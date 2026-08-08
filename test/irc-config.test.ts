/**
 * Tests for the [irc] config block (spec IRC-SUPPORT-DESIGN §8).
 *
 * The IRC block is validated at startup but not consumed by a live provider
 * in these unit tests (no sockets opened). Coverage:
 *   - absent irc block → valid (default-off)
 *   - irc block with full account parses correctly
 *   - optional fields absent by default
 *   - sasl_password + server_password are auto-redacted by key-name regex
 *   - unknown key in account block rejected (StrictObject)
 *   - missing required fields (host, nick) rejected
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { resetRedactionRegistry, registeredSecrets } from "../src/config/redaction.js";

// Minimal valid config matching the pattern from discord-config.test.ts.
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-irc-config-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── absent [irc] block ───────────────────────────────────────────────────────

test("irc: absent [irc] block is valid — default-off", async () => {
  await withConfigDir(BASE_CONFIG, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.irc, undefined, "absent [irc] block parses to undefined");
  });
});

// ── full account ─────────────────────────────────────────────────────────────

test("irc: block with one fully-specified account parses correctly", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = true
trigger_hold_ms = 250

[irc.accounts.testnet]
host = "irc.example.net"
port = 6697
tls = true
nick = "miku"
username = "miku-bot"
realname = "Miku Hatsune"
sasl_user = "miku"
sasl_password = "s3cr3t"
server_password = "netpass"
channels = ["#general", "#random"]
dm_enabled = true
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.ok(config.irc, "irc block present");
    assert.equal(config.irc.enabled, true);
    assert.equal(config.irc.trigger_hold_ms, 250);
    const acct = config.irc.accounts?.testnet;
    assert.ok(acct, "accounts.testnet present");
    assert.equal(acct.host, "irc.example.net");
    assert.equal(acct.port, 6697);
    assert.equal(acct.tls, true);
    assert.equal(acct.nick, "miku");
    assert.equal(acct.username, "miku-bot");
    assert.equal(acct.realname, "Miku Hatsune");
    assert.equal(acct.sasl_user, "miku");
    assert.equal(acct.sasl_password, "s3cr3t");
    assert.equal(acct.server_password, "netpass");
    assert.deepEqual(acct.channels, ["#general", "#random"]);
    assert.equal(acct.dm_enabled, true);
  });
});

// ── optional fields absent ───────────────────────────────────────────────────

test("irc: optional account fields absent by default", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.minimal]
host = "irc.example.net"
nick = "miku"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    const acct = config.irc?.accounts?.minimal;
    assert.ok(acct, "accounts.minimal present");
    assert.equal(acct.host, "irc.example.net");
    assert.equal(acct.nick, "miku");
    // All optional fields are absent
    assert.equal(acct.port, undefined);
    assert.equal(acct.tls, undefined);
    assert.equal(acct.username, undefined);
    assert.equal(acct.realname, undefined);
    assert.equal(acct.sasl_user, undefined);
    assert.equal(acct.sasl_password, undefined);
    assert.equal(acct.server_password, undefined);
    assert.equal(acct.channels, undefined);
    assert.equal(acct.dm_enabled, undefined);
    assert.equal(acct.agent, undefined);
  });
});

// ── trigger_hold_ms absent ───────────────────────────────────────────────────

test("irc: trigger_hold_ms is optional on the [irc] block", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.a]
host = "irc.example.net"
nick = "bot"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.irc?.trigger_hold_ms, undefined);
  });
});

// ── sasl_password redaction ───────────────────────────────────────────────────

test("irc: sasl_password is registered for redaction by key-name regex", async () => {
  const PASSWORD = "very-secret-sasl-pass-xyz42";
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bot]
host = "irc.example.net"
nick = "bot"
sasl_user = "bot"
sasl_password = "${PASSWORD}"
`;
  resetRedactionRegistry();
  await withConfigDir(toml, async (dir) => {
    await loadConfig(dir, { env: false });
    const secrets = registeredSecrets();
    assert.ok(
      secrets.includes(PASSWORD),
      `Expected sasl_password in redaction registry; got: ${JSON.stringify(secrets)}`,
    );
  });
  resetRedactionRegistry();
});

// ── server_password redaction ────────────────────────────────────────────────

test("irc: server_password is registered for redaction by key-name regex", async () => {
  const PASSWORD = "network-server-pass-abc99";
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bot]
host = "irc.example.net"
nick = "bot"
server_password = "${PASSWORD}"
`;
  resetRedactionRegistry();
  await withConfigDir(toml, async (dir) => {
    await loadConfig(dir, { env: false });
    const secrets = registeredSecrets();
    assert.ok(
      secrets.includes(PASSWORD),
      `Expected server_password in redaction registry; got: ${JSON.stringify(secrets)}`,
    );
  });
  resetRedactionRegistry();
});

// ── StrictObject rejects unknown keys ────────────────────────────────────────

test("irc: unknown key in account block is rejected (StrictObject)", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bad]
host = "irc.example.net"
nick = "bot"
unknown_field = "oops"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "StrictObject should reject unknown keys in account block",
    );
  });
});

test("irc: unknown key in [irc] block is rejected (StrictObject)", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false
unknown_top_key = "bad"

[irc.accounts.a]
host = "irc.example.net"
nick = "bot"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "StrictObject should reject unknown keys in [irc] block",
    );
  });
});

// ── required fields enforced ─────────────────────────────────────────────────

test("irc: missing required 'host' in account is rejected", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bad]
nick = "bot"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "Missing 'host' should be rejected",
    );
  });
});

test("irc: missing required 'nick' in account is rejected", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bad]
host = "irc.example.net"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "Missing 'nick' should be rejected",
    );
  });
});

// ── port range ───────────────────────────────────────────────────────────────

test("irc: port out of range (0) is rejected", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bad]
host = "irc.example.net"
nick = "bot"
port = 0
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "Port 0 is below minimum (1)",
    );
  });
});

test("irc: port out of range (65536) is rejected", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.bad]
host = "irc.example.net"
nick = "bot"
port = 65536
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      loadConfig(dir, { env: false }),
      (err: unknown) => err instanceof Error,
      "Port 65536 is above maximum (65535)",
    );
  });
});

test("irc: valid port 6697 is accepted", async () => {
  const toml = `${BASE_CONFIG}
[irc]
enabled = false

[irc.accounts.a]
host = "irc.example.net"
nick = "bot"
port = 6697
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.irc?.accounts?.a?.port, 6697);
  });
});
