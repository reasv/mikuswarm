import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { startMikuAgent } from "../src/app.js";

// Startup fail-fast for the browser-download staging config (issues #1 and #13).
// A complete, env-free config that reaches startMikuAgent's `[browser]` download
// validation block. Matrix is disabled (provider.start is a no-op) and the worker
// pools are disabled, so the [browser] block is the validation under test. The
// download keys are appended per-test.
//
// Covers the cross-field "must be set together" check (issue #21), #1's
// writability/deletability probe, and #13's absolute-path requirement.
const BASE_CONFIG = (workspaceRoot: string, browserBlock: string) => `
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
enabled = false

[browser]
enabled = true
manager_url = "http://localhost:8080"
profile_name = "test"
platform = "windows"
humanize = false
evaluate_enabled = false
geoip = false
dialog_policy = "dismiss"
snapshot_max_chars = 20000
snapshot_max_frames = 10
nav_timeout_ms = 30000
act_timeout_ms = 15000
connect_timeout_ms = 20000
session_page_idle_ms = 600000
${browserBlock}
`;

async function withConfig(
  browserBlock: string,
  fn: (config: Awaited<ReturnType<typeof loadConfig>>, workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-dl-failfast-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-dl-failfast-cfg-"));
  try {
    await writeFile(path.join(configDir, "00-test.toml"), BASE_CONFIG(workspaceRoot, browserBlock), "utf8");
    const config = await loadConfig(configDir, { env: false });
    await fn(config, workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
}

test("startup rejects a relative downloads_dir (issue #13)", async () => {
  const block = `
downloads_dir = "downloads"
downloads_local_dir = "${path.join(os.tmpdir(), "miku-dl-staging-rel")}"
`;
  await withConfig(block, async (config) => {
    await assert.rejects(
      () => startMikuAgent(config),
      /downloads_dir.*must be an absolute path/,
      "a relative downloads_dir must fail-fast at startup",
    );
  });
});

test("startup rejects downloads_dir set WITHOUT downloads_local_dir (issue #21 cross-field)", async () => {
  // Exactly one of the two keys is a broken topology, not a partial opt-in: the
  // pair describes ONE shared staging volume from two containers' viewpoints.
  await withConfig(`downloads_dir = "/downloads"\n`, async (config) => {
    await assert.rejects(
      () => startMikuAgent(config),
      /must be set together/,
      "downloads_dir alone must fail-fast at startup",
    );
  });
});

test("startup rejects downloads_local_dir set WITHOUT downloads_dir (issue #21 cross-field)", async () => {
  await withConfig(
    `downloads_local_dir = "${path.join(os.tmpdir(), "miku-dl-staging-lonely")}"\n`,
    async (config) => {
      await assert.rejects(
        () => startMikuAgent(config),
        /must be set together/,
        "downloads_local_dir alone must fail-fast at startup",
      );
    },
  );
});

test("startup accepts NEITHER key set — browser downloads disabled, no cross-field/probe error (issue #21)", async () => {
  // Both unset ⇒ downloads disabled (explicit opt-in). Startup must clear the
  // cross-field check, the absolute-path check, and the probe (the probe only
  // runs when downloads_local_dir is set), then fail later for the unrelated
  // disabled-matrix reason in this stub config — so we assert NONE of the three
  // browser-download errors is raised.
  await withConfig("", async (config) => {
    let runtime: Awaited<ReturnType<typeof startMikuAgent>> | undefined;
    try {
      runtime = await startMikuAgent(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /must be set together/, "neither key set must pass the cross-field check");
      assert.doesNotMatch(message, /must be an absolute path/, "neither key set must pass the absolute-path check");
      assert.doesNotMatch(message, /not writable\+deletable/, "no probe runs when downloads_local_dir is unset");
    } finally {
      if (runtime) await runtime.stop();
    }
  });
});

test("startup accepts an absolute downloads_dir over the absolute-path check (issue #13)", async () => {
  // An absolute downloads_dir + a writable downloads_local_dir clears both the
  // absolute-path check and the probe; startup proceeds past them (and later
  // fails for unrelated reasons in this stub config — the disabled matrix
  // account), so we assert NEITHER browser-download error is raised.
  await withConfig(
    `
downloads_dir = "/downloads"
downloads_local_dir = "${path.join(os.tmpdir(), "miku-dl-staging-ok")}"
`,
    async (config) => {
      let runtime: Awaited<ReturnType<typeof startMikuAgent>> | undefined;
      try {
        runtime = await startMikuAgent(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, /must be an absolute path/, "absolute downloads_dir must pass #13");
        assert.doesNotMatch(message, /not writable\+deletable/, "writable staging dir must pass #1's probe");
      } finally {
        if (runtime) await runtime.stop();
      }
    },
  );
});

test("startup probe fails fast when the staging dir is not writable+deletable (issue #1)", { skip: process.getuid?.() === 0 }, async () => {
  // chmod can't restrict root, so the probe-failure case is meaningful only as a
  // non-root user. Pre-create the staging dir, then make it read-only: the
  // recursive mkdir is a no-op on the existing dir, but the probe's create+unlink
  // fails with EACCES — exactly the root-owned-bind-dir leak the probe catches.
  await withConfig("", async (config, workspaceRoot) => {
    const { chmod, mkdir } = await import("node:fs/promises");
    const staging = path.join(workspaceRoot, "browser-downloads");
    await mkdir(staging, { recursive: true });
    await chmod(staging, 0o555);
    (config.browser as { downloads_dir?: string }).downloads_dir = "/downloads";
    (config.browser as { downloads_local_dir?: string }).downloads_local_dir = staging;
    try {
      await assert.rejects(
        () => startMikuAgent(config),
        /not writable\+deletable/,
        "a non-writable+deletable staging dir must fail the startup probe",
      );
      // No stray probe file may be left behind in the staging dir.
      const { readdir } = await import("node:fs/promises");
      const leftover = (await readdir(staging)).filter((n) => n.startsWith(".write-probe-"));
      assert.deepEqual(leftover, [], "the probe left no probe file behind");
    } finally {
      await chmod(staging, 0o755).catch(() => {});
    }
  });
});
