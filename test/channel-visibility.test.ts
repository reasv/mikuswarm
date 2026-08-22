/**
 * Tests for the channel-visibility feature (ARCHITECTURE.md §9h).
 *
 * Covers:
 *  - ChannelVisibilityResolver: precedence, thread inheritance, malformed-key
 *    fallback, hasIsolation, sameChannel
 *  - applyVisibilityToRooms: no-isolation fast path, explicit-list filtering +
 *    note, all-rooms materialization, non-explicit silent filtering
 *  - expand_summary isolation check: isolated vs shared summary, thread-key viewer
 *  - Diary gate: excluded status for no_diary + isolated; shared unaffected
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChannelVisibilityResolver, type VisibilityConfig } from "../src/visibility/index.js";
import { applyVisibilityToRooms } from "../src/search/index.js";
import { Storage } from "../src/storage/index.js";
import { createExpandSummaryTool } from "../src/tools/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const ROOM_TK   = "matrix:default:room:!r:s";
const ROOM_TK2  = "matrix:default:room:!r2:s";
const DM_TK     = "matrix:default:dm:@alice:s";
const THREAD_TK = "matrix:default:room:!r:s:thread:$t1";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeResolver(cfg: VisibilityConfig | undefined): ChannelVisibilityResolver {
  return new ChannelVisibilityResolver(cfg);
}

function makeEvent(id: string, timelineKey: string, ts: number, role: "user" | "assistant" = "user"): CanonicalChatEvent {
  return {
    id, timelineKey, provider: "matrix", role,
    sender: { id: role === "assistant" ? "@bot:s" : "@u:s", displayName: "X", isSelf: role === "assistant" },
    body: `message ${id}`, timestamp: ts, receivedAt: ts,
  };
}

let seq = 0;
async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-vis-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Insert a level-1 summary with the given events in the given timeline.
 * Events are appended first (required by insertSummaryWithLineage invariant).
 */
async function insertL1Summary(
  storage: Storage,
  opts: { id: string; timelineKey: string; events: CanonicalChatEvent[] },
): Promise<void> {
  const tl = new TimelineStore(storage);
  for (const e of opts.events) await tl.append(e);
  const jobId = `j-${opts.id}-${seq++}`;
  const latest = Math.max(...opts.events.map((e) => e.timestamp));
  await storage.insertSummarizationJob({
    id: jobId, timelineKey: opts.timelineKey, level: 1,
    inputStartId: opts.events[0]!.id, inputEndId: opts.events[opts.events.length - 1]!.id,
    inputTokenCount: 10, targetTokenCount: 100, maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id: opts.id, timelineKey: opts.timelineKey, level: 1,
    content: `summary ${opts.id}`,
    earliestTimestamp: opts.events[0]!.timestamp,
    latestTimestamp: latest,
    latestEventId: opts.events[opts.events.length - 1]!.id,
    eventCount: opts.events.length,
    tokenCount: 10, modelId: "m", status: "complete", generatedAt: latest,
    eventIds: opts.events.map((e) => e.id), jobId,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 1. ChannelVisibilityResolver — mode precedence
// ────────────────────────────────────────────────────────────────────────────

test("resolver: undefined config — all keys resolve to 'shared'", () => {
  const r = makeResolver(undefined);
  assert.equal(r.modeFor(ROOM_TK), "shared");
  assert.equal(r.modeFor(DM_TK), "shared");
  assert.equal(r.hasIsolation(), false);
});

test("resolver: exact entry for dm overrides dms blanket", () => {
  const r = makeResolver({
    dms: "no_diary",
    channels: [{ timeline_key: DM_TK, mode: "isolated" }],
  });
  // Exact entry (isolated) beats dms blanket (no_diary)
  assert.equal(r.modeFor(DM_TK), "isolated");
});

test("resolver: dms blanket applies to unmatched dm-kind keys", () => {
  const r = makeResolver({ dms: "no_diary" });
  assert.equal(r.modeFor(DM_TK), "no_diary");
  // Rooms are unaffected by dms blanket
  assert.equal(r.modeFor(ROOM_TK), "shared");
});

test("resolver: exact room entry overrides 'shared' default", () => {
  const r = makeResolver({
    channels: [{ timeline_key: ROOM_TK, mode: "isolated" }],
  });
  assert.equal(r.modeFor(ROOM_TK), "isolated");
  assert.equal(r.modeFor(ROOM_TK2), "shared");
});

test("resolver: thread key inherits parent room mode", () => {
  const r = makeResolver({
    channels: [{ timeline_key: ROOM_TK, mode: "no_diary" }],
  });
  assert.equal(r.modeFor(THREAD_TK), "no_diary");
});

test("resolver: thread key resolves to 'shared' when parent has no entry", () => {
  const r = makeResolver({
    channels: [{ timeline_key: ROOM_TK2, mode: "isolated" }],
  });
  // THREAD_TK is a thread of ROOM_TK (not ROOM_TK2) → default shared
  assert.equal(r.modeFor(THREAD_TK), "shared");
});

test("resolver: malformed key returns 'shared' gracefully", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK, mode: "isolated" }] });
  assert.equal(r.modeFor("not-a-valid-key"), "shared");
  assert.equal(r.modeFor(""), "shared");
});

test("resolver: hasIsolation() true when any exact entry is isolated", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK, mode: "isolated" }] });
  assert.equal(r.hasIsolation(), true);
});

test("resolver: hasIsolation() true when dms blanket is isolated", () => {
  const r = makeResolver({ dms: "isolated" });
  assert.equal(r.hasIsolation(), true);
});

