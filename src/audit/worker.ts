/**
 * The offline audit worker (spec REFUSAL-HANDLING §7.6, §10.2; DECISION-MODEL
 * §5.8): reads completed sessions and runs the decision-model diagnosis nothing
 * waits on, live and over the whole history.
 *
 * - **Queue.** Sessions with no `session_audits` row (since they last completed)
 *   for an enabled audit, not mid-run, not a generation session type
 *   (summarize/condense/diary), settled for `settle_ms`. Two lanes: sessions
 *   settled since the worker started, newest first (live, every audit), then the
 *   backlog, oldest first through a `(created_at, id)` keyset cursor, paced by
 *   `backlog_pace_ms` and bounded by `audit_backlog_max_age_ms`. The backlog walks
 *   three stages in order ({@link BACKLOG_STAGES}): the send-contract audit of the
 *   sessions with nudges or a no_reply ending, then the refusal check pass of
 *   those sessions, then every other session.
 * - **Claiming** is in memory (one process): a claimed or deferred session is
 *   never handed to a second worker.
 * - **Audits.** `send_contract` (src/audit/contract-audit.ts) for sessions whose
 *   contract record is derived: the diagnosis of every nudged run plus the judged
 *   `contract` checks of `check_kinds` over the session's endings (`no_reply`
 *   intent); `refusal` (src/audit/check-audit.ts), the judged checks of the other
 *   kinds over the session's sends and endings, for nudged sessions and a seeded
 *   sample (`sample_clean_sessions`) of clean ones.
 * - **Unauditable.** A session without a readable transcript gets an
 *   `unauditable` row per pending audit and is never retried.
 * - **Never blocks anything.** Calls run at `background` priority under the
 *   `audit` point (its own chain and timeout), billed to the `audit` ledger class
 *   (never a payee). While `shouldPause()` reports the audit budget blocked, or
 *   after a call fell back for budget, the worker stops claiming.
 * - **Retries.** A session whose calls fell back for a transient reason
 *   (unavailable, timeout, error) keeps no row for that audit and is retried
 *   later (backoff); after `max_retries` it is marked `failed`.
 */
import { nanoid } from "nanoid";
import type { AppConfig } from "../config/index.js";
import { contractBranchesOf } from "../agent/contract-store.js";
import { SYNTHETIC_SESSION_TYPES } from "../agent/recovery.js";
import { sessionTasks } from "../behaviour/rollups.js";
import { CheckEvaluator } from "../checks/evaluator.js";
import type { StateMessage } from "../checks/state.js";
import type { CheckCatalogue, CheckKind } from "../checks/types.js";
import { decisionsFor } from "../decisions/config.js";
import type { DecisionEngine } from "../decisions/registry.js";
import type { DecisionAnswers } from "../decisions/types.js";
import type { Logger } from "../observability/index.js";
import type {
  AuditCandidateRow,
  AuditQueueAudit,
  ContractAttemptTypesUpdate,
  SessionAuditInsert,
  Storage,
} from "../storage/index.js";
import { auditSessionChecks, RETRYABLE_REASONS } from "./check-audit.js";
import {
  AUDIT_VERSION,
  auditKnobs,
  DEFAULT_AUDIT_TIMEOUT_MS,
  inSample,
  type AuditKnobs,
  type AuditName,
} from "./config.js";
import { contractAuditPoint, diagnoseRun, planRun, type RunAttempt, type RunDiagnosis } from "./contract-audit.js";
import { checkItems, contractRuns, parseTranscript } from "./transcript.js";
import { AuditProgressCounter } from "./progress.js";
import type { AuditBacklogProgress } from "../behaviour/types.js";

/** Poll interval when there is nothing to audit. */
const DEFAULT_IDLE_MS = 30_000;
/** How long the worker stops claiming after a budget stop. */
const BUDGET_PAUSE_MS = 60_000;
/** First retry delay of a deferred session (doubles per attempt). */
const RETRY_BASE_MS = 60_000;
/** Candidate rows read per queue query. */
const PAGE = 50;
/** Backlog pages one claim reads before yielding (sessions it cannot claim are skipped). */
const MAX_PAGES_PER_CLAIM = 20;

/** A backlog stage: which sessions (priority or all) and which audits it runs. */
export interface BacklogStage {
  id: "contract" | "priority_checks" | "rest";
  label: string;
  /** Only sessions with nudges or a no_reply ending. */
  priority: boolean;
  /** The audits this stage runs; null = every pending audit. */
  audits: readonly AuditName[] | null;
}

