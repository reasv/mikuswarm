/**
 * Per-session refusal handling (spec REFUSAL-HANDLING §8): the rules that can
 * apply to a session, the sticky pin a rule redo leaves behind, the refusal
 * statistics rows, and Layer 0's decision on a hard refusal.
 *
 * One handle per created agent. The factory builds it with the session's site,
 * agent and rules plus a usability predicate over its own model composites
 * (health, budget, per-user limits, fits, capability); Layer 0 asks it on every
 * refused attempt ({@link SessionRefusalController.onHardRefusal}); the output
 * gate's acting policy reads the same handle through `CreatedAgent.refusal`.
 */
import { INTERNAL_SITES, type CheckCatalogue, type RefusalRule } from "../checks/types.js";
import type { Logger } from "../observability/logger.js";
import type { RefusalEventInsert, RefusalOutcome, RefusalPin } from "../storage/database.js";
import { stripLlmRequestTag, type RefusalAttemptInfo, type RefusalDecision } from "../agent/request-retry.js";
import {
  RefusalRuleWalk,
  matchRefusalRule,
  refusalRulesForSession,
  ruleAdmitsIgnoringFromModels,
  ruleModelKeys,
} from "./rules.js";
import { classifyApiRefusal, UNCATEGORIZED_REFUSAL_CODE } from "./signals.js";

/** A refusal event as a handle records it: the session fields are filled in. */
export type SessionRefusalEvent = Omit<RefusalEventInsert, "ts" | "site" | "agent" | "timelineKey" | "agentSessionId">;

/** The session-facing refusal interface: what the gate, the redo handler and the workers use. */
export interface SessionRefusalHandle {
  /** The current site: the session type, or `record_turn` while the record turn runs. */
  readonly site: string;
  readonly agent: string | null;
  /** The session's task keys (multi-label, DECISION-MODEL §5.1a); null = taskless. */
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
  matchRule(input: { reason: string; detectedReasons?: readonly string[]; kind: "hard" | "soft"; fromModel?: string }): RefusalRule | undefined;
  /** Some soft = "redo" rule could match this session now, for any reason. Cheap. */
  softRuleCouldMatch(): boolean;
  /**
   * The rule's next try at this refusal point (spec §8.1 "Tries and same-model
   * retries"): the current entry while it has tries left, else the next entry;
   * `@same` is the model that refused when the walk started; entries failing the
   * session's gates (health, budget, per-user limits, context fits, capability)
   * are skipped whole. A try on another model pins the session to it (persisted);
   * a try on `refusedModel` itself is a same-model retry and leaves the pin as it
   * is. Hard-refusal streaks reset on a clean request at the current entry.
   * Soft walks last until a message is delivered (or the site changes); a
   * different rule starts a new walk. Undefined = every entry, every try, spent.
   * The returned model may equal `refusedModel`.
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
  /** A clean request ends a hard-refusal streak and clears its temporary retry target. */
  noteCommitted(): void;
  /** A message was delivered: the refusal point ends; the next refusal starts a rule from its first entry. */
  noteDelivered(): void;
  /** The model the session's requests go to: a same-model retry's target, else the pin. */
  dispatchModel(): string | undefined;
}

