import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { AgentSessionFactory, type CreatedAgent } from "../src/agent/factory.js";
import { createRedoHandler } from "../src/agent/redo.js";
import { SessionRunner, SessionRunnerError } from "../src/agent/runner.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import { createActingPolicy } from "../src/checks/acting-policy.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import type { AppConfig } from "../src/config/index.js";
import type { BuiltContext, ContextBuilder } from "../src/context/builder.js";
import type { SessionLiveEvent } from "../src/observability/live-events.js";
import { normalizeRefusalRules } from "../src/refusals/rules.js";
import { createSoftRefusalRedoHandler } from "../src/refusals/soft-redo.js";
import { Storage } from "../src/storage/index.js";
import { createNoReplyTool } from "../src/tools/no-reply.js";

// ---------------------------------------------------------------------------
// Soft refusals end to end (spec REFUSAL-HANDLING phase 4): a message judged a
// refusal at the send gate (an operator refusal check with a pattern, so no
// decision model is needed) is held, not sent, and the turn is discarded and
// redone on a [[refusal_fallback]] rule's model through the real factory, gate,
// acting policy, runner redo loop and fork core. Upstreams are a local stub
// that plays a script of assistant turns per model.
// ---------------------------------------------------------------------------

/** One scripted assistant turn: text, tool calls, or a provider content filter. */
interface Step {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  filter?: boolean;
}

interface Stub {
  port: number;
  /** Model prefixes in request order. */
  served: string[];
  bodies: any[];
  close: () => Promise<void>;
}

