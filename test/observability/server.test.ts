import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../../src/storage/index.js";
import type { AgentSessionInsert } from "../../src/storage/index.js";
import { SessionManager } from "../../src/agent/index.js";
import type { AgentSessionFactory } from "../../src/agent/factory.js";
import type { PreviewContext } from "../../src/agent/factory.js";
import type { CanonicalChatEvent } from "../../src/types.js";
import type { Logger } from "../../src/observability/index.js";
import {
  createObservabilityServer,
  type ConsoleServer,
  type ConsoleServerDeps,
} from "../../src/observability/server/index.js";
import { registerSecret, resetRedactionRegistry } from "../../src/config/index.js";
import { CACHE_BOUNDARIES } from "../../src/context/index.js";

const TK = "matrix:miku:room:!room:example.org";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function userEvent(id: string, body: string, timestamp: number): CanonicalChatEvent {
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body,
    timestamp,
    receivedAt: timestamp,
  };
}

function sessionInsert(overrides: Partial<AgentSessionInsert> = {}): AgentSessionInsert {
  const now = 1_000;
  return {
    id: "s-aaa1111111",
    timelineKey: TK,
    sessionType: "default",
    status: "completed",
    modelId: "anthropic/claude",
    triggerEventId: "evt-1",
    triggerExternalId: "$srv-1",
    triggerBody: "hi",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A factory stub: only `buildPreview` is exercised by the room-context route. */
function stubFactory(preview: PreviewContext): AgentSessionFactory {
  return {
    buildPreview: async () => preview,
  } as unknown as AgentSessionFactory;
}

const throwingFactory = {
  buildPreview: () => {
    throw new Error("buildPreview should not be called in this test");
  },
} as unknown as AgentSessionFactory;

async function withServer(
  deps: Partial<ConsoleServerDeps> & { storage: Storage },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const full: ConsoleServerDeps = {
    config: { enabled: true, bind: "127.0.0.1", port: 0, ...deps.config },
    storage: deps.storage,
    factory: deps.factory ?? throwingFactory,
    sessions: deps.sessions ?? new SessionManager(),
    workspaceRoot: deps.workspaceRoot ?? "/tmp",
    logger: deps.logger ?? silentLogger,
  };
  const server: ConsoleServer = createObservabilityServer(full);
  await server.start();
  try {
    await fn(`http://127.0.0.1:${server.address()}`);
  } finally {
    await server.stop();
  }
}

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

test("GET /api/rooms returns aggregated room rows", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1", "hello", 1_000));
    await storage.appendTimelineEvent(userEvent("evt-2", "world", 2_000));
    await storage.insertAgentSession(sessionInsert());

    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/rooms`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rooms: any[] };
      assert.equal(body.rooms.length, 1);
      const room = body.rooms[0];
      assert.equal(room.timelineKey, TK);
      assert.equal(room.eventCount, 2);
      assert.equal(room.sessionCount, 1);
      assert.equal(room.lastActivityAt, 2_000);
      assert.equal(room.timelineState, "inactive");
    });
  });
});

test("GET /api/rooms/:key/sessions lists sessions for the timeline", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert({ id: "s-aaa1111111" }));
    await storage.insertAgentSession(
      sessionInsert({ id: "s-bbb2222222", createdAt: 2_000, updatedAt: 2_000 }),
    );

    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/rooms/${encodeURIComponent(TK)}/sessions`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { sessions: any[] };
      assert.equal(body.sessions.length, 2);
      // Reverse-chron by created_at.
      assert.equal(body.sessions[0].id, "s-bbb2222222");
      assert.equal(body.sessions[1].id, "s-aaa1111111");
      assert.equal(body.sessions[0].noReply, false);
    });
  });
});

