import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Storage, LATEST_SCHEMA_VERSION, type ExaResearchOrigin } from "../src/storage/database.js";
import type { ExaRun } from "../src/exa/types.js";
const origin: ExaResearchOrigin = {
  agent: "agent-a", timelineKey: "matrix:account:room:!room:example.org", sessionId: "origin-session",
  sessionType: "default", requesterId: "matrix:account:user-a", triggerSenderId: "user-a", toolCallId: "create-call", budgetPartitions: ["pool-a", "pool-b", "pool-a"],
  spaceId: "space-a", accountId: "account",
};
const request = { query: "Find sources", effort: "low" as const };
const run = (status: ExaRun["status"] = "completed"): ExaRun => ({ id: "remote-a", status, stopReason: "budget_limit", output: { text: "Partial evidence", grounding: [{ url: "https://example.org" }] }, costDollars: { total: 0.25 } });
const cost = { usd: 0.25, provenance: "reported" as const };
function ledgers(storage: Storage) {
  return storage.read((db) => ({ tools: db.prepare("select * from tool_invocations").all() as any[],
    usage: db.prepare("select * from usage_events").all() as any[], pools: db.prepare("select * from usage_event_partitions").all() as any[] }));
}
test("research intent uniqueness preserves original attribution and request on replay", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const results = await Promise.all([
      storage.createExaResearchIntent({ origin, request }),
      storage.createExaResearchIntent({ origin: { ...origin, requesterId: "replacement" }, request: { ...request, query: "Changed" } }),
    ]);
    assert.deepEqual(results.map((r) => r.created), [true, false]);
    assert.equal(results[0]!.job.id, results[1]!.job.id);
    assert.equal(results[1]!.job.origin.requesterId, "matrix:account:user-a");
    assert.equal(results[1]!.job.request.query, request.query);
    assert.deepEqual(results[0]!.job.origin.budgetPartitions, ["pool-a", "pool-b"]);
    assert.equal(storage.listExaResearchJobs().length, 1);
  } finally { storage.close(); }
});
for (const state of ["completed", "failed", "cancelled"] as const) {
  test(`charged ${state} finalization is atomic and counted once with frozen origin pools`, async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      const { job } = await storage.createExaResearchIntent({ origin, request });
      await storage.updateExaResearchJob(job.id, { remoteId: "remote-a", state: "running" });
      const finalizations = await Promise.all([storage.finalizeExaResearchJob(job.id, run(state), cost), storage.finalizeExaResearchJob(job.id, run(state), cost)]);
      assert.deepEqual(finalizations.map((r) => r.newlyAccounted), [true, false]);
      assert.equal(finalizations[1]!.event, undefined);
      assert.equal(finalizations[0]!.event!.agentSessionId, origin.sessionId);
      assert.equal(finalizations[0]!.event!.triggerSenderId, origin.triggerSenderId);
      assert.equal(storage.sumUsageCost({ since: 0, triggerSenderIds: ["user-a"] }), 0.25);
      assert.equal(storage.sumUsageCost({ since: 0, triggerSenderIds: [origin.requesterId!] }), 0);
      const rows = ledgers(storage);
      assert.equal(rows.tools.length, 1); assert.equal(rows.usage.length, 1); assert.equal(rows.pools.length, 1);
      assert.equal(rows.tools[0].tool_call_id, origin.toolCallId);
      assert.equal(rows.usage[0].agent_session_id, origin.sessionId);
      assert.equal(rows.usage[0].session_type, origin.sessionType);
      assert.equal(rows.usage[0].budget_partition, "pool-a"); assert.equal(rows.pools[0].partition_key, "pool-b");
      assert.equal(rows.pools[0].timeline_key, origin.timelineKey); assert.equal(rows.pools[0].space_id, origin.spaceId);
      assert.equal(rows.tools[0].input_tokens, null); assert.equal(rows.usage[0].input_tokens, null);
      assert.equal(storage.sumUsageCost({ since: 0, partitionKeys: ["pool-a"] }), 0.25);
      assert.equal(storage.sumUsageCost({ since: 0, partitionKeys: ["pool-b"] }), 0.25);
      assert.equal(storage.getSessionToolUsage(origin.sessionId).cost, 0.25);
      const stale = await storage.updateExaResearchJob(job.id, { state: "running", lastError: "late poll" });
      assert.equal(stale.state, state); assert.deepEqual(stale.remote, run(state));
    } finally { storage.close(); }
  });
}
test("research finalization rolls back all mutations if a ledger insert fails", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { job } = await storage.createExaResearchIntent({ origin, request });
    await storage.write((db) => db.exec("create trigger fail_research_usage before insert on usage_events begin select raise(abort, 'injected failure'); end"));
    await assert.rejects(storage.finalizeExaResearchJob(job.id, run(), cost), /injected failure/);
    assert.equal(storage.getExaResearchJob(job.id)!.accounted, false);
    assert.equal(storage.getExaResearchJob(job.id)!.state, "submitting");
    assert.equal(ledgers(storage).tools.length, 0);
    await storage.write((db) => db.exec("drop trigger fail_research_usage"));
    assert.equal((await storage.finalizeExaResearchJob(job.id, run(), cost)).newlyAccounted, true);
  } finally { storage.close(); }
});
test("research terminal/cost/remote invariants reject invalid writes without accounting", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { job } = await storage.createExaResearchIntent({ origin, request });
    await storage.updateExaResearchJob(job.id, { remoteId: "remote-a", state: "queued" });
    await assert.rejects(storage.updateExaResearchJob(job.id, { remoteId: "remote-b" }), /immutable/);
    await assert.rejects(storage.updateExaResearchJob(job.id, { state: "completed" }), /atomic finalization/);
    await assert.rejects(storage.finalizeExaResearchJob(job.id, run("running"), cost), /not terminal/);
    for (const usd of [NaN, Infinity, -1]) await assert.rejects(storage.finalizeExaResearchJob(job.id, run(), { ...cost, usd }), /nonnegative/);
    await assert.rejects(storage.finalizeExaResearchJob(job.id, { ...run(), id: "remote-b" }, cost), /does not match/);
    assert.equal(ledgers(storage).usage.length, 0);
  } finally { storage.close(); }
});
test("unknown provider cost differs from explicit zero in durable provenance", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const first = await storage.createExaResearchIntent({ origin, request });
    const unknown = { ...run(), costDollars: undefined };
    await storage.finalizeExaResearchJob(first.job.id, unknown, { usd: 0.5, provenance: "estimated", estimateVersion: "v1" });
    const second = await storage.createExaResearchIntent({ origin: { ...origin, toolCallId: "second" }, request });
    await storage.finalizeExaResearchJob(second.job.id, { ...run(), id: "remote-b", costDollars: { total: 0 } }, { usd: 0, provenance: "reported" });
    const metadata = ledgers(storage).tools.map((r) => JSON.parse(r.metadata_json));
    assert.equal(metadata[0].reportedCost, null); assert.equal(metadata[0].costProvenance, "estimated");
    assert.equal(metadata[1].reportedCost, 0); assert.equal(metadata[1].costProvenance, "reported");
  } finally { storage.close(); }
});
test("v28 migration and restart preserve research recovery/output and unique accounting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "exa-storage-")), databasePath = path.join(dir, "db.sqlite");
  let storage = await Storage.open({ databasePath });
  try {
    await storage.write((db) => { db.exec("drop table exa_research_jobs"); db.pragma("user_version = 28"); }); storage.close();
    storage = await Storage.open({ databasePath });
    assert.equal(storage.read((db) => db.pragma("user_version", { simple: true })), LATEST_SCHEMA_VERSION);
    const { job } = await storage.createExaResearchIntent({ origin, request });
    await storage.updateExaResearchJob(job.id, { remoteId: "remote-a", state: "running", lastError: "temporary upstream failure" });
    storage.close(); storage = await Storage.open({ databasePath });
    assert.equal(storage.getExaResearchJob(job.id)!.state, "running");
    assert.equal(storage.getExaResearchJob(job.id)!.lastError, "temporary upstream failure");
    await storage.finalizeExaResearchJob(job.id, run(), cost);
    storage.close(); storage = await Storage.open({ databasePath });
    assert.equal((await storage.finalizeExaResearchJob(job.id, run(), cost)).newlyAccounted, false);
    assert.deepEqual(storage.getExaResearchJob(job.id)!.remote!.output!.grounding, run().output!.grounding);
    assert.equal(ledgers(storage).usage.length, 1);
  } finally { storage.close(); await rm(dir, { recursive: true, force: true }); }
});
