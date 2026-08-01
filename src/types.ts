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
  /**
   * True when the sender is a Discord bot account (author.bot = true). Absent on
   * Matrix events and non-bot Discord senders. Stored in event_json and in the
   * timeline_events.sender_is_bot column for chain counting (spec MULTI-AGENT-SUPPORT §9).
   */
  isBot?: boolean;
  /**
   * True when the sender is a Discord webhook author (webhook_id set). Absent on
   * Matrix events and non-webhook Discord senders. Webhook-authored messages always
   * count as human for chain-counting purposes — they relay real humans through bridges.
   * Stored in event_json and in timeline_events.sender_is_webhook (spec §9).
   */
  isWebhook?: boolean;
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

/**
 * Generic cross-provider reaction event — the full pre-resolved envelope that
 * providers deliver to {@link ChatProviderHost.onReaction} (spec §10.1, §12.6).
 *
 * PK contract (reaction_event_id):
 *   Matrix  → the `$…` reaction event id (unchanged from before Phase 6).
 *   Discord → the deterministic synthetic key `discord:<messageId>:<emojiKey>:<userId>`
 *             where `emojiKey` is the `normalizedKey` value; reconstructible from
 *             `MESSAGE_REACTION_REMOVE`'s (message, emoji, user) triple.
 *
 * normalized_key contract:
 *   unicode → the emoji string (e.g. "👍"); unchanged.
 *   Matrix custom → the `mxc://…` URL; unchanged.
 *   Discord custom → `discord:<emojiSnowflake>` (same-named emoji in two guilds stay
 *                    distinct; `display` carries the `:name:` for rendering).
 *
 * On "add" all optional fields are populated by the provider. On "remove" only
 * the PK (`reactionEventId`) and routing fields are required; kind/display/
 * normalizedKey are absent because the tombstone path keys only on the PK.
 */
