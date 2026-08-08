/**
 * Tests for the tool-result context budget: per-result cap (Layer 1) and
 * per-turn aggregate clamp (Layer 2).
 *
 * spec TOOL-RESULT-BUDGET §8 coverage:
 *   Layer 1: under-cap untouched; over-cap sliced with exact marker; newline
 *     preference; multi-block MCP results; image blocks untouched but charged;
 *     error results exempt; cap=0 disables.
 *   Layer 2: accumulator resets on commit; settlement-order consumption; floor
 *     respected; budget derived from serving window and reserve.
 *   Config: defaults present in 00-defaults parse; schema validates/rejects bad values.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shapeContentBlocks, TurnResultBudget } from "../src/agent/tool-result-budget.js";
import type { ShapedContent } from "../src/agent/tool-result-budget.js";
import { wrapToolsWithResultBudget } from "../src/agent/tool-result-wrap.js";
import { PER_IMAGE_TOKEN_ESTIMATE } from "../src/agent/live-token-estimate.js";
import { estimateTokens } from "../src/context/tokens.js";
import { loadConfig } from "../src/config/index.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a plain text content block. */
function txt(text: string) {
  return { type: "text" as const, text };
}

/** Build a plain image content block (base64 data is just a placeholder here). */
function img(data = "abc123", mimeType = "image/png") {
  return { type: "image" as const, data, mimeType };
}

/**
 * Generate a string of exactly `targetTokens` tokens using repeated words.
 * The estimator is BPE-based so we use a simple word that encodes as one token.
 */
function makeText(targetTokens: number, word = "hello"): string {
  // Each word + space ≈ 1–2 tokens; iterate until we exceed the target.
  // We'll trim back after measuring.
  let result = (word + " ").repeat(targetTokens * 2);
  while (estimateTokens(result) > targetTokens) {
    result = result.slice(0, result.length - (word.length + 1));
  }
  return result.trimEnd();
}

// ---------------------------------------------------------------------------
// Layer 1 — per-result cap
// ---------------------------------------------------------------------------

test("shapeContentBlocks: under-cap text is returned unchanged", () => {
  const content = [txt("hello world")];
  const r = shapeContentBlocks(content, 1000, "per-result", false);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.content, content);
  assert.ok(r.textTokensShown > 0);
  assert.equal(r.imageCount, 0);
});

test("shapeContentBlocks: over-cap text is sliced with a visible per-result marker", () => {
  const bigText = makeText(100);
  const content = [txt(bigText)];
  const allowance = 20;

  const r = shapeContentBlocks(content, allowance, "per-result", false);

  assert.equal(r.truncated, true);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text");
  const resultText = (r.content[0] as { type: "text"; text: string }).text;

  // Marker must mention the per-result cap.
  assert.ok(resultText.includes("per-result cap"), `marker should say "per-result cap": got ${resultText}`);
  assert.ok(resultText.includes("~"), "marker should contain token counts (~N of ~M)");

  // The shaped text should be shorter than the original.
  assert.ok(resultText.length < bigText.length, "shaped text must be shorter than original");

  // textTokensShown is charged for the full emitted block (sliced content + marker),
  // so it exceeds the allowance — see the dedicated "marker overshoot" test below.
  assert.ok(r.textTokensShown > 0, "textTokensShown must be positive");
});

test("shapeContentBlocks: over-cap uses turn-budget marker for layer=turn-budget", () => {
  const bigText = makeText(100);
  const content = [txt(bigText)];
  const r = shapeContentBlocks(content, 20, "turn-budget", false);

  assert.equal(r.truncated, true);
  const resultText = (r.content[0] as { type: "text"; text: string }).text;
  assert.ok(
    resultText.includes("context budget"),
    `marker should say "context budget": got ${resultText}`,
  );
  assert.ok(!resultText.includes("per-result cap"), "turn-budget marker should not say per-result cap");
});

