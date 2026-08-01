import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserSession, MAX_PENDING_DOWNLOADS, STAGING_SWEEP_TTL_MS, type ConnectOverCdp } from "../src/browser/session.js";
import type { BrowserConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/logger.js";

// Unit tests for the cross-container download pipeline (ARCHITECTURE.md §11b
// "Downloads"): the agent-issued Browser.setDownloadBehavior override on a held
// browser-level CDP session, the two-stream correlation (our CDP events ×
// Playwright's page `download` events), the copy→unlink finalization into the
// workspace, the size-cap cancel, the close-race drop, and the connect-time
// staging sweep. All against a fake browser/CDP session — the real-Chromium
// path is covered by test/browser.docker.test.ts.

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function capturingLogger(logged: Array<{ event: string; fields?: Record<string, unknown> }>): Logger {
  const logger: Logger = {
    debug(event, fields) { logged.push({ event, fields }); },
    info(event, fields) { logged.push({ event, fields }); },
    warn(event, fields) { logged.push({ event, fields }); },
    error(event, fields) { logged.push({ event, fields }); },
    child() { return logger; },
  };
  return logger;
}

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

/** Minimal Manager REST stub (same shape as test/browser-session.test.ts). */
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
  return { restore: () => { globalThis.fetch = original; } };
}

interface FakeCdp {
  sent: Array<{ method: string; params: Record<string, unknown> | undefined }>;
  on(event: string, cb: (payload: unknown) => void): void;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  emit(event: string, payload: unknown): void;
}

function makeFakeCdp(): FakeCdp {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    sent: [],
    on(event, cb) { handlers.set(event, cb); },
    async send(method, params) { this.sent.push({ method, params }); return {}; },
    emit(event, payload) { handlers.get(event)?.(payload); },
  };
}

type DownloadFake = { url(): string; suggestedFilename(): string; saveAs?(p: string): Promise<void> };

interface DownloadHarness {
  cdp: FakeCdp;
  cdpSessionsOpened: number;
  /** Override what newBrowserCDPSession does (e.g. to make the override send reject). */
  newCdpSession?: () => Promise<unknown>;
  /**
   * Fire the browser's captured `disconnected` handler (issue #17): drives the
   * reconnect path (BrowserSession clears `browser`/`context`/`downloadsCdp`/
   * `pendingDownloadEntries`, the next getActivePage reconnects). Faithful to the
   * disconnect-capturing fake in test/browser-session.test.ts.
   */
  fireDisconnect(): void;
  /** The page-level `download` handler trackPage registered. */
  fireDownload(download: DownloadFake): void;
  /**
   * Simulate a `target="_blank"`/`window.open` popup that fires a `download`
   * event on the POPUP page (issue #2): emits the opener page's `popup` event
   * with a fresh page, then fires `download` on that popup. The popup is never
   * added to any session's tab list — it only ever carries this one download.
   */
  firePopupDownload(download: DownloadFake): void;
}

/**
 * A fake browser whose single page captures the `download` (and `popup`)
 * handlers and whose newBrowserCDPSession returns a controllable fake CDP
 * session.
 */
function makeDownloadBrowser(): { browser: unknown; harness: DownloadHarness } {
  const cdp = makeFakeCdp();
  let downloadHandler: ((arg: unknown) => void) | undefined;
  let popupHandler: ((arg: unknown) => void) | undefined;
  let disconnectHandler: (() => void) | undefined;
  const fakePage = {
    _closed: false,
    isClosed() { return this._closed; },
    async close() { this._closed = true; },
    on(event: string, cb: (arg: unknown) => void) {
      if (event === "download") downloadHandler = cb;
      else if (event === "popup") popupHandler = cb;
    },
    url: () => "about:blank",
    title: async () => "",
  };
  // newPage reopens the single shared page (resetting _closed): after a
  // closeSession the next getActivePage recreates the session's first tab, and a
  // real context would hand back a fresh, open page (issue #22 close-and-recreate).
  const context = {
    newPage: async () => {
      fakePage._closed = false;
      return fakePage;
    },
    pages: () => [fakePage],
  };
  const harness: DownloadHarness = {
    cdp,
    cdpSessionsOpened: 0,
    // Reassigned below once `browser` exists (it needs to flip browser._connected).
    fireDisconnect() { throw new Error("fireDisconnect wired after browser creation"); },
    fireDownload(download) {
      assert.ok(downloadHandler, "download handler was registered");
      downloadHandler!(download);
    },
    firePopupDownload(download) {
      assert.ok(popupHandler, "popup handler was registered on the opener page");
      // A minimal popup page that only exposes the `download` event, matching a
      // real Playwright popup the agent never drives.
      let popupDownloadHandler: ((arg: unknown) => void) | undefined;
      const popup = {
        on(event: string, cb: (arg: unknown) => void) {
          if (event === "download") popupDownloadHandler = cb;
        },
      };
      popupHandler!(popup);
      assert.ok(popupDownloadHandler, "the popup's download handler was attached");
      popupDownloadHandler!(download);
    },
  };
  const browser = {
    _connected: true,
    contexts: () => [context],
    isConnected: () => browser._connected,
    // Capture the `disconnected` handler so the reconnect path is drivable
    // (issue #17) — the old `on: () => {}` discarded it. Mirrors the
    // disconnect-capturing fake in test/browser-session.test.ts.
    on: (event: string, cb: () => void) => {
      if (event === "disconnected") disconnectHandler = cb;
    },
    close: async () => { browser._connected = false; },
    newBrowserCDPSession: async () => {
      harness.cdpSessionsOpened++;
      if (harness.newCdpSession) return harness.newCdpSession();
      return cdp;
    },
  };
  // A fired disconnect flips isConnected to false (so ensureContext reconnects)
  // before invoking the captured handler, matching real Playwright ordering.
  harness.fireDisconnect = () => {
    assert.ok(disconnectHandler, "the browser's disconnected handler was captured");
    browser._connected = false;
    disconnectHandler!();
  };
  return { browser, harness };
}

/** A metadata-only Playwright Download fake; saveAs must never be called (§11b). */
function metadataDownload(url: string, suggestedFilename: string) {
  return {
    url: () => url,
    suggestedFilename: () => suggestedFilename,
    saveAs: async (_p: string) => {
      assert.fail("saveAs must never be called — it is structurally broken in the split topology");
    },
  };
}

const GUID_A = "00000000-0000-4000-8000-00000000000a";
const GUID_B = "00000000-0000-4000-8000-00000000000b";

/** Poll until `cond` holds (events run through fire-and-forget async handlers). */
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

interface Dirs { ws: string; staging: string }

