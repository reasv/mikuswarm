import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ContextBuilder } from "../src/context/index.js";
import { configureAgentTimezone, resetAgentTimezone, formatAgentTimestamp } from "../src/time/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

const TK = "matrix:miku:room:!room";

function minimalConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
    models: {
      default: { id: "test-model", provider: "test", endpoint: "http://localhost", api_key: "key", input_modalities: ["text"], max_tokens: 4096 },
    },
    context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...overrides,
  } as AppConfig;
}

function ev(id: string, body: string, ts: number, role: "user" | "assistant" = "user"): CanonicalChatEvent {
  return {
    id, timelineKey: TK, provider: "matrix", role,
    sender: { id: role === "assistant" ? "@miku:server" : "alice", displayName: role === "assistant" ? "Miku" : "Alice", isSelf: role === "assistant" },
    body, timestamp: ts, receivedAt: ts,
  };
}

const emptyWorkspace: WorkspaceContent = { files: new Map(), tailContent: null, skills: { listed: [], inlined: [] } };

test("proactive build: kickoff is the final user turn with {time} substituted, no trigger group", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig({
    proactive: {
      enabled: true,
      kickoff_prompt: "It is {time}. Decide whether to speak or output NO_REPLY.",
    },
  } as Partial<AppConfig>);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  try {
    await timeline.append(ev("ev1", "hello there", 1000));
    await timeline.append(ev("ev2", "how is everyone", 2000));

    const wakeAt = Date.UTC(2026, 5, 2, 12, 0, 0);
    // Synthetic proactive trigger: not in the timeline, role sentinel, empty body.
    const trigger = ev("proactive-abc123", "", wakeAt);

    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      proactive: true,
    });

    const finalTurn = result.messages[result.messages.length - 1]!;
    assert.equal(finalTurn.type, "triggerGroup", "final turn is a triggerGroup so the runner delivers it");
    assert.equal(finalTurn.role, "user");
    assert.ok(
      finalTurn.content.includes(`It is ${formatAgentTimestamp(wakeAt)}.`),
      "kickoff has {time} substituted with the agent-formatted wake time",
    );
    assert.ok(!finalTurn.content.includes("{time}"), "no literal {time} placeholder remains");
    assert.equal(finalTurn.imageBlocks?.length ?? 0, 0, "synthetic trigger contributes no image blocks");

    // The live conversation renders as usual (the two timeline events appear), and
    // the synthetic trigger itself is NOT pulled out as a trigger-group message.
    const chatEvents = result.messages.filter((m) => m.type === "chatEvent");
    const bodies = chatEvents.map((m) => m.content).join("\n");
    assert.ok(bodies.includes("hello there") && bodies.includes("how is everyone"), "recent timeline is present");
    assert.ok(!bodies.includes("proactive-abc123"), "synthetic trigger is not rendered as a chat event");

    // Runtime state is kept for proactive (the bot should know the time).
    assert.ok(finalTurn.content.includes("Current time:"), "runtime state retained in proactive build");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});

test("proactive build: falls back to a built-in kickoff when none is configured", async () => {
  configureAgentTimezone("UTC");
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig({ proactive: { enabled: true } } as Partial<AppConfig>);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  try {
    await timeline.append(ev("ev1", "hi", 1000));
    const wakeAt = Date.UTC(2026, 5, 2, 9, 30, 0);
    const result = await builder.build({
      timelineKey: TK,
      trigger: ev("proactive-xyz", "", wakeAt),
      activeSessions: [],
      workspace: emptyWorkspace,
      proactive: true,
    });
    const finalTurn = result.messages[result.messages.length - 1]!;
    assert.ok(finalTurn.content.includes(`It is ${formatAgentTimestamp(wakeAt)}`), "default kickoff used + substituted");
    assert.ok(finalTurn.content.includes("NO_REPLY"), "default kickoff mentions the NO_REPLY protocol");
  } finally {
    storage.close();
    resetAgentTimezone();
  }
});