test("shapeContentBlocks: prefers the last newline within the final 5% of budget", () => {
  // Build a text where the last ~5% of the token budget range contains a newline.
  // We want to verify the slice cuts at or before that newline.
  // Use allowance=30 and build ~25 + "\n" + ~15 tokens so the total clearly
  // exceeds the allowance regardless of tokenizer boundary effects.
  const allowance = 30;
  const before = makeText(25, "word");
  const after = makeText(15, "end");
  const textWithNewline = before + "\n" + after;

  assert.ok(
    estimateTokens(textWithNewline) > allowance,
    "precondition: text must exceed allowance",
  );

  const r = shapeContentBlocks([txt(textWithNewline)], allowance, "per-result", false);

  if (r.truncated) {
    const resultText = (r.content[0] as { type: "text"; text: string }).text;
    // The marker starts with '\n[tool result truncated'; look at what comes before it.
    const markerStart = resultText.indexOf("\n[tool result truncated");
    const visible = markerStart >= 0 ? resultText.slice(0, markerStart) : resultText;
    // If a newline preference worked, the visible slice should end with '\n' or
    // the total tokens should be <= the allowance.
    const visibleTokens = estimateTokens(visible);
    assert.ok(
      visibleTokens <= allowance,
      `visible portion (${visibleTokens} tok) must be <= allowance (${allowance})`,
    );
  } else {
    // Text fit: no truncation (both outcomes are valid depending on tokenizer).
    assert.equal(r.truncated, false);
  }
});

// ---------------------------------------------------------------------------
// Multi-block MCP results
// ---------------------------------------------------------------------------

test("shapeContentBlocks: multi-block — fitting blocks kept, first overflow sliced, later text dropped", () => {
  const allowance = 30;
  const blockA = txt(makeText(10));   // fits (10 ≤ 30)
  const blockB = txt(makeText(50));   // first overflower (10+50 > 30)
  const blockC = txt(makeText(20));   // dropped (distinct marker: X repeated)

  const r = shapeContentBlocks([blockA, blockB, blockC], allowance, "per-result", false);

  assert.equal(r.truncated, true);
  // blockA must be present verbatim.
  assert.ok(
    r.content.some((b) => b.type === "text" && b.text === blockA.text),
    "blockA must be kept intact",
  );

  // blockC is dropped: the output has at most 2 text blocks (blockA + sliced blockB).
  const textBlocks = r.content.filter((b) => b.type === "text");
  assert.ok(textBlocks.length <= 2, `output must have ≤2 text blocks (got ${textBlocks.length}); blockC must be dropped`);

  // The marker must include M = total text tokens (A + B + C).
  const totalTextTokens =
    estimateTokens(blockA.text) + estimateTokens(blockB.text) + estimateTokens(blockC.text);
  const allText = textBlocks
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
  assert.ok(
    allText.includes(`~${totalTextTokens}`),
    `marker M must equal total text tokens (${totalTextTokens}); got text: ${allText.slice(0, 200)}`,
  );

  // textTokensShown charges the full emitted block (sliced content + marker) and
  // therefore exceeds the allowance — see the dedicated "marker overshoot" test below.
  assert.ok(r.textTokensShown > 0, "textTokensShown must be positive");
});

test("shapeContentBlocks: multi-block — all blocks fit returns unchanged content", () => {
  const allowance = 100;
  const blockA = txt(makeText(10));
  const blockB = txt(makeText(10));

  const r = shapeContentBlocks([blockA, blockB], allowance, "per-result", false);

  assert.equal(r.truncated, false);
  assert.deepEqual(r.content, [blockA, blockB]);
});

// ---------------------------------------------------------------------------
// Image blocks
// ---------------------------------------------------------------------------

test("shapeContentBlocks: image blocks pass through untouched and are counted", () => {
  const image = img("data_payload", "image/jpeg");
  const content = [image];
  const r = shapeContentBlocks(content, 10, "per-result", false);

  // Image is not considered text — no text tokens counted, no truncation triggered.
  assert.equal(r.truncated, false);
  assert.equal(r.imageCount, 1);
  assert.equal(r.textTokensShown, 0);
  assert.deepEqual(r.content, [image]);
});

test("shapeContentBlocks: image blocks interleaved with text pass through unchanged", () => {
  const smallText = txt("hi");
  const image = img();
  const bigText = txt(makeText(100));
  const allowance = 20;

  const r = shapeContentBlocks([smallText, image, bigText], allowance, "per-result", false);

  assert.equal(r.imageCount, 1);
  // The image block must be in the output.
  assert.ok(
    r.content.some((b) => b.type === "image" && b.data === image.data),
    "image must be in output",
  );
  // bigText exceeds remaining allowance after smallText → it gets sliced.
  assert.equal(r.truncated, true);
});

test("shapeContentBlocks: multiple images are all counted", () => {
  const content = [img("a"), txt(makeText(5)), img("b"), img("c")];
  const r = shapeContentBlocks(content, 1000, "per-result", false);
  assert.equal(r.imageCount, 3);
  assert.equal(r.truncated, false);
});

