import type { EnrichmentCapabilities } from "./enrichment/types.js";

export type { EnrichmentCapabilities };

/**
 * Type guard for Node.js system errors (ENOENT, EACCES, etc.).
 * Checks that the value is an Error with a `code` property.
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export type ChatRole = "user" | "assistant";

/**
 * Lifecycle state of a timeline (chat channel / DM). A timeline is `inactive`
 * until someone first triggers the bot in it; activation runs through
 * `activating` (first-trigger backfill + enrichment) to `active`. `backfilling`
 * is reserved for operator-initiated bulk history fetching (deferred). A
 * timeline with no `timeline_compaction_state` row is implicitly `inactive`.
 */
export type TimelineState = "inactive" | "activating" | "active" | "backfilling";

export interface SenderInfo {
  /**
   * Stable opaque key (MXID for Matrix, snowflake for Discord, …). Used for DB
   * storage, trigger matching, and tool addressing only — never rendered directly
   * as a human-facing label.
   */
  id: string;
  /**
   * Stable-ish unique handle (e.g. Discord `@username`). Mutable over months but
   * much slower to change than `displayName`. Rendered in place of `id` wherever
   * a human-facing label is needed (`username ?? id`). Matrix leaves this unset
   * (behaviour byte-identical to before it was added).
   */
  username?: string;
  /** Room/guild-scoped nickname; freely mutable. Rendered when it differs from `username ?? id`. */
  displayName?: string;
  isSelf?: boolean;
}

/**
 * A provider's own identity for one account.
 * `id` is the stable opaque key (MXID, Discord snowflake, …).
 */
export interface SelfIdentity {
  id: string;
  username?: string;
  displayName?: string;
}

/** Minimal cross-provider reaction event envelope. Phase 6 generalises the shape. */
export interface ReactionStreamEvent {
  action: "add" | "remove";
}

/** Cross-provider provider lifecycle / diagnostics event. Provider-specific shape. */
export type ProviderLifecycleEvent = unknown;

export interface CaptionResult {
  attachmentId: string;
  text: string;
  model?: string;
  generatedAt: number;
  status: "pending" | "complete" | "failed";
  error?: string;
}

export interface AttachmentMeta {
  id: string;
  filename?: string;
  mimeType?: string;
  mediaType: "image" | "video" | "audio" | "file";
  sizeBytes?: number;
  width?: number;
  height?: number;
  localPath?: string;
  remoteUrl?: string;
  caption?: string;
  asVoice?: boolean;
  durationMs?: number;
  isCharacterCard?: boolean;
  cardName?: string;
  isImageBlock?: boolean;
  processing?: {
    downloaded?: boolean;
    captioned?: boolean;
    error?: string;
  };
}

export interface ReplyContext {
  externalId?: string;
  sender?: SenderInfo;
  body?: string;
  htmlBody?: string;
  timestamp?: number;
  attachments?: AttachmentMeta[];
  linkedMedia?: AttachmentMeta[];
  linkPreviews?: LinkPreviewMeta[];
}

export interface LinkPreviewMeta {
  url: string;
  title?: string;
  description?: string;
  media?: AttachmentMeta[];
  sourceKind?: string;
  fetchedAt?: number;
  /**
   * Structured X-tweet payload for `sourceKind === "fx_twitter"` previews
   * (ARCHITECTURE.md §7a). Parsed from `link_previews.payload_json` at hydrate
   * time; the rich renderer branches on it, falling back to the flat
   * `description` when absent/malformed.
   */
  payload?: import("./fxtwitter/types.js").XTweetPayload;
}

export interface MentionInfo {
  mentionedUserIds: string[];
  mentionedSelf?: boolean;
}

/**
 * One deduped reaction count on a message (View A — ARCHITECTURE.md §9f). Derived
 * from the reaction store at context-build time and attached to
 * {@link CanonicalChatEvent.reactions}; it is a render-time projection, never
 * persisted into `event_json`. `display` is the glyph (unicode), `:shortcode:`
 * (custom), or literal (text); `count` is the number of distinct senders.
 */
