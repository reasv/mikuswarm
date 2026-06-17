import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager, SessionClaims, type AgentSessionRecord } from "../src/agent/index.js";
import { renderRichMessage } from "../src/context/renderer.js";
import { renderSatelliteBlock } from "../src/workspace/prompt.js";
import type { CanonicalChatEvent, InboundChatEvent, TriggerInfo } from "../src/types.js";
import type { WorkspaceContent, SatelliteRuntimeInput } from "../src/workspace/types.js";

// Regression tests for spec CLAIM-VISIBILITY-SERIALIZATION: a triggered session must
// be CLAIMED and VISIBLE-AS-RUNNING before it waits on enrichment/captions, so a
// later message's session never observes an earlier one as unclaimed or not-running.
//
// These exercise the REAL SessionManager + SessionClaims + satellite/marker renderers
// against a faithful model of `launchSession`'s post-fix ordering (the thing under
// test): createPlaceholder → markRunning → claim-attach (→ visible) → awaitTriggerReadiness
// → build. The `waitBeforeVisible` flag flips to the PRE-FIX ordering (wait first) so
// the incident is reproduced and guarded against regression.

const TK = "matrix:miku:room:!room:server.org";
const TK2 = "matrix:miku:room:!other:server.org";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain the microtask queue so a parked `await` advances to its next point. */
const tick = () => new Promise((r) => setImmediate(r));

function chatEvent(externalId: string, id: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    externalId,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:server.org", displayName: "Alice" },
    body: `message ${externalId}`,
    timestamp,
    receivedAt: timestamp,
  };
}

function inboundFor(externalId: string, id: string, timestamp: number): InboundChatEvent {
  const event = chatEvent(externalId, id, timestamp);
  const trigger: TriggerInfo = { type: "mention", reason: "test", triggeredBy: event.sender };
  return {
    provider: "matrix",
    timelineKey: TK,
    event: { ...event, trigger },
    trigger,
    outboundTarget: { provider: "matrix", accountId: "miku", roomId: "!room:server.org" } as InboundChatEvent["outboundTarget"],
  };
}

function emptyWorkspace(): WorkspaceContent {
  return { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };
}

function runtimeInput(overrides: Partial<SatelliteRuntimeInput>): SatelliteRuntimeInput {
  return {
    timelineKey: TK,
    trigger: chatEvent("$kick", "evt-kick", 0),
    activeSessions: [],
    ...overrides,
  };
}

/**
 * Faithful model of `launchSession`'s lifecycle tail (spec §4.1). The claim is
 * inserted by the caller BEFORE this runs (mirroring `handleInbound`'s `addClaim`
 * at the accept seam). `waitBeforeVisible=false` is the POST-FIX ordering under test;
 * `true` is the PRE-FIX ordering that produced the incident.
 */
async function launchModel(args: {
  sessions: SessionManager;
  claims: SessionClaims;
  inbound: InboundChatEvent;
  readiness: () => Promise<void>;
  waitBeforeVisible?: boolean;
  onVisible?: (sessionId: string) => void;
  onBuild?: (sessionId: string) => void;
}): Promise<string> {
  const { sessions, claims, inbound } = args;
  const ext = inbound.event.externalId;
  if (args.waitBeforeVisible) await args.readiness(); // PRE-FIX: blocks BEFORE the placeholder exists
  const session = sessions.createPlaceholder(inbound); // visible in activeForTimeline NOW
  sessions.markRunning(session.id);
  if (ext) claims.attachSession(inbound.timelineKey, ext, session.id); // claim attributed
  sessions.onSettle(session.id, () => claims.releaseSession(inbound.timelineKey, session.id));
  args.onVisible?.(session.id);
  if (!args.waitBeforeVisible) await args.readiness(); // POST-FIX: blocks AFTER it is visible/attributed
  args.onBuild?.(session.id);
  return session.id;
}