async function scriptedServer(script: Record<string, Step[]>): Promise<Stub> {
  const served: string[] = [];
  const bodies: any[] = [];
  let callSeq = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const prefix = (req.url ?? "").split("/")[1]!;
      served.push(prefix);
      bodies.push(JSON.parse(raw));
      const step = script[prefix]?.shift() ?? { text: "NO_REPLY" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: `${prefix}-wire`, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      if (step.filter) {
        chunk({ role: "assistant", content: "" }, null);
        chunk({}, "content_filter");
      } else if (step.calls) {
        chunk(
          {
            role: "assistant",
            ...(step.text ? { content: step.text } : {}),
            tool_calls: step.calls.map((c, index) => ({
              index,
              id: `call_${++callSeq}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          null,
        );
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: step.text ?? "" }, null);
        chunk({}, "stop");
      }
      res.write(
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    served,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function oai(port: number, prefix: string) {
  return {
    id: `${prefix}-wire`,
    provider: "test",
    api: "openai-completions",
    endpoint: `http://127.0.0.1:${port}/${prefix}/v1`,
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 256,
    context_window: 128_000,
    cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
  };
}

const KICKOFF = "<system>\nTAIL.md\n</system>\n\n<message>write it</message>";
const REFUSAL = "(?i)\\bcan't help\\b";

interface Env {
  stub: Stub;
  storage: Storage;
  sent: string[];
  reacted: string[];
  live: SessionLiveEvent[];
  logs: Array<[string, any]>;
  /** Ledger rows (budget.record). */
  recorded: any[];
  create(id: string, opts?: { sessionType?: string; proactive?: boolean; refusalPin?: { rule: string; model: string; at: number } }): Promise<CreatedAgent>;
  run(created: CreatedAgent, id: string, opts?: { retries?: number; contractRedo?: boolean; sessionType?: string }): Promise<{ noReply: boolean }>;
}

async function withEnv(
  o: { script: Record<string, Step[]>; rules: Array<Record<string, unknown>>; checks?: Record<string, unknown> },
  fn: (env: Env) => Promise<void>,
): Promise<void> {
  const stub = await scriptedServer(o.script);
  const storage = await Storage.open({ databasePath: ":memory:" });
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-soft-"));
  await writeFile(path.join(root, "AGENTS.md"), "Be nice.\n");
  const logs: Array<[string, any]> = [];
  const logger: any = {
    info: (e: string, f: any) => logs.push([e, f]),
    warn: (e: string, f: any) => logs.push([e, f]),
    error: (e: string, f: any) => logs.push([e, f]),
    debug() {},
    child: () => logger,
  };
  const live: SessionLiveEvent[] = [];
  const recorded: any[] = [];
  const config = {
    app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 1 }, system: {} },
    recovery: { llm_request_max_wait_ms: 5000, llm_request_backoff_base_ms: 1, llm_request_backoff_max_ms: 1 },
    models: { default: oai(stub.port, "a"), model_b: oai(stub.port, "b"), model_c: oai(stub.port, "c") },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: root },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    checks: o.checks ?? { refusal_canned: { kind: "refusal", reason: "capability", patterns: [REFUSAL] } },
    refusal_fallback: o.rules,
  } as unknown as AppConfig;
  const catalogue = buildCheckCatalogue(config);
  const evaluator = new CheckEvaluator({ catalogue, config, storage, logger });
  const built = {
    messages: [
      { type: "system", role: "system", content: "SYSTEM", tier: "system", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: KICKOFF, tier: "trigger", tokenEstimate: 1, timestamp: 1 },
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
    storage,
    logger,
    budget: { record: (event: unknown) => recorded.push(event) } as any,
    liveEvents: { publish: (_id: string, event: SessionLiveEvent) => live.push(event) } as any,
    refusals: { catalogue, rules: normalizeRefusalRules(config) },
    outputChecks: {
      evaluator,
      logger,
      actingPolicy: (_session, handles) => createActingPolicy({ ...handles, logger }),
    },
  });
  const sent: string[] = [];
  const reacted: string[] = [];
  const tools = () => [
    {
      name: "send_message",
      label: "send",
      description: "send a message",
      parameters: Type.Object({ message: Type.String() }),
      execute: async (_id: string, params: any) => {
        sent.push(params.message);
        // A final send ends the turn (like send_message with final = true).
        return { content: [{ type: "text" as const, text: "sent: $e1" }], details: {}, terminate: true };
      },
    },
    {
      name: "react",
      label: "react",
      description: "react to a message",
      parameters: Type.Object({ emoji: Type.String() }),
      execute: async (_id: string, params: any) => {
        reacted.push(params.emoji);
        return { content: [{ type: "text" as const, text: "reacted" }], details: {} };
      },
    },
    createNoReplyTool(),
  ];
  const session = (id: string, sessionType = "default"): AgentSessionRecord =>
    ({
      id,
      timelineKey: "matrix:a:room:!r",
      sessionType,
      status: "running",
      trigger: {
        provider: "matrix",
        timelineKey: "matrix:a:room:!r",
        event: { id: "e", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user", sender: { id: "@u:hs" }, body: "hi", timestamp: 1, receivedAt: 1 },
      },
      createdAt: 0,
    }) as unknown as AgentSessionRecord;
  const env: Env = {
    stub,
    storage,
    sent,
    reacted,
    live,
    logs,
    recorded,
    async create(id, opts = {}) {
      await storage.insertAgentSession({
        id, timelineKey: "matrix:a:room:!r", sessionType: opts.sessionType ?? "default", status: "running", createdAt: 1, updatedAt: 1,
      });
      return factory.create(session(id, opts.sessionType), tools() as any, {
        ...(opts.proactive ? { proactive: true } : {}),
        ...(opts.refusalPin ? { refusalPin: opts.refusalPin } : {}),
      });
    },
    async run(created, id, opts = {}) {
      const fork = created.forkContext({ storage, flushTranscript: async () => {}, logger });
      const onRefusal = createSoftRefusalRedoHandler({ storage, ...(created.gate ? { gate: created.gate } : {}), logger });
      const runner = new SessionRunner({
        redo: { control: created.redoControl, onRedo: createRedoHandler({ fork, logger, onRefusal }) },
        contractRedo: opts.contractRedo ?? false,
        ...(created.gate ? { endings: created.gate } : {}),
        logger,
      });
      return runner.run(created.agent, session(id, opts.sessionType), opts.retries ?? 1, created.kickoff);
    },
  };
  try {
    await fn(env);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
}

const send = (message: string): Step => ({ calls: [{ name: "send_message", args: { message } }] });
const REFUSED = "Sorry, I can't help with that.";
const rule = (over: Record<string, unknown> = {}) => ({ name: "capability_redo", reasons: ["capability"], models: ["model_b"], ...over });

async function settled(storage: Storage, id: string) {
  await storage.waitForIdle();
  return {
    branches: storage.listSessionBranches(id),
    refusals: storage.listRefusalEvents(id),
    decisions: storage.getDecisionEvaluationsForSession(id),
  };
}

const liveText = (created: CreatedAgent): string => JSON.stringify(created.agent.state.messages);

// ── Soft redo at a send ──────────────────────────────────────────────────────

test("soft redo at a send: the refused message is held and never sent; the turn is redone on the rule's model", async () => {
  await withEnv(
    { script: { a: [send(REFUSED)], b: [send("Here it is.")] }, rules: [rule()] },
    async ({ stub, storage, sent, live, create, run }) => {
      const created = await create("s1");
      const result = await run(created, "s1");
      assert.deepEqual(sent, ["Here it is."], "only the redo's message reached the chat");
      assert.deepEqual(stub.served, ["a", "b"], "one request on the refusing model, then the redo model");
      assert.equal(result.noReply, false);
      assert.equal(created.refusal.pinnedModel(), "model_b", "the session stays on the redo model (§8.3)");
      assert.ok(!liveText(created).includes("can't help"), "the refused message left the live transcript");
      // The redo request saw no trace of the refused message.
      assert.ok(!JSON.stringify(stub.bodies[1]).includes("can't help"));

      const { branches, refusals, decisions } = await settled(storage, "s1");
      assert.equal(branches.length, 1);
      assert.equal(branches[0]!.reason, "refusal_redo");
      assert.equal(branches[0]!.check_code, "refusal_canned");
      assert.equal(branches[0]!.from_model, "default");
      assert.equal(branches[0]!.to_model, "model_b");
      assert.match(branches[0]!.messages_json, /can't help/, "the discarded span is kept as the branch");
      assert.equal(refusals.length, 1);
      assert.equal(refusals[0]!.kind, "soft");
      assert.equal(refusals[0]!.outcome, "redo");
      assert.equal(refusals[0]!.rule_name, "capability_redo");
      assert.equal(refusals[0]!.to_model, "model_b");
      assert.equal(refusals[0]!.method, "pattern");
      assert.equal(refusals[0]!.checkpoint, "send");
      assert.equal(refusals[0]!.branch_no, 1, "re-anchored to the branch the refused message lives in");
      const refusedRow = decisions.find((d) => d.consequence === "redo")!;
      assert.equal(refusedRow.branch_no, 1);
      assert.equal(refusedRow.checkpoint, "send");
      assert.equal(refusals[0]!.decision_evaluation_id, refusedRow.id);
      assert.equal(branches[0]!.decision_evaluation_id, refusedRow.id);
      const forked = live.find((e) => e.type === "branch_forked") as any;
      assert.deepEqual(
        { branchNo: forked.branchNo, reason: forked.reason, checkCode: forked.checkCode, fromModel: forked.fromModel, toModel: forked.toModel },
        { branchNo: 1, reason: "refusal_redo", checkCode: "refusal_canned", fromModel: "default", toModel: "model_b" },
      );
    },
  );
});

test("hold only when a verdict could act: no matching rule → the refused message is sent, recorded observed", async () => {
  await withEnv(
    // The only rule is for another reason: nothing can act on a capability refusal.
    { script: { a: [send(REFUSED)] }, rules: [rule({ reasons: ["distillation"] })] },
    async ({ storage, sent, create, run }) => {
      const created = await create("s2");
      await run(created, "s2");
      assert.deepEqual(sent, [REFUSED]);
      const { branches, refusals, decisions } = await settled(storage, "s2");
      assert.equal(branches.length, 0);
      assert.deepEqual(refusals.map((r) => r.outcome), ["observed"]);
      assert.deepEqual(decisions.map((d) => d.consequence), ["observed"]);
    },
  );
});

test("soft redo with siblings: an irreversible sibling stays with its result (sibling edit); a redo-safe one is redone", async () => {
  await withEnv(
    {
      script: {
        a: [{ calls: [{ name: "react", args: { emoji: "👍" } }, { name: "send_message", args: { message: REFUSED } }] }],
        b: [send("Done properly.")],
      },
      rules: [rule()],
    },
    async ({ storage, sent, reacted, create, run }) => {
      const created = await create("s3");
      await run(created, "s3");
      assert.deepEqual(reacted, ["👍"], "the sibling ran once and was not redone");
      assert.deepEqual(sent, ["Done properly."]);
      const messages = created.agent.state.messages as any[];
      const edited = messages.find((m) => m.role === "assistant" && m.content.some((b: any) => b.name === "react"));
      assert.deepEqual(edited.content.map((b: any) => `${b.type}:${b.name ?? ""}`), ["toolCall:react"], "the gated call and the text are removed");
      assert.ok(messages.some((m) => m.role === "toolResult" && m.toolName === "react"), "the sibling keeps its result");
      assert.ok(!messages.some((m) => m.role === "toolResult" && m.toolName === "send_message" && m.isError));
      const { branches } = await settled(storage, "s3");
      assert.equal(branches.length, 1);
      const span = JSON.parse(branches[0]!.messages_json);
      assert.ok(span[0].content.some((b: any) => b.name === "send_message"), "the branch keeps the original message");
    },
  );
});

test("soft redo after an already-delivered sibling send: the delivered message stays, only the refused one is redone", async () => {
  await withEnv(
    {
      script: {
        a: [{ calls: [{ name: "send_message", args: { message: "First part." } }, { name: "send_message", args: { message: REFUSED } }] }],
        b: [send("Second part, done.")],
      },
      rules: [rule()],
    },
    async ({ storage, sent, create, run }) => {
      const created = await create("s4");
      await run(created, "s4");
      assert.deepEqual(sent, ["First part.", "Second part, done."]);
      const live = JSON.stringify(created.agent.state.messages);
      assert.match(live, /First part\./);
      assert.ok(!live.includes("can't help"));
      const { branches, decisions } = await settled(storage, "s4");
      assert.equal(branches.length, 1);
      // The delivered sibling's row stays on the live branch; the refused one moved.
      const byConsequence = Object.fromEntries(decisions.map((d) => [d.consequence, d.branch_no]));
      assert.equal(byConsequence["redo"], 1);
    },
  );
});

test("second entry refuses too → the rule's next entry", async () => {
  await withEnv(
    { script: { a: [send(REFUSED)], b: [send("I really can't help.")], c: [send("Sure.")] }, rules: [rule({ models: ["model_b", "model_c"] })] },
    async ({ stub, storage, sent, create, run }) => {
      const created = await create("s5");
      await run(created, "s5");
      assert.deepEqual(stub.served, ["a", "b", "c"]);
      assert.deepEqual(sent, ["Sure."]);
      assert.equal(created.refusal.pinnedModel(), "model_c");
      const { branches, refusals } = await settled(storage, "s5");
      assert.deepEqual(branches.map((b) => [b.from_model, b.to_model]), [["default", "model_b"], ["model_b", "model_c"]]);
      assert.deepEqual(refusals.map((r) => [r.served_model, r.outcome, r.to_model]), [
        ["default", "redo", "model_b"],
        ["model_b", "redo", "model_c"],
      ]);
    },
  );
});

test("@same with tries: the refusing model is retried, then the rule is exhausted (send_last sends the last attempt)", async () => {
  await withEnv(
    {
      script: { a: [send(REFUSED), send("Still can't help."), send("No, I can't help.")] },
      rules: [rule({ models: [{ model: "@same", tries: 2 }] })],
    },
    async ({ stub, storage, sent, create, run }) => {
      const created = await create("s6");
      await run(created, "s6");
      assert.deepEqual(stub.served, ["a", "a", "a"], "two same-model retries, fresh samples");
      assert.deepEqual(sent, ["No, I can't help."], "exhausted: the last attempt is sent");
      assert.equal(created.refusal.pinnedModel(), undefined, "a same-model retry never moves the pin");
      const { branches, refusals, decisions } = await settled(storage, "s6");
      assert.equal(branches.length, 2);
      assert.deepEqual(refusals.map((r) => r.outcome), ["redo", "redo", "exhausted_send_last"]);
      assert.equal(decisions.at(-1)!.consequence, "sent");
    },
  );
});

test("on_exhausted = withhold: nothing is sent, the session settles NO_REPLY with no notice", async () => {
  await withEnv(
    { script: { a: [send(REFUSED)], b: [send("Can't help, sorry.")] }, rules: [rule({ on_exhausted: "withhold" })] },
    async ({ storage, sent, create, run }) => {
      const created = await create("s7");
      const result = await run(created, "s7");
      assert.deepEqual(sent, []);
      assert.equal(result.noReply, true);
      const { refusals, decisions } = await settled(storage, "s7");
      assert.deepEqual(refusals.map((r) => r.outcome), ["redo", "exhausted_withheld"]);
      assert.equal(decisions.at(-1)!.consequence, "withheld");
    },
  );
});

test("on_exhausted = park: nothing is sent and the run fails as a refusal (parked)", async () => {
  await withEnv(
    { script: { a: [send(REFUSED), send(REFUSED)] }, rules: [rule({ models: [{ model: "@same", tries: 1 }], on_exhausted: "park" })] },
    async ({ storage, sent, create, run }) => {
      const created = await create("s8");
      // One same-model try, then exhausted.
      await assert.rejects(
        () => run(created, "s8"),
        (error: unknown) => error instanceof SessionRunnerError && error.phase === "llm" && error.llmClass === "refusal",
      );
      assert.deepEqual(sent, []);
      const { refusals } = await settled(storage, "s8");
      assert.deepEqual(refusals.map((r) => r.outcome), ["redo", "exhausted_parked"]);
    },
  );
});

// ── Endings ──────────────────────────────────────────────────────────────────

test("ending: forced-completion exhaustion judged first — a refusal redoes on the rule's model, not the contract redo", async () => {
  await withEnv(
    {
      script: { a: [{ text: "I can't help with writing that." }, { text: "Again, I can't help." }], b: [send("Written.")] },
      rules: [rule()],
    },
    async ({ storage, sent, create, run }) => {
      const created = await create("s9");
      await run(created, "s9", { retries: 1, contractRedo: true });
      assert.deepEqual(sent, ["Written."]);
      const { branches, refusals } = await settled(storage, "s9");
      assert.deepEqual(branches.map((b) => b.reason), ["refusal_redo"], "the refusal redo took precedence");
      assert.equal(refusals[0]!.checkpoint, "ending");
      assert.equal(refusals[0]!.outcome, "redo");
      assert.equal(refusals[0]!.branch_no, 1, "the ending's rows moved with the discarded span");
    },
  );
});

test("ending: exhaustion without a refusal keeps the same-model contract redo", async () => {
  await withEnv(
    {
      script: { a: [{ text: "Here is my answer as text." }, { text: "Still text." }, send("Sent this time.")] },
      rules: [rule()],
    },
    async ({ stub, storage, sent, create, run }) => {
      const created = await create("s10");
      await run(created, "s10", { retries: 1, contractRedo: true });
      assert.deepEqual(sent, ["Sent this time."]);
      assert.deepEqual(stub.served, ["a", "a", "a"]);
      const { branches } = await settled(storage, "s10");
      assert.deepEqual(branches.map((b) => b.reason), ["contract_redo"]);
    },
  );
});

test("ending: a no_reply call judged a refusal (its analysis) is redone on the rule's model", async () => {
  await withEnv(
    {
      script: { a: [{ calls: [{ name: "no_reply", args: { analysis: "I can't help with this request." } }] }], b: [send("Answered.")] },
      rules: [rule()],
    },
    async ({ storage, sent, create, run }) => {
      const created = await create("s11");
      const result = await run(created, "s11");
      assert.deepEqual(sent, ["Answered."]);
      assert.equal(result.noReply, false);
      const { branches, refusals } = await settled(storage, "s11");
      assert.deepEqual(branches.map((b) => b.reason), ["refusal_redo"]);
      assert.equal(refusals[0]!.checkpoint, "ending");
      assert.equal(refusals[0]!.source, "analysis");
    },
  );
});

// ── Tasks ────────────────────────────────────────────────────────────────────

test("tasks: a proactive session carries the built-in `proactive` task; rules match it", async () => {
  await withEnv(
    {
      script: { a: [send(REFUSED)], b: [send("A thought.")] },
      rules: [rule({ name: "proactive_only", tasks: ["proactive"] })],
    },
    async ({ storage, sent, create, run }) => {
      const created = await create("s12", { sessionType: "proactive", proactive: true });
      assert.deepEqual(created.refusal.tasks(), ["proactive"]);
      assert.deepEqual(created.gate?.scope.tasks, ["proactive"]);
      await run(created, "s12", { sessionType: "proactive" });
      assert.deepEqual(sent, ["A thought."]);
      const { refusals } = await settled(storage, "s12");
      assert.equal(refusals[0]!.rule_name, "proactive_only");
      assert.equal(refusals[0]!.tasks_json, JSON.stringify(["proactive"]));
      // Persisted like a routed task (statistics, audit, resume).
      assert.deepEqual(storage.getSessionInitialPreloads("s12")?.tasks, ["proactive"]);
      // A default session is taskless: the tasks rule never matches it.
      const plain = await create("s12b");
      assert.equal(plain.refusal.tasks(), null);
      assert.equal(plain.refusal.softRuleCouldMatch(), false);
    },
  );
});

// ── Ledger ───────────────────────────────────────────────────────────────────

test("a hard refusal inside a discarded span moves to the branch; the refused attempt's ledger row has the system prompt hash", async () => {
  await withEnv(
    {
      script: { a: [send(REFUSED)], b: [{ filter: true }], c: [send("Fine.")] },
      // The soft refusal moves the session to model_b, which hard-refuses; the
      // same rule's next entry serves.
      rules: [rule({ reasons: undefined, models: ["model_b", "model_c"] })],
    },
    async ({ storage, sent, recorded, create, run }) => {
      const created = await create("s13");
      await run(created, "s13");
      assert.deepEqual(sent, ["Fine."]);
      const { refusals } = await settled(storage, "s13");
      assert.deepEqual(refusals.map((r) => [r.kind, r.outcome, r.branch_no]), [
        ["soft", "redo", 1],
        ["hard", "redo", 0],
      ]);
      // The refused (billed) attempt carries the frozen system prompt's hash like any agent-loop row.
      const loop = recorded.filter((r) => r.class === "agent_loop");
      const refused = loop.find((r) => r.logicalModelId === "model_b")!;
      assert.match(refused.systemPromptHash ?? "", /^[0-9a-f]{12}$/);
      assert.equal(refused.systemPromptHash, loop[0].systemPromptHash);
    },
  );
});

test("a hard refusal whose re-issued request wrote the refused message moves to that message's branch", async () => {
  await withEnv(
    {
      script: { a: [{ filter: true }], b: [send(REFUSED)], c: [send("Fine.")] },
      rules: [rule({ reasons: undefined, models: ["model_b", "model_c"] })],
    },
    async ({ storage, sent, create, run }) => {
      const created = await create("s14");
      await run(created, "s14");
      assert.deepEqual(sent, ["Fine."]);
      const { refusals } = await settled(storage, "s14");
      assert.deepEqual(refusals.map((r) => [r.kind, r.served_model, r.outcome, r.branch_no]), [
        ["hard", "default", "redo", 1],
        ["soft", "model_b", "redo", 1],
      ]);
    },
  );
});

// ── Multi-label task plumbing ───────────────────────────────────────────────

test("config: `proactive` is a reserved routing task key; tasks carry an optional threshold", async () => {
  const { validateDecisionsConfig } = await import("../src/decisions/config.js");
  const base: any = {
    models: { default: oai(1, "a") },
    decisions: { routing: { tasks: { proactive: { description: "x" } } } },
  };
  assert.throws(() => validateDecisionsConfig(base), /routing\.tasks\.proactive: "proactive" is the built-in task/);
  validateDecisionsConfig({ ...base, decisions: { routing: { tasks: { coding: { description: "x", threshold: 0.4 } } } } });
});

test("storage: the routed tasks persist with the routing state and read back", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.insertAgentSession({ id: "s-tasks", timelineKey: "matrix:a:room:!r", sessionType: "default", status: "running", createdAt: 1, updatedAt: 1 });
    await storage.setSessionInitialPreloads("s-tasks", { skills: [], tasks: ["coding", "research"] });
    assert.deepEqual(storage.getSessionInitialPreloads("s-tasks"), { skills: [], tasks: ["coding", "research"] });
  } finally {
    storage.close();
  }
});

test("factory: a session created with a refusal pin (a job's rerun) sends every request to the pinned model", async () => {
  await withEnv({ script: { b: [send("From the pinned model.")] }, rules: [rule()] }, async ({ stub, sent, create, run }) => {
    const created = await create("s-pin", { refusalPin: { rule: "capability_redo", model: "model_b", at: 1 } });
    assert.equal(created.refusal.pinnedModel(), "model_b");
    await run(created, "s-pin");
    assert.deepEqual(stub.served, ["b"]);
    assert.deepEqual(sent, ["From the pinned model."]);
  });
});
