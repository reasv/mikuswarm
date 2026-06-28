import assert from "node:assert/strict";
import test from "node:test";
import { FEATURE_TOOLS, gatedOutFeatureTools } from "../src/app.ts";
import type { AppConfig } from "../src/config/index.js";

// The full set of feature-gated tool names, as wired in src/app.ts.
const CARD_TOOLS = ["character_card_create", "character_card_read", "character_card_edit"] as const;
const DANBOORU_TOOL = "danbooru";

// Reproduce the exact combined-exclusion app.ts builds at startup:
// `disabled_tools` ∪ gatedOutFeatureTools(features). A tool is unavailable when it
// appears in either. We then ask which of a candidate tool set survives.
function availableTools(
  candidates: readonly string[],
  features: AppConfig["features"],
  disabled: readonly string[] = [],
): Set<string> {
  const excluded = new Set(disabled);
  for (const name of gatedOutFeatureTools(features)) excluded.add(name);
  return new Set(candidates.filter((name) => !excluded.has(name)));
}

const ALL_GATED = [...CARD_TOOLS, DANBOORU_TOOL];

test("mapping covers exactly the documented tools", () => {
  assert.deepEqual([...FEATURE_TOOLS.character_card], CARD_TOOLS);
  assert.deepEqual([...FEATURE_TOOLS.danbooru], [DANBOORU_TOOL]);
});

test("no [features] table -> character_card_* and danbooru excluded", () => {
  const available = availableTools(ALL_GATED, undefined);
  for (const name of ALL_GATED) assert.equal(available.has(name), false, `${name} should be gated off`);
});

test("empty [features] table (both keys absent) -> all gated tools excluded", () => {
  const available = availableTools(ALL_GATED, {});
  for (const name of ALL_GATED) assert.equal(available.has(name), false, `${name} should be gated off`);
});

test("character_card = true -> the 3 card tools present, danbooru still excluded", () => {
  const available = availableTools(ALL_GATED, { character_card: true });
  for (const name of CARD_TOOLS) assert.equal(available.has(name), true, `${name} should be available`);
  assert.equal(available.has(DANBOORU_TOOL), false, "danbooru should remain gated off");
});

test("both true -> all gated tools present", () => {
  const available = availableTools(ALL_GATED, { character_card: true, danbooru: true });
  for (const name of ALL_GATED) assert.equal(available.has(name), true, `${name} should be available`);
});

test("feature = false is treated as off (tools excluded)", () => {
  const available = availableTools(ALL_GATED, { character_card: false, danbooru: false });
  for (const name of ALL_GATED) assert.equal(available.has(name), false, `${name} should be gated off`);
});

test("feature gate composes with disabled_tools (gated-on tool also disabled stays out)", () => {
  // character_card is turned ON, but character_card_edit is also in disabled_tools:
  // it must remain unavailable (excluded by EITHER mechanism).
  const available = availableTools(ALL_GATED, { character_card: true, danbooru: true }, [
    "character_card_edit",
  ]);
  assert.equal(available.has("character_card_edit"), false, "disabled_tools must still exclude it");
  assert.equal(available.has("character_card_create"), true);
  assert.equal(available.has("character_card_read"), true);
  assert.equal(available.has(DANBOORU_TOOL), true);
});
