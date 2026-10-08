/**
 * Reads and writes of the judged-retrieval tables (src/storage/memory-retrieval-schema.ts;
 * ARCHITECTURE.md §9d, §9c "Memory filters"). A thin layer over `Storage.read` /
 * `Storage.write`, kept out of database.ts so the retrieval code owns its SQL.
 * Every write goes through the single-writer queue.
 */
import type { LexicalHit, Storage } from "./database.js";

/** `agent` column value: `''` stands for legacy single-agent mode. */
export function agentKey(agent: string | null | undefined): string {
  return agent && agent !== "__legacy__" ? agent : "";
}

export interface ChunkMissingProvenance {
  agent: string;
  contentHash: string;
  path: string;
  startLine: number;
  text: string;
}

export interface Level1Range {
  id: string;
  timelineKey: string;
  earliestTimestamp: number;
  latestTimestamp: number;
  diaryStatus: string | null;
  mirroredFrom: string | null;
}

export interface SenderCount {
  provider: string;
  senderId: string;
  count: number;
}

export interface BlockParticipant {
  contentHash: string;
  provider: string;
  senderId: string;
  messageCount: number;
}

export interface FilterVerdictRow {
  contentHash: string;
  filterKey: string;
  filterHash: string;
  probability: number | null;
  hidden: boolean;
  model: string | null;
  servedVersion: string | null;
  evaluatedAt: number;
}

export interface FilterHitInput {
  agent: string | null;
  contentHash: string;
  filterKey: string;
  filterHash: string;
  kind: "keyword" | "pattern" | "judged";
  detail: string | null;
  probability: number | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  surface: string;
  at: number;
}

export interface FilterHitRow {
  agent: string;
  contentHash: string;
  filterKey: string;
  filterHash: string;
  kind: string;
  detail: string | null;
  probability: number | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  surface: string;
  firstHiddenAt: number;
  lastHiddenAt: number;
  hideCount: number;
}

export interface LateVectorRow {
  contentHash: string;
  dtype: "fp16" | "int8";
  dim: number;
  tokenCount: number;
  vectors: Buffer;
  scales: Buffer | null;
}

export interface MemoryRetrievalRowInput {
  id: string;
  agentSessionId: string | null;
  agent: string | null;
  timelineKey: string | null;
  ts: number;
  source: string;
  decisionGroup: string | null;
  candidates: number;
  judged: number;
  kept: number;
  hidden: number;
  tokens: number;
  ms: number;
  reportJson: string | null;
}

export interface MemoryRetrievalRow extends MemoryRetrievalRowInput {
  followUpAt: number | null;
  followUpKind: string | null;
}

export interface FollowUpStats {
  /** Builds that showed at least one memory. */
  sessionsWithBlock: number;
  /** ... of which the session then opened a cited memory or searched memory. */
  followedUp: number;
  rate: number | null;
}

type ChunkRow = LexicalHit;

/**
 * Retry pacing of a failed block in an index without a status column
 * (`memory_index_failures`): never excluded for good, only delayed. The n-th
 * consecutive failure waits `base × 2^(n-1)`, capped at `max`.
 */
export interface IndexRetryPolicy {
  now: number;
  baseMs?: number;
  maxMs?: number;
}

export const INDEX_RETRY_BASE_MS = 60_000;
export const INDEX_RETRY_MAX_MS = 3_600_000;

/** SQL predicate (alias `f` = memory_index_failures): no failure, or its backoff has elapsed. Binds 3 params. */
const RETRY_DUE = `(f.content_hash is null or f.updated_at + min(?, ? * (1 << min(f.attempts - 1, 30))) <= ?)`;

function retryParams(p: IndexRetryPolicy): number[] {
  return [p.maxMs ?? INDEX_RETRY_MAX_MS, p.baseMs ?? INDEX_RETRY_BASE_MS, p.now];
}

const CHUNK_COLUMNS = `c.rowid as rowid, c.id as id, c.path as path, c.start_line as startLine,
  c.end_line as endLine, c.room as room, c.entry_ts as entryTs, c.text as text,
  c.content_hash as contentHash, c.token_count as tokenCount, c.agent as agent, 0 as bm25`;

export interface MemoryRetrievalStoreOptions {
  /** Days `memory_retrievals` rows are kept (0 = forever, default 90); pruned at most hourly, in the background. */
  retrievalsRetentionDays?: number;
}

