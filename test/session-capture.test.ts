import test from "node:test";
import assert from "node:assert/strict";
import { Storage, type AgentSessionInsert } from "../src/storage/index.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  attachSessionCapture,
  externalizeImages,
  base64ByteLength,
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
  state: { messages: AgentMessage[]; errorMessage?: string } = { messages: [] };
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

  /**
   * Fire an agent event. The optional `payload` lets a test attach an event
   * payload such as `agent_end`'s `{ messages }` (used to exercise #12, where
   * capture must prefer the payload over `state.messages`).
   */
  async fire(type: string, payload?: { messages?: AgentMessage[] }): Promise<void> {
    if (!this.listener) return;
    await this.listener({ type, ...payload }, new AbortController().signal);
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

test("externalizeImages externalizes pi-ai inline image blocks ({type:image,data,mimeType})", () => {
  // pi-ai's ImageContent shape (no `source` wrapper) appears in UserMessage /
  // ToolResultMessage content arrays (issue #4). It must be externalized too.
  const b64 = Buffer.from([1, 2, 3, 4, 5]).toString("base64");
  const input = [
    {
      role: "toolResult",
      toolCallId: "t1",
      content: [
        { type: "text", content: "here's the screenshot" },
        { type: "image", data: b64, mimeType: "image/png" },
      ],
    },
  ];
  const out = externalizeImages(input) as Array<{
    content: Array<Record<string, unknown>>;
  }>;
  const json = JSON.stringify(out);
  assert.ok(!json.includes(b64), "raw base64 must not survive externalization");

  const imgBlock = out[0]!.content[1]!;
  assert.equal(imgBlock.type, "image", "the block type is preserved");
  const ref = imgBlock.data as { __imageRef: boolean; mimeType?: string; sizeBytes: number };
  assert.equal(ref.__imageRef, true);
  assert.equal(ref.mimeType, "image/png");
  assert.equal(ref.sizeBytes, 5);
  assert.equal(typeof imgBlock.data, "object", "data replaced by an ImageRef object");
});

test("pi-ai inline branch does not collide with the Anthropic source branch", () => {
  // A block that has BOTH a `source` wrapper and a top-level `data` must take the
  // Anthropic path (externalize `source`), never the pi-ai path.
  const b64 = Buffer.from([7, 7, 7]).toString("base64");
  const input = [
    {
      type: "image",
      source: { type: "base64", media_type: "image/gif", data: b64 },
    },
  ];
  const out = externalizeImages(input) as Array<Record<string, unknown>>;
  const block = out[0]!;
  const src = block.source as { __imageRef: boolean; mimeType?: string; sizeBytes: number };
  assert.equal(src.__imageRef, true, "Anthropic source branch handled the block");
  assert.equal(src.mimeType, "image/gif");
  assert.equal(src.sizeBytes, 3);
  assert.ok(!("data" in block), "no stray top-level data ref was added");
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

    const capture = attachSessionCapture(agent, {
      storage,
      sessionId: "s-abc1234567",
    });
    await settle(storage);

    capture.detach();
    assert.equal(agent.unsubscribeCalled, true);

    // Fire after unsubscribe -> listener detached, no flush.
    await agent.fire("turn_end");
    await settle(storage);
    const row = storage.getAgentSession("s-abc1234567");
    assert.equal(row?.transcript_json, null, "no flush after unsubscribe");
  });
});

// ---------------------------------------------------------------------------
// Issue #8 — exhaustive image externalization (non-Anthropic shapes + data URIs)
// ---------------------------------------------------------------------------

test("#8 externalizes OpenAI-style image_url blocks (no base64 survives)", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    const b64 = Buffer.from([1, 2, 3, 4, 5]).toString("base64");
    const dataUri = `data:image/webp;base64,${b64}`;
    agent.state.messages = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", content: "look" },
          { type: "image_url", image_url: { url: dataUri, detail: "high" } },
        ],
      },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("turn_end");
    await settle(storage);

    const json = storage.getAgentSession("s-abc1234567")!.transcript_json!;
    assert.ok(!json.includes(b64), "raw base64 must not survive in transcript JSON");

    const parsed = JSON.parse(json);
    const block = parsed[0].content[1];
    assert.equal(block.type, "image_url");
    assert.equal(block.image_url.detail, "high", "sibling fields preserved");
    assert.equal(block.image_url.url.__imageRef, true);
    assert.equal(block.image_url.url.mimeType, "image/webp");
    assert.equal(block.image_url.url.sizeBytes, 5);
  });
});

