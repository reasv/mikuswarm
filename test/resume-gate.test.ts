import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { evaluateResumeGate, type ResumeGateConfig } from "../src/app.ts";
import type { ResumeMaterial } from "../src/agent/index.ts";
import type { AgentSessionRow } from "../src/storage/index.ts";

// =============================================================================
// Review issue #2: the pre-CAS resume gate must be THROW-SAFE.
//
// `tryReplyResume` is launched as `if (await tryReplyResume(...)) return;` with NO
// try/catch at the call site (inside `launchSession`), so an exception escaping the
// gate unwinds through dispatch and drops the user's message with no reply at all —
// the one outcome the spec forbids ("degrade to FRESH, never to corruption/loss",
// §2/§7). `evaluateResumeGate` is the factored-out pre-CAS gate (mirrors
// `resumeUsageSeed`); these tests assert that ANY throw inside it RESOLVES to
// `{resume:false}` (FRESH) rather than rejecting, and that ordinary gate failures
// still degrade to FRESH through the same catch wrapper.
// =============================================================================

const NOW = 1_000_000;

/** A minimal COMPLETED, generation-0, work-bearing row that passes every gate. */
function completedRow(over: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "s1",
    timeline_key: "matrix:miku:room:!room",
    session_type: "default",
    status: "completed",
    model_id: "test-model",
    trigger_event_id: "t1",
    trigger_external_id: "$t1",
    trigger_body: "do the thing",
    trigger_sender_id: "alice",
    trigger_sender_display_name: "Alice",
    context_snapshot_json: "[]",
    context_dump_path: null,
    transcript_json: "[]",
    token_estimate: 100,
    llm_requests: 1,
    usage_input_tokens: 10,
    usage_output_tokens: 10,
    usage_cache_read_tokens: 0,
    usage_cache_write_tokens: 0,
    usage_cost: 0,
    context_tokens: 500,
    resume_generation: 0,
    no_reply: 0,
    error: null,
    created_at: NOW - 5000,
    started_at: NOW - 5000,
    updated_at: NOW - 1000,
    completed_at: NOW - 1000,
    ...over,
  };
}

/** A transcript containing a non-exempt (work) tool call, so the work gate passes. */
function workMaterial(): ResumeMaterial {
  const transcript = [
    { type: "triggerGroup", content: "do the thing" },
    { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "web_search", arguments: {} }] },
  ] as unknown as AgentMessage[];
  return { snapshot: [], transcript };
}

/** Base gate args with all callbacks succeeding; override per test. */
function gateArgs(
  over: Partial<Parameters<typeof evaluateResumeGate>[0]> = {},
): Parameters<typeof evaluateResumeGate>[0] {
  const warnings: unknown[] = [];
  const resumeCfg: ResumeGateConfig = { same_user_only: true };
  return {
    sessionId: "s1",
    getSession: () => completedRow(),
    targetEvent: { agentSessionGeneration: 0 },
    inbound: {
      timelineKey: "matrix:miku:room:!room",
      event: { sender: { id: "alice" }, timestamp: NOW },
    },
    ctx: "group",
    resumeCfg,
    exemptToolNames: new Set<string>(["send_message", "react", "media"]),
    resolveCeiling: () => 100_000,
    loadMaterial: async () => workMaterial(),
    logger: { warn: (...a: unknown[]) => warnings.push(a) },
    ...over,
  };
}

// ── Happy path / ordinary gating (the catch must not break normal behaviour) ──

test("issue #2: all gates pass → {resume:true} with the row + material", async () => {
  const v = await evaluateResumeGate(gateArgs());
  assert.equal(v.resume, true);
  if (v.resume) {
    assert.equal(v.row.id, "s1");
    assert.equal(v.material.transcript.length, 2);
  }
});

test("issue #2: a non-completed row → {resume:false} (FRESH)", async () => {
  const v = await evaluateResumeGate(gateArgs({ getSession: () => completedRow({ status: "failed-resumable" }) }));
  assert.deepEqual(v, { resume: false });
});

test("issue #2: a missing row → {resume:false} (FRESH)", async () => {
  const v = await evaluateResumeGate(gateArgs({ getSession: () => undefined }));
  assert.deepEqual(v, { resume: false });
});

test("issue #2: a stale generation → {resume:false} (FRESH)", async () => {
  // target tagged gen 0, row already bumped to gen 1 (a superseded handle).
  const v = await evaluateResumeGate(
    gateArgs({ getSession: () => completedRow({ resume_generation: 1 }), targetEvent: { agentSessionGeneration: 0 } }),
  );
  assert.deepEqual(v, { resume: false });
});

