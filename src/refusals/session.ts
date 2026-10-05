/**
 * Per-session refusal handling (spec REFUSAL-HANDLING §8): the rules that can
 * apply to a session, the sticky pin a rule redo leaves behind, the refusal
 * statistics rows, and Layer 0's decision on a hard refusal.
 *
 * One handle per created agent. The factory builds it with the session's site,
 * agent and rules plus a usability predicate over its own model composites
 * (health, budget, per-user limits, fits, capability); Layer 0 asks it on every
 * refused attempt ({@link SessionRefusalController.onHardRefusal}); the gate
 * (phase 3/4) reads the same handle through `CreatedAgent.refusal`.
 */
import { INTERNAL_SITES, type CheckCatalogue, type RefusalRule } from "../checks/types.js";
import type { Logger } from "../observability/logger.js";
import type { RefusalEventInsert, RefusalOutcome, RefusalPin } from "../storage/database.js";
import { stripLlmRequestTag, type RefusalAttemptInfo, type RefusalDecision } from "../agent/request-retry.js";
import { matchRefusalRule, refusalRulesForSession } from "./rules.js";
import { classifyApiRefusal, UNCATEGORIZED_REFUSAL_CODE } from "./signals.js";

/** A refusal event as a handle records it: the session fields are filled in. */
export type SessionRefusalEvent = Omit<RefusalEventInsert, "ts" | "site" | "agent" | "timelineKey" | "agentSessionId">;

/** The session-facing refusal interface (implementation contract, wave 1). */
export interface SessionRefusalHandle {
  /** The current site: the session type, or `record_turn` while the record turn runs. */
  readonly site: string;
  readonly agent: string | null;
  /** The session's task keys; null = taskless (multi-label tasks arrive in phase 4). */
  tasks(): string[] | null;
  /** Logical id of the member that served (or is serving) the last request. */
  servingModel(): string | undefined;
  /** The rule entry the session is pinned to after a rule redo (spec §8.3). */
  pinnedModel(): string | undefined;
  /**
   * The rule that handles a refusal of this session now, or undefined (no rule:
   * implicit fallover for a hard refusal, record only for a soft one). When the
   * session is pinned to a rule's entry and that entry refused, the same rule's
   * next entry applies (spec §8.1) whatever its `from_models` say.
   */
  matchRule(input: { reason: string; kind: "hard" | "soft"; fromModel?: string }): RefusalRule | undefined;
  /** Some soft = "redo" rule could match this session now, for any reason. Cheap. */
  softRuleCouldMatch(): boolean;
  /**
   * Pick the rule's next usable entry after `refusedModel` (entries before it are
   * never revisited, so a rule walks forward and ends), pin the session to it and
   * persist the pin. Usable = the session's gates pass (health, budget, per-user
   * limits, context fits, capability) and the model has not refused in the
   * current request or redo. Undefined = the rule is exhausted.
   */
  advance(rule: RefusalRule, refusedModel: string): string | undefined;
  /** Write one `refusal_events` row with the session fields filled in; resolves to its id (0 without storage). */
  record(event: SessionRefusalEvent): Promise<number>;
  /** The full pin, or undefined. */
  pin(): RefusalPin | undefined;
  /** Outcome of the last hard refusal of this session (workers read `exhausted_no_output`). */
  lastHardOutcome(): RefusalOutcome | undefined;
}

/** The factory's side of the handle. */
export interface SessionRefusalController extends SessionRefusalHandle {
  /** Layer 0's hook (`RequestRetryContext.onRefusal`). */
  onHardRefusal(info: RefusalAttemptInfo): RefusalDecision;
  /** Switch the site (the record turn sets `record_turn`); undefined = back to the session type. */
  setSite(site: string | undefined): void;
  /** The member the composite resolved for the current attempt. */
  noteServing(logicalId: string): void;
  /** A request committed cleanly: the per-request refused set starts over. */
  noteCommitted(): void;
}

export interface SessionRefusalDeps {
  /** The session type name (the default site). */
  sessionType: string;
  agent: string | null;
  sessionId?: string;
  timelineKey?: string;
  rules: readonly RefusalRule[];
  /** The app's check catalogue (built once, ARCH R2). Absent = every hard refusal is uncategorized. */
  catalogue?: CheckCatalogue;
  /** Logical id of the session's head (the serving model before any request). */
  headModel?: string;
  /** Whether a logical id names a configured model. */
  knownModel: (logicalId: string) => boolean;
  /** Logical ids of a model's fallback chain, head first (rule-entry continuation). */
  chainOf: (logicalId: string) => string[];
  /** The session's gates for a rule entry, given the health keys that refused the request. */
  isUsable: (logicalId: string, refusedKeys?: ReadonlySet<string>) => boolean;
  /** The pin persisted for a resumed session. */
  initialPin?: RefusalPin;
  /** Persist the pin (`setAgentSessionRefusalPin`). */
  persistPin?: (pin: RefusalPin) => Promise<void>;
  /** Write a refusal event (`insertRefusalEvent`). */
  insertEvent?: (row: RefusalEventInsert) => Promise<number>;
  logger?: Logger;
  now?: () => number;
}

