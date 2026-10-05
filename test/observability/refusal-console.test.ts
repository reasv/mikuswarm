import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../../src/storage/index.js";
import { SessionManager } from "../../src/agent/index.js";
import type { AgentSessionFactory } from "../../src/agent/factory.js";
import { SessionLiveEventBus, type Logger } from "../../src/observability/index.js";
import { createObservabilityServer, type ConsoleServerDeps } from "../../src/observability/server/index.js";

// ---------------------------------------------------------------------------
// Console read API for refusal handling (spec REFUSAL-HANDLING §9, §12.1–§12.2):
// session detail carries the branches, refusal events, send-contract attempts
// and check descriptions; decision rows carry their anchor; session lists carry
// the chip counters; the live stream forwards `branch_forked` and re-seeds.
// ---------------------------------------------------------------------------

const TK = "matrix:acct:room:!room:example.org";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const factory = {
  resolveSessionContextCeiling: () => 128_000,
  resolveSessionCostCeiling: () => undefined,
  toolBlockFor: () => undefined,
} as unknown as AgentSessionFactory;

async function withServer(
  deps: Partial<ConsoleServerDeps> & { storage: Storage },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createObservabilityServer({
    config: { enabled: true, bind: "127.0.0.1", port: 0 },
    factory,
    sessions: new SessionManager(),
    workspaceRoot: "/tmp",
    logger: silent,
    ...deps,
  });
  await server.start();
  try {
    await fn(`http://127.0.0.1:${server.address()}`);
  } finally {
    await server.stop();
  }
}

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

async function session(storage: Storage, id: string, createdAt = 1_000): Promise<void> {
  await storage.insertAgentSession({
    id, timelineKey: TK, sessionType: "default", status: "completed", createdAt, updatedAt: createdAt,
  });
}

function checkRow(sessionId: string, over: Record<string, unknown>): any {
  return {
    ts: 2_000, decision_group: "g1", point: "checks", agent: null, timeline_key: TK,
    agent_session_id: sessionId, source: "model", verdict_json: JSON.stringify({ fired: [], results: [] }),
    checkpoint: "send", branch_no: 0, tool_call_id: "c1", consequence: "sent", ...over,
  };
}

const describeChecks: ConsoleServerDeps["checks"] = {
  describe: (code) =>
    code === "op_refusal"
      ? { code, kind: "refusal", remedy: "redo", reason: "safety", description: "Declines on safety grounds" }
      : undefined,
  maxNudges: 3,
};

test("session detail: branches, refusal events, contract attempts and the checks they name", async () => {
  await withStorage(async (storage) => {
    await session(storage, "s-1");
    const span = [{ role: "assistant", content: [{ type: "text", text: "no" }], timestamp: 3 }];
    await storage.insertSessionBranch({
      sessionId: "s-1", forkIndex: 2, reason: "refusal_redo", checkCode: "op_refusal", decisionEvaluationId: 7,
      fromModel: "model_a", toModel: "model_b", messagesJson: JSON.stringify(span), costUsd: 0.01, createdAt: 5,
    });
    await storage.insertRefusalEvent({
      ts: 4, agentSessionId: "s-1", site: "default", kind: "soft", checkCode: "op_refusal", reason: "safety",
      method: "judged", source: "message", probability: 0.9, checkpoint: "send", outcome: "redo", toModel: "model_b",
      ruleName: "r1", decisionEvaluationId: 7,
    });
    await storage.replaceSessionContract("s-1", {
      attempts: [{ agentSessionId: "s-1", attemptNo: 0, variant: "original", failureTypes: ["text_only"], primaryType: "text_only", servedModel: "model_b" }],
      outcome: "recovered", nudges: 1, version: 1,
    });
    await storage.insertDecisionEvaluation(checkRow("s-1", { verdict_json: JSON.stringify({ fired: ["style_x"], source: "message", matched: "m" }) }));

    await withServer({ storage, checks: describeChecks }, async (base) => {
      const body = (await (await fetch(`${base}/api/sessions/s-1`)).json()) as any;
      assert.equal(body.branches.length, 1);
      assert.deepEqual(body.branches[0], {
        branchNo: 1, parentBranchNo: 0, forkIndex: 2, reason: "refusal_redo", checkCode: "op_refusal",
        decisionEvaluationId: 7, fromModel: "model_a", toModel: "model_b", messages: span, costUsd: 0.01, createdAt: 5,
      });
      assert.equal(body.refusalEvents.length, 1);
      assert.equal(body.refusalEvents[0].outcome, "redo");
      assert.equal(body.refusalEvents[0].probability, 0.9);
      assert.equal(body.refusalEvents[0].ruleName, "r1");
      assert.deepEqual(body.contract.outcome, "recovered");
      assert.equal(body.contract.nudges, 1);
      assert.equal(body.contract.maxNudges, 3);
      assert.deepEqual(body.contract.attempts[0].failureTypes, ["text_only"]);
      assert.equal(body.contract.attempts[0].servedModel, "model_b");
      // Only codes the catalogue knows are described (style_x is not in this one).
      assert.deepEqual(body.checks, [
        { code: "op_refusal", kind: "refusal", remedy: "redo", reason: "safety", description: "Declines on safety grounds" },
      ]);
      assert.deepEqual(body.session.checkChips, { refused: 1, redone: 1, nudged: 1, revised: 0, unjudged: 0 });
    });

    // Without the checks deps: no descriptions, no nudge budget.
    await withServer({ storage }, async (base) => {
      const body = (await (await fetch(`${base}/api/sessions/s-1`)).json()) as any;
      assert.deepEqual(body.checks, []);
      assert.equal(body.contract.maxNudges, null);
    });
  });
});