test("resolver: hasIsolation() false when only no_diary configured (no isolation)", () => {
  const r = makeResolver({
    dms: "no_diary",
    channels: [{ timeline_key: ROOM_TK, mode: "no_diary" }],
  });
  assert.equal(r.hasIsolation(), false);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. sameChannel
// ────────────────────────────────────────────────────────────────────────────

test("sameChannel: identical keys match", () => {
  const r = makeResolver(undefined);
  assert.equal(r.sameChannel(ROOM_TK, ROOM_TK), true);
});

test("sameChannel: thread key matches its parent room", () => {
  const r = makeResolver(undefined);
  assert.equal(r.sameChannel(THREAD_TK, ROOM_TK), true);
  assert.equal(r.sameChannel(ROOM_TK, THREAD_TK), true);
});

test("sameChannel: different rooms do not match", () => {
  const r = makeResolver(undefined);
  assert.equal(r.sameChannel(ROOM_TK, ROOM_TK2), false);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. applyVisibilityToRooms
// ────────────────────────────────────────────────────────────────────────────

const NOOP_STORAGE = { getDistinctTimelineKeys: (): string[] => [] };

test("applyVisibilityToRooms: no-isolation fast path — undefined preserved", () => {
  // no_diary only, hasIsolation() === false
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK, mode: "no_diary" }] });
  const { keys, note } = applyVisibilityToRooms(undefined, ROOM_TK, r, NOOP_STORAGE, false);
  assert.equal(keys, undefined); // legacy no-filter path preserved
  assert.equal(note, "");
});

test("applyVisibilityToRooms: no-isolation fast path — explicit list unchanged", () => {
  const r = makeResolver(undefined); // no isolation
  const { keys, note } = applyVisibilityToRooms([ROOM_TK, ROOM_TK2], ROOM_TK, r, NOOP_STORAGE, true);
  assert.deepEqual(keys, [ROOM_TK, ROOM_TK2]);
  assert.equal(note, "");
});

test("applyVisibilityToRooms: drops isolated non-viewer key from explicit list with note", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK2, mode: "isolated" }] });
  const { keys, note } = applyVisibilityToRooms(
    [ROOM_TK, ROOM_TK2],
    ROOM_TK,    // viewer in ROOM_TK, not ROOM_TK2
    r, NOOP_STORAGE, true,
  );
  assert.deepEqual(keys, [ROOM_TK]);
  assert.match(note, /1 room\(s\) excluded by operator visibility config/);
});

test("applyVisibilityToRooms: keeps isolated key when viewer IS in that channel", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK, mode: "isolated" }] });
  const { keys, note } = applyVisibilityToRooms(
    [ROOM_TK, ROOM_TK2],
    ROOM_TK,    // viewer IS in ROOM_TK (the isolated one)
    r, NOOP_STORAGE, true,
  );
  // ROOM_TK: isolated but viewer is in it → passes; ROOM_TK2: shared → passes
  assert.deepEqual(keys, [ROOM_TK, ROOM_TK2]);
  assert.equal(note, "");
});

test("applyVisibilityToRooms: both isolated keys dropped when viewer is in neither", () => {
  const viewer = "matrix:default:room:!other:s";
  const r = makeResolver({
    channels: [
      { timeline_key: ROOM_TK, mode: "isolated" },
      { timeline_key: ROOM_TK2, mode: "isolated" },
    ],
  });
  const { keys, note } = applyVisibilityToRooms(
    [ROOM_TK, ROOM_TK2], viewer, r, NOOP_STORAGE, true,
  );
  assert.deepEqual(keys, []);
  assert.match(note, /2 room\(s\) excluded by operator visibility config/);
});

test("applyVisibilityToRooms: non-explicit list filters silently (no note)", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK2, mode: "isolated" }] });
  const { keys, note } = applyVisibilityToRooms(
    [ROOM_TK, ROOM_TK2],
    ROOM_TK,    // viewer not in ROOM_TK2
    r, NOOP_STORAGE,
    false,      // NOT an explicit list (agents-mode or rooms:"current")
  );
  assert.deepEqual(keys, [ROOM_TK]);
  assert.equal(note, ""); // no note for non-explicit filter
});

test("applyVisibilityToRooms: all-rooms path materializes and filters isolated channels", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK2, mode: "isolated" }] });
  const storage = { getDistinctTimelineKeys: () => [ROOM_TK, ROOM_TK2] };
  const { keys, note } = applyVisibilityToRooms(
    undefined,  // rooms:"all"
    ROOM_TK,    // viewer not in ROOM_TK2
    r, storage, false,
  );
  // ROOM_TK2 is isolated and viewer is not in it → dropped
  assert.deepEqual(keys, [ROOM_TK]);
  assert.equal(note, "");
});

test("applyVisibilityToRooms: all-rooms with viewer in isolated channel — it passes through", () => {
  const r = makeResolver({ channels: [{ timeline_key: ROOM_TK, mode: "isolated" }] });
  const storage = { getDistinctTimelineKeys: () => [ROOM_TK, ROOM_TK2] };
  const { keys, note } = applyVisibilityToRooms(
    undefined,
    ROOM_TK,    // viewer IS in the isolated channel
    r, storage, false,
  );
  // ROOM_TK: isolated, viewer is in it → passes; ROOM_TK2: shared → passes
  assert.deepEqual(keys, [ROOM_TK, ROOM_TK2]);
  assert.equal(note, "");
});

// ────────────────────────────────────────────────────────────────────────────
// 4. expand_summary isolation check
// ────────────────────────────────────────────────────────────────────────────

