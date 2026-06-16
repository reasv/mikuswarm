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
