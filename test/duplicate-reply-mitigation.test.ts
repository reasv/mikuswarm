import assert from "node:assert/strict";
import test from "node:test";

import { SessionClaims, coTargetOwnerSteerableSoon } from "../src/agent/session-claims.js";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import { renderSatelliteBlock } from "../src/workspace/prompt.js";
import { createSendMessageTool, type SendMessageToolContext } from "../src/tools/send-message.js";
import { createSpawnSessionTool, type SpawnCoReplyResult } from "../src/tools/spawn-session.js";
import type { CanonicalChatEvent, IChatProvider, OutboundTarget } from "../src/types.js";
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

test("SessionClaims: claimantOf surfaces another session's claim (incl. un-attributed), excludes self", () => {
  const claims = new SessionClaims();
  // Inserted at accept time, no session id yet (the accept→launch gap / queued).
  claims.claim(TK, { triggerId: "t1", externalId: "$n3m7", triggerTimestamp: 1000, createdAt: 1000 });
  // Un-attributed IS surfaced now (review #4) — still "being handled" — but un-named.
  const pending = claims.claimantOf(TK, "$n3m7", "s-self");
  assert.ok(pending);
  assert.equal(pending?.sessionId, undefined);

  claims.attachSession(TK, "$n3m7", "s-owner");
  // Surfaced to another session, now named.
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

test("SessionClaims: coTargetClaim matches on the trigger's OWN reply-target (Case B)", () => {
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
  assert.equal(claims.coTargetClaim(TK, "$beat")?.sessionId, "s-1");
  // A reply to the trigger message itself ($reply1) is NOT a co-target match
  // (that is Case A — handled by the marker/guard, not coalescing).
  assert.equal(claims.coTargetClaim(TK, "$reply1"), undefined);
  // Self is excluded.
  assert.equal(claims.coTargetClaim(TK, "$beat", "s-1"), undefined);
  // A queued (un-attributed) co-target claim IS returned now (spec
  // DEFERRED-COALESCING) — the caller defers the co-reply until the owner goes live
  // rather than skipping it. Its sessionId is still undefined.
  claims.claim(TK, { triggerId: "t9", externalId: "$reply9", replyToExternalId: "$beat2", triggerTimestamp: 1, createdAt: 1 });
  const queuedMatch = claims.coTargetClaim(TK, "$beat2");
  assert.equal(queuedMatch?.externalId, "$reply9");
  assert.equal(queuedMatch?.sessionId, undefined);
});

test("coTargetOwnerSteerableSoon: defer while pre-live, spawn once terminal", () => {
  // Un-attributed owner (queued / accept→launch window) → will launch → defer.
  assert.equal(coTargetOwnerSteerableSoon(false, undefined), true);
  // Attributed but still building (attachSession→attachAgent window) → defer.
  assert.equal(coTargetOwnerSteerableSoon(true, "created"), true);
  assert.equal(coTargetOwnerSteerableSoon(true, "running"), true);
  // Attributed owner that has reached a terminal/evicted state → never steerable
  // again → fall through to a normal spawn (§5.2).
  assert.equal(coTargetOwnerSteerableSoon(true, "completed"), false);
  assert.equal(coTargetOwnerSteerableSoon(true, "discarded"), false);
  assert.equal(coTargetOwnerSteerableSoon(true, "failed-resumable"), false);
  assert.equal(coTargetOwnerSteerableSoon(true, "interrupted"), false);
  // Attributed owner whose record is already gone (evicted) → spawn.
  assert.equal(coTargetOwnerSteerableSoon(true, undefined), false);
});

test("SessionClaims: snapshotForBuild excludes self, includes others (attributed + pending)", () => {
  const claims = new SessionClaims();
  claims.claim(TK, { triggerId: "t1", externalId: "$a", triggerTimestamp: 1, createdAt: 1 });
  claims.claim(TK, { triggerId: "t2", externalId: "$b", triggerTimestamp: 2, createdAt: 2 });
  claims.claim(TK, { triggerId: "t3", externalId: "$c", triggerTimestamp: 3, createdAt: 3 }); // queued, no session
  claims.attachSession(TK, "$a", "s-self");
  claims.attachSession(TK, "$b", "s-other");

  const snap = claims.snapshotForBuild(TK, "s-self");
  assert.equal(snap.has("$a"), false); // self excluded
  assert.equal(snap.get("$b")?.sessionId, "s-other"); // other, attributed
  // Un-attributed (queued) IS included now (review #4), as a pending marker.
  assert.equal(snap.has("$c"), true);
  assert.equal(snap.get("$c")?.sessionId, undefined);
  assert.equal(snap.size, 2);
});

// ── Render marker (§4) ──────────────────────────────────────────────────────

test("renderRichMessage emits <handled_by_session> when claimedBy hits, before the body", () => {
  const ev = chatEvent({ externalId: "$n3m7", body: "> plagueis" });
  const out = renderRichMessage(ev, { claimedBy: (id) => (id === "$n3m7" ? { sessionId: "s-TQBfXQVCYQ" } : undefined) });
  assert.match(out, /<handled_by_session id="s-TQBfXQVCYQ"\/>/);
  // Marker precedes the body text.
  assert.ok(out.indexOf("handled_by_session") < out.indexOf("plagueis"));
});

test("renderRichMessage emits a pending marker for an un-attributed (queued) claim", () => {
  const ev = chatEvent({ externalId: "$n3m7", body: "> plagueis" });
  // claimedBy returns a marker with no sessionId (a pending owner — review #4).
  const out = renderRichMessage(ev, { claimedBy: (id) => (id === "$n3m7" ? {} : undefined) });
  assert.match(out, /<handled_by_session pending="true"\/>/);
  assert.doesNotMatch(out, /handled_by_session id="/); // no session id to name yet
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

// ── co-target admission ordering: coalesce→claim must have no yield (review #5) ─
//
// This models the trigger-admission span of `handleInbound` (src/app.ts, the region
// `coalesceCoTargetReply` → `triggerCoordinator.accept` → `addClaim`, then the
// deferred `await resolveTriggerGroup`). The bug (#5): a real event-loop yield
// (`await resolveTriggerGroup`) sat BETWEEN the co-target coalesce check (which reads
// the registry keyed on `replyToExternalId`) and the claim registration (`addClaim`).
// Two DISTINCT replies to the SAME target could both pass coalesce — neither had
// claimed yet — before either reached `addClaim`, so both spawned and the bot replied
// twice. The fix moves `await resolveTriggerGroup` to AFTER accept+addClaim, making the
// coalesce→claim span synchronous.
//
// We reproduce the exact ordering with the real `SessionClaims`, parameterized by a
// `yieldBeforeClaim` flag. `yieldBeforeClaim:true` is the PRE-FIX ordering and must
// double-spawn; `false` is the POST-FIX ordering and must coalesce the sibling.

interface AdmitResult {
  action: "spawn" | "coalesce";
}

/**
 * Faithful model of the handleInbound co-target admission span. With
 * `yieldBeforeClaim:true` the (former) `await resolveTriggerGroup` runs between the
 * coalesce check and `addClaim` — the pre-fix ordering. With `false` the claim is
 * registered first and the resolve runs after — the post-fix ordering.
 *
 * `resolveTriggerGroup` is modeled as a microtask boundary (`await Promise.resolve()`),
 * exactly the kind of real event-loop yield the live code performs (it awaits a
 * single-writer SQLite enqueue). The coalesce decision mirrors the real one: a
 * co-target claim within the window (a non-reply or out-of-window sibling never
 * coalesces — same as `coalesceCoTargetReply`).
 */
async function admit(
  claims: SessionClaims,
  inbound: { externalId: string; replyToExternalId?: string; timestamp: number; sessionId: string },
  windowMs: number,
  yieldBeforeClaim: boolean,
): Promise<AdmitResult> {
  // 1. coalesceCoTargetReply: a reply whose target already has a co-target owner
  //    within the window is folded in (no spawn).
  if (inbound.replyToExternalId !== undefined) {
    const match = claims.coTargetClaim(TK, inbound.replyToExternalId, inbound.sessionId);
    if (match && Math.abs(inbound.timestamp - match.triggerTimestamp) <= windowMs) {
      return { action: "coalesce" };
    }
  }

  // 2. PRE-FIX: the resolveTriggerGroup yield happens here, before the claim.
  if (yieldBeforeClaim) await Promise.resolve();

  // 3. accept + addClaim (synchronous in the real code right after accept).
  claims.claim(TK, {
    triggerId: `t-${inbound.externalId}`,
    externalId: inbound.externalId,
    replyToExternalId: inbound.replyToExternalId,
    triggerTimestamp: inbound.timestamp,
    createdAt: inbound.timestamp,
  });
  claims.attachSession(TK, inbound.externalId, inbound.sessionId);

  // 4. POST-FIX: the resolveTriggerGroup yield happens here, after the claim.
  if (!yieldBeforeClaim) await Promise.resolve();

  return { action: "spawn" };
}

test("co-target burst (PRE-FIX ordering) double-spawns — the #5 race, guarded against regression", async () => {
  // Two DISTINCT replies to the SAME beat, admitted concurrently. With the yield
  // BETWEEN coalesce and claim (pre-fix), both pass coalesce before either claims.
  const claims = new SessionClaims();
  const a = { externalId: "$replyA", replyToExternalId: "$beat", timestamp: 1000, sessionId: "s-A" };
  const b = { externalId: "$replyB", replyToExternalId: "$beat", timestamp: 1001, sessionId: "s-B" };

  // Interleave across the await window: both coalesce checks run before either claim.
  const [ra, rb] = await Promise.all([
    admit(claims, a, 5000, /* yieldBeforeClaim */ true),
    admit(claims, b, 5000, /* yieldBeforeClaim */ true),
  ]);

  // Pre-fix: BOTH spawn → two replies (this is the bug the fix removes).
  assert.equal(ra.action, "spawn");
  assert.equal(rb.action, "spawn");
});

test("co-target burst (POST-FIX ordering) yields exactly ONE spawn, the sibling coalesces", async () => {
  // Same burst, but with the claim registered BEFORE the yield (post-fix ordering).
  // Whichever sibling wins the coalesce→claim race first claims $beat; the other now
  // observes that claim and coalesces instead of spawning a twin.
  const claims = new SessionClaims();
  const a = { externalId: "$replyA", replyToExternalId: "$beat", timestamp: 1000, sessionId: "s-A" };
  const b = { externalId: "$replyB", replyToExternalId: "$beat", timestamp: 1001, sessionId: "s-B" };

  const [ra, rb] = await Promise.all([
    admit(claims, a, 5000, /* yieldBeforeClaim */ false),
    admit(claims, b, 5000, /* yieldBeforeClaim */ false),
  ]);

  const actions = [ra.action, rb.action].sort();
  assert.deepEqual(actions, ["coalesce", "spawn"], "exactly one spawn, the sibling coalesces");
  // And the registry holds exactly one claim on the shared beat's owner side.
  assert.ok(claims.coTargetClaim(TK, "$beat"), "the winning sibling is the registered co-target owner");
});

test("post-fix ordering preserves the normal single-trigger path (distinct targets both spawn)", async () => {
  // Two replies to DIFFERENT beats are independent — both spawn under either ordering.
  // Confirms the fix does not over-coalesce non-co-target inbounds.
  const claims = new SessionClaims();
  const a = { externalId: "$replyA", replyToExternalId: "$beat1", timestamp: 1000, sessionId: "s-A" };
  const b = { externalId: "$replyB", replyToExternalId: "$beat2", timestamp: 1001, sessionId: "s-B" };

  const [ra, rb] = await Promise.all([
    admit(claims, a, 5000, false),
    admit(claims, b, 5000, false),
  ]);

  assert.equal(ra.action, "spawn");
  assert.equal(rb.action, "spawn");
});

test("post-fix ordering: an out-of-window sibling still spawns (coalesce window preserved)", async () => {
  // First reply claims $beat; a second reply to $beat arrives far outside the window →
  // it does NOT coalesce (mirrors coalesceCoTargetReply's window check), it spawns.
  const claims = new SessionClaims();
  await admit(claims, { externalId: "$replyA", replyToExternalId: "$beat", timestamp: 1000, sessionId: "s-A" }, 5000, false);
  const rb = await admit(
    claims,
    { externalId: "$replyB", replyToExternalId: "$beat", timestamp: 1_000_000, sessionId: "s-B" },
    5000,
    false,
  );
  assert.equal(rb.action, "spawn");
});

test("post-fix ordering: a non-reply trigger never coalesces (Case A unaffected)", async () => {
  // A plain (non-reply) trigger has no reply-target → it is never a co-target sibling.
  const claims = new SessionClaims();
  await admit(claims, { externalId: "$replyA", replyToExternalId: "$beat", timestamp: 1000, sessionId: "s-A" }, 5000, false);
  const plain = await admit(
    claims,
    { externalId: "$plainB", replyToExternalId: undefined, timestamp: 1001, sessionId: "s-B" },
    5000,
    false,
  );
  assert.equal(plain.action, "spawn");
});

// ── send_message reply guard (§6) ───────────────────────────────────────────

function sendCtx(overrides: Partial<SendMessageToolContext> = {}): SendMessageToolContext {
  const provider = {
    id: "matrix",
    capabilities: {},
    async start() {},
    async stop() {},
    accountIds() { return []; },
    getSelf() { return undefined; },
    ownsUserId() { return false; },
    enrichment() { return undefined; },
    async send(target: OutboundTarget) {
      return { provider: "matrix", target, externalId: "$sent", deliveredAt: Date.now() };
    },
    async setTyping() {},
  } as unknown as IChatProvider;
  const target: OutboundTarget = { provider: "matrix", timelineKey: TK, roomId: "!room:server.org" };
  const timeline = {
    append: async () => {},
    ingestAssistantSend: async () => "appended" as const,
  } as unknown as TimelineStore;
  return { provider, target, timeline, agentSessionId: "s-self", ...overrides };
}

test("send_message guard refuses a reply to a message another session claimed, without terminating", async () => {
  let sent = false;
  const ctx = sendCtx({
    isClaimedByOther: (id) => (id === "$n3m7" ? { sessionId: "s-TQBfXQVCYQ" } : undefined),
  });
  // Spy on send to prove it never fires.
  (ctx.provider as { send: IChatProvider["send"] }).send = async (target) => {
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

test("send_message guard refuses a reply to a message claimed by a not-yet-named (pending) session", async () => {
  let sent = false;
  // The owner is un-attributed → marker carries no sessionId (review #4).
  const ctx = sendCtx({ isClaimedByOther: (id) => (id === "$n3m7" ? {} : undefined) });
  (ctx.provider as { send: IChatProvider["send"] }).send = async (target) => {
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
  assert.match((result.content[0] as { text: string }).text, /a session that's starting up/);
  assert.notEqual(result.terminate, true);
});

test("send_message guard ignores non-reply sends and unclaimed reply targets", async () => {
  const sends: string[] = [];
  const ctx = sendCtx({ isClaimedByOther: (id) => (id === "$claimed" ? { sessionId: "s-o" } : undefined) });
  (ctx.provider as { send: IChatProvider["send"] }).send = async (target) => {
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