export interface ReactionAggregate {
  normalizedKey: string;
  kind: "unicode" | "custom" | "text";
  display: string;
  shortcode?: string;
  count: number;
}

export interface TriggerInfo {
  type: "mention" | "dm" | "timer" | "manual" | "reply";
  reason: string;
  triggeredBy: SenderInfo;
  holdStartedAt?: number;
  holdEndedAt?: number;
  groupedEventIds?: string[];
}

export interface CanonicalChatEvent {
  id: string;
  externalId?: string;
  timelineKey: string;
  provider: string;
  agentSessionId?: string;
  /**
   * Resume generation the owning session held when this (bot-sent) message was
   * tagged (spec RESUMABLE-SESSIONS §6). Set only on assistant sends; absent on
   * inbound messages and pre-feature sends (read as generation 0). Persisted both
   * in `event_json` (so it survives the echo-enrich UPDATE, which rebuilds the row
   * from the canonical event) and in the `timeline_events.agent_session_generation`
   * column. A reply-resume continues a completed session only when this equals the
   * session's current `resume_generation`.
   */
  agentSessionGeneration?: number;
  role: ChatRole;
  sender: SenderInfo;
  body: string;
  htmlBody?: string;
  timestamp: number;
  receivedAt: number;
  attachments?: AttachmentMeta[];
  linkedMedia?: AttachmentMeta[];
  replyTo?: ReplyContext;
  linkPreviews?: LinkPreviewMeta[];
  mentions?: MentionInfo;
  /**
   * Deduped reaction counts on this message (View A). A render-time derivation
   * populated by the context builder from the reaction store — NOT part of the
   * persisted event (never written into `event_json`). Only the rich renderer
   * emits it.
   */
  reactions?: ReactionAggregate[];
  threadId?: string;
  trigger?: TriggerInfo;
  generatedCaptions?: CaptionResult[];
  /**
   * Set when this event could not be decrypted (UTD). The renderer keys off this
   * field — not the body — to show a human-client-style "unable to decrypt"
   * placeholder, so `body` stays empty and never leaks. Cleared by the
   * re-decryption sweeper when the real event is recovered, at which point
   * `body`/`attachments` carry the decrypted content.
   */
  undecryptable?: { sessionId?: string; reason?: string };
}

export interface InboundChatEvent {
  provider: string;
  timelineKey: string;
  event: CanonicalChatEvent;
  trigger?: TriggerInfo;
  outboundTarget?: OutboundTarget;
  /**
   * Channel type populated at ingest by the provider normalizer. Routing prefers
   * this field over parsing the `timelineKey` when it is present, so DM/thread
   * detection works correctly even before the key is available (and for future
   * providers whose key shape might differ). Falls back to `timelineKindOf(key)`
   * in workers and subsystems that only have a stored key.
   *
   * - `"dm"` — direct message channel (1-on-1)
   * - `"group"` — group channel / guild text channel
   * - `"thread"` — sub-thread of a channel (Matrix thread, Discord thread/forum post)
   *
   * Not set on synthetic events (recovery, proactive, backfill) — callers fall
   * back to key parsing in those cases.
   */
  channelType?: "group" | "dm" | "thread";
  /**
   * Set when this inbound event is a message edit (`m.replace`). `event` carries
   * the replacement body/attachments (from `m.new_content`); `targetExternalId`
   * is the provider event id of the message being edited. The pipeline applies
   * the replacement to that target in place instead of appending a new timeline
   * row, mirroring how a normal client shows an edited message (issue #17).
   */
  edit?: { targetExternalId: string };
}

export interface OutboundTarget {
  provider: string;
  timelineKey: string;
  accountId?: string;
  roomId?: string;
  threadId?: string;
  replyToId?: string;
}

