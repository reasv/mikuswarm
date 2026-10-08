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
   * false = never call a decision model (a room preview): the selection is
   * unjudged and judged filters fall back to `pending`.
   */
  judge?: boolean;
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
   * Passages that got no model verdict (the chain did not answer, or they were
   * over `auto.max_judged`); they went through the fallback rule.
   */
  unjudged?: number;
  /** Shown items the fallback rule chose (the decision chain did not answer for them). */
  fellBack?: number;
  kept: number;
  hidden: number;
  tokens: number;
  ms: number;
  decisionGroup?: string;
  /** True when the plan was aborted before the build used it: nothing was shown. */
  aborted?: boolean;
  stages: {
    recallMs: number;
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

/** A launch-time plan handed to the session's context build (§9d). */
export interface MemoryPlanTicket {
  plan: Promise<RetrievalPlan | null>;
  /** The longest the build waits for it: the memory point's timeout plus a grace (spec §8). */
  waitMs: number;
  /** The build stopped waiting: the plan is aborted and its block never recorded as shown. */
  abandon(): void;
}