const INTERNAL = new Set<string>(INTERNAL_SITES);

/** True for the internal sites (mechanical jobs and the record turn), whose exhaustion is "no output". */
export function isInternalSite(site: string): boolean {
  return INTERNAL.has(site);
}

export interface HardRefusalClass {
  checkCode: string;
  reason: string;
  subReason: string | null;
  method: "stop_reason" | "provider_category";
}

/**
 * Classify a hard refusal (spec §5.1). A refusal recognized only by its error
 * text (no raw stop reason) or one no signal maps is `refusal_uncategorized`.
 */
export function classifyHardRefusal(
  catalogue: CheckCatalogue | undefined,
  input: { api?: string; rawStopReason?: string; category?: string | null },
  agent?: string | null,
): HardRefusalClass {
  const classified =
    catalogue && input.rawStopReason
      ? classifyApiRefusal(catalogue, { api: input.api, rawStopReason: input.rawStopReason, category: input.category }, agent)
      : undefined;
  if (classified) return classified;
  const category = input.category && input.category.length > 0 ? input.category : null;
  return {
    checkCode: UNCATEGORIZED_REFUSAL_CODE,
    reason: "unclear",
    subReason: category ?? input.rawStopReason ?? null,
    method: "stop_reason",
  };
}

/** The `refusal_events.outcome` of an exhausted rule at a site. */
export function exhaustedOutcome(rule: RefusalRule, site: string): RefusalOutcome {
  if (isInternalSite(site)) return "exhausted_no_output";
  return rule.onExhausted === "withhold"
    ? "exhausted_withheld"
    : rule.onExhausted === "park"
      ? "exhausted_parked"
      : "exhausted_send_last";
}

