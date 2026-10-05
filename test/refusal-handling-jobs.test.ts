import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SessionRecordService, type StartRecordTurnParams } from "../src/agent/session-records.js";
import { CaptionWorker } from "../src/captioning/worker.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import { createBackgroundChecks, type GateVerdict } from "../src/checks/gate.js";
import type { RefusalRule } from "../src/checks/types.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiaryWorkerPool, buildDiaryHeader } from "../src/diary/index.js";
import { configureAgentTimezone } from "../src/time/index.js";
import type { Logger } from "../src/observability/index.js";
import { isRefusalExhausted } from "../src/refusals/fetch.js";
import { JobSoftRefusalRedo, decideSessionArtifactRefusal } from "../src/refusals/jobs.js";
import { normalizeRefusalRules } from "../src/refusals/rules.js";
import { MemoryFileWriter, Storage } from "../src/storage/index.js";
import { SummarizationWorkerPool } from "../src/summarization/index.js";
import { SummaryDraft } from "../src/tools/summary-tool.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Soft refusals of mechanical jobs (spec REFUSAL-HANDLING §5.2.3–4, §8.4): a
// judged refusal of an artifact (summary, diary entry, caption, session record)
// or of a failed rollout discards the output and reruns the job on a soft
// rule's model; exhausted = no output. Checks are real (pattern checks through
// the evaluator and background checks); models are fakes.
// ---------------------------------------------------------------------------

const TK = "matrix:test:room:!room:server";
const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };
const REFUSAL = "(?i)\\bcan't help\\b";

function config(rules: Array<Record<string, unknown>>): any {
  return {
    models: {},
    checks: { refusal_canned: { kind: "refusal", reason: "capability", patterns: [REFUSAL] } },
    refusal_fallback: rules,
    agents: {},
  };
}

async function checksFor(storage: Storage, rules: Array<Record<string, unknown>>) {
  const cfg = config(rules);
  const evaluator = new CheckEvaluator({ catalogue: buildCheckCatalogue(cfg), config: cfg, storage, logger: silentLogger });
  return { checks: createBackgroundChecks(evaluator, { logger: silentLogger }), rules: normalizeRefusalRules(cfg) };
}