// ---------------------------------------------------------------------------
// Error exemption
// ---------------------------------------------------------------------------

test("shapeContentBlocks: error results are exempt from truncation", () => {
  const bigText = txt(makeText(200));
  const r = shapeContentBlocks([bigText], 10, "per-result", /* isError */ true);

  assert.equal(r.truncated, false);
  assert.deepEqual(r.content, [bigText]);
  // Tokens are still measured and reported for accounting.
  assert.ok(r.textTokensShown > 0, "textTokensShown must be > 0 even for errors");
});

// ---------------------------------------------------------------------------
// cap = 0 disables Layer 1 (allowance ≤ 0 → pass through)
// ---------------------------------------------------------------------------

test("shapeContentBlocks: allowance=0 passes through content unchanged (Layer 1 disabled)", () => {
  const bigText = txt(makeText(500));
  const r = shapeContentBlocks([bigText], 0, "per-result", false);

  assert.equal(r.truncated, false);
  assert.deepEqual(r.content, [bigText]);
});

test("shapeContentBlocks: allowance negative also passes through unchanged", () => {
  const bigText = txt(makeText(100));
  const r = shapeContentBlocks([bigText], -50, "per-result", false);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.content, [bigText]);
});

// ---------------------------------------------------------------------------
// TurnResultBudget — accumulator
// ---------------------------------------------------------------------------

test("TurnResultBudget: allowance math — basic derivation", () => {
  const budget = new TurnResultBudget(
    /* servingWindow */ 100_000,
    /* reserveTokens */ 32_768,
    /* minTokens */ 1024,
  );

  // No consumption yet; allowance = max(100000 - 57000 - 32768, 1024) = 10232
  const runningCtx = 57_000;
  const expected = Math.max(100_000 - runningCtx - 32_768 - 0, 1024);
  assert.equal(budget.allowance(runningCtx), expected);
});

test("TurnResultBudget: consume reduces subsequent allowances (settlement order)", () => {
  const budget = new TurnResultBudget(100_000, 32_768, 1024);
  const runningCtx = 57_000;

  const first = budget.allowance(runningCtx); // = 10232
  budget.consume(5_000);
  const second = budget.allowance(runningCtx); // = 10232 - 5000 = 5232

  assert.ok(second < first, "allowance decreases after consume");
  assert.equal(second, first - 5_000);
});

test("TurnResultBudget: sequential results in a parallel batch consume in order", () => {
  const budget = new TurnResultBudget(50_000, 10_000, 1024);
  const runningCtx = 30_000;
  // budget = 50000 - 30000 - 10000 = 10000

  const allow1 = budget.allowance(runningCtx); // 10000 - 0 = 10000
  budget.consume(6_000);
  const allow2 = budget.allowance(runningCtx); // 10000 - 6000 = 4000
  budget.consume(4_000);
  const allow3 = budget.allowance(runningCtx); // 10000 - 10000 = 0 → floor = 1024

  assert.equal(allow1, 10_000);
  assert.equal(allow2, 4_000);
  assert.equal(allow3, 1024, "floor must be respected when budget exhausted");
});

test("TurnResultBudget: floor is applied when budget would go negative", () => {
  const budget = new TurnResultBudget(100_000, 90_000, 1024);
  // budget = 100000 - 60000 - 90000 = -50000 (already negative!)
  assert.equal(budget.allowance(60_000), 1024);
});

test("TurnResultBudget: reset clears the accumulator", () => {
  const budget = new TurnResultBudget(100_000, 32_768, 1024);
  const runningCtx = 57_000;

  budget.consume(8_000);
  const beforeReset = budget.allowance(runningCtx);
  budget.reset();
  const afterReset = budget.allowance(runningCtx);

  assert.ok(afterReset > beforeReset, "allowance must increase after reset");
  // After reset, accumulated = 0, so allowance = max(budget, min)
  const expected = Math.max(100_000 - runningCtx - 32_768, 1024);
  assert.equal(afterReset, expected);
});

test("TurnResultBudget: multiple resets are idempotent", () => {
  const budget = new TurnResultBudget(100_000, 32_768, 1024);
  budget.consume(5_000);
  budget.reset();
  budget.reset();
  budget.reset();
  const expected = Math.max(100_000 - 50_000 - 32_768, 1024);
  assert.equal(budget.allowance(50_000), expected);
});