test("expand_summary: summary from isolated channel denied when viewer is in a different channel", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "s-iso-1",
      timelineKey: ROOM_TK2, // this channel will be marked isolated
      events: [makeEvent("e1", ROOM_TK2, 1_000), makeEvent("e2", ROOM_TK2, 2_000)],
    });

    const resolver = makeResolver({
      channels: [{ timeline_key: ROOM_TK2, mode: "isolated" }],
    });
    const tool = createExpandSummaryTool({
      storage,
      defaults: { tokenCap: 10_000, maxDepth: 3 },
      currentTimelineKey: ROOM_TK, // viewer in ROOM_TK, NOT ROOM_TK2
      visibilityResolver: resolver,
    });

    const result = await tool.execute("tc1", { id: "s-iso-1" }, {} as any);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /isolated channel/);
    assert.match(text, /cannot be expanded outside it/);
    assert.equal((result.details as { error: string }).error, "isolated");
  });
});

test("expand_summary: summary from isolated channel accessible when viewer IS in that channel", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "s-iso-2",
      timelineKey: ROOM_TK,
      events: [makeEvent("e3", ROOM_TK, 1_000), makeEvent("e4", ROOM_TK, 2_000)],
    });

    const resolver = makeResolver({
      channels: [{ timeline_key: ROOM_TK, mode: "isolated" }],
    });
    const tool = createExpandSummaryTool({
      storage,
      defaults: { tokenCap: 10_000, maxDepth: 3 },
      currentTimelineKey: ROOM_TK, // viewer IS in ROOM_TK
      visibilityResolver: resolver,
    });

    const result = await tool.execute("tc2", { id: "s-iso-2" }, {} as any);
    const text = (result.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /isolated channel/);
    assert.doesNotMatch(text, /error/);
  });
});

test("expand_summary: no visibilityResolver — backward compat, no isolation check", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "s-compat",
      timelineKey: ROOM_TK2,
      events: [makeEvent("e5", ROOM_TK2, 1_000)],
    });

    // No resolver, no currentTimelineKey — must not error on isolation
    const tool = createExpandSummaryTool({
      storage,
      defaults: { tokenCap: 10_000, maxDepth: 3 },
    });

    const result = await tool.execute("tc3", { id: "s-compat" }, {} as any);
    const text = (result.content[0] as { text: string }).text;
    assert.doesNotMatch(text, /isolated channel/);
  });
});

test("expand_summary: thread-key viewer matches isolated parent room (sameChannel)", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "s-thread",
      timelineKey: ROOM_TK,
      events: [makeEvent("e6", ROOM_TK, 1_000)],
    });

    const resolver = makeResolver({
      channels: [{ timeline_key: ROOM_TK, mode: "isolated" }],
    });
    const tool = createExpandSummaryTool({
      storage,
      defaults: { tokenCap: 10_000, maxDepth: 3 },
      currentTimelineKey: THREAD_TK, // viewer in a THREAD of ROOM_TK
      visibilityResolver: resolver,
    });

    const result = await tool.execute("tc4", { id: "s-thread" }, {} as any);
    const text = (result.content[0] as { text: string }).text;
    // Thread viewer matches parent room → NOT an isolation error
    assert.doesNotMatch(text, /isolated channel/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Diary gate — excluded status via Storage.setDiaryStatus
// ────────────────────────────────────────────────────────────────────────────

test("diary: setDiaryStatus('excluded') is terminal — row not reclaimable", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "d-exc",
      timelineKey: ROOM_TK,
      events: [makeEvent("ex1", ROOM_TK, 1_000), makeEvent("ex2", ROOM_TK, 2_000, "assistant")],
    });

    // Claim it
    const claimed = await storage.claimNextDiaryJob();
    assert.ok(claimed, "should have a claimable diary job");
    assert.equal(claimed.summaryId, "d-exc");

    // Mark as excluded (visibility gate)
    await storage.setDiaryStatus(claimed.summaryId, "excluded");

    // Should not be reclaimable (it's terminal)
    const next = await storage.claimNextDiaryJob();
    assert.equal(next, undefined, "excluded job must not be reclaimable");
  });
});

test("diary: getPipelineCounts reports excluded count for diary pool", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "d-count",
      timelineKey: ROOM_TK,
      events: [makeEvent("dc1", ROOM_TK, 1_000), makeEvent("dc2", ROOM_TK, 2_000, "assistant")],
    });

    const claimed = await storage.claimNextDiaryJob();
    assert.ok(claimed);
    await storage.setDiaryStatus(claimed.summaryId, "excluded");

    const counts = storage.getPipelineCounts("diary");
    assert.equal(counts.excluded, 1);
    assert.equal(counts.pending, 0);
    assert.equal(counts.done, 0);
  });
});

test("diary: excluded count is always 0 for non-diary pools", async () => {
  await withStorage(async (storage) => {
    const enrichment = storage.getPipelineCounts("enrichment");
    assert.equal(enrichment.excluded, 0);
    const summarization = storage.getPipelineCounts("summarization");
    assert.equal(summarization.excluded, 0);
    const captioning = storage.getPipelineCounts("captioning");
    assert.equal(captioning.excluded, 0);
  });
});

