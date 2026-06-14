import assert from "node:assert/strict";
import test from "node:test";

import { SessionClaims } from "../src/agent/session-claims.js";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import { renderSatelliteBlock } from "../src/workspace/prompt.js";
import { createSendMessageTool, type SendMessageToolContext } from "../src/tools/send-message.js";
import { createSpawnSessionTool, type SpawnCoReplyResult } from "../src/tools/spawn-session.js";
import type { CanonicalChatEvent, ChatProvider, OutboundTarget } from "../src/types.js";
import type { TimelineStore } from "../src/timeline/index.js";
import type { WorkspaceContent, SatelliteRuntimeInput } from "../src/workspace/types.js";

const TK = "matrix:miku:room:!room:server.org";

function chatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "evt-1",
    externalId: "$msg1",
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:server.org", displayName: "Alice" },
    body: "wait what the fuck is that legit?",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ── SessionClaims registry (§3) ─────────────────────────────────────────────

test("SessionClaims: claimantOf returns another session's attributed claim, excludes self and queued", () => {
  const claims = new SessionClaims();
  // Inserted at accept time, no session id yet (the accept→launch gap).
  claims.claim(TK, { triggerId: "t1", externalId: "$n3m7", triggerTimestamp: 1000, createdAt: 1000 });
  // Un-attributed → not surfaced (nothing to name/render).
  assert.equal(claims.claimantOf(TK, "$n3m7", "s-self"), undefined);

  claims.attachSession(TK, "$n3m7", "s-owner");
  // Surfaced to another session.
  assert.equal(claims.claimantOf(TK, "$n3m7", "s-self")?.sessionId, "s-owner");
  // Never surfaced to the owner itself (a session may always answer its own trigger).
  assert.equal(claims.claimantOf(TK, "$n3m7", "s-owner"), undefined);
  // Unknown id / other timeline → nothing.
  assert.equal(claims.claimantOf(TK, "$other", "s-self"), undefined);
  assert.equal(claims.claimantOf("matrix:miku:room:!x", "$n3m7", "s-self"), undefined);
});

test("SessionClaims: releaseSession drops a settled session's claims so it stops deterring", () => {
  const claims = new SessionClaims();
  claims.claim(TK, { triggerId: "t1", externalId: "$a", triggerTimestamp: 1, createdAt: 1 });
  claims.claim(TK, { triggerId: "t2", externalId: "$b", triggerTimestamp: 2, createdAt: 2 });
  claims.attachSession(TK, "$a", "s-1");
  claims.attachSession(TK, "$b", "s-2");

  claims.releaseSession(TK, "s-1");
  assert.equal(claims.claimantOf(TK, "$a", "s-x"), undefined);
  assert.equal(claims.claimantOf(TK, "$b", "s-x")?.sessionId, "s-2");
});

test("SessionClaims: coTargetSession matches on the trigger's OWN reply-target (Case B)", () => {
  const claims = new SessionClaims();
  // Session s-1 was triggered by a reply to the shared beat $beat.
  claims.claim(TK, {
    triggerId: "t1",
    externalId: "$reply1",
    replyToExternalId: "$beat",
    triggerTimestamp: 5000,
    createdAt: 5000,
  });
  claims.attachSession(TK, "$reply1", "s-1");

  // A second reply to the SAME beat finds s-1 (co-target).
  assert.equal(claims.coTargetSession(TK, "$beat")?.sessionId, "s-1");
  // A reply to the trigger message itself ($reply1) is NOT a co-target match
  // (that is Case A — handled by the marker/guard, not coalescing).
  assert.equal(claims.coTargetSession(TK, "$reply1"), undefined);
  // Self is excluded.
  assert.equal(claims.coTargetSession(TK, "$beat", "s-1"), undefined);
  // Queued (un-attributed) co-target claim is not steerable → not returned.
  claims.claim(TK, { triggerId: "t9", externalId: "$reply9", replyToExternalId: "$beat2", triggerTimestamp: 1, createdAt: 1 });
  assert.equal(claims.coTargetSession(TK, "$beat2"), undefined);
});

