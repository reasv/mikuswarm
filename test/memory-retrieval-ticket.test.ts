/**
 * The launch-time plan ticket (ARCHITECTURE.md §9d "Judged retrieval"): a
 * plan's row is written once, as shown when its kickoff was sent (confirm) or
 * as aborted when the build was discarded first (abandon); the best effort
 * cuts the plan short within a grace. Synthetic plans only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createPlanTicket } from "../src/retrieval/auto/ticket.js";
import type { RetrievalPlan, RetrievalReport } from "../src/retrieval/auto/types.js";

const plan = (): RetrievalPlan => ({
  block: "<retrieved_memory>…</retrieved_memory>",
  report: {
    source: "model", candidates: 2, judged: 2, kept: 1, hidden: 0, tokens: 40, ms: 5, stages: { recallMs: 1 },
    items: [
      { contentHash: "a", citation: "memory/a.md:1-2", lanes: ["trigger"], hybrid: 0.9, presence: false, stage: "kept", judged: true, selectedBy: "judge" },
      { contentHash: "b", citation: "memory/b.md:1-2", lanes: ["trigger"], hybrid: 0.5, presence: false, stage: "dropped", judged: true },
    ],
  },
});

function fixture(p: Promise<RetrievalPlan | null> = Promise.resolve(plan()), graceMs?: number) {
  const rows: RetrievalReport[] = [];
  const abort = new AbortController();
  const finishNow = new AbortController();
  const ticket = createPlanTicket({ plan: p, waitMs: 100, abort, finishNow, record: (r) => rows.push(r), ...(graceMs !== undefined ? { graceMs } : {}) });
  return { ticket, rows, abort, finishNow };
}

const flush = () => new Promise((r) => setImmediate(r));

test("ticket: confirm records the build as shown, once; a later abandon only stops the plan", async () => {
  const f = fixture();
  f.ticket.confirm();
  f.ticket.confirm();
  f.ticket.abandon();
  await flush();
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0]!.kept, 1);
  assert.equal(f.rows[0]!.aborted, undefined);
  assert.equal(f.abort.signal.aborted, true, "session end stops an outstanding plan");
});

test("ticket: a build cancelled or redone after its plan resolved records it as aborted, never shown", async () => {
  const f = fixture();
  await f.ticket.plan;
  f.ticket.abandon();
  f.ticket.confirm();
  await flush();
  assert.equal(f.rows.length, 1);
  const row = f.rows[0]!;
  assert.equal(row.aborted, true);
  assert.equal(row.kept, 0);
  assert.equal(row.tokens, 0);
  assert.deepEqual(row.items.map((i) => i.stage), ["aborted", "dropped"]);
  assert.ok(row.items.every((i) => i.selectedBy === undefined));
});

test("ticket: a failed plan records nothing", async () => {
  const f = fixture(Promise.resolve(null));
  f.ticket.abandon();
  await flush();
  assert.equal(f.rows.length, 0);
});

test("ticket: best effort tells the plan to finish now and waits a short grace", async () => {
  let resolve!: (p: RetrievalPlan) => void;
  const f = fixture(new Promise<RetrievalPlan>((r) => (resolve = r)), 200);
  f.finishNow.signal.addEventListener("abort", () => resolve(plan()));
  const got = await f.ticket.bestEffort();
  assert.equal(f.finishNow.signal.aborted, true);
  assert.equal(got?.report.kept, 1);
  const hung = fixture(new Promise(() => {}), 20);
  const started = Date.now();
  assert.equal(await hung.ticket.bestEffort(), null, "nothing ready within the grace");
  assert.ok(Date.now() - started < 1000);
});
