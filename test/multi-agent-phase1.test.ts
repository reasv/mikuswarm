/**
 * Phase 1 multi-agent support tests (spec MULTI-AGENT-SUPPORT §3 / §4.1 / §4.2 / §4.3 / §5.2 / §9).
 *
 * Covers:
 *   - Config schema: [agents.*], [siblings], agent field on accounts, [workspace] optional
 *   - Cross-field validation: validateAgentConfig (§3 key checks, §4.2 invariants)
 *   - Sibling suppression: evaluateGate with siblingUserIds (§5.2)
 *   - Diary pool §4.3: resolveJobDeps returning undefined → job skipped
 *   - Reply-trigger sibling suppression (§9): sibling replies must not produce a trigger
 *   - §4.3 in factory: resolveWorkspaceRoot returning undefined → throw, not fallback
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { validateAgentConfig } from "../src/app.ts";
import { evaluateGate } from "../src/proactive/index.js";
import { Storage, MemoryFileWriter } from "../src/storage/index.js";
import { DiaryWorkerPool } from "../src/diary/index.js";
import { DiscordProvider } from "../src/discord/index.js";
import { MatrixProvider } from "../src/matrix/index.js";
import type { Logger } from "../src/observability/index.js";
import type { CanonicalChatEvent, TriggerInfo, InboundChatEvent } from "../src/types.js";
import type { AppConfig } from "../src/config/index.js";
import type { DiscordProviderCallbacks } from "../src/discord/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma-cfg-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    const { rm: rmDir } = await import("node:fs/promises");
    await rmDir(dir, { recursive: true, force: true });
  }
}

/** Minimal config that loads cleanly — [workspace] intentionally absent (now optional). */
const BASE_CONFIG = `
[app]
name = "mikuswarm"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug/context"

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

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

// ---------------------------------------------------------------------------
// §4.1 / schema: [workspace] is now optional
// ---------------------------------------------------------------------------

test("config: [workspace] block is optional — config without it is accepted", async () => {
  // BASE_CONFIG already omits [workspace]; if this loads successfully the schema
  // is correctly marked optional.
  await withConfigDir(BASE_CONFIG, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.workspace, undefined, "[workspace] must be undefined when absent");
  });
});

test("config: [workspace] block with root_dir is still accepted after making it optional", async () => {
  const toml = `${BASE_CONFIG}
[workspace]
root_dir = "./workspaces/test"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.workspace?.root_dir, "./workspaces/test");
  });
});

// ---------------------------------------------------------------------------
// §4.2 schema: [agents.*] blocks
// ---------------------------------------------------------------------------

test("config: [agents.*] with workspace_root is accepted", async () => {
  // Schema-only test: exercises TypeBox validation, NOT validateAgentConfig.
  // BASE_CONFIG's [matrix.accounts.test] resolves to agent name "test" (by
  // default) which is undeclared in [agents], so validateAgentConfig would throw;
  // that cross-field check is covered by the validateAgentConfig suite below.
  // Use a second account key ("miku") that doesn't conflict with the "test"
  // account already defined in BASE_CONFIG.
  const toml = `${BASE_CONFIG}
[agents.miku]
workspace_root = "./workspaces/miku"

[matrix.accounts.miku]
homeserver = "http://localhost"
user_id = "@miku:localhost"
store_path = "./var/miku"
agent = "miku"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agents?.miku?.workspace_root, "./workspaces/miku");
  });
});

test("config: [agents.*] missing workspace_root is rejected by schema", async () => {
  const toml = `${BASE_CONFIG}
[agents.miku]
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /workspace_root|Invalid config/i,
      "missing workspace_root must fail TypeBox validation",
    );
  });
});

// ---------------------------------------------------------------------------
// §3 / schema: agent field on accounts
// ---------------------------------------------------------------------------

