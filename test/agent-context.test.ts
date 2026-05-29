import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../src/agent/convert.js";
import { buildAgentContextMessages } from "../src/agent/factory.js";
import type { BuiltContext } from "../src/context/index.js";
import { ContextBuilder, type BuildContextOptions } from "../src/context/builder.js";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { WorkspaceContent } from "../src/workspace/types.js";

test("agent context keeps timeline base and preserves live runtime messages", () => {
  const built: BuiltContext = {
    messages: [
      {
        type: "system",
        role: "system",
        content: "system prompt",
        tier: "system",
        tokenEstimate: 1,
      },
      {
        type: "chatEvent",
        role: "user",
        content: "<message>hello</message>",
        tier: "rich",
        tokenEstimate: 1,
      },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 1,
    imageBlocks: [],
  };

  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "tool output" }],
    details: {},
    isError: false,
    timestamp: 1,
  };
  const interjection: AgentMessage = { type: "interjection", content: "new user reply" };
  const forcedPrompt: AgentMessage = { role: "user", content: "finish visibly", timestamp: 2 };
  const duplicateTrigger: AgentMessage = {
    type: "chatEvent",
    role: "user",
    content: "hello",
  };

  const messages = buildAgentContextMessages(built, [
    duplicateTrigger,
    toolResult,
    interjection,
    forcedPrompt,
  ]);

  assert.deepEqual(
    messages.map((message) => (message as any).type ?? (message as any).role),
    ["chatEvent", "toolResult", "interjection", "user"],
  );

  const llmMessages = convertToLlm(messages);
  assert.equal(llmMessages.some((message) => (message as any).content === "system prompt"), false);
  assert.equal(llmMessages.some((message) => message.role === "toolResult"), true);
  assert.equal(llmMessages.some((message) => message.role === "user" && message.content === "finish visibly"), true);
  assert.equal(
    llmMessages.some(
      (message) => message.role === "user" && typeof message.content === "string" && message.content.includes("<interjection>"),
    ),
    true,
  );
});

test("summary layer renders as a user turn ahead of chat and trigger", () => {
  const built: BuiltContext = {
    messages: [
      { type: "system", role: "system", content: "system prompt", tier: "system", tokenEstimate: 1 },
      {
        type: "summaryLayer",
        role: "user",
        content: "<summary level=\"1\">old history</summary>",
        tier: "summary",
        tokenEstimate: 1,
        timestamp: 10,
      },
      { type: "chatEvent", role: "user", content: "<message>recent</message>", tier: "compact", tokenEstimate: 1, timestamp: 20 },
      { type: "triggerGroup", role: "user", content: "<system>now</system>", tier: "trigger", tokenEstimate: 1, timestamp: 30 },
    ],
    tokenEstimate: 4,
    compactTokens: 1,
    richTokens: 0,
    imageBlocks: [],
  } as BuiltContext;

  const messages = buildAgentContextMessages(built, []);

  assert.deepEqual(
    messages.map((m) => (m as any).type),
    ["chatEvent", "chatEvent", "triggerGroup"],
  );
  // The summary layer is the first chatEvent, role user, carrying the summary body.
  assert.equal((messages[0] as any).role, "user");
  assert.match((messages[0] as any).content, /<summary/);

  const llm = convertToLlm(messages);
  assert.equal(
    llm.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<summary")),
    true,
  );
});

test("convertToLlm filters accidental system transcript messages", () => {
  const messages = convertToLlm([{ role: "system", content: "duplicate system", timestamp: 1 } as any]);
  assert.deepEqual(messages, []);
});

test("convertToLlm renders historical assistant chat events as assistant messages", () => {
  const messages = convertToLlm([
    {
      type: "chatEvent",
      role: "assistant",
      content: "<message sender=\"Miku\">hello</message>",
      timestamp: 1,
    } as any,
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "assistant");
});

// ── summarizationCutoff path in ContextBuilder.build() (#5) ──────────

/** Minimal AppConfig sufficient for ContextBuilder.build() without touching real
 *  files, network, or the full schema. Uses cast-to-AppConfig to avoid filling
 *  every optional field. */
function minimalConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
    },
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        multimodal: false,
        max_tokens: 4096,
      },
    },
    context: {
      tiers: {
        rich_target_tokens: 2000,
        rich_max_tokens: 4000,
        compact_target_tokens: 4000,
        compact_max_tokens: 8000,
      },
    },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...overrides,
  } as AppConfig;
}