test("diary: excluded rows hidden from default listPipelineItems view", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "d-hide",
      timelineKey: ROOM_TK,
      events: [makeEvent("dh1", ROOM_TK, 1_000), makeEvent("dh2", ROOM_TK, 2_000, "assistant")],
    });

    const claimed = await storage.claimNextDiaryJob();
    assert.ok(claimed);
    await storage.setDiaryStatus(claimed.summaryId, "excluded");

    // Default view (no status filter) should hide excluded
    const result = storage.listPipelineItems("diary", { limit: 20, cursor: null, status: undefined }, 3);
    const found = result.items.filter((i: { status: string }) => i.status === "excluded");
    assert.equal(found.length, 0, "excluded items must not appear in default list view");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Additional imports needed for sections 6-10
// ────────────────────────────────────────────────────────────────────────────

import { writeFile } from "node:fs/promises";
import { validateVisibilityChannels } from "../src/visibility/index.js";
import { loadConfig } from "../src/config/index.js";
import { ChatSearchIndexer } from "../src/search/index.js";
import { DiaryWorkerPool } from "../src/diary/index.js";
import { MemoryFileWriter } from "../src/storage/index.js";
import {
  createSearchMessagesTool,
  createRecapTool,
  createUserActivityTool,
} from "../src/tools/index.js";
import type { Logger } from "../src/observability/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// ────────────────────────────────────────────────────────────────────────────
// 6. Config validation — validateVisibilityChannels (the startup entry point)
// ────────────────────────────────────────────────────────────────────────────

test("config validation: valid config passes without throwing", () => {
  assert.doesNotThrow(() =>
    validateVisibilityChannels({
      dms: "no_diary",
      channels: [
        { timeline_key: ROOM_TK, mode: "isolated" },
        { timeline_key: ROOM_TK2, mode: "shared" },
      ],
    }),
  );
});

test("config validation: undefined config passes (no-op)", () => {
  assert.doesNotThrow(() => validateVisibilityChannels(undefined));
});

test("config validation: malformed timeline_key throws", () => {
  assert.throws(
    () =>
      validateVisibilityChannels({
        channels: [{ timeline_key: "not-a-valid-key", mode: "isolated" }],
      }),
    /not a valid timeline_key/,
  );
});

test("config validation: thread-suffixed key throws (v1 does not support per-thread)", () => {
  assert.throws(
    () =>
      validateVisibilityChannels({
        channels: [{ timeline_key: THREAD_TK, mode: "no_diary" }],
      }),
    /:thread: suffix/,
  );
});

test("config validation: duplicate timeline_key throws", () => {
  assert.throws(
    () =>
      validateVisibilityChannels({
        channels: [
          { timeline_key: ROOM_TK, mode: "isolated" },
          { timeline_key: ROOM_TK, mode: "shared" },
        ],
      }),
    /duplicate entry/,
  );
});

// Enum validation is done by the TypeBox schema at config-parse time.
// We use loadConfig with a minimal TOML config to exercise that path.

const BASE_CONFIG = `
[app]
name = "mikuswarm"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "test-model"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[workspace]
root_dir = "./workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"

[summarization]
enabled = false
`;

async function withConfigDir(toml: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-vis-cfg-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config validation: bad mode enum rejected by schema", async () => {
  const toml = BASE_CONFIG + `
[visibility]
[[visibility.channels]]
timeline_key = "${ROOM_TK}"
mode = "super_secret"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /Invalid config/,
    );
  });
});

test("config validation: bad dms enum rejected by schema", async () => {
  const toml = BASE_CONFIG + `
[visibility]
dms = "invisible"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /Invalid config/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. DiaryWorkerPool — visibility gate driven through the pool
// ────────────────────────────────────────────────────────────────────────────

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

/** Fake factory that either completes a diary job (no-op finalize) or tracks
 *  whether `create` was ever invoked so we can assert it was NOT called. */
function makeTrackingFactory(ref: { created: boolean }): any {
  return {
    resolveModelId: () => "test-model",
    resolveSessionCostCeiling: () => 0.5,
    resolveSessionType: () => ({ session_instruction: "write entry. Begin: {{header}}" }),
    create: async (_session: unknown, tools: AgentTool[]) => {
      ref.created = true;
      const tool = tools[0]!;
      const state = { messages: [] as unknown[], errorMessage: undefined as string | undefined };
      return {
        agent: {
          prompt: async () => {
            // Use the diary_tool: view + finalize (the legitimate empty-draft path).
            await tool.execute("tc", { command: "view", finalize: true }, {} as any);
          },
          waitForIdle: async () => {},
          subscribe: () => () => {},
          state,
          abort: () => {},
        },
        finalTurn: { type: "satellite", content: "<system>diary</system>" },
        snapshot: undefined,
        tokenEstimate: undefined,
      };
    },
  };
}

async function withDiaryFixture(
  run: (ctx: { storage: Storage; workspaceRoot: string; memoryWriter: MemoryFileWriter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-vis-diary-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run({ storage, workspaceRoot: dir, memoryWriter: new MemoryFileWriter(dir) });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function diaryStatus(storage: Storage, id: string): string | null {
  return (storage.read((db) => db.prepare("select diary_status from summaries where id = ?").get(id)) as { diary_status: string | null }).diary_status;
}

test("diary pool: no_diary channel → job excluded, factory never called", async () => {
  await withDiaryFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertL1Summary(storage, {
      id: "dp-nodiary",
      timelineKey: ROOM_TK,
      events: [makeEvent("dpe1", ROOM_TK, 1_000), makeEvent("dpe2", ROOM_TK, 2_000, "assistant")],
    });

    const ref = { created: false };
    const resolver = makeResolver({ channels: [{ timeline_key: ROOM_TK, mode: "no_diary" }] });
    const pool = new DiaryWorkerPool({
      storage,
      factory: makeTrackingFactory(ref),
      memoryWriter,
      config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
      workspaceRoot,
      resolveChannelLabel: async () => "Test Room",
      visibilityResolver: resolver,
      logger: silentLogger,
    });

    pool.start();
    await waitFor(() => diaryStatus(storage, "dp-nodiary") === "excluded");
    await pool.stop();

    assert.equal(diaryStatus(storage, "dp-nodiary"), "excluded", "status is terminal 'excluded'");
    assert.equal(ref.created, false, "factory.create must NOT be called for no_diary channels");
  });
});

test("diary pool: isolated channel → job excluded, factory never called", async () => {
  await withDiaryFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertL1Summary(storage, {
      id: "dp-isolated",
      timelineKey: DM_TK,
      events: [makeEvent("dpi1", DM_TK, 1_000), makeEvent("dpi2", DM_TK, 2_000, "assistant")],
    });

    const ref = { created: false };
    const resolver = makeResolver({ dms: "isolated" });
    const pool = new DiaryWorkerPool({
      storage,
      factory: makeTrackingFactory(ref),
      memoryWriter,
      config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
      workspaceRoot,
      resolveChannelLabel: async () => "DM Room",
      visibilityResolver: resolver,
      logger: silentLogger,
    });

    pool.start();
    await waitFor(() => diaryStatus(storage, "dp-isolated") === "excluded");
    await pool.stop();

    assert.equal(diaryStatus(storage, "dp-isolated"), "excluded");
    assert.equal(ref.created, false, "factory.create must NOT be called for isolated channels");
  });
});