test("incident regression: a captioning-blocked earlier session is visible + claimed to a later session's build", async () => {
  const sessions = new SessionManager();
  const claims = new SessionClaims();

  // M1 (earlier) is accepted + claimed at the accept seam, then launches; its
  // readiness blocks on a (stubbed) pending caption.
  const m1Inbound = inboundFor("$m1", "evt-m1", 1000);
  claims.claim(TK, { triggerId: "evt-m1", externalId: "$m1", triggerTimestamp: 1000, createdAt: 1000 });
  const m1Gate = deferred();
  let m1Id: string | undefined;
  const m1 = launchModel({
    sessions,
    claims,
    inbound: m1Inbound,
    readiness: () => m1Gate.promise,
    onVisible: (id) => {
      m1Id = id;
    },
  });

  // Let M1 reach its readiness wait. It is now created/running + attributed.
  await tick();
  assert.ok(m1Id, "M1 reached createPlaceholder (visible) BEFORE its readiness wait");
  assert.equal(sessions.activeForTimeline(TK).length, 1, "M1 is in activeForTimeline while blocked on captions");
  assert.equal(
    claims.claimantOf(TK, "$m1", "s-someone-else")?.sessionId,
    m1Id,
    "M1's claim is ATTRIBUTED during the wait (not merely pending)",
  );

  // M2 (later) is accepted + claimed and launches with no media (readiness resolves).
  claims.claim(TK, { triggerId: "evt-m2", externalId: "$m2", triggerTimestamp: 2000, createdAt: 2000 });
  let m2SawActive: AgentSessionRecord[] = [];
  let satellite = "";
  let m1Marker = "";
  await launchModel({
    sessions,
    claims,
    inbound: inboundFor("$m2", "evt-m2", 2000),
    readiness: async () => {},
    onBuild: (m2Id) => {
      m2SawActive = sessions.activeForTimeline(TK);
      const snapshot = claims.snapshotForBuild(TK, m2Id);
      satellite = renderSatelliteBlock(runtimeInput({ selfSessionId: m2Id, activeSessions: m2SawActive }), emptyWorkspace());
      m1Marker = renderRichMessage(m1Inbound.event, { claimedBy: (id) => snapshot.get(id) });
    },
  });

  // The fix: M2's build saw M1 as running, the coordination line that explains the
  // marker, and the attributed marker on M1's message.
  assert.ok(m2SawActive.some((s) => s.id === m1Id), "M2's build sees M1 in activeForTimeline (visible-before-wait)");
  assert.match(satellite, /<active_sessions>/);
  assert.match(satellite, /<coordination>/, "the coordination line that gives the marker meaning is present");
  assert.match(m1Marker, /<handled_by_session id="/, "M1's message is marked, named (attributed)");

  m1Gate.resolve();
  await m1;
});

test("PRE-FIX ordering reproduces the incident: bare marker, NO coordination line, empty active list", async () => {
  // Same scenario, but M1 waits on its caption BEFORE creating its placeholder
  // (the old ordering). While M1 is blocked it is invisible in activeForTimeline,
  // so M2's build sees an un-explained `<handled_by_session>` marker.
  const sessions = new SessionManager();
  const claims = new SessionClaims();

  const m1Inbound = inboundFor("$m1", "evt-m1", 1000);
  // The claim IS added at accept time in BOTH orderings (that part never regressed).
  claims.claim(TK, { triggerId: "evt-m1", externalId: "$m1", triggerTimestamp: 1000, createdAt: 1000 });
  const m1Gate = deferred();
  let m1Id: string | undefined;
  const m1 = launchModel({
    sessions,
    claims,
    inbound: m1Inbound,
    readiness: () => m1Gate.promise,
    waitBeforeVisible: true,
    onVisible: (id) => {
      m1Id = id;
    },
  });

  await tick();
  assert.equal(m1Id, undefined, "PRE-FIX: M1 is parked in readiness BEFORE its placeholder exists");
  assert.equal(sessions.activeForTimeline(TK).length, 0, "PRE-FIX: M1 is invisible while blocked on captions");

  claims.claim(TK, { triggerId: "evt-m2", externalId: "$m2", triggerTimestamp: 2000, createdAt: 2000 });
  let m2SawActive: AgentSessionRecord[] = [];
  let satellite = "";
  let m1Marker = "";
  await launchModel({
    sessions,
    claims,
    inbound: inboundFor("$m2", "evt-m2", 2000),
    readiness: async () => {},
    onBuild: (m2Id) => {
      m2SawActive = sessions.activeForTimeline(TK);
      const snapshot = claims.snapshotForBuild(TK, m2Id);
      satellite = renderSatelliteBlock(runtimeInput({ selfSessionId: m2Id, activeSessions: m2SawActive }), emptyWorkspace());
      m1Marker = renderRichMessage(m1Inbound.event, { claimedBy: (id) => snapshot.get(id) });
    },
  });

  // The incident: M1 is absent from activeForTimeline → no coordination line, even
  // though the (un-attributed) claim still renders a bare pending marker on M1.
  assert.ok(!m2SawActive.some((s) => s.id === m1Id), "PRE-FIX: M2's build does NOT see M1 as active");
  assert.doesNotMatch(satellite, /<coordination>/, "PRE-FIX: no coordination line — the marker is un-explained (the bug)");
  assert.match(m1Marker, /<handled_by_session pending="true"\/>/, "PRE-FIX: only a bare pending marker (claim added but owner invisible)");

  m1Gate.resolve();
  await m1;
});

test("readiness-before-build holds: the relocated wait still gates the build (post-fix)", async () => {
  // The build must observe a COMPLETED readiness wait — i.e., the relocated wait still
  // runs before factory.create (spec §7.2 "countPendingCaptions == 0 at build").
  const sessions = new SessionManager();
  const claims = new SessionClaims();
  claims.claim(TK, { triggerId: "evt-m1", externalId: "$m1", triggerTimestamp: 1000, createdAt: 1000 });

  let readinessDone = false;
  let buildSawReadinessDone: boolean | undefined;
  let visibleBeforeReadiness: boolean | undefined;
  await launchModel({
    sessions,
    claims,
    inbound: inboundFor("$m1", "evt-m1", 1000),
    readiness: async () => {
      // Simulate captions completing during the wait.
      await tick();
      readinessDone = true;
    },
    onVisible: () => {
      // The session is visible BEFORE the readiness wait resolves.
      visibleBeforeReadiness = readinessDone === false;
    },
    onBuild: () => {
      buildSawReadinessDone = readinessDone;
    },
  });

  assert.equal(visibleBeforeReadiness, true, "the session is visible before the wait completes");
  assert.equal(buildSawReadinessDone, true, "the build runs only AFTER readiness resolves");
});

test("a settled session releases its claim (the later build no longer sees it)", async () => {
  const sessions = new SessionManager();
  const claims = new SessionClaims();
  claims.claim(TK, { triggerId: "evt-m1", externalId: "$m1", triggerTimestamp: 1000, createdAt: 1000 });

  let m1Id: string | undefined;
  await launchModel({
    sessions,
    claims,
    inbound: inboundFor("$m1", "evt-m1", 1000),
    readiness: async () => {},
    onVisible: (id) => {
      m1Id = id;
    },
  });
  assert.ok(m1Id);
  assert.equal(claims.claimantOf(TK, "$m1", "s-other")?.sessionId, m1Id, "claimed while running");

  // Settle the run → onSettle releases the claim (mirrors the real settle seam).
  sessions.markCompleted(m1Id!);
  assert.equal(sessions.activeForTimeline(TK).length, 0, "settled session leaves activeForTimeline");
  assert.equal(claims.claimantOf(TK, "$m1", "s-other"), undefined, "settled session's claim is released");
});

// ── claim_out_of_order advisory guard (§4.4) ─────────────────────────────────

test("SessionClaims.claim warns claim_out_of_order only when a strictly-older trigger follows a newer one", () => {
  const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const claims = new SessionClaims({ warn: (event, fields) => warnings.push({ event, fields }) });

  // First claim: nothing to compare against.
  claims.claim(TK, { triggerId: "t1", externalId: "$a", triggerTimestamp: 1000, createdAt: 1000 });
  assert.equal(warnings.length, 0);

  // In arrival order (newer after older): no warning.
  claims.claim(TK, { triggerId: "t2", externalId: "$b", triggerTimestamp: 2000, createdAt: 2000 });
  assert.equal(warnings.length, 0, "in-order insert does not warn");

  // OUT of order: a strictly-older trigger lands after a newer one → warn once.
  claims.claim(TK, { triggerId: "t3", externalId: "$c", triggerTimestamp: 1500, createdAt: 3000 });
  assert.equal(warnings.length, 1, "an older-after-newer claim warns");
  assert.equal(warnings[0].event, "claim_out_of_order");
  assert.equal(warnings[0].fields?.externalId, "$c");
  assert.equal(warnings[0].fields?.triggerTimestamp, 1500);
  assert.equal(warnings[0].fields?.newestExistingTimestamp, 2000);

  // A re-insert of the (newest) same externalId is excluded → no new warning.
  claims.claim(TK, { triggerId: "t2", externalId: "$b", triggerTimestamp: 2000, createdAt: 4000 });
  assert.equal(warnings.length, 1, "re-inserting the same trigger does not warn");

  // A tie (equal newest timestamp) is not strictly older → no warning.
  claims.claim(TK, { triggerId: "t4", externalId: "$d", triggerTimestamp: 2000, createdAt: 5000 });
  assert.equal(warnings.length, 1, "a tie does not warn (strict <)");

  // A different timeline is independent → no warning even though older.
  claims.claim(TK2, { triggerId: "t5", externalId: "$e", triggerTimestamp: 1, createdAt: 6000 });
  assert.equal(warnings.length, 1, "ordering is per-timeline");
});

test("SessionClaims without a logger never throws on out-of-order inserts (guard is opt-in)", () => {
  const claims = new SessionClaims(); // no logger
  claims.claim(TK, { triggerId: "t1", externalId: "$a", triggerTimestamp: 2000, createdAt: 1 });
  // Older-after-newer with no logger: silently inserts, no throw.
  assert.doesNotThrow(() =>
    claims.claim(TK, { triggerId: "t2", externalId: "$b", triggerTimestamp: 1000, createdAt: 2 }),
  );
  assert.equal(claims.claimantOf(TK, "$b", "s-x")?.triggerId, "t2");
});
