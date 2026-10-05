/**
 * Refusal rules for the sessionless, fetch-shaped consumers (spec
 * REFUSAL-HANDLING §8.1 site `caption`): a hard refusal of a fetch attempt is
 * classified and recorded, and a matching `[[refusal_fallback]]` rule re-runs
 * the call on its next usable entry (with that entry's own fallback chain)
 * instead of failing. No rule keeps the consumer's own refusal behaviour.
 *
 * The consumer's per-member fetch signals a refusal by throwing an error that
 * carries a {@link FetchRefusalSignal} under `refusal` (see `CaptionRefusalError`).
 */
import type { AppConfig } from "../config/index.js";
import type { CheckCatalogue, RefusalRule } from "../checks/types.js";
import type { Logger } from "../observability/logger.js";
import type { RefusalEventInsert, RefusalOutcome } from "../storage/database.js";
import {
  buildFetchChain,
  chooseChainMember,
  resolveModelChain,
  runFetchWithFallback,
  type FetchAttemptOutcome,
  type FetchChainMember,
  type ModelChainEntry,
  type RunFetchFallbackOptions,
} from "../agent/model-fallback.js";
import { RefusalRuleWalk, matchRefusalRule, ruleAdmitsIgnoringFromModels } from "./rules.js";
import { classifyHardRefusal } from "./session.js";

type ModelConfig = AppConfig["models"]["default"];

/** What a refused fetch reports (the provider's stop reason and category). */
export interface FetchRefusalSignal {
  rawStopReason: string;
  category?: string | null;
  /** Provider explanation or refusal text (recorded truncated). */
  explanation?: string;
  /** Wire model that refused, when the response named it. */
  wireModel?: string;
}

/** The refusal signal an error carries, if any. */
export function fetchRefusalOf(error: unknown): FetchRefusalSignal | undefined {
  if (!error || typeof error !== "object") return undefined;
  const signal = (error as { refusal?: unknown }).refusal;
  if (!signal || typeof signal !== "object") return undefined;
  const raw = (signal as { rawStopReason?: unknown }).rawStopReason;
  return typeof raw === "string" && raw.length > 0 ? (signal as FetchRefusalSignal) : undefined;
}

const EXHAUSTED = Symbol("mikuswarm.refusalExhausted");

/**
 * True when a fetch failed because every entry of a matching refusal rule
 * refused too (`exhausted_no_output`): the consumer must not re-run it.
 */
export function isRefusalExhausted(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { [EXHAUSTED]?: boolean })[EXHAUSTED] === true;
}

/** Mark an error as "every entry of a matching refusal rule refused" (see {@link isRefusalExhausted}). */
export function markRefusalExhausted<E extends object>(error: E): E {
  (error as { [EXHAUSTED]?: boolean })[EXHAUSTED] = true;
  return error;
}

export interface FetchRefusalRouting {
  /** The refusal site (`caption`). */
  site: string;
  /** The consumer's agent, when it serves one agent; null = agent-less (rules with `agents` never match). */
  agent: string | null;
  rules: readonly RefusalRule[];
  /** The app's check catalogue (classification); absent = uncategorized. */
  catalogue?: CheckCatalogue;
  /** `[models.*]`, to resolve a rule entry's chain. */
  models: Record<string, ModelConfig>;
  /** Write a refusal event (`insertRefusalEvent`). */
  insertEvent?: (row: RefusalEventInsert) => Promise<number>;
  logger?: Logger;
}

/**
 * {@link runFetchWithFallback} with refusal rules. Without `routing` it is
 * exactly `runFetchWithFallback`. `onRefused` is told about every refused
 * attempt (the consumer bills it, spec §10.3).
 */
