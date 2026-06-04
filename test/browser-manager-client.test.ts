import assert from "node:assert/strict";
import test from "node:test";

import { ManagerClient } from "../src/browser/manager-client.js";
import { isBrowserError } from "../src/browser/errors.js";
import type { Logger } from "../src/observability/logger.js";

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Install a fake global fetch; returns the captured calls + a restore fn. */
function stubFetch(handler: (call: FetchCall) => Response): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function client(): ManagerClient {
  return new ManagerClient({
    baseUrl: "http://127.0.0.1:8080/",
    authToken: "secret-tok",
    timeoutMs: 5000,
    logger: silentLogger,
  });
}

test("manager client: lists profiles and sends the bearer header", async () => {
  const { calls, restore } = stubFetch(() =>
    new Response(JSON.stringify([{ id: "p1", name: "miku", fingerprint_seed: 1, status: "stopped", cdp_url: null }]), {
      status: 200,
    }),
  );
  try {
    const profiles = await client().listProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.name, "miku");
    assert.equal(calls[0]!.method, "GET");
    // baseUrl trailing slash is normalized so the path is well-formed.
    assert.equal(calls[0]!.url, "http://127.0.0.1:8080/api/profiles");
    assert.equal(calls[0]!.headers["authorization"], "Bearer secret-tok");
  } finally {
    restore();
  }
});

test("manager client: createProfile posts the body", async () => {
  const { calls, restore } = stubFetch((call) =>
    new Response(JSON.stringify({ id: "p9", name: call.body && (call.body as { name: string }).name, fingerprint_seed: 7, status: "stopped", cdp_url: null }), { status: 201 }),
  );
  try {
    const created = await client().createProfile({ name: "miku", platform: "windows", humanize: true, geoip: false, auto_launch: true });
    assert.equal(created.id, "p9");
    assert.equal(calls[0]!.method, "POST");
    assert.equal((calls[0]!.body as { auto_launch: boolean }).auto_launch, true);
    assert.equal(calls[0]!.headers["content-type"], "application/json");
  } finally {
    restore();
  }
});

test("manager client: 401 maps to auth_failed", async () => {
  const { restore } = stubFetch(() => new Response("Unauthorized", { status: 401 }));
  try {
    await assert.rejects(
      () => client().listProfiles(),
      (err: unknown) => isBrowserError(err) && err.code === "auth_failed",
    );
  } finally {
    restore();
  }
});

test("manager client: a transport failure maps to backend_unavailable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  try {
    await assert.rejects(
      () => client().listProfiles(),
      (err: unknown) => isBrowserError(err) && err.code === "backend_unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("manager client: launch treats 409 (already running) as success via structured status", async () => {
  // Body deliberately omits any "HTTP 409" text — detection must rely on the
  // structured httpStatus field, not a regex over the human-readable message (#7).
  const { calls, restore } = stubFetch(() => new Response(JSON.stringify({ detail: "Profile is already running" }), { status: 409 }));
  try {
    await client().launch("p1"); // must not throw
    assert.equal(calls[0]!.url, "http://127.0.0.1:8080/api/profiles/p1/launch");
  } finally {
    restore();
  }
});

test("manager client: request carries the HTTP status on the BrowserError", async () => {
  const { restore } = stubFetch(() => new Response("boom", { status: 503 }));
  try {
    await assert.rejects(
      () => client().getStatus("p1"),
      (err: unknown) =>
        isBrowserError(err) && err.code === "backend_unavailable" && err.httpStatus === 503,
    );
  } finally {
    restore();
  }
});

test("manager client: launch re-throws a non-409 failure (not tolerated)", async () => {
  // A 500 on launch must surface as profile_launch_failed, not be swallowed.
  const { restore } = stubFetch(() => new Response("internal error", { status: 500 }));
  try {
    await assert.rejects(
      () => client().launch("p1"),
      (err: unknown) => isBrowserError(err) && err.code === "profile_launch_failed",
    );
  } finally {
    restore();
  }
});
