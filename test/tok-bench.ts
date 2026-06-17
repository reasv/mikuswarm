/**
 * Tokenizer perf microbenchmark — baseline for spec/TOKENIZER-SWAP.md (§4, §6.3).
 *
 * Measures encode throughput and the per-context-build tokenization cost of the
 * CURRENT estimator. The sync-vs-async decision in the spec rests on these
 * numbers (a full build spends ~1 ms in tokenization). To compare a candidate
 * GLM tokenizer, swap the `encode` import below for the native binding and
 * re-run; per §6.3 the GLM build must stay within the same order as this
 * baseline (a debug-built native tokenizer that regresses is a blocker).
 *
 * Not a test (excluded from the `test/**\/*.test.ts` runner glob) and not in the
 * tsconfig `src/**` include. Run: `npx tsx test/tok-bench.ts`.
 */
import { encode } from "gpt-tokenizer/model/gpt-4o";

function bench(label: string, fn: () => void, iters: number) {
  // warm
  for (let i = 0; i < Math.min(iters, 50); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  console.log(`${label}: ${iters} iters, ${totalMs.toFixed(1)} ms total, ${(totalMs / iters * 1000).toFixed(2)} µs/op`);
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

const perTiny = bench("tiny message encode", () => { encode(tinyMsg); }, 50000);
bench("4k-token body encode", () => { encode(bigBody); }, 2000);
bench("225KB file encode (splitByTokens worst case)", () => { encode(hugeFile); }, 200);

// Simulate one context build: ~300 events, each encoded rich+compact (~600 encodes of small strings)
const buildMs = bench("FULL BUILD sim (600 small encodes)", () => {
  for (let e = 0; e < 600; e++) encode(tinyMsg);
}, 200);

const charsPerSec = (tinyMsg.length / (perTiny / 1000)) / 1e6;
console.log(`\napprox tiny-string throughput: ${charsPerSec.toFixed(1)} M chars/s`);
console.log(`=> a 300-event build spends ~${buildMs.toFixed(1)} ms in tokenization (event-loop blocked that long)`);
