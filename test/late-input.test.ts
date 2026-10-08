/**
 * Unit tests for the late-input controller (ARCHITECTURE.md §8 "Late input"):
 * the irreversibility hold, effect tracking, the replay store's lineage rule,
 * and request progress for the abort rule.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  HELD_CALL_CANCELLED,
  LateInputSession,
  callKey,
  lineageCallCount,
  resolveLateInputSettings,
  takeQueuedSteers,
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
  ctl.requestRestart({ reason: "edit_redo", causeEventIds: ["e"], fallbacks: [], addedEventIds: [], removedEventIds: [] });
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

function assistantCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } as unknown as AgentMessage;
}

for (const [label, rawArgs, executed] of [
  ["an explicit null optional (dropped by validation)", { query: "x", limit: null }, { query: "x" }],
  ["a coerced string number", { query: "x", limit: "5" }, { query: "x", limit: 5 }],
  ["a prefill analysis argument (stripped before the replay wrapper)", { query: "x", analysis: "We must search" }, { query: "x" }],
] as const) {
  test(`replay: a repeated call on the same lineage executes fresh (${label})`, async () => {
    const ctl = session();
    let runs = 0;
    const live: AgentMessage[] = [];
    const [read] = ctl.wrapReplayTools([tool("read_messages", () => (runs += 1))], () => live);
    live.push(assistantCall("c1", "read_messages", rawArgs as Record<string, unknown>));
    await read!.execute("c1", executed as never, undefined, undefined);
    // The model calls it again within the same line of work: it wants a new value.
    live.push(assistantCall("c2", "read_messages", rawArgs as Record<string, unknown>));
    await read!.execute("c2", executed as never, undefined, undefined);
    assert.equal(runs, 2, "the second call on the same lineage executes, it is not replayed");
  });
}

test("replay: a prefill analysis argument does not stop a redo from replaying the call", async () => {
  const ctl = session();
  let runs = 0;
  let live: AgentMessage[] = [];
  const [search] = ctl.wrapReplayTools([tool("web_search", () => (runs += 1))], () => live);
  live = [assistantCall("a", "web_search", { query: "x", analysis: "We must look" })];
  await search!.execute("a", { query: "x" }, undefined, undefined);
  live = [assistantCall("b", "web_search", { query: "x", analysis: "We must look it up" })];
  await search!.execute("b", { query: "x" }, undefined, undefined);
  assert.equal(runs, 1, "replayed on the new lineage");
});

test("effects: a visible call counts while it executes, and after it threw", async () => {
  const ctl = session({ holdMs: 0 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = { ...tool("send_message"), execute: async () => { await gate; throw new Error("aborted"); } } as unknown as AgentTool;
  const [send] = ctl.wrapHoldTools([slow]);
  const running = send!.execute("c1", { message: "hi" }, undefined, undefined).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctl.hasIrreversibleEffect(), true, "a send on its way out is an effect");
  assert.equal(ctl.canRedo(), false);
  release();
  await running;
  assert.equal(ctl.hasIrreversibleEffect(), true, "a throw may have delivered");
});

test("effects: a no-op undoable call is not compensated", async () => {
  const ctl = session({ holdMs: 0 });
  const noop = { ...tool("react"), execute: async () => ({ content: [{ type: "text", text: "removed 0 reaction(s)" }], details: { changed: false } }) } as unknown as AgentTool;
  const [react] = ctl.wrapHoldTools([noop]);
  await react!.execute("c1", { message_id: "m", emoji: "x", remove: true }, undefined, undefined);
  assert.equal(ctl.undoableEffects().length, 0);
});

test("hold: a redo re-arms the hold for the new lineage", async () => {
  const ctl = session({ holdMs: 200 });
  const [send] = ctl.wrapHoldTools([tool("react")]);
  await send!.execute("c1", { message_id: "m", emoji: "x" }, undefined, undefined);
  assert.equal(ctl.holdActive(), false, "released by the first visible call");
  ctl.bind({ signal: undefined, abort: () => undefined } as unknown as Agent, undefined);
  assert.equal(ctl.holdActive(), true, "the rebuilt agent's first visible call is held again");
});

test("restart: a repeatable call executing is let finish before the agent is aborted", async () => {
  const ctl = session();
  let aborted = false;
  ctl.bind({ signal: new AbortController().signal, abort: () => (aborted = true) } as unknown as Agent, new RequestProgress(false));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let runs = 0;
  const image = { ...tool("image_generate"), execute: async () => { runs += 1; await gate; return { content: [{ type: "text", text: "image" }], details: {} }; } } as unknown as AgentTool;
  const live: AgentMessage[] = [assistantCall("c1", "image_generate", { prompt: "cat" })];
  const [gen] = ctl.wrapHoldTools(ctl.wrapReplayTools([image], () => live));
  const running = gen!.execute("c1", { prompt: "cat" }, undefined, undefined);
  await new Promise((r) => setTimeout(r, 20));
  ctl.requestRestart({ reason: "edit_redo", causeEventIds: ["e"], fallbacks: [], addedEventIds: [], removedEventIds: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(aborted, false, "not aborted while the repeatable call runs");
  release();
  await running;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(aborted, true, "aborted once it finished");
  // The redo's identical call is served from the store.
  const redoLive: AgentMessage[] = [assistantCall("c2", "image_generate", { prompt: "cat" })];
  const [again] = ctl.wrapReplayTools([image], () => redoLive);
  await again!.execute("c2", { prompt: "cat" }, undefined, undefined);
  assert.equal(runs, 1, "the redo did not pay again");
});

test("run end: a step still pending is returned and cleared; the end is stamped once", () => {
  const ctl = session();
  const fallback = async () => undefined;
  ctl.requestCancel("delete_trigger", "e", fallback);
  const dropped = ctl.markEnded(1000);
  assert.equal(dropped?.kind, "cancel");
  assert.equal(ctl.peekPending(), undefined);
  assert.equal(ctl.markEnded(2000), undefined);
  assert.equal(ctl.runEndedAt, 1000);
});

test("redo: queued steers the old agent never read can be moved", () => {
  const agent = new Agent({ streamFn: (() => { throw new Error("unused"); }) as never });
  const message = { role: "user", content: "late", timestamp: 1 } as unknown as AgentMessage;
  agent.steer(message);
  assert.deepEqual(takeQueuedSteers(agent), [message]);
  assert.equal(agent.hasQueuedMessages(), false);
});

test("redo: a correction while a redo rebuilds joins the rebuild instead of a second redo", () => {
  const ctl = session();
  const req = (id: string) => ({ reason: "edit_redo" as const, causeEventIds: [id], fallbacks: [], addedEventIds: [], removedEventIds: [] });
  ctl.markRebuilding();
  ctl.markBuildStarted();
  ctl.requestRestart(req("e2"));
  assert.equal(ctl.peekPending(), undefined, "no step for the new agent's first request to trip on");
  assert.deepEqual(ctl.takeRebuildBeforeStart()?.causeEventIds, ["e2"]);
});