async function withDirs(fn: (dirs: Dirs) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-dl-"));
  try {
    const ws = path.join(root, "workspace");
    const staging = path.join(root, "staging");
    await mkdir(ws, { recursive: true });
    await mkdir(staging, { recursive: true });
    await fn({ ws, staging });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface SessionBundle {
  session: BrowserSession;
  harness: DownloadHarness;
  logged: Array<{ event: string; fields?: Record<string, unknown> }>;
  manager: { restore(): void };
}

function newDownloadSession(
  dirs: Dirs,
  opts: { sizeLimit?: number; configured?: boolean; actTimeoutMs?: number } = {},
): SessionBundle {
  const manager = stubManager();
  const { browser, harness } = makeDownloadBrowser();
  const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  // Each connect (initial AND reconnect after a fired disconnect) yields a live
  // socket — flip _connected back true so a post-disconnect getActivePage finds
  // a connected browser (issue #17). Real connectOverCDP always returns a live one.
  const connect: ConnectOverCdp = async () => {
    (browser as { _connected: boolean })._connected = true;
    return browser as never;
  };
  const configured = opts.configured ?? true;
  const session = new BrowserSession({
    config: baseConfig({
      ...(configured ? { downloads_dir: "/downloads", downloads_local_dir: dirs.staging } : {}),
      ...(opts.actTimeoutMs !== undefined ? { act_timeout_ms: opts.actTimeoutMs } : {}),
    }),
    agentTimezone: "UTC",
    workspaceRoot: dirs.ws,
    logger: capturingLogger(logged),
    downloadSizeLimit: opts.sizeLimit,
    connectOverCdp: connect,
  });
  return { session, harness, logged, manager };
}

type PendingPrivate = { pendingDownloadEntries: Array<{ expiresAt: number }> };

// ── Tests ──────────────────────────────────────────────────────────────────

test("downloads: connect sends the setDownloadBehavior override on our own browser-level CDP session", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      assert.equal(harness.cdpSessionsOpened, 1, "one held browser-level CDP session");
      const override = harness.cdp.sent.find((c) => c.method === "Browser.setDownloadBehavior");
      assert.ok(override, "override was sent");
      assert.deepEqual(override!.params, {
        behavior: "allowAndName",
        downloadPath: "/downloads",
        eventsEnabled: true,
      });
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: unconfigured ⇒ no CDP override, no capture, and a once-per-connect log", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { configured: false });
    try {
      await session.getActivePage("s1");
      assert.equal(harness.cdpSessionsOpened, 0, "no browser-level CDP session opened");
      assert.equal(harness.cdp.sent.length, 0, "no override sent");
      assert.equal(
        logged.filter((l) => l.event === "browser_download_unconfigured").length,
        1,
        "the operator discovery log fired exactly once for the connect",
      );
      // A page download with no override records nothing (bytes never crossed).
      harness.fireDownload(metadataDownload("https://example.com/f.bin", "f.bin"));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(session.drainDownloads("s1").length, 0, "nothing recorded when unconfigured");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: completed staging file is copied into the workspace, staging unlinked, record drained (saveAs never called)", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "hello bytes");

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/report.pdf", suggestedFilename: "report.pdf",
      });
      harness.fireDownload(metadataDownload("https://example.com/report.pdf", "report.pdf"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 11, totalBytes: 11,
      });

      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "report.pdf");
      await waitFor(() => exists(finalPath), "the finalized workspace file");
      assert.equal((await readFile(finalPath)).toString(), "hello bytes", "bytes copied intact");
      await waitFor(async () => !(await exists(path.join(dirs.staging, GUID_A))), "staging guid unlinked");

      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1);
      assert.equal(drained[0]!.path, path.join("browser-downloads", "s1", "report.pdf"));
      assert.equal(drained[0]!.filename, "report.pdf");
      assert.equal(drained[0]!.url, "https://example.com/report.pdf");
      assert.ok(!drained[0]!.failed, "a successful download is not marked failed");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: the page event arriving FIRST correlates the same way (either stream may lead)", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "page-first");

      harness.fireDownload(metadataDownload("https://example.com/a.txt", "a.txt"));
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/a.txt", suggestedFilename: "a.txt",
      });
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 10, totalBytes: 10,
      });

      // Poll drainDownloads directly: exists(file) fires while finalizeDownload is
      // still in `await unlink(staging)`, before the record is pushed. The drain
      // poll exits only once the record is on pendingDownloads — no race window.
      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "finalized record");
      assert.equal(drained.length, 1);
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: a completion racing ahead of the page event finalizes on correlation", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "raced");

      // CDP side begins AND completes before Playwright's page event lands.
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/r.bin", suggestedFilename: "r.bin",
      });
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 5, totalBytes: 5,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(session.drainDownloads("s1").length, 0, "nothing recorded before attribution exists");

      harness.fireDownload(metadataDownload("https://example.com/r.bin", "r.bin"));
      // Same race as above: poll drainDownloads rather than exists(file).
      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "finalized record");
      assert.equal(drained.length, 1);
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: two same-URL same-name downloads match FIFO and both land (bump-until-free)", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "first");
      await writeFile(path.join(dirs.staging, GUID_B), "second");
      const url = "https://example.com/dup.txt";

      harness.cdp.emit("Browser.downloadWillBegin", { guid: GUID_A, url, suggestedFilename: "dup.txt" });
      harness.cdp.emit("Browser.downloadWillBegin", { guid: GUID_B, url, suggestedFilename: "dup.txt" });
      harness.fireDownload(metadataDownload(url, "dup.txt"));
      harness.fireDownload(metadataDownload(url, "dup.txt"));
      harness.cdp.emit("Browser.downloadProgress", { guid: GUID_A, state: "completed", receivedBytes: 5, totalBytes: 5 });
      harness.cdp.emit("Browser.downloadProgress", { guid: GUID_B, state: "completed", receivedBytes: 6, totalBytes: 6 });

      const dir = path.join(dirs.ws, "browser-downloads", "s1");
      await waitFor(
        () => Promise.all([exists(path.join(dir, "dup.txt")), exists(path.join(dir, "dup (2).txt"))]).then((r) => r.every(Boolean)),
        "both finalized files",
      );
      // FIFO: oldest pending guid pairs with the oldest page event — but with an
      // identical (url, filename) key the records are interchangeable anyway.
      const contents = new Set([
        (await readFile(path.join(dir, "dup.txt"))).toString(),
        (await readFile(path.join(dir, "dup (2).txt"))).toString(),
      ]);
      assert.deepEqual(contents, new Set(["first", "second"]), "both payloads landed without clobbering");
      // Two separate finalizations each go through `await unlink(staging)` before
      // pushing their record. Wait until both staging guids are gone — that proves
      // both `unlink` awaits have resolved and both records have been pushed.
      await waitFor(async () => (await readdir(dirs.staging)).length === 0, "both staging guids unlinked");
      assert.equal(session.drainDownloads("s1").length, 2, "two records surface");
      assert.equal((await readdir(dirs.staging)).length, 0, "staging emptied");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: an uncorrelated entry past its deadline is dropped with a warn and its staging bytes reaped", async () => {
  // #24: drive the deadline with a tiny real act_timeout_ms rather than reaching
  // into private pendingDownloadEntries to backdate expiresAt. This lets the
  // deadline expire for real (after one short wait) AND covers the
  // act_timeout_ms → expiresAt wiring (a regression dropping that arithmetic
  // would never expire the entry, hanging on the waitFor below). The drop still
  // fires from a real trigger — sweepIdleNow's expirePendingDownloads pass.
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { actTimeoutMs: 1 });
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "orphan");

      // CDP stream only — the page-event counterpart never arrives. The entry is
      // created with expiresAt = now + 1ms (act_timeout_ms), so it is past its
      // deadline within a couple of milliseconds.
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/orphan.bin", suggestedFilename: "orphan.bin",
      });
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 6, totalBytes: 6,
      });
      // Let the 1ms deadline pass for real, then run a real trigger (the periodic
      // idle sweep) — no private-field mutation. The sweep's expirePendingDownloads
      // pass drops the now-expired entry and reaps its staging bytes.
      await new Promise((r) => setTimeout(r, 20));
      await session.sweepIdleNow();

      assert.ok(
        logged.some((l) => l.event === "browser_download_uncorrelated_dropped"),
        "the drop was logged as a warn",
      );
      await waitFor(async () => !(await exists(path.join(dirs.staging, GUID_A))), "orphaned staging bytes reaped");
      assert.equal(session.drainDownloads("s1").length, 0, "no record without attribution");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: a transfer over the size cap is canceled, Chromium owns the partial, and a failed record surfaces", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { sizeLimit: 10 });
    try {
      await session.getActivePage("s1");
      // Mid-flight the partial is named `<guid>.crdownload` (NOT the bare guid),
      // and Browser.cancelDownload makes Chromium delete its own partial (issue
      // #3). The over-cap path therefore must NOT itself unlink the bare guid —
      // that was a misleading no-op. Plant the realistic in-flight name; it is
      // the TTL sweep, not the cancel path, that reaps any surviving partial.
      const crPartial = path.join(dirs.staging, `${GUID_A}.crdownload`);
      await writeFile(crPartial, "partial-bytes-on-disk");

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/huge.iso", suggestedFilename: "huge.iso",
      });
      harness.fireDownload(metadataDownload("https://example.com/huge.iso", "huge.iso"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "inProgress", receivedBytes: 4, totalBytes: 1000,
      });

      await waitFor(
        () => harness.cdp.sent.some((c) => c.method === "Browser.cancelDownload"),
        "Browser.cancelDownload sent",
      );
      const cancel = harness.cdp.sent.find((c) => c.method === "Browser.cancelDownload")!;
      assert.deepEqual(cancel.params, { guid: GUID_A }, "cancel targets the offending guid");

      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "a failure record surfaces");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "huge.iso");
      assert.equal(drained[0]!.path, "", "a failed record carries no workspace path");
      assert.ok(logged.some((l) => l.event === "browser_download_failed"), "failure logged");

      // A surviving `.crdownload` partial (Chromium didn't get to delete it) is
      // reaped by the TTL sweep — never by the over-cap path itself.
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(crPartial, past, past);
      await session.sweepStagingNow();
      assert.equal(await exists(crPartial), false, "a surviving aged .crdownload partial is reaped by the TTL sweep");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #18: an over-cap value arriving on the `completed` state must NOT finalize ─

