import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";

// A complete, env-free config so loadConfig reaches structural + cross-field
// validation without tripping the "missing env var" guard. The
// `[observability.server]` block is appended per-test to exercise issue #5.
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
multimodal = false
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

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-config-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: observability server enabled with blank auth_token is rejected (issue #5)", async () => {
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
auth_token = ""
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /auth_token|minLength|Invalid config/i,
      "empty auth_token must fail-fast when the server is enabled",
    );
  });
});

test("config: observability server enabled with whitespace-only auth_token is rejected (issue #5)", async () => {
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
auth_token = "   "
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /auth_token/i,
      "whitespace-only auth_token must fail-fast when the server is enabled",
    );
  });
});

test("config: observability server enabled with ABSENT auth_token is accepted (issue #5)", async () => {
  // Key absent = auth intentionally disabled (localhost-operator default).
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.observability?.server?.enabled, true);
    assert.equal(config.observability?.server?.auth_token, undefined);
  });
});

test("config: observability server enabled with a real auth_token is accepted (issue #5)", async () => {
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
auth_token = "sekret-token"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.observability?.server?.auth_token, "sekret-token");
  });
});
