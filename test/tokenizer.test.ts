import assert from "node:assert/strict";
import test from "node:test";
import {
  GlmTokenizer,
  GptTokenizer,
  initTokenizers,
  getPrimaryTokenizer,
  getRetrievalTokenizer,
  resetTokenizersForTest,
  type Tokenizer,
} from "../src/context/tokenizer/index.js";
import { estimateTokens, splitByTokens, truncateToTokens } from "../src/context/tokens.js";
import { chunkMemoryFile } from "../src/retrieval/chunk.js";
import { validateTokenizerConfig } from "../src/app.js";
import type { AppConfig } from "../src/config/index.js";

const FIXTURE = "native/crates/matrix-core/tests/fixtures/byte-bpe.tokenizer.json";

// --- Shared parity/behaviour suite, run against both implementations ---------
function paritySuite(name: string, make: () => Tokenizer): void {
  test(`${name}: count — empty is 0, non-empty is positive, stable`, () => {
    const t = make();
    assert.equal(t.count(""), 0);
    const c = t.count("hello world, this is a calibration probe");
    assert.ok(c > 0);
    assert.equal(c, t.count("hello world, this is a calibration probe"));
  });

  test(`${name}: count adds NO special-token overhead (empty → 0)`, () => {
    // A BOS-adding count would make the empty string 1, not 0 — this is the
    // add_special_tokens=false contract (parity with gpt-tokenizer).
    assert.equal(make().count(""), 0);
  });

  test(`${name}: truncate is a no-op within budget, a prefix over budget`, () => {
    const t = make();
    const text = Array.from({ length: 400 }, (_, i) => `token number ${i} about widgets and gadgets`).join(" ");
    const full = t.count(text);
    assert.ok(full > 50, "precondition: text exceeds the small budget");
    assert.equal(t.truncate(text, full + 100), text, "within budget → unchanged");
    const clipped = t.truncate(text, 50);
    assert.ok(t.count(clipped) <= 50, "over budget → count within max");
    assert.ok(text.startsWith(clipped) || text.includes(clipped.slice(0, 20)), "clip is a prefix");
    assert.ok(clipped.length < text.length);
  });

  test(`${name}: truncate handles multibyte/emoji without producing garbage`, () => {
    const t = make();
    const text = "こんにちは 🎉 café ümlauts 日本語 🚀 ".repeat(40);
    const clipped = t.truncate(text, 20);
    // truncate returns decode(firstN tokens). For byte-level BPE a token-20 boundary
    // can split a multibyte char, so the decoded prefix may RE-encode to a couple of
    // tokens over budget (a boundary replacement char costs 1–3 tokens). That's a
    // property of byte-level truncation, not garbage — allow a small slack.
    assert.ok(t.count(clipped) <= 20 + 4, `count ${t.count(clipped)} within budget + slack`);
    assert.equal(typeof clipped, "string");
    assert.ok(clipped.length < text.length, "clipped is shorter than the input");
    assert.ok(text.startsWith(clipped.slice(0, 4)));
  });

  test(`${name}: split — windows tile the text, offsets are valid substrings`, () => {
    const t = make();
    const text = Array.from({ length: 300 }, (_, i) => `sentence ${i} about the launch and the rollout`).join("\n");
    const windows = t.split(text, 40, 8);
    assert.ok(windows.length > 1, "long text splits into multiple windows");
    for (const w of windows) {
      assert.ok(w.charStart >= 0 && w.charEnd <= text.length);
      assert.ok(w.charEnd >= w.charStart);
      // Each window's text is (essentially) the substring at its offsets — a
      // multibyte boundary may shift by at most one char (documented in algorithms.ts).
      const slice = text.slice(w.charStart, w.charEnd);
      assert.ok(
        slice === w.text || slice.includes(w.text.slice(1, -1)) || w.text.includes(slice.slice(1, -1)),
        "window text matches its char offsets",
      );
      assert.ok(t.count(w.text) <= 40 + 2, "window within size (±boundary token)");
    }
  });

  test(`${name}: split returns [] for empty, single window when within size`, () => {
    const t = make();
    assert.deepEqual(t.split("", 100, 10), []);
    const small = "just a short line";
    const w = t.split(small, 100, 10);
    assert.equal(w.length, 1);
    assert.equal(w[0]!.text, small);
    assert.equal(w[0]!.charStart, 0);
    assert.equal(w[0]!.charEnd, small.length);
  });
}

paritySuite("GptTokenizer", () => new GptTokenizer());
paritySuite("GlmTokenizer", () => GlmTokenizer.fromFile(FIXTURE));

// --- GLM native specifics ---------------------------------------------------
test("GlmTokenizer: countAsync matches sync count (libuv escape hatch)", async () => {
  const t = GlmTokenizer.fromFile(FIXTURE);
  for (const s of ["", "hello world", "こんにちは 🎉 multibyte"]) {
    assert.equal(await t.countAsync(s), t.count(s), `countAsync==count for ${JSON.stringify(s)}`);
  }
});

test("GptTokenizer: no countAsync (sync-only; callers fall back to count)", () => {
  assert.equal(new GptTokenizer().countAsync, undefined);
});