/** Report items kept in a stored `report_json` (the rest are counted in `itemsOmitted`). */
export const REPORT_MAX_ITEMS = 120;
/** Reports up to this size are stored as they are (no parse). */
const REPORT_PARSE_ABOVE = 48 * 1024;
const PRUNE_EVERY_MS = 3_600_000;
/** `index_meta` key of the sender-name back-fill cursor (the next upper rowid; 0 = done). */
const SENDER_BACKFILL_KEY = "memory_sender_names_backfill";
/** Timeline rows per back-fill batch (a few ms of the writer each). */
const SENDER_BACKFILL_ROWS = 500;
const PRUNE_BATCH = 5000;
/** Distinct display names kept per sender in the history read on every build. */
const NAME_HISTORY_MAX = 6;

/**
 * Bound a build report before it is stored: the kept, hidden and judged items
 * always, then the best-scored others up to {@link REPORT_MAX_ITEMS}; the
 * number left out is recorded as `itemsOmitted`.
 */
export function capReportJson(json: string | null, maxItems = REPORT_MAX_ITEMS): string | null {
  if (json === null || json.length <= REPORT_PARSE_ABOVE) return json;
  let report: { items?: Array<Record<string, unknown>>; itemsOmitted?: number };
  try {
    report = JSON.parse(json) as typeof report;
  } catch {
    return json;
  }
  const items = report.items;
  if (!Array.isArray(items) || items.length <= maxItems) return json;
  const score = (i: Record<string, unknown>): number => {
    const s = (i.scores ?? i) as Record<string, unknown>;
    for (const k of ["rerank", "late", "hybrid"]) if (typeof s[k] === "number") return s[k] as number;
    return -Infinity;
  };
  const must = items.filter((i) => i.stage === "kept" || i.stage === "hidden" || i.judged === true);
  const rest = items.filter((i) => !must.includes(i)).sort((a, b) => score(b) - score(a));
  const kept = [...must, ...rest.slice(0, Math.max(0, maxItems - must.length))];
  const keep = new Set(kept);
  report.items = items.filter((i) => keep.has(i));
  report.itemsOmitted = (report.itemsOmitted ?? 0) + items.length - report.items.length;
  return JSON.stringify(report);
}

export class MemoryRetrievalStore {
  private lastPrune = 0;

  constructor(
    readonly storage: Storage,
    private readonly opts: MemoryRetrievalStoreOptions = {},
  ) {}

  // ── Chunks ────────────────────────────────────────────────────────────────

  /** Chunks by content hash, scoped to an agent (null = legacy / no filter). */
  chunksByContentHashes(hashes: string[], agent: string | null): ChunkRow[] {
    if (hashes.length === 0) return [];
    return this.storage.read((db) => {
      const out: ChunkRow[] = [];
      for (let i = 0; i < hashes.length; i += 500) {
        const slice = hashes.slice(i, i + 500);
        const params: unknown[] = [...slice];
        let agentClause = "";
        if (agent !== null && agent !== "__legacy__") {
          agentClause = " and c.agent = ?";
          params.push(agent);
        }
        out.push(
          ...(db
            .prepare(
              `select ${CHUNK_COLUMNS} from memory_chunks c
               where c.content_hash in (${slice.map(() => "?").join(",")})${agentClause}`,
            )
            .all(...params) as ChunkRow[]),
        );
      }
      return out;
    });
  }

  /** Newest chunks of an agent, newest entry first (the late-interaction window). */
  newestChunks(
    agent: string | null,
    limit: number,
    excludePaths: ReadonlySet<string>,
    accept?: (row: ChunkRow) => boolean,
  ): ChunkRow[] {
    return this.storage.read((db) => {
      const params: unknown[] = [];
      let where = "1 = 1";
      if (agent !== null && agent !== "__legacy__") {
        where = "c.agent = ?";
        params.push(agent);
      }
      const rows: ChunkRow[] = [];
      const stmt = db.prepare(
        `select ${CHUNK_COLUMNS} from memory_chunks c where ${where}
         order by c.entry_ts desc, c.rowid desc limit ? offset ?`,
      );
      const page = 500;
      const seen = new Set<string>();
      for (let offset = 0; rows.length < limit; offset += page) {
        const batch = stmt.all(...params, page, offset) as ChunkRow[];
        if (batch.length === 0) break;
        for (const row of batch) {
          if (excludePaths.has(row.path)) continue;
          if (accept && !accept(row)) continue;
          if (seen.has(row.contentHash)) continue;
          seen.add(row.contentHash);
          rows.push(row);
          if (rows.length >= limit) break;
        }
      }
      return rows;
    });
  }

