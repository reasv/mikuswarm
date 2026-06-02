import assert from "node:assert/strict";
import test from "node:test";
import { buildDockerExecArgs, mapContainerCwd } from "../src/sandbox/index.js";

test("buildDockerExecArgs: minimal command", () => {
  const args = buildDockerExecArgs({
    containerName: "miku-sbx",
    command: "echo hi",
    workdir: "/workspace",
  });
  assert.deepEqual(args, ["exec", "-i", "-w", "/workspace", "miku-sbx", "/bin/sh", "-lc", "echo hi"]);
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
  // container/shell tail is preserved
  assert.deepEqual(args.slice(-4), ["c", "/bin/sh", "-lc", "true"]);
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
