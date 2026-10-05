import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSessionFactory, mapBuiltMessages } from "../src/agent/factory.js";
import { convertToLlm } from "../src/agent/convert.js";
import {
  MODEL_TAIL_AT,
  applyModelPrompt,
  loadModelPrompts,
  renderModelTail,
  resolveModelPromptProfile,
  spliceModelTail,
  systemPromptHashOf,
} from "../src/agent/model-prompts.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import { loadConfig, type AppConfig } from "../src/config/index.js";
import type { BuiltContext, ContextBuilder } from "../src/context/builder.js";
import { estimateTokens } from "../src/context/index.js";
import { renderSatelliteBlock, renderSatelliteBlockWithTailSlot } from "../src/workspace/prompt.js";
import type { WorkspaceContent } from "../src/workspace/types.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ContextBuilder } from "../src/context/builder.js";
import { resolveRetrievalConfig, type MemorySearch } from "../src/retrieval/index.js";
import { configureAgentTimezone, resetAgentTimezone } from "../src/time/index.js";

// --- resolution ladder --------------------------------------------------------

function ladderConfig(): AppConfig {
  return {
    models: { a: { model_prompt: "pa" }, b: { model_prompt: "pb" }, c: {} },
    model_prompts: { pa: { preamble: { text: "A" } }, pb: { preamble: { text: "B" } }, pw: { tail: { text: "W" } } },
  } as unknown as AppConfig;
}

test("resolution: session-type exact model, then '*', then the model default, then none", () => {
  const config = ladderConfig();
  assert.deepEqual(resolveModelPromptProfile(config, undefined, "a"), { profile: "pa", rung: "model" });
  assert.equal(resolveModelPromptProfile(config, undefined, "c"), undefined, "no profile anywhere");
  const st = { model_prompts: { a: "pw", "*": "none" } };
  assert.deepEqual(resolveModelPromptProfile(config, st, "a"), { profile: "pw", rung: "session_type" });
  assert.equal(resolveModelPromptProfile(config, st, "b"), undefined, '"*" = "none" beats b\'s own default');
  const wild = { model_prompts: { "*": "pw" } };
  assert.deepEqual(resolveModelPromptProfile(config, wild, "c"), { profile: "pw", rung: "session_type_wildcard" });
  assert.equal(resolveModelPromptProfile(config, { model_prompts: { a: "none" } }, "a"), undefined, "exact none");
  assert.deepEqual(resolveModelPromptProfile(config, { model_prompts: { b: "pw" } }, "a"), { profile: "pa", rung: "model" });
});

// --- satellite slot -------------------------------------------------------------

const workspace = (tail: string | null): WorkspaceContent =>
  ({ files: new Map(), tailContent: tail, skills: { listed: [], inlined: [] } }) as unknown as WorkspaceContent;

const satInput = (over: Record<string, unknown> = {}) =>
  ({
    timelineKey: "matrix:a:room:!r",
    trigger: { id: "e", timestamp: 0 },
    activeSessions: [],
    now: 0,
    ...over,
  }) as any;

test("satellite: text is unchanged; the slot sits after the tail instructions, before the session instruction", () => {
  const st = { session_instruction: "Do the thing." };
  const { text, tailSlot } = renderSatelliteBlockWithTailSlot(satInput(), workspace("Tail text."), st);
  assert.equal(text, renderSatelliteBlock(satInput(), workspace("Tail text."), st), "no marker in the text");
  assert.ok(tailSlot);
  const block = renderModelTail("Model tail.");
  const spliced = spliceModelTail(text, tailSlot!, block);
  assert.match(spliced, /<\/tail_instructions>\n\n<tail_instructions>\nModel tail\.\n<\/tail_instructions>\n\n<session_instruction>/);
});