// --- Registry ---------------------------------------------------------------
test("registry: defaults to gpt-tokenizer lazily when init never ran", () => {
  resetTokenizersForTest();
  assert.ok(getPrimaryTokenizer() instanceof GptTokenizer);
  assert.ok(getRetrievalTokenizer() instanceof GptTokenizer);
});

test("registry: initTokenizers binds primary=glm, retrieval=gpt (per-consumer scoping)", async () => {
  resetTokenizersForTest();
  await initTokenizers({ primary: "glm", retrieval: "gpt-tokenizer", glmTokenizerPath: FIXTURE });
  assert.ok(getPrimaryTokenizer() instanceof GlmTokenizer, "primary is glm");
  assert.ok(getRetrievalTokenizer() instanceof GptTokenizer, "retrieval stays gpt");
  resetTokenizersForTest();
});

test("registry: same kind for both consumers shares one instance", async () => {
  resetTokenizersForTest();
  await initTokenizers({ primary: "gpt-tokenizer", retrieval: "gpt-tokenizer" });
  assert.equal(getPrimaryTokenizer(), getRetrievalTokenizer(), "one shared gpt instance");
  resetTokenizersForTest();
});

test("registry: initTokenizers fail-fast when glm selected without a path", async () => {
  resetTokenizersForTest();
  await assert.rejects(
    () => initTokenizers({ primary: "glm" }),
    /glm_tokenizer_path is not set/,
  );
  resetTokenizersForTest();
});

test("registry: chunk.ts uses the INJECTED retrieval tokenizer, not the primary (§5.3)", async () => {
  resetTokenizersForTest();
  // Set the MODULE primary to glm — if the chunker (wrongly) reached for the
  // module-level tokenizer, tokenCount would be a small BPE number, not the stub's.
  await initTokenizers({ primary: "glm", retrieval: "gpt-tokenizer", glmTokenizerPath: FIXTURE });
  let countAsyncCalls = 0;
  const stub: Tokenizer = {
    count: (t) => t.length, // distinctive: char length, never a BPE count
    truncate: (t) => t,
    split: (t) => [{ text: t, charStart: 0, charEnd: t.length }],
    countAsync: async (t) => {
      countAsyncCalls++;
      return t.length;
    },
  };
  const text = "## 2026-01-01 10:00 → 2026-01-01 11:00 · UTC · #room\nhello body text here\n";
  const chunks = await chunkMemoryFile({
    relativePath: "memory/2026-01-01.md",
    text,
    fileDate: "2026-01-01",
    fallbackTimestamp: 0,
    maxChunkTokens: 4096,
    fallbackChunkTokens: 400,
    fallbackChunkOverlap: 80,
    tokenizer: stub,
  });
  assert.ok(chunks.length >= 1);
  // tokenCount == char length proves the stub (injected) tokenizer produced it.
  assert.equal(chunks[0]!.tokenCount, chunks[0]!.text.length);
  assert.ok(countAsyncCalls >= 1, "oversize check went through the injected countAsync hatch");
  resetTokenizersForTest();
});

test("registry: module-level estimateTokens delegates to the primary tokenizer", async () => {
  resetTokenizersForTest();
  // gpt primary → estimateTokens == GptTokenizer.count
  await initTokenizers({ primary: "gpt-tokenizer" });
  const probe = "a representative chat message about the deploy logs";
  assert.equal(estimateTokens(probe), new GptTokenizer().count(probe));
  // glm primary → estimateTokens tracks the glm tokenizer (different count)
  resetTokenizersForTest();
  await initTokenizers({ primary: "glm", glmTokenizerPath: FIXTURE });
  assert.equal(estimateTokens(probe), GlmTokenizer.fromFile(FIXTURE).count(probe));
  // truncate/split delegate too
  assert.equal(truncateToTokens(probe, 100000), probe);
  assert.ok(splitByTokens(probe.repeat(50), 30, 5).length > 1);
  resetTokenizersForTest();
});

// --- app.ts cross-field validation -----------------------------------------
function cfg(tokenizer: AppConfig["tokenizer"]): AppConfig {
  return { tokenizer } as unknown as AppConfig;
}

test("validateTokenizerConfig: gpt-only / unset is fine", () => {
  validateTokenizerConfig(cfg(undefined));
  validateTokenizerConfig(cfg({ primary: "gpt-tokenizer", retrieval: "gpt-tokenizer" }));
});

test("validateTokenizerConfig: glm without a path throws", () => {
  assert.throws(
    () => validateTokenizerConfig(cfg({ primary: "glm" })),
    /glm_tokenizer_path is missing/,
  );
  assert.throws(
    () => validateTokenizerConfig(cfg({ retrieval: "glm", glm_tokenizer_path: "  " })),
    /glm_tokenizer_path is missing/,
  );
});

test("validateTokenizerConfig: glm with an unreadable path throws", () => {
  assert.throws(
    () => validateTokenizerConfig(cfg({ primary: "glm", glm_tokenizer_path: "/no/such/tokenizer.json" })),
    /not readable/,
  );
});

test("validateTokenizerConfig: glm with a readable path is accepted", () => {
  validateTokenizerConfig(cfg({ primary: "glm", glm_tokenizer_path: FIXTURE }));
});