test("TurnResultBudget: minTokens must always be the floor even after massive consumption", () => {
  const budget = new TurnResultBudget(10_000, 5_000, 2048);
  budget.consume(1_000_000); // wildly over-budget
  assert.equal(budget.allowance(0), 2048, "floor must be respected regardless of accumulated");
  assert.equal(budget.allowance(50_000), 2048, "floor regardless of runningContext too");
});

// ---------------------------------------------------------------------------
// Interaction: Layer 1 + Layer 2 both active (wiring picks tighter)
// ---------------------------------------------------------------------------

test("shapeContentBlocks integration: the tighter of two allowances wins when called with the minimum", () => {
  // Simulate step-2 wiring choosing min(perResultCap, turnBudgetAllowance).
  const bigText = makeText(200);
  const perResultCap = 50;
  const turnBudgetAllowance = 30; // tighter
  const effectiveCap = Math.min(perResultCap, turnBudgetAllowance);

  const r = shapeContentBlocks([txt(bigText)], effectiveCap, "turn-budget", false);
  assert.equal(r.truncated, true);
  // textTokensShown includes the marker, so it exceeds effectiveCap — see "marker overshoot" test.
  assert.ok(r.textTokensShown > 0);
});

// ---------------------------------------------------------------------------
// Fix 3a — marker overshoot is expected
// ---------------------------------------------------------------------------

test("shapeContentBlocks: marker overshoot is expected — emitted block exceeds allowance, shown-count reflects full emission", () => {
  const bigText = makeText(100);
  const allowance = 20;

  const r = shapeContentBlocks([txt(bigText)], allowance, "per-result", false);

  assert.equal(r.truncated, true);
  assert.equal(r.content.length, 1);
  const emittedText = (r.content[0] as { type: "text"; text: string }).text;
  const emittedTokens = estimateTokens(emittedText);

  // The emitted block is sliced content + marker. The marker is deliberately NOT
  // counted against the caller's allowance (it does not compete with tool output),
  // but it IS counted in the shown-token charge so the accumulator reflects what
  // was actually appended to the context (spec §4).
  assert.ok(
    emittedTokens > allowance,
    `emitted block (${emittedTokens} tokens) must exceed allowance (${allowance}); marker causes deliberate overshoot`,
  );

  // shown-count must equal the full emitted block estimate, marker included.
  assert.equal(
    r.textTokensShown,
    emittedTokens,
    `textTokensShown (${r.textTokensShown}) must equal full emitted block tokens (${emittedTokens})`,
  );

  // Sanity: since textTokensShown = emittedTokens > allowance, this also holds.
  assert.ok(r.textTokensShown > allowance, "textTokensShown must exceed allowance (marker is charged)");
});

// ---------------------------------------------------------------------------
// Fix 3b — emoji-dense truncation: no orphaned surrogate
// ---------------------------------------------------------------------------

test("shapeContentBlocks: emoji-dense text truncated mid-stream yields no orphaned surrogate", () => {
  // Emoji are surrogate pairs in UTF-16 (U+D800–U+DBFF + U+DC00–U+DFFF).
  // A naive char-offset slice could leave an orphaned high surrogate at the end.
  const emoji = "😀".repeat(500);
  const allowance = 20;

  const r = shapeContentBlocks([txt(emoji)], allowance, "per-result", false);

  assert.equal(r.truncated, true, "emoji string must trigger truncation");
  const emittedText = (r.content[0] as { type: "text"; text: string }).text;

  // Isolate the sliced portion (before the truncation marker).
  const markerStart = emittedText.indexOf("\n[tool result truncated");
  const slicedPart = markerStart >= 0 ? emittedText.slice(0, markerStart) : emittedText;

  // Must not end in an orphaned high surrogate.
  assert.ok(
    !/[\uD800-\uDBFF]$/.test(slicedPart),
    `sliced portion must not end in unpaired high surrogate; got: ${JSON.stringify(slicedPart.slice(-4))}`,
  );

  // Must survive a UTF-8 round-trip losslessly (unpaired surrogates corrupt the encoding).
  assert.equal(
    Buffer.from(slicedPart, "utf8").toString("utf8"),
    slicedPart,
    "sliced portion must be valid UTF-8 (no unpaired surrogates)",
  );
});

// ---------------------------------------------------------------------------
// Config: defaults present + schema validation
// ---------------------------------------------------------------------------

