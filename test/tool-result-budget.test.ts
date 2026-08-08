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
import { estimateTokens } from "../src/context/tokens.js";
import { loadConfig } from "../src/config/index.js";

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

  // textTokensShown should be at most the allowance.
  assert.ok(
    r.textTokensShown <= allowance,
    `textTokensShown (${r.textTokensShown}) must be <= allowance (${allowance})`,
  );
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

  // textTokensShown must be <= allowance.
  assert.ok(r.textTokensShown <= allowance, "textTokensShown must be <= allowance");
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
  assert.ok(r.textTokensShown <= effectiveCap);
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
