import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createManualResumeSession,
  loadResumeMaterial,
  stripFailedTail,
  RESUME_IMAGE_PLACEHOLDER,
  type ManualResumeDeps,
  type ResumeMaterialResult,
  type ResumeMaterialDeps,
} from "../src/agent/recovery.js";
import { externalizeImages } from "../src/agent/session-capture.js";
import { tagLlmRequestError } from "../src/agent/request-retry.js";
import { SessionRunner, SessionRunnerError, isResumableRunError } from "../src/agent/runner.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { Storage, type AgentSessionRow } from "../src/storage/index.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { InboundChatEvent } from "../src/types.js";

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
    trigger_sender_id: "@alice:example.org",
    trigger_sender_display_name: "Alice",
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
  assert.equal(material!.mode, "continue");
  const m = material as Extract<NonNullable<typeof material>, { mode: "continue" }>;
  // mapBuiltMessages contract: the system block is dropped from the runtime prefix.
  assert.equal(m.snapshot.length, 1);
  assert.equal((m.snapshot[0] as any).type, "chatEvent");
  // The synthetic error assistant turn is stripped; the transcript ends at the
  // un-answered final user turn, ready for agent.continue().
  assert.equal(m.transcript.length, 1);
  assert.equal((m.transcript[0] as any).type, "triggerGroup");
});

test("loadResumeMaterial rejects rows that cannot be redone", async () => {
  // A transcript without its snapshot violates the capture ordering — corrupt.
  assert.equal(await loadResumeMaterial(row({ context_snapshot_json: null }), NO_MEDIA_DEPS), null);
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
});

