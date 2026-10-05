/**
 * DecisionClient — raw fetch to `[models.*]` blocks with api = "system-one"
 * (ARCHITECTURE.md §8h). Fetch-shaped like captioning and x_search: it composes
 * `runFetchWithFallback` over the referenced model's chain, so per-model health,
 * group throttling, the canary and at most one attempt per member per call all
 * apply unchanged. What it adds:
 *
 * - **Fits** — a member whose declared limits (`[models.*.decision]`) the request
 *   exceeds is never sent it; with no fitting member the call throws
 *   {@link NoFittingMemberError}.
 * - **State clamping** — the state is built per member for that member's own
 *   budget (`state_budget_tokens`, else `context_window`, capped by the point's
 *   `state_max_tokens`), so a route that silently truncates sees exactly the
 *   window the log records. Provider truncation is never relied on.
 * - **Response normalisation** — the bare body and Cloudflare's `{ result }`
 *   envelope; the dated served model id; `usage.cost` when the provider reports
 *   it, else the member's `cost` block.
 * - **Configuration failures** — a 401/403/404 (e.g. OpenRouter's "No endpoints
 *   found matching your data policy" for a ZDR-filtered member without a ZDR
 *   endpoint) is not a health strike and is not retried: it is logged once per
 *   member and the chain moves on.
 */

import type { AppConfig } from "../config/index.js";

type ModelConfig = AppConfig["models"]["default"];
import {
  NoFittingMemberError,
  resolveModelChain,
  runFetchWithFallback,
  type FetchAttemptOutcome,
  type FetchChainMember,
} from "../agent/model-fallback.js";
import { parseRetryAfterMs, type LlmScheduler, type PriorityClass } from "../agent/scheduler.js";
import { computeUsageCost } from "../agent/usage.js";
import { estimateTokens } from "../context/tokens.js";
import type { Logger } from "../observability/logger.js";
import {
  parseAnswers,
  requestShapeOf,
  type DecisionAnswers,
  type DecisionQuestion,
  type DecisionRequestShape,
} from "./types.js";

export { NoFittingMemberError };

/** Default for a point's `min_state_tokens`. */
export const DEFAULT_MIN_STATE_TOKENS = 1000;
/** Headroom kept between state + questions and the member's budget. */
const BUDGET_MARGIN_TOKENS = 64;
/** Cap on the response body read (a decision response is a few KB). */
const MAX_RESPONSE_BYTES = 1_000_000;

export interface DecisionRequest {
  questions: Record<string, DecisionQuestion>;
  /**
   * Build the state for a token budget. Called once per distinct effective
   * budget (memoized); must return a state whose JSON fits the budget. The
   * client checks and shrinks if a builder overshoots.
   */
  state: (budgetTokens: number) => unknown;
  /** The point's state cap (`state_max_tokens`). */
  stateMaxTokens: number;
  /** Members whose effective state budget is below this are skipped. */
  minStateTokens: number;
}

export interface SentAttempt {
  /** The state object that was JSON-serialised and placed in the request body. */
  state: unknown;
  /** The questions map that was sent (same for every attempt in a call). */
  questions: Record<string, DecisionQuestion>;
  /** Logical model id of the member this was sent to. */
  memberKey: string;
}

export interface DecisionCallOptions {
  /** Label for logs and the fallback resolver (`decision:<point>`). */
  consumer: string;
  priority: PriorityClass;
  /** Hard deadline for the whole call, chain included. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Drop members that are over budget (the registry's `[[limits]]` check). */
  isModelAvailable?: (logicalId: string) => boolean;
  /** One call per attempt the provider billed (a 2xx response), parsed or not. */
  onBilled?: (attempt: BilledAttempt) => void;
  /**
   * Called once per member attempt, immediately before the HTTP fetch, with the
   * state and questions that were actually serialised into the request body.
   * The last call records what the final (successful or last-tried) member saw.
   * Evaluate() uses this to write the exact sent payload to the evaluation row
   * (spec §8 requires the row to reflect what the member actually received).
   */
  onSent?: (sent: SentAttempt) => void;
}

export interface BilledAttempt {
  logicalId: string;
  config: ModelConfig;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when the cost is the provider's own `usage.cost`. */
  providerCost: boolean;
  /** Dated served model id from the response (`typesafe/jev-1.13-20260917`). */
  servedVersion?: string;
}

export interface DecisionResult {
  answers: DecisionAnswers;
  logicalId: string;
  config: ModelConfig;
  servedVersion?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stateTokens: number;
  billing: "per_request" | "per_question";
}

