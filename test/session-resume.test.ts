import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  autoResumeSession,
  loadResumeMaterial,
  stripFailedTail,
  RESUME_IMAGE_PLACEHOLDER,
  type AutoResumeDeps,
  type ResumeAttemptResult,
  type ResumeMaterialDeps,
} from "../src/agent/recovery.js";
import { externalizeImages } from "../src/agent/session-capture.js";
import { tagLlmRequestError } from "../src/agent/request-retry.js";
import { SessionRunner, SessionRunnerError, isResumableRunError } from "../src/agent/runner.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { Storage, type AgentSessionRow } from "../src/storage/index.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";

/** Deps stub for image-free rows: no media store hits expected. */
const NO_MEDIA_DEPS: ResumeMaterialDeps = {
  media: { getMediaAssetById: () => undefined },
  workspaceRoot: "/nonexistent-workspace",
};

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

test("loadResumeMaterial projects the snapshot vocabulary and strips the failed tail", async () => {
  const material = await loadResumeMaterial(row(), NO_MEDIA_DEPS);
  assert.ok(material, "row with snapshot+transcript is resumable");
  // mapBuiltMessages contract: the system block is dropped from the runtime prefix.
  assert.equal(material!.snapshot.length, 1);
  assert.equal((material!.snapshot[0] as any).type, "chatEvent");
  // The synthetic error assistant turn is stripped; the transcript ends at the
  // un-answered final user turn, ready for agent.continue().
  assert.equal(material!.transcript.length, 1);
  assert.equal((material!.transcript[0] as any).type, "triggerGroup");
});

