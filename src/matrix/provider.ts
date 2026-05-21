import path from "node:path";
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
import type { MatrixNativeConfig } from "./native-types.js";
import { processMatrixInboundEvent } from "./inbound.js";

type Handler = (event: InboundChatEvent) => void;

interface AccountRuntime {
  accountId: string;
  client: MatrixNativeClient;
  selfUserId: string;
  pollTimer?: NodeJS.Timeout;
}

interface PendingTrigger {
  event: InboundChatEvent;
  timer: NodeJS.Timeout;
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

  async start(config: AppConfig["matrix"]): Promise<void> {
    this.config = config;
    if (!config.enabled) return;
    for (const [accountId, account] of Object.entries(config.accounts)) {
      const client = new MatrixNativeClient();
      client.start(toNativeConfig(accountId, account));
      const runtime: AccountRuntime = {
        accountId,
        client,
        selfUserId: account.user_id,
      };
      runtime.pollTimer = setInterval(() => void this.poll(runtime), 250);
      this.accounts.set(accountId, runtime);
    }
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingTriggers.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingTriggers.clear();
    for (const account of this.accounts.values()) {
      if (account.pollTimer) clearInterval(account.pollTimer);
      account.client.stop();
    }
    this.accounts.clear();
  }

  subscribe(handler: Handler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    const account = this.resolveAccount(target);
    if (!target.roomId) throw new Error("Matrix outbound target requires roomId");
    const result = account.client.sendMessage({
      roomId: target.roomId,
      text: message.body,
      threadId: target.threadId,
    });
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
    account.client.setTyping({ roomId: target.roomId, typing });
  }

  private async poll(account: AccountRuntime): Promise<void> {
    const events = account.client.pollEvents();
    for (const nativeEvent of events) {
      if (nativeEvent.type !== "inbound") continue;
      const inbound = await processMatrixInboundEvent(nativeEvent.event, {
        accountId: account.accountId,
        selfUserId: account.selfUserId,
        mentionNames: this.config?.rooms.mention_names ?? [],
        attachmentDir: path.join("msg-attach", "matrix", account.accountId),
        client: account.client,
      });
      this.emitWithTriggerHold(inbound);
    }
  }

  private emitWithTriggerHold(inbound: InboundChatEvent): void {
    this.emit({ ...inbound, trigger: undefined, event: { ...inbound.event, trigger: undefined } });
    if (!inbound.trigger || !this.config) return;

    const key = `${inbound.timelineKey}:${inbound.event.sender.id}`;
    const existing = this.pendingTriggers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.event.event.trigger = {
        ...existing.event.trigger!,
        groupedEventIds: [...(existing.event.trigger?.groupedEventIds ?? []), inbound.event.id],
      };
    }

    const holdStartedAt = Date.now();
    const timer = setTimeout(() => {
      const pending = this.pendingTriggers.get(key);
      if (!pending) return;
      this.pendingTriggers.delete(key);
      const holdEndedAt = Date.now();
      pending.event.trigger = {
        ...pending.event.trigger!,
        holdStartedAt,
        holdEndedAt,
      };
      pending.event.event.trigger = pending.event.trigger;
      this.emit(pending.event);
    }, this.config.trigger_hold_ms);

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
