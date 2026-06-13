import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCaptionCost, type CaptionCostBlock } from "../src/captioning/cost.js";

const SHARED_COST: CaptionCostBlock = { input: 0.3, output: 2.5, cache_read: 0.075, cache_write: 0 };
const MODALITY_COST: CaptionCostBlock = { input: 1, output: 4, cache_read: 0.25, cache_write: 0.5 };

describe("resolveCaptionCost", () => {
  it("uses the modality's own cost block when present (prices its own model)", () => {
    const r = resolveCaptionCost({
      modalityModelId: "anthropic/claude-vision",
      modalityCost: MODALITY_COST,
      sharedModelId: "google/gemini-3.5-flash",
      topLevelCost: SHARED_COST,
    });
    assert.deepEqual(r.rates, { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 0.5 });
    assert.equal(r.unpricedOverride, false);
  });

  it("applies top-level cost when the modality does not override the model", () => {
    const r = resolveCaptionCost({
      modalityModelId: undefined,
      modalityCost: undefined,
      sharedModelId: "google/gemini-3.5-flash",
      topLevelCost: SHARED_COST,
    });
    assert.deepEqual(r.rates, { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 });
    assert.equal(r.unpricedOverride, false);
  });

  it("applies top-level cost when the modality overrides only endpoint/key (same model id)", () => {
    // id resolves to the shared model id, so top-level rates are still correct.
    const r = resolveCaptionCost({
      modalityModelId: "google/gemini-3.5-flash",
      modalityCost: undefined,
      sharedModelId: "google/gemini-3.5-flash",
      topLevelCost: SHARED_COST,
    });
    assert.deepEqual(r.rates, { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 });
    assert.equal(r.unpricedOverride, false);
  });

  it("does NOT inherit shared cost for a different model with no cost block (unknown + warn)", () => {
    const r = resolveCaptionCost({
      modalityModelId: "anthropic/claude-vision-expensive",
      modalityCost: undefined,
      sharedModelId: "google/gemini-3.5-flash",
      topLevelCost: SHARED_COST,
    });
    assert.equal(r.rates, undefined, "must not borrow the shared model's rates for a different model");
    assert.equal(r.unpricedOverride, true, "should flag the silent untracked override");
  });

  it("does not warn for a different model with no cost when top-level pricing is also unset", () => {
    // Cost tracking is simply off everywhere; an override warning would be noise.
    const r = resolveCaptionCost({
      modalityModelId: "anthropic/claude-vision-expensive",
      modalityCost: undefined,
      sharedModelId: "google/gemini-3.5-flash",
      topLevelCost: undefined,
    });
    assert.equal(r.rates, undefined);
    assert.equal(r.unpricedOverride, false);
  });

  it("returns undefined (untracked) when nothing is priced and no override", () => {
    const r = resolveCaptionCost({
      modalityModelId: undefined,
      modalityCost: undefined,
      sharedModelId: "google/gemini-3.5-flash",
      topLevelCost: undefined,
    });
    assert.equal(r.rates, undefined);
    assert.equal(r.unpricedOverride, false);
  });
});
