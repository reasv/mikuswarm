import assert from "node:assert/strict";
import test from "node:test";
import { Storage, type ExaResearchOrigin } from "../src/storage/database.js";
import { ExaResearchService } from "../src/exa/research.js";
import { ExaClient } from "../src/exa/client.js";
import { resolveExaConfig } from "../src/exa/config.js";
import type { ExaRun } from "../src/exa/types.js";
const origin: ExaResearchOrigin = { agent: "agent", timelineKey: "matrix:a:room:!r", sessionId: "session", sessionType: "default", requesterId: "user", toolCallId: "call", budgetPartitions: [], spaceId: null };
const caller = { agent: "agent", timeline: origin.timelineKey, requesterId: "user" };
const request = { query: "Evidence", effort: "low" as const };
const terminal: ExaRun = { id: "remote", status: "completed", output: { text: "Evidence" }, costDollars: { total: 0.025 } };
function bound(storage: Storage) {
  return { createExaResearchIntent: storage.createExaResearchIntent.bind(storage), getExaResearchJob: storage.getExaResearchJob.bind(storage), listExaResearchJobs: storage.listExaResearchJobs.bind(storage), updateExaResearchJob: storage.updateExaResearchJob.bind(storage), finalizeExaResearchJob: storage.finalizeExaResearchJob.bind(storage) };
}
function client(maxInFlight = 2, response: () => Promise<ExaRun> = async () => terminal) {
  let creates = 0, gets = 0;
  const config = resolveExaConfig({ enabled: true, api_key: "test-key", requests_per_second: 1000, research: { enabled: true, max_in_flight: maxInFlight, poll_interval_ms: 10, wait_timeout_ms: 1000 } });
  const api = new ExaClient(config, async (_url, opts) => { const run = opts.method === "POST" ? (creates++, await response()) : (gets++, terminal); return new Response(JSON.stringify(run)); });
  return { api, creates: () => creates, gets: () => gets };
}
for (const cap of [1, 2]) {
  test(`concurrent same invocation joins the terminal result before cap ${cap}`, async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    let resolve!: (run: ExaRun) => void; const transport = client(cap, () => new Promise((r) => { resolve = r; }));
    const service = new ExaResearchService({ client: transport.api, storage });
    try {
      const first = service.create(origin, request, caller), second = service.create(origin, request, caller);
      await new Promise((r) => setTimeout(r, 5)); resolve(terminal);
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map((j) => j.state), ["completed", "completed"]);
      assert.equal(results[0]!.id, results[1]!.id); assert.equal(transport.creates(), 1);
    } finally { await service.stop(); storage.close(); }
  });
}
test("one invocation waiter abort does not cancel another waiter's submission", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  let resolve!: (run: ExaRun) => void; const transport = client(1, () => new Promise((r) => { resolve = r; }));
  const service = new ExaResearchService({ client: transport.api, storage });
  try {
    const abort = new AbortController(); const first = service.create(origin, request, caller, abort.signal);
    const rejected = assert.rejects(first, /aborted.*preserved.*exa_research_result/);
    const second = service.create(origin, request, caller);
    await new Promise((r) => setTimeout(r, 5)); abort.abort(); await rejected;
    resolve(terminal); assert.equal((await second).state, "completed"); assert.equal(transport.creates(), 1);
  } finally { await service.stop(); storage.close(); }
});
test("immediately completed accepted run survives accounting failure and restart collection", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" }); const transport = client();
  const failing = bound(storage); failing.finalizeExaResearchJob = async () => { throw new Error("ledger unavailable"); };
  const service = new ExaResearchService({ client: transport.api, storage: failing });
  try {
    await assert.rejects(service.create(origin, request, caller), /accepted.*recovery.*exa_research_result/);
    const saved = storage.listExaResearchJobs()[0]!;
    assert.equal(saved.remoteId, "remote"); assert.notEqual(saved.state, "failed"); assert.equal(saved.accounted, false);
    await service.stop();
    const recovery = new ExaResearchService({ client: transport.api, storage });
    try {
      await recovery.start();
      assert.equal((await recovery.result(saved.id, caller)).state, "completed");
      assert.equal(transport.creates(), 1); assert.equal(storage.getSessionToolUsage(origin.sessionId).cost, 0.025);
    } finally { await recovery.stop(); }
  } finally { await service.stop(); storage.close(); }
});
test("nonterminal post-submit persistence error preserves remote identity and avoids failed classification", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" }); const transport = client(2, async () => ({ id: "remote", status: "running" }));
  const flaky = bound(storage); let updates = 0;
  flaky.updateExaResearchJob = async (id, patch) => {
    updates++;
    if (updates === 2) throw new Error("post-submit snapshot write failed");
    return storage.updateExaResearchJob(id, patch);
  };
  const service = new ExaResearchService({ client: transport.api, storage: flaky });
  try {
    await assert.rejects(service.create(origin, request, caller), /accepted.*recovery/);
    const saved = storage.listExaResearchJobs()[0]!; assert.equal(saved.remoteId, "remote"); assert.notEqual(saved.state, "failed");
    assert.equal((await service.result(saved.id, caller)).state, "completed"); assert.equal(transport.creates(), 1);
  } finally { await service.stop(); storage.close(); }
});
test("replay recovery bypasses new-spend budget while new intent is blocked", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" }); const transport = client();
  const service = new ExaResearchService({ client: transport.api, storage });
  try {
    const { job } = await storage.createExaResearchIntent({ origin, request });
    await storage.updateExaResearchJob(job.id, { remoteId: "remote", state: "running" });
    let checked = 0; const blocked = () => { checked++; return "Exhausted budget"; };
    const recovered = await service.create(origin, request, caller, undefined, undefined, blocked);
    assert.equal(recovered.state, "completed"); assert.equal(checked, 0); assert.equal(transport.creates(), 0);
    await assert.rejects(service.create({ ...origin, toolCallId: "new-call" }, request, caller, undefined, undefined, blocked), /Exhausted budget/);
    assert.equal(checked, 1); assert.equal(storage.listExaResearchJobs().length, 1); assert.equal(transport.creates(), 0);
  } finally { await service.stop(); storage.close(); }
});
test("accepted remote identity attachment retries without another paid submission", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" }); const transport = client();
  const flaky = bound(storage); let updates = 0;
  flaky.updateExaResearchJob = async (id, patch) => {
    if (++updates === 1) throw new Error("identity write temporarily unavailable");
    return storage.updateExaResearchJob(id, patch);
  };
  const service = new ExaResearchService({ client: transport.api, storage: flaky });
  try {
    await assert.rejects(service.create(origin, request, caller), /accepted.*recovery/);
    const job = storage.listExaResearchJobs()[0]!;
    const recovered = await service.result(job.id, caller);
    assert.equal(recovered.remoteId, "remote"); assert.equal(recovered.state, "completed");
    assert.equal(transport.creates(), 1); assert.equal(transport.gets(), 0);
  } finally { await service.stop(); storage.close(); }
});
