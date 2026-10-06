/**
 * Unit tests for the session-record service and helpers (spec SESSION-RECORDS §3).
 * The end-to-end behaviour (record turn, injection, folding, decisions) is
 * covered at app level in test/session-records-app.test.ts; this file pins the
 * pieces with their own contracts: eligibility, the in-flight registry
 * (synchronous registration, deadline-bounded waits, shutdown), builds_on,
 * failure classification, deferred-load injection, and the per-request
 * admission priority the record turn raises.
 */
import assert from "node:assert/strict";
import test from "node:test";

import http from "node:http";
import {
  buildsOnFromTranscript,
  classifyUnfinalizedRecordTurn,
  isEligibleForRecord,
  SessionRecordService,
  type StartRecordTurnParams,
} from "../src/agent/session-records.ts";
import { SummaryDraft } from "../src/tools/session-record-tool.ts";
import { AgentSessionFactory, withDeferredLoads } from "../src/agent/factory.ts";
import { LlmScheduler, type PriorityClass } from "../src/agent/scheduler.ts";
import type { DynamicToolRegistry } from "../src/agent/dynamic-tools.ts";
import type { BuiltContext, ContextBuilder } from "../src/context/index.ts";
import type { AgentSessionRecord } from "../src/agent/session-manager.ts";
import type { AppConfig } from "../src/config/index.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionRecordsConfig } from "../src/config/schema.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTranscriptWithTool(toolName: string): AgentMessage[] {
  // hasResumableWork checks for type === "toolCall" (internal agent format).
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: toolName,
          input: {},
        },
      ],
      timestamp: Date.now(),
    },
    {
      role: "tool",
      content: [{ type: "text", text: "ok" }],
      timestamp: Date.now(),
    },
  ] as AgentMessage[];
}

function emptyTranscript(): AgentMessage[] {
  return [];
}

const enabledConfig: SessionRecordsConfig = { enabled: true };
const disabledConfig: SessionRecordsConfig = { enabled: false };

// ── isEligibleForRecord ───────────────────────────────────────────────────────

test("isEligibleForRecord: disabled config → false", () => {
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("default", undefined, disabledConfig, transcript, new Set()),
    false,
  );
});

test("isEligibleForRecord: undefined config → enabled (default on)", () => {
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("default", undefined, undefined, transcript, new Set()),
    true,
  );
});

test("isEligibleForRecord: synthetic session type → false", () => {
  // "summarize" is in SYNTHETIC_SESSION_TYPES
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("summarize", undefined, enabledConfig, transcript, new Set()),
    false,
  );
});

test("isEligibleForRecord: proactive type matches config → true", () => {
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("proactive", "proactive", enabledConfig, transcript, new Set()),
    true,
  );
});

test("isEligibleForRecord: proactive type does not match → false", () => {
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("proactive", "something-else", enabledConfig, transcript, new Set()),
    false,
  );
});

test("isEligibleForRecord: default type → true regardless of proactiveSessionType", () => {
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("default", "proactive", enabledConfig, transcript, new Set()),
    true,
  );
});

test("isEligibleForRecord: no tool work → false (work gate)", () => {
  assert.equal(
    isEligibleForRecord("default", undefined, enabledConfig, emptyTranscript(), new Set()),
    false,
  );
});

test("isEligibleForRecord: tool work is exempt → false (work gate)", () => {
  const transcript = makeTranscriptWithTool("summary_tool");
  assert.equal(
    isEligibleForRecord("default", undefined, enabledConfig, transcript, new Set(["summary_tool"])),
    false,
  );
});

test("isEligibleForRecord: tool work is NOT exempt → true", () => {
  const transcript = makeTranscriptWithTool("read_file");
  assert.equal(
    isEligibleForRecord("default", undefined, enabledConfig, transcript, new Set(["summary_tool"])),
    true,
  );
});

// ── SessionRecordService in-flight registry ───────────────────────────────────

test("SessionRecordService: isInFlight false before any turn", () => {
  const svc = new SessionRecordService();
  assert.equal(svc.isInFlight("s-abc"), false);
});

test("SessionRecordService: waitFor resolves immediately when nothing registered", async () => {
  const svc = new SessionRecordService();
  // Should resolve without hanging
  await assert.doesNotReject(svc.waitFor("s-no-entry"));
});

// ── start(): registration, waits, shutdown ───────────────────────────────────

const quietLogger = () => {
  const lines: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const log = (message: string, fields?: Record<string, unknown>) => lines.push({ message, fields });
  return { lines, logger: { info: log, warn: log, error: log, debug: log } as unknown as StartRecordTurnParams["logger"] };
};

