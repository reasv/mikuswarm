import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserSession, type ConnectOverCdp } from "../src/browser/session.js";
import { isBrowserError } from "../src/browser/errors.js";
import type { BrowserConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/logger.js";

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function baseConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
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
    nav_timeout_ms: 30000,
    act_timeout_ms: 15000,
    connect_timeout_ms: 20000,
    session_page_idle_ms: 600000,
    ...overrides,
  };
}

// ── Fakes ──────────────────────────────────────────────────────────────────

interface FakePage {
  _closed: boolean;
  isClosed(): boolean;
  close(): Promise<void>;
  on(): void;
  url(): string;
  title(): Promise<string>;
}

function makeFakePage(): FakePage {
  const page: FakePage = {
    _closed: false,
    isClosed: () => page._closed,
    close: async () => { page._closed = true; },
    on: () => {},
    url: () => "about:blank",
    title: async () => "",
  };
  return page;
}

interface FakeBrowser {
  _connected: boolean;
  _disconnect(): void;
  contexts(): unknown[];
  isConnected(): boolean;
  on(event: string, cb: () => void): void;
  close(): Promise<void>;
  pages: FakePage[];
}

function makeFakeBrowser(): FakeBrowser {
  const pages: FakePage[] = [];
  let disconnectCb: (() => void) | undefined;
  const context = {
    newPage: async () => { const p = makeFakePage(); pages.push(p); return p; },
    pages: () => pages,
  };
  const browser: FakeBrowser = {
    _connected: true,
    _disconnect() { browser._connected = false; disconnectCb?.(); },
    contexts: () => [context],
    isConnected: () => browser._connected,
    on: (event, cb) => { if (event === "disconnected") disconnectCb = cb; },
    close: async () => { browser._connected = false; },
    pages,
  };
  return browser;
}

interface ManagerStubOptions {
  profiles?: Array<{ id: string; name: string; status: string }>;
  status?: string; // status returned by GET .../status
  throwOnFetch?: boolean;
}

interface ManagerStub {
  calls: Array<{ method: string; url: string }>;
  restore(): void;
}

function stubManager(opts: ManagerStubOptions = {}): ManagerStub {
  const original = globalThis.fetch;
  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.throwOnFetch) throw new Error("ECONNREFUSED");
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "GET" && url.endsWith("/api/profiles")) {
      return new Response(JSON.stringify((opts.profiles ?? []).map((p) => ({ ...p, fingerprint_seed: 1, cdp_url: null }))), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/api/profiles")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return new Response(JSON.stringify({ id: "p1", name: body.name, fingerprint_seed: 1, status: "stopped", cdp_url: null }), { status: 201 });
    }
    if (method === "GET" && /\/status$/.test(url)) {
      return new Response(JSON.stringify({ status: opts.status ?? "stopped", cdp_url: null }), { status: 200 });
    }
    if (method === "POST" && /\/launch$/.test(url)) {
      return new Response(JSON.stringify({ profile_id: "p1", status: "running", vnc_ws_port: 6100, display: ":100" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function withWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
  const ws = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-test-"));
  try {
    await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("session: bootstraps a missing profile (create + launch) and connects with the bearer header", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [] });
    const connectCalls: Array<{ endpoint: string; headers?: Record<string, string> }> = [];
    const connect: ConnectOverCdp = async (endpoint, options) => {
      connectCalls.push({ endpoint, headers: options.headers });
      return makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    };
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const page = await session.getActivePage("s1");
      assert.ok(page);
      // Created the profile (POST /api/profiles) and launched it (POST .../launch).
      assert.ok(manager.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/profiles")), "should create profile");
      assert.ok(manager.calls.some((c) => c.method === "POST" && /\/launch$/.test(c.url)), "should launch profile");
      // Connected to the right CDP endpoint with the Authorization header.
      assert.equal(connectCalls.length, 1);
      assert.match(connectCalls[0]!.endpoint, /\/api\/profiles\/p1\/cdp$/);
      assert.equal(connectCalls[0]!.headers?.Authorization, "Bearer test-tok");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session: reuses an existing running profile (no create, no launch)", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      await session.getActivePage("s1");
      assert.ok(!manager.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/profiles")), "must not create");
      assert.ok(!manager.calls.some((c) => /\/launch$/.test(c.url)), "must not launch an already-running profile");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session: each chat session gets isolated tabs; connects only once", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    let connectCount = 0;
    const browser = makeFakeBrowser();
    const connect: ConnectOverCdp = async () => { connectCount++; return browser as unknown as Awaited<ReturnType<ConnectOverCdp>>; };
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const p1 = await session.getActivePage("s1");
      const p2 = await session.getActivePage("s2");
      assert.notEqual(p1, p2, "different sessions get different pages");
      // A single shared connection backs both sessions.
      assert.equal(connectCount, 1);
      // s1 can open a second tab without affecting s2.
      await session.openTab("s1");
      const tabsS1 = await session.listTabs("s1");
      const tabsS2 = await session.listTabs("s2");
      assert.equal(tabsS1.length, 2);
      assert.equal(tabsS2.length, 1);
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session: closeSession closes that session's tabs only", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const p1 = await session.getActivePage("s1") as unknown as FakePage;
      await session.getActivePage("s2");
      await session.closeSession("s1");
      assert.equal(p1._closed, true, "s1 tab closed");
      assert.equal((await session.listTabs("s2")).length, 1, "s2 untouched");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session: transparently reconnects after the browser disconnects", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    let connectCount = 0;
    const browsers: FakeBrowser[] = [];
    const connect: ConnectOverCdp = async () => {
      connectCount++;
      const b = makeFakeBrowser();
      browsers.push(b);
      return b as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    };
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      await session.getActivePage("s1");
      assert.equal(connectCount, 1);
      browsers[0]!._disconnect();
      // Next use reconnects and gives the session a fresh page.
      const page = await session.getActivePage("s1");
      assert.ok(page);
      assert.equal(connectCount, 2);
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session: a down Manager surfaces backend_unavailable (graceful degradation)", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ throwOnFetch: true });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      await assert.rejects(
        () => session.getActivePage("s1"),
        (err: unknown) => isBrowserError(err) && err.code === "backend_unavailable",
      );
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});
