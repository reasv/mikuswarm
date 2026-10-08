import assert from "node:assert/strict";
import test from "node:test";
import { ContextBuilder } from "../src/context/builder.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { lastSeen, seenFromMessages, UNSEEN_MAX_AGE_MS, withSeenStamp } from "../src/checks/duplicate.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import { OutputGate, wrapToolsWithOutputGate } from "../src/checks/gate.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

// ---------------------------------------------------------------------------
// The duplicate check's last-seen point is never 0 (ARCHITECTURE.md §8j
// "Duplicate sends"): a build that read no raw event stamps when it read the
// timeline, a stored 0 stamp is ignored, and the unseen read is bounded.
// ---------------------------------------------------------------------------

const TK = "matrix:miku:room:!room";
function config(): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: { default: { id: "m", provider: "test", endpoint: "http://localhost", api_key: "key", input_modalities: ["text"], max_tokens: 4096, context_window: 128_000 } },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  } as AppConfig;
}
const workspace: WorkspaceContent = { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };

test("a build that read no raw timeline event stamps when it read the timeline, never 0", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const builder = new ContextBuilder(new TimelineStore(storage), config(), storage);
    // A proactive-style synthetic trigger (never stored): nothing raw in the window.
    const trigger: CanonicalChatEvent = {
      id: "proactive-abc", timelineKey: TK, provider: "matrix", role: "user",
      sender: { id: "@bot:x", displayName: "Bot", isSelf: true }, body: "", timestamp: Date.now(), receivedAt: Date.now(),
      trigger: { type: "timer", reason: "proactive" } as never,
    };
    const before = Date.now();
    const built = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "s1" });
    assert.ok(built.timelineCutoff !== undefined && built.timelineCutoff >= before && built.timelineCutoff <= Date.now(), `cutoff ${built.timelineCutoff}`);
    const head = withSeenStamp({ type: "triggerGroup", content: "x", timestamp: 5 }, { timelineKey: TK, upTo: built.timelineCutoff! });
    assert.ok(lastSeen(seenFromMessages([head]), TK)! >= before);
  } finally {
    storage.close();
  }
});

test("a stored 0 stamp (an older build) is no last-seen point: the head turn's time is", () => {
  const head = withSeenStamp({ type: "triggerGroup", content: "x", timestamp: 5_000 }, { timelineKey: TK, upTo: 0 });
  assert.equal(lastSeen(seenFromMessages([head]), TK), 5_000);
});

test("the unseen read never reaches back further than UNSEEN_MAX_AGE_MS", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const models: any = {
      decider: { id: "d", provider: "openrouter", api: "system-one", endpoint: "https://gw.example/decisions", api_key: "k", input_modalities: ["text"], max_tokens: 1, context_window: 32000 },
    };
    const cfg: any = { models, decisions: { enabled: true, model: "decider", checks: { enabled: true } }, checks: { duplicate: { enabled: true } }, agents: {} };
    const fetchImpl = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    const engine = new DecisionEngine({ config: cfg, client: new DecisionClient({ models, fetchImpl }), record: () => {} });
    const evaluator = new CheckEvaluator({ catalogue: buildCheckCatalogue(cfg), engine, config: cfg, storage });
    const reads: number[] = [];
    const now = Date.now();
    const gate = new OutputGate({
      evaluator,
      scope: { agent: null, site: "default", sessionId: "s1", sessionType: "default", timelineKey: TK, tasks: null },
      // A session whose last-seen point is a day old.
      getMessages: () => [withSeenStamp({ type: "triggerGroup", content: "x", timestamp: 1 }, { timelineKey: TK, upTo: now - 24 * 3600_000 })],
      duplicate: {
        target: () => TK,
        messages: (_tk, after) => {
          reads.push(after);
          return [];
        },
        answering: () => "unprompted",
      },
      now: () => now,
    });
    const [tool] = wrapToolsWithOutputGate(
      [{ name: "send_message", label: "s", description: "s", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [], details: {} }) }],
      gate,
    );
    await tool!.execute("c1", { message: "hello there" } as never, undefined, undefined);
    assert.deepEqual(reads, [now - UNSEEN_MAX_AGE_MS]);
  } finally {
    storage.close();
  }
});