/** A stub agent whose prompt resolves when `release()` (or abort) is called. */
function stubAgent(messages: AgentMessage[]) {
  let release!: () => void;
  const prompted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agent = {
    state: {
      messages,
      errorMessage: undefined as string | undefined,
      model: { api: "openai-completions", provider: "p", id: "m" },
      tools: [{ name: "session_record_tool" }],
    },
    hasQueuedMessages: () => false,
    clearAllQueues: () => {},
    subscribe: () => () => {},
    prompt: async (kickoff: AgentMessage[]) => {
      agent.state.messages.push(...kickoff);
      await prompted;
    },
    waitForIdle: async () => {},
    abort: () => {
      agent.state.errorMessage = "aborted";
      release();
    },
  };
  return { agent: agent as unknown as StartRecordTurnParams["agent"], release };
}

function startParams(over: Partial<StartRecordTurnParams> & Pick<StartRecordTurnParams, "agent" | "logger">): StartRecordTurnParams {
  return {
    sessionId: "s1",
    timelineKey: "matrix:a:room:!r",
    sessionType: "default",
    proactiveSessionType: "proactive",
    agentName: null,
    handles: { gate: { active: false }, draft: new SummaryDraft() },
    config: { enabled: true },
    exemptToolNames: new Set(),
    storage: { upsertSessionRecord: async () => assert.fail("no row expected") } as unknown as StartRecordTurnParams["storage"],
    ...over,
  };
}

test("SessionRecordService.start: an ineligible session registers nothing", () => {
  const svc = new SessionRecordService();
  const { logger } = quietLogger();
  const { agent } = stubAgent(emptyTranscript());
  assert.equal(svc.start(startParams({ agent, logger })), undefined);
  assert.equal(svc.isInFlight("s1"), false);
});

test("SessionRecordService.start: no record tool in the catalog → skipped, nothing registered (Z2)", () => {
  const svc = new SessionRecordService();
  const { logger, lines } = quietLogger();
  const { agent } = stubAgent(makeTranscriptWithTool("web_fetch"));
  (agent.state as { tools: unknown[] }).tools = [{ name: "web_fetch" }];
  assert.equal(svc.start(startParams({ agent, logger })), undefined);
  assert.equal(svc.isInFlight("s1"), false);
  assert.ok(lines.some((l) => l.message === "session_record_skipped" && l.fields?.reason === "tool_unavailable"));
  // Under dynamic loading the registry's catalog decides.
  const registry = { inCatalog: () => false } as unknown as DynamicToolRegistry;
  const { agent: second } = stubAgent(makeTranscriptWithTool("web_fetch"));
  assert.equal(svc.start(startParams({ agent: second, logger, registry })), undefined);
});

