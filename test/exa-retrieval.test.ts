import assert from "node:assert/strict";
import test from "node:test";
import { ExaClient } from "../src/exa/client.js";
import { resolveExaConfig } from "../src/exa/config.js";
import { ExaContentStore } from "../src/exa/content-store.js";
import { createExaRetrievalTools, validateExaOutputSchema } from "../src/tools/exa.js";
import { ChannelVisibilityResolver } from "../src/visibility/index.js";
import { exaRetrievalCost } from "../src/exa/accounting.js";
import { selectExaMcpServers, selectExaRetrievalCatalog, SHIPPED_EXA_MCP_URL } from "../src/exa/selection.js";
import { filterTools } from "../src/agent/factory.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
const owner = { agent: "agent-a", timeline: "matrix:account:room:!a" };
function fixture(response: unknown, overrides: any = {}, storeBytes = 100000) {
  const config = resolveExaConfig({ enabled: true, api_key: "private-key", requests_per_second: 100, ...overrides });
  const calls: any[] = [], records: any[] = [];
  const client = new ExaClient(config, async (url, options) => { calls.push({ url, body: JSON.parse(String(options.body)) }); return new Response(JSON.stringify(response)); });
  const store = new ExaContentStore(storeBytes, 1000);
  const tools = createExaRetrievalTools({ client, store, owner, sessionId: "s1", recordUsage: (record) => records.push(record) });
  const run = (name: string, args: any) => tools.find((tool) => tool.name === name)!.execute("call1", args);
  return { client, store, tools, calls, records, run };
}
test("basic highlighted search intentional budgets and authoritative cost", async () => {
  const f = fixture({ results: [{ url: "https://example.com", title: "Evidence", highlights: ["facts"] }], requestId: "r1", costDollars: { total: 0.007 } });
  const result = await f.run("exa_search", { query: "find facts" });
  assert.deepEqual(f.calls[0].body, { query: "find facts", type: "auto", numResults: 10, contents: { highlights: { maxCharacters: 1500 } } });
  assert.match((result.content[0] as any).text, /Evidence/); assert.equal(f.records[0].modelId, "exa/search"); assert.equal(f.records[0].metadata.costProvenance, "reported"); assert.equal(f.records[0].usage, undefined);
});
test("advanced constraints and nested schemas fail before spending; freshness is nested", async () => {
  const f = fixture({ results: [], output: { content: { verified: true }, grounding: [{ field: "verified", citations: [{ url: "https://example.com" }] }] } });
  for (const schema of [{ type: "object", properties: { bad: { $ref: "https://example.com/schema" } } }, { type: "object", properties: { rows: { type: "array", items: { type: "string" } } } }]) await assert.rejects(f.run("exa_search_advanced", { query: "q", output_schema: schema }));
  await assert.rejects(f.run("exa_search_advanced", { query: "q", category: "people", exclude_domains: ["example.com"] })); assert.equal(f.calls.length, 0);
  await f.run("exa_search_advanced", { query: "q", max_age_hours: 0, country: "us", start_published_date: "2026-01-01", output_schema: { type: "object", properties: { verified: { type: "boolean" } } } });
  assert.equal(f.calls[0].body.contents.maxAgeHours, 0); assert.equal(f.calls[0].body.userLocation, "US"); assert.equal(f.calls[0].body.startPublishedDate, "2026-01-01");
});
test("batch extraction reports every URL and free visible pagination", async () => {
  const f = fixture({ results: [{ url: "https://example.com/", text: "0123456789abcdefghijklmn" }], statuses: [{ id: "https://example.com/", status: "success" }, { id: "https://bad.example/", status: "error", error: "not found" }] });
  const result = await f.run("exa_fetch", { urls: ["https://example.com", "https://bad.example"], max_chars: 10 });
  const outcomes = (result.details as any).outcomes; assert.equal(outcomes.length, 2); assert.equal(outcomes[1].status, "error"); assert.equal(outcomes[0].displayTruncated, true);
  const more = await f.run("exa_fetch", { content_id: outcomes[0].contentId, offset: 10, max_chars: 10 }); assert.match((more.content[0] as any).text, /abcdefghij/);
  assert.equal(f.calls.length, 1); assert.equal(f.records.length, 1);
  assert.equal(f.calls[0].body.contents, undefined); assert.deepEqual(f.calls[0].body.text, { maxCharacters: 50000 });
});
test("cache refusal does not emit undefined handles; advanced text has readable continuation", async () => {
  const f = fixture({ results: [{ url: "https://example.com/", text: "0123456789abcdefghijklmn" }] }, {}, 1);
  const result = await f.run("exa_fetch", { urls: ["https://example.com"], max_chars: 5 }); assert.doesNotMatch((result.content[0] as any).text, /content_id: "undefined"/); assert.match((result.content[0] as any).text, /refetch/);
  const advanced = fixture({ results: [{ url: "https://example.com/", text: "x".repeat(9000) }] });
  const answer = await advanced.run("exa_search_advanced", { query: "q", content_mode: "text" }); assert.match((answer.content[0] as any).text, /content_id: "exa_content_/);
});
test("content store TTL, bounded metadata and agent/isolated timeline restrictions", () => {
  let now = 0; const store = new ExaContentStore(1000, 100, () => now); const visibility = new ChannelVisibilityResolver({ channels: [{ timeline_key: owner.timeline, mode: "isolated" }] });
  const id = store.put({ owner, url: "https://example.com", text: "abc", extractionTruncated: false })!;
  assert.throws(() => store.get(id, { ...owner, agent: "other" }, visibility)); assert.throws(() => store.get(id, { ...owner, timeline: "matrix:account:room:!b" }, visibility));
  assert.equal(store.get(id, { ...owner, timeline: `${owner.timeline}:thread:child` }, visibility).text, "abc");
  assert.equal(store.put({ owner, url: "x".repeat(2000), text: "", extractionTruncated: false }), undefined);
  now = 100; assert.throws(() => store.get(id, owner), /expired/);
});
const tool = (name: string) => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [] }) } as AgentTool);
test("provider selection obeys exact server and session catalog; old tools remain deferred", () => {
  const config = resolveExaConfig({ enabled: true, api_key: "key" }); const f = fixture({ results: [] });
  const servers = { exa: { url: SHIPPED_EXA_MCP_URL }, custom: { url: "https://mcp.exa.ai/custom" }, off: { url: "https://example.com", enabled: false } };
  assert.deepEqual(Object.keys(selectExaMcpServers(servers, config)), ["custom"]);
  const catalog = [tool("exa_search"), tool("exa_fetch"), tool("web_search"), tool("web_fetch")];
  const selected = selectExaRetrievalCatalog(catalog, config, f.client.health, ["exa_fetch"]); assert.deepEqual(filterTools(selected, { tools: ["exa_fetch"] }).map((t) => t.name), ["exa_fetch"]);
  const admission = f.client.health.enter("search"); admission.failure(new ExaError("auth_failed", "auth", "search")); admission.finish();
  const unavailable = selectExaRetrievalCatalog(catalog, config, f.client.health); assert.equal((unavailable.find((t) => t.name === "web_search") as any).initialLoading, "immediate");
  assert.equal((unavailable.find((t) => t.name === "exa_search") as any).initialLoading, "deferred");
  const restricted = selectExaRetrievalCatalog(catalog.filter((t) => t.name !== "web_search"), config, f.client.health); assert.doesNotMatch((restricted.find((t) => t.name === "exa_search") as any).availabilityNotice, /web_search/);
});
import { ExaError } from "../src/exa/errors.js";
test("pricing estimates identify current instant and extra-result charges", () => {
  assert.equal(exaRetrievalCost(undefined, "search", 20, "instant").dollars, 0.014);
  assert.equal(exaRetrievalCost(undefined, "contents", 3).dollars, 0.003);
  assert.equal(exaRetrievalCost({ total: 0 }, "search", 20).provenance, "reported");
});