export async function runFetchWithRefusalRules<T>(
  chain: ModelChainEntry[],
  options: RunFetchFallbackOptions,
  attempt: (member: FetchChainMember) => Promise<FetchAttemptOutcome<T>>,
  routing: FetchRefusalRouting | undefined,
  onRefused?: (member: FetchChainMember, error: unknown) => void,
): Promise<T> {
  if (!routing) return runFetchWithFallback(chain, options, attempt);
  let current = chain;
  // The call is one refusal point: the rule walk in play (spec §8.1 tries).
  let walk: RefusalRuleWalk | undefined;
  for (;;) {
    let last: FetchChainMember | undefined;
    try {
      return await runFetchWithFallback(
        current,
        options,
        (member) => {
          last = member;
          return attempt(member);
        },
      );
    } catch (error) {
      const signal = fetchRefusalOf(error);
      if (!signal || !last) throw error;
      const member: FetchChainMember = last;
      try {
        onRefused?.(member, error);
      } catch {
        /* billing is best-effort */
      }
      const category = signal.category && signal.category.length > 0 ? signal.category : null;
      const cls = classifyHardRefusal(
        routing.catalogue,
        { api: member.config.api, rawStopReason: signal.rawStopReason, category },
        routing.agent,
      );
      const scope = { site: routing.site, agent: routing.agent, tasks: null, reason: cls.reason, kind: "hard" as const };
      // The walk's last try (or a member of its chain serving for it) refused:
      // the same rule continues, `from_models` aside (they named the first refuser).
      const continuing =
        walk?.last !== undefined &&
        chainIds(walk.last, routing.models).includes(member.logicalId) &&
        ruleAdmitsIgnoringFromModels(walk.rule, scope);
      const rule: RefusalRule | undefined = continuing
        ? walk!.rule
        : matchRefusalRule(routing.rules, { ...scope, fromModel: member.logicalId });
      let toModel: string | undefined;
      if (rule) {
        if (!continuing) walk = new RefusalRuleWalk(rule, member.logicalId);
        toModel = walk!.next(
          (candidate) => entryUsable(candidate, routing.models, options),
          (candidate) => routing.logger?.info("refusal_rule_entry_skipped", { site: routing.site, rule: rule.name, model: candidate }),
        );
      }
      const outcome: RefusalOutcome = !rule ? "failed" : toModel !== undefined ? "redo" : "exhausted_no_output";
      routing.logger?.warn("llm_refusal", {
        consumer: options.consumer,
        site: routing.site,
        member: member.logicalId,
        model: signal.wireModel ?? member.config.id,
        rawStopReason: signal.rawStopReason,
        checkCode: cls.checkCode,
        reason: cls.reason,
        subReason: cls.subReason,
        category,
        rule: rule?.name,
        outcome,
        toModel,
      });
      if (routing.insertEvent) {
        void routing
          .insertEvent({
            ts: Date.now(),
            agentSessionId: null,
            site: routing.site,
            agent: routing.agent,
            timelineKey: null,
            tasks: null,
            servedModel: member.logicalId,
            wireModel: signal.wireModel ?? member.config.id,
            kind: "hard",
            checkCode: cls.checkCode,
            reason: cls.reason,
            subReason: cls.subReason,
            method: cls.method,
            source: "api",
            rawStopReason: signal.rawStopReason,
            category,
            explanation: signal.explanation ?? null,
            checkpoint: "request",
            ruleName: rule?.name ?? null,
            outcome,
            toModel: toModel ?? null,
          })
          .catch((writeError: unknown) => {
            routing.logger?.warn("refusal_event_write_failed", {
              site: routing.site,
              error: writeError instanceof Error ? writeError.message : String(writeError),
            });
          });
      }
      if (outcome === "exhausted_no_output") {
        (error as { [EXHAUSTED]?: boolean })[EXHAUSTED] = true;
      }
      if (toModel === undefined) throw error;
      current = resolveModelChain(toModel, routing.models);
    }
  }
}

function chainIds(head: string, models: Record<string, ModelConfig>): string[] {
  try {
    return resolveModelChain(head, models).map((m) => m.logicalId);
  } catch {
    return [head];
  }
}

/**
 * A rule entry can serve the call now: it exists, its head passes the consumer's
 * capability filter, and some member of its chain is healthy and in budget. A
 * model that refused is not excluded: explicit entries may retry it (§8.1 tries).
 */
function entryUsable(candidate: string, models: Record<string, ModelConfig>, options: RunFetchFallbackOptions): boolean {
  const config = models[candidate];
  if (!config) return false;
  if (options.capability && !options.capability(config)) return false;
  let members: FetchChainMember[];
  try {
    members = buildFetchChain(resolveModelChain(candidate, models), options.capability);
  } catch {
    return false;
  }
  if (options.memberFilter) members = members.filter(options.memberFilter);
  if (members.length === 0) return false;
  const pick = chooseChainMember(members, {
    scheduler: options.scheduler,
    isModelAvailable: options.isModelAvailable,
  });
  return pick.reason !== "all-unhealthy";
}
