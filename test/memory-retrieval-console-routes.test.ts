/** Console routes of judged memory retrieval (ARCHITECTURE.md §9d "Observability"). */
import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryRetrievalStore } from "../src/storage/memory-retrieval-store.js";
import { memoryFilterHits, memoryStats, sessionMemoryRetrievals } from "../src/observability/server/memory-handlers.js";

function fakeRes() {
  const out: { status?: number; body?: any } = {};
  const res: any = {
    writeHead: (status: number) => (out.status = status),
    end: (json: string) => (out.body = JSON.parse(json)),
  };
  return { res, out };
}

test("memory routes: session builds, filter hits, follow-up stats and source mix", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const store = new MemoryRetrievalStore(storage);
    const now = Date.now();
    await store.insertRetrieval({ id: "r1", agentSessionId: "s1", agent: null, timelineKey: "t", ts: now, source: "model", decisionGroup: "g", candidates: 10, judged: 4, kept: 2, hidden: 1, tokens: 300, ms: 900, reportJson: "{}" });
    await store.insertRetrieval({ id: "r2", agentSessionId: "s2", agent: null, timelineKey: "t", ts: now, source: "fallback", decisionGroup: null, candidates: 5, judged: 0, kept: 1, hidden: 0, tokens: 100, ms: 50, reportJson: "{}" });
    await store.insertRetrieval({ id: "r3", agentSessionId: "s3", agent: null, timelineKey: "t", ts: now, source: "model", decisionGroup: "g3", candidates: 5, judged: 2, kept: 2, hidden: 0, tokens: 100, ms: 50, reportJson: JSON.stringify({ fellBack: 1 }) });
    await store.insertRetrieval({ id: "r4", agentSessionId: "s4", agent: null, timelineKey: "t", ts: now, source: "model", decisionGroup: "g4", candidates: 5, judged: 2, kept: 0, hidden: 0, tokens: 0, ms: 50, reportJson: "{not json" });
    await store.markFollowUp("s1", "recall_memory", now);
    await store.recordFilterHits([{ agent: null, contentHash: "h", filterKey: "k", filterHash: "x", kind: "keyword", detail: "nick", probability: null, path: "memory/a.md", startLine: 1, endLine: 2, surface: "auto_retrieval", at: now }]);
    const ctx = (params: Record<string, string> = {}, q = "") => ({ params, url: new URL(`http://x/${q}`), deps: { storage } as any });
    const a = fakeRes();
    sessionMemoryRetrievals({} as any, a.res, ctx({ id: "s1" }));
    assert.equal(a.out.body.retrievals.length, 1);
    assert.equal(a.out.body.retrievals[0].followUpKind, "recall_memory");
    const b = fakeRes();
    memoryFilterHits({} as any, b.res, ctx({}, "?limit=10"));
    assert.equal(b.out.body.hits[0].filterKey, "k");
    const c = fakeRes();
    memoryStats({} as any, c.res, ctx());
    const week = c.out.body.windows.find((w: any) => w.days === 7);
    assert.deepEqual([week.sessionsWithBlock, week.followedUp, week.builds], [3, 1, 4]);
    // A model build that showed fallback-selected items is its own share of the mix.
    assert.deepEqual(week.sources, { fallback: 1, model: 2, model_fallback: 1 });
  } finally {
    storage.close();
  }
});
