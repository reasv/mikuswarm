/**
 * Measure late-interaction MaxSim throughput on this host and size the
 * exhaustive window (spec MEMORY-RETRIEVAL §5.0d "Sizing the window";
 * `[retrieval.late].exhaustive_blocks`). The tool generates random
 * L2-normalized token vectors (no data is read), loads growing resident
 * windows into a scorer backend, and measures the median score latency per
 * window size. It prints only numbers: per size the median and throughput
 * (document tokens scored per ms), then the largest measured block count that
 * fits the target and a linear extrapolation from the largest measured size.
 *
 * Usage:
 *   npx tsx scripts/bench-late.ts [options]
 *
 * Options:
 *   --backend exact|turboquant  scorer backend (default exact: fp32 ONNX in a worker thread;
 *                               turboquant: the native kernel, when the module is built)
 *   --dim <n>                   vector dimensions (default 128)
 *   --query-tokens <n>          query tokens (default 32)
 *   --block-tokens <n>          tokens per block (default 340)
 *   --target-ms <n>             latency budget for one MaxSim pass (default 100)
 *   --threads <n>               scorer threads (default: the backend's default)
 *   --bits <n>                  TurboQuant bits per coordinate (default 4; turboquant only)
 *   --max-blocks <n>            largest window tried (default 20000)
 *   --start-blocks <n>          first window size; each next size doubles (default 250)
 *   --runs <n>                  timed runs per size, after one warm-up (default 7)
 *
 * Memory: the exact backend holds blocks × block-tokens × dim × 4 bytes in its
 * worker (about 700 MB for 4,000 blocks of 340 tokens at 128 dims). Sizes stop
 * growing once a median exceeds twice the target.
 */
import { parseArgs } from "node:util";
import { ExactMaxSimScorer } from "../src/retrieval/late/maxsim.js";
import type { MaxSimScorer, ScoredDoc } from "../src/retrieval/late/scorer.js";
import type { TokenMatrix } from "../src/retrieval/models/types.js";

const { values } = parseArgs({
  options: {
    backend: { type: "string", default: "exact" },
    dim: { type: "string", default: "128" },
    "query-tokens": { type: "string", default: "32" },
    "block-tokens": { type: "string", default: "340" },
    "target-ms": { type: "string", default: "100" },
    threads: { type: "string" },
    bits: { type: "string", default: "4" },
    "max-blocks": { type: "string", default: "20000" },
    "start-blocks": { type: "string", default: "250" },
    runs: { type: "string", default: "7" },
  },
});

function positive(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(2);
  }
  return n;
}

const backend = values.backend!;
const dim = positive("dim", values.dim);
const queryTokens = positive("query-tokens", values["query-tokens"]);
const blockTokens = positive("block-tokens", values["block-tokens"]);
const targetMs = positive("target-ms", values["target-ms"]);
const threads = values.threads === undefined ? undefined : positive("threads", values.threads);
const bits = positive("bits", values.bits);
const maxBlocks = positive("max-blocks", values["max-blocks"]);
const startBlocks = positive("start-blocks", values["start-blocks"]);
const runs = positive("runs", values.runs);

let seed = 0x9e3779b9;
function rand(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function randomMatrix(tokens: number): TokenMatrix {
  const data = new Float32Array(tokens * dim);
  for (let t = 0; t < tokens; t++) {
    let norm = 0;
    for (let k = 0; k < dim; k++) {
      const v = rand() * 2 - 1;
      data[t * dim + k] = v;
      norm += v * v;
    }
    const inv = 1 / Math.sqrt(norm);
    for (let k = 0; k < dim; k++) data[t * dim + k]! *= inv;
  }
  return { tokens, dim, data };
}

async function createScorer(): Promise<MaxSimScorer | null> {
  if (backend === "exact") return ExactMaxSimScorer.create({ threads });
  if (backend === "turboquant") {
    try {
      const mod = (await import("../src/retrieval/late/turboquant.js" as string)) as {
        createTurboQuantScorer: (opts: { threads?: number; bits?: number }) => Promise<MaxSimScorer> | MaxSimScorer;
      };
      return await mod.createTurboQuantScorer({ threads, bits });
    } catch (error) {
      console.log(`backend turboquant unavailable: ${(error as Error).message}`);
      return null;
    }
  }
  console.error("--backend must be exact or turboquant");
  process.exit(2);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const scorer = await createScorer();
if (!scorer) process.exit(1);

// A pool of distinct blocks reused across the window (scores are not checked).
const pool = Array.from({ length: 256 }, () => randomMatrix(blockTokens));
const query = randomMatrix(queryTokens);

console.log(
  `backend ${scorer.backend}  dim ${dim}  query_tokens ${queryTokens}  block_tokens ${blockTokens}  target_ms ${targetMs}` +
    (threads ? `  threads ${threads}` : ""),
);
console.log("blocks\tdoc_tokens\tmedian_ms\ttokens_per_ms");

let bestFit = 0;
let last: { blocks: number; ms: number } | null = null;
try {
  for (let blocks = Math.min(startBlocks, maxBlocks); ; blocks = Math.min(blocks * 2, maxBlocks)) {
    const docs: ScoredDoc[] = Array.from({ length: blocks }, (_, i) => ({ key: String(i), matrix: pool[i % pool.length]! }));
    await scorer.setWindow("bench", docs);
    await scorer.score(query, { windowId: "bench", windowTopK: 60 }); // warm-up
    const times: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      await scorer.score(query, { windowId: "bench", windowTopK: 60 });
      times.push(performance.now() - t0);
    }
    const ms = median(times);
    const docTokens = blocks * blockTokens;
    console.log(`${blocks}\t${docTokens}\t${ms.toFixed(2)}\t${Math.round(docTokens / ms)}`);
    if (ms <= targetMs) bestFit = blocks;
    last = { blocks, ms };
    if (ms > targetMs * 2 || blocks >= maxBlocks) break;
  }
} finally {
  await scorer.dropWindow("bench").catch(() => undefined);
  await scorer.close();
}

console.log(`fits_target_measured_blocks\t${bestFit}`);
if (last) console.log(`fits_target_extrapolated_blocks\t${Math.floor((last.blocks * targetMs) / last.ms)}`);