test("diary pool: shared channel → job proceeds normally (factory called)", async () => {
  await withDiaryFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertL1Summary(storage, {
      id: "dp-shared",
      timelineKey: ROOM_TK,
      events: [makeEvent("dps1", ROOM_TK, 1_000), makeEvent("dps2", ROOM_TK, 2_000, "assistant")],
    });

    const ref = { created: false };
    // no visibility restrictions — all shared
    const pool = new DiaryWorkerPool({
      storage,
      factory: makeTrackingFactory(ref),
      memoryWriter,
      config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
      workspaceRoot,
      resolveChannelLabel: async () => "Test Room",
      logger: silentLogger,
    });

    pool.start();
    await waitFor(() => {
      const s = diaryStatus(storage, "dp-shared");
      return s === "done" || s === "failed";
    });
    await pool.stop();

    // `done` when the empty-draft no-op finalize succeeds.
    assert.equal(diaryStatus(storage, "dp-shared"), "done", "shared channel proceeds");
    assert.equal(ref.created, true, "factory.create IS called for shared channels");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. Requeue — retryFailedPipelineItems leaves excluded rows untouched
// ────────────────────────────────────────────────────────────────────────────

test("requeue: retryFailedPipelineItems('diary') does not requeue excluded rows", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "rq-exc",
      timelineKey: ROOM_TK,
      events: [makeEvent("rq1", ROOM_TK, 1_000), makeEvent("rq2", ROOM_TK, 2_000, "assistant")],
    });
    // Also add a failed row to confirm requeue works on failed (and doesn't touch excluded).
    await insertL1Summary(storage, {
      id: "rq-fail",
      timelineKey: ROOM_TK2,
      events: [makeEvent("rq3", ROOM_TK2, 3_000), makeEvent("rq4", ROOM_TK2, 4_000, "assistant")],
    });

    // Claim both and set their statuses.
    const j1 = await storage.claimNextDiaryJob();
    assert.ok(j1);
    await storage.setDiaryStatus(j1.summaryId, "excluded");

    const j2 = await storage.claimNextDiaryJob();
    assert.ok(j2);
    await storage.setDiaryStatus(j2.summaryId, "failed");

    // Requeue failed rows.
    const count = await storage.retryFailedPipelineItems("diary");
    assert.equal(count, 1, "exactly 1 failed row requeued");

    // 'excluded' row must remain excluded.
    assert.equal(diaryStatus(storage, "rq-exc"), "excluded", "excluded stays excluded after requeue");
    // 'failed' row goes back to pending.
    assert.equal(diaryStatus(storage, "rq-fail"), "pending", "failed row is back to pending");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 9. Migration round-trip: v12 → v13
// ────────────────────────────────────────────────────────────────────────────

test("migration v12→v13: rowids, FTS, summary_events, summary_parents all preserved", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-vis-mig-"));
  const dbPath = path.join(dir, "test.db");
  try {
    // Phase 1: build a v12 database with data (fresh DB built at v13, stamped
    // back to v12 to simulate a DB that has master's absorbed_parent_id column
    // but not yet the widened diary_status CHECK constraint rebuild).
    let preRowid: number;
    let preEventCount: number;
    let preParentCount: number;
    {
      const storage = await Storage.open({ databasePath: dbPath });

      // Insert two summaries so we test the child-table round-trip.
      await insertL1Summary(storage, {
        id: "mig-parent",
        timelineKey: ROOM_TK,
        events: [makeEvent("me1", ROOM_TK, 1_000), makeEvent("me2", ROOM_TK, 2_000, "assistant")],
      });
      await insertL1Summary(storage, {
        id: "mig-child",
        timelineKey: ROOM_TK,
        events: [makeEvent("me3", ROOM_TK, 3_000), makeEvent("me4", ROOM_TK, 4_000)],
      });

      // Capture the rowid of "mig-parent" before migration.
      preRowid = storage.read((db) => {
        return (db.prepare("select rowid from summaries where id = 'mig-parent'").get() as { rowid: number }).rowid;
      });

      preEventCount = storage.read((db) => {
        return (db.prepare("select count(*) as n from summary_events").get() as { n: number }).n;
      });
      preParentCount = storage.read((db) => {
        return (db.prepare("select count(*) as n from summary_parents").get() as { n: number }).n;
      });

      // Downgrade to v12: the migration will rerun widenDiaryStatusConstraint.
      await storage.write((db) => {
        db.pragma("user_version = 12");
      });
      await storage.waitForIdle();
      storage.close();
    }

    // Phase 2: re-open — this runs the v12→v13 migration.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      try {
        // Version is now 14 (v13 channel-visibility + v14 input_child_ids).
        const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
        assert.equal(version, 14, "migration stamped version 14");

        // Rowid preserved across the table rebuild.
        const postRowid = storage.read((db) => {
          return (db.prepare("select rowid from summaries where id = 'mig-parent'").get() as { rowid: number }).rowid;
        });
        assert.equal(postRowid, preRowid, "summary rowid preserved across migration");

        // summary_events and summary_parents rows all restored.
        const postEventCount = storage.read((db) => {
          return (db.prepare("select count(*) as n from summary_events").get() as { n: number }).n;
        });
        assert.equal(postEventCount, preEventCount, "summary_events rows preserved");

        const postParentCount = storage.read((db) => {
          return (db.prepare("select count(*) as n from summary_parents").get() as { n: number }).n;
        });
        assert.equal(postParentCount, preParentCount, "summary_parents rows preserved");

        // FTS returns the expected content for the migrated summary.
        const ftsHit = storage.read((db) => {
          return db.prepare("select rowid from summaries_fts where summaries_fts match 'summary'").all() as { rowid: number }[];
        });
        assert.ok(ftsHit.length >= 2, "FTS still returns summaries after migration");

        // The widened CHECK constraint accepts 'excluded'.
        await storage.write((db) => {
          db.prepare("update summaries set diary_status = 'excluded' where id = 'mig-parent'").run();
        });
        await storage.waitForIdle();
        const status = diaryStatus(storage, "mig-parent");
        assert.equal(status, "excluded", "CHECK constraint accepts 'excluded' after migration");

        // The after-insert trigger still fires (FTS stays live for new inserts).
        // Check the FTS docsize count BEFORE and AFTER the new insert to verify
        // the summaries_ai trigger fires. We avoid using the FTS `match` query
        // directly because FTS5 interprets `-` in `match 'mig-new'` as a NOT
        // operator, which causes a SQLITE_ERROR (no such column).
        const ftsCountBefore = storage.read((db) => {
          return (db.prepare("select count(*) as n from summaries_fts_docsize").get() as { n: number }).n;
        });
        await insertL1Summary(storage, {
          id: "mig-new",
          timelineKey: ROOM_TK,
          events: [makeEvent("me5", ROOM_TK, 5_000)],
        });
        const ftsCountAfter = storage.read((db) => {
          return (db.prepare("select count(*) as n from summaries_fts_docsize").get() as { n: number }).n;
        });
        assert.equal(ftsCountAfter, ftsCountBefore + 1, "summaries_ai trigger fires after migration — FTS doccount increased");
      } finally {
        await storage.waitForIdle();
        storage.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 10. E2E tool tests — real DB + isolation config + visibility enforcement
// ────────────────────────────────────────────────────────────────────────────

const VIEWER_TK = ROOM_TK;   // "matrix:default:room:!r:s"
const ISOLATED_TK = DM_TK;   // "matrix:default:dm:@alice:s"
const OTHER_TK = ROOM_TK2;   // "matrix:default:room:!r2:s"

function makeE2eEvent(
  id: string,
  timelineKey: string,
  ts: number,
  body = `body ${id}`,
): CanonicalChatEvent {
  return {
    id, timelineKey, provider: "matrix", role: "user",
    sender: { id: "@u:s", displayName: "U", isSelf: false },
    body, timestamp: ts, receivedAt: ts,
  };
}

async function withE2eSetup(
  run: (ctx: { storage: Storage; indexer: ChatSearchIndexer }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-vis-e2e-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const tl = new TimelineStore(storage);
    // VIEWER_TK events
    await tl.append(makeE2eEvent("v1", VIEWER_TK, 1_000, "hello from viewer room"));
    await tl.append(makeE2eEvent("v2", VIEWER_TK, 2_000, "another viewer message"));
    // ISOLATED_TK events (will be configured as isolated in tests)
    await tl.append(makeE2eEvent("i1", ISOLATED_TK, 3_000, "secret dm message one"));
    await tl.append(makeE2eEvent("i2", ISOLATED_TK, 4_000, "secret dm message two"));
    // OTHER_TK events (shared room)
    await tl.append(makeE2eEvent("o1", OTHER_TK, 5_000, "public other room"));

    const indexer = new ChatSearchIndexer({ storage });
    await indexer.reconcileAll();
    await run({ storage, indexer });
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── search_messages ──

test("search_messages: explicit isolated room excluded — no leakage to outside viewer", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({ dms: "isolated" });
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: VIEWER_TK, visibilityResolver: resolver,
    });

    // Explicit request for the isolated DM: must return 0 hits + note.
    const res = await tool.execute("t1", { rooms: [ISOLATED_TK] }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // Short-circuit fires: no hits, note present.
    assert.match(text, /1 room\(s\) excluded by operator visibility config/);
    const details = res.details as { excluded?: number };
    assert.equal(details.excluded, 1);
  });
});

test("search_messages: explicit isolated room + allowed room — allowed room returns results, note present", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({ dms: "isolated" });
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: VIEWER_TK, visibilityResolver: resolver,
    });

    // Mixed explicit list: VIEWER_TK (allowed) + ISOLATED_TK (isolated, excluded).
    const res = await tool.execute("t1", { rooms: [VIEWER_TK, ISOLATED_TK] }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // Should return results from VIEWER_TK, note about excluded DM.
    assert.match(text, /1 room\(s\) excluded by operator visibility config/);
    // Must NOT mention the isolated DM's content.
    assert.doesNotMatch(text, /secret dm message/);
  });
});