test("downloads #18: an over-cap transfer reported on the `completed` state is canceled, lands no workspace file, and surfaces a failed record", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { sizeLimit: 10 });
    try {
      await session.getActivePage("s1");
      // A small-but-over-cap transfer can report `completed` WITHOUT a prior
      // over-cap `inProgress` event (the size cap is checked on every state, not
      // just inProgress — §2.5). Plant the bare completed guid file (the
      // realistic on-disk state at `completed`): the cap check must fire BEFORE
      // the completed-finalize branch, so the bytes must NOT be copied into the
      // workspace. A regression hoisting the cap check below the `completed`
      // branch would land an over-cap file in the workspace — this catches it.
      await writeFile(path.join(dirs.staging, GUID_A), "0123456789ABCDEF"); // 16 bytes > 10

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/big.bin", suggestedFilename: "big.bin",
      });
      harness.fireDownload(metadataDownload("https://example.com/big.bin", "big.bin"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 50, totalBytes: 50,
      });

      await waitFor(
        () => harness.cdp.sent.some((c) => c.method === "Browser.cancelDownload"),
        "Browser.cancelDownload sent for the over-cap completed transfer",
      );
      const cancel = harness.cdp.sent.find((c) => c.method === "Browser.cancelDownload")!;
      assert.deepEqual(cancel.params, { guid: GUID_A }, "cancel targets the offending guid");

      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "a failure record surfaces");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "big.bin");
      assert.equal(drained[0]!.path, "", "a failed record carries no workspace path");
      assert.ok(logged.some((l) => l.event === "browser_download_failed"), "failure logged");
      assert.equal(
        await exists(path.join(dirs.ws, "browser-downloads", "s1", "big.bin")),
        false,
        "the over-cap bytes were NOT finalized into the workspace",
      );
      const priv = session as unknown as PendingPrivate;
      assert.equal(priv.pendingDownloadEntries.length, 0, "the over-cap entry is dropped (session was attributed)");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads #18: a chunked over-cap transfer with no declared total (totalBytes 0) is canceled with a failed record", async () => {
  // Variant (a): a chunked transfer reports its size only via receivedBytes
  // (totalBytes stays 0). The cap is enforced on max(received, total), so this
  // must still cancel + fail. (The pre-correlation ordering of this exact shape
  // is exercised by "downloads #6"; this asserts it for the common
  // page-event-first ordering too, keeping the chunked leg explicit alongside
  // the declared-total and completed-state legs.)
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { sizeLimit: 10 });
    try {
      await session.getActivePage("s1");
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/stream.bin", suggestedFilename: "stream.bin",
      });
      harness.fireDownload(metadataDownload("https://example.com/stream.bin", "stream.bin"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "inProgress", receivedBytes: 50, totalBytes: 0,
      });

      await waitFor(
        () => harness.cdp.sent.some((c) => c.method === "Browser.cancelDownload"),
        "Browser.cancelDownload sent for the chunked over-cap transfer",
      );
      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "a failure record surfaces for the no-declared-total chunked transfer");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "stream.bin");
      assert.equal(drained[0]!.path, "");
      assert.ok(logged.some((l) => l.event === "browser_download_failed"), "failure logged");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: a browser-side cancel surfaces a failed record", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/c.zip", suggestedFilename: "c.zip",
      });
      harness.fireDownload(metadataDownload("https://example.com/c.zip", "c.zip"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "canceled", receivedBytes: 0, totalBytes: 0,
      });
      await waitFor(
        () => logged.some((l) => l.event === "browser_download_failed"),
        "the cancel was logged as a failure",
      );
      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "a failed record surfaces");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "c.zip");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: close race — the file still lands on disk but the record is deliberately dropped", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "late");

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/late.txt", suggestedFilename: "late.txt",
      });
      harness.fireDownload(metadataDownload("https://example.com/late.txt", "late.txt"));
      // The session closes while the transfer is still in flight…
      await session.closeSession("s1");
      // …and the completion lands afterwards.
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 4, totalBytes: 4,
      });

      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "late.txt");
      await waitFor(() => exists(finalPath), "file lands on disk despite the closed session");
      await waitFor(
        () => logged.some((l) => l.event === "browser_download_after_close_dropped"),
        "deliberate drop logged",
      );
      assert.equal(session.drainDownloads("s1").length, 0, "no record surfaces from the dead session");
      assert.ok(!logged.some((l) => l.event === "browser_download_failed"), "the drop is not an error");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #22: close-and-recreate-under-the-same-id (the close-race SECOND disjunct) ─

