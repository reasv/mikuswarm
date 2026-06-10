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

// ---------------------------------------------------------------------------
// guardedFetch redirect-chain behaviour (per-hop slots + WHATWG redirect
// semantics). Guard-enabled tests use public IP-literal hosts so
// assertPublicHttpUrl never touches DNS; fetch is stubbed throughout.
// ---------------------------------------------------------------------------

// Distinct public (TEST-NET) hosts; different origins.
const HOST_A = "203.0.113.1";
const HOST_B = "198.51.100.2";

interface RecordedCall {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // Snapshot headers — guardedFetch mutates its headers object across hops.
    const snapshot = { ...(init ?? {}), headers: { ...(init as { headers?: Record<string, string> } | undefined)?.headers } };
    calls.push({ url, init: snapshot as RecordedCall["init"] });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function redirectResponse(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

test("redirect hop to a different host swaps the per-host slot (old released, new held)", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 1, globalCeiling: 100 });
  let releaseHopFetch!: () => void;
  const hopFetchGate = new Promise<void>((resolve) => { releaseHopFetch = resolve; });
  const stub = stubFetch(async (url) => {
    if (url.includes(HOST_A)) return redirectResponse(302, `https://${HOST_B}/target`);
    await hopFetchGate; // hold the hop fetch open so we can inspect slot state
    return new Response("ok", { status: 200 });
  });
  try {
    const pending = guardedFetch(`https://${HOST_A}/start`);
    // Wait until the hop fetch (host B) is in flight.
    while (stub.calls.length < 2) await delay(5);
    // Host A's slot must be free again (cap is 1) ...
    const releaseA = await acquireHttpSlot(`https://${HOST_A}/probe`);
    releaseA();
    // ... and host B's slot must be held by the in-flight hop.
    let acquiredB = false;
    const probeB = acquireHttpSlot(`https://${HOST_B}/probe`).then((release) => {
      acquiredB = true;
      return release;
    });
    await delay(20);
    assert.equal(acquiredB, false, "hop host slot is held while the hop is in flight");
    releaseHopFetch();
    const response = await pending;
    assert.equal(response.status, 200);
    (await probeB)(); // hop settled → slot freed → probe acquires
    assert.equal(acquiredB, true, "hop host slot is released when the chain settles");
  } finally {
    stub.restore();
    resetHttpLimiter();
  }
});

test("redirect hop respects the hop host's backoff (backed-off host not reachable via redirects)", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 100 });
  noteHttpResponse(`https://${HOST_B}/x`, 429, "2"); // host B backed off for 2s
  const stub = stubFetch((url) =>
    url.includes(HOST_A) ? redirectResponse(302, `https://${HOST_B}/target`) : new Response("ok", { status: 200 }),
  );
  try {
    const controller = new AbortController();
    const pending = guardedFetch(`https://${HOST_A}/start`, { signal: controller.signal });
    const settled = pending.then(
      () => "resolved",
      () => "rejected",
    );
    await delay(60);
    assert.equal(stub.calls.length, 1, "the hop to the backed-off host must not be fetched yet");
    controller.abort();
    assert.equal(await settled, "rejected", "abort while gated on the hop host's backoff rejects");
    assert.equal(stub.calls.length, 1, "the backed-off host was never fetched");
  } finally {
    stub.restore();
    resetHttpLimiter();
  }
});

test("guard-disabled path records the throttle against the FINAL host, not the original", async () => {
  resetHttpLimiter();
  configureHttpLimiter({ defaultMaxInFlightPerHost: 10, globalCeiling: 100, backoffBaseMs: 80, backoffMaxMs: 200 });
  setEgressGuardEnabled(false);
  const stub = stubFetch(() => {
    const response = new Response("", { status: 429 });
    Object.defineProperty(response, "url", { value: "https://final.example/landed" });
    return response;
  });
  try {
    await guardedFetch("https://original.example/start");
    // Original host: no backoff recorded → immediate acquire.
    const startOriginal = Date.now();
    (await acquireHttpSlot("https://original.example/again"))();
    assert.ok(Date.now() - startOriginal < 25, "original host must not be backed off");
    // Final host: 429 recorded there → acquire waits out the backoff.
    const startFinal = Date.now();
    (await acquireHttpSlot("https://final.example/again"))();
    assert.ok(Date.now() - startFinal >= 30, "final host carries the backoff");
  } finally {
    stub.restore();
    setEgressGuardEnabled(true);
    resetHttpLimiter();
  }
});

test("cross-origin redirect strips authorization/cookie/proxy-authorization but keeps other headers", async () => {
  resetHttpLimiter();
  const stub = stubFetch((url) =>
    url.includes(HOST_A) ? redirectResponse(302, `https://${HOST_B}/target`) : new Response("ok", { status: 200 }),
  );
  try {
    const response = await guardedFetch(`https://${HOST_A}/start`, {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=abc",
        "Proxy-Authorization": "Basic xyz",
        "X-Custom": "kept",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(stub.calls.length, 2);
    const first = stub.calls[0]!.init.headers;
    assert.equal(first["Authorization"], "Bearer secret", "first hop carries the credential");
    const hop = stub.calls[1]!.init.headers;
    const hopKeys = Object.keys(hop).map((key) => key.toLowerCase());
    assert.ok(!hopKeys.includes("authorization"), "authorization stripped cross-origin");
    assert.ok(!hopKeys.includes("cookie"), "cookie stripped cross-origin");
    assert.ok(!hopKeys.includes("proxy-authorization"), "proxy-authorization stripped cross-origin");
    assert.equal(hop["X-Custom"], "kept", "non-credential headers survive");
    assert.ok(hopKeys.includes("user-agent"), "default User-Agent survives");
  } finally {
    stub.restore();
    resetHttpLimiter();
  }
});

test("303 on POST converts the hop to GET with the body and content headers dropped", async () => {
  resetHttpLimiter();
  const stub = stubFetch((url) =>
    url.endsWith("/start") ? redirectResponse(303, `https://${HOST_A}/result`) : new Response("ok", { status: 200 }),
  );
  try {
    await guardedFetch(`https://${HOST_A}/start`, {
      method: "POST",
      body: '{"a":1}',
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    });
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.init.method, "POST");
    const hop = stub.calls[1]!.init;
    assert.equal(hop.method, "GET", "303 follows as GET");
    assert.equal(hop.body, undefined, "body dropped on the GET conversion");
    const hopKeys = Object.keys(hop.headers).map((key) => key.toLowerCase());
    assert.ok(!hopKeys.includes("content-type"), "content-type dropped with the body");
    assert.equal(hop.headers["Authorization"], "Bearer secret", "same-origin hop keeps the credential");
  } finally {
    stub.restore();
    resetHttpLimiter();
  }
});

test("307 same-origin redirect preserves method, body, and authorization", async () => {
  resetHttpLimiter();
  const stub = stubFetch((url) =>
    url.endsWith("/start") ? redirectResponse(307, `https://${HOST_A}/retry`) : new Response("ok", { status: 200 }),
  );
  try {
    await guardedFetch(`https://${HOST_A}/start`, {
      method: "POST",
      body: '{"a":1}',
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
    });
    assert.equal(stub.calls.length, 2);
    const hop = stub.calls[1]!.init;
    assert.equal(hop.method, "POST", "307 preserves the method");
    assert.equal(hop.body, '{"a":1}', "307 preserves the body");
    assert.equal(hop.headers["Authorization"], "Bearer secret", "same-origin 307 keeps the credential");
    assert.equal(hop.headers["Content-Type"], "application/json", "content headers preserved");
  } finally {
    stub.restore();
    resetHttpLimiter();
  }
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
