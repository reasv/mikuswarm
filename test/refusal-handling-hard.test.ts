import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSessionFactory, type CreatedAgent } from "../src/agent/factory.js";
import { SessionRunner, SessionRunnerError } from "../src/agent/runner.js";
import { LlmScheduler } from "../src/agent/scheduler.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import type { AppConfig } from "../src/config/index.js";
import type { BuiltContext, ContextBuilder } from "../src/context/builder.js";
import type { UserLimitContext, UserLimitResolution } from "../src/budget/index.js";
import { normalizeRefusalRules } from "../src/refusals/rules.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// Hard refusals end to end (spec REFUSAL-HANDLING phase 1): a provider refusal
// through the real factory stream stack (pi-ai → admission → model prompts →
// fallback composite → Layer 0) is classified, recorded in refusal_events,
// billed, and redone on a [[refusal_fallback]] rule's model, which then stays
// pinned for the session. Upstreams are a local HTTP stub per path prefix.
// ---------------------------------------------------------------------------

type Behaviour = "ok" | "filter" | "toolcall" | "anthropic-refusal" | "anthropic-refusal-unknown";

interface Stub {
  port: number;
  bodies: Array<{ path: string; body: any }>;
  /** A behaviour, or a queue consumed one request at a time (then "ok"). */
  behaviour: Record<string, Behaviour | Behaviour[]>;
  close: () => Promise<void>;
}

/** Path prefix ("/a/") → behaviour; unknown prefixes answer ok. */
async function stubServer(behaviour: Record<string, Behaviour | Behaviour[]>): Promise<Stub> {
  const bodies: Array<{ path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      bodies.push({ path: url, body: JSON.parse(raw) });
      const prefix = Object.keys(behaviour).find((p) => url.startsWith(p));
      const configured = prefix ? behaviour[prefix]! : "ok";
      const kind: Behaviour = Array.isArray(configured) ? (configured.shift() ?? "ok") : configured;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (kind === "anthropic-refusal" || kind === "anthropic-refusal-unknown") {
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("message_start", {
          type: "message_start",
          message: {
            id: "msg_1", type: "message", role: "assistant", model: "anth-wire", content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 0 },
          },
        });
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_sequence: null,
            stop_details: {
              type: "refusal",
              category: kind === "anthropic-refusal" ? "reasoning_extraction" : "novel_category",
              explanation: "Declined to reveal reasoning.",
            },
          },
          usage: { output_tokens: 3 },
        });
        send("message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (kind === "toolcall") {
        const name = (JSON.parse(raw).tools ?? [])[0]?.function?.name ?? "tool";
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: { name, arguments: "{}" } }] }, finish_reason: null }] });
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      } else if (kind === "filter") {
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] });
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } });
      } else {
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    behaviour,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const KICKOFF = "<system>\nTAIL.md\n</system>\n\n<message>hi</message>";
const SLOT = { offset: "<system>\nTAIL.md".length, join: "before" as const };

function oai(port: number, id: string, prefix: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    provider: "test",
    api: "openai-completions",
    endpoint: `http://127.0.0.1:${port}/${prefix}/v1`,
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 256,
    context_window: 128_000,
    cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
    ...extra,
  };
}

function anthropic(port: number, id: string, prefix: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    provider: "anthropic",
    api: "anthropic-messages",
    endpoint: `http://127.0.0.1:${port}/${prefix}`,
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 256,
    context_window: 128_000,
    reasoning: false,
    cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
    ...extra,
  };
}

interface FactoryOptions {
  models: Record<string, unknown>;
  rules?: Array<Record<string, unknown>>;
  storage?: Storage;
  recorded?: any[];
  scheduler?: LlmScheduler;
  isModelAvailable?: (id: string) => boolean;
  extra?: Record<string, unknown>;
  root: string;
}