test("GET /api/sessions/:id returns snapshot + transcript; 404 for unknown", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert());
    await storage.saveAgentSessionSnapshot("s-aaa1111111", {
      snapshotJson: JSON.stringify([{ type: "system", role: "system", content: "sys" }]),
      dumpPath: null,
      tokenEstimate: 42,
    });
    await storage.saveAgentSessionTranscript(
      "s-aaa1111111",
      JSON.stringify([{ type: "triggerGroup", content: "hi" }]),
    );

    await withServer({ storage }, async (base) => {
      const ok = await fetch(`${base}/api/sessions/s-aaa1111111`);
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as any;
      assert.equal(body.session.id, "s-aaa1111111");
      assert.equal(body.session.tokenEstimate, 42);
      assert.equal(body.contextSnapshot.length, 1);
      assert.equal(body.transcript[0].content, "hi");

      const missing = await fetch(`${base}/api/sessions/s-nope`);
      assert.equal(missing.status, 404);
    });
  });
});

test("GET /api/sessions/:id marks rolloutStartIndex past the head final turn (issue #4)", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert());
    await storage.saveAgentSessionSnapshot("s-aaa1111111", {
      snapshotJson: JSON.stringify([{ type: "system", role: "system", content: "sys" }]),
      dumpPath: "/var/dumps/s-aaa1111111.json",
      tokenEstimate: 42,
    });
    // Transcript: head final user turn (triggerGroup), then the rollout begins at
    // the first assistant turn. A later user-role interjection must NOT shift the
    // boundary — only the leading run of final-turn messages is the input view.
    await storage.saveAgentSessionTranscript(
      "s-aaa1111111",
      JSON.stringify([
        { type: "triggerGroup", role: "user", content: "hi" },
        { type: "chatEvent", role: "assistant", content: "hello back" },
        { role: "user", content: "an interjection mid-rollout" },
        { type: "chatEvent", role: "assistant", content: "more" },
      ]),
    );

    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/sessions/s-aaa1111111`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      // Rollout begins at index 1 (the first assistant turn), not at the later
      // user-role interjection.
      assert.equal(body.rolloutStartIndex, 1);
      // context_dump_path is surfaced on the detail shape only (issue #9).
      assert.equal(body.contextDumpPath, "/var/dumps/s-aaa1111111.json");
    });
  });
});

test("GET /api/sessions/:id rolloutStartIndex edge cases (empty / all-final-turn)", async () => {
  await withStorage(async (storage) => {
    // Empty transcript → rolloutStartIndex 0.
    await storage.insertAgentSession(sessionInsert({ id: "s-empty111111" }));
    // All-final-turn transcript (two satellite/trigger heads, no rollout yet) →
    // rolloutStartIndex equals the transcript length.
    await storage.insertAgentSession(sessionInsert({ id: "s-allhead1111" }));
    await storage.saveAgentSessionTranscript(
      "s-allhead1111",
      JSON.stringify([
        { type: "satellite", role: "user", content: "sat" },
        { type: "triggerGroup", role: "user", content: "trig" },
      ]),
    );

    await withServer({ storage }, async (base) => {
      const empty = (await (await fetch(`${base}/api/sessions/s-empty111111`)).json()) as any;
      assert.equal(empty.rolloutStartIndex, 0);
      // No dump persisted → null, not undefined/missing.
      assert.equal(empty.contextDumpPath, null);

      const allHead = (await (await fetch(`${base}/api/sessions/s-allhead1111`)).json()) as any;
      assert.equal(allHead.rolloutStartIndex, 2);
    });
  });
});

test("GET /api/rooms/:key/sessions list shape omits contextDumpPath (issue #9)", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert());
    await storage.saveAgentSessionSnapshot("s-aaa1111111", {
      snapshotJson: "[]",
      dumpPath: "/var/dumps/s-aaa1111111.json",
      tokenEstimate: 1,
    });
    await withServer({ storage }, async (base) => {
      const body = (await (
        await fetch(`${base}/api/rooms/${encodeURIComponent(TK)}/sessions`)
      ).json()) as any;
      assert.equal(body.sessions.length, 1);
      assert.ok(!("contextDumpPath" in body.sessions[0]), "list shape must not leak dump path");
    });
  });
});

test("auth: 401 without token, 200 with bearer header or query token", async () => {
  await withStorage(async (storage) => {
    await withServer({ storage, config: { enabled: true, bind: "127.0.0.1", port: 0, auth_token: "sekret-token" } }, async (base) => {
      const unauth = await fetch(`${base}/api/rooms`);
      assert.equal(unauth.status, 401);

      const wrong = await fetch(`${base}/api/rooms`, {
        headers: { authorization: "Bearer nope" },
      });
      assert.equal(wrong.status, 401);

      const header = await fetch(`${base}/api/rooms`, {
        headers: { authorization: "Bearer sekret-token" },
      });
      assert.equal(header.status, 200);

      const query = await fetch(`${base}/api/rooms?token=sekret-token`);
      assert.equal(query.status, 200);
    });
  });
});

test("auth: allowed when no token configured", async () => {
  await withStorage(async (storage) => {
    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/rooms`);
      assert.equal(res.status, 200);
    });
  });
});

