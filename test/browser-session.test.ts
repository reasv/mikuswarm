import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

import {
  BrowserSession,
  CONSOLE_ENTRY_MAX_CHARS,
  CONSOLE_TRUNCATION_MARKER,
  dialogOverrideScript,
  type ConnectOverCdp,
} from "../src/browser/session.js";
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
    snapshot_max_frames: 10,
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
  /** Successive statuses returned by GET .../status (overrides `status`). Last value sticks. */
  statusSequence?: string[];
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
      let status = opts.status ?? "stopped";
      if (opts.statusSequence && opts.statusSequence.length > 0) {
        status = opts.statusSequence.length > 1 ? opts.statusSequence.shift()! : opts.statusSequence[0]!;
      }
      return new Response(JSON.stringify({ status, cdp_url: null }), { status: 200 });
    }
    if (method === "POST" && /\/launch$/.test(url)) {
      return new Response(JSON.stringify({ profile_id: "p1", status: "running", vnc_ws_port: 6100, display: ":100" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/**
 * Push a session's lastUsed far into the past so the next sweep considers it
 * idle, without waiting real time. Reaches into private state by design (test
 * seam for the sweeper, issues #1/#22).
 */
function forceIdle(session: BrowserSession, sessionId: string): void {
  const sessions = (session as unknown as { sessions: Map<string, { lastUsed: number }> }).sessions;
  const state = sessions.get(sessionId);
  if (state) state.lastUsed = 0;
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

test("session #5: a late disconnect from an OLD browser does not clobber the new connection", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const browsers: FakeBrowser[] = [];
    const connect: ConnectOverCdp = async () => {
      const b = makeFakeBrowser();
      browsers.push(b);
      return b as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    };
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      // First connection (browser A), with a live tab.
      await session.getActivePage("s1");
      assert.equal(browsers.length, 1);
      // A disconnects → forces a reconnect to browser B on next use.
      browsers[0]!._disconnect();
      await session.getActivePage("s1");
      assert.equal(browsers.length, 2, "reconnected to a new browser");
      assert.equal((await session.listTabs("s1")).length, 1, "B has the session's tab");
      // A late, stale disconnect from the OLD browser A must NOT wipe B's state.
      browsers[0]!._disconnect();
      assert.equal((await session.listTabs("s1")).length, 1, "B's tab survives the stale disconnect");
      // And no spurious reconnect: still on browser B.
      await session.getActivePage("s1");
      assert.equal(browsers.length, 2, "no spurious reconnect after stale disconnect");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #6: concurrent getActivePage for one session opens exactly one tab", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const browser = makeFakeBrowser();
    const connect: ConnectOverCdp = async () => browser as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const [a, b] = await Promise.all([session.getActivePage("s1"), session.getActivePage("s1")]);
      assert.equal(a, b, "both calls resolve to the same page");
      assert.equal((await session.listTabs("s1")).length, 1, "exactly one tab created");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #9: a 401 on the CDP connect surfaces as auth_failed (not connect_failed)", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => { throw new Error("WebSocket error: Unexpected server response: 401 Unauthorized"); };
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      await assert.rejects(
        () => session.getActivePage("s1"),
        (err: unknown) => isBrowserError(err) && err.code === "auth_failed",
      );
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #12: two rapid failing connects within the cooldown only hit the Manager once", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    let connectAttempts = 0;
    const connect: ConnectOverCdp = async () => { connectAttempts++; throw new Error("ECONNRESET during CDP upgrade"); };
    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      await assert.rejects(() => session.getActivePage("s1"), (err: unknown) => isBrowserError(err) && err.code === "connect_failed");
      const callsAfterFirst = manager.calls.length;
      // Second attempt within the cooldown window: returns the cached error,
      // re-hitting neither connectOverCDP nor the Manager.
      await assert.rejects(() => session.getActivePage("s1"), (err: unknown) => isBrowserError(err) && err.code === "connect_failed");
      assert.equal(connectAttempts, 1, "connectOverCDP attempted only once within the cooldown");
      assert.equal(manager.calls.length, callsAfterFirst, "Manager not re-hit within the cooldown");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #13: a cold start (stopped→running) succeeds on the first call via the readiness poll", async () => {
  await withWorkspace(async (ws) => {
    // Profile is stopped, so a launch is issued and the cold-start poll engages.
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "stopped" }], statusSequence: ["stopped", "running"] });
    let attempts = 0;
    const connect: ConnectOverCdp = async () => {
      attempts++;
      // First post-launch attempt fails (not CDP-ready yet); the poll retries.
      if (attempts === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:9222");
      return makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    };
    // Keep the budget comfortably above one poll interval.
    const session = new BrowserSession({ config: baseConfig({ connect_timeout_ms: 5000 }), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const page = await session.getActivePage("s1");
      assert.ok(page, "first call succeeds without surfacing a failed call");
      assert.ok(attempts >= 2, "the poll retried connectOverCDP until ready");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #1: an idle-but-busy session (inFlight>0) is NOT reaped by a sweep", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    // Tiny idle window so the session is "idle" almost immediately, isolating the
    // busy-guard from the elapsed-time check.
    const session = new BrowserSession({ config: baseConfig({ session_page_idle_ms: 30000 }), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const page = await session.getActivePage("s1") as unknown as FakePage;
      // Simulate a long op in flight, then force lastUsed far into the past so the
      // session would be reaped if it weren't for the in-flight guard.
      session.beginOp("s1");
      forceIdle(session, "s1");
      await session.sweepIdleNow();
      assert.equal(page._closed, false, "busy session's page survives the sweep");
      assert.equal((await session.listTabs("s1")).length, 1, "busy session not reaped");
      session.endOp("s1");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #1: an idle-and-quiet session IS reaped by a sweep", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig({ session_page_idle_ms: 30000 }), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const page = await session.getActivePage("s1") as unknown as FakePage;
      forceIdle(session, "s1"); // no in-flight op
      await session.sweepIdleNow();
      assert.equal(page._closed, true, "quiet idle session's page is closed");
      assert.equal((await session.listTabs("s1")).length, 0, "quiet idle session reaped");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #22: a sweep reaps ALL tabs of an idle multi-tab session", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig({ session_page_idle_ms: 30000 }), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      await session.getActivePage("s1");
      await session.openTab("s1");
      await session.openTab("s1");
      assert.equal((await session.listTabs("s1")).length, 3, "precondition: session has three tabs");
      // Grab the actual page objects from the private state (listTabs returns only
      // metadata) so we can assert each underlying tab is closed by the sweep.
      const state = (session as unknown as { sessions: Map<string, { pages: FakePage[] }> }).sessions.get("s1")!;
      const pages = [...state.pages];
      assert.equal(pages.length, 3, "captured all three page objects");

      forceIdle(session, "s1"); // idle and quiet
      await session.sweepIdleNow();

      // Every tab of the reaped session is closed, not just the active one.
      for (const p of pages) assert.equal(p._closed, true, "each idle tab is closed");
      assert.equal((await session.listTabs("s1")).length, 0, "the whole session is reaped");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("session #1: op completion (endOp) refreshes lastUsed so a just-finished op isn't instantly reaped", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    const connect: ConnectOverCdp = async () => makeFakeBrowser() as unknown as Awaited<ReturnType<ConnectOverCdp>>;
    const session = new BrowserSession({ config: baseConfig({ session_page_idle_ms: 30000 }), agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
    try {
      const page = await session.getActivePage("s1") as unknown as FakePage;
      session.beginOp("s1");
      forceIdle(session, "s1");      // op ran long; lastUsed is now stale
      session.endOp("s1");           // completion must refresh lastUsed
      const state = (session as unknown as { sessions: Map<string, { lastUsed: number }> }).sessions.get("s1")!;
      assert.ok(Date.now() - state.lastUsed < 1000, "endOp refreshed lastUsed to ~now");
      await session.sweepIdleNow();
      assert.equal(page._closed, false, "session survives a sweep right after the op completes");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// NOTE (downloads): handleDownload's old saveAs path is gone — downloads now run
// through the cross-container staging pipeline (ARCHITECTURE.md §11b "Downloads"),
// covered in test/browser-downloads.test.ts (incl. the issue-#14 close race, the
// hostile-filename sanitization, and the issue-#12 session-id traversal guard
// formerly tested here against saveAs).

// ── #19: capture per-page dialog/download handlers ───────────────────────────

interface CapturedHandlers {
  dialog?: (dialog: unknown) => void;
  download?: (download: unknown) => void;
}

/**
 * A browser whose single page records the `dialog`/`download` handlers that
 * trackPage registers, so a test can fire them directly with fake events.
 */
function makeHandlerCapturingBrowser(captured: CapturedHandlers): {
  contexts: () => unknown[];
  isConnected: () => boolean;
  on: () => void;
  close: () => Promise<void>;
} {
  const fakePage = {
    _closed: false,
    isClosed() { return this._closed; },
    async close() { this._closed = true; },
    on(event: string, cb: (arg: unknown) => void) {
      if (event === "dialog") captured.dialog = cb;
      if (event === "download") captured.download = cb;
    },
    url: () => "about:blank",
    title: async () => "",
  };
  const context = { newPage: async () => fakePage, pages: () => [fakePage] };
  const browser = {
    _connected: true,
    contexts: () => [context],
    isConnected: () => true,
    on: () => {},
    close: async () => { browser._connected = false; },
  };
  return browser;
}

interface FakeDialog {
  type(): string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
  accepted: boolean;
  dismissed: boolean;
}

function makeFakeDialog(type: "alert" | "confirm" | "prompt"): FakeDialog {
  const d: FakeDialog = {
    type: () => type,
    accept: async () => { d.accepted = true; },
    dismiss: async () => { d.dismissed = true; },
    accepted: false,
    dismissed: false,
  };
  return d;
}

// alert ALWAYS accepts (nothing to dismiss); confirm/prompt follow dialog_policy.
// Asserting both policies catches an inverted policy that a single-policy test
// would miss (spec §5.1).
const DIALOG_MATRIX: Array<{
  policy: "dismiss" | "accept";
  type: "alert" | "confirm" | "prompt";
  expect: "accept" | "dismiss";
}> = [
  { policy: "dismiss", type: "alert", expect: "accept" },
  { policy: "dismiss", type: "confirm", expect: "dismiss" },
  { policy: "dismiss", type: "prompt", expect: "dismiss" },
  { policy: "accept", type: "alert", expect: "accept" },
  { policy: "accept", type: "confirm", expect: "accept" },
  { policy: "accept", type: "prompt", expect: "accept" },
];

for (const { policy, type, expect } of DIALOG_MATRIX) {
  test(`session #19: dialog_policy="${policy}" → ${type} is ${expect}ed`, async () => {
    await withWorkspace(async (ws) => {
      const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
      const captured: CapturedHandlers = {};
      const connect: ConnectOverCdp = async () =>
        makeHandlerCapturingBrowser(captured) as unknown as Awaited<ReturnType<ConnectOverCdp>>;
      const session = new BrowserSession({
        config: baseConfig({ dialog_policy: policy }),
        agentTimezone: "UTC",
        workspaceRoot: ws,
        logger: silentLogger,
        connectOverCdp: connect,
      });
      try {
        await session.getActivePage("s1");
        assert.ok(captured.dialog, "dialog handler was registered on the page");
        const dialog = makeFakeDialog(type);
        captured.dialog!(dialog);
        // Handler is fire-and-forget (void); let its async accept/dismiss settle.
        await new Promise((r) => setTimeout(r, 5));
        if (expect === "accept") {
          assert.equal(dialog.accepted, true, `${type} under "${policy}" must accept`);
          assert.equal(dialog.dismissed, false, `${type} under "${policy}" must not dismiss`);
        } else {
          assert.equal(dialog.dismissed, true, `${type} under "${policy}" must dismiss`);
          assert.equal(dialog.accepted, false, `${type} under "${policy}" must not accept`);
        }
      } finally {
        manager.restore();
        await session.shutdown();
      }
    });
  });
}

// ── pdf export (CDP Page.printToPDF → workspace) ─────────────────────────────

/** A fake page whose CDP session returns a stubbed printToPDF payload. */
function makePdfPage(opts: { printError?: Error; data?: string } = {}) {
  const cdpCalls: string[] = [];
  const cdp = {
    async send(method: string) {
      cdpCalls.push(method);
      if (opts.printError) throw opts.printError;
      return { data: opts.data ?? Buffer.from("%PDF-1.4 fake pdf").toString("base64") };
    },
    async detach() { cdpCalls.push("detach"); },
  };
  return {
    url: () => "https://example.com/article",
    context: () => ({ newCDPSession: async () => cdp }),
    cdpCalls,
  };
}

test("session: exportPdf writes a PDF to the workspace download dir and returns its record", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const page = makePdfPage();
      const record = await session.exportPdf("s1", page as never);
      assert.equal(record.path, path.join("browser-downloads", "s1", "page-1.pdf"));
      assert.equal(record.filename, "page-1.pdf");
      assert.equal(record.url, "https://example.com/article");
      const bytes = await readFile(path.join(ws, record.path));
      assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-", "file has the PDF magic");
      assert.ok(page.cdpCalls.includes("Page.printToPDF"), "used CDP printToPDF");
      assert.ok(page.cdpCalls.includes("detach"), "CDP session detached");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: exportPdf numbers successive exports (page-1, page-2)", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      // Create session state so pdfCount persists across exports.
      (session as unknown as { getOrCreateState(id: string): unknown }).getOrCreateState("s1");
      const r1 = await session.exportPdf("s1", makePdfPage() as never);
      const r2 = await session.exportPdf("s1", makePdfPage() as never);
      assert.equal(r1.filename, "page-1.pdf");
      assert.equal(r2.filename, "page-2.pdf");
    } finally {
      await session.shutdown();
    }
  });
});

test("session #2: two exports across a SessionState reset produce distinct, non-clobbering files", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      // First export with live state → page-1.pdf.
      (session as unknown as { getOrCreateState(id: string): unknown }).getOrCreateState("s1");
      const r1 = await session.exportPdf("s1", makePdfPage({ data: Buffer.from("%PDF-first").toString("base64") }) as never);
      assert.equal(r1.filename, "page-1.pdf");

      // Simulate an idle-reap / disconnect: SessionState (and its pdfCount) is
      // destroyed, but the download dir + page-1.pdf persist on disk.
      const sessions = (session as unknown as { sessions: Map<string, unknown> }).sessions;
      sessions.delete("s1");
      // A fresh state for the same id starts pdfCount back at 0 — the exact
      // condition that used to clobber page-1.pdf (issue #2).
      (session as unknown as { getOrCreateState(id: string): unknown }).getOrCreateState("s1");

      const r2 = await session.exportPdf("s1", makePdfPage({ data: Buffer.from("%PDF-second").toString("base64") }) as never);
      assert.notEqual(r2.filename, r1.filename, "post-reset export must not reuse the earlier name");
      assert.equal(r2.filename, "page-2.pdf", "bumped past the existing page-1.pdf on disk");

      // The earlier file is intact (not clobbered) and the second is its own file.
      const b1 = await readFile(path.join(ws, r1.path));
      const b2 = await readFile(path.join(ws, r2.path));
      assert.equal(b1.toString("latin1"), "%PDF-first", "earlier PDF survived the second export");
      assert.equal(b2.toString("latin1"), "%PDF-second", "second PDF is its own file");
    } finally {
      await session.shutdown();
    }
  });
});

test("session #19: a printToPDF that SUCCEEDS but a workspace write that FAILS maps to pdf_failed", async () => {
  await withWorkspace(async (ws) => {
    // Point the session's workspace at a path whose parent is a *file*, so mkdir
    // (and thus the write) fails even though printToPDF returns data — exercising
    // the write-failure branch distinct from the printToPDF-throws branch.
    const blocker = path.join(ws, "blocker");
    await writeFile(blocker, "not a dir");
    const session = newSession(blocker); // workspaceRoot is a file, not a dir
    try {
      const page = makePdfPage(); // printToPDF succeeds (returns data)
      await assert.rejects(
        () => session.exportPdf("s1", page as never),
        (e: unknown) => isBrowserError(e) && e.code === "pdf_failed",
      );
      // printToPDF was attempted and the CDP session still detached.
      assert.ok(page.cdpCalls.includes("Page.printToPDF"), "printToPDF was called (it succeeded)");
      assert.ok(page.cdpCalls.includes("detach"), "CDP session detached before the write failure");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: exportPdf maps a printToPDF failure to pdf_failed and still detaches", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const page = makePdfPage({ printError: new Error("printToPDF unsupported") });
      await assert.rejects(
        () => session.exportPdf("s1", page as never),
        (e: unknown) => isBrowserError(e) && e.code === "pdf_failed",
      );
      assert.ok(page.cdpCalls.includes("detach"), "detaches even on failure");
    } finally {
      await session.shutdown();
    }
  });
});

// ── one-shot act:dialog override (armDialog + handleDialog) ──────────────────

/** A fake Playwright Dialog recording accept(text?)/dismiss() calls. */
function fakeDialog(type: "alert" | "confirm" | "prompt") {
  const calls: Array<[string, string | undefined]> = [];
  return {
    type: () => type,
    accept: async (t?: string) => { calls.push(["accept", t]); },
    dismiss: async () => { calls.push(["dismiss", undefined]); },
    calls,
  };
}

type DialogPrivate = {
  handleDialog(page: unknown, dialog: unknown): Promise<void>;
  dialogOverrides: WeakMap<object, { accept: boolean; promptText?: string; expiresAt: number }>;
};

type InjectPrivate = {
  injectPageDialogOverride(page: unknown, accept: boolean, promptText: string | undefined): Promise<void>;
  dialogOverrides: WeakMap<object, { accept: boolean; promptText?: string; expiresAt: number }>;
};

function newSession(ws: string, overrides: Partial<BrowserConfig> = {}): BrowserSession {
  return new BrowserSession({
    config: baseConfig(overrides), agentTimezone: "UTC", workspaceRoot: ws,
    logger: silentLogger, connectOverCdp: async () => ({}) as never,
  });
}

test("session: an armed accept override answers the next dialog with prompt_text, then is one-shot", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const page = {};
      const priv = session as unknown as DialogPrivate;
      session.armDialog(page as never, true, "my answer");
      const d1 = fakeDialog("prompt");
      await priv.handleDialog(page, d1);
      assert.deepEqual(d1.calls, [["accept", "my answer"]], "armed accept used, with text");

      // One-shot: the override is consumed, so the NEXT dialog falls back to the
      // default dialog_policy ("dismiss" for confirm).
      const d2 = fakeDialog("confirm");
      await priv.handleDialog(page, d2);
      assert.deepEqual(d2.calls, [["dismiss", undefined]], "override did not persist to the next dialog");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: an armed dismiss override dismisses the next dialog", async () => {
  await withWorkspace(async (ws) => {
    // dialog_policy "accept" so the override (dismiss) is clearly distinguishable
    // from the default behavior.
    const session = newSession(ws, { dialog_policy: "accept" });
    try {
      const page = {};
      const priv = session as unknown as DialogPrivate;
      session.armDialog(page as never, false, undefined);
      const d = fakeDialog("confirm");
      await priv.handleDialog(page, d);
      assert.deepEqual(d.calls, [["dismiss", undefined]], "armed dismiss overrode the accept policy");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: an armed dismiss override beats the alert auto-accept special-case", async () => {
  await withWorkspace(async (ws) => {
    // Alerts normally ALWAYS accept (nothing to dismiss) — see handleDialog's
    // `dialog.type() === "alert"` branch. An armed dismiss override must run
    // BEFORE that special-case and dismiss the alert. This guards against a
    // future refactor moving the override check below the alert branch.
    const session = newSession(ws, { dialog_policy: "dismiss" });
    try {
      const page = {};
      const priv = session as unknown as DialogPrivate;
      session.armDialog(page as never, false, undefined);
      const d = fakeDialog("alert");
      await priv.handleDialog(page, d);
      assert.deepEqual(d.calls, [["dismiss", undefined]], "armed dismiss overrode the alert auto-accept");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: an expired override falls back to the default dialog_policy", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws, { dialog_policy: "dismiss" });
    try {
      const page = {};
      const priv = session as unknown as DialogPrivate;
      session.armDialog(page as never, true, "stale");
      // Backdate the override so it's expired when the dialog fires.
      priv.dialogOverrides.get(page)!.expiresAt = 0;
      const d = fakeDialog("confirm");
      await priv.handleDialog(page, d);
      assert.deepEqual(d.calls, [["dismiss", undefined]], "expired override ignored; default policy applied");
      assert.equal(priv.dialogOverrides.has(page), false, "expired override is cleared");
    } finally {
      await session.shutdown();
    }
  });
});

// ── console buffer (console + pageerror ring) ────────────────────────────────

/** A fake page that records on() handlers and can emit events to them. */
function makeConsolePage() {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {};
  return {
    on(event: string, cb: (arg: unknown) => void) { (handlers[event] ??= []).push(cb); },
    emit(event: string, arg: unknown) { for (const h of handlers[event] ?? []) h(arg); },
    url: () => "https://example.com",
  };
}

type TrackPrivate = {
  trackPage(id: string, state: unknown, page: unknown): void;
  getOrCreateState(id: string): unknown;
};

test("session: console buffer captures console + pageerror, drains once", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const priv = session as unknown as TrackPrivate;
      const page = makeConsolePage();
      priv.trackPage("s1", priv.getOrCreateState("s1"), page);
      page.emit("console", { type: () => "log", text: () => "hello" });
      page.emit("pageerror", new Error("boom"));
      assert.deepEqual(session.drainConsole(page as never), [
        { level: "log", text: "hello" },
        { level: "error", text: "boom" },
      ]);
      assert.deepEqual(session.drainConsole(page as never), [], "second drain is empty");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: console buffer is bounded to the last 200 messages", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const priv = session as unknown as TrackPrivate;
      const page = makeConsolePage();
      priv.trackPage("s1", priv.getOrCreateState("s1"), page);
      for (let i = 0; i < 250; i++) page.emit("console", { type: () => "log", text: () => `m${i}` });
      const drained = session.drainConsole(page as never);
      assert.equal(drained.length, 200, "capped at CONSOLE_BUFFER_MAX");
      assert.equal(drained[0]!.text, "m50", "oldest over the cap dropped");
      assert.equal(drained[199]!.text, "m249", "newest kept");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: a single huge console message is truncated to the per-entry cap on push", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const priv = session as unknown as TrackPrivate;
      const page = makeConsolePage();
      priv.trackPage("s1", priv.getOrCreateState("s1"), page);
      // 5 MB of console text — pre-fix this would sit in the buffer verbatim.
      const huge = "x".repeat(5 * 1024 * 1024);
      page.emit("console", { type: () => "log", text: () => huge });
      const drained = session.drainConsole(page as never);
      assert.equal(drained.length, 1);
      const entry = drained[0]!;
      assert.equal(
        entry.text.length,
        CONSOLE_ENTRY_MAX_CHARS + CONSOLE_TRUNCATION_MARKER.length,
        "buffered entry is the per-message cap plus the truncation marker — never the full 5 MB",
      );
      assert.ok(entry.text.endsWith(CONSOLE_TRUNCATION_MARKER), "truncation marker appended");
      assert.ok(entry.text.length < huge.length, "buffer never holds the full multi-MB string");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: a console message at/under the per-entry cap is kept verbatim", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const priv = session as unknown as TrackPrivate;
      const page = makeConsolePage();
      priv.trackPage("s1", priv.getOrCreateState("s1"), page);
      const exact = "y".repeat(CONSOLE_ENTRY_MAX_CHARS);
      page.emit("console", { type: () => "log", text: () => exact });
      const drained = session.drainConsole(page as never);
      assert.equal(drained[0]!.text, exact, "no marker, no truncation at the boundary");
    } finally {
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

// ── injectPageDialogOverride (Amendment 1/3 tests) ────────────────────────────

test("session: injectPageDialogOverride success clears the CDP WeakMap override", async () => {
  await withWorkspace(async (ws) => {
    const session = newSession(ws);
    try {
      const priv = session as unknown as InjectPrivate;
      // Stub page with a successful evaluate.
      const page: Record<string, unknown> = {
        evaluate: async (_fn: unknown, _arg: unknown) => undefined,
      };
      // Arm the CDP-path slot first (mirrors what armDialog does before inject).
      session.armDialog(page as never, true, "my text");
      assert.ok(priv.dialogOverrides.has(page), "precondition: WeakMap armed");

      // Inject succeeds → WeakMap entry cleared so it can't fire on a later dialog.
      await priv.injectPageDialogOverride(page, true, "my text");
      assert.ok(!priv.dialogOverrides.has(page), "WeakMap cleared after successful JS injection");
    } finally {
      await session.shutdown();
    }
  });
});

test("session: injectPageDialogOverride evaluate failure logs warn and retains WeakMap", async () => {
  await withWorkspace(async (ws) => {
    const warnCalls: Array<{ event: string; fields: unknown }> = [];
    const capturingLogger: Logger = {
      debug() {}, info() {},
      warn(event: string, fields?: unknown) { warnCalls.push({ event, fields }); },
      error() {},
      child() { return capturingLogger; },
    };
    const session = new BrowserSession({
      config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws,
      logger: capturingLogger, connectOverCdp: async () => ({}) as never,
    });
    try {
      const priv = session as unknown as InjectPrivate;
      const page: Record<string, unknown> = {
        evaluate: async (_fn: unknown, _arg: unknown) => {
          throw new Error("execution context was destroyed");
        },
      };
      session.armDialog(page as never, false, undefined);
      assert.ok(priv.dialogOverrides.has(page), "precondition: WeakMap armed");

      await priv.injectPageDialogOverride(page, false, undefined);

      // CDP fallback must remain armed.
      assert.ok(priv.dialogOverrides.has(page), "WeakMap retained after failed JS injection");
      // Failure must be visible to the operator as a warn (not debug).
      assert.ok(
        warnCalls.some((c) => c.event === "dialog_inject_override_failed"),
        "warn logged for inject failure",
      );
      // The note about CDP fallback also failing should be included.
      const failWarn = warnCalls.find((c) => c.event === "dialog_inject_override_failed");
      assert.ok(
        (failWarn?.fields as Record<string, unknown>)?.note?.toString().includes("CDP fallback"),
        "warn includes note that CDP fallback also fails",
      );
    } finally {
      await session.shutdown();
    }
  });
});

// ── dialogOverrideScript page-side logic (vm sandbox tests) ──────────────────
//
// The injected function runs in the browser; we test its logic by evaluating
// its serialised source in a vm.createContext where window = fakeWindow. tsx
// strips TypeScript before V8 sees the source, so .toString() yields plain JS.

/** Build a vm context with `window` = fakeW and the built-in `Object`.
 * Also injects esbuild's `__name` helper: when tsx compiles the module, esbuild
 * instruments functions with `__name(fn, "name")` for devtools display. The
 * helper is normally defined in the host bundle but absent from a bare vm sandbox,
 * so we supply a no-op shim that just returns the function. */
function makeDialogScriptCtx(fakeW: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const __name = (fn: unknown, _name: string) => fn;
  return createContext({ window: fakeW, Object, __name });
}

/** Evaluate dialogOverrideScript in a vm sandbox with the given spec. */
function runScript(ctx: ReturnType<typeof createContext>, spec: { accept: boolean; promptText: string | null }): void {
  const src = dialogOverrideScript.toString();
  runInContext(`(${src})(${JSON.stringify(spec)})`, ctx);
}

test("session: dialogOverrideScript - slot consumed restores natives and clears sentinel", () => {
  const nativeConfirmCalls: unknown[][] = [];
  const fakeW: Record<string, unknown> = {
    confirm: (...args: unknown[]) => { nativeConfirmCalls.push(args); return false; },
    prompt: () => null,
    alert: () => {},
  };
  const ctx = makeDialogScriptCtx(fakeW);

  // Install wrappers and arm.
  runScript(ctx, { accept: true, promptText: "ans" });
  assert.ok(fakeW.__miku_dlg_wrapped__, "sentinel set after install");

  // Call confirm — consumes the slot.
  const result = (fakeW.confirm as (...a: unknown[]) => boolean)("sure?");
  assert.equal(result, true, "wrapper returns armed accept=true");
  assert.equal(fakeW.__miku_dlg_wrapped__, false, "sentinel cleared after consume");
  assert.equal(fakeW.__miku_dlg_ov__, null, "slot cleared after consume");

  // Native must be restored: calling confirm now delegates to the original.
  (fakeW.confirm as (...a: unknown[]) => boolean)("after restore");
  assert.equal(nativeConfirmCalls.length, 1, "native called once after restore");
  assert.deepEqual(nativeConfirmCalls[0], ["after restore"], "native received args");
});

test("session: dialogOverrideScript - unarmed call delegates to native (slot null)", () => {
  const nativeCalls: unknown[][] = [];
  const fakeW: Record<string, unknown> = {
    confirm: (...args: unknown[]) => { nativeCalls.push(args); return false; },
    prompt: () => null,
    alert: () => {},
  };
  const ctx = makeDialogScriptCtx(fakeW);

  // Install wrappers.
  runScript(ctx, { accept: true, promptText: null });

  // Clear the slot (simulate no armed override).
  fakeW.__miku_dlg_ov__ = null;

  // Call confirm with no slot — must delegate to native, sentinel unchanged.
  const result = (fakeW.confirm as (...a: unknown[]) => boolean)("msg");
  assert.equal(result, false, "native return value passes through");
  assert.equal(nativeCalls.length, 1, "native called");
  assert.equal(fakeW.__miku_dlg_wrapped__, true, "sentinel not cleared (no consume)");
});

test("session: dialogOverrideScript - re-arm after consume re-installs wrappers", () => {
  const fakeW: Record<string, unknown> = {
    confirm: () => false,
    prompt: () => null,
    alert: () => {},
  };
  const ctx = makeDialogScriptCtx(fakeW);

  // First arm + consume.
  runScript(ctx, { accept: true, promptText: null });
  const result1 = (fakeW.confirm as (...a: unknown[]) => boolean)("first");
  assert.equal(result1, true, "first arm accept=true");
  assert.equal(fakeW.__miku_dlg_wrapped__, false, "sentinel cleared after first consume");

  // Second arm — re-installs because sentinel is false.
  runScript(ctx, { accept: false, promptText: null });
  assert.equal(fakeW.__miku_dlg_wrapped__, true, "sentinel set again after re-arm");
  const result2 = (fakeW.confirm as (...a: unknown[]) => boolean)("second");
  assert.equal(result2, false, "second arm accept=false");
  assert.equal(fakeW.__miku_dlg_wrapped__, false, "sentinel cleared after second consume");
});

test("session: dialogOverrideScript - prompt returns armed text or null on dismiss", () => {
  const fakeW: Record<string, unknown> = {
    confirm: () => false,
    prompt: () => "native",
    alert: () => {},
  };
  const ctx = makeDialogScriptCtx(fakeW);

  // Arm with accept=true and promptText.
  runScript(ctx, { accept: true, promptText: "my answer" });
  const r1 = (fakeW.prompt as (...a: unknown[]) => string | null)("Enter value:");
  assert.equal(r1, "my answer", "prompt returns armed text");

  // Re-arm with accept=false (dismiss → null).
  runScript(ctx, { accept: false, promptText: null });
  const r2 = (fakeW.prompt as (...a: unknown[]) => string | null)("Enter value:");
  assert.equal(r2, null, "prompt returns null on dismiss");
});

test("session: dialogOverrideScript - globals are non-enumerable (Object.keys check)", () => {
  const fakeW: Record<string, unknown> = {
    confirm: () => false,
    prompt: () => null,
    alert: () => {},
  };
  const ctx = makeDialogScriptCtx(fakeW);
  runScript(ctx, { accept: true, promptText: null });

  const keys = Object.keys(fakeW);
  assert.ok(!keys.includes("__miku_dlg_ov__"), "__miku_dlg_ov__ not in Object.keys");
  assert.ok(!keys.includes("__miku_dlg_wrapped__"), "__miku_dlg_wrapped__ not in Object.keys");
});

test("session: dialogOverrideScript - wrappers have native-code toString", () => {
  const fakeW: Record<string, unknown> = {
    confirm: () => false,
    prompt: () => null,
    alert: () => {},
  };
  const ctx = makeDialogScriptCtx(fakeW);
  runScript(ctx, { accept: true, promptText: null });

  const confirmStr = (fakeW.confirm as { toString(): string }).toString();
  assert.ok(confirmStr.includes("[native code]"), "confirm.toString() contains [native code]");
  assert.ok(confirmStr.includes("confirm"), "confirm.toString() names the function");
});
