/**
 * Recompute historical `usage_events` cost for the auxiliary lanes (class IN
 * ('tool','caption')) from the CURRENT config rates, using the same
 * `computeUsageCost` the live code uses. Agent-loop rows are left alone (they
 * were already priced with the configured model rates at record time).
 *
 * `cost_usd` is computed once, when an event is recorded — so rows that were
 * recorded before their rate block was configured carry a stale $0. This pass
 * re-derives cost from the stored token counts and the now-known rates. It is
 * idempotent (recompute-from-tokens), so it can be re-run after any rate change.
 *
 * Each row is mapped to its rate block exactly as the live tools do:
 *   - class='caption'                          → [captioning.model.cost]
 *   - class='tool' image_generate (pro/flash)  → [image_gen.costs.{pro,flash}]
 *   - class='tool' x_search grok model         → [x_search.cost]
 *   - class='tool' x_search caption model       → [captioning.model.cost]  (inline captions)
 *
 * Usage:
 *   npx tsx scripts/reprice-aux-usage.ts [db-path] [--apply]
 *     db-path  defaults to ./var/mikuswarm.db
 *     --apply  write the changes (omit for a dry-run that only reports)
 *
 * SAFETY: run with the agent container STOPPED — this opens the SQLite DB
 * read-write outside the app's single-writer queue. The script first opens the
 * DB through Storage to apply any pending schema migrations (notably v28, which
 * REBUILDS the caption ledger rows) BEFORE repricing — otherwise a later v28 run
 * would delete the repriced caption rows and reinsert them at $0.
 */
import Database from "better-sqlite3";
import { loadConfig } from "../src/config/index.js";
import { Storage, LATEST_SCHEMA_VERSION } from "../src/storage/index.js";
import { computeUsageCost, type CostRates } from "../src/agent/usage.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbPath = args.find((a) => !a.startsWith("--")) ?? "./var/mikuswarm.db";

const config = await loadConfig("./config");

// Apply pending migrations (incl. v28's caption-row rebuild) BEFORE repricing, so
// repricing operates on the final row set and can't be clobbered by a later
// migration — but ONLY when the DB is behind. When it is already current (the
// app has migrated it), skip opening a competing Storage writer; the direct
// UPDATE below uses a busy-timeout, so it is safe against a live DB.
{
  const probe = new Database(dbPath, { readonly: true });
  const version = probe.pragma("user_version", { simple: true }) as number;
  probe.close();
  if (version < LATEST_SCHEMA_VERSION) {
    const migrated = await Storage.open({ databasePath: dbPath });
    await migrated.waitForIdle();
    migrated.close();
  }
}

const cap = config.captioning?.model?.cost;
const captionRates: CostRates | null = cap
  ? { input: cap.input, output: cap.output, cacheRead: cap.cache_read, cacheWrite: cap.cache_write }
  : null;
const xc = config.x_search?.cost;
const xSearchRates: CostRates | null = xc
  ? { input: xc.input, output: xc.output, cacheRead: 0, cacheWrite: 0 }
  : null;
const imgRates = (blk?: { input: number; output: number; cache_read: number; cache_write: number; per_image?: number }): CostRates | null =>
  blk
    ? {
        input: blk.input,
        output: blk.output,
        cacheRead: blk.cache_read,
        cacheWrite: blk.cache_write,
        ...(blk.per_image != null ? { perImage: blk.per_image } : {}),
      }
    : null;

const proId = config.image_gen?.models?.pro;
const flashId = config.image_gen?.models?.flash;
const grokIds = new Set([config.x_search?.model, config.x_search?.deep_model].filter(Boolean));

interface Row {
  id: string;
  class: string;
  tool_name: string | null;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  images: number | null;
  cost_usd: number;
}

function ratesFor(r: Row): CostRates | null {
  if (r.class === "caption") return captionRates;
  if (r.class === "tool") {
    if (r.tool_name === "image_generate") {
      if (r.model_id === proId) return imgRates(config.image_gen?.costs?.pro);
      if (r.model_id === flashId) return imgRates(config.image_gen?.costs?.flash);
      return null;
    }
    if (r.tool_name === "x_search") {
      if (grokIds.has(r.model_id)) return xSearchRates;
      return captionRates; // inline image captions run through the shared caption client
    }
  }
  return null;
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const rows = db
  .prepare(
    `select id, class, tool_name, model_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, images, cost_usd
       from usage_events where class in ('tool','caption')`,
  )
  .all() as Row[];

const upd = db.prepare(`update usage_events set cost_usd = ? where id = ?`);
const groups = new Map<string, { n: number; oldSum: number; newSum: number; changed: number }>();
let skipped = 0;
let changed = 0;

const run = db.transaction(() => {
  for (const r of rows) {
    const rates = ratesFor(r);
    if (!rates) {
      skipped++;
      continue;
    }
    const cost = computeUsageCost(rates, {
      input: r.input_tokens ?? 0,
      output: r.output_tokens ?? 0,
      cacheRead: r.cache_read_tokens ?? 0,
      cacheWrite: r.cache_write_tokens ?? 0,
      images: r.images ?? 0,
    }).total;
    const key = `${r.class}/${r.tool_name ?? "-"}/${r.model_id}`;
    const g = groups.get(key) ?? { n: 0, oldSum: 0, newSum: 0, changed: 0 };
    g.n++;
    g.oldSum += r.cost_usd ?? 0;
    g.newSum += cost;
    const diff = Math.abs(cost - (r.cost_usd ?? 0)) > 1e-9;
    if (diff) {
      g.changed++;
      changed++;
      if (apply) upd.run(cost, r.id);
    }
    groups.set(key, g);
  }
});
run();
db.close();

console.log(`\n${apply ? "APPLIED" : "DRY-RUN (no writes; pass --apply to write)"} — db: ${dbPath}\n`);
console.log("class/tool/model".padEnd(54), "rows".padStart(5), "old $".padStart(10), "new $".padStart(10), "chg".padStart(5));
let oldTotal = 0;
let newTotal = 0;
for (const [key, g] of [...groups.entries()].sort()) {
  oldTotal += g.oldSum;
  newTotal += g.newSum;
  console.log(key.padEnd(54), String(g.n).padStart(5), g.oldSum.toFixed(4).padStart(10), g.newSum.toFixed(4).padStart(10), String(g.changed).padStart(5));
}
console.log("".padEnd(54, "-"));
console.log("TOTAL".padEnd(54), String(rows.length).padStart(5), oldTotal.toFixed(4).padStart(10), newTotal.toFixed(4).padStart(10), String(changed).padStart(5));
console.log(`\nrows changed: ${changed} · skipped (unmapped model): ${skipped}`);
if (!apply && changed > 0) console.log("re-run with --apply to write these costs.");