test("config: agent field on matrix account is accepted", async () => {
  // Schema-only test: exercises TypeBox validation, NOT validateAgentConfig.
  // BASE_CONFIG's [matrix.accounts.test] resolves to undeclared agent "test" —
  // that cross-field invariant is tested in the validateAgentConfig suite below.
  // Use a different account key to avoid redefining BASE_CONFIG's "test" account.
  const toml = `${BASE_CONFIG}
[agents.miku]
workspace_root = "./workspaces/miku"

[matrix.accounts.miku]
homeserver = "http://localhost"
user_id = "@miku:localhost"
store_path = "./var/miku"
agent = "miku"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal((config.matrix.accounts.miku as { agent?: string }).agent, "miku");
  });
});

test("config: empty agent field on matrix account is rejected (minLength 1)", async () => {
  // Use a different account key to avoid redefining BASE_CONFIG's "test" account.
  const toml = `${BASE_CONFIG}
[matrix.accounts.second]
homeserver = "http://localhost"
user_id = "@second:localhost"
store_path = "./var/second"
agent = ""
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /agent|minLength|Invalid config/i,
      "empty agent field must fail schema validation",
    );
  });
});

// ---------------------------------------------------------------------------
// §5.2 / schema: [siblings] block
// ---------------------------------------------------------------------------

test("config: [siblings] with replies = \"never\" is accepted", async () => {
  const toml = `${BASE_CONFIG}
[siblings]
replies = "never"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.siblings?.replies, "never");
  });
});

test("config: [siblings] with max_bot_chain accepted as integer", async () => {
  const toml = `${BASE_CONFIG}
[siblings]
max_bot_chain = 3
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.siblings?.max_bot_chain, 3);
  });
});

test("config: [siblings] with unknown replies value is rejected", async () => {
  const toml = `${BASE_CONFIG}
[siblings]
replies = "always"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /replies|Invalid config/i,
      "an out-of-enum replies value must fail schema validation",
    );
  });
});

test("config: [siblings] max_bot_chain below 1 is rejected", async () => {
  const toml = `${BASE_CONFIG}
[siblings]
max_bot_chain = 0
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /max_bot_chain|minimum|Invalid config/i,
      "max_bot_chain < 1 must fail schema validation",
    );
  });
});

// ---------------------------------------------------------------------------
// validateAgentConfig: §3 account key colon check
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  // A minimal valid AppConfig skeleton — only the fields validateAgentConfig reads.
  return {
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    discord: undefined,
    agents: undefined,
    workspace: undefined,
    ...overrides,
  } as unknown as AppConfig;
}

