import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";

import { FetchClient } from "../src/enrichment/fetch-client.js";
import { setEgressGuardEnabled } from "../src/tools/ssrf.js";

// ---------------------------------------------------------------------------
// Egress guard redirect handling (issue #1 / #5)
//
// The client now always routes through the shared `guardedFetch`, which
// self-gates on the global `network.ssrf_guard` switch (default ON). With the
// guard ON it uses `redirect: "manual"` and re-runs `assertPublicHttpUrl` on
// every `Location` hop before following it. The real risk is a *public* URL that
// 302-redirects to a private/metadata host (169.254.169.254, loopback, ...).
//
// `assertPublicHttpUrl` blocks loopback (127.0.0.1) on the FIRST hop, so we
// cannot start a real redirect chain from a loopback test server. Instead we
// stub `globalThis.fetch` to play back the HTTP responses while keeping the
// REAL guard + REAL redirect loop under test. First hops use public IP literals
// (no DNS) so the guard passes them; the redirect target is what we vary. The
// final test flips the switch OFF to prove the guard can be disabled.
// ---------------------------------------------------------------------------

/** A public IPv4 literal that `assertPublicHttpUrl` accepts without any DNS. */
const PUBLIC_IP_A = "93.184.216.34"; // example.com's documented address
const PUBLIC_IP_B = "198.51.100.7"; // TEST-NET-2 (public per the guard)
const METADATA_IP = "169.254.169.254"; // link-local — must be blocked

type StubResponse = {
  status: number;
  location?: string;
  body?: Buffer;
  contentType?: string;
};

/**
 * Install a `globalThis.fetch` stub that maps each requested URL to a canned
 * response, then restore the original on cleanup. Records every URL the client
 * actually requested so we can assert which hops were attempted.
 */
function stubFetch(routes: (url: string) => StubResponse): {
  requested: string[];
  restore: () => void;
} {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input);
    requested.push(url);
    const r = routes(url);
    const headers = new Headers();
    if (r.location) headers.set("location", r.location);
    if (r.contentType) headers.set("content-type", r.contentType);
    const body = r.status >= 300 && r.status < 400 ? null : (r.body ?? Buffer.alloc(0));
    return new Response(body, { status: r.status, headers });
  }) as typeof globalThis.fetch;
  return { requested, restore: () => void (globalThis.fetch = original) };
}

function makeClient(): FetchClient {
  return new FetchClient({
    timeoutMs: 5_000,
    maxResponseBytes: 10 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Transient-error retry (a connection blip on a CDN asset must not fail the
// tool when an immediate retry would succeed — e.g. the danbooru/media path).
// ---------------------------------------------------------------------------

/** A transient undici-style failure: `TypeError: fetch failed` with a cause code. */
function transientFetchError(code = "ECONNRESET"): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("socket hang up"), { code }),
  });
}

function makeRetryClient(overrides: Partial<ConstructorParameters<typeof FetchClient>[0]> = {}): FetchClient {
  return new FetchClient({
    timeoutMs: 5_000,
    maxResponseBytes: 10 * 1024 * 1024,
    retryBaseDelayMs: 0, // keep the test instant
    ...overrides,
  });
}

test("retries a transient 'fetch failed' and then succeeds", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) throw transientFetchError();
    return new Response(Buffer.from("ok"), { status: 200, headers: new Headers({ "content-type": "image/png" }) });
  }) as typeof globalThis.fetch;
  const client = makeRetryClient();
  let result: Awaited<ReturnType<FetchClient["fetch"]>> | undefined;
  try {
    result = await client.fetch(`http://${PUBLIC_IP_A}/asset.png`);
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 3, "two transient failures then a success (3 attempts total)");
  } finally {
    globalThis.fetch = original;
    if (result) await rm(result.path, { force: true });
    client.stop();
  }
});

test("gives up after maxRetries and surfaces the underlying cause", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    throw transientFetchError("ECONNRESET");
  }) as typeof globalThis.fetch;
  const client = makeRetryClient({ maxRetries: 1 });
  try {
    // The opaque "fetch failed" is replaced with the cause code.
    await assert.rejects(client.fetch(`http://${PUBLIC_IP_A}/asset.png`), /fetch failed \(ECONNRESET\)/);
    assert.equal(calls, 2, "initial try + 1 retry");
  } finally {
    globalThis.fetch = original;
    client.stop();
  }
});