test("redaction: registered secrets are scrubbed from responses", async () => {
  await withStorage(async (storage) => {
    const secret = "zzz-very-secret-payload-9001";
    registerSecret(secret);
    try {
      await storage.insertAgentSession(sessionInsert());
      await storage.saveAgentSessionTranscript(
        "s-aaa1111111",
        JSON.stringify([{ type: "chatEvent", content: `token is ${secret}` }]),
      );
      await withServer({ storage }, async (base) => {
        const res = await fetch(`${base}/api/sessions/s-aaa1111111`);
        const text = await res.text();
        assert.ok(!text.includes(secret), "secret must not appear in response");
        assert.ok(text.includes("[REDACTED]"), "secret must be redacted");
      });
    } finally {
      resetRedactionRegistry();
    }
  });
});

test("GET /api/media/:ref streams bytes; traversal rejected; missing 404", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "miku-media-"));
  try {
    await writeFile(path.join(workspaceRoot, "img.bin"), Buffer.from([1, 2, 3, 4]));
    await withStorage(async (storage) => {
      await storage.appendTimelineEvent(userEvent("evt-1", "hi", 1_000));
      await storage.insertMediaAsset({
        id: "evt-1:attach:0",
        event_id: "evt-1",
        role: "attachment",
        media_type: "image",
        mime_type: "image/png",
        local_path: "img.bin",
        caption_status: "complete",
        download_status: "complete",
        created_at: 1_000,
      });
      await storage.insertMediaAsset({
        id: "evt-1:attach:evil",
        event_id: "evt-1",
        role: "attachment",
        media_type: "image",
        local_path: "../escape.bin",
        caption_status: "complete",
        download_status: "complete",
        created_at: 1_000,
      });

      await withServer({ storage, workspaceRoot }, async (base) => {
        const ok = await fetch(`${base}/api/media/${encodeURIComponent("evt-1:attach:0")}`);
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get("content-type"), "image/png");
        const bytes = Buffer.from(await ok.arrayBuffer());
        assert.deepEqual([...bytes], [1, 2, 3, 4]);

        const evil = await fetch(`${base}/api/media/${encodeURIComponent("evt-1:attach:evil")}`);
        assert.equal(evil.status, 403);

        const missing = await fetch(`${base}/api/media/${encodeURIComponent("nope")}`);
        assert.equal(missing.status, 404);
      });
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("SSE: terminal session yields a not_live event and event-stream headers", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert({ status: "completed" }));
    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/sessions/s-aaa1111111/stream`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = await res.text();
      assert.match(text, /event: not_live/);
    });
  });
});

/**
 * A minimal `Agent` stand-in for the SSE stream. `signal` models pi-agent-core's
 * `agent.signal` — defined while a run is active, `undefined` once it settles
 * (which happens before SessionManager evicts the agent). `subscribe` only
 * delivers FUTURE events, matching the real contract the late-subscribe race
 * relies on.
 */
function fakeAgent(opts: { live: boolean } = { live: true }): {
  agent: any;
  emit: (event: any) => void;
} {
  const listeners = new Set<(event: any) => void>();
  const agent = {
    get signal() {
      return opts.live ? new AbortController().signal : undefined;
    },
    subscribe(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    agent,
    emit: (event) => {
      for (const l of listeners) l(event);
    },
  };
}

/** Register a `running` session in both storage and an in-memory manager. */
async function attachRunningSession(
  storage: Storage,
  sessions: SessionManager,
  agent: any,
): Promise<string> {
  const record = sessions.createPlaceholder({
    provider: "matrix",
    timelineKey: TK,
    event: userEvent("evt-1", "hi", 1_000),
  });
  sessions.markRunning(record.id);
  sessions.attachAgent(record.id, agent);
  await storage.insertAgentSession(sessionInsert({ id: record.id, status: "running" }));
  return record.id;
}

test("SSE: late subscribe after run already settled self-closes with not_live", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    // Agent is still in the map (not yet evicted) but its run has already
    // settled — `signal` is undefined. The old code subscribed and waited
    // forever for an `agent_end` that will never replay; the stream must now
    // self-close immediately after the post-subscribe liveness re-check.
    const { agent } = fakeAgent({ live: false });
    const id = await attachRunningSession(storage, sessions, agent);

    await withServer({ storage, sessions }, async (base) => {
      const res = await fetch(`${base}/api/sessions/${id}/stream`);
      assert.equal(res.status, 200);
      // The body completes (stream closed) and carries a not_live terminal event.
      const text = await res.text();
      assert.match(text, /event: not_live/);
    });
  });
});

test("SSE: live session streams events and closes on agent_end", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    const { agent, emit } = fakeAgent({ live: true });
    const id = await attachRunningSession(storage, sessions, agent);

    await withServer({ storage, sessions }, async (base) => {
      const res = await fetch(`${base}/api/sessions/${id}/stream`);
      assert.equal(res.status, 200);
      // Drive a terminal event so the read below completes.
      emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
      emit({ type: "agent_end", messages: [] });
      const text = await res.text();
      assert.match(text, /event: turn_end/);
      assert.match(text, /event: agent_end/);
      assert.doesNotMatch(text, /event: not_live/);
    });
  });
});

test("SSE: unknown session id is 404", async () => {
  await withStorage(async (storage) => {
    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/sessions/s-nope/stream`);
      assert.equal(res.status, 404);
    });
  });
});

