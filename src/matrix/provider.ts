import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { AppConfig } from "../config/index.js";
import type { MatrixUploadMediaThumbnail } from "./native-types.js";
import type {
  ChannelClient,
  ChatProviderHost,
  DeliveryReceipt,
  IChatProvider,
  InboundChatEvent,
  OutboundMessage,
  OutboundTarget,
  ProviderCapabilities,
  SelfIdentity,
} from "../types.js";
import { MatrixChannelClient } from "./channel-client.js";
import { MatrixNativeClient } from "./native-client.js";
import type {
  MatrixMessageSummary,
  MatrixNativeConfig,
  MatrixNativeEvent,
  MatrixReactionStreamEvent,
} from "./native-types.js";
import { normalizeMatrixInboundEvent } from "./inbound.js";
import { recordInboundEmojiUsage } from "./emoji-resolve.js";
import type { EnrichmentCapabilities } from "../enrichment/index.js";
import { parseTimelineKey } from "../storage/timeline-key.js";

/**
 * Cap on how long a same-sender trigger burst can debounce-extend the trigger
 * hold, expressed as a multiple of `trigger_hold_ms`. Each trigger-bearing
 * follow-up resets the hold to a fresh `trigger_hold_ms`, but never past
 * `holdStartedAt + trigger_hold_ms * this`, so a steady drip of messages can't
 * hold a trigger open indefinitely (with the default 2000ms hold, a burst flushes
 * after at most 8s). Kept as a code constant rather than config: it needs no
 * per-deployment tuning and adding an optional key would re-expose the
 * config-merge drop foot-gun that disabled co-target coalescing.
 */
const TRIGGER_HOLD_MAX_MULTIPLIER = 4;

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

export class MatrixProvider implements IChatProvider {
  readonly id = "matrix";
  readonly capabilities: ProviderCapabilities = {
    typing: true,
    reactions: true,
    reactionKinds: ["unicode", "custom", "text"],
    customEmojiScoped: false,
    mediaUpload: true,
    maxAttachmentsPerMessage: 1,
    maxMessageChars: 4000,
    maxContentBytes: 60_000,
    formatting: "html",
    edits: true,
    deletes: true,
    pollCreate: true,
    pollVote: true,
    pins: true,
    voiceMessages: true,
    threads: true,
    history: true,
    encrypted: true,
    linkPreviews: "provider",
    singleAttachmentPerMessage: true,
    membershipRoster: true,
  };

  private readonly accounts = new Map<string, AccountRuntime>();
  private readonly pendingTriggers = new Map<string, PendingTrigger>();
  private host?: ChatProviderHost;
  private stopped = false;
  private readonly activePolls = new Set<Promise<void>>();

  constructor(private readonly config: AppConfig["matrix"]) {}

