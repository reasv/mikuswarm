import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Storage } from "../src/storage/index.js";
import { SummarizationWorkerPool } from "../src/summarization/index.js";
import { CaptionWorker } from "../src/captioning/worker.js";
import type { BackgroundArtifact, BackgroundChecks, BackgroundRollout } from "../src/checks/gate.js";
import type { Logger } from "../src/observability/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Internal jobs' output checks (spec REFUSAL-HANDLING §5.2.3–4): a summary at
// finalize is judged as an artifact, a run that produced no summary as a
// rollout before its re-run, and every persisted caption as an artifact. The
// hooks are observe-only: they never change the job's outcome.
// ---------------------------------------------------------------------------

const TK = "matrix:test:room:!room:server";
const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };

function event(id: string, timestamp: number): CanonicalChatEvent {
  return { id, timelineKey: TK, provider: "matrix", role: "user", sender: { id: "@u:test" }, body: `message ${id}`, timestamp, receivedAt: timestamp };
}

async function seedJob(storage: Storage, id: string, maxRetries: number): Promise<void> {
  await storage.appendTimelineEvent(event("ev0", 1000));
  await storage.appendTimelineEvent(event("ev1", 2000));
  await storage.insertSummarizationJob({
    id, timelineKey: TK, level: 1, inputStartId: "ev0", inputEndId: "ev1", inputTokenCount: 50, targetTokenCount: 100, maxRetries,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function recorder(): BackgroundChecks & { artifacts: BackgroundArtifact[]; rollouts: BackgroundRollout[] } {
  const artifacts: BackgroundArtifact[] = [];
  const rollouts: BackgroundRollout[] = [];
  return {
    artifacts,
    rollouts,
    artifact: async (input) => {
      artifacts.push(input);
    },
    rollout: async (input) => {
      rollouts.push(input);
    },
  };
}

function summaryFactory(write: boolean, text = "I'm not able to summarize this.") {
  return {
    resolveModelId: () => "test-model",
    resolveSessionCostCeiling: () => 0.5,
    create: async (_session: unknown, tools: AgentTool[]) => {
      if (write) await tools[0]!.execute("t", { command: "create", file_text: "A perfectly fine summary." });
      return {
        agent: {
          prompt: async () => {},
          waitForIdle: async () => {},
          subscribe: () => () => {},
          state: { messages: [{ role: "assistant", content: [{ type: "text", text }], model: "wire-model-1" }] },
        },
        renderedInputIds: ["ev0", "ev1"],
      };
    },
  } as any;
}

test("summarization: the finalized summary is judged as an artifact", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const checks = recorder();
  try {
    await seedJob(storage, "job_ok", 1);
    const pool = new SummarizationWorkerPool({
      storage, factory: summaryFactory(true), config: { worker_count: 1, max_retries: 1 },
      onComplete: () => {}, onError: () => {}, outputChecks: checks, logger: silentLogger,
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => storage.getSummarizationJobById("job_ok")?.status === "complete");
    await pool.stop();
    assert.equal(checks.artifacts.length, 1);
    const [artifact] = checks.artifacts;
    assert.equal(artifact!.site, "summarize");
    assert.equal(artifact!.kind, "summary");
    assert.equal(artifact!.text, "A perfectly fine summary.");
    assert.equal(artifact!.timelineKey, TK);
    assert.equal(artifact!.wireModel, "wire-model-1");
    assert.equal(checks.rollouts.length, 0);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("summarization: a run with no summary is judged as a rollout; the re-run is unchanged", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const checks = recorder();
  try {
    await seedJob(storage, "job_fail", 1);
    const pool = new SummarizationWorkerPool({
      storage, factory: summaryFactory(false), config: { worker_count: 1, max_retries: 1 },
      onComplete: () => {}, onError: () => {}, outputChecks: checks, logger: silentLogger,
    });
    await pool.start();
    pool.notifyNewWork();
    await waitFor(() => checks.rollouts.length >= 1);
    await waitFor(() => {
      const job = storage.getSummarizationJobById("job_fail");
      return job?.status === "pending" || job?.status === "failed" || job?.status === "complete";
    });
    await pool.stop();
    const [rollout] = checks.rollouts;
    assert.equal(rollout!.site, "summarize");
    assert.equal(rollout!.sessionType, "summarize");
    assert.equal((rollout!.messages[0] as any).content[0].text, "I'm not able to summarize this.");
    assert.equal(checks.artifacts.length, 0);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("captioning: every persisted caption reaches the check hook; a throwing hook never fails the caption", async () => {
  const seen: Array<{ caption: string; logical: string; timelineKey: unknown }> = [];
  const storage = { updateCaptionResult: async () => {} } as any;
  const client = {
    caption: async () => ({ caption: "A cat on a sofa.", model: "wire-cap", logicalModelId: "caption_model", provider: null, usage: null, cost: null }),
  } as any;
  const worker = new CaptionWorker({
    storage,
    clients: new Map([["audio", client]]),
    workspaceRoot: "/tmp",
    onCaptioned: (asset, result) => {
      seen.push({ caption: result.caption, logical: result.logicalModelId, timelineKey: (asset as any).timeline_key });
      throw new Error("hook failure must not fail the caption");
    },
  });
  const asset = { id: "a1", event_id: "e1", role: "attachment", local_path: "x.mp3", media_type: "audio", caption_status: "pending", timeline_key: TK } as any;
  assert.equal(await worker.process(asset), "e1");
  assert.deepEqual(seen, [{ caption: "A cat on a sofa.", logical: "caption_model", timelineKey: TK }]);
});
