import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { startMikuAgent } from "../src/app.js";

// A complete, env-free config that reaches startMikuAgent's summarization fail-fast
// block (the symmetric sibling of the diary #3 check). Matrix is disabled
// (provider.start is a no-op) and diary is disabled, so the only runtime-level
// validation exercised is the summarization one. The summarize/condense session
// types are appended per-test to vary their `tools` allowlists.
const BASE_CONFIG = (workspaceRoot: string) => `
[app]
name = "mikuswarm"
data_dir = "${workspaceRoot}/var"
log_level = "error"
context_dump_dir = "${workspaceRoot}/debug/context"

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
# Required for any session-resolved model (spec CONTEXT-LIMIT-UNIFICATION §2.5);
# validateContextTokenCeilings fail-fasts at startup without it.
context_window = 128000

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[workspace]
root_dir = "${workspaceRoot}/workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "${workspaceRoot}/var/test"

[summarization]
enabled = true

[diary]
enabled = false
`;

async function withWorkspace(
  sessionTypeBlocks: string,
  fn: (config: Awaited<ReturnType<typeof loadConfig>>) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "miku-summ-failfast-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "miku-summ-failfast-cfg-"));
  try {
    await writeFile(
      path.join(configDir, "00-test.toml"),
      `${BASE_CONFIG(workspaceRoot)}${sessionTypeBlocks}`,
      "utf8",
    );
    const config = await loadConfig(configDir, { env: false });
    await fn(config);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
}

test("startup throws when the summarize session type omits summary_tool from its tools allowlist", async () => {
  // `summarize` is validated first in the fail-fast loop; a bad allowlist there
  // must abort startup before the (valid) condense type is reached.
  const block = `
[agent.session_types.summarize]
tools = ["search_memory"]

[agent.session_types.condense]
tools = ["summary_tool"]
`;
  await withWorkspace(block, async (config) => {
    await assert.rejects(
      () => startMikuAgent(config),
      /summary_tool/,
      "a summarize allowlist without summary_tool must fail-fast at startup",
    );
  });
});

test("startup throws when the condense session type omits summary_tool from its tools allowlist", async () => {
  // `summarize` is valid here, so the loop must continue to `condense` and throw on
  // its bad allowlist — proving both members of the loop are checked.
  const block = `
[agent.session_types.summarize]
tools = ["summary_tool"]

[agent.session_types.condense]
tools = ["search_memory"]
`;
  await withWorkspace(block, async (config) => {
    await assert.rejects(
      () => startMikuAgent(config),
      /summary_tool/,
      "a condense allowlist without summary_tool must fail-fast at startup",
    );
  });
});

test("startup does not raise the summary_tool fail-fast when both allowlists include summary_tool", async () => {
  // Valid allowlists must clear the summarization fail-fast block. Full startup
  // proceeds past it (and later fails for unrelated reasons in this stub config —
  // e.g. the disabled matrix account), so we assert the summary_tool error is NOT
  // raised rather than asserting a clean start.
  const block = `
[agent.session_types.summarize]
tools = ["summary_tool"]

[agent.session_types.condense]
tools = ["summary_tool"]
`;
  await withWorkspace(block, async (config) => {
    let runtime: Awaited<ReturnType<typeof startMikuAgent>> | undefined;
    try {
      runtime = await startMikuAgent(config);
    } catch (error) {
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /summary_tool/,
        "valid summarize/condense allowlists must pass the summary_tool fail-fast",
      );
    } finally {
      if (runtime) await runtime.stop();
    }
  });
});