function testEvent(overrides: {
  id: string;
  body: string;
  timestamp: number;
  role?: "user" | "assistant";
}): CanonicalChatEvent {
  return {
    id: overrides.id,
    timelineKey: "matrix:miku:room:!room",
    provider: "matrix",
    role: overrides.role ?? "user",
    sender: { id: "alice", displayName: "Alice" },
    body: overrides.body,
    timestamp: overrides.timestamp,
    receivedAt: overrides.timestamp,
  };
}

const emptyWorkspace: WorkspaceContent = {
  files: new Map(),
  tailContent: null,
  skills: { listed: [], inlined: [] },
};

test("summarizationCutoff: only events with timestamp <= endTimestamp are included", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "first", timestamp: 1000 }));
    await timeline.append(testEvent({ id: "ev2", body: "second", timestamp: 2000 }));
    await timeline.append(testEvent({ id: "ev3", body: "third", timestamp: 3000 }));
    await timeline.append(testEvent({ id: "ev4", body: "fourth", timestamp: 4000 }));

    const trigger = testEvent({ id: "summarize:test", body: "Summarize", timestamp: 2000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 2000 },
    });

    // Only ev1 and ev2 (timestamp <= 2000) should appear as chatEvent messages.
    const chatEvents = result.messages.filter((m) => m.type === "chatEvent");
    const bodies = chatEvents.map((m) => m.content);
    assert.ok(bodies.some((b) => b.includes("first")), "ev1 should be included");
    assert.ok(bodies.some((b) => b.includes("second")), "ev2 should be included");
    assert.ok(!bodies.some((b) => b.includes("third")), "ev3 should be excluded (timestamp > cutoff)");
    assert.ok(!bodies.some((b) => b.includes("fourth")), "ev4 should be excluded (timestamp > cutoff)");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: summary layer excludes summaries overlapping the events being summarized", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // Insert events spanning 1000–4000.
    for (let i = 1; i <= 4; i++) {
      await timeline.append(testEvent({ id: `ev${i}`, body: `event ${i}`, timestamp: i * 1000 }));
    }

    // Insert a summary covering events up to timestamp 1500 (before the events being summarized).
    await storage.write((db) => {
      db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
         latest_timestamp, latest_event_id, event_count, token_count, model_id,
         status, generated_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sum_old", TK, 1, "old summary", 500, 1500, "ev1", 2, 50, "model", "complete", 0, 0);
    });

    // Insert a summary that overlaps the events being summarized (latestTimestamp = 3500).
    await storage.write((db) => {
      db.prepare(
        `insert into summaries (id, timeline_key, level, content, earliest_timestamp,
         latest_timestamp, latest_event_id, event_count, token_count, model_id,
         status, generated_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sum_overlap", TK, 1, "overlapping summary", 2000, 3500, "ev3", 2, 50, "model", "complete", 0, 0);
    });

    // Build with cutoff at 4000. The earliest event timestamp is 2000 (first event
    // after the old summary's coverage). The beforeTimestamp filter should exclude
    // sum_overlap (latestTimestamp 3500 > earliest event being summarized).
    const trigger = testEvent({ id: "summarize:test2", body: "Summarize", timestamp: 4000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 4000 },
    });

    const summaryMsg = result.messages.find((m) => m.type === "summaryLayer");
    if (summaryMsg) {
      assert.ok(summaryMsg.content.includes("old summary"), "old summary should be in layer");
      assert.ok(!summaryMsg.content.includes("overlapping summary"), "overlapping summary should be excluded");
    }
    // sum_old is included. The events being summarized (after sum_old's coverage) should render.
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: runtime state is suppressed", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));

    const trigger = testEvent({ id: "summarize:test3", body: "Summarize", timestamp: 1000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1000 },
    });

    // The final user turn (satellite) should NOT contain <runtime_state>.
    const satellite = result.messages.find((m) => m.type === "satellite");
    assert.ok(satellite, "satellite message should exist");
    assert.ok(!satellite!.content.includes("<runtime_state>"), "runtime_state should be suppressed in summarization build");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: image blocks are skipped", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig({
    models: {
      default: {
        id: "test-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        multimodal: true,
        max_tokens: 4096,
      },
    },
  } as any);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));

    const trigger = testEvent({ id: "summarize:test4", body: "Summarize", timestamp: 1000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1000 },
    });

    assert.deepEqual(result.imageBlocks, [], "image blocks should be empty for summarization build");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: no job enqueueing during summarization build", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  // Set a very low generation threshold so a normal build would enqueue.
  const config = minimalConfig({
    summarization: {
      enabled: true,
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    },
  } as any);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    // Insert enough events to exceed the threshold.
    for (let i = 0; i < 20; i++) {
      await timeline.append(testEvent({
        id: `ev${i}`,
        body: `message content that has some words ${i}`,
        timestamp: 1000 + i,
      }));
    }

    let jobEnqueued = false;
    builder.onJobEnqueued = () => { jobEnqueued = true; };

    const trigger = testEvent({ id: "summarize:test5", body: "Summarize", timestamp: 1019 });
    await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1019 },
    });

    assert.equal(jobEnqueued, false, "no job should be enqueued during a summarization build");

    // Double-check: no jobs in the database.
    const jobs = storage.getActiveSummarizationJobs(TK, 1);
    assert.equal(jobs.length, 0, "no summarization jobs should exist in DB");
  } finally {
    storage.close();
  }
});

test("summarizationCutoff: final message type is 'satellite' not 'triggerGroup'", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig();
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    await timeline.append(testEvent({ id: "ev1", body: "hello", timestamp: 1000 }));

    const trigger = testEvent({ id: "summarize:test6", body: "Summarize", timestamp: 1000 });
    const result = await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
      summarizationCutoff: { endTimestamp: 1000 },
    });

    const lastMsg = result.messages[result.messages.length - 1];
    assert.equal(lastMsg?.type, "satellite", "final message type should be 'satellite' in a summarization build");
    assert.ok(!result.messages.some((m) => m.type === "triggerGroup"), "no triggerGroup message should exist");
  } finally {
    storage.close();
  }
});

// ── enabled predicate: undefined means enabled (#1) ──────────────────

test("maybeEnqueueLevel1 enqueues when summarization.enabled is explicitly undefined", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  // summarization key present but enabled is not set; low threshold + tiny rich tier
  // so events land in the compact tier and exceed the threshold.
  const config = minimalConfig({
    summarization: {
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    },
    context: {
      tiers: {
        rich_target_tokens: 1,
        rich_max_tokens: 1,
        compact_target_tokens: 40000,
        compact_max_tokens: 80000,
      },
    },
  } as any);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    for (let i = 0; i < 20; i++) {
      await timeline.append(testEvent({
        id: `ev${String(i).padStart(4, "0")}`,
        body: `message content with some words ${i}`,
        timestamp: 1000 + i,
      }));
    }

    let jobEnqueued = false;
    builder.onJobEnqueued = () => { jobEnqueued = true; };

    const trigger = testEvent({ id: "trigger2", body: "hi", timestamp: 2000, role: "user" });
    await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });

    assert.equal(jobEnqueued, true, "job should be enqueued when enabled key is missing (defaults to true)");
  } finally {
    storage.close();
  }
});

test("maybeEnqueueLevel1 skips when summarization.enabled is explicitly false", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const config = minimalConfig({
    summarization: {
      enabled: false,
      generation_threshold_tokens: 1,
      leaf_input_tokens: 10,
      leaf_target_tokens: 5,
    },
    context: {
      tiers: {
        rich_target_tokens: 1,
        rich_max_tokens: 1,
        compact_target_tokens: 40000,
        compact_max_tokens: 80000,
      },
    },
  } as any);
  const timeline = new TimelineStore(storage);
  const builder = new ContextBuilder(timeline, config, storage);
  const TK = "matrix:miku:room:!room";
  try {
    for (let i = 0; i < 20; i++) {
      await timeline.append(testEvent({
        id: `ev${String(i).padStart(4, "0")}`,
        body: `message content with some words ${i}`,
        timestamp: 1000 + i,
      }));
    }

    let jobEnqueued = false;
    builder.onJobEnqueued = () => { jobEnqueued = true; };

    const trigger = testEvent({ id: "trigger3", body: "hi", timestamp: 2000, role: "user" });
    await builder.build({
      timelineKey: TK,
      trigger,
      activeSessions: [],
      workspace: emptyWorkspace,
    });

    assert.equal(jobEnqueued, false, "no job should be enqueued when enabled is explicitly false");
  } finally {
    storage.close();
  }
});
