import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentSessionFactory } from "../src/agent/factory.js";
import { DynamicToolRegistry } from "../src/agent/dynamic-tools.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { BuiltContext } from "../src/context/index.js";
import type { ContextBuilder } from "../src/context/builder.js";
import type { UserLimitContext, UserLimitResolution } from "../src/budget/index.js";
import { NO_ROUTING, routingInputFrom, routingPoint, type RoutingInput, type RoutingVerdict } from "../src/decisions/index.js";
import { renderSatelliteBlock } from "../src/workspace/prompt.js";

// ---------------------------------------------------------------------------
// Decision-model routing (ARCHITECTURE.md §8h "Routing"): the point, the
// satellite render, initial preloads, and the factory's cascade selection.
// ---------------------------------------------------------------------------

const settings: any = { point: "routing", minConfidence: 0.75, calibration: {} };
const sameThreshold = (_name: string, value: number) => value;

function input(over: Partial<RoutingInput> = {}): RoutingInput {
  return {
    request: { id: "$1", from: "Alice", text: "write me a bash script" },
    recent: [],
    skills: [
      { name: "shell", description: "Run shell commands" },
      { name: "media", description: "Work with media" },
    ],
    tasks: {
      coding: { description: "Writing or fixing code", models: ["big", "mid"], thinking_level: "high", skills: ["shell"] },
      chat: { description: "Small talk" },
    },
    preloadSkills: true,
    ...over,
  };
}

const choice = (c: string, confidence: number) => ({ type: "choice" as const, choice: c, probabilities: {}, confidence });

test("routing questions: task choice with implicit other, skill choice with none, optional difficulty score", () => {
  const q = routingPoint.questions(input({ difficulty: { levels: ["easy", "hard"] } }), settings);
  assert.deepEqual(Object.keys(q), ["task", "difficulty", "skill"]);
  assert.deepEqual(Object.keys((q.task as any).criteria), ["coding", "chat", "other"]);
  assert.deepEqual(Object.keys((q.skill as any).criteria), ["shell", "media", "none"]);
  assert.deepEqual((q.difficulty as any).criteria, ["easy", "hard"]);
  const noSkills = routingPoint.questions(input({ preloadSkills: false, tasks: {} }), settings);
  assert.deepEqual(Object.keys(noSkills), []);
});

test("routing resolve: confident task → its cascade, thinking level, skills ∪ skill answer, tail files", () => {
  const v = routingPoint.resolve(
    { task: choice("coding", 0.9), skill: choice("media", 0.8) },
    input(),
    sameThreshold,
    settings,
  )!;
  assert.deepEqual(v, {
    task: "coding",
    models: ["big", "mid"],
    thinkingLevel: "high",
    skills: ["shell", "media"],
    tailFiles: [],
  });
});

test("routing resolve: `model` is shorthand for a one-entry cascade; skill `none` adds nothing", () => {
  const v = routingPoint.resolve(
    { task: choice("coding", 0.9), skill: choice("none", 0.9) },
    input({ tasks: { coding: { description: "x", model: "big", tail_files: ["tail/code.md"] } } }),
    sameThreshold,
    settings,
  )!;
  assert.deepEqual(v.models, ["big"]);
  assert.deepEqual(v.skills, []);
  assert.deepEqual(v.tailFiles, ["tail/code.md"]);
});

test("routing resolve: nothing confident → null (falls back to no routing)", () => {
  assert.equal(
    routingPoint.resolve({ task: choice("coding", 0.5), skill: choice("shell", 0.4) }, input(), sameThreshold, settings),
    null,
  );
  // A confident skill alone still routes (a preload, no model change).
  const v = routingPoint.resolve({ task: choice("coding", 0.5), skill: choice("shell", 0.9) }, input(), sameThreshold, settings)!;
  assert.deepEqual([v.task, v.models, v.skills], ["other", [], ["shell"]]);
});