function event(id: string, timestamp: number, role: "user" | "assistant" = "user"): CanonicalChatEvent {
  const sender = role === "assistant" ? { id: "@bot:test", isSelf: true } : { id: "@u:test" };
  return { id, timelineKey: TK, provider: "matrix", role, sender, body: `message ${id}`, timestamp, receivedAt: timestamp };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A fake factory whose runs are scripted per pinned model: `head` serves an
 * unpinned run; a soft-refusal rerun is pinned (`opts.refusalPin`).
 */
function scriptedFactory(script: Record<string, { write?: string; text: string }>, head = "model_a") {
  const created: Array<{ model: string; sessionId: string }> = [];
  return {
    created,
    factory: {
      resolveModelId: () => "wire",
      resolveSessionCostCeiling: () => 0.5,
      resolveSessionType: () => undefined,
      refusalEntryViable: (model: string) => model !== "model_down",
      resolveModelChainLogicalIdsForModel: (model: string) => [model],
      create: async (session: any, tools: AgentTool[], opts: any) => {
        const model = opts?.refusalPin?.model ?? head;
        created.push({ model, sessionId: session.id });
        const step = script[model]!;
        if (step.write) await tools[0]!.execute("t", { command: "create", file_text: step.write });
        return {
          agent: {
            prompt: async () => {},
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state: { messages: [{ role: "assistant", content: [{ type: "text", text: step.text }], model: `${model}-wire` }] },
          },
          renderedInputIds: ["ev0", "ev1"],
          refusal: { servingModel: () => model, lastHardOutcome: () => undefined },
        };
      },
    } as any,
  };
}

async function seedSummaryJob(storage: Storage, id: string): Promise<void> {
  await storage.appendTimelineEvent(event("ev0", 1000));
  await storage.appendTimelineEvent(event("ev1", 2000));
  await storage.insertSummarizationJob({
    id, timelineKey: TK, level: 1, inputStartId: "ev0", inputEndId: "ev1", inputTokenCount: 50, targetTokenCount: 100, maxRetries: 2,
  });
}

async function runSummaryJob(
  storage: Storage,
  rules: Array<Record<string, unknown>>,
  script: Record<string, { write?: string; text: string }>,
) {
  const { checks, rules: normalized } = await checksFor(storage, rules);
  const { factory, created } = scriptedFactory(script);
  await seedSummaryJob(storage, "job");
  const errors: string[] = [];
  const pool = new SummarizationWorkerPool({
    storage, factory, config: { worker_count: 1, max_retries: 2 },
    onComplete: () => {}, onError: (_id, e) => errors.push(e.message),
    outputChecks: checks, refusals: { rules: normalized }, logger: silentLogger,
  });
  await pool.start();
  pool.notifyNewWork();
  await waitFor(() => {
    const job = storage.getSummarizationJobById("job");
    return !!job && job.attempts >= 1 && job.status !== "processing";
  });
  await pool.stop();
  await storage.waitForIdle();
  return { created, errors, refusals: storage.listRefusalEvents.bind(storage) };
}

const RULE = { name: "jobs", sites: ["summarize", "diary", "caption", "record_turn"], models: ["model_b"] };

test("summarization: a failed run judged a refusal (rollout) reruns on the rule's model, not the same model", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { created } = await runSummaryJob(storage, [RULE], {
      model_a: { text: "Sorry, I can't help summarizing this." },
      model_b: { write: "A fine summary.", text: "done" },
    });
    assert.deepEqual(created.map((c) => c.model), ["model_a", "model_b"]);
    assert.equal(storage.getSummarizationJobById("job")?.status, "complete");
    const first = storage.getAgentSession(created[0]!.sessionId)!;
    assert.equal(first.status, "discarded");
    assert.match(first.error ?? "", /judged a refusal \(refusal_canned\)/);
    const events = storage.listRefusalEvents(created[0]!.sessionId);
    assert.deepEqual(events.map((e) => [e.site, e.checkpoint, e.outcome, e.rule_name, e.to_model]), [
      ["summarize", "rollout", "redo", "jobs", "model_b"],
    ]);
  } finally {
    storage.close();
  }
});

test("summarization: no refusal in a failed run keeps today's semantic redo (same model, retried later)", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { created } = await runSummaryJob(storage, [RULE], { model_a: { text: "Hmm, let me think." } });
    assert.deepEqual(created.map((c) => c.model), ["model_a"]);
    assert.equal(storage.getSummarizationJobById("job")?.status, "pending", "retried by the queue, as before");
  } finally {
    storage.close();
  }
});

test("summarization: a refused summary (artifact) is discarded and rewritten on the rule's model", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { created } = await runSummaryJob(storage, [RULE], {
      model_a: { write: "I can't help with summarizing this chat.", text: "done" },
      model_b: { write: "Alice and Bob planned the meetup.", text: "done" },
    });
    assert.deepEqual(created.map((c) => c.model), ["model_a", "model_b"]);
    const job = storage.getSummarizationJobById("job")!;
    assert.equal(job.status, "complete");
    assert.deepEqual(storage.getSummariesByLevel(TK, 1).map((x) => x.content), ["Alice and Bob planned the meetup."]);
    const events = storage.listRefusalEvents(created[0]!.sessionId);
    assert.deepEqual(events.map((e) => [e.checkpoint, e.outcome]), [["artifact", "redo"]]);
  } finally {
    storage.close();
  }
});