test("SessionRecordService.start: the in-flight entry is registered before start returns (L5)", async () => {
  const svc = new SessionRecordService();
  const { logger, lines } = quietLogger();
  const { agent, release } = stubAgent(makeTranscriptWithTool("web_fetch"));
  const handles = { gate: { active: false }, draft: new SummaryDraft() };
  const run = svc.start(startParams({ agent, logger, handles }));
  assert.ok(run);
  // Synchronously visible: a trigger launched right after (the slot release) sees it.
  assert.equal(svc.isInFlight("s1"), true);
  assert.equal(svc.inFlightCount, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(handles.gate.active, true, "gate open while the turn runs");
  release();
  await run;
  assert.equal(svc.isInFlight("s1"), false);
  assert.equal(handles.gate.active, false, "gate closed after the turn");
  // Ended without finalize → failed, no row (the stub storage would throw).
  assert.ok(lines.some((l) => l.message === "session_record_failed" && l.fields?.reason === "not_finalized"));
});

test("SessionRecordService.waitFor: bounded by the entry's deadline", async () => {
  const svc = new SessionRecordService();
  const { logger } = quietLogger();
  const { agent, release } = stubAgent(makeTranscriptWithTool("web_fetch"));
  const run = svc.start(startParams({ agent, logger, config: { enabled: true, wait_timeout_ms: 60, timeout_ms: 60_000 } }));
  const t0 = Date.now();
  assert.equal(await svc.waitFor("s1"), false);
  assert.equal(svc.isInFlight("s1"), true);
  assert.equal(agent.state.errorMessage, undefined, "waiting does not abort production");
  const waited = Date.now() - t0;
  assert.ok(waited < 1000, `waitFor returned at the deadline (${waited} ms)`);
  release();
  await run;
});

test("SessionRecordService.waitFor: graceMs waits for the turn to settle past its deadline (Z3)", async () => {
  const svc = new SessionRecordService();
  const { logger } = quietLogger();
  // Production can finish after the ordinary wait expires.
  const slow = stubAgent(makeTranscriptWithTool("web_fetch"));
  setTimeout(slow.release, 150);
  const run = svc.start(startParams({ agent: slow.agent, logger, config: { enabled: true, timeout_ms: 60 } }));
  assert.equal(await svc.waitFor("s1", { graceMs: 2000 }), true, "settled within the grace");
  assert.equal(svc.isInFlight("s1"), false);
  await run;
  // A turn that never settles: false once the grace elapsed.
  const stuck = stubAgent(makeTranscriptWithTool("web_fetch"));
  (stuck.agent as unknown as { abort: () => void }).abort = () => {};
  const run2 = svc.start(startParams({ sessionId: "s2", agent: stuck.agent, logger, config: { enabled: true, timeout_ms: 60 } }));
  assert.equal(await svc.waitFor("s2", { graceMs: 50 }), false);
  assert.equal(svc.isInFlight("s2"), true);
  stuck.release();
  await run2;
  assert.equal(await svc.waitFor("s2"), true, "nothing registered → true");
});

test("SessionRecordService.shutdown: aborts the running turn and refuses new ones", async () => {
  const svc = new SessionRecordService();
  const { logger, lines } = quietLogger();
  const { agent } = stubAgent(makeTranscriptWithTool("web_fetch"));
  const run = svc.start(startParams({ agent, logger }));
  await new Promise((r) => setImmediate(r));
  svc.shutdown();
  await run;
  assert.ok(lines.some((l) => l.message === "session_record_failed" && l.fields?.reason === "shutdown"));
  const second = stubAgent(makeTranscriptWithTool("web_fetch"));
  await svc.start(startParams({ sessionId: "s2", agent: second.agent, logger }));
  assert.ok(lines.some((l) => l.fields?.sessionId === "s2" && l.fields?.reason === "shutdown"));
});

test("SessionRecordService.start: the flush runs before waiters are released", async () => {
  const svc = new SessionRecordService();
  const { logger } = quietLogger();
  const { agent, release } = stubAgent(makeTranscriptWithTool("web_fetch"));
  let flushed = false;
  const run = svc.start(
    startParams({
      agent,
      logger,
      flush: async () => {
        await new Promise((r) => setTimeout(r, 20));
        flushed = true;
      },
    }),
  );
  const waiter = svc.waitFor("s1").then(() => flushed);
  release();
  assert.equal(await waiter, true, "a waiter never sees the turn before its transcript flush");
  await run;
});

// ── builds_on (J4) ────────────────────────────────────────────────────────────

function injectionPair(id: string, sessionId: string, result: { isError: boolean; details: unknown }): AgentMessage[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: "read_session_record", arguments: { session_id: sessionId } }], harness: { kind: "injection" } },
    { role: "toolResult", toolCallId: id, toolName: "read_session_record", content: [{ type: "text", text: "x" }], isError: result.isError, details: result.details, harness: { kind: "injection" } },
  ] as unknown as AgentMessage[];
}

test("buildsOnFromTranscript: only injected records that were delivered", () => {
  const transcript = [
    ...injectionPair("a", "s-ok", { isError: false, details: { session_id: "s-ok" } }),
    ...injectionPair("b", "s-err", { isError: true, details: null }),
    ...injectionPair("c", "s-none", { isError: false, details: null }),
    // The agent's own (non-harness) read does not count as builds_on.
    { role: "assistant", content: [{ type: "toolCall", id: "d", name: "read_session_record", arguments: { session_id: "s-own" } }] },
    { role: "toolResult", toolCallId: "d", toolName: "read_session_record", content: [], isError: false, details: { session_id: "s-own" } },
  ] as unknown as AgentMessage[];
  assert.deepEqual(buildsOnFromTranscript(transcript), ["s-ok"]);
});

// ── failure classification (K4) ────────────────────────────────────────────────

test("classifyUnfinalizedRecordTurn: refusal, budget, error, not finalized", () => {
  assert.equal(classifyUnfinalizedRecordTurn("refusal", "The model refused to complete the request"), "refusal");
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "Provider finish_reason: content_filter"), "refusal");
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "[llm-request:content] session cost limit exceeded: observed"), "budget_blocked");
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "per-user budget exhausted: no affordable model"), "budget_blocked");
  assert.equal(classifyUnfinalizedRecordTurn(undefined, "500 upstream"), "llm_error");
  assert.equal(classifyUnfinalizedRecordTurn(undefined, undefined), "not_finalized");
});

// ── injections reach tools on the wire (K7/P1) ────────────────────────────────

test("withDeferredLoads: a deferred injection target is loaded by a synthetic tool_search first", () => {
  const registry = {
    inCatalog: (n: string) => ["read_session_record", "load_skill"].includes(n),
    isLoaded: (n: string) => n === "load_skill",
  } as unknown as DynamicToolRegistry;
  const spec = { name: "read_session_record", params: { session_id: "s" }, harness: { kind: "injection" as const, decisionGroup: "g" } };
  const out = withDeferredLoads([spec], registry);
  assert.deepEqual(out[0], { name: "tool_search", params: { query: "select:read_session_record" }, harness: spec.harness });
  assert.deepEqual(out[1], spec);
  // Loaded already, or no dynamic loading: unchanged.
  assert.deepEqual(withDeferredLoads([{ ...spec, name: "load_skill" }], registry), [{ ...spec, name: "load_skill" }]);
  assert.deepEqual(withDeferredLoads([spec], undefined), [spec]);
});