test("routing resolve: difficulty routes only when no category matched", () => {
  const difficulty = { levels: ["a", "b", "c"], models: { "2": ["big"] }, thinking_levels: { "2": "xhigh" as const } };
  const answers = (task: string) => ({
    task: choice(task, 0.9),
    difficulty: { type: "score" as const, score: 2, probabilities: {}, confidence: 0.9 },
  });
  const other = routingPoint.resolve(answers("other"), input({ difficulty }), sameThreshold, settings)!;
  assert.deepEqual([other.models, other.thinkingLevel, other.difficulty], [["big"], "xhigh", 2]);
  const coding = routingPoint.resolve(answers("chat"), input({ difficulty }), sameThreshold, settings)!;
  assert.deepEqual(coding.models, [], "a matched category without models keeps normal selection");
});

test("routing state: request kept whole, recent packed newest-first to the budget", () => {
  const recent = Array.from({ length: 60 }, (_, i) => ({ id: `$r${i}`, from: `u${i}`, text: `message ${i} `.repeat(20) }));
  const state = routingPoint.state(input({ recent }), 600) as any;
  assert.equal(state.request.text, "write me a bash script");
  assert.ok(state.recent.length > 0 && state.recent.length < 60);
  assert.equal(state.recent.at(-1).from, "u59");
});

test("routingInputFrom: reply target, captions, self flag, recent limit", () => {
  const ev = (id: string, body: string, over: any = {}) => ({
    id,
    externalId: `$${id}`,
    timelineKey: "k",
    provider: "matrix",
    role: "user",
    sender: { id: `@${id}:x`, displayName: id.toUpperCase() },
    body,
    timestamp: 1,
    receivedAt: 1,
    ...over,
  });
  const trigger = ev("t", "what is this?", {
    replyTo: { sender: { id: "@b:x", displayName: "Bob" }, body: "look" },
    attachments: [{ id: "a", mediaType: "image", caption: "a cat" }],
  });
  const result = routingInputFrom({
    trigger: trigger as any,
    recent: [ev("a", "one"), ev("b", "two", { role: "assistant" }), trigger] as any,
    listedSkills: [{ name: "media", description: "d" }],
    routing: { recent_messages: 1, tasks: { x: { description: "X" } } },
  });
  assert.deepEqual(result.request.reply_to, { from: "Bob", text: "look" });
  assert.deepEqual(result.request.attachments, ["a cat"]);
  assert.equal(result.recent.length, 1);
  assert.equal(result.recent[0]!.self, true);
  assert.equal(result.preloadSkills, true);
});

// --- satellite ---------------------------------------------------------------

test("satellite: preloaded skills render right before <tail_instructions>, task tail files after", () => {
  const out = renderSatelliteBlock(
    {
      timelineKey: "k",
      trigger: { id: "e", timestamp: 1 } as any,
      activeSessions: [],
      suppressRuntimeState: true,
      routedSatellite: {
        preloadedSkills: [{ name: "shell", body: "Use bash.", tools: ["bash"] }],
        tailFiles: [{ source: "tail/code.md", content: "Code carefully." }],
      },
    },
    { tailContent: "Be brief." } as any,
  );
  const skill = out.indexOf('<preloaded_skill name="shell">');
  const tail = out.indexOf('<tail_instructions source="TAIL.md">');
  const extra = out.indexOf('<tail_instructions source="tail/code.md">');
  assert.ok(skill >= 0 && skill < tail && tail < extra, out);
  assert.match(out, /Tools enabled by this skill \(already loaded, directly callable\): bash\./);
  // Without routing the satellite is unchanged.
  const plain = renderSatelliteBlock(
    { timelineKey: "k", trigger: { id: "e", timestamp: 1 } as any, activeSessions: [], suppressRuntimeState: true },
    { tailContent: "Be brief." } as any,
  );
  assert.equal(plain, '<tail_instructions source="TAIL.md">\nBe brief.\n</tail_instructions>');
});

test("DynamicToolRegistry.loadInitial: loads silently, not immediate", () => {
  const tool = (name: string) => ({ name, description: name, parameters: {} }) as any;
  const reg = new DynamicToolRegistry([tool("a"), tool("b"), tool("c")], ["a"]);
  let changes = 0;
  reg.onChange = () => (changes += 1);
  assert.deepEqual(reg.loadInitial(["b", "zzz", "a"]), ["b"]);
  assert.deepEqual(reg.current.map((t) => t.name), ["a", "b"]);
  assert.equal(changes, 0);
  assert.equal(reg.immediateNames.has("b"), false);
});

