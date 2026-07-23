/**
 * Calibration harness — the REQUIRED-before-rollout measurement for
 * spec/TOKENIZER-SWAP.md §6. Samples each token-denominated **content class** from
 * a copy of the production SQLite DB (+ optional `memory/` tree), encodes every
 * sample under both the baseline (`gpt-tokenizer`) and a comparison tokenizer, and
 * reports the per-class GLM/gpt ratio (aggregate + p50/p90/p99/max) plus the §6.2
 * recalibration table (each knob → its class ratio → recommended new value).
 *
 * The ratio is NOT uniform across content (prose, code, URLs, CJK, emoji inflate
 * differently), so this measures it per class against real data rather than
 * blanket-multiplying by the ~1.5 average.
 *
 * Run (real numbers — operator supplies the GLM tokenizer.json, §5.2/§10.1):
 *   npx tsx test/tok-calibrate.ts --db var/mikuswarm.db \
 *       --glm native/assets/glm-5.1/tokenizer.json [--memory workspaces/miku/memory] [--sample 2000]
 *
 * With no --glm it compares against the synthetic byte-BPE test fixture — a
 * DEMONSTRATION of the machinery + the real per-class distribution shapes, NOT
 * GLM-meaningful ratios. The §6.2 table's GLM column must be filled by re-running
 * with the real tokenizer.json.
 *
 * Not a unit test (excluded from the `*.test.ts` runner glob). Prints only counts
 * and ratios — never sample content.
 */
import Database from "better-sqlite3";
import { renderCompactMessage, renderRichMessage } from "../src/context/renderer.js";
import { configureAgentTimezone } from "../src/time/index.js";
import { GptTokenizer } from "../src/context/tokenizer/gpt.js";
import { GlmTokenizer } from "../src/context/tokenizer/glm.js";
import type { Tokenizer } from "../src/context/tokenizer/types.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("db") ?? "var/mikuswarm.db";
const glmPath = arg("glm");
const memoryDir = arg("memory");
const sampleCap = Number(arg("sample") ?? "0") || Infinity;

configureAgentTimezone("UTC");

const gpt = new GptTokenizer();
const glm: Tokenizer = glmPath
  ? GlmTokenizer.fromFile(glmPath)
  : GlmTokenizer.fromFile("native/crates/matrix-core/tests/fixtures/byte-bpe.tokenizer.json");
const usingRealGlm = Boolean(glmPath);

interface ClassStat {
  name: string;
  items: number;
  gptTotal: number;
  glmTotal: number;
  ratios: number[];
}

function measure(name: string, texts: Iterable<string>): ClassStat {
  let items = 0;
  let gptTotal = 0;
  let glmTotal = 0;
  const ratios: number[] = [];
  for (const t of texts) {
    if (!t) continue;
    const g = gpt.count(t);
    if (g === 0) continue;
    const m = glm.count(t);
    items++;
    gptTotal += g;
    glmTotal += m;
    ratios.push(m / g);
  }
  ratios.sort((a, b) => a - b);
  return { name, items, gptTotal, glmTotal, ratios };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Limit the per-class sample for speed; ORDER BY rowid keeps it deterministic.
const take = <T>(rows: T[]): T[] => (rows.length > sampleCap ? rows.slice(0, sampleCap) : rows);

// --- Chat events → compact / rich renderers --------------------------------
const eventRows = take(
  db.prepare("select event_json from timeline_events order by rowid").all() as Array<{
    event_json: string;
  }>,
);
const events: CanonicalChatEvent[] = [];
for (const r of eventRows) {
  try {
    events.push(JSON.parse(r.event_json) as CanonicalChatEvent);
  } catch {
    /* skip unparseable */
  }
}
const compactStat = measure("compact chat events", events.map((e) => renderCompactMessage(e)));
const richStat = measure("rich chat events", events.map((e) => renderRichMessage(e)));

// --- Summaries, per level --------------------------------------------------
const summaryLevels = db
  .prepare("select distinct level from summaries order by level")
  .all() as Array<{ level: number }>;
const summaryStats = summaryLevels.map(({ level }) => {
  const rows = take(
    db
      .prepare("select content from summaries where level = ? and content <> '' order by rowid")
      .all(level) as Array<{ content: string }>,
  );
  return measure(`summary L${level}`, rows.map((r) => r.content));
});
const allSummaryRows = take(
  db.prepare("select content from summaries where content <> '' order by rowid").all() as Array<{
    content: string;
  }>,
);
const summaryAllStat = measure("summary (all levels)", allSummaryRows.map((r) => r.content));

// --- Memory chunks (diary + retrieved snippets) ----------------------------
const memRows = take(
  db.prepare("select text from memory_chunks order by rowid").all() as Array<{ text: string }>,
);
const memoryStat = measure("memory chunks", memRows.map((r) => r.text));

// --- Optional: raw memory/*.md files ---------------------------------------
let memoryFileStat: ClassStat | undefined;
if (memoryDir) {
  const texts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "SOUL.md") continue; // persona file, not a memory chunk
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".md")) texts.push(readFileSync(p, "utf8"));
    }
  };
  walk(memoryDir);
  memoryFileStat = measure("memory/*.md files", take(texts));
}

db.close();

// --- Report ----------------------------------------------------------------
const allStats = [
  compactStat,
  richStat,
  ...summaryStats,
  summaryAllStat,
  memoryStat,
  ...(memoryFileStat ? [memoryFileStat] : []),
];

