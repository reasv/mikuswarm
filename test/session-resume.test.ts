import assert from "node:assert/strict";
import test from "node:test";

import { loadResumeMaterial, stripFailedTail } from "../src/agent/recovery.js";
import { SessionRunner, SessionRunnerError, isResumableRunError } from "../src/agent/runner.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { Storage, type AgentSessionRow } from "../src/storage/index.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";

// ---------------------------------------------------------------------------
// Layer-2 session resume-in-place (spec CONCURRENCY-AND-RATE-LIMITING §6.2):
// resume-material projection (snapshot vocabulary + failed-tail stripping), the
// runner's mechanical-failure rejection + continue-mode, and the new session
// states.
// ---------------------------------------------------------------------------

function row(overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "s-resume0001",
    timeline_key: "matrix:miku:room:!room",
    session_type: "default",
    status: "failed-resumable",
    model_id: "m",
    trigger_event_id: "ev-1",
    trigger_external_id: null,
    trigger_body: "hi",
    context_snapshot_json: JSON.stringify([
      { type: "system", role: "system", content: "prompt", tier: "system", tokenEstimate: 1 },
      { type: "chatEvent", role: "user", content: "<message>history</message>", tier: "compact", tokenEstimate: 1 },
    ]),
    context_dump_path: null,
    transcript_json: JSON.stringify([
      { type: "triggerGroup", content: "<system>now</system>", timestamp: 1 },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" },
    ]),
    token_estimate: 2,
    no_reply: 0,
    error: "boom",
    created_at: 1,
    started_at: 1,
    updated_at: 2,
    completed_at: null,
    ...overrides,
  };
}

test("loadResumeMaterial projects the snapshot vocabulary and strips the failed tail", () => {
  const material = loadResumeMaterial(row());
  assert.ok(material, "row with snapshot+transcript is resumable");
  // mapBuiltMessages contract: the system block is dropped from the runtime prefix.
  assert.equal(material!.snapshot.length, 1);
  assert.equal((material!.snapshot[0] as any).type, "chatEvent");
  // The synthetic error assistant turn is stripped; the transcript ends at the
  // un-answered final user turn, ready for agent.continue().
  assert.equal(material!.transcript.length, 1);
  assert.equal((material!.transcript[0] as any).type, "triggerGroup");
});

test("loadResumeMaterial rejects rows that cannot be redone", () => {
  // Missing material.
  assert.equal(loadResumeMaterial(row({ context_snapshot_json: null })), null);
  assert.equal(loadResumeMaterial(row({ transcript_json: null })), null);
  // Corrupt JSON.
  assert.equal(loadResumeMaterial(row({ transcript_json: "{nope" })), null);
  // A transcript whose last turn committed cleanly: nothing failed to redo.
  assert.equal(
    loadResumeMaterial(
      row({
        transcript_json: JSON.stringify([
          { type: "triggerGroup", content: "x", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        ]),
      }),
    ),
    null,
  );
  // Stripping everything leaves nothing to re-issue.
  assert.equal(
    loadResumeMaterial(
      row({
        transcript_json: JSON.stringify([
          { role: "assistant", content: [], stopReason: "error", errorMessage: "x" },
        ]),
      }),
    ),
    null,
  );
});

test("stripFailedTail drops stacked error/aborted assistant turns only", () => {
  const transcript = [
    { role: "user", content: "q" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "a" },
    { role: "assistant", content: [], stopReason: "aborted" },
  ] as any[];
  const stripped = stripFailedTail(transcript);
  assert.equal(stripped.length, 1);
  assert.equal((stripped[0] as any).role, "user");
});

// ---------------------------------------------------------------------------
// Runner: mechanical-failure rejection + continue-mode
// ---------------------------------------------------------------------------

const session = { id: "s-test111111" } as AgentSessionRecord;
const kickoff = { role: "user", content: "hi", timestamp: 1 } as any;

test("SessionRunner rejects with phase 'mechanical' when the run dies on a retryable error", async () => {
  const messages: any[] = [];
  const agent: any = {
    state: {
      messages,
      errorMessage: undefined as string | undefined,
    },
    async prompt() {
      messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" });
      agent.state.errorMessage = "529 overloaded";
    },
    async continue() {},
    async waitForIdle() {},
  };

  const runner = new SessionRunner();
  await assert.rejects(
    runner.run(agent, session, 3, kickoff),
    (err: unknown) => isResumableRunError(err),
  );
});

test("SessionRunner does NOT reject mechanically on fatal or aborted runs", async () => {
  // Fatal (auth) error: settles via the ordinary loop, no mechanical rejection.
  const fatalMessages: any[] = [];
  const fatalAgent: any = {
    state: { messages: fatalMessages, errorMessage: undefined as string | undefined },
    async prompt() {
      fatalMessages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "401 unauthorized" });
      fatalAgent.state.errorMessage = "401 unauthorized";
    },
    async continue() {},
    async waitForIdle() {},
  };
  const result = await new SessionRunner().run(fatalAgent, session, 0, kickoff);
  assert.equal(result.noReply, true);

  // Aborted run: also settles normally (interrupt/cap semantics unchanged).
  const abortedMessages: any[] = [];
  const abortedAgent: any = {
    state: { messages: abortedMessages, errorMessage: undefined as string | undefined },
    async prompt() {
      abortedMessages.push({ role: "assistant", content: [], stopReason: "aborted" });
      abortedAgent.state.errorMessage = "aborted";
    },
    async continue() {},
    async waitForIdle() {},
  };
  const aborted = await new SessionRunner().run(abortedAgent, session, 3, kickoff);
  assert.equal(aborted.noReply, true);
});

