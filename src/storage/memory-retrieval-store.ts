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

const CHUNK_COLUMNS = `c.rowid as rowid, c.id as id, c.path as path, c.start_line as startLine,
  c.end_line as endLine, c.room as room, c.entry_ts as entryTs, c.text as text,
  c.content_hash as contentHash, c.token_count as tokenCount, c.agent as agent, 0 as bm25`;

export class MemoryRetrievalStore {
  constructor(readonly storage: Storage) {}

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
   */
  chunksWithParticipants(
    agent: string | null,
    senders: Array<{ provider: string; senderId: string }>,
    limit: number,
  ): Array<ChunkRow & { senderId: string; messageCount: number }> {
    if (senders.length === 0 || limit <= 0) return [];
    const a = agentKey(agent);
    return this.storage.read((db) => {
      const pairs = senders.map(() => "(p.provider = ? and p.sender_id = ?)").join(" or ");
      const params: unknown[] = [a];
      for (const s of senders) params.push(s.provider, s.senderId);
      const agentClause = a === "" ? "" : " and c.agent = p.agent";
      params.push(limit);
      return db
        .prepare(
          `select ${CHUNK_COLUMNS}, p.sender_id as senderId, p.message_count as messageCount
           from memory_block_participants p
           join memory_chunks c on c.content_hash = p.content_hash${agentClause}
           where p.agent = ? and (${pairs})
           order by c.entry_ts desc, c.rowid desc
           limit ?`,
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
    return this.storage.read((db) => {
      const rows = db
        .prepare(
          `select sender_display_name as name, max(timestamp) as last
           from timeline_events
           where provider = ? and sender_id = ? and sender_display_name is not null
             and sender_display_name != ''
           group by sender_display_name
           order by last desc
           limit ?`,
        )
        .all(provider, senderId, limit + 1) as Array<{ name: string; last: number }>;
      const skip = exclude?.trim().toLowerCase();
      const seen = new Set<string>();
      const out: string[] = [];
      for (const r of rows) {
        const key = r.name.trim().toLowerCase();
        if (!key || key === skip || seen.has(key)) continue;
        seen.add(key);
        out.push(r.name.trim());
        if (out.length >= limit) break;
      }
      return out;
    });
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
   * Blocks (one per content hash) with no late vectors for `model` and fewer
   * than `maxAttempts` recorded failures, newest entry first: a block leaves the
   * recency layer oldest-first, but new blocks are what keeps the window fresh.
   */
  blocksMissingLateVectors(model: string, indexName: string, maxAttempts: number, limit: number): Array<{
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
           where v.content_hash is null and coalesce(f.attempts, 0) < ?
           group by c.content_hash
           order by max(c.entry_ts) desc
           limit ?`,
        )
        .all(model, indexName, maxAttempts, limit) as Array<{ contentHash: string; text: string }>,
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

  /** Drop vectors of other models (the index belongs to one model) and of vanished blocks. */
  pruneLateVectors(model: string): Promise<number> {
    return this.storage.write((db) => {
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

  /**
   * Chunks with no row in the vector table `table` (a `memory_vec_*` vec0 table)
   * and fewer than `maxAttempts` failures under `indexName`.
   */
  chunksMissingFromVectorTable(table: string, indexName: string, maxAttempts: number, limit: number): Array<{
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
             and coalesce(f.attempts, 0) < ?
           order by c.rowid
           limit ?`,
        )
        .all(indexName, maxAttempts, limit) as Array<{ rowid: number; contentHash: string; text: string; source: string }>,
    );
  }

  // ── Per-build retrieval rows (§9d "Observability") ────────────────────────

  insertRetrieval(row: MemoryRetrievalRowInput): Promise<void> {
    return this.storage.write((db) => {
      db.prepare(
        `insert into memory_retrievals (id, agent_session_id, agent, timeline_key, ts, source, decision_group,
           candidates, judged, kept, hidden, tokens, ms, report_json)
         values (@id, @agentSessionId, @agent, @timelineKey, @ts, @source, @decisionGroup,
           @candidates, @judged, @kept, @hidden, @tokens, @ms, @reportJson)
         on conflict(id) do nothing`,
      ).run(row);
    });
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