function makeFactory(o: FactoryOptions): AgentSessionFactory {
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
    recovery: { llm_request_max_wait_ms: 5000, llm_request_backoff_base_ms: 1, llm_request_backoff_max_ms: 1 },
    models: o.models,
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: o.root },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    refusal_fallback: o.rules ?? [],
    ...o.extra,
  } as unknown as AppConfig;
  const recorded = o.recorded ?? [];
  return new AgentSessionFactory({
    config,
    contextBuilder: { build: async () => built } as unknown as ContextBuilder,
    getActiveSessions: () => [],
    storage: o.storage,
    scheduler: o.scheduler,
    budget: {
      record: (event: unknown) => recorded.push(event),
      ...(o.isModelAvailable
        ? {
            engine: {
              isModelAvailable: o.isModelAvailable,
              check: () => ({ allowed: true, blockingRules: [] }),
              logBlocked: () => {},
            },
          }
        : {}),
    } as any,
    refusals: { catalogue: buildCheckCatalogue(config), rules: normalizeRefusalRules(config) },
  });
}

function session(id: string, sessionType = "default", attachments?: unknown[]): AgentSessionRecord {
  return {
    id,
    timelineKey: "matrix:a:room:!r",
    sessionType,
    status: "running",
    trigger: {
      provider: "matrix",
      timelineKey: "matrix:a:room:!r",
      event: {
        id: "e", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user",
        sender: { id: "@u:hs" }, body: "hi", timestamp: 1, receivedAt: 1,
        ...(attachments ? { attachments } : {}),
      },
    },
    createdAt: 0,
  } as unknown as AgentSessionRecord;
}

async function withEnv(
  behaviour: Record<string, Behaviour | Behaviour[]>,
  fn: (env: { stub: Stub; storage: Storage; root: string }) => Promise<void>,
): Promise<void> {
  const stub = await stubServer(behaviour);
  const storage = await Storage.open({ databasePath: ":memory:" });
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-rh-"));
  await writeFile(path.join(root, "AGENTS.md"), "Be nice.\n");
  try {
    await fn({ stub, storage, root });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function addSessionRow(storage: Storage, id: string, sessionType = "default"): Promise<void> {
  await storage.insertAgentSession({
    id, timelineKey: "matrix:a:room:!r", sessionType, status: "running", createdAt: 1, updatedAt: 1,
  });
}

const prefixes = (stub: Stub): string[] => stub.bodies.map((b) => b.path.split("/")[1]!);
const systemOf = (body: any): string => body.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content;
const userText = (body: any): string => {
  const user = body.messages.find((m: any) => m.role === "user");
  return typeof user.content === "string" ? user.content : user.content.map((p: any) => p.text ?? "").join("");
};

async function events(storage: Storage, id: string) {
  await storage.waitForIdle();
  return storage.listRefusalEvents(id);
}

async function runFirst(created: CreatedAgent): Promise<void> {
  await created.agent.prompt(created.finalTurn as any);
}

// ── No rule: today's implicit fallover, now recorded and billed ─────────────

test("no rule: implicit fallover unchanged; refusal_events row 'fallover'; the refused attempt is billed", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s1");
    const recorded: any[] = [];
    const factory = makeFactory({
      root,
      storage,
      recorded,
      models: { default: oai(stub.port, "a-wire", "a", { fallback: ["second"] }), second: oai(stub.port, "b-wire", "b") },
    });
    const created = await factory.create(session("s1"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a", "b"], "fell over to the next chain member");
    const rows = await events(storage, "s1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "fallover");
    assert.equal(rows[0]!.check_code, "refusal_safety");
    assert.equal(rows[0]!.reason, "safety");
    assert.equal(rows[0]!.sub_reason, "content_filter");
    assert.equal(rows[0]!.method, "stop_reason");
    assert.equal(rows[0]!.checkpoint, "request");
    assert.equal(rows[0]!.source, "api");
    assert.equal(rows[0]!.site, "default");
    assert.equal(rows[0]!.served_model, "default");
    assert.equal(rows[0]!.rule_name, null);
    const loop = recorded.filter((r) => r.class === "agent_loop");
    assert.deepEqual(loop.map((r) => r.logicalModelId), ["default", "second"], "refused attempt billed to the refusing member");
    assert.equal(loop[0].inputTokens, 20);
    assert.ok(loop[0].costUsd > 0);
    assert.equal(created.refusal.pinnedModel(), undefined, "no rule → no pin");
    assert.equal(storage.getAgentSessionRefusalPin("s1"), undefined);
  });
});

test("no rule and no fallover target: the refusal is terminal ('failed')", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s1b");
    const factory = makeFactory({ root, storage, models: { default: oai(stub.port, "a-wire", "a") } });
    const created = await factory.create(session("s1b"), []);
    await runFirst(created);
    assert.match(created.agent.state.errorMessage ?? "", /\[llm-request:refusal\]/);
    const rows = await events(storage, "s1b");
    assert.deepEqual(rows.map((r) => r.outcome), ["failed"]);
  });
});