test("issue #2: a pure-chat rollout fails the work gate → {resume:false} (FRESH)", async () => {
  const chatOnly: ResumeMaterial = {
    snapshot: [],
    transcript: [
      { type: "triggerGroup", content: "hi" },
      { role: "assistant", content: [{ type: "toolCall", id: "c0", name: "send_message", arguments: {} }] },
    ] as unknown as AgentMessage[],
  };
  const v = await evaluateResumeGate(gateArgs({ loadMaterial: async () => chatOnly }));
  assert.deepEqual(v, { resume: false });
});

test("issue #2: over-ceiling context → {resume:false} (FRESH)", async () => {
  const v = await evaluateResumeGate(
    gateArgs({ getSession: () => completedRow({ context_tokens: 200_000 }), resolveCeiling: () => 100_000 }),
  );
  assert.deepEqual(v, { resume: false });
});

// ── Throw-safety: the actual issue #2 fix ─────────────────────────────────────

test("issue #2: a throwing loadMaterial degrades to FRESH, does NOT reject", async () => {
  const warnings: Array<unknown[]> = [];
  // assert.doesNotReject would catch a rejection; assert the RESOLVED value too.
  const v = await evaluateResumeGate(
    gateArgs({
      loadMaterial: async () => {
        throw new Error("image rehydration blew up");
      },
      logger: { warn: (...a: unknown[]) => warnings.push(a) },
    }),
  );
  assert.deepEqual(v, { resume: false }, "a thrown gate must degrade to FRESH, never propagate");
  assert.equal(warnings.length, 1, "the throw is logged once (resume_gate_threw)");
  assert.equal(warnings[0][0], "resume_gate_threw");
});

test("issue #2: a synchronously throwing loadMaterial also degrades to FRESH", async () => {
  // A callback that throws synchronously (not via a rejected promise) — still caught.
  const v = await evaluateResumeGate(
    gateArgs({
      loadMaterial: (() => {
        throw new Error("sync throw before any await");
      }) as () => Promise<ResumeMaterial | null>,
    }),
  );
  assert.deepEqual(v, { resume: false });
});

test("issue #2: a throwing getSession (DB read) degrades to FRESH, does NOT reject", async () => {
  const v = await evaluateResumeGate(
    gateArgs({
      getSession: () => {
        throw new Error("database is locked");
      },
    }),
  );
  assert.deepEqual(v, { resume: false });
});

test("issue #2: a throwing resolveCeiling is absorbed (capability gate inert) → still resumes", async () => {
  // The ORIGINAL inline gate already guarded resolveCeiling individually: a ceiling
  // resolution failure leaves the capability gate inert (no ceiling), it does NOT
  // fail the whole gate. With all other gates passing the verdict is still RESUME.
  const v = await evaluateResumeGate(
    gateArgs({
      resolveCeiling: () => {
        throw new Error("model descriptor missing");
      },
    }),
  );
  assert.equal(v.resume, true, "a ceiling-resolution throw must not block an otherwise-eligible resume");
});

test("issue #2: the resume gate never rejects, whatever the callbacks do", async () => {
  // Belt-and-suspenders: drive every throwing-callback combination through
  // assert.doesNotReject to lock in that the gate is a total function.
  await assert.doesNotReject(() =>
    evaluateResumeGate(
      gateArgs({
        getSession: () => {
          throw new Error("x");
        },
      }),
    ),
  );
  await assert.doesNotReject(() =>
    evaluateResumeGate(
      gateArgs({
        loadMaterial: async () => {
          throw new Error("y");
        },
      }),
    ),
  );
});

// =============================================================================
// Issue #14-remainder: the remaining fork-gate → FRESH cases at the
// `evaluateResumeGate` boundary. The happy path, missing/non-completed row, stale
// generation, work-gate, over-ceiling, and throw-safety are pinned above; these add
// the INTENT-heuristic gates (§7.6 same_user_only / window) and the §7.3 synthetic-
// type structural gate, plus the both-directions controls that prove each gate is
// the decisive factor (toggle off / within window → still RESUME).
// =============================================================================

test("issue #14: same_user_only + a different sender → FRESH (the scarce resume is reserved for the asker)", async () => {
  // Row's trigger_sender_id is "alice"; a different user ("bob") replies. §6/§7.6:
  // the single-consumption resume is reserved for the original trigger sender.
  const v = await evaluateResumeGate(
    gateArgs({
      inbound: {
        timelineKey: "matrix:miku:room:!room",
        event: { sender: { id: "bob" }, timestamp: NOW },
      },
    }),
  );
  assert.deepEqual(v, { resume: false });
});

