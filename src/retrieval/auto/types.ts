/**
 * Types of the auto-retrieval pipeline (ARCHITECTURE.md §9d "Judged
 * retrieval"): its input (built at session launch), the per-candidate state it
 * carries through the stages, and the report it logs, persists and shows in
 * the console.
 */
import type { LexicalHit } from "../../storage/database.js";
import type { DecisionAttribution } from "../../decisions/registry.js";
import type { MemoryChatMessage } from "../../decisions/points/memory.js";
import type { MemoryFilterQuestion } from "../../decisions/points/memory.js";
import type { HiddenBy } from "../filters/service.js";

/** One person the user lanes search for. */
export interface PlanParticipant {
  provider: string;
  senderId: string;
  /** Current display name (or username). */
  name: string;
  /** Up to 4 earlier names, newest first (filled by the pipeline when absent). */
  earlierNames?: string[];
  role: "requester" | "reply_author" | "mentioned";
  /** Discord-style username (alias history comes from it). */
  username?: string;
}

export interface PlanInput {
  agentName: string | null;
  timelineKey: string;
  attribution: DecisionAttribution;
  triggerEventId?: string | null;
  /** Proactive session: no request, the conversation stands in for it. */
  proactive: boolean;
  /** Decay anchor: the trigger's timestamp. */
  now: number;
  /** The request (the trigger group's text); absent for proactive. */
  request?: { from: string; text: string; replyTo?: { from: string; text: string } };
  /** The conversation before the request, oldest first (deleted messages as placeholders). */
  conversation: MemoryChatMessage[];
  participants: PlanParticipant[];
  /**
   * Humans active in the conversation for person-cued recall: the participants
   * plus the senders of the last `auto.query_messages` messages.
   */
  activePeople?: Array<{ provider: string; senderId: string; name: string }>;
  signal?: AbortSignal;
  /**
   * Finish now (the build's wait expired): the stages still waiting on a model
   * stop (their requests are aborted) and the plan resolves with what is
   * ready: the judged keepers so far plus the fallback rule over the passages
   * not yet answered, with unscored excerpts. Before the candidate pool exists
   * nothing is ready yet and the plan carries on (the build stops waiting).
   */
  finishNow?: AbortSignal;
  /**
   * The caller records the build (`MemoryRetrievalPipeline.recordBuild`) once
   * its fate is known, instead of the plan recording it when it resolves.
   */
  deferRecord?: boolean;
}

export type CandidateLane = "trigger" | "reply" | "window" | "user_name" | "presence" | "person" | "late_window";

export interface Candidate {
  chunk: LexicalHit;
  /** Best pre-decay hybrid relevance over the lanes (0 for a late-window-only block). */
  hybrid: number;
  /** Best decayed score (ordering). */
  score: number;
  /** Per-lane pre-decay relevance. */
  laneRelevance: Partial<Record<CandidateLane, number>>;
  /** True when the block's provenance tags include a lane participant. */
  presence: boolean;
  /** MaxSim score; null = no vectors (bypasses the late cut); undefined = stage did not run. */
  late?: number | null;
  rerank?: number;
  pendingFilters: MemoryFilterQuestion[];
  hiddenBy?: HiddenBy;
  /** Person-cued: skips the re-rank cuts and goes straight to the judge. */
  personCued?: boolean;
}

export type ItemStage =
  | "kept"
  | "recency"
  | "hidden"
  | "cut_late"
  | "cut_rerank"
  /** Over `auto.max_judged`: never sent to the judge, not shown (a policy cut). */
  | "over_cap"
  | "not_judged"
  | "dropped"
  | "not_selected"
  | "budget"
  /** Would have been shown, but the plan was aborted (session ended, redo, the build stopped waiting). */
  | "aborted";

export interface ReportItem {
  contentHash: string;
  citation: string;
  lanes: CandidateLane[];
  hybrid: number;
  late?: number | null;
  rerank?: number;
  relevant?: number | null;
  aboutParticipant?: number | null;
  presence: boolean;
  stage: ItemStage;
  hiddenBy?: HiddenBy;
  /** True when the memory point answered for this passage. */
  judged?: boolean;
  /**
   * For a kept item: chosen by the judge, by the fallback rule (the decision
   * chain did not answer for it), or by the unjudged selection (no decision model).
   */
  selectedBy?: "judge" | "fallback" | "unjudged";
}

export type RetrievalSource = "model" | "fallback" | "unjudged" | "none";

export interface RetrievalReport {
  source: RetrievalSource;
  /** Why the selection was not the model's (fallback reason, or a disabled judge). */
  reason?: string;
  candidates: number;
  judged: number;
  /**
   * Passages sent to the judge that got no model verdict (the chain did not
   * answer for them); they went through the fallback rule.
   */
  unjudged?: number;
  /** Passages over `auto.max_judged` when some were judged: not sent, not shown. */
  overCap?: number;
  /** Shown items the fallback rule chose (the decision chain did not answer for them). */
  fellBack?: number;
  kept: number;
  hidden: number;
  tokens: number;
  ms: number;
  decisionGroup?: string;
  /** True when the plan was aborted before the build used it: nothing was shown. */
  aborted?: boolean;
  /** True when the build's wait expired and the plan finished with what was ready (`PlanInput.finishNow`). */
  cutShort?: boolean;
  /**
   * How long the context build waited for this plan (ms): the part of the
   * plan's time on the reply's path. Set by the build; absent for a plan no
   * build awaited.
   */
  waitMs?: number;
  stages: {
    recallMs: number;
    /**
     * Recall's sub-steps (ms): the corpus freshness check (once per request),
     * the query embeddings, FTS and the vector half (summed over the queries,
     * which run concurrently), the participants' earlier names, the user
     * lanes, the recency layer's read (concurrent with the queries) and the
     * person-cued pages (after `recallMs`).
     */
    freshMs?: number;
    embedMs?: number;
    lexicalMs?: number;
    vectorMs?: number;
    namesMs?: number;
    lanesMs?: number;
    recencyMs?: number;
    personMs?: number;
    vectorIndex?: string;
    late?: { status: string; backend: string | null; ms: number; windowSize: number; missing: number; queryModel: string | null };
    rerank?: { status: string; provider: string | null; ms: number };
    judgeMs?: number;
  };
  items: ReportItem[];
}

export interface RetrievalPlan {
  /** The `<retrieved_memory>` block, or null when nothing is kept. */
  block: string | null;
  report: RetrievalReport;
}

/**
 * A launch-time plan handed to the session's context build (§9d). Its
 * `memory_retrievals` row is written once, when its fate is known: `confirm`
 * (the kickoff carrying the block was sent) records it as shown; `abandon`
 * before that records it as aborted. Only confirmed builds count as shown.
 */
export interface MemoryPlanTicket {
  plan: Promise<RetrievalPlan | null>;
  /** The longest the build waits for it: the memory point's timeout plus a grace (spec §8). */
  waitMs: number;
  /**
   * The build's wait expired: the plan finishes now with what is ready
   * (`PlanInput.finishNow`), within a short grace; null when nothing is.
   */
  bestEffort(): Promise<RetrievalPlan | null>;
  /** The kickoff carrying the plan's block was sent: its row is recorded as shown (once). */
  confirm(): void;
  /**
   * The build no longer uses the plan (it showed no block, or the session was
   * cancelled, redone or ended): the plan is aborted and, unless confirmed,
   * its row is recorded as aborted. Idempotent.
   */
  abandon(): void;
}