// ── A rule replaces the fallover; stickiness; model prompts ─────────────────

test("rule: redo on the rule's model instead of the chain fallback, pinned for every later request, with its model prompts", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s2");
    const recorded: any[] = [];
    const factory = makeFactory({
      root,
      storage,
      recorded,
      models: {
        default: oai(stub.port, "a-wire", "a", { fallback: ["second"] }),
        second: oai(stub.port, "b-wire", "b"),
        redo1: oai(stub.port, "r1-wire", "r1", { model_prompt: "pr" }),
      },
      rules: [{ name: "safety_redo", reasons: ["safety"], models: ["redo1"] }],
      extra: { model_prompts: { pr: { preamble: { text: "PREAMBLE R" }, tail: { text: "TAIL R" } } } },
    });
    const created = await factory.create(session("s2"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a", "r1"], "the rule replaced the chain fallover");
    // The redo model, outside the session's chains, is served with its own preamble and tail.
    const redo = stub.bodies[1]!.body;
    assert.ok(systemOf(redo).startsWith("PREAMBLE R\n\n"), systemOf(redo));
    assert.match(userText(redo), /<tail_instructions>\nTAIL R\n<\/tail_instructions>/);
    const loop = recorded.filter((r) => r.class === "agent_loop");
    assert.equal(loop[1].logicalModelId, "redo1");
    assert.equal(loop[1].modelPrompt, "pr");
    assert.match(loop[1].modelPromptHash ?? "", /^[0-9a-f]{12}$/);
    assert.equal(loop[0].modelPrompt, null, "the refused head carried no model prompt");

    const rows = await events(storage, "s2");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "redo");
    assert.equal(rows[0]!.rule_name, "safety_redo");
    assert.equal(rows[0]!.to_model, "redo1");
    assert.equal(created.refusal.pinnedModel(), "redo1");
    assert.deepEqual(
      { rule: storage.getAgentSessionRefusalPin("s2")?.rule, model: storage.getAgentSessionRefusalPin("s2")?.model },
      { rule: "safety_redo", model: "redo1" },
    );

    // A later request of the session stays on the pinned entry: the head is never asked again.
    stub.behaviour["/a/"] = "ok";
    await created.agent.prompt({ role: "user", content: "and again", timestamp: 2 } as any);
    assert.deepEqual(prefixes(stub), ["a", "r1", "r1"]);
    assert.equal(created.refusal.servingModel(), "redo1");
  });
});

