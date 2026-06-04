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

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Dialog, type Download, type Page } from "playwright-core";

import type { BrowserConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { BrowserError } from "./errors.js";
import { ManagerClient, type ProfileCreateInput } from "./manager-client.js";

export interface DownloadRecord {
  /** Workspace-relative path the file was saved to. */
  path: string;
  filename: string;
  url: string;
}

interface SessionState {
  /** Tabs owned by this chat session, in open order. */
  pages: Page[];
  /** Index into `pages` of the active tab. */
  activeIndex: number;
  lastUsed: number;
  /** Downloads captured since the last drain, surfaced in tool results. */
  pendingDownloads: DownloadRecord[];
}

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
  /** Override the CDP connector (tests). Defaults to chromium.connectOverCDP. */
  connectOverCdp?: ConnectOverCdp;
}

const SWEEP_INTERVAL_MS = 30_000;

export class BrowserSession {
  private readonly config: BrowserConfig;
  private readonly agentTimezone: string;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;
  private readonly manager: ManagerClient;

  /** In-flight or resolved connection. Cleared on disconnect to force reconnect. */
  private connectPromise: Promise<BrowserContext> | undefined;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;

  private readonly sessions = new Map<string, SessionState>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly connectOverCdp: ConnectOverCdp;

  constructor(opts: BrowserSessionOptions) {
    this.config = opts.config;
    this.agentTimezone = opts.agentTimezone;
    this.workspaceRoot = opts.workspaceRoot;
    this.logger = opts.logger;
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
    this.connectPromise ??= this.connect().catch((error) => {
      // Allow a later retry after a failed connect.
      this.connectPromise = undefined;
      throw error;
    });
    return this.connectPromise;
  }

  private async connect(): Promise<BrowserContext> {
    const profile = await this.resolveOrCreateProfile();
    await this.ensureLaunched(profile.id);

    const cdpEndpoint = `${this.manager.base}/api/profiles/${encodeURIComponent(profile.id)}/cdp`;
    const headers = this.config.auth_token
      ? { Authorization: `Bearer ${this.config.auth_token}` }
      : undefined;

    let browser: Browser;
    try {
      browser = await this.connectOverCdp(cdpEndpoint, {
        headers,
        timeout: this.config.connect_timeout_ms,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserError(
        "connect_failed",
        `connectOverCDP to the CloakBrowser-Manager failed (${message}). The profile may still be warming up — retry shortly.`,
        { cause: error },
      );
    }

    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new BrowserError("connect_failed", "Connected to the Manager but it exposed no browser context.");
    }

    // Reconnect-on-drop: clear the cache so the next ensureContext() reconnects.
    // Per-session pages are dead once the socket drops, so drop their state too.
    browser.on("disconnected", () => {
      this.logger.warn("browser_disconnected");
      this.browser = undefined;
      this.context = undefined;
      this.connectPromise = undefined;
      this.sessions.clear();
    });

    this.browser = browser;
    this.context = context;
    this.startSweeper();
    this.logger.info("browser_connected", { profileId: profile.id, cdpEndpoint });
    return context;
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

  /** Ensure the profile is running (launch if stopped; 409 already-running is fine). */
  private async ensureLaunched(profileId: string): Promise<void> {
    const status = await this.manager.getStatus(profileId);
    if (status.status === "running") return;
    this.logger.info("browser_profile_launching", { profileId });
    await this.manager.launch(profileId);
  }

  // ── Per-session tab management ───────────────────────────────────────────

  private getOrCreateState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { pages: [], activeIndex: 0, lastUsed: Date.now(), pendingDownloads: [] };
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
    const context = await this.ensureContext();
    const state = this.getOrCreateState(sessionId);
    state.lastUsed = Date.now();
    this.compact(state);
    if (state.pages.length === 0) {
      await this.openTab(sessionId);
      return state.pages[state.activeIndex]!;
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
    const page = state.pages[index];
    if (!page) {
      throw new BrowserError("bad_request", `Tab index ${index} is out of range (0..${state.pages.length - 1}).`);
    }
    await page.close().catch(() => {});
    state.pages.splice(index, 1);
    if (state.activeIndex >= state.pages.length) state.activeIndex = Math.max(0, state.pages.length - 1);
    state.lastUsed = Date.now();
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
      void this.handleDialog(dialog);
    });
    page.on("download", (download: Download) => {
      void this.handleDownload(sessionId, state, download);
    });
  }

  private async handleDialog(dialog: Dialog): Promise<void> {
    try {
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

  private async handleDownload(sessionId: string, state: SessionState, download: Download): Promise<void> {
    try {
      const suggested = download.suggestedFilename() || "download";
      const safeName = suggested.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "download";
      const relDir = path.join("browser-downloads", sanitizeSessionId(sessionId));
      const absDir = path.join(this.workspaceRoot, relDir);
      await mkdir(absDir, { recursive: true });
      const absPath = path.join(absDir, safeName);
      await download.saveAs(absPath);
      const relPath = path.join(relDir, safeName);
      state.pendingDownloads.push({ path: relPath, filename: safeName, url: download.url() });
      this.logger.info("browser_download", { sessionId, path: relPath, url: download.url() });
    } catch (error) {
      this.logger.warn("browser_download_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Close all of a session's tabs (called when the chat session ends). */
  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    for (const page of state.pages) {
      await page.close().catch(() => {});
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweepIdle();
    }, SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweeper.
    this.sweeper.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    const idleMs = this.config.session_page_idle_ms;
    for (const [sessionId, state] of this.sessions) {
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
    this.connectPromise = undefined;
  }
}

/** Filesystem-safe session id for the per-session download directory. */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session";
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