export interface DecisionClientOptions {
  models: Record<string, ModelConfig>;
  scheduler?: LlmScheduler;
  logger?: Logger;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Why a member does not fit a request (undefined = fits). Pure; exported for tests. */
export function memberMisfit(
  config: ModelConfig,
  shape: DecisionRequestShape,
  effectiveStateBudget: number,
  minStateTokens: number,
): string | undefined {
  const fits = config.decision;
  if (fits?.question_types) {
    for (const type of shape.questionTypes) {
      if (!fits.question_types.includes(type)) return `question_type:${type}`;
    }
  }
  if (fits?.max_questions !== undefined && shape.questionCount > fits.max_questions) return "max_questions";
  if (fits?.max_choice_options !== undefined && shape.maxChoiceOptions > fits.max_choice_options) {
    return "max_choice_options";
  }
  if (fits?.max_score_levels !== undefined && shape.maxScoreLevels > fits.max_score_levels) {
    return "max_score_levels";
  }
  // Every state the points build is an object; a judge-only member takes only a
  // string or an {input, output} conversation.
  if (fits?.state_shapes === "text_or_conversation") return "state_shape";
  if (effectiveStateBudget < minStateTokens) return "state_budget";
  return undefined;
}

/** The largest state a member reads: `state_budget_tokens`, else `context_window`. */
export function memberStateBudget(config: ModelConfig): number {
  return config.decision?.state_budget_tokens ?? config.context_window ?? Number.POSITIVE_INFINITY;
}

/** Token estimate of a JSON-serialised value (the context builder's tokenizer). */
export function jsonTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}

class DecisionHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DecisionHttpError";
  }
}

export class DecisionClient {
  private readonly fetchImpl: typeof fetch;
  /** Members already logged for a configuration failure (once per member + status). */
  private readonly configErrorsLogged = new Set<string>();

