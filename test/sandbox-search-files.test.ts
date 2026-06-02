import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRipgrep } from "../src/tools/file.js";
import type { ExecBackend, ExecOptions, ExecResult } from "../src/sandbox/index.js";

function fakeBackend(reply: Partial<ExecResult>): { backend: ExecBackend; calls: { command: string; options?: ExecOptions }[] } {
  const calls: { command: string; options?: ExecOptions }[] = [];
  const backend: ExecBackend = {
    async exec(command, options) {
      calls.push({ command, options });
      return { stdout: "", stderr: "", exitCode: 0, truncated: false, timedOut: false, ...reply };
    },
  };
  return { backend, calls };
}

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-rg-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runRipgrep (sandbox): builds a quoted rg command and parses matches", async () => {
  await withWorkspace(async (root) => {
    const { backend, calls } = fakeBackend({
      stdout: "src/a.ts:1:hello world\nsrc/b.ts:5:hello world\n",
      exitCode: 0,
    });
    const result = await runRipgrep(root, { pattern: "hello world", path: ".", max_results: 100 }, backend);

    assert.equal(calls.length, 1);
    const cmd = calls[0].command;
    assert.ok(cmd.startsWith("'rg' "), "command runs rg");
    assert.ok(cmd.includes("'--line-number'"), "keeps the standard flags");
    assert.ok(cmd.includes("'hello world'"), "pattern is single-quoted");
    assert.ok(cmd.includes("'.'"), "relative path target is passed");

    assert.equal(result.details.count, 2);
    assert.equal(result.details.truncated, false);
    assert.match(result.text, /src\/a\.ts:1:hello world/);
  });
});

test("runRipgrep (sandbox): exit 1 with empty stdout means no matches", async () => {
  await withWorkspace(async (root) => {
    const { backend } = fakeBackend({ stdout: "", exitCode: 1 });
    const result = await runRipgrep(root, { pattern: "nope", path: "." }, backend);
    assert.equal(result.text, "No matches.");
    assert.equal(result.details.count, 0);
  });
});

test("runRipgrep (sandbox): exit > 1 throws with stderr", async () => {
  await withWorkspace(async (root) => {
    const { backend } = fakeBackend({ stdout: "", stderr: "rg: bad regex", exitCode: 2 });
    await assert.rejects(
      () => runRipgrep(root, { pattern: "(", path: "." }, backend),
      /ripgrep failed \(exit 2\): rg: bad regex/,
    );
  });
});

test("runRipgrep (sandbox): respects max_results and reports truncation", async () => {
  await withWorkspace(async (root) => {
    const stdout = Array.from({ length: 5 }, (_, i) => `f.ts:${i + 1}:m`).join("\n") + "\n";
    const { backend } = fakeBackend({ stdout, exitCode: 0 });
    const result = await runRipgrep(root, { pattern: "m", path: ".", max_results: 2 }, backend);
    assert.equal(result.details.count, 5);
    assert.equal(result.details.truncated, true);
    assert.equal(result.text.split("\n").length, 2);
  });
});

test("runRipgrep (sandbox): single quotes in the pattern are escaped", async () => {
  await withWorkspace(async (root) => {
    const { backend, calls } = fakeBackend({ stdout: "", exitCode: 1 });
    await runRipgrep(root, { pattern: "it's", path: "." }, backend);
    // single-quote-escape: ' -> '\''
    assert.ok(calls[0].command.includes("'it'\\''s'"), `got: ${calls[0].command}`);
  });
});