type SessionsPrivate = { sessions: Map<string, { closed: boolean; pendingDownloads: unknown[] }> };

test("downloads #22: a download correlated to a session that is closed AND recreated under the same id does not land on the new session", async () => {
  // The existing close-race test exercises the FIRST disjunct (state.closed). This
  // covers the SECOND disjunct of finalizeDownload's re-check —
  // `this.sessions.get(sessionId) !== state` — where, after the download
  // correlated, the session was closed and a *fresh* session was created under the
  // SAME id (a new chat turn reusing "s1") before the copy resolved. The record
  // must be dropped, NOT pushed onto the new session's state.
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "old-session bytes");

      // Correlate the download against the ORIGINAL "s1" state.
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/x.txt", suggestedFilename: "x.txt",
      });
      harness.fireDownload(metadataDownload("https://example.com/x.txt", "x.txt"));

      // Close "s1" (detaches the original state) and immediately recreate it: a new
      // chat turn reusing the same id gets a brand-new, empty SessionState.
      await session.closeSession("s1");
      await session.getActivePage("s1");

      // The completion now finalizes against the ORIGINAL (detached) state — its
      // copy lands on disk, but the record must be dropped because the live "s1"
      // state is a different object.
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 17, totalBytes: 17,
      });

      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "x.txt");
      await waitFor(() => exists(finalPath), "file still lands on disk for the original session dir");
      await waitFor(
        () => logged.some((l) => l.event === "browser_download_after_close_dropped"),
        "the record was deliberately dropped (not surfaced)",
      );
      // The crucial assertion: the RECREATED "s1" must not have inherited the
      // record — a regression checking only `state.closed` would still drop it
      // here too (closed is also set), so to pin the SECOND disjunct exactly we
      // also assert below the closed=false / map-mismatch case in isolation.
      assert.equal(session.drainDownloads("s1").length, 0, "the recreated session did not inherit the dropped record");

      // Pin the SECOND disjunct in isolation: a stale state that is NOT marked
      // closed but has been REPLACED in the session map under the same id. A
      // regression that only checked `state.closed` (dropping the map-identity
      // arm) would push the record onto the live session here. We swap the map
      // entry for a fresh state object without closing the old one, then drive a
      // fresh correlated completion whose entry references the OLD (open) state.
      const priv = session as unknown as SessionsPrivate;
      const staleState = priv.sessions.get("s1")!;
      assert.equal(staleState.closed, false, "precondition: the live state is open (not closed)");
      const replacement = { ...staleState, closed: false, pendingDownloads: [] as unknown[] };
      priv.sessions.set("s1", replacement); // staleState is now detached but NOT closed

      await writeFile(path.join(dirs.staging, GUID_B), "stale-state bytes");
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_B, url: "https://example.com/y.txt", suggestedFilename: "y.txt",
      });
      // Fire the page event so the entry correlates to the now-detached staleState
      // (the page handler captured staleState when the page was tracked).
      harness.fireDownload(metadataDownload("https://example.com/y.txt", "y.txt"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_B, state: "completed", receivedBytes: 12, totalBytes: 12,
      });

      const finalPath2 = path.join(dirs.ws, "browser-downloads", "s1", "y.txt");
      await waitFor(() => exists(finalPath2), "second file lands on disk for the (open but detached) stale state");
      await waitFor(
        () => logged.filter((l) => l.event === "browser_download_after_close_dropped").length >= 2,
        "the second record was dropped via the map-identity disjunct (state was open, not closed)",
      );
      assert.equal(replacement.pendingDownloads.length, 0, "the live replacement state never received the dropped record");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #22: a Browser.cancelDownload send rejection is caught; the failure still records ─

test("downloads #22: when Browser.cancelDownload rejects, the rejection is swallowed and the failed record still surfaces", async () => {
  // The over-cap path sends Browser.cancelDownload and then records a failure. If
  // the CDP send rejects (a dead/racing session), onDownloadProgress must catch it
  // (debug-logged) and STILL record the failure — a regression letting the rejection
  // escape would turn an unhandled rejection loose and the model would never see the
  // failed record.
  await withDirs(async (dirs) => {
    const manager = stubManager();
    const { browser, harness } = makeDownloadBrowser();
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    // A CDP session whose setDownloadBehavior succeeds (so capture is enabled and
    // downloadsCdp is set) but whose cancelDownload send rejects.
    const cancelRejectingCdp = {
      sent: [] as Array<{ method: string; params: Record<string, unknown> | undefined }>,
      handlers: new Map<string, (payload: unknown) => void>(),
      on(event: string, cb: (payload: unknown) => void) { this.handlers.set(event, cb); },
      async send(method: string, params?: Record<string, unknown>) {
        this.sent.push({ method, params });
        if (method === "Browser.cancelDownload") throw new Error("cancel send boom");
        return {};
      },
      emit(event: string, payload: unknown) { this.handlers.get(event)?.(payload); },
    };
    harness.newCdpSession = async () => cancelRejectingCdp;
    const session = new BrowserSession({
      config: baseConfig({ downloads_dir: "/downloads", downloads_local_dir: dirs.staging }),
      agentTimezone: "UTC",
      workspaceRoot: dirs.ws,
      logger: capturingLogger(logged),
      downloadSizeLimit: 10,
      connectOverCdp: async () => browser as never,
    });
    try {
      await session.getActivePage("s1");
      cancelRejectingCdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/huge.iso", suggestedFilename: "huge.iso",
      });
      harness.fireDownload(metadataDownload("https://example.com/huge.iso", "huge.iso"));
      // Breach the cap → the over-cap path sends cancelDownload (which rejects).
      cancelRejectingCdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "inProgress", receivedBytes: 50, totalBytes: 1000,
      });

      // Despite the cancel send rejecting, the failed record must still surface.
      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "the failed record after a rejecting cancel send");
      assert.equal(drained.length, 1, "a failure record surfaces even though the cancel send rejected");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "huge.iso");
      assert.ok(
        cancelRejectingCdp.sent.some((c) => c.method === "Browser.cancelDownload"),
        "the over-cap path attempted Browser.cancelDownload",
      );
      assert.ok(logged.some((l) => l.event === "browser_download_failed"), "the failure was logged");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #22: the staging sweep skips a guid-NAMED directory (the isFile() guard) ──

