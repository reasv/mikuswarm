import assert from "node:assert/strict";
import test from "node:test";
import { safeCheckAdmission, safeProactiveDeferUntil } from "../src/app.js";
import type { AdmissionResult } from "../src/budget/index.js";

// =============================================================================
// spec USAGE-COST-LIMITS — review #7: the budget admission gate and proactive
// defer call the BudgetEngine OUTSIDE exception isolation. A throw inside
// `launchSession`'s admission gate unwinds to the dispatch `catch`, which does
// `releaseClaimFor` + rethrow but NOT `triggerCoordinator.complete`, leaking the
// per-timeline slot. The fix wraps both in fail-open guards (`safeCheckAdmission`,
// `safeProactiveDeferUntil`): on a throw, admit / no-defer and log — a
// budget-engine bug must never silently stop the bot from responding.
// =============================================================================

/** A logger that records `warn` calls for assertions; other levels are no-ops. */
function capturingLogger() {
  const warns: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    debug() {}, info() {}, error() {},
    warn(message: string, fields?: Record<string, unknown>) {
      warns.push({ message, fields });
    },
    child() {
      return logger;
    },
  } as never;
  return { logger, warns };
}

const allowed: AdmissionResult = { allowed: true, ownBlocking: [] };
const blocked: AdmissionResult = {
  allowed: false,
  ownBlocking: [
    { name: "cap", spentUsd: 5, capUsd: 1, window: { type: "rolling", durationMs: 1000, duration: "1s" }, resetsAt: 9_999 },
  ],
  primary: { name: "cap", resetsAt: 9_999 },
};

// --- #7 admission gate fail-open ---------------------------------------------

test("#7 safeCheckAdmission: a throwing engine FAILS OPEN (returns undefined = admit) and logs", () => {
  const { logger, warns } = capturingLogger();
  const engine = {
    checkAdmission(): AdmissionResult {
      throw new Error("budget engine boom");
    },
    accurateResetsAt() {
      return undefined;
    },
  };
  const result = safeCheckAdmission(engine, "default", "m1", logger, { sessionId: "s1" });
  // Fail-open: undefined means "admit" at the call site — the session is NOT
  // discarded, so it falls through to a normal launch and its slot releases on
  // settle as usual (no leak; the throw can no longer escape launchSession).
  assert.equal(result, undefined, "a throw yields undefined (admit), never re-raises");
  const warn = warns.find((w) => w.message === "usage_admission_check_threw");
  assert.ok(warn, "the swallowed throw is logged with a stable tag");
  assert.equal(warn!.fields?.sessionId, "s1", "the call-site context is carried into the log");
  assert.match(String(warn!.fields?.error), /boom/);
});

test("#7 safeCheckAdmission: a non-throwing engine passes the decision through unchanged", () => {
  const { logger, warns } = capturingLogger();
  const okEngine = {
    checkAdmission: () => allowed,
    accurateResetsAt: () => undefined,
  };
  assert.equal(safeCheckAdmission(okEngine, "default", "m1", logger)?.allowed, true);

  const denyEngine = {
    checkAdmission: () => blocked,
    accurateResetsAt: () => undefined,
  };
  const deny = safeCheckAdmission(denyEngine, "default", "m1", logger);
  assert.equal(deny?.allowed, false, "a genuine block decision is preserved (still refuses)");
  assert.equal(deny?.primary?.name, "cap");
  assert.equal(warns.length, 0, "no error log on the happy/deny path");
});

test("#1 safeCheckAdmission: a supplied chain routes through checkAdmissionChain", () => {
  // The launch gate (spec MODEL-FALLBACK §6.1) passes the session's whole fallback
  // chain so an in-budget fallback admits even when the head is capped. Verify the
  // chain arg dispatches to `checkAdmissionChain` (not the head-only path).
  const { logger } = capturingLogger();
  const seen: { chain?: string[]; viaChain: boolean } = { viaChain: false };
  const engine = {
    checkAdmission(): AdmissionResult {
      return blocked; // head-only path would refuse
    },
    checkAdmissionChain(_t: string, _m: string, chain: string[]): AdmissionResult {
      seen.viaChain = true;
      seen.chain = chain;
      return allowed; // chain-aware path admits (a fallback is in budget)
    },
    accurateResetsAt: () => undefined,
  };
  const result = safeCheckAdmission(engine, "default", "m1", logger, {}, ["primary", "fallback"]);
  assert.equal(seen.viaChain, true, "the chain arg dispatches to checkAdmissionChain");
  assert.deepEqual(seen.chain, ["primary", "fallback"], "the resolved chain is forwarded");
  assert.equal(result?.allowed, true, "an in-budget fallback admits despite a capped head");
});

// --- #7 proactive defer fail-open --------------------------------------------

test("#7 safeProactiveDeferUntil: a throwing engine FAILS OPEN (no defer) and logs", () => {
  const { logger, warns } = capturingLogger();
  const engine = {
    checkAdmission(): AdmissionResult {
      throw new Error("defer boom");
    },
    accurateResetsAt: () => undefined,
  };
  const when = safeProactiveDeferUntil(engine, "proactive", () => "m1", logger);
  assert.equal(when, undefined, "a throw yields no defer (proactive posting is never stalled by a bug)");
  const warn = warns.find((w) => w.message === "usage_proactive_defer_check_threw");
  assert.ok(warn, "the swallowed throw is logged");
  assert.equal(warn!.fields?.proactiveType, "proactive");
});

test("#7 safeProactiveDeferUntil: unresolvable model id → no defer, no throw", () => {
  const { logger, warns } = capturingLogger();
  const engine = {
    checkAdmission: () => blocked,
    accurateResetsAt: () => 12_345,
  };
  // resolveModelId throws → no defer (matches the engine's own unresolvable handling).
  assert.equal(
    safeProactiveDeferUntil(engine, "proactive", () => { throw new Error("no model"); }, logger),
    undefined,
  );
  // resolveModelId returns undefined → no defer.
  assert.equal(safeProactiveDeferUntil(engine, "proactive", () => undefined, logger), undefined);
  assert.equal(warns.length, 0, "an unresolvable model id is expected, not an error");
});

test("#7 safeProactiveDeferUntil: defers to the ACCURATE rolling reset when over budget (preserves #5)", () => {
  const { logger } = capturingLogger();
  const engine = {
    checkAdmission: () => blocked,
    accurateResetsAt: (name: string) => (name === "cap" ? 4_242 : undefined),
  };
  // The #5 accurate-ETA path is preserved through the #7 wrap: the defer instant is
  // accurateResetsAt(primary), not the gate's full-duration upper bound.
  assert.equal(safeProactiveDeferUntil(engine, "proactive", () => "m1", logger), 4_242);
});

test("#7 safeProactiveDeferUntil: falls back to the gate resetsAt when accurate is unresolved", () => {
  const { logger } = capturingLogger();
  const engine = {
    checkAdmission: () => blocked,
    accurateResetsAt: () => undefined, // unresolved → fall back to primary.resetsAt
  };
  assert.equal(safeProactiveDeferUntil(engine, "proactive", () => "m1", logger), 9_999);
});

test("#7 safeProactiveDeferUntil: within budget → no defer", () => {
  const { logger } = capturingLogger();
  const engine = {
    checkAdmission: () => allowed,
    accurateResetsAt: () => 1,
  };
  assert.equal(safeProactiveDeferUntil(engine, "proactive", () => "m1", logger), undefined);
});