export interface OutboundMessage {
  body: string;
  htmlBody?: string;
  attachments?: AttachmentMeta[];
  agentSessionId?: string;
}

export interface DeliveryReceipt {
  provider: string;
  target: OutboundTarget;
  externalId?: string;
  externalIds?: string[];
  deliveredAt: number;
}

export type Unsubscribe = () => void;

export interface ProviderCapabilities {
  typing?: boolean;
  reactions?: boolean;
  reactionKinds?: Array<"unicode" | "custom" | "text">;
  customEmojiScoped?: boolean;
  mediaUpload?: boolean;
  /** Maximum number of attachments per outbound message. */
  maxAttachmentsPerMessage: number;
  /** Safe body character budget (for chunking). */
  maxMessageChars: number;
  formatting: "html" | "markdown" | "plain";
  edits: boolean;
  deletes: boolean;
  pollCreate: boolean;
  /** Note: Discord has no bot vote endpoint — false there even though Discord supports polls. */
  pollVote: boolean;
  pins: boolean;
  voiceMessages: boolean;
  threads: boolean;
  /** history = read_messages tool + backfill. */
  history: boolean;
  /** gates re-decryption instantiation (encrypted provider only). */
  encrypted: boolean;
  /** "none" → framework-level direct-HTTP preview fallback. */
  linkPreviews: "provider" | "none";
  singleAttachmentPerMessage: boolean;
  membershipRoster: boolean;
}

/**
 * Cross-provider lifecycle callbacks passed at {@link IChatProvider.start}.
 * Replaces the constructor-options pattern for Matrix and applies to all providers.
 */
export interface ChatProviderHost {
  onEvent(event: InboundChatEvent): void;
  onReaction(event: ReactionStreamEvent, ctx: { accountId: string }): void;
  /** Gateway/sync lifecycle + diagnostics for the console. Optional to emit. */
  onNativeEvent?(event: ProviderLifecycleEvent, ctx: { accountId: string }): void;
  onDiagnostics?(diagnostics: unknown, ctx: { accountId: string }): void;
  onError(error: unknown, ctx: { accountId?: string; phase: string }): void;
  /** Reply-as-trigger resolver (spec RESUMABLE-SESSIONS §5); provider stays resume-unaware. */
  resolveReplyTrigger?(args: {
    provider: string;
    externalId: string;
    timelineKey: string;
    sender: SenderInfo;
  }): TriggerInfo | undefined;
}

/**
 * Provider contract v2 (spec DISCORD-SUPPORT-DESIGN §3.1).
 * Implemented by MatrixProvider (Phase 2a). Discord provider (Phase 3+).
 *
 * Deferred members (not yet present):
 *   - `channelClient(target)` — Phase 4, ChannelClient type not yet defined
 *   - `history(target)` — Phase 6, HistoryClient type not yet defined
 */
export interface IChatProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  start(host: ChatProviderHost): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
  setTyping(target: OutboundTarget, typing: boolean): Promise<void>;
  accountIds(): string[];
  /** Resolved at start; undefined when the account is not running. */
  getSelf(accountId: string): SelfIdentity | undefined;
  /** Shape test: "is this one of my user IDs?" — used for budget enforceability. */
  ownsUserId(id: string): boolean;
  /** Enrichment capability object for one account; undefined when the account is foreign. */
  enrichment(accountId: string): EnrichmentCapabilities | undefined;
}

/**
 * Legacy provider interface — superseded by {@link IChatProvider}.
 * @deprecated Use IChatProvider. Will be removed once all call sites are migrated (Phase 2b).
 */
export interface ChatProvider<ProviderConfig = unknown> {
  readonly id: string;
  capabilities: ProviderCapabilities;
  start(config: ProviderConfig): Promise<void>;
  stop(): Promise<void>;
  subscribe(handler: (event: InboundChatEvent) => void): Unsubscribe;
  send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
  setTyping(target: OutboundTarget, typing: boolean): Promise<void>;
}