test("downloads #22: the staging sweep never reaps a guid-named directory (isFile guard)", async () => {
  // STAGING_GUID_RE matches the NAME, so a directory whose name happens to look
  // like a guid must be skipped by the `st.isFile()` guard — the sweep only reaps
  // regular files and never recurses or rmdir's.
  await withDirs(async (dirs) => {
    const { session, manager } = newDownloadSession(dirs);
    try {
      // A directory named exactly like a completed-staging guid, backdated past TTL.
      const guidDir = path.join(dirs.staging, GUID_A);
      await mkdir(guidDir, { recursive: true });
      await writeFile(path.join(guidDir, "inside.txt"), "must survive");
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(guidDir, past, past);

      await session.sweepStagingNow();

      assert.equal(await exists(path.join(guidDir, "inside.txt")), true, "the guid-named directory and its contents survive");
      // And it is still a directory (never rmdir'd / never recursed into).
      const entries = await readdir(guidDir);
      assert.deepEqual(entries, ["inside.txt"], "the directory was left intact");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #2: popup/new-tab downloads correlate to the opener's session ───────────

test("downloads #2: a popup/target=_blank download lands in the OPENER's session dir", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      // s1 opens a tab; a target=_blank export link spawns a popup that downloads.
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "popup bytes");

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/export.csv", suggestedFilename: "export.csv",
      });
      // The page event fires on the POPUP, not the opener page — the OLD code
      // (handler only on tracked pages) would never see this, the entry would
      // never correlate, and the bytes would be reaped after act_timeout_ms.
      harness.firePopupDownload(metadataDownload("https://example.com/export.csv", "export.csv"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 11, totalBytes: 11,
      });

      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "export.csv");
      await waitFor(() => exists(finalPath), "the popup download finalized under the opener's session dir");
      assert.equal((await readFile(finalPath)).toString(), "popup bytes", "bytes copied intact");
      await waitFor(async () => !(await exists(path.join(dirs.staging, GUID_A))), "staging guid unlinked");

      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "the popup download surfaces on the opener's session");
      assert.equal(drained[0]!.path, path.join("browser-downloads", "s1", "export.csv"));
      assert.ok(!drained[0]!.failed);
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #5: an unsafe CDP guid is rejected before it reaches a path join ─────────

test("downloads #5: a guid containing ../ is rejected and touches no path outside staging", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      // A traversal target the OLD code would have copied from / unlinked at:
      // <workspace>/escaped.txt sits one level above the staging dir's sibling.
      const escapeTarget = path.join(dirs.staging, "..", "escaped.txt");
      await writeFile(escapeTarget, "must survive");
      const hostileGuid = "../escaped.txt";

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: hostileGuid, url: "https://example.com/x", suggestedFilename: "x.txt",
      });
      // Even a completion for the hostile guid must not act on it (the entry was
      // never stored, so there is nothing to find).
      harness.cdp.emit("Browser.downloadProgress", {
        guid: hostileGuid, state: "completed", receivedBytes: 4, totalBytes: 4,
      });
      // And a canceled state must not unlink the escape target via unlinkStaging.
      harness.cdp.emit("Browser.downloadProgress", {
        guid: hostileGuid, state: "canceled", receivedBytes: 0, totalBytes: 0,
      });
      await new Promise((r) => setTimeout(r, 30));

      assert.ok(
        logged.some((l) => l.event === "browser_download_guid_rejected"),
        "the hostile guid was rejected with a warn",
      );
      assert.equal(await exists(escapeTarget), true, "the out-of-staging file was never touched");
      const priv = session as unknown as PendingPrivate;
      assert.equal(priv.pendingDownloadEntries.length, 0, "no pending entry was created for the hostile guid");
      assert.equal(session.drainDownloads("s1").length, 0, "nothing recorded");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #6: a size-cap/cancel failure BEFORE correlation still surfaces ──────────

test("downloads #6: an over-cap failure fired before the page event still surfaces a failed record", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { sizeLimit: 10 });
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "partial");

      // CDP side begins AND breaches the cap BEFORE Playwright's page event —
      // the entry has no session yet. The OLD code removed it from the FIFO, so
      // the late page event created an orphan that warn-dropped and the model
      // never saw [download failed: …].
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/huge.iso", suggestedFilename: "huge.iso",
      });
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "inProgress", receivedBytes: 50, totalBytes: 0,
      });
      await waitFor(
        () => harness.cdp.sent.some((c) => c.method === "Browser.cancelDownload"),
        "the over-cap transfer was canceled",
      );
      // Nothing surfaces yet — no session attributed.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(session.drainDownloads("s1").length, 0, "no record before the page event attributes a session");

      // The late page event attaches the opener's session and surfaces the failure.
      harness.fireDownload(metadataDownload("https://example.com/huge.iso", "huge.iso"));
      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "the failed record after late correlation");
      assert.equal(drained.length, 1);
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "huge.iso");
      assert.equal(drained[0]!.path, "", "a failed record carries no workspace path");
      assert.ok(logged.some((l) => l.event === "browser_download_failed"), "failure logged");
      const priv = session as unknown as PendingPrivate;
      assert.equal(priv.pendingDownloadEntries.length, 0, "the entry is dropped once surfaced (no double-record)");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #8: a failed setDownloadBehavior detaches the freshly opened CDP session ──