test("rule entries: a second refusal moves to the next entry; unusable entries are skipped", async () => {
  await withEnv({ "/a/": "filter", "/r1/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s3");
    const factory = makeFactory({
      root,
      storage,
      models: {
        default: oai(stub.port, "a-wire", "a"),
        redo1: oai(stub.port, "r1-wire", "r1"),
        redo2: oai(stub.port, "r2-wire", "r2"),
        redo3: oai(stub.port, "r3-wire", "r3"),
      },
      // redo2 is over its period budget: skipped by the gate.
      isModelAvailable: (id) => id !== "redo2",
      rules: [{ name: "any", models: ["redo1", "redo2", "redo3"] }],
    });
    const created = await factory.create(session("s3"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a", "r1", "r3"]);
    const rows = await events(storage, "s3");
    assert.deepEqual(rows.map((r) => [r.served_model, r.outcome, r.to_model]), [
      ["default", "redo", "redo1"],
      ["redo1", "redo", "redo3"],
    ]);
    assert.equal(created.refusal.pinnedModel(), "redo3");
  });
});

for (const [onExhausted, outcome] of [
  ["send_last", "exhausted_send_last"],
  ["park", "exhausted_parked"],
] as const) {
  test(`exhaustion: on_exhausted = "${onExhausted}" parks a chat session like today (no text to send)`, async () => {
    await withEnv({ "/a/": "filter", "/r1/": "filter" }, async ({ stub, storage, root }) => {
      await addSessionRow(storage, `s4-${onExhausted}`);
      const factory = makeFactory({
        root,
        storage,
        models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1") },
        rules: [{ name: "r", models: ["redo1"], on_exhausted: onExhausted }],
      });
      const s = session(`s4-${onExhausted}`);
      const created = await factory.create(s, []);
      await assert.rejects(
        () => new SessionRunner().run(created.agent, s, 0, created.kickoff),
        (error: unknown) => error instanceof SessionRunnerError && error.phase === "llm" && error.llmClass === "refusal",
      );
      assert.deepEqual(prefixes(stub), ["a", "r1"]);
      const rows = await events(storage, s.id);
      assert.deepEqual(rows.map((r) => r.outcome), ["redo", outcome]);
      assert.equal(created.refusal.lastHardOutcome(), outcome);
    });
  });
}

test('exhaustion: on_exhausted = "withhold" settles the session NO_REPLY with no failure', async () => {
  await withEnv({ "/a/": "filter", "/r1/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s5");
    const recorded: any[] = [];
    const factory = makeFactory({
      root,
      storage,
      recorded,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "r", models: ["redo1"], on_exhausted: "withhold" }],
    });
    const s = session("s5");
    const created = await factory.create(s, []);
    const result = await new SessionRunner().run(created.agent, s, 0, created.kickoff);
    assert.equal(result.noReply, true);
    assert.equal(created.agent.state.errorMessage, undefined);
    const last = created.agent.state.messages.at(-1) as any;
    assert.equal(last.role, "assistant");
    assert.deepEqual(last.content, [{ type: "text", text: "NO_REPLY" }]);
    assert.deepEqual(last.harness, { kind: "refusal_withheld" });
    const rows = await events(storage, "s5");
    assert.deepEqual(rows.map((r) => r.outcome), ["redo", "exhausted_withheld"]);
    // Both refused attempts are billed; the harness NO_REPLY turn is not.
    assert.deepEqual(recorded.filter((r) => r.class === "agent_loop").map((r) => r.logicalModelId), ["default", "redo1"]);
  });
});

// ── Internal sites ───────────────────────────────────────────────────────────

test("mechanical job: an exhausted rule ends with no output (exhausted_no_output), whatever on_exhausted says", async () => {
  await withEnv({ "/a/": "filter", "/r1/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s6", "summarize");
    const factory = makeFactory({
      root,
      storage,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "r", sites: ["summarize"], models: ["redo1"], on_exhausted: "withhold" }],
    });
    const created = await factory.create(session("s6", "summarize"), []);
    await runFirst(created);
    assert.match(created.agent.state.errorMessage ?? "", /\[llm-request:refusal\]/, "no NO_REPLY stand-in for a job");
    assert.equal(created.refusal.lastHardOutcome(), "exhausted_no_output");
    const rows = await events(storage, "s6");
    assert.deepEqual(rows.map((r) => [r.site, r.outcome]), [["summarize", "redo"], ["summarize", "exhausted_no_output"]]);
  });
});

test("record turn: its opt-out disables only the implicit fallover; a rule naming record_turn applies", async () => {
  await withEnv({}, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s7");
    const factory = makeFactory({
      root,
      storage,
      models: {
        default: oai(stub.port, "a-wire", "a", { fallback: ["second"] }),
        second: oai(stub.port, "b-wire", "b"),
        redo1: oai(stub.port, "r1-wire", "r1"),
      },
      rules: [{ name: "records", sites: ["record_turn"], models: ["redo1"] }],
    });
    const created = await factory.create(session("s7"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a"]);
    // The record turn: no implicit fallover, site record_turn.
    stub.behaviour["/a/"] = "filter";
    created.setRefusalFallover(false);
    created.setRefusalSite("record_turn");
    assert.equal(created.refusal.site, "record_turn");
    await created.agent.prompt({ role: "user", content: "write the record", timestamp: 2 } as any);
    assert.deepEqual(prefixes(stub), ["a", "a", "r1"], "the rule redid the record turn; the chain fallback was not used");
    const rows = await events(storage, "s7");
    assert.deepEqual(rows.map((r) => [r.site, r.outcome, r.to_model]), [["record_turn", "redo", "redo1"]]);
    created.setRefusalSite(undefined);
    assert.equal(created.refusal.site, "default");
  });
});

test("record turn without a matching rule: the refusal ends the turn at once ('failed')", async () => {
  await withEnv({}, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s7b");
    const factory = makeFactory({
      root,
      storage,
      models: { default: oai(stub.port, "a-wire", "a", { fallback: ["second"] }), second: oai(stub.port, "b-wire", "b"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "chat_only", sites: ["default"], models: ["redo1"] }],
    });
    const created = await factory.create(session("s7b"), []);
    await runFirst(created);
    stub.behaviour["/a/"] = "filter";
    created.setRefusalFallover(false);
    created.setRefusalSite("record_turn");
    await created.agent.prompt({ role: "user", content: "write the record", timestamp: 2 } as any);
    assert.deepEqual(prefixes(stub), ["a", "a"]);
    assert.match(created.agent.state.errorMessage ?? "", /\[llm-request:refusal\]/);
    assert.deepEqual((await events(storage, "s7b")).map((r) => r.outcome), ["failed"]);
  });
});

