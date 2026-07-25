import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { startMikuAgent, type StartMikuAgentOptions } from "../src/app.js";
import { makeFakeProvider } from "./helpers/fake-provider.js";

function fakeProviderOpts(): StartMikuAgentOptions {
  return { providers: new Map([["fake", makeFakeProvider().provider]]) };
}

// A complete, env-free config that reaches startMikuAgent's diary fail-fast block
// (issue #3). Matrix is disabled and summarization is disabled, so the only
// runtime-level validation exercised is the diary one. The diary session type is
// appended per-test to vary its `tools` allowlist.
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
input_modalities = ["text"]
max_tokens = 1024
# Required for any session-resolved model (spec CONTEXT-LIMIT-UNIFICATION §2.5).
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
enabled = false

[diary]
enabled = true
`;

async function withWorkspace(
  diarySessionTypeBlock: string,
  fn: (config: Awaited<ReturnType<typeof loadConfig>>) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "miku-diary-failfast-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "miku-diary-failfast-cfg-"));
  try {
    await writeFile(
      path.join(configDir, "00-test.toml"),
      `${BASE_CONFIG(workspaceRoot)}${diarySessionTypeBlock}`,
      "utf8",
    );
    const config = await loadConfig(configDir, { env: false });
    await fn(config);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
}

test("startup throws when the diary session type omits diary_tool from its tools allowlist (issue #3)", async () => {
  const block = `
[agent.session_types.diary]
tools = ["search_memory"]
`;
  await withWorkspace(block, async (config) => {
    await assert.rejects(
      () => startMikuAgent(config, fakeProviderOpts()),
      /diary_tool/,
      "a diary allowlist without diary_tool must fail-fast at startup",
    );
  });
});

test("startup does not raise the diary_tool fail-fast when the allowlist includes diary_tool (issue #3)", async () => {
  // A valid allowlist must clear the diary fail-fast block. Full startup proceeds
  // past it (and later fails for unrelated reasons in this stub config — e.g. the
  // disabled matrix account), so we assert the diary_tool error is NOT raised
  // rather than asserting a clean start.
  const block = `
[agent.session_types.diary]
tools = ["diary_tool"]
`;
  await withWorkspace(block, async (config) => {
    let runtime: Awaited<ReturnType<typeof startMikuAgent>> | undefined;
    try {
      runtime = await startMikuAgent(config, fakeProviderOpts());
    } catch (error) {
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /diary_tool/,
        "a valid diary allowlist must pass the diary_tool fail-fast",
      );
    } finally {
      if (runtime) await runtime.stop();
    }
  });
});