test("#8 externalizes a bare { url: data-URI } block", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    const b64 = Buffer.from([7, 7, 7]).toString("base64");
    agent.state.messages = [
      {
        type: "message",
        role: "user",
        content: [{ url: `data:image/gif;base64,${b64}`, alt: "g" }],
      },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("turn_end");
    await settle(storage);

    const json = storage.getAgentSession("s-abc1234567")!.transcript_json!;
    assert.ok(!json.includes(b64), "raw base64 must not survive");

    const parsed = JSON.parse(json);
    const block = parsed[0].content[0];
    assert.equal(block.alt, "g", "sibling fields preserved");
    assert.equal(block.url.__imageRef, true);
    assert.equal(block.url.mimeType, "image/gif");
    assert.equal(block.url.sizeBytes, 3);
  });
});

test("#8 strips inline base64 data URIs embedded in text strings", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    const b64 = Buffer.from([4, 4, 4, 4, 4, 4]).toString("base64");
    agent.state.messages = [
      {
        type: "message",
        role: "assistant",
        content: `here it is: data:image/png;base64,${b64} done`,
      },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("turn_end");
    await settle(storage);

    const json = storage.getAgentSession("s-abc1234567")!.transcript_json!;
    assert.ok(!json.includes(b64), "embedded base64 must be stripped from text");

    const parsed = JSON.parse(json);
    assert.match(
      parsed[0].content,
      /data:image\/png;base64,<imageRef sizeBytes=6>/,
      "data URI replaced with size-bearing marker",
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #9 — base64ByteLength computed arithmetically, equal to a real decode
// ---------------------------------------------------------------------------

test("#9 base64ByteLength matches Buffer decode across payload shapes", () => {
  const cases: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from([0]),
    Buffer.from([0, 1]),
    Buffer.from([0, 1, 2]),
    Buffer.from([0, 1, 2, 3]),
    Buffer.from([0, 1, 2, 3, 4]),
    Buffer.from("hello world, this is a longer payload!"),
    Buffer.from(Array.from({ length: 257 }, (_, i) => i % 256)),
  ];
  for (const buf of cases) {
    const b64 = buf.toString("base64"); // padded
    assert.equal(
      base64ByteLength(b64),
      Buffer.from(b64, "base64").length,
      `padded len mismatch for ${buf.length} bytes`,
    );
    // Unpadded variant.
    const unpadded = b64.replace(/=+$/, "");
    assert.equal(
      base64ByteLength(unpadded),
      buf.length,
      `unpadded len mismatch for ${buf.length} bytes`,
    );
    // Whitespace-wrapped variant (line breaks every 8 chars).
    const wrapped = b64.replace(/(.{8})/g, "$1\n");
    assert.equal(
      base64ByteLength(wrapped),
      buf.length,
      `whitespace-wrapped len mismatch for ${buf.length} bytes`,
    );
    // data: URI variant.
    assert.equal(
      base64ByteLength(`data:image/png;base64,${b64}`),
      buf.length,
      `data-uri len mismatch for ${buf.length} bytes`,
    );
  }
});

test("#9 base64ByteLength guards malformed input", () => {
  assert.equal(base64ByteLength(""), 0);
  assert.equal(base64ByteLength("@@@@"), 0, "non-base64 chars -> 0");
  assert.equal(base64ByteLength("ABCDE"), 0, "len % 4 === 1 is impossible -> 0");
  assert.equal(base64ByteLength(undefined as unknown as string), 0);
});

// ---------------------------------------------------------------------------
// Issue #10 — snapshot write is enqueued before the first transcript write
// ---------------------------------------------------------------------------

test("#10 snapshot is enqueued before the first transcript flush", async () => {
  // Fake storage that records call order and lets us delay the snapshot write to
  // prove the first transcript flush waits for the snapshot enqueue regardless.
  const order: string[] = [];
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  const fakeStorage = {
    async saveAgentSessionSnapshot() {
      order.push("snapshot");
      await snapshotGate; // hold the snapshot mid-write
    },
    async saveAgentSessionTranscript() {
      order.push("transcript");
    },
  } as unknown as Storage;

  const agent = new FakeAgent();
  agent.state.messages = [
    { type: "message", role: "user", content: "hi" },
  ] as unknown as AgentMessage[];

  attachSessionCapture(agent, {
    storage: fakeStorage,
    sessionId: "s-abc1234567",
    snapshot: [
      { type: "system", content: "s", tier: "system", tokenEstimate: 1 },
    ] as unknown as ContextMessage[],
  });

  // Fire turn_end but DON'T await it yet. The listener awaits the transcript
  // flush, which is chained behind the snapshot write — and that write is still
  // gated open. Awaiting fire() here would deadlock (the gate is released below,
  // after this point). In production the snapshot write resolves on its own via
  // the single-writer queue, so the turn_end listener never stalls; the gate only
  // exists to prove the transcript is ordered strictly AFTER the snapshot write.
  const fired = agent.fire("turn_end");
  // Let microtasks drain. The transcript must NOT have run: its flush is chained
  // behind the snapshot write, which is still held open by snapshotGate.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["snapshot"], "transcript must wait for snapshot");

  // Releasing the gate lets the snapshot write resolve, which unblocks the chained
  // transcript flush; awaiting `fired` then waits for that flush to complete.
  releaseSnapshot();
  await fired;

  assert.deepEqual(order, ["snapshot", "transcript"], "snapshot precedes transcript");
});

// ---------------------------------------------------------------------------
// Issue #12 — agent_end flush prefers the event's { messages } payload
// ---------------------------------------------------------------------------

test("#12 agent_end uses event.messages payload over state.messages", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    // state.messages is deliberately STALE / different from the event payload.
    agent.state.messages = [
      { type: "message", role: "user", content: "stale-state" },
    ] as unknown as AgentMessage[];

    const payloadMessages = [
      { type: "message", role: "user", content: "payload-user" },
      { type: "message", role: "assistant", content: "payload-assistant" },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("agent_end", { messages: payloadMessages });
    await settle(storage);

    const json = storage.getAgentSession("s-abc1234567")!.transcript_json!;
    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 2, "persisted the payload, not the 1-msg state");
    assert.equal(parsed[1].content, "payload-assistant");
    assert.ok(!json.includes("stale-state"), "state.messages must not be persisted");
  });
});

