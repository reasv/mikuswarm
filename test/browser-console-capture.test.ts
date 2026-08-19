import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSession, type ConnectOverCdp } from "../src/browser/session.js";
import type { BrowserConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/logger.js";

// Console capture across the two transports
// (spec/BROWSER-CONSOLE-CAPTURE-STEALTH-FALLBACK.md).
//
// A stealth Chromium (CloakBrowser) suppresses the CDP `Runtime` event stream,
// so Playwright's `console`/`pageerror` events — which are derived from it —
// never fire and the ONLY live channels are the legacy `Console` domain plus a
// page-side hook. A standard Chromium fires both. These tests drive a real
// BrowserSession with a fake page that can emit on either transport
// independently, so both backends are exercised against the same code path.

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function baseConfig(): BrowserConfig {
  return {
    enabled: true,
    manager_url: "http://127.0.0.1:8080",
    auth_token: "test-tok",
    profile_name: "miku",
    platform: "windows",
    fingerprint_seed: 12345,
    humanize: true,
    evaluate_enabled: false,
    proxy: "",
    geoip: false,
    dialog_policy: "dismiss",
    snapshot_max_chars: 20000,
    snapshot_max_frames: 10,
    nav_timeout_ms: 30000,
    act_timeout_ms: 15000,
    connect_timeout_ms: 20000,
    session_page_idle_ms: 600000,
  };
}

function stubManager(): { restore(): void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/profiles")) {
      return new Response(
        JSON.stringify([{ id: "p1", name: "miku", status: "running", fingerprint_seed: 1, cdp_url: null }]),
        { status: 200 },
      );
    }
    if (method === "GET" && /\/status$/.test(url)) {
      return new Response(JSON.stringify({ status: "running", cdp_url: null }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { restore() { globalThis.fetch = original; } };
}

interface Harness {
  /** Emit on the Playwright/`Runtime` transport (dead on a stealth backend). */
  nativeConsole(type: string, text: string): void;
  nativePageError(message: string): void;
  /** Emit on the legacy `Console` domain transport (alive on both backends). */
  cdpConsole(level: string, text: string): void;
  /** Commands sent on our page CDP session, e.g. "Console.enable". */
  sent: string[];
  /** Sources handed to addInitScript / evaluate. */
  injected: string[];
}

function makeBrowser(): { browser: unknown; harness: Harness } {
  let nativeConsoleCb: ((msg: { type(): string; text(): string }) => void) | undefined;
  let nativePageErrorCb: ((err: Error) => void) | undefined;
  let cdpConsoleCb: ((event: unknown) => void) | undefined;
  const sent: string[] = [];
  const injected: string[] = [];

  const cdp = {
    on(event: string, cb: (event: unknown) => void) {
      if (event === "Console.messageAdded") cdpConsoleCb = cb;
    },
    async send(method: string) { sent.push(method); return {}; },
  };
  const fakePage = {
    _closed: false,
    isClosed() { return this._closed; },
    async close() { this._closed = true; },
    on(event: string, cb: (arg: never) => void) {
      if (event === "console") nativeConsoleCb = cb as never;
      else if (event === "pageerror") nativePageErrorCb = cb as never;
    },
    context: () => context,
    async addInitScript(source: string) { injected.push(source); },
    async evaluate(source: string) { injected.push(source); return undefined; },
    url: () => "about:blank",
    title: async () => "",
  };
  const context = {
    newPage: async () => { fakePage._closed = false; return fakePage; },
    pages: () => [fakePage],
    newCDPSession: async () => cdp,
  };
  const browser = {
    _connected: true,
    contexts: () => [context],
    isConnected: () => browser._connected,
    on: () => {},
    close: async () => { browser._connected = false; },
    newBrowserCDPSession: async () => { throw new Error("downloads not configured in this harness"); },
  };
  const harness: Harness = {
    sent,
    injected,
    nativeConsole(type, text) {
      assert.ok(nativeConsoleCb, "native console handler registered");
      nativeConsoleCb!({ type: () => type, text: () => text });
    },
    nativePageError(message) {
      assert.ok(nativePageErrorCb, "native pageerror handler registered");
      nativePageErrorCb!(new Error(message));
    },
    cdpConsole(level, text) {
      assert.ok(cdpConsoleCb, "Console.messageAdded handler registered");
      cdpConsoleCb!({ message: { level, text } });
    },
  };
  return { browser, harness };
}

async function withSession(
  run: (ctx: {
    session: BrowserSession;
    harness: Harness;
    drain: () => Array<{ level: string; text: string }>;
  }) => Promise<void>,
): Promise<void> {
  const manager = stubManager();
  const { browser, harness } = makeBrowser();
  const connect: ConnectOverCdp = async () => browser as never;
  const session = new BrowserSession({
    config: baseConfig(),
    agentTimezone: "UTC",
    workspaceRoot: "/tmp",
    logger: silentLogger,
    connectOverCdp: connect,
  });
  try {
    const page = await session.getActivePage("s1");
    await run({ session, harness, drain: () => session.drainConsole(page) });
  } finally {
    await session.shutdown();
    manager.restore();
  }
}

/** The sentinel the page-side hook stamps on bridged page errors. */
const SENTINEL = "\u0000miku-pageerror\u0000";

test("console capture: the legacy Console transport is enabled and the hook injected", async () => {
  await withSession(async ({ harness }) => {
    assert.ok(harness.sent.includes("Console.enable"), "Console.enable sent on the page CDP session");
    assert.equal(harness.injected.length, 2, "hook installed for future documents AND the current one");
    for (const source of harness.injected) {
      assert.match(source, /__miku_con_hook__/, "injected source is the console hook");
      // Guard the raw-source-string contract: a compiled function would carry
      // esbuild's __name(...) wrapper and throw ReferenceError in the page.
      assert.doesNotMatch(source, /__name\(/, "no esbuild keepNames artifact in the injected source");
    }
  });
});

test("console capture: stealth backend (CDP transport only) buffers console messages", async () => {
  await withSession(async ({ harness, drain }) => {
    // Exactly the CloakBrowser case: the native transport never fires at all.
    harness.cdpConsole("log", "hello-from-page");
    harness.cdpConsole("warning", "careful");
    assert.deepEqual(drain(), [
      { level: "log", text: "hello-from-page" },
      { level: "warning", text: "careful" },
    ]);
  });
});

test("console capture: stealth backend surfaces bridged page errors as pageerror entries", async () => {
  await withSession(async ({ harness, drain }) => {
    harness.cdpConsole("error", `${SENTINEL}boom`);
    assert.deepEqual(drain(), [{ level: "error", text: "boom" }], "sentinel decoded and stripped");
  });
});

test("console capture: standard backend does not double-log when both transports fire", async () => {
  await withSession(async ({ harness, drain }) => {
    // A stock Chromium reports every console call on BOTH channels.
    harness.nativeConsole("log", "once");
    harness.cdpConsole("log", "once");
    assert.deepEqual(drain(), [{ level: "log", text: "once" }], "cross-transport duplicate collapsed");
  });
});

test("console capture: standard backend records one entry per page error", async () => {
  await withSession(async ({ harness, drain }) => {
    // One throw on a stock Chromium produces THREE arrivals: the native
    // pageerror, plus the hook's bridged console.error on each transport.
    harness.nativePageError("boom");
    harness.nativeConsole("error", `${SENTINEL}boom`); // dropped: native path is alive
    harness.cdpConsole("error", `${SENTINEL}boom`); // matched against the native pageerror
    assert.deepEqual(drain(), [{ level: "error", text: "boom" }]);
  });
});

test("console capture: repeated identical logs on one transport are all kept", async () => {
  await withSession(async ({ harness, drain }) => {
    // Same-transport arrivals must never cancel each other, or a page logging in
    // a loop would report a single line.
    for (let i = 0; i < 5; i++) harness.cdpConsole("log", "tick");
    assert.equal(drain().length, 5, "all five occurrences buffered");
  });
});

test("console capture: repeated identical logs pair 1:1 when both transports are live", async () => {
  await withSession(async ({ harness, drain }) => {
    for (let i = 0; i < 3; i++) {
      harness.nativeConsole("log", "tick");
      harness.cdpConsole("log", "tick");
    }
    assert.equal(drain().length, 3, "three real occurrences, three entries");
  });
});

test("console capture: distinct messages are never collapsed", async () => {
  await withSession(async ({ harness, drain }) => {
    harness.cdpConsole("log", "a");
    harness.cdpConsole("error", "a"); // same text, different level
    harness.cdpConsole("log", "b");
    assert.deepEqual(drain(), [
      { level: "log", text: "a" },
      { level: "error", text: "a" },
      { level: "log", text: "b" },
    ]);
  });
});
