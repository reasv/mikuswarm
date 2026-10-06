/**
 * The runner's redo loop and send-contract redo (spec REFUSAL-HANDLING §7.5,
 * §8.4): tagged corrective prompts from the shared constants, redo requests
 * taken after every settle (an aborted run is not a Stop), nudge-budget resets,
 * one contract redo per failure point, give-up paths, and the full contract
 * redo through the real fork core and the completion-time derivation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionRunner, type RedoOutcome } from "../src/agent/runner.js";
import { SessionRedoControl, type RedoRequest } from "../src/agent/redo-signal.js";
import { SessionManager, type AgentSessionRecord } from "../src/agent/session-manager.js";
import { FORCED_COMPLETION_PROMPTS } from "../src/agent/contract.js";
import { createRedoHandler } from "../src/agent/redo.js";
import { persistSessionContract } from "../src/agent/contract-store.js";
import type { ForkContext } from "../src/agent/fork.js";
import { Storage } from "../src/storage/index.js";
import type { InboundChatEvent } from "../src/types.js";

let clock = 1000;
const kickoff = { type: "triggerGroup", content: "hi", timestamp: clock++ } as any;
const text = (t: string, served = "model_a") => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", served: { logicalId: served }, timestamp: clock++ });
const sendCall = (id: string, final: boolean, served = "model_a") => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "send_message", arguments: { text: "hello", final } }],
  stopReason: "toolUse",
  served: { logicalId: served },
  timestamp: clock++,
});
const ok = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "send_message", content: [], isError: false, timestamp: clock++ });
const abortedMsg = () => ({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted", timestamp: clock++ });

type Step = (messages: any[]) => void;

/**
 * Scripted agent: each prompt()/continue() pushes the prompt input (as pi does)
 * and then runs the next script step, which appends what the run produced.
 */
function scriptedAgent(steps: Step[]) {
  const state = { messages: [] as any[], errorMessage: undefined as string | undefined };
  const prompts: any[] = [];
  let continues = 0;
  const next = () => {
    const step = steps.shift();
    if (!step) throw new Error("script exhausted");
    step(state.messages);
  };
  const agent = {
    state,
    async prompt(input: any) {
      for (const m of Array.isArray(input) ? input : [input]) {
        prompts.push(m);
        state.messages.push(m);
      }
      next();
    },
    async continue() {
      continues += 1;
      next();
    },
    async waitForIdle() {},
  };
  return { agent: agent as any, prompts, continues: () => continues, state };
}

const session = { id: "s1" } as AgentSessionRecord;

test("forced completion sends the shared prompt constants, tagged with attempt and variant", async () => {
  const { agent, prompts } = scriptedAgent([
    (m) => m.push(text("my reply as text")),
    (m) => m.push(sendCall("s1", false), ok("s1"), text("and more text")),
    (m) => m.push(sendCall("s2", true), ok("s2")),
  ]);
  const result = await new SessionRunner().run(agent, session, 3, kickoff);
  assert.equal(result.noReply, false);
  assert.equal(result.retries, 2);
  const nudges = prompts.slice(1);
  assert.deepEqual(nudges.map((n) => n.content), [
    FORCED_COMPLETION_PROMPTS.current.not_sent,
    FORCED_COMPLETION_PROMPTS.current.sent_not_final,
  ]);
  assert.deepEqual(nudges.map((n) => n.harness), [
    { kind: "forced_completion", attempt: 1, variant: "not_sent" },
    { kind: "forced_completion", attempt: 2, variant: "sent_not_final" },
  ]);
});

function redoRunner(onRedo: (req: RedoRequest, agent: any) => Promise<RedoOutcome>, opts: { contractRedo?: boolean } = {}) {
  const control = new SessionRedoControl();
  const calls: RedoRequest[] = [];
  const runner = new SessionRunner({
    redo: {
      control,
      onRedo: async (req, agent) => {
        calls.push(req);
        return onRedo(req, agent);
      },
    },
    contractRedo: opts.contractRedo,
  });
  return { runner, control, calls };
}

test("a pending redo request is taken after the settle; the aborted run is not a Stop", async () => {
  let control!: SessionRedoControl;
  const { agent, continues } = scriptedAgent([
    (m) => {
      // The gate refuses a send: requests a redo and aborts the run.
      m.push(sendCall("g1", true), { ...ok("g1"), isError: true }, abortedMsg());
      control.request({ kind: "refusal", toolCallId: "g1", checkCode: "refusal_x" });
    },
    (m) => m.push(sendCall("s2", true, "model_b"), ok("s2")),
  ]);
  const r = redoRunner(async (_req, a) => {
    a.state.messages.splice(1); // the fork core's job; any truncation will do here
    return { action: "continue" };
  });
  control = r.control;
  const result = await r.runner.run(agent, session, 3, kickoff);
  assert.deepEqual(r.calls, [{ kind: "refusal", toolCallId: "g1", checkCode: "refusal_x" }]);
  assert.equal(continues(), 1, "the runner continued after the redo");
  assert.equal(result.noReply, false);
  assert.equal(r.control.peek(), undefined);
});

