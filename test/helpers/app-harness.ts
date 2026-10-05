/**
 * Whole-app harness: `startMikuAgent` with a controllable fake chat provider and
 * a scripted fake LLM endpoint (fake-llm.ts). Inbound messages go through the real
 * pipeline (router, trigger coordinator, launchSession, factory, runner); the
 * test reads the SQLite file read-only to assert on what the app persisted.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../../src/config/index.js";
import { startMikuAgent } from "../../src/app.js";
import type {
  ChatProviderHost,
  DeliveryReceipt,
  IChatProvider,
  InboundChatEvent,
  OutboundMessage,
  OutboundTarget,
} from "../../src/types.js";
import { FAKE_CAPABILITIES } from "./fake-provider.js";
import { startFakeLlm, type DecideNoul, type FakeLlm, type FakeLlmReply, type FakeLlmRequest } from "./fake-llm.js";

export const HARNESS_TK = "matrix:test:room:!room";
export const BOT_ID = "@bot:fake";

export interface HarnessSend {
  target: OutboundTarget;
  msg: OutboundMessage;
  externalId: string;
}

export interface AppHarness {
  llm: FakeLlm;
  sends: HarnessSend[];
  /** Deliver a user message; `mention` makes it a trigger. Returns its external id. */
  say(body: string, opts?: { mention?: boolean; replyTo?: string; id?: string }): string;
  /** Poll until `predicate` holds (default 10 s). */
  until(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** Read-only query against the app's database. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Captured structured log lines (parsed JSON). */
  logs: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

function baseToml(root: string, llmUrl: string): string {
  return `
[app]
name = "mikuswarm"
data_dir = "${root}/var"
log_level = "info"
context_dump_dir = "${root}/debug/context"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "fake-model"
provider = "fake"
api = "openai-completions"
endpoint = "${llmUrl}"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
context_window = 128000
streaming = true

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = "${root}/var/miku.sqlite"

[workspace]
root_dir = "${root}/workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "${root}/var/test"

[summarization]
enabled = false

[diary]
enabled = false

[recovery]
llm_primary_attempts_per_request = 1

# The fake provider has no enrichment client: never hold a trigger on it.
[enrichment]
trigger_wait_timeout_ms = 100
`;
}

export async function startHarness(opts: {
  script: (req: FakeLlmRequest) => FakeLlmReply | Promise<FakeLlmReply>;
  /** Extra TOML merged over the base config (`LLM_URL` is replaced by the fake endpoint). */
  toml?: string;
  decideNoul?: DecideNoul;
  /**
   * Called on every provider typing toggle and awaited. The runner turns typing
   * off after the agent loop ended and before the run settles, so a hook on
   * `on === false` holds the session in that window.
   */
  onTyping?: (on: boolean) => Promise<void> | void;
}): Promise<AppHarness> {
  const llm = await startFakeLlm(opts.script, opts.decideNoul);
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-app-harness-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "miku-app-harness-cfg-"));
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    await writeFile(path.join(configDir, "00-test.toml"), baseToml(root, llm.url), "utf8");
    // The test's extra TOML is its own (later) file, so it may override base tables.
    await writeFile(path.join(configDir, "50-extra.toml"), (opts.toml ?? "").replaceAll("LLM_URL", llm.url), "utf8");
    config = await loadConfig(configDir, { env: false });
  } catch (error) {
    await llm.close();
    await rm(root, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    throw error;
  }

  const sends: HarnessSend[] = [];
  let host: ChatProviderHost | null = null;
  let sendSeq = 0;
  const provider: IChatProvider = {
    id: "matrix",
    capabilities: FAKE_CAPABILITIES,
    async start(h: ChatProviderHost) {
      host = h;
    },
    async stop() {},
    async send(target: OutboundTarget, msg: OutboundMessage): Promise<DeliveryReceipt> {
      sendSeq += 1;
      const externalId = `$bot${sendSeq}`;
      sends.push({ target, msg, externalId });
      return { provider: "matrix", target, externalId, deliveredAt: Date.now() };
    },
    async setTyping(_target: OutboundTarget, on: boolean) {
      await opts.onTyping?.(on);
    },
    accountIds: () => ["test"],
    getSelf: () => ({ id: BOT_ID, displayName: "Bot" }),
    ownsUserId: (id: string) => id === BOT_ID,
    enrichment: () => undefined,
    channelClient: () => undefined,
  } as unknown as IChatProvider;

  // Capture the structured logs (the logger writes one JSON line per console call)
  // instead of printing them; set HARNESS_LOGS=1 to also print.
  const logs: Array<Record<string, unknown>> = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    const line = args[0];
    if (typeof line === "string" && line.startsWith("{")) {
      try {
        logs.push(JSON.parse(line));
        if (process.env.HARNESS_LOGS) orig(...args);
        return;
      } catch {
        /* not a log line */
      }
    }
    orig(...args);
  };
  console.log = capture(original.log);
  console.warn = capture(original.warn);
  console.error = capture(original.error);
  const restoreConsole = () => Object.assign(console, original);

  let runtime;
  try {
    runtime = await startMikuAgent(config, { providers: new Map([["matrix", provider]]) });
  } catch (error) {
    restoreConsole();
    await llm.close();
    throw error;
  }
  const db = new Database(path.join(root, "var", "miku.sqlite"), { readonly: true, fileMustExist: true });
  let seq = 0;
  const harness: AppHarness = {
    llm,
    sends,
    logs,
    say(body, sayOpts = {}) {
      seq += 1;
      const now = Date.now() + seq;
      const externalId = sayOpts.id ?? `$user${seq}`;
      const sender = { id: "@alice:fake", displayName: "Alice", username: "alice" };
      const inbound: InboundChatEvent = {
        provider: "matrix",
        timelineKey: HARNESS_TK,
        channelType: "group",
        event: {
          id: `evt-${externalId}`,
          externalId,
          timelineKey: HARNESS_TK,
          provider: "matrix",
          role: "user",
          sender,
          body,
          timestamp: now,
          receivedAt: now,
          ...(sayOpts.mention ? { mentions: { mentionedSelf: true, userIds: [BOT_ID] } } : {}),
          ...(sayOpts.replyTo ? { replyTo: { externalId: sayOpts.replyTo } } : {}),
        },
        ...(sayOpts.mention
          ? { trigger: { type: "mention" as const, reason: "mention", triggeredBy: sender } }
          : {}),
        outboundTarget: { provider: "matrix", timelineKey: HARNESS_TK, accountId: "test", roomId: "!room" },
      } as InboundChatEvent;
      host!.onEvent(inbound);
      return externalId;
    },
    async until(predicate, what, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    query<T>(sql: string, ...params: unknown[]): T[] {
      try {
        return db.prepare(sql).all(...params) as T[];
      } catch (error) {
        throw new Error(`query failed (${sql}): ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async stop() {
      try {
        await runtime.stop();
      } finally {
        restoreConsole();
        db.close();
        await llm.close();
        await rm(root, { recursive: true, force: true });
        await rm(configDir, { recursive: true, force: true });
      }
    },
  };
  return harness;
}
