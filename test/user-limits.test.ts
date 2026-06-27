import assert from "node:assert/strict";
import test from "node:test";

import {
  UserLimitEngine,
  compileGlob,
  homeserverOf,
  renderPartition,
  type ModelCostRates,
  type NormalizedUserLimitRule,
  type UserLimitContext,
} from "../src/budget/user-limits.js";
import { normalizeUserLimits, type RawUserLimitRule } from "../src/budget/normalize-user-limits.js";

// A silent logger satisfying the engine's Logger shape.
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as never;

const RATES: Record<string, ModelCostRates> = {
  // $15/$75 per MTok (Opus-class).
  "opus-premium": { inputPerMTok: 15, outputPerMTok: 75 },
  // $0.5/$2 per MTok (cheap).
  "glm-cheap": { inputPerMTok: 0.5, outputPerMTok: 2 },
  free: { inputPerMTok: 0, outputPerMTok: 0 },
};
const MAX_TOKENS: Record<string, number> = { "opus-premium": 32000, "glm-cheap": 8000, free: 8000 };
const KNOWN_MODELS = new Set(["opus-premium", "glm-cheap", "free", "default"]);

function normalize(raw: RawUserLimitRule[]): NormalizedUserLimitRule[] {
  const r = normalizeUserLimits(raw, { defaultTz: "UTC", knownModelIds: KNOWN_MODELS });
  assert.deepEqual(r.fatal, [], `unexpected fatals: ${r.fatal.join("; ")}`);
  return r.rules;
}

function makeEngine(
  raw: RawUserLimitRule[],
  opts?: { sumUsageCost?: (f: { since: number }) => number; now?: number },
): UserLimitEngine {
  return new UserLimitEngine({
    rules: normalize(raw),
    sumUsageCost: opts?.sumUsageCost ?? (() => 0),
    minUsageTs: () => null,
    costRatesFor: (id) => RATES[id],
    maxTokensFor: (id) => MAX_TOKENS[id],
    zeroCostModelIds: new Set(["free"]),
    viableMinOutputTokens: 256,
    logger,
    now: () => opts?.now ?? 1_000_000,
  });
}