test("search_messages: all-rooms with isolation — isolated DM not returned", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({ dms: "isolated" });
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: VIEWER_TK, visibilityResolver: resolver,
    });

    // rooms:"all" — isolated DM must be silently excluded.
    const res = await tool.execute("t1", { rooms: "all", query: "secret" }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // The DM messages contain "secret"; they must NOT appear.
    assert.doesNotMatch(text, /secret dm message/);
    // No note for all-rooms (silent filtering).
    assert.doesNotMatch(text, /excluded by operator visibility config/);
  });
});

test("search_messages: viewer inside isolated room sees their own room (sameChannel)", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({ dms: "isolated" });
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: ISOLATED_TK, // viewer IS in the DM
      visibilityResolver: resolver,
    });

    // rooms:"all" from inside the isolated DM → DM should appear (sameChannel passes).
    const res = await tool.execute("t1", { rooms: "all", query: "secret" }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // DM content is visible to a viewer inside that DM.
    assert.match(text, /secret dm message/);
  });
});

test("search_messages: CRITICAL — all rooms isolated, explicit list → zero hits, no unfiltered query", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    // Configure both VIEWER_TK and ISOLATED_TK as isolated.
    const resolver = makeResolver({
      channels: [
        { timeline_key: VIEWER_TK, mode: "isolated" },
        { timeline_key: ISOLATED_TK, mode: "isolated" },
      ],
    });
    const viewer = OTHER_TK; // viewer not in either isolated room
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: viewer, visibilityResolver: resolver,
    });

    // Explicit list of two isolated rooms, viewer is in neither.
    const res = await tool.execute("t1", { rooms: [VIEWER_TK, ISOLATED_TK] }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // Short-circuit: all rooms excluded, 0 hits.
    assert.match(text, /2 room\(s\) excluded by operator visibility config/);
    // Critically: no content from any room must appear.
    assert.doesNotMatch(text, /hello from viewer room/);
    assert.doesNotMatch(text, /secret dm message/);
  });
});