test("summarization: every entry refuses → no output, the job fails without a re-run", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { created, errors } = await runSummaryJob(storage, [RULE], {
      model_a: { write: "I can't help.", text: "done" },
      model_b: { write: "I also can't help.", text: "done" },
    });
    assert.deepEqual(created.map((c) => c.model), ["model_a", "model_b"]);
    assert.equal(storage.getSummarizationJobById("job")?.status, "failed");
    assert.deepEqual(errors, ["refusal rule exhausted"]);
    assert.deepEqual(storage.getSummariesByLevel(TK, 1), [], "never a refusal written into a summary");
    assert.deepEqual(storage.listRefusalEvents(created[1]!.sessionId).map((e) => e.outcome), ["exhausted_no_output"]);
  } finally {
    storage.close();
  }
});

test("summarization: a soft rule for another site leaves the job observe-only", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { created } = await runSummaryJob(storage, [{ ...RULE, sites: ["diary"] }], {
      model_a: { write: "I can't help.", text: "done" },
    });
    assert.deepEqual(created.map((c) => c.model), ["model_a"]);
    assert.equal(storage.getSummarizationJobById("job")?.status, "complete", "kept: nothing can act");
    await new Promise((r) => setTimeout(r, 30));
    await storage.waitForIdle();
    assert.deepEqual(storage.listRefusalEvents(created[0]!.sessionId).map((e) => e.outcome), ["observed"]);
  } finally {
    storage.close();
  }
});

test("JobSoftRefusalRedo: tries per entry, unusable entries skipped, continuation from the walk's model", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { checks, rules } = await checksFor(storage, [
      { name: "r", models: ["model_down", { model: "@same", tries: 2 }, "model_b"] },
    ]);
    const redo = new JobSoftRefusalRedo({ checks, rules, site: "summarize", agent: null, usable: (m) => m !== "model_down" });
    assert.equal(redo.active, true);
    const refused = { site: "summarize", kind: "summary", text: "I can't help.", timelineKey: TK };
    const d1 = await redo.artifact({ ...refused, servedModel: "model_a" });
    assert.deepEqual(d1.action === "rerun" && d1.pin.model, "model_a", "model_down skipped; @same = the refusing model");
    const d2 = await redo.artifact({ ...refused, servedModel: "model_a" });
    assert.deepEqual(d2.action === "rerun" && d2.pin.model, "model_a", "second try of the same entry");
    const d3 = await redo.artifact({ ...refused, servedModel: "model_a" });
    assert.deepEqual(d3.action === "rerun" && d3.pin.model, "model_b");
    const d4 = await redo.artifact({ ...refused, servedModel: "model_b" });
    assert.equal(d4.action, "exhausted");
    const ok = await redo.artifact({ ...refused, text: "A good summary.", servedModel: "model_b" });
    assert.equal(ok.action, "accept");
  } finally {
    storage.close();
  }
});