test("validateAgentConfig: matrix account key with colon throws", () => {
  const config = minimalConfig({
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { "bad:key": { homeserver: "http://localhost", user_id: "@x:h", store_path: "./v" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /matrix.*bad:key.*colon|colon.*parseTimelineKey/i,
  );
});

test("validateAgentConfig: discord account key with colon throws", () => {
  const config = minimalConfig({
    discord: {
      enabled: true,
      accounts: { "bad:key": { token: "tok" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /discord.*bad:key.*colon|colon.*parseTimelineKey/i,
  );
});

test("validateAgentConfig: irc account key with colon throws", () => {
  const config = minimalConfig({
    irc: {
      enabled: true,
      accounts: { "bad:key": { host: "irc.example.net", nick: "bot" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /irc.*bad:key.*colon|colon.*parseTimelineKey/i,
  );
});

// ---------------------------------------------------------------------------
// validateAgentConfig: §4.2 agents-mode invariants
// ---------------------------------------------------------------------------

test("validateAgentConfig: [workspace].root_dir + [agents] mutual exclusivity throws", () => {
  const config = minimalConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    workspace: { root_dir: "/tmp/shared" },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { miku: { homeserver: "h", user_id: "@x:h", store_path: "./v" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /mutually exclusive|root_dir.*agents|agents.*root_dir/i,
  );
});

test("validateAgentConfig: agent name outside [a-z0-9-] throws", () => {
  const config = minimalConfig({
    agents: { "Bad_Name": { workspace_root: "/tmp/bad" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { "Bad_Name": { homeserver: "h", user_id: "@x:h", store_path: "./v" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /Bad_Name.*\[a-z0-9-\]|\[agents\].*characters outside/i,
  );
});

test("validateAgentConfig: matrix account pointing to undeclared agent throws", () => {
  const config = minimalConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { other: { homeserver: "h", user_id: "@x:h", store_path: "./v", agent: "ghost" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /ghost.*not declared|agents\.ghost/i,
  );
});

test("validateAgentConfig: matrix account key defaulting to undeclared agent throws", () => {
  // Account key 'other' but no agent field — defaults to agentName = 'other',
  // which is not in [agents]. Only 'miku' is declared.
  const config = minimalConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { other: { homeserver: "h", user_id: "@x:h", store_path: "./v" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /other.*not declared|agents\.other/i,
  );
});

test("validateAgentConfig: overlapping workspace roots throws", () => {
  const config = minimalConfig({
    agents: {
      a: { workspace_root: "/tmp/agents/a" },
      b: { workspace_root: "/tmp/agents/a/nested" }, // nested inside a
    },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        a: { homeserver: "h", user_id: "@a:h", store_path: "./va" },
        b: { homeserver: "h", user_id: "@b:h", store_path: "./vb" },
      },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /pairwise disjoint|overlap/i,
  );
});

test("validateAgentConfig: identical workspace roots throws", () => {
  const config = minimalConfig({
    agents: {
      a: { workspace_root: "/tmp/agents/shared" },
      b: { workspace_root: "/tmp/agents/shared" }, // same root
    },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        a: { homeserver: "h", user_id: "@a:h", store_path: "./va" },
        b: { homeserver: "h", user_id: "@b:h", store_path: "./vb" },
      },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /pairwise disjoint|overlap/i,
  );
});

test("validateAgentConfig: valid two-agent config with disjoint roots does not throw", () => {
  const config = minimalConfig({
    agents: {
      alice: { workspace_root: "/tmp/agents/alice" },
      bob: { workspace_root: "/tmp/agents/bob" },
    },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        alice: { homeserver: "h", user_id: "@a:h", store_path: "./va" },
        bob: { homeserver: "h", user_id: "@b:h", store_path: "./vb" },
      },
    } as any,
  });
  assert.doesNotThrow(() => validateAgentConfig(config));
});

test("validateAgentConfig: irc account pointing to undeclared agent throws", () => {
  const config = minimalConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { miku: { homeserver: "h", user_id: "@x:h", store_path: "./v" } },
    } as any,
    irc: {
      enabled: true,
      accounts: { ircthing: { host: "irc.example.net", nick: "bot", agent: "ghost" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /ghost.*not declared|agents\.ghost/i,
  );
});

test("validateAgentConfig: irc account key defaulting to undeclared agent throws", () => {
  // Account key 'ircthing' but no agent field — defaults to agentName = 'ircthing',
  // which is not in [agents]. Only 'miku' is declared.
  const config = minimalConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { miku: { homeserver: "h", user_id: "@x:h", store_path: "./v" } },
    } as any,
    irc: {
      enabled: true,
      accounts: { ircthing: { host: "irc.example.net", nick: "bot" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /ircthing.*not declared|agents\.ircthing/i,
  );
});

// ---------------------------------------------------------------------------
// validateAgentConfig: §4.2 legacy-mode invariants
// ---------------------------------------------------------------------------

test("validateAgentConfig: agent field on matrix account without [agents] throws", () => {
  const config = minimalConfig({
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { test: { homeserver: "h", user_id: "@t:h", store_path: "./v", agent: "miku" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /agent.*field.*not valid without|agents.*table/i,
  );
});

test("validateAgentConfig: agent field on irc account without [agents] throws", () => {
  const config = minimalConfig({
    irc: {
      enabled: true,
      accounts: { bot: { host: "irc.example.net", nick: "bot", agent: "miku" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /agent.*field.*not valid without|agents.*table/i,
  );
});

test("validateAgentConfig: no [agents] table + no agent fields is valid", () => {
  const config = minimalConfig({
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { test: { homeserver: "h", user_id: "@t:h", store_path: "./v" } },
    } as any,
  });
  assert.doesNotThrow(() => validateAgentConfig(config));
});

// ---------------------------------------------------------------------------
// §5.2: sibling suppression in evaluateGate
// ---------------------------------------------------------------------------

const TK = "matrix:miku:room:!room:server";

function ev(
  id: string,
  ts: number,
  role: "user" | "assistant",
  senderId?: string,
): CanonicalChatEvent {
  const defaultSender = role === "assistant" ? "@miku:server" : "@u:server";
  return {
    id,
    timelineKey: TK,
    provider: "matrix",
    role,
    sender: { id: senderId ?? defaultSender, isSelf: role === "assistant" },
    body: id,
    timestamp: ts,
    receivedAt: ts,
  };
}

const GATE = { deadChannelBackstopMs: 6 * 3_600_000, minUserMessages: 2 };
const NOW = 10_000;

test("evaluateGate: sibling user messages are excluded from human count (gate stays closed)", () => {
  // Two messages from @sibling:server arrive as role:'user' — without suppression they'd
  // open the gate; with siblingUserIds={@sibling:server} they should not count.
  const sibling = "@sibling:server";
  const events: CanonicalChatEvent[] = [
    ev("a1", 1000, "assistant"),
    ev("s1", 2000, "user", sibling),
    ev("s2", 3000, "user", sibling),
  ];
  const result = evaluateGate(events, NOW, GATE, new Set([sibling]));
  assert.deepEqual(
    result,
    { ok: false, reason: "skip_sparse" },
    "sibling messages must not count toward the human threshold",
  );
});

test("evaluateGate: non-sibling messages still count even when siblingUserIds is set", () => {
  const sibling = "@sibling:server";
  const events: CanonicalChatEvent[] = [
    ev("a1", 1000, "assistant"),
    ev("u1", 2000, "user", "@human:server"),
    ev("u2", 3000, "user", "@human:server"),
    // A sibling message between them should be invisible to the gate
    ev("s1", 2500, "user", sibling),
  ];
  const result = evaluateGate(events, NOW, GATE, new Set([sibling]));
  assert.deepEqual(
    result,
    { ok: true },
    "real human messages must still count toward the threshold",
  );
});

test("evaluateGate: without siblingUserIds all role:user messages count as before", () => {
  // Baseline: behaviour identical to pre-Phase-1 when no siblingUserIds provided.
  const events: CanonicalChatEvent[] = [
    ev("a1", 1000, "assistant"),
    ev("u1", 2000, "user"),
    ev("u2", 3000, "user"),
  ];
  assert.deepEqual(evaluateGate(events, NOW, GATE), { ok: true });
});

// ---------------------------------------------------------------------------
// §4.3: diary pool skips a job when resolveJobDeps returns undefined
// ---------------------------------------------------------------------------

async function withFixture(
  run: (ctx: { storage: Storage; workspaceRoot: string; memoryWriter: MemoryFileWriter }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma-diary-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run({ storage, workspaceRoot: dir, memoryWriter: new MemoryFileWriter(dir) });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function insertLevel1(storage: Storage, id: string): Promise<void> {
  const evs: CanonicalChatEvent[] = [
    {
      id: `e-${id}`,
      timelineKey: TK,
      provider: "matrix",
      role: "user",
      sender: { id: "@u:server", isSelf: false },
      body: "hi",
      timestamp: 1000,
      receivedAt: 1000,
    },
  ];
  for (const e of evs) await storage.appendTimelineEvent(e);
  const jobId = `job-${id}`;
  await storage.insertSummarizationJob({
    id: jobId, timelineKey: TK, level: 1,
    inputStartId: evs[0]!.id, inputEndId: evs[0]!.id,
    inputTokenCount: 10, targetTokenCount: 100, maxRetries: 0,
  });
  await storage.insertSummaryWithLineage({
    id, timelineKey: TK, level: 1, content: `summary ${id}`,
    earliestTimestamp: 1000, latestTimestamp: 1000,
    latestEventId: evs[0]!.id, eventCount: 1,
    tokenCount: 10, modelId: "m", status: "complete", generatedAt: 1000,
    eventIds: evs.map((e) => e.id), jobId,
  });
}

function diaryStatus(storage: Storage, id: string): string | null {
  return (
    storage.read((db) =>
      db.prepare(`select diary_status from summaries where id = ?`).get(id),
    ) as { diary_status: string | null }
  ).diary_status;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for predicate");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("diary pool §4.3: resolveJobDeps returning undefined marks the job 'skipped'", async () => {
  await withFixture(async ({ storage, workspaceRoot, memoryWriter }) => {
    await insertLevel1(storage, "s1");

    // resolveJobDeps always returns undefined — simulates an account that was
    // removed from config after its summaries were already committed (§4.3).
    const pool = new DiaryWorkerPool({
      storage,
      factory: { resolveModelId: () => "test-model" } as any,
      memoryWriter,
      workspaceRoot,
      config: { worker_count: 1, max_retries: 0, per_session_budget_tokens: 1000 },
      resolveJobDeps: () => undefined,
      resolveChannelLabel: async () => "Test Room",
      logger: silentLogger,
    });

    await pool.start();
    pool.notifyNewWork();
    try {
      // diary_status starts as 'pending' after insertLevel1 (not null).
      // Wait for it to leave the non-terminal states ('pending', 'processing').
      await waitFor(
        () => !["pending", "processing"].includes(diaryStatus(storage, "s1") ?? ""),
      );
      assert.equal(
        diaryStatus(storage, "s1"),
        "skipped",
        "job with unresolvable account must be marked skipped, not failed or retried",
      );
    } finally {
      await pool.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// §9: Reply-trigger sibling suppression — both providers
// ---------------------------------------------------------------------------

// A realistic trigger value that resolveReplyTrigger would return if called.
// Used to detect whether the sibling-guard correctly short-circuits the call.
const STUB_REPLY_TRIGGER: TriggerInfo = {
  type: "reply",
  reason: "reply to bot message",
  triggeredBy: { id: "dummy-id" },
};

test("§9 reply-trigger: Discord sibling reply does not produce a trigger", async () => {
  // A sibling bot's message that replies to one of the main bot's own messages.
  // Without the §9 sibling guard the reply-trigger path would call
  // resolveReplyTrigger and set inbound.trigger — verify it does NOT.
  const SIBLING_ID = "888000000000000001";
  const BOT_MSG_ID  = "800000000000000001";

  // Minimal callbacks (no real storage — we only care about the trigger path)
  const callbacks: DiscordProviderCallbacks = {
    async mergeLateEmbeds() {},
    async storeIngestEmbeds() {},
    async upsertUserIdentity() {},
    async setChannelMetadata() {},
  };

  const provider = new DiscordProvider(
    {
      enabled: true,
      accounts: { main: { token: "MOCK_TOKEN" } },
    } as NonNullable<AppConfig["discord"]>,
    callbacks,
  );

  // Inject siblingUserIds before the message arrives
  (provider as unknown as { siblingUserIds: Set<string> }).siblingUserIds = new Set([SIBLING_ID]);

  let capturedInbound: unknown;
  let replyTriggerCalled = false;
  (provider as unknown as Record<string, unknown>).host = {
    onEvent(inbound: unknown) { capturedInbound = inbound; },
    resolveReplyTrigger() {
      replyTriggerCalled = true;
      return STUB_REPLY_TRIGGER;
    },
  };

  // Message from the sibling that replies to a bot message (has reference.messageId)
  const cachedBotMsg = {
    id: BOT_MSG_ID,
    content: "bot message being replied to",
    author: { id: "999000000000000001", username: "bot", displayName: "Bot" },
    createdTimestamp: 1_699_000_000_000,
    attachments: { values: () => [].values() },
    stickers: { values: () => [].values() },
    guild: null,
  };
  const msgStub = {
    id: "111111111111111112",
    content: "sibling reply",
    channelId: "200000000000000001",
    guildId:   "300000000000000001",
    channel: {
      type: 0, // GuildText — not a thread, so resolveParentChannelId returns undefined
      messages: {
        cache: { get: (id: string) => (id === BOT_MSG_ID ? cachedBotMsg : undefined) },
      },
    },
    author: { id: SIBLING_ID, username: "sibling-bot", displayName: "SiblingBot" },
    reference: { messageId: BOT_MSG_ID },
    mentions: {
      users: { map: () => [] },
      roles: { map: () => [] },
      channels: { map: () => [] },
      everyone: false,
      repliedUser: null,
    },
    attachments: { values: () => [].values() },
    stickers: { values: () => [].values() },
    embeds: [],
    flags: { has: () => false },
    guild: null,
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp: null,
    poll: null,
  };

  const runtime = {
    accountId: "main",
    self: { id: "999000000000000001", username: "bot", displayName: "Bot" },
    client: { channels: { cache: new Map(), fetch: async () => null } },
    allowedGuilds: undefined,
    dmEnabled: true,
    memberIntentEnabled: false,
  };

  await (provider as unknown as Record<string, (...a: unknown[]) => Promise<void>>)
    .handleMessageCreate(runtime, msgStub);

  assert.ok(capturedInbound, "sibling message must still be ingested (event emitted)");
  assert.equal(
    (capturedInbound as { trigger?: unknown }).trigger,
    undefined,
    "sibling reply must not produce a trigger on the captured inbound event (§9)",
  );
  assert.equal(
    replyTriggerCalled,
    false,
    "resolveReplyTrigger must not be called for a sibling sender (§9 guard)",
  );
});

test("§9 reply-trigger: Matrix sibling reply does not produce a trigger (emitWithTriggerHold)", () => {
  // A sibling bot's message that replies (replyTo.externalId set) to a bot message.
  // Without the §9 guard emitWithTriggerHold would call resolveReplyTrigger and
  // mutate inbound.trigger — verify it does NOT for sibling senders.
  const SIBLING_ID = "@sibling:server";

  const provider = new MatrixProvider({
    enabled: false,
    trigger_hold_ms: 0,
    accounts: {},
  } as AppConfig["matrix"]);

  // siblingUserIds is a public property (injected by app.ts after construction)
  provider.siblingUserIds = new Set([SIBLING_ID]);

  let replyTriggerCalled = false;
  // Inject host via cast (private field)
  (provider as unknown as Record<string, unknown>).host = {
    onEvent(_inbound: unknown) {},
    resolveReplyTrigger() {
      replyTriggerCalled = true;
      return STUB_REPLY_TRIGGER;
    },
  };

  const inbound: InboundChatEvent = {
    provider: "matrix",
    timelineKey: "matrix:test:room:!room:server",
    trigger: undefined,
    event: {
      id: "$sibling-msg-1",
      timelineKey: "matrix:test:room:!room:server",
      provider: "matrix",
      role: "user",
      sender: { id: SIBLING_ID, isSelf: false },
      body: "sibling reply",
      timestamp: 2000,
      receivedAt: 2000,
      replyTo: { externalId: "$bot-msg-1" },
    } as CanonicalChatEvent,
  };

  (provider as unknown as Record<string, (a: InboundChatEvent) => void>)
    .emitWithTriggerHold(inbound);

  assert.equal(
    inbound.trigger,
    undefined,
    "sibling reply must not mutate inbound.trigger (§9 guard in emitWithTriggerHold)",
  );
  assert.equal(
    replyTriggerCalled,
    false,
    "resolveReplyTrigger must not be called for a sibling sender (§9 guard)",
  );
});