test("background fallback is explicit, labelled and cannot drop freshness requirements", async () => {
  let fallbackCalls = 0; const config = resolveExaConfig({ enabled: true, api_key: "key", requests_per_second: 100 });
  const client = new ExaClient(config, async () => new Response("{}", { status: 503 }));
  const fallback = tool("web_fetch"); fallback.execute = async () => { fallbackCalls++; return { content: [{ type: "text", text: "fallback page" }], details: {} }; };
  const context = { client, store: new ExaContentStore(10000, 10000), owner, sessionId: "s", backgroundFallback: fallback };
  const tools = createExaRetrievalTools(context); const fetch = tools.find((t) => t.name === "exa_fetch")!;
  const result = await fetch.execute("c1", { urls: ["https://example.com"] }); assert.match((result.content[0] as any).text, /Fallback provider: direct web_fetch/); assert.equal(fallbackCalls, 1);
  await assert.rejects(fetch.execute("c2", { urls: ["https://example.com"], max_age_hours: 0 })); assert.equal(fallbackCalls, 1);
  const noFallback = createExaRetrievalTools({ ...context, backgroundFallback: undefined }).find((t) => t.name === "exa_fetch")!;
  await assert.rejects(noFallback.execute("c3", { urls: ["https://example.com"] })); assert.equal(fallbackCalls, 1);
});
test("research-compatible bounded array-of-object search schema remains accepted", () => {
  assert.doesNotThrow(() => validateExaOutputSchema({ type: "object", properties: { rows: { type: "array", maxItems: 10, items: { type: "object", properties: { name: { type: "string" } } } } } }, true));
});

test("paid Exa session-type budget gate stops transport while unrelated worker remains permitted", async () => {
  const { BudgetEngine, makeToolBudgetGate } = await import("../src/budget/engine.js");
  const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } } as any;
  const engine = new BudgetEngine({
    rules: [{ name: "default-tools", maxUsd: 0, window: { type: "rolling", durationMs: 86400000, duration: "24h" }, selector: { classes: ["tool"], sessionTypes: ["default"] } }],
    sumUsageCost: () => 0, zeroCostModelIds: new Set(), dependencies: {}, resolveModelId: () => "paid", logger,
  });
  const f = fixture({ results: [] });
  const toolsFor = (sessionType: string) => createExaRetrievalTools({ client: f.client, store: f.store, owner, sessionId: "s",
    checkBudget: (toolName, service) => makeToolBudgetGate({ engine: () => engine, toolName, timelineKey: owner.timeline, sessionType, paidService: true, formatResetsAt: String })(service),
  });
  await assert.rejects(toolsFor("default").find((t) => t.name === "exa_search")!.execute("blocked", { query: "q" }), /Over budget/);
  assert.equal(f.calls.length, 0);
  await toolsFor("summarize").find((t) => t.name === "exa_fetch")!.execute("allowed", { urls: ["https://example.com"] });
  assert.equal(f.calls.length, 1);
});
test("freshness provider crawl timeout stays within 90 seconds independently of outer deadline", async () => {
  const f = fixture({ results: [] }, { request_timeout_ms: 120000 });
  await f.run("exa_search_advanced", { query: "q", max_age_hours: 0 });
  await f.run("exa_fetch", { urls: ["https://example.com"], max_age_hours: 0 });
  assert.equal(f.calls[0].body.contents.livecrawlTimeout, 90000);
  assert.equal(f.calls[1].body.livecrawlTimeout, 90000);
  assert.equal(f.client.config.request_timeout_ms, 120000);
});
