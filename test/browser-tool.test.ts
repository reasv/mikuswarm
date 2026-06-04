import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BrowserSession, type ConnectOverCdp } from "../src/browser/session.js";
import { createBrowserTool } from "../src/tools/browser.js";
import type { BrowserConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/logger.js";

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function baseConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    enabled: true, manager_url: "http://127.0.0.1:8080", auth_token: "t",
    profile_name: "miku", platform: "windows", fingerprint_seed: 1, humanize: false,
    evaluate_enabled: false, proxy: "", geoip: false, dialog_policy: "dismiss",
    snapshot_max_chars: 20000, nav_timeout_ms: 30000, act_timeout_ms: 15000,
    connect_timeout_ms: 20000, session_page_idle_ms: 600000, ...overrides,
  };
}

const SNAPSHOT = '- generic [ref=e1]:\n  - heading "Example" [level=1] [ref=e2]\n  - link "More" [ref=e3]';

interface FakePageOptions {
  refError?: Error; // thrown by locator actions (stale ref / timeout)
  evalResult?: unknown;
}

function makeFakePage(opts: FakePageOptions) {
  let currentUrl = "about:blank";
  return {
    _closed: false,
    isClosed() { return this._closed; },
    async close() { this._closed = true; },
    on() {},
    url() { return currentUrl; },
    async title() { return "Example"; },
    async goto(u: string) { currentUrl = u; },
    async goBack() {},
    async waitForTimeout() {},
    async screenshot() { return Buffer.from("\x89PNGfake"); },
    async evaluate() { return opts.evalResult ?? "ok"; },
    mouse: { async wheel() {} },
    keyboard: { async press() {} },
    locator(_selector: string) {
      return {
        async ariaSnapshot() { return SNAPSHOT; },
        async click() { if (opts.refError) throw opts.refError; },
        async hover() {},
        async fill() {},
        async pressSequentially() {},
        async selectOption() { return []; },
        async press() {},
        async scrollIntoViewIfNeeded() {},
      };
    },
  };
}

function makeBrowser(pageOpts: FakePageOptions) {
  const context = { async newPage() { return makeFakePage(pageOpts); }, pages() { return []; } };
  return {
    contexts: () => [context],
    isConnected: () => true,
    on: () => {},
    close: async () => {},
  };
}

/** Manager stub: profile exists + running, so the tool path reaches the page fast. */
function stubManager(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/profiles")) {
      return new Response(JSON.stringify([{ id: "p1", name: "miku", fingerprint_seed: 1, status: "running", cdp_url: null }]), { status: 200 });
    }
    if (/\/status$/.test(url)) return new Response(JSON.stringify({ status: "running", cdp_url: null }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

async function withTool(
  config: BrowserConfig,
  pageOpts: FakePageOptions,
  fn: (tool: ReturnType<typeof createBrowserTool>) => Promise<void>,
): Promise<void> {
  const ws = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-tool-"));
  const restore = stubManager();
  const connect: ConnectOverCdp = async () => makeBrowser(pageOpts) as unknown as Awaited<ReturnType<ConnectOverCdp>>;
  const session = new BrowserSession({ config, agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
  const tool = createBrowserTool({ session, agentSessionId: "s1", config });
  try {
    await fn(tool);
  } finally {
    restore();
    await session.shutdown();
    await rm(ws, { recursive: true, force: true });
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("tool: navigate returns a fresh AI snapshot with refs", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    const result = await tool.execute("c1", { action: "navigate", url: "https://example.com" });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    assert.match(text, /navigated to https:\/\/example\.com/);
    assert.match(text, /\[ref=e2\]/);
    assert.equal((result as { details: { refCount: number } }).details.refCount, 3);
  });
});

test("tool: rejects non-http(s) schemes (bad_url)", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "navigate", url: "file:///etc/passwd" }),
      /browser:bad_url/,
    );
  });
});

test("tool: a stale ref surfaces as ref_expired", async () => {
  const timeout = Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
  await withTool(baseConfig(), { refError: timeout }, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "act", kind: "click", ref: "e3" }),
      /browser:ref_expired/,
    );
  });
});

test("tool: act:evaluate is gated by evaluate_enabled", async () => {
  await withTool(baseConfig({ evaluate_enabled: false }), {}, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "act", kind: "evaluate", text: "1+1" }),
      /browser:evaluate_disabled/,
    );
  });
  await withTool(baseConfig({ evaluate_enabled: true }), { evalResult: 2 }, async (tool) => {
    const result = await tool.execute("c1", { action: "act", kind: "evaluate", text: "1+1" });
    assert.match(textOf(result as { content: Array<{ type: string; text?: string }> }), /evaluate → 2/);
  });
});

test("tool: screenshot returns an inline PNG image block", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    const result = await tool.execute("c1", { action: "screenshot", full_page: true }) as {
      content: Array<{ type: string; mimeType?: string; data?: string }>;
    };
    const image = result.content.find((c) => c.type === "image");
    assert.ok(image, "has an image block");
    assert.equal(image!.mimeType, "image/png");
    assert.ok(image!.data && image!.data.length > 0, "base64 data present");
  });
});

test("tool: open then tabs lists the session's tabs", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    await tool.execute("c1", { action: "navigate", url: "https://a.example" });
    await tool.execute("c1", { action: "open", url: "https://b.example" });
    const result = await tool.execute("c1", { action: "tabs" });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    // Two tabs, the second (just-opened) is active.
    assert.match(text, /\[0\]/);
    assert.match(text, /\[1\]/);
    assert.match(text, /\*\s\[1\]/);
  });
});

test("tool: act:click returns a refreshed snapshot", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    const result = await tool.execute("c1", { action: "act", kind: "click", ref: "e3" });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    assert.match(text, /clicked e3/);
    assert.match(text, /\[ref=e1\]/);
  });
});