  /**
   * The late-interaction window's members: the newest `limit` blocks (one per
   * content hash, newest entry first) of an agent that have vectors for
   * `model`, outside `excludePaths`. Narrow rows only, read in keyset pages
   * with a yield to the event loop between pages, so a large window never
   * blocks it for long.
   */
  async newestLateWindow(
    agent: string | null,
    model: string,
    limit: number,
    excludePaths: ReadonlySet<string>,
    page = 500,
  ): Promise<Array<{ contentHash: string; rowid: number }>> {
    // Walks idx_memory_chunks_entry_ts newest first (`+c.agent` keeps the planner off the agent index).
    const agentClause = agent !== null && agent !== "__legacy__" ? "+c.agent = ? and " : "";
    const agentParams: unknown[] = agentClause ? [agent] : [];
    const sql = `select c.rowid as rowid, c.content_hash as contentHash, c.path as path, c.entry_ts as entryTs
       from memory_chunks c
       where ${agentClause}(c.entry_ts, c.rowid) < (?, ?)
         and exists (select 1 from memory_late_vectors v where v.model = ? and v.content_hash = c.content_hash)
       order by c.entry_ts desc, c.rowid desc limit ?`;
    const out: Array<{ contentHash: string; rowid: number }> = [];
    const seen = new Set<string>();
    let cursor = { ts: Number.MAX_SAFE_INTEGER, rowid: Number.MAX_SAFE_INTEGER };
    while (out.length < limit) {
      const batch = this.storage.read(
        (db) =>
          db.prepare(sql).all(...agentParams, cursor.ts, cursor.rowid, model, page) as Array<{
            rowid: number;
            contentHash: string;
            path: string;
            entryTs: number;
          }>,
      );
      if (batch.length === 0) break;
      for (const row of batch) {
        if (excludePaths.has(row.path) || seen.has(row.contentHash)) continue;
        seen.add(row.contentHash);
        out.push({ contentHash: row.contentHash, rowid: row.rowid });
        if (out.length >= limit) break;
      }
      const last = batch[batch.length - 1]!;
      cursor = { ts: last.entryTs, rowid: last.rowid };
      if (batch.length < page) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return out;
  }

  /**
   * One batch of the `memory_sender_names` back-fill over `timeline_events`
   * rows older than its triggers (newest first, `batchRows` rowids per call,
   * its own short write). Returns true once done (or when there is nothing to fill).
   */
  backfillSenderNames(batchRows = SENDER_BACKFILL_ROWS): Promise<boolean> {
    return this.storage.write((db) => {
      const ready = db
        .prepare(`select count(*) as n from sqlite_master where type = 'table' and name in ('timeline_events', 'memory_sender_names')`)
        .get() as { n: number };
      if (ready.n < 2) return true;
      const stored = db.prepare(`select value from index_meta where key = ?`).get(SENDER_BACKFILL_KEY) as { value: string } | undefined;
      const cursor = stored
        ? Number(stored.value)
        : (db.prepare(`select coalesce(max(rowid), 0) as m from timeline_events`).get() as { m: number }).m;
      if (cursor > 0) {
        const lo = Math.max(0, cursor - batchRows);
        db.prepare(
          `insert into memory_sender_names (provider, sender_id, display_name, last_ts)
           select provider, sender_id, sender_display_name, max(timestamp) from timeline_events
           where rowid > ? and rowid <= ? and sender_display_name is not null and sender_display_name != ''
           group by provider, sender_id, sender_display_name
           on conflict(provider, sender_id, display_name) do update set last_ts = max(last_ts, excluded.last_ts)`,
        ).run(lo, cursor);
        db.prepare(`insert into index_meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`).run(
          SENDER_BACKFILL_KEY,
          String(lo),
        );
        return lo === 0;
      }
      if (!stored) db.prepare(`insert into index_meta (key, value) values (?, '0')`).run(SENDER_BACKFILL_KEY);
      return true;
    });
  }

  /** Run {@link backfillSenderNames} to completion in the background, pausing between batches. */
  async runSenderNamesBackfill(opts: { signal?: AbortSignal; pauseMs?: number } = {}): Promise<void> {
    while (!opts.signal?.aborted) {
      if (await this.backfillSenderNames()) return;
      await new Promise((resolve) => setTimeout(resolve, opts.pauseMs ?? 20).unref());
    }
  }

  /** Distinct content hashes of every chunk (any agent). */
  allContentHashes(): Set<string> {
    return this.storage.read((db) => {
      const rows = db.prepare(`select distinct content_hash as h from memory_chunks`).all() as Array<{ h: string }>;
      return new Set(rows.map((r) => r.h));
    });
  }

  // ── Participant tags (§9d "Participant tags") ─────────────────────────────

  /** Chunks with no provenance row yet (the tagger's work queue, oldest first). */
  chunksMissingProvenance(limit: number): ChunkMissingProvenance[] {
    return this.storage.read((db) =>
      db
        .prepare(
          `select coalesce(c.agent, '') as agent, c.content_hash as contentHash, c.path as path,
                  min(c.start_line) as startLine, c.text as text
           from memory_chunks c
           left join memory_block_provenance p
             on p.agent = coalesce(c.agent, '') and p.content_hash = c.content_hash
           where p.content_hash is null
           group by coalesce(c.agent, ''), c.content_hash
           order by min(c.rowid)
           limit ?`,
        )
        .all(limit) as ChunkMissingProvenance[],
    );
  }

  /**
   * The text of the nearest chunk at or above `startLine` in the same file that
   * begins with a diary header: the head window of an oversized block that was
   * sub-split, whose later windows carry no header line of their own.
   */
  headerChunkAbove(agent: string, path: string, startLine: number): string | undefined {
    return this.storage.read((db) => {
      const row = db
        .prepare(
          `select text from memory_chunks
           where coalesce(agent, '') = ? and path = ? and start_line <= ? and text like '## %'
           order by start_line desc limit 1`,
        )
        .get(agent, path, startLine) as { text: string } | undefined;
      return row?.text;
    });
  }

  /** Every level-1 summary range (the provenance join's lookup side). */
  level1Ranges(): Level1Range[] {
    return this.storage.read((db) =>
      db
        .prepare(
          `select id, timeline_key as timelineKey, earliest_timestamp as earliestTimestamp,
                  latest_timestamp as latestTimestamp, diary_status as diaryStatus,
                  mirrored_from as mirroredFrom
           from summaries where level = 1 and status != 'superseded'`,
        )
        .all() as Level1Range[],
    );
  }

  /**
   * Human senders of a summary's source range with message counts: user-role
   * events that are not from a bot or webhook account. Mirrored summaries share
   * their donor's lineage, so a mirror falls back to its donor's events.
   */
  summaryHumanSenders(summaryId: string): SenderCount[] {
    return this.storage.read((db) => {
      const query = db.prepare(
        `select te.provider as provider, te.sender_id as senderId, count(*) as count
         from summary_events se
         join timeline_events te on te.id = se.event_id
         where se.summary_id = ?
           and te.role = 'user'
           and coalesce(te.sender_is_bot, 0) = 0
           and coalesce(te.sender_is_webhook, 0) = 0
         group by te.provider, te.sender_id
         order by count desc`,
      );
      let rows = query.all(summaryId) as SenderCount[];
      if (rows.length === 0) {
        const donor = db.prepare(`select mirrored_from as m from summaries where id = ?`).get(summaryId) as
          | { m: string | null }
          | undefined;
        if (donor?.m) rows = query.all(donor.m) as SenderCount[];
      }
      return rows;
    });
  }

  setProvenance(input: {
    agent: string;
    contentHash: string;
    status: "tagged" | "none" | "ambiguous";
    summaryId: string | null;
    timelineKey: string | null;
    participants: SenderCount[];
    at: number;
  }): Promise<void> {
    return this.storage.readAndWrite((db) => {
      db.prepare(
        `insert into memory_block_provenance (agent, content_hash, status, summary_id, timeline_key, resolved_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(agent, content_hash) do update set status = excluded.status,
           summary_id = excluded.summary_id, timeline_key = excluded.timeline_key,
           resolved_at = excluded.resolved_at`,
      ).run(input.agent, input.contentHash, input.status, input.summaryId, input.timelineKey, input.at);
      db.prepare(`delete from memory_block_participants where agent = ? and content_hash = ?`).run(
        input.agent,
        input.contentHash,
      );
      const ins = db.prepare(
        `insert into memory_block_participants (agent, content_hash, provider, sender_id, message_count)
         values (?, ?, ?, ?, ?)`,
      );
      for (const p of input.participants) ins.run(input.agent, input.contentHash, p.provider, p.senderId, p.count);
    });
  }

  /** Participant tags of some blocks of one agent. */
  participantsOf(agent: string | null, hashes: string[]): BlockParticipant[] {
    if (hashes.length === 0) return [];
    const a = agentKey(agent);
    return this.storage.read((db) => {
      const out: BlockParticipant[] = [];
      for (let i = 0; i < hashes.length; i += 500) {
        const slice = hashes.slice(i, i + 500);
        out.push(
          ...(db
            .prepare(
              `select content_hash as contentHash, provider, sender_id as senderId, message_count as messageCount
               from memory_block_participants
               where agent = ? and content_hash in (${slice.map(() => "?").join(",")})`,
            )
            .all(a, ...slice) as BlockParticipant[]),
        );
      }
      return out;
    });
  }

  /**
   * The presence lane: chunks whose source conversation included one of these
   * senders, newest entry first. `agent` null = legacy mode (all chunks).
   * `offset` pages through the same order (a block tagged with several of the
   * senders appears once per sender).
   */
  chunksWithParticipants(
    agent: string | null,
    senders: Array<{ provider: string; senderId: string }>,
    limit: number,
    offset = 0,
  ): Array<ChunkRow & { senderId: string; messageCount: number }> {
    if (senders.length === 0 || limit <= 0) return [];
    const a = agentKey(agent);
    return this.storage.read((db) => {
      const pairs = senders.map(() => "(p.provider = ? and p.sender_id = ?)").join(" or ");
      const params: unknown[] = [a];
      for (const s of senders) params.push(s.provider, s.senderId);
      const agentClause = a === "" ? "" : " and c.agent = p.agent";
      params.push(limit, Math.max(0, offset));
      return db
        .prepare(
          `select ${CHUNK_COLUMNS}, p.sender_id as senderId, p.message_count as messageCount
           from memory_block_participants p
           join memory_chunks c on c.content_hash = p.content_hash${agentClause}
           where p.agent = ? and (${pairs})
           order by c.entry_ts desc, c.rowid desc, p.provider, p.sender_id
           limit ? offset ?`,
        )
        .all(...params) as Array<ChunkRow & { senderId: string; messageCount: number }>;
    });
  }

  /** Distinct tagged senders of an agent's blocks (user resolution for `recall_memory`). */
  distinctParticipantSenders(agent: string | null): Array<{ provider: string; senderId: string }> {
    const a = agentKey(agent);
    return this.storage.read((db) =>
      db
        .prepare(`select distinct provider, sender_id as senderId from memory_block_participants where agent = ?`)
        .all(a) as Array<{ provider: string; senderId: string }>,
    );
  }

  provenanceCounts(): { tagged: number; none: number; ambiguous: number } {
    return this.storage.read((db) => {
      const rows = db
        .prepare(`select status, count(*) as n from memory_block_provenance group by status`)
        .all() as Array<{ status: string; n: number }>;
      const out = { tagged: 0, none: 0, ambiguous: 0 };
      for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.n;
      return out;
    });
  }

  // ── Display-name history (§9d user lanes) ─────────────────────────────────

  /**
   * Distinct display names a sender id has had in the timeline, newest first
   * (by the last message sent under each name). Excludes `exclude` (the
   * current name) case-insensitively.
   */
  senderDisplayNameHistory(provider: string, senderId: string, limit: number, exclude?: string): string[] {
    if (limit <= 0) return [];
    const skip = exclude?.trim().toLowerCase();
    return this.displayNames(provider, senderId)
      .filter((n) => n.toLowerCase() !== skip)
      .slice(0, limit);
  }

  /**
   * A sender's distinct display names (case-insensitively), newest first, up to
   * {@link NAME_HISTORY_MAX}: a primary-key read of its `memory_sender_names` rows.
   */
  private displayNames(provider: string, senderId: string): string[] {
    return this.storage.read((db) => {
      const rows = db
        .prepare(
          `select display_name as name from memory_sender_names
           where provider = ? and sender_id = ?
           order by last_ts desc
           limit ?`,
        )
        .all(provider, senderId, NAME_HISTORY_MAX * 2) as Array<{ name: string }>;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of rows) {
        const k = r.name.trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(r.name.trim());
        if (out.length >= NAME_HISTORY_MAX) break;
      }
      return out;
    });
  }