test("session detail of a session without refusal handling: empty lists, null chips", async () => {
  await withStorage(async (storage) => {
    await session(storage, "s-plain");
    await withServer({ storage }, async (base) => {
      const body = (await (await fetch(`${base}/api/sessions/s-plain`)).json()) as any;
      assert.deepEqual(body.branches, []);
      assert.deepEqual(body.refusalEvents, []);
      assert.deepEqual(body.contract, { outcome: null, nudges: null, maxNudges: null, attempts: [] });
      assert.equal(body.session.checkChips, null);
    });
  });
});

test("decision rows carry the check anchor", async () => {
  await withStorage(async (storage) => {
    await session(storage, "s-2");
    await storage.insertDecisionEvaluation(checkRow("s-2", { checkpoint: "ending", tool_call_id: null, attempt_no: 2, branch_no: 1, consequence: "observed" }));
    await storage.insertDecisionEvaluation({
      ts: 1, decision_group: "g0", point: "routing", agent: null, timeline_key: TK, agent_session_id: "s-2", source: "model",
    });
    await withServer({ storage }, async (base) => {
      const body = (await (await fetch(`${base}/api/sessions/s-2/decisions`)).json()) as any;
      const [routing, ending] = body.evaluations;
      assert.deepEqual(
        { checkpoint: ending.checkpoint, branchNo: ending.branchNo, toolCallId: ending.toolCallId, attemptNo: ending.attemptNo, consequence: ending.consequence },
        { checkpoint: "ending", branchNo: 1, toolCallId: null, attemptNo: 2, consequence: "observed" },
      );
      assert.equal(routing.checkpoint, null);
      assert.equal(routing.consequence, null);
    });
  });
});