test("does not retry a deterministic size-cap overflow", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(Buffer.alloc(100), { status: 200, headers: new Headers({ "content-type": "image/png" }) });
  }) as typeof globalThis.fetch;
  const client = makeRetryClient({ maxResponseBytes: 10 });
  try {
    await assert.rejects(client.fetch(`http://${PUBLIC_IP_A}/big.png`), /exceeded/i);
    assert.equal(calls, 1, "a deterministic failure must not be retried");
  } finally {
    globalThis.fetch = original;
    client.stop();
  }
});

test("egress guard rejects a 302 redirect to a private/metadata host", async () => {
  const stub = stubFetch((url) => {
    if (url.includes(PUBLIC_IP_A)) return { status: 302, location: `http://${METADATA_IP}/latest/meta-data/` };
    // The metadata host must never be fetched — if we get here the guard failed.
    return { status: 200, body: Buffer.from("SECRET"), contentType: "text/plain" };
  });
  const client = makeClient();
  try {
    await assert.rejects(
      client.fetch(`http://${PUBLIC_IP_A}/start`),
      /private address is blocked|Local/i,
    );
    // The guard validated the first hop, saw the 302, and rejected the target
    // BEFORE issuing a request to the metadata host.
    assert.deepEqual(stub.requested, [`http://${PUBLIC_IP_A}/start`]);
  } finally {
    stub.restore();
    client.stop();
  }
});

test("egress guard follows a 302 between two public hops and returns the final 200", async () => {
  const stub = stubFetch((url) => {
    if (url.includes(PUBLIC_IP_A)) return { status: 302, location: `http://${PUBLIC_IP_B}/final` };
    return { status: 200, body: Buffer.from("payload-bytes"), contentType: "image/png" };
  });
  const client = makeClient();
  let result: Awaited<ReturnType<FetchClient["fetch"]>> | undefined;
  try {
    result = await client.fetch(`http://${PUBLIC_IP_A}/start`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.sizeBytes, Buffer.from("payload-bytes").byteLength);
    assert.equal(result.contentType, "image/png");
    // Both hops were validated and requested, in order.
    assert.deepEqual(stub.requested, [`http://${PUBLIC_IP_A}/start`, `http://${PUBLIC_IP_B}/final`]);
  } finally {
    stub.restore();
    if (result) await rm(result.path, { force: true });
    client.stop();
  }
});

test("egress guard passes through a direct (no-redirect) public 200 unchanged", async () => {
  const stub = stubFetch(() => ({ status: 200, body: Buffer.from("hello"), contentType: "image/jpeg" }));
  const client = makeClient();
  let result: Awaited<ReturnType<FetchClient["fetch"]>> | undefined;
  try {
    result = await client.fetch(`http://${PUBLIC_IP_A}/direct`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.contentType, "image/jpeg");
    assert.equal(result.sizeBytes, 5);
    assert.deepEqual(stub.requested, [`http://${PUBLIC_IP_A}/direct`]);
  } finally {
    stub.restore();
    if (result) await rm(result.path, { force: true });
    client.stop();
  }
});

test("egress guard rejects the initial URL itself when it is a private host", async () => {
  // No redirect needed: the very first assertPublicHttpUrl call must reject.
  const stub = stubFetch(() => ({ status: 200, body: Buffer.from("x") }));
  const client = makeClient();
  try {
    await assert.rejects(
      client.fetch(`http://${METADATA_IP}/`),
      /private address is blocked|Local/i,
    );
    // No network request was made at all.
    assert.deepEqual(stub.requested, []);
  } finally {
    stub.restore();
    client.stop();
  }
});

test("with the egress guard disabled, a private host is NOT rejected (network layer is the boundary)", async () => {
  // network.ssrf_guard=false (e.g. the docker deployment): the app does no
  // address filtering and issues a single redirect:"follow" fetch. The same
  // metadata IP that is rejected above is now requested. Restore the default
  // (ON) afterwards so later tests keep their guarantees.
  const stub = stubFetch(() => ({ status: 200, body: Buffer.from("ok"), contentType: "text/plain" }));
  setEgressGuardEnabled(false);
  const client = makeClient();
  let result: Awaited<ReturnType<FetchClient["fetch"]>> | undefined;
  try {
    result = await client.fetch(`http://${METADATA_IP}/latest/meta-data/`);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(stub.requested, [`http://${METADATA_IP}/latest/meta-data/`]);
  } finally {
    setEgressGuardEnabled(true);
    stub.restore();
    if (result) await rm(result.path, { force: true });
    client.stop();
  }
});
