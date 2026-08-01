// =============================================================================
// `[[user_limits]]` config → normalized rules (spec PER-USER-LIMITS §9).
//
// TypeBox has validated shape. This layer parses windows, expands the `max_usd`
// shorthand, renders the per-field cascade inputs, and runs the cross-field
// semantic checks (§9) — kept out of the loader per the project convention that
// cross-field validation lives in app.ts (this module is called from there),
// mirroring `normalizeLimits`.
// =============================================================================

import type {
  NormalizedConstraint,
  NormalizedUserLimitRule,
} from "./user-limits.js";
import type { WindowSpec } from "./window.js";
import { isValidTimeZone, parseDuration } from "./window.js";

/** Raw window (mirrors LimitWindowSchema). */
type RawWindow =
  | { type: "rolling"; duration: string }
  | { type: "calendar"; period: "day" | "week" | "month"; tz?: string };

/** Raw constraint (mirrors UserLimitConstraintSchema). */
interface RawConstraint {
  max_usd: number;
  window: RawWindow;
  models?: string[];
  partition?: string;
}

/** Raw rule (mirrors UserLimitRuleSchema). */
export interface RawUserLimitRule {
  user?: string | string[];
  room?: string | string[];
  space?: string | string[];
  models?: string[];
  limits?: RawConstraint[];
  max_usd?: number;
  window?: RawWindow;
  trigger_rejection_message?: string;
  /** Agent/account scope (spec MULTI-AGENT-SUPPORT §8). */
  agent?: string;
  account?: string;
}

export interface NormalizeUserLimitsResult {
  rules: NormalizedUserLimitRule[];
  fatal: string[];
  warnings: string[];
}

/**
 * All recognized partition variable names (canonical + aliases). Canonical:
 * `{channel_id}` (channel scope), `{server_id}` (server/guild/space scope).
 * Aliases: `{room_id}` = `{channel_id}`; `{space_id}` = `{server_id}`.
 * `{homeserver}` is Matrix-only; a rule using it with no Matrix provider earns
 * a config-load warning.
 */
const KNOWN_PARTITION_VARS = new Set(["user_id", "room_id", "channel_id", "homeserver", "space_id", "server_id"]);
const DEFAULT_SHORTHAND_WINDOW: RawWindow = { type: "rolling", duration: "24h" };
/**
 * Upper bound on DISTINCT shared-pool partition values in one rule (spec
 * MULTI-SHARED-POOL §4). Each pool an event joins beyond the first costs one
 * `usage_event_partitions` child insert on the hot path, so the cap bounds that
 * write amplification. Realistic nesting (per-room + per-space + fleet) is 2–3;
 * this leaves generous headroom while refusing pathological configs.
 */
const MAX_SHARED_POOLS_PER_RULE = 8;

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  return list.length > 0 ? list : undefined;
}

/** Extract `{var}` template variable names from a partition template. */
function partitionVars(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
}

/** True when a partition template has no `{...}` variables (a fully-static key). */
function isStaticPartition(template: string): boolean {
  return !/\{[^}]*\}/.test(template);
}

/**
 * Emit a warning when `varName` is a known variable that no enabled provider can
 * supply at runtime (§6.4). Currently only `{homeserver}` is Matrix-only; all
 * other known vars are available from any provider.
 */
function checkProviderVar(
  varName: string,
  enabledProviders: string[],
  label: string,
  warnings: string[],
): void {
  if (varName === "homeserver" && !enabledProviders.includes("matrix")) {
    warnings.push(
      `${label}: partition variable "{homeserver}" is Matrix-only but no Matrix provider is enabled — ` +
        `the variable will always resolve to "" for enabled providers; consider {user_id} instead`,
    );
  }
}

/**
 * True when the template contains a lone, unmatched brace — a `{` or `}` that is not
 * part of a well-formed `{var}` (issue #7). Strips every well-formed `{...}` group;
 * any residual brace is malformed. Without this, `"{user_id"` (missing `}`) matches
 * no variable and silently degrades to a literal global pool instead of failing.
 */