// --- factory -----------------------------------------------------------------

function model(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    provider: "test",
    endpoint: "http://127.0.0.1:9",
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 4096,
    context_window: 128_000,
    reasoning: true,
    ...over,
  };
}

function factoryConfig(workspaceRoot: string, over: Record<string, unknown> = {}): any {
  return {
    app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
      tools: { dynamic: { enabled: true, immediate: ["send_message"], index: "orphans" } },
    },
    recovery: { llm_request_max_wait_ms: 1, llm_request_backoff_base_ms: 1, llm_request_backoff_max_ms: 1 },
    models: {
      default: model("def-wire", { thinking_level: "low" }),
      big: model("big-wire"),
      mid: model("mid-wire"),
      plain: model("plain-wire", { reasoning: false }),
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: workspaceRoot },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...over,
  };
}

function session(id = "s-route"): AgentSessionRecord {
  return {
    id,
    timelineKey: "matrix:a:room:!r",
    sessionType: "default",
    status: "running",
    trigger: {
      provider: "matrix",
      timelineKey: "matrix:a:room:!r",
      event: {
        id: "ev1",
        timelineKey: "matrix:a:room:!r",
        provider: "matrix",
        role: "user",
        sender: { id: "@u:hs" },
        body: "hi",
        timestamp: 10,
        receivedAt: 10,
      },
    } as any,
    createdAt: 0,
  };
}

function capturingBuilder(): { builder: ContextBuilder; calls: any[] } {
  const calls: any[] = [];
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "sys", tier: "system", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "hi", tier: "trigger", tokenEstimate: 1, timestamp: 10 },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  } as any;
  return {
    builder: { build: async (opts: any) => (calls.push(opts), built) } as unknown as ContextBuilder,
    calls,
  };
}