test("diary: a declining run (no entry written) judged a refusal reruns on the rule's model", async () => {
  configureAgentTimezone("UTC");
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-diary-soft-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const { checks, rules } = await checksFor(storage, [RULE]);
    const evs = [event("u0", 1000), event("a0", 2000, "assistant")];
    for (const e of evs) await storage.appendTimelineEvent(e);
    await storage.insertSummarizationJob({
      id: "job-sum1", timelineKey: TK, level: 1, inputStartId: "u0", inputEndId: "a0", inputTokenCount: 10, targetTokenCount: 100, maxRetries: 0,
    });
    await storage.insertSummaryWithLineage({
      id: "sum1", timelineKey: TK, level: 1, content: "summary", earliestTimestamp: 1000, latestTimestamp: 2000,
      latestEventId: "a0", eventCount: 2, tokenCount: 10, modelId: "m", status: "complete", generatedAt: 2000,
      eventIds: ["u0", "a0"], jobId: "job-sum1",
    });
    const header = buildDiaryHeader({ earliestTimestamp: 1000, latestTimestamp: 2000, room: "Room" });
    const models: string[] = [];
    const factory: any = {
      resolveModelId: () => "wire",
      resolveSessionCostCeiling: () => 0.5,
      resolveSessionType: () => ({ session_instruction: "Begin with EXACTLY this header:\n{{header}}" }),
      refusalEntryViable: () => true,
      resolveModelChainLogicalIdsForModel: (m: string) => [m],
      create: async (_session: unknown, tools: AgentTool[], opts: any) => {
        const model = opts?.refusalPin?.model ?? "model_a";
        models.push(model);
        const state: any = { messages: [] };
        return {
          agent: {
            prompt: async () => {
              if (model === "model_a") {
                state.messages.push({ role: "assistant", content: [{ type: "text", text: "I can't help keep a diary of this." }] });
              } else {
                await tools[0]!.execute("t", { command: "create", file_text: `${header}\nWe planned the meetup.`, finalize: true });
                state.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
              }
            },
            waitForIdle: async () => {},
            subscribe: () => () => {},
            state,
            abort: () => {},
          },
          finalTurn: { type: "satellite", content: "<system>diary</system>" },
          refusal: { servingModel: () => model, lastHardOutcome: () => undefined },
        };
      },
    };
    const pool = new DiaryWorkerPool({
      storage, factory, memoryWriter: new MemoryFileWriter(dir),
      config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
      workspaceRoot: dir, resolveChannelLabel: async () => "Room", logger: silentLogger,
      outputChecks: checks, refusals: { rules },
    });
    await pool.start();
    pool.notifyNewWork();
    const status = () =>
      (storage.read((db) => db.prepare(`select diary_status from summaries where id = 'sum1'`).get()) as { diary_status: string | null }).diary_status;
    await waitFor(() => status() === "done" || status() === "failed");
    await pool.stop();
    assert.deepEqual(models, ["model_a", "model_b"]);
    assert.equal(status(), "done");
    const files = await readdir(path.join(dir, "memory"));
    const content = await readFile(path.join(dir, "memory", files[0]!), "utf8");
    assert.match(content, /We planned the meetup\./);
    assert.ok(!content.includes("can't help"));
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("caption: a refused caption is discarded and re-captioned on the rule's model; exhausted = no caption", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const { checks, rules } = await checksFor(storage, [RULE]);
    const persisted: string[] = [];
    const billed: string[] = [];
    const calls: Array<string | undefined> = [];
    const replies: Record<string, string> = { default: "I can't help describe this image.", model_b: "A cat on a sofa." };
    const client = {
      caption: async (req: { model?: string }) => {
        calls.push(req.model);
        const key = req.model ?? "default";
        return { caption: replies[key]!, model: `${key}-wire`, logicalModelId: key === "default" ? "model_a" : key, provider: null, usage: null, cost: null };
      },
    } as any;
    const worker = (r: RefusalRule[]) =>
      new CaptionWorker({
        storage: { updateCaptionResult: async (_id: string, caption: string) => void persisted.push(caption) } as any,
        clients: new Map([["audio", client]]),
        workspaceRoot: "/tmp",
        recordUsage: (result) => billed.push(result.caption),
        softRefusal: () => {
          const redo = new JobSoftRefusalRedo({ checks, rules: r, site: "caption", agent: null, usable: () => true });
          return redo.active ? redo : undefined;
        },
      });
    const asset: any = { id: "a1", event_id: "ev1", media_type: "audio", local_path: "x.mp3", mime_type: "audio/mpeg", timeline_key: TK };
    await worker(rules).process(asset);
    assert.deepEqual(calls, [undefined, "model_b"]);
    assert.deepEqual(persisted, ["A cat on a sofa."], "the refused caption is never written");
    assert.deepEqual(billed, ["I can't help describe this image.", "A cat on a sofa."], "both calls are billed");

    replies.model_b = "I can't help with that either.";
    persisted.length = 0;
    await assert.rejects(() => worker(rules).process(asset), (error: unknown) => isRefusalExhausted(error));
    assert.deepEqual(persisted, []);
  } finally {
    storage.close();
  }
});

