/**
 * Tests for the [discord] config block (Phase 2a).
 *
 * The Discord block is validated at startup but not yet consumed by a provider.
 * Coverage:
 *   - absent discord block → valid (defaults from 00-defaults.toml)
 *   - discord with an account parses correctly
 *   - guilds / dm_enabled / member_intent default to absent (optional)
 *   - discord.accounts.*.token is auto-redacted by the key-name regex
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { resetRedactionRegistry, registeredSecrets } from "../src/config/redaction.js";

// Minimal valid config that satisfies all required fields.
// Uses [matrix] with enabled:false and no accounts so the integration plumbing
// is untouched; we are only testing the schema validation here.
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

[workspace]
root_dir = "./workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"
`;

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-discord-config-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── absent discord block ────────────────────────────────────────────────────

test("discord: absent [discord] block is valid — defaults apply", async () => {
  await withConfigDir(BASE_CONFIG, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    // The isolated config dir has no [discord] block and never loads 00-defaults.toml,
    // so the optional schema field parses to `undefined`. Loading must not throw.
    assert.equal(config.discord, undefined, "absent [discord] parses to undefined");
  });
});

// ── discord block with an account ──────────────────────────────────────────

test("discord: block with one account parses correctly", async () => {
  const toml = `${BASE_CONFIG}
[discord]
enabled = true
trigger_hold_ms = 500

[discord.accounts.main]
token = "Bot very-secret-token-12345"
application_id = "1234567890"
guilds = ["9876543210"]
dm_enabled = true
member_intent = false
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.ok(config.discord, "discord block present");
    assert.equal(config.discord.enabled, true);
    assert.equal(config.discord.trigger_hold_ms, 500);
    const main = config.discord.accounts?.main;
    assert.ok(main, "accounts.main present");
    assert.equal(main.token, "Bot very-secret-token-12345");
    assert.equal(main.application_id, "1234567890");
    assert.deepEqual(main.guilds, ["9876543210"]);
    assert.equal(main.dm_enabled, true);
    assert.equal(main.member_intent, false);
  });
});

// ── optional field defaults ─────────────────────────────────────────────────

test("discord: optional account fields absent by default", async () => {
  const toml = `${BASE_CONFIG}
[discord]
enabled = false

[discord.accounts.minimal]
token = "Bot tok-abcde-1234567890"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    const acct = config.discord?.accounts?.minimal;
    assert.ok(acct, "accounts.minimal present");
    // Optional fields absent = undefined
    assert.equal(acct.application_id, undefined);
    assert.equal(acct.guilds, undefined);
    assert.equal(acct.dm_enabled, undefined);
    assert.equal(acct.member_intent, undefined);
  });
});

// ── token redaction ─────────────────────────────────────────────────────────

test("discord: token is registered for redaction by key-name regex", async () => {
  const TOKEN = "Bot super-secret-discord-token-x9z7";
  const toml = `${BASE_CONFIG}
[discord]
enabled = false

[discord.accounts.bot]
token = "${TOKEN}"
`;
  // Reset the registry so previous test runs don't pollute the assertion.
  resetRedactionRegistry();
  await withConfigDir(toml, async (dir) => {
    await loadConfig(dir, { env: false });
    const secrets = registeredSecrets();
    assert.ok(
      secrets.includes(TOKEN),
      `Expected discord token in redaction registry; got: ${JSON.stringify(secrets)}`,
    );
  });
  resetRedactionRegistry();
});

// ── invalid config is rejected ──────────────────────────────────────────────

test("discord: unknown key in account block is rejected (StrictObject)", async () => {
  const toml = `${BASE_CONFIG}
[discord]
enabled = false

[discord.accounts.bad]
token = "Bot tok-1234"
unknown_field = "oops"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "StrictObject should reject unknown keys",
    );
  });
});
