import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireHttpSlot,
  configureHttpLimiter,
  hostOf,
  noteHttpResponse,
  resetHttpLimiter,
} from "../src/tools/http-limiter.js";
import { guardedFetch, setEgressGuardEnabled } from "../src/tools/ssrf.js";

// ---------------------------------------------------------------------------
// Per-host HTTP egress limiter (spec CONCURRENCY-AND-RATE-LIMITING §8 / Design D).
//
// Per-host admission concurrency + a global backstop + unconditional 429/503
// backoff shared across all callers to a host.
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("hostOf extracts the lowercase hostname", () => {
  assert.equal(hostOf("https://Example.COM/path?q=1"), "example.com");
  assert.equal(hostOf("http://cdn.example.org:8080/a"), "cdn.example.org");
});

test("per-host concurrency cap blocks the 3rd acquire until a release", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 2, globalCeiling: 100 });
  const url = "https://a.example/x";
  const r1 = await acquireHttpSlot(url);
  const r2 = await acquireHttpSlot(url);

  let thirdResolved = false;
  const p3 = acquireHttpSlot(url).then((release) => {
    thirdResolved = true;
    return release;
  });
  await delay(10);
  assert.equal(thirdResolved, false, "3rd acquire must wait at the per-host cap");

  r1();
  const r3 = await p3;
  assert.equal(thirdResolved, true, "release frees the 3rd acquire");
  r2();
  r3();
  resetHttpLimiter();
});

test("global ceiling caps total in-flight across distinct hosts", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 2 });
  const r1 = await acquireHttpSlot("https://h1.example/a");
  const r2 = await acquireHttpSlot("https://h2.example/b");

  let thirdResolved = false;
  const p3 = acquireHttpSlot("https://h3.example/c").then((release) => {
    thirdResolved = true;
    return release;
  });
  await delay(10);
  assert.equal(thirdResolved, false, "global ceiling blocks the 3rd host");

  r1();
  const r3 = await p3;
  assert.equal(thirdResolved, true);
  r2();
  r3();
  resetHttpLimiter();
});

test("a 429 without Retry-After backs off subsequent acquires to that host", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 100, backoffBaseMs: 50, backoffMaxMs: 100 });
  const url = "https://c.example/z";
  noteHttpResponse(url, 429, null);

  const start = Date.now();
  const release = await acquireHttpSlot(url);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 20, `expected a backoff wait, got ${elapsed}ms`);
  release();
  resetHttpLimiter();
});

test("a 503 backs off; a later success does not extend the window", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 100, backoffBaseMs: 40, backoffMaxMs: 80 });
  const url = "https://svc.example/q";
  noteHttpResponse(url, 503, null);
  noteHttpResponse(url, 200, null); // resets the throttle streak, not the existing window

  const start = Date.now();
  const release = await acquireHttpSlot(url);
  assert.ok(Date.now() - start >= 15, "the 503 backoff window is still honoured");
  release();
  resetHttpLimiter();
});

test("Retry-After (delta-seconds) is honoured and the wait is abortable", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 100 });
  const url = "https://d.example/w";
  noteHttpResponse(url, 429, "1"); // 1s

  const controller = new AbortController();
  let resolved = false;
  const pending = acquireHttpSlot(url, controller.signal).then(
    () => { resolved = true; },
    () => { /* aborted — expected */ },
  );
  await delay(100);
  assert.equal(resolved, false, "still backing off well before the 1s Retry-After");
  controller.abort(); // cancel the pending wait so no timer dangles
  await pending;
  resetHttpLimiter();
});

test("acquiring with an already-aborted signal rejects", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 1, globalCeiling: 100 });
  const url = "https://e.example/p";
  const held = await acquireHttpSlot(url); // occupy the only slot
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => acquireHttpSlot(url, controller.signal));
  held();
  resetHttpLimiter();
});

test("guardedFetch records a host 429 so the next call to that host backs off", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 100, backoffBaseMs: 80, backoffMaxMs: 200 });
  setEgressGuardEnabled(false); // skip DNS; exercise the limiter wiring in guardedFetch
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 429 })) as typeof fetch;
  try {
    await guardedFetch("https://throttled.example/1");
    const start = Date.now();
    await guardedFetch("https://throttled.example/2");
    assert.ok(Date.now() - start >= 30, "second call to the same host backed off");
  } finally {
    globalThis.fetch = original;
    setEgressGuardEnabled(true);
    resetHttpLimiter();
  }
});