test("loadResumeMaterial: a never-flushed transcript resolves to FRESH, not a rejection", async () => {
  // Hard crash before the first turn_end/flushNow (e.g. process kill
  // mid-first-request): no transcript row at all. Nothing committed → fresh
  // rebuild from the durable trigger row, regardless of snapshot presence.
  assert.deepEqual(await loadResumeMaterial(row({ transcript_json: null }), NO_MEDIA_DEPS), {
    mode: "fresh",
  });
  assert.deepEqual(
    await loadResumeMaterial(
      row({ transcript_json: null, context_snapshot_json: null }),
      NO_MEDIA_DEPS,
    ),
    { mode: "fresh" },
  );
  // A flushed-but-empty transcript is the same "nothing committed" case.
  assert.deepEqual(await loadResumeMaterial(row({ transcript_json: "[]" }), NO_MEDIA_DEPS), {
    mode: "fresh",
  });
  // Only failed tails with no committed turn beneath — also fresh.
  assert.deepEqual(
    await loadResumeMaterial(
      row({
        transcript_json: JSON.stringify([
          { role: "assistant", content: [], stopReason: "error", errorMessage: "x" },
        ]),
      }),
      NO_MEDIA_DEPS,
    ),
    { mode: "fresh" },
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

test("SessionRunner rejects on EVERY tagged LLM failure — content class included (spec §8.1)", async () => {
  // A content failure (oversized request) used to settle as a silent NO_REPLY
  // after doomed forced-completion re-prompts (audit defect #1). It must now
  // throw phase "llm" with class "content" BEFORE the forced-completion loop —
  // a typed rejection launchSession parks, never discards.
  const contentTagged = tagLlmRequestError("413 prompt is too long", "content");
  const contentMessages: any[] = [];
  let prompts = 0;
  const contentAgent: any = {
    state: { messages: contentMessages, errorMessage: undefined as string | undefined },
    async prompt() {
      prompts += 1;
      contentMessages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: contentTagged });
      contentAgent.state.errorMessage = contentTagged;
    },
    async continue() {},
    async waitForIdle() {},
  };
  await assert.rejects(
    new SessionRunner().run(contentAgent, session, 3, kickoff),
    (err: unknown) =>
      err instanceof SessionRunnerError &&
      err.phase === "llm" &&
      err.llmClass === "content" &&
      !isResumableRunError(err),
  );
  assert.equal(prompts, 1, "no forced-completion re-prompt after an API failure (P1)");

  // 401, previously "fatal": endpoint-level → environmental → resumable.
  const authTagged = tagLlmRequestError("401 unauthorized", "environmental");
  const authMessages: any[] = [];
  const authAgent: any = {
    state: { messages: authMessages, errorMessage: undefined as string | undefined },
    async prompt() {
      authMessages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: authTagged });
      authAgent.state.errorMessage = authTagged;
    },
    async continue() {},
    async waitForIdle() {},
  };
  await assert.rejects(
    new SessionRunner().run(authAgent, session, 0, kickoff),
    (err: unknown) => isResumableRunError(err),
  );

  // Aborted run (tagged — e.g. an aborted scheduler admission surfaced through
  // Layer-1): settles normally (interrupt/cap semantics unchanged).
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

test("isResumableRunError only matches environmental llm-phase failures", () => {
  assert.equal(isResumableRunError(new SessionRunnerError("x", "llm", { llmClass: "environmental" })), true);
  assert.equal(isResumableRunError(new SessionRunnerError("x", "llm", { llmClass: "content" })), false);
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

test("SessionManager: markFailedResumable evicts; adopt re-registers", () => {
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

  sessions.markFailedResumable(record.id, { error: "529" });
  assert.equal(sessions.get(record.id), undefined, "parked sessions are evicted from memory");

  const adopted: AgentSessionRecord = { ...record, status: "resuming" };
  sessions.adopt(adopted);
  assert.equal(sessions.get(record.id)?.status, "resuming");
  sessions.markRunning(record.id);
  assert.equal(sessions.get(record.id)?.status, "running");
});

// ---------------------------------------------------------------------------
// Manual console resume (issues #16-#20): double-POST guard, status +
// viability gates, per-timeline slot, sender reconstruction from the durable
// row, and shutdown re-park.
// ---------------------------------------------------------------------------

const FAKE_MATERIAL: ResumeMaterialResult = { mode: "continue", snapshot: [], transcript: [] };
const SELF_USER_ID = "@miku:example.org";

interface ManualRecorded {
  adopted: AgentSessionRecord[];
  attempts: Array<{ record: AgentSessionRecord; inbound: InboundChatEvent }>;
  parked: Array<string | undefined>;
  discarded: Array<string | undefined>;
  slotAcquires: string[];
  slotReleases: string[];
}

function manualResumeHarness(overrides: Partial<ManualResumeDeps> = {}): {
  deps: ManualResumeDeps;
  rec: ManualRecorded;
} {
  const rec: ManualRecorded = {
    adopted: [],
    attempts: [],
    parked: [],
    discarded: [],
    slotAcquires: [],
    slotReleases: [],
  };
  const deps: ManualResumeDeps = {
    isDraining: () => false,
    getSessionRow: () => row(),
    loadMaterial: async () => FAKE_MATERIAL,
    hasLiveSession: () => false,
    adopt: (record) => rec.adopted.push(record),
    tryAcquireTimelineSlot: (key) => {
      rec.slotAcquires.push(key);
      return true;
    },
    releaseTimelineSlot: (key) => rec.slotReleases.push(key),
    selfUserIdForAccount: (accountId) => (accountId === "miku" ? SELF_USER_ID : undefined),
    runAttempt: async (record, inbound) => {
      rec.attempts.push({ record, inbound });
      return { outcome: "completed" };
    },
    markFailedResumable: (_id, error) => rec.parked.push(error),
    markDiscarded: (_id, error) => rec.discarded.push(error),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
  return { deps, rec };
}

test("manual resume happy path: completes, slot held for the run, sender is the PERSISTED user (#16-#18)", async () => {
  const { deps, rec } = manualResumeHarness();
  const resume = createManualResumeSession(deps);
  const result = await resume("s-resume0001");
  assert.deepEqual(result, { ok: true, status: "completed" });

  // Timeline slot (#17): acquired before the run, released after.
  assert.deepEqual(rec.slotAcquires, ["matrix:miku:room:!room"]);
  assert.deepEqual(rec.slotReleases, ["matrix:miku:room:!room"]);

  // The reconstructed record was adopted and drives the same attempt.
  assert.equal(rec.adopted.length, 1);
  assert.equal(rec.adopted[0].id, "s-resume0001");
  assert.equal(rec.adopted[0].status, "resuming");
  assert.equal(rec.attempts.length, 1);

  // Sender identity (#18): the persisted trigger sender, NOT the bot — and
  // isSelf is never claimed for a user-triggered session.
  const sender = rec.attempts[0].inbound.event.sender;
  assert.equal(sender.id, "@alice:example.org");
  assert.equal(sender.displayName, "Alice");
  assert.equal(sender.isSelf, undefined);
  // Outbound target reconstructed from the timeline key.
  assert.equal(rec.attempts[0].inbound.outboundTarget?.roomId, "!room");
  assert.equal(rec.attempts[0].inbound.outboundTarget?.accountId, "miku");
  assert.deepEqual(rec.parked, []);
  assert.deepEqual(rec.discarded, []);
});

test("manual resume: a bot-triggered (proactive) or legacy NULL sender reconstructs as self (#18)", async () => {
  // Proactive sessions persist the bot as the trigger sender; isSelf is then true.
  const proactive = manualResumeHarness({
    getSessionRow: () =>
      row({ trigger_sender_id: SELF_USER_ID, trigger_sender_display_name: null }),
  });
  await createManualResumeSession(proactive.deps)("s-resume0001");
  assert.equal(proactive.rec.attempts[0].inbound.event.sender.id, SELF_USER_ID);
  assert.equal(proactive.rec.attempts[0].inbound.event.sender.isSelf, true);

  // Defensive pre-v18 fallback (NULL columns): bot identity, honestly self.
  const legacy = manualResumeHarness({
    getSessionRow: () => row({ trigger_sender_id: null, trigger_sender_display_name: null }),
  });
  await createManualResumeSession(legacy.deps)("s-resume0001");
  assert.equal(legacy.rec.attempts[0].inbound.event.sender.id, SELF_USER_ID);
  assert.equal(legacy.rec.attempts[0].inbound.event.sender.isSelf, true);
});

test("manual resume: wrong state is rejected without side effects (409)", async () => {
  for (const status of ["completed", "running", "discarded", "created"] as const) {
    const { deps, rec } = manualResumeHarness({ getSessionRow: () => row({ status }) });
    const result = await createManualResumeSession(deps)("s-resume0001");
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.match(result.reason!, /not resumable/);
    assert.deepEqual(rec.adopted, []);
    assert.deepEqual(rec.slotAcquires, []);
    assert.deepEqual(rec.attempts, []);
  }
  // Unknown session.
  const { deps } = manualResumeHarness({ getSessionRow: () => undefined });
  const unknown = await createManualResumeSession(deps)("s-nope");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, "unknown");
});

test("manual resume: double POST is rejected synchronously while the first is in flight (#16)", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { deps, rec } = manualResumeHarness({
    runAttempt: async (record, inbound) => {
      rec.attempts.push({ record, inbound });
      await gate; // hold the first resume mid-run
      return { outcome: "completed" };
    },
  });
  const resume = createManualResumeSession(deps);
  const first = resume("s-resume0001");
  const second = await resume("s-resume0001"); // before the first settles
  assert.equal(second.ok, false);
  assert.equal(second.status, "resuming");
  assert.match(second.reason!, /already in flight/);
  release!();
  assert.deepEqual(await first, { ok: true, status: "completed" });
  assert.equal(rec.attempts.length, 1, "only one run was driven");
  assert.equal(rec.adopted.length, 1, "only one adopt");

  // After the first settles the guard clears: a new resume is admitted again.
  const third = await resume("s-resume0001");
  assert.equal(third.ok, true);
});

test("manual resume: an in-memory live record for the id also rejects (#16)", async () => {
  const { deps, rec } = manualResumeHarness({ hasLiveSession: () => true });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /already in flight/);
  assert.deepEqual(rec.attempts, []);
});

test("manual resume: timeline busy is a clean 409 — no run, no marks, no release (#17)", async () => {
  const { deps, rec } = manualResumeHarness({ tryAcquireTimelineSlot: () => false });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed-resumable");
  assert.match(result.reason!, /timeline busy/);
  assert.deepEqual(rec.attempts, []);
  assert.deepEqual(rec.adopted, []);
  assert.deepEqual(rec.slotReleases, [], "never-acquired slot must not be released");
  assert.deepEqual(rec.parked, []);
});

test("manual resume: slot is released even when the attempt fails (#17)", async () => {
  const { deps, rec } = manualResumeHarness({
    runAttempt: async () => ({ outcome: "mechanical", error: "529 again" }),
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed-resumable");
  assert.deepEqual(rec.parked, ["529 again"]);
  assert.deepEqual(rec.slotReleases, ["matrix:miku:room:!room"]);
});

test("manual resume: interrupted session WITH viable material resumes transparently (#19)", async () => {
  const { deps, rec } = manualResumeHarness({
    getSessionRow: () => row({ status: "interrupted" }),
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.deepEqual(result, { ok: true, status: "completed" });
  assert.equal(rec.attempts.length, 1, "same re-issue mechanism, no extra turn");
});

test("manual resume: interrupted session with a NEVER-FLUSHED transcript resumes in fresh mode", async () => {
  // Hard crash before the first transcript flush: loadMaterial says `fresh`,
  // and the resume proceeds (rebuild-and-relaunch) instead of rejecting.
  const { deps, rec } = manualResumeHarness({
    getSessionRow: () => row({ status: "interrupted" }),
    loadMaterial: async () => ({ mode: "fresh" }),
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.deepEqual(result, { ok: true, status: "completed" });
  assert.equal(rec.attempts.length, 1, "the attempt runs; resumeSessionRun owns the rebuild");
});

test("manual resume: interrupted session WITHOUT material is a 409 and its status is untouched (#19)", async () => {
  const { deps, rec } = manualResumeHarness({
    getSessionRow: () => row({ status: "interrupted" }),
    loadMaterial: async () => null,
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.equal(result.status, "interrupted", "row status reported as-is");
  assert.match(result.reason!, /nothing to redo/);
  assert.deepEqual(rec.adopted, [], "row never adopted");
  assert.deepEqual(rec.parked, [], "NOT converted to failed-resumable");
  assert.deepEqual(rec.discarded, []);
  assert.deepEqual(rec.slotAcquires, []);
});

test("manual resume: a crash-interrupted SYNTHETIC worker session is a 409 — never re-driven as chat (#19 follow-up)", async () => {
  for (const sessionType of ["summarize", "condense", "diary"] as const) {
    let materialLoads = 0;
    const { deps, rec } = manualResumeHarness({
      getSessionRow: () => row({ status: "interrupted", session_type: sessionType }),
      loadMaterial: async () => {
        materialLoads++;
        return FAKE_MATERIAL;
      },
    });
    const result = await createManualResumeSession(deps)("s-resume0001");
    assert.equal(result.ok, false);
    assert.equal(result.status, "interrupted", "row status reported as-is, untouched");
    assert.match(result.reason!, /synthetic .* not resumable/);
    assert.equal(materialLoads, 0, "rejected before the viability gate");
    assert.deepEqual(rec.adopted, [], "row never adopted");
    assert.deepEqual(rec.attempts, [], "no chat run driven");
    assert.deepEqual(rec.slotAcquires, []);
    assert.deepEqual(rec.parked, [], "NOT converted to failed-resumable");
    assert.deepEqual(rec.discarded, []);
  }
});

test("manual resume: interrupted user-facing sessions (default + proactive) with material stay resumable (#19 follow-up)", async () => {
  for (const sessionType of ["default", "proactive"] as const) {
    const { deps, rec } = manualResumeHarness({
      getSessionRow: () => row({ status: "interrupted", session_type: sessionType }),
    });
    const result = await createManualResumeSession(deps)("s-resume0001");
    assert.deepEqual(result, { ok: true, status: "completed" });
    assert.equal(rec.attempts.length, 1);
    assert.equal(rec.adopted[0].sessionType, sessionType);
  }
});

test("manual resume: draining at entry rejects before any work (#20)", async () => {
  const { deps, rec } = manualResumeHarness({ isDraining: () => true });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /shutting down/);
  assert.deepEqual(rec.attempts, []);
  assert.deepEqual(rec.slotAcquires, []);
});

test("manual resume: a fatal outcome WHILE DRAINING re-parks instead of discarding (#20)", async () => {
  // Shutdown begins mid-attempt: the scheduler gate rejects the request, which
  // Layer-1 classifies fatal — but the material is intact, so park.
  let draining = false;
  const { deps, rec } = manualResumeHarness({
    isDraining: () => draining,
    runAttempt: async (record, inbound) => {
      rec.attempts.push({ record, inbound });
      draining = true;
      return { outcome: "fatal", error: "LLM scheduler stopped" };
    },
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed-resumable");
  assert.deepEqual(rec.parked, ["LLM scheduler stopped"]);
  assert.deepEqual(rec.discarded, [], "never discarded at shutdown");
});

test("manual resume: fatal on a live runtime discards; unresumable re-parks", async () => {
  const fatal = manualResumeHarness({
    runAttempt: async () => ({ outcome: "fatal", error: "400 malformed" }),
  });
  const fatalResult = await createManualResumeSession(fatal.deps)("s-resume0001");
  assert.equal(fatalResult.status, "discarded");
  assert.deepEqual(fatal.rec.discarded, ["400 malformed"]);
  assert.deepEqual(fatal.rec.parked, []);

  const unresumable = manualResumeHarness({
    runAttempt: async () => ({ outcome: "unresumable", error: "session row missing" }),
  });
  const unresumableResult = await createManualResumeSession(unresumable.deps)("s-resume0001");
  assert.equal(unresumableResult.status, "failed-resumable");
  assert.deepEqual(unresumable.rec.parked, ["session row missing"]);
});

test("manual resume: runAttempt THROWING (pre-run wiring) evicts the adopted record so a retry is admitted (#11)", async () => {
  // resumeSessionRun's markRunning/attachAgent/attachSessionCapture run OUTSIDE
  // its own try/catch — a throw there escapes `runAttempt`. If the adopted
  // record is not evicted, `hasLiveSession` rejects EVERY future resume of this
  // session forever. Model live-ness off the SessionManager: adopt registers,
  // markDiscarded/markFailedResumable evict.
  let live = false;
  const { deps, rec } = manualResumeHarness({
    hasLiveSession: () => live,
    adopt: (record) => {
      rec.adopted.push(record);
      live = true;
    },
    markDiscarded: (_id, error) => {
      rec.discarded.push(error);
      live = false;
    },
    markFailedResumable: (_id, error) => {
      rec.parked.push(error);
      live = false;
    },
    runAttempt: async (record, inbound) => {
      rec.attempts.push({ record, inbound });
      throw new Error("attachAgent blew up");
    },
  });
  const resume = createManualResumeSession(deps);
  const first = await resume("s-resume0001");
  // Routed to the fatal/discard eviction path (live runtime).
  assert.equal(first.ok, false);
  assert.equal(first.status, "discarded");
  assert.match(first.reason!, /resume threw before completing/);
  assert.deepEqual(rec.discarded, ["attachAgent blew up"]);
  assert.deepEqual(rec.parked, []);
  // Slot + in-flight guard released regardless (finally blocks).
  assert.deepEqual(rec.slotReleases, ["matrix:miku:room:!room"]);

  // The record was evicted: a subsequent resume is NOT rejected as in-flight.
  const second = await resume("s-resume0001");
  assert.equal(second.status, "discarded", "admitted again — not wedged");
  assert.equal(rec.attempts.length, 2, "second attempt actually ran");
});

test("manual resume: runAttempt throwing WHILE DRAINING re-parks (not discards) and still evicts (#11/#20)", async () => {
  let live = false;
  let draining = false;
  const { deps, rec } = manualResumeHarness({
    isDraining: () => draining,
    hasLiveSession: () => live,
    adopt: (record) => {
      rec.adopted.push(record);
      live = true;
    },
    markFailedResumable: (_id, error) => {
      rec.parked.push(error);
      live = false;
    },
    runAttempt: async (record, inbound) => {
      rec.attempts.push({ record, inbound });
      draining = true; // shutdown began mid-wiring
      throw new Error("markRunning during shutdown");
    },
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed-resumable");
  assert.match(result.reason!, /resume threw during shutdown/);
  assert.deepEqual(rec.parked, ["markRunning during shutdown"]);
  assert.deepEqual(rec.discarded, [], "parked, never discarded while draining");
  assert.equal(live, false, "record evicted");
});

test("manual resume: DM timeline key reconstructs the outbound target", async () => {
  // DM sessions use `matrix:<account>:dm:<roomId>` keys (timelineKeyForMatrixEvent),
  // and the room id itself contains a colon. Regression: these 409'd as
  // "cannot reconstruct outbound target" because the parser only matched :room:.
  const dmKey = "matrix:miku:dm:!klfGPmhzdKaOinFDgO:example.org";
  const { deps, rec } = manualResumeHarness({
    getSessionRow: () => row({ timeline_key: dmKey }),
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.deepEqual(result, { ok: true, status: "completed" });
  assert.deepEqual(rec.slotAcquires, [dmKey]);
  assert.equal(rec.attempts[0].inbound.outboundTarget?.accountId, "miku");
  assert.equal(rec.attempts[0].inbound.outboundTarget?.roomId, "!klfGPmhzdKaOinFDgO:example.org");
  assert.equal(rec.attempts[0].inbound.outboundTarget?.threadId, undefined);
});

test("manual resume: unparseable timeline key / unknown account rejects before the slot", async () => {
  const { deps, rec } = manualResumeHarness({
    getSessionRow: () => row({ timeline_key: "discord:guild:123" }),
  });
  const result = await createManualResumeSession(deps)("s-resume0001");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /cannot reconstruct outbound target/);
  assert.deepEqual(rec.slotAcquires, []);

  const unknownAccount = manualResumeHarness({
    getSessionRow: () => row({ timeline_key: "matrix:other:room:!room" }),
  });
  const accountResult = await createManualResumeSession(unknownAccount.deps)("s-resume0001");
  assert.equal(accountResult.ok, false);
  assert.match(accountResult.reason!, /cannot reconstruct outbound target/);
});