test("#12 turn_end (no payload) falls back to state.messages", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    agent.state.messages = [
      { type: "message", role: "user", content: "from-state" },
    ] as unknown as AgentMessage[];

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("turn_end");
    await settle(storage);

    const json = storage.getAgentSession("s-abc1234567")!.transcript_json!;
    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].content, "from-state");
  });
});

test("failed run: agent_end's 1-message failure payload is ignored in favour of the full state", async () => {
  await withStorage(async (storage) => {
    // pi-agent-core's handleRunFailure emits `agent_end` with
    // `messages: [failureMessage]` ONLY. Preferring that payload would
    // overwrite the transcript with a one-element array — destroying the
    // resume material until the error-path flushNow() repair. When
    // state.errorMessage is set (the run failed), state.messages is canonical.
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "529 overloaded",
    } as unknown as AgentMessage;
    agent.state.messages = [
      { type: "triggerGroup", content: "kickoff" },
      failureMessage,
    ] as unknown as AgentMessage[];
    agent.state.errorMessage = "529 overloaded";

    attachSessionCapture(agent, { storage, sessionId: "s-abc1234567" });
    await agent.fire("agent_end", { messages: [failureMessage] });
    await settle(storage);

    const parsed = JSON.parse(storage.getAgentSession("s-abc1234567")!.transcript_json!);
    assert.equal(parsed.length, 2, "full live state persisted, not the 1-msg failure payload");
    assert.equal(parsed[0].content, "kickoff");
  });
});

// ---------------------------------------------------------------------------
// Issue #1 — flushNow() captures the transcript on the error/abort path
// ---------------------------------------------------------------------------

test("#1 flushNow persists the kickoff turn when run errors before turn_end", async () => {
  await withStorage(async (storage) => {
    // Mirror the chat path: a 'running' row exists; the run rejects before any
    // turn_end. The error path must flush before detaching + marking discarded.
    await storage.insertAgentSession(baseInsert());

    const agent = new FakeAgent();
    // state.messages holds the kickoff turn (delivered via agent.prompt) plus a
    // partial assistant message — exactly what we must not lose.
    agent.state.messages = [
      { type: "message", role: "user", content: "kickoff trigger" },
      { type: "message", role: "assistant", content: "partial..." },
    ] as unknown as AgentMessage[];

    const capture = attachSessionCapture(agent, {
      storage,
      sessionId: "s-abc1234567",
    });

    // Simulate the error path: NO turn_end fired; flush then detach.
    await capture.flushNow();
    capture.detach();
    // Caller flips status on the error path.
    await storage.updateAgentSessionStatus("s-abc1234567", "discarded", {
      completedAt: 2_000,
      error: "boom",
    });
    await settle(storage);

    const row = storage.getAgentSession("s-abc1234567");
    assert.equal(row?.status, "discarded");
    assert.ok(row?.transcript_json, "transcript must be non-null after error flush");
    const parsed = JSON.parse(row!.transcript_json!);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].content, "kickoff trigger", "kickoff turn preserved");
  });
});