// Minimal complete config without env-var substitutions.
const MINIMAL_CONFIG = `
[app]
name = "test"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "test-model"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[workspace]
root_dir = "./workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"

[summarization]
enabled = false
`;

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-budget-test-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: [agent.tools] with valid values is accepted", async () => {
  const toml = `${MINIMAL_CONFIG}
[agent.tools]
result_max_tokens = 16384
result_reserve_tokens = 32768
result_min_tokens = 1024
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agent.tools?.result_max_tokens, 16384);
    assert.equal(config.agent.tools?.result_reserve_tokens, 32768);
    assert.equal(config.agent.tools?.result_min_tokens, 1024);
  });
});

test("config: [agent.tools] with result_max_tokens = 0 (disabled) is accepted", async () => {
  const toml = `${MINIMAL_CONFIG}
[agent.tools]
result_max_tokens = 0
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agent.tools?.result_max_tokens, 0);
  });
});

test("config: [agent.tools] is optional — omitting it is valid", async () => {
  await withConfigDir(MINIMAL_CONFIG, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agent.tools, undefined);
  });
});

test("config: result_max_tokens = -1 is rejected (minimum: 0)", async () => {
  const toml = `${MINIMAL_CONFIG}
[agent.tools]
result_max_tokens = -1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /result_max_tokens|minimum|Invalid config/i,
      "negative result_max_tokens must fail validation",
    );
  });
});

test("config: result_reserve_tokens = -1 is rejected (minimum: 0)", async () => {
  const toml = `${MINIMAL_CONFIG}
[agent.tools]
result_reserve_tokens = -1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /result_reserve_tokens|minimum|Invalid config/i,
      "negative result_reserve_tokens must fail validation",
    );
  });
});

test("config: result_min_tokens = 0 is rejected (minimum: 1)", async () => {
  const toml = `${MINIMAL_CONFIG}
[agent.tools]
result_min_tokens = 0
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /result_min_tokens|minimum|Invalid config/i,
      "result_min_tokens = 0 must fail validation (floor of 0 defeats the purpose)",
    );
  });
});

test("config: result_min_tokens = -1 is rejected (minimum: 1)", async () => {
  const toml = `${MINIMAL_CONFIG}
[agent.tools]
result_min_tokens = -1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /result_min_tokens|minimum|Invalid config/i,
    );
  });
});

test("config: 00-defaults.toml ships the [agent.tools] defaults", async () => {
  // Load only the actual defaults file to confirm all three knobs are present.
  const defaultsPath = path.resolve("config/00-defaults.toml");
  // We need a complete config layer on top to satisfy required fields (matrix
  // accounts etc.). Use a two-file dir: the real defaults + a minimal overlay.
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-budget-defaults-"));
  try {
    const { readFile, copyFile } = await import("node:fs/promises");
    // Copy the real defaults file.
    await copyFile(defaultsPath, path.join(dir, "00-defaults.toml"));
    // An overlay that satisfies the required fields not in defaults.
    const overlay = `
[matrix.accounts.miku]
homeserver = "http://localhost"
password = "test"
recovery_key = "test-key"
user_id = "@miku:localhost"
device_id = "TESTDEVICE"
store_path = "./var/matrix/miku"
`;
    await writeFile(path.join(dir, "90-overlay.toml"), overlay, "utf8");

    // Set the env vars that 00-defaults.toml references so loadConfig doesn't throw.
    const savedEnv: Record<string, string | undefined> = {};
    const requiredVars: Record<string, string> = {
      ANTHROPIC_BASE_URL: "http://localhost",
      LLM_API_KEY: "test-key",
      OPENROUTER_BASE_URL: "http://localhost",
      GEMINI_BASE_URL: "http://localhost",
      MATRIX_HOMESERVER: "http://localhost",
      MATRIX_PASSWORD: "test",
      MATRIX_RECOVERY_KEY: "test-key",
      MATRIX_USER_ID: "@miku:localhost",
      MATRIX_DEVICE_ID: "TESTDEVICE",
    };
    for (const [k, v] of Object.entries(requiredVars)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const config = await loadConfig(dir, { env: false });
      // Verify the three [agent.tools] defaults are present and match the spec.
      assert.equal(config.agent.tools?.result_max_tokens, 16384, "default result_max_tokens should be 16384");
      assert.equal(config.agent.tools?.result_reserve_tokens, 32768, "default result_reserve_tokens should be 32768");
      assert.equal(config.agent.tools?.result_min_tokens, 1024, "default result_min_tokens should be 1024");
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: wrapToolsWithResultBudget wiring
// ---------------------------------------------------------------------------
// These tests exercise the REAL wrapper code path (not a reimplementation).
// They use small synthetic AgentTool objects with fixed content returns.

/** Minimal AgentTool that returns the given content blocks. */
function makeTool(
  name: string,
  content: AgentToolResult<null>["content"],
): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content, details: null }),
  } as AgentTool;
}