  /**
   * Senders that have used this display name (case-insensitive), via
   * `idx_memory_sender_names_name`; at most `limit`.
   */
  sendersByDisplayName(name: string, limit: number): Array<{ provider: string; senderId: string }> {
    const needle = name.trim();
    if (!needle || limit <= 0) return [];
    return this.storage.read((db) =>
      db
        .prepare(
          `select distinct provider, sender_id as senderId
           from memory_sender_names
           where display_name = ? collate nocase
           limit ?`,
        )
        .all(needle, limit) as Array<{ provider: string; senderId: string }>,
    );
  }

  // ── Filter verdicts and hits (§9c "Memory filters") ───────────────────────

  filterVerdicts(agent: string | null, hashes: string[]): FilterVerdictRow[] {
    if (hashes.length === 0) return [];
    const a = agentKey(agent);
    return this.storage.read((db) => {
      const out: FilterVerdictRow[] = [];
      for (let i = 0; i < hashes.length; i += 500) {
        const slice = hashes.slice(i, i + 500);
        const rows = db
          .prepare(
            `select content_hash as contentHash, filter_key as filterKey, filter_hash as filterHash,
                    probability, hidden, model, served_version as servedVersion, evaluated_at as evaluatedAt
             from memory_filter_verdicts
             where agent = ? and content_hash in (${slice.map(() => "?").join(",")})`,
          )
          .all(a, ...slice) as Array<Omit<FilterVerdictRow, "hidden"> & { hidden: number }>;
        for (const r of rows) out.push({ ...r, hidden: r.hidden === 1 });
      }
      return out;
    });
  }

