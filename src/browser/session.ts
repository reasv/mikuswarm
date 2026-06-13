// BrowserSession — owns the single connectOverCDP link to the one persistent
// CloakBrowser identity and multiplexes per-chat-session tabs over it (spec §4).
//
// Design (phase-0 confirmed):
//   - One persistent context (the Manager launches launch_persistent_context).
//     connectOverCDP(browser-level) → browser.contexts()[0] is that context.
//   - Each chat session gets its OWN page(s) (tabs) inside that shared context,
//     so cookies/logins/fingerprint are shared (one Miku) but refs/current-page
//     are per session. Sessions never touch the Manager's initial page or each
//     other's pages — every page is created by us and tracked per sessionId.
//   - Lazy + idempotent: nothing happens at app startup; the first browser-tool
//     call resolves/creates the profile, ensures it is launched, connects, and
//     caches. A dropped connection transparently reconnects on next use.
//   - Bounded growth: a session's tabs are closed when the session ends
//     (closeSession) or after session_page_idle_ms of inactivity (idle sweeper).

import { constants as fsConstants, copyFile, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type Download,
  type Page,
} from "playwright-core";

import type { BrowserConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { BrowserError } from "./errors.js";
import { ManagerClient, type ProfileCreateInput } from "./manager-client.js";

export interface DownloadRecord {
  /** Workspace-relative path the file was saved to ("" for a failed download). */
  path: string;
  filename: string;
  url: string;
  /**
   * Set when the download produced no file (canceled, over the size cap, or the
   * staging→workspace copy failed). Surfaced so the model learns the click did
   * not produce a file instead of the loss being silent.
   */
  failed?: boolean;
}

/** One buffered console/pageerror line, drained by the `console` action. */
export interface ConsoleEntry {
  /** console level (`log`/`info`/`warning`/`error`/…) or `error` for a pageerror. */
  level: string;
  text: string;
}

/** Cap the NUMBER of entries each page's console buffer holds. */
const CONSOLE_BUFFER_MAX = 200;

/**
 * Cap the SIZE of a single console/pageerror entry's text, applied AT PUSH TIME.
 * Without this, one `console.log(hugeString)` would park a multi-MB string in the
 * buffer (CONSOLE_BUFFER_MAX only bounds entry count) and later dump it straight
 * into agent context on drain. 4 KB is far above any legible diagnostic line; a
 * fixed bound matches the codebase's other defensive caps (e.g. the `text` tool
 * arg's `maxLength`), so no config knob is warranted.
 */
export const CONSOLE_ENTRY_MAX_CHARS = 4096;

/**
 * Second-layer cap on the TOTAL text the `console` action returns per drain. Even
 * with each entry bounded, CONSOLE_BUFFER_MAX entries near the per-entry cap could
 * still concatenate to ~800 KB; this keeps the rendered block context-friendly.
 */
export const CONSOLE_DRAIN_MAX_CHARS = 16384;

/** Appended when an entry or the drained block is truncated. */
export const CONSOLE_TRUNCATION_MARKER = "… [truncated]";

interface SessionState {
  /** Tabs owned by this chat session, in open order. */
  pages: Page[];
  /** Index into `pages` of the active tab. */
  activeIndex: number;
  lastUsed: number;
  /** Downloads captured since the last drain, surfaced in tool results. */
  pendingDownloads: DownloadRecord[];
  /** Monotonic counter for naming exported PDFs (page-1.pdf, page-2.pdf, …). */
  pdfCount: number;
  /**
   * Number of browser-tool operations currently in flight against this session
   * (issue #1). Bracketed by beginOp/endOp around every page-using tool op so
   * the idle sweeper never reaps a session mid-operation (which would close the
   * page out from under a long goto/wait → confusing "Target closed" instead of
   * a clean timeout). > 0 means "busy — do not reap".
   */
  inFlight: number;
  /**
   * Set once closeSession() has detached this state from `sessions` (issue #14).
   * A download whose saveAs() resolves AFTER the session closed must not push
   * its record onto this now-orphaned array (drainDownloads can never reach it);
   * handleDownload checks this and the live-session map and deliberately drops.
   */
  closed: boolean;
  /**
   * In-flight lazy creation of this session's first tab. Single-flights
   * concurrent getActivePage() callers so they share one tab instead of each
   * racing to open one (mirrors connectPromise). Cleared on settle.
   */
  firstPagePromise?: Promise<void>;
}

/**
 * One in-flight download being correlated across the two event streams
 * (ARCHITECTURE.md §11b "Downloads"): our browser-level CDP session supplies the
 * guid (staging filename) + completion/progress, the Playwright `download` page
 * event supplies the owning chat session. Either stream may arrive first; an
 * entry created by one side is completed by the other, matched FIFO on
 * (url, suggestedFilename).
 */
interface PendingDownloadEntry {
  url: string;
  suggestedFilename: string;
  /** CDP side (Browser.downloadWillBegin): the staging filename. */
  guid?: string;
  /** Playwright side (page.on("download")): session attribution. */
  sessionId?: string;
  state?: SessionState;
  /** Set when Browser.downloadProgress completed before correlation finished. */
  completed: boolean;
  /**
   * Deadline for the missing counterpart (act_timeout_ms from creation), set to
   * Infinity once correlated. An entry that never sees its counterpart is
   * dropped with a warn log; correlated entries live until completed/canceled
   * (or the connection drops).
   */
  expiresAt: number;
}

/** Staging filenames written by `allowAndName` are 36-char guids — match nothing else. */
const STAGING_GUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Connect-time staging-hygiene TTL: guid files older than this are orphans from
 * crashes/disconnects mid-download (in-flight downloads are recent by definition).
 */
export const STAGING_SWEEP_TTL_MS = 60 * 60 * 1000;

/** Connect to a CDP endpoint. Injectable so tests can supply a fake browser. */
export type ConnectOverCdp = (
  endpoint: string,
  options: { headers?: Record<string, string>; timeout: number },
) => Promise<Browser>;

export interface BrowserSessionOptions {
  config: BrowserConfig;
  /** Fallback timezone (agent.timezone) when config.timezone is unset. */
  agentTimezone: string;
  /** Absolute workspace root; downloads are saved beneath it. */
  workspaceRoot: string;
  logger: Logger;
  /**
   * Cap for a single browser download (media.download_size_limit). A transfer
   * whose received or declared total bytes exceed it is canceled mid-flight and
   * surfaces as a failed record. Defaults to 1 GiB (the media schema default).
   */
  downloadSizeLimit?: number;
  /** Override the CDP connector (tests). Defaults to chromium.connectOverCDP. */
  connectOverCdp?: ConnectOverCdp;
}

const SWEEP_INTERVAL_MS = 30_000;

/**
 * After a failed connect, suppress reconnect attempts arriving within this
 * window by re-throwing the cached failure WITHOUT re-hitting the Manager.
 * Caps reconnect-thrash against a flapping Manager (issue #12). Pacing of
 * subsequent retries is otherwise left to the model's own cadence.
 */
const CONNECT_COOLDOWN_MS = 2_000;

/**
 * While waiting for a cold-started profile to become CDP-ready, poll the
 * Manager's status at this cadence (issue #13). The total wait is bounded by
 * connect_timeout_ms, not by this interval.
 */
const LAUNCH_POLL_INTERVAL_MS = 500;

export class BrowserSession {
  private readonly config: BrowserConfig;
  private readonly agentTimezone: string;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;
  private readonly manager: ManagerClient;

  /**
   * Download staging (ARCHITECTURE.md §11b "Downloads"): the shared staging dir
   * as seen by the browser container (sent verbatim over CDP) and by this
   * process (resolved against cwd). Both set ⇒ downloads enabled; both unset ⇒
   * disabled (validated as set-together in app.ts).
   */
  private readonly downloadsDir: string | undefined;
  private readonly downloadsLocalDir: string | undefined;
  private readonly downloadSizeLimit: number;
  /**
   * Browser-level CDP session that owns download routing: it sent the
   * Browser.setDownloadBehavior override and keeps receiving
   * downloadWillBegin/downloadProgress for the life of the connection.
   * undefined ⇔ downloads are disabled (unconfigured, or the override failed).
   */
  private downloadsCdp: CDPSession | undefined;
  /** In-flight downloads awaiting correlation/completion, in arrival order (FIFO). */
  private pendingDownloadEntries: PendingDownloadEntry[] = [];

  /** In-flight or resolved connection. Cleared on disconnect to force reconnect. */
  private connectPromise: Promise<BrowserContext> | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;

  /**
   * Wall-clock of the last failed connect() and the error it produced. Used to
   * short-circuit reconnects within CONNECT_COOLDOWN_MS so a flapping Manager
   * isn't hammered (issue #12). Reset on a successful connect.
   */
  private lastConnectFailureAt = 0;
  private lastConnectError: BrowserError | undefined;

  private readonly sessions = new Map<string, SessionState>();
  /**
   * One-shot per-page dialog overrides armed by the `act:dialog` kind (see
   * armDialog). Keyed by Page so an override set on the active tab applies to
   * that tab's next dialog. WeakMap → no cleanup needed when a page is GC'd.
   */
  private readonly dialogOverrides = new WeakMap<Page, { accept: boolean; promptText?: string; expiresAt: number }>();
  /**
   * Per-page console + pageerror ring buffers, drained by the `console` action.
   * Standing instrumentation wired at page setup; bounded at CONSOLE_BUFFER_MAX.
   * WeakMap → buffers are GC'd with their page, no explicit cleanup.
   */
  private readonly consoleBuffers = new WeakMap<Page, ConsoleEntry[]>();
  /**
   * Per-page snapshot-time frame URLs (index → URL), the `frameUrls` map from the
   * most recent `aiSnapshot` of that page. Recorded by recordFrameUrls() after
   * each snapshot and consulted by the next `act` (via frameUrlsFor) to detect
   * frame reordering between snapshot and act (a reused index landing on a
   * different live frame → `ref_expired`). WeakMap → cleared with the page on GC.
   */
  private readonly frameUrls = new WeakMap<Page, Map<number, string>>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly connectOverCdp: ConnectOverCdp;

  constructor(opts: BrowserSessionOptions) {
    this.config = opts.config;
    this.agentTimezone = opts.agentTimezone;
    this.workspaceRoot = opts.workspaceRoot;
    this.logger = opts.logger;
    this.downloadsDir = opts.config.downloads_dir;
    this.downloadsLocalDir =
      opts.config.downloads_local_dir !== undefined ? path.resolve(opts.config.downloads_local_dir) : undefined;
    this.downloadSizeLimit = opts.downloadSizeLimit ?? 1_073_741_824;
    this.connectOverCdp =
      opts.connectOverCdp ??
      ((endpoint, options) => chromium.connectOverCDP(endpoint, options));
    this.manager = new ManagerClient({
      baseUrl: opts.config.manager_url,
      authToken: opts.config.auth_token,
      timeoutMs: opts.config.connect_timeout_ms,
      logger: opts.logger,
    });
  }

  // ── Connection bootstrap ─────────────────────────────────────────────────

  /**
   * Ensure we have a live persistent context, connecting (and bootstrapping the
   * profile) on first use. Concurrent callers share a single in-flight connect.
   */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.closed) throw new BrowserError("backend_unavailable", "Browser backend is shutting down.");
    if (this.context && this.browser?.isConnected()) return this.context;
    // Reconnect cooldown (issue #12): if a recent connect failed, re-throw the
    // cached error without re-hitting the Manager. Never blocks the first
    // connect (lastConnectError is undefined until a failure is recorded).
    if (this.lastConnectError && Date.now() - this.lastConnectFailureAt < CONNECT_COOLDOWN_MS) {
      throw this.lastConnectError;
    }
    this.connectPromise ??= this.connect().then(
      (context) => {
        // Successful connect clears any prior failure cooldown.
        this.lastConnectFailureAt = 0;
        this.lastConnectError = undefined;
        return context;
      },
      (error) => {
        // Record the failure for the cooldown and allow a later retry.
        this.lastConnectFailureAt = Date.now();
        this.lastConnectError =
          error instanceof BrowserError
            ? error
            : new BrowserError("connect_failed", error instanceof Error ? error.message : String(error), { cause: error });
        this.connectPromise = undefined;
        throw error;
      },
    );
    return this.connectPromise;
  }

  private async connect(): Promise<BrowserContext> {
    const profile = await this.resolveOrCreateProfile();
    const launched = await this.ensureLaunched(profile.id);

    const cdpEndpoint = `${this.manager.base}/api/profiles/${encodeURIComponent(profile.id)}/cdp`;
    const headers = this.config.auth_token
      ? { Authorization: `Bearer ${this.config.auth_token}` }
      : undefined;

    // If we just issued a launch, Chromium may not be CDP-ready the instant the
    // Manager accepts the request, so poll until ready or connect_timeout_ms
    // elapses — letting a genuine cold start succeed on the FIRST tool call
    // instead of costing one guaranteed-failed call (issue #13). When the
    // profile was already running we connect once with no extra wait (fast path).
    const browser = launched
      ? await this.connectColdStart(profile.id, cdpEndpoint, headers)
      : await this.connectCdp(cdpEndpoint, headers, this.config.connect_timeout_ms);

    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new BrowserError("connect_failed", "Connected to the Manager but it exposed no browser context.");
    }

    // Reconnect-on-drop: clear the cache so the next ensureContext() reconnects.
    // Per-session pages are dead once the socket drops, so drop their state too.
    // Guard on identity (issue #5): a late disconnect from an OLD browser must
    // not clobber a newer connection we've since established. Only clear shared
    // state if it still points at the browser whose socket just dropped.
    browser.on("disconnected", () => {
      if (this.browser !== browser) {
        this.logger.debug("browser_disconnected_stale");
        return;
      }
      this.logger.warn("browser_disconnected");
      this.browser = undefined;
      this.context = undefined;
      this.connectPromise = undefined;
      this.sessions.clear();
      // The held download CDP session died with the socket; pending entries
      // reference dead sessions/transfers. Orphaned staging bytes are reaped by
      // the next connect's TTL sweep.
      this.downloadsCdp = undefined;
      this.pendingDownloadEntries = [];
    });

    this.browser = browser;
    this.context = context;
    // Take ownership of download routing (initial connect AND every reconnect).
    // Awaited so a download triggered right after connect can't slip past the
    // override; never throws (a failure degrades to "downloads disabled").
    await this.setupDownloadCapture(browser);
    // Staging hygiene: fire-and-forget, must not delay or fail the connect.
    void this.sweepStagingNow();
    this.startSweeper();
    this.logger.info("browser_connected", { profileId: profile.id, cdpEndpoint });
    return context;
  }

  /**
   * Single connectOverCDP attempt, mapping the underlying failure to an
   * actionable BrowserError: 401/unauthorized → auth_failed (retrying won't
   * fix auth, issue #9), everything else → connect_failed ("warming up").
   */
  private async connectCdp(
    cdpEndpoint: string,
    headers: Record<string, string> | undefined,
    timeoutMs: number,
  ): Promise<Browser> {
    try {
      return await this.connectOverCdp(cdpEndpoint, { headers, timeout: timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A 401 on the CDP WebSocket upgrade is an auth problem, not a cold start —
      // retrying won't fix it, so surface auth_failed rather than connect_failed
      // (issue #9). REST normally 401s first, but the WS path can 401 alone.
      if (/\b401\b|unauthorized/i.test(message)) {
        throw new BrowserError(
          "auth_failed",
          `CloakBrowser-Manager rejected the CDP connection (401 Unauthorized: ${message}). Check that [browser].auth_token matches the Manager's AUTH_TOKEN.`,
          { cause: error },
        );
      }
      throw new BrowserError(
        "connect_failed",
        `connectOverCDP to the CloakBrowser-Manager failed (${message}). The profile may still be warming up — retry shortly.`,
        { cause: error },
      );
    }
  }

  /**
   * Connect after a cold-start launch: poll connectOverCDP (interleaved with a
   * short wait) until the profile is CDP-ready or connect_timeout_ms elapses
   * (issue #13). A non-auth connect failure is treated as "not ready yet" and
   * retried within budget; auth_failed is fatal immediately (retrying won't
   * help). If the whole budget is exhausted, the last connect_failed
   * ("warming up") is surfaced so the model can retry on its own cadence.
   */
  private async connectColdStart(
    profileId: string,
    cdpEndpoint: string,
    headers: Record<string, string> | undefined,
  ): Promise<Browser> {
    const deadline = Date.now() + this.config.connect_timeout_ms;
    let lastError: BrowserError | undefined;
    for (;;) {
      // Abort the poll promptly if the backend is shutting down rather than
      // spinning out the full connect_timeout_ms budget after shutdown().
      if (this.closed) throw new BrowserError("backend_unavailable", "Browser backend is shutting down.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw (
          lastError ??
          new BrowserError(
            "connect_failed",
            `Browser profile did not become CDP-ready within ${this.config.connect_timeout_ms}ms (warming up). Retry shortly.`,
          )
        );
      }
      try {
        return await this.connectCdp(cdpEndpoint, headers, remaining);
      } catch (error) {
        // Auth failures won't resolve by waiting — surface immediately.
        if (error instanceof BrowserError && error.code === "auth_failed") throw error;
        lastError = error instanceof BrowserError ? error : undefined;
        this.logger.debug("browser_cold_start_poll", { profileId });
      }
      // Wait before the next attempt, but never past the deadline.
      const wait = Math.min(LAUNCH_POLL_INTERVAL_MS, deadline - Date.now());
      if (wait <= 0) continue;
      await delay(wait);
    }
  }

  /** Resolve the persistent profile by name; create it (idempotently) if absent. */
  private async resolveOrCreateProfile(): Promise<{ id: string; status: string }> {
    const name = this.config.profile_name;
    const profiles = await this.manager.listProfiles();
    const existing = profiles.find((p) => p.name === name);
    if (existing) return { id: existing.id, status: existing.status };

    const input: ProfileCreateInput = {
      name,
      platform: this.config.platform,
      // 0/unset ⇒ let the Manager pick a random seed once and persist it.
      fingerprint_seed: this.config.fingerprint_seed ? this.config.fingerprint_seed : undefined,
      timezone: this.config.timezone ?? this.agentTimezone,
      locale: this.config.locale ?? deriveLocale(this.config.timezone ?? this.agentTimezone),
      proxy: this.config.proxy ? this.config.proxy : undefined,
      humanize: this.config.humanize,
      geoip: this.config.geoip,
      auto_launch: true,
      screen_width: this.config.screen_width,
      screen_height: this.config.screen_height,
    };
    try {
      const created = await this.manager.createProfile(input);
      this.logger.info("browser_profile_created", { profileId: created.id, name });
      return { id: created.id, status: created.status };
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError(
        "profile_launch_failed",
        `Failed to create browser profile "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Ensure the profile is running (launch if stopped; 409 already-running is
   * fine). Returns true iff a launch was actually issued — the caller uses this
   * to decide whether a post-launch readiness poll is needed (issue #13). An
   * already-running profile returns false and skips the poll (fast path).
   */
  private async ensureLaunched(profileId: string): Promise<boolean> {
    const status = await this.manager.getStatus(profileId);
    if (status.status === "running") return false;
    this.logger.info("browser_profile_launching", { profileId });
    await this.manager.launch(profileId);
    return true;
  }

  // ── In-flight op tracking (issue #1) ─────────────────────────────────────

  /**
   * Mark a browser-tool operation as starting against this session: increments
   * the in-flight ref-count and refreshes lastUsed so the op's whole duration
   * counts as activity. While inFlight > 0 the idle sweeper will not reap the
   * session, so a long goto/wait can't have its page closed out from under it.
   * Must be paired with endOp() (use a try/finally — see runOp).
   */
  beginOp(sessionId: string): void {
    const state = this.getOrCreateState(sessionId);
    state.inFlight++;
    state.lastUsed = Date.now();
  }

  /**
   * Mark a browser-tool operation as finished. Refreshes lastUsed so the idle
   * clock resets at op completion (a long op shouldn't be instantly reapable the
   * moment it returns). Tolerant of a missing/already-closed session.
   */
  endOp(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.inFlight > 0) state.inFlight--;
    state.lastUsed = Date.now();
  }

  /**
   * Run a browser-tool operation bracketed by beginOp/endOp so the idle sweeper
   * never reaps the session mid-op (issue #1). Symmetric even on throw. Every
   * page-using path in the tool layer should go through this.
   */
  async runOp<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    this.beginOp(sessionId);
    try {
      return await fn();
    } finally {
      this.endOp(sessionId);
    }
  }

  // ── Per-session tab management ───────────────────────────────────────────

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { pages: [], activeIndex: 0, lastUsed: Date.now(), pendingDownloads: [], pdfCount: 0, inFlight: 0, closed: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Drop pages that the context reports as closed (crash / external close). */
  private compact(state: SessionState): void {
    const live = state.pages.filter((p) => !p.isClosed());
    if (live.length !== state.pages.length) {
      state.pages = live;
      if (state.activeIndex >= state.pages.length) state.activeIndex = Math.max(0, state.pages.length - 1);
    }
  }

  /**
   * Resolve the active page for a session, creating the session's first tab
   * lazily (and reconnecting / recreating transparently after a drop).
   */
  async getActivePage(sessionId: string): Promise<Page> {
    await this.ensureContext();
    const state = this.getOrCreateState(sessionId);
    state.lastUsed = Date.now();
    this.compact(state);
    if (state.pages.length === 0) {
      // Single-flight lazy first-tab creation (issue #6): two concurrent calls
      // both seeing pages.length === 0 must share ONE openTab, not each open a
      // tab. Mirror the connectPromise pattern; clear on settle so a failed
      // creation can be retried.
      state.firstPagePromise ??= this.openTab(sessionId)
        .then(() => undefined)
        .finally(() => {
          state.firstPagePromise = undefined;
        });
      await state.firstPagePromise;
    }
    return state.pages[state.activeIndex]!;
  }

  /** Open a new tab for the session and make it active. Returns its index. */
  async openTab(sessionId: string): Promise<number> {
    const context = await this.ensureContext();
    const state = this.getOrCreateState(sessionId);
    state.lastUsed = Date.now();
    const page = await context.newPage();
    this.trackPage(sessionId, state, page);
    state.pages.push(page);
    state.activeIndex = state.pages.length - 1;
    return state.activeIndex;
  }

  /** List the session's tabs (index, url, title, active marker). */
  async listTabs(sessionId: string): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    this.compact(state);
    const out: Array<{ index: number; url: string; title: string; active: boolean }> = [];
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i]!;
      let title = "";
      try {
        title = await page.title();
      } catch {
        title = "";
      }
      out.push({ index: i, url: page.url(), title, active: i === state.activeIndex });
    }
    return out;
  }

  /** Switch the active tab. */
  setActiveTab(sessionId: string, index: number): void {
    const state = this.sessions.get(sessionId);
    if (!state) throw new BrowserError("no_active_page", "This session has no open tabs.");
    this.compact(state);
    // An empty-pages state can exist transiently (beginOp creates state before
    // any tab); treat it the same as a missing session.
    if (state.pages.length === 0) throw new BrowserError("no_active_page", "This session has no open tabs.");
    if (index < 0 || index >= state.pages.length) {
      throw new BrowserError("bad_request", `Tab index ${index} is out of range (0..${state.pages.length - 1}).`);
    }
    state.activeIndex = index;
    state.lastUsed = Date.now();
  }

  /** Close one of the session's tabs. */
  async closeTab(sessionId: string, index: number): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new BrowserError("no_active_page", "This session has no open tabs.");
    this.compact(state);
    if (state.pages.length === 0) throw new BrowserError("no_active_page", "This session has no open tabs.");
    const page = state.pages[index];
    if (!page) {
      throw new BrowserError("bad_request", `Tab index ${index} is out of range (0..${state.pages.length - 1}).`);
    }
    await page.close().catch(() => {});
    state.pages.splice(index, 1);
    if (state.activeIndex >= state.pages.length) state.activeIndex = Math.max(0, state.pages.length - 1);
    state.lastUsed = Date.now();
  }

  /**
   * Export the active page to a PDF in the session's workspace download dir and
   * return its record (path/filename/url). Uses CDP `Page.printToPDF` — NOT
   * `page.pdf()`, which Chromium only supports in headless mode; the stealth
   * browser runs headed, so the CDP path is the only one that works. Reuses the
   * download-sink path policy (`browser-downloads/<session>/`) so a PDF looks
   * like any other download. Write-only from the agent's view — miku has no PDF
   * ingestion, so the caller forwards the returned path to the message tool.
   * Throws `pdf_failed` if printToPDF is unsupported/errors or the file can't be
   * written.
   *
   * The `page-<n>.pdf` name is collision-proof against the *on-disk* state, not
   * the in-memory counter (issue #2): `pdfCount` resets to 0 whenever SessionState
   * is destroyed (idle-reap ~10 min, disconnect), but the download dir + its
   * `page-*.pdf` files persist — so trusting the counter alone would let a
   * post-reset export reuse `page-1.pdf` and silently clobber the earlier file.
   * Instead the number is bumped until free against the directory contents (seeded
   * from any existing `page-*.pdf`) and committed to `pdfCount` only AFTER a
   * successful write, so a failed export never advances the counter.
   */
  async exportPdf(sessionId: string, page: Page): Promise<DownloadRecord> {
    const state = this.sessions.get(sessionId);
    const relDir = path.join("browser-downloads", sanitizeSessionId(sessionId));
    const absDir = path.join(this.workspaceRoot, relDir);
    const url = page.url();

    const cdp = await page.context().newCDPSession(page);
    let data: string;
    try {
      const result = (await cdp.send("Page.printToPDF", { printBackground: true })) as { data: string };
      data = result.data;
    } catch (error) {
      throw new BrowserError(
        "pdf_failed",
        `PDF export failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      await cdp.detach().catch(() => {});
    }

    let n: number;
    let safeName: string;
    try {
      await mkdir(absDir, { recursive: true });
      // Bump-until-free: start from max(in-memory counter, highest existing
      // page-<n>.pdf on disk) and walk forward to the first free name. The disk
      // scan makes a reset counter (idle-reap/disconnect, issue #2) unable to
      // clobber an earlier export; the `wx` (write-exclusive) flag is the final
      // guard so even a concurrent export can't land on the same name. The
      // single-writer model means the loop converges in one step in practice.
      n = Math.max(state?.pdfCount ?? 0, await highestPdfIndex(absDir));
      for (;;) {
        n += 1;
        safeName = `page-${n}.pdf`;
        try {
          await writeFile(path.join(absDir, safeName), Buffer.from(data, "base64"), { flag: "wx" });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
      }
    } catch (error) {
      throw new BrowserError(
        "pdf_failed",
        `PDF export could not be written to the workspace: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // Commit the chosen number only AFTER a successful write — so a failed export
    // never advances the counter, and the next export in this live session can
    // skip the rescan.
    if (state) state.pdfCount = n;
    const relPath = path.join(relDir, safeName);
    this.logger.info("browser_pdf_export", { sessionId, path: relPath, url });
    return { path: relPath, filename: safeName, url };
  }

  /** Drain (and clear) downloads captured for this session since the last call. */
  drainDownloads(sessionId: string): DownloadRecord[] {
    const state = this.sessions.get(sessionId);
    if (!state || state.pendingDownloads.length === 0) return [];
    const out = state.pendingDownloads;
    state.pendingDownloads = [];
    return out;
  }

  /**
   * Wire auto dialog handling + download capture onto a freshly created page
   * (spec §5.1). Without the dialog handler an unhandled alert/confirm/prompt
   * deadlocks the page, so this is not optional.
   */
  private trackPage(sessionId: string, state: SessionState, page: Page): void {
    page.on("dialog", (dialog: Dialog) => {
      void this.handleDialog(page, dialog);
    });
    page.on("download", (download: Download) => {
      this.handleDownload(sessionId, state, download);
    });
    // Console + uncaught page errors → a bounded per-page buffer the agent can
    // drain via the `console` action to self-diagnose a silently-failing page.
    this.consoleBuffers.set(page, []);
    page.on("console", (msg) => this.pushConsole(page, { level: msg.type(), text: msg.text() }));
    page.on("pageerror", (err: Error) => this.pushConsole(page, { level: "error", text: err?.message ?? String(err) }));
  }

  private pushConsole(page: Page, entry: ConsoleEntry): void {
    const buf = this.consoleBuffers.get(page);
    if (!buf) return;
    // Bound the per-entry text HERE (not just at drain) so the buffer itself can
    // never retain an unbounded string — this is the real memory bound.
    if (entry.text.length > CONSOLE_ENTRY_MAX_CHARS) {
      entry = {
        level: entry.level,
        text: entry.text.slice(0, CONSOLE_ENTRY_MAX_CHARS) + CONSOLE_TRUNCATION_MARKER,
      };
    }
    buf.push(entry);
    if (buf.length > CONSOLE_BUFFER_MAX) buf.splice(0, buf.length - CONSOLE_BUFFER_MAX);
  }

  /**
   * Record the snapshot-time frame URLs for `page` (the `frameUrls` from the
   * `aiSnapshot` just rendered). The next `act` on this page reads them via
   * frameUrlsFor() to detect frame reordering (see requireRefLocator). Each
   * snapshot fully replaces the previous map so a stale entry can't outlive the
   * snapshot it described.
   */
  recordFrameUrls(page: Page, urls: Map<number, string>): void {
    this.frameUrls.set(page, urls);
  }

  /** The most recently recorded snapshot-time frame URLs for `page` (or undefined). */
  frameUrlsFor(page: Page): Map<number, string> | undefined {
    return this.frameUrls.get(page);
  }

  /** Drain (and clear) buffered console/pageerror messages for `page`. */
  drainConsole(page: Page): ConsoleEntry[] {
    const buf = this.consoleBuffers.get(page);
    if (!buf || buf.length === 0) return [];
    const out = buf.slice();
    buf.length = 0;
    return out;
  }

  private async handleDialog(page: Page, dialog: Dialog): Promise<void> {
    try {
      // A one-shot act:dialog override (armed on this page) takes precedence over
      // the standing dialog_policy for exactly the next dialog. It's consumed
      // (deleted) whether or not it's still valid; an expired one falls through
      // to the default policy so an armed-but-never-triggered override can't
      // hijack a later, unrelated dialog.
      const override = this.dialogOverrides.get(page);
      if (override) {
        // Delete BEFORE the expiry check by design: an expired override is
        // eagerly consumed even by an unrelated later dialog. That's the correct
        // outcome — the override's window has passed, so this dialog must get the
        // default policy AND the stale slot must not survive to hijack the next
        // dialog after it. (Consuming an expired slot here only ever falls through
        // to the same default policy that an absent slot would.)
        this.dialogOverrides.delete(page);
        if (override.expiresAt >= Date.now()) {
          if (override.accept) await dialog.accept(override.promptText);
          else await dialog.dismiss();
          return;
        }
      }
      // alert always accepts (there's nothing to dismiss); confirm/prompt follow
      // dialog_policy. Default "dismiss" is the safe choice — it won't, e.g.,
      // confirm a destructive action on the model's behalf.
      if (dialog.type() === "alert" || this.config.dialog_policy === "accept") {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    } catch (error) {
      this.logger.debug("dialog_handle_failed", {
        type: dialog.type(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Arm a one-shot override for the NEXT JS dialog on `page` (the `act:dialog`
   * kind), overriding the standing dialog_policy for that one event. The
   * override is consumed by the next dialog; if no dialog fires it expires after
   * act_timeout_ms so it can't leak into a later, unrelated dialog. Coordinates
   * with handleDialog via the dialogOverrides slot the default handler checks
   * first.
   *
   * The override binds to the tab passed here (the active tab at arm time). If a
   * tab switch happens before the triggering act, the new tab's dialog has no
   * override and falls through to the default dialog_policy with no error — so
   * arm immediately before the triggering act on the same tab.
   */
  armDialog(page: Page, accept: boolean, promptText: string | undefined): void {
    this.dialogOverrides.set(page, {
      accept,
      promptText,
      expiresAt: Date.now() + this.config.act_timeout_ms,
    });
  }

  // ── Downloads: cross-container staging pipeline (ARCHITECTURE.md §11b) ────
  //
  // connectOverCDP downloads are structurally broken in the split-container
  // topology: Playwright points Chromium's download path at an agent-local
  // mkdtemp dir that does not exist in the browser container, so the bytes
  // never cross the boundary and `download.saveAs()` always throws. Instead, a
  // browser-level CDP session of OUR OWN overrides the download path to a
  // shared staging volume (`downloads_dir` as the browser sees it,
  // `downloads_local_dir` as we see it), correlates our CDP events with
  // Playwright's `download` page events (which carry session attribution), and
  // finalizes completed transfers with a copy into the workspace — the copy
  // also converts the root-owned 0644 staging file into an agent-owned one.
  // `saveAs()`/`cancel()` are never called on the Playwright Download object;
  // it is metadata-only.

  /**
   * After every successful connect (initial and reconnect), take ownership of
   * download routing. No `browserContextId` — same default-context scope as
   * Playwright's own context-init call; Chromium's download path is
   * per-browser-context state, last write wins, and ours lands after
   * Playwright's (connectOverCDP has resolved). `eventsEnabled` is
   * per-CDP-session, so Playwright keeps receiving its own events and
   * `page.on("download")` still fires. A failure degrades to "downloads
   * disabled" — it must never fail the connect (navigation/snapshot still work).
   */
  private async setupDownloadCapture(browser: Browser): Promise<void> {
    if (this.downloadsDir === undefined || this.downloadsLocalDir === undefined) {
      // Downloads are an explicit opt-in tied to the deployment's mount
      // topology; this once-per-connect log is the operator's discovery point
      // for why downloaded files never materialize.
      this.logger.info("browser_download_unconfigured");
      return;
    }
    try {
      const cdp = await browser.newBrowserCDPSession();
      // Listeners before the override so no event can slip between the two.
      cdp.on("Browser.downloadWillBegin", (event) => {
        this.onDownloadWillBegin(event);
      });
      cdp.on("Browser.downloadProgress", (event) => {
        void this.onDownloadProgress(event);
      });
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName", // guid filenames: collision-free staging
        downloadPath: this.downloadsDir,
        eventsEnabled: true,
      });
      this.downloadsCdp = cdp;
    } catch (error) {
      this.logger.warn("browser_download_override_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * CDP side of the correlation: record the guid under its (url, filename) key,
   * or attach it to the oldest page-side entry still missing a guid. Both
   * streams originate from the same underlying browser event, so per-stream
   * ordering matches emission order; ambiguity requires two simultaneous
   * in-flight downloads with identical URL AND filename, in which case the
   * records are interchangeable anyway.
   */
  private onDownloadWillBegin(event: { guid: string; url: string; suggestedFilename: string }): void {
    this.expirePendingDownloads();
    const match = this.pendingDownloadEntries.find(
      (e) => e.guid === undefined && e.url === event.url && e.suggestedFilename === event.suggestedFilename,
    );
    if (match) {
      match.guid = event.guid;
      match.expiresAt = Infinity; // correlated — lives until completed/canceled
      return;
    }
    this.pendingDownloadEntries.push({
      url: event.url,
      suggestedFilename: event.suggestedFilename,
      guid: event.guid,
      completed: false,
      expiresAt: Date.now() + this.config.act_timeout_ms,
    });
  }

  /**
   * Completion/failure/size-cap driver. `completed` for a correlated guid
   * finalizes (copy into workspace); for a not-yet-correlated one it marks the
   * entry so the page event finalizes on arrival. `canceled` and a size-cap
   * breach surface failed records and clean up the staging file.
   */
  private async onDownloadProgress(event: {
    guid: string;
    state: "inProgress" | "completed" | "canceled";
    receivedBytes: number;
    totalBytes: number;
  }): Promise<void> {
    const entry = this.pendingDownloadEntries.find((e) => e.guid === event.guid);
    if (!entry) return;
    // Size cap: enforced on declared total AND received bytes, so both an
    // honest oversized transfer and a chunked one with no declared total are
    // caught. Checked on every state (a tiny-but-over-cap download can report
    // `completed` without an over-cap `inProgress` event first).
    if (Math.max(event.receivedBytes, event.totalBytes) > this.downloadSizeLimit) {
      this.removePendingEntry(entry);
      try {
        await this.downloadsCdp?.send("Browser.cancelDownload", { guid: event.guid });
      } catch (error) {
        this.logger.debug("browser_download_cancel_failed", {
          guid: event.guid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await this.unlinkStaging(event.guid);
      this.recordDownloadFailure(entry, `exceeds the download size limit (${this.downloadSizeLimit} bytes)`);
      return;
    }
    if (event.state === "completed") {
      if (entry.sessionId !== undefined) {
        this.removePendingEntry(entry);
        await this.finalizeDownload(entry);
      } else {
        // The page-event counterpart hasn't arrived yet; correlation finalizes.
        entry.completed = true;
      }
      return;
    }
    if (event.state === "canceled") {
      this.removePendingEntry(entry);
      await this.unlinkStaging(event.guid);
      this.recordDownloadFailure(entry, "canceled by the browser");
    }
  }

  /**
   * Playwright side of the correlation: `page.on("download")` resolves frame →
   * page internally, which is the only public-API path from a download to its
   * owning chat session. The Download object is METADATA ONLY — `saveAs()` is
   * a local-filesystem copy from a path that never exists here (broken by
   * design in the split topology) and `cancel()` would abort the real transfer.
   */
  private handleDownload(sessionId: string, state: SessionState, download: Download): void {
    // Unconfigured (or the override failed): the bytes never cross the
    // container boundary, so there is nothing to record — already logged
    // once per connect (browser_download_unconfigured / _override_failed).
    if (!this.downloadsCdp) return;
    this.expirePendingDownloads();
    const url = download.url();
    const suggestedFilename = download.suggestedFilename();
    const match = this.pendingDownloadEntries.find(
      (e) => e.sessionId === undefined && e.url === url && e.suggestedFilename === suggestedFilename,
    );
    if (!match) {
      this.pendingDownloadEntries.push({
        url,
        suggestedFilename,
        sessionId,
        state,
        completed: false,
        expiresAt: Date.now() + this.config.act_timeout_ms,
      });
      return;
    }
    match.sessionId = sessionId;
    match.state = state;
    match.expiresAt = Infinity; // correlated
    // The CDP completion may have raced ahead of the page event — finalize now.
    if (match.completed) {
      this.removePendingEntry(match);
      void this.finalizeDownload(match);
    }
  }

  /**
   * A completed, correlated download: copy the staging guid file into the
   * session's workspace download dir, unlink the staging file, and push the
   * record (with the §11b close-race re-check carried over unchanged).
   */
  private async finalizeDownload(entry: PendingDownloadEntry): Promise<void> {
    const sessionId = entry.sessionId!;
    const state = entry.state!;
    const stagingPath = path.join(this.downloadsLocalDir!, entry.guid!);
    const safeName = sanitizeDownloadFilename(entry.suggestedFilename);
    const relDir = path.join("browser-downloads", sanitizeSessionId(sessionId));
    const absDir = path.join(this.workspaceRoot, relDir);
    let finalName: string;
    try {
      await mkdir(absDir, { recursive: true });
      // COPY, not rename — mandatory, not an EXDEV fallback: the staging file is
      // root-owned 0644 (readable, not writable, not chown-able by the agent);
      // the copy produces an agent-uid-owned file the sandbox and file tools can
      // fully use. Name collisions bump until free under COPYFILE_EXCL
      // (name.ext → name (2).ext …), mirroring exportPdf's wx guard.
      finalName = await copyBumpUntilFree(stagingPath, absDir, safeName);
    } catch (error) {
      this.recordDownloadFailure(
        entry,
        `copy into the workspace failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // Unlink the staging guid file. Allowed despite root ownership: the agent
    // owns the staging DIRECTORY, and unlink is governed by directory write
    // permission, not file ownership. Best-effort — the connect-time TTL sweep
    // reaps any leftover.
    await unlink(stagingPath).catch((error: unknown) => {
      // WARN, not debug (issue #1): a persistent unlink failure (typically EACCES
      // when the staging directory is root-owned — the fresh-compose-deploy leak)
      // means every finalized download leaks a copy into the shared staging
      // volume. The startup probe in app.ts is meant to catch this loudly, but
      // surface it here too in case the directory's permissions change at runtime.
      this.logger.warn("browser_download_staging_unlink_failed", {
        guid: entry.guid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const relPath = path.join(relDir, finalName);
    // Re-check AFTER the awaited copy (that's when the close race resolves): if
    // the session closed mid-download, the file is on disk but `state` is
    // detached from `sessions`, so pushing the record would silently lose it.
    // Drop it deliberately with a log instead (issue #14). File-on-disk
    // behavior is unchanged.
    if (state.closed || this.sessions.get(sessionId) !== state) {
      this.logger.info("browser_download_after_close_dropped", { sessionId, path: relPath, url: entry.url });
      return;
    }
    state.pendingDownloads.push({ path: relPath, filename: finalName, url: entry.url });
    this.logger.info("browser_download", { sessionId, path: relPath, url: entry.url });
  }

  /**
   * Log a failed download and — when the owning session is known and still
   * live — surface a failed record in the tool result, so the model learns the
   * click didn't produce a file (the silent loss was exactly the complaint).
   */
  private recordDownloadFailure(entry: PendingDownloadEntry, reason: string): void {
    const filename = sanitizeDownloadFilename(entry.suggestedFilename);
    this.logger.warn("browser_download_failed", {
      sessionId: entry.sessionId,
      url: entry.url,
      filename,
      reason,
    });
    const state = entry.state;
    if (!state || entry.sessionId === undefined) return;
    if (state.closed || this.sessions.get(entry.sessionId) !== state) return;
    state.pendingDownloads.push({ path: "", filename, url: entry.url, failed: true });
  }

  /**
   * Drop pending entries whose counterpart never arrived within act_timeout_ms
   * (correlated entries have expiresAt = Infinity and are never dropped here).
   * A completed-but-never-correlated guid leaves its bytes in staging; reap
   * them now rather than waiting for the next connect's TTL sweep. Called
   * lazily on every download event and from the periodic idle sweep.
   */
  private expirePendingDownloads(now = Date.now()): void {
    for (let i = this.pendingDownloadEntries.length - 1; i >= 0; i--) {
      const entry = this.pendingDownloadEntries[i]!;
      if (entry.expiresAt > now) continue;
      this.pendingDownloadEntries.splice(i, 1);
      this.logger.warn("browser_download_uncorrelated_dropped", {
        url: entry.url,
        filename: entry.suggestedFilename,
        guid: entry.guid,
      });
      if (entry.guid !== undefined && entry.completed) void this.unlinkStaging(entry.guid);
    }
  }

  private removePendingEntry(entry: PendingDownloadEntry): void {
    const i = this.pendingDownloadEntries.indexOf(entry);
    if (i >= 0) this.pendingDownloadEntries.splice(i, 1);
  }

  /** Best-effort removal of a (possibly partial) staging guid file. */
  private async unlinkStaging(guid: string): Promise<void> {
    if (this.downloadsLocalDir === undefined) return;
    await unlink(path.join(this.downloadsLocalDir, guid)).catch(() => {});
  }

  /**
   * Staging hygiene, run fire-and-forget on every successful connect (public as
   * a test seam, like sweepIdleNow): reap guid-named files older than
   * STAGING_SWEEP_TTL_MS — orphans from crashes/disconnects mid-download.
   * Guid-pattern files only; never recurses, never touches non-guid names. The
   * dir holds at most in-flight downloads transiently and is empty at steady
   * state.
   */
  async sweepStagingNow(now = Date.now()): Promise<void> {
    const dir = this.downloadsLocalDir;
    if (dir === undefined) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    // Track unreaped expired orphans so we warn (at least once per sweep) instead
    // of silently swallowing — an expired guid file we CANNOT unlink is the
    // root-owned-staging-dir leak (issue #1), not a benign vanished file.
    let unreaped = 0;
    let lastError: unknown;
    for (const name of names) {
      if (!STAGING_GUID_RE.test(name)) continue;
      const filePath = path.join(dir, name);
      let expired: boolean;
      try {
        const st = await stat(filePath);
        if (!st.isFile()) continue;
        expired = now - st.mtimeMs >= STAGING_SWEEP_TTL_MS;
      } catch {
        // A vanished or unstattable entry is someone else's problem (likely
        // unlinked between readdir and stat) — never the permission leak.
        continue;
      }
      if (!expired) continue;
      try {
        await unlink(filePath);
        this.logger.info("browser_download_staging_orphan_reaped", { file: name });
      } catch (error) {
        unreaped++;
        lastError = error;
      }
    }
    if (unreaped > 0) {
      this.logger.warn("browser_download_staging_orphan_unreaped", {
        count: unreaped,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Close all of a session's tabs (called when the chat session ends). */
  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    // Mark closed BEFORE detaching so an in-flight handleDownload whose saveAs()
    // resolves after this point deliberately drops its record instead of pushing
    // onto an orphaned array drainDownloads can never reach (issue #14).
    state.closed = true;
    this.sessions.delete(sessionId);
    for (const page of state.pages) {
      await page.close().catch(() => {});
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweepIdleNow();
    }, SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweeper.
    this.sweeper.unref?.();
  }

  /**
   * Test seam (issues #1/#22): run one idle-sweep pass synchronously instead of
   * waiting for the 30s interval. The production interval calls exactly this.
   */
  async sweepIdleNow(): Promise<void> {
    const now = Date.now();
    // Piggyback the pending-download expiry on the periodic sweep so an
    // uncorrelated entry is dropped even when no further download events arrive.
    this.expirePendingDownloads(now);
    const idleMs = this.config.session_page_idle_ms;
    for (const [sessionId, state] of this.sessions) {
      // Never reap a session with an operation in flight (issue #1): closing its
      // page mid-op surfaces a confusing "Target closed" instead of a clean
      // timeout. A busy session is by definition not idle.
      if (state.inFlight > 0) continue;
      if (now - state.lastUsed >= idleMs) {
        this.logger.debug("browser_session_idle_close", { sessionId, idleMs });
        await this.closeSession(sessionId);
      }
    }
  }

  /** Tear down the connection and all tabs (app shutdown). */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId);
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = undefined;
      this.context = undefined;
    }
    // The held download CDP session is closed with the browser connection.
    this.downloadsCdp = undefined;
    this.pendingDownloadEntries = [];
    this.connectPromise = undefined;
  }
}

/** Promise-based sleep, used by the cold-start readiness poll. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Filesystem-safe session id for the per-session download directory. Strips
 * everything outside `[A-Za-z0-9._-]`, then — because that charset still permits
 * `.` — collapses a result that is only dots (`.`, `..`, `...`) to "session" so a
 * `..`-bearing id can never become a `..` path segment that escapes
 * `browser-downloads/` (issue #12, defense-in-depth; today's ids are `s-<nanoid>`
 * and are unaffected). A single segment can't introduce a separator, so collapsing
 * the all-dots case is sufficient.
 */
function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (cleaned === "" || /^\.+$/.test(cleaned)) return "session";
  return cleaned;
}

/**
 * Filesystem-safe download filename from the browser-suggested one (hostile
 * input): strip to `[A-Za-z0-9._-]`, bound the length, and fall back to
 * "download" for an empty/missing suggestion. The charset forbids separators,
 * so the result can never introduce a path segment.
 */
function sanitizeDownloadFilename(suggested: string): string {
  return (suggested || "download").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "download";
}

/**
 * Copy `src` into `destDir` under `safeName`, bumping the name until free
 * (`name.ext` → `name (2).ext` → …) with COPYFILE_EXCL as the final guard so
 * even a concurrent finalization can't land on the same name — the copy
 * equivalent of exportPdf's `wx` write flag. Returns the name actually used.
 */
async function copyBumpUntilFree(src: string, destDir: string, safeName: string): Promise<string> {
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? safeName : `${stem} (${n})${ext}`;
    try {
      await copyFile(src, path.join(destDir, candidate), fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

/**
 * Highest N among existing `page-<N>.pdf` files in `dir` (0 if none / dir
 * missing). Lets exportPdf seed its counter from disk so a reset in-memory
 * counter can't clobber an earlier export (issue #2).
 */
async function highestPdfIndex(dir: string): Promise<number> {
  let max = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const m = /^page-(\d+)\.pdf$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Best-effort locale from an IANA timezone, so a profile created without an
 * explicit locale still gets a plausible one that tracks the persona's zone.
 * Falls back to en-US. This is a coherence nicety, not a security control.
 */
function deriveLocale(timezone: string): string {
  const map: Record<string, string> = {
    "America/New_York": "en-US",
    "America/Chicago": "en-US",
    "America/Denver": "en-US",
    "America/Los_Angeles": "en-US",
    "America/Toronto": "en-CA",
    "Europe/London": "en-GB",
    "Europe/Dublin": "en-IE",
    "Europe/Paris": "fr-FR",
    "Europe/Berlin": "de-DE",
    "Europe/Madrid": "es-ES",
    "Europe/Rome": "it-IT",
    "Asia/Tokyo": "ja-JP",
    "Asia/Shanghai": "zh-CN",
    "Asia/Seoul": "ko-KR",
    "Australia/Sydney": "en-AU",
  };
  return map[timezone] ?? "en-US";
}