test("the record turn after a sticky redo runs on the pinned model", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s7c");
    const factory = makeFactory({
      root,
      storage,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "r", models: ["redo1"] }],
    });
    const created = await factory.create(session("s7c"), []);
    await runFirst(created);
    created.setRefusalFallover(false);
    created.setRefusalSite("record_turn");
    await created.agent.prompt({ role: "user", content: "write the record", timestamp: 2 } as any);
    assert.deepEqual(prefixes(stub), ["a", "r1", "r1"]);
  });
});

// ── Resume ───────────────────────────────────────────────────────────────────

test("resume: a persisted pin is read back and keeps the session on the rule's model (with its model prompts)", async () => {
  await withEnv({}, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s8");
    await storage.setAgentSessionRefusalPin("s8", { rule: "r", model: "redo1", at: 5 });
    const factory = makeFactory({
      root,
      storage,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1", { model_prompt: "pr" }) },
      rules: [{ name: "r", models: ["redo1"] }],
      extra: { model_prompts: { pr: { preamble: { text: "PREAMBLE R" } } } },
    });
    const created = await factory.create(session("s8"), [], {
      resume: { snapshot: [], transcript: [{ role: "user", content: "resumed", timestamp: 1 } as any] },
    });
    assert.equal(created.refusal.pinnedModel(), "redo1");
    await created.agent.continue();
    assert.deepEqual(prefixes(stub), ["r1"]);
    assert.ok(systemOf(stub.bodies[0]!.body).startsWith("PREAMBLE R\n\n"));
  });
});

// ── Gates ────────────────────────────────────────────────────────────────────

test("gates: an unhealthy entry is skipped", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s9");
    const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 600_000, probeBackoffMaxMs: 600_000 } });
    try {
      scheduler.noteOutcome("default", `http://127.0.0.1:${stub.port}/r1/v1::r1-wire`, "environmental");
      const factory = makeFactory({
        root,
        storage,
        scheduler,
        models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1"), redo2: oai(stub.port, "r2-wire", "r2") },
        rules: [{ name: "r", models: ["redo1", "redo2"] }],
      });
      const created = await factory.create(session("s9"), []);
      await runFirst(created);
      assert.deepEqual(prefixes(stub), ["a", "r2"]);
    } finally {
      scheduler.stop();
    }
  });
});

test("gates: an entry that cannot take the session's images is skipped", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s10");
    const factory = makeFactory({
      root,
      storage,
      models: {
        default: oai(stub.port, "a-wire", "a", { input_modalities: ["text", "image"] }),
        redo1: oai(stub.port, "r1-wire", "r1"),
        redo2: oai(stub.port, "r2-wire", "r2", { input_modalities: ["text", "image"] }),
      },
      rules: [{ name: "r", models: ["redo1", "redo2"] }],
    });
    const created = await factory.create(session("s10", "default", [{ mediaType: "image", localPath: "/m/pic.png" }]), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a", "r2"]);
  });
});

// ── Per-user selection and routing ──────────────────────────────────────────