test("an operator Stop wins over a pending redo request", async () => {
  const sessions = new SessionManager();
  const inbound: InboundChatEvent = {
    provider: "test",
    timelineKey: "tl:r",
    event: { id: "e", externalId: "x", timelineKey: "tl:r", provider: "test", role: "user", sender: { id: "u" }, body: "b", timestamp: 1, receivedAt: 1 },
  } as InboundChatEvent;
  const record = sessions.createPlaceholder(inbound, "default");
  let control!: SessionRedoControl;
  const { agent } = scriptedAgent([
    (m) => {
      m.push(abortedMsg());
      control.request({ kind: "refusal" });
      assert.equal(sessions.interrupt(record.id), true);
    },
  ]);
  agent.hasQueuedMessages = () => false;
  agent.clearAllQueues = () => {};
  agent.abort = () => {};
  sessions.markRunning(record.id);
  sessions.attachAgent(record.id, agent);
  const r = redoRunner(async () => ({ action: "continue" }));
  control = r.control;
  const result = await r.runner.run(agent, record, 3, kickoff, sessions.runLifecycle(record.id));
  assert.deepEqual(r.calls, []);
  assert.equal(result.noReply, true);
});

test("give_up settles with the handler's noReply and no further turn", async () => {
  let control!: SessionRedoControl;
  const { agent, continues } = scriptedAgent([
    (m) => {
      m.push(abortedMsg());
      control.request({ kind: "refusal" });
    },
  ]);
  const r = redoRunner(async () => ({ action: "give_up", noReply: true }));
  control = r.control;
  const result = await r.runner.run(agent, session, 3, kickoff);
  assert.equal(result.noReply, true);
  assert.equal(continues(), 0);
});

test("a throwing redo handler gives up silently", async () => {
  let control!: SessionRedoControl;
  const { agent } = scriptedAgent([
    (m) => {
      m.push(abortedMsg());
      control.request({ kind: "refusal" });
    },
  ]);
  const r = redoRunner(async () => {
    throw new Error("boom");
  });
  control = r.control;
  const result = await r.runner.run(agent, session, 3, kickoff);
  assert.equal(result.noReply, true);
});

test("the nudge counter resets on a refusal redo", async () => {
  let control!: SessionRedoControl;
  const { agent, prompts } = scriptedAgent([
    (m) => m.push(text("a")),
    // nudge 1 → the redone send is refused at the gate
    (m) => {
      m.push(sendCall("g1", true), { ...ok("g1"), isError: true }, abortedMsg());
      control.request({ kind: "refusal", toolCallId: "g1" });
    },
    // after the redo (continue): text again → with maxRetries 1 a nudge is only
    // possible because the budget was reset
    (m) => m.push(text("b", "model_b")),
    (m) => m.push(sendCall("s3", true, "model_b"), ok("s3")),
  ]);
  const r = redoRunner(async (_req, a) => {
    a.state.messages.splice(1);
    return { action: "continue" };
  });
  control = r.control;
  const result = await r.runner.run(agent, session, 1, kickoff);
  assert.equal(result.noReply, false);
  const nudges = prompts.filter((p) => p.harness?.kind === "forced_completion");
  assert.deepEqual(nudges.map((n) => n.harness.attempt), [1, 1]);
});

test("contract redo: once the nudges run out, one same-model redo with a fresh budget", async () => {
  const { agent, prompts } = scriptedAgent([
    (m) => m.push(text("a")),
    (m) => m.push(text("b")),
    (m) => m.push(text("c")),
    // redo continue
    (m) => m.push(sendCall("s1", true), ok("s1")),
  ]);
  const r = redoRunner(async (_req, a) => {
    a.state.messages.splice(1);
    return { action: "continue" };
  }, { contractRedo: true });
  const result = await r.runner.run(agent, session, 2, kickoff);
  assert.deepEqual(r.calls, [{ kind: "contract" }]);
  assert.equal(result.noReply, false);
  assert.equal(prompts.filter((p) => p.harness?.kind === "forced_completion").length, 2);
});