export interface ReactionStreamEvent {
  action: "add" | "remove";
  /** Storage PK — see contract above. */
  reactionEventId: string;
  /** Pre-built timeline key for the reactions table locality hint. */
  timelineKey: string;
  /** Stable sender id (MXID, Discord snowflake, …). */
  senderId: string;
  senderDisplay?: string;
  /** Reaction or redaction timestamp (ms epoch). */
  reactedAtMs: number;
  // ── "add"-only fields ──────────────────────────────────────────────────────
  /** Target message external id. Required for "add"; absent for "remove". */
  targetEventId?: string;
  /** Resolved reaction kind. Required for "add"; absent for "remove". */
  kind?: "unicode" | "custom" | "text";
  /** Display text: unicode glyph or ":shortcode:". Required for "add". */
  display?: string;
  /** Custom emoji shortcode (custom kind only). */
  shortcode?: string;
  /** Normalised reaction key — see contract above. Required for "add". */
  normalizedKey?: string;
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
  /**
   * Byte budget for the combined body + formatted_body in a single event (HTML
   * send path). Matrix: 60 000 (within the 65 536-byte event limit). Absent on
   * providers where no such cap applies; send_message falls back to 60 000.
   */
  maxContentBytes?: number;
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
  /**
   * Provider-initiated bulk reaction clear (spec §10.4 — Discord MESSAGE_REACTION_REMOVE_ALL /
   * MESSAGE_REACTION_REMOVE_EMOJI). `normalizedKey` absent ⇒ clear all emoji on the target;
   * present ⇒ clear only that emoji. The host maps to `tombstoneReactionsByTargetEvent` or
   * `tombstoneReactionsByTargetAndKey` respectively.
   */
  onBulkReactionClear?(args: { targetEventId: string; normalizedKey?: string }, ctx: { accountId: string }): void;
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

// ── ChannelClient (spec DISCORD-SUPPORT-DESIGN §7.1) ──────────────────────────

/** Cross-provider reaction listing for one message. */
export interface ReactionEntry {
  normalizedKey: string;
  display: string;
  kind: "unicode" | "custom" | "text";
  shortcode?: string;
  count: number;
  users: string[];
}
export type ReactionListing = ReactionEntry[];

/**
 * Channel descriptor returned by {@link ChannelClient.channelInfo}.
 * `label` is the human-readable channel name (e.g. `#channel-name (Server Name)`
 * for Discord, `Room Name (Space Name)` for Matrix).
 */
export interface ChannelInfo {
  /** Human-readable channel label (name + optional server/space suffix). */
  label: string;
  /**
   * Display name for the channel/room without any server/space suffix.
   * Matrix: the room's `displayName` from the native client (absent for unnamed rooms).
   * Discord: the channel's name (absent for unnamed or unresolvable channels).
   * The tool renders this as the `Name:` line; the `label` field incorporates it
   * (plus a server/space suffix) for label-cache and diary consumers.
   */
  displayName?: string;
  /** Native channel/room id. */
  channelId: string;
  /** Server/space/guild name (e.g. Matrix parent space, Discord guild). */
  serverName?: string;
  isDirect: boolean;
  topic?: string;
  memberCount?: number;
  joined?: boolean;
  canonicalAlias?: string;
  altAliases?: string[];
}

/** A pinned message as returned by {@link ChannelClient.pins}. */
export interface PinnedMessage {
  externalId: string;
  sender: SenderInfo;
  body: string;
  timestamp: number;
}

/** A sendable emoji entry returned by {@link ChannelClient.emojiList}. */
export interface EmojiEntry {
  shortcode: string;
  animated?: boolean;
}

/** Member information returned by {@link ChannelClient.memberInfo}. */
export interface MemberInfo {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  membership?: string;
  isSelf: boolean;
  isDirect: boolean;
}

/** Neutral history page request (spec §11.3). `cursor` = Matrix next_batch or snowflake. */
export interface HistoryPageRequest {
  cursor?: string;
  limit?: number;
  /** Older-than cursor (passed through from the read_messages `before` parameter). */
  before?: string;
  /** Newer-than cursor (passed through from the read_messages `after` parameter). */
  after?: string;
}

/** One message in a history page (spec §11.3). */
export interface HistorySummary {
  externalId: string;
  sender: SenderInfo;
  timestamp: number;
  body: string;
  attachments?: AttachmentMeta[];
  replyToExternalId?: string;
  edited?: boolean;
  /** External id of the message this event replaces. Present only when `edited` is true. */
  editTargetExternalId?: string;
  /** Thread root's external id. Present only when this is a thread-child message. */
  threadRootExternalId?: string;
  /**
   * Matrix-only — present when the message could not be decrypted (UTD).
   * Mirrors {@link CanonicalChatEvent.undecryptable}; documented Matrix-only
   * because only E2EE-capable providers produce UTD events.
   */
  undecryptable?: true;
  /** Matrix-only — megolm session id whose key is missing when the event is undecryptable. */
  sessionId?: string;
  /** Matrix-only — reason code for decryption failure when the event is undecryptable. */
  utdReason?: string;
}

/** Neutral history page result (spec §11.3). */
export interface HistoryPageResult {
  messages: HistorySummary[];
  nextCursor?: string;
  prevCursor?: string;
}

/** Create-poll request passed to {@link ChannelClient.createPoll}. */
export interface CreatePollRequest {
  question: string;
  options: Array<{ id: string; text: string }>;
  maxSelections?: number;
}

/** Result from {@link ChannelClient.createPoll}. */
export interface CreatePollResult {
  externalId: string;
}

/** Vote-poll request passed to {@link ChannelClient.votePoll}. */
export interface VotePollRequest {
  pollExternalId: string;
  answerIds: string[];
}

/** Result from {@link ChannelClient.votePoll}. */
export interface VotePollResult {
  externalId: string;
}

/**
 * Per-target action surface obtained from a provider (spec DISCORD-SUPPORT-DESIGN §7.1).
 *
 * Capabilities gating:
 * - `members` is present iff `ProviderCapabilities.membershipRoster`.
 * - `createPoll` is present iff `ProviderCapabilities.pollCreate`.
 * - `votePoll` is present iff `ProviderCapabilities.pollVote`.
 *
 * All methods throw on failure; callers must catch and report errors.
 */
export interface ChannelClient {
  /**
   * Add a reaction. Optionally returns the resolved display text (e.g. the
   * resolved emoji glyph or custom shortcode the platform used). Lean providers
   * may return void.
   */
  react(externalId: string, emoji: string): Promise<{ display?: string } | void>;
  unreact(externalId: string, emoji: string): Promise<{ removed?: number } | void>;
  listReactions(externalId: string, limit?: number): Promise<ReactionListing>;
  /**
   * Edit a message. Optionally returns the new event/message id assigned by the
   * platform. Lean providers may return void.
   */
  editMessage(externalId: string, body: string): Promise<{ externalId?: string } | void>;
  deleteMessage(externalId: string, reason?: string): Promise<void>;
  readMessages(req: HistoryPageRequest): Promise<HistoryPageResult>;
  /** Look up a single message by its provider-native id. Returns undefined when not found. */
  readMessage(externalId: string): Promise<HistorySummary | undefined>;
  memberInfo(userId: string): Promise<MemberInfo | undefined>;
  /** Present iff `ProviderCapabilities.membershipRoster`. */
  members?(): Promise<SenderInfo[]>;
  channelInfo(): Promise<ChannelInfo>;
  pins(): Promise<PinnedMessage[]>;
  /**
   * Pin a message. Optionally returns the post-op total pin count. Lean
   * providers may return void.
   */
  pinMessage(externalId: string): Promise<{ pinCount?: number } | void>;
  /**
   * Unpin a message. Optionally returns the post-op total pin count. Lean
   * providers may return void.
   */
  unpinMessage(externalId: string): Promise<{ pinCount?: number } | void>;
  emojiList(limit?: number): Promise<EmojiEntry[]>;
  /** Present iff `ProviderCapabilities.pollCreate`. */
  createPoll?(req: CreatePollRequest): Promise<CreatePollResult>;
  /** Present iff `ProviderCapabilities.pollVote`. */
  votePoll?(req: VotePollRequest): Promise<VotePollResult>;
}

/**
 * Neutral history paging client (spec §11.3) — the provider-side counterpart
 * to `ChannelClient.readMessages`, exposed via `IChatProvider.history()`.
 * Matrix: backed by the existing `room.messages()` NAPI.
 * Discord (Phase 7): before-snowflake paging (`GET /channels/{id}/messages?before=…`).
 *
 * Distinct from the internal `BackfillReadClient` in `src/backfill/paginate.ts`,
 * which is also neutral (uses `HistoryPageRequest`/`HistoryPageResult`) but is
 * scoped to the backfill engine. `HistoryClient` is the provider-facing interface;
 * Phase 7 will wire it into the backfill path when a Discord provider is live.
 */
export interface HistoryClient {
  readMessages(req: HistoryPageRequest): Promise<HistoryPageResult>;
  /**
   * Fetch all backed-up megolm sessions for the channel into the crypto store
   * before a deep history descent. Optional — only Matrix encrypted rooms need
   * this; Discord and plain-text Matrix channels leave it absent.
   */
  downloadRoomKeys?(): Promise<void>;
}

/**
 * Per-provider terminology used to assemble provider-aware tool descriptions
 * (spec DISCORD-SUPPORT-DESIGN §7.1). The Matrix bundle reproduces today's
 * tool schema strings exactly; the Discord bundle uses Discord vocabulary.
 */
export interface ProviderTerminology {
  /** e.g. "Matrix event ID" or "Discord message ID" */
  messageIdFmt: string;
  /** e.g. "Matrix user ID (e.g. @user:server.com)" or "Discord user ID (snowflake)" */
  userIdFmt: string;
  /** e.g. "room" or "channel" */
  channelNoun: string;
  /** e.g. "Matrix" or "Discord" */
  providerName: string;
  /** mention description sentence embedded in send_message.message description */
  mentionNote: string;
  /**
   * Short sender-id example used in user_profile_read/edit senderId parameter description.
   * e.g. "for example a Matrix mxid" or "for example a Discord user ID snowflake".
   * Produces "Stable provider sender id, <senderIdHint>." — the Matrix value keeps the
   * pre-Phase-8 string byte-identical.
   */
  senderIdHint: string;
  /**
   * spawn_session message_id parameter description string.
   * Matrix value: byte-for-byte reproduction of the pre-Phase-8 literal
   * ("The Matrix event id ($…) of the co-reply message…").
   * Discord value: Discord-native equivalent.
   */
  coReplyIdDescription: string;
  /**
   * spawn_session required-error text (returned when message_id is empty).
   * Matrix value: byte-for-byte reproduction of the pre-Phase-8 literal
   * ("error: message_id is required (the $… event id…)").
   * Discord value: Discord-native equivalent.
   */
  coReplyIdRequiredError: string;
}

/**
 * Provider contract v2 (spec DISCORD-SUPPORT-DESIGN §3.1).
 * Implemented by MatrixProvider (Phase 2). Discord provider (Phase 7).
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
  /** Tool/action surface for one target; undefined when the target is foreign. */
  channelClient(target: OutboundTarget): ChannelClient | undefined;
  /** Enrichment capability object for one account; undefined when the account is foreign. */
  enrichment(accountId: string): EnrichmentCapabilities | undefined;
  /**
   * Neutral history paging client for one target (spec §11.3).
   * Present iff `capabilities.history` is true and the target is in scope.
   * Returns undefined for foreign targets or when history is unavailable.
   * Matrix: wraps the native `room.messages()` call for the resolved roomId.
   * Discord (Phase 7): before-snowflake paging.
   */
  history?(target: OutboundTarget): HistoryClient | undefined;
  /**
   * Update the bot's own profile (display name and/or avatar). Optional: absent on
   * providers that do not support profile edits (or where it is not yet implemented).
   * Discord: avatar + per-guild nick (global username rename excluded — §14).
   * Matrix: display name + avatar upload.
   */
  setProfile?(accountId: string, opts: {
    displayName?: string;
    avatarUrl?: string;
    avatarDataBase64?: string;
    avatarContentType?: string;
  }): Promise<{ displayName?: string; avatarUrl?: string }>;
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
