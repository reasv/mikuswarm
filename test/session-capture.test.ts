import test from "node:test";
import assert from "node:assert/strict";
import { Storage, type AgentSessionInsert } from "../src/storage/index.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  attachSessionCapture,
  externalizeImages,
  type CapturableAgent,
} from "../src/agent/session-capture.js";
import type { ContextMessage } from "../src/context/builder.js";

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

function baseInsert(overrides: Partial<AgentSessionInsert> = {}): AgentSessionInsert {
  const now = 1_000;
  return {
    id: "s-abc1234567",
    timelineKey: "matrix:miku:room:!room",
    sessionType: "default",
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Fake agent: records the subscribed listener so tests can fire events, and
 * exposes a mutable `state.messages`. Structurally a `CapturableAgent`.
 */
class FakeAgent implements CapturableAgent {
  state: { messages: AgentMessage[] } = { messages: [] };
  private listener:
    | ((event: { type: string }, signal: AbortSignal) => void | Promise<void>)
    | null = null;
  unsubscribeCalled = false;

  subscribe(
    listener: (event: { type: string }, signal: AbortSignal) => void | Promise<void>,
  ): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribeCalled = true;
      this.listener = null;
    };
  }

  async fire(type: string): Promise<void> {
    if (!this.listener) return;
    await this.listener({ type }, new AbortController().signal);
  }
}

// Let the fire-and-forget snapshot IIFE settle, and let the single-writer queue
// drain, before reading back.
async function settle(storage: Storage): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await storage.waitForIdle();
}

test("snapshot is persisted once on attach", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    const snapshot: ContextMessage[] = [
      { type: "system", content: "you are miku", tier: "system", tokenEstimate: 3 },
      { type: "chatEvent", role: "user", content: "hello", tier: "rich", tokenEstimate: 1 },
    ] as unknown as ContextMessage[];

    attachSessionCapture(agent, {
      storage,
      sessionId: "s-abc1234567",
      snapshot,
      tokenEstimate: 42,
      dumpPath: "/dumps/s-abc1234567.json",
    });

    await settle(storage);

    const row = storage.getAgentSession("s-abc1234567");
    assert.ok(row?.context_snapshot_json, "context_snapshot_json should be set");
    assert.equal(row?.token_estimate, 42);
    assert.equal(row?.context_dump_path, "/dumps/s-abc1234567.json");
    assert.equal(row?.transcript_json, null, "transcript not written yet");

    const parsed = JSON.parse(row!.context_snapshot_json!);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].tier, "system");
    assert.equal(parsed[0].content, "you are miku");
  });
});

test("transcript flushes on turn_end and agent_end", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    agent.state.messages = [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "hello there" },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await settle(storage);

    // No transcript before any event.
    let row = storage.getAgentSession("s-abc1234567");
    assert.equal(row?.transcript_json, null);

    await agent.fire("turn_end");
    await settle(storage);
    row = storage.getAgentSession("s-abc1234567");
    assert.ok(row?.transcript_json, "transcript written on turn_end");
    const afterTurn = JSON.parse(row!.transcript_json!);
    assert.equal(afterTurn.length, 2);

    // Append another message and fire agent_end -> latest state flushed.
    agent.state.messages = [
      ...agent.state.messages,
      { type: "message", role: "assistant", content: "bye" } as unknown as AgentMessage,
    ];
    await agent.fire("agent_end");
    await settle(storage);
    row = storage.getAgentSession("s-abc1234567");
    const afterEnd = JSON.parse(row!.transcript_json!);
    assert.equal(afterEnd.length, 3);
  });
});

test("non-capture events do not flush", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());
    const agent = new FakeAgent();
    agent.state.messages = [
      { type: "message", role: "user", content: "x" },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await settle(storage);

    await agent.fire("turn_start");
    await agent.fire("tool_execution_start");
    await settle(storage);
    const row = storage.getAgentSession("s-abc1234567");
    assert.equal(row?.transcript_json, null, "no flush on non-capture events");
  });
});