  putFilterVerdicts(agent: string | null, rows: FilterVerdictRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    const a = agentKey(agent);
    return this.storage.readAndWrite((db) => {
      const stmt = db.prepare(
        `insert into memory_filter_verdicts
           (agent, content_hash, filter_key, filter_hash, probability, hidden, model, served_version, evaluated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(agent, content_hash, filter_key) do update set
           filter_hash = excluded.filter_hash, probability = excluded.probability,
           hidden = excluded.hidden, model = excluded.model,
           served_version = excluded.served_version, evaluated_at = excluded.evaluated_at`,
      );
      for (const r of rows) {
        stmt.run(a, r.contentHash, r.filterKey, r.filterHash, r.probability, r.hidden ? 1 : 0, r.model, r.servedVersion, r.evaluatedAt);
      }
    });
  }

  recordFilterHits(hits: FilterHitInput[]): Promise<void> {
    if (hits.length === 0) return Promise.resolve();
    return this.storage.readAndWrite((db) => {
      const stmt = db.prepare(
        `insert into memory_filter_hits
           (agent, content_hash, filter_key, filter_hash, kind, detail, probability, path, start_line, end_line,
            surface, first_hidden_at, last_hidden_at, hide_count)
         values (@agent, @contentHash, @filterKey, @filterHash, @kind, @detail, @probability, @path, @startLine,
                 @endLine, @surface, @at, @at, 1)
         on conflict(agent, content_hash, filter_key) do update set
           filter_hash = excluded.filter_hash, kind = excluded.kind, detail = excluded.detail,
           probability = excluded.probability,
           path = coalesce(excluded.path, memory_filter_hits.path),
           start_line = coalesce(excluded.start_line, memory_filter_hits.start_line),
           end_line = coalesce(excluded.end_line, memory_filter_hits.end_line),
           surface = excluded.surface, last_hidden_at = excluded.last_hidden_at,
           hide_count = memory_filter_hits.hide_count + 1`,
      );
      for (const h of hits) stmt.run({ ...h, agent: agentKey(h.agent) });
    });
  }