test("satellite: separators are right when the slot is first, last, or alone", () => {
  // Generation build (no runtime state), no TAIL.md, a session instruction → slot first.
  const first = renderSatelliteBlockWithTailSlot(
    satInput({ suppressRuntimeState: true }),
    workspace(null),
    { session_instruction: "S." },
  );
  assert.deepEqual(first.tailSlot, { offset: 0, join: "after" });
  assert.equal(spliceModelTail(first.text, first.tailSlot!, "<T/>"), "<T/>\n\n<session_instruction>\nS.\n</session_instruction>");
  // Nothing else in the satellite → the block alone.
  const alone = renderSatelliteBlockWithTailSlot(satInput({ suppressRuntimeState: true }), workspace(null));
  assert.deepEqual(alone.tailSlot, { offset: 0, join: "none" });
  assert.equal(spliceModelTail(alone.text, alone.tailSlot!, "<T/>"), "<T/>");
  // Slot last (no session instruction).
  const last = renderSatelliteBlockWithTailSlot(satInput({ suppressRuntimeState: true }), workspace("X"));
  assert.equal(spliceModelTail(last.text, last.tailSlot!, "<T/>"), `${last.text}\n\n<T/>`);
});

test("satellite: no slot when the resume satellite suppresses the tail", () => {
  const { tailSlot } = renderSatelliteBlockWithTailSlot(satInput({ suppressTail: true }), workspace("Tail."));
  assert.equal(tailSlot, undefined);
});

// --- wire carriage --------------------------------------------------------------

