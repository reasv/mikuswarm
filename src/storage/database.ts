import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../observability/index.js";
import type { AttachmentMeta, CanonicalChatEvent, TimelineState } from "../types.js";
import { nanoid } from "nanoid";
import type { RawTokenUsage, SessionUsageTotals } from "../agent/usage.js";
import { roomIdFromTimelineKeyOpt, threadKeyLikePattern } from "./timeline-key.js";

/**
 * The resolved replacement content an edit carries: the post-edit body and the
 * serialized attachments. Mirrors `EditReplacement` in `src/timeline/edits.ts`
 * but lives here so the storage layer (pending-edit persistence, issue #12) does
 * not depend on the timeline layer. Kept structurally identical.
 */
export interface EditReplacementContent {
  body: string;
  attachments: AttachmentMeta[];
}

export interface StorageOptions {
  databasePath: string;
  logger?: Logger;
}

/**
 * Re-decryption give-up ceiling (issue #1). A UTD row whose `redecrypt_attempts`
 * reaches this count is excluded from `getUndecryptedEvents`, so permanently-dead
 * events (megolm keys that will never arrive — e.g. messages sent before the bot
 * joined) leave the oldest-first candidate window and stop starving newer,
 * decryptable rows. At the default sweep interval with exponential backoff this
 * spans well over a day of real-time retries before a row is retired.
 */
export const MAX_REDECRYPT_ATTEMPTS = 12;

/**
 * Sentinel `redecrypt_attempts` value marking a row permanently retired from the
 * re-decryption rotation regardless of {@link MAX_REDECRYPT_ATTEMPTS} (e.g. a UTD
 * row with no resolvable room/event id, which can never be re-fetched). Chosen
 * far above the ceiling so it always falls outside the candidate query.
 */
export const REDECRYPT_RETIRED = 1_000_000;

type WriteJob<T> = {
  run: (db: Database.Database) => T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export interface TimelineEventRow {
  id: string;
  external_id: string | null;
  timeline_key: string;
  provider: string;
  role: string;
  sender_id: string;
  sender_display_name: string | null;
  body: string;
  timestamp: number;
  received_at: number;
  agent_session_id: string | null;
  event_json: string;
  created_at: number;
  updated_at: number;
}

export interface ReplyContextRow {
  event_id: string;
  reply_external_id?: string | null;
  sender_id?: string | null;
  sender_display_name?: string | null;
  body?: string | null;
  html_body?: string | null;
  timestamp?: number | null;
  created_at: number;
}

export interface LinkPreviewRow {
  id: string;
  event_id: string;
  context: string;
  url: string;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  source_kind?: string | null;
  preview_index: number;
  fetched_at?: number | null;
  fetch_status: string;
  error?: string | null;
  /**
   * Structured preview payload for rich renderers (ARCHITECTURE.md §7a). NULL
   * for plain Synapse previews; for `source_kind = 'fx_twitter'` it carries the
   * serialized XTweetPayload (src/fxtwitter/types.ts) the rich renderer
   * consumes. `description` stays the flat-text fallback + FTS source.
   */
  payload_json?: string | null;
  created_at: number;
}

export interface MediaAssetRow {
  id: string;
  event_id: string;
  role: string;
  source_index?: number | null;
  link_preview_id?: string | null;
  local_path?: string | null;
  mime_type?: string | null;
  media_type: string;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  original_filename?: string | null;
  detected_content?: string | null;
  detected_metadata_json?: string | null;
  caption?: string | null;
  caption_model?: string | null;
  caption_status: string;
  caption_error?: string | null;
  /** Durable claim-time caption retry counter (mirrors enrichment_retries). */
  caption_attempts?: number;
  /**
   * Auxiliary caption usage/cost (spec AUXILIARY-USAGE-TRACKING §8.1), written
   * atomically with the caption result. Null on legacy rows and when the gateway
   * omitted usage ("unknown", never zero). `caption_cost` is USD;
   * `caption_total_tokens` is input+output+cacheRead. This is a separate lane —
   * never folded into `agent_sessions.usage_*` (§4).
   */
  caption_input_tokens?: number | null;
  caption_output_tokens?: number | null;
  caption_cache_read_tokens?: number | null;
  caption_total_tokens?: number | null;
  caption_cost?: number | null;
  download_status: string;
  /**
   * Channel (timeline_key) the captioned asset belongs to. NOT a `media_assets`
   * column — join-populated by {@link Storage.claimPendingCaptions} (via
   * `event_id → timeline_events`) so the caption worker can attribute its ledger
   * row to a room. Undefined on rows read by paths that don't perform that join.
   */
  timeline_key?: string | null;
  download_error?: string | null;
  created_at: number;
  /** Last-mutated wall clock (bumped on every caption write); seeded to created_at. */
  updated_at?: number | null;
}

export interface TimelineCompactionState {
  schemaVersion: 1;
  timelineKey: string;
  compactStartEventId: string | null;
  richStartEventId: string | null;
  updatedAt: number;
}

export type SummaryStatus = "complete" | "truncated" | "superseded";

export interface Summary {
  id: string;
  timelineKey: string;
  level: number;
  content: string;
  earliestTimestamp: number;
  latestTimestamp: number;
  /**
   * In-memory only — set on synthesized failure placeholders (§9b wait-or-omit)
   * so the contiguity probe (`hasEventsBetweenSummaries`) gets an exact start
   * cursor without lineage rows. Not a column; undefined on rows loaded from
   * the summaries table (whose earliest event resolves through lineage).
   */
  earliestEventId?: string;
  latestEventId: string;
  eventCount: number;
  tokenCount: number;
  modelId: string | null;
  status: SummaryStatus;
  backfillJobId: string | null;
  generatedAt: number;
  createdAt: number;
}

export type SummarizationJobStatus = "pending" | "processing" | "complete" | "failed";

/**
 * Scheduler priority class carried on a summarization job row (spec
 * CONCURRENCY-AND-RATE-LIMITING §5.5). Mirrors `PriorityClass`
 * (src/agent/scheduler.ts); declared independently so storage stays
 * import-free of the agent layer. Almost always `background`; raised by
 * priority inheritance when a live context build waits on the job.
 */
export type SummarizationJobPriority =
  | "interactive"
  | "proactive"
  | "background"
  | "background_low";

export interface SummarizationJob {
  id: string;
  timelineKey: string;
  level: number;
  status: SummarizationJobStatus;
  priority: SummarizationJobPriority;
  inputStartId: string;
  inputEndId: string;
  inputTokenCount: number | null;
  targetTokenCount: number;
  attempts: number;
  maxRetries: number;
  bestEffortDraft: string | null;
  error: string | null;
  resultSummaryId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Diary queue state on a level-1 summary row (ARCHITECTURE.md §9c). */
export type DiaryStatus = "pending" | "processing" | "done" | "skipped" | "failed";

/**
 * A claimed diary job: the level-1 summary whose participation range the diary
 * session writes about. Carries just what the worker needs — the lineage events
 * are loaded separately via {@link Storage.getSummaryLineage}.
 */
export interface DiaryJob {
  summaryId: string;
  timelineKey: string;
  level: number;
  earliestTimestamp: number;
  latestTimestamp: number;
  /** Persisted attempt count, post-increment at claim time. */
  attempts: number;
}

/**
 * A memory-retrieval chunk as produced by the indexer (ARCHITECTURE.md §9d). The
 * storage layer accepts this structurally for reconciliation; the canonical shape
 * (with docs) lives in `src/retrieval/chunk.ts` as `MemoryChunk`.
 */
export interface MemoryChunkInput {
  id: string;
  path: string;
  ordinal: number;
  source: string;
  startLine: number;
  endLine: number;
  room: string | null;
  entryTs: number;
  text: string;
  tokenCount: number;
  contentHash: string;
}

/** Net effect of one reconcile pass over a file (for logging). */
export interface ReconcileResult {
  inserted: number;
  updated: number;
  deleted: number;
  /** rowids of chunks removed this pass — so the caller can prune their vectors. */
  deletedRowids: number[];
}

/** One lexical (FTS5/BM25) search hit, pre-ranking. */
export interface LexicalHit {
  rowid: number;
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  room: string | null;
  entryTs: number;
  text: string;
  /** Raw SQLite bm25() cost — lower (more negative) is a better match. */
  bm25: number;
}

/**
 * Raw inputs for one event's chat-search projection (ARCHITECTURE.md §9e), joined
 * from timeline_events + aggregated media_assets / link_previews / reply_contexts.
 * The indexer turns this into a `ChatIndexUpsert` (parses mentions from event_json,
 * builds aux_text, computes the content signature). `srcRowid` is the timeline_events
 * implicit rowid, used only as the full-sweep paging cursor.
 */
export interface ChatProjectionInput {
  srcRowid: number;
  eventId: string;
  timelineKey: string;
  senderId: string;
  senderDisplayName: string | null;
  role: string;
  body: string;
  timestamp: number;
  updatedAt: number;
  eventJson: string;
  /** csv of distinct media_type for role='attachment' media, or null. */
  attachmentTypes: string | null;
  attachCount: number;
  /** space-joined complete captions across all media roles (recall over precision). */
  captions: string | null;
  linkCount: number;
  /** space-joined link-preview title/description/site_name. */
  linkText: string | null;
  quotedSenderId: string | null;
  replyCount: number;
}

/** A projected chat-index row ready to upsert, plus its denormalized mentions. */
export interface ChatIndexUpsert {
  eventId: string;
  timelineKey: string;
  senderId: string;
  senderDisplayName: string | null;
  role: string;
  timestamp: number;
  body: string;
  auxText: string;
  hasAttachment: number;
  attachmentTypes: string;
  hasLink: number;
  isReply: number;
  quotedSenderId: string | null;
  mentions: string[];
  contentSig: string;
}

/**
 * One reaction (or un-reaction) to persist in the `reactions` store. Built from a
 * native MatrixReactionStreamEvent (action "add") in the provider ingest path.
 */
export interface ReactionUpsert {
  reactionEventId: string;
  timelineKey: string;
  targetEventId: string;
  senderId: string;
  senderDisplay: string | null;
  /** Mirrors MatrixReactionKind; narrowed so a bad value can't reach the CHECK. */
  kind: "unicode" | "custom" | "text";
  display: string;
  shortcode: string | null;
  normalizedKey: string;
  reactedAt: number;
  observedAt: number;
}

/**
 * One row of View A — a deduped reaction count on a single target message,
 * grouped by `normalizedKey`. `count` is the number of distinct senders.
 */
export interface ReactionAggregateRow {
  targetEventId: string;
  normalizedKey: string;
  kind: string;
  display: string;
  shortcode: string | null;
  count: number;
}

/**
 * One live (non-tombstoned) reaction row, for View B discrete-line synthesis.
 * Ordered by `reactedAt` ascending so "earliest reactors" fall out naturally.
 */
export interface DiscreteReactionRow {
  reactionEventId: string;
  targetEventId: string;
  senderId: string;
  senderDisplay: string | null;
  normalizedKey: string;
  kind: string;
  display: string;
  shortcode: string | null;
  reactedAt: number;
}

/** Net effect of one chat-index reconcile batch (for logging). */
export interface ChatIndexReconcileResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** A parsed `search_messages` query against the chat index (ARCHITECTURE.md §9e). */
export interface ChatSearchQuery {
  /** Pre-built, column-scoped FTS5 MATCH expression; undefined = metadata-only search. */
  match?: string;
  /** Restrict to these timeline_keys; undefined = all rooms. */
  timelineKeys?: string[];
  fromSenders?: string[];
  mentions?: string[];
  quotedUsers?: string[];
  isReply?: boolean;
  hasAttachment?: boolean;
  /** Any-of media types (image/video/audio/file). */
  attachmentTypes?: string[];
  hasLink?: boolean;
  afterTs?: number;
  /** Exclusive upper bound (ms). */
  beforeTs?: number;
  limit: number;
  /** Keyset cursor for newest/oldest order (ignored for relevance). */
  cursor?: { timestamp: number; rowid: number };
  order: "newest" | "oldest" | "relevance";
}

/** One chat-index search hit (snippet is built by the caller from body/auxText). */
export interface ChatSearchHit {
  rowid: number;
  eventId: string;
  timelineKey: string;
  senderId: string;
  senderDisplayName: string | null;
  role: string;
  timestamp: number;
  body: string;
  auxText: string;
  hasAttachment: number;
  attachmentTypes: string;
  hasLink: number;
  isReply: number;
  quotedSenderId: string | null;
  /** Raw bm25 cost when ordered by relevance (lower = better); 0 otherwise. */
  bm25: number;
}

export interface ChatSearchResult {
  hits: ChatSearchHit[];
  /** Total matches ignoring limit/cursor — so the agent knows if it saw everything. */
  total: number;
}

/**
 * Query over the summary-content FTS index (`summaries_fts`), backing
 * `search_messages(corpus:"summaries")` (ARCHITECTURE.md §9e). Orthogonal to
 * `ChatSearchQuery` — only the corpus-agnostic axes (text, rooms, time, order,
 * pagination) overlap; summaries add `levels`/`minLevel`/`statuses`. `superseded`
 * summaries are NEVER returned regardless of `statuses` (filtered in SQL).
 */
export interface SummarySearchQuery {
  /** Pre-built FTS5 MATCH expression scoped to the `content` column; undefined = metadata-only. */
  match?: string;
  timelineKeys?: string[];
  /** Restrict to these levels (any-of); undefined = all levels. */
  levels?: number[];
  /** Restrict to level >= this (combinable with `levels`). */
  minLevel?: number;
  /**
   * Allowed statuses; defaults to ['complete','truncated']. 'superseded' is silently
   * dropped from this set — a superseded summary is never searchable (§9e).
   */
  statuses?: SummaryStatus[];
  /** Summary overlaps the window when latest_timestamp >= afterTs and earliest_timestamp <= beforeTs. */
  afterTs?: number;
  beforeTs?: number;
  limit: number;
  /** Keyset cursor for newest/oldest order (ignored for relevance). */
  cursor?: { timestamp: number; rowid: number };
  order: "newest" | "oldest" | "relevance";
}

/** One summary-search hit. `content` is the full summary; the caller builds a snippet. */
export interface SummarySearchHit {
  rowid: number;
  id: string;
  timelineKey: string;
  level: number;
  earliestTimestamp: number;
  latestTimestamp: number;
  eventCount: number;
  tokenCount: number;
  status: SummaryStatus;
  content: string;
  /** Raw bm25 cost when ordered by relevance (lower = better); 0 otherwise. */
  bm25: number;
}

export interface SummarySearchResult {
  hits: SummarySearchHit[];
  total: number;
}

/** Sort key for events/summaries: (timestamp, received_at, id) ascending. */
export interface TimelineCursor {
  timestamp: number;
  receivedAt: number;
  id: string;
}

/** Operator target for a message-only backfetch job (spec MESSAGE-BACKFETCH §6.3). */
export type BackfetchTargetKind = "beginning" | "date" | "oldest_decryptable" | "count";

/** Lifecycle of a backfetch job (spec MESSAGE-BACKFETCH §8.1). */
export type BackfetchJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** A `backfetch_jobs` row in camelCase (spec MESSAGE-BACKFETCH §8.1). */
export interface BackfetchJobRow {
  id: string;
  roomId: string;
  accountId: string;
  timelineKey: string;
  targetKind: BackfetchTargetKind;
  /** ISO date for 'date'; positive integer (as text) for 'count'; null otherwise. */
  targetValue: string | null;
  captionAfter: boolean;
  status: BackfetchJobStatus;
  cursorToken: string | null;
  oldestReachedEventId: string | null;
  oldestReachedTs: number | null;
  fetched: number;
  stored: number;
  stopReason: string | null;
  floorEventId: string | null;
  /** Max stored per run (0 = unbounded) and wall-clock budget ms (0 = none). */
  safetyCap: number;
  timeoutMs: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Fields an operator supplies to create a backfetch job. */
export interface BackfetchJobInput {
  roomId: string;
  accountId: string;
  timelineKey: string;
  targetKind: BackfetchTargetKind;
  targetValue?: string | null;
  captionAfter?: boolean;
  safetyCap?: number;
  timeoutMs?: number;
}

/** Mutable progress/state fields patched as a job runs. */
export interface BackfetchJobPatch {
  status?: BackfetchJobStatus;
  cursorToken?: string | null;
  oldestReachedEventId?: string | null;
  oldestReachedTs?: number | null;
  fetched?: number;
  stored?: number;
  stopReason?: string | null;
  floorEventId?: string | null;
  error?: string | null;
}

/** Raw `backfetch_jobs` row shape (snake_case, as stored). */
interface BackfetchJobDbRow {
  id: string;
  room_id: string;
  account_id: string;
  timeline_key: string;
  target_kind: string;
  target_value: string | null;
  caption_after: number;
  status: string;
  cursor_token: string | null;
  oldest_reached_event_id: string | null;
  oldest_reached_ts: number | null;
  fetched: number;
  stored: number;
  stop_reason: string | null;
  floor_event_id: string | null;
  safety_cap: number;
  timeout_ms: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function mapBackfetchJobRow(row: BackfetchJobDbRow): BackfetchJobRow {
  return {
    id: row.id,
    roomId: row.room_id,
    accountId: row.account_id,
    timelineKey: row.timeline_key,
    targetKind: row.target_kind as BackfetchTargetKind,
    targetValue: row.target_value,
    captionAfter: row.caption_after === 1,
    status: row.status as BackfetchJobStatus,
    cursorToken: row.cursor_token,
    oldestReachedEventId: row.oldest_reached_event_id,
    oldestReachedTs: row.oldest_reached_ts,
    fetched: row.fetched,
    stored: row.stored,
    stopReason: row.stop_reason,
    floorEventId: row.floor_event_id,
    safetyCap: row.safety_cap,
    timeoutMs: row.timeout_ms,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SummaryRow {
  id: string;
  timeline_key: string;
  level: number;
  content: string;
  earliest_timestamp: number;
  latest_timestamp: number;
  latest_event_id: string;
  event_count: number;
  token_count: number;
  model_id: string | null;
  status: SummaryStatus;
  backfill_job_id: string | null;
  generated_at: number;
  created_at: number;
}

interface SummarizationJobRow {
  id: string;
  timeline_key: string;
  level: number;
  status: SummarizationJobStatus;
  priority: SummarizationJobPriority;
  input_start_id: string;
  input_end_id: string;
  input_token_count: number | null;
  target_token_count: number;
  attempts: number;
  max_retries: number;
  best_effort_draft: string | null;
  error: string | null;
  result_summary_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapSummaryRow(row: SummaryRow): Summary {
  return {
    id: row.id,
    timelineKey: row.timeline_key,
    level: row.level,
    content: row.content,
    earliestTimestamp: row.earliest_timestamp,
    latestTimestamp: row.latest_timestamp,
    latestEventId: row.latest_event_id,
    eventCount: row.event_count,
    tokenCount: row.token_count,
    modelId: row.model_id,
    status: row.status,
    backfillJobId: row.backfill_job_id,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

function mapJobRow(row: SummarizationJobRow): SummarizationJob {
  return {
    id: row.id,
    timelineKey: row.timeline_key,
    level: row.level,
    status: row.status,
    priority: row.priority,
    inputStartId: row.input_start_id,
    inputEndId: row.input_end_id,
    inputTokenCount: row.input_token_count,
    targetTokenCount: row.target_token_count,
    attempts: row.attempts,
    maxRetries: row.max_retries,
    bestEffortDraft: row.best_effort_draft,
    error: row.error,
    resultSummaryId: row.result_summary_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parameters for inserting a completed or truncated summary with its lineage. */
export interface SummaryInsert {
  id: string;
  timelineKey: string;
  level: number;
  content: string;
  earliestTimestamp: number;
  latestTimestamp: number;
  latestEventId: string;
  eventCount: number;
  tokenCount: number;
  modelId: string | null;
  status: SummaryStatus;
  generatedAt: number;
  /** Ordered leaf event IDs (level 1 only). */
  eventIds?: string[];
  /** Ordered parent summary IDs (level 2+ only). */
  parentIds?: string[];
  /** Job to mark complete with this summary as its result. */
  jobId: string;
}

export interface SummarizationJobInsert {
  id: string;
  timelineKey: string;
  level: number;
  inputStartId: string;
  inputEndId: string;
  inputTokenCount: number | null;
  targetTokenCount: number;
  maxRetries: number;
  /** Scheduler class (spec §5.5). Unset = `background` (the normal case). */
  priority?: SummarizationJobPriority;
}

/**
 * Lifecycle status of a durable session record (spec §4 status model).
 *   - `created`     placeholder made, not yet run (in-memory)
 *   - `running`     actively executing (in-memory)
 *   - `completed`   finished normally, incl. no_reply (terminal, default)
 *   - `discarded`   failed/aborted (terminal)
 *   - `interrupted` process stopped mid-run; healed on startup (reserved)
 *   - `suspended`   paused awaiting external input (reserved, future §7)
 *   - `resuming`    auto-resume in progress after a mechanical run failure
 *                   (spec CONCURRENCY-AND-RATE-LIMITING §6.2)
 *   - `failed-resumable` auto-resume exhausted; parked for a manual console
 *                   resume (snapshot + transcript retained; §6.2)
 */
export type AgentSessionStatus =
  | "created"
  | "running"
  | "completed"
  | "discarded"
  | "interrupted"
  | "suspended"
  | "resuming"
  | "failed-resumable";

/**
 * Initial-insert shape for an `agent_sessions` row (spec §4, §5). The runner
 * creates the placeholder at `created`; the snapshot/transcript/timestamp
 * columns are filled in later by the dedicated save/update methods. `status` is
 * supplied by the caller (typically `'created'`).
 *
 * `startedAt` is optional: the chat path inserts at `created` and leaves it
 * null until `markRunning` sets it. Callers that insert directly at `running`
 * (e.g. the summarization worker, which bypasses `created → markRunning`) pass
 * `startedAt` so the row carries a non-null start time from the outset.
 */
export interface AgentSessionInsert {
  id: string;
  timelineKey: string;
  sessionType: string;
  status: AgentSessionStatus;
  modelId?: string | null;
  triggerEventId?: string | null;
  triggerExternalId?: string | null;
  triggerBody?: string | null;
  /**
   * The ORIGINAL trigger sender's durable identity (id + display name) — the
   * identity sender-bound tools (`user_profile_read`/`user_profile_edit`,
   * `recap`'s asker) bind to. Persisted so a manual resume reconstructs the
   * exact same tool bindings instead of substituting the bot's own identity
   * (spec CONCURRENCY-AND-RATE-LIMITING §6.2 "redo the exact same request").
   */
  triggerSenderId?: string | null;
  triggerSenderDisplayName?: string | null;
  /**
   * Gap-backfill lower bound (spec RESUMABLE-SESSIONS §9.2): the timestamp of the
   * ORIGINAL trigger group's latest member (== the trigger event's timestamp; the
   * group only folds in EARLIER same-sender messages). The newest message the
   * session's context already covers, so the gap surfaces only what arrived AFTER
   * it. Nullable on legacy (pre-v27) rows; advanced on each accepted resume to the
   * new trigger's timestamp via {@link Storage.setSessionChatUpperBound}.
   */
  chatUpperBoundTs?: number | null;
  createdAt: number;
  startedAt?: number | null;
  updatedAt: number;
}

/**
 * Insert shape for a `session_interjections` row (ARCHITECTURE.md §8/§11). One row per
 * user message injected into a running session (reply-steer / co-reply). `eventId`/
 * `externalId` are the inbound timeline message's ids (the durable timeline→session
 * link); `body` is the raw inbound text (the search corpus, truncated by the caller).
 */
export interface SessionInterjectionInsert {
  sessionId: string;
  eventId?: string | null;
  externalId?: string | null;
  senderId?: string | null;
  senderDisplayName?: string | null;
  kind: string;
  body: string;
  createdAt: number;
}

/**
 * A persisted `agent_sessions` row as stored (snake_case columns). Read-side
 * shape returned by {@link Storage.getAgentSession}; mirrors the table in
 * spec §4 verbatim so the console can render snapshot + transcript directly.
 */
export interface AgentSessionRow {
  id: string;
  timeline_key: string;
  session_type: string;
  status: AgentSessionStatus;
  model_id: string | null;
  trigger_event_id: string | null;
  trigger_external_id: string | null;
  trigger_body: string | null;
  trigger_sender_id: string | null;
  trigger_sender_display_name: string | null;
  context_snapshot_json: string | null;
  context_dump_path: string | null;
  transcript_json: string | null;
  token_estimate: number | null;
  /**
   * Actuals (spec TOKEN-USAGE-TRACKING §4.2): denormalized session-level usage
   * aggregate. Null on legacy rows and on a session that never committed a
   * request (read as "unknown", not zero). `usage_cost` is USD (REAL);
   * `context_tokens` is the last committed request's provider-reported context
   * size (the session's current size).
   */
  llm_requests: number | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_cache_write_tokens: number | null;
  usage_cost: number | null;
  context_tokens: number | null;
  /**
   * Single-consumption counter for reply-resume (spec RESUMABLE-SESSIONS §6).
   * `NOT NULL DEFAULT 0`; bumped when a resume is accepted. A completed session
   * is reply-resumable only via a target message whose tagged generation equals
   * this value.
   */
  resume_generation: number;
  /**
   * Gap-backfill lower bound (spec RESUMABLE-SESSIONS §9.2): the timestamp of the
   * trigger group's latest member that this session's context already covers — its
   * original trigger on creation, advanced to each accepted resume's trigger
   * thereafter. The reply-resume gap window is `(chat_upper_bound_ts, new
   * trigger]`. NULL on legacy (pre-v27) rows; on such a row's first resume the gap
   * falls back to the new trigger's timestamp (a one-time bounded fallback).
   */
  chat_upper_bound_ts: number | null;
  no_reply: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
}

const AGENT_SESSION_META_COLUMN_NAMES = [
  "id",
  "timeline_key",
  "session_type",
  "status",
  "model_id",
  "trigger_event_id",
  "trigger_external_id",
  "trigger_body",
  "token_estimate",
  "llm_requests",
  "usage_input_tokens",
  "usage_output_tokens",
  "usage_cache_read_tokens",
  "usage_cache_write_tokens",
  "usage_cost",
  "context_tokens",
  "no_reply",
  "error",
  "created_at",
  "started_at",
  "updated_at",
  "completed_at",
] as const satisfies readonly (keyof AgentSessionRow)[];

/**
 * Lightweight projection used by session-list reads. The heavyweight persisted
 * context/transcript columns belong to the single-session detail path only; list
 * endpoints must not materialize them merely to discard them in `sessionMeta`.
 */
export type AgentSessionMetaRow = Pick<
  AgentSessionRow,
  (typeof AGENT_SESSION_META_COLUMN_NAMES)[number]
>;

const AGENT_SESSION_META_COLUMNS = AGENT_SESSION_META_COLUMN_NAMES.join(", ");
const AGENT_SESSION_META_COLUMNS_ALIASED = AGENT_SESSION_META_COLUMN_NAMES.map(
  (column) => `s.${column}`,
).join(", ");

/**
 * One row of the auxiliary tool-use usage ledger (spec AUXILIARY-USAGE-TRACKING
 * §8.2): a generic per-invocation record for provider calls made by a tool via
 * raw fetch (today `image_generate`). Attributed to the ambient
 * `agent_session_id` but accounted in a SEPARATE lane — never folded into
 * `agent_sessions.usage_*`/`context_tokens` (§4). All usage/cost fields are
 * nullable ("unknown", never a misleading 0).
 */
export interface ToolInvocationRow {
  id: string;
  agent_session_id: string | null;
  tool_name: string;
  /** The pi-agent-core tool-call id, for matching a ledger row to a rollout block. */
  tool_call_id: string | null;
  model_id: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** Generated-image count (nullable; image-gen only). */
  images: number | null;
  /** USD total (`computeUsageCost(...).total`). */
  cost: number | null;
  /** Output artifact reference, e.g. the workspace image path (nullable). */
  ref: string | null;
  created_at: number;
}

/**
 * Insert payload for {@link Storage.insertToolInvocation}. The store generates
 * `id` (nanoid) and `created_at`; the caller supplies attribution + usage/cost.
 */
export interface ToolInvocationInput {
  agentSessionId: string | null;
  toolName: string;
  toolCallId?: string | null;
  modelId?: string | null;
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  images?: number | null;
  cost?: number | null;
  ref?: string | null;
}

/** Consumer class of a {@link UsageEventRow} (spec USAGE-COST-LIMITS §3). */
export type UsageEventClass = "agent_loop" | "tool" | "caption" | "embedding";

/**
 * One billable event in the unified usage ledger (spec USAGE-COST-LIMITS §3).
 * `model_id` is always present; attribution columns are null for background
 * (caption/embedding) events. `cost_usd` is the USD priced at commit time (0 for
 * a zero-rate free model — still recorded for its token counts, §2.2).
 */
export interface UsageEventRow {
  id: string;
  ts: number;
  class: UsageEventClass;
  agent_session_id: string | null;
  session_type: string | null;
  timeline_key: string | null;
  trigger_sender_id: string | null;
  tool_name: string | null;
  model_id: string;
  /**
   * The LOGICAL model id — the config block name (spec MODEL-FALLBACK §2.2),
   * distinct from `model_id` (the upstream wire id). Budget scoping / `[[limits]]`
   * `models` selector / console grouping key on THIS; `model_id` is retained for
   * provenance ("actually billed") and health attribution. Backfilled equal to
   * `model_id` for legacy rows (the norm when block name == upstream id).
   */
  logical_model_id: string;
  /**
   * The REQUESTED virtual model id chosen by the per-user selector (spec
   * PER-USER-LIMITS §7), distinct from `logical_model_id` (the SERVED chain member)
   * under active fallback. Per-user sub-caps scope on THIS so an outage backup still
   * counts toward its requested model's sub-cap. Null for pre-feature rows + every
   * non-per-user lane (background/proactive/tool).
   */
  requested_model_id: string | null;
  /**
   * The rendered SHARED-POOL partition key this event belongs to (spec
   * PER-USER-LIMITS §3.5) — a literal (`staff`/`public`), `room:<id>`, `space:<id>`,
   * or `hs:<server>`. Null when the event joins no shared pool (the per-user `{user_id}`
   * default needs no denormalization — it reseeds off `trigger_sender_id`).
   */
  budget_partition: string | null;
  /** Bare Matrix room id derived from `timeline_key` (spec PER-USER-LIMITS §8.3) — the
   *  sturdy room-scoped seed for per-user-per-room counters + per-room pools. */
  room_id: string | null;
  /** Canonical parent space id (resolved + frozen at admission, spec PER-USER-LIMITS
   *  §11) — the space-scoped seed for per-user-per-space counters + per-space pools.
   *  Null when the room has no parent space or the deployment uses no space rules. */
  space_id: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  images: number | null;
  cost_usd: number;
  ref: string | null;
  created_at: number;
}

/**
 * A {@link UsageEventRow} carrying the resolved human channel label (`Name (Space)`
 * from `room_metadata`, else the raw `timeline_key`) for the console's recent
 * paid-calls table. Joined on read; `channel_label` is null only when the event
 * has no `timeline_key` at all.
 */
export interface UsageEventRowWithChannel extends UsageEventRow {
  channel_label: string | null;
}

/**
 * Insert payload for {@link Storage.insertUsageEvent}. The store generates `id`
 * and `created_at`; `ts` defaults to now when omitted. Every other column maps
 * directly to {@link UsageEventRow}.
 */
export interface UsageEventInput {
  ts?: number;
  class: UsageEventClass;
  agentSessionId?: string | null;
  sessionType?: string | null;
  timelineKey?: string | null;
  triggerSenderId?: string | null;
  toolName?: string | null;
  modelId: string;
  /**
   * Logical model id (config block name; spec MODEL-FALLBACK §2.2). Defaults to
   * `modelId` when omitted — the common case where a consumer has no fallback /
   * virtual model, so block name == wire id.
   */
  logicalModelId?: string | null;
  /**
   * Requested virtual model the per-user selector chose (spec PER-USER-LIMITS §7),
   * distinct from `logicalModelId` (served) under active fallback. Omitted by every
   * non-per-user caller → stored null.
   */
  requestedModelId?: string | null;
  /**
   * Rendered shared-pool partition key (spec PER-USER-LIMITS §3.5). Omitted when the
   * event joins no shared pool → stored null.
   */
  budgetPartition?: string | null;
  /**
   * Canonical parent space id of the triggering room (spec PER-USER-LIMITS §11),
   * resolved + frozen at admission. Omitted (no space rules / no parent) → null.
   */
  spaceId?: string | null;
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  images?: number | null;
  costUsd: number;
  ref?: string | null;
}

/**
 * Selector for {@link Storage.sumUsageCost} — the own-scope filter of a single
 * budget rule (spec USAGE-COST-LIMITS §2/§6.1). `since`/`until` bound the window
 * (ms epoch, half-open `[since, until)`); the dimension arrays AND together, with
 * OR within each list; an omitted dimension is a wildcard.
 */
export interface UsageCostFilter {
  since: number;
  until?: number;
  classes?: string[];
  sessionTypes?: string[];
  tools?: string[];
  models?: string[];
  // Per-user limits seed/recompute dimensions (spec PER-USER-LIMITS §8.3). Same
  // AND-of-dimensions / OR-within-a-list semantics as the columns above.
  /** `trigger_sender_id IN (…)` — the per-user `{user_id}` counter seed. */
  triggerSenderIds?: string[];
  /** `budget_partition IN (…)` — a shared-pool meter seed (the rendered key). */
  partitionKeys?: string[];
  /** `room_id IN (…)` — room-scoped seed (derived bare room id, §16 Q2 choice). */
  roomIds?: string[];
  /** `space_id IN (…)` — space-scoped seed (canonical parent space id, §11). */
  spaceIds?: string[];
  /**
   * A per-user sub-cap's REQUESTED-model scope (spec §7): matches `requested_model_id`,
   * falling back to `logical_model_id` for pre-feature `class = 'agent_loop'` rows
   * whose requested id is null (so an opus-premium sub-cap still counts legacy
   * opus-premium agent-loop spend). Null-requested `class = 'tool'` rows are EXCLUDED
   * — tool spend never seeds a model-scoped sub-cap (issue #14). OR-within-list.
   *
   * AGENT-LOOP-ONLY scoping: the null-fallback clause hardcodes `class = 'agent_loop'`,
   * so this dimension must NOT be combined with a non-agent-loop `classes` filter
   * (e.g. `classes: ['tool']`) — the two would AND into the always-false
   * `class IN ('tool') AND class = 'agent_loop'`, silently under-counting (issue #9).
   * No caller sets both today; keep it that way.
   */
  requestedModelIds?: string[];
}

/**
 * Extract the bare Matrix room id from a `timeline_key` (spec PER-USER-LIMITS §8.3)
 * for the denormalized `room_id` column. Delegates to the shared leaf derivation in
 * `./timeline-key.js` (the SAME regex the timeline layer's `roomIdFromTimelineKey`
 * uses) so room-scoped seeding cannot drift; normalizes `undefined` → `null` for the
 * SQLite column. The leaf lives under `src/storage/` so storage never imports the
 * timeline layer.
 */
function roomIdFromTimelineKey(timelineKey: string | undefined): string | null {
  return roomIdFromTimelineKeyOpt(timelineKey) ?? null;
}

/**
 * Per-session auxiliary tool-spend rollup (spec §8.3, §10.3), derived on read by
 * SUM/COUNT over `usage_events` (class='tool'; was `tool_invocations` before the
 * v25 ledger). A separate lane from the §8b session actuals — shown beside,
 * never blended into, the LLM-loop figures (§9).
 */
export interface SessionToolUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/**
 * Captioning-pool usage aggregate (spec §10.2), derived by SUM/COUNT over
 * `media_assets`. `captionedCount` counts complete captions with recorded usage.
 */
export interface CaptioningUsageAggregate {
  captionedCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

/**
 * Global cost overview across the three lanes (spec §10.4): the §8b agent-loop
 * cost, the auxiliary tool-call cost, and the captioning cost. Summed
 * independently; presented side-by-side, never as one blended headline (§9).
 */
export interface CostOverview {
  agentLoopCost: number;
  toolCost: number;
  captioningCost: number;
}

/** Spend + counts by class and by model over a window (spec USAGE-COST-LIMITS §7.1 cards). */
export interface UsageSummary {
  since: number;
  /** Server `now` (ms) the window was computed against — the average denominator's upper bound. */
  now: number;
  /**
   * Earliest event ts within `[since, now)`, or null when the window has no events.
   * The console divides spend by the *actual* elapsed range (`now - firstTs`), not the
   * nominal window width, so a 30d view a week into data averages over ~7d (§7.1 cards).
   */
  firstTs: number | null;
  total: number;
  byClass: Array<{ class: string; cost: number; events: number }>;
  byModel: Array<{ model: string; cost: number; events: number }>;
}

/** One (bucket, group) point of the stacked spend-over-time chart (§7.1). */
export interface UsageTimeseriesRow {
  bucket: number;
  grp: string;
  cost: number;
}

/** One row of the console's recent-sessions table (§7.1 table 5). */
export interface UsageSessionRow {
  sessionId: string;
  modelId: string | null;
  sessionType: string;
  timelineKey: string;
  /** Human room label (`Name (Space)`) from `room_metadata`, falling back to `timelineKey`. */
  channelLabel: string;
  triggerSender: string | null;
  status: string;
  completedAt: number | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  agentCost: number;
  toolCost: number;
  toolCalls: number;
}

/** One per-bucket spend point for a single leaderboard user (§7.1 leaderboard cards). */
export interface UsageLeaderboardSeriesPoint {
  bucket: number;
  cost: number;
}

/**
 * One leaderboard entry — the per-actor equivalent of the console's Total-spend card
 * (§7.1 leaderboard tab). `series` carries this actor's per-bucket totals (same
 * `bucketMs` as the page chart) so the card can reuse the sub-period averaging; it is
 * only populated for carded entries (top-N users + the system actors).
 *
 * Two kinds share this shape (`kind`):
 * - `'user'` — a real human, attributed by `trigger_sender_id`; carries a contiguous
 *   `rank` (1..N over humans). `senderId` is the matrix id.
 * - `'system'` — a non-human/self actor (Summarization, Diary, Proactive), attributed
 *   by `session_type`; carries a `comparisonRank` = where it would place if it were a
 *   user. `senderId` holds the actor label.
 */
export interface UsageLeaderboardUser {
  senderId: string;
  displayName: string | null;
  kind: "user" | "system";
  /** Contiguous 1..N rank among humans. Set for `kind:'user'`. */
  rank?: number;
  /** Where this actor would place if it were a user. Set for `kind:'system'`. */
  comparisonRank?: number;
  total: number;
  events: number;
  sessions: number;
  firstTs: number;
  lastTs: number;
  series: UsageLeaderboardSeriesPoint[];
}

/** Reference stats over the non-zero human users in the window (§7.1 leaderboard). */
export interface UsageLeaderboardUserStats {
  count: number;
  average: number;
  median: number;
}

/** Per-actor spend leaderboard over a window (§7.1 leaderboard tab). */
export interface UsageLeaderboard {
  /** Server `now` (ms) the window was computed against — each card's average denominator upper bound. */
  now: number;
  /** Bucket width (ms) of every actor's `series` — hourly for ≤24h windows, daily otherwise. */
  bucketMs: number;
  /**
   * Grand total over EVERY event in the window, including non-attributable
   * (null-sender) spend. The denominator for each actor's share-of-total, matching the
   * Total-spend card; per-actor shares therefore sum to ≤ 100%.
   */
  grandTotal: number;
  /** Average/median spend over the non-zero human users — the System & self reference cards. */
  userStats: UsageLeaderboardUserStats;
  /** Real humans, ranked contiguously 1..N by spend (zero-spend excluded). */
  users: UsageLeaderboardUser[];
  /** Non-human/self actors (Summarization, Diary, Proactive), each with a comparison rank. */
  systemActors: UsageLeaderboardUser[];
}

/**
 * One row per timeline for the observability console's room list (spec §8,
 * `GET /api/rooms`). Aggregated from `timeline_events` with correlated counts;
 * read-only. `display_name` is the cached human room label from `room_metadata`
 * (populated by RoomLabelCache), falling back to `timeline_key` when no label
 * has been resolved yet.
 */
export interface RoomSummaryRow {
  timeline_key: string;
  display_name: string;
  timeline_state: TimelineState;
  last_activity_at: number;
  event_count: number;
  session_count: number;
}

/**
 * Backing data for a summary in the console detail column (spec §12): the raw
 * timeline events it covers (level-1, via `summary_events`) and/or the child
 * summaries it condenses (level-2+, via `summary_parents`). Both are returned;
 * a given summary populates one or the other depending on its level.
 */
export interface SummaryLineage {
  events: CanonicalChatEvent[];
  children: Summary[];
}

// ── Pipeline monitor (ARCHITECTURE.md §11) ───────────────────────────────────
// A unified read model over the four background worker queues (enrichment,
// captioning, summarization, diary). Counts and item lists are derived from the
// DB (the single source of truth that survives restart); live in-flight state is
// read separately from the pool objects via `PipelineStats`.

/** The four background pipelines surfaced by the monitor. */
export type PipelineId = "enrichment" | "captioning" | "summarization" | "diary";

export const PIPELINE_IDS: readonly PipelineId[] = [
  "enrichment",
  "captioning",
  "summarization",
  "diary",
];

/**
 * Status-bucket counts for a pipeline's full history. Each pool's raw statuses are
 * normalized into these six buckets (e.g. `complete`→`done`; a `pending` row with
 * `attempts > 0` → `retrying`). Enrichment's `inactive` (never-queued) rows are
 * excluded entirely — the monitor only counts events that are/were in the queue.
 */
export interface PipelineCounts {
  pending: number;
  processing: number;
  retrying: number;
  done: number;
  failed: number;
  skipped: number;
  /**
   * Captioning-only: `pending` assets the pool would never claim under the current
   * config (the derived `deferred` status — see {@link CaptionEligibility}). Carved
   * out of `pending` so that count reflects real backlog. Always 0 for the other
   * pools (and for captioning when no eligibility is supplied to
   * {@link Storage.getPipelineCounts}).
   */
  deferred: number;
}

/**
 * Whether the captioning pool would *ever* claim a pending media asset under the
 * current config — mirrors the `claimPendingCaptions` join predicate. A pending
 * asset that is NOT eligible is surfaced by the monitor as the derived `deferred`
 * status: with neither `caption_all` nor `caption_assistant_messages` set, media on
 * non-trigger (and non-assistant) messages parks `pending` indefinitely, so the
 * monitor hides it by default rather than counting it as backlog. Supplied to the
 * pipeline read methods for the captioning pool only; absent ⇒ no `deferred`
 * partition (legacy behaviour: every `pending` asset counts as pending work).
 */
export interface CaptionEligibility {
  /** `caption_all`: caption media in every message ⇒ nothing is ever deferred. */
  captionAll: boolean;
  /** `caption_all || caption_assistant_messages`: also caption assistant-message media. */
  captionAssistant: boolean;
}

/**
 * SQL boolean (over the `te` alias) for "the captioning pool would claim this
 * asset's event". Inlines the two config booleans as literals — they are trusted
 * config, never user input, so the fragment carries no bind params and composes
 * into any WHERE/CASE. Mirrors the {@link Storage.claimPendingCaptions} predicate.
 */
function captionEligibleSql(e: CaptionEligibility): string {
  if (e.captionAll) return "1"; // every event eligible — nothing deferred
  // `te.is_backfetch = 1` mirrors the claimPendingCaptions predicate (spec
  // MESSAGE-BACKFETCH §7.3): a promoted backfetched 'pending' row IS claimable, so
  // the monitor must count it as real pending, not derived-deferred.
  const clauses = ["te.trigger_group_id is not null", "te.is_backfetch = 1"];
  if (e.captionAssistant) clauses.push("te.role = 'assistant'");
  return `(${clauses.join(" or ")})`;
}

/** JS mirror of {@link captionEligibleSql} for the row projection. */
function captionEligibleRow(row: Record<string, unknown>, e: CaptionEligibility): boolean {
  if (e.captionAll) return true;
  if (row.trigger_group_id != null) return true;
  if (Number(row.is_backfetch ?? 0) === 1) return true;
  return e.captionAssistant && row.role === "assistant";
}

/**
 * Unified list projection of one queue item across the four heterogeneous pools
 * (event / media asset / job row / level-1 summary). The detail responses stay
 * pool-specific (see {@link PipelineItemDetail}); this is the common browsable
 * shape Col2 renders.
 */
export interface PipelineItem {
  pool: PipelineId;
  /** event id | media asset id | job id | summary id. */
  id: string;
  /** Raw pool status (pending/processing/complete/failed/skipped/done/...). */
  status: string;
  /** enrichment_retries | caption_attempts | jobs.attempts | diary_attempts. */
  attempts: number;
  maxRetries: number;
  /** No explicit "retrying" state exists: derived as status===pending && attempts>0. */
  retrying: boolean;
  /** timeline_key, or null when not resolvable. */
  room: string | null;
  createdAt: number;
  /**
   * Reverse-chron sort key surfaced to the client and used as the keyset cursor
   * value. = updated_at for enrichment/captioning/summarization; = latest_timestamp
   * (the covered range's end) for diary, which has no updated_at column.
   */
  updatedAt: number;
  /** Short input descriptor (sender+snippet / filename / job range / date+range). */
  inputSummary: string;
  /** Short output descriptor, or null when not yet produced. */
  outputSummary: string | null;
  /** Persisted error text where the pool stores one, else null. */
  error: string | null;
  /** agent_sessions.id for summarize/condense/diary (latest attempt); null otherwise. */
  sessionId: string | null;
}

/** One keyset-paginated page of {@link PipelineItem}s. */
export interface PipelineItemPage {
  items: PipelineItem[];
  /** Opaque cursor for the next page, or null when the last page was returned. */
  nextCursor: string | null;
}

/** Filters + keyset cursor for {@link Storage.listPipelineItems}. */
export interface PipelineItemQuery {
  status?: string | null;
  room?: string | null;
  cursor?: string | null;
  limit?: number;
}

/** Result of {@link Storage.retryPipelineItem} (Phase 5 manual retry). */
export type PipelineRetryOutcome =
  | { ok: true }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "not_retryable"; itemStatus: string };

/**
 * Per-pool terminal states that are *safe* to manually reset to `pending`
 * (ARCHITECTURE.md §11 / spec §3.7). The deferred-unsafe states are everything
 * else terminal: summarization `complete` (the summary may already be consumed by
 * a higher-level condensation + a diary entry — a regenerate is a cascade delete,
 * not a status flip; note a best-effort *truncated* result is still a `complete`
 * job — `truncated` is a summaries-row status, not a job status) and diary `done`
 * (the memory file is append-only with no dedup, so a re-run would duplicate the
 * day-file entry). `processing` (in-flight) is never here — stop the linked
 * session instead.
 */
export const PIPELINE_SAFE_RETRY: Record<PipelineId, readonly string[]> = {
  enrichment: ["failed", "complete", "skipped"],
  captioning: ["failed", "complete", "skipped"],
  summarization: ["failed"],
  diary: ["failed", "skipped"],
};

/** Opaque reverse-chron keyset cursor: `(sortValue, id)` on `(updatedAt, id)`. */
interface PipelineCursor {
  s: number;
  id: string;
}

function encodePipelineCursor(cursor: PipelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodePipelineCursor(raw: string | null | undefined): PipelineCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as PipelineCursor).s === "number" &&
      typeof (parsed as PipelineCursor).id === "string"
    ) {
      return parsed as PipelineCursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Per-pool wiring for the unified counts/list read. `scope` is the base predicate
 * that defines "in this pipeline's queue" (e.g. captioning only tracks
 * image/video/audio; enrichment excludes never-queued `inactive` events). `sortCol`
 * /`idCol` drive both the reverse-chron order and the keyset cursor. `project` maps
 * a raw row to the unified {@link PipelineItem}; `done` lists the raw statuses that
 * normalize to the `done` bucket.
 */
interface PipelineListSpec {
  table: string;
  statusCol: string;
  attemptsCol: string;
  roomCol: string;
  sortCol: string;
  idCol: string;
  scope: string | null;
  done: string[];
  /**
   * Optional predicate for the DEFAULT (no status filter) view that supersedes
   * `scope` + the generic `status != 'skipped'` — written to match a pool's partial
   * "active" index verbatim so that primary view is an index walk, not a scan past
   * the skipped bulk. Set for enrichment (the large, skipped-dominated table); other
   * pools fall back to `scope` + `!= 'skipped'`.
   */
  defaultScope?: string;
  /** Full SELECT list + FROM (incl. any join + correlated session subquery). */
  selectFrom: string;
  /**
   * Maps a raw row to a {@link PipelineItem}. `eligibility` is supplied for the
   * captioning pool only, where it relabels an ineligible pending asset's status
   * to the derived `deferred` (consistent with the list/count filtering).
   */
  project: (
    row: Record<string, unknown>,
    defaultMaxRetries: number,
    eligibility?: CaptionEligibility,
  ) => PipelineItem;
}

/**
 * Per-pool wiring for the unqualified (no-join) counts aggregate. Mirrors the
 * scope/status/attempts/done of {@link PIPELINE_LIST_SPECS} but with bare column
 * names, since the counts query hits the single base table directly.
 */
interface PipelineCountSpec {
  table: string;
  statusCol: string;
  attemptsCol: string;
  scope: string | null;
  done: string[];
}

const PIPELINE_COUNT_SPECS: Record<PipelineId, PipelineCountSpec> = {
  enrichment: {
    table: "timeline_events",
    statusCol: "enrichment_status",
    attemptsCol: "enrichment_retries",
    scope: "enrichment_status != 'inactive'",
    done: ["complete"],
  },
  captioning: {
    // Joins timeline_events so the count can evaluate caption eligibility (the
    // `deferred` partition); the join is on the indexed FK and inner (every asset
    // has a parent event), so it does not change the scoped row set.
    table: "media_assets ma join timeline_events te on te.id = ma.event_id",
    statusCol: "ma.caption_status",
    attemptsCol: "ma.caption_attempts",
    scope: "ma.media_type in ('image', 'video', 'audio')",
    done: ["complete"],
  },
  summarization: {
    table: "summarization_jobs",
    statusCol: "status",
    attemptsCol: "attempts",
    scope: null,
    done: ["complete"],
  },
  diary: {
    table: "summaries",
    statusCol: "diary_status",
    attemptsCol: "diary_attempts",
    scope: "diary_status is not null",
    done: ["done"],
  },
};

/** Collapse whitespace and clip to `max` chars for a list descriptor. */
function pipelineSnippet(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** ISO day (UTC) for a diary item's covered-range end, for the list descriptor. */
function pipelineDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const PIPELINE_LIST_SPECS: Record<PipelineId, PipelineListSpec> = {
  enrichment: {
    table: "timeline_events",
    statusCol: "enrichment_status",
    attemptsCol: "enrichment_retries",
    roomCol: "timeline_key",
    sortCol: "updated_at",
    idCol: "id",
    // Exclude never-queued events (assistant turns / nothing enrichable): the
    // monitor only shows events that are/were actually in the enrichment queue.
    scope: "enrichment_status != 'inactive'",
    // Default view also hides `skipped` (every plain message); the merged predicate
    // matches idx_timeline_events_active_updated so it stays an index walk.
    defaultScope: "enrichment_status not in ('inactive', 'skipped')",
    done: ["complete"],
    selectFrom: `select id, enrichment_status as status, enrichment_retries as attempts,
        timeline_key as room, created_at, updated_at,
        sender_display_name, sender_id, body
      from timeline_events`,
    project: (row, maxRetries) => {
      const status = String(row.status);
      const attempts = Number(row.attempts ?? 0);
      const sender =
        (row.sender_display_name as string | null) ?? (row.sender_id as string | null) ?? "unknown";
      const createdAt = Number(row.created_at ?? 0);
      return {
        pool: "enrichment",
        id: String(row.id),
        status,
        attempts,
        maxRetries,
        retrying: status === "pending" && attempts > 0,
        room: (row.room as string | null) ?? null,
        createdAt,
        updatedAt: Number(row.updated_at ?? createdAt),
        inputSummary: `${sender}: ${pipelineSnippet(String(row.body ?? ""))}`,
        // Enrichment does not persist an error string on the row (no column); the
        // produced rows live in the detail response. Output stays in detail.
        outputSummary: null,
        error: null,
        sessionId: null,
      };
    },
  },
  captioning: {
    table: "media_assets",
    statusCol: "ma.caption_status",
    attemptsCol: "ma.caption_attempts",
    roomCol: "te.timeline_key",
    sortCol: "ma.updated_at",
    idCol: "ma.id",
    // The captioning track is image/video/audio assets only (what the pool claims).
    scope: "ma.media_type in ('image', 'video', 'audio')",
    done: ["complete"],
    selectFrom: `select ma.id as id, ma.caption_status as status, ma.caption_attempts as attempts,
        te.timeline_key as room, ma.created_at as created_at, ma.updated_at as updated_at,
        ma.original_filename as original_filename, ma.media_type as media_type,
        ma.caption as caption, ma.caption_error as caption_error,
        te.trigger_group_id as trigger_group_id, te.role as role, te.is_backfetch as is_backfetch
      from media_assets ma
      join timeline_events te on te.id = ma.event_id`,
    project: (row, maxRetries, eligibility) => {
      const attempts = Number(row.attempts ?? 0);
      // Derived `deferred`: a fresh pending asset the pool would never claim under
      // the current config (mirrors the list/count filter), surfaced as its own
      // status so the monitor can hide it by default yet badge it distinctly.
      const status =
        eligibility && row.status === "pending" && attempts === 0 && !captionEligibleRow(row, eligibility)
          ? "deferred"
          : String(row.status);
      const createdAt = Number(row.created_at ?? 0);
      const caption = (row.caption as string | null) ?? null;
      return {
        pool: "captioning",
        id: String(row.id),
        status,
        attempts,
        maxRetries,
        retrying: status === "pending" && attempts > 0,
        room: (row.room as string | null) ?? null,
        createdAt,
        updatedAt: Number(row.updated_at ?? createdAt),
        inputSummary: `${(row.original_filename as string | null) ?? "(file)"} · ${row.media_type}`,
        outputSummary: caption ? pipelineSnippet(caption, 100) : null,
        error: (row.caption_error as string | null) ?? null,
        sessionId: null,
      };
    },
  },
  summarization: {
    table: "summarization_jobs",
    statusCol: "status",
    attemptsCol: "attempts",
    roomCol: "timeline_key",
    sortCol: "updated_at",
    idCol: "id",
    scope: null,
    done: ["complete"],
    selectFrom: `select id, status, attempts, max_retries, timeline_key as room,
        created_at, updated_at, level, input_token_count, target_token_count,
        best_effort_draft, error, result_summary_id,
        (select sm.token_count from summaries sm
           where sm.id = summarization_jobs.result_summary_id) as result_token_count,
        (select s.id from agent_sessions s
           where s.trigger_event_id = 'summarize:' || summarization_jobs.id
           order by s.created_at desc limit 1) as session_id
      from summarization_jobs`,
    project: (row, defaultMaxRetries) => {
      const status = String(row.status);
      const attempts = Number(row.attempts ?? 0);
      const createdAt = Number(row.created_at ?? 0);
      const resultSummaryId = (row.result_summary_id as string | null) ?? null;
      const bestEffort = (row.best_effort_draft as string | null) ?? null;
      const resultTokenCount = (row.result_token_count as number | null) ?? null;
      // "to" side: actual produced size once available, shown as actual/target
      // so target-vs-actual drift is visible; falls back to the target budget
      // alone while the job is still pending/running.
      const toLabel =
        resultTokenCount != null
          ? `${resultTokenCount}/${row.target_token_count}`
          : `${row.target_token_count}`;
      return {
        pool: "summarization",
        id: String(row.id),
        status,
        attempts,
        maxRetries: Number(row.max_retries ?? defaultMaxRetries),
        retrying: status === "pending" && attempts > 0,
        room: (row.room as string | null) ?? null,
        createdAt,
        updatedAt: Number(row.updated_at ?? createdAt),
        inputSummary: `L${row.level} · ${row.input_token_count ?? "?"}→${toLabel} tok`,
        outputSummary: resultSummaryId
          ? `→ ${resultSummaryId}`
          : bestEffort
            ? "best-effort draft"
            : null,
        error: (row.error as string | null) ?? null,
        sessionId: (row.session_id as string | null) ?? null,
      };
    },
  },
  diary: {
    table: "summaries",
    statusCol: "diary_status",
    attemptsCol: "diary_attempts",
    roomCol: "timeline_key",
    sortCol: "latest_timestamp",
    idCol: "id",
    // Only the diary-bearing level-1 summaries (level 2+ have NULL diary_status).
    scope: "diary_status is not null",
    done: ["done"],
    selectFrom: `select id, diary_status as status, diary_attempts as attempts,
        timeline_key as room, created_at, latest_timestamp, earliest_timestamp, event_count,
        (select s.id from agent_sessions s
           where s.trigger_event_id = 'diary:' || summaries.id
           order by s.created_at desc limit 1) as session_id
      from summaries`,
    project: (row, defaultMaxRetries) => {
      const status = String(row.status);
      const attempts = Number(row.attempts ?? 0);
      const latestTs = Number(row.latest_timestamp ?? 0);
      return {
        pool: "diary",
        id: String(row.id),
        status,
        attempts,
        maxRetries: defaultMaxRetries,
        retrying: status === "pending" && attempts > 0,
        room: (row.room as string | null) ?? null,
        createdAt: Number(row.created_at ?? 0),
        // summaries has no updated_at; the diary item's recency is its range end.
        updatedAt: latestTs,
        inputSummary: `${pipelineDay(latestTs)} · ${row.event_count} msgs`,
        outputSummary:
          status === "done" ? "entry written" : status === "skipped" ? "no participation" : null,
        // Diary stores no error text on the summary row; the session carries it.
        error: null,
        sessionId: (row.session_id as string | null) ?? null,
      };
    },
  },
};

/**
 * Message-type predicate for the `chat_index` activity queries (§9e) — the same dimensions
 * `search_messages` filters on (`is_reply`/`has_attachment`/`has_link`/`attachment_types`),
 * so `user_activity` can count e.g. only text posts, only images, only attachments. Returns
 * bare-column SQL clauses (no table alias) plus the bound params, AND-combined by the caller.
 * Param names are `@f…`-prefixed to avoid colliding with the queries' room/time/sender binds.
 */
export interface ChatTypeFilter {
  isReply?: boolean;
  hasAttachment?: boolean;
  hasLink?: boolean;
  /** csv tokens from {image,video,audio,file}; OR-matched, and implies has_attachment=1. */
  attachmentTypes?: string[];
}

function chatTypeFilterClauses(filter: ChatTypeFilter | undefined, params: Record<string, unknown>): string[] {
  const clauses: string[] = [];
  if (!filter) return clauses;
  if (filter.isReply !== undefined) {
    clauses.push("is_reply = @fIsReply");
    params.fIsReply = filter.isReply ? 1 : 0;
  }
  if (filter.hasAttachment !== undefined) {
    clauses.push("has_attachment = @fHasAttachment");
    params.fHasAttachment = filter.hasAttachment ? 1 : 0;
  }
  if (filter.hasLink !== undefined) {
    clauses.push("has_link = @fHasLink");
    params.fHasLink = filter.hasLink ? 1 : 0;
  }
  if (filter.attachmentTypes && filter.attachmentTypes.length > 0) {
    // attachment_types is a csv of the fixed tokens image/video/audio/file — none is a
    // substring of another, so a LIKE per requested type is unambiguous (mirrors searchChat).
    const ors = filter.attachmentTypes.map((t, i) => {
      params[`fAt${i}`] = `%${t}%`;
      return `attachment_types like @fAt${i}`;
    });
    clauses.push(`has_attachment = 1 and (${ors.join(" or ")})`);
  }
  return clauses;
}

export class Storage {
  readonly db: Database.Database;
  private readonly queue: Array<WriteJob<any>> = [];
  private draining = false;
  private closed = false;
  private readonly logger?: Logger;

  private constructor(db: Database.Database, logger?: Logger) {
    this.db = db;
    this.logger = logger;
  }

  static async open(options: StorageOptions): Promise<Storage> {
    await mkdir(path.dirname(options.databasePath), { recursive: true });
    const db = new Database(options.databasePath);
    const storage = new Storage(db, options.logger);
    await storage.write((writer) => {
      writer.pragma("journal_mode = WAL");
      writer.pragma("foreign_keys = ON");
      // Wait up to 5s on a locked database rather than failing immediately with
      // SQLITE_BUSY. The single-writer queue avoids self-contention, but external
      // readers (the observability console reads the DB directly) and the WAL
      // checkpoint can still briefly hold a lock; without busy_timeout a transient
      // lock would surface as a swallowed fire-and-forget write failure.
      writer.pragma("busy_timeout = 5000");
      // Distinguish a brand-new database from an existing one BEFORE applying
      // SCHEMA (which uses `if not exists` and so leaves no trace of which case we
      // are in). A fresh DB has no user tables yet; SCHEMA then builds the full
      // latest shape and runMigrations only stamps the version — migration steps
      // run only for an existing DB stamped below LATEST.
      const isFreshDatabase =
        (
          writer
            .prepare(
              `select count(*) as n from sqlite_master where type = 'table' and name = 'timeline_events'`,
            )
            .get() as { n: number }
        ).n === 0;
      if (isFreshDatabase) {
        // Fresh build must be all-or-nothing (issue #7): wrap the full-schema
        // build AND the version stamp in one transaction so a crash mid-build
        // cannot leave a partial set of tables that the next open()'s
        // `timeline_events`-presence probe would misclassify as fresh.
        // runMigrations(fresh) here only stamps user_version and opens NO inner
        // transaction, so there is no nested BEGIN. The existing-DB path keeps its
        // own transaction inside runMigrations (better-sqlite3 forbids nested
        // transactions), so it must NOT be wrapped here.
        writer.transaction(() => {
          writer.exec(SCHEMA);
          runMigrations(writer, true);
        })();
      } else {
        // Existing DB: run runMigrations FIRST (applies any pending MIGRATIONS
        // steps; throws if the DB is stamped above LATEST), then SCHEMA. SCHEMA's
        // `create table/index if not exists` reconciles the existing DB to the
        // genesis shape, creating any object it lacks; it is idempotent on a DB
        // already at the latest shape. The order is retained so any future
        // stepwise migration would land before SCHEMA's latest-shape DDL.
        runMigrations(writer, false);
        writer.exec(SCHEMA);
      }
    });
    return storage;
  }

  write<T>(run: (db: Database.Database) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Storage is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      this.drainQueue();
    });
  }

  read<T>(run: (db: Database.Database) => T): T {
    if (this.closed) throw new Error("Storage is closed");
    return run(this.db);
  }

  readAndWrite<T>(run: (db: Database.Database) => T): Promise<T> {
    return this.write((db) => db.transaction(() => run(db))());
  }

  appendTimelineEvent(event: CanonicalChatEvent, enrichmentStatus?: string): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      db.prepare(
        `insert into timeline_events (
          id, external_id, timeline_key, provider, role, sender_id,
          sender_display_name, body, timestamp, received_at, agent_session_id,
          agent_session_generation, event_json, enrichment_status, created_at, updated_at
        ) values (
          @id, @externalId, @timelineKey, @provider, @role, @senderId,
          @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
          @agentSessionGeneration, @eventJson, @enrichmentStatus, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          external_id = excluded.external_id,
          timeline_key = excluded.timeline_key,
          provider = excluded.provider,
          role = excluded.role,
          sender_id = excluded.sender_id,
          sender_display_name = excluded.sender_display_name,
          body = excluded.body,
          timestamp = excluded.timestamp,
          received_at = excluded.received_at,
          agent_session_id = excluded.agent_session_id,
          agent_session_generation = excluded.agent_session_generation,
          event_json = excluded.event_json,
          enrichment_status = excluded.enrichment_status,
          created_at = timeline_events.created_at,
          updated_at = excluded.updated_at`,
      ).run({
        id: event.id,
        externalId: event.externalId ?? null,
        timelineKey: event.timelineKey,
        provider: event.provider,
        role: event.role,
        senderId: event.sender.id,
        senderDisplayName: event.sender.displayName ?? null,
        body: event.body,
        timestamp: event.timestamp,
        receivedAt: event.receivedAt,
        agentSessionId: event.agentSessionId ?? null,
        agentSessionGeneration: event.agentSessionGeneration ?? null,
        eventJson: JSON.stringify(event),
        enrichmentStatus: enrichmentStatus ?? "pending",
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  getTimelineEvents(timelineKey: string, limit = 200): CanonicalChatEvent[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from (
             select event_json, timestamp, received_at, id
             from timeline_events
             where timeline_key = ?
             order by timestamp desc, received_at desc, id desc
             limit ?
           )
           order by timestamp asc, received_at asc, id asc`,
        )
        .all(timelineKey, limit) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  getTimelineEventsForContext(
    timelineKey: string,
    retainedStartEventId: string | null | undefined,
    limit = 1000,
  ): CanonicalChatEvent[] {
    if (!retainedStartEventId) return this.getTimelineEvents(timelineKey, limit);

    const cursor = this.read((db) =>
      db
        .prepare(
          `select timestamp, received_at, id
           from timeline_events
           where timeline_key = ? and id = ?`,
        )
        .get(timelineKey, retainedStartEventId) as
        | { timestamp: number; received_at: number; id: string }
        | undefined,
    );
    if (!cursor) return this.getTimelineEvents(timelineKey, limit);

    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from timeline_events
           where timeline_key = @timelineKey
             and (
               timestamp > @timestamp
               or (timestamp = @timestamp and received_at > @receivedAt)
               or (timestamp = @timestamp and received_at = @receivedAt and id >= @id)
             )
           order by timestamp asc, received_at asc, id asc
           limit @limit`,
        )
        .all({
          timelineKey,
          timestamp: cursor.timestamp,
          receivedAt: cursor.received_at,
          id: cursor.id,
          limit,
        }) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  getTimelineEventById(id: string): CanonicalChatEvent | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select event_json from timeline_events where id = ?`)
        .get(id) as { event_json: string } | undefined,
    );
    return row ? (JSON.parse(row.event_json) as CanonicalChatEvent) : undefined;
  }

  /**
   * Whether a stored event entered via message-only backfetch (spec
   * MESSAGE-BACKFETCH §5). Read by the enrichment worker to choose the `deferred`
   * caption state (§7.3). False for any missing row.
   */
  isBackfetchEvent(id: string): boolean {
    const row = this.read((db) =>
      db.prepare(`select is_backfetch from timeline_events where id = ?`).get(id) as
        | { is_backfetch: number }
        | undefined,
    );
    return (row?.is_backfetch ?? 0) === 1;
  }

  /**
   * Count of backfetched events still awaiting/under enrichment (spec
   * MESSAGE-BACKFETCH §6.4 drain-aware pacing): `is_backfetch=1` with
   * enrichment_status in pending/processing. The coordinator pauses paging while
   * this exceeds the configured backlog so a single job can't flood the pool.
   */
  countPendingBackfetchEnrichment(): number {
    const row = this.read((db) =>
      db
        .prepare(
          `select count(*) as c from timeline_events
           where is_backfetch = 1 and enrichment_status in ('pending', 'processing')`,
        )
        .get() as { c: number },
    );
    return row.c;
  }

  /** Current enrichment_status of a stored event, or undefined if absent. */
  getEnrichmentStatus(id: string): string | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select enrichment_status from timeline_events where id = ?`)
        .get(id) as { enrichment_status: string } | undefined,
    );
    return row?.enrichment_status;
  }

  getTimelineCompactionState(timelineKey: string): TimelineCompactionState | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select state_json from timeline_compaction_state where timeline_key = ?`)
        .get(timelineKey) as { state_json: string } | undefined,
    );
    return row ? (JSON.parse(row.state_json) as TimelineCompactionState) : undefined;
  }

  saveTimelineCompactionState(state: TimelineCompactionState): Promise<void> {
    return this.write((db) => {
      // The on-conflict path deliberately omits `timeline_state` from the SET
      // list, so a summarization-pipeline save never clobbers the lifecycle
      // state owned by `setTimelineState`/activation. Symmetric to the note on
      // `setTimelineState` (which conversely leaves `state_json`/the compaction
      // cursors untouched): the two writers update disjoint columns of the same
      // row and never regress each other.
      //
      // The bare insert branch (no existing row) deliberately omits
      // `timeline_state` too, falling back to the column default `'inactive'`.
      // That default is only correct because the sole caller — the summarization
      // pipeline — runs exclusively for already-active timelines, which always
      // already have a row written by `setTimelineState('active')` during
      // activation. So this call always hits the UPDATE path; the insert branch
      // is effectively unreachable today. A FUTURE caller that wrote compaction
      // state before activation would insert with `timeline_state='inactive'`
      // while carrying real cursors, and `pruneInactiveTimelineEvents` would
      // treat the timeline as prunable — so such a caller must seed the
      // lifecycle state explicitly rather than rely on this insert.
      db.prepare(
        `insert into timeline_compaction_state (
          timeline_key, compact_start_event_id, rich_start_event_id, state_json, updated_at
        ) values (
          @timelineKey, @compactStartEventId, @richStartEventId, @stateJson, @updatedAt
        )
        on conflict(timeline_key) do update set
          compact_start_event_id = excluded.compact_start_event_id,
          rich_start_event_id = excluded.rich_start_event_id,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at`,
      ).run({
        timelineKey: state.timelineKey,
        compactStartEventId: state.compactStartEventId,
        richStartEventId: state.richStartEventId,
        stateJson: JSON.stringify(state),
        updatedAt: state.updatedAt,
      });
    });
  }

  /**
   * The context floor event id for a timeline (spec MESSAGE-BACKFETCH §4), or
   * undefined when none is set (the normal state — no backfetch has run). The
   * floor is the oldest event the first-class pipeline may consider; everything
   * strictly below it is the search-only backfetched region.
   */
  getContextFloorEventId(timelineKey: string): string | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select context_floor_event_id from timeline_compaction_state where timeline_key = ?`)
        .get(timelineKey) as { context_floor_event_id: string | null } | undefined,
    );
    return row?.context_floor_event_id ?? undefined;
  }

  /**
   * The context floor resolved to a `(timestamp, received_at, id)` cursor, for the
   * lower-bound clamp in context/summarization queries (§4.4/§4.5). Returns
   * undefined when no floor is set OR the floor event has since been pruned — in
   * both cases callers apply no clamp (a pruned floor can only mean its whole
   * first-class neighbourhood is gone, never that below-floor rows should surface).
   */
  getContextFloorCursor(timelineKey: string): TimelineCursor | undefined {
    const floorId = this.getContextFloorEventId(timelineKey);
    if (!floorId) return undefined;
    return this.getEventCursor(timelineKey, floorId);
  }

  /**
   * Pin the context floor to `eventId` IFF it is currently unset (spec §4.3 —
   * "set once, never moved"). Creates the `timeline_compaction_state` row when
   * absent (a backfetch may target a timeline that has never been activated),
   * seeding the minimal `state_json` + the default `'inactive'` lifecycle exactly
   * like `setTimelineState` so the row is well-formed for every other reader.
   * Returns whether this call set it and the resulting floor id (the freshly-set
   * one, or the pre-existing floor when a prior job/run already pinned it).
   */
  setContextFloorIfUnset(timelineKey: string, eventId: string): Promise<{ set: boolean; floorEventId: string }> {
    return this.write((db) => {
      const now = Date.now();
      const existing = db
        .prepare(`select context_floor_event_id from timeline_compaction_state where timeline_key = ?`)
        .get(timelineKey) as { context_floor_event_id: string | null } | undefined;
      if (existing === undefined) {
        const seedState: TimelineCompactionState = {
          schemaVersion: 1,
          timelineKey,
          compactStartEventId: null,
          richStartEventId: null,
          updatedAt: now,
        };
        db.prepare(
          `insert into timeline_compaction_state (
            timeline_key, compact_start_event_id, rich_start_event_id, state_json,
            context_floor_event_id, updated_at
          ) values (@timelineKey, null, null, @stateJson, @floor, @updatedAt)`,
        ).run({ timelineKey, stateJson: JSON.stringify(seedState), floor: eventId, updatedAt: now });
        return { set: true, floorEventId: eventId };
      }
      if (existing.context_floor_event_id != null) {
        return { set: false, floorEventId: existing.context_floor_event_id };
      }
      db.prepare(
        `update timeline_compaction_state set context_floor_event_id = ?, updated_at = ? where timeline_key = ?`,
      ).run(eventId, now, timelineKey);
      return { set: true, floorEventId: eventId };
    });
  }

  /**
   * Current lifecycle state of a timeline. A missing `timeline_compaction_state`
   * row means the channel has never been triggered, i.e. `'inactive'` (§2).
   */
  getTimelineState(timelineKey: string): TimelineState {
    const row = this.read((db) =>
      db
        .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
        .get(timelineKey) as { timeline_state: TimelineState } | undefined,
    );
    return row?.timeline_state ?? "inactive";
  }

  /**
   * Every timeline that has been activated (has a `timeline_compaction_state`
   * row in state `'active'`). Drives the eager summarization indexer's startup
   * sweep (`SummarizationIndexer.reconcileAll`) — inactive/never-triggered
   * timelines have no sessions and need no summaries.
   */
  listActiveTimelineKeys(): string[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select timeline_key from timeline_compaction_state
           where timeline_state = 'active'
           order by timeline_key`,
        )
        .all() as Array<{ timeline_key: string }>,
    );
    return rows.map((row) => row.timeline_key);
  }

  /**
   * The committed high-water mark across a set of timeline keys — the single
   * newest event by the canonical `(timestamp, received_at, id)` ordering used
   * everywhere reads sort. Returns the event's `timestamp`, full canonical `id`,
   * and its provider `externalId` (the gap-backfetch floor; ARCHITECTURE.md §7c
   * §5.1 — the external id is what identifies the floor when it is a bot-sent
   * message stored under an `assistant:…` canonical id, which a re-fetched
   * `matrix:…` candidate id can never match), or `undefined` when none of the
   * keys hold any event. Pass the explicit list of a room's keys (room/DM +
   * thread) so the floor is the max across all its timelines.
   */
  getHighWaterMark(
    timelineKeys: string[],
  ): { timestamp: number; id: string; externalId?: string } | undefined {
    if (timelineKeys.length === 0) return undefined;
    const placeholders = timelineKeys.map(() => "?").join(",");
    const row = this.read((db) =>
      db
        .prepare(
          `select id, timestamp, external_id from timeline_events
           where timeline_key in (${placeholders})
           order by timestamp desc, received_at desc, id desc
           limit 1`,
        )
        .get(...timelineKeys) as
        | { id: string; timestamp: number; external_id: string | null }
        | undefined,
    );
    return row
      ? { timestamp: row.timestamp, id: row.id, externalId: row.external_id ?? undefined }
      : undefined;
  }

  /**
   * The oldest event id currently held for a timeline key by the canonical
   * `(timestamp, received_at, id)` ordering, or undefined when the key holds no
   * events. Used to pin the context floor before the first below-floor backfetch
   * insert (spec MESSAGE-BACKFETCH §4.3): the floor is set to this current-oldest
   * so every paged-in older event sorts strictly below it (§4.5).
   */
  getOldestEventId(timelineKey: string): string | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `select id from timeline_events
           where timeline_key = ?
           order by timestamp asc, received_at asc, id asc
           limit 1`,
        )
        .get(timelineKey) as { id: string } | undefined,
    );
    return row?.id;
  }

  /**
   * Set a timeline's lifecycle state, upserting the compaction-state row. The
   * insert seeds a minimal valid `state_json`; the on-conflict path touches only
   * `timeline_state`/`updated_at`, preserving the compaction cursors and any
   * existing serialized state written by the summarization pipeline.
   */
  setTimelineState(timelineKey: string, state: TimelineState): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      // Minimal seed written only on first insert. The on-conflict path below
      // deliberately leaves `state_json` untouched, so this never clobbers real
      // compaction cursors. Keep this shape in sync with the
      // `TimelineCompactionState` written by `saveTimelineCompactionState` — both
      // sites construct the same serialized shape.
      const seedState: TimelineCompactionState = {
        schemaVersion: 1,
        timelineKey,
        compactStartEventId: null,
        richStartEventId: null,
        updatedAt: now,
      };
      db.prepare(
        `insert into timeline_compaction_state (
          timeline_key, compact_start_event_id, rich_start_event_id, state_json,
          timeline_state, updated_at
        ) values (
          @timelineKey, null, null, @stateJson, @state, @updatedAt
        )
        on conflict(timeline_key) do update set
          timeline_state = excluded.timeline_state,
          updated_at = excluded.updated_at`,
      ).run({
        timelineKey,
        stateJson: JSON.stringify(seedState),
        state,
        updatedAt: now,
      });
    });
  }

  /**
   * Cached human room label for a timeline, or `undefined` if none has been
   * resolved yet. Read by RoomLabelCache to decide whether a (re)resolve is due
   * (missing or `resolved_at` older than the TTL).
   */
  getRoomMetadata(timelineKey: string): { displayName: string; resolvedAt: number } | undefined {
    const row = this.read((db) =>
      db
        .prepare(`select display_name, resolved_at from room_metadata where timeline_key = ?`)
        .get(timelineKey) as { display_name: string; resolved_at: number } | undefined,
    );
    return row ? { displayName: row.display_name, resolvedAt: row.resolved_at } : undefined;
  }

  /**
   * Upsert the cached human room label for a timeline. Stamps `resolved_at` so
   * RoomLabelCache can expire stale labels (rooms can be renamed). Written by
   * RoomLabelCache on inbound activity and the startup backfill; read by
   * `listConsoleRooms` and `getRoomMetadata`.
   */
  setRoomDisplayName(timelineKey: string, displayName: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into room_metadata (timeline_key, display_name, resolved_at)
         values (@timelineKey, @displayName, @resolvedAt)
         on conflict(timeline_key) do update set
           display_name = excluded.display_name,
           resolved_at = excluded.resolved_at`,
      ).run({ timelineKey, displayName, resolvedAt: Date.now() });
    });
  }

  /**
   * Every distinct timeline key known to the store (events, sessions, or a
   * lifecycle row), regardless of state. Used by the startup room-label backfill
   * to resolve names for currently-idle rooms, and by the startup gap-backfetch
   * room enumeration (ARCHITECTURE.md §7c §6.1) — "all known rooms" (G5), active
   * *and* currently-inactive/pruned, without a native room-list API. The
   * `timeline_compaction_state` arm covers activated rooms whose events were all
   * pruned by retention (the lifecycle row outlives them); thread keys are
   * included and grouped under their room by the coordinator.
   */
  listKnownTimelineKeys(): string[] {
    return this.read((db) =>
      (
        db
          .prepare(
            `select timeline_key from timeline_events
             union
             select timeline_key from agent_sessions
             union
             select timeline_key from timeline_compaction_state`,
          )
          .all() as Array<{ timeline_key: string }>
      ).map((row) => row.timeline_key),
    );
  }

  /**
   * Flip every `'inactive'` event in a timeline to `'pending'` so the enrichment
   * and caption pools pick them up after activation (§4 step 4). Returns the
   * number of rows updated.
   */
  activateTimelineEvents(timelineKey: string): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update timeline_events set enrichment_status = 'pending', updated_at = ?
           where timeline_key = ? and enrichment_status = 'inactive'`,
        )
        .run(Date.now(), timelineKey);
      return result.changes;
    });
  }

  /**
   * Reset timelines stranded in `'activating'` (process crashed mid-activation)
   * back to `'inactive'` so the next trigger re-runs activation. Called on
   * startup, mirroring the stale-claim resets for enrichment/captions/jobs.
   * Returns the number of rows reset.
   *
   * NOTE (#9): this only heals timelines stuck in `'activating'`. It does NOT
   * touch `'active'` timelines. Combined with the retention sweep
   * (`pruneInactiveTimelineEvents`) only touching INACTIVE timelines, this means
   * the activation path's bulk `'inactive'`→`'pending'` flip
   * (`activateTimelineEvents`) MUST happen before the `setTimelineState('active')`
   * promotion: any `'inactive'` event rows left under an `'active'` timeline would
   * be invisible to both recovery paths and thus never enriched or pruned. See
   * the matching comment in `ActivationCoordinator.activateTimeline`.
   */
  resetStaleActivations(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update timeline_compaction_state set timeline_state = 'inactive', updated_at = ?
           where timeline_state = 'activating'`,
        )
        .run(Date.now());
      return result.changes;
    });
  }

  /**
   * Prune events that belong to *inactive* timelines and are older than
   * `olderThanMs` (a millisecond cutoff: rows with `timestamp < olderThanMs` are
   * deleted). Implements the Phase 8 retention job (spec §3,§13).
   *
   * A timeline is "inactive" when it has no `timeline_compaction_state` row (a
   * never-engaged channel — see `getTimelineState` semantics) OR its row's
   * `timeline_state = 'inactive'`. Events belonging to timelines in any non-
   * inactive state (`activating`/`active`/`backfilling`) are NEVER pruned — only
   * those whose `timeline_key` is absent from the set of non-inactive rows.
   *
   * Returns the number of rows deleted. Runs through the single-writer queue.
   *
   * Ordering invariant: prune treats "no `timeline_compaction_state` row =
   * prunable", which stays safe only because `activateTimeline` writes the
   * `'activating'` state (via `setTimelineState`, which inserts the row) BEFORE
   * storing any backfilled events. Both writes serialize through the
   * single-writer queue, so a concurrent prune can never see backfilled rows
   * while their timeline still lacks a non-`inactive` row (which would delete
   * them out from under an in-flight activation).
   */
  pruneInactiveTimelineEvents(olderThanMs: number): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `delete from timeline_events
           where timestamp < ?
             and timeline_key not in (
               select timeline_key from timeline_compaction_state
               where timeline_state != 'inactive'
             )`,
        )
        .run(olderThanMs);
      return result.changes;
    });
  }

  // Scoped by timeline_key (issue #3): two bot accounts sharing a room store the
  // same Matrix event as two rows differing only by canonical id, so an unscoped
  // `(provider, external_id)` lookup would return an arbitrary account's row. The
  // existing `(provider, external_id)` index still serves the query — timeline_key
  // just filters the tiny matched set.
  getTimelineEventByExternalId(
    provider: string,
    externalId: string,
    timelineKey: string,
  ): CanonicalChatEvent | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `select event_json from timeline_events
           where provider = ? and external_id = ? and timeline_key = ? limit 1`,
        )
        .get(provider, externalId, timelineKey) as { event_json: string } | undefined,
    );
    return row ? (JSON.parse(row.event_json) as CanonicalChatEvent) : undefined;
  }

  /**
   * Resolve the ACTUAL stored timeline_key of an edit target (issue #4). A
   * re-decrypted `m.replace` placeholder always lands on the room/DM key (its
   * thread relation was megolm-encrypted at store time), but the target original,
   * once decrypted, may live on a thread key (`…:thread:<root>`). Looking the edit
   * up under the placeholder's room key alone would miss a thread target and park
   * the edit under the wrong key, where replay never matches — silent edit loss.
   *
   * Scope: the target is the same Matrix event in the same room/account as the
   * placeholder, so we match `(provider, external_id)` constrained to the
   * placeholder's room base — either the room key itself or any of its thread keys
   * (`<roomKey>:thread:%`). The room base embeds `matrix:<account>:room:<roomId>`,
   * so this preserves the multi-account scoping that the room-key lookup has
   * (issue #3): a different account's row lives under a different base and is never
   * matched. Returns the target's stored timeline_key, or undefined if no target
   * is stored under this room base (caller falls back to the room key → parks).
   * Prefers an exact room-key match (the common room-target case) over a thread one.
   */
  resolveEditTargetTimelineKey(
    provider: string,
    externalId: string,
    roomTimelineKey: string,
  ): string | undefined {
    const row = this.read(
      (db) =>
        db
          .prepare(
            `select timeline_key from timeline_events
             where provider = ? and external_id = ?
               and (timeline_key = @roomKey
                    or timeline_key like @threadPrefix escape '\\')
             order by case when timeline_key = @roomKey then 0 else 1 end,
                      timeline_key
             limit 1`,
          )
          .get(provider, externalId, {
            roomKey: roomTimelineKey,
            // SQLite LIKE: escape %/_/\ in the room key so a roomId containing them
            // can't broaden the match. `:thread:` keys append the root after this.
            threadPrefix: `${roomTimelineKey.replace(/[\\%_]/g, "\\$&")}:thread:%`,
          }) as { timeline_key: string } | undefined,
    );
    return row?.timeline_key;
  }

  updateTimelineEvent(
    id: string,
    updater: (event: CanonicalChatEvent) => CanonicalChatEvent,
  ): Promise<CanonicalChatEvent> {
    return this.write((db) => {
      const row = db
        .prepare(`select event_json from timeline_events where id = ?`)
        .get(id) as { event_json: string } | undefined;
      if (!row) throw new Error(`Timeline event not found: ${id}`);
      const updated = updater(JSON.parse(row.event_json) as CanonicalChatEvent);
      db.prepare(
        `update timeline_events
         set external_id = @externalId,
             timeline_key = @timelineKey,
             provider = @provider,
             role = @role,
             sender_id = @senderId,
             sender_display_name = @senderDisplayName,
             body = @body,
             timestamp = @timestamp,
             received_at = @receivedAt,
             agent_session_id = @agentSessionId,
             event_json = @eventJson,
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id,
        externalId: updated.externalId ?? null,
        timelineKey: updated.timelineKey,
        provider: updated.provider,
        role: updated.role,
        senderId: updated.sender.id,
        senderDisplayName: updated.sender.displayName ?? null,
        body: updated.body,
        timestamp: updated.timestamp,
        receivedAt: updated.receivedAt,
        agentSessionId: updated.agentSessionId ?? null,
        eventJson: JSON.stringify(updated),
        updatedAt: Date.now(),
      });
      return updated;
    });
  }

  /**
   * Stored undecryptable (UTD) events, oldest first, capped at `limit`. Backed
   * by the `is_undecryptable` generated column + partial index, so this is cheap
   * even with a large timeline. Used by the re-decryption sweeper.
   *
   * Rows whose `redecrypt_attempts` have reached {@link MAX_REDECRYPT_ATTEMPTS}
   * (or the {@link REDECRYPT_RETIRED} sentinel) are excluded (issue #1): a wall of
   * permanently-dead OLD rows must not consume the oldest-first window and starve
   * newer, decryptable rows. Each returned event carries its current attempt count
   * so the sweeper can prune its in-memory backoff map and persist increments.
   */
  getUndecryptedEvents(limit = 100): Array<{ event: CanonicalChatEvent; attempts: number }> {
    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json, redecrypt_attempts
           from timeline_events
           where is_undecryptable = 1 and redecrypt_attempts < @max
           order by timestamp asc
           limit @limit`,
        )
        .all({ limit, max: MAX_REDECRYPT_ATTEMPTS }) as Array<{
        event_json: string;
        redecrypt_attempts: number;
      }>,
    );
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as CanonicalChatEvent,
      attempts: row.redecrypt_attempts,
    }));
  }

  /**
   * Persist a failed re-decryption probe: bump `redecrypt_attempts` by one (so the
   * row eventually crosses {@link MAX_REDECRYPT_ATTEMPTS} and drops out of the
   * candidate set) while the row is still UTD. Guarded on `is_undecryptable = 1`
   * so a row that decrypted via a concurrent path is not bumped. Returns the new
   * attempt count (or `undefined` if the row no longer exists / is no longer UTD).
   */
  recordRedecryptFailure(eventId: string): Promise<number | undefined> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update timeline_events
             set redecrypt_attempts = redecrypt_attempts + 1, updated_at = ?
           where id = ? and is_undecryptable = 1`,
        )
        .run(Date.now(), eventId);
      if (result.changes === 0) return undefined;
      const row = db
        .prepare(`select redecrypt_attempts from timeline_events where id = ?`)
        .get(eventId) as { redecrypt_attempts: number } | undefined;
      return row?.redecrypt_attempts;
    });
  }

  /**
   * Permanently retire a UTD row from the re-decryption rotation by stamping its
   * `redecrypt_attempts` to the {@link REDECRYPT_RETIRED} sentinel (issue #1).
   * Used for rows that can never be re-fetched (no resolvable room/event id). The
   * row stays UTD (content unchanged) but `getUndecryptedEvents` will never return
   * it again. Guarded on `is_undecryptable = 1` so a decrypted row is untouched.
   */
  retireUndecryptedEvent(eventId: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update timeline_events
           set redecrypt_attempts = ?, updated_at = ?
         where id = ? and is_undecryptable = 1`,
      ).run(REDECRYPT_RETIRED, Date.now(), eventId);
    });
  }

  /**
   * Delete a UTD row outright (issue #9). Used when a re-decryption probe shows
   * the event decrypted to a non-renderable message (sticker / poll / reaction):
   * the native summary comes back `null` *without throwing*, which the live append
   * path never stores, so removing the placeholder matches live parity. Guarded on
   * `is_undecryptable = 1` so a row that became a real decrypted message via a
   * concurrent path is never deleted. Returns `true` when a row was removed.
   */
  deleteUndecryptedEvent(eventId: string): Promise<boolean> {
    return this.write((db) => {
      const result = db
        .prepare(`delete from timeline_events where id = ? and is_undecryptable = 1`)
        .run(eventId);
      return result.changes > 0;
    });
  }

  /**
   * Replace a stored UTD event with its decrypted form. Rebuilds body/event_json
   * from `updater` (which must clear `undecryptable` and set the real
   * body/attachments), sets `enrichment_status` to the value `computeStatus`
   * returns, and bumps `updated_at`. Matched by event id.
   *
   * `computeStatus(updated, timelineState)` decides the post-decrypt enrichment
   * status (issues #5/#6). It is evaluated *inside* the write transaction with the
   * decrypted event and the live `timeline_state` of the row's (possibly re-homed)
   * timeline, so the sweeper and the persisted row agree without the sweeper
   * needing its own read. The chosen status is returned to the caller so its
   * notify decisions match exactly what was stored. The status must be a legal
   * `enrichment_status` value: typically `'inactive'` for inactive timelines, else
   * `'pending'` / `'skipped'` per `needsEnrichment`.
   *
   * The decrypted relation can move the event off the room timeline (a thread
   * message stored UTD has its `m.thread` relation encrypted at store time): the
   * `updater` may return a different `timelineKey`/`threadId`, which is persisted
   * here — the row is re-homed, and the timeline state is read for the NEW key.
   * The canonical id (dedup key) is never changed.
   *
   * Returns `{ event, replaced, status }`. `replaced` is `false` when the row was
   * already non-UTD (the sweeper races backfill/message_summary touches): nothing
   * is written, the existing row is returned, and `status` is its current stored
   * status so the caller can skip re-arming enrichment and the misleading
   * "replaced" log. Returns `undefined` only when no row exists for the id.
   */
  replaceUndecryptedEvent(
    eventId: string,
    updater: (event: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<{ event: CanonicalChatEvent; replaced: boolean; status: string } | undefined> {
    return this.write((db) => {
      const row = db
        .prepare(`select event_json, enrichment_status from timeline_events where id = ?`)
        .get(eventId) as { event_json: string; enrichment_status: string } | undefined;
      if (!row) return undefined;
      const existing = JSON.parse(row.event_json) as CanonicalChatEvent;
      if (!existing.undecryptable) {
        // Already replaced; no-op. Report the existing stored status.
        return { event: existing, replaced: false, status: row.enrichment_status };
      }
      const updated = updater(existing);
      // Resolve the timeline state of the (possibly re-homed) destination key. A
      // missing compaction-state row means the channel was never engaged →
      // 'inactive' (mirrors getTimelineState).
      const stateRow = db
        .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
        .get(updated.timelineKey) as { timeline_state: TimelineState } | undefined;
      const timelineState: TimelineState = stateRow?.timeline_state ?? "inactive";
      const status = computeStatus(updated, timelineState);
      db.prepare(
        `update timeline_events
         set external_id = @externalId,
             timeline_key = @timelineKey,
             provider = @provider,
             role = @role,
             sender_id = @senderId,
             sender_display_name = @senderDisplayName,
             body = @body,
             timestamp = @timestamp,
             received_at = @receivedAt,
             agent_session_id = @agentSessionId,
             event_json = @eventJson,
             enrichment_status = @enrichmentStatus,
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id: eventId,
        externalId: updated.externalId ?? null,
        timelineKey: updated.timelineKey,
        provider: updated.provider,
        role: updated.role,
        senderId: updated.sender.id,
        senderDisplayName: updated.sender.displayName ?? null,
        body: updated.body,
        timestamp: updated.timestamp,
        receivedAt: updated.receivedAt,
        agentSessionId: updated.agentSessionId ?? null,
        eventJson: JSON.stringify(updated),
        enrichmentStatus: status,
        updatedAt: Date.now(),
      });
      return { event: updated, replaced: true, status };
    });
  }

  /**
   * Apply a Matrix edit (`m.replace`) to its target message in place (issue #17),
   * mirroring what a normal client shows: the original message is updated, not a
   * new row inserted. The target is located by `(provider, externalId)`; `updater`
   * rebuilds the canonical with the replacement body/attachments while preserving
   * identity (id, timelineKey, role, sender, timestamps) — see
   * {@link applyEditToCanonical}.
   *
   * `enrichment_status` is recomputed via `computeStatus(updated, timelineState)`
   * (the same callback shape as {@link replaceUndecryptedEvent}), evaluated inside
   * the write transaction against the target row's live `timeline_state` so an
   * edit landing on an inactive timeline keeps `'inactive'` and never nudges the
   * pools (issue #6 gating). The chosen status is returned so the caller's notify
   * decisions match exactly what was stored.
   *
   * Returns `{ applied: true, event, status }` on success, or
   * `{ applied: false }` when no target row exists for `(provider, externalId)` —
   * the caller logs and skips, never inserting the edit as a standalone message.
   * Latest-by-origin_server_ts wins on repeated edits (issue #3): the row tracks
   * `last_edit_timestamp`, and an incoming edit older than it is a no-op (returns
   * the already-stored event/status). Equal-or-newer timestamps apply. This
   * mirrors the pending_edits `>=` guard, so the applied and parked paths agree.
   */
  applyEditToTarget(
    provider: string,
    targetExternalId: string,
    timelineKey: string,
    replacement: EditReplacementContent,
    editTimestamp: number,
    updater: (target: CanonicalChatEvent) => CanonicalChatEvent,
    computeStatus: (updated: CanonicalChatEvent, timelineState: TimelineState) => string,
  ): Promise<
    | { applied: true; event: CanonicalChatEvent; status: string }
    | { applied: false; pending: true }
  > {
    return this.write((db) => {
      // Scoped by timeline_key (issue #3): in a multi-account shared room the same
      // Matrix event is stored once per bot account (rows differ only by canonical
      // id), so an unscoped `(provider, external_id)` lookup could edit the wrong
      // account's row. An edit is always same-room/account as its target, so the
      // caller's timelineKey is the correct scope.
      const row = db
        .prepare(
          `select id, event_json, last_edit_timestamp from timeline_events
           where provider = ? and external_id = ? and timeline_key = ? limit 1`,
        )
        .get(provider, targetExternalId, timelineKey) as
        | { id: string; event_json: string; last_edit_timestamp: number | null }
        | undefined;
      if (!row) {
        // The target isn't stored yet (out-of-order sync / backfill). Park the
        // resolved replacement so the append path replays it once the target
        // lands (issue #12). Latest edit wins: insert-or-replace on the PK keeps
        // the newest by edit_timestamp.
        db.prepare(
          `insert into pending_edits (
             provider, target_external_id, timeline_key,
             body, attachments_json, edit_timestamp, created_at
           ) values (
             @provider, @targetExternalId, @timelineKey,
             @body, @attachmentsJson, @editTimestamp, @createdAt
           )
           on conflict(provider, target_external_id, timeline_key) do update set
             body = excluded.body,
             attachments_json = excluded.attachments_json,
             edit_timestamp = excluded.edit_timestamp,
             created_at = excluded.created_at
           where excluded.edit_timestamp >= pending_edits.edit_timestamp`,
        ).run({
          provider,
          targetExternalId,
          timelineKey,
          body: replacement.body,
          attachmentsJson: JSON.stringify(replacement.attachments),
          editTimestamp,
          createdAt: Date.now(),
        });
        return { applied: false, pending: true };
      }

      const existing = JSON.parse(row.event_json) as CanonicalChatEvent;
      // Latest-by-origin_server_ts wins (issue #3): if a newer edit has already
      // been applied to this row, an older incoming edit is a no-op. Without this
      // guard the applied path was last-arrival-wins (unlike the pending_edits
      // path, which has always been latest-wins), so a re-decrypted older edit
      // arriving after a newer live edit could clobber the newer body. Return the
      // already-stored event/status so the caller (e.g. the redecryption sweeper,
      // which retires its placeholder on `applied`) sees a stable result and does
      // not re-arm pools for a stale edit. Equal timestamps still apply (mirrors
      // the pending_edits `>=` guard) — a benign re-application of the same edit.
      if (row.last_edit_timestamp !== null && editTimestamp < row.last_edit_timestamp) {
        const storedStatusRow = db
          .prepare(`select enrichment_status from timeline_events where id = ?`)
          .get(row.id) as { enrichment_status: string } | undefined;
        return {
          applied: true,
          event: existing,
          status: storedStatusRow?.enrichment_status ?? "skipped",
        };
      }
      const updated = updater(existing);
      // The edit-application path never re-homes the target: it edits an existing
      // row by its own timeline. Resolve the target's timeline state for gating.
      const stateRow = db
        .prepare(`select timeline_state from timeline_compaction_state where timeline_key = ?`)
        .get(updated.timelineKey) as { timeline_state: TimelineState } | undefined;
      const timelineState: TimelineState = stateRow?.timeline_state ?? "inactive";
      const status = computeStatus(updated, timelineState);
      db.prepare(
        `update timeline_events
         set body = @body,
             event_json = @eventJson,
             enrichment_status = @enrichmentStatus,
             last_edit_timestamp = @lastEditTimestamp,
             updated_at = @updatedAt
         where id = @id`,
      ).run({
        id: row.id,
        body: updated.body,
        eventJson: JSON.stringify(updated),
        enrichmentStatus: status,
        lastEditTimestamp: editTimestamp,
        updatedAt: Date.now(),
      });
      return { applied: true, event: updated, status };
    });
  }

  /**
   * Look up a parked pending edit for a just-stored event (issue #12), if any,
   * scoped by `(provider, target_external_id, timeline_key)`. Used by the append
   * path to replay an edit that arrived before its target. Read-only; the caller
   * applies it and then calls {@link deletePendingEdit} in the same transaction.
   */
  getPendingEdit(
    db: Database.Database,
    provider: string,
    externalId: string,
    timelineKey: string,
  ): (EditReplacementContent & { editTimestamp: number }) | undefined {
    const row = db
      .prepare(
        `select body, attachments_json, edit_timestamp from pending_edits
         where provider = ? and target_external_id = ? and timeline_key = ?`,
      )
      .get(provider, externalId, timelineKey) as
      | { body: string; attachments_json: string; edit_timestamp: number }
      | undefined;
    if (!row) return undefined;
    return {
      body: row.body,
      attachments: JSON.parse(row.attachments_json) as AttachmentMeta[],
      editTimestamp: row.edit_timestamp,
    };
  }

  /** Delete a replayed pending edit (issue #12). Runs inside the caller's write. */
  deletePendingEdit(
    db: Database.Database,
    provider: string,
    externalId: string,
    timelineKey: string,
  ): void {
    db.prepare(
      `delete from pending_edits
       where provider = ? and target_external_id = ? and timeline_key = ?`,
    ).run(provider, externalId, timelineKey);
  }

  claimPendingEnrichment(limit: number): Promise<string[]> {
    return this.write((db) => {
      const rows = db.prepare(
        `select id from timeline_events
         where enrichment_status = 'pending'
         order by timestamp desc
         limit ?`,
      ).all(limit) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      const update = db.prepare(
        `update timeline_events set enrichment_status = 'processing', updated_at = ?
         where id = ? and enrichment_status = 'pending'`,
      );
      const now = Date.now();
      const claimed: string[] = [];
      for (const row of rows) {
        const result = update.run(now, row.id);
        if (result.changes > 0) claimed.push(row.id);
      }
      return claimed;
    });
  }

  setEnrichmentStatus(eventId: string, status: string, error?: string, retries?: number): Promise<void> {
    return this.write((db) => {
      if (retries != null) {
        db.prepare(
          `update timeline_events set enrichment_status = ?, enrichment_retries = ?, updated_at = ? where id = ?`,
        ).run(status, retries, Date.now(), eventId);
      } else {
        db.prepare(
          `update timeline_events set enrichment_status = ?, updated_at = ? where id = ?`,
        ).run(status, Date.now(), eventId);
      }
    });
  }

  getEnrichmentRetries(eventId: string): number {
    return this.read((db) => {
      const row = db.prepare(
        `select enrichment_retries from timeline_events where id = ?`,
      ).get(eventId) as { enrichment_retries: number } | undefined;
      return row?.enrichment_retries ?? 0;
    });
  }

  resetStaleEnrichment(): Promise<number> {
    return this.write((db) => {
      const result = db.prepare(
        `update timeline_events set enrichment_status = 'pending'
         where enrichment_status = 'processing'`,
      ).run();
      return result.changes;
    });
  }

  setTriggerGroup(triggerEventId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return Promise.resolve();
    return this.write((db) => {
      const placeholders = eventIds.map(() => "?").join(", ");
      db.prepare(
        `update timeline_events set trigger_group_id = ?, updated_at = ?
         where id in (${placeholders})`,
      ).run(triggerEventId, Date.now(), ...eventIds);
    });
  }

  insertReplyContext(row: ReplyContextRow): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or replace into reply_contexts (
          event_id, reply_external_id, sender_id, sender_display_name,
          body, html_body, timestamp, created_at
        ) values (
          @eventId, @replyExternalId, @senderId, @senderDisplayName,
          @body, @htmlBody, @timestamp, @createdAt
        )`,
      ).run({
        eventId: row.event_id,
        replyExternalId: row.reply_external_id ?? null,
        senderId: row.sender_id ?? null,
        senderDisplayName: row.sender_display_name ?? null,
        body: row.body ?? null,
        htmlBody: row.html_body ?? null,
        timestamp: row.timestamp ?? null,
        createdAt: row.created_at,
      });
    });
  }

  insertLinkPreview(row: LinkPreviewRow): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or replace into link_previews (
          id, event_id, context, url, title, description, site_name,
          source_kind, preview_index, fetched_at, fetch_status, error,
          payload_json, created_at
        ) values (
          @id, @eventId, @context, @url, @title, @description, @siteName,
          @sourceKind, @previewIndex, @fetchedAt, @fetchStatus, @error,
          @payloadJson, @createdAt
        )`,
      ).run({
        id: row.id,
        eventId: row.event_id,
        context: row.context,
        url: row.url,
        title: row.title ?? null,
        description: row.description ?? null,
        siteName: row.site_name ?? null,
        sourceKind: row.source_kind ?? null,
        previewIndex: row.preview_index,
        fetchedAt: row.fetched_at ?? null,
        fetchStatus: row.fetch_status,
        error: row.error ?? null,
        payloadJson: row.payload_json ?? null,
        createdAt: row.created_at,
      });
    });
  }

  insertMediaAsset(row: MediaAssetRow): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or replace into media_assets (
          id, event_id, role, source_index, link_preview_id, local_path,
          mime_type, media_type, size_bytes, width, height, duration_seconds,
          original_filename, detected_content, detected_metadata_json,
          caption, caption_model, caption_status, caption_error, caption_attempts,
          download_status, download_error, created_at, updated_at
        ) values (
          @id, @eventId, @role, @sourceIndex, @linkPreviewId, @localPath,
          @mimeType, @mediaType, @sizeBytes, @width, @height, @durationSeconds,
          @originalFilename, @detectedContent, @detectedMetadataJson,
          @caption, @captionModel, @captionStatus, @captionError, @captionAttempts,
          @downloadStatus, @downloadError, @createdAt, @updatedAt
        )`,
      ).run({
        id: row.id,
        eventId: row.event_id,
        role: row.role,
        sourceIndex: row.source_index ?? null,
        linkPreviewId: row.link_preview_id ?? null,
        localPath: row.local_path ?? null,
        mimeType: row.mime_type ?? null,
        mediaType: row.media_type,
        sizeBytes: row.size_bytes ?? null,
        width: row.width ?? null,
        height: row.height ?? null,
        durationSeconds: row.duration_seconds ?? null,
        originalFilename: row.original_filename ?? null,
        detectedContent: row.detected_content ?? null,
        detectedMetadataJson: row.detected_metadata_json ?? null,
        caption: row.caption ?? null,
        captionModel: row.caption_model ?? null,
        captionStatus: row.caption_status,
        captionError: row.caption_error ?? null,
        captionAttempts: row.caption_attempts ?? 0,
        downloadStatus: row.download_status,
        downloadError: row.download_error ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? row.created_at,
      });
    });
  }

  persistEnrichmentResults(
    eventId: string,
    result: {
      replyContext: ReplyContextRow | null;
      linkPreviews: LinkPreviewRow[];
      mediaAssets: MediaAssetRow[];
    },
  ): Promise<void> {
    return this.readAndWrite((db) => {
      db.prepare(`delete from media_assets where event_id = ?`).run(eventId);
      db.prepare(`delete from link_previews where event_id = ?`).run(eventId);
      db.prepare(`delete from reply_contexts where event_id = ?`).run(eventId);

      if (result.replyContext) {
        db.prepare(
          `insert or replace into reply_contexts (
            event_id, reply_external_id, sender_id, sender_display_name,
            body, html_body, timestamp, created_at
          ) values (
            @eventId, @replyExternalId, @senderId, @senderDisplayName,
            @body, @htmlBody, @timestamp, @createdAt
          )`,
        ).run({
          eventId: result.replyContext.event_id,
          replyExternalId: result.replyContext.reply_external_id ?? null,
          senderId: result.replyContext.sender_id ?? null,
          senderDisplayName: result.replyContext.sender_display_name ?? null,
          body: result.replyContext.body ?? null,
          htmlBody: result.replyContext.html_body ?? null,
          timestamp: result.replyContext.timestamp ?? null,
          createdAt: result.replyContext.created_at,
        });
      }

      const insertPreview = db.prepare(
        `insert or replace into link_previews (
          id, event_id, context, url, title, description, site_name,
          source_kind, preview_index, fetched_at, fetch_status, error,
          payload_json, created_at
        ) values (
          @id, @eventId, @context, @url, @title, @description, @siteName,
          @sourceKind, @previewIndex, @fetchedAt, @fetchStatus, @error,
          @payloadJson, @createdAt
        )`,
      );
      for (const lp of result.linkPreviews) {
        insertPreview.run({
          id: lp.id,
          eventId: lp.event_id,
          context: lp.context,
          url: lp.url,
          title: lp.title ?? null,
          description: lp.description ?? null,
          siteName: lp.site_name ?? null,
          sourceKind: lp.source_kind ?? null,
          previewIndex: lp.preview_index,
          fetchedAt: lp.fetched_at ?? null,
          fetchStatus: lp.fetch_status,
          error: lp.error ?? null,
          payloadJson: lp.payload_json ?? null,
          createdAt: lp.created_at,
        });
      }

      const insertAsset = db.prepare(
        `insert or replace into media_assets (
          id, event_id, role, source_index, link_preview_id, local_path,
          mime_type, media_type, size_bytes, width, height, duration_seconds,
          original_filename, detected_content, detected_metadata_json,
          caption, caption_model, caption_status, caption_error, caption_attempts,
          download_status, download_error, created_at, updated_at
        ) values (
          @id, @eventId, @role, @sourceIndex, @linkPreviewId, @localPath,
          @mimeType, @mediaType, @sizeBytes, @width, @height, @durationSeconds,
          @originalFilename, @detectedContent, @detectedMetadataJson,
          @caption, @captionModel, @captionStatus, @captionError, @captionAttempts,
          @downloadStatus, @downloadError, @createdAt, @updatedAt
        )`,
      );
      for (const ma of result.mediaAssets) {
        insertAsset.run({
          id: ma.id,
          eventId: ma.event_id,
          role: ma.role,
          sourceIndex: ma.source_index ?? null,
          linkPreviewId: ma.link_preview_id ?? null,
          localPath: ma.local_path ?? null,
          mimeType: ma.mime_type ?? null,
          mediaType: ma.media_type,
          sizeBytes: ma.size_bytes ?? null,
          width: ma.width ?? null,
          height: ma.height ?? null,
          durationSeconds: ma.duration_seconds ?? null,
          originalFilename: ma.original_filename ?? null,
          detectedContent: ma.detected_content ?? null,
          detectedMetadataJson: ma.detected_metadata_json ?? null,
          caption: ma.caption ?? null,
          captionModel: ma.caption_model ?? null,
          captionStatus: ma.caption_status,
          captionError: ma.caption_error ?? null,
          captionAttempts: ma.caption_attempts ?? 0,
          downloadStatus: ma.download_status,
          downloadError: ma.download_error ?? null,
          createdAt: ma.created_at,
          updatedAt: ma.updated_at ?? ma.created_at,
        });
      }

      db.prepare(
        `update timeline_events set enrichment_status = 'complete', updated_at = ? where id = ?`,
      ).run(Date.now(), eventId);
    });
  }

  getEnrichmentData(eventIds: string[]): {
    replyContexts: Map<string, ReplyContextRow>;
    linkPreviews: Map<string, LinkPreviewRow[]>;
    mediaAssets: Map<string, MediaAssetRow[]>;
  } {
    if (eventIds.length === 0) {
      return { replyContexts: new Map(), linkPreviews: new Map(), mediaAssets: new Map() };
    }
    return this.read((db) => {
      const replyContexts = new Map<string, ReplyContextRow>();
      const linkPreviews = new Map<string, LinkPreviewRow[]>();
      const mediaAssets = new Map<string, MediaAssetRow[]>();

      const batchSize = 500;
      for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(", ");

        const rcRows = db.prepare(
          `select * from reply_contexts where event_id in (${placeholders})`,
        ).all(...batch) as ReplyContextRow[];
        for (const row of rcRows) replyContexts.set(row.event_id, row);

        const lpRows = db.prepare(
          `select * from link_previews where event_id in (${placeholders})
           order by event_id, context, preview_index`,
        ).all(...batch) as LinkPreviewRow[];
        for (const row of lpRows) {
          const list = linkPreviews.get(row.event_id) ?? [];
          list.push(row);
          linkPreviews.set(row.event_id, list);
        }

        const maRows = db.prepare(
          `select * from media_assets where event_id in (${placeholders})
           order by event_id, role, source_index`,
        ).all(...batch) as MediaAssetRow[];
        for (const row of maRows) {
          const list = mediaAssets.get(row.event_id) ?? [];
          list.push(row);
          mediaAssets.set(row.event_id, list);
        }
      }

      return { replyContexts, linkPreviews, mediaAssets };
    });
  }

  claimPendingCaptions(limit: number, captionAll: boolean, captionAssistantMessages = false): Promise<MediaAssetRow[]> {
    return this.write((db) => {
      // `te.is_backfetch = 1` admits a promoted backfetched row (spec
      // MESSAGE-BACKFETCH §7.3). A backfetched event has no trigger group and is
      // captioned 'deferred' by the enrichment worker, so its presence as 'pending'
      // can ONLY be the operator's retroactive deferred→pending promote — that
      // promote IS the opt-in, claimable regardless of caption_all. It sorts last
      // (bucket 1, old timestamp) so live work always outranks it.
      const rows = db.prepare(
        `select ma.*, te.timeline_key as timeline_key from media_assets ma
         join timeline_events te on ma.event_id = te.id
         where ma.caption_status = 'pending'
           and ma.download_status = 'complete'
           and ma.media_type in ('image', 'video', 'audio')
           and (te.trigger_group_id is not null or ? = 1 or (te.role = 'assistant' and ? = 1)
                or te.is_backfetch = 1)
         order by
           case when te.trigger_group_id is not null then 0 else 1 end,
           te.timestamp desc
         limit ?`,
      ).all(captionAll ? 1 : 0, captionAssistantMessages ? 1 : 0, limit) as MediaAssetRow[];

      if (rows.length === 0) return [];

      // CAS pending → processing, incrementing the durable `caption_attempts`
      // counter in the SAME statement (mirroring claimNextSummarizationJob /
      // claimNextDiaryJob). First claim => attempts = 1; a crash un-sticks the row
      // via resetStaleCaptions without refunding its retry budget. `updated_at` is
      // bumped so the pipeline monitor's reverse-chron sort reflects the claim.
      const now = Date.now();
      const update = db.prepare(
        `update media_assets
         set caption_status = 'processing', caption_attempts = caption_attempts + 1, updated_at = ?
         where id = ? and caption_status = 'pending'`,
      );
      const claimed: MediaAssetRow[] = [];
      for (const row of rows) {
        const result = update.run(now, row.id);
        if (result.changes > 0) {
          claimed.push({
            ...row,
            caption_status: "processing",
            caption_attempts: (row.caption_attempts ?? 0) + 1,
            updated_at: now,
          });
        }
      }
      return claimed;
    });
  }

  updateCaptionResult(
    assetId: string,
    caption: string,
    model: string,
    usage?: RawTokenUsage | null,
    cost?: number | null,
  ): Promise<void> {
    // Auxiliary usage/cost (spec AUXILIARY-USAGE-TRACKING §8.1) written atomically
    // with the caption result. Null when usage is unknown (gateway omitted it) —
    // left NULL, never 0. `caption_total_tokens` = input + output + cacheRead
    // (= prompt + completion on the OpenAI transport). Cost may be 0 (usage known,
    // no rates configured). This lane never touches `agent_sessions.usage_*` (§4).
    const inputTokens = usage ? usage.input : null;
    const outputTokens = usage ? usage.output : null;
    const cacheReadTokens = usage ? usage.cacheRead : null;
    const totalTokens = usage ? usage.input + usage.output + usage.cacheRead : null;
    const captionCost = usage ? cost ?? 0 : null;
    return this.write((db) => {
      db.prepare(
        `update media_assets
         set caption = ?, caption_model = ?, caption_status = 'complete', caption_error = null,
             caption_input_tokens = ?, caption_output_tokens = ?, caption_cache_read_tokens = ?,
             caption_total_tokens = ?, caption_cost = ?, updated_at = ?
         where id = ?`,
      ).run(caption, model, inputTokens, outputTokens, cacheReadTokens, totalTokens, captionCost, Date.now(), assetId);
    });
  }

  /**
   * Retroactively promote deferred backfetched captions to pending (spec
   * MESSAGE-BACKFETCH §7.3) for a timeline key (its base key plus any thread
   * children), optionally bounded to a `[fromTs, toTs]` event-timestamp sub-range.
   * Flips `caption_status` 'deferred' → 'pending' only for downloaded captionable
   * assets on backfetched (`is_backfetch=1`) events; the normal caption pool then
   * drains them under the existing budget gate at lowest priority. Returns the
   * number of rows promoted (so a caller can skip the wake when nothing matched).
   * Bumps `updated_at` so the pipeline monitor reflects the change.
   */
  promoteBackfetchedCaptions(
    timelineKey: string,
    range?: { fromTs?: number | null; toTs?: number | null },
  ): Promise<number> {
    return this.write((db) => {
      const now = Date.now();
      const clauses = [
        "ma.caption_status = 'deferred'",
        "ma.download_status = 'complete'",
        "ma.media_type in ('image', 'video', 'audio')",
        "te.is_backfetch = 1",
        "(te.timeline_key = @key or te.timeline_key like @threadPrefix escape '\\')",
      ];
      const params: Record<string, unknown> = {
        key: timelineKey,
        // SQLite LIKE: escape %/_/\ in the timeline key so a key containing a
        // wildcard can't broaden the match (mirrors resolveEditTargetTimelineKey).
        threadPrefix: `${timelineKey.replace(/[\\%_]/g, "\\$&")}:thread:%`,
        now,
      };
      if (range?.fromTs != null) {
        clauses.push("te.timestamp >= @fromTs");
        params.fromTs = range.fromTs;
      }
      if (range?.toTs != null) {
        clauses.push("te.timestamp <= @toTs");
        params.toTs = range.toTs;
      }
      const result = db
        .prepare(
          `update media_assets
             set caption_status = 'pending', updated_at = @now
           where id in (
             select ma.id from media_assets ma
             join timeline_events te on te.id = ma.event_id
             where ${clauses.join(" and ")}
           )`,
        )
        .run(params);
      return result.changes;
    });
  }

  /**
   * Insert a new backfetch job (spec MESSAGE-BACKFETCH §8.1), status 'queued'.
   * Generates `id` and timestamps. Returns the persisted row.
   */
  insertBackfetchJob(input: BackfetchJobInput): Promise<BackfetchJobRow> {
    return this.write((db) => this.insertBackfetchJobRow(db, input));
  }

  /**
   * Atomic single-flight create (spec §8.2). Checks for an existing non-terminal
   * job (queued/running/paused) for the room and inserts the new job in one
   * synchronous write-queue callback, so two concurrent operator starts for the
   * same room can never both pass the check. Returns the inserted row, or the
   * existing active job when one was found (caller maps that to a 409).
   */
  insertBackfetchJobIfNoActive(
    input: BackfetchJobInput,
  ): Promise<{ inserted: true; job: BackfetchJobRow } | { inserted: false; active: BackfetchJobRow }> {
    return this.write((db) => {
      const existing = db
        .prepare(
          `select * from backfetch_jobs
           where room_id = ? and status in ('queued', 'running', 'paused')
           order by created_at desc limit 1`,
        )
        .get(input.roomId) as BackfetchJobDbRow | undefined;
      if (existing) return { inserted: false, active: mapBackfetchJobRow(existing) };
      return { inserted: true, job: this.insertBackfetchJobRow(db, input) };
    });
  }

  /** Build + insert a backfetch job row. Must run inside a write() callback. */
  private insertBackfetchJobRow(db: Database.Database, input: BackfetchJobInput): BackfetchJobRow {
    const now = Date.now();
    const row: BackfetchJobRow = {
      id: `bfjob_${nanoid(10)}`,
      roomId: input.roomId,
      accountId: input.accountId,
      timelineKey: input.timelineKey,
      targetKind: input.targetKind,
      targetValue: input.targetValue ?? null,
      captionAfter: input.captionAfter ?? false,
      status: "queued",
      cursorToken: null,
      oldestReachedEventId: null,
      oldestReachedTs: null,
      fetched: 0,
      stored: 0,
      stopReason: null,
      floorEventId: null,
      safetyCap: input.safetyCap ?? 0,
      timeoutMs: input.timeoutMs ?? 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      `insert into backfetch_jobs (
        id, room_id, account_id, timeline_key, target_kind, target_value, caption_after,
        status, cursor_token, oldest_reached_event_id, oldest_reached_ts, fetched, stored,
        stop_reason, floor_event_id, safety_cap, timeout_ms, error, created_at, updated_at
      ) values (
        @id, @roomId, @accountId, @timelineKey, @targetKind, @targetValue, @captionAfter,
        @status, @cursorToken, @oldestReachedEventId, @oldestReachedTs, @fetched, @stored,
        @stopReason, @floorEventId, @safetyCap, @timeoutMs, @error, @createdAt, @updatedAt
      )`,
    ).run({
      ...row,
      captionAfter: row.captionAfter ? 1 : 0,
    });
    return row;
  }

  /** A single backfetch job by id, or undefined. */
  getBackfetchJob(id: string): BackfetchJobRow | undefined {
    const row = this.read((db) =>
      db.prepare(`select * from backfetch_jobs where id = ?`).get(id) as BackfetchJobDbRow | undefined,
    );
    return row ? mapBackfetchJobRow(row) : undefined;
  }

  /** All backfetch jobs, newest first (console list). */
  listBackfetchJobs(limit = 200): BackfetchJobRow[] {
    const rows = this.read((db) =>
      db
        .prepare(`select * from backfetch_jobs order by created_at desc limit ?`)
        .all(limit) as BackfetchJobDbRow[],
    );
    return rows.map(mapBackfetchJobRow);
  }

  /**
   * The single non-terminal job for a room (queued/running/paused), if any —
   * enforces single-flight per room (spec §8.2) so the cursor + floor stay
   * unambiguous. Newest first if (defensively) more than one exists.
   */
  getActiveBackfetchJobForRoom(roomId: string): BackfetchJobRow | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `select * from backfetch_jobs
           where room_id = ? and status in ('queued', 'running', 'paused')
           order by created_at desc limit 1`,
        )
        .get(roomId) as BackfetchJobDbRow | undefined,
    );
    return row ? mapBackfetchJobRow(row) : undefined;
  }

  /** Jobs in a 'running' or 'queued' state at startup — resumed by the coordinator (spec §8.1). */
  listResumableBackfetchJobs(): BackfetchJobRow[] {
    const rows = this.read((db) =>
      db
        .prepare(`select * from backfetch_jobs where status in ('running', 'queued') order by created_at asc`)
        .all() as BackfetchJobDbRow[],
    );
    return rows.map(mapBackfetchJobRow);
  }

  /** Patch a job's mutable progress/state fields; bumps `updated_at`. */
  updateBackfetchJob(id: string, patch: BackfetchJobPatch): Promise<void> {
    return this.write((db) => {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id, updatedAt: Date.now() };
      const assign = (col: string, key: string, value: unknown): void => {
        sets.push(`${col} = @${key}`);
        params[key] = value;
      };
      if (patch.status !== undefined) assign("status", "status", patch.status);
      if (patch.cursorToken !== undefined) assign("cursor_token", "cursorToken", patch.cursorToken);
      if (patch.oldestReachedEventId !== undefined)
        assign("oldest_reached_event_id", "oldestReachedEventId", patch.oldestReachedEventId);
      if (patch.oldestReachedTs !== undefined)
        assign("oldest_reached_ts", "oldestReachedTs", patch.oldestReachedTs);
      if (patch.fetched !== undefined) assign("fetched", "fetched", patch.fetched);
      if (patch.stored !== undefined) assign("stored", "stored", patch.stored);
      if (patch.stopReason !== undefined) assign("stop_reason", "stopReason", patch.stopReason);
      if (patch.floorEventId !== undefined) assign("floor_event_id", "floorEventId", patch.floorEventId);
      if (patch.error !== undefined) assign("error", "error", patch.error);
      if (sets.length === 0) return;
      db.prepare(
        `update backfetch_jobs set ${sets.join(", ")}, updated_at = @updatedAt where id = @id`,
      ).run(params);
    });
  }

  /**
   * Append one row to the auxiliary tool-use usage ledger (spec §8.2). Generates
   * `id` (nanoid) and `created_at`; runs on the single-writer queue. Used by the
   * `image_generate` tool's `recordToolUsage` callback. Never updates
   * `agent_sessions` — the per-session rollup is derived on read (§8.3).
   */
  insertToolInvocation(input: ToolInvocationInput): Promise<void> {
    const row: ToolInvocationRow = {
      id: `toolinv_${nanoid(12)}`,
      agent_session_id: input.agentSessionId,
      tool_name: input.toolName,
      tool_call_id: input.toolCallId ?? null,
      model_id: input.modelId ?? null,
      provider: input.provider ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      cache_read_tokens: input.cacheReadTokens ?? null,
      cache_write_tokens: input.cacheWriteTokens ?? null,
      images: input.images ?? null,
      cost: input.cost ?? null,
      ref: input.ref ?? null,
      created_at: Date.now(),
    };
    return this.write((db) => {
      db.prepare(
        `insert into tool_invocations (
           id, agent_session_id, tool_name, tool_call_id, model_id, provider,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           images, cost, ref, created_at
         ) values (
           @id, @agent_session_id, @tool_name, @tool_call_id, @model_id, @provider,
           @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
           @images, @cost, @ref, @created_at
         )`,
      ).run(row);
    });
  }

  /**
   * Per-session auxiliary tool-spend rollup (spec §8.3/§10.3): SUM/COUNT over the
   * ledger for one session. Always returns a zeroed shape (never null) so callers
   * render "0 calls" rather than "unknown" for a session with no tool spend.
   */
  getSessionToolUsage(agentSessionId: string): SessionToolUsage {
    return this.read((db) => {
      const row = db
        .prepare(
          `select
             count(*) as calls,
             coalesce(sum(input_tokens), 0) as inputTokens,
             coalesce(sum(output_tokens), 0) as outputTokens,
             coalesce(sum(cache_read_tokens), 0) as cacheReadTokens,
             coalesce(sum(cache_write_tokens), 0) as cacheWriteTokens,
             coalesce(sum(cost), 0) as cost
           from tool_invocations where agent_session_id = ?`,
        )
        .get(agentSessionId) as SessionToolUsage;
      return row;
    });
  }

  /**
   * All ledger rows for a session, newest-first (spec §10.3) — matched into the
   * transcript by `tool_call_id` so the rollout can annotate the right block.
   */
  getToolInvocationsBySession(agentSessionId: string): ToolInvocationRow[] {
    return this.read((db) => {
      return db
        .prepare(
          `select * from tool_invocations where agent_session_id = ? order by created_at desc`,
        )
        .all(agentSessionId) as ToolInvocationRow[];
    });
  }

  /**
   * Captioning-pool usage aggregate (spec §10.2): SUM/COUNT over `media_assets`
   * rows that recorded usage. `captionedCount` counts complete captions whose
   * token usage is present (legacy/unknown rows excluded from the count and sums).
   */
  getCaptioningUsageAggregate(): CaptioningUsageAggregate {
    return this.read((db) => {
      const row = db
        .prepare(
          `select
             sum(case when caption_total_tokens is not null then 1 else 0 end) as captionedCount,
             coalesce(sum(caption_input_tokens), 0) as totalInputTokens,
             coalesce(sum(caption_output_tokens), 0) as totalOutputTokens,
             coalesce(sum(caption_cost), 0) as totalCost
           from media_assets`,
        )
        .get() as { captionedCount: number | null; totalInputTokens: number; totalOutputTokens: number; totalCost: number };
      return {
        captionedCount: row.captionedCount ?? 0,
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        totalCost: row.totalCost,
      };
    });
  }

  /**
   * Global cost overview across the three lanes (spec §10.4): agent-loop cost
   * (Σ `agent_sessions.usage_cost`), tool cost (Σ `tool_invocations.cost`), and
   * captioning cost (Σ `media_assets.caption_cost`). Three independent SUMs.
   */
  getCostOverview(): CostOverview {
    return this.read((db) => {
      const agentLoop = db
        .prepare(`select coalesce(sum(usage_cost), 0) as c from agent_sessions`)
        .get() as { c: number };
      const tool = db
        .prepare(`select coalesce(sum(cost), 0) as c from tool_invocations`)
        .get() as { c: number };
      const captioning = db
        .prepare(`select coalesce(sum(caption_cost), 0) as c from media_assets`)
        .get() as { c: number };
      return { agentLoopCost: agentLoop.c, toolCost: tool.c, captioningCost: captioning.c };
    });
  }

  // ===========================================================================
  // Unified usage ledger (spec USAGE-COST-LIMITS §3/§4). One append-only row per
  // billable event; the source of truth for the BudgetEngine seed/recompute (§6)
  // and the console "Usage & Cost" page (§7). Additive to the per-lane stores —
  // never replaces them.
  // ===========================================================================

  /**
   * Append one billable event to the unified ledger (spec §3.1). Best-effort at
   * the call site (a ledger failure must never fail the underlying work); the
   * store generates `id`/`created_at` and defaults `ts` to now.
   *
   * Ledger correctness invariants (the engine's accuracy rests on both):
   *   1. APPEND-ONLY with a RANDOM PK and NO DEDUP. There is no idempotency key —
   *      nothing here collapses a duplicate logical event. Correctness therefore
   *      requires every capture point (the §3.1 write sites — `recordUsageEvent`,
   *      caption/embedding workers) to fire AT MOST ONCE per logical event; a
   *      double-fire would be counted twice by every covering rule.
   *   2. MICROTASK-DRAINED BEFORE THE ENGINE TICK. The BudgetEngine is seeded once
   *      from a SUM over this table, then kept current by in-memory increments on
   *      each insert; its periodic reconcile runs on a `setInterval` (macrotask).
   *      For seed-then-increment consistency this durable write (queued on the
   *      single-writer microtask queue) and the matching `engine.record()` must
   *      both settle within one synchronous turn + microtask drain, BEFORE any
   *      `tick()` macrotask re-sums the ledger — otherwise a tick could double-count
   *      an increment also reflected in its SUM, or miss one not yet written. The
   *      app-side ordering of `engine.record()` vs this write lives at
   *      `recordUsageEvent` in `src/app.ts`.
   */
  insertUsageEvent(input: UsageEventInput): Promise<void> {
    // The ledger is the durable budget truth and the seed source for the
    // BudgetEngine's per-window SUMs; a non-finite or negative `cost_usd` would
    // poison those sums (and a NaN can never be cleared). Reject such a row at the
    // door — code-level guard, no DDL CHECK (the v25 table may already exist on a
    // live deployment, and a CHECK needs a table rebuild). The dropped row is rare
    // (no caller emits these today) and non-fatal: token counts for that one event
    // are lost, never the underlying work.
    if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
      this.logger?.warn("usage_event_rejected_bad_cost", {
        class: input.class,
        model: input.modelId,
        costUsd: input.costUsd,
      });
      return Promise.resolve();
    }
    const now = Date.now();
    const row: UsageEventRow = {
      id: `usage_${nanoid(12)}`,
      ts: input.ts ?? now,
      class: input.class,
      agent_session_id: input.agentSessionId ?? null,
      session_type: input.sessionType ?? null,
      timeline_key: input.timelineKey ?? null,
      trigger_sender_id: input.triggerSenderId ?? null,
      tool_name: input.toolName ?? null,
      model_id: input.modelId,
      // Logical id defaults to the upstream id when a consumer has no fallback /
      // virtual model (spec MODEL-FALLBACK §2.2 — block name == wire id). `||`
      // (not `??`) so an explicit empty string also falls back to `modelId`: a
      // `''` logical id would mis-scope budget (§8e) and mis-group the ledger/
      // console (§7), so it's never a valid stored value.
      logical_model_id: input.logicalModelId || input.modelId,
      // Per-user limits (spec PER-USER-LIMITS §8.3). `requested_model_id` and
      // `budget_partition` come straight from the per-user recorder (null for every
      // other lane). `room_id` is DERIVED here from `timeline_key` so every caller
      // stays simple and the stored id matches what the engine's `room:{room_id}`
      // partition / room-scoped seed uses (same extraction as `roomIdFromTimelineKey`).
      requested_model_id: input.requestedModelId ?? null,
      budget_partition: input.budgetPartition ?? null,
      room_id: roomIdFromTimelineKey(input.timelineKey ?? undefined),
      // Space id (§11) cannot be derived from intrinsic columns — it is supplied by
      // the per-user recorder from the session's frozen resolution (null otherwise).
      space_id: input.spaceId ?? null,
      provider: input.provider ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      cache_read_tokens: input.cacheReadTokens ?? null,
      cache_write_tokens: input.cacheWriteTokens ?? null,
      images: input.images ?? null,
      cost_usd: input.costUsd,
      ref: input.ref ?? null,
      created_at: now,
    };
    return this.write((db) => {
      db.prepare(
        `insert into usage_events (
           id, ts, class, agent_session_id, session_type, timeline_key, trigger_sender_id,
           tool_name, model_id, logical_model_id, requested_model_id, budget_partition, room_id, space_id,
           provider, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, images, cost_usd, ref, created_at
         ) values (
           @id, @ts, @class, @agent_session_id, @session_type, @timeline_key, @trigger_sender_id,
           @tool_name, @model_id, @logical_model_id, @requested_model_id, @budget_partition, @room_id, @space_id,
           @provider, @input_tokens, @output_tokens, @cache_read_tokens,
           @cache_write_tokens, @images, @cost_usd, @ref, @created_at
         )`,
      ).run(row);
    });
  }

  /**
   * Σ `cost_usd` over the ledger rows matching one rule's own-scope selector
   * within `[since, until)` (spec §6.1). Used to SEED each BudgetEngine rule at
   * startup and to RECOMPUTE rolling windows on the periodic tick. Dimension
   * arrays AND together (OR within each list); an omitted dimension is wildcard.
   */
  /**
   * Build the shared `WHERE` clause + bound params for {@link sumUsageCost} /
   * {@link minUsageTs} from a {@link UsageCostFilter}. Dimension arrays AND together
   * (OR within each list); an omitted dimension is a wildcard. The per-user
   * `requestedModelIds` dimension (spec PER-USER-LIMITS §7) additionally folds in
   * pre-feature `class = 'agent_loop'` rows whose `requested_model_id` is null by
   * falling back to `logical_model_id` for those, so an `opus-premium` sub-cap still
   * counts legacy `opus-premium` agent-loop spend recorded before this feature
   * shipped — but NOT null-requested tool rows (issue #14; see the clause below).
   */
  private usageCostClauses(filter: UsageCostFilter): { clauses: string[]; params: unknown[] } {
    const clauses: string[] = ["ts >= ?"];
    const params: unknown[] = [filter.since];
    if (filter.until !== undefined) {
      clauses.push("ts < ?");
      params.push(filter.until);
    }
    const inClause = (column: string, values: string[] | undefined): void => {
      if (!values || values.length === 0) return;
      clauses.push(`${column} in (${values.map(() => "?").join(", ")})`);
      params.push(...values);
    };
    inClause("class", filter.classes);
    inClause("session_type", filter.sessionTypes);
    inClause("tool_name", filter.tools);
    inClause("logical_model_id", filter.models);
    inClause("trigger_sender_id", filter.triggerSenderIds);
    inClause("budget_partition", filter.partitionKeys);
    inClause("room_id", filter.roomIds);
    inClause("space_id", filter.spaceIds);
    if (filter.requestedModelIds && filter.requestedModelIds.length > 0) {
      const ph = filter.requestedModelIds.map(() => "?").join(", ");
      // The null-fallback (matching pre-feature rows on `logical_model_id`) is gated
      // to `class = 'agent_loop'` so it folds in only legacy AGENT-LOOP spend. Tool
      // rows are also null-requested but must NOT seed a model-scoped sub-cap (issue
      // #14): a sub-cap reserves agent-loop degradation headroom, never a bound on
      // tool usage of the same upstream model — so a `class = 'tool'` null-requested
      // row whose `logical_model_id` happens to match the sub-cap's scope (e.g.
      // x_search→Grok) drops out here, mirroring the in-memory `record` which passes
      // no coverage model for tool spend. Non-null `requested_model_id` rows match by
      // the requested id directly (class-independent — the agent loop is the only
      // lane that stamps it), so no double-count. NOTE (issue #9): this hardcoded
      // `class = 'agent_loop'` makes `requestedModelIds` agent-loop-only scoping —
      // it must not be combined with a non-agent-loop `classes` filter (see the
      // `UsageCostFilter.requestedModelIds` doc), or the two AND to always-empty.
      clauses.push(
        `(requested_model_id in (${ph}) or (requested_model_id is null and class = 'agent_loop' and logical_model_id in (${ph})))`,
      );
      params.push(...filter.requestedModelIds, ...filter.requestedModelIds);
    }
    return { clauses, params };
  }

  sumUsageCost(filter: UsageCostFilter): number {
    const { clauses, params } = this.usageCostClauses(filter);
    return this.read((db) => {
      const row = db
        .prepare(`select coalesce(sum(cost_usd), 0) as c from usage_events where ${clauses.join(" and ")}`)
        .get(...params) as { c: number };
      // Defense-in-depth: a single non-finite `cost_usd` row (e.g. left behind by a
      // pre-guard write or a degraded backfill) makes SQLite's SUM non-finite and
      // would poison the whole window total. `insertUsageEvent` now rejects such
      // rows at the door (the primary guard); this clamp keeps the read robust if
      // one ever slips in. A finite sum passes through unchanged.
      return Number.isFinite(row.c) ? row.c : 0;
    });
  }

  /**
   * Earliest `ts` of a ledger row matching one rule's own-scope selector within
   * `[since, until)`, or `null` when none match (spec USAGE-COST-LIMITS §6.1).
   * Mirrors {@link sumUsageCost}'s selector/window filtering. Used OFF the hot path
   * (console + the human-facing refusal message) to compute an accurate rolling
   * ETA — the oldest contributing spend ages out at `minTs + durationMs`, far
   * sooner than the `now + durationMs` upper bound the gate cheaply uses (§5 #5).
   */
  minUsageTs(filter: UsageCostFilter): number | null {
    const { clauses, params } = this.usageCostClauses(filter);
    return this.read((db) => {
      const row = db
        .prepare(`select min(ts) as t from usage_events where ${clauses.join(" and ")}`)
        .get(...params) as { t: number | null };
      return row.t ?? null;
    });
  }

  /**
   * Spend + counts grouped by class and by model over `[since, now)` (spec §4 /
   * §7.1 cards). One read, two aggregations.
   */
  getUsageSummary(since: number, now: number): UsageSummary {
    return this.read((db) => {
      const byClass = db
        .prepare(
          `select class, coalesce(sum(cost_usd), 0) as cost, count(*) as events
             from usage_events where ts >= ? group by class order by cost desc`,
        )
        .all(since) as Array<{ class: string; cost: number; events: number }>;
      // Group by the UPSTREAM wire id actually billed (`model_id`), NOT the
      // logical/virtual block name. This cost page reports what was really spent
      // on which real model: a virtual model (e.g. "default") and any legacy rows
      // sharing its upstream must collapse into one row, otherwise the same model
      // splits across buckets purely by whether the row predates the logical-id
      // column. Budget scoping (`[[limits]].models`, §8e) still keys on
      // `logical_model_id`; only this presentation aggregation uses `model_id`.
      const byModel = db
        .prepare(
          `select model_id as model, coalesce(sum(cost_usd), 0) as cost, count(*) as events
             from usage_events where ts >= ? group by model_id order by cost desc`,
        )
        .all(since) as Array<{ model: string; cost: number; events: number }>;
      // Actual data start within the window — anchors the console's per-period averages to
      // the elapsed range rather than the nominal window (null ⇒ no events in window).
      const firstTs = (
        db.prepare(`select min(ts) as firstTs from usage_events where ts >= ?`).get(since) as {
          firstTs: number | null;
        }
      ).firstTs;
      const total = byClass.reduce((sum, r) => sum + r.cost, 0);
      return { since, now, firstTs, total, byClass, byModel };
    });
  }

  /**
   * Stacked spend-over-time, bucketed by `bucketMs`, grouped by class or model
   * (spec §7.1 chart). Returns one row per (bucket, group) with summed cost.
   */
  getUsageTimeseries(since: number, bucketMs: number, groupBy: "class" | "model"): UsageTimeseriesRow[] {
    // "model" groups by the UPSTREAM wire id actually billed (`model_id`),
    // consistent with byModel — the cost chart reports real-model spend, not
    // virtual/logical block names (budget scoping still keys on logical, §8e).
    const groupCol = groupBy === "model" ? "model_id" : "class";
    return this.read((db) => {
      // `cast(... as integer)` forces an integer FLOOR: a bound numeric parameter
      // makes `ts / ?` floating-point in SQLite, so without the cast the bucket
      // expression returns `ts` itself and `group by bucket` would collapse only
      // identical timestamps (one column per event instead of per hour/day).
      return db
        .prepare(
          `select cast(ts / ? as integer) * ? as bucket, ${groupCol} as grp, coalesce(sum(cost_usd), 0) as cost
             from usage_events where ts >= ?
             group by bucket, grp order by bucket asc`,
        )
        .all(bucketMs, bucketMs, since) as UsageTimeseriesRow[];
    });
  }

  /**
   * Recent sessions joined with their per-class `usage_events` rollup (spec §7.1
   * table 5): agent-LLM cost vs tool cost per session, plus token totals and
   * channel/type/trigger attribution from `agent_sessions`.
   */
  getUsageRecentSessions(limit: number): UsageSessionRow[] {
    return this.read((db) => {
      return db
        .prepare(
          `select
             s.id as sessionId,
             s.model_id as modelId,
             s.session_type as sessionType,
             s.timeline_key as timelineKey,
             -- Human room label (Name + parent space) from the cached room_metadata, else
             -- the raw timeline key so the cell still identifies the room before resolution.
             coalesce(
               (select m.display_name from room_metadata m where m.timeline_key = s.timeline_key),
               s.timeline_key
             ) as channelLabel,
             s.trigger_sender_display_name as triggerSender,
             s.status as status,
             s.completed_at as completedAt,
             coalesce(s.llm_requests, 0) as requests,
             coalesce(s.usage_input_tokens, 0) as inputTokens,
             coalesce(s.usage_output_tokens, 0) as outputTokens,
             coalesce(s.usage_cache_read_tokens, 0) as cacheReadTokens,
             coalesce(s.usage_cache_write_tokens, 0) as cacheWriteTokens,
             coalesce(s.usage_cost, 0) as agentCost,
             coalesce(t.toolCost, 0) as toolCost,
             coalesce(t.toolCalls, 0) as toolCalls
           from agent_sessions s
           -- Per-session tool rollup as ONE grouped pass, joined by id, instead of two
           -- correlated subqueries per row. The correlated form forced each session to
           -- probe usage_events via idx_usage_events_class_ts with agent_session_id as a
           -- residual filter -- ~O(N x #tool_events) per console page over a growing
           -- append-only table. Result parity is exact: the subselect groups by
           -- agent_session_id (one row per id; the null-session group never equals a
           -- concrete s.id, so it drops just as the correlated per-row equality did),
           -- and a session with no tool rows gets a null t coalesced to 0 -- matching the
           -- old per-column coalesce. No new index (keeps the append-only table lean).
           left join (
             select agent_session_id, sum(cost_usd) as toolCost, count(*) as toolCalls
             from usage_events
             where class = 'tool'
             group by agent_session_id
           ) t on t.agent_session_id = s.id
           order by coalesce(s.completed_at, s.updated_at) desc
           limit ?`,
        )
        .all(limit) as UsageSessionRow[];
    });
  }

  /**
   * Recent paid non-agent-loop events — tool / caption / embedding (spec §7.1
   * table 6), newest first.
   */
  getUsageRecentToolCalls(limit: number): UsageEventRowWithChannel[] {
    return this.read((db) => {
      // Left-join the cached room label so the console shows `Name (Space)` rather than
      // a raw timeline key; `channel_label` falls back to the key, and is null only when
      // the event has no timeline_key at all (background caption/embedding).
      return db
        .prepare(
          `select e.*, coalesce(m.display_name, e.timeline_key) as channel_label
             from usage_events e
             left join room_metadata m on m.timeline_key = e.timeline_key
             where e.class in ('tool', 'caption', 'embedding')
             order by e.ts desc limit ?`,
        )
        .all(limit) as UsageEventRowWithChannel[];
    });
  }

  /**
   * Per-actor spend leaderboard over `[since, now)` (spec §7.1 leaderboard tab). The
   * console renders this as a humans-only ranking plus a separate "System & self"
   * block, so two attribution models are returned side by side:
   *
   * - **users** — real humans, attributed by `trigger_sender_id`, ranked contiguously
   *   1..N by spend (zero-spend excluded). Up to `limit` are returned so the console can
   *   paginate to the lowest non-zero spender.
   * - **systemActors** — non-human/self workloads, attributed by `session_type`
   *   (summarize+condense → Summarization, diary → Diary, proactive → Proactive). These
   *   carry a `comparisonRank` = where each *would* place if it were a user. Keyed on
   *   session_type (not sender) because that spend is split across the synthetic `system`
   *   sender AND null-sender tool rows — only the type captures it whole.
   *
   * Background caption/embedding (null session_type AND null sender) belong to neither
   * list but still count in `grandTotal` (the share denominator). `series` (for the
   * sub-period card averages) is computed only for carded entries — the top
   * {@link CARD_COUNT} users plus every system actor — to keep the payload small.
   */
  getUsageLeaderboard(since: number, now: number, bucketMs: number, limit: number): UsageLeaderboard {
    // Non-human/self session types, and the display label each maps to.
    const SYSTEM_TYPES = ["summarize", "condense", "diary", "proactive"] as const;
    const SYSTEM_PLACEHOLDERS = SYSTEM_TYPES.map(() => "?").join(", ");
    const ACTOR_CASE =
      "case session_type when 'summarize' then 'Summarization' when 'condense' then 'Summarization' " +
      "when 'diary' then 'Diary' when 'proactive' then 'Proactive' end";
    // How many top users / system actors get a sparkline series.
    const CARD_COUNT = 10;
    return this.read((db) => {
      // Human users: attributed by sender, with system session types excluded (coalesce
      // so a null-type-but-has-sender row still counts as human). Non-zero only, ordered
      // by spend; capped at `limit` for pagination. Display name resolved per-row from the
      // most-recent non-null name on agent_sessions (the ledger only stores the id).
      const users = db
        .prepare(
          `with top as (
             select trigger_sender_id as senderId,
                    coalesce(sum(cost_usd), 0) as total,
                    count(*) as events,
                    count(distinct agent_session_id) as sessions,
                    min(ts) as firstTs,
                    max(ts) as lastTs
               from usage_events
              where ts >= ? and trigger_sender_id is not null
                and coalesce(session_type, '') not in (${SYSTEM_PLACEHOLDERS})
              group by trigger_sender_id
             having coalesce(sum(cost_usd), 0) > 0
              order by total desc
              limit ?
           )
           select top.senderId, top.total, top.events, top.sessions, top.firstTs, top.lastTs,
                  (select s.trigger_sender_display_name
                     from agent_sessions s
                    where s.trigger_sender_id = top.senderId
                      and s.trigger_sender_display_name is not null
                    order by coalesce(s.completed_at, s.updated_at) desc
                    limit 1) as displayName
             from top
            order by top.total desc`,
        )
        .all(since, ...SYSTEM_TYPES, limit) as Array<{
        senderId: string;
        total: number;
        events: number;
        sessions: number;
        firstTs: number;
        lastTs: number;
        displayName: string | null;
      }>;

      // System actors: attributed by session_type, collapsed to the display label.
      const actors = db
        .prepare(
          `select ${ACTOR_CASE} as actorKey,
                  coalesce(sum(cost_usd), 0) as total,
                  count(*) as events,
                  count(distinct agent_session_id) as sessions,
                  min(ts) as firstTs,
                  max(ts) as lastTs
             from usage_events
            where ts >= ? and session_type in (${SYSTEM_PLACEHOLDERS})
            group by actorKey
           having coalesce(sum(cost_usd), 0) > 0
            order by total desc`,
        )
        .all(since, ...SYSTEM_TYPES) as Array<{
        actorKey: string;
        total: number;
        events: number;
        sessions: number;
        firstTs: number;
        lastTs: number;
      }>;

      // Grand total over EVERY event in the window (incl. non-attributable) — the share
      // denominator, matching the Total-spend card.
      const grandTotal = (
        db.prepare(`select coalesce(sum(cost_usd), 0) as t from usage_events where ts >= ?`).get(since) as {
          t: number;
        }
      ).t;

      // Per-(sender, bucket) spend for the carded users, feeding each card's sub-period
      // averages (`buildSpendAverages` re-bins these). `cast(... as integer)` forces an
      // integer FLOOR (a bound numeric `?` makes `ts / ?` float in SQLite).
      const seriesBySender = new Map<string, UsageLeaderboardSeriesPoint[]>();
      const cardSenderIds = users.slice(0, CARD_COUNT).map((u) => u.senderId);
      if (cardSenderIds.length > 0) {
        const placeholders = cardSenderIds.map(() => "?").join(", ");
        const rows = db
          .prepare(
            `select trigger_sender_id as senderId,
                    cast(ts / ? as integer) * ? as bucket,
                    coalesce(sum(cost_usd), 0) as cost
               from usage_events
              where ts >= ? and trigger_sender_id in (${placeholders})
                and coalesce(session_type, '') not in (${SYSTEM_PLACEHOLDERS})
              group by senderId, bucket
              order by bucket asc`,
          )
          .all(bucketMs, bucketMs, since, ...cardSenderIds, ...SYSTEM_TYPES) as Array<{
          senderId: string;
          bucket: number;
          cost: number;
        }>;
        for (const r of rows) {
          const list = seriesBySender.get(r.senderId) ?? [];
          list.push({ bucket: r.bucket, cost: r.cost });
          seriesBySender.set(r.senderId, list);
        }
      }

      // Per-(actor, bucket) spend for every system actor (there are at most three).
      const seriesByActor = new Map<string, UsageLeaderboardSeriesPoint[]>();
      if (actors.length > 0) {
        const rows = db
          .prepare(
            `select ${ACTOR_CASE} as actorKey,
                    cast(ts / ? as integer) * ? as bucket,
                    coalesce(sum(cost_usd), 0) as cost
               from usage_events
              where ts >= ? and session_type in (${SYSTEM_PLACEHOLDERS})
              group by actorKey, bucket
              order by bucket asc`,
          )
          .all(bucketMs, bucketMs, since, ...SYSTEM_TYPES) as Array<{
          actorKey: string;
          bucket: number;
          cost: number;
        }>;
        for (const r of rows) {
          const list = seriesByActor.get(r.actorKey) ?? [];
          list.push({ bucket: r.bucket, cost: r.cost });
          seriesByActor.set(r.actorKey, list);
        }
      }

      // Reference stats over the non-zero human users (the System & self cards).
      const totals = users.map((u) => u.total);
      const count = totals.length;
      const average = count > 0 ? totals.reduce((s, v) => s + v, 0) / count : 0;
      // `totals` is already sorted descending, so the middle element(s) give the median.
      let median = 0;
      if (count > 0) {
        const mid = Math.floor(count / 2);
        median = count % 2 === 1 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
      }

      const userEntries: UsageLeaderboardUser[] = users.map((u, i) => ({
        senderId: u.senderId,
        displayName: u.displayName,
        kind: "user",
        rank: i + 1,
        total: u.total,
        events: u.events,
        sessions: u.sessions,
        firstTs: u.firstTs,
        lastTs: u.lastTs,
        series: seriesBySender.get(u.senderId) ?? [],
      }));

      // comparisonRank = where this actor would sit in the human ranking: one past the
      // number of users who outspent it. `users` is sorted descending.
      const systemEntries: UsageLeaderboardUser[] = actors.map((a) => ({
        senderId: a.actorKey,
        displayName: a.actorKey,
        kind: "system",
        comparisonRank: users.filter((u) => u.total > a.total).length + 1,
        total: a.total,
        events: a.events,
        sessions: a.sessions,
        firstTs: a.firstTs,
        lastTs: a.lastTs,
        series: seriesByActor.get(a.actorKey) ?? [],
      }));

      return {
        now,
        bucketMs,
        grandTotal,
        userStats: { count, average, median },
        users: userEntries,
        systemActors: systemEntries,
      };
    });
  }

  setCaptionStatus(assetId: string, status: string, error?: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update media_assets set caption_status = ?${error ? ", caption_error = ?" : ""}, updated_at = ? where id = ?`,
      ).run(...(error ? [status, error, Date.now(), assetId] : [status, Date.now(), assetId]));
    });
  }

  resetStaleCaptions(): Promise<number> {
    return this.write((db) => {
      const result = db.prepare(
        `update media_assets set caption_status = 'pending', updated_at = ?
         where caption_status = 'processing'`,
      ).run(Date.now());
      return result.changes;
    });
  }

  countPendingCaptions(eventIds: string[]): number {
    if (eventIds.length === 0) return 0;
    return this.read((db) => {
      let total = 0;
      const batchSize = 500;
      for (let i = 0; i < eventIds.length; i += batchSize) {
        const batch = eventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(", ");
        const row = db.prepare(
          `select count(*) as remaining from media_assets
           where event_id in (${placeholders})
             and caption_status in ('pending', 'processing')
             and media_type in ('image', 'video', 'audio')`,
        ).get(...batch) as { remaining: number };
        total += row.remaining;
      }
      return total;
    });
  }

  getMediaAssetsForTriggerGroup(triggerEventId: string): MediaAssetRow[] {
    return this.read((db) => {
      return db.prepare(
        `select ma.* from media_assets ma
         where ma.event_id in (
           select id from timeline_events where trigger_group_id = ?
         )
         and ma.media_type in ('image', 'video', 'audio')
         and ma.download_status = 'complete'
         order by ma.event_id, ma.role, ma.source_index`,
      ).all(triggerEventId) as MediaAssetRow[];
    });
  }

  /**
   * The durable trigger-group membership: the ids of every timeline event whose
   * `trigger_group_id` column names this trigger (written by {@link setTriggerGroup}).
   * Mirrors {@link getMediaAssetsForTriggerGroup}'s key. Synchronous (`read`). Used by
   * the context builder to reconstruct a trigger group whose in-memory
   * `groupedEventIds` was lost — e.g. a resume that re-read the trigger from
   * `event_json` (provider-hold group only), dropping backward-lookback members
   * (FOLLOWUP-FOLDING review #2).
   */
  getTriggerGroupMemberIds(triggerEventId: string): string[] {
    return this.read((db) => {
      const rows = db.prepare(
        `select id from timeline_events where trigger_group_id = ?`,
      ).all(triggerEventId) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    });
  }

  // ── Metadata key-value accessors ──────────────────────────────────

  getMetadata(key: string): string | null {
    const row = this.read((db) =>
      db.prepare(`select value from metadata where key = ?`).get(key) as
        | { value: string }
        | undefined,
    );
    return row ? row.value : null;
  }

  setMetadata(key: string, value: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into metadata (key, value, updated_at)
         values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, value, Date.now());
    });
  }

  // ── Exclusive-cursor timeline query ───────────────────────────────

  /**
   * Like getTimelineEventsForContext, but the cursor event is EXCLUDED
   * (id > cursor, not id >=). Used when the cursor event is covered by a
   * summary and must not also render raw.
   *
   * **Fallback on missing cursor (invariant violation):** When the cursor event
   * is not found in `timeline_events`, this method falls back to
   * `getTimelineEvents()` (recent events, no cursor filtering). This is
   * intentional degradation — throwing would be worse than degraded rendering,
   * since the missing cursor requires data corruption or an out-of-order delete
   * to trigger. However, the fallback may return events that are already covered
   * by a summary, potentially causing double-rendering (an event appears both in
   * the summary layer and as a raw event). The warning log emitted in this path
   * is the primary signal for investigation. Callers should not rely on the
   * returned events being disjoint from summary coverage when the warning fires.
   */
  getTimelineEventsAfter(
    timelineKey: string,
    afterEventId: string,
    limit = 1000,
  ): CanonicalChatEvent[] {
    const cursor = this.getEventCursor(timelineKey, afterEventId);
    if (!cursor) {
      if (this.logger) {
        this.logger.warn(
          "getTimelineEventsAfter: cursor event not found, falling back to recent events",
          { timelineKey, afterEventId },
        );
      }
      return this.getTimelineEvents(timelineKey, limit);
    }

    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from timeline_events
           where timeline_key = @timelineKey
             and (
               timestamp > @timestamp
               or (timestamp = @timestamp and received_at > @receivedAt)
               or (timestamp = @timestamp and received_at = @receivedAt and id > @id)
             )
           order by timestamp asc, received_at asc, id asc
           limit @limit`,
        )
        .all({
          timelineKey,
          timestamp: cursor.timestamp,
          receivedAt: cursor.receivedAt,
          id: cursor.id,
          limit,
        }) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  getEventCursor(timelineKey: string, eventId: string): TimelineCursor | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `select timestamp, received_at, id from timeline_events
           where timeline_key = ? and id = ?`,
        )
        .get(timelineKey, eventId) as
        | { timestamp: number; received_at: number; id: string }
        | undefined,
    );
    return row ? { timestamp: row.timestamp, receivedAt: row.received_at, id: row.id } : undefined;
  }

  /**
   * Events within the inclusive cursor range [start, end], ordered by
   * (timestamp, received_at, id) ascending. IDs are not chronologically
   * sortable, so callers resolve to cursors first.
   */
  getTimelineEventsBetween(
    timelineKey: string,
    start: TimelineCursor,
    end: TimelineCursor,
  ): CanonicalChatEvent[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select event_json
           from timeline_events
           where timeline_key = @timelineKey
             and (
               timestamp > @startTs
               or (timestamp = @startTs and received_at > @startRcv)
               or (timestamp = @startTs and received_at = @startRcv and id >= @startId)
             )
             and (
               timestamp < @endTs
               or (timestamp = @endTs and received_at < @endRcv)
               or (timestamp = @endTs and received_at = @endRcv and id <= @endId)
             )
           order by timestamp asc, received_at asc, id asc`,
        )
        .all({
          timelineKey,
          startTs: start.timestamp,
          startRcv: start.receivedAt,
          startId: start.id,
          endTs: end.timestamp,
          endRcv: end.receivedAt,
          endId: end.id,
        }) as Array<{ event_json: string }>,
    );
    return rows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent);
  }

  // ── Summary queries ───────────────────────────────────────────────

  /**
   * Candidate summaries for context selection: status in (complete,
   * truncated), ordered by earliest_timestamp ASC. When beforeTimestamp is
   * set, only summaries whose coverage ends at or before it (inclusive).
   * The inclusive bound prevents a coverage gap when a summary's
   * latestTimestamp exactly equals an event's timestamp (millisecond
   * collision from Matrix batch sends — §6).
   */
  getSummaryCandidates(timelineKey: string, beforeTimestamp?: number): Summary[] {
    const rows = this.read((db) => {
      if (beforeTimestamp != null) {
        return db
          .prepare(
            `select * from summaries
             where timeline_key = ? and status in ('complete', 'truncated')
               and latest_timestamp <= ?
             order by earliest_timestamp asc`,
          )
          .all(timelineKey, beforeTimestamp) as SummaryRow[];
      }
      return db
        .prepare(
          `select * from summaries
           where timeline_key = ? and status in ('complete', 'truncated')
           order by earliest_timestamp asc`,
        )
        .all(timelineKey) as SummaryRow[];
    });
    return rows.map(mapSummaryRow);
  }

  /**
   * All summaries (every level, status complete/truncated) overlapping the inclusive
   * window [start, end] across a room set (undefined = all rooms), for `recap`'s
   * coverage selection (§9e). Overlap = latest_timestamp >= start AND
   * earliest_timestamp <= end. Ordered by timeline_key then earliest_timestamp.
   */
  getSummariesInWindow(opts: {
    timelineKeys?: string[];
    start: number;
    end: number;
  }): Summary[] {
    const rows = this.read((db) => {
      const where: string[] = [
        "status in ('complete', 'truncated')",
        "latest_timestamp >= @start",
        "earliest_timestamp <= @end",
      ];
      const params: Record<string, unknown> = { start: opts.start, end: opts.end };
      if (opts.timelineKeys && opts.timelineKeys.length > 0) {
        const keys = opts.timelineKeys.map((k, i) => {
          params[`tk${i}`] = k;
          return `@tk${i}`;
        });
        where.push(`timeline_key in (${keys.join(", ")})`);
      }
      return db
        .prepare(
          `select * from summaries where ${where.join(" and ")}
           order by timeline_key asc, earliest_timestamp asc`,
        )
        .all(params) as SummaryRow[];
    });
    return rows.map(mapSummaryRow);
  }

  getSummaryById(id: string, timelineKey?: string): Summary | undefined {
    const row = this.read((db) => {
      if (timelineKey) {
        return db
          .prepare(`select * from summaries where id = ? and timeline_key = ?`)
          .get(id, timelineKey) as SummaryRow | undefined;
      }
      return db.prepare(`select * from summaries where id = ?`).get(id) as SummaryRow | undefined;
    });
    return row ? mapSummaryRow(row) : undefined;
  }

  /**
   * Level-N summary IDs already condensed into a completed (or best-effort
   * `truncated`) level-(N+1) summary — i.e. they appear as a `parent_id` of
   * such a higher-level summary (spec SUMMARIZATION-JOB-INPUT-INTEGRITY §3.2,
   * Fix A). These are no longer condensation candidates: re-condensing a range
   * already represented one level up is pure duplicate work and the trigger
   * behind the field case (Defect A). Lineage-keyed (not timestamp-overlap),
   * so it survives the producing job row being pruned and also suppresses
   * re-condensation under a manually inserted / out-of-band higher-level
   * summary. `truncated` higher summaries count toward the covered set (open
   * question A1 resolved: the range IS represented; re-condensing it is the
   * same waste). Pure read.
   */
  getCondensedSummaryIds(timelineKey: string, level: number): Set<string> {
    const rows = this.read((db) =>
      db
        .prepare(
          `select distinct sp.parent_id as id
             from summary_parents sp
             join summaries child on child.id = sp.parent_id
             join summaries higher on higher.id = sp.summary_id
            where child.timeline_key = ?
              and child.level = ?
              and higher.level = ?
              and higher.status in ('complete', 'truncated')`,
        )
        .all(timelineKey, level, level + 1) as Array<{ id: string }>,
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Summaries at a given level, status in (complete, truncated), ordered by earliest_timestamp ASC. */
  getSummariesByLevel(timelineKey: string, level: number): Summary[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summaries
           where timeline_key = ? and level = ? and status in ('complete', 'truncated')
           order by earliest_timestamp asc`,
        )
        .all(timelineKey, level) as SummaryRow[],
    );
    return rows.map(mapSummaryRow);
  }

  /**
   * Summaries in the inclusive earliest_timestamp range bounded by two summary
   * IDs (resolved internally), ordered by earliest_timestamp ASC (tie-broken by id).
   * When `level` is provided, only summaries at that level are returned.
   */
  getSummariesBetween(timelineKey: string, startId: string, endId: string, level?: number): Summary[] {
    const start = this.getSummaryById(startId, timelineKey);
    const end = this.getSummaryById(endId, timelineKey);
    if (!start || !end) return [];

    // Precondition: boundary summaries must have a status that passes the range
    // query's `status in ('complete', 'truncated')` filter. A superseded boundary
    // would be found here (getSummaryById has no status filter) but excluded from
    // the range results, silently producing incomplete output.
    const validStatuses = new Set<string>(["complete", "truncated"]);
    if (!validStatuses.has(start.status)) {
      throw new Error(
        `getSummariesBetween: start boundary summary "${startId}" has status "${start.status}" ` +
        `which is excluded by the range query (requires 'complete' or 'truncated')`,
      );
    }
    if (!validStatuses.has(end.status)) {
      throw new Error(
        `getSummariesBetween: end boundary summary "${endId}" has status "${end.status}" ` +
        `which is excluded by the range query (requires 'complete' or 'truncated')`,
      );
    }
    const levelFilter = level != null ? "and level = @level" : "";
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summaries
           where timeline_key = @timelineKey and status in ('complete', 'truncated')
             ${levelFilter}
             and (
               earliest_timestamp > @startTs
               or (earliest_timestamp = @startTs and id >= @startId)
             )
             and (
               earliest_timestamp < @endTs
               or (earliest_timestamp = @endTs and id <= @endId)
             )
           order by earliest_timestamp asc, id asc`,
        )
        .all({
          timelineKey,
          ...(level != null ? { level } : {}),
          startTs: start.earliestTimestamp,
          startId: start.id,
          endTs: end.earliestTimestamp,
          endId: end.id,
        }) as SummaryRow[],
    );
    return rows.map(mapSummaryRow);
  }

  /**
   * The (timestamp, received_at, id) cursor of a summary's earliest covered raw
   * event, resolved through the lineage tables: a recursive ordinal-0 walk down
   * `summary_parents` to the chronologically-first level-1 descendant, then its
   * ordinal-0 `summary_events` row. Undefined when lineage is missing or the
   * event row itself is gone (e.g. retention-deleted).
   */
  getSummaryEarliestEventCursor(timelineKey: string, summaryId: string): TimelineCursor | undefined {
    const row = this.read((db) =>
      db
        .prepare(
          `with recursive chain(summary_id) as (
             select @summaryId
             union all
             select sp.parent_id from summary_parents sp
               join chain on sp.summary_id = chain.summary_id
              where sp.ordinal = 0
           )
           select se.event_id as event_id from summary_events se
             join chain on se.summary_id = chain.summary_id
            where se.ordinal = 0
            limit 1`,
        )
        .get({ summaryId }) as { event_id: string } | undefined,
    );
    if (!row) return undefined;
    return this.getEventCursor(timelineKey, row.event_id);
  }

  /**
   * True when at least one raw timeline event exists strictly BETWEEN two
   * summaries' coverage — i.e. after `prev`'s last covered event and before
   * `next`'s first covered event. This is the contiguity test behind the
   * summary-layer coverage cursor (§9b, `makeContiguityProbe`): the cursor may
   * advance across `next` only when nothing un-covered would be skipped.
   * Bounds resolve to full (timestamp, received_at, id) cursors via
   * `prev.latestEventId` and `next`'s lineage (or its in-memory
   * `earliestEventId` for synthesized placeholders); when a bound cannot be
   * resolved (lineage absent, or the event row retention-deleted), it degrades
   * to a timestamp-only INCLUSIVE bound — for the start bound `timestamp >=
   * prev.latestTimestamp`, for the end bound `timestamp <=
   * next.earliestTimestamp` — so collision-adjacent events (including a
   * surviving same-millisecond sibling of a deleted boundary event) count as
   * "between" and the cursor stops rather than silently skipping them. This
   * errs in the no-drop direction: an event at exactly the boundary timestamp
   * that prev actually covered stalls the cursor at prev and double-renders
   * (layer + raw) until retention removes it — degraded but safe; the
   * alternative (exclusive start) would let an un-covered same-ms sibling
   * slip behind the cursor and vanish from context.
   */
  hasEventsBetweenSummaries(timelineKey: string, prev: Summary, next: Summary): boolean {
    const after = this.getEventCursor(timelineKey, prev.latestEventId);
    const before = next.earliestEventId
      ? this.getEventCursor(timelineKey, next.earliestEventId)
      : this.getSummaryEarliestEventCursor(timelineKey, next.id);
    const afterCond = after
      ? `(timestamp > @aTs
          or (timestamp = @aTs and received_at > @aRcv)
          or (timestamp = @aTs and received_at = @aRcv and id > @aId))`
      : `timestamp >= @aTs`;
    const beforeCond = before
      ? `(timestamp < @bTs
          or (timestamp = @bTs and received_at < @bRcv)
          or (timestamp = @bTs and received_at = @bRcv and id < @bId))`
      : `timestamp <= @bTs`;
    const row = this.read((db) =>
      db
        .prepare(
          `select 1 as hit from timeline_events
           where timeline_key = @timelineKey and ${afterCond} and ${beforeCond}
           limit 1`,
        )
        .get({
          timelineKey,
          aTs: after?.timestamp ?? prev.latestTimestamp,
          ...(after ? { aRcv: after.receivedAt, aId: after.id } : {}),
          bTs: before?.timestamp ?? next.earliestTimestamp,
          ...(before ? { bRcv: before.receivedAt, bId: before.id } : {}),
        }) as { hit: number } | undefined,
    );
    return row != null;
  }

  /** True if any summary at level >= minLevel falls between two timestamps (inclusive). */
  hasSummaryBetween(
    timelineKey: string,
    minLevel: number,
    afterTimestamp: number,
    beforeTimestamp: number,
  ): boolean {
    const row = this.read((db) =>
      db
        .prepare(
          `select 1 from summaries
           where timeline_key = ? and level >= ? and status in ('complete', 'truncated')
             and earliest_timestamp >= ? and latest_timestamp <= ?
           limit 1`,
        )
        .get(timelineKey, minLevel, afterTimestamp, beforeTimestamp) as { 1: number } | undefined,
    );
    return row != null;
  }

  /**
   * Insert a completed/truncated summary, its lineage rows, and mark the source
   * job complete — all in one transaction. No floor is persisted (the coverage
   * cursor is derived from latest_event_id).
   */
  insertSummaryWithLineage(insert: SummaryInsert): Promise<void> {
    return this.readAndWrite((db) => {
      const hasEventIds = insert.eventIds != null && insert.eventIds.length > 0;
      const hasParentIds = insert.parentIds != null && insert.parentIds.length > 0;
      if (hasEventIds && hasParentIds) {
        throw new Error("Summary cannot have both eventIds and parentIds");
      }
      if (insert.level === 1 && !hasEventIds) {
        throw new Error("Level-1 summary must have eventIds");
      }
      if (insert.level > 1 && !hasParentIds) {
        throw new Error("Level 2+ summary must have parentIds");
      }
      const now = Date.now();
      // Diary queue (ARCHITECTURE.md §9c): every LEVEL-1 summary gets queued for a
      // diary entry, unconditionally (NOT gated on [diary].enabled — when the
      // feature is off the pool simply doesn't drain, so rows accumulate as
      // 'pending' and flush when it's turned on). Level 2+ summaries get NULL: the
      // diary is written from raw participation, never from condensed summaries.
      const diaryStatus = insert.level === 1 ? "pending" : null;
      db.prepare(
        `insert into summaries (
          id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
          latest_event_id, event_count, token_count, model_id, status,
          backfill_job_id, generated_at, created_at, diary_status, diary_attempts
        ) values (
          @id, @timelineKey, @level, @content, @earliestTimestamp, @latestTimestamp,
          @latestEventId, @eventCount, @tokenCount, @modelId, @status,
          null, @generatedAt, @createdAt, @diaryStatus, 0
        )`,
      ).run({
        id: insert.id,
        timelineKey: insert.timelineKey,
        level: insert.level,
        content: insert.content,
        earliestTimestamp: insert.earliestTimestamp,
        latestTimestamp: insert.latestTimestamp,
        latestEventId: insert.latestEventId,
        eventCount: insert.eventCount,
        tokenCount: insert.tokenCount,
        modelId: insert.modelId,
        status: insert.status,
        generatedAt: insert.generatedAt,
        createdAt: now,
        diaryStatus,
      });

      if (insert.eventIds && insert.eventIds.length > 0) {
        const stmt = db.prepare(
          `insert into summary_events (summary_id, event_id, ordinal) values (?, ?, ?)`,
        );
        insert.eventIds.forEach((eventId, ordinal) => stmt.run(insert.id, eventId, ordinal));
      }

      if (insert.parentIds && insert.parentIds.length > 0) {
        const stmt = db.prepare(
          `insert into summary_parents (summary_id, parent_id, ordinal) values (?, ?, ?)`,
        );
        insert.parentIds.forEach((parentId, ordinal) => stmt.run(insert.id, parentId, ordinal));
      }

      const jobUpdate = db.prepare(
        `update summarization_jobs set status = 'complete', result_summary_id = ?, updated_at = ?
         where id = ?`,
      ).run(insert.id, now, insert.jobId);
      if (jobUpdate.changes !== 1) {
        throw new Error(
          `insertSummaryWithLineage: expected to update exactly 1 job row for "${insert.jobId}", ` +
          `but ${jobUpdate.changes} rows matched — rolling back`,
        );
      }
    });
  }

  // ── Summarization job queue ───────────────────────────────────────

  insertSummarizationJob(job: SummarizationJobInsert): Promise<void> {
    return this.write((db) => {
      const now = Date.now();
      db.prepare(
        `insert into summarization_jobs (
          id, timeline_key, level, status, priority, input_start_id, input_end_id,
          input_token_count, target_token_count, attempts, max_retries,
          created_at, updated_at
        ) values (
          @id, @timelineKey, @level, 'pending', @priority, @inputStartId, @inputEndId,
          @inputTokenCount, @targetTokenCount, 0, @maxRetries, @createdAt, @updatedAt
        )`,
      ).run({
        id: job.id,
        timelineKey: job.timelineKey,
        level: job.level,
        priority: job.priority ?? "background",
        inputStartId: job.inputStartId,
        inputEndId: job.inputEndId,
        inputTokenCount: job.inputTokenCount,
        targetTokenCount: job.targetTokenCount,
        maxRetries: job.maxRetries,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  getSummarizationJobById(id: string): SummarizationJob | undefined {
    const row = this.read((db) =>
      db.prepare(`select * from summarization_jobs where id = ?`).get(id) as
        | SummarizationJobRow
        | undefined,
    );
    return row ? mapJobRow(row) : undefined;
  }

  /** Active (pending or processing) jobs for a timeline + level. */
  getActiveSummarizationJobs(timelineKey: string, level: number): SummarizationJob[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summarization_jobs
           where timeline_key = ? and level = ? and status in ('pending', 'processing')
           order by created_at asc`,
        )
        .all(timelineKey, level) as SummarizationJobRow[],
    );
    return rows.map(mapJobRow);
  }

  /**
   * Terminally failed level-N jobs for a timeline. Drives the builder's
   * wait-or-omit failure placeholder (spec §7.2): a range whose job exhausted
   * retries with no salvageable draft renders as an explicit "couldn't
   * summarize" marker in the summary layer instead of silently dropping events.
   */
  getFailedSummarizationJobs(timelineKey: string, level: number): SummarizationJob[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summarization_jobs
           where timeline_key = ? and level = ? and status = 'failed'
           order by created_at asc`,
        )
        .all(timelineKey, level) as SummarizationJobRow[],
    );
    return rows.map(mapJobRow);
  }

  /** All processing jobs for a timeline (any level). */
  getProcessingSummarizationJobs(timelineKey: string): SummarizationJob[] {
    const rows = this.read((db) =>
      db
        .prepare(
          `select * from summarization_jobs
           where timeline_key = ? and status = 'processing'
           order by created_at asc`,
        )
        .all(timelineKey) as SummarizationJobRow[],
    );
    return rows.map(mapJobRow);
  }

  /**
   * Claim the highest-priority, oldest pending job via CAS (pending →
   * processing). Priority order is the scheduler class ranking (spec §5.5):
   * an escalated job is claimed ahead of unrelated background work; FIFO
   * (created_at) within a class. The SAME transaction increments attempts
   * (first claim => attempts = 1), bounding crash-loops. Returns the claimed
   * job (post-update) or undefined.
   */
  claimNextSummarizationJob(): Promise<SummarizationJob | undefined> {
    return this.readAndWrite((db) => {
      const row = db
        .prepare(
          `select * from summarization_jobs
           where status = 'pending'
           order by case priority
                      when 'interactive' then 3
                      when 'proactive' then 2
                      when 'background' then 1
                      else 0
                    end desc,
                    created_at asc
           limit 1`,
        )
        .get() as SummarizationJobRow | undefined;
      if (!row) return undefined;
      const now = Date.now();
      const result = db
        .prepare(
          `update summarization_jobs
           set status = 'processing', attempts = attempts + 1, updated_at = ?
           where id = ? and status = 'pending'`,
        )
        .run(now, row.id);
      if (result.changes === 0) return undefined;
      return mapJobRow({ ...row, status: "processing", attempts: row.attempts + 1, updated_at: now });
    });
  }

  /**
   * Priority inheritance, job-row half (spec §5.5): raise a job's priority so
   * `claimNextSummarizationJob` picks it next and the worker admits its LLM
   * request at the waiter's class. Raise-only — a job already at or above the
   * requested class is left unchanged (escalation never demotes) — and only
   * non-terminal (pending/processing) rows are touched. Returns true when the
   * row was actually raised.
   */
  escalateSummarizationJob(jobId: string, priority: SummarizationJobPriority): Promise<boolean> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update summarization_jobs
           set priority = @priority, updated_at = @now
           where id = @jobId
             and status in ('pending', 'processing')
             and (case priority
                    when 'interactive' then 3
                    when 'proactive' then 2
                    when 'background' then 1
                    else 0
                  end)
               < (case @priority
                    when 'interactive' then 3
                    when 'proactive' then 2
                    when 'background' then 1
                    else 0
                  end)`,
        )
        .run({ jobId, priority, now: Date.now() });
      return result.changes > 0;
    });
  }

  /** Set a job back to pending for retry, recording the error. */
  retrySummarizationJob(jobId: string, error: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs set status = 'pending', error = ?, updated_at = ? where id = ?`,
      ).run(error, Date.now(), jobId);
    });
  }

  /**
   * Return a cleanly-DRAINED job to 'pending' with the claim-time attempts
   * increment compensated (spec LLM-FAILURE-HANDLING §7): a drain abort is not
   * a semantic failure — the work never produced a judged draft — so it must
   * not consume the job's retry budget. Only the clean drain path compensates;
   * a hard process crash never reaches this decrement, so a job that *crashes*
   * the worker repeatedly still walks to 'failed' (the crash-loop bound).
   * Guarded on `status = 'processing'` so it can never double-decrement or
   * overwrite a terminal/re-pending row.
   */
  returnSummarizationJobToPending(jobId: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs
         set status = 'pending', attempts = max(attempts - 1, 0), updated_at = ?
         where id = ? and status = 'processing'`,
      ).run(Date.now(), jobId);
    });
  }

  failSummarizationJob(jobId: string, error: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs set status = 'failed', error = ?, updated_at = ? where id = ?`,
      ).run(error, Date.now(), jobId);
    });
  }

  saveBestEffortDraft(jobId: string, draft: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summarization_jobs set best_effort_draft = ?, updated_at = ? where id = ?`,
      ).run(draft, Date.now(), jobId);
    });
  }

  /** Reset stale 'processing' claims to 'pending' on startup (attempts left as-is). */
  resetStaleSummarizationJobs(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update summarization_jobs set status = 'pending', updated_at = ?
           where status = 'processing'`,
        )
        .run(Date.now());
      return result.changes;
    });
  }

  // ── Diary queue (ARCHITECTURE.md §9c) ─────────────────────────────
  //
  // The `diary_status` column on level-1 summary rows IS the queue — identical
  // to the enrichment_status / caption_status / summarization_jobs.status idiom.
  // No separate job/queue table. Only 'pending' rows are ever claimed → the DB
  // is the sole idempotency authority (correctness never depends on file state).

  /**
   * Claim the oldest pending diary job via CAS (pending → processing). The SAME
   * transaction increments+persists `diary_attempts` (first claim => attempts =
   * 1), so a crash un-sticks the row (via {@link resetStaleDiary}) without
   * refunding its retry budget. Returns the claimed job (post-update) or
   * undefined.
   */
  claimNextDiaryJob(): Promise<DiaryJob | undefined> {
    return this.readAndWrite((db) => {
      const row = db
        .prepare(
          `select id, timeline_key, level, earliest_timestamp, latest_timestamp, diary_attempts
           from summaries
           where level = 1 and diary_status = 'pending'
           order by latest_timestamp asc
           limit 1`,
        )
        .get() as
        | {
            id: string;
            timeline_key: string;
            level: number;
            earliest_timestamp: number;
            latest_timestamp: number;
            diary_attempts: number;
          }
        | undefined;
      if (!row) return undefined;
      const result = db
        .prepare(
          `update summaries
           set diary_status = 'processing', diary_attempts = diary_attempts + 1
           where id = ? and diary_status = 'pending'`,
        )
        .run(row.id);
      if (result.changes === 0) return undefined;
      return {
        summaryId: row.id,
        timelineKey: row.timeline_key,
        level: row.level,
        earliestTimestamp: row.earliest_timestamp,
        latestTimestamp: row.latest_timestamp,
        attempts: row.diary_attempts + 1,
      };
    });
  }

  /**
   * Read a level-1 summary's current diary status. Undefined when the summary
   * row is missing or carries no diary status (level 2+). Used by the diary
   * worker's post-claim terminality guard to avoid overwriting a row that
   * already left 'processing'.
   */
  getDiaryStatus(summaryId: string): DiaryStatus | undefined {
    const row = this.read((db) =>
      db.prepare(`select diary_status from summaries where id = ?`).get(summaryId) as
        | { diary_status: string | null }
        | undefined,
    );
    return (row?.diary_status ?? undefined) as DiaryStatus | undefined;
  }

  /** Set a level-1 summary's diary status (done / skipped / failed / pending-retry). */
  setDiaryStatus(summaryId: string, status: DiaryStatus): Promise<void> {
    return this.write((db) => {
      db.prepare(`update summaries set diary_status = ? where id = ?`).run(status, summaryId);
    });
  }

  /**
   * Diary twin of {@link returnSummarizationJobToPending} (spec
   * LLM-FAILURE-HANDLING §7): return a cleanly-drained diary job to 'pending'
   * with the claim-time `diary_attempts` increment compensated. Guarded on
   * `diary_status = 'processing'` — never touches a terminal or re-pending row.
   */
  returnDiaryJobToPending(summaryId: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update summaries
         set diary_status = 'pending', diary_attempts = max(diary_attempts - 1, 0)
         where id = ? and diary_status = 'processing'`,
      ).run(summaryId);
    });
  }

  /**
   * Reset stale 'processing' diary claims to 'pending' on startup (attempts left
   * as-is, so a crash doesn't refund the retry budget). Mirrors
   * resetStaleEnrichment / resetStaleCaptions / resetStaleSummarizationJobs.
   */
  resetStaleDiary(): Promise<number> {
    return this.write((db) => {
      const result = db
        .prepare(`update summaries set diary_status = 'pending' where diary_status = 'processing'`)
        .run();
      return result.changes;
    });
  }

  // ── Memory retrieval index (ARCHITECTURE.md §9d) ──────────────────
  // `memory_chunks` is the corpus index; reconciliation is a content-hash set-diff
  // per file (§7). The DB — keyed on chunk `id = hash(path+text)` — is the sole
  // idempotency authority; correctness never depends on when a file write happened.

  /**
   * Reconcile a single file's chunks against the index (§7). New/changed-hash
   * chunks (a different `id`) are inserted with `embed_status='pending'`; chunks no
   * longer present are deleted; chunks present in both with shifted line/ordinal
   * metadata are updated in place (text identical → embedding preserved). FTS rows
   * follow via triggers. Runs in one transaction so a search never sees a torn diff.
   */
  /**
   * Reconcile a file's chunks into the index (§7). `newChunkStatus` is the
   * `embed_status` stamped on freshly-inserted chunks: `'pending'` in the normal
   * (provider-present) path so the embed worker picks them up, or `'skip'` in the
   * lexical-only path (no active provider) so the pending queue doesn't grow
   * unbounded (#2). `resetAllEmbeddings()` re-queues `'skip'` rows when a provider
   * later becomes active, keeping the round-trip consistent (§5a).
   */
  reconcileMemoryChunks(
    path: string,
    chunks: MemoryChunkInput[],
    newChunkStatus: "pending" | "skip" = "pending",
  ): Promise<ReconcileResult> {
    return this.readAndWrite((db) => {
      const existing = db
        .prepare(`select rowid, id, ordinal, start_line, end_line from memory_chunks where path = ?`)
        .all(path) as Array<{
        rowid: number;
        id: string;
        ordinal: number;
        start_line: number;
        end_line: number;
      }>;
      const existingById = new Map(existing.map((r) => [r.id, r]));
      const now = Date.now();
      const insertStmt = db.prepare(
        `insert into memory_chunks (
           id, path, ordinal, source, start_line, end_line, room, entry_ts,
           text, token_count, content_hash, embed_status, indexed_at
         ) values (
           @id, @path, @ordinal, @source, @startLine, @endLine, @room, @entryTs,
           @text, @tokenCount, @contentHash, @embedStatus, @now
         )`,
      );
      const updateStmt = db.prepare(
        `update memory_chunks set ordinal = @ordinal, start_line = @startLine, end_line = @endLine
         where id = @id`,
      );
      const deleteStmt = db.prepare(`delete from memory_chunks where id = ?`);

      let inserted = 0;
      let updated = 0;
      const deletedRowids: number[] = [];
      const seen = new Set<string>();
      for (const c of chunks) {
        // A chunk id is sha256(path\0text), so two byte-identical chunks in one
        // file share an id. The first occurrence inserts/updates and records the
        // id in `seen`; skip any later duplicate so we don't hit the UNIQUE
        // constraint (which would abort the whole reconcile transaction). The id
        // is already in `seen`, so the delete pass below won't prune its row.
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const prev = existingById.get(c.id);
        if (!prev) {
          insertStmt.run({
            id: c.id,
            path: c.path,
            ordinal: c.ordinal,
            source: c.source,
            startLine: c.startLine,
            endLine: c.endLine,
            room: c.room,
            entryTs: c.entryTs,
            text: c.text,
            tokenCount: c.tokenCount,
            contentHash: c.contentHash,
            embedStatus: newChunkStatus,
            now,
          });
          inserted += 1;
        } else if (
          prev.ordinal !== c.ordinal ||
          prev.start_line !== c.startLine ||
          prev.end_line !== c.endLine
        ) {
          updateStmt.run({
            id: c.id,
            ordinal: c.ordinal,
            startLine: c.startLine,
            endLine: c.endLine,
          });
          updated += 1;
        }
      }
      for (const r of existing) {
        if (!seen.has(r.id)) {
          deleteStmt.run(r.id);
          deletedRowids.push(r.rowid);
        }
      }
      return { inserted, updated, deleted: deletedRowids.length, deletedRowids };
    });
  }

  /** All distinct file paths currently represented in the index (for sweep pruning). */
  listMemoryChunkPaths(): string[] {
    return this.read((db) => {
      const rows = db
        .prepare(`select distinct path from memory_chunks`)
        .all() as Array<{ path: string }>;
      return rows.map((r) => r.path);
    });
  }

  /** Drop every chunk for a path (a file deleted out from under the index). */
  deleteMemoryChunksForPath(path: string): Promise<number> {
    return this.write((db) => {
      return db.prepare(`delete from memory_chunks where path = ?`).run(path).changes;
    });
  }

  /**
   * Lexical (FTS5/BM25) candidate search (§4/§8a). `match` is a pre-built FTS5 MATCH
   * expression (the tool sanitizes free text into it). Optional room/time filters
   * apply to the joined `memory_chunks` metadata. Ordered best-first (bm25 ascending).
   */
  searchMemoryLexical(opts: {
    match: string;
    limit: number;
    room?: string;
    afterTs?: number;
    beforeTs?: number;
  }): LexicalHit[] {
    return this.read((db) => {
      const clauses: string[] = ["memory_chunks_fts match @match"];
      const params: Record<string, unknown> = { match: opts.match, limit: opts.limit };
      if (opts.room !== undefined) {
        clauses.push("c.room = @room");
        params.room = opts.room;
      }
      if (opts.afterTs !== undefined) {
        clauses.push("c.entry_ts >= @afterTs");
        params.afterTs = opts.afterTs;
      }
      if (opts.beforeTs !== undefined) {
        // Exclusive: `beforeTs` is the start of the day AFTER the `before` filter, so
        // the `before` day is fully inclusive (review issue #12).
        clauses.push("c.entry_ts < @beforeTs");
        params.beforeTs = opts.beforeTs;
      }
      const rows = db
        .prepare(
          `select c.rowid as rowid, c.id as id, c.path as path, c.start_line as startLine,
                  c.end_line as endLine, c.room as room, c.entry_ts as entryTs, c.text as text,
                  bm25(memory_chunks_fts) as bm25
           from memory_chunks_fts
           join memory_chunks c on c.rowid = memory_chunks_fts.rowid
           where ${clauses.join(" and ")}
           order by bm25 asc
           limit @limit`,
        )
        .all(params) as LexicalHit[];
      return rows;
    });
  }

  /**
   * Fetch chunk metadata + text by rowid (for vector-only hits that weren't in the
   * lexical candidate set, §8a). Optional room/time filters mirror the lexical query
   * so the same constraints apply to the semantic half.
   */
  getChunksByRowids(
    rowids: number[],
    filters?: { room?: string; afterTs?: number; beforeTs?: number },
  ): LexicalHit[] {
    if (rowids.length === 0) return [];
    return this.read((db) => {
      const placeholders = rowids.map(() => "?").join(",");
      const clauses = [`rowid in (${placeholders})`];
      const params: unknown[] = [...rowids];
      if (filters?.room !== undefined) {
        clauses.push("room = ?");
        params.push(filters.room);
      }
      if (filters?.afterTs !== undefined) {
        clauses.push("entry_ts >= ?");
        params.push(filters.afterTs);
      }
      if (filters?.beforeTs !== undefined) {
        // Exclusive start-of-next-day bound (review issue #12); mirrors searchMemoryLexical.
        clauses.push("entry_ts < ?");
        params.push(filters.beforeTs);
      }
      const rows = db
        .prepare(
          `select rowid, id, path, start_line as startLine, end_line as endLine, room,
                  entry_ts as entryTs, text, 0 as bm25
           from memory_chunks where ${clauses.join(" and ")}`,
        )
        .all(...params) as LexicalHit[];
      return rows;
    });
  }

  /** Read a single `index_meta` value (active model id/dim, corpus signature). */
  getIndexMeta(key: string): string | undefined {
    return this.read((db) => {
      const row = db.prepare(`select value from index_meta where key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    });
  }

  /** Upsert a single `index_meta` value. */
  setIndexMeta(key: string, value: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into index_meta (key, value) values (?, ?)
         on conflict(key) do update set value = excluded.value`,
      ).run(key, value);
    });
  }

  // ── Chat-history search index (ARCHITECTURE.md §9e, src/search/) ───────────────

  /**
   * Join the projection inputs for chat-search indexing. With `eventId`, returns that
   * one event (incremental reconcile after persist / caption / edit). Otherwise returns
   * a full-sweep page of `limit` events with `timeline_events.rowid > afterRowid`,
   * ordered by rowid so the caller can keyset-page the whole corpus. Undecryptable
   * events project with an empty body (harmless); they re-project when re-decryption
   * bumps `updated_at` and changes the body.
   */
  getChatProjectionInputs(opts: {
    eventId?: string;
    afterRowid?: number;
    limit?: number;
  }): ChatProjectionInput[] {
    return this.read((db) => {
      const selectCols = `
        e.rowid as srcRowid, e.id as eventId, e.timeline_key as timelineKey,
        e.sender_id as senderId, e.sender_display_name as senderDisplayName,
        e.role as role, e.body as body, e.timestamp as timestamp,
        e.updated_at as updatedAt, e.event_json as eventJson,
        -- group_concat without ORDER BY is order-unstable, which would let aux_text
        -- (and the derived content_sig) flap across runs for multi-attachment /
        -- multi-link events, churning the FTS projection. Each concat below pins a
        -- deterministic order by a stable column: media_type for the DISTINCT set
        -- (order expr must match the distinct expr), and the (ordinal, primary-key)
        -- pair for the others (source_index/preview_index are nullable/duplicable,
        -- so the text id PK is the stable tiebreaker).
        (select group_concat(distinct ma.media_type order by ma.media_type) from media_assets ma
           where ma.event_id = e.id and ma.role = 'attachment') as attachmentTypes,
        (select count(*) from media_assets ma
           where ma.event_id = e.id and ma.role = 'attachment') as attachCount,
        (select group_concat(ma.caption, ' ' order by ma.source_index, ma.id) from media_assets ma
           where ma.event_id = e.id and ma.caption_status = 'complete'
             and ma.caption is not null and ma.caption <> '') as captions,
        (select count(*) from link_previews lp where lp.event_id = e.id) as linkCount,
        (select group_concat(
                  trim(coalesce(lp.title,'') || ' ' || coalesce(lp.description,'') || ' '
                       || coalesce(lp.site_name,'')), ' ' order by lp.preview_index, lp.id)
           from link_previews lp where lp.event_id = e.id) as linkText,
        (select rc.sender_id from reply_contexts rc where rc.event_id = e.id) as quotedSenderId,
        (select count(*) from reply_contexts rc where rc.event_id = e.id) as replyCount`;
      if (opts.eventId !== undefined) {
        return db
          .prepare(`select ${selectCols} from timeline_events e where e.id = ?`)
          .all(opts.eventId) as ChatProjectionInput[];
      }
      return db
        .prepare(
          `select ${selectCols} from timeline_events e
           where e.rowid > @afterRowid order by e.rowid limit @limit`,
        )
        .all({
          afterRowid: opts.afterRowid ?? 0,
          limit: opts.limit ?? 500,
        }) as ChatProjectionInput[];
    });
  }

  /**
   * Set-diff a batch of projected rows into `chat_index` (+ `chat_mentions`) in one
   * transaction. A row whose `content_sig` is unchanged is left untouched (no FTS
   * churn — the `chat_index_au` trigger is gated on body/aux_text anyway, but skipping
   * the write entirely avoids even evaluating it). Inserts/updates rewrite the row and
   * replace its mention set. Returns counts + the max source rowid for cursor advance.
   */
  upsertChatIndexRows(rows: ChatIndexUpsert[]): Promise<ChatIndexReconcileResult> {
    return this.readAndWrite((db) => {
      const existing = db.prepare(
        `select rowid, content_sig as sig from chat_index where event_id = ?`,
      );
      const insertRow = db.prepare(
        `insert into chat_index (
           event_id, timeline_key, sender_id, sender_display_name, role, timestamp,
           body, aux_text, has_attachment, attachment_types, has_link, is_reply,
           quoted_sender_id, content_sig, indexed_at
         ) values (
           @eventId, @timelineKey, @senderId, @senderDisplayName, @role, @timestamp,
           @body, @auxText, @hasAttachment, @attachmentTypes, @hasLink, @isReply,
           @quotedSenderId, @contentSig, @now
         )`,
      );
      const updateRow = db.prepare(
        `update chat_index set
           timeline_key = @timelineKey, sender_id = @senderId,
           sender_display_name = @senderDisplayName, role = @role, timestamp = @timestamp,
           body = @body, aux_text = @auxText, has_attachment = @hasAttachment,
           attachment_types = @attachmentTypes, has_link = @hasLink, is_reply = @isReply,
           quoted_sender_id = @quotedSenderId, content_sig = @contentSig, indexed_at = @now
         where event_id = @eventId`,
      );
      const deleteMentions = db.prepare(`delete from chat_mentions where event_id = ?`);
      const insertMention = db.prepare(
        `insert or ignore into chat_mentions (event_id, user_id) values (?, ?)`,
      );
      const now = Date.now();
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      for (const r of rows) {
        const prev = existing.get(r.eventId) as { rowid: number; sig: string } | undefined;
        if (prev && prev.sig === r.contentSig) {
          unchanged += 1;
          continue;
        }
        const params = {
          eventId: r.eventId,
          timelineKey: r.timelineKey,
          senderId: r.senderId,
          senderDisplayName: r.senderDisplayName,
          role: r.role,
          timestamp: r.timestamp,
          body: r.body,
          auxText: r.auxText,
          hasAttachment: r.hasAttachment,
          attachmentTypes: r.attachmentTypes,
          hasLink: r.hasLink,
          isReply: r.isReply,
          quotedSenderId: r.quotedSenderId,
          contentSig: r.contentSig,
          now,
        };
        if (prev) {
          updateRow.run(params);
          updated += 1;
        } else {
          insertRow.run(params);
          inserted += 1;
        }
        // Replace the mention set for this event.
        deleteMentions.run(r.eventId);
        for (const userId of r.mentions) insertMention.run(r.eventId, userId);
      }
      return { inserted, updated, unchanged };
    });
  }

  /** Count indexed events (optionally within a room set) — for the search trailer. */
  countChatIndex(timelineKeys?: string[]): number {
    return this.read((db) => {
      if (timelineKeys && timelineKeys.length > 0) {
        const keys = timelineKeys.map((_, i) => `@k${i}`);
        const params: Record<string, string> = {};
        timelineKeys.forEach((k, i) => (params[`k${i}`] = k));
        const row = db
          .prepare(
            `select count(*) as n from chat_index where timeline_key in (${keys.join(", ")})`,
          )
          .get(params) as { n: number };
        return row.n;
      }
      return (db.prepare(`select count(*) as n from chat_index`).get() as { n: number }).n;
    });
  }

  /** Remove a single event's chat-index row (and, via trigger, its mentions). */
  deleteChatIndexForEvent(eventId: string): Promise<number> {
    return this.write((db) => {
      return db.prepare(`delete from chat_index where event_id = ?`).run(eventId).changes;
    });
  }

  /** Drop chat-index rows whose source event no longer exists (sweep prune). */
  pruneChatIndexOrphans(): Promise<number> {
    return this.write((db) => {
      return db.prepare(
        `delete from chat_index
         where not exists (select 1 from timeline_events e where e.id = chat_index.event_id)`,
      ).run().changes;
    });
  }

  /**
   * Execute a parsed chat-search query (`search_messages`, ARCHITECTURE.md §9e) over
   * `chat_index` (+ `chat_index_fts` when a text MATCH is present, + `chat_mentions`
   * for the mention filter). Returns the requested page plus the unpaginated `total`
   * so the tool can tell the agent whether it saw every match. All filters are
   * AND-combined. Ordering: newest/oldest are keyset-paginated on (timestamp, rowid);
   * relevance (bm25) returns the first page only (the tool documents this).
   */
  searchChatIndex(q: ChatSearchQuery): ChatSearchResult {
    return this.read((db) => {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      const ftsJoin = q.match ? "join chat_index_fts f on f.rowid = ci.rowid" : "";
      if (q.match) {
        where.push("chat_index_fts match @match");
        params.match = q.match;
      }
      const inClause = (col: string, values: string[], prefix: string): void => {
        const keys = values.map((v, i) => {
          params[`${prefix}${i}`] = v;
          return `@${prefix}${i}`;
        });
        where.push(`${col} in (${keys.join(", ")})`);
      };
      if (q.timelineKeys && q.timelineKeys.length > 0) {
        inClause("ci.timeline_key", q.timelineKeys, "tk");
      }
      if (q.fromSenders && q.fromSenders.length > 0) {
        inClause("ci.sender_id", q.fromSenders, "fs");
      }
      if (q.quotedUsers && q.quotedUsers.length > 0) {
        inClause("ci.quoted_sender_id", q.quotedUsers, "qu");
      }
      if (q.mentions && q.mentions.length > 0) {
        const keys = q.mentions.map((v, i) => {
          params[`mn${i}`] = v;
          return `@mn${i}`;
        });
        where.push(
          `exists (select 1 from chat_mentions m
                   where m.event_id = ci.event_id and m.user_id in (${keys.join(", ")}))`,
        );
      }
      if (q.isReply !== undefined) {
        where.push("ci.is_reply = @isReply");
        params.isReply = q.isReply ? 1 : 0;
      }
      if (q.hasAttachment !== undefined) {
        where.push("ci.has_attachment = @hasAttachment");
        params.hasAttachment = q.hasAttachment ? 1 : 0;
      }
      if (q.hasLink !== undefined) {
        where.push("ci.has_link = @hasLink");
        params.hasLink = q.hasLink ? 1 : 0;
      }
      if (q.attachmentTypes && q.attachmentTypes.length > 0) {
        // attachment_types is a csv of the fixed tokens image/video/audio/file — none
        // is a substring of another, so a LIKE per requested type is unambiguous.
        const ors = q.attachmentTypes.map((t, i) => {
          params[`at${i}`] = `%${t}%`;
          return `ci.attachment_types like @at${i}`;
        });
        where.push(`ci.has_attachment = 1 and (${ors.join(" or ")})`);
      }
      if (q.afterTs !== undefined) {
        where.push("ci.timestamp >= @afterTs");
        params.afterTs = q.afterTs;
      }
      if (q.beforeTs !== undefined) {
        where.push("ci.timestamp < @beforeTs");
        params.beforeTs = q.beforeTs;
      }

      const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";

      const totalRow = db
        .prepare(`select count(*) as n from chat_index ci ${ftsJoin} ${whereSql}`)
        .get(params) as { n: number };

      // Keyset cursor (newest/oldest only). Relevance can't keyset on bm25 cheaply, so
      // it returns the first page; the tool notes this in its output.
      const pageWhere = [...where];
      const pageParams: Record<string, unknown> = { ...params, limit: q.limit };
      let orderSql: string;
      if (q.order === "relevance" && q.match) {
        orderSql = "order by bm25(chat_index_fts) asc";
      } else {
        const desc = q.order !== "oldest";
        if (q.cursor) {
          const cmp = desc ? "<" : ">";
          pageWhere.push(
            `(ci.timestamp ${cmp} @curTs or (ci.timestamp = @curTs and ci.rowid ${cmp} @curRowid))`,
          );
          pageParams.curTs = q.cursor.timestamp;
          pageParams.curRowid = q.cursor.rowid;
        }
        orderSql = desc
          ? "order by ci.timestamp desc, ci.rowid desc"
          : "order by ci.timestamp asc, ci.rowid asc";
      }
      const pageWhereSql = pageWhere.length > 0 ? `where ${pageWhere.join(" and ")}` : "";
      const bm25Sel = q.match ? "bm25(chat_index_fts) as bm25" : "0 as bm25";
      const hits = db
        .prepare(
          `select ci.rowid as rowid, ci.event_id as eventId, ci.timeline_key as timelineKey,
                  ci.sender_id as senderId, ci.sender_display_name as senderDisplayName,
                  ci.role as role, ci.timestamp as timestamp, ci.body as body,
                  ci.aux_text as auxText, ci.has_attachment as hasAttachment,
                  ci.attachment_types as attachmentTypes, ci.has_link as hasLink,
                  ci.is_reply as isReply, ci.quoted_sender_id as quotedSenderId, ${bm25Sel}
           from chat_index ci ${ftsJoin} ${pageWhereSql} ${orderSql} limit @limit`,
        )
        .all(pageParams) as ChatSearchHit[];
      return { hits, total: totalRow.n };
    });
  }

  /**
   * Keyword search over `summaries_fts` (ARCHITECTURE.md §9e), backing
   * `search_messages(corpus:"summaries")`. Mirrors {@link searchChatIndex}: optional
   * FTS join when `match` is set (else a metadata-only scan), keyset pagination on
   * `(latest_timestamp, rowid)` for newest/oldest, and bm25 ordering for relevance.
   * `superseded` is always excluded — it is dropped from the requested `statuses` set
   * before the query, so it can never be returned. Pure read.
   */
  searchSummaries(q: SummarySearchQuery): SummarySearchResult {
    return this.read((db) => {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      const ftsJoin = q.match ? "join summaries_fts f on f.rowid = s.rowid" : "";
      if (q.match) {
        where.push("summaries_fts match @match");
        params.match = q.match;
      }
      // Status: default complete+truncated; superseded is never searchable, so strip
      // it from whatever was requested. An empty set after stripping matches nothing.
      const statuses = (q.statuses ?? ["complete", "truncated"]).filter(
        (st) => st !== "superseded",
      );
      const statusKeys = statuses.map((st, i) => {
        params[`st${i}`] = st;
        return `@st${i}`;
      });
      where.push(
        statusKeys.length > 0 ? `s.status in (${statusKeys.join(", ")})` : "0",
      );
      if (q.timelineKeys && q.timelineKeys.length > 0) {
        const keys = q.timelineKeys.map((k, i) => {
          params[`tk${i}`] = k;
          return `@tk${i}`;
        });
        where.push(`s.timeline_key in (${keys.join(", ")})`);
      }
      if (q.levels && q.levels.length > 0) {
        const keys = q.levels.map((lv, i) => {
          params[`lv${i}`] = lv;
          return `@lv${i}`;
        });
        where.push(`s.level in (${keys.join(", ")})`);
      }
      if (q.minLevel !== undefined) {
        where.push("s.level >= @minLevel");
        params.minLevel = q.minLevel;
      }
      // Window overlap (not containment): a summary touches [after, before] if its span
      // intersects it — mirrors getSummariesInWindow's overlap test.
      if (q.afterTs !== undefined) {
        where.push("s.latest_timestamp >= @afterTs");
        params.afterTs = q.afterTs;
      }
      if (q.beforeTs !== undefined) {
        where.push("s.earliest_timestamp <= @beforeTs");
        params.beforeTs = q.beforeTs;
      }

      const whereSql = `where ${where.join(" and ")}`;
      const totalRow = db
        .prepare(`select count(*) as n from summaries s ${ftsJoin} ${whereSql}`)
        .get(params) as { n: number };

      const pageWhere = [...where];
      const pageParams: Record<string, unknown> = { ...params, limit: q.limit };
      let orderSql: string;
      if (q.order === "relevance" && q.match) {
        orderSql = "order by bm25(summaries_fts) asc";
      } else {
        const desc = q.order !== "oldest";
        if (q.cursor) {
          const cmp = desc ? "<" : ">";
          pageWhere.push(
            `(s.latest_timestamp ${cmp} @curTs or (s.latest_timestamp = @curTs and s.rowid ${cmp} @curRowid))`,
          );
          pageParams.curTs = q.cursor.timestamp;
          pageParams.curRowid = q.cursor.rowid;
        }
        orderSql = desc
          ? "order by s.latest_timestamp desc, s.rowid desc"
          : "order by s.latest_timestamp asc, s.rowid asc";
      }
      const pageWhereSql = `where ${pageWhere.join(" and ")}`;
      const bm25Sel = q.match ? "bm25(summaries_fts) as bm25" : "0 as bm25";
      const hits = db
        .prepare(
          `select s.rowid as rowid, s.id as id, s.timeline_key as timelineKey,
                  s.level as level, s.earliest_timestamp as earliestTimestamp,
                  s.latest_timestamp as latestTimestamp, s.event_count as eventCount,
                  s.token_count as tokenCount, s.status as status, s.content as content, ${bm25Sel}
           from summaries s ${ftsJoin} ${pageWhereSql} ${orderSql} limit @limit`,
        )
        .all(pageParams) as SummarySearchHit[];
      return { hits, total: totalRow.n };
    });
  }

  /**
   * Re-converge `summaries_fts` with the `summaries` table (ARCHITECTURE.md §9e). The
   * insert/delete triggers keep the FTS live for new/removed summaries, and the v13->v14
   * migration rebuilds it for pre-existing rows — this startup sweep is the
   * belt-and-suspenders net that repairs any trigger gap (mirrors how the chat index
   * reconciles on boot).
   *
   * Convergence uses the FTS5 `'rebuild'` command rather than an anti-join: `summaries_fts`
   * is an EXTERNAL-CONTENT table, so a `select … from summaries_fts where rowid = ?` probe
   * reads column values back from the `summaries` content table — it cannot tell whether
   * a given rowid is actually present in the FTS *index*, which makes a "rows not in FTS"
   * anti-join silently a no-op. `'rebuild'` re-derives the entire index from the content
   * table, which is the authoritative convergence primitive and is cheap here because
   * summaries are deliberately few (hierarchical condensation), unlike raw events.
   *
   * The `'rebuild'` is gated behind a cheap count-mismatch check so an unchanged DB skips
   * the O(all summaries) rewrite on every boot. We compare the number of searchable
   * summaries (`status in ('complete','truncated')`) against the number of rows actually
   * indexed in `summaries_fts`. For the *index* count we read the `summaries_fts_docsize`
   * shadow table, NOT `select count(*) from summaries_fts`: on an external-content table
   * the latter counts through to the `summaries` content table (so it can't reveal an
   * un-indexed row), whereas `_docsize` holds exactly one row per indexed docid and so
   * reflects the true index population. Every summary is inserted `complete`/`truncated`
   * and the insert trigger indexes it, so in steady state the two counts are equal; they
   * diverge only when a trigger gap (or a pre-existing/partially-built DB) left rows
   * un-indexed — exactly when a rebuild is warranted. Any divergence (including the
   * never-written `superseded` case, which would leave a stale FTS row) errs toward
   * rebuilding, i.e. correctness over cost. If the `_docsize` probe ever fails we fall
   * back to an unconditional rebuild rather than risk a stale index.
   */
  reconcileSummariesFts(): Promise<void> {
    return this.write((db) => {
      let needsRebuild = true;
      try {
        const searchable = (
          db
            .prepare(
              `select count(*) as n from summaries where status in ('complete', 'truncated')`,
            )
            .get() as { n: number }
        ).n;
        const indexed = (
          db.prepare(`select count(*) as n from summaries_fts_docsize`).get() as { n: number }
        ).n;
        needsRebuild = searchable !== indexed;
      } catch {
        // _docsize unavailable / probe failed → rebuild unconditionally (correctness over cost).
        needsRebuild = true;
      }
      if (needsRebuild) {
        db.prepare(`insert into summaries_fts(summaries_fts) values ('rebuild')`).run();
      }
    });
  }

  /**
   * A sender's message timestamps (descending), for absence-gap detection in `recap`
   * / `search_messages` since_user_absence (§9e). Reads the chat index (which carries
   * the (sender_id, timestamp) index); callers run `ensureFreshForQuery` first so a
   * just-arrived "what did I miss" message is already present. `timelineKeys` scopes to
   * a room set (undefined = all rooms); `sinceTs` bounds the lookback horizon.
   */
  getChatSenderTimestamps(opts: {
    senderId: string;
    timelineKeys?: string[];
    sinceTs?: number;
    limit?: number;
  }): number[] {
    return this.read((db) => {
      const where: string[] = ["sender_id = @senderId"];
      const params: Record<string, unknown> = {
        senderId: opts.senderId,
        limit: opts.limit ?? 5000,
      };
      if (opts.timelineKeys && opts.timelineKeys.length > 0) {
        const keys = opts.timelineKeys.map((k, i) => {
          params[`tk${i}`] = k;
          return `@tk${i}`;
        });
        where.push(`timeline_key in (${keys.join(", ")})`);
      }
      if (opts.sinceTs !== undefined) {
        where.push("timestamp >= @sinceTs");
        params.sinceTs = opts.sinceTs;
      }
      const rows = db
        .prepare(
          `select timestamp from chat_index where ${where.join(" and ")}
           order by timestamp desc limit @limit`,
        )
        .all(params) as Array<{ timestamp: number }>;
      return rows.map((r) => r.timestamp);
    });
  }

  /**
   * Per-(sender, room) message-activity aggregates over a window, for the
   * `user_activity` tool (§9e) — the admin's inactive-user view. With `senderId`,
   * scopes to one user; otherwise returns every sender (the tool aggregates into a
   * roster). Counts/first/last come straight off the (sender_id, timestamp) index.
   */
  aggregateChatActivity(opts: {
    senderId?: string;
    timelineKeys?: string[];
    sinceTs?: number;
    untilTs?: number;
    filter?: ChatTypeFilter;
  }): Array<{ senderId: string; timelineKey: string; count: number; firstAt: number; lastAt: number }> {
    return this.read((db) => {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (opts.senderId !== undefined) {
        where.push("sender_id = @senderId");
        params.senderId = opts.senderId;
      }
      if (opts.timelineKeys && opts.timelineKeys.length > 0) {
        const keys = opts.timelineKeys.map((k, i) => {
          params[`tk${i}`] = k;
          return `@tk${i}`;
        });
        where.push(`timeline_key in (${keys.join(", ")})`);
      }
      if (opts.sinceTs !== undefined) {
        where.push("timestamp >= @sinceTs");
        params.sinceTs = opts.sinceTs;
      }
      if (opts.untilTs !== undefined) {
        where.push("timestamp < @untilTs");
        params.untilTs = opts.untilTs;
      }
      where.push(...chatTypeFilterClauses(opts.filter, params));
      const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
      return db
        .prepare(
          `select sender_id as senderId, timeline_key as timelineKey, count(*) as count,
                  min(timestamp) as firstAt, max(timestamp) as lastAt
           from chat_index ${whereSql}
           group by sender_id, timeline_key
           order by sender_id asc, timeline_key asc`,
        )
        .all(params) as Array<{
        senderId: string;
        timelineKey: string;
        count: number;
        firstAt: number;
        lastAt: number;
      }>;
    });
  }

  /**
   * Bounded roster for the all-users `user_activity` view (§9e, review #6). Ranking is by
   * **total messages across all rooms** per sender, so a naive `LIMIT` on the per-(sender,
   * room) rows would be wrong (it could cut mid-sender or drop a top sender's room). Instead
   * this pushes the bound into SQL correctly in two passes over the same window:
   *   1. rank senders by their global total (`group by sender_id`), take the top `limit`;
   *   2. fetch the per-(sender, room) breakdown only for those sender ids.
   * Also returns `totalSenders` — the count of senders matching the window (and the
   * `maxMessages` threshold when set) — so the tool's "(+N more)" overflow line can report
   * the true sender count without materializing every group. The per-room rows for one sender
   * are contiguous; the tool aggregates them.
   *
   * `order` ranks senders by global total: `"most"` (default) for the most-active view,
   * `"least"` for the inactive view (least-active first). `maxMessages` keeps only senders
   * whose total is `<= maxMessages` (the "who's gone quiet below N" threshold). Both bound
   * the *posting* roster; users who never posted have no `chat_index` row and are surfaced
   * separately by the tool's `include_silent` membership union (§9e).
   */
  topChatActivity(opts: {
    timelineKeys?: string[];
    sinceTs?: number;
    untilTs?: number;
    limit: number;
    order?: "most" | "least";
    maxMessages?: number;
    filter?: ChatTypeFilter;
  }): {
    rows: Array<{ senderId: string; timelineKey: string; count: number; firstAt: number; lastAt: number }>;
    totalSenders: number;
  } {
    return this.read((db) => {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (opts.timelineKeys && opts.timelineKeys.length > 0) {
        const keys = opts.timelineKeys.map((k, i) => {
          params[`tk${i}`] = k;
          return `@tk${i}`;
        });
        where.push(`timeline_key in (${keys.join(", ")})`);
      }
      if (opts.sinceTs !== undefined) {
        where.push("timestamp >= @sinceTs");
        params.sinceTs = opts.sinceTs;
      }
      if (opts.untilTs !== undefined) {
        where.push("timestamp < @untilTs");
        params.untilTs = opts.untilTs;
      }
      where.push(...chatTypeFilterClauses(opts.filter, params));
      const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
      const dir = opts.order === "least" ? "asc" : "desc";
      const havingSql = opts.maxMessages !== undefined ? "having count(*) <= @maxMessages" : "";

      // totalSenders honours the maxMessages threshold (so "(+N more)" counts only senders
      // that pass the filter). Without it, a cheap count(distinct) suffices.
      const totalSenders =
        opts.maxMessages !== undefined
          ? (
              db
                .prepare(
                  `select count(*) as n from (
                     select sender_id from chat_index ${whereSql}
                     group by sender_id ${havingSql})`,
                )
                .get({ ...params, maxMessages: opts.maxMessages }) as { n: number }
            ).n
          : (
              db
                .prepare(`select count(distinct sender_id) as n from chat_index ${whereSql}`)
                .get(params) as { n: number }
            ).n;

      // Pass 1: the limit-N senders by global total across rooms, ranked per `order`.
      const pass1Params: Record<string, unknown> = { ...params, limit: opts.limit };
      if (opts.maxMessages !== undefined) pass1Params.maxMessages = opts.maxMessages;
      const top = db
        .prepare(
          `select sender_id as senderId from chat_index ${whereSql}
           group by sender_id ${havingSql}
           order by count(*) ${dir}, sender_id asc
           limit @limit`,
        )
        .all(pass1Params) as Array<{ senderId: string }>;
      if (top.length === 0) return { rows: [], totalSenders };

      // Pass 2: per-room breakdown for exactly those senders.
      const senderParams: Record<string, unknown> = { ...params };
      const senderPlaceholders = top.map((s, i) => {
        senderParams[`sid${i}`] = s.senderId;
        return `@sid${i}`;
      });
      const detailWhere = [...where, `sender_id in (${senderPlaceholders.join(", ")})`];
      const rows = db
        .prepare(
          `select sender_id as senderId, timeline_key as timelineKey, count(*) as count,
                  min(timestamp) as firstAt, max(timestamp) as lastAt
           from chat_index where ${detailWhere.join(" and ")}
           group by sender_id, timeline_key
           order by sender_id asc, timeline_key asc`,
        )
        .all(senderParams) as Array<{
        senderId: string;
        timelineKey: string;
        count: number;
        firstAt: number;
        lastAt: number;
      }>;
      return { rows, totalSenders };
    });
  }

  /**
   * Scope-wide totals for a window — the denominator and actual data span behind a
   * `user_activity` report (§9e). The `total*`/`first*`/`last*` fields honour the optional
   * type `filter` (so "% of total" and the considered span describe the *matching* subset),
   * while `corpusFirstAt`/`corpusLastAt` ignore the type filter and report the span of the
   * underlying corpus in the same room/window scope. That split keeps the coverage footnote
   * honest: "30d requested, only 3d on record" is a property of the corpus, so filtering to
   * (say) images must NOT make the warning fire just because images are recent. All `*At`
   * fields are null when their respective set is empty.
   */
  chatActivityScope(opts: {
    timelineKeys?: string[];
    sinceTs?: number;
    untilTs?: number;
    filter?: ChatTypeFilter;
  }): {
    totalMessages: number;
    distinctSenders: number;
    firstAt: number | null;
    lastAt: number | null;
    corpusFirstAt: number | null;
    corpusLastAt: number | null;
  } {
    return this.read((db) => {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (opts.timelineKeys && opts.timelineKeys.length > 0) {
        const keys = opts.timelineKeys.map((k, i) => {
          params[`tk${i}`] = k;
          return `@tk${i}`;
        });
        where.push(`timeline_key in (${keys.join(", ")})`);
      }
      if (opts.sinceTs !== undefined) {
        where.push("timestamp >= @sinceTs");
        params.sinceTs = opts.sinceTs;
      }
      if (opts.untilTs !== undefined) {
        where.push("timestamp < @untilTs");
        params.untilTs = opts.untilTs;
      }
      const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
      // The type filter lives INSIDE conditional aggregates rather than the WHERE, so the
      // same single pass yields both the filtered totals and the unfiltered corpus span.
      const typeClauses = chatTypeFilterClauses(opts.filter, params);
      const match = typeClauses.length > 0 ? typeClauses.join(" and ") : "1";
      return db
        .prepare(
          `select coalesce(sum(case when ${match} then 1 else 0 end), 0) as totalMessages,
                  count(distinct case when ${match} then sender_id end) as distinctSenders,
                  min(case when ${match} then timestamp end) as firstAt,
                  max(case when ${match} then timestamp end) as lastAt,
                  min(timestamp) as corpusFirstAt,
                  max(timestamp) as corpusLastAt
           from chat_index ${whereSql}`,
        )
        .get(params) as {
        totalMessages: number;
        distinctSenders: number;
        firstAt: number | null;
        lastAt: number | null;
        corpusFirstAt: number | null;
        corpusLastAt: number | null;
      };
    });
  }

  // ── Embedding queue (the `embed_status` column IS the queue, §7) ───
  // Mirrors the enrichment/caption/diary worker idiom: poll 'pending' → CAS-claim a
  // batch to 'processing' (attempts++) → embed → 'done' (or 'failed'/'skip').

  /** Claim up to `limit` pending chunks for embedding (CAS pending→processing). */
  claimPendingEmbedChunks(limit: number): Promise<
    Array<{
      rowid: number;
      id: string;
      contentHash: string;
      text: string;
      source: string;
      /** Attempt count AFTER this claim's increment. */
      attempts: number;
    }>
  > {
    return this.readAndWrite((db) => {
      const rows = db
        .prepare(
          `select rowid, id, content_hash as contentHash, text, source, embed_attempts as attempts
           from memory_chunks where embed_status = 'pending'
           order by indexed_at asc limit ?`,
        )
        .all(limit) as Array<{
        rowid: number;
        id: string;
        contentHash: string;
        text: string;
        source: string;
        attempts: number;
      }>;
      if (rows.length === 0) return [];
      const claim = db.prepare(
        `update memory_chunks set embed_status = 'processing', embed_attempts = embed_attempts + 1
         where rowid = ? and embed_status = 'pending'`,
      );
      return rows
        .filter((r) => claim.run(r.rowid).changes > 0)
        .map((r) => ({ ...r, attempts: r.attempts + 1 }));
    });
  }

  /** Reset stale 'processing' embed claims to 'pending' on startup (§7). */
  resetStaleEmbedding(): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(`update memory_chunks set embed_status = 'pending' where embed_status = 'processing'`)
          .run().changes,
    );
  }

  /**
   * Delete `memory_vec` rows whose `chunk_id` no longer has a `memory_chunks` row
   * (#8). A chunk deleted by reconcile *after* `pruneVectors` but *before* the embed
   * worker's `upsert` leaves an orphan vector with no owning chunk — harmless to
   * correctness (search filters unmatched KNN hits) but an unbounded space leak.
   * Run at startup alongside `resetStaleEmbedding`. No-op (returns 0) if `memory_vec`
   * doesn't exist yet (lexical-only / semantic half never came up).
   */
  sweepOrphanVectors(): Promise<number> {
    return this.write((db) => {
      const exists =
        (
          db
            .prepare(
              `select count(*) as n from sqlite_master where type = 'table' and name = 'memory_vec'`,
            )
            .get() as { n: number }
        ).n > 0;
      if (!exists) return 0;
      return db
        .prepare(
          `delete from memory_vec
           where chunk_id not in (select rowid from memory_chunks)`,
        )
        .run().changes;
    });
  }

  /** Mark a chunk embedded: status='done', record the model it was embedded with. */
  setEmbedDone(rowid: number, modelId: string): Promise<void> {
    return this.write((db) => {
      db.prepare(`update memory_chunks set embed_status = 'done', model_id = ? where rowid = ?`).run(
        modelId,
        rowid,
      );
    });
  }

  /**
   * Set a chunk's embed status (failed-retry → 'pending', exhausted → 'failed', or
   * 'skip' when embeddings are disabled). `maxRetries` chooses pending vs failed.
   */
  setEmbedFailed(rowid: number, attempts: number, maxRetries: number): Promise<void> {
    const status = attempts > maxRetries ? "failed" : "pending";
    return this.write((db) => {
      db.prepare(`update memory_chunks set embed_status = ? where rowid = ?`).run(status, rowid);
    });
  }

  /** Mark chunks 'skip' (embeddings intentionally off — lexical-only chunk, §6). */
  skipPendingEmbedding(): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(`update memory_chunks set embed_status = 'skip' where embed_status = 'pending'`)
          .run().changes,
    );
  }

  /**
   * Invalidate the vector index for a model switch (§5a): every embedded/failed/skip
   * chunk goes back to 'pending' and loses its `model_id`, so the worker re-embeds
   * with the new active model. The lexical index is untouched. Returns the count.
   */
  resetAllEmbeddings(): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(
            `update memory_chunks set embed_status = 'pending', model_id = null
             where embed_status in ('done', 'failed', 'skip')`,
          )
          .run().changes,
    );
  }

  /** Count chunks still awaiting embedding (for worker idle detection / logs). */
  countPendingEmbedding(): number {
    return this.read(
      (db) =>
        (
          db
            .prepare(`select count(*) as n from memory_chunks where embed_status = 'pending'`)
            .get() as { n: number }
        ).n,
    );
  }

  /** Document-embedding cache lookup (§5e): identical text+model never re-embeds. */
  getCachedEmbedding(textHash: string, modelId: string): Buffer | undefined {
    return this.read((db) => {
      const row = db
        .prepare(`select embedding from embedding_cache where text_hash = ? and model_id = ?`)
        .get(textHash, modelId) as { embedding: Buffer } | undefined;
      return row?.embedding;
    });
  }

  /** Store a document embedding in the cache (§5e). */
  putCachedEmbedding(textHash: string, modelId: string, embedding: Buffer): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into embedding_cache (text_hash, model_id, embedding) values (?, ?, ?)
         on conflict(text_hash, model_id) do update set embedding = excluded.embedding`,
      ).run(textHash, modelId, embedding);
    });
  }

  // ── Agent sessions (durable session record) ───────────────────────
  // Spec §3–§5: a session's durable record is the frozen context prefix
  // (snapshot, written once) plus its transcript (rewritten atomically at each
  // turn boundary). The snapshot and transcript live in separate columns so the
  // large immutable prefix is NOT re-serialized through the single-writer queue
  // on every cheap transcript flush.

  /** Insert the initial `agent_sessions` placeholder row (spec §5, status='created'). */
  insertAgentSession(row: AgentSessionInsert): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into agent_sessions (
          id, timeline_key, session_type, status, model_id,
          trigger_event_id, trigger_external_id, trigger_body,
          trigger_sender_id, trigger_sender_display_name,
          chat_upper_bound_ts,
          no_reply, created_at, started_at, updated_at
        ) values (
          @id, @timelineKey, @sessionType, @status, @modelId,
          @triggerEventId, @triggerExternalId, @triggerBody,
          @triggerSenderId, @triggerSenderDisplayName,
          @chatUpperBoundTs,
          0, @createdAt, @startedAt, @updatedAt
        )`,
      ).run({
        id: row.id,
        timelineKey: row.timelineKey,
        sessionType: row.sessionType,
        status: row.status,
        modelId: row.modelId ?? null,
        triggerEventId: row.triggerEventId ?? null,
        triggerExternalId: row.triggerExternalId ?? null,
        triggerBody: row.triggerBody ?? null,
        triggerSenderId: row.triggerSenderId ?? null,
        triggerSenderDisplayName: row.triggerSenderDisplayName ?? null,
        chatUpperBoundTs: row.chatUpperBoundTs ?? null,
        createdAt: row.createdAt,
        startedAt: row.startedAt ?? null,
        updatedAt: row.updatedAt,
      });
    });
  }

  /**
   * Accept a reply-resume of a COMPLETED session (spec RESUMABLE-SESSIONS §6):
   * atomically flip `completed → resuming` AND increment `resume_generation` in a
   * single CAS, returning the new generation, or `undefined` when the row is no
   * longer `completed` (already resumed by a racing reply, or never completed).
   *
   * The `where status = 'completed'` guard is the durable single-consumption
   * point: only the first accepted resume of a given state mutates the row, so the
   * prior run's outputs (tagged with the pre-bump generation on their
   * `timeline_events` rows) become stale forever and the same state can never be
   * continued twice. The in-memory fork guard (app.ts) is the synchronous
   * first-line defense; this CAS is the authoritative, cross-restart backstop.
   * Status moves through `resuming` exactly as the manual/failure resume path,
   * so `markRunning`/`markCompleted` drive the rest of the lifecycle unchanged.
   */
  acceptResumeGeneration(sessionId: string): Promise<number | undefined> {
    return this.readAndWrite((db) => {
      const now = Date.now();
      const result = db
        .prepare(
          `update agent_sessions
             set status = 'resuming',
                 resume_generation = resume_generation + 1,
                 updated_at = @now
           where id = @id and status = 'completed'`,
        )
        .run({ id: sessionId, now });
      if (result.changes === 0) return undefined;
      const row = db
        .prepare(`select resume_generation from agent_sessions where id = ?`)
        .get(sessionId) as { resume_generation: number } | undefined;
      return row?.resume_generation;
    });
  }

  /**
   * Record a user interjection injected into a running session (ARCHITECTURE.md
   * §8/§11). Fire-and-forget on the single-writer queue, written at the steer site
   * after a successful inject; the `_ai` trigger maintains `session_interjections_fts`
   * so the session becomes reachable by the interjection's text. Cascades with the
   * parent session row.
   */
  insertSessionInterjection(row: SessionInterjectionInsert): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert into session_interjections (
          session_id, event_id, external_id, sender_id, sender_display_name,
          kind, body, created_at
        ) values (
          @sessionId, @eventId, @externalId, @senderId, @senderDisplayName,
          @kind, @body, @createdAt
        )`,
      ).run({
        sessionId: row.sessionId,
        eventId: row.eventId ?? null,
        externalId: row.externalId ?? null,
        senderId: row.senderId ?? null,
        senderDisplayName: row.senderDisplayName ?? null,
        kind: row.kind,
        body: row.body,
        createdAt: row.createdAt,
      });
    });
  }

  /**
   * Surface a no-op `agent_sessions` write. The session save/update methods all
   * target `where id = @id`; if that id does not exist the UPDATE silently
   * affects zero rows and the caller is none the wiser. A zero-change write here
   * means a wiring bug (the placeholder insert failed, or the row was deleted)
   * is losing snapshot/transcript/status data. We log a structured warning so
   * the no-op is visible, but deliberately do NOT throw: these run on the
   * fire-and-forget flush path (single-writer queue), and throwing could
   * destabilize it or reject unrelated queued writes.
   */
  private warnIfNoSessionRow(method: string, id: string, changes: number): void {
    if (changes === 0 && this.logger) {
      this.logger.warn(`${method}: no agent_sessions row matched id`, {
        method,
        sessionId: id,
      });
    }
  }

  /**
   * Update a session's status and any of the lifecycle timestamps/flags. Only
   * the fields provided in `opts` are written; `updated_at` is always bumped
   * (defaulting to now). Mirrors `markRunning/markCompleted/markDiscarded` from
   * spec §5.
   *
   * `started_at`/`completed_at` are forward-only (write-once in practice): the
   * lifecycle sets each exactly once (`markRunning`, `markCompleted`/
   * `markDiscarded`), and callers never rewind them. This is intentional — the
   * timestamps record when the session first entered each phase.
   */
  updateAgentSessionStatus(
    id: string,
    status: AgentSessionStatus,
    opts: {
      startedAt?: number;
      completedAt?: number;
      noReply?: boolean;
      error?: string | null;
      updatedAt?: number;
    } = {},
  ): Promise<void> {
    return this.write((db) => {
      const sets: string[] = ["status = @status", "updated_at = @updatedAt"];
      const params: Record<string, unknown> = {
        id,
        status,
        updatedAt: opts.updatedAt ?? Date.now(),
      };
      if (opts.startedAt !== undefined) {
        sets.push("started_at = @startedAt");
        params.startedAt = opts.startedAt;
      }
      if (opts.completedAt !== undefined) {
        sets.push("completed_at = @completedAt");
        params.completedAt = opts.completedAt;
      }
      if (opts.noReply !== undefined) {
        sets.push("no_reply = @noReply");
        params.noReply = opts.noReply ? 1 : 0;
      }
      if (opts.error !== undefined) {
        sets.push("error = @error");
        params.error = opts.error;
      }
      const result = db
        .prepare(`update agent_sessions set ${sets.join(", ")} where id = @id`)
        .run(params);
      this.warnIfNoSessionRow("updateAgentSessionStatus", id, result.changes);
    });
  }

  /**
   * Persist the frozen context snapshot for a session (spec §3). Written ONCE,
   * when the build completes at session creation: the snapshot prefix, its
   * on-disk dump path, and the snapshot token estimate.
   */
  saveAgentSessionSnapshot(
    id: string,
    snapshot: {
      snapshotJson: string;
      dumpPath: string | null;
      tokenEstimate: number | null;
      updatedAt?: number;
    },
  ): Promise<void> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set
            context_snapshot_json = @snapshotJson,
            context_dump_path = @dumpPath,
            token_estimate = @tokenEstimate,
            updated_at = @updatedAt
           where id = @id`,
        )
        .run({
          id,
          snapshotJson: snapshot.snapshotJson,
          dumpPath: snapshot.dumpPath ?? null,
          tokenEstimate: snapshot.tokenEstimate ?? null,
          updatedAt: snapshot.updatedAt ?? Date.now(),
        });
      this.warnIfNoSessionRow("saveAgentSessionSnapshot", id, result.changes);
    });
  }

  /**
   * Flush the session transcript (spec §3). Cheap, repeated at each turn
   * boundary — it touches ONLY `transcript_json` + `updated_at` and never
   * re-serializes the large immutable snapshot columns.
   */
  saveAgentSessionTranscript(
    id: string,
    transcriptJson: string,
    updatedAt?: number,
  ): Promise<void> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set transcript_json = @transcriptJson, updated_at = @updatedAt
           where id = @id`,
        )
        .run({
          id,
          transcriptJson,
          updatedAt: updatedAt ?? Date.now(),
        });
      this.warnIfNoSessionRow("saveAgentSessionTranscript", id, result.changes);
    });
  }

  /**
   * Persist the session-level usage aggregate (spec TOKEN-USAGE-TRACKING §4.2).
   * Enqueued once per committed request via `attachSessionCapture`'s tracker
   * subscription — sessions make single-digit-to-low-tens of requests, so one
   * write per commit is negligible (no debounce needed). Touches the usage
   * columns, `model_id` (the actually-billed model, via `coalesce` so a null
   * arg never clobbers a recorded model), + `updated_at`; the large immutable
   * snapshot/transcript columns are untouched. `contextTokens` may be null (no
   * request committed yet) and is written through as such.
   */
  updateAgentSessionUsage(
    id: string,
    totals: SessionUsageTotals,
    modelId?: string | null,
  ): Promise<void> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set
            model_id = coalesce(@modelId, model_id),
            llm_requests = @llmRequests,
            usage_input_tokens = @inputTokens,
            usage_output_tokens = @outputTokens,
            usage_cache_read_tokens = @cacheReadTokens,
            usage_cache_write_tokens = @cacheWriteTokens,
            usage_cost = @cost,
            context_tokens = @contextTokens,
            updated_at = @updatedAt
           where id = @id`,
        )
        .run({
          id,
          modelId: modelId ?? null,
          llmRequests: totals.llmRequests,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
          cost: totals.cost,
          contextTokens: totals.contextTokens ?? null,
          updatedAt: Date.now(),
        });
      this.warnIfNoSessionRow("updateAgentSessionUsage", id, result.changes);
    });
  }

  /**
   * Startup healing (spec §4): flip any session left mid-flight (`running` or
   * `created`) to `interrupted`, before the provider delivers events. No
   * auto-resume — but an `interrupted` row with viable resume material stays
   * MANUALLY resumable from the console (Decision D; the resume endpoint
   * accepts `failed-resumable` and `interrupted` alike). A session that died
   * while `resuming` (mid auto-resume) is healed to `failed-resumable` instead
   * — its snapshot + transcript are intact, so it too stays manually resumable
   * (spec CONCURRENCY-AND-RATE-LIMITING §6.2). Mirrors
   * `resetStaleActivations`/`resetStaleSummarizationJobs`. Returns the number of
   * rows healed.
   */
  resetStaleSessions(): Promise<number> {
    return this.write((db) => {
      const now = Date.now();
      const interrupted = db
        .prepare(
          `update agent_sessions set status = 'interrupted', updated_at = ?
           where status in ('running', 'created')`,
        )
        .run(now);
      const parked = db
        .prepare(
          `update agent_sessions set status = 'failed-resumable', updated_at = ?
           where status = 'resuming'`,
        )
        .run(now);
      return interrupted.changes + parked.changes;
    });
  }

  /** Read a single session record by id (spec §4), or undefined if absent. */
  getAgentSession(id: string): AgentSessionRow | undefined {
    return this.read((db) =>
      db.prepare(`select * from agent_sessions where id = ?`).get(id) as
        | AgentSessionRow
        | undefined,
    );
  }

  /**
   * Advance a session's gap-backfill lower bound (spec RESUMABLE-SESSIONS §9.2) to
   * `ts` — the latest member of the trigger group that just resumed it (== that
   * trigger's timestamp). Called on each accepted reply-resume AFTER the gap is
   * built from the prior bound, so the NEXT resume's gap starts where this one
   * ends. Single-writer write; mirrors `updateAgentSessionStatus`/`markRunning`.
   */
  setSessionChatUpperBound(id: string, ts: number): Promise<void> {
    return this.write((db) => {
      const result = db
        .prepare(
          `update agent_sessions set chat_upper_bound_ts = @ts, updated_at = @updatedAt where id = @id`,
        )
        .run({ id, ts, updatedAt: Date.now() });
      this.warnIfNoSessionRow("setSessionChatUpperBound", id, result.changes);
    });
  }

  /**
   * Sessions for a room, reverse-chron by creation (spec §8,
   * `GET /api/rooms/:key/sessions`). Matches the room key AND its thread
   * sub-timelines (`<roomKey>:thread:%`), so the room subsumes its threads exactly
   * as `listConsoleRooms` aggregates them — a session that landed on a thread
   * timeline stays reachable from its room. Read-only.
   */
  getAgentSessionsByTimeline(timelineKey: string, limit = 100): AgentSessionMetaRow[] {
    return this.read((db) =>
      db
        .prepare(
          `select ${AGENT_SESSION_META_COLUMNS} from agent_sessions
           where timeline_key = @key or timeline_key like @threadPrefix escape '\\'
           order by created_at desc
           limit @limit`,
        )
        .all({
          key: timelineKey,
          threadPrefix: threadKeyLikePattern(timelineKey),
          limit,
        }) as AgentSessionMetaRow[],
    );
  }

  /**
   * Filtered/searched sessions for a timeline, reverse-chron by creation (console
   * sessions filter, ARCHITECTURE.md §11). All filters are AND-combined; within a
   * category (`statuses`, `sessionTypes`) the values are OR'd via `in (...)`.
   * `triggerMatch` is an already-sanitized, column-agnostic FTS5 MATCH expression
   * (built by `sanitizeTriggerFtsMatch` in the handler, mirroring `searchChatIndex`'s
   * match-agnostic contract). When present, a session matches if the text hits its
   * **trigger** body (`agent_sessions_fts`) **OR** any of its **interjection** bodies
   * (`session_interjections_fts`) — both are user messages the session acted on, so the
   * "timeline message → session" debug path finds the session by either (§8/§11). The
   * two are OR'd via subqueries (not a JOIN) so a session is returned once regardless of
   * how many interjections match. With no filters this degenerates to the same result
   * as `getAgentSessionsByTimeline`. Read-only.
   */
  searchAgentSessionsByTimeline(
    timelineKey: string,
    opts: {
      triggerMatch?: string;
      statuses?: AgentSessionStatus[];
      sessionTypes?: string[];
      limit?: number;
    } = {},
  ): AgentSessionMetaRow[] {
    const limit = opts.limit ?? 100;
    return this.read((db) => {
      // Room + its thread sub-timelines, matching `getAgentSessionsByTimeline`.
      const where: string[] = [
        "(s.timeline_key = @timelineKey or s.timeline_key like @threadPrefix escape '\\')",
      ];
      const params: Record<string, unknown> = {
        timelineKey,
        threadPrefix: threadKeyLikePattern(timelineKey),
        limit,
      };
      if (opts.triggerMatch) {
        params.ftsMatch = opts.triggerMatch;
        where.push(
          `(s.rowid in (select rowid from agent_sessions_fts where agent_sessions_fts match @ftsMatch)
            or exists (
              select 1 from session_interjections si
              where si.session_id = s.id
                and si.rowid in (
                  select rowid from session_interjections_fts
                  where session_interjections_fts match @ftsMatch
                )
            ))`,
        );
      }
      const inClause = (col: string, values: string[], prefix: string): void => {
        const keys = values.map((v, i) => {
          params[`${prefix}${i}`] = v;
          return `@${prefix}${i}`;
        });
        where.push(`${col} in (${keys.join(", ")})`);
      };
      if (opts.statuses && opts.statuses.length > 0) {
        inClause("s.status", opts.statuses, "st");
      }
      if (opts.sessionTypes && opts.sessionTypes.length > 0) {
        inClause("s.session_type", opts.sessionTypes, "ty");
      }
      return db
        .prepare(
          `select ${AGENT_SESSION_META_COLUMNS_ALIASED} from agent_sessions s
           where ${where.join(" and ")}
           order by s.created_at desc
           limit @limit`,
        )
        .all(params) as AgentSessionMetaRow[];
    });
  }

  /**
   * Distinct `session_type` values present for a timeline (console sessions filter,
   * ARCHITECTURE.md §11). Backs the type-filter options — statuses are a fixed enum
   * the UI knows, but session types are open-ended, so the filter offers exactly the
   * types that actually occur in this room. Ordered for a stable menu. Read-only.
   */
  getAgentSessionTimelineFacets(timelineKey: string): { types: string[] } {
    return this.read((db) => {
      // Room + its thread sub-timelines, matching the sessions drill-down so the
      // type menu offers exactly the types the listed sessions can have.
      const rows = db
        .prepare(
          `select distinct session_type from agent_sessions
           where timeline_key = @key or timeline_key like @threadPrefix escape '\\'
           order by session_type`,
        )
        .all({ key: timelineKey, threadPrefix: threadKeyLikePattern(timelineKey) }) as Array<{
        session_type: string;
      }>;
      return { types: rows.map((r) => r.session_type) };
    });
  }

  /**
   * Count `agent_sessions` rows for a timeline of a given session type created
   * at/after `since` (ARCHITECTURE.md §9g). Backs the proactive scheduler's
   * derived daily budget: because the placeholder row is inserted at session
   * start and persists regardless of outcome, this count includes sent AND
   * `NO_REPLY` (and even crash-discarded) proactive sessions with no extra state.
   * Read-only. The `idx_agent_sessions_timeline(timeline_key, created_at)` index
   * covers the timeline+time predicate; session_type is filtered in-row (the
   * per-tick frequency is far too low to warrant a dedicated index).
   */
  countSessionsByType(timelineKey: string, sessionType: string, since: number): number {
    return this.read((db) => {
      const row = db
        .prepare(
          `select count(*) as n from agent_sessions
           where timeline_key = ? and session_type = ? and created_at >= ?`,
        )
        .get(timelineKey, sessionType, since) as { n: number };
      return row.n;
    });
  }

  /**
   * One row per ROOM for the console room list (spec §8, `GET /api/rooms`),
   * reverse-chron by latest activity. The anchor set is the UNION of timelines
   * that have `timeline_events` OR have `agent_sessions` rows (issue #6): a
   * timeline whose events were pruned (§13 delete-events / retention sweep) but
   * whose sessions persist must still appear so its sessions stay reachable via
   * room→session drill-down.
   *
   * Thread sub-timelines (`<roomKey>:thread:<root>`) are first-class timelines
   * with their own context/summarization (matrix/inbound.ts), but they resolve to
   * their parent room's label and would otherwise list as indistinguishable
   * duplicate "rooms". So each anchor is mapped to its canonical room key (the
   * `:thread:<root>` suffix stripped) and the union is **grouped by room**: one row
   * per room, with `event_count`/`session_count` summed and `last_activity_at`
   * maxed across the room and all its threads. The room→session drill-down
   * (`getAgentSessionsByTimeline` &c.) matches the same room+threads set, so the
   * aggregated count stays consistent and thread sessions remain reachable.
   * `display_name`/`timeline_state` come from the room key itself. `last_activity_at`
   * per timeline is its max event timestamp, falling back to the latest session
   * activity (`max(created_at, updated_at)`) when no events survive, so reverse-chron
   * ordering stays sensible. Pure read.
   */
  listConsoleRooms(limit = 500): RoomSummaryRow[] {
    return this.read((db) =>
      db
        .prepare(
          `with anchors as (
             select timeline_key from timeline_events
             union
             select timeline_key from agent_sessions
           ),
           mapped as (
             select
               -- Canonical room key: strip a :thread:<root> suffix so a room and its
               -- threads collapse to one row. ':thread:' only ever appears as the
               -- live-inserted separator (matrix/inbound.ts), never inside a room id.
               case when anchors.timeline_key like '%:thread:%'
                    then substr(anchors.timeline_key, 1,
                                instr(anchors.timeline_key, ':thread:') - 1)
                    else anchors.timeline_key end as room_key,
               (select count(*) from timeline_events te
                  where te.timeline_key = anchors.timeline_key) as event_count,
               (select count(*) from agent_sessions s
                  where s.timeline_key = anchors.timeline_key) as session_count,
               coalesce(
                 (select max(te.timestamp) from timeline_events te
                    where te.timeline_key = anchors.timeline_key),
                 (select max(max(s.created_at, s.updated_at)) from agent_sessions s
                    where s.timeline_key = anchors.timeline_key),
                 0
               ) as last_activity_at
             from anchors
           ),
           rooms as (
             select room_key,
                    max(last_activity_at) as last_activity_at,
                    sum(event_count) as event_count,
                    sum(session_count) as session_count
             from mapped
             group by room_key
           )
           select
             rooms.room_key as timeline_key,
             coalesce(
               (select m.display_name from room_metadata m
                 where m.timeline_key = rooms.room_key),
               rooms.room_key
             ) as display_name,
             coalesce(
               (select c.timeline_state from timeline_compaction_state c
                 where c.timeline_key = rooms.room_key),
               'inactive'
             ) as timeline_state,
             rooms.last_activity_at as last_activity_at,
             rooms.event_count as event_count,
             rooms.session_count as session_count
           from rooms
           order by last_activity_at desc
           limit ?`,
        )
        .all(limit) as RoomSummaryRow[],
    );
  }

  /**
   * Backing data for a summary (spec §12 detail column): the raw timeline events
   * it covers (`summary_events`, ordered) and the child summaries it condenses
   * (`summary_parents`, ordered). Returns both arrays; one is typically empty
   * depending on the summary's level. Pure read.
   */
  getSummaryLineage(id: string): SummaryLineage {
    return this.read((db) => {
      const eventRows = db
        .prepare(
          `select te.event_json as event_json
             from summary_events se
             join timeline_events te on te.id = se.event_id
            where se.summary_id = ?
            order by se.ordinal asc`,
        )
        .all(id) as Array<{ event_json: string }>;
      const childRows = db
        .prepare(
          `select s.* from summary_parents sp
             join summaries s on s.id = sp.parent_id
            where sp.summary_id = ?
            order by sp.ordinal asc`,
        )
        .all(id) as SummaryRow[];
      return {
        events: eventRows.map((row) => JSON.parse(row.event_json) as CanonicalChatEvent),
        children: childRows.map(mapSummaryRow),
      };
    });
  }

  /**
   * A single media asset by its id (= `${eventId}:attach:${index}`, which is
   * also the `attachmentId` carried in externalized image refs — see
   * `mediaAssetToAttachmentMeta`). Backs `GET /api/media/:ref`. Pure read.
   */
  getMediaAssetById(id: string): MediaAssetRow | undefined {
    return this.read((db) =>
      db.prepare(`select * from media_assets where id = ?`).get(id) as
        | MediaAssetRow
        | undefined,
    );
  }

  // ── Pipeline monitor reads (ARCHITECTURE.md §11) ──────────────────────────

  /**
   * Status-bucket counts for a pipeline's full history (the `/api/pipelines`
   * dashboard feed). DB-derived (the single source of truth that survives
   * restart). Raw statuses normalize into the six {@link PipelineCounts} buckets;
   * a `pending` row with `attempts > 0` is `retrying` (no explicit state exists).
   * Pure read.
   */
  getPipelineCounts(pool: PipelineId, eligibility?: CaptionEligibility): PipelineCounts {
    const spec = PIPELINE_COUNT_SPECS[pool];
    const where = spec.scope ? `where ${spec.scope}` : "";
    const donePlaceholders = spec.done.map(() => "?").join(", ");
    // Captioning: split the raw `pending` bucket into eligible (real backlog) and
    // `deferred` (never-claimed under the current config). Other pools — and
    // captioning when no eligibility is supplied — have no `deferred` partition.
    const eligibleSql = pool === "captioning" && eligibility ? captionEligibleSql(eligibility) : null;
    const freshPending = `${spec.statusCol} = 'pending' and ${spec.attemptsCol} = 0`;
    const pendingCase = eligibleSql ? `${freshPending} and ${eligibleSql}` : freshPending;
    const deferredCase = eligibleSql ? `${freshPending} and not ${eligibleSql}` : null;
    const sql = `select
        sum(case when ${pendingCase} then 1 else 0 end) as pending,
        sum(case when ${spec.statusCol} = 'pending' and ${spec.attemptsCol} > 0 then 1 else 0 end) as retrying,
        sum(case when ${spec.statusCol} = 'processing' then 1 else 0 end) as processing,
        sum(case when ${spec.statusCol} in (${donePlaceholders}) then 1 else 0 end) as done,
        sum(case when ${spec.statusCol} = 'failed' then 1 else 0 end) as failed,
        sum(case when ${spec.statusCol} = 'skipped' then 1 else 0 end) as skipped,
        ${deferredCase ? `sum(case when ${deferredCase} then 1 else 0 end)` : "0"} as deferred
      from ${spec.table} ${where}`;
    return this.read((db) => {
      const row = db.prepare(sql).get(...spec.done) as Record<string, number | null>;
      return {
        pending: row.pending ?? 0,
        processing: row.processing ?? 0,
        retrying: row.retrying ?? 0,
        done: row.done ?? 0,
        failed: row.failed ?? 0,
        skipped: row.skipped ?? 0,
        deferred: row.deferred ?? 0,
      };
    });
  }

  /**
   * One keyset-paginated page of a pipeline's items (the `/api/pipelines/:pool/items`
   * feed), reverse-chron on `(updatedAt, id)`. `status`/`room` are optional indexed
   * filters. The cursor is opaque (base64 of `(sortValue, id)`); a fetched-one-extra
   * probe sets `nextCursor`. `defaultMaxRetries` is the pool's configured retry cap,
   * stamped onto items whose pool has no per-row max (enrichment/captioning/diary;
   * summarization carries its own `max_retries`). Pure read.
   */
  listPipelineItems(
    pool: PipelineId,
    query: PipelineItemQuery,
    defaultMaxRetries: number,
    eligibility?: CaptionEligibility,
  ): PipelineItemPage {
    const spec = PIPELINE_LIST_SPECS[pool];
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const cursor = decodePipelineCursor(query.cursor);

    const where: string[] = [];
    const params: Record<string, unknown> = {};
    // The default (no-chip) view of a pool with a `defaultScope` uses that single
    // predicate instead of `scope` (which it already implies) so the planner stays
    // on the pool's partial "active" index; every other branch uses `scope`.
    const usesDefaultScope = !query.status && spec.defaultScope != null;
    if (spec.scope && !usesDefaultScope) where.push(spec.scope);
    // Captioning `deferred` (never-claimed pending under the current config). The
    // fragment inlines its config booleans, so it needs no bind params. Only the
    // captioning pool supplies `eligibility`; absent ⇒ no deferred partition.
    const eligibleSql = pool === "captioning" && eligibility ? captionEligibleSql(eligibility) : null;
    const deferredSql = eligibleSql
      ? `${spec.statusCol} = 'pending' and ${spec.attemptsCol} = 0 and not ${eligibleSql}`
      : null;
    // `pending`/`retrying` are the two count buckets that share the raw `pending`
    // status (retrying = pending with prior attempts); filter on the same predicate
    // the counts use so a chip's rows match its badge. Any other value is a raw
    // status match.
    if (query.status === "retrying") {
      where.push(`${spec.statusCol} = 'pending' and ${spec.attemptsCol} > 0`);
    } else if (query.status === "pending") {
      // The `pending` chip mirrors the honest count: deferred (never-claimed)
      // captioning rows are excluded — they live under the `deferred` chip.
      where.push(`${spec.statusCol} = 'pending' and ${spec.attemptsCol} = 0`);
      if (eligibleSql) where.push(eligibleSql);
    } else if (query.status === "deferred" && deferredSql) {
      where.push(deferredSql);
    } else if (query.status) {
      where.push(`${spec.statusCol} = @status`);
      params.status = query.status;
    } else {
      // Default (unfiltered) view: hide the terminal-noise that otherwise drowns
      // the list into an all-message timeline — `skipped` (nothing to do) for every
      // pool, plus captioning's config-`deferred` pending. Both stay reachable via
      // their explicit chip. `defaultScope` (enrichment) folds the `skipped` + scope
      // exclusion into the one index-matching predicate; pools without it fall back
      // to `scope` (pushed above) + a plain `!= 'skipped'`.
      where.push(spec.defaultScope ?? `${spec.statusCol} != 'skipped'`);
      if (deferredSql) where.push(`not (${deferredSql})`);
    }
    if (query.room) {
      where.push(`${spec.roomCol} = @room`);
      params.room = query.room;
    }
    if (cursor) {
      where.push(
        `(${spec.sortCol} < @cursorSort or (${spec.sortCol} = @cursorSort and ${spec.idCol} < @cursorId))`,
      );
      params.cursorSort = cursor.s;
      params.cursorId = cursor.id;
    }
    // Fetch one extra row to learn whether a further page exists.
    params.limit = limit + 1;

    const whereSql = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const sql = `${spec.selectFrom} ${whereSql}
      order by ${spec.sortCol} desc, ${spec.idCol} desc
      limit @limit`;

    const rows = this.read(
      (db) => db.prepare(sql).all(params) as Array<Record<string, unknown>>,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((row) => spec.project(row, defaultMaxRetries, eligibility));
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? encodePipelineCursor({ s: last.updatedAt, id: last.id }) : null;
    return { items, nextCursor };
  }

  /**
   * A single pipeline item by id (backs `/api/pipelines/:pool/items/:id`), using
   * the same projection + scope as {@link listPipelineItems}. Returns undefined
   * when the id is unknown OR falls outside the pool's scope (e.g. a non
   * image/video/audio media asset, or an `inactive` enrichment event) — so an
   * out-of-track id reads as a 404, never a partial item. Pure read.
   */
  getPipelineItem(
    pool: PipelineId,
    id: string,
    defaultMaxRetries: number,
    eligibility?: CaptionEligibility,
  ): PipelineItem | undefined {
    const spec = PIPELINE_LIST_SPECS[pool];
    const where = [spec.scope, `${spec.idCol} = @id`].filter(Boolean).join(" and ");
    const sql = `${spec.selectFrom} where ${where} limit 1`;
    const row = this.read(
      (db) => db.prepare(sql).get({ id }) as Record<string, unknown> | undefined,
    );
    return row ? spec.project(row, defaultMaxRetries, eligibility) : undefined;
  }

  /**
   * Manual retry (ARCHITECTURE.md §11, Phase 5): re-enqueue a terminal item —
   * status→pending, attempts→0, error cleared. Gated by per-pool safety
   * ({@link PIPELINE_SAFE_RETRY}): `processing` (in-flight) and the deferred unsafe
   * states (summarization `complete`, diary `done`) are rejected with
   * `not_retryable` (the caller maps that to a 409). The reset is idempotent and
   * goes through the single-writer queue; the pool re-claims on its next tick (the
   * server additionally pokes the pool's notify seam for immediacy). Terminal safe
   * states are never auto-claimed, so the read-then-write needs no extra CAS.
   */
  async retryPipelineItem(pool: PipelineId, id: string): Promise<PipelineRetryOutcome> {
    const item = this.getPipelineItem(pool, id, 0);
    if (!item) return { ok: false, code: "not_found" };
    if (!PIPELINE_SAFE_RETRY[pool].includes(item.status)) {
      return { ok: false, code: "not_retryable", itemStatus: item.status };
    }
    const now = Date.now();
    await this.write((db) => {
      switch (pool) {
        case "enrichment":
          db.prepare(
            `update timeline_events set enrichment_status = 'pending', enrichment_retries = 0, updated_at = ? where id = ?`,
          ).run(now, id);
          break;
        case "captioning":
          db.prepare(
            `update media_assets set caption_status = 'pending', caption_attempts = 0, caption_error = null, updated_at = ? where id = ?`,
          ).run(now, id);
          break;
        case "summarization":
          db.prepare(
            `update summarization_jobs set status = 'pending', attempts = 0, error = null, updated_at = ? where id = ?`,
          ).run(now, id);
          break;
        case "diary":
          db.prepare(
            `update summaries set diary_status = 'pending', diary_attempts = 0 where id = ?`,
          ).run(id);
          break;
      }
    });
    return { ok: true };
  }

  /**
   * Bulk retry (ARCHITECTURE.md §11, Phase 5): reset every `failed` item in a pool
   * to `pending` (attempts→0, error cleared). Restricted to the unambiguously-safe
   * `failed` state — a thin wrapper over the per-item reset. Returns the count
   * re-enqueued. Goes through the single-writer queue.
   */
  retryFailedPipelineItems(pool: PipelineId): Promise<number> {
    const now = Date.now();
    return this.write((db) => {
      switch (pool) {
        case "enrichment":
          return db
            .prepare(
              `update timeline_events set enrichment_status = 'pending', enrichment_retries = 0, updated_at = ? where enrichment_status = 'failed'`,
            )
            .run(now).changes;
        case "captioning":
          return db
            .prepare(
              `update media_assets set caption_status = 'pending', caption_attempts = 0, caption_error = null, updated_at = ?
               where caption_status = 'failed' and media_type in ('image', 'video', 'audio')`,
            )
            .run(now).changes;
        case "summarization":
          return db
            .prepare(
              `update summarization_jobs set status = 'pending', attempts = 0, error = null, updated_at = ? where status = 'failed'`,
            )
            .run(now).changes;
        case "diary":
          return db
            .prepare(`update summaries set diary_status = 'pending', diary_attempts = 0 where diary_status = 'failed'`)
            .run().changes;
      }
    });
  }

  // --- Passive reaction store (ARCHITECTURE.md §6/§9f) ---

  /**
   * Upsert one reaction (action "add"). Idempotent on duplicate delivery:
   * `insert or ignore` keyed on the reaction's own event id leaves any existing
   * row (including a tombstoned one) untouched. Note `or ignore` also swallows
   * CHECK-constraint failures (e.g. a `kind` outside the allowed set) silently —
   * the narrowed `ReactionUpsert.kind` union is the compile-time guard against that.
   */
  upsertReaction(row: ReactionUpsert): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `insert or ignore into reactions (
           reaction_event_id, timeline_key, target_event_id, sender_id, sender_display,
           kind, display, shortcode, normalized_key, reacted_at, observed_at
         ) values (
           @reactionEventId, @timelineKey, @targetEventId, @senderId, @senderDisplay,
           @kind, @display, @shortcode, @normalizedKey, @reactedAt, @observedAt
         )`,
      ).run(row);
    });
  }

  /**
   * Tombstone a reaction (un-react): set `redacted_at` once. The `redacted_at is
   * null` guard makes a duplicate redaction a no-op and preserves the first
   * removal's timestamp. Returns rows updated — 0 when the id is unknown (a
   * redaction of a non-reaction event, or a reaction never surfaced) or already
   * tombstoned.
   */
  tombstoneReaction(reactionEventId: string, redactedAt: number): Promise<number> {
    return this.write(
      (db) =>
        db
          .prepare(
            `update reactions set redacted_at = @redactedAt
             where reaction_event_id = @reactionEventId and redacted_at is null`,
          )
          .run({ reactionEventId, redactedAt }).changes,
    );
  }

  /**
   * View A: deduped reaction counts for a batch of target messages, keyed by
   * target event id. Each value is that message's reactions grouped by
   * `normalizedKey` with a distinct-sender count, ordered count desc then display
   * asc (matching `react`/`list_reactions`). Tombstoned rows are excluded; targets
   * with no live reactions are simply absent from the map.
   *
   * Matches purely on `target_event_id` (a globally-unique Matrix event id) — not
   * on timeline_key, which is not derivable from a reaction event (see the
   * reactions schema). The caller passes the exact event ids it is rendering, so
   * there is no cross-room leakage.
   */
  getReactionAggregates(targetEventIds: string[]): Map<string, ReactionAggregateRow[]> {
    const result = new Map<string, ReactionAggregateRow[]>();
    if (targetEventIds.length === 0) return result;
    return this.read((db) => {
      const batchSize = 500;
      for (let i = 0; i < targetEventIds.length; i += batchSize) {
        const batch = targetEventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(", ");
        const rows = db
          .prepare(
            // Bare aggregates over a GROUP BY pick an arbitrary row in SQLite, so a
            // normalized_key group whose rows differ only by a variation selector
            // (`❤️` vs `❤`) would yield a non-deterministic glyph + sort key. Take a
            // stable representative for each non-grouped column via min(). `kind` is
            // constant within a normalized_key group (unicode glyph vs custom mxc://),
            // so min(kind) is a coherent pairing, not an arbitrary cross-row mix.
            // The final `normalized_key asc` is a total-order tiebreaker (the GROUP BY
            // key is unique per group) so equal-(count, display) groups don't sort in
            // SQLite-undefined order. Together this makes the result byte-for-byte
            // deterministic (ARCHITECTURE.md §9 invariant).
            `select target_event_id as targetEventId, normalized_key as normalizedKey,
                    min(kind) as kind, min(display) as display, min(shortcode) as shortcode,
                    count(distinct sender_id) as count
             from reactions
             where target_event_id in (${placeholders})
               and redacted_at is null
             group by target_event_id, normalized_key
             order by count desc, display asc, normalized_key asc`,
          )
          .all(...batch) as ReactionAggregateRow[];
        for (const row of rows) {
          const list = result.get(row.targetEventId);
          if (list) list.push(row);
          else result.set(row.targetEventId, [row]);
        }
      }
      return result;
    });
  }

  /**
   * View B: live (non-tombstoned) reactions on a batch of target messages, ordered
   * oldest-first by `reacted_at`. The caller (context builder) coalesces these per
   * (target, normalizedKey) and applies the recency horizon + name cap. Flat list
   * across all targets. Matches on `target_event_id` only (see
   * {@link getReactionAggregates}).
   */
  getDiscreteReactions(targetEventIds: string[]): DiscreteReactionRow[] {
    if (targetEventIds.length === 0) return [];
    return this.read((db) => {
      const rows: DiscreteReactionRow[] = [];
      const batchSize = 500;
      for (let i = 0; i < targetEventIds.length; i += batchSize) {
        const batch = targetEventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(", ");
        rows.push(
          ...(db
            .prepare(
              `select reaction_event_id as reactionEventId, target_event_id as targetEventId,
                      sender_id as senderId, sender_display as senderDisplay,
                      normalized_key as normalizedKey, kind, display, shortcode,
                      reacted_at as reactedAt
               from reactions
               where target_event_id in (${placeholders})
                 and redacted_at is null
               order by reacted_at asc, reaction_event_id asc`,
            )
            .all(...batch) as DiscreteReactionRow[]),
        );
      }
      return rows;
    });
  }

  close(): void {
    this.closed = true;
    this.rejectPendingWrites();
    this.db.close();
  }

  async waitForIdle(): Promise<void> {
    while (!this.closed && (this.draining || this.queue.length > 0)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private rejectPendingWrites(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      job?.reject(new Error("Storage is closed"));
    }
  }

  private drainQueue(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) continue;
        try {
          job.resolve(job.run(this.db));
        } catch (error) {
          job.reject(error);
        }
      }
      this.draining = false;
      if (this.queue.length > 0) this.drainQueue();
    });
  }
}

// Memory-retrieval index DDL (ARCHITECTURE.md §9d). Shared verbatim by the
// fresh-DB SCHEMA (interpolated below) and the v6→v7 migration step, so the two
// can never drift. Plain SQLite + built-in FTS5 only — NO extension load is
// required here. The `sqlite-vec` `memory_vec` virtual table is NOT created here:
// it depends on the extension being loaded on the connection and on the active
// embedding model's dimension, so it is created at retrieval-subsystem init time
// (§5b), leaving lexical search fully functional with zero native deps.
const RETRIEVAL_SCHEMA = `
create table if not exists memory_chunks (
  -- AUTOINCREMENT so a deleted chunk's rowid is NEVER reused: the vector index
  -- (memory_vec) keys on this rowid, and a reused rowid could otherwise bind a
  -- stale vector to a different chunk (§9d). Orphaned vec rows are also pruned on
  -- delete, but the no-reuse guarantee makes a mismatch impossible regardless.
  rowid         integer primary key autoincrement,
  id            text unique not null,
  path          text not null,
  ordinal       integer not null,
  source        text not null default 'memory',
  start_line    integer not null,
  end_line      integer not null,
  room          text,
  entry_ts      integer not null,
  text          text not null,
  token_count   integer not null,
  content_hash  text not null,
  model_id      text,
  embed_status  text not null default 'pending'
                  check(embed_status in ('pending','processing','done','failed','skip')),
  embed_attempts integer not null default 0,
  indexed_at    integer not null
);

create index if not exists idx_chunks_embed on memory_chunks(embed_status)
  where embed_status in ('pending','processing');
create index if not exists idx_chunks_path on memory_chunks(path);

-- Lexical index: external-content FTS5 over memory_chunks (unicode61, English).
create virtual table if not exists memory_chunks_fts using fts5(
  text, room, content='memory_chunks', content_rowid='rowid'
);

-- Triggers mirror memory_chunks → FTS. External-content tables require the special
-- 'delete' command (with the old column values) to retract a row before re-add.
create trigger if not exists memory_chunks_ai after insert on memory_chunks begin
  insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
end;
create trigger if not exists memory_chunks_ad after delete on memory_chunks begin
  insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
    values ('delete', old.rowid, old.text, old.room);
end;
-- The update trigger is gated on the FTS-indexed columns (review issue #11): most
-- memory_chunks updates touch only embed_status/model_id/embed_attempts (the embed
-- queue), which the lexical index does not care about. Without this WHEN guard every
-- such update — and resetAllEmbeddings rewrites EVERY row's embed_status — would
-- delete+reinsert the FTS row needlessly. IS NOT (not <>) so a NULL room is
-- compared correctly. This trigger carries its when-guard from genesis.
create trigger if not exists memory_chunks_au after update on memory_chunks
  when new.text is not old.text or new.room is not old.room
begin
  insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
    values ('delete', old.rowid, old.text, old.room);
  insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
end;

-- Document-embedding cache (§5e): identical text under the same model never
-- re-embeds. Keyed by content_hash (= hash(text)) + model_id.
create table if not exists embedding_cache (
  text_hash text not null,
  model_id  text not null,
  embedding blob not null,
  primary key (text_hash, model_id)
);

-- Single-key/value metadata: active embedding model + dim, corpus signature (§6).
create table if not exists index_meta (
  key   text primary key,
  value text not null
);
`;

// Chat-history search index (ARCHITECTURE.md §9e). A denormalized, search-optimized
// projection of timeline_events: one row per searchable event, flattening the
// scattered searchable text (message body + image captions + link-preview text) and
// the filter metadata (attachment presence/type, links, replies, quoted sender) that
// otherwise live across media_assets / link_previews / reply_contexts / event_json.
// Rebuilt incrementally by the reconciliation indexer (src/search/) as bodies, edits,
// captions and previews settle — the same content-hash set-diff idiom as the memory
// index above. `chat_mentions` denormalizes event_json.mentions for an indexed
// "who was mentioned" join. `chat_index_fts` is external-content FTS5 over the two
// searchable columns; the tools' `scope` selects which column set MATCH applies to.
const CHAT_SEARCH_SCHEMA = `
create table if not exists chat_index (
  -- AUTOINCREMENT for the same reason memory_chunks uses it: the FTS docid keys on
  -- this rowid, and never reusing a deleted row's id keeps the external-content FTS
  -- mapping unambiguous.
  rowid               integer primary key autoincrement,
  -- Cascade-delete with the source event: when a timeline_events row is removed
  -- (pruneInactiveTimelineEvents / deleteUndecryptedEvent), its denormalized
  -- search projection must go too, or search_messages keeps surfacing the
  -- deleted event from chat_index's OWN stored body copy until the next startup
  -- orphan sweep (a privacy/consistency leak across restarts — review #4). The
  -- chat_index_ad AFTER DELETE trigger fires on the cascade, transitively
  -- cleaning chat_index_fts + chat_mentions (recursive triggers are on by
  -- default). PRAGMA foreign_keys is ON (Storage.open), so this takes effect.
  event_id            text not null unique references timeline_events(id) on delete cascade,
  timeline_key        text not null,
  sender_id           text not null,
  sender_display_name text,
  role                text not null,
  timestamp           integer not null,
  body                text not null default '',   -- default search scope
  aux_text            text not null default '',   -- captions + link-preview text (opt-in scope)
  has_attachment      integer not null default 0, -- 1 if any role='attachment' media
  attachment_types    text not null default '',   -- csv subset of image,video,audio,file
  has_link            integer not null default 0,
  is_reply            integer not null default 0,
  quoted_sender_id    text,
  content_sig         text not null,              -- hash of all projected inputs (dirty check)
  indexed_at          integer not null
);
create index if not exists idx_chat_index_room_time on chat_index(timeline_key, timestamp);
create index if not exists idx_chat_index_sender_time on chat_index(sender_id, timestamp);
create index if not exists idx_chat_index_quoted on chat_index(quoted_sender_id, timestamp)
  where quoted_sender_id is not null;

create table if not exists chat_mentions (
  event_id text not null,
  user_id  text not null,
  primary key (event_id, user_id)
);
create index if not exists idx_chat_mentions_user on chat_mentions(user_id);

-- Lexical index: external-content FTS5 over chat_index. No tokenize= clause, so
-- the FTS5 default (unicode61, no stemming) applies — same as memory_chunks_fts.
create virtual table if not exists chat_index_fts using fts5(
  body, aux_text, content='chat_index', content_rowid='rowid'
);
create trigger if not exists chat_index_ai after insert on chat_index begin
  insert into chat_index_fts(rowid, body, aux_text) values (new.rowid, new.body, new.aux_text);
end;
create trigger if not exists chat_index_ad after delete on chat_index begin
  insert into chat_index_fts(chat_index_fts, rowid, body, aux_text)
    values ('delete', old.rowid, old.body, old.aux_text);
  -- Mentions are keyed by event_id, not rowid, so drop them alongside the index row.
  delete from chat_mentions where event_id = old.event_id;
end;
-- Gated on the FTS-indexed columns: a projection upsert that only touches metadata
-- (e.g. has_link flipping) must not churn the FTS row. IS NOT compares NULLs safely.
create trigger if not exists chat_index_au after update on chat_index
  when new.body is not old.body or new.aux_text is not old.aux_text
begin
  insert into chat_index_fts(chat_index_fts, rowid, body, aux_text)
    values ('delete', old.rowid, old.body, old.aux_text);
  insert into chat_index_fts(rowid, body, aux_text) values (new.rowid, new.body, new.aux_text);
end;
`;

// Summary-content search index (ARCHITECTURE.md §9e, "Summary search"). An
// external-content FTS5 table over `summaries.content`, so a summary is reachable by
// keyword — not only by time window via `recap`. Mirrors `memory_chunks_fts` /
// `chat_index_fts`, but simpler: a summary's `content` is **immutable after insert**
// (a summary row is created once by `insertSummaryWithLineage`; later only its
// `status` flips — and only ever to `superseded`, which no code path writes today —
// or the row is deleted). Immutable content means there is NO update trigger to guard:
// plain insert/delete suffice. `superseded` rows stay in the FTS table and are filtered
// out at QUERY time (`status in ('complete','truncated')`), which is simpler and safer
// than mutating FTS on a (currently nonexistent) supersede. `summaries.id` is a TEXT
// PK, but the table is not WITHOUT ROWID, so it has the implicit integer `rowid` the
// external-content FTS docid maps onto.
const SUMMARY_SEARCH_SCHEMA = `
create virtual table if not exists summaries_fts using fts5(
  content, content='summaries', content_rowid='rowid'
);
create trigger if not exists summaries_ai after insert on summaries begin
  insert into summaries_fts(rowid, content) values (new.rowid, new.content);
end;
create trigger if not exists summaries_ad after delete on summaries begin
  insert into summaries_fts(summaries_fts, rowid, content) values ('delete', old.rowid, old.content);
end;
`;

// Session trigger-message search index (console sessions filter, ARCHITECTURE.md §11).
// External-content FTS5 over `agent_sessions.trigger_body` so the console can keyword-
// search the message that launched a session. Mirrors `summaries_fts` / `chat_index_fts`,
// but the source column is set ONCE at session creation and effectively immutable (later
// updates only flip status / write usage rollups — never `trigger_body`). So no separate
// reconciliation indexer is needed: the triggers keep the index exact. The `au` trigger is
// gated on `trigger_body` actually changing (IS NOT compares NULLs safely) so the steady
// stream of status/usage updates on a row never churns the FTS index. `agent_sessions.id`
// is a TEXT PK but the table is not WITHOUT ROWID, so it has the implicit integer `rowid`
// the external-content FTS docid maps onto (same as `summaries`).
const AGENT_SESSIONS_FTS_SCHEMA = `
create virtual table if not exists agent_sessions_fts using fts5(
  trigger_body, content='agent_sessions', content_rowid='rowid'
);
create trigger if not exists agent_sessions_ai after insert on agent_sessions begin
  insert into agent_sessions_fts(rowid, trigger_body) values (new.rowid, new.trigger_body);
end;
create trigger if not exists agent_sessions_ad after delete on agent_sessions begin
  insert into agent_sessions_fts(agent_sessions_fts, rowid, trigger_body)
    values ('delete', old.rowid, old.trigger_body);
end;
create trigger if not exists agent_sessions_au after update on agent_sessions
  when new.trigger_body is not old.trigger_body
begin
  insert into agent_sessions_fts(agent_sessions_fts, rowid, trigger_body)
    values ('delete', old.rowid, old.trigger_body);
  insert into agent_sessions_fts(rowid, trigger_body) values (new.rowid, new.trigger_body);
end;
`;

// Per-session **interjection** store (console sessions filter, ARCHITECTURE.md §8/§11).
// An interjection is a user message injected into an already-running session (a reply
// steered into the live run, or a co-target co-reply — see §8 "Steering"); it plays the
// same role as the session's trigger but arrives mid-run, and there can be many. So
// unlike the single `agent_sessions.trigger_body` column, interjections need a child
// table. Each row denormalizes the inbound message that drove the interjection — its
// timeline `event_id`/`external_id` (the durable "timeline message → session" link the
// debug path follows), sender, kind, and the raw `body` (truncated like `trigger_body`)
// — so a session is reachable by an interjection's text exactly as it is by its trigger.
// `body` is written once at injection and never updated, so (like `summaries_fts`) the
// external-content FTS5 index needs only insert/delete sync triggers, no update guard.
// `on delete cascade` from `agent_sessions` (FKs ON) keeps the children + their FTS rows
// consistent if a session row is ever removed; the `_ad` trigger cleans the FTS on the
// cascade (recursive triggers are on by default).
const SESSION_INTERJECTIONS_SCHEMA = `
create table if not exists session_interjections (
  -- AUTOINCREMENT: the external-content FTS docid keys on this rowid; never reusing a
  -- deleted row's id keeps the FTS mapping unambiguous (same idiom as chat_index).
  rowid               integer primary key autoincrement,
  session_id          text not null references agent_sessions(id) on delete cascade,
  event_id            text,   -- internal timeline event id (null for non-timeline injects)
  external_id         text,   -- Matrix $… id of the inbound message
  sender_id           text,
  sender_display_name text,
  kind                text not null,            -- 'reply' | 'co-reply' | 'follow-up'
  body                text not null default '', -- raw inbound body (search corpus)
  created_at          integer not null
);
create index if not exists idx_session_interjections_session
  on session_interjections(session_id, created_at);
create index if not exists idx_session_interjections_event
  on session_interjections(event_id) where event_id is not null;
create virtual table if not exists session_interjections_fts using fts5(
  body, content='session_interjections', content_rowid='rowid'
);
create trigger if not exists session_interjections_ai after insert on session_interjections begin
  insert into session_interjections_fts(rowid, body) values (new.rowid, new.body);
end;
create trigger if not exists session_interjections_ad after delete on session_interjections begin
  insert into session_interjections_fts(session_interjections_fts, rowid, body)
    values ('delete', old.rowid, old.body);
end;
`;

// Passive reaction store (ARCHITECTURE.md §6/§9f): the
// source of truth for emoji reactions the agent passively perceives. Deliberately
// NOT part of the timeline — a reaction is a mutable many-to-one relation (N
// senders, add/remove over time) folded onto one target message, injected only at
// render time (Views A/B). Keeping reactions out of `timeline_events` keeps them
// out of summarization, chat search, diary and recap, all of which iterate it.
//
// No foreign key to `timeline_events`: `target_event_id` is the *external* Matrix
// event id (== CanonicalChatEvent.externalId), not the internal `timeline_events.id`,
// and a reaction may legitimately reference a message not (or no longer) stored.
// `if not exists` makes this block safe to run both as the fresh-DB schema and as
// the v14->v15 migration (which simply re-execs it), so the two cannot drift.
const REACTIONS_SCHEMA = `
create table if not exists reactions (
  -- The m.reaction event's OWN id ($...). Redactions name this id, so an un-react
  -- is a single UPDATE ... where reaction_event_id = ? — no content matching.
  reaction_event_id text primary key,
  -- Room-level locality hint (matrix:{account}:room:{roomId}) — informational
  -- only. A reaction event carries just a room id; the target message's
  -- authoritative timeline_key (dm vs room vs :thread:root) is NOT derivable from
  -- it, and there is an ingest-vs-persist race. So reactions are matched to their
  -- target purely by the globally-unique target_event_id (a Matrix event id is
  -- unique across rooms); this column is for debugging/console context, never the
  -- join key.
  timeline_key      text not null,
  -- The annotated message's Matrix event id (== CanonicalChatEvent.externalId).
  -- This, not timeline_key, is the authoritative match key for both views.
  target_event_id   text not null,
  sender_id         text not null,
  -- Display name at observation time (untrusted; for View B prose lines only).
  sender_display    text,
  kind              text not null check(kind in ('unicode', 'custom', 'text')),
  -- Glyph for unicode, :shortcode: for custom, literal for text.
  display           text not null,
  shortcode         text,
  -- Canonical grouping key: mxc:// for custom, glyph without variation selectors
  -- for unicode. Dedup/aggregation (View A) groups on this.
  normalized_key    text not null,
  reacted_at        integer not null,   -- origin_server_ts of the reaction
  observed_at       integer not null,   -- when we ingested it
  -- Non-NULL once removed (un-react): a tombstone. Tombstoned rows render in
  -- neither view but are kept so the aggregate count stays honest and a duplicate
  -- redaction is a no-op.
  redacted_at       integer
);
-- Both views match by target_event_id (View A aggregates per target, View B fetches
-- live rows for a target set). Partial on the live rows since tombstones never
-- render. Carries reacted_at so View B's oldest-first scan is fully index-served and
-- View A's target+live-row filter is index-served. View A's aggregation itself still
-- hits the heap: it groups on normalized_key and counts distinct sender_id, neither
-- of which is in the index. Fine at the rich tier's small row counts.
create index if not exists idx_reactions_by_target
  on reactions(target_event_id, reacted_at) where redacted_at is null;
`;

// Auxiliary tool-use usage ledger DDL (spec AUXILIARY-USAGE-TRACKING §8.2),
// shared verbatim between the canonical SCHEMA (fresh DBs) and the v20→v21
// migration step (existing DBs) so the two can never drift. Both uses are
// `create … if not exists`, so applying it twice is harmless.
const TOOL_INVOCATIONS_SCHEMA = `
create table if not exists tool_invocations (
  id text primary key,
  agent_session_id text,
  tool_name text not null,
  tool_call_id text,
  model_id text,
  provider text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  images integer,
  cost real,
  ref text,
  created_at integer not null
);

create index if not exists idx_tool_invocations_session
  on tool_invocations(agent_session_id, created_at);
`;

// Unified usage ledger DDL (spec USAGE-COST-LIMITS §3). One row per BILLABLE
// event across every consumer class (agent_loop / tool / caption / embedding) —
// the single source of truth for all cross-cutting usage queries (period
// budgets, console charts, both console tables). The per-lane stores
// (agent_sessions.usage_*, media_assets.caption_*) are retained as denormalized
// caches; this is an ADDITIONAL unified write, never folded back into them
// (§3.1). `model_id` is NOT NULL (every billable event names the model it
// priced against); attribution columns are nullable (caption/embedding are
// background, not session-scoped). `cost_usd` defaults 0 so a zero-rate
// (free-model) event still records its token/request counts while staying
// invisible to the BudgetEngine (§2.2). Shared verbatim between the canonical
// SCHEMA (fresh DBs) and the v24→v25 migration step (existing DBs) so the two
// can never drift; both uses are `create … if not exists`, idempotent.
//
// APPEND-ONLY, RANDOM PK, NO DEDUP: the `id` is a random `usage_<nanoid>` (or a
// `usage_bf_*` backfill key), never a natural/idempotency key — nothing collapses
// a duplicate logical event, so each capture point must fire at most once. The
// engine's seed-then-increment consistency additionally requires each insert to be
// microtask-drained before its `setInterval` tick. See `insertUsageEvent` for the
// full statement of both invariants.
const USAGE_EVENTS_SCHEMA = `
create table if not exists usage_events (
  id text primary key,
  ts integer not null,
  class text not null,
  agent_session_id text,
  session_type text,
  timeline_key text,
  trigger_sender_id text,
  tool_name text,
  model_id text not null,
  -- Logical model id (config block name; spec MODEL-FALLBACK §2.2), distinct from
  -- model_id (upstream wire id). Budget selectors + console grouping key on this.
  logical_model_id text not null default '',
  -- Per-user limits (spec PER-USER-LIMITS §8.3) — all three nullable, written for
  -- the human agent loop only; null for legacy rows + background/proactive lanes.
  --   requested_model_id: the REQUESTED virtual model the per-user selector chose
  --     (§7), distinct from logical_model_id (the SERVED chain member) under active
  --     fallback. Per-user sub-caps scope on THIS so an outage backup still counts
  --     toward its requested model's sub-cap.
  --   budget_partition: the rendered SHARED-POOL key (§3.5) this event belongs to
  --     (literal/room/space/hs); null when the event joins no shared pool. Pool
  --     membership is a cascade outcome, irreducible from intrinsic columns.
  --   room_id: the bare Matrix room id (derived from timeline_key) for room-scoped
  --     per-user counters + per-room pools — sturdier than a timeline_key LIKE.
  --   space_id: the canonical parent space id (resolved + frozen at admission, §11)
  --     for space-scoped per-user counters + per-space pools. Null when the room has
  --     no parent space, or for a deployment without space rules.
  requested_model_id text,
  budget_partition text,
  room_id text,
  space_id text,
  provider text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  images integer,
  cost_usd real not null default 0,
  ref text,
  created_at integer not null
);

-- NB: there is intentionally NO session_type index. Session-scoped budget rules
-- (the spec's flagship) sumUsageCost over "ts >= window.start" plus a residual
-- "session_type in (...)" filter -- served by idx_usage_events_ts (the range bounds
-- the scan; the type filter is cheap on the windowed slice). Add a dedicated
-- idx_usage_events_sessiontype_ts only for a high-volume deployment running long
-- rolling session rules where the windowed scan grows costly.
create index if not exists idx_usage_events_ts        on usage_events(ts);
create index if not exists idx_usage_events_session   on usage_events(agent_session_id, ts);
create index if not exists idx_usage_events_class_ts   on usage_events(class, ts);
create index if not exists idx_usage_events_model_ts   on usage_events(model_id, ts);
create index if not exists idx_usage_events_logical_model_ts on usage_events(logical_model_id, ts);
create index if not exists idx_usage_events_tool_ts    on usage_events(tool_name, ts);
-- Per-user limits seed/recompute indexes (spec PER-USER-LIMITS §8.3): per-user
-- counters reseed off trigger_sender_id; shared pools off budget_partition; room
-- scoping off the derived room_id; requested-model sub-caps off requested_model_id.
create index if not exists idx_usage_events_sender_ts on usage_events(trigger_sender_id, ts);
create index if not exists idx_usage_events_partition_ts on usage_events(budget_partition, ts);
create index if not exists idx_usage_events_requested_model_ts on usage_events(requested_model_id, ts);
create index if not exists idx_usage_events_room_ts on usage_events(room_id, ts);
create index if not exists idx_usage_events_space_ts on usage_events(space_id, ts);
`;

// media_assets table + its indexes, factored out of the canonical SCHEMA so the
// v28->v29 CHECK-widening rebuild recreates the EXACT same shape (fresh and
// rebuilt DBs can't drift). The two are separate consts because the rebuild
// recreates indexes as a distinct post-copy step.
const MEDIA_ASSETS_SCHEMA = `
create table if not exists media_assets (
  id text primary key,
  event_id text not null references timeline_events(id) on delete cascade,
  role text not null,
  source_index integer,
  link_preview_id text references link_previews(id) on delete cascade,
  local_path text,
  mime_type text,
  media_type text not null,
  size_bytes integer,
  width integer,
  height integer,
  duration_seconds real,
  original_filename text,
  detected_content text,
  detected_metadata_json text,
  caption text,
  caption_model text,
  -- 'deferred' (spec MESSAGE-BACKFETCH §7.3): a captionable asset on a backfetched
  -- (is_backfetch=1) event. The enrichment worker assigns it instead of 'pending'
  -- so the row is INERT — claimPendingCaptions never considers 'deferred', even
  -- under caption_all=true — until an operator retroactively promotes it
  -- (deferred → pending) for a room/range. Keeps backfetch captioning opt-in and
  -- decoupled from the always-on text indexing.
  caption_status text not null default 'pending'
    check(caption_status in ('pending', 'processing', 'complete', 'failed', 'skipped', 'deferred')),
  caption_error text,
  -- Durable caption retry counter (ARCHITECTURE.md §11 pipeline monitor). Mirrors
  -- timeline_events.enrichment_retries / summarization_jobs.attempts /
  -- summaries.diary_attempts: incremented at claim time inside the CAS so "what's
  -- retrying" survives a restart and is visible to the DB-derived pipeline counts
  -- (the captioning pool previously tracked this in-memory only).
  caption_attempts integer not null default 0,
  -- Auxiliary caption usage/cost (spec AUXILIARY-USAGE-TRACKING §8.1), written
  -- atomically with the caption result. Nullable: legacy rows and gateways that
  -- omit usage read as "unknown" (never 0). caption_total_tokens =
  -- input+output+cacheRead; caption_cost is USD. A separate lane from
  -- agent_sessions.usage_* (§4). Added via the v20->v21 migration for existing DBs.
  caption_input_tokens integer,
  caption_output_tokens integer,
  caption_cache_read_tokens integer,
  caption_total_tokens integer,
  caption_cost real,
  download_status text not null default 'complete'
    check(download_status in ('complete', 'failed')),
  download_error text,
  created_at integer not null,
  -- Last-mutated wall clock, bumped on every caption claim/result/status write.
  -- The pipeline monitor sorts the captioning queue reverse-chron on this (= "most
  -- recently processed"); media_assets otherwise only carried created_at. Inserts
  -- seed it to created_at; the v7→v8 migration backfills existing rows likewise.
  updated_at integer
);
`;

const MEDIA_ASSETS_INDEXES = `
create index if not exists idx_media_assets_event
  on media_assets(event_id, role, source_index);

create index if not exists idx_media_assets_preview
  on media_assets(link_preview_id)
  where link_preview_id is not null;

create index if not exists idx_media_assets_caption_eligible
  on media_assets(caption_status, download_status, media_type)
  where caption_status in ('pending', 'processing');

-- Pipeline monitor: keyset pagination of the captioning queue, reverse-chron on
-- (updated_at, id) across full history (ARCHITECTURE.md §11).
create index if not exists idx_media_assets_updated
  on media_assets(updated_at, id);

-- Pipeline monitor: status-filtered keyset pagination ("what is failing?"). The
-- pre-existing partial index only covers pending/processing; a status=failed /
-- complete / skipped list must filter+sort without a full scan, so a non-partial
-- composite ordered to match the keyset sort (status, updated_at, id) is needed
-- (spec §3.4; ARCHITECTURE.md §11). (Does not cover getPipelineCounts, whose
-- pending/retrying split reads the uncovered attempts column — see §11 perf note.)
create index if not exists idx_media_assets_status_updated
  on media_assets(caption_status, updated_at, id);
`;

// Message-only history backfetch jobs (spec MESSAGE-BACKFETCH §8.1;
// ARCHITECTURE.md §7d). Persistent + resumable: a console/operator-triggered job
// that pages a room's history BELOW its context floor into the search-only
// region. Resumability is trivial (no atomicity — the search-only region is never
// rendered/summarized, so every committed page is independently consistent): on
// restart a `running` job resumes from `cursor_token`. Single-flight per room
// keeps the cursor + floor unambiguous. DDL shared with the v28→v29 migration.
const BACKFETCH_JOBS_SCHEMA = `
create table if not exists backfetch_jobs (
  id text primary key,
  room_id text not null,
  account_id text not null,
  timeline_key text not null,
  -- The operator target (spec §6.3): how the descent decides where to stop.
  target_kind text not null
    check(target_kind in ('beginning', 'date', 'oldest_decryptable', 'count')),
  -- ISO date for 'date'; positive integer for 'count'; NULL for the others.
  target_value text,
  -- §7.3 sugar: run the deferred→pending caption promote for this job's own
  -- fetched range on completion. The promote stands alone (operator action); this
  -- flag is convenience only and never makes the live claimer pick up deferred rows.
  caption_after integer not null default 0,
  status text not null default 'queued'
    check(status in ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  -- Backward continuation token (§6.2): the next_batch of the last page fetched.
  cursor_token text,
  oldest_reached_event_id text,
  oldest_reached_ts integer,
  -- Progress counters (fetched = summaries seen; stored = newly-committed rows).
  fetched integer not null default 0,
  stored integer not null default 0,
  -- Last BackwardPaginateStopReason of a run segment (telemetry / why it paused).
  stop_reason text,
  -- The floor this job pinned for its timeline key (audit; §4.3). NULL until the
  -- first below-floor insert sets it (or reuses a pre-existing floor).
  floor_event_id text,
  -- Optional per-run safety caps (§6.3): max stored (0 = unbounded) and wall-clock
  -- budget ms (0 = none). Combinable with any primary target.
  safety_cap integer not null default 0,
  timeout_ms integer not null default 0,
  error text,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_backfetch_jobs_status
  on backfetch_jobs(status, created_at);
create index if not exists idx_backfetch_jobs_room
  on backfetch_jobs(room_id, created_at desc);
`;

// Canonical schema. This is the COMPLETE current schema with every constraint
// baked in from the start, expressed entirely with idempotent
// `create … if not exists` DDL: a fresh database executes this block, is built
// directly at the final shape, and is stamped `user_version = LATEST` by
// `runMigrations`. Structurally it is still the genesis (v1) shape — the only
// MIGRATIONS step so far (v1→v2) is a data-only cleanup that changes no DDL.
// Evolve the schema by editing this block in place (keeping it idempotent), and
// only add a MIGRATIONS step for a rename/transform — or a data fix on existing
// rows — that `if not exists` cannot express.
const SCHEMA = `
create table if not exists timeline_events (
  id text primary key,
  external_id text,
  timeline_key text not null,
  provider text not null,
  role text not null check(role in ('user', 'assistant')),
  sender_id text not null,
  sender_display_name text,
  body text not null,
  timestamp integer not null,
  received_at integer not null,
  agent_session_id text,
  -- Resumable sessions (spec RESUMABLE-SESSIONS §6): the resume_generation the
  -- owning session held when this (bot-sent) message was tagged. NULL on inbound
  -- rows and on pre-migration sends, treated as generation 0. A reply-resume
  -- accepts a completed session only via a target message whose generation equals
  -- the session's CURRENT agent_sessions.resume_generation (older becomes FRESH),
  -- so a superseded output can never re-consume an already-continued state.
  agent_session_generation integer,
  event_json text not null,
  enrichment_status text not null default 'pending'
    check(enrichment_status in ('inactive', 'pending', 'processing', 'complete', 'failed', 'skipped')),
  enrichment_retries integer not null default 0,
  -- origin_server_ts of the most recent edit (m.replace) applied to this row, or
  -- NULL if the row has never been edited. The edit-application paths use this to
  -- enforce latest-by-origin_server_ts wins (issue #3): an incoming edit whose
  -- timestamp is older than this is a no-op, so an out-of-order delivery (notably a
  -- re-decrypted older edit arriving after a newer live edit across the
  -- live/redecryption boundary) can never clobber a newer edit. Mirrors the
  -- pending_edits latest-wins guard for the not-yet-stored-target case.
  last_edit_timestamp integer,
  -- Count of re-decryption probe attempts that did not yield decrypted content
  -- (still-UTD or unfetchable). The re-decryption sweeper increments this per
  -- failed probe and excludes rows at/above a ceiling from its candidate query
  -- so permanently-dead UTD rows (keys will never arrive) can't starve the
  -- oldest-first window and stall recovery of newer decryptable events. A large
  -- sentinel value marks a row permanently retired (e.g. missing room/event id).
  redecrypt_attempts integer not null default 0,
  trigger_group_id text,
  -- Provenance marker (spec MESSAGE-BACKFETCH §5): 1 iff this row entered via the
  -- message-only history backfetch (ARCHITECTURE.md §7d) — paged in from BELOW the
  -- room's context floor and kept search-only (indexed + enriched, never
  -- summarized/diaried/embedded/rendered). Immutable per-event, distinct from the
  -- movable context_floor_event_id which records *visibility*. Used by the
  -- enrichment worker to defer captioning (§7.3) and by the caption claim/promote
  -- path. Default 0 = the ordinary live/initial/gap ingest.
  is_backfetch integer not null default 0,
  created_at integer not null,
  updated_at integer not null,
  -- Generated from event_json so undecryptable (UTD) events are cheaply
  -- queryable by the re-decryption sweeper without scanning every row's JSON.
  -- VIRTUAL (computed on read/index): the partial index below makes lookups
  -- O(matches) without storing a redundant column per row. This column is
  -- created here by the canonical SCHEMA on a fresh DB.
  -- Derived from event_json, so late keys still resolve old rows across restarts
  -- (vs an in-memory UTD set).
  is_undecryptable integer generated always as
    (case when json_extract(event_json, '$.undecryptable') is not null then 1 else 0 end) virtual
);

create index if not exists idx_timeline_events_timeline_time
  on timeline_events(timeline_key, timestamp, received_at, id);

-- Partial index over the is_undecryptable generated column so the re-decryption
-- sweeper finds stored UTD events cheaply (O(matches), no full JSON scan).
-- redecrypt_attempts is carried in the index so the sweeper's candidate query
-- (is_undecryptable = 1 and redecrypt_attempts < :max, ordered by timestamp)
-- skips exhausted rows without touching the heap.
create index if not exists idx_timeline_events_undecryptable
  on timeline_events(is_undecryptable, redecrypt_attempts, timestamp)
  where is_undecryptable = 1;

create index if not exists idx_timeline_events_external
  on timeline_events(provider, external_id)
  where external_id is not null;

create index if not exists idx_timeline_events_enrichment
  on timeline_events(enrichment_status, timestamp desc)
  where enrichment_status in ('pending', 'processing');

-- Pipeline monitor: keyset pagination of the enrichment queue, reverse-chron on
-- (updated_at, id) across full history (ARCHITECTURE.md §11).
create index if not exists idx_timeline_events_updated
  on timeline_events(updated_at, id);

-- Pipeline monitor: status-filtered keyset pagination ("what is failing?"). The
-- pre-existing partial index only covers pending/processing; a status=failed /
-- complete / skipped list must filter+sort without a full scan, so a non-partial
-- composite ordered to match the keyset sort (status, updated_at, id) is needed
-- (spec §3.4; ARCHITECTURE.md §11). (Does not cover getPipelineCounts, whose
-- pending/retrying split reads the uncovered attempts column — see §11 perf note.)
create index if not exists idx_timeline_events_status_updated
  on timeline_events(enrichment_status, updated_at, id);

-- Pipeline monitor: the DEFAULT (no status chip) enrichment list — now the primary
-- browsing view — hides the noise (inactive never-queued rows + the skipped bulk of
-- every plain message), reverse-chron on (updated_at, id). A partial index over only
-- the non-noise minority lets that view be a clean keyset walk instead of scanning
-- past the skipped majority on idx_timeline_events_updated. The predicate matches the
-- emitted default-view WHERE term verbatim (PipelineListSpec defaultScope) so the
-- planner can use it (ARCHITECTURE.md §11).
create index if not exists idx_timeline_events_active_updated
  on timeline_events(updated_at, id)
  where enrichment_status not in ('inactive', 'skipped');

create index if not exists idx_timeline_events_trigger_group
  on timeline_events(trigger_group_id)
  where trigger_group_id is not null;

create table if not exists metadata (
  key text primary key,
  value text not null,
  updated_at integer not null
);

create table if not exists timeline_compaction_state (
  timeline_key text primary key,
  compact_start_event_id text,
  rich_start_event_id text,
  state_json text not null,
  timeline_state text not null default 'inactive'
    check(timeline_state in ('inactive', 'activating', 'active', 'backfilling')),
  -- Context floor (spec MESSAGE-BACKFETCH §4; ARCHITECTURE.md §7d): the oldest
  -- event id the FIRST-CLASS pipeline (context rendering + summarization) may
  -- consider for this timeline. NULL = no floor = today's behaviour exactly (the
  -- normal state for every room that has never been backfetched). Set ONCE to the
  -- timeline's current-oldest event id, immediately before the first below-floor
  -- backfetch insert, and never moved by this feature (moving it down — making the
  -- search-only region first-class — is the deferred full-backfetch feature §12).
  -- An event id (not a timestamp) for exact positioning, resolved to
  -- (timestamp, received_at, id) via the cursor lookup, same convention as
  -- compact_start_event_id / rich_start_event_id.
  context_floor_event_id text,
  updated_at integer not null
);

create table if not exists room_metadata (
  timeline_key text primary key,
  display_name text not null,
  resolved_at integer not null
);

create table if not exists reply_contexts (
  event_id text primary key references timeline_events(id) on delete cascade,
  reply_external_id text,
  sender_id text,
  sender_display_name text,
  sender_username text,
  body text,
  html_body text,
  timestamp integer,
  created_at integer not null
);

create table if not exists link_previews (
  id text primary key,
  event_id text not null references timeline_events(id) on delete cascade,
  context text not null,
  url text not null,
  title text,
  description text,
  site_name text,
  source_kind text,
  preview_index integer not null,
  fetched_at integer,
  fetch_status text not null,
  error text,
  payload_json text,
  created_at integer not null
);

create index if not exists idx_link_previews_event
  on link_previews(event_id, context, preview_index);

${MEDIA_ASSETS_SCHEMA}
${MEDIA_ASSETS_INDEXES}

create table if not exists summaries (
  id text primary key,
  timeline_key text not null,
  level integer not null,
  content text not null,
  earliest_timestamp integer not null,
  latest_timestamp integer not null,
  latest_event_id text not null,
  event_count integer not null,
  token_count integer not null,
  model_id text,
  status text not null default 'complete'
    check(status in ('complete', 'truncated', 'superseded')),
  backfill_job_id text,
  generated_at integer not null,
  created_at integer not null,
  -- Diary queue (ARCHITECTURE.md §9c). Set to 'pending' on every LEVEL-1 summary
  -- insert (unconditionally, regardless of [diary].enabled); NULL for level 2+.
  -- The DiaryWorkerPool drains 'pending' rows, mirroring the
  -- enrichment_status/caption_status/summarization_jobs.status idiom. NULL passes
  -- the CHECK (level 2+ never gets a diary entry).
  diary_status text
    check(diary_status in ('pending', 'processing', 'done', 'skipped', 'failed')),
  diary_attempts integer not null default 0
);

create index if not exists idx_summaries_timeline
  on summaries(timeline_key, latest_timestamp);

create index if not exists idx_summaries_level
  on summaries(timeline_key, level, earliest_timestamp);

-- Diary claim path: oldest pending level-1 summary first.
create index if not exists idx_summaries_diary
  on summaries(diary_status, latest_timestamp)
  where diary_status in ('pending', 'processing');

-- Pipeline monitor: keyset pagination of the diary queue (the diary-bearing
-- level-1 summaries), reverse-chron on (latest_timestamp, id). summaries has no
-- updated_at; the diary item's natural recency is its covered range's end
-- (ARCHITECTURE.md §11).
create index if not exists idx_summaries_diary_list
  on summaries(latest_timestamp, id)
  where diary_status is not null;

-- Pipeline monitor: status-filtered keyset pagination of the diary queue ("what is
-- failing?"). The diary list sorts by latest_timestamp (summaries has no
-- updated_at), so the composite is (diary_status, latest_timestamp, id), partial on
-- the diary-bearing rows to mirror idx_summaries_diary_list (spec §3.4;
-- ARCHITECTURE.md §11). (Does not cover getPipelineCounts — see §11 perf note.)
create index if not exists idx_summaries_diary_status_updated
  on summaries(diary_status, latest_timestamp, id)
  where diary_status is not null;

create table if not exists summary_events (
  summary_id text not null references summaries(id) on delete cascade,
  event_id text not null,
  ordinal integer not null,
  primary key (summary_id, event_id)
);

create index if not exists idx_summary_events_event
  on summary_events(event_id);

create table if not exists summary_parents (
  summary_id text not null references summaries(id) on delete cascade,
  parent_id text not null references summaries(id) on delete cascade,
  ordinal integer not null,
  primary key (summary_id, parent_id)
);

create index if not exists idx_summary_parents_parent
  on summary_parents(parent_id);

create table if not exists summarization_jobs (
  id text primary key,
  timeline_key text not null,
  level integer not null,
  status text not null default 'pending'
    check(status in ('pending', 'processing', 'complete', 'failed')),
  priority text not null default 'background'
    check(priority in ('interactive', 'proactive', 'background', 'background_low')),
  input_start_id text not null,
  input_end_id text not null,
  input_token_count integer,
  target_token_count integer not null,
  attempts integer not null default 0,
  max_retries integer not null default 2,
  best_effort_draft text,
  error text,
  result_summary_id text references summaries(id) on delete set null,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_summarization_jobs_status
  on summarization_jobs(status, created_at)
  where status in ('pending', 'processing');

create index if not exists idx_summarization_jobs_timeline
  on summarization_jobs(timeline_key, level, status);

-- Pipeline monitor: keyset pagination of the summarization queue, reverse-chron
-- on (updated_at, id) across full history (ARCHITECTURE.md §11).
create index if not exists idx_summarization_jobs_updated
  on summarization_jobs(updated_at, id);

-- Pipeline monitor: status-filtered keyset pagination ("what is failing?"). The
-- pre-existing partial index only covers pending/processing; a status=failed /
-- complete list must filter+sort without a full scan, so a non-partial composite
-- ordered to match the keyset sort (status, updated_at, id) is needed (spec §3.4;
-- ARCHITECTURE.md §11). (Does not cover getPipelineCounts — see §11 perf note.)
create index if not exists idx_summarization_jobs_status_updated
  on summarization_jobs(status, updated_at, id);

-- Edits (m.replace) that arrived/decrypted BEFORE their target message was
-- stored (plausible during backfill or out-of-order sync). The live/decrypt edit
-- path applies an edit to its target in place; when the target is missing it
-- parks the resolved replacement here instead of dropping it, and the append path
-- replays it once the target lands (issue #12). Keyed by
-- (provider, target_external_id, timeline_key) — scoped by timeline_key for the
-- same multi-account-shared-room reason as the edit lookup (issue #3): two bot
-- accounts in one room store the same Matrix event as two rows differing only by
-- canonical id, so a pending edit must target the right account's row. Latest
-- edit wins (insert-or-replace on the PK keeps the newest by edit_timestamp).
create table if not exists pending_edits (
  provider text not null,
  target_external_id text not null,
  timeline_key text not null,
  -- Resolved replacement content (post-edit body + serialized AttachmentMeta[]),
  -- already extracted from m.new_content so apply-time needs no re-parse.
  body text not null,
  attachments_json text not null,
  -- Origin timestamp of the edit event, used for latest-wins when several edits
  -- target the same not-yet-stored message.
  edit_timestamp integer not null,
  created_at integer not null,
  primary key (provider, target_external_id, timeline_key)
);

-- Durable session record (spec §3-§5): the frozen context prefix (snapshot,
-- written once at session creation) plus the appended transcript (rewritten
-- atomically at each turn boundary). Together context_snapshot_json ++
-- transcript_json reconstruct the exact sequence the model saw. The persisted
-- record outlives SessionManager's in-memory eviction; the console reads it
-- from here. See the status model in spec section 4.
create table if not exists agent_sessions (
  id text primary key,
  timeline_key text not null,
  session_type text not null default 'default',
  status text not null
    check(status in ('created', 'running', 'completed', 'discarded', 'interrupted', 'suspended',
                     'resuming', 'failed-resumable')),
  model_id text,
  trigger_event_id text,
  trigger_external_id text,
  trigger_body text,
  trigger_sender_id text,
  trigger_sender_display_name text,
  context_snapshot_json text,
  context_dump_path text,
  transcript_json text,
  token_estimate integer,
  -- Actuals (spec TOKEN-USAGE-TRACKING §4.2): denormalized session-level
  -- aggregate of provider-reported usage. All nullable so legacy rows read as
  -- "unknown" rather than a misleading zero. Per-request usage already lives
  -- verbatim inside transcript_json (Decision D1); these are the cheap rollup.
  llm_requests integer,
  usage_input_tokens integer,
  usage_output_tokens integer,
  usage_cache_read_tokens integer,
  usage_cache_write_tokens integer,
  usage_cost real,
  context_tokens integer,
  -- Resumable sessions (spec RESUMABLE-SESSIONS §6): the single-consumption
  -- counter. Bumped atomically when a reply-resume is ACCEPTED (status →
  -- resuming), so the prior run's outputs (tagged with the pre-bump value on
  -- their timeline_events rows) become stale forever and a state can be
  -- continued at most once. A linear chain works (each resume's new sends carry
  -- the bumped value); branching from a superseded output degrades to FRESH.
  resume_generation integer not null default 0,
  -- Resumable sessions (spec RESUMABLE-SESSIONS §9.2): the gap-backfill lower
  -- bound — the timestamp of the trigger group's latest member the session's
  -- context already covers (its original trigger on creation, advanced to each
  -- accepted resume's trigger). The reply-resume gap window is
  -- (chat_upper_bound_ts, new trigger]. Nullable: legacy (pre-v27) rows are NULL
  -- and fall back to the new trigger's timestamp on their first resume.
  chat_upper_bound_ts integer,
  no_reply integer not null default 0,
  error text,
  created_at integer not null,
  started_at integer,
  updated_at integer not null,
  completed_at integer
);

create index if not exists idx_agent_sessions_timeline
  on agent_sessions(timeline_key, created_at desc);

create index if not exists idx_agent_sessions_status
  on agent_sessions(status, updated_at desc);

${AGENT_SESSIONS_FTS_SCHEMA}
${SESSION_INTERJECTIONS_SCHEMA}

-- Auxiliary tool-use usage ledger (spec AUXILIARY-USAGE-TRACKING §8.2): one row
-- per billable raw-fetch tool call (today image_generate). Attributed to the
-- ambient session but a SEPARATE accounting lane — never folded into
-- agent_sessions.usage_* (§4). All usage/cost fields nullable ("unknown", not 0).
-- DDL shared with the v20→v21 migration via TOOL_INVOCATIONS_SCHEMA.
${TOOL_INVOCATIONS_SCHEMA}
-- Unified usage ledger (spec USAGE-COST-LIMITS §3): one row per billable event
-- across all consumer classes, the source of truth for cross-cutting usage
-- queries. Mirrors tool_invocations (one-to-one) and adds per-request agent-loop
-- rows + caption + embedding. DDL shared with the v24-to-v25 migration step.
${USAGE_EVENTS_SCHEMA}
${RETRIEVAL_SCHEMA}
${CHAT_SEARCH_SCHEMA}
${SUMMARY_SEARCH_SCHEMA}
${REACTIONS_SCHEMA}
${BACKFETCH_JOBS_SCHEMA}`;

// SCHEMA above defines the complete current shape with idempotent
// `create … if not exists` DDL, so a fresh database is built directly at the
// final shape and stamped straight to LATEST. To evolve the schema, edit SCHEMA
// in place (it stays idempotent) and, only if a column/table rename or a data
// transform on existing rows is needed that `create if not exists` cannot
// express, bump LATEST_SCHEMA_VERSION and add an ordered step to MIGRATIONS.
export const LATEST_SCHEMA_VERSION = 3;

/**
 * v1 → v2 (data-only, no DDL): one-off cleanup of duplicated bot self-messages.
 * Before `appendIfMissing` deduped by `(provider, external_id, timeline_key)` and
 * `send_message` merged into an echo-created row (`ingestAssistantSend`), a
 * bot-sent message could be stored twice — once under its
 * `assistant:{session}:{eventId}:{chunk}` canonical id (the send tool's append)
 * and once under `matrix:{account}:{eventId}` (the sync-echo race, or the gap
 * backfetch re-keying self-sent history). The duplicate shares the original's
 * timestamp but has a later received_at, so it sorts outside a summarization
 * job's declared cursor range while the timestamp-cutoff level-1 render still
 * includes it — tripping the declared-vs-rendered input-integrity assertion.
 *
 * Keep the `assistant:` row (it carries the session attribution), remap every
 * reference to the `matrix:` duplicate onto it, and delete the duplicate:
 * - `summary_events` lineage: drop the dup's row when the summary already lists
 *   the assistant sibling (both rows were rendered), else remap.
 * - `summaries.latest_event_id` / `summarization_jobs.input_{start,end}_id` /
 *   `timeline_compaction_state` cursors: remap to the assistant sibling (it
 *   sorts immediately below the dup — same timestamp, earlier received_at — so
 *   every cursor stays semantically in place).
 * - The dup's enrichment artifacts (`media_assets`/`link_previews`/
 *   `reply_contexts`) are deleted with it; the assistant row has its own.
 * - `chat_index` cleans itself via the ON DELETE CASCADE + its FTS triggers.
 */
function cleanupAssistantEchoDuplicates(db: Database.Database): void {
  db.exec(`
    create temp table dup_pairs as
      select m.id as matrix_id, min(a.id) as assistant_id
      from timeline_events m
      join timeline_events a
        on a.provider = m.provider
       and a.external_id = m.external_id
       and a.timeline_key = m.timeline_key
       and a.id like 'assistant:%'
      where m.id like 'matrix:%'
        and m.external_id is not null
        and m.role = 'assistant'
      group by m.id;

    delete from summary_events
    where exists (
      select 1 from dup_pairs dp
      where dp.matrix_id = summary_events.event_id
        and exists (
          select 1 from summary_events se2
          where se2.summary_id = summary_events.summary_id
            and se2.event_id = dp.assistant_id
        )
    );
    update summary_events
    set event_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = summary_events.event_id)
    where event_id in (select matrix_id from dup_pairs);

    update summaries
    set latest_event_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = summaries.latest_event_id)
    where latest_event_id in (select matrix_id from dup_pairs);

    update summarization_jobs
    set input_start_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = summarization_jobs.input_start_id)
    where input_start_id in (select matrix_id from dup_pairs);
    update summarization_jobs
    set input_end_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = summarization_jobs.input_end_id)
    where input_end_id in (select matrix_id from dup_pairs);

    update timeline_compaction_state
    set compact_start_event_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = timeline_compaction_state.compact_start_event_id)
    where compact_start_event_id in (select matrix_id from dup_pairs);
    update timeline_compaction_state
    set rich_start_event_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = timeline_compaction_state.rich_start_event_id)
    where rich_start_event_id in (select matrix_id from dup_pairs);
    update timeline_compaction_state
    set context_floor_event_id = (select dp.assistant_id from dup_pairs dp where dp.matrix_id = timeline_compaction_state.context_floor_event_id)
    where context_floor_event_id in (select matrix_id from dup_pairs);

    delete from media_assets where event_id in (select matrix_id from dup_pairs);
    delete from link_previews where event_id in (select matrix_id from dup_pairs);
    delete from reply_contexts where event_id in (select matrix_id from dup_pairs);

    delete from timeline_events where id in (select matrix_id from dup_pairs);

    drop table dup_pairs;
  `);
}

// Minimal HTML-entity decode for blockquote text recovered from a stored
// htmlBody (the native renderer escapes only these plus numeric references).
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Render a blockquote's inner HTML to trimmed plain-text lines (tags stripped
// after <br>/block-close breaks, entities decoded last so escaped text never
// reads as markup). Leading/trailing blank lines are dropped.
function blockquoteHtmlToText(inner: string): string[] {
  const text = decodeHtmlEntities(
    inner
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|ul|ol|blockquote|pre|h[1-6]|table|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
  const lines = text.split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * v2 → v3 (data-only, no DDL): repair reply bodies over-stripped by the native
 * reply-fallback stripper. Until the matching native fix, `strip_reply_fallback`
 * treated ANY leading `>`-prefixed lines of a reply body as the legacy rich-reply
 * fallback. Clients that omit the (deprecated since Matrix 1.3) fallback — Cinny,
 * Element X — send replies whose body is just the user's text; when that text
 * itself started with a markdown quote (`> …` / `>…` greentext), the quote lines
 * were deleted at ingest, and a whole-quote reply persisted as an empty body.
 *
 * The formatted body kept the content: after `<mx-reply>` stripping it begins
 * with the user's own `<blockquote>`. Rebuild the plain body from it:
 *  - candidates: replies (`event_json.replyTo` set) whose stored `htmlBody`
 *    starts with `<blockquote`;
 *  - skip rows whose body still contains the blockquote's first line — those
 *    came from fallback-sending clients and were stripped correctly;
 *  - repaired body = the blockquote text as `> `-prefixed lines, a blank line,
 *    then the surviving remainder (if any); both the `body` column and
 *    `event_json.body` are rewritten.
 *
 * Follow-on stores: `chat_index` needs no touch-up — the startup `reconcileAll`
 * sweep re-projects every event and the changed `content_sig` marks repaired
 * rows dirty. `reply_contexts` rows quoting a repaired event get the repaired
 * text where the stored context body exactly equals the damaged body (the
 * whole-quote case fell back to a formatted-body render at enrichment time and
 * is left as-is). Summaries generated from damaged renders are LLM output and
 * are not recomputed. Rows whose quote nests another blockquote are skipped
 * rather than risk a wrong rebuild.
 */
function repairReplyFallbackOverstrip(db: Database.Database): void {
  const candidates = db
    .prepare(
      `select id, external_id, body, event_json from timeline_events
       where json_extract(event_json, '$.replyTo') is not null
         and json_extract(event_json, '$.htmlBody') like '<blockquote%'`,
    )
    .all() as Array<{
    id: string;
    external_id: string | null;
    body: string;
    event_json: string;
  }>;
  if (candidates.length === 0) return;

  const updateEvent = db.prepare(
    "update timeline_events set body = ?, event_json = ?, updated_at = ? where id = ?",
  );
  const updateReplyContext = db.prepare(
    "update reply_contexts set body = ? where reply_external_id = ? and body = ?",
  );
  // Fold to lowercase alphanumeric words for the already-carries-the-quote
  // check: plain body and formatted body render the same source through
  // different markdown/HTML paths (`**bold**` vs `bold`, stray punctuation
  // differences), so only the word content is comparable.
  const scrub = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  for (const row of candidates) {
    let eventJson: Record<string, unknown>;
    try {
      eventJson = JSON.parse(row.event_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const htmlBody = typeof eventJson.htmlBody === "string" ? eventJson.htmlBody : "";
    // Attribute values may contain a literal `>` (Cinny emits
    // `<blockquote data-md=">">`), so the open tag can't end at the first `>`
    // — skip over quoted attribute strings when finding it.
    const match = /^<blockquote\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/blockquote>/i.exec(
      htmlBody,
    );
    if (!match || match[1].toLowerCase().includes("<blockquote")) continue;
    const quoteLines = blockquoteHtmlToText(match[1]);
    if (quoteLines.length === 0) continue;
    const remainder = row.body.trim();
    if (remainder !== "") {
      // Non-empty body: repair only when it verifiably lost the quote. A
      // word-free quote (pure punctuation) can't be checked — leave it alone
      // rather than risk prepending a duplicate.
      const quoteKey = scrub(quoteLines[0]);
      if (quoteKey === "" || scrub(row.body).includes(quoteKey)) continue;
    }

    const quote = quoteLines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
    const repaired = remainder === "" ? quote : `${quote}\n\n${remainder}`;
    eventJson.body = repaired;
    updateEvent.run(repaired, JSON.stringify(eventJson), Date.now(), row.id);
    if (row.external_id) updateReplyContext.run(repaired, row.external_id, row.body);
  }
}

// Ordered migration steps, indexed so the step at index `i` migrates a database
// at `user_version = i` up to `user_version = i + 1`. Index 0 (v0→v1) is
// deliberately absent: a v0 stamp only ever belongs to a fresh DB, which SCHEMA
// builds directly at the latest shape (runMigrations then just stamps LATEST).
const MIGRATIONS: Array<((db: Database.Database) => void) | undefined> = [
  undefined,
  cleanupAssistantEchoDuplicates,
  repairReplyFallbackOverstrip,
];

// PRAGMA user_version-based migration runner. Runs inside open()'s write
// callback (single-writer queue).
//   - Fresh DB (`isFresh`): SCHEMA has already built every table/index at the
//     latest shape (which includes every data fix by construction), so
//     runMigrations only STAMPS user_version to LATEST.
//   - Existing DB below LATEST: apply MIGRATIONS[current..<LATEST] in order,
//     then stamp LATEST. open() runs this before SCHEMA so any legacy-shape
//     ALTERs land before SCHEMA's latest-shape DDL.
//   - Existing DB already at LATEST: idempotent no-op.
//   - Existing DB ABOVE LATEST: throw — refuse to open forward-versioned data.
//     This is what guards a database stamped by a newer build until it is
//     explicitly re-stamped.
//
// `create table/index if not exists` in SCHEMA makes re-running open() on an
// up-to-date database harmless.
function runMigrations(db: Database.Database, isFresh: boolean): void {
  const current = Number((db.pragma("user_version", { simple: true }) as number) ?? 0);

  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${LATEST_SCHEMA_VERSION}). ` +
        `Refusing to open to avoid corrupting forward-versioned data.`,
    );
  }
  if (current === LATEST_SCHEMA_VERSION) {
    // Already at the latest version. Idempotent no-op.
    return;
  }

  // A fresh DB reports user_version = 0 but its tables were just built at the
  // latest shape by SCHEMA — there is no legacy column to add, so skip the steps
  // and only stamp the version.
  if (isFresh) {
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
    return;
  }

  // Existing DB below LATEST: apply each ordered step from `current` up to LATEST
  // in one transaction. A step at index i migrates a v(i) DB up to v(i+1).
  db.transaction(() => {
    for (let version = current; version < LATEST_SCHEMA_VERSION; version++) {
      const step = MIGRATIONS[version];
      if (step) step(db);
    }
    // PRAGMA does not accept bound parameters; LATEST_SCHEMA_VERSION is a
    // compile-time integer constant, so interpolation here is safe.
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`);
  })();
}
