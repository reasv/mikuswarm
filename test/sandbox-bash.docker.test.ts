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

    // AbortSignal cancels a long-running command.
    const ac = new AbortController();
    const slow = manager.exec("sleep 30", { signal: ac.signal });
    ac.abort();
    const slowResult = await slow;
    assert.notEqual(slowResult.exitCode, 0);

    // timeout_ms kills the command and flags timedOut.
    const timed = await manager.exec("sleep 30", { timeoutMs: 500 });
    assert.equal(timed.timedOut, true);
  } finally {
    await manager?.shutdown({ stop: true });
    spawnSync("docker", ["rm", "-f", TEST_CONTAINER], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", "mikuswarm-sandbox-test"], { stdio: "ignore" });
    await rm(workspace, { recursive: true, force: true });
  }
});
