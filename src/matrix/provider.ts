import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "../config/index.js";
import type {
  ChatProvider,
  DeliveryReceipt,
  InboundChatEvent,
  OutboundMessage,
  OutboundTarget,
  Unsubscribe,
} from "../types.js";
import { MatrixNativeClient } from "./native-client.js";
import type { MatrixNativeConfig, MatrixNativeEvent } from "./native-types.js";
import { normalizeMatrixInboundEvent } from "./inbound.js";
import type { EnrichmentCapabilities } from "../enrichment/index.js";

type Handler = (event: InboundChatEvent) => void;

interface AccountRuntime {
  accountId: string;
  client: MatrixNativeClient;
  selfUserId: string;
  attachmentDir: string;
  pollTimer?: NodeJS.Timeout;
}

interface PendingTrigger {
  event: InboundChatEvent;
  timer: NodeJS.Timeout;
}

export interface MatrixProviderOptions {
  onError?: (error: unknown, context: { accountId?: string; phase: string }) => void;
  onNativeEvent?: (event: Exclude<MatrixNativeEvent, { type: "inbound" }>, context: { accountId: string }) => void;
  onDiagnostics?: (diagnostics: ReturnType<MatrixNativeClient["start"]>, context: { accountId: string }) => void;
}

export class MatrixProvider implements ChatProvider<AppConfig["matrix"]> {
  readonly id = "matrix";
  capabilities = {
    typing: true,
    reactions: true,
    readReceipts: false,
    mediaUpload: true,
  };

  private readonly handlers = new Set<Handler>();
  private readonly accounts = new Map<string, AccountRuntime>();
  private readonly pendingTriggers = new Map<string, PendingTrigger>();
  private config?: AppConfig["matrix"];
  private stopped = false;
  private readonly activePolls = new Set<Promise<void>>();

  constructor(private readonly options: MatrixProviderOptions = {}) {}