test("search_messages: no isolation configured — undefined no-filter path preserved (fast path)", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    // No resolver → pure legacy behavior.
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: VIEWER_TK,
    });

    // rooms:"all" without isolation must return everything.
    const res = await tool.execute("t1", { rooms: "all" }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // All three rooms' content is visible.
    assert.match(text, /all rooms/i);
    // Total indexed events includes all 5.
    const details = res.details as { scanned?: number };
    assert.ok((details.scanned ?? 0) >= 5, "all events indexed when no isolation");
  });
});

test("search_messages (corpus:summaries): isolated room excluded", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    // Insert a summary in the isolated DM.
    await insertL1Summary(storage, {
      id: "s-dm-1",
      timelineKey: ISOLATED_TK,
      events: [makeE2eEvent("se1", ISOLATED_TK, 3_500)],
    });

    const resolver = makeResolver({ dms: "isolated" });
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: VIEWER_TK, visibilityResolver: resolver,
    });

    // Explicit request for the isolated DM summary.
    const res = await tool.execute("t1", { corpus: "summaries", rooms: [ISOLATED_TK] }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /1 room\(s\) excluded by operator visibility config/);
    const details = res.details as { excluded?: number };
    assert.equal(details.excluded, 1);
  });
});

// ── search_rooms_excluded structured log ──

test("search_rooms_excluded log is emitted when explicit rooms are excluded", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const logs: Array<{ message: string; tool: string; excludedCount: number }> = [];
    const captureLogger: Logger = {
      debug() {}, warn() {}, error() {},
      info(message, fields) { logs.push({ message, ...(fields as any) }); },
      child() { return captureLogger; },
    };

    const resolver = makeResolver({ dms: "isolated" });
    const tool = createSearchMessagesTool({
      storage, indexer, currentTimelineKey: VIEWER_TK,
      visibilityResolver: resolver, logger: captureLogger,
    });

    await tool.execute("t1", { rooms: [ISOLATED_TK] }, {} as any);

    const exclusionLog = logs.find((l) => l.message === "search_rooms_excluded");
    assert.ok(exclusionLog, "search_rooms_excluded log was emitted");
    assert.equal(exclusionLog?.tool, "search_messages");
    assert.equal(exclusionLog?.excludedCount, 1);
  });
});

// ── recap ──

test("recap: isolated room excluded from explicit list", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    await insertL1Summary(storage, {
      id: "rc-dm",
      timelineKey: ISOLATED_TK,
      events: [makeE2eEvent("rce1", ISOLATED_TK, 3_500)],
    });
    await insertL1Summary(storage, {
      id: "rc-room",
      timelineKey: VIEWER_TK,
      events: [makeE2eEvent("rce2", VIEWER_TK, 1_500, "recap visible content")],
    });

    const resolver = makeResolver({ dms: "isolated" });
    const now = () => 10_000_000;
    const tool = createRecapTool({
      storage, indexer, currentTimelineKey: VIEWER_TK,
      askerId: "@u:s",
      defaults: { budgetTokens: 8000, gapThresholdMs: 3 * 3600000, defaultLookbackMs: 24 * 3600000 },
      visibilityResolver: resolver,
      now,
    });

    const res = await tool.execute("t1", { rooms: [VIEWER_TK, ISOLATED_TK] }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // Excluded room note present; viewer's room content visible.
    assert.match(text, /1 room\(s\) excluded by operator visibility config/);
    assert.doesNotMatch(text, /summary rc-dm/);
  });
});