test("image externalization in snapshot drops base64 and adds ref", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    // 3 raw bytes -> base64 "AAEC"
    const b64 = Buffer.from([0, 1, 2]).toString("base64");
    const snapshot: ContextMessage[] = [
      {
        type: "triggerGroup",
        content: "look at this",
        tier: "trigger",
        tokenEstimate: 2,
        imageBlocks: [
          {
            eventId: "$evt1",
            attachmentId: "att1",
            mediaType: "image/png",
            dataBase64: b64,
          },
        ],
      },
    ] as unknown as ContextMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567", snapshot });
    await settle(storage);

    const row = storage.getAgentSession("s-abc1234567");
    const json = row!.context_snapshot_json!;
    assert.ok(!json.includes(b64), "raw base64 must not survive in snapshot JSON");
    assert.ok(!json.includes("dataBase64"), "dataBase64 key must be gone");

    const parsed = JSON.parse(json);
    const ref = parsed[0].imageBlocks[0];
    assert.equal(ref.__imageRef, true);
    assert.equal(ref.mimeType, "image/png");
    assert.equal(ref.sizeBytes, 3);
    assert.equal(ref.eventId, "$evt1");
    assert.equal(ref.attachmentId, "att1");
  });
});

test("image externalization in transcript content blocks drops base64", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    const b64 = Buffer.from([9, 9, 9, 9]).toString("base64");
    agent.state.messages = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", content: "see image" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        ],
      },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("turn_end");
    await settle(storage);

    const row = storage.getAgentSession("s-abc1234567");
    const json = row!.transcript_json!;
    assert.ok(!json.includes(b64), "raw base64 must not survive in transcript JSON");

    const parsed = JSON.parse(json);
    const imgBlock = parsed[0].content[1];
    assert.equal(imgBlock.type, "image");
    assert.equal(imgBlock.source.__imageRef, true);
    assert.equal(imgBlock.source.mimeType, "image/jpeg");
    assert.equal(imgBlock.source.sizeBytes, 4);
  });
});

test("externalizeImages is pure (does not mutate input)", () => {
  const b64 = Buffer.from([1, 2, 3]).toString("base64");
  const input = [
    {
      type: "triggerGroup",
      content: "x",
      tier: "trigger",
      tokenEstimate: 1,
      imageBlocks: [
        { eventId: "$e", attachmentId: "a", mediaType: "image/png", dataBase64: b64 },
      ],
    },
  ];
  const out = externalizeImages(input);
  assert.notEqual(out, input);
  // Original untouched.
  assert.equal(input[0].imageBlocks[0].dataBase64, b64);
  // Output externalized.
  const ref = (out[0] as { imageBlocks: Array<{ sizeBytes: number }> }).imageBlocks[0];
  assert.equal(ref.sizeBytes, 3);
});

test("secrets are redacted in persisted JSON", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    // Register a secret so redactSecrets will replace it (mirrors how config /
    // api keys are registered at startup). The exact literal must not survive.
    const { registerSecret, resetRedactionRegistry } = await import(
      "../src/config/redaction.js"
    );
    const secret = "super-secret-token-value-12345";
    registerSecret(secret);

    try {
      const agent = new FakeAgent();
      const snapshot = [
        {
          type: "chatEvent",
          role: "user",
          content: `my key is ${secret}`,
          tier: "rich",
          tokenEstimate: 5,
        },
      ] as unknown as ContextMessage[];

      attachSessionCapture(agent, { storage, sessionId: "s-abc1234567", snapshot });
      await settle(storage);

      const row = storage.getAgentSession("s-abc1234567");
      const json = row!.context_snapshot_json!;
      assert.ok(!json.includes(secret), "raw secret must be redacted");
      assert.ok(json.includes("[REDACTED]"), "redaction marker present");
    } finally {
      resetRedactionRegistry();
    }
  });
});

test("returned unsubscribe stops further flushes", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    agent.state.messages = [
      { type: "message", role: "user", content: "first" },
    ] as unknown as AgentMessage[];

    const unsubscribe = attachSessionCapture(agent, {
      storage,
      sessionId: "s-abc1234567",
    });
    await settle(storage);

    unsubscribe();
    assert.equal(agent.unsubscribeCalled, true);

    // Fire after unsubscribe -> listener detached, no flush.
    await agent.fire("turn_end");
    await settle(storage);
    const row = storage.getAgentSession("s-abc1234567");
    assert.equal(row?.transcript_json, null, "no flush after unsubscribe");
  });
});