test("SessionRunner continue-mode kicks via agent.continue() instead of a new prompt", async () => {
  let prompts = 0;
  let continues = 0;
  const messages: any[] = [{ type: "triggerGroup", content: "x", timestamp: 1 }];
  const agent: any = {
    state: { messages, errorMessage: undefined },
    async prompt() {
      prompts += 1;
    },
    async continue() {
      continues += 1;
      messages.push({ role: "assistant", content: [{ type: "toolCall", name: "send_message", args: {} }] });
    },
    async waitForIdle() {},
  };

  const result = await new SessionRunner().run(agent, session, 3, undefined);
  assert.equal(prompts, 0, "no new user turn in continue-mode");
  assert.equal(continues, 1, "the failed request is re-issued via continue()");
  assert.equal(result.noReply, false);
});

test("isResumableRunError only matches the mechanical phase", () => {
  assert.equal(isResumableRunError(new SessionRunnerError("x", "mechanical")), true);
  assert.equal(isResumableRunError(new SessionRunnerError("x", "prompt")), false);
  assert.equal(isResumableRunError(new Error("boom")), false);
});

// ---------------------------------------------------------------------------
// Session states: resuming / failed-resumable
// ---------------------------------------------------------------------------

test("storage accepts the resume states and resetStaleSessions parks mid-resume rows", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const now = Date.now();
    await storage.insertAgentSession({
      id: "s-r1",
      timelineKey: "matrix:miku:room:!room",
      sessionType: "default",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await storage.updateAgentSessionStatus("s-r1", "resuming", { error: "529" });
    assert.equal(storage.getAgentSession("s-r1")?.status, "resuming");
    await storage.updateAgentSessionStatus("s-r1", "failed-resumable", { error: "529" });
    assert.equal(storage.getAgentSession("s-r1")?.status, "failed-resumable");

    // A session that died mid-resume heals to failed-resumable (still manually
    // resumable), not interrupted.
    await storage.updateAgentSessionStatus("s-r1", "resuming");
    const healed = await storage.resetStaleSessions();
    assert.equal(healed, 1);
    assert.equal(storage.getAgentSession("s-r1")?.status, "failed-resumable");
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("SessionManager: markResuming keeps the record; markFailedResumable evicts; adopt re-registers", () => {
  const sessions = new SessionManager();
  const record = sessions.createPlaceholder({
    provider: "test",
    timelineKey: "tl:room1",
    event: {
      id: "evt-1",
      timelineKey: "tl:room1",
      provider: "test",
      role: "user",
      sender: { id: "u1" },
      body: "hello",
      timestamp: 1,
      receivedAt: 1,
    },
  } as any);
  sessions.markRunning(record.id);

  sessions.markResuming(record.id, { error: "529" });
  assert.equal(sessions.get(record.id)?.status, "resuming");

  sessions.markFailedResumable(record.id, { error: "529" });
  assert.equal(sessions.get(record.id), undefined, "parked sessions are evicted from memory");

  const adopted: AgentSessionRecord = { ...record, status: "resuming" };
  sessions.adopt(adopted);
  assert.equal(sessions.get(record.id)?.status, "resuming");
  sessions.markRunning(record.id);
  assert.equal(sessions.get(record.id)?.status, "running");
});