test("contract redo: a second exhaustion at the same failure point gives up as NO_REPLY", async () => {
  const { agent } = scriptedAgent([
    (m) => m.push(text("a")),
    (m) => m.push(text("b")),
    (m) => m.push(text("c")), // redo
    (m) => m.push(text("d")),
  ]);
  const r = redoRunner(async (_req, a) => {
    a.state.messages.splice(1);
    return { action: "continue" };
  }, { contractRedo: true });
  const result = await r.runner.run(agent, session, 1, kickoff);
  assert.equal(r.calls.length, 1, "one redo per failure point");
  assert.equal(result.noReply, true);
  assert.equal(result.retries, 2);
});

test("contract redo: a new failure point (a message delivered since) gets its own redo", async () => {
  const { agent } = scriptedAgent([
    (m) => m.push(text("a")), // exhausted (maxRetries 0) → redo 1
    (m) => m.push(sendCall("s1", false), ok("s1"), text("b")), // delivered, then fails again → redo 2
    (m) => m.push(sendCall("s2", true), ok("s2")),
  ]);
  const r = redoRunner(async (_req, a) => {
    // fork back to the last delivered message (the core's rule)
    const msgs = a.state.messages;
    let cut = 1;
    msgs.forEach((x: any, i: number) => {
      if (x.role === "toolResult" && !x.isError) cut = i + 1;
    });
    msgs.splice(cut);
    return { action: "continue" };
  }, { contractRedo: true });
  const result = await r.runner.run(agent, session, 0, kickoff);
  assert.equal(r.calls.length, 2);
  assert.equal(result.noReply, false);
});

test("contract redo off: exhaustion settles as before", async () => {
  const { agent } = scriptedAgent([(m) => m.push(text("a"))]);
  const r = redoRunner(async () => ({ action: "continue" }), { contractRedo: false });
  const result = await r.runner.run(agent, session, 0, kickoff);
  assert.deepEqual(r.calls, []);
  assert.equal(result.noReply, true);
});

test("end to end: contract redo through the fork core, the refusal pin untouched, derived at completion", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.insertAgentSession({
      id: "s1", timelineKey: "matrix:a:room:!r:x", sessionType: "default", status: "running", createdAt: 1, updatedAt: 1,
    });
    const pin = { rule: "rule_a", model: "model_b", at: 5 };
    await storage.setAgentSessionRefusalPin("s1", pin);
    const { agent } = scriptedAgent([
      (m) => m.push(text("a", "model_b")),
      (m) => m.push(text("b", "model_b")),
      (m) => m.push(sendCall("s1", true, "model_b"), ok("s1")),
    ]);
    const fork: ForkContext = { sessionId: "s1", agent, storage, flushTranscript: async () => {} };
    const runner = new SessionRunner({
      redo: { control: new SessionRedoControl(), onRedo: createRedoHandler({ fork }) },
      contractRedo: true,
    });
    const result = await runner.run(agent, session, 1, kickoff);
    assert.equal(result.noReply, false);
    const [branch] = storage.listSessionBranches("s1");
    assert.equal(branch!.reason, "contract_redo");
    assert.equal(branch!.fork_index, 1);
    assert.equal(branch!.from_model, "model_b", "the pinned model served the failed attempts");
    assert.equal(branch!.to_model, "model_b", "same model: the redo changes no model");
    assert.deepEqual(storage.getAgentSessionRefusalPin("s1"), pin);
    assert.equal(agent.state.messages.length, 3, "kickoff + the redo's send and result");

    await persistSessionContract({ storage, sessionId: "s1", messages: agent.state.messages });
    const row = storage.getAgentSession("s1")!;
    assert.equal(row.contract_outcome, "redo_recovered");
    assert.equal(row.contract_nudges, 1);
    assert.equal(row.contract_version, 1);
    assert.deepEqual(
      storage.listContractAttempts("s1").map((a) => [a.branch_no, a.redo_no, a.attempt_no, a.variant, a.primary_type, a.served_model]),
      [
        [0, 1, 0, "original", null, "model_b"],
        [1, 0, 0, "original", "text_only", "model_b"],
        [1, 0, 1, "not_sent", "text_only", "model_b"],
      ],
    );
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("ending judge skips harness NO_REPLY but still judges model NO_REPLY", async () => {
 for (const synthetic of [true, false]) {
   let judged = 0;
   const { agent } = scriptedAgent([(messages) => messages.push({ ...text("NO_REPLY"), ...(synthetic ? { harness: { kind: "refusal_withheld" } } : {}) })]);
   const result = await new SessionRunner({ endings: { onEnding: async () => { judged++; } } }).run(agent, session, 0, kickoff);
   assert.equal(result.noReply, true);
   assert.equal(judged, synthetic ? 0 : 1);
 }
});