test("wire: the slot rides under a symbol, survives the snapshot JSON round-trip, and never serializes", () => {
  const built = {
    messages: [
      { type: "system", role: "system", content: "sys", tier: "system", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "<system>\nA\n</system>", tier: "trigger", tokenEstimate: 1, modelTailAt: { offset: 10, join: "before" } },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  } as unknown as BuiltContext;
  const mapped = JSON.parse(JSON.stringify(mapBuiltMessages(built)));
  assert.deepEqual(mapped[0].modelTailAt, { offset: 10, join: "before" }, "persisted with the turn");
  const wire = convertToLlm(mapped);
  assert.deepEqual((wire[0] as any)[MODEL_TAIL_AT], { offset: 10, join: "before" });
  assert.ok(!JSON.stringify(wire).includes("offset"), "no trace in a serialized payload");
});

test("apply: preamble first, tail at the slot, other messages keep their identity", () => {
  const text = "<system>\nA\n</system>\n\n<message>hi</message>";
  const user = { role: "user", content: text, timestamp: 1 } as any;
  user[MODEL_TAIL_AT] = { offset: "<system>\nA".length, join: "before" };
  const assistant = { role: "assistant", content: [{ type: "text", text: "yo" }] } as any;
  const out = applyModelPrompt(
    { systemPrompt: "SYS", messages: [user, assistant] },
    { preamble: "PRE", tail: renderModelTail("TAIL") },
  );
  assert.equal(out.systemPrompt, "PRE\n\nSYS");
  assert.equal(
    (out.messages[0] as any).content,
    "<system>\nA\n\n<tail_instructions>\nTAIL\n</tail_instructions>\n</system>\n\n<message>hi</message>",
  );
  assert.equal(out.messages[1], assistant, "untouched message is the same object");
  // No tail → messages array untouched.
  const pre = applyModelPrompt({ systemPrompt: "SYS", messages: [user] }, { preamble: "PRE" });
  assert.equal((pre.messages[0] as any).content, text);
});

test("apply: an image-bearing turn gets the tail in its leading text part", () => {
  const user = { role: "user", content: [{ type: "text", text: "ab" }, { type: "image", data: "x", mimeType: "image/png" }] } as any;
  user[MODEL_TAIL_AT] = { offset: 1, join: "none" };
  const out = applyModelPrompt({ messages: [user] }, { tail: "T" });
  assert.equal((out.messages[0] as any).content[0].text, "aTb");
  assert.equal((out.messages[0] as any).content[1].type, "image");
});

// --- loading --------------------------------------------------------------------

test("load: sources read once per profile; missing workspace files and empty files are unset, silently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-mp-"));
  try {
    await writeFile(path.join(root, "MODEL_TAIL.md"), "Tail from workspace.\n");
    await writeFile(path.join(root, "EMPTY.md"), "  \n\n");
    const config = {
      models: { a: { model_prompt: "p" }, b: { model_prompt: "p" }, c: { model_prompt: "q" }, d: { model_prompt: "p" } },
      model_prompts: {
        p: { preamble: { text: "Pre." }, tail: { workspace_file: "MODEL_TAIL.md" } },
        q: { preamble: { workspace_file: "MISSING.md" }, tail: { workspace_file: "EMPTY.md" } },
        e: { preamble: { workspace_file: "EMPTY.md" } },
      },
    } as unknown as AppConfig;
    const warnings: unknown[] = [];
    const logger = { info: () => {}, warn: (...a: unknown[]) => warnings.push(a), debug: () => {}, error: () => {} } as any;
    const load = (sessionType?: Record<string, unknown>) =>
      loadModelPrompts({
        config,
        sessionType: sessionType as any,
        sessionTypeName: "default",
        logicalIds: ["a", "b", "c", "d"],
        workspaceRoot: root,
        estimateTokens,
        logger,
      });
    const loaded = await load();
    assert.equal(loaded.get("a")?.preamble, "Pre.");
    assert.equal(loaded.get("a")?.tail, '<tail_instructions source="MODEL_TAIL.md">\nTail from workspace.\n</tail_instructions>');
    assert.equal(loaded.get("a")?.hash, loaded.get("b")?.hash, "same profile, same bytes, same hash");
    assert.equal(loaded.has("c"), false, "missing + empty → no model prompt");
    // An override to a profile whose file is empty works like "none": d's own default is not used.
    const overridden = await load({ model_prompts: { d: "e" } });
    assert.equal(overridden.has("d"), false);
    assert.ok(overridden.has("a"));
    assert.equal(warnings.length, 0, "absent workspace files and empty files are not warnings");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load: an unreadable source still warns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-mp-"));
  try {
    const config = {
      models: { a: { model_prompt: "p" } },
      model_prompts: { p: { preamble: { file: path.join(root, "vanished.md") } } },
    } as unknown as AppConfig;
    const warnings: unknown[] = [];
    const logger = { info: () => {}, warn: (...a: unknown[]) => warnings.push(a), debug: () => {}, error: () => {} } as any;
    const loaded = await loadModelPrompts({ config, sessionType: undefined, sessionTypeName: "default", logicalIds: ["a"], workspaceRoot: root, estimateTokens, logger });
    assert.equal(loaded.size, 0);
    assert.equal(warnings.length, 1, "a config-dir file validated at startup that vanished is worth a warning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- config validation ----------------------------------------------------------

const BASE = `
[app]
name = "t"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug"
[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0
[agent.system]
[models.default]
id = "m"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1024
[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000
[storage]
database_path = ":memory:"
[workspace]
root_dir = "./ws"
[matrix]
enabled = false
trigger_hold_ms = 0
[matrix.accounts.t]
homeserver = "http://localhost"
user_id = "@t:localhost"
store_path = "./var/t"
`;

async function load(extra: string, files: Record<string, string> = {}): Promise<AppConfig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-mpcfg-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), BASE);
    await writeFile(path.join(dir, "90-test.toml"), extra);
    for (const [name, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), body);
    }
    return await loadConfig(dir, { env: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: a valid setup loads and config-dir files become absolute", async () => {
  const config = await load(
    `
[model_prompts.claude]
preamble = { file = "model-prompts/claude.md" }
tail = { workspace_file = "MODEL_TAIL.md" }
[models.default]
model_prompt = "claude"
[agent.session_types.summarize]
model_prompts = { default = "none", "*" = "claude" }
`,
    { "model-prompts/claude.md": "Hello." },
  );
  assert.ok(path.isAbsolute(config.model_prompts!.claude!.preamble!.file!));
  assert.equal(config.models.default.model_prompt, "claude");
});