/**
 * The backlog's stages, in order: classify how sends failed first (the
 * send-contract audit, which also judges the `contract` checks of the endings),
 * for every session that has nudges or ended with no_reply; then the refusal
 * check pass over those sessions; then every remaining session. The live lane
 * runs every audit of a just-settled session regardless.
 */
export const BACKLOG_STAGES: readonly BacklogStage[] = [
  { id: "contract", label: "send-contract classification", priority: true, audits: ["send_contract"] },
  { id: "priority_checks", label: "refusal checks, nudged and no_reply sessions", priority: true, audits: null },
  { id: "rest", label: "every other session", priority: false, audits: null },
];

export interface AuditWorkerPoolOptions {
  storage: Storage;
  config: AppConfig;
  engine: DecisionEngine;
  /** The one check catalogue (CONTRACT R2). */
  catalogue: CheckCatalogue;
  /** Owning agent of a timeline key; null in legacy mode. */
  agentForTimelineKey(timelineKey: string): string | null;
  /** The chat before a session's trigger (its `recent` state), newest last; optional. */
  recentChat?(session: AuditCandidateRow, limit: number): StateMessage[];
  /** True while the `audit` budget class is blocked: the worker claims nothing. */
  shouldPause?(): boolean;
  logger?: Logger;
  now?(): number;
  /** Poll interval when idle (default 30 s). */
  idleMs?: number;
}

/** What one {@link AuditWorkerPool.runOnce} step did. */
export type AuditStep =
  | { kind: "idle" }
  | { kind: "paused" }
  | { kind: "paced" }
  | { kind: "audited"; sessionId: string; lane: "live" | "backlog"; statuses: Record<string, string>; deferred?: string };

interface Deferral {
  until: number;
  attempts: number;
}

export class AuditWorkerPool {
  private running = false;
  private startedAt = 0;
  private readonly claimed = new Set<string>();
  private readonly deferred = new Map<string, Deferral>();
  /** Sessions (`id@completed_at`) with nothing to do under the current config (an agent with the point off). */
  private readonly ignored = new Set<string>();
  private cursor: { createdAt: number; id: string } | undefined;
  /** Index into {@link BACKLOG_STAGES} of the stage the backlog walks. */
  private stage = 0;
  private nextBacklogAt = 0;
  /** True once the backlog walked its last stage to the end (until the next pass starts). */
  private passDone = false;
  private readonly progress: AuditProgressCounter;
  private pausedUntil = 0;
  private readonly loops = new Set<Promise<void>>();
  private wake: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly evaluator: CheckEvaluator;
  private readonly auditSnapshots = new Map<string, { auditCompletedAt: number | null }>();
  private reconciled?: Promise<void>;

