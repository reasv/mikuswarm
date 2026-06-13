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
    // sessionMeta resolves the operative context-token ceiling from config
    // (spec CONTEXT-LIMIT-UNIFICATION §2.4); a fixed value in these fixtures.
    resolveSessionContextCeiling: () => 128_000,
  } as unknown as AgentSessionFactory;
}

const throwingFactory = {
  buildPreview: () => {
    throw new Error("buildPreview should not be called in this test");
  },
  // Exercised by the session list/detail routes via sessionMeta; fixed here.
  resolveSessionContextCeiling: () => 128_000,
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

test("GET /api/rooms includes timelines with sessions but no events (issue #6)", async () => {
  await withStorage(async (storage) => {
    const eventfulTk = TK;
    const orphanTk = "matrix:miku:room:!orphan:example.org";

    // A normal timeline with events + a session.
    await storage.appendTimelineEvent(userEvent("evt-1", "hello", 1_000));
    await storage.insertAgentSession(sessionInsert({ id: "s-aaa1111111" }));

    // A timeline whose events were pruned/deleted but whose session row persists.
    // It must still appear so its sessions stay reachable via drill-down, and its
    // last-activity must fall back to session activity for ordering.
    await storage.insertAgentSession(
      sessionInsert({
        id: "s-orphan11111",
        timelineKey: orphanTk,
        createdAt: 5_000,
        updatedAt: 5_000,
      }),
    );

    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/rooms`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { rooms: any[] };
      assert.equal(body.rooms.length, 2);

      const orphan = body.rooms.find((r) => r.timelineKey === orphanTk);
      assert.ok(orphan, "timeline with sessions but no events must appear");
      assert.equal(orphan.eventCount, 0);
      assert.equal(orphan.sessionCount, 1);
      // Falls back to session activity (max created_at/updated_at).
      assert.equal(orphan.lastActivityAt, 5_000);

      const eventful = body.rooms.find((r) => r.timelineKey === eventfulTk);
      assert.ok(eventful);
      assert.equal(eventful.eventCount, 1);
      assert.equal(eventful.lastActivityAt, 1_000);

      // Reverse-chron: orphan (5_000) before eventful (1_000).
      assert.equal(body.rooms[0].timelineKey, orphanTk);
      assert.equal(body.rooms[1].timelineKey, eventfulTk);
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

test("sessionMeta surfaces ACTUALS usage as a grouped object + echoes context/limit (issue #7)", async () => {
  await withStorage(async (storage) => {
    // A row whose usage columns are POPULATED (a request committed). The
    // null-vs-zero distinction is load-bearing (spec §4.2): a populated row has
    // a non-null `llm_requests`, so `usage` must be the grouped object — never null.
    await storage.insertAgentSession(sessionInsert());
    await storage.updateAgentSessionUsage("s-aaa1111111", {
      llmRequests: 3,
      inputTokens: 1_000,
      outputTokens: 250,
      cacheReadTokens: 800,
      cacheWriteTokens: 120,
      cost: 0.0123,
      contextTokens: 2_170,
    });

    // Pin the operative-ceiling wiring: the route reads it from
    // factory.resolveSessionContextCeiling(session_type), so the stub value must
    // surface verbatim as `maxContextTokens`.
    const factory = {
      buildPreview: () => {
        throw new Error("buildPreview should not be called in this test");
      },
      resolveSessionContextCeiling: (sessionType: string) => {
        assert.equal(sessionType, "default"); // resolved from the row's session_type
        return 8_000;
      },
    } as unknown as AgentSessionFactory;

    await withServer({ storage, factory }, async (base) => {
      // Both the list route and the detail route build the meta via sessionMeta;
      // assert the populated shape on both (cheap, and they are structurally
      // identical — the detail route just nests it under `session`).
      const list = (await (
        await fetch(`${base}/api/rooms/${encodeURIComponent(TK)}/sessions`)
      ).json()) as any;
      assert.equal(list.sessions.length, 1);
      const s = list.sessions[0];
      assert.deepEqual(s.usage, {
        input: 1_000,
        output: 250,
        cacheRead: 800,
        cacheWrite: 120,
        cost: 0.0123,
      });
      assert.equal(s.llmRequests, 3);
      assert.equal(s.contextTokens, 2_170);
      assert.equal(s.maxContextTokens, 8_000);

      const detail = (await (await fetch(`${base}/api/sessions/s-aaa1111111`)).json()) as any;
      assert.deepEqual(detail.session.usage, {
        input: 1_000,
        output: 250,
        cacheRead: 800,
        cacheWrite: 120,
        cost: 0.0123,
      });
      assert.equal(detail.session.llmRequests, 3);
      assert.equal(detail.session.contextTokens, 2_170);
      assert.equal(detail.session.maxContextTokens, 8_000);
    });
  });
});

test("sessionMeta returns null usage/contextTokens for a LEGACY row (null-vs-zero, issue #7)", async () => {
  await withStorage(async (storage) => {
    // A legacy/pre-first-commit row: never had usage written, so `llm_requests`
    // is null. The branch `hasUsage = row.llm_requests !== null` must yield
    // `usage === null` and `contextTokens === null` — NOT an all-zero usage
    // object (the null-vs-zero distinction, spec §4.2).
    await storage.insertAgentSession(sessionInsert());

    await withServer({ storage }, async (base) => {
      const list = (await (
        await fetch(`${base}/api/rooms/${encodeURIComponent(TK)}/sessions`)
      ).json()) as any;
      const s = list.sessions[0];
      assert.equal(s.usage, null);
      assert.equal(s.contextTokens, null);
      assert.equal(s.llmRequests, null);
      // maxContextTokens is the operative ceiling resolved from CURRENT config —
      // independent of the row's (absent) usage. The default throwingFactory stub
      // returns a fixed 128000 (always-on now, never null; spec §4).
      assert.equal(s.maxContextTokens, 128_000);

      const detail = (await (await fetch(`${base}/api/sessions/s-aaa1111111`)).json()) as any;
      assert.equal(detail.session.usage, null);
      assert.equal(detail.session.contextTokens, null);
      assert.equal(detail.session.llmRequests, null);
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

test("GET /api/sessions/:id normalizes the persisted snapshot to the context wire shape", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert());
    // As persisted by session-capture: optional ContextMessage keys
    // (timestamp/tier/imageBlocks) are absent where undefined, and image blocks
    // were already externalized to refs at write time. The console decodes this
    // through the same strict ContextMessageWire schema as the room-context
    // preview, so absent fields must come back as explicit nulls and refs must
    // be exposed under `imageRefs`.
    await storage.saveAgentSessionSnapshot("s-aaa1111111", {
      snapshotJson: JSON.stringify([
        { type: "system", role: "system", content: "sys", tokenEstimate: 10 },
        {
          type: "chatEvent",
          role: "user",
          content: "pic",
          tier: "rich",
          tokenEstimate: 5,
          timestamp: 1_234,
          imageBlocks: [
            { __imageRef: true, eventId: "evt-1", attachmentId: "att-1", sizeBytes: 99 },
          ],
        },
      ]),
      dumpPath: null,
      tokenEstimate: 15,
    });

    await withServer({ storage }, async (base) => {
      const body = (await (await fetch(`${base}/api/sessions/s-aaa1111111`)).json()) as any;
      const [sys, chat] = body.contextSnapshot;
      // Absent optional fields become explicit nulls (present keys).
      assert.equal(sys.tier, null);
      assert.equal(sys.timestamp, null);
      assert.equal(sys.tokenEstimate, 10);
      assert.equal(sys.imageRefs, undefined);
      // Present fields pass through; refs move from imageBlocks → imageRefs.
      assert.equal(chat.tier, "rich");
      assert.equal(chat.timestamp, 1_234);
      assert.deepEqual(chat.imageRefs, [
        { __imageRef: true, eventId: "evt-1", attachmentId: "att-1", sizeBytes: 99 },
      ]);
      assert.equal(chat.imageBlocks, undefined);
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
function fakeAgent(opts: { live: boolean; messages?: any[] } = { live: true }): {
  agent: any;
  emit: (event: any) => void;
} {
  const listeners = new Set<(event: any) => void>();
  const agent = {
    get signal() {
      return opts.live ? new AbortController().signal : undefined;
    },
    // The accumulated canonical messages the rollout_seed snapshot reads.
    state: { messages: opts.messages ?? [] },
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

test("SSE: stream spans the whole run and closes on settlement, not agent_end", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    const { agent, emit } = fakeAgent({ live: true });
    const id = await attachRunningSession(storage, sessions, agent);

    await withServer({ storage, sessions }, async (base) => {
      const res = await fetch(`${base}/api/sessions/${id}/stream`);
      assert.equal(res.status, 200);
      // First agent-loop invocation (the kickoff) ends with an agent_end — which
      // must NOT close the stream. A run can drive several: here a forced
      // completion follows, injecting a user turn (emitted as message_start, as
      // pi-agent-core does) and producing a second assistant turn + agent_end.
      emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
      emit({ type: "agent_end", messages: [] });
      emit({ type: "message_start", message: { role: "user", content: "forced" } });
      emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
      emit({ type: "agent_end", messages: [] });
      // The run settles — THIS closes the stream (evict → onSettle).
      sessions.markCompleted(id);
      const text = await res.text();
      // Both turns and both agent_ends made it through one continuous stream.
      assert.equal((text.match(/event: agent_end/g) ?? []).length, 2);
      assert.equal((text.match(/event: turn_end/g) ?? []).length, 2);
      assert.match(text, /event: message_start/); // the injected forced-completion turn
      assert.doesNotMatch(text, /event: not_live/);
      // The seed must precede the live events on the wire.
      assert.ok(
        text.indexOf("event: rollout_seed") < text.indexOf("event: turn_end"),
        "rollout_seed must be sent before any live event",
      );
    });
  });
});

test("SSE: mid-run attach is seeded with the accumulated state messages", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    // Two head final-turn messages + one already-completed assistant turn: a
    // console attaching now must receive them in the seed (Agent.subscribe is
    // future-only) with rolloutStartIndex skipping the head final turn.
    const { agent } = fakeAgent({
      live: true,
      messages: [
        { type: "triggerGroup", role: "user", content: "trigger" },
        { role: "assistant", content: [{ type: "text", text: "earlier turn" }] },
      ],
    });
    const id = await attachRunningSession(storage, sessions, agent);

    await withServer({ storage, sessions }, async (base) => {
      const res = await fetch(`${base}/api/sessions/${id}/stream`);
      assert.equal(res.status, 200);
      // Settle the run to close the stream so the read completes (agent_end no
      // longer terminates it — the stream spans the whole run).
      sessions.markCompleted(id);
      const text = await res.text();
      assert.match(text, /event: rollout_seed/);
      const seedData = text
        .split("\n")
        .find((l) => l.startsWith("data: ") && l.includes("rollout_seed"));
      assert.ok(seedData, "seed record must carry data");
      const seed = JSON.parse(seedData.slice("data: ".length));
      assert.equal(seed.sessionId, id);
      assert.equal(seed.rolloutStartIndex, 1); // skips the head triggerGroup turn
      assert.equal(seed.messages.length, 2);
      assert.equal(seed.messages[1].content[0].text, "earlier turn");
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

/**
 * A live `Agent` stand-in for the abort endpoint: `signal` is defined (an active
 * run) and `abort()` flips it, recording the call. Mirrors how pi-agent-core's
 * `Agent.abort()` aborts the active run's controller.
 */
function fakeAbortableAgent(): { agent: any; aborted: () => boolean } {
  const controller = new AbortController();
  let didAbort = false;
  const agent = {
    get signal() {
      return controller.signal;
    },
    abort() {
      didAbort = true;
      controller.abort();
    },
    hasQueuedMessages: () => false,
    clearAllQueues() {},
    subscribe() {
      return () => {};
    },
  };
  return { agent, aborted: () => didAbort };
}

test("POST /api/sessions/:id/abort interrupts a live run (200) and aborts the agent", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    const { agent, aborted } = fakeAbortableAgent();
    const id = await attachRunningSession(storage, sessions, agent);
    // interrupt() gates on the explicit run-in-progress flag the runner sets for
    // the duration of run() — model that here so the session is interruptible.
    sessions.runLifecycle(id).markRunInProgress();

    await withServer({ storage, sessions }, async (base) => {
      const res = await fetch(`${base}/api/sessions/${id}/abort`, {
        method: "POST",
        headers: { "x-console-request": "1" },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.sessionId, id);
      assert.equal(body.status, "interrupted");
      assert.ok(aborted(), "agent.abort() must have been called");
      assert.equal(sessions.get(id)?.status, "interrupted");
    });
  });
});

test("POST /api/sessions/:id/abort requires the x-console-request CSRF header (403 without, 200 with)", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    const { agent, aborted } = fakeAbortableAgent();
    const id = await attachRunningSession(storage, sessions, agent);
    sessions.runLifecycle(id).markRunInProgress();

    await withServer({ storage, sessions }, async (base) => {
      // A live, interruptible, fully-authorized session — the only thing missing is
      // the console-request marker, so a 403 here is unambiguously the CSRF guard
      // (not 401/404/409). On the pre-fix server this POST would have aborted the run.
      const missing = await fetch(`${base}/api/sessions/${id}/abort`, { method: "POST" });
      assert.equal(missing.status, 403);
      assert.equal(aborted(), false, "abort must NOT run when the CSRF header is absent");
      assert.equal(sessions.get(id)?.status, "running");
      const body = (await missing.json()) as any;
      // Same error envelope as every other error response.
      assert.equal(body.error.status, 403);
      assert.equal(typeof body.error.message, "string");

      // With the header the request passes the guard and interrupts the run.
      const ok = await fetch(`${base}/api/sessions/${id}/abort`, {
        method: "POST",
        headers: { "x-console-request": "1" },
      });
      assert.equal(ok.status, 200);
      assert.ok(aborted(), "agent.abort() must run once the CSRF header is present");
      assert.equal(sessions.get(id)?.status, "interrupted");
    });
  });
});

test("POST /api/sessions/:id/abort returns 409 (standard error envelope) with the session status when not running", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert({ status: "completed" }));
    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/sessions/s-aaa1111111/abort`, {
        method: "POST",
        headers: { "x-console-request": "1" },
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as any;
      // Standard error envelope `{ error: { status, message, ...details } }` — the
      // session-specific fields live INSIDE `error`, never as top-level siblings, and
      // the session status is `sessionStatus` (distinct from the HTTP `error.status`).
      assert.equal(body.error.status, 409);
      assert.equal(typeof body.error.message, "string");
      assert.equal(body.error.sessionId, "s-aaa1111111");
      assert.equal(body.error.sessionStatus, "completed");
      // No legacy top-level siblings: the old mixed shape is gone.
      assert.ok(!("sessionId" in body), "sessionId must live inside the error envelope");
      assert.ok(!("status" in body), "no top-level status colliding with error.status");
      // The BFF surfaces the raw 409 body text as the operator-facing message, so the
      // human-readable message must convey the session status on its own.
      assert.match(body.error.message, /completed/);
    });
  });
});

