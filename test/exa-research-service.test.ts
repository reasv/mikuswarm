import assert from "node:assert/strict";
import test from "node:test";
import { Storage, type ExaResearchOrigin } from "../src/storage/database.js";
import { ExaClient } from "../src/exa/client.js";
import { resolveExaConfig } from "../src/exa/config.js";
import { ExaResearchService } from "../src/exa/research.js";
import { UserLimitEngine } from "../src/budget/user-limits.js";
import { normalizeUserLimits } from "../src/budget/normalize-user-limits.js";
import { createExaResearchTools } from "../src/tools/exa-research.js";
const origin: ExaResearchOrigin = { agent: "a", timelineKey: "matrix:acct:room:!room", sessionId: "session", sessionType: "default", requesterId: "matrix:user", toolCallId: "call", budgetPartitions: ["frozen"], spaceId: null };
const caller = { agent: origin.agent, timeline: origin.timelineKey, requesterId: origin.requesterId };
async function fixture() {
  const storage = await Storage.open({ databasePath: ":memory:" });
  let creates = 0, reads = 0, cancellations = 0, commits = 0;
  const client = new ExaClient(resolveExaConfig({ enabled: true, api_key: "test", requests_per_second: 1000, research: { enabled: true, poll_interval_ms: 10 } }), async (url, options) => {
    let body;
    if (url.endsWith("/cancel")) { cancellations++; body = { id: "remote", status: "cancelled", costDollars: { total: 0.03 } }; }
    else if (options?.method === "POST") { creates++; body = { id: "remote", status: "queued" }; }
    else { reads++; body = { id: "remote", status: "completed", output: { text: "Evidence", grounding: [{ url: "https://example.org" }] }, costDollars: { total: 0.03 } }; }
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const service = new ExaResearchService({ client, storage, onCommitted: () => commits++ });
  return { storage, service, counts: () => ({ creates, reads, cancellations, commits }), close: async () => { await service.stop(); storage.close(); } };
}
test("blocking research collects once and repeated reads retain origin accounting and grounding", async () => {
  const f = await fixture();
  try {
    const job = await f.service.create(origin, { query: "Question", effort: "low" }, caller);
    assert.equal(job.state, "completed"); assert.equal(job.accounted, true);
    assert.deepEqual(job.remote?.output?.grounding, [{ url: "https://example.org" }]);
    assert.equal((await f.service.result(job.id, caller)).id, job.id);
    assert.deepEqual(f.counts(), { creates: 1, reads: 1, cancellations: 0, commits: 1 });
    assert.equal(f.storage.getSessionToolUsage(origin.sessionId).cost, 0.03);
    assert.equal(f.storage.sumUsageCost({ since: 0, partitionKeys: ["frozen"] }), 0.03);
  } finally { await f.close(); }
});
test("startup reconciles purchased known runs without session notifications and preserves unknown submissions", async () => {
  const f = await fixture();
  try {
    const { job } = await f.storage.createExaResearchIntent({ origin, request: { query: "Question", effort: "low" } });
    await f.storage.updateExaResearchJob(job.id, { remoteId: "remote", state: "running" });
    const unknown = await f.storage.createExaResearchIntent({ origin: { ...origin, toolCallId: "unknown" }, request: { query: "Other", effort: "low" } });
    await f.service.start();
    assert.equal((await f.service.result(job.id, caller)).accounted, true);
    assert.equal(f.storage.getExaResearchJob(unknown.job.id)?.state, "submission_unknown");
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().commits, 1);
  } finally { await f.close(); }
});
test("job visibility protects reads/list/cancel and cancellation requires origin requester", async () => {
  const f = await fixture();
  try {
    const { job } = await f.storage.createExaResearchIntent({ origin, request: { query: "Secret", effort: "low" } });
    await f.storage.updateExaResearchJob(job.id, { remoteId: "remote", state: "running" });
    const foreign = { ...caller, agent: "other" };
    assert.equal(f.service.list(foreign).jobs.length, 0);
    await assert.rejects(f.service.result(job.id, foreign), /outside/);
    await assert.rejects(f.service.cancel(job.id, foreign), /outside/);
    await assert.rejects(f.service.cancel(job.id, { ...caller, requesterId: "matrix:other" }), /requester/);
    assert.equal((await f.service.cancel(job.id, caller)).state, "cancelled");
    assert.equal(f.counts().commits, 1);
  } finally { await f.close(); }
});
test("research child gate removes new paid work but keeps recovery tools", async () => {
  const f = await fixture();
  try {
    f.service.client.config.research.enabled = false;
    assert.deepEqual(createExaResearchTools({ service: f.service, caller, makeOrigin: () => origin }).map(t => t.name), ["exa_research_result", "exa_research_list", "exa_research_cancel"]);
  } finally { await f.close(); }
});


test("durable research refreshes live and ended-origin user meters using raw billing identity", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const raw = "@requester:example.org";
  const rules = normalizeUserLimits([{ user: "*", limits: [{ max_usd: 1, window: { type: "calendar", period: "day", tz: "UTC" } }, { max_usd: 1, window: { type: "calendar", period: "day", tz: "UTC" }, partition: "frozen" }] }], { defaultTz: "UTC", knownModelIds: new Set() }).rules;
  const logger: any = { info() {}, warn() {}, error() {}, debug() {} };
  const engine = new UserLimitEngine({ rules, sumUsageCost: filter => storage.sumUsageCost(filter), minUsageTs: () => null, costRatesFor: () => undefined, maxTokensFor: () => 1000, zeroCostModelIds: new Set(), viableMinOutputTokens: 1, isUserIdentity: id => id.startsWith("@"), logger });
  const resolution = engine.resolve({ userId: raw });
  const client = new ExaClient(resolveExaConfig({ enabled: true, api_key: "test", research: { enabled: true } }), async () => new Response(JSON.stringify({ id: "completed", status: "completed", costDollars: { total: 0.25 } })));
  const service = new ExaResearchService({ client, storage, onCommitted: () => engine.reconcileCommittedUsage() });
  try {
    const billingOrigin = { ...origin, requesterId: `matrix:${raw}`, triggerSenderId: raw };
    const billingCaller = { ...caller, requesterId: billingOrigin.requesterId };
    const job = await service.create(billingOrigin, { query: "Question", effort: "low" }, billingCaller);
    assert.equal(engine.totalHeadroom(resolution), 0.75);
    await service.result(job.id, billingCaller);
    assert.equal(engine.totalHeadroom(resolution), 0.75);
    assert.equal(engine.totalHeadroom(engine.resolve({ userId: raw })), 0.75);
    assert.equal(storage.sumUsageCost({ since: 0, triggerSenderId: raw }), 0.25);
    assert.equal(storage.sumUsageCost({ since: 0, partitionKeys: ["frozen"] }), 0.25);
    assert.equal(engine.totalHeadroom(engine.resolve({ userId: "@another:example.org" })), 0.75, "frozen shared pool is refreshed even after origin ends");
  } finally { await service.stop(); storage.close(); }
});
