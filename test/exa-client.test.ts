import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ExaClient, type ExaTransport } from "../src/exa/client.js";
import { resolveExaConfig } from "../src/exa/config.js";
import { ExaError } from "../src/exa/errors.js";
import { guardedFetch, setEgressGuardEnabled } from "../src/tools/ssrf.js";
const cfg = () => resolveExaConfig({ enabled: true, api_key: "test-private-key", requests_per_second: 100, research: { enabled: true } });
const search = { query: "test", contents: { highlights: { maxCharacters: 1500 } } };
const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers });
test("typed routes, bearer and redirect rejection; disabled config has no requests", async () => {
  const calls: Array<{ url: string; options: any }> = [];
  const transport: ExaTransport = async (url, options) => { calls.push({ url, options }); return json(url.includes("agent") ? { id: "agent_run_1", status: "queued" } : { results: [] }); };
  const client = new ExaClient(cfg(), transport);
  await client.search(search); await client.contents({ urls: ["https://example.com"], text: { maxCharacters: 50000 } }); await client.createRun({ query: "research", effort: "low" }); await client.getRun("agent_run_1"); await client.cancelRun("agent_run_1");
  assert.deepEqual(calls.map((c) => c.url), ["https://api.exa.ai/search", "https://api.exa.ai/contents", "https://api.exa.ai/agent/runs", "https://api.exa.ai/agent/runs/agent_run_1", "https://api.exa.ai/agent/runs/agent_run_1/cancel"]);
  for (const c of calls) { assert.equal(c.options.rejectRedirects, true); assert.equal(c.options.headers.Authorization, "Bearer test-private-key"); }
  const disabled = new ExaClient(resolveExaConfig(undefined), transport); await assert.rejects(disabled.search(search), /disabled/); assert.equal(calls.length, 5);
  assert.throws(() => client.getRun("../search"), /identifier/);
});
test("HTTP taxonomy, shared cooldown, malformed response and safe errors", async () => {
  let calls = 0; const client = new ExaClient(cfg(), async () => { calls++; return json({ error: "test-private-key", requestId: "req1" }, 429, { "retry-after": "9999999" }); });
  await assert.rejects(client.search(search), (e: ExaError) => e.code === "rate_limited" && !e.message.includes("test-private-key") && e.requestId === "req1" && e.retryAt! <= Date.now() + 300000);
  await assert.rejects(client.contents({ urls: ["https://example.com"] }), (e: ExaError) => e.code === "exa_unavailable"); assert.equal(calls, 1);
  const malformed = new ExaClient(cfg(), async () => json({ results: [{ url: 3 }] })); await assert.rejects(malformed.search(search), (e: ExaError) => e.code === "invalid_response");
});
test("create failures mark uncertain acceptance; no retries; abort during transport remains neutral", async () => {
  let calls = 0; const client = new ExaClient(cfg(), async () => { calls++; throw new Error("private detail"); });
  await assert.rejects(client.createRun({ query: "q", effort: "low" }), (e: ExaError) => e.submissionUncertain && e.code === "transport_failed"); assert.equal(calls, 1);
  const controller = new AbortController(); const waiting = new ExaClient(cfg(), async (_url, opts) => { await delay(10000, undefined, { signal: opts.signal }); return json({ results: [] }); });
  const promise = waiting.search(search, controller.signal); await delay(5); controller.abort(); await assert.rejects(promise, (e: ExaError) => e.code === "aborted"); assert.equal(waiting.health.available("search"), true);
});
test("queued abort does not call upstream or leak admission; timeout bounds response body", async () => {
  let calls = 0; let release!: () => void;
  const config = cfg(); config.max_in_flight = 1;
  const client = new ExaClient(config, async () => { calls++; if (calls === 1) await new Promise<void>((r) => release = r); return json({ results: [] }); });
  const first = client.search(search); await delay(5);
  const abort = new AbortController(); const queued = client.search(search, abort.signal); abort.abort(); await assert.rejects(queued, (e: ExaError) => e.code === "aborted");
  release(); await first; await client.search(search); assert.equal(calls, 2);
  config.request_timeout_ms = 10;
  const stalled = new ExaClient(config, async (_url, opts) => new Response(new ReadableStream({})));
  await assert.rejects(stalled.search(search), (e: ExaError) => e.code === "timeout");
});
test("guarded transport rejects redirects whether address guard is enabled or disabled", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, opts) => { calls++; assert.equal(opts?.redirect, "manual"); return new Response("redirect", { status: 307, headers: { location: "https://attacker.example" } }); };
  try { for (const enabled of [false, true]) { setEgressGuardEnabled(enabled); await assert.rejects(guardedFetch("https://1.1.1.1/path", { rejectRedirects: true, headers: { Authorization: "Bearer secret" } }), /redirects are forbidden/); } assert.equal(calls, 2); }
  finally { globalThis.fetch = original; setEgressGuardEnabled(true); }
});

test("invalid arguments make no requests", () => {
  let calls = 0; const client = new ExaClient(cfg(), async () => { calls++; return json({ results: [] }); });
  assert.throws(() => client.search({ query: " " }), /nonblank/);
  assert.throws(() => client.contents({ urls: ["file:\/\/etc\/passwd"] }), /HTTP URLs/);
  assert.throws(() => client.createRun({ query: "q", effort: "high" }), /effort/);
  assert.equal(calls, 0);
});
