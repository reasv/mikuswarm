import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRipgrep } from "../src/tools/file.js";
import type { ExecBackend, ExecOptions, ExecResult } from "../src/sandbox/index.js";

function rgAvailable(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const noRg = !rgAvailable() && "ripgrep (rg) not on PATH";

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

test("runRipgrep (sandbox): backend byte-truncation is surfaced as truncated", async () => {
  await withWorkspace(async (root) => {
    // Output is under the max_results line cap, but the backend clipped it at
    // the byte cap (truncated: true). The reported result must reflect that.
    const { backend } = fakeBackend({ stdout: "src/a.ts:1:hit\n", exitCode: 0, truncated: true });
    const result = await runRipgrep(root, { pattern: "hit", path: ".", max_results: 100 }, backend);
    assert.equal(result.details.truncated, true);
    assert.match(result.text, /\[output truncated\]/);
  });
});

test("runRipgrep (sandbox): no truncation when under line cap and backend not clipped", async () => {
  await withWorkspace(async (root) => {
    const { backend } = fakeBackend({ stdout: "src/a.ts:1:hit\n", exitCode: 0, truncated: false });
    const result = await runRipgrep(root, { pattern: "hit", path: ".", max_results: 100 }, backend);
    assert.equal(result.details.truncated, false);
    assert.doesNotMatch(result.text, /\[output truncated\]/);
  });
});

test("runRipgrep (sandbox): a `-`-prefixed pattern is passed after `--`, not as a flag", async () => {
  await withWorkspace(async (root) => {
    const { backend, calls } = fakeBackend({ stdout: "", exitCode: 1 });
    await runRipgrep(root, { pattern: "-l", path: "." }, backend);
    const cmd = calls[0].command;
    // `--` must appear immediately before the pattern (after all flags/globs).
    assert.ok(cmd.includes("'--' '-l'"), `expected end-of-options separator before pattern; got: ${cmd}`);
  });
});

test("runRipgrep (sandbox): exit 1 WITH stdout is parsed as a match (not 'No matches.')", async () => {
  await withWorkspace(async (root) => {
    // rg exits 1 for "no matches", but a backend can also surface exit 1 with
    // real stdout (e.g. a partial/edge result); the `!result.stdout` guard means
    // non-empty stdout must be treated as a hit, not silently dropped to "No matches.".
    const { backend } = fakeBackend({ stdout: "src/a.ts:1:match\n", exitCode: 1 });
    const result = await runRipgrep(root, { pattern: "match", path: ".", max_results: 100 }, backend);
    assert.notEqual(result.text, "No matches.");
    assert.equal(result.details.count, 1);
    assert.match(result.text, /src\/a\.ts:1:match/);
  });
});

test("runRipgrep (sandbox): a glob value with a space survives quoted into the command", async () => {
  await withWorkspace(async (root) => {
    const { backend, calls } = fakeBackend({ stdout: "", exitCode: 1 });
    await runRipgrep(root, { pattern: "x", path: ".", glob: ["src dir/*.ts"] }, backend);
    const cmd = calls[0].command;
    // The glob (with its embedded space) must be a single single-quoted token
    // following its `--glob` flag, so the space can't word-split in the shell.
    assert.ok(cmd.includes("'--glob' 'src dir/*.ts'"), `glob not preserved as one token; got: ${cmd}`);
  });
});

test("runRipgrep (host backend): finds matches in a real workspace via host rg", { skip: noRg }, async () => {
  await withWorkspace(async (root) => {
    // No sandbox backend → the production default when [sandbox].enabled=false,
    // which shells out to the host `rg` via execFileAsync. Exercise that branch
    // end-to-end against a real file with known content.
    await writeFile(path.join(root, "hello.ts"), "const greeting = 'needle';\nconst other = 1;\n");
    await writeFile(path.join(root, "noise.ts"), "const haystack = 2;\n");

    const result = await runRipgrep(root, { pattern: "needle", path: ".", max_results: 100 });
    assert.equal(result.details.count, 1);
    assert.equal(result.details.truncated, false);
    assert.match(result.text, /hello\.ts:1:.*needle/);
  });
});

test("runRipgrep (host backend): no matches returns 'No matches.' (rg exit 1)", { skip: noRg }, async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "hello.ts"), "const greeting = 'hello';\n");
    const result = await runRipgrep(root, { pattern: "absent_symbol_xyz", path: "." });
    assert.equal(result.text, "No matches.");
    assert.equal(result.details.count, 0);
  });
});

test("runRipgrep (host backend): a `-`-prefixed pattern is searched literally via `--`", { skip: noRg }, async () => {
  await withWorkspace(async (root) => {
    // `--` before the pattern means rg treats `-l` as a search term, not a flag.
    await writeFile(path.join(root, "flags.ts"), "// option -l is documented here\nnothing\n");
    const result = await runRipgrep(root, { pattern: "-l", path: ".", max_results: 100 });
    assert.equal(result.details.count, 1);
    assert.match(result.text, /flags\.ts:1:.*-l/);
  });
});