const ROLL24: RawUserLimitRule["window"] = { type: "rolling", duration: "24h" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

test("compileGlob: anchored fnmatch, * = any run incl empty, case-sensitive", () => {
  assert.ok(compileGlob("@alice:hs.org")("@alice:hs.org"));
  assert.ok(!compileGlob("@alice:hs.org")("@bob:hs.org"));
  assert.ok(compileGlob("*:trusted.hs")("@x:trusted.hs"));
  assert.ok(compileGlob("*:trusted.hs")(":trusted.hs")); // * matches empty
  assert.ok(!compileGlob("*:trusted.hs")("@x:other.hs"));
  assert.ok(!compileGlob("ABC")("abc")); // case-sensitive
  // A literal dot is not a wildcard.
  assert.ok(!compileGlob("a.c")("axc"));
});

test("homeserverOf + renderPartition", () => {
  assert.equal(homeserverOf("@alice:hs.org"), "hs.org");
  const ctx: UserLimitContext = { userId: "@alice:hs.org", roomId: "!room:hs.org" };
  assert.equal(renderPartition("{user_id}", ctx), "@alice:hs.org");
  assert.equal(renderPartition("room:{room_id}", ctx), "room:!room:hs.org");
  assert.equal(renderPartition("hs:{homeserver}", ctx), "hs:hs.org");
  assert.equal(renderPartition("staff", ctx), "staff");
});

// ─── Normalizer ─────────────────────────────────────────────────────────────

test("normalize: max_usd shorthand expands to one fungible total constraint", () => {
  const rules = normalize([{ user: "*", max_usd: 5, window: ROLL24 }]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.constraints.length, 1);
  assert.equal(rules[0]!.constraints[0]!.maxUsd, 5);
  assert.equal(rules[0]!.constraints[0]!.models, undefined);
  assert.equal(rules[0]!.constraints[0]!.partition, "{user_id}");
  assert.equal(rules[0]!.hasBudgetBlock, true);
});

test("normalize: max_usd = 0 is a ban; max_usd < 0 is exempt (no constraint)", () => {
  const ban = normalize([{ user: "@x:h", max_usd: 0 }]);
  assert.equal(ban[0]!.constraints.length, 1);
  assert.equal(ban[0]!.constraints[0]!.maxUsd, 0);
  const exempt = normalize([{ user: "@x:h", max_usd: -1 }]);
  assert.equal(exempt[0]!.constraints.length, 0);
  assert.equal(exempt[0]!.hasBudgetBlock, true);
});

test("normalize fatals: no match dimension, unknown model, sub-cap rules", () => {
  const noDim = normalizeUserLimits([{ max_usd: 5, window: ROLL24 }], { defaultTz: "UTC", knownModelIds: KNOWN_MODELS });
  assert.ok(noDim.fatal.some((f) => /at least one match dimension/.test(f)));

  // `space` is a valid match dimension (§11 second slice) — not a fatal.
  const space = normalizeUserLimits([{ space: "!s:h", max_usd: 5, window: ROLL24 }], { defaultTz: "UTC", knownModelIds: KNOWN_MODELS });
  assert.deepEqual(space.fatal, []);

  const unknown = normalizeUserLimits([{ user: "*", models: ["nope"] }], { defaultTz: "UTC", knownModelIds: KNOWN_MODELS });
  assert.ok(unknown.fatal.some((f) => /unknown model "nope"/.test(f)));

  // Sub-cap requires the rule to declare models.
  const subNoModels = normalizeUserLimits(
    [{ user: "*", limits: [{ max_usd: 2, window: ROLL24, models: ["opus-premium"] }] }],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(subNoModels.fatal.some((f) => /requires the rule to declare models/.test(f)));

  // Sub-cap model not in the rule's models.
  const subForeign = normalizeUserLimits(
    [{ user: "*", models: ["glm-cheap"], limits: [{ max_usd: 2, window: ROLL24, models: ["opus-premium"] }] }],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(subForeign.fatal.some((f) => /not in the rule's models/.test(f)));
});

test("normalize fatals: bad partition var, shorthand+limits, >1 shared pool", () => {
  const badVar = normalizeUserLimits(
    [{ user: "*", limits: [{ max_usd: 5, window: ROLL24, partition: "{nope}" }] }],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(badVar.fatal.some((f) => /unknown partition variable/.test(f)));

  // `{space_id}` is a valid partition variable now (§11) — not a fatal.
  const space = normalizeUserLimits(
    [{ space: "!s:h", user: "*", limits: [{ max_usd: 5, window: ROLL24, partition: "space:{space_id}" }] }],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.deepEqual(space.fatal, []);

  const both = normalizeUserLimits(
    [{ user: "*", max_usd: 5, window: ROLL24, limits: [{ max_usd: 3, window: ROLL24 }] }],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(both.fatal.some((f) => /either max_usd \(shorthand\) or limits/.test(f)));

  const twoPools = normalizeUserLimits(
    [
      {
        user: "*",
        limits: [
          { max_usd: 50, window: ROLL24, partition: "staff" },
          { max_usd: 80, window: ROLL24, partition: "public" },
        ],
      },
    ],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(twoPools.fatal.some((f) => /at most one shared pool/.test(f)));
});

test("normalize warns: positive sub-cap with no covering total, divergent static caps", () => {
  const noTotal = normalizeUserLimits(
    [{ user: "*", models: ["opus-premium", "glm-cheap"], limits: [{ max_usd: 2, window: ROLL24, models: ["opus-premium"] }] }],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(noTotal.warnings.some((w) => /reserves no headroom/.test(w)));

  const divergent = normalizeUserLimits(
    [
      {
        user: "*",
        limits: [
          { max_usd: 50, window: ROLL24, partition: "staff" },
          { max_usd: 80, window: ROLL24, partition: "staff" },
        ],
      },
    ],
    { defaultTz: "UTC", knownModelIds: KNOWN_MODELS },
  );
  assert.ok(divergent.warnings.some((w) => /divergent caps/.test(w)));
});

// ─── Cascade ──────────────────────────────────────────────────────────────────

test("cascade: FIRST matching rule wins each value field; message cascades independently of the budget block", () => {
  // Precedence is authored order — more-specific rules go ABOVE the general ones
  // (spec §8.1: "Placed ABOVE … so it wins the cascade"). A message override and a
  // ban therefore sit above the universal default + global budget.
  const engine = makeEngine([
    // 1) message override for one user (no budget block → budget cascades PAST).
    { user: "@special:hs", trigger_rejection_message: "special refusal" },
    // 2) ban a user (no message → message cascades PAST to rule 3).
    { user: "@spammer:bad", max_usd: 0 },
    // 3) universal default refusal message only.
    { user: "*", trigger_rejection_message: "default refusal {resets_at}" },
    // 4) global default budget.
    { user: "*", models: ["opus-premium", "glm-cheap"], limits: [{ max_usd: 5, window: ROLL24 }] },
  ]);

  // Special user: message from rule 1; budget block cascades past to rule 4.
  const special = engine.resolve({ userId: "@special:hs" });
  assert.equal(special.messageTemplate, "special refusal");
  assert.deepEqual(special.models, ["opus-premium", "glm-cheap"]);
  assert.equal(special.active, true);

  // Spammer: banned (rule 2); message cascades past to rule 3.
  const spammer = engine.resolve({ userId: "@spammer:bad" });
  assert.equal(spammer.banned, true);
  assert.equal(spammer.messageTemplate, "default refusal {resets_at}");

  // Plain user: budget + message from the defaults (rules 3 + 4).
  const plain = engine.resolve({ userId: "@joe:hs" });
  assert.deepEqual(plain.models, ["opus-premium", "glm-cheap"]);
  assert.equal(plain.messageTemplate, "default refusal {resets_at}");
});

test("cascade: no matching rule ⇒ inert (matched=false, inactive)", () => {
  const engine = makeEngine([{ user: "@only:hs", max_usd: 5, window: ROLL24 }]);
  const r = engine.resolve({ userId: "@other:hs" });
  assert.equal(r.matched, false);
  assert.equal(r.active, false);
});

// ─── Estimation + degradation ──────────────────────────────────────────────────

test("affordable: caps output at remaining headroom; reports unaffordable below viable_min", () => {
  const engine = makeEngine([{ user: "*", models: ["opus-premium"], limits: [{ max_usd: 5, window: ROLL24 }] }]);
  const r = engine.resolve({ userId: "@a:hs" });
  const aff = engine.affordable(r, "opus-premium", { newTokens: 10_000 });
  assert.equal(aff.ok, true);
  // input_cost = 10000/1e6 * 15 = 0.15; max_output = floor((5-0.15)/(75/1e6)) = 64666; capped at model max 32000.
  assert.equal(aff.maxOutput, 32000);

  // A user already at the cap cannot afford a turn.
  engine.record(r, "opus-premium", 5);
  const after = engine.affordable(r, "opus-premium", { newTokens: 10_000 });
  assert.equal(after.ok, false);
});

test("degradation: an exhausted premium sub-cap makes premium unaffordable but the cheap model still affordable", () => {
  const engine = makeEngine([
    {
      user: "*",
      models: ["opus-premium", "glm-cheap"],
      limits: [
        { max_usd: 5, window: ROLL24 }, // fungible total
        { max_usd: 2, window: ROLL24, models: ["opus-premium"] }, // premium sub-cap
      ],
    },
  ]);
  const r = engine.resolve({ userId: "@a:hs" });
  // Spend the premium sub-cap (counts toward total + sub-cap).
  engine.record(r, "opus-premium", 2);
  // Premium: remaining = min(total 5-2=3, sub-cap 2-2=0) = 0 ⇒ unaffordable.
  assert.equal(engine.affordable(r, "opus-premium", { newTokens: 5000 }).ok, false);
  // Cheap: only the total covers it; remaining = 3 ⇒ affordable (rollout continues cheap).
  assert.equal(engine.affordable(r, "glm-cheap", { newTokens: 5000 }).ok, true);
  // The reserved $3 is the difference the sub-cap guaranteed for continuation.
  assert.equal(engine.totalHeadroom(r), 3);
});

test("affordable: additive thinking budget is reserved within the issued cap and charged (#4)", () => {
  // glm-cheap: $0.5/$2 per MTok. Total cap $5, no prior context (input_cost ≈ 0).
  // affordableOutput = floor(5 / (2/1e6)) = 2_500_000 total billed output.
  const engine = makeEngine([{ user: "*", models: ["glm-cheap"], limits: [{ max_usd: 5, window: ROLL24 }] }]);
  const r = engine.resolve({ userId: "@a:hs" });
  // Without thinking, the cap is the model default max (8000 < 2.5M affordable).
  const noThink = engine.affordable(r, "glm-cheap", { newTokens: 0 }, 0);
  assert.equal(noThink.ok, true);
  assert.equal(noThink.maxOutput, 8000);

  // Tight budget so the model-default cap does NOT clamp: $0.02 buys
  // floor(0.02 / (2/1e6)) = 10_000 total output. A 2048-token thinking budget must be
  // RESERVED inside the issued base cap → base = 10000 − 2048 = 7952, so the wire cap
  // (base + thinking) = 10000 stays within budget rather than overshooting to 12048.
  const tight = makeEngine([{ user: "*", models: ["glm-cheap"], limits: [{ max_usd: 0.02, window: ROLL24 }] }]);
  const rt = tight.resolve({ userId: "@a:hs" });
  const noThinkTight = tight.affordable(rt, "glm-cheap", { newTokens: 0 }, 0);
  assert.equal(noThinkTight.maxOutput, 8000); // model default clamps (10000 > 8000)
  const thinkTight = tight.affordable(rt, "glm-cheap", { newTokens: 0 }, 2048);
  assert.equal(thinkTight.ok, true);
  // base = min(modelDefaultMax 8000, affordableOutput 10000 − 2048 = 7952) = 7952.
  assert.equal(thinkTight.maxOutput, 7952);
  // The reserved thinking budget keeps base + thinking == the un-thinking affordable
  // output (10000) — never above it.
  assert.equal(thinkTight.maxOutput + 2048, 10000);
});

test("affordable: a loose budget caps at the REQUESTED model's own max_tokens — the #9 disambiguator basis", () => {
  // The §5.4 re-drive disambiguation (#9) compares the issued cap against the REQUESTED
  // model's `max_tokens`: a length stop with `cap >= requestedModelMax` is a legitimate
  // long answer (accept), `cap < requestedModelMax` is a budget cap (re-drive). This
  // pins the load-bearing property: when the budget does NOT bind, the cap equals the
  // requested model's own max — so the disambiguator never misreads a natural length
  // stop as a budget cap (and vice-versa), independent of any served fallback member.
  const engine = makeEngine([{ user: "*", models: ["opus-premium"], limits: [{ max_usd: 100, window: ROLL24 }] }]);
  const r = engine.resolve({ userId: "@a:hs" });
  const aff = engine.affordable(r, "opus-premium", { newTokens: 1_000 });
  assert.equal(aff.ok, true);
  assert.equal(aff.maxOutput, MAX_TOKENS["opus-premium"], "loose budget ⇒ cap == requested model max");

  // A bound budget caps BELOW the requested model max → the disambiguator reads "budget".
  const tight = makeEngine([{ user: "*", models: ["opus-premium"], limits: [{ max_usd: 1, window: ROLL24 }] }]);
  const rt = tight.resolve({ userId: "@a:hs" });
  const affTight = tight.affordable(rt, "opus-premium", { newTokens: 1_000 });
  assert.ok(affTight.ok && affTight.maxOutput < MAX_TOKENS["opus-premium"]!, "bound budget ⇒ cap below model max");
});

test("affordable: thinking budget that consumes the whole turn makes it unaffordable (#4)", () => {
  // $0.02 buys 10_000 total output; a 16384 thinking budget leaves a NEGATIVE base
  // (< viable_min) ⇒ the model cannot complete a turn within budget.
  const engine = makeEngine([{ user: "*", models: ["glm-cheap"], limits: [{ max_usd: 0.02, window: ROLL24 }] }]);
  const r = engine.resolve({ userId: "@a:hs" });
  assert.equal(engine.affordable(r, "glm-cheap", { newTokens: 0 }, 16384).ok, false);
});

test("estimation: prior context is cache-read within the TTL, cache-write outside (§5.3)", () => {
  // A model with explicit cache rates: read = 0.1×input, write = 1.25×input.
  const cacheRates: Record<string, ModelCostRates> = {
    cached: { inputPerMTok: 10, outputPerMTok: 10, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
  };
  const norm = normalizeUserLimits(
    [{ user: "*", models: ["cached"], limits: [{ max_usd: 1, window: ROLL24 }] }],
    { defaultTz: "UTC", knownModelIds: new Set(["cached"]) },
  );
  assert.deepEqual(norm.fatal, []);
  const engine = new UserLimitEngine({
    rules: norm.rules,
    sumUsageCost: () => 0,
    costRatesFor: (id) => cacheRates[id],
    maxTokensFor: () => 1_000_000,
    zeroCostModelIds: new Set(),
    viableMinOutputTokens: 1,
    logger,
    now: () => 1_000_000,
  });
  const r = engine.resolve({ userId: "@a:hs" });
  // 1M cached tokens. Within the TTL: input_cost = 1M × $1/MTok = $1.00 → exhausts the
  // whole $1 cap → no output affordable → UNAFFORDABLE only if cost ≥ cap. Make headroom
  // explicit by comparing the two pricings' maxOutput.
  const hot = engine.affordable(r, "cached", { cachedTokens: 500_000, newTokens: 0, withinCacheTtl: true });
  const cold = engine.affordable(r, "cached", { cachedTokens: 500_000, newTokens: 0, withinCacheTtl: false });
  // Hot prices 500k at cache-read ($0.50); cold prices it at cache-write ($6.25, > cap).
  assert.equal(hot.ok, true, "cache-read keeps it affordable within the TTL");
  assert.equal(cold.ok, false, "cache-write throughout exhausts the cap outside the TTL");
  // New material is always cache-write even within the TTL.
  const withNew = engine.affordable(r, "cached", { cachedTokens: 0, newTokens: 100_000, withinCacheTtl: true });
  // 100k × $12.5/MTok = $1.25 > $1 cap → unaffordable.
  assert.equal(withNew.ok, false, "new material priced at cache-write");
});

test("zero-cost model bypass: always affordable regardless of counters", () => {
  const engine = makeEngine([{ user: "*", models: ["free"], limits: [{ max_usd: 0, window: ROLL24 }] }]);
  const r = engine.resolve({ userId: "@a:hs" });
  // Even with a $0 total cap, a free model is affordable (cost = rate × tokens = 0).
  assert.equal(engine.affordable(r, "free", { newTokens: 100_000 }).ok, true);
});

// ─── Partitioning ───────────────────────────────────────────────────────────

test("per-user partition: each user's spend is isolated (default {user_id})", () => {
  const engine = makeEngine([{ user: "*", models: ["glm-cheap"], limits: [{ max_usd: 5, window: ROLL24 }] }]);
  const a = engine.resolve({ userId: "@a:hs" });
  const b = engine.resolve({ userId: "@b:hs" });
  engine.record(a, "glm-cheap", 5);
  assert.equal(engine.affordable(a, "glm-cheap", { newTokens: 1000 }).ok, false);
  // B is untouched by A's spend.
  assert.equal(engine.affordable(b, "glm-cheap", { newTokens: 1000 }).ok, true);
  assert.equal(engine.totalHeadroom(b), 5);
});

test("shared pool: distinct users share one meter and degrade together", () => {
  const engine = makeEngine([
    {
      user: ["@a:hs", "@b:hs"],
      models: ["glm-cheap"],
      limits: [{ max_usd: 50, window: ROLL24, partition: "staff" }],
    },
  ]);
  const a = engine.resolve({ userId: "@a:hs" });
  const b = engine.resolve({ userId: "@b:hs" });
  // The shared-pool key is denormalized onto the ledger for both.
  assert.equal(a.ledgerPartitionKey, "staff");
  assert.equal(b.ledgerPartitionKey, "staff");
  // A spends $30 of the shared $50; B sees only $20 remaining.
  engine.record(a, "glm-cheap", 30);
  assert.equal(engine.totalHeadroom(b), 20);
  engine.record(b, "glm-cheap", 20);
  // Pool exhausted ⇒ both fail at once.
  assert.equal(engine.affordable(a, "glm-cheap", { newTokens: 1000 }).ok, false);
  assert.equal(engine.affordable(b, "glm-cheap", { newTokens: 1000 }).ok, false);
});

test("record keys coverage on the REQUESTED model: a sub-cap ignores other-model spend", () => {
  const engine = makeEngine([
    {
      user: "*",
      models: ["opus-premium", "glm-cheap"],
      limits: [
        { max_usd: 100, window: ROLL24 },
        { max_usd: 10, window: ROLL24, models: ["opus-premium"] },
      ],
    },
  ]);
  const r = engine.resolve({ userId: "@a:hs" });
  // Cheap spend counts toward the total only, never the opus-premium sub-cap.
  engine.record(r, "glm-cheap", 8);
  const premiumBinding = engine.bindingConstraint(r, "opus-premium");
  // Premium remaining is still its full sub-cap (10), not reduced by cheap spend.
  assert.equal(engine.affordable(r, "opus-premium", { newTokens: 0 }).remainingUsd, 10);
  assert.equal(premiumBinding?.modelScope?.[0], "opus-premium");
});

test("space matching (§11): matches ANY parent space; per-space pool shares across users", () => {
  const engine = makeEngine([
    // A space-scoped shared pool for two users; matches if the room is under !spaceB.
    {
      user: ["@a:hs", "@b:hs"],
      space: "!spaceB:hs",
      models: ["glm-cheap"],
      limits: [{ max_usd: 30, window: ROLL24, partition: "space:{space_id}" }],
    },
  ]);
  // A room with two parent spaces (best-first): !spaceA (canonical), !spaceB.
  const ctxA: UserLimitContext = { userId: "@a:hs", roomId: "!r:hs", spaceIds: ["!spaceA:hs", "!spaceB:hs"] };
  const ctxB: UserLimitContext = { userId: "@b:hs", roomId: "!r:hs", spaceIds: ["!spaceA:hs", "!spaceB:hs"] };
  const a = engine.resolve(ctxA);
  // Matches via the SECOND parent (!spaceB), even though the rule's space glob isn't
  // the canonical first parent — "any ancestor matches".
  assert.equal(a.active, true);
  // The pool/partition + ledger key use the CANONICAL (first) parent space.
  assert.equal(a.ledgerPartitionKey, "space:!spaceA:hs");
  const b = engine.resolve(ctxB);
  // Shared per-space pool: A's spend is visible to B (one meter).
  engine.record(a, "glm-cheap", 20);
  assert.equal(engine.totalHeadroom(b), 10);

  // A room under neither space does not match.
  const outside = engine.resolve({ userId: "@a:hs", roomId: "!r2:hs", spaceIds: ["!other:hs"] });
  assert.equal(outside.active, false);
  // The engine flags that it needs space resolution.
  assert.equal(engine.usesSpace, true);
});

test("usesSpace is false when no rule references space (skips the resolution)", () => {
  const engine = makeEngine([{ user: "*", max_usd: 5, window: ROLL24 }]);
  assert.equal(engine.usesSpace, false);
});

test("seed: a meter materializes from the ledger sum on first access", () => {
  // The fake ledger reports $4 already spent for any matching filter.
  const engine = makeEngine([{ user: "*", models: ["glm-cheap"], limits: [{ max_usd: 5, window: ROLL24 }] }], {
    sumUsageCost: () => 4,
  });
  const r = engine.resolve({ userId: "@a:hs" });
  // Seeded at $4 → only $1 headroom remains.
  assert.equal(engine.totalHeadroom(r), 1);
});