test("issue #14: same_user_only=false lets a different sender RESUME (gate is the decisive factor)", async () => {
  // The control: with the toggle OFF, the SAME different-sender reply resumes — so
  // the FRESH above is attributable to same_user_only, not some other gate.
  const v = await evaluateResumeGate(
    gateArgs({
      resumeCfg: { same_user_only: false },
      inbound: {
        timelineKey: "matrix:miku:room:!room",
        event: { sender: { id: "bob" }, timestamp: NOW },
      },
    }),
  );
  assert.equal(v.resume, true, "with same_user_only off, a third party may consume the resume");
});

test("issue #14: a reply OUTSIDE the resume window → FRESH (stale)", async () => {
  // window.group = 1000ms; the row completed at NOW-1000 and the reply lands at
  // NOW + 5000, i.e. 6000ms after completion → outside the window → FRESH (§7.6).
  const v = await evaluateResumeGate(
    gateArgs({
      resumeCfg: { same_user_only: true, window: { group: 1_000 } },
      inbound: {
        timelineKey: "matrix:miku:room:!room",
        event: { sender: { id: "alice" }, timestamp: NOW + 5_000 },
      },
    }),
  );
  assert.deepEqual(v, { resume: false });
});

test("issue #14: a reply INSIDE the resume window still RESUMES (window gate is decisive)", async () => {
  // The control: same window, but the reply lands 500ms after completion (< 1000ms)
  // → within window → RESUME. Pins that the FRESH above is the window, not staleness
  // elsewhere.
  const v = await evaluateResumeGate(
    gateArgs({
      resumeCfg: { same_user_only: true, window: { group: 1_000 } },
      // completed_at defaults to NOW-1000; place the reply at NOW-500 (500ms after).
      getSession: () => completedRow({ completed_at: NOW - 500 }),
      inbound: {
        timelineKey: "matrix:miku:room:!room",
        event: { sender: { id: "alice" }, timestamp: NOW },
      },
    }),
  );
  assert.equal(v.resume, true, "a reply within the window resumes");
});

test("issue #14: the window gate is per-context — a group window does not gate a DM reply", async () => {
  // window is keyed by ctx; a stale-looking gap under `group` must not leak into a
  // `dm` evaluation that has no DM window configured. ctx=dm, only group set → the
  // window gate is inert, so an otherwise-eligible DM reply resumes.
  const v = await evaluateResumeGate(
    gateArgs({
      ctx: "dm",
      resumeCfg: { same_user_only: true, window: { group: 1_000 } },
      inbound: {
        timelineKey: "matrix:miku:room:!room",
        event: { sender: { id: "alice" }, timestamp: NOW + 1_000_000 }, // way past any group window
      },
    }),
  );
  assert.equal(v.resume, true, "a group window does not gate a DM-context resume");
});

test("issue #14: a synthetic worker session type → FRESH (§7.3, structural)", async () => {
  // Summarize/condense/diary sessions aren't repliable; the structural gate rejects
  // them even though every other gate would pass.
  for (const sessionType of ["summarize", "condense", "diary"]) {
    const v = await evaluateResumeGate(gateArgs({ getSession: () => completedRow({ session_type: sessionType }) }));
    assert.deepEqual(v, { resume: false }, `${sessionType} must be FRESH`);
  }
});

// NOTE (issue #14, app-orchestration path): the full `handleInbound` fork —
// concurrent replies to the same dead handle where ONE resumes and the OTHER
// coalesces into the resumed session (spec §10), and the launch/`tryReplyResume`
// wiring around `evaluateResumeGate` + the `acceptResumeGeneration` CAS — is NOT
// cleanly unit-reachable: that logic lives inside the `startMikuAgent` closure in
// app.ts (the resolver, claims registry, session manager, and provider are all
// captured locals), with no exported seam to drive an inbound message through it in
// isolation. The decomposable, behaviour-bearing pieces are each covered at their
// own boundary instead: the single-consumption CAS race (exactly one of two
// concurrent accepts wins) in test/resumable-sessions.test.ts; the pre-CAS gate
// (every FRESH branch, throw-safety) here; the co-target coalescing that lands the
// second reply as an interjection in the SessionClaims / coalescing tests. Driving
// the closure would require a near-whole-app harness (real provider + manager +
// storage + config), which the project's unit suite deliberately avoids — an honest
// gap noted rather than a contrived harness. The Group 1 provider-boundary tests
// already pin "a natively-triggered reply is handled exactly once".