  async start(host: ChatProviderHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    if (!this.config.enabled) return;
    for (const [accountId, account] of Object.entries(this.config.accounts)) {
      const client = new MatrixNativeClient();
      const diagnostics = client.start(toNativeConfig(accountId, account));
      const runtime: AccountRuntime = {
        accountId,
        client,
        selfUserId: account.user_id,
        attachmentDir: path.join(path.resolve(account.store_path), "msg-attach"),
      };
      this.accounts.set(accountId, runtime);
      this.host.onDiagnostics?.(diagnostics, { accountId });
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

  accountIds(): string[] {
    return [...this.accounts.keys()];
  }

  getSelf(accountId: string): SelfIdentity | undefined {
    const runtime = this.accounts.get(accountId);
    if (!runtime) return undefined;
    return { id: runtime.selfUserId };
  }

  /**
   * Matrix user ids always start with `@`. Used as a budget-enforceability
   * shape test — not a full lookup — so it works before accounts are started.
   */
  ownsUserId(id: string): boolean {
    return id.startsWith("@");
  }

  enrichment(accountId: string): EnrichmentCapabilities | undefined {
    if (!this.accounts.has(accountId)) return undefined;
    return this.getEnrichmentCapabilities(accountId);
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
        const thumbnail = await maybeBuildThumbnail(data, attachment.mimeType);
        const result = await account.client.uploadMedia({
          roomId: target.roomId,
          filename: attachment.filename ?? path.basename(attachment.localPath),
          contentType: attachment.mimeType ?? "application/octet-stream",
          dataBase64: data.toString("base64"),
          thumbnail,
          caption: !primaryExternalId && index === 0 && message.body ? message.body : undefined,
          threadId: target.threadId,
          replyToId: primaryExternalId ? undefined : target.replyToId,
          asVoice: attachment.asVoice,
          durationMs: attachment.durationMs,
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

  /**
   * @deprecated Use {@link enrichment} instead. Kept public for backcompat
   * until Phase 2b replaces all external call sites.
   */
  getEnrichmentCapabilities(accountId: string): EnrichmentCapabilities {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Matrix account not running: ${accountId}`);
    const client = account.client;

    return {
      async downloadMedia(params) {
        const result = await client.downloadMedia({
          roomId: params.roomId,
          eventId: params.eventId,
          outputPath: params.outputPath,
          sizeLimit: params.sizeLimit,
        });
        return {
          sizeBytes: result.sizeBytes,
          contentType: result.contentType,
          filename: result.filename,
          kind: result.kind,
        };
      },
      async messageSummary(params) {
        const summary = await client.messageSummary(params);
        if (!summary) return null;
        return convertMatrixMessageSummary(summary);
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
      if (nativeEvent.type === "reaction") {
        // Passive: persist only, never wake a session (ARCHITECTURE.md §9f).
        this.host?.onReaction(nativeEvent.event, { accountId: account.accountId });
        continue;
      }
      if (nativeEvent.type !== "inbound") {
        this.host?.onNativeEvent?.(nativeEvent, { accountId: account.accountId });
        continue;
      }
      recordInboundEmojiUsage(account.client, nativeEvent.event);
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
        .catch((error) => this.host?.onError(error, { accountId: account.accountId, phase: "poll" }))
        .finally(() => {
          this.activePolls.delete(poll);
          this.schedulePoll(account);
        });
      this.activePolls.add(poll);
    }, 250);
  }

  private emitWithTriggerHold(inbound: InboundChatEvent): void {
    // Reply-as-trigger (spec RESUMABLE-SESSIONS §5): an UNTRIGGERED reply to
    // someone else's message may still be a reply to one of the bot's own
    // messages. Ask the app (resume-unaware here) BEFORE the strip/hold below, so
    // a resolved trigger flows through the exact same hold/debounce/same-sender
    // grouping as a native dm/mention — one held, grouped trigger-bearing
    // delivery (no late synthesis past the hold). Self-replies are excluded (a
    // bot reply to its own message is never a trigger). The downstream
    // resume-vs-fresh fork still happens in the app; the provider only classifies.
    if (
      !inbound.trigger &&
      inbound.event.replyTo?.externalId &&
      !inbound.event.sender.isSelf &&
      this.host?.resolveReplyTrigger
    ) {
      const replyTrigger = this.host.resolveReplyTrigger({
        provider: inbound.provider,
        externalId: inbound.event.replyTo.externalId,
        timelineKey: inbound.timelineKey,
        sender: inbound.event.sender,
      });
      if (replyTrigger) {
        inbound.trigger = replyTrigger;
        inbound.event.trigger = replyTrigger;
      }
    }

    this.emit({ ...inbound, trigger: undefined, event: { ...inbound.event, trigger: undefined } });
    if (!this.host) return;

    const key = `${inbound.timelineKey}:${inbound.event.sender.id}`;
    const existing = this.pendingTriggers.get(key);

    // A same-sender message that arrives while a hold is open belongs to the same
    // burst — the pending key is per-sender — so fold its event id into the held
    // trigger: ONE grouped trigger → ONE session, whether or not the follow-up
    // itself triggers. Previously only a NON-triggering follow-up grouped here; a
    // trigger-bearing one flushed the hold early and spawned a twin session. Since
    // Matrix auto-mentions the replied-to user, EVERY reply to the bot carries its
    // own mention trigger, so consecutive same-sender replies always fragmented
    // into separate sessions (the duplicate-session incident). Grouping them here
    // is the upstream fix; co-target coalescing stays the cross-sender /
    // out-of-window backstop.
    if (existing) {
      const heldTrigger = existing.event.trigger!;
      const groupedTrigger = {
        ...heldTrigger,
        groupedEventIds: [...(heldTrigger.groupedEventIds ?? []), inbound.event.id],
      };
      existing.event.trigger = groupedTrigger;
      existing.event.event.trigger = groupedTrigger;
      // A trigger-bearing follow-up DEBOUNCES the hold so a longer burst keeps
      // accreting; the reset is capped relative to the first message's
      // holdStartedAt (TRIGGER_HOLD_MAX_MULTIPLIER) so a steady drip can't hold the
      // trigger open forever. A non-triggering follow-up just rides the existing
      // timer (its content is already in the group).
      if (inbound.trigger) {
        clearTimeout(existing.timer);
        const heldStartedAt = heldTrigger.holdStartedAt ?? Date.now();
        const cap = heldStartedAt + this.config.trigger_hold_ms * TRIGGER_HOLD_MAX_MULTIPLIER;
        const deadline = Math.min(Date.now() + this.config.trigger_hold_ms, cap);
        existing.timer = setTimeout(() => this.flushPendingTrigger(key), Math.max(0, deadline - Date.now()));
      }
      return;
    }

    // No open hold: the non-triggering message was just ingested above; only a
    // trigger opens a new hold.
    if (!inbound.trigger) return;

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
    this.host?.onEvent(event);
  }

  /**
   * Return a `ChannelClient` scoped to the target's channel (§7.1).
   * Returns `undefined` when the account is not running or the target has no channel.
   */
  channelClient(target: OutboundTarget): ChannelClient | undefined {
    try {
      const account = this.resolveAccount(target);
      const roomId = target.roomId ?? parseTimelineKey(target.timelineKey)?.channelId;
      if (!roomId) return undefined;
      return new MatrixChannelClient(account.client, roomId);
    } catch {
      return undefined;
    }
  }

  /**
   * Update the bot's own profile (display name and/or avatar) for the given
   * account. Delegates to the Matrix native client's `setProfile` call.
   */
  async setProfile(
    accountId: string,
    opts: { displayName?: string; avatarUrl?: string; avatarDataBase64?: string; avatarContentType?: string },
  ): Promise<{ displayName?: string; avatarUrl?: string }> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Matrix account not running: ${accountId}`);
    return await account.client.setProfile(opts);
  }

  /**
   * @deprecated Use {@link channelClient} instead. Kept for callers that still
   * need the raw native client (enrichment wiring, serverIdsFor) until those
   * sites are migrated in later phases.
   */
  getClient(target: OutboundTarget): MatrixNativeClient {
    return this.resolveAccount(target).client;
  }

  private resolveAccount(target: OutboundTarget): AccountRuntime {
    const accountId = target.accountId ?? parseTimelineKey(target.timelineKey)?.accountId ?? "";
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

const THUMBNAIL_MIN_SOURCE_BYTES = 100_000;
const THUMBNAIL_LONG_EDGE = 512;
const THUMBNAIL_MAX_BYTES_STATIC = 1_200_000;
const THUMBNAIL_MAX_BYTES_ANIMATED = 6_000_000;
const THUMBNAIL_SCALE_CANDIDATES = [1, 0.75, 0.5];
const THUMBNAIL_QUALITY_CANDIDATES_STATIC = [75, 60, 45];
const THUMBNAIL_QUALITY_CANDIDATES_ANIMATED = [65, 50, 35];

/**
 * Convert a `MatrixMessageSummary` (NAPI native type with `msgtype` + `media[]`)
 * into the neutral `EnrichmentCapabilities.messageSummary` return shape.
 *
 * Matrix vocabulary (`m.image` / `m.video` / `m.audio` / `m.file`) is mapped
 * to the neutral `mediaType` string. When the native `media` array is present
 * (current Rust NAPI — always populated for media msgtypes), it is used
 * directly; the `msgtype` fallback handles any older payloads that omit it.
 * Non-media msgtypes (e.g. `m.text`) produce no attachments — identical to
 * the old `isMediaMsgtype` gate.
 *
 * Matrix caps `maxAttachmentsPerMessage = 1`, so the resulting `attachments`
 * array always has ≤ 1 element on the Matrix path. `remoteUrl` is never set
 * (Matrix never carries the `AttachmentMeta.remoteUrl` CDN field; the field
 * was confirmed dead for Matrix in the protocol coupling audit).
 */
export function convertMatrixMessageSummary(summary: MatrixMessageSummary): {
  eventId: string;
  sender: string;
  senderName?: string;
  body: string;
  attachments?: Array<{ mediaType: string; filename?: string; mimeType?: string }>;
  timestamp: string;
} {
  const attachments = matrixSummaryAttachments(summary);
  return {
    eventId: summary.eventId,
    sender: summary.sender,
    senderName: summary.senderName,
    body: summary.body,
    timestamp: summary.timestamp,
    ...(attachments ? { attachments } : {}),
  };
}

const MATRIX_MEDIA_MSGTYPES: ReadonlySet<string> = new Set([
  "m.image", "m.video", "m.audio", "m.file",
]);

function matrixMsgtypeToMediaType(msgtype: string): string | undefined {
  if (msgtype === "m.image") return "image";
  if (msgtype === "m.video") return "video";
  if (msgtype === "m.audio") return "audio";
  if (msgtype === "m.file") return "file";
  return undefined;
}

function matrixSummaryAttachments(
  summary: MatrixMessageSummary,
): Array<{ mediaType: string; filename?: string; mimeType?: string }> | undefined {
  if (!summary.msgtype || !MATRIX_MEDIA_MSGTYPES.has(summary.msgtype)) return undefined;

  if (summary.media && summary.media.length > 0) {
    return summary.media.map((m) => ({
      mediaType: m.kind as string,
      filename: m.filename ?? m.body,
      mimeType: m.contentType,
    }));
  }

  // Fallback: msgtype set but media array absent (defensive; current Rust always
  // populates media for msgtypes that have attachments).
  const mediaType = matrixMsgtypeToMediaType(summary.msgtype);
  if (!mediaType) return undefined;
  return [{ mediaType }];
}

async function maybeBuildThumbnail(
  data: Buffer,
  mimeType?: string,
): Promise<MatrixUploadMediaThumbnail | undefined> {
  if (!mimeType?.startsWith("image/") || mimeType === "image/svg+xml") return undefined;
  if (data.length < THUMBNAIL_MIN_SOURCE_BYTES) return undefined;

  try {
    const metadata = await sharp(data, { animated: true }).metadata();
    if (!metadata.format || !metadata.width || !metadata.height) return undefined;
    const sourceHeight = metadata.pageHeight ?? metadata.height;
    const animated = (metadata.pages ?? 1) > 1;
    const maxBytes = animated ? THUMBNAIL_MAX_BYTES_ANIMATED : THUMBNAIL_MAX_BYTES_STATIC;
    const qualityCandidates = animated ? THUMBNAIL_QUALITY_CANDIDATES_ANIMATED : THUMBNAIL_QUALITY_CANDIDATES_STATIC;

    for (const scale of THUMBNAIL_SCALE_CANDIDATES) {
      const targetEdge = Math.round(THUMBNAIL_LONG_EDGE * scale);
      for (const quality of qualityCandidates) {
        const output = await sharp(data, { animated }).rotate().resize({
          width: targetEdge,
          height: targetEdge,
          fit: "inside",
          withoutEnlargement: true,
        }).webp({
          quality,
          alphaQuality: quality,
          effort: 4,
          ...(animated ? { loop: 0 } : {}),
        }).toBuffer();

        if (output.length >= data.length) return undefined;
        if (output.length <= maxBytes) {
          const outMeta = await sharp(output, { animated }).metadata();
          const outWidth = outMeta.width;
          const outHeight = outMeta.pageHeight ?? outMeta.height;
          if (!outWidth || !outHeight) return undefined;
          return {
            dataBase64: output.toString("base64"),
            contentType: "image/webp",
            width: outWidth,
            height: outHeight,
            sizeBytes: output.length,
          };
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