const fakeTool = (name: string) =>
  ({ name, label: name, description: `${name} tool`, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }) as any;

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-routing-"));
  try {
    await mkdir(path.join(root, "skills", "shell"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "shell", "SKILL.md"),
      "---\nname: shell\ndescription: Run shell commands\ntools:\n  - bash\n---\nUse bash carefully.\n",
    );
    await mkdir(path.join(root, "tail"), { recursive: true });
    await writeFile(path.join(root, "tail", "code.md"), "Code tail.\n");
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function verdict(over: Partial<RoutingVerdict> = {}): RoutingVerdict {
  return { ...NO_ROUTING, task: "coding", ...over };
}

test("factory: a routed cascade heads the session with its first viable entry", async () => {
  await withWorkspace(async (root) => {
    const { builder } = capturingBuilder();
    const factory = new AgentSessionFactory({
      config: factoryConfig(root),
      contextBuilder: builder,
      getActiveSessions: () => [],
      // "big" is over budget → skipped; "mid" heads.
      budget: { engine: { isModelAvailable: (id: string) => id !== "big" } } as any,
    });
    let calls = 0;
    const { agent } = await factory.create(session(), [fakeTool("send_message")], {
      route: async () => (calls++, verdict({ models: ["big", "mid"] })),
    });
    assert.equal(calls, 1);
    assert.equal(agent.state.model.id, "mid-wire");
  });
});

test("factory: every cascade entry exhausted → exactly today's selection", async () => {
  await withWorkspace(async (root) => {
    const { builder } = capturingBuilder();
    const factory = new AgentSessionFactory({
      config: factoryConfig(root),
      contextBuilder: builder,
      getActiveSessions: () => [],
      budget: { engine: { isModelAvailable: (id: string) => id === "default" } } as any,
    });
    const { agent } = await factory.create(session(), [fakeTool("send_message")], {
      route: async () => verdict({ models: ["big", "mid", "ghost"] }),
    });
    assert.equal(agent.state.model.id, "def-wire");
    assert.equal(agent.state.thinkingLevel, "low");
  });
});

test("factory: a routed thinking level applies to a reasoning head, is ignored on a non-reasoning one", async () => {
  await withWorkspace(async (root) => {
    const { builder } = capturingBuilder();
    const factory = new AgentSessionFactory({ config: factoryConfig(root), contextBuilder: builder, getActiveSessions: () => [] });
    const routed = await factory.create(session(), [fakeTool("send_message")], {
      route: async () => verdict({ thinkingLevel: "high" }),
    });
    assert.equal(routed.agent.state.model.id, "def-wire", "no cascade: default model, new effort");
    assert.equal(routed.agent.state.thinkingLevel, "high");
    const plain = await factory.create(session("s2"), [fakeTool("send_message")], {
      route: async () => verdict({ models: ["plain"], thinkingLevel: "high" }),
    });
    assert.equal(plain.agent.state.model.id, "plain-wire");
    assert.equal(plain.agent.state.thinkingLevel, "off");
  });
});

test("factory: skill preloads load tools before turn 1, render in the satellite, persist, and re-apply on resume", async () => {
  await withWorkspace(async (root) => {
    const { builder, calls } = capturingBuilder();
    const persisted = new Map<string, { skills: string[]; tools: string[] }>();
    const storage: any = {
      setSessionInitialPreloads: async (id: string, p: any) => void persisted.set(id, p),
      getSessionInitialPreloads: (id: string) => persisted.get(id),
    };
    const factory = new AgentSessionFactory({
      config: factoryConfig(root),
      contextBuilder: builder,
      getActiveSessions: () => [],
      storage,
    });
    const tools = [fakeTool("send_message"), fakeTool("bash"), fakeTool("web_fetch")];
    const fresh = await factory.create(session(), tools, {
      route: async ({ listedSkills }) => {
        assert.deepEqual(listedSkills.map((s) => s.name), ["shell"]);
        return verdict({ skills: ["shell", "ghost"], tailFiles: ["tail/code.md", "tail/missing.md"] });
      },
    });
    const names = fresh.agent.state.tools.map((t) => t.name);
    assert.ok(names.includes("bash"), `bash preloaded: ${names}`);
    assert.ok(!names.includes("web_fetch"));
    const sat = calls[0].routedSatellite;
    assert.deepEqual(sat.preloadedSkills.map((s: any) => [s.name, s.body, s.tools]), [["shell", "Use bash carefully.", ["bash"]]]);
    assert.deepEqual(sat.tailFiles, [{ source: "tail/code.md", content: "Code tail." }]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(persisted.get("s-route"), { skills: ["shell"], tools: ["bash"] });

    // Resume: no routing call, the persisted preloads are re-applied.
    let routedOnResume = false;
    const resumed = await factory.create(session(), tools, {
      resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any], transcript: [] },
      route: async () => ((routedOnResume = true), verdict({ models: ["big"] })),
    });
    assert.equal(routedOnResume, false);
    assert.ok(resumed.agent.state.tools.some((t) => t.name === "bash"));
    assert.equal(resumed.agent.state.model.id, "def-wire");
  });
});

test("factory: a declared-deferred head gets the preloaded tool definitions as text", async () => {
  await withWorkspace(async (root) => {
    const { builder, calls } = capturingBuilder();
    const config = factoryConfig(root);
    config.models.default.compat = { declare_deferred_tools: true };
    const factory = new AgentSessionFactory({ config, contextBuilder: builder, getActiveSessions: () => [] });
    await factory.create(session(), [fakeTool("send_message"), fakeTool("bash")], {
      route: async () => verdict({ skills: ["shell"] }),
    });
    assert.match(calls[0].routedSatellite.preloadedSkills[0].toolDefinitions, /^Tool definitions now loaded/);
  });
});

test("factory: no route (or a fallback verdict) leaves the build untouched", async () => {
  await withWorkspace(async (root) => {
    const { builder, calls } = capturingBuilder();
    const factory = new AgentSessionFactory({ config: factoryConfig(root), contextBuilder: builder, getActiveSessions: () => [] });
    const a = await factory.create(session(), [fakeTool("send_message"), fakeTool("bash")]);
    const b = await factory.create(session("s2"), [fakeTool("send_message"), fakeTool("bash")], { route: async () => undefined });
    assert.equal(calls[0].routedSatellite, undefined);
    assert.equal(calls[1].routedSatellite, undefined);
    assert.deepEqual(a.agent.state.tools.map((t) => t.name), b.agent.state.tools.map((t) => t.name));
    assert.equal(a.agent.state.model.id, b.agent.state.model.id);
  });
});