test("session list chips: redone counts rule redos and contract redos once; judged calls are distinct", async () => {
  await withStorage(async (storage) => {
    await session(storage, "s-a", 1_000);
    await session(storage, "s-b", 2_000);
    // s-a: a hard redo (no branch), a soft redo (event + its branch), a contract redo branch.
    for (const kind of ["hard", "soft"] as const) {
      await storage.insertRefusalEvent({
        ts: 3, agentSessionId: "s-a", site: "default", kind, checkCode: "c", reason: "safety",
        method: kind === "hard" ? "stop_reason" : "judged", checkpoint: kind === "hard" ? "request" : "send", outcome: "redo",
      });
    }
    await storage.insertRefusalEvent({
      ts: 3, agentSessionId: "s-a", site: "default", kind: "soft", checkCode: "c", reason: "safety",
      method: "judged", checkpoint: "send", outcome: "observed",
    });
    for (const reason of ["refusal_redo", "contract_redo"] as const) {
      await storage.insertSessionBranch({ sessionId: "s-a", forkIndex: 1, reason, messagesJson: "[]" });
    }
    await storage.setAgentSessionContract("s-a", { outcome: "recovered", nudges: 2, version: 1 });
    // s-b: one revised call judged in two split calls + a pattern row (one anchor), a
    // second revised call, and an unjudged ending (attempt anchor, no tool call).
    await storage.insertDecisionEvaluation(checkRow("s-b", { tool_call_id: "c1", consequence: "revise" }));
    await storage.insertDecisionEvaluation(checkRow("s-b", { tool_call_id: "c1", consequence: "revise" }));
    await storage.insertDecisionEvaluation(checkRow("s-b", { tool_call_id: "c1", consequence: "revise", source: "pattern" }));
    await storage.insertDecisionEvaluation(checkRow("s-b", { tool_call_id: "c2", consequence: "revise" }));
    await storage.insertDecisionEvaluation(checkRow("s-b", { checkpoint: "ending", tool_call_id: null, attempt_no: 0, consequence: "sent_unjudged" }));
    await storage.insertDecisionEvaluation(checkRow("s-b", { point: "routing", tool_call_id: null, consequence: "revise" }));

    const chips = storage.getSessionCheckChips(["s-a", "s-b", "s-none"]);
    assert.deepEqual(chips.get("s-a"), { refused: 3, redone: 3, nudged: 2, revised: 0, unjudged: 0 });
    assert.deepEqual(chips.get("s-b"), { refused: 0, redone: 0, nudged: 0, revised: 2, unjudged: 1 });
    assert.equal(chips.has("s-none"), false);
    assert.equal(storage.getSessionCheckChips([]).size, 0);

    await withServer({ storage }, async (base) => {
      const body = (await (await fetch(`${base}/api/rooms/${encodeURIComponent(TK)}/sessions`)).json()) as any;
      const byId = new Map(body.sessions.map((s: any) => [s.id, s.checkChips]));
      assert.deepEqual(byId.get("s-a"), { refused: 3, redone: 3, nudged: 2, revised: 0, unjudged: 0 });
      assert.equal((byId.get("s-b") as any).revised, 2);
    });
  });
});

test("SSE: branch_forked is forwarded and followed by a re-seed of the new live branch", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    const liveEvents = new SessionLiveEventBus();
    const state = {
      messages: [
        { type: "triggerGroup", role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "discarded" }] },
      ] as any[],
    };
    const agent = {
      get signal() {
        return new AbortController().signal;
      },
      state,
      subscribe: () => () => {},
    };
    const record = sessions.createPlaceholder({
      provider: "matrix",
      timelineKey: TK,
      event: { id: "e1", timelineKey: TK, provider: "matrix", role: "user", sender: { id: "@a:example.org" }, body: "hi", timestamp: 1, receivedAt: 1 } as any,
    });
    sessions.markRunning(record.id);
    sessions.attachAgent(record.id, agent as any);
    await storage.insertAgentSession({ id: record.id, timelineKey: TK, sessionType: "default", status: "running", createdAt: 1, updatedAt: 1 });

    await withServer({ storage, sessions, liveEvents }, async (base) => {
      const res = await fetch(`${base}/api/sessions/${record.id}/stream`);
      assert.equal(res.status, 200);
      // The fork core cuts the live list first, then publishes.
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      state.messages = state.messages.slice(0, 1);
      liveEvents.publish(record.id, {
        type: "branch_forked", branchNo: 1, forkIndex: 1, reason: "refusal_redo", checkCode: "op_refusal",
        fromModel: "model_a", toModel: "model_b",
      });
      sessions.markCompleted(record.id);
      const text = await res.text();
      const records = text.split("\n\n").filter((r) => r.startsWith("event: "));
      const kinds = records.map((r) => r.split("\n")[0]!.slice("event: ".length));
      assert.deepEqual(kinds, ["rollout_seed", "branch_forked", "rollout_seed"]);
      const forked = JSON.parse(records[1]!.split("\n")[1]!.slice("data: ".length));
      assert.equal(forked.branchNo, 1);
      assert.equal(forked.toModel, "model_b");
      const reseed = JSON.parse(records[2]!.split("\n")[1]!.slice("data: ".length));
      assert.equal(reseed.messages.length, 1, "the seed carries the cut live list");
      assert.equal(reseed.rolloutStartIndex, 1);
    });
  });
});
