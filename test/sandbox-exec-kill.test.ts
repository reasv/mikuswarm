import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDockerExecArgs,
  buildAbortKillArgs,
  CappedSink,
  createDockerExecBackend,
  type DockerSpawn,
  type RawExecResult,
} from "../src/sandbox/index.js";

// ---------------------------------------------------------------------------
// Issue #1 — in-container timeout wrapper construction (pure argv)
// ---------------------------------------------------------------------------

test("buildDockerExecArgs: no explicit timeout still wraps in `timeout` (unbounded sentinel) + marker", () => {
  const args = buildDockerExecArgs({
    containerName: "c",
    command: "echo hi",
    workdir: "/workspace",
    marker: "mikuexec_abc",
  });
  // exec -i -w /workspace c timeout -s TERM -k 5 <sentinel> /bin/sh -lc ": mikuexec_abc; echo hi"
  assert.deepEqual(args.slice(0, 5), ["exec", "-i", "-w", "/workspace", "c"]);
  assert.equal(args[5], "timeout");
  assert.deepEqual(args.slice(6, 10), ["-s", "TERM", "-k", "5"]);
  // The sentinel is a large positive integer (30 days), so the command runs
  // effectively unbounded but still inside a killable process group.
  assert.ok(Number(args[10]) > 1_000_000, `expected unbounded sentinel, got ${args[10]}`);
  assert.deepEqual(args.slice(11), ["/bin/sh", "-lc", ": mikuexec_abc; echo hi"]);
});

test("buildDockerExecArgs: a timeout wraps the command in coreutils `timeout -s TERM <secs>`", () => {
  const args = buildDockerExecArgs({
    containerName: "c",
    command: "sleep 30",
    workdir: "/workspace",
    marker: "mikuexec_abc",
    timeoutSecs: 5,
  });
  // The in-container leader is `timeout -s TERM -k <grace> 5 /bin/sh -lc ...`
  assert.deepEqual(args.slice(4), [
    "c", "timeout", "-s", "TERM", "-k", "5", "5",
    "/bin/sh", "-lc", ": mikuexec_abc; sleep 30",
  ]);
  // `timeout` and `-s TERM` must be present so the real tree dies in-container.
  assert.ok(args.includes("timeout"));
  assert.deepEqual([args[args.indexOf("-s")], args[args.indexOf("-s") + 1]], ["-s", "TERM"]);
});

test("buildDockerExecArgs: omitting marker leaves the inner command verbatim", () => {
  const args = buildDockerExecArgs({
    containerName: "c",
    command: "echo hi",
    workdir: "/workspace",
  });
  assert.equal(args.at(-1), "echo hi");
});

test("buildDockerExecArgs: env still becomes -e and PATH is skipped under the wrapper", () => {
  const args = buildDockerExecArgs({
    containerName: "c",
    command: "true",
    workdir: "/workspace",
    env: { FOO: "bar", PATH: "/nope" },
    marker: "mikuexec_x",
  });
  assert.ok(args.includes("FOO=bar"));
  assert.ok(!args.some((a) => a.startsWith("PATH=")));
});

// ---------------------------------------------------------------------------
// Issue #1 — out-of-band abort kill construction (pure argv)
// ---------------------------------------------------------------------------

test("buildAbortKillArgs: targets the container, signals the process group, brackets the marker", () => {
  const args = buildAbortKillArgs({ containerName: "c", marker: "mikuexec_deadbeef", signal: "TERM" });
  assert.deepEqual(args.slice(0, 4), ["exec", "c", "/bin/sh", "-c"]);
  const script = args[4];
  // Self-excluding bracket trick: pattern is `[m]ikuexec_deadbeef` so the
  // pgrep/grep process does not match its own cmdline.
  assert.ok(script.includes("[m]ikuexec_deadbeef"), "marker first char must be bracketed");
  assert.ok(!script.includes("'mikuexec_deadbeef'"), "the bare marker must not appear unbracketed as a pattern");
  // Whole-group kill via negative PGID with the requested signal.
  assert.ok(script.includes("kill -TERM -\"$pgid\""));
  assert.ok(script.includes("pgrep -f"));
  assert.ok(script.includes("pgid="));
});

test("buildAbortKillArgs: KILL variant escalates with SIGKILL", () => {
  const args = buildAbortKillArgs({ containerName: "c", marker: "mikuexec_x", signal: "KILL" });
  assert.ok(args[4].includes("kill -KILL -\"$pgid\""));
});

// ---------------------------------------------------------------------------
// Issue #1 — backend behavior with a mocked docker spawn (no real Docker)
// ---------------------------------------------------------------------------

function fakeResult(over: Partial<RawExecResult> = {}): RawExecResult {
  return { stdout: "", stderr: "", code: 0, truncated: false, timedOut: false, ...over };
}

