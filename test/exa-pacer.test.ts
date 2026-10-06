import assert from "node:assert/strict";
import test from "node:test";
import { ExaPacer } from "../src/exa/pacer.js";

test("queued cancellations share one wakeup and clear it when the last request leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pacer = new ExaPacer(3, 100000);
  await pacer.run(async () => {});
  const controllers = [new AbortController(), new AbortController()];
  let executed = 0;
  const queued = controllers.map((c) => pacer.run(async () => { executed++; }, c.signal));
  const rejected = queued.map((p) => assert.rejects(p));
  const timer = (pacer as unknown as { wakeup?: ReturnType<typeof setTimeout> }).wakeup;
  assert.ok(timer);
  controllers[0]!.abort();
  assert.equal((pacer as unknown as { wakeup?: ReturnType<typeof setTimeout> }).wakeup, timer);
  controllers[1]!.abort();
  assert.equal((pacer as unknown as { wakeup?: ReturnType<typeof setTimeout> }).wakeup, undefined);
  await Promise.all(rejected);
  t.mock.timers.tick(100000);
  assert.equal(executed, 0);
});

test("a cancelled long pacing wait does not keep a child process alive", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { ExaPacer } from './src/exa/pacer.ts';
    const pacer = new ExaPacer(2, 100000);
    await pacer.run(async () => {});
    const controller = new AbortController();
    const queued = pacer.run(async () => {}, controller.signal);
    controller.abort();
    await queued.catch(() => {});
  `], { cwd: new URL("..", import.meta.url), timeout: 3000, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
