import assert from "node:assert/strict";
import test from "node:test";
import { WorkerRpc } from "../src/retrieval/onnx/worker-rpc.js";

const url = new URL("./fixtures/retrieval/hang-worker.ts", import.meta.url);
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => "settled" as const, () => "settled" as const), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms).unref())]);

test("worker rpc: an aborted request the child never acknowledges kills the wedged child", async () => {
  let dead: Error | null = null;
  const { rpc } = await WorkerRpc.start(url, "hang", null, { label: "hang", cancelGraceMs: 200, onDead: (e) => (dead = e) });
  const child = (rpc as unknown as { child: { kill(s: string): void } }).child;
  try {
    const a = new AbortController();
    // The child runs requests in order, so once `sleep` replies it is already inside `hang`.
    // Aborting earlier can land the cancel before `hang` starts (both messages in one IPC
    // read on a loaded host); the child then rightly skips it and nothing is wedged.
    const before = rpc.call("sleep", { ms: 20 });
    const hung = rpc.call("hang", null, a.signal).catch((e: Error) => e.name);
    assert.equal(await before, "slept");
    a.abort();
    assert.equal(await hung, "AbortError");
    // A trivial op queued behind the wedged one is rejected once the watchdog fires.
    const queued = rpc.call("ping", null).catch((e: Error) => e.message);
    assert.match(String(await queued), /wedged/);
    assert.equal(rpc.dead, true);
    assert.ok(dead && /wedged/.test((dead as Error).message), "onDead runs so the owner can respawn");
  } finally {
    child.kill("SIGKILL");
  }
});

test("worker rpc: a request past its deadline kills the child; aborts behind a slow healthy request wait their turn", async () => {
  const { rpc } = await WorkerRpc.start(url, "hang", null, { label: "hang", cancelGraceMs: 150 });
  try {
    // A queued abort does not start its grace while an older request is still running.
    const slow = rpc.call("sleep", { ms: 400 });
    const a = new AbortController();
    const queued = rpc.call("ping", null, a.signal).catch((e: Error) => e.name);
    a.abort();
    assert.equal(await queued, "AbortError");
    assert.equal(await slow, "slept");
    assert.equal(rpc.dead, false, "the healthy child acknowledged the cancel and survives");
    assert.equal(await rpc.call("ping", null), "pong");
    await assert.rejects(rpc.call("hang", null, undefined, { timeoutMs: 100 }), /deadline/);
    assert.equal(rpc.dead, true);
  } finally {
    await rpc.close();
  }
});

test("worker rpc: close() has a deadline even when the child is wedged", async () => {
  const { rpc } = await WorkerRpc.start(url, "hang", null, { label: "hang", closeTimeoutMs: 200, cancelGraceMs: 60_000 });
  void rpc.call("hang", null).catch(() => undefined);
  assert.equal(await within(rpc.close(), 3000), "settled");
  assert.equal(rpc.dead, true);
});