export interface SessionRefusalDeps {
  /** The session type name (the default site). */
  sessionType: string;
  agent: string | null;
  /** The session's task keys (routing, or the built-in `proactive`); null/absent = taskless. */
  tasks?: readonly string[] | null;
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
  /**
   * The session's gates for a rule entry (health, budget, per-user limits, fits,
   * capability). A model that refused is NOT excluded: explicit entries may
   * re-send to it (spec §8.1 tries); only the implicit fallover never does.
   */
  isUsable: (logicalId: string) => boolean;
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
  const tasks: string[] | null = deps.tasks && deps.tasks.length > 0 ? [...deps.tasks] : null;
  let site = deps.sessionType;
  let serving: string | undefined;
  let lastOutcome: RefusalOutcome | undefined;
  // Models that refused in the current request (or redo): never chosen again for it.
  // The current refusal point's walk through a rule (spec §8.1 tries): lives
  // until a message is delivered or the site changes.
  let walk: RefusalRuleWalk | undefined;
  // A same-model retry's target for the rest of the current request (the pin
  // does not move when a try re-sends to the model that refused).
  let retryTarget: string | undefined;
  let hardRetryPending = false;
  // The rules whose scope admits the current site (cached per site).
  const scopedBySite = new Map<string, RefusalRule[]>();
  const scoped = (): RefusalRule[] => {
    let list = scopedBySite.get(site);
    if (!list) {
      list = refusalRulesForSession(deps.rules, { site, agent: deps.agent, tasks });
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

  /** `refused` is `model`, or a member of its fallback chain that served on its behalf. */
  const servedFor = (model: string | undefined, refused: string | undefined): boolean =>
    model !== undefined && refused !== undefined && (model === refused || deps.chainOf(model).includes(refused));

  const matchRule: SessionRefusalHandle["matchRule"] = (input) => {
    const scope = { site, agent: deps.agent, tasks, reason: input.reason, detectedReasons: input.detectedReasons, kind: input.kind };
    // The model a running walk handed out refused: the same rule continues, when
    // it admits this refusal apart from `from_models` (they named the model that
    // refused first). Likewise for the rule the session is pinned by, when its
    // pinned model refuses at a later refusal point (spec §8.1 tries).
    if (walk && servedFor(walk.last, input.fromModel) && ruleAdmitsIgnoringFromModels(walk.rule, scope)) return walk.rule;
    const pinned = pinRule();
    if (pinned && servedFor(pin?.model, input.fromModel) && ruleAdmitsIgnoringFromModels(pinned, scope)) return pinned;
    return matchRefusalRule(deps.rules, { ...scope, fromModel: input.fromModel });
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

  const advanceWith = (rule: RefusalRule, refusedModel: string | undefined): string | undefined => {
    // A new walk unless this refusal point is already walking this rule.
    if (!walk || walk.rule.name !== rule.name) {
      walk = new RefusalRuleWalk(rule, refusedModel ?? pin?.model ?? deps.headModel ?? "");
      if (pin?.rule === rule.name) walk.resumeAt(pin.model);
    }
    const model = walk.next(
      (candidate) => {
        try {
          return candidate.length > 0 && deps.isUsable(candidate);
        } catch {
          return false;
        }
      },
      (candidate) =>
        deps.logger?.info("refusal_rule_entry_skipped", { sessionId: deps.sessionId, site, rule: rule.name, model: candidate }),
    );
    if (model === undefined) return undefined;
    if (model === refusedModel) {
      // A same-model retry (@same, or the refusing model listed again): a fresh
      // sample of the same model; the pin does not move (spec §8.1).
      retryTarget = model;
    } else {
      retryTarget = undefined;
      setPin(rule, model);
    }
    return model;
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
        tasks: event.tasks !== undefined ? event.tasks : tasks,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const onHardRefusal = (info: RefusalAttemptInfo): RefusalDecision => {
    hardRetryPending = true;
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
      action = info.implicitFallover ? "fallover" : "fail";
      outcome = info.implicitFallover ? "fallover" : "failed";
    } else if (!info.canReissue) {
      // The wall-clock budget is spent: no attempt can be issued any more.
      action = "fail";
      outcome = "failed";
    } else {
      toModel = advanceWith(rule, refusedModel);
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
    tasks: () => (tasks ? [...tasks] : null),
    servingModel: () => serving ?? pin?.model ?? deps.headModel,
    pinnedModel: () => pin?.model,
    pin: () => (pin ? { ...pin } : undefined),
    lastHardOutcome: () => lastOutcome,
    matchRule,
    softRuleCouldMatch: () => {
      const rules = scoped();
      if (rules.length === 0) return false;
      const current = serving ?? pin?.model ?? deps.headModel;
      return rules.some(
        (rule) =>
          rule.soft === "redo" &&
          (!rule.fromModels ||
            (current !== undefined && rule.fromModels.includes(current)) ||
            rule.name === pin?.rule ||
            rule.name === walk?.rule.name),
      );
    },
    advance: (rule, refusedModel) => advanceWith(rule, refusedModel),
    record,
    onHardRefusal,
    setSite: (next) => {
      const nextSite = next ?? deps.sessionType;
      if (nextSite !== site) {
        walk = undefined;
        retryTarget = undefined;
        hardRetryPending = false;
      }
      site = nextSite;
    },
    dispatchModel: () => retryTarget ?? pin?.model,
    noteDelivered: () => {
      walk = undefined;
    },
    noteServing: (logicalId) => {
      serving = logicalId;
    },
    noteCommitted: () => {
      // A successful request ends a HARD-refusal streak. Soft redos are judged
      // after commit and keep their separate walk until delivery/site change.
      if (hardRetryPending) {
        walk?.resetStreak();
        hardRetryPending = false;
        lastOutcome = undefined;
      }
      retryTarget = undefined;
    },
  };
}

/**
 * Logical ids of every model a session's refusal rules can switch it to, for
 * model-prompt resolution (spec §8.3): the rules whose scope admits any of the
 * session's sites (and its tasks).
 */
export function refusalRuleModels(
  rules: readonly RefusalRule[],
  scope: { sites: readonly string[]; agent: string | null; tasks?: readonly string[] | null },
): string[] {
  const models = new Set<string>();
  for (const site of scope.sites) {
    for (const rule of refusalRulesForSession(rules, { site, agent: scope.agent, tasks: scope.tasks ?? null })) {
      for (const model of ruleModelKeys(rule)) models.add(model);
    }
  }
  return [...models];
}
