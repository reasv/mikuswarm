// =============================================================================
// `[[limits]]` config → normalized LimitRule[] (spec USAGE-COST-LIMITS §5).
//
// TypeBox has already validated shape/bounds at load. This layer parses the
// duration string, defaults the calendar tz, and runs the cross-field semantic
// checks (§5.2) — kept out of the loader per the project convention that
// cross-field validation lives in app.ts (this module is called from there).
// =============================================================================

import type { LimitRule, RuleSelector } from "./engine.js";
import { isValidTimeZone, parseDuration } from "./window.js";

/** The raw config shape of one `[[limits]]` entry (mirrors LimitRuleSchema). */
export interface RawLimitRule {
  name: string;
  max_usd: number;
  window:
    | { type: "rolling"; duration: string }
    | { type: "calendar"; period: "day" | "week" | "month"; tz?: string };
  classes?: ("agent_loop" | "tool" | "caption" | "embedding")[];
  session_types?: string[];
  tools?: string[];
  models?: string[];
  trigger_rejection_message?: string;
}

/** Outcome of normalizing + validating the rule set (spec §5.2). */
export interface NormalizeResult {
  rules: LimitRule[];
  /** Fatal config errors — startup should fail fast on any of these. */
  fatal: string[];
  /** Non-fatal warnings (config survives, but the operator should know). */
  warnings: string[];
}

/**
 * Normalize + validate `[[limits]]`. `defaultTz` (from `agent.timezone`, else
 * "UTC") backfills a calendar rule's omitted tz. `knownTools`/`knownSessionTypes`
 * drive soft "unknown reference" warnings (config survives renames). A rule whose
 * duration or tz is invalid is dropped and reported as fatal.
 */
export function normalizeLimits(
  raw: RawLimitRule[] | undefined,
  opts: {
    defaultTz: string;
    knownTools: Set<string>;
    knownSessionTypes: Set<string>;
  },
): NormalizeResult {
  const rules: LimitRule[] = [];
  const fatal: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw ?? []) {
    if (seen.has(entry.name)) {
      fatal.push(`[[limits]]: duplicate rule name "${entry.name}"`);
      continue;
    }
    seen.add(entry.name);

    let window: LimitRule["window"];
    if (entry.window.type === "rolling") {
      let durationMs: number;
      try {
        durationMs = parseDuration(entry.window.duration);
      } catch (error) {
        fatal.push(
          `[[limits]] "${entry.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!(durationMs > 0)) {
        fatal.push(`[[limits]] "${entry.name}": rolling duration must be > 0`);
        continue;
      }
      window = { type: "rolling", durationMs, duration: entry.window.duration };
    } else {
      const tz = entry.window.tz ?? opts.defaultTz;
      if (!isValidTimeZone(tz)) {
        fatal.push(`[[limits]] "${entry.name}": invalid calendar tz "${tz}"`);
        continue;
      }
      window = { type: "calendar", period: entry.window.period, tz };
    }

    const selector: RuleSelector = {};
    if (entry.classes && entry.classes.length > 0) selector.classes = [...entry.classes];
    if (entry.session_types && entry.session_types.length > 0)
      selector.sessionTypes = [...entry.session_types];
    if (entry.tools && entry.tools.length > 0) selector.tools = [...entry.tools];
    if (entry.models && entry.models.length > 0) selector.models = [...entry.models];

    // Soft reference checks (§5.2): warn, never fail, so config survives renames.
    for (const t of selector.tools ?? []) {
      if (!opts.knownTools.has(t)) warnings.push(`[[limits]] "${entry.name}": unknown tool "${t}"`);
    }
    for (const st of selector.sessionTypes ?? []) {
      if (!opts.knownSessionTypes.has(st))
        warnings.push(`[[limits]] "${entry.name}": unknown session type "${st}"`);
    }

    // A trigger_rejection_message is only meaningful on a rule that can cover a
    // triggered (default) session — i.e. one whose class selector includes
    // agent_loop (or is wildcard) and whose session_types include "default" (or
    // is wildcard). Warn otherwise; the message would never fire (§5.2).
    if (entry.trigger_rejection_message) {
      const coversAgentLoop = !selector.classes || selector.classes.includes("agent_loop");
      const coversDefault = !selector.sessionTypes || selector.sessionTypes.includes("default");
      if (!coversAgentLoop || !coversDefault) {
        warnings.push(
          `[[limits]] "${entry.name}": trigger_rejection_message set on a rule that cannot cover a triggered session (no effect)`,
        );
      }
    }

    rules.push({
      name: entry.name,
      maxUsd: entry.max_usd,
      window,
      selector,
      triggerRejectionMessage: entry.trigger_rejection_message,
    });
  }

  return { rules, fatal, warnings };
}
