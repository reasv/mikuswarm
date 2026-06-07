import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("session #14: a download whose saveAs resolves after closeSession is dropped, not pushed onto a dead state", async () => {
  await withWorkspace(async (ws) => {
    const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
    // Capture the page-level `download` handler so we can fire it manually.
    let downloadHandler: ((download: unknown) => void) | undefined;
    const fakePage = {
      _closed: false,
      isClosed() { return this._closed; },
      async close() { this._closed = true; },
      on(event: string, cb: (arg: unknown) => void) { if (event === "download") downloadHandler = cb; },
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
    const connect: ConnectOverCdp = async () => browser as unknown as Awaited<ReturnType<ConnectOverCdp>>;

    // Capturing logger to assert the deliberate drop.
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const capturingLogger: Logger = {
      debug(event, fields) { logged.push({ event, fields }); },
      info(event, fields) { logged.push({ event, fields }); },
      warn(event, fields) { logged.push({ event, fields }); },
      error(event, fields) { logged.push({ event, fields }); },
      child() { return capturingLogger; },
    };

    const session = new BrowserSession({ config: baseConfig(), agentTimezone: "UTC", workspaceRoot: ws, logger: capturingLogger, connectOverCdp: connect });
    try {
      await session.getActivePage("s1");
      assert.ok(downloadHandler, "download handler was registered");

      // A fake Download whose saveAs resolves only after we release it — letting
      // us close the session mid-saveAs (the exact race in issue #14).
      let releaseSaveAs!: () => void;
      const saveAsGate = new Promise<void>((resolve) => { releaseSaveAs = resolve; });
      const fakeDownload = {
        suggestedFilename: () => "report.pdf",
        url: () => "https://example.com/report.pdf",
        saveAs: async (_p: string) => { await saveAsGate; },
      };

      // Fire the download; it parks inside saveAs.
      downloadHandler!(fakeDownload);
      // Close the session while saveAs is still pending.
      await session.closeSession("s1");
      // Now let saveAs resolve — handleDownload must NOT throw and must drop.
      releaseSaveAs();
      await new Promise((r) => setTimeout(r, 10));

      // Record is unreachable (state is gone) and a deliberate drop was logged.
      assert.equal(session.drainDownloads("s1").length, 0, "no record surfaces from the dead session");
      assert.ok(
        logged.some((l) => l.event === "browser_download_after_close_dropped"),
        "a deliberate after-close drop was logged",
      );
      assert.ok(!logged.some((l) => l.event === "browser_download_failed"), "the drop is not an error/failure");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #19/#20: capture per-page dialog/download handlers ───────────────────────

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

// ── #20: download capture + filename sanitization ────────────────────────────

interface FakeDownload {
  suggestedFilename(): string;
  saveAs(p: string): Promise<void>;
  url(): string;
  savedTo?: string;
}

function makeFakeDownload(suggested: string, url: string): FakeDownload {
  const d: FakeDownload = {
    suggestedFilename: () => suggested,
    url: () => url,
    saveAs: async (p: string) => { d.savedTo = p; },
  };
  return d;
}

const HOSTILE_FILENAMES: Array<{ name: string; suggested: string }> = [
  { name: "path traversal", suggested: "../../etc/passwd" },
  { name: "absolute-looking path", suggested: "/etc/shadow" },
  { name: "weird chars + spaces", suggested: "my report (final)!.pdf" },
  { name: "null/slash mix", suggested: "a/b\\c:d*e?.bin" },
];

for (const { name, suggested } of HOSTILE_FILENAMES) {
  test(`session #20: a hostile download filename (${name}) is sanitized and stays under the session dir`, async () => {
    await withWorkspace(async (ws) => {
      const manager = stubManager({ profiles: [{ id: "p1", name: "miku", status: "running" }], status: "running" });
      const captured: CapturedHandlers = {};
      const connect: ConnectOverCdp = async () =>
        makeHandlerCapturingBrowser(captured) as unknown as Awaited<ReturnType<ConnectOverCdp>>;
      // A session id with hostile chars too, to exercise sanitizeSessionId.
      const sessionId = "../sneaky:id";
      const session = new BrowserSession({
        config: baseConfig(),
        agentTimezone: "UTC",
        workspaceRoot: ws,
        logger: silentLogger,
        connectOverCdp: connect,
      });
      try {
        await session.getActivePage(sessionId);
        assert.ok(captured.download, "download handler was registered on the page");

        const dl = makeFakeDownload(suggested, "https://example.com/file");
        captured.download!(dl);
        // handleDownload awaits mkdir + saveAs; give it a moment to settle.
        await new Promise((r) => setTimeout(r, 20));

        assert.ok(dl.savedTo, "saveAs was called");
        const savedTo = dl.savedTo!;
        assert.ok(path.isAbsolute(savedTo), "saveAs got an absolute path");

        // The download dir is workspaceRoot/browser-downloads/<sanitized-session>/.
        const downloadsRoot = path.join(ws, "browser-downloads");
        const rel = path.relative(downloadsRoot, savedTo);
        // Must stay UNDER browser-downloads — no absolute jump out of the root.
        assert.ok(!path.isAbsolute(rel), `saved path escaped browser-downloads: ${rel}`);

        // <sanitized-session>/<sanitized-filename>: exactly two path segments.
        const parts = rel.split(path.sep);
        assert.equal(parts.length, 2, `expected <session>/<file>, got "${rel}"`);
        const [sessionSeg, fileSeg] = parts;
        // No segment is a real traversal step. (A sanitized name may *contain* the
        // chars "." — e.g. "..sneaky" → "_sneaky" collapses dots to underscores —
        // but it is never the bare ".." that path resolution would walk up.)
        assert.notEqual(sessionSeg, "..", "session dir is not a traversal step");
        assert.notEqual(fileSeg, "..", "filename is not a traversal step");
        assert.match(sessionSeg!, /^[A-Za-z0-9._-]+$/, "session dir is sanitized to a safe charset");
        // The sanitized charset itself forbids the path separator, so no segment
        // it produces can introduce a new directory level.

        // Filename: sanitized to a safe charset, no separators, no "..".
        assert.match(fileSeg!, /^[A-Za-z0-9._-]+$/, `filename not sanitized: "${fileSeg}"`);
        assert.ok(!fileSeg!.includes("/") && !fileSeg!.includes("\\"), "no separators in filename");
        assert.notEqual(fileSeg, "..", "filename is not a bare ..");

        // The record is drained once, then cleared.
        const drained = session.drainDownloads(sessionId);
        assert.equal(drained.length, 1, "exactly one download record surfaces");
        assert.equal(drained[0]!.url, "https://example.com/file");
        assert.equal(drained[0]!.filename, fileSeg, "record filename matches the sanitized name");
        // The record's relative path is workspace-relative and stays under the dir.
        assert.equal(drained[0]!.path, path.join("browser-downloads", sessionSeg!, fileSeg!));
        // A second drain returns nothing — the buffer was cleared.
        assert.equal(session.drainDownloads(sessionId).length, 0, "downloads cleared after drain");
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