test("per-user selection + routing: an unaffordable entry is skipped; the pin overrides the cascade and preference list", async () => {
  await withEnv({ "/a/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s11");
    const recorded: any[] = [];
    const selections: string[] = [];
    const resolution = {
      matched: true, active: true, banned: false, models: ["default"], constraints: [], ledgerPartitionKeys: [],
    } as unknown as UserLimitResolution;
    const ctx = { userId: "@u:hs", roomId: "!r:hs" } as UserLimitContext;
    const engine = {
      affordable: (_r: unknown, model: string) =>
        model === "redo1" ? { ok: false, maxOutput: 0, remainingUsd: 0 } : { ok: true, maxOutput: 200, remainingUsd: 5 },
      bindingConstraint: () => undefined,
      noteSelection: (_s: string, _u: string, _room: string, model: string) => selections.push(model),
    } as never;
    const factory = makeFactory({
      root,
      storage,
      recorded,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1"), redo2: oai(stub.port, "r2-wire", "r2") },
      rules: [{ name: "r", models: ["redo1", "redo2"] }],
    });
    const created = await factory.create(session("s11"), [], {
      userLimit: { engine, resolution, ctx },
      route: async () => ({ task: "t", models: ["default"], skills: [], tailFiles: [] }),
    });
    await runFirst(created);
    stub.behaviour["/a/"] = "ok";
    await created.agent.prompt({ role: "user", content: "next", timestamp: 2 } as any);
    assert.deepEqual(prefixes(stub), ["a", "r2", "r2"], "redo1 unaffordable; later requests stay on the pin");
    const loop = recorded.filter((r) => r.class === "agent_loop");
    assert.deepEqual(loop.map((r) => [r.logicalModelId, r.requestedModelId]), [
      ["default", "default"],
      ["redo2", "redo2"],
      ["redo2", "redo2"],
    ], "the redo counts as the requested model for the payee's caps");
    assert.equal(selections.at(-1), "redo2", "the pre-flight notes the pinned model as the selection");
    assert.equal(stub.bodies[1]!.body.max_tokens ?? stub.bodies[1]!.body.max_completion_tokens, 200, "output capped at the pin's headroom");
  });
});

// ── Anthropic category through the real stream ──────────────────────────────

test("classifier end to end: the Anthropic stop_details category reaches the rule and the event row", async () => {
  await withEnv({ "/x/": "anthropic-refusal" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s12");
    const recorded: any[] = [];
    const factory = makeFactory({
      root,
      storage,
      recorded,
      models: { default: anthropic(stub.port, "anth-wire", "x"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "distill", reasons: ["distillation"], models: ["redo1"] }],
    });
    const created = await factory.create(session("s12"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["x", "r1"]);
    const rows = await events(storage, "s12");
    assert.equal(rows[0]!.check_code, "refusal_distillation");
    assert.equal(rows[0]!.reason, "distillation");
    assert.equal(rows[0]!.method, "provider_category");
    assert.equal(rows[0]!.category, "reasoning_extraction");
    assert.equal(rows[0]!.sub_reason, "reasoning_extraction");
    assert.equal(rows[0]!.raw_stop_reason, "refusal");
    assert.equal(rows[0]!.explanation, "Declined to reveal reasoning.");
    assert.equal(rows[0]!.wire_model, "anth-wire");
    assert.equal(rows[0]!.outcome, "redo");
    // The refused Anthropic attempt carried usage: it is billed.
    const refused = recorded.find((r) => r.class === "agent_loop" && r.logicalModelId === "default");
    assert.equal(refused?.inputTokens, 40);
    assert.equal(refused?.outputTokens, 3);
  });
});

test("classifier end to end: an unknown category is refusal_uncategorized with the raw category recorded", async () => {
  await withEnv({ "/x/": "anthropic-refusal-unknown" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "s13");
    const factory = makeFactory({
      root,
      storage,
      models: { default: anthropic(stub.port, "anth-wire", "x"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "distill", reasons: ["distillation"], models: ["redo1"] }],
    });
    const created = await factory.create(session("s13"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["x"], "the distillation rule does not match an unclear refusal");
    const rows = await events(storage, "s13");
    assert.equal(rows[0]!.check_code, "refusal_uncategorized");
    assert.equal(rows[0]!.reason, "unclear");
    assert.equal(rows[0]!.category, "novel_category");
    assert.equal(rows[0]!.sub_reason, "novel_category");
    assert.equal(rows[0]!.outcome, "failed");
    // The category rides on the transcript's error message beside rawStopReason.
    const last = created.agent.state.messages.at(-1) as any;
    assert.equal(last.rawStopReason, "refusal");
    assert.equal(last.stopCategory, "novel_category");
  });
});

// ── Tries and same-model retries (spec §8.1, owner decision 28) ─────────────

test("tries: @same retries the model that refused without moving the pin; a success stays on it", async () => {
  await withEnv({ "/a/": ["filter", "ok"] }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "t1");
    const recorded: any[] = [];
    const factory = makeFactory({
      root,
      storage,
      recorded,
      models: { default: oai(stub.port, "a-wire", "a", { fallback: ["second"] }), second: oai(stub.port, "b-wire", "b"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "r", models: [{ model: "@same", tries: 2 }, "redo1"] }],
    });
    const created = await factory.create(session("t1"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a", "a"], "re-sent to the refusing model (the implicit rule does not apply to explicit entries)");
    assert.equal(created.refusal.pinnedModel(), undefined, "a same-model retry pins nothing");
    assert.equal(storage.getAgentSessionRefusalPin("t1"), undefined);
    const rows = await events(storage, "t1");
    assert.deepEqual(rows.map((r) => [r.served_model, r.outcome, r.to_model]), [["default", "redo", "default"]]);
    assert.deepEqual(recorded.filter((r) => r.class === "agent_loop").map((r) => r.logicalModelId), ["default", "default"]);
    await created.agent.prompt({ role: "user", content: "next", timestamp: 2 } as any);
    assert.deepEqual(prefixes(stub), ["a", "a", "a"]);
  });
});

test("tries: every try of an entry is spent before the next entry; repeated keys are separate entries", async () => {
  await withEnv({ "/a/": "filter", "/r1/": ["filter", "filter", "ok"] }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "t2");
    const factory = makeFactory({
      root,
      storage,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1"), redo2: oai(stub.port, "r2-wire", "r2") },
      rules: [{ name: "r", models: [{ model: "@same", tries: 2 }, "redo1", "redo2", "redo1"] }],
    });
    const created = await factory.create(session("t2"), []);
    await runFirst(created);
    // a refuses; @same twice (a, a); redo1 refuses; redo2 serves.
    assert.deepEqual(prefixes(stub), ["a", "a", "a", "r1", "r2"]);
    assert.equal(created.refusal.pinnedModel(), "redo2");
    const rows = await events(storage, "t2");
    assert.deepEqual(rows.map((r) => [r.served_model, r.to_model]), [
      ["default", "default"],
      ["default", "default"],
      ["default", "redo1"],
      ["redo1", "redo2"],
    ]);
  });
});