test("recap: all-rooms-excluded short-circuit returns visibility note", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({
      channels: [
        { timeline_key: VIEWER_TK, mode: "isolated" },
        { timeline_key: ISOLATED_TK, mode: "isolated" },
      ],
    });
    const now = () => 10_000_000;
    const tool = createRecapTool({
      storage, indexer, currentTimelineKey: OTHER_TK, // viewer not in either isolated room
      askerId: "@u:s",
      defaults: { budgetTokens: 8000, gapThresholdMs: 3 * 3600000, defaultLookbackMs: 24 * 3600000 },
      visibilityResolver: resolver,
      now,
    });

    const res = await tool.execute("t1", { rooms: [VIEWER_TK, ISOLATED_TK] }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /2 room\(s\) excluded by operator visibility config/);
    const details = res.details as { excluded?: number };
    assert.equal(details.excluded, 2);
  });
});

// ── user_activity ──

test("user_activity: isolated room excluded from explicit list", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({ dms: "isolated" });
    const now = () => 1_000_000_000_000;
    const tool = createUserActivityTool({
      storage, indexer, currentTimelineKey: VIEWER_TK,
      visibilityResolver: resolver, now,
    });

    const res = await tool.execute("t1", { rooms: [VIEWER_TK, ISOLATED_TK], all_time: true }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /1 room\(s\) excluded by operator visibility config/);
    // Isolated DM's content/sender must not appear.
    assert.doesNotMatch(text, /@alice:s/);
  });
});

test("user_activity: all-rooms-excluded short-circuit returns visibility note", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({
      channels: [
        { timeline_key: VIEWER_TK, mode: "isolated" },
        { timeline_key: ISOLATED_TK, mode: "isolated" },
      ],
    });
    const now = () => 1_000_000_000_000;
    const tool = createUserActivityTool({
      storage, indexer, currentTimelineKey: OTHER_TK,
      visibilityResolver: resolver, now,
    });

    const res = await tool.execute("t1", { rooms: [VIEWER_TK, ISOLATED_TK], all_time: true }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /2 room\(s\) excluded by operator visibility config/);
    const details = res.details as { excluded?: number };
    assert.equal(details.excluded, 2);
  });
});

test("user_activity: all-rooms with isolation — isolated DM not returned", async () => {
  await withE2eSetup(async ({ storage, indexer }) => {
    const resolver = makeResolver({ dms: "isolated" });
    const now = () => 1_000_000_000_000;
    const tool = createUserActivityTool({
      storage, indexer, currentTimelineKey: VIEWER_TK,
      visibilityResolver: resolver, now,
    });

    const res = await tool.execute("t1", { rooms: "all", all_time: true }, {} as any);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // Secret DM content must not appear in activity.
    assert.doesNotMatch(text, /secret dm message/);
    // No note for all-rooms silent filtering.
    assert.doesNotMatch(text, /excluded by operator visibility config/);
  });
});

// ── storage layer empty-array guard (defense-in-depth test) ──

test("storage: searchChatIndex with empty timelineKeys returns zero hits (not all-rooms query)", async () => {
  await withE2eSetup(async ({ storage }) => {
    const result = storage.searchChatIndex({ timelineKeys: [], limit: 20, order: "newest" });
    assert.equal(result.hits.length, 0);
    assert.equal(result.total, 0);
  });
});

test("storage: countChatIndex with empty timelineKeys returns 0 (not total count)", async () => {
  await withE2eSetup(async ({ storage }) => {
    // With no filter, total is > 0; with empty array it must be 0.
    const total = storage.countChatIndex(undefined);
    assert.ok(total > 0, "sanity: there are indexed events");
    const clamped = storage.countChatIndex([]);
    assert.equal(clamped, 0, "empty array means 'match nothing', not 'all rooms'");
  });
});

test("storage: getSummariesInWindow with empty timelineKeys returns empty (not all-rooms query)", async () => {
  await withStorage(async (storage) => {
    await insertL1Summary(storage, {
      id: "sw-1",
      timelineKey: ROOM_TK,
      events: [makeEvent("sw1", ROOM_TK, 1_000)],
    });
    const result = storage.getSummariesInWindow({ timelineKeys: [], start: 0, end: 999_999_999_999 });
    assert.equal(result.length, 0, "empty timelineKeys → no summaries");
  });
});

test("storage: topChatActivity with empty timelineKeys returns zero rows (not unfiltered)", async () => {
  await withE2eSetup(async ({ storage }) => {
    const { rows, totalSenders } = storage.topChatActivity({ timelineKeys: [], limit: 10 });
    assert.equal(rows.length, 0);
    assert.equal(totalSenders, 0);
  });
});

test("storage: chatActivityScope with empty timelineKeys returns zero (not unfiltered)", async () => {
  await withE2eSetup(async ({ storage }) => {
    const scope = storage.chatActivityScope({ timelineKeys: [] });
    assert.equal(scope.totalMessages, 0);
    assert.equal(scope.distinctSenders, 0);
    assert.equal(scope.corpusFirstAt, null);
  });
});