test("backend: timeout maps exit 124 to timedOut=true and passes timeoutSecs to the wrapper", async () => {
  const calls: { args: string[] }[] = [];
  const spawnDocker: DockerSpawn = async (args) => {
    calls.push({ args });
    return fakeResult({ code: 124 });
  };
  const backend = createDockerExecBackend({
    containerName: "c",
    workspaceMount: "/workspace",
    spawnDocker,
  });
  const result = await backend.exec("sleep 30", { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  // 500ms rounds up to a 1s in-container timeout. The secs value is the
  // `timeout` arg immediately before the `/bin/sh` it wraps.
  const primary = calls[0].args;
  assert.ok(primary.includes("timeout"));
  assert.equal(primary[primary.indexOf("/bin/sh") - 1], "1");
});

test("backend: a non-124 exit under a timeout is NOT reported as timedOut", async () => {
  const spawnDocker: DockerSpawn = async () => fakeResult({ code: 7 });
  const backend = createDockerExecBackend({ containerName: "c", workspaceMount: "/workspace", spawnDocker });
  const result = await backend.exec("exit 7", { timeoutMs: 5000 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test("backend: abort issues the out-of-band in-container kill (TERM then KILL) and does not hang", async () => {
  const killArgs: string[][] = [];
  let primaryResolve: (() => void) | undefined;
  const spawnDocker: DockerSpawn = async (args) => {
    if (args[0] === "exec" && args[1] === "-i") {
      // The primary exec — block until the kill is issued (mirrors how the real
      // `docker exec` client stays alive until the in-container process dies).
      await new Promise<void>((r) => {
        primaryResolve = r;
      });
      return fakeResult({ code: 137 });
    }
    // An abort kill `docker exec c /bin/sh -c '...'`.
    killArgs.push(args);
    // The first kill (TERM) is what unblocks the primary exec.
    primaryResolve?.();
    return fakeResult({ code: 0 });
  };
  const backend = createDockerExecBackend({ containerName: "c", workspaceMount: "/workspace", spawnDocker });
  const ac = new AbortController();
  // Use a tiny grace by aborting; the backend's real KILL_GRACE_SECS (5s) sleep
  // would make this slow, so assert just the TERM kill was issued promptly and
  // the call resolves — the KILL escalation is covered by buildAbortKillArgs.
  const started = Date.now();
  const p = backend.exec("sleep 30", { signal: ac.signal });
  ac.abort();
  const result = await p;
  const elapsed = Date.now() - started;
  // It resolved (did not hang) and surfaced the kill exit.
  assert.equal(result.exitCode, 137);
  // At least the TERM kill was issued against the container with a bracketed marker.
  assert.ok(killArgs.length >= 1, "expected at least the TERM kill");
  const term = killArgs[0];
  assert.deepEqual(term.slice(0, 4), ["exec", "c", "/bin/sh", "-c"]);
  assert.match(term[4], /\[m\]ikuexec_/);
  assert.match(term[4], /kill -TERM /);
  // Resolves within the grace window + slack (well under the 5s KILL escalation
  // plus margin); proves no indefinite hang.
  assert.ok(elapsed < 8000, `abort resolved in ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// Issue #9 — UTF-8 boundary trim in CappedSink
// ---------------------------------------------------------------------------

test("CappedSink: trims a 3-byte char (€) split by the cap, no U+FFFD at the boundary", () => {
  // '€' is E2 82 AC. Cap at a point that lands mid-sequence.
  const prefix = Buffer.from("abc", "utf8"); // 3 bytes
  const euro = Buffer.from("€", "utf8"); // 3 bytes
  // Cap = 3 (prefix) + 1 (first byte of euro) => euro is cut after its lead byte.
  const sink = new CappedSink(4);
  sink.push(Buffer.concat([prefix, euro]));
  assert.equal(sink.overflowed, true, "cap was hit -> truncated reported");
  const out = sink.toString();
  assert.equal(out, "abc", "partial euro byte dropped, no replacement char");
  assert.ok(!out.includes("�"), "no U+FFFD replacement char");
});

test("CappedSink: trims a 4-byte emoji split by the cap", () => {
  const emoji = Buffer.from("😀", "utf8"); // F0 9F 98 80, 4 bytes
  // Cap after 2 bytes of the emoji.
  const sink = new CappedSink(2);
  sink.push(emoji);
  assert.equal(sink.overflowed, true);
  const out = sink.toString();
  assert.equal(out, "", "incomplete emoji dropped");
  assert.ok(!out.includes("�"));
});

test("CappedSink: keeps a complete multi-byte char that lands exactly on the cap", () => {
  const euro = Buffer.from("€", "utf8"); // 3 bytes
  const sink = new CappedSink(3);
  sink.push(euro);
  assert.equal(sink.toString(), "€");
  assert.equal(sink.overflowed, false);
});

test("CappedSink: ASCII content under the cap is unaffected", () => {
  const sink = new CappedSink(1024);
  sink.push(Buffer.from("hello world", "utf8"));
  assert.equal(sink.toString(), "hello world");
  assert.equal(sink.overflowed, false);
});