test("POST /api/sessions/:id/abort is idempotent: live run → 200, second abort → 409 with interrupted status", async () => {
  await withStorage(async (storage) => {
    const sessions = new SessionManager();
    const { agent, aborted } = fakeAbortableAgent();
    const id = await attachRunningSession(storage, sessions, agent);
    // Model a live, interruptible run (the runner sets this for the whole run()).
    sessions.runLifecycle(id).markRunInProgress();

    await withServer({ storage, sessions }, async (base) => {
      // First abort hits a live run → 200, status flips to interrupted.
      const first = await fetch(`${base}/api/sessions/${id}/abort`, {
        method: "POST",
        headers: { "x-console-request": "1" },
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as any;
      assert.equal(firstBody.sessionId, id);
      assert.equal(firstBody.status, "interrupted");
      assert.ok(aborted(), "agent.abort() must have run on the first abort");
      assert.equal(sessions.get(id)?.status, "interrupted");

      // Second abort on the now-interrupted (no longer running) session → 409,
      // carrying the session's current status in the standard envelope.
      const second = await fetch(`${base}/api/sessions/${id}/abort`, {
        method: "POST",
        headers: { "x-console-request": "1" },
      });
      assert.equal(second.status, 409);
      const secondBody = (await second.json()) as any;
      assert.equal(secondBody.error.status, 409);
      assert.equal(secondBody.error.sessionId, id);
      assert.equal(secondBody.error.sessionStatus, "interrupted");
      assert.match(secondBody.error.message, /interrupted/);
    });
  });
});

test("POST /api/sessions/:id/abort returns 404 for an unknown session", async () => {
  await withStorage(async (storage) => {
    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/sessions/s-nope/abort`, {
        method: "POST",
        headers: { "x-console-request": "1" },
      });
      assert.equal(res.status, 404);
    });
  });
});

test("abort route: GET is 405 (method not allowed); POST is 401 without token", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession(sessionInsert({ status: "completed" }));
    // GET on a POST-only path → 405 (path exists under another method).
    await withServer({ storage }, async (base) => {
      const wrongMethod = await fetch(`${base}/api/sessions/s-aaa1111111/abort`);
      assert.equal(wrongMethod.status, 405);
    });
    // Bearer-token gate covers the mutation like every other route.
    await withServer(
      { storage, config: { enabled: true, bind: "127.0.0.1", port: 0, auth_token: "sekret-token" } },
      async (base) => {
        const unauth = await fetch(`${base}/api/sessions/s-aaa1111111/abort`, { method: "POST" });
        assert.equal(unauth.status, 401);
      },
    );
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
