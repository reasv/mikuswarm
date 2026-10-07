/**
 * Unit tests for the late-input controller (ARCHITECTURE.md §8 "Late input"):
 * the irreversibility hold, effect tracking, the replay store's lineage rule,
 * and request progress for the abort rule.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  HELD_CALL_CANCELLED,
  LateInputSession,
  callKey,
  lineageCallCount,
  resolveLateInputSettings,
} from "../src/agent/late-input.js";
import { RequestProgress } from "../src/agent/request-progress.js";

function tool(name: string, onRun: (args: unknown) => void = () => undefined, text = "ok"): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} } as never,
    execute: async (_id: string, params: unknown) => {
      onRun(params);
      return { content: [{ type: "text", text }], details: {} };
    },
  } as unknown as AgentTool;
}

function session(over: Partial<{ holdMs: number; maxHoldMs: number; extendMs: number; maxRedos: number }> = {}, receivedAt = Date.now()) {
  const settings = { ...resolveLateInputSettings({ enabled: true }), ...over };
  const ctl = new LateInputSession({ sessionId: "s", settings, triggerReceivedAt: receivedAt, holdApplies: true });
  ctl.markRunning();
  return ctl;
}

test("settings: off without the block, defaults otherwise", () => {
  assert.equal(resolveLateInputSettings(undefined).enabled, false);
  const s = resolveLateInputSettings({ enabled: true });
  assert.deepEqual(
    [s.holdMs, s.extendMs, s.maxHoldMs, s.maxRedos, s.firstEventWaitMs, s.replayMaxAgeMs, s.reviveMaxMs, s.skewToleranceMs],
    [8000, 4000, 20000, 3, 10000, 300000, 300000, 0],
  );
});

test("hold: the first irreversible call waits for the deadline, reads do not, later sends do not", async () => {
  const ctl = session({ holdMs: 300 });
  const [send, search] = ctl.wrapHoldTools([tool("send_message"), tool("web_search")]);
  const t0 = Date.now();
  await search!.execute("c1", { query: "x" }, undefined, undefined);
  assert.ok(Date.now() - t0 < 100, "a redo-safe call is never held");
  await send!.execute("c2", { message: "hi" }, undefined, undefined);
  assert.ok(Date.now() - t0 >= 250, "the first send waited for the deadline");
  assert.equal(ctl.holdRecordFor("c2")?.reason, "hold_deadline");
  assert.equal(ctl.hasIrreversibleEffect(), true);
  const t1 = Date.now();
  await send!.execute("c3", { message: "again" }, undefined, undefined);
  assert.ok(Date.now() - t1 < 100, "only the first irreversible call is held");
  assert.equal(ctl.canRedo(), false, "no redo after an irreversible effect");
});

test("hold: a restart requested while a call is held cancels it", async () => {
  const ctl = session({ holdMs: 2000 });
  let ran = false;
  const [send] = ctl.wrapHoldTools([tool("send_message", () => (ran = true))]);
  const pending = send!.execute("c1", { message: "hi" }, undefined, undefined);
  await new Promise((r) => setTimeout(r, 50));
  ctl.requestRestart({ reason: "edit_redo", causeEventIds: ["e"], fallbackInterjections: [], addedEventIds: [], removedEventIds: [] });
  const result = await pending;
  assert.equal(ran, false, "the held call never executed");
  assert.equal((result.content[0] as { text: string }).text, HELD_CALL_CANCELLED);
  assert.equal(ctl.holdRecordFor("c1")?.reason, "correction");
  assert.equal(ctl.peekPending()?.kind, "restart");
});

test("hold: a pending late-addition verdict holds the call past the deadline", async () => {
  const ctl = session({ holdMs: 50 });
  let release!: () => void;
  ctl.trackVerdict(new Promise<void>((r) => (release = r)));
  const [send] = ctl.wrapHoldTools([tool("send_message")]);
  const t0 = Date.now();
  setTimeout(() => release(), 250);
  await send!.execute("c1", {}, undefined, undefined);
  assert.ok(Date.now() - t0 >= 200);
  assert.equal(ctl.holdRecordFor("c1")?.reason, "verdict_pending");
});

test("hold: corrections extend the deadline, bounded by max_hold_ms", () => {
  const at = Date.now();
  const ctl = session({ holdMs: 1000, extendMs: 5000, maxHoldMs: 3000 }, at);
  assert.equal(ctl.holdDeadline, at + 1000);
  ctl.extendHold();
  assert.equal(ctl.holdDeadline, at + 3000);
});

test("effects: a failed send leaves no effect; redos are bounded", async () => {
  const ctl = session({ holdMs: 0, maxRedos: 1 });
  const [send] = ctl.wrapHoldTools([tool("send_message", () => undefined, "error: not delivered")]);
  await send!.execute("c1", {}, undefined, undefined);
  assert.equal(ctl.hasIrreversibleEffect(), false);
  assert.equal(ctl.canRedo(), true);
  ctl.redoCount = 1;
  assert.equal(ctl.canRedo(), false);
});

test("replay: served once per lineage, fresh when the lineage already has the call", async () => {
  const ctl = session();
  let runs = 0;
  let live: AgentMessage[] = [];
  const [search] = ctl.wrapReplayTools([tool("web_search", () => (runs += 1))], () => live);
  const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "web_search", arguments: { query: "x" } }] }) as unknown as AgentMessage;
  // First lineage: executes and stores.
  live = [call("a")];
  await search!.execute("a", { query: "x" }, undefined, undefined);
  assert.equal(runs, 1);
  // Same lineage, same call again: a new value is wanted.
  live = [call("a"), call("b")];
  await search!.execute("b", { query: "x" }, undefined, undefined);
  assert.equal(runs, 2);
  // A redo from scratch (new lineage): served from the store.
  live = [call("c")];
  await search!.execute("c", { query: "x" }, undefined, undefined);
  assert.equal(runs, 2, "replayed");
  assert.equal(lineageCallCount([call("c")], callKey("web_search", { query: "x" }), "c"), 0);
  assert.equal(callKey("t", { b: 1, a: 2 }), callKey("t", { a: 2, b: 1 }), "canonical arguments");
});

test("request progress: queued, awaiting the first event, streaming, idle", async () => {
  const p = new RequestProgress(true);
  assert.equal(p.phase, "idle");
  p.begin();
  assert.equal(p.phase, "queued");
  p.noteAdmitted();
  assert.equal(p.phase, "awaiting_first_event");
  const waited = p.waitForFirstEventOrEnd(5000);
  setTimeout(() => p.noteAttemptEvent(), 30);
  await waited;
  assert.equal(p.phase, "streaming");
  p.end();
  assert.equal(p.phase, "idle");
  p.begin();
  p.noteAdmitted();
  const t0 = Date.now();
  await p.waitForFirstEventOrEnd(60);
  assert.ok(Date.now() - t0 >= 50, "bounded by the timeout");
});