test("tries: exhaustion counts every try", async () => {
  await withEnv({ "/a/": "filter", "/r1/": "filter" }, async ({ stub, storage, root }) => {
    await addSessionRow(storage, "t3");
    const factory = makeFactory({
      root,
      storage,
      models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1") },
      rules: [{ name: "r", models: [{ model: "redo1", tries: 3 }] }],
    });
    const created = await factory.create(session("t3"), []);
    await runFirst(created);
    assert.deepEqual(prefixes(stub), ["a", "r1", "r1", "r1"]);
    assert.deepEqual((await events(storage, "t3")).map((r) => r.outcome), ["redo", "redo", "redo", "exhausted_send_last"]);
  });
});

for (const [tool, delivered] of [["send_message", true], ["read_messages", false]] as const) {
  test(`tries: a refusal point ${delivered ? "ends at a delivered message (the rule restarts at entry 1 on the pinned model)" : "spans non-posting tool work (the walk continues)"}`, async () => {
    await withEnv({ "/a/": "filter", "/r1/": ["toolcall", "filter", "ok"] }, async ({ stub, storage, root }) => {
      await addSessionRow(storage, `t4-${tool}`);
      const factory = makeFactory({
        root,
        storage,
        models: { default: oai(stub.port, "a-wire", "a"), redo1: oai(stub.port, "r1-wire", "r1"), redo2: oai(stub.port, "r2-wire", "r2") },
        rules: [{ name: "r", from_models: ["default"], models: ["redo1", "redo2"] }],
      });
      const toolDef = {
        name: tool,
        label: tool,
        description: "test tool",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
      } as any;
      const created = await factory.create(session(`t4-${tool}`), [toolDef]);
      await runFirst(created);
      assert.deepEqual(
        prefixes(stub),
        delivered ? ["a", "r1", "r1", "r1"] : ["a", "r1", "r1", "r2"],
        "after a delivery the pinned model's refusal starts the rule over (entry 1 = redo1, a same-model retry)",
      );
      assert.equal(created.refusal.pinnedModel(), delivered ? "redo1" : "redo2");
    });
  });
}