test("SessionClaims: snapshotForBuild excludes self and un-attributed claims", () => {
  const claims = new SessionClaims();
  claims.claim(TK, { triggerId: "t1", externalId: "$a", triggerTimestamp: 1, createdAt: 1 });
  claims.claim(TK, { triggerId: "t2", externalId: "$b", triggerTimestamp: 2, createdAt: 2 });
  claims.claim(TK, { triggerId: "t3", externalId: "$c", triggerTimestamp: 3, createdAt: 3 }); // queued, no session
  claims.attachSession(TK, "$a", "s-self");
  claims.attachSession(TK, "$b", "s-other");

  const snap = claims.snapshotForBuild(TK, "s-self");
  assert.equal(snap.get("$a"), undefined); // self excluded
  assert.equal(snap.get("$b"), "s-other");
  assert.equal(snap.get("$c"), undefined); // un-attributed excluded
  assert.equal(snap.size, 1);
});

// ── Render marker (§4) ──────────────────────────────────────────────────────

test("renderRichMessage emits <handled_by_session> when claimedBy hits, before the body", () => {
  const ev = chatEvent({ externalId: "$n3m7", body: "> plagueis" });
  const out = renderRichMessage(ev, { claimedBy: (id) => (id === "$n3m7" ? "s-TQBfXQVCYQ" : undefined) });
  assert.match(out, /<handled_by_session id="s-TQBfXQVCYQ"\/>/);
  // Marker precedes the body text.
  assert.ok(out.indexOf("handled_by_session") < out.indexOf("plagueis"));
});

test("renderRichMessage omits the marker when claimedBy misses or is absent", () => {
  const ev = chatEvent({ externalId: "$n3m7" });
  assert.doesNotMatch(renderRichMessage(ev), /handled_by_session/);
  assert.doesNotMatch(renderRichMessage(ev, { claimedBy: () => undefined }), /handled_by_session/);
});

test("renderCompactMessage never emits the marker (cache-stable prefix, §4.3)", () => {
  // The compact renderer takes no claim predicate at all — confirm no marker leaks.
  const ev = chatEvent({ externalId: "$n3m7" });
  assert.doesNotMatch(renderCompactMessage(ev), /handled_by_session/);
});

// ── Coordination line (§4.2) ────────────────────────────────────────────────

function emptyWorkspace(): WorkspaceContent {
  return { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };
}

function runtimeInput(overrides: Partial<SatelliteRuntimeInput> = {}): SatelliteRuntimeInput {
  return {
    timelineKey: TK,
    trigger: chatEvent(),
    activeSessions: [],
    ...overrides,
  };
}

function sessionEntry(id: string) {
  return { id, createdAt: 1_700_000_000_000, trigger: { event: chatEvent({ body: "hi" }) } } as SatelliteRuntimeInput["activeSessions"][number];
}

test("coordination line renders only when ≥1 OTHER active session exists", () => {
  // Just self → no coordination line.
  const selfOnly = renderSatelliteBlock(
    runtimeInput({ selfSessionId: "s-self", activeSessions: [sessionEntry("s-self")] }),
    emptyWorkspace(),
  );
  assert.match(selfOnly, /<active_sessions>/);
  assert.doesNotMatch(selfOnly, /<coordination>/);

  // Self + another → coordination line present.
  const withOther = renderSatelliteBlock(
    runtimeInput({ selfSessionId: "s-self", activeSessions: [sessionEntry("s-self"), sessionEntry("s-other")] }),
    emptyWorkspace(),
  );
  assert.match(withOther, /<coordination>/);
  assert.match(withOther, /handled_by_session/);
  // The coordination line sits inside <active_sessions>.
  assert.ok(withOther.indexOf("<coordination>") < withOther.indexOf("</active_sessions>"));
  assert.ok(withOther.indexOf("<coordination>") > withOther.indexOf("<active_sessions>"));
});

test("coordination line absent when there are no active sessions at all", () => {
  const out = renderSatelliteBlock(runtimeInput({ activeSessions: [] }), emptyWorkspace());
  assert.doesNotMatch(out, /active_sessions/);
  assert.doesNotMatch(out, /coordination/);
});

