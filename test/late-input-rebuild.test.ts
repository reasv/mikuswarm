/**
 * The cache contract of a redo from scratch (ARCHITECTURE.md §8 "Late input"):
 * the rebuild against the first build's timeline cutoff reproduces the first
 * build's prefix byte for byte, with only the corrected trigger turn changed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm } from "../src/agent/convert.js";
import { splitBuiltContext } from "../src/agent/factory.js";
import { ContextBuilder } from "../src/context/builder.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

const TK = "matrix:miku:room:!room";

function config(): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 128_000,
      },
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
  } as AppConfig;
}

const workspace: WorkspaceContent = { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };

function event(id: string, body: string, ts: number, sender = "bob"): CanonicalChatEvent {
  return {
    id,
    externalId: `$${id}`,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: sender, displayName: sender },
    body,
    timestamp: ts,
    receivedAt: ts,
  };
}

async function setup() {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config(), storage);
  for (let i = 0; i < 6; i += 1) await timeline.append(event(`old${i}`, `older chat ${i}`, 1000 + i * 100));
  const trigger = event("t", "what is the capital of Australia?", 5000, "alice");
  trigger.trigger = { type: "mention", reason: "mention", triggeredBy: trigger.sender, groupedEventIds: ["t"] };
  await timeline.append(trigger);
  return { storage, timeline, builder, trigger };
}

/** The wire prefix (everything before the final user turn), serialized. */
function wirePrefix(built: Awaited<ReturnType<ContextBuilder["build"]>>): string {
  return JSON.stringify(convertToLlm(splitBuiltContext(built).frozenBase as never));
}

test("rebuild after a trigger edit: the prefix is byte-identical, the trigger turn carries the edit", async () => {
  const { storage, timeline, builder, trigger } = await setup();
  try {
    const first = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "s1" });
    assert.ok(first.timelineCutoff !== undefined && first.timelineCutoff >= 5000);
    // After the first build: someone else talks, and the trigger is edited in place.
    await timeline.append(event("late-other", "unrelated message from bob", 6000));
    await storage.updateTimelineEvent("t", (e) => ({ ...e, body: "what is the capital of Austria?" }));
    const rebuilt = await builder.build({
      timelineKey: TK,
      trigger: { ...trigger, body: "what is the capital of Austria?" },
      activeSessions: [],
      workspace,
      selfSessionId: "s1",
      timelineCutoff: first.timelineCutoff,
    });
    assert.equal(wirePrefix(rebuilt), wirePrefix(first), "the prefix up to the final turn is unchanged");
    const finalTurn = String(splitBuiltContext(rebuilt).finalTurn && (splitBuiltContext(rebuilt).finalTurn as { content: string }).content);
    assert.ok(finalTurn.includes("capital of Austria"), "the edited body");
    assert.ok(!finalTurn.includes("Australia"));
    assert.ok(!JSON.stringify(rebuilt.messages).includes("unrelated message from bob"), "a message after the cutoff stays out");
    // Without the cutoff, the new message would enter the prefix.
    const uncut = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "s1" });
    assert.notEqual(wirePrefix(uncut), wirePrefix(first));
  } finally {
    storage.close();
  }
});

test("rebuild after a late addition: the addition joins the trigger turn, the prefix is unchanged", async () => {
  const { storage, timeline, builder, trigger } = await setup();
  try {
    const first = await builder.build({ timelineKey: TK, trigger, activeSessions: [], workspace, selfSessionId: "s1" });
    await timeline.append(event("add", "the one in Europe", 7000, "alice"));
    const grown = { ...trigger, trigger: { ...trigger.trigger!, groupedEventIds: ["t", "add"] } };
    await timeline.setTriggerGroup("t", ["t", "add"]);
    const rebuilt = await builder.build({
      timelineKey: TK,
      trigger: grown,
      activeSessions: [],
      workspace,
      selfSessionId: "s1",
      timelineCutoff: first.timelineCutoff,
    });
    assert.equal(wirePrefix(rebuilt), wirePrefix(first));
    const finalTurn = (splitBuiltContext(rebuilt).finalTurn as { content: string }).content;
    assert.ok(finalTurn.includes("capital of Australia") && finalTurn.includes("the one in Europe"));
  } finally {
    storage.close();
  }
});