test("GET /api/rooms/:key/context flags the final turn preview and externalizes images", async () => {
  await withStorage(async (storage) => {
    const preview: PreviewContext = {
      syntheticTriggerEventId: "evt-1",
      finalTurnIndex: 1,
      cacheBoundaries: [...CACHE_BOUNDARIES],
      built: {
        tokenEstimate: 100,
        compactTokens: 10,
        richTokens: 20,
        imageBlocks: [],
        messages: [
          {
            type: "system",
            role: "system",
            content: "system prompt",
            tier: "system",
            tokenEstimate: 5,
          },
          {
            type: "triggerGroup",
            role: "user",
            content: "<system>sat</system>\n\nhello",
            tier: "trigger",
            tokenEstimate: 7,
            imageBlocks: [
              {
                eventId: "evt-1",
                attachmentId: "evt-1:attach:0",
                mediaType: "image/png",
                dataBase64: Buffer.from([9, 9, 9]).toString("base64"),
              },
            ],
          },
        ],
      },
    };

    await withServer({ storage, factory: stubFactory(preview) }, async (base) => {
      const res = await fetch(`${base}/api/rooms/${encodeURIComponent(TK)}/context`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("dataBase64"), "no base64 over the wire");

      const body = (await JSON.parse(text)) as any;
      assert.equal(body.preview, true);
      assert.equal(body.syntheticTriggerEventId, "evt-1");
      assert.equal(body.tokenEstimate, 100);
      // Cache boundaries are surfaced from the single shared const (issue #1).
      assert.deepEqual(body.cacheBoundaries, [...CACHE_BOUNDARIES]);
      // System block is not preview; final turn is.
      assert.equal(body.messages[0].preview, false);
      assert.equal(body.messages[1].preview, true);
      const ref = body.messages[1].imageRefs[0];
      assert.equal(ref.__imageRef, true);
      assert.equal(ref.attachmentId, "evt-1:attach:0");
      assert.equal(ref.mimeType, "image/png");
    });
  });
});