test("session record: a record judged a refusal is discarded and the turn rerun on the pinned model; exhausted = no record", async () => {
  for (const verdicts of [["rerun", "accept"], ["rerun", "exhausted"]] as const) {
    const draft = new SummaryDraft();
    const listeners = new Set<(e: any) => void>();
    const texts = ["I can't help writing this record.", "Looked up the hall's hours and posted them."];
    const agent: any = {
      state: {
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "web_fetch", arguments: {} }], timestamp: 2 },
          { role: "toolResult", toolCallId: "t1", toolName: "web_fetch", content: [], isError: false, timestamp: 3 },
        ],
        tools: [{ name: "session_record_tool" }],
        model: { api: "openai-completions", provider: "test", id: "m" },
      },
      hasQueuedMessages: () => false,
      clearAllQueues() {},
      abort() {},
      subscribe(fn: (e: any) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt(kickoff: any[]) {
        this.state.messages.push(...kickoff, { role: "assistant", content: [{ type: "toolCall", id: "r", name: "session_record_tool" }], timestamp: 4 });
        draft.create(texts.shift()!);
        for (const fn of listeners) fn({ type: "tool_execution_end", toolName: "session_record_tool", isError: false, result: { terminate: true } });
        for (const fn of listeners) fn({ type: "turn_end" });
      },
      async waitForIdle() {},
    };
    const upserts: string[] = [];
    const discarded: number[] = [];
    const judged: string[] = [];
    const queue = [...verdicts];
    const params: StartRecordTurnParams = {
      sessionId: "s-rec",
      timelineKey: TK,
      sessionType: "default",
      proactiveSessionType: "proactive",
      agentName: null,
      agent,
      handles: { gate: { active: false }, draft } as any,
      config: { enabled: true },
      exemptToolNames: new Set(),
      storage: { upsertSessionRecord: async (row: any) => void upserts.push(row.text) } as any,
      judgeRecord: async (text) => {
        judged.push(text);
        return queue.shift();
      },
      discardTurn: async (startIndex) => {
        discarded.push(startIndex);
        agent.state.messages.length = startIndex;
      },
      logger: silentLogger,
    };
    await new SessionRecordService().start(params);
    assert.deepEqual(judged, ["I can't help writing this record.", "Looked up the hall's hours and posted them."]);
    assert.deepEqual(discarded, [3], "the first turn was discarded back to its start");
    assert.deepEqual(upserts, verdicts[1] === "accept" ? ["Looked up the hall's hours and posted them."] : []);
  }
});

test("decideSessionArtifactRefusal: the session handle's rule and walk decide; no fired refusal = accept", () => {
  const advanced: string[] = [];
  const handle: any = {
    site: "record_turn",
    servingModel: () => "model_a",
    matchRule: () => ({ name: "r" }),
    advance: (rule: any) => (advanced.push(rule.name), advanced.length === 1 ? "model_b" : undefined),
  };
  const fired = { code: "refusal_canned", kind: "refusal", remedy: "redo", reason: "capability", method: "judged", probability: 0.9 } as const;
  const verdict = (f: any[]): GateVerdict => ({ evaluationIds: [], fired: f, revise: [], unjudged: false, latencyMs: 1 });
  assert.equal(decideSessionArtifactRefusal(handle, verdict([]), false).decision, "accept");
  const redo = decideSessionArtifactRefusal(handle, verdict([fired]), false);
  assert.equal(redo.decision, "rerun");
  assert.deepEqual(redo.act?.refusal, { code: "refusal_canned", outcome: "redo", ruleName: "r", toModel: "model_b" });
  assert.equal(decideSessionArtifactRefusal(handle, verdict([fired]), true).decision, "accept", "a late judged verdict never acts");
  const exhausted = decideSessionArtifactRefusal(handle, verdict([fired]), false);
  assert.equal(exhausted.decision, "exhausted");
  assert.equal(exhausted.act?.refusal?.outcome, "exhausted_no_output");
});