  constructor(private readonly options: AuditWorkerPoolOptions) {
    this.evaluator = new CheckEvaluator({
      catalogue: options.catalogue,
      engine: options.engine,
      config: options.config,
      storage: {
        insertDecisionEvaluation: (row) => {
          const snapshot = row.agent_session_id ? this.auditSnapshots.get(row.agent_session_id) : undefined;
          return snapshot ? options.storage.insertDecisionEvaluation(row, snapshot) : Promise.resolve(0);
        },
        insertRefusalEvent: (row) => {
          const snapshot = row.agentSessionId ? this.auditSnapshots.get(row.agentSessionId) : undefined;
          return snapshot ? options.storage.insertRefusalEvent(row, snapshot) : Promise.resolve(0);
        },
      },
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
      judging: {
        point: "audit",
        usageClass: "audit",
        priority: "background",
        timeoutMs: decisionsFor(options.config, null).audit?.timeout_ms ?? DEFAULT_AUDIT_TIMEOUT_MS,
        groupPrefix: "audit:",
        logEvent: "audit_check_evaluated",
      },
    });
    this.progress = new AuditProgressCounter({
      storage: options.storage,
      audits: () => this.queueAudits().map((a) => a.name),
      excludeSessionTypes: [...SYNTHETIC_SESSION_TYPES],
      knobs: () => this.poolKnobs,
      now: () => this.now(),
      current: () => (this.passDone ? null : (BACKLOG_STAGES[this.stage]?.id ?? null)),
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  /** The latest backlog count (background, never on a request path); null before the first one finished. */
  backlogProgress(): AuditBacklogProgress | null {
    return this.progress.snapshot();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Pool-wide knobs (workers, pacing, settle, retries): the global `[decisions.audit]`. */
  private get poolKnobs(): AuditKnobs {
    return auditKnobs(decisionsFor(this.options.config, null));
  }

  /** The audits some agent runs (the queue's pending condition). */
  queueAudits(): AuditQueueAudit[] {
    const config = this.options.config;
    const agents: Array<string | null> = [null, ...Object.keys(config.agents ?? {})];
    const names = new Set<AuditName>();
    for (const agent of agents) {
      if (!this.options.engine.isEnabled("audit", agent)) continue;
      for (const name of auditKnobs(decisionsFor(config, agent)).audits) names.add(name);
    }
    return [...names].map((name) => ({ name, ...(name === "send_contract" ? { requiresContract: true } : {}) }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    const workers = this.poolKnobs.workers;
    this.options.logger?.info("audit_worker_started", { workers, audits: this.queueAudits().map((a) => a.name) });
    this.progress.start();
    for (let i = 0; i < workers; i++) {
      const loop = this.loop().finally(() => this.loops.delete(loop));
      this.loops.add(loop);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.progress.stop();
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await Promise.allSettled([...this.loops]);
  }

  /** Wake an idle worker (a session just completed). */
  notifyNewWork(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    // Yield once so boot never waits on the first queue query.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.running) {
      let step: AuditStep;
      try {
        step = await this.runOnce();
      } catch (error) {
        this.options.logger?.error("audit_worker_error", { error: error instanceof Error ? error.message : String(error) });
        step = { kind: "idle" };
      }
      if (!this.running) break;
      if (step.kind === "audited") continue;
      const delay =
        step.kind === "paced"
          ? Math.max(0, this.nextBacklogAt - this.now())
          : step.kind === "paused"
            ? Math.max(1000, this.pausedUntil - this.now())
            : (this.options.idleMs ?? DEFAULT_IDLE_MS);
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.wake = undefined;
        resolve();
      };
      this.wake = done;
      this.timer = setTimeout(done, ms);
      this.timer.unref?.();
    });
  }

  /**
   * One step: claim the next session (live lane first, then the paced backlog)
   * and audit it. Exposed for tests and for a caller that drives the worker.
   */
  async runOnce(): Promise<AuditStep> {
    await (this.reconciled ??= this.options.storage.reconcileOfflineAudits());
    if (this.startedAt === 0) this.startedAt = this.now();
    const now = this.now();
    if (now < this.pausedUntil || this.options.shouldPause?.()) {
      if (now >= this.pausedUntil) this.pausedUntil = now + BUDGET_PAUSE_MS;
      return { kind: "paused" };
    }
    const claim = this.claim(now);
    if (claim.kind !== "claimed") return { kind: claim.kind };
    const { row, lane, stage, only } = claim;
    this.claimed.add(row.id);
    this.auditSnapshots.set(row.id, { auditCompletedAt: row.completed_at });
    try {
      return await this.audit(row, lane, stage, only);
    } finally {
      this.claimed.delete(row.id);
      this.auditSnapshots.delete(row.id);
      if (lane === "backlog") this.nextBacklogAt = this.now() + this.poolKnobs.backlogPaceMs;
    }
  }

  private available(row: AuditCandidateRow, now: number, stage: string): boolean {
    if (this.claimed.has(row.id) || this.ignored.has(ignoreKey(row, stage)) || this.ignored.has(ignoreKey(row, "*"))) return false;
    const d = this.deferred.get(row.id);
    return !d || d.until <= now;
  }

  private claim(now: number):
    | { kind: "claimed"; row: AuditCandidateRow; lane: "live" | "backlog"; stage: string; only: readonly AuditName[] | null }
    | { kind: "idle" | "paced" } {
    const audits = this.queueAudits();
    if (audits.length === 0) return { kind: "idle" };
    const knobs = this.poolKnobs;
    const base = {
      audits,
      excludeSessionTypes: [...SYNTHETIC_SESSION_TYPES],
      settledBefore: now - knobs.settleMs,
      limit: PAGE,
      ...(knobs.backlogMaxAgeMs > 0 ? { minCreatedAt: now - knobs.backlogMaxAgeMs } : {}),
    };
    const live = this.options.storage.listAuditCandidates({
      ...base,
      order: "desc",
      settledSince: this.startedAt - knobs.settleMs,
    });
    const fresh = live.find((row) => this.available(row, now, "live"));
    if (fresh) return { kind: "claimed", row: fresh, lane: "live", stage: "live", only: null };

    if (now < this.nextBacklogAt) return { kind: "paced" };
    for (let pages = 0; ; pages++) {
      // Long runs of unclaimable rows (deferred, or an agent with the point off):
      // yield and continue from the cursor on the next step.
      if (pages >= MAX_PAGES_PER_CLAIM) return { kind: "paced" };
      const stage = BACKLOG_STAGES[this.stage]!;
      const stageAudits = stage.audits === null ? audits : audits.filter((a) => stage.audits!.includes(a.name as AuditName));
      const page = stageAudits.length === 0
        ? []
        : this.options.storage.listAuditCandidates({
            ...base,
            audits: stageAudits,
            order: "asc",
            ...(stage.priority ? { priority: true } : {}),
            ...(this.cursor ? { after: this.cursor } : {}),
          });
      if (page.length === 0) {
        // End of a stage: the next one starts from the oldest session; after the
        // last, the next pass starts over (deferred sessions come back).
        this.cursor = undefined;
        if (this.stage < BACKLOG_STAGES.length - 1) {
          this.stage += 1;
          continue;
        }
        this.stage = 0;
        this.passDone = true;
        return { kind: "idle" };
      }
      this.passDone = false;
      for (const row of page) {
        this.cursor = { createdAt: row.created_at, id: row.id };
        if (this.available(row, now, stage.id)) return { kind: "claimed", row, lane: "backlog", stage: stage.id, only: stage.audits };
      }
    }
  }

  /**
   * Audit one session: every pending audit (or those of `only`, the backlog
   * stage's), written in one transaction.
   */
  private async audit(
    row: AuditCandidateRow,
    lane: "live" | "backlog",
    stageKey: string,
    only: readonly AuditName[] | null,
  ): Promise<AuditStep> {
    const { storage, engine, config } = this.options;
    const agent = this.options.agentForTimelineKey(row.timeline_key);
    if (!engine.isEnabled("audit", agent)) {
      this.ignored.add(ignoreKey(row, "*"));
      return { kind: "audited", sessionId: row.id, lane, statuses: {} };
    }
    const knobs = auditKnobs(decisionsFor(config, agent));
    const done = storage
      .listSessionAudits(row.id)
      .filter((a) => a.event_id === null && a.created_at >= (row.completed_at ?? 0))
      .map((a) => a.audit);
    const pending = knobs.audits.filter(
      (name) =>
        !done.includes(name) &&
        (name !== "send_contract" || row.contract_version !== null) &&
        (only === null || only.includes(name)),
    );
    if (pending.length === 0) {
      this.ignored.add(ignoreKey(row, stageKey));
      return { kind: "audited", sessionId: row.id, lane, statuses: {} };
    }

    const now = this.now();
    const transcript = parseTranscript(storage.getAgentSessionTranscriptJson(row.id));
    const statuses: Record<string, string> = {};
    if (!transcript) {
      const rows = pending.map((audit): SessionAuditInsert => ({
        sessionId: row.id,
        audit,
        status: "unauditable",
        version: AUDIT_VERSION,
        createdAt: now,
      }));
      await storage.writeSessionAudits(rows, { auditCompletedAt: row.completed_at });
      for (const audit of pending) statuses[audit] = "unauditable";
      this.deferred.delete(row.id);
      this.options.logger?.info("session_audited", { sessionId: row.id, lane, statuses });
      return { kind: "audited", sessionId: row.id, lane, statuses };
    }

    const branches = contractBranchesOf(storage, row.id);
    const runs = contractRuns(transcript, branches);
    const request: StateMessage[] = row.trigger_body
      ? [{ from: row.trigger_sender_display_name ?? row.trigger_sender_id ?? "user", text: row.trigger_body }]
      : [];
    const attribution = { agentSessionId: row.id, sessionType: row.session_type, timelineKey: row.timeline_key };
    const rows: SessionAuditInsert[] = [];
    let attemptTypes: { sessionId: string; updates: ContractAttemptTypesUpdate[] } | undefined;
    let deferredReason: string | undefined;
    const deferredAudits: AuditName[] = [];
    let costUsd = 0;

    // The chat before the trigger (the check state's `recent`), read once if a check pass runs.
    let recent: StateMessage[] | undefined;
    const recentChat = (): StateMessage[] => {
      if (recent) return recent;
      recent = [];
      const recentLimit = this.evaluator.knobs(agent).recentMessages;
      if (this.options.recentChat && recentLimit > 0) {
        try {
          recent = this.options.recentChat(row, recentLimit).slice(-recentLimit);
        } catch (error) {
          this.options.logger?.warn("audit_chat_state_failed", {
            sessionId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return recent;
    };
    const items = checkItems(transcript);
    const checkPass = (passItems: typeof items, kinds: readonly CheckKind[]) =>
      auditSessionChecks({
        evaluator: this.evaluator,
        scope: {
          agent,
          site: row.session_type,
          sessionId: row.id,
          sessionType: row.session_type,
          timelineKey: row.timeline_key,
          triggerSenderId: row.trigger_sender_id,
          tasks: sessionTasks(row.initial_preloads),
        },
        items: passItems,
        existing: storage.getDecisionEvaluationsForSession(row.id),
        kinds,
        request,
        recent: recentChat(),
      });

    if (pending.includes("send_contract")) {
      // The send-contract classification: the diagnosis of every nudged run, then
      // the judged `contract` checks of the endings (why a run ended with no_reply).
      const diagnoses: RunDiagnosis[] = [];
      const updates: ContractAttemptTypesUpdate[] = [];
      const answersByRun: Record<string, DecisionAnswers> = {};
      let modelId: string | undefined;
      let contractCost = 0;
      let contractDeferred: string | undefined;
      if (runs.length > 0) {
        const attemptRows = storage.listContractAttempts(row.id).filter((a) => a.primary_type !== null && a.ts !== null);
        const settings = engine.settings("audit", agent);
        for (const run of runs) {
          const endingTexts = new Map(run.endings.map((e) => [e.ts, e.text]));
          const attempts: RunAttempt[] = attemptRows
            .filter((a) => endingTexts.has(a.ts!))
            .map((a) => ({ row: a, text: endingTexts.get(a.ts!) ?? "" }));
          const plan = planRun(run, attempts, request);
          let answers: DecisionAnswers | undefined;
          if (plan.input) {
            const outcome = await engine.evaluate(contractAuditPoint, plan.input, {
              agentName: agent,
              attribution,
              priority: "background",
              timeoutMs: decisionsFor(config, agent).audit?.timeout_ms ?? DEFAULT_AUDIT_TIMEOUT_MS,
              usageClass: "audit",
              decisionGroup: `audit:${nanoid()}`,
              onEvaluation: (evaluation) => {
                void storage.insertDecisionEvaluation({
                  ts: evaluation.ts, decision_group: evaluation.decisionGroup, point: evaluation.point,
                  agent: evaluation.agent, agent_session_id: row.id, timeline_key: evaluation.timelineKey,
                  source: evaluation.source, reason: evaluation.reason, verdict_json: evaluation.verdictJson,
                  answers_json: evaluation.answersJson, state_json: evaluation.stateJson,
                  questions_json: evaluation.questionsJson, served_model: evaluation.servedModel,
                  served_version: evaluation.servedVersion, latency_ms: evaluation.latencyMs,
                  input_tokens: evaluation.inputTokens, cost_usd: evaluation.costUsd,
                }, { auditCompletedAt: row.completed_at }).catch((error) => {
                  this.options.logger?.warn("decision_evaluation_persist_failed", {
                    point: "audit", sessionId: row.id, error: error instanceof Error ? error.message : String(error),
                  });
                });
              },
            });
            contractCost += outcome.costUsd;
            if (outcome.source === "model") {
              answers = outcome.verdict.answers;
              answersByRun[String(run.run)] = answers;
              modelId = outcome.servedModel ?? modelId;
            } else if (outcome.reason && RETRYABLE_REASONS.has(outcome.reason)) {
              contractDeferred ??= outcome.reason;
              break;
            }
          }
          const result = diagnoseRun(run, attempts, plan, answers, {
            selfTalk: knobs.selfTalkThreshold,
            textual: knobs.textualToolCallThreshold,
            minConfidence: settings?.minConfidence ?? 0.6,
          });
          diagnoses.push(result.diagnosis);
          updates.push(...result.updates);
        }
      }
      const endings = items.filter((i) => i.checkpoint === "ending");
      const contractKinds = knobs.checkKinds.filter((k) => k === "contract");
      let checks: Awaited<ReturnType<typeof checkPass>> | undefined;
      if (!contractDeferred && contractKinds.length > 0 && endings.length > 0) {
        checks = await checkPass(endings, contractKinds);
        contractCost += checks.costUsd;
        modelId = checks.modelId ?? modelId;
        if (checks.deferred) contractDeferred = checks.reason ?? "error";
      }
      costUsd += contractCost;
      const judgedNothing = !checks || (checks.verdict.judged === 0 && Object.keys(checks.verdict.fired).length === 0);
      if (contractDeferred) {
        deferredReason ??= contractDeferred;
        deferredAudits.push("send_contract");
      } else if (runs.length === 0 && judgedNothing) {
        rows.push(this.row(row.id, "send_contract", "skipped", { verdict: { reason: "not_nudged" } }, now));
        statuses["send_contract"] = "skipped";
      } else {
        rows.push(
          this.row(row.id, "send_contract", "done", {
            verdict: { runs: diagnoses, ...(checks ? { checks: checks.verdict } : {}) },
            answers: Object.keys(answersByRun).length > 0 ? answersByRun : undefined,
            modelId,
            costUsd: contractCost,
          }, now),
        );
        if (updates.length > 0) attemptTypes = { sessionId: row.id, updates };
        statuses["send_contract"] = "done";
      }
    }

    if (pending.includes("refusal")) {
      const nudged = runs.length > 0 || (row.contract_nudges ?? 0) > 0;
      if (!nudged && !inSample(row.id, knobs.sampleCleanSessions)) {
        rows.push(this.row(row.id, "refusal", "skipped", { verdict: { reason: "not_sampled" } }, now));
        statuses["refusal"] = "skipped";
      } else {
        // Every kind of `check_kinds`; checks the send-contract stage already judged
        // at an output are skipped there (check-audit.ts).
        const result = await checkPass(items, knobs.checkKinds);
        costUsd += result.costUsd;
        if (result.deferred) {
          deferredReason ??= result.reason;
          deferredAudits.push("refusal");
        } else {
          rows.push(
            this.row(row.id, "refusal", "done", {
              verdict: result.verdict,
              modelId: result.modelId,
              costUsd: result.costUsd,
            }, now),
          );
          statuses["refusal"] = "done";
        }
      }
    }

    if (deferredReason) {
      if (deferredReason === "budget") this.pausedUntil = this.now() + BUDGET_PAUSE_MS;
      const prior = this.deferred.get(row.id)?.attempts ?? 0;
      const attempts = deferredReason === "budget" ? prior : prior + 1;
      if (attempts > knobs.maxRetries) {
        for (const audit of deferredAudits) {
          rows.push(this.row(row.id, audit, "failed", { verdict: { reason: deferredReason } }, now));
          statuses[audit] = "failed";
        }
        this.deferred.delete(row.id);
      } else {
        this.deferred.set(row.id, { until: this.now() + RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), attempts });
        for (const audit of deferredAudits) statuses[audit] = "deferred";
      }
    } else {
      this.deferred.delete(row.id);
    }
    await storage.writeSessionAudits(rows, { ...(attemptTypes ? { attemptTypes } : {}), auditCompletedAt: row.completed_at });
    this.options.logger?.info("session_audited", {
      sessionId: row.id,
      lane,
      statuses,
      ...(deferredReason ? { deferred: deferredReason } : {}),
      costUsd: Math.round(costUsd * 1e6) / 1e6,
    });
    return {
      kind: "audited",
      sessionId: row.id,
      lane,
      statuses,
      ...(deferredReason ? { deferred: deferredReason } : {}),
    };
  }

  private row(
    sessionId: string,
    audit: AuditName,
    status: SessionAuditInsert["status"],
    fields: { verdict?: unknown; answers?: unknown; modelId?: string | undefined; costUsd?: number },
    now: number,
  ): SessionAuditInsert {
    return {
      sessionId,
      audit,
      status,
      verdictJson: fields.verdict !== undefined ? JSON.stringify(fields.verdict) : null,
      answersJson: fields.answers !== undefined ? JSON.stringify(fields.answers) : null,
      modelId: fields.modelId ?? null,
      costUsd: fields.costUsd && fields.costUsd > 0 ? fields.costUsd : null,
      version: AUDIT_VERSION,
      createdAt: now,
    };
  }
}

/**
 * A session's identity for the ignore set, per queue stage (`*` = every stage: its
 * agent has the point off): a later completion (a resume) is a new key.
 */
function ignoreKey(row: AuditCandidateRow, stage: string): string {
  return `${row.id}@${row.completed_at ?? 0}@${stage}`;
}
