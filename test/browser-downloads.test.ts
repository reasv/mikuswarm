import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserSession, STAGING_SWEEP_TTL_MS, type ConnectOverCdp } from "../src/browser/session.js";
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
  const context = { newPage: async () => fakePage, pages: () => [fakePage] };
  const harness: DownloadHarness = {
    cdp,
    cdpSessionsOpened: 0,
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
    isConnected: () => true,
    on: () => {},
    close: async () => {},
    newBrowserCDPSession: async () => {
      harness.cdpSessionsOpened++;
      if (harness.newCdpSession) return harness.newCdpSession();
      return cdp;
    },
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

function newDownloadSession(dirs: Dirs, opts: { sizeLimit?: number; configured?: boolean } = {}): SessionBundle {
  const manager = stubManager();
  const { browser, harness } = makeDownloadBrowser();
  const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const connect: ConnectOverCdp = async () => browser as never;
  const configured = opts.configured ?? true;
  const session = new BrowserSession({
    config: baseConfig(
      configured ? { downloads_dir: "/downloads", downloads_local_dir: dirs.staging } : {},
    ),
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

      await waitFor(() => exists(path.join(dirs.ws, "browser-downloads", "s1", "a.txt")), "finalized file");
      assert.equal(session.drainDownloads("s1").length, 1);
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
      await waitFor(() => exists(path.join(dirs.ws, "browser-downloads", "s1", "r.bin")), "finalized file");
      assert.equal(session.drainDownloads("s1").length, 1);
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
      assert.equal(session.drainDownloads("s1").length, 2, "two records surface");
      assert.equal((await readdir(dirs.staging)).length, 0, "staging emptied");
    } finally {
      manager.restore();
      await session.shutdown();
    }
  });
});

test("downloads: an uncorrelated entry past its deadline is dropped with a warn and its staging bytes reaped", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs);
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "orphan");

      // CDP stream only — the page-event counterpart never arrives.
      harness.cdp.emit("Browser.downloadWillBegin", {
        guid: GUID_A, url: "https://example.com/orphan.bin", suggestedFilename: "orphan.bin",
      });
      harness.cdp.emit("Browser.downloadProgress", {
        guid: GUID_A, state: "completed", receivedBytes: 6, totalBytes: 6,
      });
      await new Promise((r) => setTimeout(r, 20));

      // Backdate the entry past its act_timeout_ms deadline (test seam, like
      // forceIdle in browser-session.test.ts), then run the periodic sweep.
      const priv = session as unknown as PendingPrivate;
      assert.equal(priv.pendingDownloadEntries.length, 1, "entry pending correlation");
      priv.pendingDownloadEntries[0]!.expiresAt = 0;
      await session.sweepIdleNow();

      assert.equal(priv.pendingDownloadEntries.length, 0, "entry dropped");
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

test("downloads: a transfer over the size cap is canceled, its partial unlinked, and a failed record surfaces", async () => {
  await withDirs(async (dirs) => {
    const { session, harness, logged, manager } = newDownloadSession(dirs, { sizeLimit: 10 });
    try {
      await session.getActivePage("s1");
      await writeFile(path.join(dirs.staging, GUID_A), "partial-bytes-on-disk");

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
      await waitFor(async () => !(await exists(path.join(dirs.staging, GUID_A))), "partial staging file unlinked");

      const drained = session.drainDownloads("s1");
      assert.equal(drained.length, 1, "a failure record surfaces");
      assert.equal(drained[0]!.failed, true);
      assert.equal(drained[0]!.filename, "huge.iso");
      assert.equal(drained[0]!.path, "", "a failed record carries no workspace path");
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
        const finalPath = path.join(dirs.ws, "browser-downloads", "session", "file.bin");
        await waitFor(() => exists(finalPath), "file under the collapsed 'session' dir");
        const drained = session.drainDownloads(id);
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