test("downloads #8: when the override send rejects, the opened CDP session is detached (no leak) and connect still works", async () => {
  await withDirs(async (dirs) => {
    const manager = stubManager();
    const { browser, harness } = makeDownloadBrowser();
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    let detached = 0;
    // A CDP session whose setDownloadBehavior send rejects, exposing detach().
    const failingCdp = {
      sent: [] as Array<{ method: string }>,
      on() {},
      async send(method: string) {
        if (method === "Browser.setDownloadBehavior") throw new Error("send boom");
        return {};
      },
      async detach() { detached++; },
    };
    harness.newCdpSession = async () => failingCdp;
    const session = new BrowserSession({
      config: baseConfig({ downloads_dir: "/downloads", downloads_local_dir: dirs.staging }),
      agentTimezone: "UTC",
      workspaceRoot: dirs.ws,
      logger: capturingLogger(logged),
      connectOverCdp: async () => browser as never,
    });
    try {
      // The override fails, but connect must still succeed (navigation/snapshot
      // keep working) — getActivePage resolves a page.
      const page = await session.getActivePage("s1");
      assert.ok(page, "connect still yields an active page despite the override failure");
      assert.equal(detached, 1, "the half-set-up CDP session was detached exactly once (no leak)");
      assert.ok(
        logged.some((l) => l.event === "browser_download_override_failed"),
        "the override failure was warned",
      );
      // Downloads are disabled: a page download records nothing.
      harness.fireDownload(metadataDownload("https://example.com/f.bin", "f.bin"));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(session.drainDownloads("s1").length, 0, "no capture when the override failed");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #16: newBrowserCDPSession itself rejecting also degrades to downloads-off ──

test("downloads #16: when newBrowserCDPSession rejects, connect still succeeds, the failure is warned, and a later download records nothing", async () => {
  await withDirs(async (dirs) => {
    const manager = stubManager();
    const { browser, harness } = makeDownloadBrowser();
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    // Distinct from #8 (where the SESSION opens but the override SEND rejects):
    // here opening the browser-level CDP session ITSELF rejects, so there is no
    // session to leak — but the connect must STILL succeed (navigation/snapshot
    // keep working) and downloads must degrade to disabled, not propagate the
    // error out of setupDownloadCapture (which connect() awaits — a regression
    // there would break EVERY browser tool call, §2.3).
    harness.newCdpSession = async () => {
      throw new Error("newBrowserCDPSession boom");
    };
    const session = new BrowserSession({
      config: baseConfig({ downloads_dir: "/downloads", downloads_local_dir: dirs.staging }),
      agentTimezone: "UTC",
      workspaceRoot: dirs.ws,
      logger: capturingLogger(logged),
      connectOverCdp: async () => browser as never,
    });
    try {
      const page = await session.getActivePage("s1");
      assert.ok(page, "connect still yields an active page despite the CDP-session open failure");
      assert.equal(harness.cdpSessionsOpened, 1, "newBrowserCDPSession was attempted exactly once");
      assert.ok(
        logged.some((l) => l.event === "browser_download_override_failed"),
        "the override failure was warned",
      );
      assert.equal(
        harness.cdp.sent.filter((c) => c.method === "Browser.setDownloadBehavior").length,
        0,
        "no override was sent (the session never opened)",
      );
      // Downloads are disabled (downloadsCdp stayed undefined): a page download
      // records nothing — and this is the disabled state, NOT a failed transfer,
      // so no failed record surfaces either.
      await writeFile(path.join(dirs.staging, GUID_A), "would-be bytes");
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/f.bin", suggestedFilename: "f.bin",
      });
      harness.fireDownload(metadataDownload("https://example.com/f.bin", "f.bin"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 13, totalBytes: 13,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(session.drainDownloads("s1").length, 0, "downloads disabled ⇒ nothing recorded (not a failed record)");
      assert.equal(
        await exists(path.join(dirs.ws, "browser-downloads", "s1", "f.bin")),
        false,
        "no file finalized into the workspace when downloads are disabled",
      );
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #17: reconnect re-issues the override and resets pending download state ───

test("downloads #17: reconnect re-issues the setDownloadBehavior override and clears stale pending entries", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    const priv = session as unknown as PendingPrivate;
    try {
      // First connect: the override is sent once.
      await session.getActivePage("s1");
      assert.equal(harness.cdpSessionsOpened, 1, "one CDP session on the initial connect");
      assert.equal(
        harness.cdp.sent.filter((c) => c.method === "Browser.setDownloadBehavior").length,
        1,
        "override sent once on the initial connect",
      );

      // Seed a stale pending entry (a CDP willBegin whose page event never landed
      // before the socket dropped) — it references a now-dead transfer/session.
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/stale.bin", suggestedFilename: "stale.bin",
      });
      assert.equal(priv.pendingDownloadEntries.length, 1, "a pending entry is seeded before the disconnect");

      // The socket drops: BrowserSession's disconnected handler must clear
      // downloadsCdp + pendingDownloadEntries (the held CDP session died with the
      // connection; pending entries point at dead transfers).
      harness.fireDisconnect();
      assert.equal(priv.pendingDownloadEntries.length, 0, "the stale pending entry was cleared on disconnect");

      // Reconnect on the next use: the override MUST be re-issued (every connect),
      // and a fresh CDP session opened.
      await session.getActivePage("s1");
      assert.equal(harness.cdpSessionsOpened, 2, "a second CDP session opened on reconnect");
      assert.equal(
        harness.cdp.sent.filter((c) => c.method === "Browser.setDownloadBehavior").length,
        2,
        "the override was re-issued after reconnect (sent a SECOND time)",
      );

      // A fresh download now correlates cleanly against a clean FIFO — it does NOT
      // attach to the stale pre-disconnect entry (which is gone) and finalizes.
      await writeFile(path.join(dirs.staging, GUID_B), "fresh bytes");
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_B, url: "https://example.com/fresh.bin", suggestedFilename: "fresh.bin",
      });
      harness.fireDownload(metadataDownload("https://example.com/fresh.bin", "fresh.bin"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_B, state: "completed", receivedBytes: 11, totalBytes: 11,
      });
      // Poll drainDownloads rather than exists(file) to close the unlink-yield race.
      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "the post-reconnect download finalized cleanly");
      assert.equal(drained.length, 1, "exactly the fresh download surfaces (no stale residue)");
      assert.equal(drained[0]!.filename, "fresh.bin");
      assert.ok(!drained[0]!.failed);
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #20/#12 (ported from the old saveAs path): hostile names stay confined ───

const HOSTILE_FILENAMES: Array<{ name: string; suggested: string }> = [
  { name: "path traversal", suggested: "../../etc/passwd" },
  { name: "absolute-looking path", suggested: "/etc/shadow" },
  { name: "weird chars + spaces", suggested: "my report (final)!.pdf" },
  { name: "null/slash mix", suggested: "a/b\\c:d*e?.bin" },
];

for (const { name, suggested } of HOSTILE_FILENAMES) {
  test(`downloads #20: a hostile suggested filename (${name}) is sanitized and stays under the session dir`, async () => {
    await withDirs(async (dirs) => {
      const { session, harness, manager } = newDownloadSession(dirs);
      // A session id with hostile chars too, to exercise sanitizeSessionId.
      const sessionId = "../sneaky:id";
      try {
        await session.getActivePage(sessionId);
        await writeFile(path.join(dirs.staging, GUID_A), "hostile payload");

        harness.cdp.emit("Browser.downloadWillBegin", {
          guid: GUID_A, url: "https://example.com/file", suggestedFilename: suggested,
        });
        harness.fireDownload(metadataDownload("https://example.com/file", suggested));
        harness.cdp.emit("Browser.downloadProgress", {
          guid: GUID_A, state: "completed", receivedBytes: 15, totalBytes: 15,
        });

        let drained: ReturnType<typeof session.drainDownloads> = [];
        await waitFor(() => (drained = session.drainDownloads(sessionId)).length > 0, "the finalized record");
        assert.equal(drained.length, 1, "exactly one record surfaces");
        const record = drained[0]!;

        // <sanitized-session>/<sanitized-filename>: exactly two safe segments
        // under browser-downloads — never a traversal step or separator.
        const parts = record.path.split(path.sep);
        assert.equal(parts.length, 3, `expected browser-downloads/<session>/<file>, got "${record.path}"`);
        const [rootSeg, sessionSeg, fileSeg] = parts;
        assert.equal(rootSeg, "browser-downloads");
        assert.notEqual(sessionSeg, "..", "session dir is not a traversal step");
        assert.notEqual(fileSeg, "..", "filename is not a traversal step");
        assert.match(sessionSeg!, /^[A-Za-z0-9._-]+$/, "session dir sanitized to the safe charset");
        assert.match(fileSeg!, /^[A-Za-z0-9._-]+$/, `filename not sanitized: "${fileSeg}"`);
        assert.equal(record.filename, fileSeg, "record filename matches the sanitized name");
        // The file actually landed at the sanitized path inside the workspace.
        assert.equal((await readFile(path.join(dirs.ws, record.path))).toString(), "hostile payload");
        // A second drain returns nothing — the buffer was cleared.
        assert.equal(session.drainDownloads(sessionId).length, 0, "downloads cleared after drain");
      } finally {
        manager.restore();
        await session.shutdown();
      }
    });
  });
}

for (const { name, id } of [
  { name: "bare ..", id: ".." },
  { name: "single .", id: "." },
  { name: "triple dots", id: "..." },
]) {
  test(`downloads #12: a ${name} session id is collapsed and stays under browser-downloads`, async () => {
    await withDirs(async (dirs) => {
      const { session, harness, manager } = newDownloadSession(dirs);
      try {
        await session.getActivePage(id);
        await writeFile(path.join(dirs.staging, GUID_A), "dots");

        harness.cdp.emit("Browser.downloadWillBegin", {
          guid: GUID_A, url: "https://example.com/file", suggestedFilename: "file.bin",
        });
        harness.fireDownload(metadataDownload("https://example.com/file", "file.bin"));
        harness.cdp.emit("Browser.downloadProgress", {
          guid: GUID_A, state: "completed", receivedBytes: 4, totalBytes: 4,
        });

        // The dot-only id collapses to the safe sentinel, never a ".." segment.
        // Poll drainDownloads rather than exists(file): the file is written before
        // `await unlink(staging)` yields, so exists() can fire before the record
        // is pushed. The drain poll exits only once finalization is complete.
        let drained: ReturnType<typeof session.drainDownloads> = [];
        await waitFor(() => (drained = session.drainDownloads(id)).length > 0, "file under the collapsed 'session' dir");
        assert.equal(drained.length, 1);
        assert.equal(drained[0]!.path, path.join("browser-downloads", "session", "file.bin"));
      } finally {
        manager.restore();
        await session.shutdown();
      }
    });
  });
}

test("downloads: the staging sweep reaps only old guid-named files (never non-guid names, never fresh guids)", async () => {
  await withDirs(async (dirs) => {
    const { session, manager } = newDownloadSession(dirs);
    try {
      const oldGuid = path.join(dirs.staging, GUID_A);
      const freshGuid = path.join(dirs.staging, GUID_B);
      const nonGuid = path.join(dirs.staging, "keep-me.txt");
      await writeFile(oldGuid, "old orphan");
      await writeFile(freshGuid, "in flight");
      await writeFile(nonGuid, "operator file");
      // Backdate the old guid AND the non-guid file past the TTL.
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(oldGuid, past, past);
      await utimes(nonGuid, past, past);

      await session.sweepStagingNow();

      assert.equal(await exists(oldGuid), false, "old guid orphan reaped");
      assert.equal(await exists(freshGuid), true, "fresh guid (in-flight) kept");
      assert.equal(await exists(nonGuid), true, "non-guid name untouched even when old");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #3: the sweep reaps stale <guid>.crdownload in-flight partials ───────────

test("downloads #3: an aged <guid>.crdownload orphan is reaped while a fresh one is kept", async () => {
  await withDirs(async (dirs) => {
    const { session, manager } = newDownloadSession(dirs);
    try {
      // In-flight downloads are staged as `<guid>.crdownload` and renamed to the
      // bare `<guid>` only on completion. A mid-download crash leaves the
      // `.crdownload` behind — which the OLD bare-guid-only sweep regex could
      // never match, so it leaked forever.
      const oldCr = path.join(dirs.staging, `${GUID_A}.crdownload`);
      const freshCr = path.join(dirs.staging, `${GUID_B}.crdownload`);
      await writeFile(oldCr, "abandoned partial");
      await writeFile(freshCr, "still downloading");
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(oldCr, past, past);

      await session.sweepStagingNow();

      assert.equal(await exists(oldCr), false, "aged .crdownload orphan reaped (old code leaked it)");
      assert.equal(await exists(freshCr), true, "a fresh .crdownload (genuinely in-flight) is kept");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #7: the periodic idle sweep also runs the staging sweep ──────────────────

// ── #20: connect() itself fires the staging sweep (the wiring, not the policy) ─

test("downloads #20: connect() reaps a backdated staging orphan present before connect (no direct sweepStagingNow call)", async () => {
  await withDirs(async (dirs) => {
    const { session, logged, manager } = newDownloadSession(dirs);
    try {
      // Plant an aged guid orphan of BOTH staging forms BEFORE the first connect.
      // connect() must trigger the staging sweep itself (`void this.sweepStagingNow()`),
      // so these get reaped by getActivePage's connect — the test never calls
      // sweepStagingNow OR sweepIdleNow directly, so deleting the connect-time
      // wiring (separate from #7's periodic wiring) fails this.
      const oldGuid = path.join(dirs.staging, GUID_A);
      const oldCr = path.join(dirs.staging, `${GUID_B}.crdownload`);
      await writeFile(oldGuid, "pre-connect orphan");
      await writeFile(oldCr, "pre-connect partial");
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(oldGuid, past, past);
      await utimes(oldCr, past, past);

      await session.getActivePage("s1"); // connect — its connect-time sweep must reap both

      await waitFor(
        async () => !(await exists(oldGuid)) && !(await exists(oldCr)),
        "the pre-connect aged orphans were reaped by connect()'s own sweep",
      );
      assert.ok(
        logged.some((l) => l.event === "browser_download_staging_orphan_reaped"),
        "the connect-time sweep logged the reap",
      );
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads #7: the periodic idle sweep reaps an aged staging orphan (no direct sweepStagingNow call)", async () => {
  await withDirs(async (dirs) => {
    const { session, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1"); // connect; its connect-time sweep sees an empty dir
      // Plant an aged orphan of BOTH staging forms AFTER connect, so only the
      // PERIODIC sweep (piggybacked on sweepIdleNow) can reap them. The test
      // never calls sweepStagingNow directly — deleting the periodic wiring fails it.
      const oldGuid = path.join(dirs.staging, GUID_A);
      const oldCr = path.join(dirs.staging, `${GUID_B}.crdownload`);
      await writeFile(oldGuid, "aged orphan");
      await writeFile(oldCr, "aged partial");
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(oldGuid, past, past);
      await utimes(oldCr, past, past);

      await session.sweepIdleNow();

      await waitFor(async () => !(await exists(oldGuid)) && !(await exists(oldCr)), "aged orphans reaped by the periodic sweep");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #4: a concurrent-download budget bounds the pending map ──────────────────

test("downloads #4: the (N+1)th concurrent download is rejected with a failed record and stages nothing", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      // Saturate the pending map with MAX_PENDING_DOWNLOADS distinct in-flight
      // downloads (CDP willBegin only — each is a distinct (url) so none merge).
      for (let i = 0; i < MAX_PENDING_DOWNLOADS; i++) {
        harness.cdp.emit("Browser.downloadWillBegin", {
          guid: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
          url: `https://example.com/f${i}.bin`,
          suggestedFilename: `f${i}.bin`,
        });
      }
      const priv = session as unknown as PendingPrivate;
      assert.equal(priv.pendingDownloadEntries.length, MAX_PENDING_DOWNLOADS, "pending map saturated at the cap");

      // The (N+1)th download arrives page-side first (the opener's session is
      // known): it must be rejected with a failed record and stage nothing.
      harness.fireDownload(metadataDownload("https://example.com/overflow.bin", "overflow.bin"));
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(
        priv.pendingDownloadEntries.length,
        MAX_PENDING_DOWNLOADS,
        "the overflow download created no new pending entry (it was rejected, not queued)",
      );
      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "exactly one failed record surfaces for the rejected download");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "overflow.bin");
      assert.equal(drained[0]!.path, "", "a rejected download carries no workspace path");
      assert.ok(logged.some((l) => l.event === "browser_download_too_many"), "the rejection was logged");

      // The cap must NOT break correlation of entries already in flight: complete
      // one of the saturating downloads and assert it still finalizes normally.
      await writeFile(path.join(dirs.staging, "00000000-0000-4000-8000-000000000000"), "ok bytes");
      harness.fireDownload(metadataDownload("https://example.com/f0.bin", "f0.bin"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: "00000000-0000-4000-8000-000000000000", state: "completed", receivedBytes: 8, totalBytes: 8,
      });
      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "f0.bin");
      await waitFor(() => exists(finalPath), "an in-flight download under the cap still correlates and finalizes");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #9: a copy failure leaves no partial workspace file and yields a failure ──

test("downloads #9: a copy failure removes the partial workspace file and surfaces a failed record", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      // Drive a normal correlate→complete sequence but NEVER write the staging
      // source, so the finalize copy fails (ENOENT — a non-EEXIST copy error).
      // Pre-plant a truncated file at the exact destination candidate to stand in
      // for a partial left by an earlier mid-copy failure: the OLD code would
      // leave it (and the next finalize would bump past it); the fix unlinks it.
      const destDir = path.join(dirs.ws, "browser-downloads", "s1");
      await mkdir(destDir, { recursive: true });
      const partial = path.join(destDir, "doc.bin");
      await writeFile(partial, "TRUNCATED PARTIAL");

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/doc.bin", suggestedFilename: "doc.bin",
      });
      harness.fireDownload(metadataDownload("https://example.com/doc.bin", "doc.bin"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 4, totalBytes: 4,
      });

      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "the failed record after the copy error");
      assert.equal(drained.length, 1);
      assert.equal(drained[0]!.failed, true, "copy failure yields a failed record");
      assert.equal(drained[0]!.filename, "doc.bin");
      assert.equal(await exists(partial), false, "the partial workspace file was removed (old code left it)");
      assert.ok(logged.some((l) => l.event === "browser_download_failed"), "the copy failure was logged");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// ── #10: a dot-only suggested filename collapses to "download" ───────────────

test("downloads #10: a dot-only suggested filename collapses to \"download\"", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "dot bytes");

      // A suggested filename of ".." would, under the OLD sanitizer, survive as
      // ".." (the charset permits dots) and dead-end as EISDIR/a traversal step.
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/x", suggestedFilename: "..",
      });
      harness.fireDownload(metadataDownload("https://example.com/x", ".."));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 9, totalBytes: 9,
      });

      // Poll drainDownloads rather than exists(file) to close the unlink-yield race
      // (#10 observed failing 0 !== 1 under build-gate CPU contention).
      let drained: ReturnType<typeof session.drainDownloads> = [];
      await waitFor(() => (drained = session.drainDownloads("s1")).length > 0, "the dot-only name collapsed to 'download'");
      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "download");
      assert.equal(drained.length, 1);
      assert.equal(drained[0]!.filename, "download", "dot-only name collapses to the safe fallback");
      assert.equal(drained[0]!.path, path.join("browser-downloads", "s1", "download"));
      assert.equal((await readFile(finalPath)).toString(), "dot bytes", "bytes landed under the safe name");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

// Issue #1: a per-download staging unlink that fails (the root-owned-dir leak)
// must surface at WARN, not debug — every leaked file is a copy stranded in the
// shared ./var volume. chmod can't block root, so meaningful only as non-root.
test("downloads: a failed per-download staging unlink is logged at warn (issue #1)", { skip: process.getuid?.() === 0 }, async () => {
  await withDirs(async (dirs) => {
    const levels: Array<{ level: string; event: string }> = [];
    const manager = stubManager();
    const { browser, harness } = makeDownloadBrowser();
    const levelLogger: import("../src/observability/logger.js").Logger = {
      debug(event) { levels.push({ level: "debug", event }); },
      info(event) { levels.push({ level: "info", event }); },
      warn(event) { levels.push({ level: "warn", event }); },
      error(event) { levels.push({ level: "error", event }); },
      child() { return levelLogger; },
    };
    const session = new BrowserSession({
      config: baseConfig({ downloads_dir: "/downloads", downloads_local_dir: dirs.staging }),
      agentTimezone: "UTC",
      workspaceRoot: dirs.ws,
      logger: levelLogger,
      connectOverCdp: async () => browser as never,
    });
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "hello bytes");
      // Make the staging dir non-writable: the copy OUT still reads the 0644 file,
      // but the post-copy unlink of the staging guid fails with EACCES.
      await chmod(dirs.staging, 0o555);

      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/report.pdf", suggestedFilename: "report.pdf",
      });
      harness.fireDownload(metadataDownload("https://example.com/report.pdf", "report.pdf"));
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 11, totalBytes: 11,
      });

      const finalPath = path.join(dirs.ws, "browser-downloads", "s1", "report.pdf");
      await waitFor(() => exists(finalPath), "the finalized workspace file");
      await waitFor(
        () => levels.some((l) => l.event === "browser_download_staging_unlink_failed"),
        "the staging-unlink-failed log",
      );
      const entry = levels.find((l) => l.event === "browser_download_staging_unlink_failed");
      assert.equal(entry!.level, "warn", "staging-unlink failure logs at warn, not debug");
    } finally {
      await chmod(dirs.staging, 0o755).catch(() => {});
      manager.restore();
      await session.shutdown();
    }
  });
});

// Issue #1: an expired guid orphan the agent cannot unlink (the root-owned
// staging-dir leak) must WARN once per sweep rather than be silently swallowed.
// chmod can't block root, so the test is meaningful only as a non-root user.
test("downloads: the staging sweep warns when it cannot reap an expired orphan (issue #1)", { skip: process.getuid?.() === 0 }, async () => {
  await withDirs(async (dirs) => {
    const { session, logged, manager } = newDownloadSession(dirs);
    try {
      const oldGuid = path.join(dirs.staging, GUID_A);
      await writeFile(oldGuid, "old orphan");
      const past = new Date(Date.now() - STAGING_SWEEP_TTL_MS - 60_000);
      await utimes(oldGuid, past, past);
      // Make the staging directory non-writable so unlink fails with EACCES,
      // standing in for the root-owned-dir leak the probe is meant to catch.
      await chmod(dirs.staging, 0o555);

      await session.sweepStagingNow();

      assert.equal(
        logged.filter((l) => l.event === "browser_download_staging_orphan_unreaped").length,
        1,
        "an unreapable expired orphan warns exactly once per sweep",
      );
      assert.equal(await exists(oldGuid), true, "the orphan was NOT reaped (unlink failed)");
    } finally {
      await chmod(dirs.staging, 0o755).catch(() => {});
      manager.restore();
      await session.shutdown();
    }
  });
});