test("config: invalid model-prompt setups are startup errors", async () => {
  const cases: Array<[string, RegExp]> = [
    [`[models.default]\nmodel_prompt = "ghost"`, /names no \[model_prompts\.\*\] profile/],
    [`[model_prompts.none]\npreamble = { text = "x" }`, /reserved/],
    [`[model_prompts.p]`, /needs a preamble, a tail, or both/],
    [`[model_prompts.p]\npreamble = { text = "x", workspace_file = "y" }`, /exactly one of/],
    [`[model_prompts.p]\npreamble = { file = "nope.md" }`, /not found/],
    [`[model_prompts.p]\npreamble = { text = "x" }\n[agent.session_types.default]\nmodel_prompts = { ghost = "p" }`, /neither "\*" nor a \[models\.\*\] name/],
    [`[model_prompts.p]\npreamble = { text = "x" }\n[agent.session_types.default]\nmodel_prompts = { default = "ghost" }`, /use "none"/],
  ];
  for (const [extra, pattern] of cases) {
    await assert.rejects(load(extra), pattern, extra);
  }
});

// --- end to end through the factory ---------------------------------------------

/** OpenAI-completions SSE stub; records each request body. `fail` paths answer 500. */
async function stubServer(fail: Set<string>): Promise<{ port: number; bodies: Array<{ path: string; body: any }>; close: () => Promise<void> }> {
  const bodies: Array<{ path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ path: req.url ?? "", body: JSON.parse(raw) });
      if ([...fail].some((p) => (req.url ?? "").startsWith(p))) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
      chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const KICKOFF = "<system>\nTAIL.md\n</system>\n\n<message>hi</message>";
const SLOT = { offset: "<system>\nTAIL.md".length, join: "before" as const };

