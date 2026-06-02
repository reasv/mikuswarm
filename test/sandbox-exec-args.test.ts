import assert from "node:assert/strict";
import test from "node:test";
import { buildDockerExecArgs, mapContainerCwd } from "../src/sandbox/index.js";

test("buildDockerExecArgs: minimal command (no explicit timeout/marker)", () => {
  const args = buildDockerExecArgs({
    containerName: "miku-sbx",
    command: "echo hi",
    workdir: "/workspace",
  });
  // The command always runs under coreutils `timeout` so its tree gets its own
  // process group (killed as a unit on timeout/abort — issue #1). With no
  // explicit limit the duration is a large sentinel.
  assert.deepEqual(args.slice(0, 5), ["exec", "-i", "-w", "/workspace", "miku-sbx"]);
  assert.deepEqual(args.slice(5, 10), ["timeout", "-s", "TERM", "-k", "5"]);
  assert.ok(Number(args[10]) > 1_000_000);
  assert.deepEqual(args.slice(11), ["/bin/sh", "-lc", "echo hi"]);
});

test("buildDockerExecArgs: env entries become -e, PATH is skipped", () => {
  const args = buildDockerExecArgs({
    containerName: "c",
    command: "true",
    workdir: "/workspace/sub",
    env: { FOO: "bar", PATH: "/should/not/leak" },
  });
  assert.ok(args.includes("-e"));
  assert.ok(args.includes("FOO=bar"));
  assert.ok(!args.some((a) => a.startsWith("PATH=")), "PATH must not be passed via -e");
  // container/shell tail is preserved (under the `timeout` wrapper)
  assert.deepEqual(args.slice(-3), ["/bin/sh", "-lc", "true"]);
  assert.ok(args.includes("timeout"));
});

test("mapContainerCwd: defaults to the mount root", () => {
  assert.equal(mapContainerCwd("/workspace"), "/workspace");
  assert.equal(mapContainerCwd("/workspace", "."), "/workspace");
});

test("mapContainerCwd: joins a relative cwd under the mount", () => {
  assert.equal(mapContainerCwd("/workspace", "a/b"), "/workspace/a/b");
  assert.equal(mapContainerCwd("/workspace", "./a/b"), "/workspace/a/b");
});

test("mapContainerCwd: rejects `..` escapes", () => {
  assert.throws(() => mapContainerCwd("/workspace", "../etc"), /escapes workspace/);
  assert.throws(() => mapContainerCwd("/workspace", "a/../../b"), /escapes workspace/);
});

test("mapContainerCwd: rejects absolute cwd", () => {
  assert.throws(() => mapContainerCwd("/workspace", "/etc/passwd"), /escapes workspace/);
});
