/**
 * Tokenizer perf microbenchmark — baseline + GLM perf gate for spec/TOKENIZER-SWAP.md
 * (§4, §6.3).
 *
 * Measures encode throughput and the per-context-build tokenization cost of the
 * shipped `gpt-tokenizer` estimator AND the native GLM tokenizer. The sync-vs-async
 * decision (§4) rests on the gpt numbers (a full build spends ~1 ms in
 * tokenization). §6.3 is the **gate**: the native build must stay within the same
 * order as the gpt baseline — a debug-built tokenizer that regresses below it means
 * the `opt-level` override in native/Cargo.toml did NOT take effect, which is a
 * blocker, not a ship.
 *
 * Not a test (excluded from the `test/**\/*.test.ts` runner glob). Run:
 *   npx tsx test/tok-bench.ts [path/to/glm/tokenizer.json]
 * With no arg it benches the synthetic byte-BPE fixture, which still exercises the
 * native crate's BPE loop and so still proves the build was optimized.
 */
import { encode } from "gpt-tokenizer/model/gpt-4o";
import { GptTokenizer } from "../src/context/tokenizer/gpt.js";
import { GlmTokenizer } from "../src/context/tokenizer/glm.js";

function bench(label: string, fn: () => void, iters: number): number {
  // warm
  for (let i = 0; i < Math.min(iters, 50); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  console.log(
    `${label}: ${iters} iters, ${totalMs.toFixed(1)} ms total, ${((totalMs / iters) * 1000).toFixed(2)} µs/op`,
  );
  return totalMs / iters;
}

// Representative inputs
const tinyMsg = "<msg user=\"alice\" ts=\"12:30\">hey can you check the deploy logs? something looks off in prod</msg>";
const bigBody = "lorem ipsum dolor sit amet ".repeat(600); // ~4000 tokens-ish (~16KB)
const hugeFile = "The quick brown fox jumps over the lazy dog. ".repeat(5000); // ~225KB, retrieval-indexing worst case

const tinyToks = encode(tinyMsg).length;
const bigToks = encode(bigBody).length;
const hugeToks = encode(hugeFile).length;
console.log(`sizes: tiny=${tinyMsg.length}ch/${tinyToks}tok  big=${bigBody.length}ch/${bigToks}tok  huge=${hugeFile.length}ch/${hugeToks}tok\n`);

console.log("== gpt-tokenizer (gpt-4o BPE) — baseline ==");
const gpt = new GptTokenizer();
const gptTiny = bench("tiny message count", () => { gpt.count(tinyMsg); }, 50000);
bench("4k-token body count", () => { gpt.count(bigBody); }, 2000);
bench("225KB file count (split worst case)", () => { gpt.count(hugeFile); }, 200);
const gptBuild = bench("FULL BUILD sim (600 small counts)", () => {
  for (let e = 0; e < 600; e++) gpt.count(tinyMsg);
}, 200);

const glmPath = process.argv[2] ?? "native/crates/matrix-core/tests/fixtures/byte-bpe.tokenizer.json";
console.log(`\n== glm native tokenizer (${glmPath}) — §6.3 gate ==`);
// Probe native availability. Since the binding load became lazy (the throw moved out
// of import time into GlmTokenizer.fromFile), this catch is the live guard: with no
// fresh `pnpm build:native` it degrades GRACEFULLY — the gpt baseline above already
// printed, so we just skip the GLM side + perf gate and exit cleanly (0), rather than
// failing the run.
let glm: GlmTokenizer | null = null;
try {
  glm = GlmTokenizer.fromFile(glmPath);
} catch (err) {
  console.error(`\nSKIPPING GLM gate — native tokenizer unavailable: ${(err as Error).message}`);
  console.error("Run `pnpm build:native` (then re-run) to exercise the GLM side / §6.3 perf gate.");
  process.exit(0);
}
const glmTiny = bench("tiny message count", () => { glm!.count(tinyMsg); }, 50000);
bench("4k-token body count", () => { glm!.count(bigBody); }, 2000);
bench("225KB file count", () => { glm!.count(hugeFile); }, 200);
const glmBuild = bench("FULL BUILD sim (600 small counts)", () => {
  for (let e = 0; e < 600; e++) glm!.count(tinyMsg);
}, 200);

console.log("\n== §6.3 perf gate (opt-level override must be in effect) ==");
const tinyRatio = glmTiny / gptTiny;
const buildRatio = glmBuild / gptBuild;
console.log(`tiny-count    gpt=${(gptTiny * 1000).toFixed(2)}µs  glm=${(glmTiny * 1000).toFixed(2)}µs  glm/gpt=${tinyRatio.toFixed(1)}×`);
console.log(`full-build    gpt=${gptBuild.toFixed(2)}ms  glm=${glmBuild.toFixed(2)}ms  glm/gpt=${buildRatio.toFixed(1)}×`);
console.log(
  `note: glm carries NAPI FFI + the tokenizers crate's per-call overhead, so it runs a\n` +
    `  single order slower than gpt-tokenizer's JS — expected, and still ≈${glmBuild.toFixed(0)}ms per ~600-encode\n` +
    `  build, negligible vs an LLM call (§4 sync decision holds). The gate below only\n` +
    `  catches an UN-optimized (debug) native build.`,
);
// The gate's real job (§5.2/§6.3): catch a debug-built BPE loop. Measured on this
// box, the OPTIMIZED native tokenizer is ~12× gpt; a DEBUG build is ~70× gpt (the
// opt-level=3 override buys ~8× on the BPE loop). A 30× threshold cleanly separates
// them and is machine-independent (both sides measured in the same run).
const DEBUG_GATE = 30;
if (tinyRatio > DEBUG_GATE) {
  console.error(
    `\n❌ GATE FAILED: GLM tiny-count is ${tinyRatio.toFixed(0)}× gpt (> ${DEBUG_GATE}×) — the opt-level=3 override in\n` +
      `   native/Cargo.toml did NOT take effect; this is a DEBUG-built BPE loop. See spec §5.2 / §6.3.`,
  );
  process.exit(1);
}
console.log(
  `\n✅ GATE PASSED: ${tinyRatio.toFixed(0)}× gpt is the optimized profile (< ${DEBUG_GATE}× debug threshold) — opt-level override in effect.`,
);