  async start(config: AppConfig["matrix"]): Promise<void> {
    this.config = config;
    this.stopped = false;
    if (!config.enabled) return;
    for (const [accountId, account] of Object.entries(config.accounts)) {
      const client = new MatrixNativeClient();
      const diagnostics = client.start(toNativeConfig(accountId, account));
      const runtime: AccountRuntime = {
        accountId,
        client,
        selfUserId: account.user_id,
        attachmentDir: path.join(path.resolve(account.store_path), "msg-attach"),
      };
      this.accounts.set(accountId, runtime);
      this.options.onDiagnostics?.(diagnostics, { accountId });
      this.schedulePoll(runtime);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pendingTriggers.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingTriggers.clear();
    for (const account of this.accounts.values()) {
      if (account.pollTimer) clearTimeout(account.pollTimer);
    }
    await Promise.allSettled([...this.activePolls]);
    for (const account of this.accounts.values()) account.client.stop();
    this.accounts.clear();
  }

  subscribe(handler: Handler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    const account = this.resolveAccount(target);
    if (!target.roomId) throw new Error("Matrix outbound target requires roomId");
    if (message.attachments?.length) {
      const externalIds: string[] = [];
      let primaryExternalId: string | undefined;
      if (message.body.trim()) {
        const textResult = await account.client.sendMessage({
          roomId: target.roomId,
          text: message.body,
          html: message.htmlBody,
          threadId: target.threadId,
          ...(target.replyToId ? { replyToId: target.replyToId } : {}),
        });
        primaryExternalId = textResult.messageId;
        externalIds.push(textResult.messageId);
      }
      for (const [index, attachment] of message.attachments.entries()) {
        if (!attachment.localPath) throw new Error(`Outbound attachment has no localPath: ${attachment.id}`);
        const data = await readFile(attachment.localPath);
        const result = await account.client.uploadMedia({
          roomId: target.roomId,
          filename: attachment.filename ?? path.basename(attachment.localPath),
          contentType: attachment.mimeType ?? "application/octet-stream",
          dataBase64: data.toString("base64"),
          caption: !primaryExternalId && index === 0 && message.body ? message.body : undefined,
          threadId: target.threadId,
          replyToId: primaryExternalId ? undefined : target.replyToId,
        });
        primaryExternalId ??= result.messageId;
        externalIds.push(result.messageId);
      }
      return {
        provider: this.id,
        target,
        externalId: primaryExternalId,
        externalIds,
        deliveredAt: Date.now(),
      };
    }
    const request = {
      roomId: target.roomId,
      text: message.body,
      html: message.htmlBody,
      threadId: target.threadId,
      ...(target.replyToId ? { replyToId: target.replyToId } : {}),
    };
    const result = await account.client.sendMessage(request);
    return {
      provider: this.id,
      target,
      externalId: result.messageId,
      deliveredAt: Date.now(),
    };
  }

  async setTyping(target: OutboundTarget, typing: boolean): Promise<void> {
    const account = this.resolveAccount(target);
    if (!target.roomId) throw new Error("Matrix typing target requires roomId");
    await account.client.setTyping({ roomId: target.roomId, typing });
  }

  getEnrichmentCapabilities(accountId: string): EnrichmentCapabilities {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Matrix account not running: ${accountId}`);
    const client = account.client;

    return {
      async downloadMedia(params) {
        const result = await client.downloadMedia(params);
        return {
          sizeBytes: result.sizeBytes,
          contentType: result.contentType,
          filename: result.filename,
          kind: result.kind,
        };
      },
      async messageSummary(params) {
        return await client.messageSummary(params);
      },
      async resolveLinkPreviews(params) {
        return await client.resolveLinkPreviews(params);
      },
      async memberInfo(params) {
        const result = await client.memberInfo(params);
        return { displayName: result.displayName };
      },
    };
  }

  private async poll(account: AccountRuntime): Promise<void> {
    if (this.stopped) return;
    const events = account.client.pollEvents();
    for (const nativeEvent of events) {
      if (nativeEvent.type !== "inbound") {
        this.options.onNativeEvent?.(nativeEvent, { accountId: account.accountId });
        continue;
      }
      const inbound = normalizeMatrixInboundEvent(nativeEvent.event, {
        accountId: account.accountId,
        selfUserId: account.selfUserId,
      });
      this.emitWithTriggerHold(inbound);
    }
  }

  private schedulePoll(account: AccountRuntime): void {
    if (this.stopped) return;
    account.pollTimer = setTimeout(() => {
      const poll = this.poll(account)
        .catch((error) => this.options.onError?.(error, { accountId: account.accountId, phase: "poll" }))
        .finally(() => {
          this.activePolls.delete(poll);
          this.schedulePoll(account);
        });
      this.activePolls.add(poll);
    }, 250);
  }

  private emitWithTriggerHold(inbound: InboundChatEvent): void {
    this.emit({ ...inbound, trigger: undefined, event: { ...inbound.event, trigger: undefined } });
    if (!this.config) return;

    const key = `${inbound.timelineKey}:${inbound.event.sender.id}`;
    const existing = this.pendingTriggers.get(key);
    if (!inbound.trigger) {
      if (existing) {
        existing.event.trigger = {
          ...existing.event.trigger!,
          groupedEventIds: [...(existing.event.trigger?.groupedEventIds ?? []), inbound.event.id],
        };
        existing.event.event.trigger = existing.event.trigger;
      }
      return;
    }

    if (existing) {
      this.flushPendingTrigger(key);
    }

    const holdStartedAt = Date.now();
    const timer = setTimeout(() => this.flushPendingTrigger(key), this.config.trigger_hold_ms);

    const pendingEvent: InboundChatEvent = {
      ...inbound,
      trigger: {
        ...inbound.trigger,
        holdStartedAt,
        groupedEventIds: [inbound.event.id],
      },
      event: {
        ...inbound.event,
        trigger: {
          ...inbound.trigger,
          holdStartedAt,
          groupedEventIds: [inbound.event.id],
        },
      },
    };
    this.pendingTriggers.set(key, { event: pendingEvent, timer });
  }

  private flushPendingTrigger(key: string): void {
    const pending = this.pendingTriggers.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTriggers.delete(key);
    pending.event.trigger = {
      ...pending.event.trigger!,
      holdEndedAt: Date.now(),
    };
    pending.event.event.trigger = pending.event.trigger;
    this.emit(pending.event);
  }

  private emit(event: InboundChatEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private resolveAccount(target: OutboundTarget): AccountRuntime {
    const accountId = target.accountId ?? target.timelineKey.split(":")[1];
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Matrix account is not running: ${accountId}`);
    return account;
  }
}

function toNativeConfig(
  accountId: string,
  account: AppConfig["matrix"]["accounts"][string],
): MatrixNativeConfig {
  const rootDir = account.store_path;
  return {
    accountId,
    homeserver: account.homeserver,
    userId: account.user_id,
    auth:
      account.access_token && account.access_token.length > 0
        ? { mode: "accessToken", accessToken: account.access_token }
        : { mode: "password", password: account.password ?? "" },
    recoveryKey: account.recovery_key,
    deviceName: account.device_id,
    initialSyncLimit: 20,
    encryptionEnabled: true,
    defaultThreadReplies: "inbound",
    replyToMode: "first",
    stateLayout: {
      rootDir,
      sessionFile: path.join(rootDir, "session.json"),
      sdkStoreDir: path.join(rootDir, "sdk-store"),
      cryptoStoreDir: path.join(rootDir, "crypto-store"),
      mediaCacheDir: path.join(rootDir, "media"),
      emojiCatalogFile: path.join(rootDir, "emoji.json"),
      reactionsFile: path.join(rootDir, "reactions.json"),
      logsDir: path.join(rootDir, "logs"),
    },
    roomOverrides: {},
  };
}