test("factory (per-user): the cascade is tried first; unaffordable entries fall through to the normal preference list", async () => {
  await withWorkspace(async (root) => {
    const { builder } = capturingBuilder();
    const factory = new AgentSessionFactory({ config: factoryConfig(root), contextBuilder: builder, getActiveSessions: () => [] });
    const probed: string[] = [];
    const selected: string[] = [];
    const engine: any = {
      affordable: (_r: unknown, id: string) => {
        probed.push(id);
        return id === "big" ? { ok: false, maxOutput: 0, remainingUsd: 0 } : { ok: true, maxOutput: 4096, remainingUsd: 1 };
      },
      bindingConstraint: () => undefined,
      noteSelection: (_s: string, _u: string, _r: string, m: string) => selected.push(m),
    };
    const resolution = { matched: true, active: true, banned: false, models: ["default"], constraints: [], ledgerPartitionKeys: [] } as unknown as UserLimitResolution;
    const ctx = { userId: "@u:hs", roomId: "!r" } as UserLimitContext;
    const { agent } = await factory.create(session(), [fakeTool("send_message")], {
      userLimit: { engine, resolution, ctx },
      route: async () => verdict({ models: ["big", "default"] }),
    });
    await agent.prompt({ role: "user", content: "hi", timestamp: 20 } as any).catch(() => {});
    assert.equal(probed[0], "big", "the cascade is probed first");
    assert.equal(selected[0], "default", "big unaffordable → normal selection");
  });
});

// --- storage: v21→v22 -----------------------------------------------------------

test("storage: v21→v22 adds agent_sessions.initial_preloads; set/get round-trip", async () => {
  const { Storage, LATEST_SCHEMA_VERSION } = await import("../src/storage/database.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-preloads-"));
  const dbPath = path.join(dir, "test.db");
  try {
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.insertAgentSession({
        id: "s1",
        timelineKey: "matrix:a:room:!r",
        sessionType: "default",
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as any);
      await storage.waitForIdle();
      await storage.write((db) => {
        db.exec("alter table agent_sessions drop column initial_preloads");
        db.pragma("user_version = 21");
      });
      await storage.waitForIdle();
      storage.close();
    }
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(storage.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
      assert.equal(storage.getSessionInitialPreloads("s1"), undefined, "existing rows stay unrouted");
      await storage.setSessionInitialPreloads("s1", { skills: ["shell"], tools: ["bash"] });
      await storage.waitForIdle();
      assert.deepEqual(storage.getSessionInitialPreloads("s1"), { skills: ["shell"], tools: ["bash"] });
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory: a resumed routed session keeps its routed model and effort", async () => {
  await withWorkspace(async (root) => {
    const { builder } = capturingBuilder();
    const persisted = new Map<string, any>();
    const storage: any = {
      setSessionInitialPreloads: async (id: string, p: any) => void persisted.set(id, p),
      getSessionInitialPreloads: (id: string) => persisted.get(id),
    };
    const factory = new AgentSessionFactory({ config: factoryConfig(root), contextBuilder: builder, getActiveSessions: () => [], storage });
    const fresh = await factory.create(session(), [fakeTool("send_message")], {
      route: async () => verdict({ models: ["mid"], thinkingLevel: "high" }),
    });
    assert.equal(fresh.agent.state.model.id, "mid-wire");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(persisted.get("s-route"), { skills: [], tools: [], model: "mid", thinkingLevel: "high" });
    const resumed = await factory.create(session(), [fakeTool("send_message")], {
      resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any], transcript: [] },
    });
    assert.equal(resumed.agent.state.model.id, "mid-wire");
    assert.equal(resumed.agent.state.thinkingLevel, "high");
    // An unrouted session persists nothing.
    await factory.create(session("plain"), [fakeTool("send_message")], { route: async () => verdict() });
    await new Promise((r) => setImmediate(r));
    assert.equal(persisted.has("plain"), false);
  });
});
