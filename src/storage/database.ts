import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../observability/index.js";
import type { AttachmentMeta, CanonicalChatEvent, TimelineState } from "../types.js";

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
  download_status: string;
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
  createdAt: number;
  startedAt?: number | null;
  updatedAt: number;
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
  context_snapshot_json: string | null;
  context_dump_path: string | null;
  transcript_json: string | null;
  token_estimate: number | null;
  no_reply: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
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
  /** Full SELECT list + FROM (incl. any join + correlated session subquery). */
  selectFrom: string;
  project: (row: Record<string, unknown>, defaultMaxRetries: number) => PipelineItem;
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
    table: "media_assets",
    statusCol: "caption_status",
    attemptsCol: "caption_attempts",
    scope: "media_type in ('image', 'video', 'audio')",
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
        ma.caption as caption, ma.caption_error as caption_error
      from media_assets ma
      join timeline_events te on te.id = ma.event_id`,
    project: (row, maxRetries) => {
      const status = String(row.status);
      const attempts = Number(row.attempts ?? 0);
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
        inputSummary: `L${row.level} · ${row.input_token_count ?? "?"}→${row.target_token_count} tok`,
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
      // latest shape and runMigrations only stamps the version — it must NOT run
      // the additive ALTER steps, which target legacy DBs that predate a column.
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
        // `timeline_events`-presence probe would misclassify as fresh (skipping
        // the additive ALTER steps). runMigrations(fresh) here only stamps
        // user_version and opens NO inner transaction, so there is no nested
        // BEGIN. The existing-DB upgrade path keeps its own transaction inside
        // runMigrations (better-sqlite3 forbids nested transactions), so it must
        // NOT be wrapped here.
        writer.transaction(() => {
          writer.exec(SCHEMA);
          runMigrations(writer, true);
        })();
      } else {
        // Existing DB: run the additive migrations FIRST, then SCHEMA. SCHEMA is
        // the latest (vN) shape and its index/table DDL references columns that
        // only the ALTER steps add (e.g. idx_timeline_events_undecryptable keys on
        // redecrypt_attempts); running SCHEMA against an un-migrated legacy table
        // would raise "no such column" before the steps could add it. runMigrations
        // brings the legacy tables up to the current column shape under its own
        // transaction; the subsequent `create table/index if not exists` in SCHEMA
        // is then harmless (every referenced column now exists) and creates any
        // genuinely-new tables/indexes that no migration step covers.
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
          event_json, enrichment_status, created_at, updated_at
        ) values (
          @id, @externalId, @timelineKey, @provider, @role, @senderId,
          @senderDisplayName, @body, @timestamp, @receivedAt, @agentSessionId,
          @eventJson, @enrichmentStatus, @createdAt, @updatedAt
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
   * Every distinct timeline key known to the store (events or sessions),
   * regardless of lifecycle state. Used by the startup room-label backfill to
   * resolve names for rooms that may currently be idle.
   */
  listKnownTimelineKeys(): string[] {
    return this.read((db) =>
      (
        db
          .prepare(
            `select timeline_key from timeline_events
             union
             select timeline_key from agent_sessions`,
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
          source_kind, preview_index, fetched_at, fetch_status, error, created_at
        ) values (
          @id, @eventId, @context, @url, @title, @description, @siteName,
          @sourceKind, @previewIndex, @fetchedAt, @fetchStatus, @error, @createdAt
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
          source_kind, preview_index, fetched_at, fetch_status, error, created_at
        ) values (
          @id, @eventId, @context, @url, @title, @description, @siteName,
          @sourceKind, @previewIndex, @fetchedAt, @fetchStatus, @error, @createdAt
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
      const rows = db.prepare(
        `select ma.* from media_assets ma
         join timeline_events te on ma.event_id = te.id
         where ma.caption_status = 'pending'
           and ma.download_status = 'complete'
           and ma.media_type in ('image', 'video', 'audio')
           and (te.trigger_group_id is not null or ? = 1 or (te.role = 'assistant' and ? = 1))
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

  updateCaptionResult(assetId: string, caption: string, model: string): Promise<void> {
    return this.write((db) => {
      db.prepare(
        `update media_assets
         set caption = ?, caption_model = ?, caption_status = 'complete', caption_error = null, updated_at = ?
         where id = ?`,
      ).run(caption, model, Date.now(), assetId);
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
          no_reply, created_at, started_at, updated_at
        ) values (
          @id, @timelineKey, @sessionType, @status, @modelId,
          @triggerEventId, @triggerExternalId, @triggerBody,
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
        createdAt: row.createdAt,
        startedAt: row.startedAt ?? null,
        updatedAt: row.updatedAt,
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
   * Startup healing (spec §4): flip any session left mid-flight (`running` or
   * `created`) to `interrupted`, before the provider delivers events. No
   * auto-resume. A session that died while `resuming` (mid auto-resume) is
   * healed to `failed-resumable` instead — its snapshot + transcript are intact,
   * so it stays manually resumable from the console (spec
   * CONCURRENCY-AND-RATE-LIMITING §6.2). Mirrors
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
   * Sessions for a timeline, reverse-chron by creation (spec §8,
   * `GET /api/rooms/:key/sessions`). The `idx_agent_sessions_timeline`
   * index covers this ordering. Read-only.
   */
  getAgentSessionsByTimeline(timelineKey: string, limit = 100): AgentSessionRow[] {
    return this.read((db) =>
      db
        .prepare(
          `select * from agent_sessions
           where timeline_key = ?
           order by created_at desc
           limit ?`,
        )
        .all(timelineKey, limit) as AgentSessionRow[],
    );
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
   * One row per timeline for the console room list (spec §8, `GET /api/rooms`),
   * reverse-chron by latest activity. The anchor set is the UNION of timelines
   * that have `timeline_events` OR have `agent_sessions` rows (issue #6): a
   * timeline whose events were pruned (§13 delete-events / retention sweep) but
   * whose sessions persist must still appear so its sessions stay reachable via
   * room→session drill-down. Session counts and lifecycle state are correlated
   * subqueries; `last_activity_at` is the max event timestamp, falling back to
   * the latest session activity (`max(created_at, updated_at)`) when no events
   * survive, so reverse-chron ordering stays sensible. Pure read.
   */
  listConsoleRooms(limit = 500): RoomSummaryRow[] {
    return this.read((db) =>
      db
        .prepare(
          `select
             tk.timeline_key as timeline_key,
             coalesce(
               (select m.display_name from room_metadata m
                 where m.timeline_key = tk.timeline_key),
               tk.timeline_key
             ) as display_name,
             coalesce(
               (select c.timeline_state from timeline_compaction_state c
                 where c.timeline_key = tk.timeline_key),
               'inactive'
             ) as timeline_state,
             coalesce(
               (select max(te.timestamp) from timeline_events te
                  where te.timeline_key = tk.timeline_key),
               (select max(max(s.created_at, s.updated_at)) from agent_sessions s
                  where s.timeline_key = tk.timeline_key),
               0
             ) as last_activity_at,
             (select count(*) from timeline_events te
                where te.timeline_key = tk.timeline_key) as event_count,
             (select count(*) from agent_sessions s
                where s.timeline_key = tk.timeline_key) as session_count
           from (
             select timeline_key from timeline_events
             union
             select timeline_key from agent_sessions
           ) tk
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
  getPipelineCounts(pool: PipelineId): PipelineCounts {
    const spec = PIPELINE_COUNT_SPECS[pool];
    const where = spec.scope ? `where ${spec.scope}` : "";
    const donePlaceholders = spec.done.map(() => "?").join(", ");
    const sql = `select
        sum(case when ${spec.statusCol} = 'pending' and ${spec.attemptsCol} = 0 then 1 else 0 end) as pending,
        sum(case when ${spec.statusCol} = 'pending' and ${spec.attemptsCol} > 0 then 1 else 0 end) as retrying,
        sum(case when ${spec.statusCol} = 'processing' then 1 else 0 end) as processing,
        sum(case when ${spec.statusCol} in (${donePlaceholders}) then 1 else 0 end) as done,
        sum(case when ${spec.statusCol} = 'failed' then 1 else 0 end) as failed,
        sum(case when ${spec.statusCol} = 'skipped' then 1 else 0 end) as skipped
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
  ): PipelineItemPage {
    const spec = PIPELINE_LIST_SPECS[pool];
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const cursor = decodePipelineCursor(query.cursor);

    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (spec.scope) where.push(spec.scope);
    // `pending`/`retrying` are the two count buckets that share the raw `pending`
    // status (retrying = pending with prior attempts); filter on the same predicate
    // the counts use so a chip's rows match its badge. Any other value is a raw
    // status match.
    if (query.status === "retrying") {
      where.push(`${spec.statusCol} = 'pending' and ${spec.attemptsCol} > 0`);
    } else if (query.status === "pending") {
      where.push(`${spec.statusCol} = 'pending' and ${spec.attemptsCol} = 0`);
    } else if (query.status) {
      where.push(`${spec.statusCol} = @status`);
      params.status = query.status;
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
    const items = pageRows.map((row) => spec.project(row, defaultMaxRetries));
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
  ): PipelineItem | undefined {
    const spec = PIPELINE_LIST_SPECS[pool];
    const where = [spec.scope, `${spec.idCol} = @id`].filter(Boolean).join(" and ");
    const sql = `${spec.selectFrom} where ${where} limit 1`;
    const row = this.read(
      (db) => db.prepare(sql).get({ id }) as Record<string, unknown> | undefined,
    );
    return row ? spec.project(row, defaultMaxRetries) : undefined;
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
-- compared correctly. Changing this DDL means existing DBs that already created the
-- unguarded trigger need the v7->v8 migration to swap it (see MIGRATIONS).
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

// Canonical schema, version 1. This is the COMPLETE current schema with every
// constraint baked in from the start — there is no patch-an-old-DB step (this
// software has never been deployed, so there are no legacy databases to
// migrate). A fresh database executes this block and is stamped
// `user_version = 1` by `runMigrations`. Any future schema change adds an
// ordered step to MIGRATIONS (see below) rather than mutating this block.
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
  created_at integer not null,
  updated_at integer not null,
  -- Generated from event_json so undecryptable (UTD) events are cheaply
  -- queryable by the re-decryption sweeper without scanning every row's JSON.
  -- VIRTUAL (computed on read/index): the partial index below makes lookups
  -- O(matches) without storing a redundant column per row. This column is
  -- created here by the canonical SCHEMA on a fresh DB; no migration ADDs it
  -- (the only generated-column-related migration, v1->v2, adds the separate
  -- redecrypt_attempts column and rebuilds the partial index — see MIGRATIONS).
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
  backfill_fence_timestamp integer,
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
  created_at integer not null
);

create index if not exists idx_link_previews_event
  on link_previews(event_id, context, preview_index);

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
  caption_status text not null default 'pending'
    check(caption_status in ('pending', 'processing', 'complete', 'failed', 'skipped')),
  caption_error text,
  -- Durable caption retry counter (ARCHITECTURE.md §11 pipeline monitor). Mirrors
  -- timeline_events.enrichment_retries / summarization_jobs.attempts /
  -- summaries.diary_attempts: incremented at claim time inside the CAS so "what's
  -- retrying" survives a restart and is visible to the DB-derived pipeline counts
  -- (the captioning pool previously tracked this in-memory only).
  caption_attempts integer not null default 0,
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
  context_snapshot_json text,
  context_dump_path text,
  transcript_json text,
  token_estimate integer,
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
${RETRIEVAL_SCHEMA}
${CHAT_SEARCH_SCHEMA}
${SUMMARY_SEARCH_SCHEMA}
${REACTIONS_SCHEMA}`;

// Latest schema version. SCHEMA above defines version 1 in full; MIGRATIONS
// holds the ordered steps that advance an existing database from one version to
// the next. Bump this (and append a MIGRATIONS entry) whenever the schema
// changes.
export const LATEST_SCHEMA_VERSION = 17;

// Ordered, additive migration steps. The runner's loop consults
// `MIGRATIONS[version]` for each `version` from the DB's current version up to
// LATEST, so the step at index `i` migrates a database at `user_version = i` up
// to `user_version = i + 1`. Fresh DBs are built directly at the latest shape by
// SCHEMA and NEVER run any step (see runMigrations). Each step runs inside the
// version-bump transaction and only ever runs once per DB. To add a future
// migration:
//   1. bump LATEST_SCHEMA_VERSION to N,
//   2. set MIGRATIONS[N-1] to the step that takes a v(N-1) DB to vN,
//   3. update SCHEMA so a fresh DB is created directly at vN.
const MIGRATIONS: Array<((db: Database.Database) => void) | undefined> = [
  // index 0 (v0 -> v1): unused. v1 is the original canonical SCHEMA; there are no
  // real v0 databases (a fresh DB is built at the latest shape and skips steps).
  undefined,
  // index 1 (v1 -> v2): add `redecrypt_attempts` to `timeline_events`
  // (re-decryption give-up counter, issue #1) and rebuild the UTD partial index
  // to carry it. `ALTER TABLE ADD COLUMN` with a NOT NULL default backfills
  // existing rows to 0; dropping/recreating the index picks up the new key
  // column. Fresh DBs get this directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(
      `alter table timeline_events
         add column redecrypt_attempts integer not null default 0;
       drop index if exists idx_timeline_events_undecryptable;
       create index if not exists idx_timeline_events_undecryptable
         on timeline_events(is_undecryptable, redecrypt_attempts, timestamp)
         where is_undecryptable = 1;`,
    );
  },
  // index 2 (v2 -> v3): add the `pending_edits` table that parks edits whose
  // target message hasn't been stored yet, so the append path can replay them
  // once the target lands (issue #12). `create table if not exists` is harmless
  // if a forward path already created it. Fresh DBs get this directly from SCHEMA
  // above and never run this step.
  (db) => {
    db.exec(
      `create table if not exists pending_edits (
         provider text not null,
         target_external_id text not null,
         timeline_key text not null,
         body text not null,
         attachments_json text not null,
         edit_timestamp integer not null,
         created_at integer not null,
         primary key (provider, target_external_id, timeline_key)
       );`,
    );
  },
  // index 3 (v3 -> v4): add `last_edit_timestamp` to `timeline_events`, the
  // origin_server_ts of the most recently applied edit. The edit-application
  // paths use it to enforce latest-by-origin_server_ts wins (issue #3). Nullable
  // with no default: existing rows backfill to NULL ("never edited"), so the next
  // edit always applies. Fresh DBs get this directly from SCHEMA above and never
  // run this step.
  (db) => {
    db.exec(`alter table timeline_events add column last_edit_timestamp integer;`);
  },
  // index 4 (v4 -> v5): add the `agent_sessions` table — the durable session
  // record (spec §3–§5): frozen context snapshot (written once) + appended
  // transcript (flushed at each turn boundary), the status model, and the two
  // lookup indexes (by timeline reverse-chron, and by status for startup
  // healing). `create table/index if not exists` is harmless if a forward path
  // already created it. Fresh DBs get this directly from SCHEMA above and never
  // run this step.
  (db) => {
    db.exec(
      `create table if not exists agent_sessions (
         id text primary key,
         timeline_key text not null,
         session_type text not null default 'default',
         status text not null
           check(status in ('created', 'running', 'completed', 'discarded', 'interrupted', 'suspended')),
         model_id text,
         trigger_event_id text,
         trigger_external_id text,
         trigger_body text,
         context_snapshot_json text,
         context_dump_path text,
         transcript_json text,
         token_estimate integer,
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
         on agent_sessions(status, updated_at desc);`,
    );
  },
  // index 5 (v5 -> v6): add the diary queue columns to `summaries` — `diary_status`
  // (the per-level-1 diary queue: pending/processing/done/skipped/failed, NULL for
  // level 2+) and `diary_attempts` (claim-time retry counter, mirroring
  // summarization_jobs.attempts) — plus the claim index (ARCHITECTURE.md §9c). The
  // ADD COLUMNs are nullable / NOT NULL-with-default so existing rows backfill
  // cleanly (diary_status → NULL = "no diary queued"; diary_attempts → 0). Fresh
  // DBs get this directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(
      `alter table summaries
         add column diary_status text
           check(diary_status in ('pending', 'processing', 'done', 'skipped', 'failed'));
       alter table summaries
         add column diary_attempts integer not null default 0;
       create index if not exists idx_summaries_diary
         on summaries(diary_status, latest_timestamp)
         where diary_status in ('pending', 'processing');`,
    );
  },
  // index 6 (v6 -> v7): add the memory-retrieval index (ARCHITECTURE.md §9d) —
  // `memory_chunks` (+ embed-queue/path indexes), the external-content FTS5 table
  // `memory_chunks_fts` with its sync triggers, `embedding_cache`, and `index_meta`.
  // All plain SQLite + built-in FTS5; the `sqlite-vec` `memory_vec` table is created
  // at runtime (it needs the extension + active-model dim), not here. `create ... if
  // not exists` is harmless if a forward path already created any object. Fresh DBs
  // get this directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(RETRIEVAL_SCHEMA);
  },
  // index 7 (v7 -> v8): re-create the `memory_chunks_au` FTS-sync trigger with a WHEN
  // guard on the indexed columns (review issue #11). The v6->v7 step created the
  // trigger WITHOUT the guard, so its `create trigger if not exists` in RETRIEVAL_SCHEMA
  // is now a no-op for those DBs — they keep the old, unguarded trigger. Drop and
  // recreate it so existing DBs get the guarded version (fresh DBs build it directly
  // from RETRIEVAL_SCHEMA and never run this step). The guard makes embed-queue-only
  // updates (embed_status/model_id/embed_attempts) skip the FTS delete+reinsert; the
  // index stays correct because text/room changes still resync.
  (db) => {
    db.exec(
      `drop trigger if exists memory_chunks_au;
       create trigger memory_chunks_au after update on memory_chunks
         when new.text is not old.text or new.room is not old.room
       begin
         insert into memory_chunks_fts(memory_chunks_fts, rowid, text, room)
           values ('delete', old.rowid, old.text, old.room);
         insert into memory_chunks_fts(rowid, text, room) values (new.rowid, new.text, new.room);
       end;`,
    );
  },
  // index 8 (v8 -> v9): make captioning retry state durable and uniform for the
  // pipeline monitor (ARCHITECTURE.md §11). Add `caption_attempts` (claim-time
  // retry counter, previously in-memory `failureCounts`) and `updated_at`
  // (last-mutated wall clock, sorted on by the monitor) to `media_assets`,
  // backfilling `updated_at` to each row's `created_at`. Add the four per-pool
  // keyset-pagination indexes on (updated_at/latest_timestamp, id). The ADD
  // COLUMNs are NOT NULL-with-default / nullable so existing rows backfill cleanly
  // (caption_attempts → 0; updated_at → created_at). Fresh DBs get all of this
  // directly from SCHEMA above and never run this step.
  (db) => {
    db.exec(
      `alter table media_assets add column caption_attempts integer not null default 0;
       alter table media_assets add column updated_at integer;
       update media_assets set updated_at = created_at where updated_at is null;
       create index if not exists idx_media_assets_updated
         on media_assets(updated_at, id);
       create index if not exists idx_timeline_events_updated
         on timeline_events(updated_at, id);
       create index if not exists idx_summarization_jobs_updated
         on summarization_jobs(updated_at, id);
       create index if not exists idx_summaries_diary_list
         on summaries(latest_timestamp, id)
         where diary_status is not null;`,
    );
  },
  // index 9 (v9 -> v10): add the per-pool status-filtered keyset-pagination indexes
  // (spec §3.4). The v9 step added only (updated_at, id) covering indexes; a
  // status=failed / complete / skipped list (the monitor's "what is failing?" view)
  // had no index for filter+sort and full-scanned the large enrichment/captioning
  // tables. These non-partial composites are ordered to match the keyset sort
  // (status, sort, id) so a status-filtered page reads only its window from the
  // index (review issues #2/#8). These do NOT cover getPipelineCounts, whose
  // pending/retrying split reads the uncovered attempts column (deliberate; the 5s
  // count poll keeps its full scan — see the §11 perf note). diary sorts by
  // latest_timestamp (summaries
  // has no updated_at) and is partial on diary-bearing rows, mirroring
  // idx_summaries_diary_list. All `if not exists`, so a forward path that already
  // created any is harmless. Fresh DBs get these directly from SCHEMA above and
  // never run this step.
  (db) => {
    db.exec(
      `create index if not exists idx_timeline_events_status_updated
         on timeline_events(enrichment_status, updated_at, id);
       create index if not exists idx_media_assets_status_updated
         on media_assets(caption_status, updated_at, id);
       create index if not exists idx_summarization_jobs_status_updated
         on summarization_jobs(status, updated_at, id);
       create index if not exists idx_summaries_diary_status_updated
         on summaries(diary_status, latest_timestamp, id)
         where diary_status is not null;`,
    );
  },
  // index 10 (v10 -> v11): add the `room_metadata` table that caches resolved
  // human room labels (Matrix `m.room.name`/canonical alias, with a parent-space
  // suffix) keyed by timeline_key, so the observability console room list can
  // show real names instead of raw room ids. Populated lazily on inbound
  // activity (and a throttled startup backfill) by RoomLabelCache; read by
  // listConsoleRooms. `create table if not exists` is harmless if a forward path
  // already created it. Fresh DBs get this directly from SCHEMA above and never
  // run this step.
  (db) => {
    db.exec(
      `create table if not exists room_metadata (
         timeline_key text primary key,
         display_name text not null,
         resolved_at integer not null
       );`,
    );
  },
  // index 11 (v11 -> v12): add the chat-history search index (ARCHITECTURE.md §9e) —
  // `chat_index` (the denormalized per-event projection + its room/sender/quoted
  // indexes), `chat_mentions` (denormalized mention lookup), and the external-content
  // FTS5 table `chat_index_fts` with its insert/delete/update sync triggers. All plain
  // SQLite + built-in FTS5. The tables are created EMPTY here; the reconciliation
  // indexer (src/search/) backfills them from existing `timeline_events` on its first
  // startup sweep — identical to how the v7 memory index bootstraps from disk files,
  // so there is no row-level backfill in this step. `create ... if not exists` is
  // harmless if a forward path already created any object. Fresh DBs get all of this
  // directly from SCHEMA above (via CHAT_SEARCH_SCHEMA) and never run this step.
  (db) => {
    db.exec(CHAT_SEARCH_SCHEMA);
  },
  // index 12 (v12 -> v13): add the missing `references timeline_events(id) on
  // delete cascade` FK to `chat_index.event_id` (ARCHITECTURE.md §9e, review #4).
  // The v11->v12 step created `chat_index` WITHOUT the FK, so deleting a
  // timeline_events row (pruneInactiveTimelineEvents / deleteUndecryptedEvent)
  // orphaned its search projection; search_messages then kept surfacing the
  // deleted event from chat_index's own stored body copy until the next startup
  // orphan sweep (a cross-restart privacy/consistency leak). SQLite cannot
  // `ALTER TABLE ADD CONSTRAINT`, so we rebuild the table per SQLite's official
  // table-redefinition procedure (https://sqlite.org/lang_altertable.html):
  //
  //   1. DROP the FTS table + the three sync triggers first. The triggers fire
  //      on every chat_index write; leaving them in place would make the row
  //      copy below double-insert into the FTS shadow. The external-content FTS
  //      keys on chat_index.rowid, so we drop it and fully rebuild it from the
  //      rowid-preserved content table at the end — this is correctness-robust
  //      regardless of any rowid subtlety (chosen over trying to keep the old
  //      FTS rows valid in place).
  //   2. Rename the old table aside, CREATE the new one WITH the FK (identical
  //      columns/constraints/rowid-pk otherwise), and copy every row INCLUDING
  //      the explicit `rowid` so the FTS docid mapping is preserved 1:1.
  //   3. DROP the old table and recreate the indexes + FTS table + triggers
  //      exactly as CHAT_SEARCH_SCHEMA builds them, then `rebuild` the FTS from
  //      the now-FK-bearing content table.
  //
  // This whole step runs inside runMigrations' single wrapping transaction with
  // foreign_keys ON. Per SQLite, foreign_keys cannot be toggled inside a
  // transaction, but `defer_foreign_keys=ON` CAN be — it postpones FK
  // enforcement to the COMMIT at the end of the migration transaction, so the
  // mid-rebuild window (old table dropped, rows being copied) does not trip an
  // FK check; by COMMIT every chat_index row references a live timeline_events
  // row (the indexer only ever projected real events). defer_foreign_keys auto-
  // resets to OFF at the end of the transaction, leaving foreign_keys itself ON.
  // chat_mentions is keyed by event_id (not rowid) and is untouched by the
  // rebuild; its cleanup stays driven by the chat_index_ad trigger. Fresh DBs
  // get the FK directly from SCHEMA (via CHAT_SEARCH_SCHEMA) and never run this.
  (db) => {
    db.exec(
      `pragma defer_foreign_keys = ON;

       -- 0. Purge any already-orphaned rows BEFORE the rebuild. A pre-v13 DB
       -- could hold chat_index rows whose timeline_events were deleted while the
       -- FK was absent (only the startup orphan sweep ever cleaned them). With
       -- the FK now enforced, such orphans would fail the deferred FK check at
       -- this transaction's COMMIT and abort the migration; delete them first so
       -- the copied table is referentially clean. (The chat_index_ad trigger is
       -- still live at this point, so this also drops their FTS + mentions rows.)
       delete from chat_index
         where not exists (select 1 from timeline_events e where e.id = chat_index.event_id);

       -- 1. Drop FTS + sync triggers so the row copy doesn't churn the shadow.
       drop trigger if exists chat_index_ai;
       drop trigger if exists chat_index_ad;
       drop trigger if exists chat_index_au;
       drop table if exists chat_index_fts;

       -- 2. Rebuild chat_index WITH the cascade FK, preserving rowids.
       alter table chat_index rename to chat_index_old;
       create table chat_index (
         rowid               integer primary key autoincrement,
         event_id            text not null unique
                               references timeline_events(id) on delete cascade,
         timeline_key        text not null,
         sender_id           text not null,
         sender_display_name text,
         role                text not null,
         timestamp           integer not null,
         body                text not null default '',
         aux_text            text not null default '',
         has_attachment      integer not null default 0,
         attachment_types    text not null default '',
         has_link            integer not null default 0,
         is_reply            integer not null default 0,
         quoted_sender_id    text,
         content_sig         text not null,
         indexed_at          integer not null
       );
       insert into chat_index
         (rowid, event_id, timeline_key, sender_id, sender_display_name, role,
          timestamp, body, aux_text, has_attachment, attachment_types, has_link,
          is_reply, quoted_sender_id, content_sig, indexed_at)
         select
          rowid, event_id, timeline_key, sender_id, sender_display_name, role,
          timestamp, body, aux_text, has_attachment, attachment_types, has_link,
          is_reply, quoted_sender_id, content_sig, indexed_at
         from chat_index_old;
       drop table chat_index_old;

       -- 3. Recreate indexes + FTS + triggers exactly as CHAT_SEARCH_SCHEMA does,
       -- then fully rebuild the external-content FTS from the copied rows.
       create index if not exists idx_chat_index_room_time on chat_index(timeline_key, timestamp);
       create index if not exists idx_chat_index_sender_time on chat_index(sender_id, timestamp);
       create index if not exists idx_chat_index_quoted on chat_index(quoted_sender_id, timestamp)
         where quoted_sender_id is not null;

       create virtual table chat_index_fts using fts5(
         body, aux_text, content='chat_index', content_rowid='rowid'
       );
       create trigger chat_index_ai after insert on chat_index begin
         insert into chat_index_fts(rowid, body, aux_text) values (new.rowid, new.body, new.aux_text);
       end;
       create trigger chat_index_ad after delete on chat_index begin
         insert into chat_index_fts(chat_index_fts, rowid, body, aux_text)
           values ('delete', old.rowid, old.body, old.aux_text);
         delete from chat_mentions where event_id = old.event_id;
       end;
       create trigger chat_index_au after update on chat_index
         when new.body is not old.body or new.aux_text is not old.aux_text
       begin
         insert into chat_index_fts(chat_index_fts, rowid, body, aux_text)
           values ('delete', old.rowid, old.body, old.aux_text);
         insert into chat_index_fts(rowid, body, aux_text) values (new.rowid, new.body, new.aux_text);
       end;
       insert into chat_index_fts(chat_index_fts) values ('rebuild');`,
    );
  },
  // index 13 (v13 -> v14): add the summary-content search index (ARCHITECTURE.md §9e,
  // "Summary search") — the external-content FTS5 table `summaries_fts` over
  // `summaries.content` plus its insert/delete sync triggers. Unlike the v11->v12
  // chat index (created empty, backfilled by the reconciliation indexer), `summaries`
  // already holds rows, so after creating the FTS table this step **rebuilds** it from
  // the existing content (`insert into summaries_fts(summaries_fts) values ('rebuild')`)
  // so pre-v14 summaries become searchable immediately. There is no update trigger:
  // summary content is immutable after insert (see SUMMARY_SEARCH_SCHEMA). The same
  // constant is interpolated into the base SCHEMA so fresh DBs build it directly;
  // `create ... if not exists` makes the step harmless if a forward path already created
  // any object. Fresh DBs get this directly from SCHEMA and never run this step.
  (db) => {
    db.exec(SUMMARY_SEARCH_SCHEMA);
    db.exec(`insert into summaries_fts(summaries_fts) values ('rebuild');`);
  },
  // index 14 (v14 -> v15): add the `reactions` table — the passive reaction store
  // (ARCHITECTURE.md §6/§9f). A standalone, additive table with no FK
  // (target_event_id is an external Matrix id, not timeline_events.id), so the
  // migration simply re-execs the canonical REACTIONS_SCHEMA, written with
  // `create table/index if not exists` so the fresh-DB and migration paths share one
  // source of truth and cannot drift. The index is the final (target_event_id,
  // reacted_at) shape from the start — reactions are matched by the globally-unique
  // Matrix event id, not timeline_key (a reaction event cannot derive its target's
  // dm/room/thread key). Fresh DBs get it directly from SCHEMA and never run this step.
  (db) => {
    db.exec(REACTIONS_SCHEMA);
  },
  // index 15 (v15 -> v16): add `priority` to `summarization_jobs` — the job-row
  // half of priority inheritance (spec CONCURRENCY-AND-RATE-LIMITING §5.5).
  // `claimNextSummarizationJob` orders by it (class rank desc, then created_at)
  // and `escalateSummarizationJob` raises it when a live context build waits on
  // the job. ADD COLUMN with a NOT NULL default backfills existing rows to
  // 'background' (the universal pre-escalation value). Guarded for idempotence
  // (the ALTER has no IF NOT EXISTS form): skipped when the table is absent —
  // a real pre-v16 DB always has it (base schema since v1), but minimal legacy
  // test fixtures don't, and SCHEMA (which runs after the steps on an existing
  // DB) then creates it directly at the latest shape — or when the column
  // already exists (a forward path added it). Fresh DBs get this directly from
  // SCHEMA above and never run this step.
  (db) => {
    const table = db
      .prepare(`select 1 from sqlite_master where type = 'table' and name = 'summarization_jobs'`)
      .get();
    if (!table) return;
    const columns = db.pragma(`table_info(summarization_jobs)`) as Array<{ name: string }>;
    if (columns.some((column) => column.name === "priority")) return;
    db.exec(
      `alter table summarization_jobs
         add column priority text not null default 'background'
           check(priority in ('interactive', 'proactive', 'background', 'background_low'));`,
    );
  },
  // index 16 (v16 -> v17): widen the `agent_sessions.status` CHECK with the two
  // resume-in-place states (spec CONCURRENCY-AND-RATE-LIMITING §6.2): `resuming`
  // (auto-resume in progress) and `failed-resumable` (parked for a manual
  // console resume). SQLite cannot ALTER a CHECK constraint, so the step follows
  // the standard table-redefinition procedure: rebuild the table with the
  // widened CHECK (identical columns otherwise), copy every row, and recreate
  // the two indexes. No FK references agent_sessions (timeline_events carries a
  // plain agent_session_id text column), so no FK juggling is needed. Skipped
  // when the table is absent (minimal legacy fixtures; SCHEMA, which runs after
  // the steps on an existing DB, then builds it at the latest shape). Fresh DBs
  // get the widened CHECK directly from SCHEMA and never run this step.
  (db) => {
    const table = db
      .prepare(`select 1 from sqlite_master where type = 'table' and name = 'agent_sessions'`)
      .get();
    if (!table) return;
    db.exec(
      `alter table agent_sessions rename to agent_sessions_old;
       create table agent_sessions (
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
         context_snapshot_json text,
         context_dump_path text,
         transcript_json text,
         token_estimate integer,
         no_reply integer not null default 0,
         error text,
         created_at integer not null,
         started_at integer,
         updated_at integer not null,
         completed_at integer
       );
       insert into agent_sessions select * from agent_sessions_old;
       drop table agent_sessions_old;
       create index if not exists idx_agent_sessions_timeline
         on agent_sessions(timeline_key, created_at desc);
       create index if not exists idx_agent_sessions_status
         on agent_sessions(status, updated_at desc);`,
    );
  },
];

// PRAGMA user_version-based migration runner. Runs inside open()'s write
// callback (single-writer queue). Ordering relative to `writer.exec(SCHEMA)`
// differs by case (see Storage.open):
//   - Fresh DB: SCHEMA runs FIRST (builds every table/index at the latest
//     shape), then runMigrations(isFresh=true) only STAMPS the version and
//     applies NO steps. (Running the additive ALTER steps would fail, e.g.
//     "duplicate column", because SCHEMA already added the targeted columns.)
//   - Existing DB: runMigrations runs FIRST (additive ALTERs bring legacy tables
//     up to the current column shape), then SCHEMA runs to create any new
//     tables/indexes. SCHEMA must NOT precede the steps: its latest-shape DDL
//     references columns that only the steps add (e.g. the undecryptable index
//     keys on redecrypt_attempts), so running it against an un-migrated table
//     raises "no such column".
//
//   - Fresh DB (`isFresh`): stamp to LATEST_SCHEMA_VERSION, apply NO steps.
//   - Existing DB at version V < LATEST: apply MIGRATIONS[V], MIGRATIONS[V+1],
//     ... in order, advancing user_version to LATEST.
//   - Existing DB already at LATEST: no steps, idempotent no-op.
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