  constructor(private readonly options: DecisionClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** The chain behind a decision model key, head first. */
  chain(modelKey: string) {
    return resolveModelChain(modelKey, this.options.models);
  }

  async decide(modelKey: string, request: DecisionRequest, options: DecisionCallOptions): Promise<DecisionResult> {
    const shape = requestShapeOf(request.questions);
    const questionTokens = jsonTokens(request.questions);
    const effectiveBudget = (config: ModelConfig): number =>
      Math.floor(Math.min(request.stateMaxTokens, memberStateBudget(config)) - questionTokens - BUDGET_MARGIN_TOKENS);
    const states = new Map<number, { state: unknown; tokens: number }>();
    const stateFor = (budget: number): { state: unknown; tokens: number } => {
      const cached = states.get(budget);
      if (cached) return cached;
      // The builder packs newest-first to the budget; shrink and rebuild if it
      // overshoots, so the provider never sees more than the member reads.
      let target = budget;
      for (let i = 0; i < 4; i++) {
        const state = request.state(target);
        const tokens = jsonTokens(state);
        if (tokens <= budget) {
          const built = { state, tokens };
          states.set(budget, built);
          return built;
        }
        target = Math.floor(target * 0.75);
      }
      throw new Error(`${options.consumer}: state does not fit a ${budget}-token budget`);
    };

    const deadline = Date.now() + options.timeoutMs;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, options.timeoutMs));
    let result: DecisionResult | undefined;
    try {
      await runFetchWithFallback<DecisionResult>(
        this.chain(modelKey),
        {
          consumer: options.consumer,
          priority: options.priority,
          scheduler: this.options.scheduler,
          isModelAvailable: options.isModelAvailable,
          probeBackoffMaxMs: (cfg) => cfg.llm_probe_backoff_max_ms,
          signal: controller.signal,
          logger: this.options.logger,
          memberFilter: (member) =>
            member.config.api === "system-one" &&
            memberMisfit(member.config, shape, effectiveBudget(member.config), request.minStateTokens) === undefined,
        },
        async (member) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw abortError();
          let built: { state: unknown; tokens: number };
          try {
            built = stateFor(effectiveBudget(member.config));
          } catch (error) {
            // A state builder failure is this request's content, never a health signal.
            return { ok: false, kind: "content", error };
          }
          options.onSent?.({ state: built.state, questions: request.questions, memberKey: member.logicalId });
          const outcome = await this.attempt(member, request.questions, built.state, remaining, controller.signal, options);
          if (outcome.ok) {
            result = { ...outcome.value, stateTokens: built.tokens };
            return { ok: true, value: result, status: outcome.status };
          }
          return outcome;
        },
      );
    } finally {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
    if (!result) throw new Error(`${options.consumer}: no result`);
    return result;
  }

  private async attempt(
    member: FetchChainMember,
    questions: Record<string, DecisionQuestion>,
    state: unknown,
    timeoutMs: number,
    callSignal: AbortSignal,
    options: DecisionCallOptions,
  ): Promise<FetchAttemptOutcome<Omit<DecisionResult, "stateTokens">>> {
    const config = member.config;
    const body: Record<string, unknown> = { model: config.id, state, questions };
    const routing = config.compat?.openrouter_routing;
    if (routing && Object.keys(routing).length > 0) body["provider"] = routing;

    const attemptController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, timeoutMs);
    const onCallAbort = () => attemptController.abort();
    callSignal.addEventListener("abort", onCallAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(config.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(config.api_key ? { authorization: `Bearer ${config.api_key}` } : {}),
          },
          body: JSON.stringify(body),
          signal: attemptController.signal,
        });
      } catch (error) {
        return this.thrownOutcome(error, timedOut, callSignal, timeoutMs);
      }
      let text: string;
      try {
        text = await readCapped(response);
      } catch (error) {
        return this.thrownOutcome(error, timedOut, callSignal, timeoutMs);
      }
      if (!response.ok) return this.statusOutcome(member, response, text);

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return environmental(response.status, "unparsable response body");
      }
      const envelope = unwrapEnvelope(parsed);
      const usage = readUsage(envelope["usage"]);
      const servedVersion = typeof envelope["model"] === "string" ? (envelope["model"] as string) : undefined;
      const billing = config.decision?.billing ?? "per_request";
      const inputTokens = usage.inputTokens ?? estimateInputTokens(state, questions, billing);
      const outputTokens = usage.outputTokens ?? 0;
      const providerCost = usage.cost !== undefined;
      const costUsd =
        usage.cost ??
        (config.cost
          ? computeUsageCost(
              { input: config.cost.input, output: config.cost.output, cacheRead: 0, cacheWrite: 0 },
              { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 },
            ).total
          : 0);
      // A 2xx is billed whether or not its answers parse (the ledger matches the invoice).
      options.onBilled?.({
        logicalId: member.logicalId,
        config,
        inputTokens,
        outputTokens,
        costUsd,
        providerCost,
        servedVersion,
      });
      const answers = parseAnswers(envelope["answers"], questions);
      if (!answers) return environmental(response.status, "malformed answers");
      return {
        ok: true,
        status: response.status,
        value: {
          answers,
          logicalId: member.logicalId,
          config,
          servedVersion,
          inputTokens,
          outputTokens,
          costUsd,
          billing,
        },
      };
    } finally {
      clearTimeout(timer);
      callSignal.removeEventListener("abort", onCallAbort);
    }
  }

  private thrownOutcome(
    error: unknown,
    timedOut: boolean,
    callSignal: AbortSignal,
    timeoutMs: number,
  ): FetchAttemptOutcome<never> {
    // The whole call's deadline or the caller's signal is a neutral teardown
    // (never a health strike); this attempt's own timeout is environmental.
    if (callSignal.aborted && !timedOut) throw abortError();
    if (timedOut) return environmental(undefined, `timed out after ${timeoutMs}ms`);
    return environmental(undefined, error instanceof Error ? error.message : String(error));
  }

  private statusOutcome(member: FetchChainMember, response: Response, text: string): FetchAttemptOutcome<never> {
    const status = response.status;
    const snippet = text.slice(0, 300);
    const error = new DecisionHttpError(`HTTP ${status}${snippet ? ` (${snippet})` : ""}`, status);
    if (status === 400 || status === 413 || status === 422) {
      // This request's content: deterministic on replay, never falls over.
      return { ok: false, kind: "content", status, error };
    }
    if (status === 401 || status === 403 || status === 404) {
      // Configuration failure of this member (bad key, unknown model, or a data
      // policy no endpoint of it satisfies): not a health strike, not retried.
      const key = `${member.logicalId}:${status}`;
      if (!this.configErrorsLogged.has(key)) {
        this.configErrorsLogged.add(key);
        this.options.logger?.error("decision_member_config_error", {
          model: member.logicalId,
          status,
          dataPolicy: /data policy/i.test(text),
          detail: snippet,
        });
      }
      return { ok: false, kind: "skip", status, error };
    }
    return {
      ok: false,
      kind: "environmental",
      status,
      retryAfterMs: parseRetryAfterMs(response.headers),
      error,
    };
  }
}

function environmental(status: number | undefined, message: string): FetchAttemptOutcome<never> {
  return { ok: false, kind: "environmental", status, error: new DecisionHttpError(message, status) };
}

function abortError(): Error {
  const err = new Error("decision call aborted");
  err.name = "AbortError";
  return err;
}

/** Accept the bare body and Cloudflare's `{ result: { … } }` envelope. */
export function unwrapEnvelope(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  if (!("answers" in obj) && obj["result"] && typeof obj["result"] === "object") {
    return obj["result"] as Record<string, unknown>;
  }
  return obj;
}

function readUsage(raw: unknown): { inputTokens?: number; outputTokens?: number; cost?: number } {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  return {
    inputTokens: num(u["input_tokens"]) ?? num(u["prompt_tokens"]),
    outputTokens: num(u["output_tokens"]) ?? num(u["completion_tokens"]),
    cost: num(u["cost"]),
  };
}

/** Input-token estimate when the provider reports none: state re-billed per question where it is. */
function estimateInputTokens(
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  billing: "per_request" | "per_question",
): number {
  const stateTokens = jsonTokens(state);
  const count = Object.keys(questions).length;
  return (billing === "per_question" ? stateTokens * Math.max(1, count) : stateTokens) + jsonTokens(questions);
}

async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}