test("loadResumeMaterial rejects rows that cannot be redone", async () => {
  // Missing material.
  assert.equal(await loadResumeMaterial(row({ context_snapshot_json: null }), NO_MEDIA_DEPS), null);
  assert.equal(await loadResumeMaterial(row({ transcript_json: null }), NO_MEDIA_DEPS), null);
  // Corrupt JSON.
  assert.equal(await loadResumeMaterial(row({ transcript_json: "{nope" }), NO_MEDIA_DEPS), null);
  // A transcript whose last turn committed cleanly: nothing failed to redo.
  assert.equal(
    await loadResumeMaterial(
      row({
        transcript_json: JSON.stringify([
          { type: "triggerGroup", content: "x", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
        ]),
      }),
      NO_MEDIA_DEPS,
    ),
    null,
  );
  // Stripping everything leaves nothing to re-issue.
  assert.equal(
    await loadResumeMaterial(
      row({
        transcript_json: JSON.stringify([
          { role: "assistant", content: [], stopReason: "error", errorMessage: "x" },
        ]),
      }),
      NO_MEDIA_DEPS,
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Image-ref rehydration on resume (issue #13): externalize → persist → load
// must round-trip image bytes, and unresolvable refs must degrade to a text
// placeholder so the resumed request stays valid (never a malformed
// `{type:"image"}` block that 400s fatally and discards the session).
// ---------------------------------------------------------------------------

test("loadResumeMaterial rehydrates externalized image refs byte-identically (#13)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "miku-resume-img-"));
  try {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
    const dataBase64 = imageBytes.toString("base64");
    await mkdir(path.join(root, "media"), { recursive: true });
    await writeFile(path.join(root, "media", "img.png"), imageBytes);

    const deps: ResumeMaterialDeps = {
      media: {
        getMediaAssetById: (id) =>
          id === "ev-1:attach:0" ? { local_path: "media/img.png", mime_type: "image/png" } : undefined,
      },
      workspaceRoot: root,
    };

    // Snapshot: a historical chatEvent carrying a ContextMessage image block.
    const snapshot = [
      { type: "system", role: "system", content: "prompt", tier: "system", tokenEstimate: 1 },
      {
        type: "chatEvent",
        role: "user",
        content: "<message>look</message>",
        tier: "rich",
        tokenEstimate: 1,
        imageBlocks: [
          { eventId: "ev-1", attachmentId: "ev-1:attach:0", mediaType: "image/png", dataBase64 },
        ],
      },
    ];
    // Transcript: the trigger kickoff carries the same block shape; a toolResult
    // carries a pi-ai inline image (read_image-style — NO attachment id, so it
    // is unresolvable by design); tail is the synthetic failed turn.
    const transcript = [
      {
        type: "triggerGroup",
        content: "<system>now</system>",
        timestamp: 1,
        imageBlocks: [
          { eventId: "ev-1", attachmentId: "ev-1:attach:0", mediaType: "image/png", dataBase64 },
        ],
      },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read_image", args: {} }] },
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [
          { type: "text", text: "here" },
          { type: "image", data: dataBase64, mimeType: "image/png" },
        ],
      },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" },
    ];

    // Persist exactly the way session capture does: externalized.
    const persisted = row({
      context_snapshot_json: JSON.stringify(externalizeImages(snapshot)),
      transcript_json: JSON.stringify(externalizeImages(transcript)),
    });
    // Sanity: externalization really did strip the payloads.
    assert.ok(!persisted.context_snapshot_json!.includes(dataBase64));
    assert.ok(persisted.transcript_json!.includes("__imageRef"));

    const material = await loadResumeMaterial(persisted, deps);
    assert.ok(material, "image-bearing row is resumable");

    // Snapshot chatEvent block: bytes restored identically.
    const chatEvent = material!.snapshot.find((m) => (m as any).type === "chatEvent") as any;
    assert.equal(chatEvent.imageBlocks.length, 1);
    assert.equal(chatEvent.imageBlocks[0].dataBase64, dataBase64, "snapshot bytes round-trip");
    assert.equal(chatEvent.imageBlocks[0].mediaType, "image/png");
    assert.equal(chatEvent.imageBlocks[0].attachmentId, "ev-1:attach:0");

    // Transcript trigger block: bytes restored identically.
    const trigger = material!.transcript[0] as any;
    assert.equal(trigger.imageBlocks[0].dataBase64, dataBase64, "transcript bytes round-trip");

    // toolResult inline image (no attachment id): replaced by a text placeholder,
    // keeping the content array valid for re-issue.
    const toolResult = material!.transcript[2] as any;
    assert.equal(toolResult.content[0].text, "here");
    assert.deepEqual(toolResult.content[1], { type: "text", text: RESUME_IMAGE_PLACEHOLDER });

    // No ref marker survives anywhere in the material.
    assert.ok(!JSON.stringify(material).includes("__imageRef"));
    // The failed tail is still stripped (rehydration happens before projection).
    assert.equal(material!.transcript.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadResumeMaterial substitutes placeholders for unresolvable imageBlocks refs (#13)", async () => {
  const snapshot = [
    {
      type: "chatEvent",
      role: "user",
      content: "<message>pic</message>",
      tier: "rich",
      tokenEstimate: 1,
      imageBlocks: [
        { eventId: "ev-9", attachmentId: "ev-9:attach:0", mediaType: "image/png", dataBase64: "QUJD" },
      ],
    },
  ];
  const persisted = row({ context_snapshot_json: JSON.stringify(externalizeImages(snapshot)) });
  // Media store knows nothing about the attachment → unresolvable.
  const material = await loadResumeMaterial(persisted, NO_MEDIA_DEPS);
  assert.ok(material, "unresolvable images degrade, they do not block resume");
  const chatEvent = material!.snapshot[0] as any;
  assert.deepEqual(chatEvent.imageBlocks, [], "ref entry dropped (no valid block shape without bytes)");
  assert.ok(
    chatEvent.content.includes(RESUME_IMAGE_PLACEHOLDER),
    "omission is annotated in the message text",
  );
  assert.ok(!JSON.stringify(material).includes("__imageRef"));
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

test("SessionRunner rejects with phase 'mechanical' when the run dies on a retryable LLM-layer error", async () => {
  // The error carries the Layer-1 origin tag, exactly as withRequestRetry
  // surfaces it (Decision C / #14): only tagged errors are resume candidates.
  const tagged = tagLlmRequestError("529 overloaded");
  const messages: any[] = [];
  const agent: any = {
    state: {
      messages,
      errorMessage: undefined as string | undefined,
    },
    async prompt() {
      messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: tagged });
      agent.state.errorMessage = tagged;
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

test("SessionRunner: an UNTAGGED error (programming throw) settles as a plain failure, not mechanical (#14)", async () => {
  // pi-agent-core's handleRunFailure flattens ANY executor throw (e.g. a
  // transformContext/tool-plumbing bug) into state.errorMessage with no
  // status/keyword — the lean-retryable default would call it mechanical.
  // Without the Layer-1 tag it must settle in place (pre-B.2 behaviour): no
  // mechanical rejection, no resume attempts.
  const messages: any[] = [];
  const agent: any = {
    state: { messages, errorMessage: undefined as string | undefined },
    async prompt() {
      // Simulates handleRunFailure for `throw new TypeError(...)` inside
      // transformContext: synthetic error turn + flattened message, NO tag.
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "Cannot read properties of undefined (reading 'map')",
      });
      agent.state.errorMessage = "Cannot read properties of undefined (reading 'map')";
    },
    async continue() {},
    async waitForIdle() {},
  };
  const result = await new SessionRunner().run(agent, session, 0, kickoff);
  assert.equal(result.noReply, true, "settles via the ordinary loop (plain failure)");
});

test("SessionRunner does NOT reject mechanically on fatal or aborted runs", async () => {
  // Fatal (auth) error — tagged, since it surfaced through Layer-1 — settles
  // via the ordinary loop, no mechanical rejection.
  const fatalTagged = tagLlmRequestError("401 unauthorized");
  const fatalMessages: any[] = [];
  const fatalAgent: any = {
    state: { messages: fatalMessages, errorMessage: undefined as string | undefined },
    async prompt() {
      fatalMessages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: fatalTagged });
      fatalAgent.state.errorMessage = fatalTagged;
    },
    async continue() {},
    async waitForIdle() {},
  };
  const result = await new SessionRunner().run(fatalAgent, session, 0, kickoff);
  assert.equal(result.noReply, true);

  // Aborted run (tagged — e.g. an aborted scheduler admission surfaced through
  // Layer-1): also settles normally (interrupt/cap semantics unchanged).
  const abortedMessages: any[] = [];
  const abortedAgent: any = {
    state: { messages: abortedMessages, errorMessage: undefined as string | undefined },
    async prompt() {
      abortedMessages.push({ role: "assistant", content: [], stopReason: "aborted" });
      abortedAgent.state.errorMessage = tagLlmRequestError("aborted");
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

// ---------------------------------------------------------------------------
// Auto-resume policy loop (issue #15): park-over-discard for attempts=0,
// draining-at-entry, and fatal-at-shutdown.
// ---------------------------------------------------------------------------

const MECHANICAL = new SessionRunnerError("agent run failed mechanically: 529", "mechanical");

interface Recorded {
  resuming: string[];
  parked: string[];
  discarded: string[];
  attemptsRun: number[];
}

function autoResumeHarness(overrides: Partial<AutoResumeDeps> = {}): { deps: AutoResumeDeps; rec: Recorded } {
  const rec: Recorded = { resuming: [], parked: [], discarded: [], attemptsRun: [] };
  const deps: AutoResumeDeps = {
    sessionId: "s-auto1",
    timelineKey: "tl:room1",
    attempts: 2,
    backoffBaseMs: 0,
    isDraining: () => false,
    runAttempt: async (attempt): Promise<ResumeAttemptResult> => {
      rec.attemptsRun.push(attempt);
      return { outcome: "mechanical", error: "529 again" };
    },
    markResuming: (err) => rec.resuming.push(err),
    markFailedResumable: (err) => rec.parked.push(err),
    markDiscarded: (err) => rec.discarded.push(err),
    logger: { warn: () => {}, error: () => {} },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, rec };
}

test("autoResumeSession: non-resumable errors are handed back (false), nothing marked", async () => {
  const { deps, rec } = autoResumeHarness();
  assert.equal(await autoResumeSession(new Error("transform bug"), deps), false);
  assert.equal(await autoResumeSession(new SessionRunnerError("x", "prompt"), deps), false);
  assert.deepEqual(rec.parked, []);
  assert.deepEqual(rec.discarded, []);
  assert.deepEqual(rec.attemptsRun, []);
});

test("autoResumeSession: attempts=0 parks immediately, still manually resumable (#15)", async () => {
  // Config contract (schema.ts session_auto_resume_attempts): "0 disables
  // auto-resume (failures park immediately... still resumable manually)".
  const { deps, rec } = autoResumeHarness({ attempts: 0 });
  assert.equal(await autoResumeSession(MECHANICAL, deps), true, "handled here, not discarded by caller");
  assert.deepEqual(rec.parked, [MECHANICAL.message]);
  assert.deepEqual(rec.discarded, []);
  assert.deepEqual(rec.attemptsRun, [], "no doomed attempt is run");
  assert.deepEqual(rec.resuming, [], "parks directly, never enters resuming");
});

test("autoResumeSession: draining at entry parks instead of discarding (#15)", async () => {
  const { deps, rec } = autoResumeHarness({ isDraining: () => true });
  assert.equal(await autoResumeSession(MECHANICAL, deps), true);
  assert.deepEqual(rec.parked, [MECHANICAL.message]);
  assert.deepEqual(rec.discarded, []);
  assert.deepEqual(rec.attemptsRun, []);
});

test("autoResumeSession: fatal attempt outcome WHILE DRAINING parks — shutdown-caused fatality keeps resume material (#15)", async () => {
  // Group-3 interaction: scheduler.stop() makes in-flight admission reject
  // ("LLM scheduler stopped"), which Layer-1 deliberately classifies FATAL so
  // teardown never spins retries. That fatality is shutdown-caused, not
  // content-caused — the parked row must stay manually resumable.
  let draining = false;
  const { deps, rec } = autoResumeHarness({
    isDraining: () => draining,
    runAttempt: async (attempt) => {
      rec.attemptsRun.push(attempt);
      draining = true; // shutdown begins mid-attempt
      return { outcome: "fatal", error: "LLM scheduler stopped" };
    },
  });
  assert.equal(await autoResumeSession(MECHANICAL, deps), true);
  assert.deepEqual(rec.attemptsRun, [1]);
  assert.deepEqual(rec.parked, ["LLM scheduler stopped"]);
  assert.deepEqual(rec.discarded, [], "never discarded at shutdown");
});

test("autoResumeSession: fatal outcome on a live runtime still discards", async () => {
  const { deps, rec } = autoResumeHarness({
    runAttempt: async (attempt) => {
      rec.attemptsRun.push(attempt);
      return { outcome: "fatal", error: "400 malformed" };
    },
  });
  assert.equal(await autoResumeSession(MECHANICAL, deps), true);
  assert.deepEqual(rec.discarded, ["400 malformed"]);
  assert.deepEqual(rec.parked, []);
});

test("autoResumeSession: draining mid-backoff parks without running the attempt", async () => {
  let draining = false;
  const { deps, rec } = autoResumeHarness({
    sleep: async () => {
      draining = true; // shutdown lands during the backoff sleep
    },
    isDraining: () => draining,
  });
  assert.equal(await autoResumeSession(MECHANICAL, deps), true);
  assert.deepEqual(rec.attemptsRun, []);
  assert.deepEqual(rec.parked, [MECHANICAL.message]);
});

test("autoResumeSession: completion resumes; exhaustion parks", async () => {
  // Completed on the second attempt.
  const ok = autoResumeHarness({
    runAttempt: async (attempt) => {
      ok.rec.attemptsRun.push(attempt);
      return attempt === 2 ? { outcome: "completed" } : { outcome: "mechanical", error: "529" };
    },
  } as Partial<AutoResumeDeps>);
  assert.equal(await autoResumeSession(MECHANICAL, ok.deps), true);
  assert.deepEqual(ok.rec.attemptsRun, [1, 2]);
  assert.deepEqual(ok.rec.parked, []);
  assert.deepEqual(ok.rec.discarded, []);

  // Mechanical every time → exhaustion → park.
  const { deps, rec } = autoResumeHarness();
  assert.equal(await autoResumeSession(MECHANICAL, deps), true);
  assert.deepEqual(rec.attemptsRun, [1, 2]);
  assert.deepEqual(rec.parked, ["529 again"]);
  assert.deepEqual(rec.discarded, []);
});