  filterHits(opts: { filterKey?: string; limit: number }): FilterHitRow[] {
    return this.storage.read((db) => {
      const where = opts.filterKey ? "where filter_key = ?" : "";
      const params: unknown[] = opts.filterKey ? [opts.filterKey, opts.limit] : [opts.limit];
      return db
        .prepare(
          `select agent, content_hash as contentHash, filter_key as filterKey, filter_hash as filterHash, kind,
                  detail, probability, path, start_line as startLine, end_line as endLine, surface,
                  first_hidden_at as firstHiddenAt, last_hidden_at as lastHiddenAt, hide_count as hideCount
           from memory_filter_hits ${where}
           order by last_hidden_at desc limit ?`,
        )
        .all(...params) as FilterHitRow[];
    });
  }

  // ── Late-interaction vectors (§9d "Late interaction") ─────────────────────

  lateVectors(model: string, hashes: string[]): Map<string, LateVectorRow> {
    const out = new Map<string, LateVectorRow>();
    if (hashes.length === 0) return out;
    this.storage.read((db) => {
      for (let i = 0; i < hashes.length; i += 500) {
        const slice = hashes.slice(i, i + 500);
        const rows = db
          .prepare(
            `select content_hash as contentHash, dtype, dim, token_count as tokenCount, vectors, scales
             from memory_late_vectors where model = ? and content_hash in (${slice.map(() => "?").join(",")})`,
          )
          .all(model, ...slice) as LateVectorRow[];
        for (const r of rows) out.set(r.contentHash, r);
      }
    });
    return out;
  }

  /** Content hashes with late vectors for `model`. */
  lateIndexedHashes(model: string): Set<string> {
    return this.storage.read((db) => {
      const rows = db.prepare(`select content_hash as h from memory_late_vectors where model = ?`).all(model) as Array<{ h: string }>;
      return new Set(rows.map((r) => r.h));
    });
  }

