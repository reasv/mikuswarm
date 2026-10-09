/**
 * The auto-retrieval pipeline (ARCHITECTURE.md §9d "Judged retrieval"):
 *
 *   wide recall (three queries + user lanes, fused, ~60 blocks)
 *   ─► recency-layer and filter exclusions
 *   ─► late interaction (exhaustive recent window + re-score of the rest) ─► top_n
 *   ─► cross-encoder ─► top_n
 *   ─► the `memory` decision point (one passage per request): orders and vetoes
 *      (`judge_mode = "order"`), or is the final filter (`"filter"`)
 *   ─► excerpts ─► `<retrieved_memory>` (0..N items within a token budget)
 *
 * Every stage is optional and degrades in order: no late interaction → the
 * cross-encoder sees the recall set; no cross-encoder → the late top 8 (or the
 * hybrid top 12) go to the decision model; no decision model → the last
 * scorer's calibrated cutoff; none → the hybrid ranking with the fallback
 * floor. Started at session launch, in parallel with routing; the context
 * build awaits the plan when it assembles the final user turn.
 */
import { nanoid } from "nanoid";
import type { Logger } from "../../observability/logger.js";
import type { DecisionEngine } from "../../decisions/registry.js";
import { DEFAULT_MEMORY_CONVERSATION_MESSAGES, DEFAULT_TIMEOUT_MS, memoryPointKnobs, pointSettings } from "../../decisions/config.js";
import type { PriorityClass } from "../../agent/scheduler.js";
import { memoryPoint, type MemoryPassageVerdict } from "../../decisions/points/memory.js";
import type { LexicalHit } from "../../storage/database.js";
import type { MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import { estimateTokens } from "../../context/tokens.js";
import { agentDateStamp } from "../../time/index.js";
import { JUDGED_AFTER_HYBRID, JUDGED_AFTER_LATE, type ResolvedRetrievalConfig } from "../config.js";
import { cleanBlockText, escapeAngleBrackets, formatCitation, indentContinuation, makeExcerpt, queryTerms } from "../excerpt.js";
import type { FilterBlock, MemoryFilterService } from "../filters/service.js";
import type { LateStage, LateOutcome } from "../late/stage.js";
import type { ProviderChain } from "../models/chain.js";
import type { RerankProvider } from "../models/types.js";
import type { MemorySearch, ScoredChunk, SearchTimings } from "../search.js";
import { dayFromFilename } from "../chunk.js";
import { parseDiaryHeaderLine } from "../participants.js";
import type {
  Candidate,
  CandidateLane,
  ItemStage,
  PlanInput,
  PlanParticipant,
  ReportItem,
  RetrievalPlan,
  RetrievalReport,
  RetrievalSource,
} from "./types.js";

export const JUDGED_NOTE =
  "Memories from your diary, judged relevant to this conversation. Read-only; open a cited " +
  "file:lines with your read tools for the full entry.";
export const ORDERED_NOTE =
  "Memories from your diary that may bear on this conversation or the people in it, most " +
  "relevant first. Read-only; open a cited file:lines with your read tools for the full entry.";
export const UNJUDGED_NOTE =
  "Past diary entries that may bear on this conversation. Read-only; open a cited file:lines " +
  "with your read tools for the full entry.";

/** Conversation tail joined to the request for the cross-encoder query. */
const RERANK_TAIL_MESSAGES = 3;

/**
 * `judge_mode = "order"`: a judged passage is left out only when the judge
 * answers no on both axes (`relevant` and `about_participant` below this).
 * It is the yes/no boundary of a `noul` answer, not a tuned threshold.
 */
const ORDER_VETO = 0.5;

/**
 * The cross-encoder's query (`[retrieval.rerank].query`). `"request"`: the
 * trigger text (its grouped parts) and the reply target's text, each prefixed by
 * its speaker as the memory point's state names them. `"conversation"`: that
 * plus the last few messages. With no request (proactive) both use the
 * conversation form. Clipped to `maxChars`.
 */
export function rerankQuery(input: PlanInput, mode: "request" | "conversation", maxChars: number): string {
  const request = input.request;
  const requestText = request?.text.trim() ?? "";
  const replyText = request?.replyTo?.text.trim() ?? "";
  const lines: string[] = [];
  if (mode === "request" && requestText) {
    lines.push(`${request!.from}: ${requestText}`);
    if (replyText) lines.push(`(replying to ${request!.replyTo!.from}: ${replyText})`);
  } else {
    if (requestText) lines.push(`${request!.from}: ${requestText}`);
    if (replyText) lines.push(`(replying to ${request!.replyTo!.from}: ${replyText})`);
    for (const m of input.conversation.slice(-RERANK_TAIL_MESSAGES)) lines.push(`${m.from}: ${m.text}`);
  }
  return lines.filter(Boolean).join("\n").slice(0, maxChars);
}

/**
 * Memory-point requests (and the judged filters riding with an unjudged
 * selection) queue below routing, records and the send/ending checks, which
 * run at `interactive` in the same `decision:<model>` group: the build needs
 * the memory block last, so it never delays them.
 */
export const MEMORY_PRIORITY: PriorityClass = "proactive";

/**
 * Priority only orders the queue: memory judging (a dozen requests per build)
 * could still hold every slot of the group. Its requests count against a
 * capped share (`auto.judge_slot_share` of `max_in_flight`), so the other
 * decision points always find a free slot.
 */
export const MEMORY_SLOT_SHARE = "memory";

/** Added to the memory point's timeout for the build's wait (recall and the re-rank stages run first). */
export const PLAN_WAIT_GRACE_MS = 1500;

/**
 * How long a build whose wait expired gives a plan told to finish now
 * (`PlanInput.finishNow`): enough for the selection and packing, which no
 * longer wait on any model.
 */
export const BEST_EFFORT_GRACE_MS = 1000;

/** Tagged rows read per person (and for the presence lane) while paging past the recency layer. */
const MAX_PARTICIPANT_ROWS = 200;

/** Excerpt embeds in flight at once. */
const EXCERPT_CONCURRENCY = 4;

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** `p`, or an AbortError as soon as `signal` aborts (a hung dependency cannot hold the plan). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Map with at most `limit` calls in flight, results in input order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface MemoryRetrievalPipelineDeps {
  search: MemorySearch;
  store: MemoryRetrievalStore;
  config: ResolvedRetrievalConfig;
  filters?: MemoryFilterService;
  engine?: () => DecisionEngine | undefined;
  late?: LateStage;
  rerank?: ProviderChain<RerankProvider>;
  /** The recency layer's text for an agent at `now` (blocks shown there are excluded). */
  recencyContent?: (
    agent: string | null,
    timelineKey: string,
    now: number,
    attribution: PlanInput["attribution"],
  ) => Promise<string | null>;
  /** Earlier names of a participant (Discord username aliases); display-name history is built in. */
  usernameAliases?: (provider: string, senderId: string, limit: number) => string[];
  logger?: Logger;
  now?: () => number;
}

/** Rounds the recall sub-step timings of a report's stages; returns them for the build log. */
function recallSubSteps(stages: RetrievalReport["stages"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of RECALL_SUB_STEPS) {
    const v = stages[key];
    if (v !== undefined) out[key] = stages[key] = Math.round(v);
  }
  return out;
}

const RECALL_SUB_STEPS = ["freshMs", "embedMs", "lexicalMs", "vectorMs", "namesMs", "lanesMs", "recencyMs", "personMs"] as const;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function entryTsOf(chunk: LexicalHit): number | null {
  if (parseDiaryHeaderLine(chunk.text)) return chunk.entryTs;
  const base = chunk.path.split("/").pop() ?? chunk.path;
  return dayFromFilename(base) ? chunk.entryTs : null;
}

function filterBlockOf(chunk: LexicalHit): FilterBlock {
  return {
    contentHash: chunk.contentHash,
    text: chunk.text,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    room: chunk.room,
    entryTs: entryTsOf(chunk),
  };
}

export class MemoryRetrievalPipeline {
  constructor(private readonly deps: MemoryRetrievalPipelineDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether the memory point judges this agent's retrieval. */
  judgeOn(agent: string | null): boolean {
    return this.deps.config.auto.judge && (this.deps.engine?.()?.isEnabled("memory", agent) ?? false);
  }

  /**
   * How long a context build waits for a launch-time plan (spec §8): the
   * memory point's timeout (default the global `[decisions].timeout_ms`) plus
   * a small grace for recall and the re-rank stages.
   */
  waitBudgetMs(agent: string | null): number {
    const raw = this.deps.engine?.()?.raw(agent);
    const timeout = (raw && pointSettings(raw, "memory")?.timeoutMs) ?? raw?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    return timeout + PLAN_WAIT_GRACE_MS;
  }

  /** The newest recorded build of a timeline (counts only), or null; never throws. */
  latestForTimeline(timelineKey: string): { ts: number; source: string; kept: number; tokens: number } | null {
    try {
      return this.deps.store.latestRetrievalForTimeline(timelineKey);
    } catch {
      return null;
    }
  }

  /**
   * Tagged rows of `senders`, newest first, paging past the rows `visit`
   * rejects (blocks in the recency layer) until it says stop or
   * {@link MAX_PARTICIPANT_ROWS} rows were read.
   */
  private pageParticipantRows(
    agent: string | null,
    senders: Array<{ provider: string; senderId: string }>,
    pageSize: number,
    visit: (row: ReturnType<MemoryRetrievalStore["chunksWithParticipants"]>[number]) => "stop" | "next",
  ): void {
    if (senders.length === 0 || pageSize <= 0) return;
    for (let offset = 0; offset < MAX_PARTICIPANT_ROWS; offset += pageSize) {
      const rows = this.deps.store.chunksWithParticipants(agent, senders, pageSize, offset);
      for (const row of rows) if (visit(row) === "stop") return;
      if (rows.length < pageSize) return;
    }
  }

  /** Participant names for the lanes: current plus up to 4 earlier, newest first. */
  private namesOf(p: PlanParticipant): string[] {
    const names = [p.name];
    let earlier = p.earlierNames;
    if (!earlier) {
      earlier = p.username && this.deps.usernameAliases
        ? this.deps.usernameAliases(p.provider, p.senderId, 4)
        : this.deps.store.senderDisplayNameHistory(p.provider, p.senderId, 4, p.name);
    }
    for (const n of earlier) if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    return names.slice(0, 5);
  }

  async plan(input: PlanInput): Promise<RetrievalPlan> {
    const started = this.now();
    const cfg = this.deps.config;
    const auto = cfg.auto;
    const agent = input.agentName === "__legacy__" ? null : input.agentName;
    const report: RetrievalReport = {
      source: "none",
      candidates: 0,
      judged: 0,
      kept: 0,
      hidden: 0,
      tokens: 0,
      ms: 0,
      stages: { recallMs: 0 },
      items: [],
    };
    const itemStage = new Map<string, ItemStage>();
    /** Items the fallback rule selected (never a model verdict). */
    const fallbackSelected = new Set<string>();
    const verdicts = new Map<string, MemoryPassageVerdict>();
    const aborted = () => input.signal?.aborted === true;
    // Told to finish now (the build's wait expired): the stages still waiting on
    // a model stop, and the plan uses what is ready (see PlanInput.finishNow).
    const cut = () => input.finishNow?.aborted === true;
    const stageSignal =
      input.finishNow && input.signal ? AbortSignal.any([input.signal, input.finishNow]) : (input.finishNow ?? input.signal);

    // ── 1. Wide recall ────────────────────────────────────────────────────
    const requestText = input.request?.text.trim() ?? "";
    const replyText = input.request?.replyTo?.text.trim() ?? "";
    const windowText = input.conversation
      .slice(-auto.queryMessages)
      .map((m) => m.text)
      .join("\n")
      .trim();
    const queries: Array<{ lane: CandidateLane; text: string; semanticOnly?: boolean }> = [];
    if (requestText) queries.push({ lane: "trigger", text: requestText });
    if (requestText && replyText) queries.push({ lane: "reply", text: `${requestText}\n${replyText}` });
    if (windowText) queries.push({ lane: "window", text: windowText, semanticOnly: requestText.length > 0 });

    // The recency layer's text (its blocks are already in context): started now,
    // in parallel with recall.
    const stages = report.stages;
    const clock = () => this.now();
    const recencyStarted = clock();
    const recencyPromise = (
      auto.dedupAgainstRecency && this.deps.recencyContent
        ? this.deps.recencyContent(agent, input.timelineKey, input.now, input.attribution).catch(() => null)
        : Promise.resolve(null)
    ).finally(() => {
      stages.recencyMs = clock() - recencyStarted;
    });
    const participants = input.participants;
    let t0 = clock();
    const laneNames = [...new Set(participants.flatMap((p) => this.namesOf(p)))];
    stages.namesMs = clock() - t0;
    // One corpus freshness check for every search of this request.
    t0 = clock();
    try {
      await this.deps.search.ensureFresh?.();
    } catch {
      // a failed check leaves the index as it stands (as each search would)
    }
    stages.freshMs = clock() - t0;
    const searchOpts = { limit: auto.candidates, minScore: auto.candidateMinScore, now: input.now, agentName: agent, fresh: true };
    // Per-query sub-step timings, summed over the queries (they run concurrently).
    const addTimings = (t: SearchTimings | undefined) => {
      if (!t) return;
      stages.embedMs = (stages.embedMs ?? 0) + t.embedMs;
      stages.lexicalMs = (stages.lexicalMs ?? 0) + t.lexicalMs;
      stages.vectorMs = (stages.vectorMs ?? 0) + t.vectorMs;
    };
    let nameLane: Promise<ScoredChunk[]> = Promise.resolve([]);
    if (auto.userLane.enabled && laneNames.length > 0 && auto.userLaneCandidates > 0) {
      // Synchronous with `fresh` (FTS only): timed here, not by when it settles.
      t0 = clock();
      nameLane = this.deps.search
        .userLaneScored({
          names: laneNames,
          maxResults: auto.userLaneCandidates * 3,
          minScore: auto.userLane.minScore,
          prefixEnabled: auto.userLane.prefixEnabled,
          prefixMinChars: auto.userLane.prefixMinChars,
          now: input.now,
          agentName: agent,
          fresh: true,
        })
        .catch(() => [] as ScoredChunk[]);
      stages.lanesMs = clock() - t0;
    }
    const [laneResults, nameHits] = await Promise.all([
      Promise.all(
        queries.map((q) =>
          this.deps.search
            .searchScored({ ...searchOpts, query: q.text, semanticOnly: q.semanticOnly, signal: input.signal })
            .then((r) => {
              addTimings(r.timings);
              return r;
            })
            .catch(() => ({ scored: [] as ScoredChunk[], mode: "lexical" as const, degraded: true, vectorIndex: undefined })),
        ),
      ),
      nameLane,
    ]);
    report.stages.vectorIndex = laneResults.find((r) => r.vectorIndex)?.vectorIndex;

    // The recency layer (its blocks are already in context).
    const recency = await recencyPromise;
    const recencyNorm = recency ? norm(recency) : null;
    const inRecency = (text: string) => {
      if (!recencyNorm) return false;
      const probe = norm(cleanBlockText(text).lines.join(" ")).slice(0, 60);
      return probe.length >= 12 && recencyNorm.includes(probe);
    };

    // The presence lane: the newest blocks tagged with a participant, paging
    // past the recency layer so an active person's older entries are reached.
    const presenceRows: LexicalHit[] = [];
    t0 = clock();
    if (auto.userLane.enabled && participants.length > 0 && auto.userLaneCandidates > 0) {
      const want = auto.userLaneCandidates * 3;
      const seen = new Set<number>();
      this.pageParticipantRows(
        agent,
        participants.map((p) => ({ provider: p.provider, senderId: p.senderId })),
        want + 10,
        (row) => {
          if (seen.has(row.rowid) || inRecency(row.text)) return "next";
          seen.add(row.rowid);
          presenceRows.push(row);
          return presenceRows.length >= want ? "stop" : "next";
        },
      );
    }

    const byRow = new Map<number, Candidate>();
    const add = (hit: LexicalHit, lane: CandidateLane, relevance: number, score: number) => {
      const c = byRow.get(hit.rowid);
      if (!c) {
        byRow.set(hit.rowid, { chunk: hit, hybrid: relevance, score, laneRelevance: { [lane]: relevance }, presence: false, pendingFilters: [] });
        return;
      }
      c.hybrid = Math.max(c.hybrid, relevance);
      c.score = Math.max(c.score, score);
      c.laneRelevance[lane] = Math.max(c.laneRelevance[lane] ?? 0, relevance);
    };
    laneResults.forEach((r, i) => {
      for (const s of r.scored) add(s, queries[i]!.lane, s.relevance, s.score);
    });
    // User lanes: presence (provenance tags) and name matches share the reserved
    // slots. Ranked by the request's similarity when it has content, by recency
    // otherwise (a bare "hey" has nothing to match).
    const halfLife = cfg.query.temporalDecayHalfLifeDays;
    const decayOf = (ts: number) =>
      cfg.query.temporalDecayEnabled ? Math.pow(2, -Math.max(0, (input.now - ts) / 86_400_000) / halfLife) : 1;
    const laneRows = new Map<number, LexicalHit>();
    for (const row of presenceRows) {
      add(row, "presence", auto.candidateMinScore, auto.candidateMinScore * decayOf(row.entryTs));
      laneRows.set(row.rowid, row);
    }
    for (const s of nameHits) {
      add(s, "user_name", s.relevance, s.score);
      laneRows.set(s.rowid, s);
    }
    const laneQuery = requestText || (input.proactive ? "" : windowText);
    let laneSimilarity: Map<number, number> | null = null;
    if (laneRows.size > 0 && queryTerms([laneQuery]).length > 0) {
      const scoped = await this.deps.search
        .searchScored({ query: laneQuery, limit: laneRows.size, minScore: 0, now: input.now, agentName: agent, rowidScope: [...laneRows.keys()], signal: input.signal, fresh: true })
        .catch(() => null);
      if (scoped) laneSimilarity = new Map(scoped.scored.map((x) => [x.rowid, x.relevance]));
    }
    // The user lanes: the name search (concurrent with the queries), the
    // presence pages and the lane ranking.
    stages.lanesMs = (stages.lanesMs ?? 0) + (clock() - t0);
    const laneOrder = [...laneRows.values()].sort((a, b) =>
      laneSimilarity
        ? (laneSimilarity.get(b.rowid) ?? 0) - (laneSimilarity.get(a.rowid) ?? 0) || b.entryTs - a.entryTs
        : b.entryTs - a.entryTs,
    );
    const reservedSet = new Set(laneOrder.slice(0, auto.userLaneCandidates).map((r) => r.rowid));
    const topical = [...byRow.values()].filter((c) => !reservedSet.has(c.chunk.rowid)).sort((a, b) => b.score - a.score);
    let pool: Candidate[] = [
      ...[...reservedSet].map((r) => byRow.get(r)!),
      ...topical.slice(0, Math.max(0, auto.candidates - reservedSet.size)),
    ];
    report.stages.recallMs = this.now() - started;

    // Presence tags of a lane participant (near-tie breaker, never a slot).
    const markPresence = (list: Candidate[]) => {
      if (participants.length === 0 || list.length === 0) return;
      const ids = new Set(participants.map((p) => `${p.provider}\0${p.senderId}`));
      const tagged = new Set(
        this.deps.store
          .participantsOf(agent, list.map((c) => c.chunk.contentHash))
          .filter((t) => ids.has(`${t.provider}\0${t.senderId}`))
          .map((t) => t.contentHash),
      );
      for (const c of list) if (tagged.has(c.chunk.contentHash)) c.presence = true;
    };

    // ── 2. Exclusions: the recency layer and operator filters ─────────────
    const exclude = (list: Candidate[]): Candidate[] => {
      const out: Candidate[] = [];
      const states = this.deps.filters?.classify(agent, list.map((c) => filterBlockOf(c.chunk)));
      for (const c of list) {
        if (inRecency(c.chunk.text)) {
          itemStage.set(c.chunk.contentHash, "recency");
          continue;
        }
        const st = states?.get(c.chunk.contentHash);
        if (st?.hidden) {
          c.hiddenBy = st.hiddenBy;
          itemStage.set(c.chunk.contentHash, "hidden");
          continue;
        }
        c.pendingFilters = st?.pendingJudged ?? [];
        out.push(c);
      }
      return out;
    };
    const all = new Map<string, Candidate>(pool.map((c) => [c.chunk.contentHash, c]));
    pool = exclude(dedupeByHash(pool));

    // Person-cued recall (§9d): for each human active in the conversation, the
    // newest tagged entries they took part in, outside the recency layer. No text
    // match needed; they skip the re-rank cuts and go straight to the judge.
    const personCued: Candidate[] = [];
    /** A person-cued candidate's place among that person's entries (0 = newest). */
    const cuedRank = new Map<Candidate, number>();
    t0 = clock();
    if (auto.personRecent > 0 && auto.personRecentMax > 0) {
      const taken = new Set<string>();
      for (const person of input.activePeople ?? []) {
        if (personCued.length >= auto.personRecentMax) break;
        let n = 0;
        this.pageParticipantRows(agent, [{ provider: person.provider, senderId: person.senderId }], auto.personRecent + 10, (row) => {
          if (n >= auto.personRecent || personCued.length >= auto.personRecentMax) return "stop";
          if (taken.has(row.contentHash)) return "next";
          taken.add(row.contentHash);
          const existing = all.get(row.contentHash);
          // Presence (the near-tie bonus) is a participant's tag only: set by
          // markPresence below, never for being active in the window.
          const c: Candidate = existing ?? {
            chunk: row,
            hybrid: 0,
            score: 0,
            laneRelevance: {},
            presence: false,
            pendingFilters: [],
          };
          c.laneRelevance.person = c.laneRelevance.person ?? 0;
          if (!existing) all.set(row.contentHash, c);
          if (itemStage.get(row.contentHash) === "recency" || itemStage.get(row.contentHash) === "hidden") return "next";
          const kept = existing && pool.includes(existing) ? [existing] : exclude([c]);
          if (kept.length === 0) {
            // A recency-layer block is not a candidate at all: no report item.
            if (!existing && itemStage.get(row.contentHash) === "recency") {
              all.delete(row.contentHash);
              itemStage.delete(row.contentHash);
            }
            return "next";
          }
          kept[0]!.personCued = true;
          personCued.push(kept[0]!);
          cuedRank.set(kept[0]!, n);
          n += 1;
          return n >= auto.personRecent || personCued.length >= auto.personRecentMax ? "stop" : "next";
        });
      }
      pool = pool.filter((c) => !c.personCued);
      stages.personMs = clock() - t0;
    }

    // ── 3. Late interaction ───────────────────────────────────────────────
    let lateRan = false;
    let lateQueryModel: string | null = null;
    if (this.deps.late && cfg.late.enabled) {
      const lateQuery = [requestText, replyText].filter(Boolean).join("\n") || windowText;
      const out: LateOutcome = await this.deps.late.score({
        agent,
        queryText: lateQuery,
        candidates: pool.map((c) => ({ contentHash: c.chunk.contentHash })),
        signal: stageSignal,
      });
      report.stages.late = {
        status: out.status,
        backend: out.backend,
        ms: out.ms,
        windowSize: out.windowSize,
        missing: out.missing,
        queryModel: out.queryModel,
      };
      if (out.status === "ok") {
        lateRan = true;
        lateQueryModel = out.queryModel;
        // Merge the exhaustive branch's blocks into the pool.
        const extra: Candidate[] = [];
        const have = new Set(pool.map((c) => c.chunk.contentHash));
        for (const row of out.windowChunks) {
          if (have.has(row.contentHash) || itemStage.has(row.contentHash)) continue;
          const c: Candidate = { chunk: row, hybrid: 0, score: 0, laneRelevance: { late_window: 0 }, presence: false, pendingFilters: [] };
          extra.push(c);
          all.set(row.contentHash, c);
        }
        pool = [...pool, ...exclude(extra)];
        for (const c of pool) c.late = out.scores.get(c.chunk.contentHash) ?? null;
        const scored = pool.filter((c) => c.late !== null).sort((a, b) => b.late! - a.late!);
        // Only blocks with no vectors bypass the cut; anything else left unscored is cut.
        const noVectors = new Set(out.missingHashes);
        const missing = pool.filter((c) => c.late === null && noVectors.has(c.chunk.contentHash));
        const kept = scored.slice(0, cfg.late.topN);
        for (const c of scored.slice(cfg.late.topN)) itemStage.set(c.chunk.contentHash, "cut_late");
        for (const c of pool) if (c.late === null && !noVectors.has(c.chunk.contentHash)) itemStage.set(c.chunk.contentHash, "cut_late");
        pool = [...kept, ...missing];
      }
    }

    // ── 4. Cross-encoder ──────────────────────────────────────────────────
    let rerankRan = false;
    let rerankCutoff: number | undefined;
    // Order mode: the person-cued passages are scored too (never cut by it), so
    // every passage the selection orders has a cross-encoder score.
    const toScore = auto.judgeMode === "order" ? [...pool, ...personCued] : pool;
    if (this.deps.rerank && cfg.rerank.enabled && toScore.length > 0 && !aborted() && !cut()) {
      const q = rerankQuery(input, cfg.rerank.query, cfg.rerank.queryMaxChars);
      const t0 = this.now();
      try {
        const docs = toScore.map((c) => cleanBlockText(c.chunk.text).lines.join("\n"));
        const res = await this.deps.rerank.run((p, s) => p.score(q, docs, s), { signal: stageSignal });
        rerankRan = true;
        rerankCutoff = cfg.rerank.providers[res.provider.name]?.minScore;
        toScore.forEach((c, i) => (c.rerank = res.value[i]));
        pool.sort((a, b) => b.rerank! - a.rerank!);
        for (const c of pool.slice(cfg.rerank.topN)) itemStage.set(c.chunk.contentHash, "cut_rerank");
        pool = pool.slice(0, cfg.rerank.topN);
        report.stages.rerank = { status: "ok", provider: res.provider.name, ms: this.now() - t0 };
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        report.stages.rerank = { status: cut() ? "cut_short" : aborted ? "aborted" : "unavailable", provider: null, ms: this.now() - t0 };
      }
    }
    // Without a cross-encoder: the late top 8 (missing-vector blocks bypass), or the hybrid top 12.
    if (!rerankRan) {
      if (lateRan) {
        const scored = pool.filter((c) => c.late !== null);
        const missing = pool.filter((c) => c.late === null).sort((a, b) => b.score - a.score);
        const head = scored.slice(0, JUDGED_AFTER_LATE);
        pool = [...head, ...missing].slice(0, Math.max(JUDGED_AFTER_HYBRID, head.length));
      } else {
        pool = [...pool].sort((a, b) => b.score - a.score).slice(0, JUDGED_AFTER_HYBRID);
      }
    }
    // Person-cued candidates join after the cuts.
    const ranked = pool;
    // Each person's newest entry before anyone's second one, so a cut keeps
    // every active person's latest.
    const cued = personCued
      .filter((c) => !ranked.includes(c))
      .map((c, i) => ({ c, i, rank: cuedRank.get(c) ?? 0 }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.c);
    pool = [...ranked, ...cued];
    markPresence(pool);
    // At most `max_judged` passages go to the judge, person-cued included (a
    // third of the cap is theirs when the ranked passages would fill it, more
    // when those are fewer). The cap is a policy cut, not a failure: the passages
    // over it (the lowest-ranked ones and the latest-cued ones) are not judged
    // and not shown (stage `over_cap`), unless the whole chain fails (below).
    const maxJudged = Math.max(0, auto.maxJudged);
    const cuedSlots = Math.min(cued.length, Math.max(Math.ceil(maxJudged / 3), maxJudged - ranked.length));
    const toJudge = [...ranked.slice(0, maxJudged - cuedSlots), ...cued.slice(0, cuedSlots)];
    const sent = new Set(toJudge);

    // ── 5. The decision model as the final filter ─────────────────────────
    let selected: Candidate[] = [];
    let source: RetrievalSource;
    const judge = this.judgeOn(agent);
    const engine = this.deps.engine?.();
    if (aborted()) {
      source = "none";
    } else if (judge && engine && pool.length > 0) {
      const t0 = this.now();
      const decisionGroup = nanoid();
      report.decisionGroup = decisionGroup;
      const knobs = memoryPointKnobs(engine.raw(agent));
      const conversation = input.conversation.slice(-(knobs.conversationMessages ?? DEFAULT_MEMORY_CONVERSATION_MESSAGES));
      // On finish-now, unanswered passages count as not judged (the fallback
      // rule), and their requests are aborted, freeing the group's slots.
      const judgedOutcomes = await Promise.all(
        toJudge.map((c) => {
          if (cut()) return Promise.resolve(undefined);
          const outcome = engine.evaluate(
            memoryPoint,
            {
              conversation,
              ...(input.request
                ? {
                    request: {
                      from: input.request.from,
                      text: input.request.text,
                      ...(input.request.replyTo ? { reply_to: input.request.replyTo } : {}),
                    },
                  }
                : {}),
              participants: laneNames,
              passage: {
                date: agentDateStamp(c.chunk.entryTs),
                room: c.chunk.room,
                text: cleanBlockText(c.chunk.text).lines.join("\n"),
              },
              filters: c.pendingFilters,
              meta: {
                citation: formatCitation(c.chunk),
                contentHash: c.chunk.contentHash,
                scores: { hybrid: round3(c.hybrid), late: c.late === undefined || c.late === null ? null : round3(c.late), rerank: c.rerank === undefined ? null : round3(c.rerank) },
              },
            },
            {
              agentName: agent,
              attribution: input.attribution,
              priority: MEMORY_PRIORITY,
              share: { name: MEMORY_SLOT_SHARE, fraction: auto.judgeSlotShare },
              signal: stageSignal,
              decisionGroup,
              triggerEventId: input.triggerEventId ?? null,
            },
          );
          return untilAborted(outcome, input.finishNow).catch(() => undefined);
        }),
      );
      report.stages.judgeMs = this.now() - t0;
      const byCandidate = new Map(toJudge.map((c, i) => [c, judgedOutcomes[i]]));
      let modelVerdicts = 0;
      for (const c of toJudge) {
        const o = byCandidate.get(c);
        if (o?.source !== "model") continue;
        modelVerdicts += 1;
        verdicts.set(c.chunk.contentHash, o.verdict);
        if (Object.keys(o.verdict.filters).length > 0) {
          void this.deps.filters?.storeVerdicts(agent, c.chunk.contentHash, o.verdict.filters, { model: o.servedModel ?? null, version: null });
          for (const [key, r] of Object.entries(o.verdict.filters)) {
            if (r.hidden && !c.hiddenBy) c.hiddenBy = { key, kind: "judged", probability: r.probability };
          }
        }
      }
      // Pending judged filters (`pending = "hide"`) on what may still be shown:
      // the sent passages without a verdict, and every passage when none was judged.
      const hidePending = this.deps.filters?.pendingPolicy(agent) === "hide";
      for (const c of pool) {
        if (verdicts.has(c.chunk.contentHash) || c.pendingFilters.length === 0 || !hidePending) continue;
        if (modelVerdicts > 0 && !sent.has(c)) continue;
        c.hiddenBy = { key: c.pendingFilters[0]!.key, kind: "judged", pending: true };
      }
      report.judged = modelVerdicts;
      const failReason = () => {
        const reasons = judgedOutcomes.map((o) => o?.reason).filter(Boolean);
        return cut() ? "wait_budget" : (reasons[0] ?? (toJudge.length === 0 ? "max_judged" : "error"));
      };
      if (auto.judgeMode === "order") {
        // The judge orders and vetoes; it does not gate (§9d "Judge mode").
        // With verdicts: the sent passages; with none (the chain did not
        // answer): every passage, over-cap ones included, unvetoed.
        source = modelVerdicts > 0 ? "model" : "fallback";
        if (modelVerdicts === 0) report.reason = failReason();
        const vetoed = (c: Candidate) => {
          const v = verdicts.get(c.chunk.contentHash);
          return v !== undefined && (v.relevant ?? 0) < ORDER_VETO && (v.aboutParticipant ?? 0) < ORDER_VETO;
        };
        const eligible: Candidate[] = [];
        for (const c of pool) {
          if (c.hiddenBy) itemStage.set(c.chunk.contentHash, "hidden");
          else if (modelVerdicts > 0 && !sent.has(c)) itemStage.set(c.chunk.contentHash, "over_cap");
          else if (vetoed(c)) itemStage.set(c.chunk.contentHash, "dropped");
          else eligible.push(c);
        }
        if (modelVerdicts > 0) {
          const overCap = pool.length - sent.size;
          if (overCap > 0) report.overCap = overCap;
          const unjudged = toJudge.filter((c) => !verdicts.has(c.chunk.contentHash) && !c.hiddenBy).length;
          if (unjudged > 0) report.unjudged = unjudged;
        }
        // Excerpts are made only for what can still fit.
        selected = orderRanked(eligible, verdicts).slice(0, auto.maxResults * 2);
        for (const c of selected) if (!verdicts.has(c.chunk.contentHash)) fallbackSelected.add(c.chunk.contentHash);
      } else if (modelVerdicts > 0) {
        source = "model";
        const keptList = pool.filter((c) => verdicts.get(c.chunk.contentHash)?.keep && !c.hiddenBy);
        for (const c of pool) {
          if (!sent.has(c)) itemStage.set(c.chunk.contentHash, "over_cap");
          else if (c.hiddenBy) itemStage.set(c.chunk.contentHash, "hidden");
          else if (!verdicts.has(c.chunk.contentHash)) itemStage.set(c.chunk.contentHash, "not_judged");
          else if (!verdicts.get(c.chunk.contentHash)!.keep) itemStage.set(c.chunk.contentHash, "dropped");
        }
        const overCap = pool.length - sent.size;
        if (overCap > 0) report.overCap = overCap;
        // Passages sent to the judge that got no verdict (group capacity, the
        // point's timeout, a failed request, the build's wait expiring) are not
        // dropped: they go through the fallback rule (the last scorer's
        // calibrated cutoff, else the hybrid floor), at most
        // `fallback_max_results` of them, after the judged keepers. Passages
        // over the cap were never sent and are not shown.
        const unjudged = toJudge.filter((c) => !verdicts.has(c.chunk.contentHash) && !c.hiddenBy);
        const rescued = this.selectWithoutJudge(unjudged, {
          cap: auto.fallbackMaxResults,
          rerankRan,
          rerankCutoff,
          lateRan,
          lateQueryModel,
          legacy: false,
        });
        for (const c of rescued) fallbackSelected.add(c.chunk.contentHash);
        if (unjudged.length > 0) report.unjudged = unjudged.length;
        selected = [...orderJudged(keptList, verdicts), ...rescued];
      } else {
        source = "fallback";
        report.reason = failReason();
        for (const c of pool) if (c.hiddenBy) itemStage.set(c.chunk.contentHash, "hidden");
        selected = this.selectWithoutJudge(pool.filter((c) => !c.hiddenBy), {
          cap: auto.fallbackMaxResults,
          rerankRan,
          rerankCutoff,
          lateRan,
          lateQueryModel,
          legacy: false,
        });
        for (const c of selected) fallbackSelected.add(c.chunk.contentHash);
      }
    } else {
      source = pool.length > 0 ? "unjudged" : "none";
      report.reason = !auto.judge ? "judge_off" : "no_decision_model";
      selected = this.selectWithoutJudge(pool, { cap: auto.maxResults, rerankRan, rerankCutoff, lateRan, lateQueryModel, legacy: true });
      // Judged filters still apply to what is shown: judged now (bounded), or `pending`.
      const pending = selected.filter((c) => c.pendingFilters.length > 0);
      if (pending.length > 0 && this.deps.filters) {
        const filters = this.deps.filters;
        const states = cut()
          ? null
          : await untilAborted(
              filters.enforce(agent, pending.map((c) => filterBlockOf(c.chunk)), {
                surface: "auto_retrieval",
                attribution: input.attribution,
                priority: MEMORY_PRIORITY,
                share: { name: MEMORY_SLOT_SHARE, fraction: auto.judgeSlotShare },
                signal: stageSignal,
              }),
              input.finishNow,
            ).catch((error: unknown) => {
              if (!cut()) throw error;
              return null;
            });
        for (const c of pending) {
          // Finished now before the filters were judged: the `pending` policy applies.
          const st = states
            ? states.get(c.chunk.contentHash)
            : (() => {
                const p = { hidden: false, pendingJudged: c.pendingFilters } as { hidden: boolean; hiddenBy?: Candidate["hiddenBy"]; pendingJudged: Candidate["pendingFilters"] };
                filters.applyPending(agent, p);
                return p;
              })();
          if (st?.hidden) {
            c.hiddenBy = st.hiddenBy;
            itemStage.set(c.chunk.contentHash, "hidden");
          }
        }
        selected = selected.filter((c) => !c.hiddenBy);
      }
    }
    for (const c of pool) if (!itemStage.has(c.chunk.contentHash) && !selected.includes(c)) itemStage.set(c.chunk.contentHash, "not_selected");

    // ── 6. Excerpts and packing ───────────────────────────────────────────
    // The judged note only when every shown item was judged.
    const note =
      judge && auto.judgeMode === "order" && source !== "none"
        ? ORDERED_NOTE
        : source === "model" && !selected.some((c) => fallbackSelected.has(c.chunk.contentHash))
          ? JUDGED_NOTE
          : UNJUDGED_NOTE;
    const wrapper = `<retrieved_memory note="${note}">\n</retrieved_memory>`;
    let budget = auto.maxTokens - estimateTokens(wrapper);
    const lines: string[] = [];
    const excerptQueries = [requestText, replyText].filter(Boolean);
    if (excerptQueries.length === 0 && windowText) excerptQueries.push(windowText);
    // Excerpt embeds run concurrently (bounded) and stop with the plan.
    const scorer = this.deps.search.unitScorer;
    const excerptQuery = excerptQueries.join("\n");
    const excerpts = aborted()
      ? []
      : await mapBounded(selected, EXCERPT_CONCURRENCY, (c) =>
          makeExcerpt(c.chunk.text, {
            queries: excerptQueries,
            budget: { tokens: auto.excerptMaxTokens },
            // Finishing now: unscored excerpts (no embed wait).
            ...(scorer && excerptQueries.length > 0 && !cut()
              ? { scoreUnits: (units: string[]) => untilAborted(scorer(excerptQuery, units, input.signal), stageSignal) }
              : {}),
          }),
        );
    selected.forEach((c, i) => {
      if (aborted()) return;
      if (lines.length >= auto.maxResults) {
        itemStage.set(c.chunk.contentHash, "budget");
        return;
      }
      const line = `- [${citationLabel(c.chunk)}] ${indentContinuation(escapeAngleBrackets(excerpts[i] ?? ""))}`;
      const cost = estimateTokens(line) + 1;
      if (cost > budget) {
        itemStage.set(c.chunk.contentHash, "budget");
        return;
      }
      budget -= cost;
      lines.push(line);
      itemStage.set(c.chunk.contentHash, "kept");
    });
    // An aborted plan (the session ended, a redo replaced it, or the build
    // stopped waiting) shows nothing: what it would have kept is recorded as
    // `aborted`, never as shown.
    if (aborted()) {
      lines.length = 0;
      for (const [hash, stage] of itemStage) if (stage === "kept") itemStage.set(hash, "aborted");
      for (const c of selected) if (!itemStage.has(c.chunk.contentHash)) itemStage.set(c.chunk.contentHash, "aborted");
      report.aborted = true;
      report.reason = "aborted";
    }
    const block = lines.length > 0 ? `<retrieved_memory note="${note}">\n${lines.join("\n")}\n</retrieved_memory>` : null;
    if (cut() && !aborted()) report.cutShort = true;

    // ── 7. Report ─────────────────────────────────────────────────────────
    report.source = lines.length > 0 || source !== "none" ? source : "none";
    report.candidates = all.size;
    report.kept = lines.length;
    report.tokens = block ? estimateTokens(block) : 0;
    report.items = [...all.values()].map((c) => {
      const v = verdicts.get(c.chunk.contentHash);
      const item: ReportItem = {
        contentHash: c.chunk.contentHash,
        citation: formatCitation(c.chunk),
        lanes: Object.keys(c.laneRelevance) as CandidateLane[],
        hybrid: round3(c.hybrid),
        presence: c.presence,
        stage: itemStage.get(c.chunk.contentHash) ?? "not_selected",
      };
      if (c.late !== undefined) item.late = c.late === null ? null : round3(c.late);
      if (c.rerank !== undefined) item.rerank = round3(c.rerank);
      item.judged = v !== undefined;
      if (v) {
        item.relevant = v.relevant;
        item.aboutParticipant = v.aboutParticipant;
      }
      if (item.stage === "kept") item.selectedBy = fallbackSelected.has(c.chunk.contentHash) ? "fallback" : v ? "judge" : "unjudged";
      if (c.hiddenBy) item.hiddenBy = c.hiddenBy;
      return item;
    });
    report.hidden = report.items.filter((i) => i.stage === "hidden").length;
    const fellBack = report.items.filter((i) => i.selectedBy === "fallback").length;
    if (fellBack > 0) report.fellBack = fellBack;
    report.ms = this.now() - started;
    const subSteps = recallSubSteps(report.stages);
    this.deps.logger?.info("memory_retrieval", {
      agent: agent ?? undefined,
      timelineKey: input.timelineKey,
      sessionId: input.attribution.agentSessionId ?? undefined,
      candidates: report.candidates,
      judged: report.judged,
      ...(report.unjudged ? { unjudged: report.unjudged } : {}),
      ...(report.overCap ? { overCap: report.overCap } : {}),
      fellBack: report.fellBack ?? 0,
      kept: report.kept,
      hidden: report.hidden,
      tokens: report.tokens,
      source: report.source,
      ...(report.reason ? { reason: report.reason } : {}),
      ...(report.cutShort ? { cutShort: true } : {}),
      ms: report.ms,
      recallMs: report.stages.recallMs,
      ...subSteps,
      ...(report.stages.late ? { late: report.stages.late.status, lateMs: report.stages.late.ms } : {}),
      ...(report.stages.rerank ? { rerank: report.stages.rerank.status, rerankMs: report.stages.rerank.ms } : {}),
      ...(report.stages.judgeMs !== undefined ? { judgeMs: report.stages.judgeMs } : {}),
    });
    if (report.hidden > 0 && this.deps.filters) {
      this.deps.filters.recordAndLog(
        agent,
        [...all.values()].filter((c) => c.hiddenBy).map((c) => filterBlockOf(c.chunk)),
        new Map([...all.values()].filter((c) => c.hiddenBy).map((c) => [c.chunk.contentHash, { hidden: true, hiddenBy: c.hiddenBy, pendingJudged: [] }])),
        "auto_retrieval",
      );
    }
    if (input.attribution.agentSessionId && !input.deferRecord) {
      this.recordBuild(report, { agentSessionId: input.attribution.agentSessionId, agent, timelineKey: input.timelineKey });
    }
    return { block, report };
  }

  /**
   * Store a build's `memory_retrievals` row (best-effort, never rejects). A
   * live session's plan defers it (`PlanInput.deferRecord`) to the moment its
   * fate is known: shown when the kickoff carrying the block is sent, else
   * recorded as aborted ({@link abortedReport}).
   */
  recordBuild(report: RetrievalReport, who: { agentSessionId: string; agent: string | null; timelineKey: string }): void {
    void this.deps.store
      .insertRetrieval({
        id: nanoid(),
        agentSessionId: who.agentSessionId,
        agent: who.agent === "__legacy__" ? null : who.agent,
        timelineKey: who.timelineKey,
        ts: this.now(),
        source: report.source,
        decisionGroup: report.decisionGroup ?? null,
        candidates: report.candidates,
        judged: report.judged,
        kept: report.kept,
        hidden: report.hidden,
        tokens: report.tokens,
        ms: report.ms,
        reportJson: JSON.stringify(report),
      })
      .catch((error) =>
        this.deps.logger?.warn("memory_retrieval_persist_failed", { error: error instanceof Error ? error.message : String(error) }),
      );
  }

  /**
   * Selection without a decision model (§9d): the last scorer's calibrated
   * cutoff (cross-encoder, else late interaction); else, for the fallback,
   * the hybrid ranking above `fallback_min_score`; else (no decision model
   * configured) today's two-lane selection: topical hits above `min_score`
   * plus the reserved user-lane hits.
   */
  private selectWithoutJudge(
    pool: Candidate[],
    opts: { cap: number; rerankRan: boolean; rerankCutoff?: number; lateRan: boolean; lateQueryModel: string | null; legacy: boolean },
  ): Candidate[] {
    const auto = this.deps.config.auto;
    if (opts.cap <= 0) return [];
    if (opts.rerankRan && opts.rerankCutoff !== undefined) {
      return pool.filter((c) => (c.rerank ?? -Infinity) >= opts.rerankCutoff!).sort((a, b) => b.rerank! - a.rerank!).slice(0, opts.cap);
    }
    const lateCutoff = this.deps.late?.cutoff(opts.lateQueryModel);
    if (opts.lateRan && lateCutoff !== undefined) {
      return pool.filter((c) => c.late !== null && c.late !== undefined && c.late >= lateCutoff).sort((a, b) => b.late! - a.late!).slice(0, opts.cap);
    }
    if (!opts.legacy) {
      return pool.filter((c) => c.hybrid >= auto.fallbackMinScore).sort((a, b) => b.score - a.score).slice(0, opts.cap);
    }
    // Today's behaviour: user lane first (reserved), then topical.
    const user = pool
      .filter((c) => (c.laneRelevance.user_name ?? -1) >= auto.userLane.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, auto.userLane.maxResults);
    const topical = pool
      .filter((c) => !user.includes(c))
      .filter((c) => Math.max(c.laneRelevance.trigger ?? 0, c.laneRelevance.reply ?? 0, c.laneRelevance.window ?? 0) >= auto.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.cap);
    return [...user, ...topical];
  }
}

/**
 * The citation as shown inside `<retrieved_memory>`: a room label is diary
 * text, so angle brackets are neutralized and line breaks flattened.
 */
/**
 * A resolved plan's report as never shown (the build that used it was
 * cancelled, redone or discarded before its kickoff was sent): what it kept is
 * recorded as `aborted`, and it counts as no shown block.
 */
export function abortedReport(report: RetrievalReport): RetrievalReport {
  return {
    ...report,
    aborted: true,
    reason: "aborted",
    kept: 0,
    tokens: 0,
    items: report.items.map((i) => {
      if (i.stage !== "kept") return i;
      const { selectedBy: _selectedBy, ...rest } = i;
      return { ...rest, stage: "aborted" as const };
    }),
  };
}

export function citationLabel(chunk: LexicalHit): string {
  return escapeAngleBrackets(formatCitation(chunk)).replace(/[\r\n]+/g, " ");
}

function dedupeByHash(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    if (seen.has(c.chunk.contentHash)) continue;
    seen.add(c.chunk.contentHash);
    out.push(c);
  }
  return out;
}

/**
 * Kept passages ordered by `relevant`; a participant tie (about_participant ≥
 * 0.5 or a provenance tag of a lane participant) only breaks near-ties (within
 * 0.1) and never outranks a clearly more relevant passage; then the
 * cross-encoder score, then the late score, then the hybrid score.
 */
export function orderJudged(list: Candidate[], verdicts: Map<string, MemoryPassageVerdict>): Candidate[] {
  const key = (c: Candidate) => {
    const v = verdicts.get(c.chunk.contentHash)!;
    const tied = (v.aboutParticipant ?? 0) >= 0.5 || c.presence;
    return (v.relevant ?? 0) + (tied ? 0.0999 : 0);
  };
  return [...list].sort(
    (a, b) =>
      key(b) - key(a) ||
      (b.rerank ?? -Infinity) - (a.rerank ?? -Infinity) ||
      (b.late ?? -Infinity) - (a.late ?? -Infinity) ||
      b.score - a.score,
  );
}

/**
 * `judge_mode = "order"`: the passages the judge kept (`relevant ≥
 * relevance_threshold`) first, in {@link orderJudged} order; then the rest
 * (judged or not) by the cross-encoder, then the late, then the hybrid score.
 */
export function orderRanked(list: Candidate[], verdicts: Map<string, MemoryPassageVerdict>): Candidate[] {
  const promoted = list.filter((c) => verdicts.get(c.chunk.contentHash)?.keep === true);
  const rest = list
    .filter((c) => !promoted.includes(c))
    .sort(
      (a, b) =>
        (b.rerank ?? -Infinity) - (a.rerank ?? -Infinity) ||
        (b.late ?? -Infinity) - (a.late ?? -Infinity) ||
        b.score - a.score,
    );
  return [...orderJudged(promoted, verdicts), ...rest];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