function e2eFactory(port: number, root: string, over: Record<string, unknown> = {}, recorded: any[] = []): AgentSessionFactory {
  const model = (id: string, prefix: string, extra: Record<string, unknown> = {}) => ({
    id,
    provider: "test",
    api: "openai-completions",
    endpoint: `http://127.0.0.1:${port}/${prefix}/v1`,
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 256,
    context_window: 128_000,
    ...extra,
  });
  const built = {
    messages: [
      { type: "system", role: "system", content: "SYSTEM", tier: "system", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: KICKOFF, tier: "trigger", tokenEstimate: 1, timestamp: 1, modelTailAt: SLOT },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  } as unknown as BuiltContext;
  const config = {
    app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    recovery: { llm_request_max_wait_ms: 2000, llm_request_backoff_base_ms: 1, llm_request_backoff_max_ms: 1 },
    models: {
      default: model("head-wire", "a", { model_prompt: "pa", fallback: ["second"] }),
      second: model("second-wire", "b", { model_prompt: "pb" }),
    },
    model_prompts: {
      pa: { preamble: { text: "PREAMBLE A" }, tail: { text: "TAIL A" } },
      pb: { preamble: { text: "PREAMBLE B" } },
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: root },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...over,
  } as unknown as AppConfig;
  return new AgentSessionFactory({
    config,
    contextBuilder: { build: async () => built } as unknown as ContextBuilder,
    getActiveSessions: () => [],
    budget: { record: (event: unknown) => recorded.push(event) } as any,
  });
}

const e2eSession = (): AgentSessionRecord =>
  ({
    id: "s-mp",
    timelineKey: "matrix:a:room:!r",
    sessionType: "default",
    status: "running",
    trigger: { provider: "matrix", timelineKey: "matrix:a:room:!r", event: { id: "e", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user", sender: { id: "@u:hs" }, body: "hi", timestamp: 1, receivedAt: 1 } },
    createdAt: 0,
  }) as unknown as AgentSessionRecord;

const systemOf = (body: any) => body.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content;
const userText = (body: any) => {
  const user = body.messages.find((m: any) => m.role === "user");
  return typeof user.content === "string" ? user.content : user.content.map((p: any) => p.text ?? "").join("");
};

test("e2e: the serving member's preamble opens the system prompt and its tail lands at the slot", async () => {
  const stub = await stubServer(new Set());
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-mpe2e-"));
  await writeFile(path.join(root, "AGENTS.md"), "Be nice.\n");
  try {
    const factory = e2eFactory(stub.port, root);
    const { agent, finalTurn } = await factory.create(e2eSession(), []);
    assert.equal((finalTurn as any).content, KICKOFF, "stored kickoff stays model-neutral");
    await agent.prompt(finalTurn as any);
    const body = stub.bodies[0]!.body;
    assert.ok(agent.state.systemPrompt.includes("Be nice."), "stored system prompt is the workspace render");
    assert.equal(systemOf(body), `PREAMBLE A\n\n${agent.state.systemPrompt}`);
    assert.equal(userText(body), "<system>\nTAIL.md\n\n<tail_instructions>\nTAIL A\n</tail_instructions>\n</system>\n\n<message>hi</message>");
    assert.ok(!JSON.stringify(body).includes("modelTailAt"));
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("e2e: after failover the fallback member sends ITS text; a member without a tail sends today's bytes", async () => {
  const stub = await stubServer(new Set(["/a/"]));
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-mpe2e-"));
  await writeFile(path.join(root, "AGENTS.md"), "Be nice.\n");
  try {
    const recorded: any[] = [];
    const factory = e2eFactory(stub.port, root, {}, recorded);
    const { agent, finalTurn } = await factory.create(e2eSession(), []);
    await agent.prompt(finalTurn as any);
    const served = stub.bodies.find((b) => b.path.startsWith("/b/"));
    const row = recorded.find((r) => r.class === "agent_loop");
    assert.equal(row?.logicalModelId, "second");
    assert.equal(row?.modelPrompt, "pb", "the ledger names the served member's profile");
    assert.match(row?.modelPromptHash ?? "", /^[0-9a-f]{12}$/);
    // The frozen, model-neutral system prompt's hash (spec REFUSAL-HANDLING §12.4).
    assert.equal(row?.systemPromptHash, systemPromptHashOf(agent.state.systemPrompt));
    assert.ok(served, `fallback served: ${stub.bodies.map((b) => b.path)}`);
    assert.ok(String(systemOf(served!.body)).startsWith("PREAMBLE B\n\n"));
    assert.ok(!String(systemOf(served!.body)).includes("PREAMBLE A"));
    assert.equal(userText(served!.body), KICKOFF, "pb has no tail → byte-identical kickoff");
    for (const head of stub.bodies.filter((b) => b.path.startsWith("/a/"))) {
      assert.ok(String(systemOf(head.body)).startsWith("PREAMBLE A\n\n"));
    }
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("e2e: a session-type override of 'none' sends no model prompt at all", async () => {
  const stub = await stubServer(new Set());
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-mpe2e-"));
  await writeFile(path.join(root, "AGENTS.md"), "Be nice.\n");
  try {
    const factory = e2eFactory(stub.port, root, {
      agent: {
        sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
        system: {},
        session_types: { default: { model_prompts: { "*": "none" } } },
      },
    });
    const { agent, finalTurn } = await factory.create(e2eSession(), []);
    await agent.prompt(finalTurn as any);
    const body = stub.bodies[0]!.body;
    assert.equal(systemOf(body), agent.state.systemPrompt);
    assert.equal(userText(body), KICKOFF);
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- the real builder records the slot at the right offset ------------------------

const TK = "matrix:miku:room:!room";
const ev = (id: string, body: string, ts: number) =>
  ({ id, timelineKey: TK, provider: "matrix", role: "user", sender: { id: "alice", displayName: "Alice" }, body, timestamp: ts, receivedAt: ts }) as any;
const builderConfig = () =>
  ({
    app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: { default: { id: "m", provider: "t", endpoint: "http://x", api_key: "k", input_modalities: ["text"], max_tokens: 4096 } },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  }) as unknown as AppConfig;
const memorySearch = {
  search: async () => ({
    results: [{ id: "id", path: "memory/x.md", startLine: 1, endLine: 2, room: "R", date: "2026-01-01", entryTs: 1, score: 0.9, snippet: "An older decision." }],
    mode: "hybrid",
    degraded: false,
    ignoredDateBounds: [],
    contradictoryDateBounds: false,
  }),
  searchUserLane: async () => [],
} as unknown as MemorySearch;
const EXPECT = "TAIL-MD\n</tail_instructions>\n\n<X/>\n\n<session_instruction>\nSI\n</session_instruction>\n</system>";

test("builder: fresh build records the slot after TAIL.md, past the retrieved_memory block", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, builderConfig(), storage, undefined, {
    search: memorySearch,
    config: resolveRetrievalConfig({ enabled: true }),
  });
  try {
    const trigger = ev("ev1", "what did we decide?", 1000);
    await timeline.append(trigger);
    const built = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: workspace("TAIL-MD"),
      sessionType: { session_instruction: "SI" },
    });
    const final = built.messages[built.messages.length - 1]!;
    assert.ok(final.content.startsWith("<retrieved_memory"), "the slot must account for the leading block");
    assert.ok(final.modelTailAt);
    assert.ok(spliceModelTail(final.content, final.modelTailAt!, "<X/>").includes(EXPECT));
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

test("builder: the reply-resume turn records the slot past the gap block; tail toggle off records none", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, builderConfig(), storage);
  try {
    await timeline.append(ev("missed", "a message the session missed", 2000));
    const trigger = ev("reply", "follow up", 4000);
    await timeline.append(trigger);
    const base = { timelineKey: TK, trigger, activeSessions: [], workspace: workspace("TAIL-MD"), sessionType: { session_instruction: "SI" }, selfSessionId: "s1" };
    const turn = (await builder.buildResumeTurn({
      ...base,
      tail: true,
      gap: { maxMessages: 10, maxTokens: 10_000, lowerBoundTimestamp: 0 },
    })) as any;
    assert.ok(turn.content.indexOf("<system>") > 0, "gap block precedes the satellite");
    assert.ok(spliceModelTail(turn.content, turn.modelTailAt, "<X/>").includes(EXPECT));
    const off = (await builder.buildResumeTurn({ ...base, tail: false })) as any;
    assert.equal(off.modelTailAt, undefined);
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

// --- storage: v22→v23 -----------------------------------------------------------

test("storage: v22→v23 adds the usage_events model-prompt columns; per-session rollup", async () => {
  const { Storage: Store, LATEST_SCHEMA_VERSION } = await import("../src/storage/database.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-mp-"));
  const dbPath = path.join(dir, "test.db");
  const row = (over: Record<string, unknown>) => ({
    class: "agent_loop",
    agentSessionId: "s1",
    modelId: "wire",
    costUsd: 0.01,
    ...over,
  });
  try {
    {
      const storage = await Store.open({ databasePath: dbPath });
      await storage.insertUsageEvent(row({ ts: 1, logicalModelId: "a" }) as any);
      await storage.waitForIdle();
      await storage.write((db) => {
        db.exec("alter table usage_events drop column model_prompt");
        db.exec("alter table usage_events drop column model_prompt_hash");
        db.pragma("user_version = 22");
      });
      await storage.waitForIdle();
      storage.close();
    }
    const storage = await Store.open({ databasePath: dbPath });
    try {
      assert.equal(storage.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
      assert.deepEqual(storage.getSessionModelPrompts("s1"), [], "pre-feature rows carry no model prompt");
      await storage.insertUsageEvent(row({ ts: 2, logicalModelId: "a", modelPrompt: "pa", modelPromptHash: "h1" }) as any);
      await storage.insertUsageEvent(row({ ts: 3, logicalModelId: "a", modelPrompt: "pa", modelPromptHash: "h1" }) as any);
      await storage.insertUsageEvent(row({ ts: 4, logicalModelId: "b", modelPrompt: "pb", modelPromptHash: "h2" }) as any);
      await storage.waitForIdle();
      assert.deepEqual(storage.getSessionModelPrompts("s1"), [
        { member: "a", profile: "pa", hash: "h1", requests: 2 },
        { member: "b", profile: "pb", hash: "h2", requests: 1 },
      ]);
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