  putLateVectors(model: string, rows: LateVectorRow[], at: number): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    return this.storage.readAndWrite((db) => {
      const stmt = db.prepare(
        `insert or replace into memory_late_vectors
           (model, content_hash, dtype, dim, token_count, vectors, scales, indexed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) stmt.run(model, r.contentHash, r.dtype, r.dim, r.tokenCount, r.vectors, r.scales, at);
    });
  }

  /**
   * Blocks (one per content hash) with no late vectors for `model` whose last
   * failure, if any, has served its backoff ({@link IndexRetryPolicy}), newest
   * entry first: a block leaves the recency layer oldest-first, but new blocks
   * are what keeps the window fresh.
   */
  blocksMissingLateVectors(model: string, indexName: string, retry: IndexRetryPolicy, limit: number): Array<{
    contentHash: string;
    text: string;
  }> {
    return this.storage.read((db) =>
      db
        .prepare(
          `select c.content_hash as contentHash, min(c.text) as text
           from memory_chunks c
           left join memory_late_vectors v on v.model = ? and v.content_hash = c.content_hash
           left join memory_index_failures f on f.index_name = ? and f.content_hash = c.content_hash
           where v.content_hash is null and ${RETRY_DUE}
           group by c.content_hash
           order by max(c.entry_ts) desc
           limit ?`,
        )
        .all(model, indexName, ...retryParams(retry), limit) as Array<{ contentHash: string; text: string }>,
    );
  }

  /** Index lag: blocks without late vectors for `model`, with their paths. */
  lateIndexLag(model: string): Array<{ contentHash: string; path: string; agent: string | null; entryTs: number }> {
    return this.storage.read((db) =>
      db
        .prepare(
          `select c.content_hash as contentHash, c.path as path, c.agent as agent, c.entry_ts as entryTs
           from memory_chunks c
           left join memory_late_vectors v on v.model = ? and v.content_hash = c.content_hash
           where v.content_hash is null`,
        )
        .all(model) as Array<{ contentHash: string; path: string; agent: string | null; entryTs: number }>,
    );
  }

  /**
   * Drop vectors of other models (the index belongs to one model) and of
   * vanished blocks, and the failure rows of other late indexes.
   */
  pruneLateVectors(model: string): Promise<number> {
    return this.storage.write((db) => {
      db.prepare(`delete from memory_index_failures where index_name like 'late:%' and index_name != ?`).run(`late:${model}`);
      const a = db.prepare(`delete from memory_late_vectors where model != ?`).run(model).changes;
      const b = db
        .prepare(
          `delete from memory_late_vectors where model = ?
             and content_hash not in (select content_hash from memory_chunks)`,
        )
        .run(model).changes;
      return a + b;
    });
  }

  // ── Per-index failures ────────────────────────────────────────────────────

  noteIndexFailure(indexName: string, contentHash: string, error: string, at: number): Promise<void> {
    return this.storage.write((db) => {
      db.prepare(
        `insert into memory_index_failures (index_name, content_hash, attempts, last_error, updated_at)
         values (?, ?, 1, ?, ?)
         on conflict(index_name, content_hash) do update set attempts = attempts + 1,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      ).run(indexName, contentHash, error.slice(0, 500), at);
    });
  }

  clearIndexFailures(indexName: string): Promise<void> {
    return this.storage.write((db) => {
      db.prepare(`delete from memory_index_failures where index_name = ?`).run(indexName);
    });
  }

  /** Forget the failures of blocks that have now been indexed. */
  clearIndexFailuresFor(indexName: string, hashes: string[]): Promise<void> {
    if (hashes.length === 0) return Promise.resolve();
    return this.storage.write((db) => {
      const stmt = db.prepare(`delete from memory_index_failures where index_name = ? and content_hash = ?`);
      for (const h of new Set(hashes)) stmt.run(indexName, h);
    });
  }

  /** Failure rows of an index (diagnostics and tests). */
  indexFailureCount(indexName: string): number {
    return this.storage.read(
      (db) => (db.prepare(`select count(*) as n from memory_index_failures where index_name = ?`).get(indexName) as { n: number }).n,
    );
  }

  /**
   * Chunks with no row in the vector table `table` (a `memory_vec_*` vec0 table)
   * whose last failure under `indexName`, if any, has served its backoff.
   */
  chunksMissingFromVectorTable(table: string, indexName: string, retry: IndexRetryPolicy, limit: number): Array<{
    rowid: number;
    contentHash: string;
    text: string;
    source: string;
  }> {
    if (!/^memory_vec_[a-z0-9_]+$/.test(table)) throw new Error(`invalid vector table name ${table}`);
    return this.storage.read((db) =>
      db
        .prepare(
          `select c.rowid as rowid, c.content_hash as contentHash, c.text as text, c.source as source
           from memory_chunks c
           left join memory_index_failures f on f.index_name = ? and f.content_hash = c.content_hash
           where c.rowid not in (select chunk_id from ${table})
             and ${RETRY_DUE}
           order by c.rowid
           limit ?`,
        )
        .all(indexName, ...retryParams(retry), limit) as Array<{ rowid: number; contentHash: string; text: string; source: string }>,
    );
  }

  /** Chunks with no row in the vector table `table`, failed or not (0 = the index covers every chunk). */
  countMissingFromVectorTable(table: string): number {
    if (!/^memory_vec_[a-z0-9_]+$/.test(table)) throw new Error(`invalid vector table name ${table}`);
    return this.storage.read(
      (db) =>
        (db.prepare(`select count(*) as n from memory_chunks c where c.rowid not in (select chunk_id from ${table})`).get() as { n: number })
          .n,
    );
  }

  // ── Per-build retrieval rows (§9d "Observability") ────────────────────────

  /** Store one build row (its report bounded by {@link capReportJson}); prunes expired rows at most hourly. */
  insertRetrieval(row: MemoryRetrievalRowInput): Promise<void> {
    const stored = { ...row, reportJson: capReportJson(row.reportJson) };
    const done = this.storage.write((db) => {
      db.prepare(
        `insert into memory_retrievals (id, agent_session_id, agent, timeline_key, ts, source, decision_group,
           candidates, judged, kept, hidden, tokens, ms, report_json)
         values (@id, @agentSessionId, @agent, @timelineKey, @ts, @source, @decisionGroup,
           @candidates, @judged, @kept, @hidden, @tokens, @ms, @reportJson)
         on conflict(id) do nothing`,
      ).run(stored);
    });
    if (row.ts - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = row.ts;
      void this.pruneRetrievals(row.ts).catch(() => undefined);
    }
    return done;
  }

  /**
   * Delete `memory_retrievals` rows older than the retention (in bounded
   * batches, each its own write, so the writer queue is never held for long).
   * Returns the number deleted.
   */
  async pruneRetrievals(now: number): Promise<number> {
    const days = this.opts.retrievalsRetentionDays ?? 90;
    if (days <= 0) return 0;
    const cutoff = now - days * 86_400_000;
    let total = 0;
    for (;;) {
      const n = await this.storage.write(
        (db) =>
          db
            .prepare(`delete from memory_retrievals where rowid in (select rowid from memory_retrievals where ts < ? limit ?)`)
            .run(cutoff, PRUNE_BATCH).changes,
      );
      total += n;
      if (n < PRUNE_BATCH) return total;
    }
  }

  retrievalsForSession(sessionId: string): MemoryRetrievalRow[] {
    return this.storage.read((db) =>
      db
        .prepare(
          `select id, agent_session_id as agentSessionId, agent, timeline_key as timelineKey, ts, source,
                  decision_group as decisionGroup, candidates, judged, kept, hidden, tokens, ms,
                  report_json as reportJson, follow_up_at as followUpAt, follow_up_kind as followUpKind
           from memory_retrievals where agent_session_id = ? order by ts`,
        )
        .all(sessionId) as MemoryRetrievalRow[],
    );
  }

  /** Record a session's first follow-up on its memory block (idempotent). */
  markFollowUp(sessionId: string, kind: string, at: number): Promise<number> {
    return this.storage.write(
      (db) =>
        db
          .prepare(
            `update memory_retrievals set follow_up_at = ?, follow_up_kind = ?
             where agent_session_id = ? and kept > 0 and follow_up_at is null`,
          )
          .run(at, kind, sessionId).changes,
    );
  }

  /**
   * Builds since `sinceTs` counted by source (model / fallback / unjudged /
   * none); a `model` build that also showed fallback-selected items counts as
   * `model_fallback`.
   */
  sourceCounts(sinceTs: number): Record<string, number> {
    return this.storage.read((db) => {
      const rows = db
        .prepare(
          `select case when source = 'model' and json_valid(report_json) and coalesce(json_extract(report_json, '$.fellBack'), 0) > 0
                       then 'model_fallback' else source end as source,
                  count(*) as n
           from memory_retrievals where ts >= ? group by 1`,
        )
        .all(sinceTs) as Array<{ source: string; n: number }>;
      return Object.fromEntries(rows.map((r) => [r.source, r.n]));
    });
  }

  /** The follow-up rate over builds since `sinceTs` (the before/after metric of spec §9). */
  followUpStats(sinceTs: number, agent?: string | null): FollowUpStats {
    return this.storage.read((db) => {
      const params: unknown[] = [sinceTs];
      let agentClause = "";
      if (agent) {
        agentClause = " and agent = ?";
        params.push(agent);
      }
      const row = db
        .prepare(
          `select count(distinct agent_session_id) as withBlock,
                  count(distinct case when follow_up_at is not null then agent_session_id end) as followed
           from memory_retrievals where ts >= ? and kept > 0 and agent_session_id is not null${agentClause}`,
        )
        .get(...params) as { withBlock: number; followed: number };
      return {
        sessionsWithBlock: row.withBlock,
        followedUp: row.followed,
        rate: row.withBlock > 0 ? row.followed / row.withBlock : null,
      };
    });
  }
}
