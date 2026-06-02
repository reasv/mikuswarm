import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxManager } from "../src/sandbox/index.js";
import type { Logger } from "../src/observability/logger.js";

const IMAGE = process.env.MIKUSWARM_SANDBOX_IMAGE ?? "mikuswarm-sandbox:24.04";
const TEST_CONTAINER = "mikuswarm-sandbox-test";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function imageAvailable(): boolean {
  return spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
}

const noDocker = !dockerAvailable();
const noImage = !noDocker && !imageAvailable();
const skip = noDocker
  ? "docker unavailable"
  : noImage
    ? `image ${IMAGE} not built (run docker/build-sandbox.sh)`
    : false;

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

test("sandbox bash: round-trips a command and shares the bind-mounted workspace", { skip }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "miku-sbx-ws-"));
  let manager: SandboxManager | undefined;
  try {
    manager = await SandboxManager.ensure({
      image: IMAGE,
      containerName: TEST_CONTAINER,
      network: "mikuswarm-sandbox-test",
      workspaceHostDir: workspace,
      workspaceMount: "/workspace",
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      execTimeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      logger: silentLogger,
    });

    const echo = await manager.exec("echo hello-sandbox");
    assert.equal(echo.exitCode, 0);
    assert.match(echo.stdout, /hello-sandbox/);

    const pwd = await manager.exec("pwd");
    assert.equal(pwd.stdout.trim(), "/workspace");

    // A file written in-container appears on the host bind mount.
    await manager.exec("echo from-container > made-in-sandbox.txt");
    const onHost = await readFile(path.join(workspace, "made-in-sandbox.txt"), "utf8");
    assert.equal(onHost.trim(), "from-container");

    // Non-zero exit codes are surfaced, not thrown.
    const fail = await manager.exec("exit 7");
    assert.equal(fail.exitCode, 7);

    // AbortSignal cancels a long-running command and leaves NO orphan in the
    // long-lived container (issue #1: the in-container process tree is killed
    // out-of-band, not just the local docker-exec client). A unique sentinel in
    // the command lets us pgrep for survivors afterwards.
    const ac = new AbortController();
    const abortSentinel = `miku-abort-${Date.now()}`;
    const abortStart = Date.now();
    const slow = manager.exec(`sleep 300 # ${abortSentinel}`, { signal: ac.signal });
    ac.abort();
    const slowResult = await slow;
    const abortElapsed = Date.now() - abortStart;
    assert.notEqual(slowResult.exitCode, 0);
    assert.equal(slowResult.timedOut, false, "abort is not a timeout");
    // The awaited abort must resolve promptly — a no-op abort would block on the
    // full `sleep 300`. Bound it well under 300s but above the deterministic
    // KILL_GRACE_SECS (5s) the abort path waits between the in-container TERM and
    // KILL before resolving, so the bound sits above that structural floor.
    // (The out-of-band in-container kill is what unblocks the exec.)
    assert.ok(abortElapsed < 15_000, `abort resolved promptly (took ${abortElapsed}ms)`);
    {
      const survivors = spawnSync(
        "docker",
        ["exec", TEST_CONTAINER, "pgrep", "-fc", abortSentinel],
        { encoding: "utf8" },
      );
      // pgrep exits 1 (no match) -> count "0". Anything else is an orphan.
      assert.equal((survivors.stdout || "0").trim(), "0", "no orphaned process survives an abort");
    }

    // timeout_ms kills the command in-container, flags timedOut, maps to exit
    // 124 (coreutils `timeout`), and leaves no orphan.
    const timeoutSentinel = `miku-timeout-${Date.now()}`;
    const timed = await manager.exec(`sleep 300 # ${timeoutSentinel}`, { timeoutMs: 500 });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.exitCode, 124);
    {
      // Allow the in-container TERM->KILL to settle before checking.
      const settle = spawnSync("docker", ["exec", TEST_CONTAINER, "sleep", "1"]);
      assert.equal(settle.status, 0);
      const survivors = spawnSync(
        "docker",
        ["exec", TEST_CONTAINER, "pgrep", "-fc", timeoutSentinel],
        { encoding: "utf8" },
      );
      assert.equal((survivors.stdout || "0").trim(), "0", "no orphaned process survives a timeout");
    }
  } finally {
    await manager?.shutdown({ stop: true });
    spawnSync("docker", ["rm", "-f", TEST_CONTAINER], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", "mikuswarm-sandbox-test"], { stdio: "ignore" });
    await rm(workspace, { recursive: true, force: true });
  }
});