test("#1 flushNow never throws even when the write fails", async () => {
  const fakeStorage = {
    async saveAgentSessionTranscript() {
      throw new Error("disk full");
    },
  } as unknown as Storage;
  const agent = new FakeAgent();
  agent.state.messages = [
    { type: "message", role: "user", content: "x" },
  ] as unknown as AgentMessage[];

  const capture = attachSessionCapture(agent, {
    storage: fakeStorage,
    sessionId: "s-abc1234567",
  });
  // Must resolve (swallow), not reject — so it can't mask the original error.
  await capture.flushNow();
  capture.detach();
});

// ---------------------------------------------------------------------------
// Issue #15(a) — summarization capture path: insert-as-running → capture →
// terminal status, with snapshot + transcript both present.
//
// The summarization worker (src/summarization/worker-pool.ts) bypasses
// SessionManager: it inserts the agent_sessions row directly at status
// 'running' (with started_at), attaches the SAME attachSessionCapture, drives
// the agent, then flips status to completed/discarded. These tests reproduce
// that exact sequence against real Storage so a regression in the
// insert-as-running + capture + status-flip contract is caught.
// ---------------------------------------------------------------------------

test("#15 summarization capture: completed run has snapshot + transcript", async () => {
  await withStorage(async (storage) => {
    const sessionId = "s-sum1234567";
    const startedAt = 5_000;
    // Worker inserts directly as 'running' with started_at (see worker-pool.ts).
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "matrix:miku:room:!room",
      sessionType: "summarize",
      status: "running",
      modelId: "model-summarize-1",
      triggerEventId: "summarize:job-1",
      triggerBody: "Summarize the conversation shown above.",
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
    });

    const agent = new FakeAgent();
    agent.state.messages = [
      { type: "message", role: "user", content: "Summarize the conversation shown above." },
      { type: "message", role: "assistant", content: "<summary tool call>" },
    ] as unknown as AgentMessage[];
    const snapshot = [
      { type: "system", content: "you summarize", tier: "system", tokenEstimate: 3 },
    ] as unknown as ContextMessage[];

    const capture = attachSessionCapture(agent, {
      storage,
      sessionId,
      snapshot,
      tokenEstimate: 7,
    });
    try {
      await agent.fire("agent_end", { messages: agent.state.messages });
    } finally {
      capture.detach();
    }
    // Worker flips status on success.
    await storage.updateAgentSessionStatus(sessionId, "completed", { completedAt: 6_000 });
    await settle(storage);

    const row = storage.getAgentSession(sessionId);
    assert.equal(row?.status, "completed");
    assert.equal(row?.started_at, startedAt, "insert-as-running set started_at");
    assert.ok(row?.context_snapshot_json, "snapshot present");
    assert.equal(row?.token_estimate, 7);
    assert.ok(row?.transcript_json, "transcript present");
    assert.equal(JSON.parse(row!.transcript_json!).length, 2);
  });
});

test("#15 summarization capture: discarded run still flushes via error path", async () => {
  await withStorage(async (storage) => {
    const sessionId = "s-sum7654321";
    const startedAt = 8_000;
    await storage.insertAgentSession({
      id: sessionId,
      timelineKey: "matrix:miku:room:!room",
      sessionType: "summarize",
      status: "running",
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
    });

    const agent = new FakeAgent();
    // Run threw before any turn_end; state holds only the kickoff turn.
    agent.state.messages = [
      { type: "message", role: "user", content: "Summarize the conversation shown above." },
    ] as unknown as AgentMessage[];

    const capture = attachSessionCapture(agent, { storage, sessionId });
    // Mirror worker-pool.ts catch: flushNow() before detach.
    await capture.flushNow();
    capture.detach();
    await storage.updateAgentSessionStatus(sessionId, "discarded", {
      completedAt: 9_000,
      error: "agent prompt failed",
    });
    await settle(storage);

    const row = storage.getAgentSession(sessionId);
    assert.equal(row?.status, "discarded");
    assert.equal(row?.error, "agent prompt failed");
    assert.ok(row?.transcript_json, "kickoff turn flushed on error path");
    assert.equal(JSON.parse(row!.transcript_json!)[0].content, "Summarize the conversation shown above.");
  });
});