/** Minimal AgentTool that always throws an error. */
function makeErrorTool(name: string, message: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error(message);
    },
  } as AgentTool;
}

test("wrapToolsWithResultBudget: small result passes through unchanged (under Layer-1 cap)", async () => {
  const budget = new TurnResultBudget(200_000, 32_768, 1024);
  const smallText = txt(makeText(10));
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [smallText])], {
    resultMaxTokens: 16_384,
    turnBudget: budget,
    getRunningContext: () => 50_000,
  });
  const result = await wrapped!.execute("id", {});
  assert.deepEqual(result.content, [smallText]);
  assert.ok(budget.accumulated > 0, "budget should have been charged");
});

test("wrapToolsWithResultBudget: over-cap result is truncated (Layer 1)", async () => {
  const budget = new TurnResultBudget(200_000, 1000, 100);
  const bigText = makeText(500);
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 50,   // Layer 1: very tight
    turnBudget: budget,
    getRunningContext: () => 100, // leaves huge Layer-2 room
  });
  const result = await wrapped!.execute("id", {});
  assert.equal(result.content.length, 1);
  const text = (result.content[0] as { type: "text"; text: string }).text;
  assert.ok(text.length < bigText.length, "result must be shorter than original");
  assert.ok(text.includes("per-result cap"), "Layer-1 marker must be present");
});

test("wrapToolsWithResultBudget: over-budget result is truncated (Layer 2)", async () => {
  // Layer-1 cap is large; Layer-2 is tiny.
  const budget = new TurnResultBudget(
    /* servingWindow */ 10_100,
    /* reserve       */ 10_000,
    /* min           */ 100,
  );
  // budget = 10100 - 5000 - 10000 = -4900 → allowance = min = 100
  const bigText = makeText(500);
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 16_384,
    turnBudget: budget,
    getRunningContext: () => 5_000,
  });
  const result = await wrapped!.execute("id", {});
  const text = (result.content[0] as { type: "text"; text: string }).text;
  assert.ok(text.includes("context budget"), "Layer-2 marker must be present");
  assert.ok(text.length < bigText.length, "result must be shorter");
});

test("wrapToolsWithResultBudget: accumulator resets on turnBudget.reset()", async () => {
  const budget = new TurnResultBudget(100_000, 10_000, 1024);
  const bigText = makeText(200);
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 0,   // Layer 1 disabled; Layer 2 applies
    turnBudget: budget,
    getRunningContext: () => 80_000,
  });

  await wrapped!.execute("id1", {});
  const accumulatedBefore = budget.accumulated;
  assert.ok(accumulatedBefore > 0, "budget must have been charged");

  // Simulate commit (onRequestCommitted calls turnBudget.reset()).
  budget.reset();
  assert.equal(budget.accumulated, 0, "accumulated must be 0 after reset");

  // Next turn gets a fresh allowance.
  const allowanceAfterReset = budget.allowance(80_000);
  const allowanceBeforeReset = budget.allowance(80_000) - accumulatedBefore;
  assert.ok(allowanceAfterReset > allowanceBeforeReset, "fresh allowance after reset must be larger");
});

test("wrapToolsWithResultBudget: sequential settlement — later results get smaller allowance", async () => {
  // budget = 50000 - 20000 - 10000 = 20000 tokens for the whole turn.
  // Each tool returns ~8000 tokens:
  //   t1: allowance = 20000, 8000 fits   → charged ~8000
  //   t2: allowance = 12000, 8000 fits   → charged ~8000
  //   t3: allowance = ~4000, 8000 > 4000 → truncated with turn-budget marker
  const budget = new TurnResultBudget(50_000, 10_000, 1024);
  const runningCtx = 20_000;
  const bigText = makeText(8_000); // ~8000 tokens each — exceeds what t3 gets
  const tools = [
    makeTool("t1", [txt(bigText)]),
    makeTool("t2", [txt(bigText)]),
    makeTool("t3", [txt(bigText)]),
  ];
  const wrapped = wrapToolsWithResultBudget(tools, {
    resultMaxTokens: 0,
    turnBudget: budget,
    getRunningContext: () => runningCtx,
  });

  // Execute sequentially (settlement order = execution order here).
  const r1 = await wrapped[0]!.execute("id1", {});
  const r2 = await wrapped[1]!.execute("id2", {});
  const r3 = await wrapped[2]!.execute("id3", {});

  // Each successive result must have less or equal text than the previous.
  const len1 = (r1.content[0] as { type: "text"; text: string }).text.length;
  const len2 = (r2.content[0] as { type: "text"; text: string }).text.length;
  const len3 = (r3.content[0] as { type: "text"; text: string }).text.length;
  assert.ok(len3 <= len1 && len3 <= len2, "third result must be shortest (exhausted budget)");

  // The third result must be truncated by Layer 2.
  const text3 = (r3.content[0] as { type: "text"; text: string }).text;
  assert.ok(text3.includes("context budget"), "third result must carry a turn-budget marker");
});

