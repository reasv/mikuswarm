/**
 * Tests for read_session_transcript (T3 fix: resultIndex built from message-level
 * toolCallId, not from content-block scanning).
 *
 * The transcript is built using real pi AgentMessage shapes — toolResult messages
 * carry toolCallId at the message level, with content as TextContent[] blocks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Storage } from "../src/storage/index.js";
import { createReadSessionTranscriptTool } from "../src/tools/read-session-record.js";

// ── helpers ──────────────────────────────────────────────────────────────────

async function withStorage(fn: (s: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

/**
 * Build a minimal realistic transcript: one assistant turn with a tool call,
 * followed by its toolResult message using the real pi AgentMessage shape.
 * toolCallId is at the MESSAGE level on the toolResult — not inside a content block.
 */
function buildTranscript(
  toolName: string,
  toolArgs: Record<string, unknown>,
  resultText: string,
  toolCallId = "tc_abc123",
): AgentMessage[] {
  const assistantMsg: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: toolArgs }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as AgentMessage;

  // Real pi ToolResultMessage shape: toolCallId at message level, content as text blocks.
  const toolResultMsg: AgentMessage = {
    role: "toolResult",
    toolCallId,             // at MESSAGE level — this is what T3 fixes the index to read
    toolName,
    content: [{ type: "text", text: resultText }],
    details: null,
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;

  return [assistantMsg, toolResultMsg];
}

// ── T3: resultIndex is keyed by message-level toolCallId ─────────────────────

test("read_session_transcript: tool result is found (not '(not found)')", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    const sessionId = "s-t3-test";
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "!room:example.com",
      sessionType: "default",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    const transcript = buildTranscript("send_message", { text: "Hello!" }, "Message sent.");
    await storage.saveAgentSessionTranscript(sessionId, JSON.stringify(transcript));

    const tool = createReadSessionTranscriptTool({ storage });
    const result = await tool.execute("tc", { session_id: sessionId });

    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");

    // The result should contain the tool name and its result text.
    assert.ok(text.includes("send_message"), `expected send_message in: ${text}`);
    // Critically: the result must NOT be "(not found)" — that was the T3 bug.
    assert.ok(!text.includes("(not found)"), `result showed (not found), index is still broken: ${text}`);
    // The actual result text should be present.
    assert.ok(text.includes("Message sent."), `expected result text in: ${text}`);
  });
});

test("read_session_transcript: query filter matches result text", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    const sessionId = "s-t3-query";
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "!room:example.com",
      sessionType: "default",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    const msgs: AgentMessage[] = [
      ...buildTranscript("search_web", { query: "cats" }, "Found 3 cat articles.", "tc_1"),
      ...buildTranscript("send_message", { text: "Here you go!" }, "Sent.", "tc_2"),
    ];
    await storage.saveAgentSessionTranscript(sessionId, JSON.stringify(msgs));

    const tool = createReadSessionTranscriptTool({ storage });

    // Query by result text — should find only the search_web call.
    const result = await tool.execute("tc", { session_id: sessionId, query: "cat" });
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");

    assert.ok(text.includes("search_web"), `expected search_web: ${text}`);
    assert.ok(text.includes("cat articles"), `expected result text: ${text}`);
    assert.ok(!text.includes("(not found)"), `result showed (not found): ${text}`);
  });
});

test("read_session_transcript: range filter works with real shapes", async () => {
  await withStorage(async (storage) => {
    const now = Date.now();
    const sessionId = "s-t3-range";
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "!room:example.com",
      sessionType: "default",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });

    const msgs: AgentMessage[] = [
      ...buildTranscript("read_file", { path: "a.txt" }, "Contents of a.txt", "tc_r1"),
      ...buildTranscript("send_message", { text: "Done" }, "Sent.", "tc_r2"),
    ];
    await storage.saveAgentSessionTranscript(sessionId, JSON.stringify(msgs));

    const tool = createReadSessionTranscriptTool({ storage });

    // Request only turn 2.
    const result = await tool.execute("tc", { session_id: sessionId, range: [2, 2] });
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("");

    assert.ok(text.includes("send_message"), `expected send_message in turn 2: ${text}`);
    assert.ok(!text.includes("read_file"), `turn 1 should be excluded: ${text}`);
    assert.ok(!text.includes("(not found)"), `result showed (not found): ${text}`);
  });
});