function hasUnbalancedBrace(template: string): boolean {
  return /[{}]/.test(template.replace(/\{[^{}]*\}/g, ""));
}

/**
 * Normalize + validate `[[user_limits]]` (spec §9). `defaultTz` backfills an
 * omitted calendar tz; `knownModelIds` is the union of configured model ids — a
 * `models` / sub-cap reference outside it is FATAL (unlike §8e's soft warn: a
 * per-user model is SELECTED, so a dangling name would crash the fallback build).
 *
 * `enabledProviders` (optional): when supplied, a warning is emitted when a rule
 * uses a partition variable that no enabled provider can supply at runtime (§6.4).
 * The only such variable today is `{homeserver}`, which is Matrix-only.
 *
 * Agent/account scope options (spec MULTI-AGENT-SUPPORT §8): same semantics as
 * `normalizeLimits` — see that function for field documentation.
 */
export function normalizeUserLimits(
  raw: RawUserLimitRule[] | undefined,
  opts: {
    defaultTz: string;
    knownModelIds: Set<string>;
    enabledProviders?: string[];
    /** True when the `[agents]` table is present (agents mode). */
    isAgentsMode?: boolean;
    /** agentName → ["provider:accountKey", …] — resolves `agent` matchers. */
    agentAccountPrefixes?: Map<string, string[]>;
    /** All configured account prefixes ("provider:accountKey") — validates `account` matchers. */
    knownAccountPrefixes?: Set<string>;
  },
): NormalizeUserLimitsResult {
  const rules: NormalizedUserLimitRule[] = [];
  const fatal: string[] = [];
  const warnings: string[] = [];

  (raw ?? []).forEach((entry, order) => {
    const label = `[[user_limits]] #${order + 1}`;
    const fatalsBefore = fatal.length;

    const user = asList(entry.user);
    const room = asList(entry.room);
    const space = asList(entry.space);

    if (!user && !room && !space) {
      fatal.push(`${label}: at least one match dimension (user/room/space) is required`);
    }

    // ── Models (the preference set) ──
    const models = entry.models;
    for (const m of models ?? []) {
      if (!opts.knownModelIds.has(m)) {
        fatal.push(`${label}: models references unknown model "${m}" (not in [models.*])`);
      }
    }
    if (models && models.length === 0) {
      // An explicit empty set = ban via "no model" (spec §3.4). Kept (not fatal).
    }

    // ── Constraints: shorthand XOR limits ──
    const hasShorthand = entry.max_usd !== undefined;
    const hasLimits = entry.limits !== undefined && entry.limits.length > 0;
    if (hasShorthand && hasLimits) {
      fatal.push(`${label}: set either max_usd (shorthand) or limits, not both`);
    }

    const constraints: NormalizedConstraint[] = [];
    let exempt = false;

    const parseWindow = (w: RawWindow, where: string): WindowSpec | undefined => {
      if (w.type === "rolling") {
        let durationMs: number;
        try {
          durationMs = parseDuration(w.duration);
        } catch (error) {
          fatal.push(`${label} ${where}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
        if (!(durationMs > 0)) {
          fatal.push(`${label} ${where}: rolling duration must be > 0`);
          return undefined;
        }
        return { type: "rolling", durationMs, duration: w.duration };
      }
      const tz = w.tz ?? opts.defaultTz;
      if (!isValidTimeZone(tz)) {
        fatal.push(`${label} ${where}: invalid calendar tz "${tz}"`);
        return undefined;
      }
      return { type: "calendar", period: w.period, tz };
    };

    if (hasShorthand) {
      const maxUsd = entry.max_usd!;
      if (maxUsd < 0) {
        exempt = true; // explicit exempt — budget block present, no constraints
        if (entry.window) warnings.push(`${label}: window ignored for exempt (max_usd < 0)`);
      } else {
        if (entry.window === undefined && maxUsd > 0) {
          warnings.push(`${label}: max_usd shorthand without window — defaulting to 24h rolling`);
        }
        const window = parseWindow(entry.window ?? DEFAULT_SHORTHAND_WINDOW, "max_usd window");
        if (window) {
          constraints.push({ index: 0, maxUsd, window, partition: "{user_id}", shared: false });
        }
      }
    } else if (hasLimits) {
      entry.limits!.forEach((c, index) => {
        const window = parseWindow(c.window, `limits[${index}]`);
        if (!window) return;
        const partition = c.partition ?? "{user_id}";
        // A lone unmatched brace is fatal (§9) — a malformed template like "{user_id"
        // (missing `}`) must NOT silently degrade to a literal global pool (#7).
        if (hasUnbalancedBrace(partition)) {
          fatal.push(
            `${label} limits[${index}]: malformed partition template "${partition}" ` +
              `(unmatched "{" or "}"; a variable must be written "{name}")`,
          );
        }
        // Partition template var validation (§9): only known vars (incl. {space_id},
        // §11 second slice; {channel_id}/{server_id} canonical names also accepted).
        for (const v of partitionVars(partition)) {
          if (!KNOWN_PARTITION_VARS.has(v)) {
            fatal.push(`${label} limits[${index}]: unknown partition variable "{${v}}"`);
          } else if (opts.enabledProviders) {
            // Provider-supply warning (§6.4): warn when no enabled provider can
            // supply this var. Only `{homeserver}` has a provider restriction today.
            checkProviderVar(v, opts.enabledProviders, `${label} limits[${index}]`, warnings);
          }
        }
        // Sub-cap scope must reference known + declared models (§9).
        if (c.models) {
          if (!models) {
            fatal.push(
              `${label} limits[${index}]: a sub-cap (models=…) requires the rule to declare models`,
            );
          }
          for (const m of c.models) {
            if (!opts.knownModelIds.has(m)) {
              fatal.push(`${label} limits[${index}]: unknown model "${m}"`);
            } else if (models && !models.includes(m)) {
              fatal.push(`${label} limits[${index}]: sub-cap model "${m}" not in the rule's models`);
            }
          }
        }
        constraints.push({
          index,
          maxUsd: c.max_usd,
          window,
          models: c.models ? [...c.models] : undefined,
          partition,
          shared: partition !== "{user_id}",
        });
      });
    }

    const hasBudgetBlock = models !== undefined || hasShorthand || hasLimits;

    // ── Cross-field warnings (§3.3 / §3.5) ──
    if (hasBudgetBlock && !exempt && constraints.length > 0) {
      const hasTotal = constraints.some((c) => c.models === undefined);
      const hasPositiveSubCap = constraints.some((c) => c.models !== undefined && c.maxUsd > 0);
      if (hasPositiveSubCap && !hasTotal) {
        warnings.push(
          `${label}: a positive sub-cap with no covering total reserves no headroom for ` +
            `cheaper continuation — degradation will never fire (spec §3.3)`,
        );
      }
      // Divergent caps on a shared fully-static key (likely a mistake, §3.5).
      const staticGroups = new Map<string, Set<number>>();
      for (const c of constraints) {
        if (!isStaticPartition(c.partition)) continue;
        const key = `${c.partition}#${c.models ? [...c.models].sort().join(",") : "*"}#${windowKeyOf(c.window)}`;
        const caps = staticGroups.get(key) ?? new Set<number>();
        caps.add(c.maxUsd);
        staticGroups.set(key, caps);
      }
      for (const [key, caps] of staticGroups) {
        if (caps.size > 1) {
          warnings.push(`${label}: constraints share static partition key "${key}" with divergent caps`);
        }
      }
    }

    // ── ≤ MAX_SHARED_POOLS_PER_RULE distinct non-{user_id} partition values per rule
    // (spec MULTI-SHARED-POOL §4). Multiple shared pools are now supported: a single
    // event joins each covering pool, its first key denormalized on `budget_partition`
    // and the rest spilled to `usage_event_partitions` (one child insert per overflow
    // pool). The bound keeps that hot-path write amplification bounded — a rule with N
    // distinct shared pools costs ≤ N-1 extra inserts per pooled event. (Was: a hard
    // "at most one shared pool" fatal, when overflow membership had no storage.) ──
    const sharedTemplates = new Set(
      constraints.filter((c) => c.shared).map((c) => c.partition),
    );
    if (sharedTemplates.size > MAX_SHARED_POOLS_PER_RULE) {
      fatal.push(
        `${label}: a rule may reference at most ${MAX_SHARED_POOLS_PER_RULE} shared pools ` +
          `(distinct non-{user_id} partitions) — found ${sharedTemplates.size}: ` +
          `${[...sharedTemplates].map((p) => `"${p}"`).join(", ")} (spec MULTI-SHARED-POOL §4)`,
      );
    }

    // A rule that does nothing at all (no budget block, no message) is inert.
    if (!hasBudgetBlock && entry.trigger_rejection_message === undefined) {
      warnings.push(`${label}: rule has no budget block and no trigger_rejection_message (no effect)`);
    }

    // ── Agent/account scope (spec MULTI-AGENT-SUPPORT §8) ────────────────────
    // Single if-else-if chain: at most ONE branch fires per entry, mirroring
    // normalizeLimits' single-fatal behavior and preventing the double-fatal where
    // both `agent`+`account` set AND agent-not-found would push two fatals.
    let timelineKeyPrefixes: string[] | undefined;
    if (entry.agent !== undefined && entry.account !== undefined) {
      fatal.push(`${label}: cannot set both agent and account on the same rule`);
    } else if ((entry.agent !== undefined || entry.account !== undefined) && !opts.isAgentsMode) {
      fatal.push(
        `${label}: agent/account matcher requires agents mode ([agents] table) — not valid in legacy mode`,
      );
    } else if (entry.agent !== undefined) {
      // opts.isAgentsMode is implicitly true here (both-set and !isAgentsMode handled above).
      const prefixes = opts.agentAccountPrefixes?.get(entry.agent);
      if (prefixes === undefined) {
        fatal.push(`${label}: agent "${entry.agent}" is not a declared [agents.*] block`);
      } else if (prefixes.length === 0) {
        fatal.push(
          `${label}: agent "${entry.agent}" is declared but has no configured accounts` +
            ` — cannot scope a limit rule to it`,
        );
      } else {
        timelineKeyPrefixes = prefixes;
      }
    } else if (entry.account !== undefined) {
      // opts.isAgentsMode is implicitly true here.
      if (!entry.account.includes(":")) {
        fatal.push(`${label}: account "${entry.account}" must be in "provider:key" format`);
      } else if (opts.knownAccountPrefixes && !opts.knownAccountPrefixes.has(entry.account)) {
        fatal.push(`${label}: account "${entry.account}" is not a configured account`);
      } else {
        timelineKeyPrefixes = [entry.account];
      }
    }

    // Only push the rule if it introduced no fatals (a fatal rule is dropped from
    // the live set; startup fails fast on `fatal` anyway).
    if (fatal.length === fatalsBefore) {
      rules.push({
        order,
        user,
        room,
        space,
        hasBudgetBlock,
        models,
        constraints,
        messageTemplate: entry.trigger_rejection_message,
        timelineKeyPrefixes,
      });
    }
  });

  return { rules, fatal, warnings };
}

function windowKeyOf(w: WindowSpec): string {
  return w.type === "rolling" ? `r:${w.duration}` : `c:${w.period}:${w.tz}`;
}