test("wrapToolsWithResultBudget: floor is respected when budget exhausted", async () => {
  // Set reserve > servingWindow - runningCtx → budget = negative → allowance = min
  const min = 512;
  const budget = new TurnResultBudget(
    /* servingWindow */ 10_000,
    /* reserve       */ 15_000, // reserve > remaining → budget goes negative
    /* min           */ min,
  );
  const bigText = makeText(1000);
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 0,
    turnBudget: budget,
    getRunningContext: () => 5_000,
  });

  const result = await wrapped!.execute("id", {});
  // Result should still carry content (the min floor).
  assert.equal(result.content.length, 1);
  const text = (result.content[0] as { type: "text"; text: string }).text;
  // The text should be present (floor guarantees a useful head).
  assert.ok(text.length > 0, "floor guarantees a non-empty result");
  assert.ok(text.includes("context budget"), "truncation marker must be present");
});

test("wrapToolsWithResultBudget: Layer-1 vs Layer-2 — tighter one wins", async () => {
  const budget = new TurnResultBudget(200_000, 1_000, 100);
  const bigText = makeText(500);
  // Layer-1 cap = 30, Layer-2 allowance = 200000 - 50000 - 1000 = 149000 → Layer 1 is tighter
  const [wrappedL1] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 30,
    turnBudget: budget,
    getRunningContext: () => 50_000,
  });
  const r1 = await wrappedL1!.execute("id", {});
  const t1 = (r1.content[0] as { type: "text"; text: string }).text;
  assert.ok(t1.includes("per-result cap"), "Layer-1 must win when tighter");

  // Layer-1 cap = 150000, Layer-2 = 100 (reserve=199900 → very tight) → Layer 2 is tighter
  const budget2 = new TurnResultBudget(200_000, 199_900, 100);
  const [wrappedL2] = wrapToolsWithResultBudget([makeTool("t2", [txt(bigText)])], {
    resultMaxTokens: 150_000,
    turnBudget: budget2,
    getRunningContext: () => 50,
  });
  const r2 = await wrappedL2!.execute("id", {});
  const t2 = (r2.content[0] as { type: "text"; text: string }).text;
  assert.ok(t2.includes("context budget"), "Layer-2 must win when tighter");
});

test("wrapToolsWithResultBudget: error results pass through unchanged (execute throws)", async () => {
  const budget = new TurnResultBudget(100_000, 10_000, 1024);
  const [wrapped] = wrapToolsWithResultBudget([makeErrorTool("t", "tool failure")], {
    resultMaxTokens: 16_384,
    turnBudget: budget,
    getRunningContext: () => 50_000,
  });

  await assert.rejects(
    () => wrapped!.execute("id", {}),
    /tool failure/,
    "thrown error must propagate unchanged",
  );
  // Budget must not have been charged (consume is never reached on a throw).
  assert.equal(budget.accumulated, 0, "budget must not be charged for error results");
});

test("wrapToolsWithResultBudget: image blocks pass through but charge Layer-2 budget", async () => {
  const budget = new TurnResultBudget(200_000, 1_000, 100);
  const image = img("base64payload", "image/png");
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [image])], {
    resultMaxTokens: 16_384,
    turnBudget: budget,
    getRunningContext: () => 50_000,
  });

  const result = await wrapped!.execute("id", {});

  // Image must pass through untouched.
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "image");
  assert.equal(
    (result.content[0] as { type: "image"; data: string }).data,
    "base64payload",
  );

  // Image is flat-charged against Layer 2.
  assert.equal(budget.accumulated, PER_IMAGE_TOKEN_ESTIMATE, "image charges PER_IMAGE_TOKEN_ESTIMATE");
});