// ── setPriority: admission class read per request (K11) ───────────────────────

test("factory setPriority changes the admission class of the agent's later requests", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
      chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const scheduler = new LlmScheduler();
    const seen: PriorityClass[] = [];
    const acquire = scheduler.acquire.bind(scheduler);
    scheduler.acquire = ((opts: Parameters<LlmScheduler["acquire"]>[0]) => {
      seen.push(opts.priority);
      return acquire(opts);
    }) as LlmScheduler["acquire"];
    const config = {
      app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
      agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
      models: {
        default: {
          id: "m", provider: "p", api: "openai-completions", endpoint: `http://127.0.0.1:${port}/v1`,
          api_key: "k", input_modalities: ["text"], max_tokens: 100, context_window: 128_000,
        },
      },
      context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
      storage: { database_path: ":memory:" },
      workspace: { root_dir: "/tmp" },
      matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    } as unknown as AppConfig;
    const built = {
      messages: [
        { type: "system", role: "system", content: "s", tier: "system", tokenEstimate: 1 },
        { type: "triggerGroup", role: "user", content: "hi", tier: "trigger", tokenEstimate: 1, timestamp: 1 },
      ],
      tokenEstimate: 2,
      compactTokens: 0,
      richTokens: 0,
      imageBlocks: [],
    } as unknown as BuiltContext;
    const factory = new AgentSessionFactory({
      config,
      contextBuilder: { build: async () => built } as unknown as ContextBuilder,
      getActiveSessions: () => [],
      scheduler,
    });
    const session = {
      id: "s", timelineKey: "matrix:a:room:!r", sessionType: "default", status: "running", createdAt: 0,
      trigger: { provider: "matrix", timelineKey: "matrix:a:room:!r", event: { id: "t", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user", sender: { id: "u" }, body: "hi", timestamp: 1, receivedAt: 1 } },
    } as unknown as AgentSessionRecord;
    const created = await factory.create(session, [], { priority: "background" });
    await created.agent.prompt(created.kickoff!);
    created.setPriority("interactive");
    await created.agent.prompt({ role: "user", content: "again", timestamp: 2 } as AgentMessage);
    assert.deepEqual(seen, ["background", "interactive"]);
    scheduler.stop();
  } finally {
    server.close();
  }
});


test("record shutdown persists its outcome on the harness marker before flushing", async () => {
  const svc = new SessionRecordService();
  const { logger } = quietLogger();
  const { agent } = stubAgent(makeTranscriptWithTool("web_fetch"));
  let flushed = false;
  const run = svc.start(startParams({ agent, logger, config: { enabled: true, timeout_ms: 10 }, flush: async () => {
    const marker = agent.state.messages.find((m) => (m as any).harness?.kind === "record_turn") as any;
    assert.deepEqual(marker.harness, { kind: "record_turn", status: "failed", reason: "shutdown" });
    flushed = true;
  } }));
  svc.shutdown();
  await run;
  assert.equal(flushed, true);
});

test("record settle barrier includes asynchronous post-write judging", async () => {
 const svc = new SessionRecordService();
 const { logger } = quietLogger();
 const { agent } = stubAgent(makeTranscriptWithTool("web_fetch"));
 const draft = new SummaryDraft();
 draft.create("synthetic record");
 let listener: (event: any) => void = () => {};
 (agent as any).subscribe = (fn: typeof listener) => { listener = fn; return () => {}; };
 (agent as any).prompt = async (messages: AgentMessage[]) => {
   agent.state.messages.push(...messages);
   listener({ type: "tool_execution_end", toolName: "session_record_tool", isError: false, result: { terminate: true } });
 };
 let finishJudge!: () => void;
 let enteredJudge!: () => void;
 const entered = new Promise<void>((resolve) => { enteredJudge = resolve; });
 const judge = new Promise<void>((resolve) => { finishJudge = resolve; });
 const run = svc.start(startParams({ agent, logger, handles: { gate: { active: false }, draft },
   storage: { upsertSessionRecord: async () => {} } as any,
   onRecordWritten: async () => { enteredJudge(); await judge; },
 }));
 await entered;
 let settled = false;
 const barrier = svc.settled("s1").then(() => { settled = true; });
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(settled, false);
 finishJudge();
 await run;
 await barrier;
 assert.equal(settled, true);
});