export function createSessionRefusalController(deps: SessionRefusalDeps): SessionRefusalController {
  const now = deps.now ?? Date.now;
  let site = deps.sessionType;
  let serving: string | undefined;
  let lastOutcome: RefusalOutcome | undefined;
  // Models that refused in the current request (or redo): never chosen again for it.
  const refusedNow = new Set<string>();
  // The rules whose scope admits the current site (cached per site).
  const scopedBySite = new Map<string, RefusalRule[]>();
  const scoped = (): RefusalRule[] => {
    let list = scopedBySite.get(site);
    if (!list) {
      list = refusalRulesForSession(deps.rules, { site, agent: deps.agent, tasks: null });
      scopedBySite.set(site, list);
    }
    return list;
  };

  let pin: RefusalPin | undefined;
  if (deps.initialPin) {
    if (deps.knownModel(deps.initialPin.model)) {
      pin = { ...deps.initialPin };
    } else {
      deps.logger?.warn("refusal_pin_dropped", {
        sessionId: deps.sessionId,
        rule: deps.initialPin.rule,
        model: deps.initialPin.model,
        reason: "unknown_model",
      });
    }
  }
  const pinRule = (): RefusalRule | undefined =>
    pin ? deps.rules.find((rule) => rule.name === pin!.rule) : undefined;

  /**
   * Index of `model` among the rule's entries; a member of the pinned entry's
   * fallback chain counts as that entry (it served on the entry's behalf).
   */
  const entryIndex = (rule: RefusalRule, model: string | undefined): number => {
    if (model === undefined) return -1;
    const direct = rule.models.indexOf(model);
    if (direct >= 0) return direct;
    if (pin && pin.rule === rule.name) {
      const pinned = rule.models.indexOf(pin.model);
      if (pinned >= 0 && deps.chainOf(pin.model).includes(model)) return pinned;
    }
    return -1;
  };

  const matchRule: SessionRefusalHandle["matchRule"] = (input) => {
    const current = pinRule();
    if (current && entryIndex(current, input.fromModel) >= 0) {
      // The pinned entry refused: the same rule continues when it admits this
      // refusal apart from `from_models` (which named the model that refused first).
      const { fromModels: _fromModels, ...rest } = current;
      if (matchRefusalRule([rest], { site, agent: deps.agent, tasks: null, reason: input.reason, kind: input.kind })) {
        return current;
      }
    }
    return matchRefusalRule(deps.rules, {
      site,
      agent: deps.agent,
      tasks: null,
      fromModel: input.fromModel,
      reason: input.reason,
      kind: input.kind,
    });
  };

  const setPin = (rule: RefusalRule, model: string): void => {
    pin = { rule: rule.name, model, at: now() };
    deps.logger?.info("refusal_pin_set", { sessionId: deps.sessionId, site, rule: rule.name, model });
    if (deps.persistPin) {
      void deps.persistPin(pin).catch((error: unknown) => {
        deps.logger?.warn("refusal_pin_persist_failed", {
          sessionId: deps.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const advanceWith = (
    rule: RefusalRule,
    refusedModel: string | undefined,
    refusedKeys?: ReadonlySet<string>,
  ): string | undefined => {
    if (refusedModel !== undefined) refusedNow.add(refusedModel);
    const from = entryIndex(rule, refusedModel);
    for (let i = from + 1; i < rule.models.length; i++) {
      const candidate = rule.models[i]!;
      if (refusedNow.has(candidate)) continue;
      let usable = false;
      try {
        usable = deps.isUsable(candidate, refusedKeys);
      } catch {
        usable = false;
      }
      if (!usable) {
        deps.logger?.info("refusal_rule_entry_skipped", { sessionId: deps.sessionId, site, rule: rule.name, model: candidate });
        continue;
      }
      setPin(rule, candidate);
      return candidate;
    }
    return undefined;
  };

  const record = (event: SessionRefusalEvent): Promise<number> => {
    if (!deps.insertEvent) return Promise.resolve(0);
    try {
      return deps.insertEvent({
        ...event,
        ts: now(),
        agentSessionId: deps.sessionId ?? null,
        site,
        agent: deps.agent,
        timelineKey: deps.timelineKey ?? null,
        tasks: event.tasks ?? null,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const onHardRefusal = (info: RefusalAttemptInfo): RefusalDecision => {
    const message = info.message as
      | (RefusalAttemptInfo["message"] & { stopCategory?: string | null })
      | undefined;
    const refusedModel = info.servedModel;
    const category = typeof message?.stopCategory === "string" && message.stopCategory.length > 0 ? message.stopCategory : null;
    const cls = classifyHardRefusal(
      deps.catalogue,
      { api: message?.api, rawStopReason: message?.rawStopReason, category },
      deps.agent,
    );
    const rule = matchRule({ reason: cls.reason, kind: "hard", fromModel: refusedModel });
    let action: RefusalDecision["action"];
    let outcome: RefusalOutcome;
    let toModel: string | undefined;
    if (!rule) {
      if (refusedModel !== undefined) refusedNow.add(refusedModel);
      action = info.implicitFallover ? "fallover" : "fail";
      outcome = info.implicitFallover ? "fallover" : "failed";
    } else if (!info.canReissue) {
      // The wall-clock budget is spent: no attempt can be issued any more.
      if (refusedModel !== undefined) refusedNow.add(refusedModel);
      action = "fail";
      outcome = "failed";
    } else {
      toModel = advanceWith(rule, refusedModel, info.refusedKeys);
      if (toModel !== undefined) {
        action = "redo";
        outcome = "redo";
      } else {
        outcome = exhaustedOutcome(rule, site);
        // A hard refusal has no text, so send_last parks like park (spec §8.2).
        action = outcome === "exhausted_withheld" ? "withhold" : "fail";
      }
    }
    lastOutcome = outcome;
    const explanation = message?.errorMessage ? stripLlmRequestTag(message.errorMessage) : null;
    void record({
      kind: "hard",
      checkCode: cls.checkCode,
      reason: cls.reason,
      subReason: cls.subReason,
      method: cls.method,
      source: "api",
      servedModel: refusedModel ?? null,
      wireModel: message?.model ?? null,
      rawStopReason: message?.rawStopReason ?? null,
      category,
      explanation,
      checkpoint: "request",
      ruleName: rule?.name ?? null,
      outcome,
      toModel: toModel ?? null,
    }).catch((error: unknown) => {
      deps.logger?.warn("refusal_event_write_failed", {
        sessionId: deps.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return {
      action,
      log: {
        site,
        checkCode: cls.checkCode,
        reason: cls.reason,
        subReason: cls.subReason,
        category,
        rule: rule?.name,
        outcome,
        toModel,
      },
    };
  };

  return {
    get site() {
      return site;
    },
    agent: deps.agent,
    tasks: () => null,
    servingModel: () => serving ?? pin?.model ?? deps.headModel,
    pinnedModel: () => pin?.model,
    pin: () => (pin ? { ...pin } : undefined),
    lastHardOutcome: () => lastOutcome,
    matchRule,
    softRuleCouldMatch: () => {
      const rules = scoped();
      if (rules.length === 0) return false;
      const current = serving ?? pin?.model ?? deps.headModel;
      const continuing = pinRule();
      return rules.some(
        (rule) =>
          rule.soft === "redo" &&
          (!rule.fromModels ||
            (current !== undefined && rule.fromModels.includes(current)) ||
            (rule === continuing && entryIndex(rule, current) >= 0)),
      );
    },
    advance: (rule, refusedModel) => advanceWith(rule, refusedModel),
    record,
    onHardRefusal,
    setSite: (next) => {
      site = next ?? deps.sessionType;
    },
    noteServing: (logicalId) => {
      serving = logicalId;
    },
    noteCommitted: () => {
      refusedNow.clear();
    },
  };
}

/**
 * Logical ids of every model a session's refusal rules can switch it to, for
 * model-prompt resolution (spec §8.3): the rules whose scope admits any of the
 * session's sites.
 */
export function refusalRuleModels(
  rules: readonly RefusalRule[],
  scope: { sites: readonly string[]; agent: string | null },
): string[] {
  const models = new Set<string>();
  for (const site of scope.sites) {
    for (const rule of refusalRulesForSession(rules, { site, agent: scope.agent, tasks: null })) {
      for (const model of rule.models) models.add(model);
    }
  }
  return [...models];
}