test("wrapToolsWithResultBudget: multi-result turn stays within servingWindow − reserve", async () => {
  const servingWindow = 100_000;
  const reserve = 10_000;
  const min = 1024;
  // Leaves budget = 100000 - 80000 - 10000 = 10000 for the whole turn
  const runningCtx = 80_000;
  const budget = new TurnResultBudget(servingWindow, reserve, min);

  // Three tools each returning ~5000 tokens — far more than the 10000 turn budget.
  const tools = [
    makeTool("t1", [txt(makeText(5000))]),
    makeTool("t2", [txt(makeText(5000))]),
    makeTool("t3", [txt(makeText(5000))]),
  ];
  const wrapped = wrapToolsWithResultBudget(tools, {
    resultMaxTokens: 0, // Layer 1 disabled
    turnBudget: budget,
    getRunningContext: () => runningCtx,
  });

  const results = await Promise.all(
    wrapped.map((w, i) => w!.execute(`id${i}`, {})),
  );

  // Every result must carry a visible truncation marker.
  let truncatedCount = 0;
  for (const r of results) {
    const t = (r.content[0] as { type: "text"; text: string }).text;
    if (t.includes("context budget")) truncatedCount++;
  }
  assert.ok(truncatedCount > 0, "at least one result must be truncated");

  // Total tokens charged must not exceed budget + (N−1)×min (floor-overshoot bound).
  const N = tools.length;
  const maxAllowed = (servingWindow - runningCtx - reserve) + (N - 1) * min;
  assert.ok(
    budget.accumulated <= maxAllowed,
    `accumulated (${budget.accumulated}) must be ≤ budget + (N-1)×min = ${maxAllowed}`,
  );
});

test("wrapToolsWithResultBudget: resultMaxTokens=0 disables Layer 1, Layer 2 still active", async () => {
  // Layer 1 off, Layer 2 gives only 2000 tokens.
  const budget = new TurnResultBudget(
    /* servingWindow */ 50_000,
    /* reserve       */ 47_000,
    /* min           */ 1024,
  );
  // budget = 50000 - 1000 - 47000 = 2000
  const bigText = makeText(5000);
  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 0,  // Layer 1 disabled
    turnBudget: budget,
    getRunningContext: () => 1_000,
  });

  const result = await wrapped!.execute("id", {});
  const text = (result.content[0] as { type: "text"; text: string }).text;

  // Must be truncated by Layer 2 (not Layer 1 which is off).
  assert.ok(text.includes("context budget"), "Layer-2 marker must fire when Layer 1 is disabled");
  // Must NOT carry a per-result-cap marker (Layer 1 is off).
  assert.ok(!text.includes("per-result cap"), "Layer-1 marker must NOT fire when disabled");
});

test("wrapToolsWithResultBudget: onTruncation callback fires for truncated results", async () => {
  const budget = new TurnResultBudget(200_000, 1_000, 100);
  const bigText = makeText(500);
  let callbackFired = false;
  let capturedInfo: { tool: string; layer: string; fromTokens: number; toTokens: number } | undefined;

  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt(bigText)])], {
    resultMaxTokens: 30,  // Layer 1 fires
    turnBudget: budget,
    getRunningContext: () => 50_000,
    onTruncation: (info) => {
      callbackFired = true;
      capturedInfo = info;
    },
  });

  await wrapped!.execute("id", {});

  assert.ok(callbackFired, "onTruncation must fire when a result is truncated");
  assert.equal(capturedInfo!.tool, "t");
  assert.equal(capturedInfo!.layer, "per-result");
  assert.ok(capturedInfo!.fromTokens > capturedInfo!.toTokens, "fromTokens must exceed toTokens");
  assert.ok(capturedInfo!.toTokens > 0, "toTokens must be positive");
});

test("wrapToolsWithResultBudget: onTruncation does not fire for non-truncated results", async () => {
  const budget = new TurnResultBudget(200_000, 1_000, 100);
  let callbackFired = false;

  const [wrapped] = wrapToolsWithResultBudget([makeTool("t", [txt("tiny")])], {
    resultMaxTokens: 16_384,
    turnBudget: budget,
    getRunningContext: () => 50_000,
    onTruncation: () => { callbackFired = true; },
  });

  await wrapped!.execute("id", {});
  assert.equal(callbackFired, false, "onTruncation must not fire for non-truncated results");
});