// ── send_message reply guard (§6) ───────────────────────────────────────────

function sendCtx(overrides: Partial<SendMessageToolContext> = {}): SendMessageToolContext {
  const provider = {
    id: "matrix",
    capabilities: {},
    async start() {},
    async stop() {},
    subscribe() { return () => {}; },
    async send(target: OutboundTarget) {
      return { provider: "matrix", target, externalId: "$sent", deliveredAt: Date.now() };
    },
    async setTyping() {},
  } as unknown as ChatProvider;
  const target: OutboundTarget = { provider: "matrix", timelineKey: TK, roomId: "!room:server.org" };
  const timeline = { append: async () => {} } as unknown as TimelineStore;
  return { provider, target, timeline, agentSessionId: "s-self", ...overrides };
}

test("send_message guard refuses a reply to a message another session claimed, without terminating", async () => {
  let sent = false;
  const ctx = sendCtx({
    isClaimedByOther: (id) => (id === "$n3m7" ? { sessionId: "s-TQBfXQVCYQ" } : undefined),
  });
  // Spy on send to prove it never fires.
  (ctx.provider as { send: ChatProvider["send"] }).send = async (target) => {
    sent = true;
    return { provider: "matrix", target, externalId: "$x", deliveredAt: Date.now() };
  };
  const tool = createSendMessageTool(ctx);
  const result = await tool.execute("call-1", {
    message: "yeah that's real",
    is_reply: true,
    reply_to_id: "$n3m7",
    final: true,
  });
  assert.equal(sent, false);
  assert.match((result.content[0] as { text: string }).text, /being handled by another session \(s-TQBfXQVCYQ\)/);
  // Non-terminating: the agent gets another turn.
  assert.notEqual(result.terminate, true);
});

test("send_message guard ignores non-reply sends and unclaimed reply targets", async () => {
  const sends: string[] = [];
  const ctx = sendCtx({ isClaimedByOther: (id) => (id === "$claimed" ? { sessionId: "s-o" } : undefined) });
  (ctx.provider as { send: ChatProvider["send"] }).send = async (target) => {
    sends.push("sent");
    return { provider: "matrix", target, externalId: "$x", deliveredAt: Date.now() };
  };
  const tool = createSendMessageTool(ctx);
  // Reply to an UNCLAIMED message → sends.
  await tool.execute("c1", { message: "hi", is_reply: true, reply_to_id: "$free", final: true });
  // A plain (non-reply) send is never guarded, even if the text mentions a claimed id.
  await tool.execute("c2", { message: "re $claimed", is_reply: false, final: true });
  assert.equal(sends.length, 2);
});

// ── spawn_session tool (§5.4) ───────────────────────────────────────────────

test("spawn_session maps each spawnCoReply outcome, never terminating", async () => {
  const outcomes: Record<string, SpawnCoReplyResult> = {
    "$ok": { status: "spawned" },
    "$q": { status: "queued" },
    "$miss": { status: "not_found" },
    "$err": { status: "error", detail: "queue_full" },
  };
  const tool = createSpawnSessionTool({ spawnCoReply: async (id) => outcomes[id] ?? { status: "not_found" } });

  const spawned = await tool.execute("c", { message_id: "$ok" });
  assert.match((spawned.content[0] as { text: string }).text, /spawned a new session/);
  assert.equal(spawned.terminate, false);

  const queued = await tool.execute("c", { message_id: "$q" });
  assert.match((queued.content[0] as { text: string }).text, /queued a new session/);
  assert.equal(queued.terminate, false);

  const miss = await tool.execute("c", { message_id: "$miss" });
  assert.match((miss.content[0] as { text: string }).text, /no pending co-reply/);

  const err = await tool.execute("c", { message_id: "$err" });
  assert.match((err.content[0] as { text: string }).text, /could not spin off/);

  const blank = await tool.execute("c", { message_id: "   " });
  assert.match((blank.content[0] as { text: string }).text, /message_id is required/);
});