console.log(`\nTokenizer calibration — baseline=gpt-tokenizer, comparison=${usingRealGlm ? `glm (${glmPath})` : "SYNTHETIC FIXTURE (demo only)"}`);
console.log(`db=${dbPath}${memoryDir ? `  memory=${memoryDir}` : ""}  sampleCap=${sampleCap === Infinity ? "all" : sampleCap}\n`);
if (!usingRealGlm) {
  console.log("⚠  No --glm tokenizer.json supplied: ratios below compare gpt-tokenizer to the");
  console.log("   synthetic byte-BPE FIXTURE and are NOT GLM-meaningful. They demonstrate the");
  console.log("   harness + the per-class distribution shape. Re-run with --glm for §6.2.\n");
}

const col = (s: string, w: number) => s.padEnd(w);
console.log(
  col("content class", 24) + col("items", 8) + col("aggregate", 11) + col("p50", 8) + col("p90", 8) + col("p99", 8) + col("max", 8),
);
console.log("-".repeat(75));
for (const s of allStats) {
  const agg = s.gptTotal > 0 ? s.glmTotal / s.gptTotal : 0;
  console.log(
    col(s.name, 24) +
      col(String(s.items), 8) +
      col(agg.toFixed(3) + "×", 11) +
      col(pct(s.ratios, 50).toFixed(2), 8) +
      col(pct(s.ratios, 90).toFixed(2), 8) +
      col(pct(s.ratios, 99).toFixed(2), 8) +
      col(pct(s.ratios, 100).toFixed(2), 8),
  );
}

// --- §6.2 recalibration table ----------------------------------------------
const aggOf = (s: ClassStat): number => (s.gptTotal > 0 ? s.glmTotal / s.gptTotal : 0);
const rCompact = aggOf(compactStat);
const rRich = aggOf(richStat);
const rSummary = aggOf(summaryAllStat);
const rDiary = aggOf(memoryStat);
const rSnippet = aggOf(memoryStat);

interface Knob {
  knob: string;
  def: number;
  klass: string;
  ratio: number | null; // null = unchanged
}
const knobs: Knob[] = [
  { knob: "context.tiers.rich_target_tokens", def: 4000, klass: "rich events", ratio: rRich },
  { knob: "context.tiers.rich_max_tokens", def: 8000, klass: "rich events", ratio: rRich },
  { knob: "context.tiers.compact_target_tokens", def: 16000, klass: "compact events", ratio: rCompact },
  { knob: "context.tiers.compact_max_tokens", def: 24000, klass: "compact events", ratio: rCompact },
  { knob: "summarization.generation_threshold_tokens", def: 6000, klass: "compact events", ratio: rCompact },
  { knob: "summarization.leaf_input_tokens", def: 4000, klass: "compact events", ratio: rCompact },
  { knob: "summarization.leaf_target_tokens", def: 600, klass: "summary prose", ratio: rSummary },
  { knob: "summarization.condense_target_tokens", def: 800, klass: "summary prose", ratio: rSummary },
  { knob: "diary.per_session_budget_tokens", def: 1200, klass: "diary prose", ratio: rDiary },
  { knob: "diary.recency_max_tokens", def: 6000, klass: "diary prose", ratio: rDiary },
  { knob: "retrieval.auto.max_tokens", def: 600, klass: "snippet/summary", ratio: rSnippet },
  { knob: "search.recap_budget_tokens", def: 6000, klass: "summary prose", ratio: rSummary },
  { knob: "search.summaries.expand_token_cap", def: 4000, klass: "summary prose", ratio: rSummary },
  { knob: "summarization.summary_max_overage_factor", def: 2.5, klass: "— (multiplier)", ratio: null },
  { knob: "retrieval.index.max_chunk_tokens", def: 512, klass: "embedder-bound", ratio: null },
  { knob: "retrieval.index.fallback_chunk_tokens", def: 400, klass: "embedder-bound", ratio: null },
  { knob: "retrieval.index.fallback_chunk_overlap", def: 80, klass: "embedder-bound", ratio: null },
  { knob: "session_types.*.max_context_tokens", def: 60000, klass: "provider actuals", ratio: null },
  { knob: "models.*.context_window", def: 128000, klass: "model ceiling (actuals)", ratio: null },
];

console.log(`\n§6.2 recalibration table${usingRealGlm ? "" : " (DEMO — fixture ratios, not GLM)"}:`);
console.log(col("knob (default)", 46) + col("class", 18) + col("ratio", 9) + "recommended");
console.log("-".repeat(90));
for (const k of knobs) {
  const ratioStr = k.ratio === null ? "—" : k.ratio.toFixed(3) + "×";
  const rec =
    k.ratio === null
      ? "unchanged"
      : String(Math.round(k.def * k.ratio)) + ` (${k.def} × ${k.ratio.toFixed(2)})`;
  console.log(col(`${k.knob} (${k.def})`, 46) + col(k.klass, 18) + col(ratioStr, 9) + rec);
}
console.log(
  "\nPolicy: scale the summarization/diary/retrieval-output knobs to preserve current",
);
console.log(
  "behaviour; the context-tier knobs are the maintainer's keep-vs-scale choice (keep =",
);
console.log(
  "honest/tighter; scale = preserve today's real window sizes). The embedder-bound and",
);
console.log("provider-actuals rows stay unchanged (§2 non-goals / §6.2).");
