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

test("mapContainerCwd: empty cwd hits the `!cwd` guard and returns the mount root", () => {
  assert.equal(mapContainerCwd("/workspace", ""), "/workspace");
});

test("mapContainerCwd: a benign interior `..` resolves in-bounds (not over-rejected)", () => {
  // `a/b/../c` normalizes to `a/c` — the traversal stays inside the workspace,
  // so it must resolve, not throw. Guards against an over-eager `..` check.
  assert.equal(mapContainerCwd("/workspace", "a/b/../c"), "/workspace/a/c");
});

test("mapContainerCwd: joins a relative cwd under the mount", () => {
  assert.equal(mapContainerCwd("/workspace", "a/b"), "/workspace/a/b");
  assert.equal(mapContainerCwd("/workspace", "./a/b"), "/workspace/a/b");
});

test("mapContainerCwd: rejects `..` escapes", () => {
  assert.throws(() => mapContainerCwd("/workspace", "../etc"), /escapes workspace/);
  assert.throws(() => mapContainerCwd("/workspace", "a/../../b"), /escapes workspace/);
  // Over-traversal that normalizes to a bare `..` chain.
  assert.throws(() => mapContainerCwd("/workspace", "a/b/../../.."), /escapes workspace/);
  // A leading `./` does not launder the escape — it normalizes to `../etc`.
  assert.throws(() => mapContainerCwd("/workspace", "./../etc"), /escapes workspace/);
});

test("mapContainerCwd: rejects absolute cwd", () => {
  assert.throws(() => mapContainerCwd("/workspace", "/etc/passwd"), /escapes workspace/);
});

test("buildDockerExecArgs: an env value with `=` and spaces is one -e KEY=value token", () => {
  const args = buildDockerExecArgs({
    containerName: "c",
    command: "true",
    workdir: "/workspace",
    env: { OPTS: "a=b c=d e" },
  });
  // The value (which itself contains `=` and spaces) must survive as a SINGLE
  // argv element immediately after `-e` — not split into multiple tokens.
  const eIndex = args.indexOf("-e");
  assert.notEqual(eIndex, -1, "env produces a -e flag");
  assert.equal(args[eIndex + 1], "OPTS=a=b c=d e");
  // And it appears verbatim as exactly one token in the whole argv.
  assert.equal(args.filter((a) => a === "OPTS=a=b c=d e").length, 1);
});
