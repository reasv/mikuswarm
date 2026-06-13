import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFile, mkdir, symlink } from "node:fs/promises";

import sharp from "sharp";

import { BrowserSession, type ConnectOverCdp } from "../src/browser/session.js";
import { createBrowserTool, boundScreenshot, resolveUploadFiles, renderConsole } from "../src/tools/browser.js";
import { CONSOLE_DRAIN_MAX_CHARS, CONSOLE_TRUNCATION_MARKER, type ConsoleEntry } from "../src/browser/session.js";
import { aiSnapshot } from "../src/browser/snapshot.js";
import { base64ByteSize } from "../src/tools/read-image.js";
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
    snapshot_max_chars: 20000, snapshot_max_frames: 10, nav_timeout_ms: 30000, act_timeout_ms: 15000,
    connect_timeout_ms: 20000, session_page_idle_ms: 600000, ...overrides,
  };
}

const SNAPSHOT = '- generic [ref=e1]:\n  - heading "Example" [level=1] [ref=e2]\n  - link "More" [ref=e3]';

interface FakePageOptions {
  refError?: Error; // thrown by locator actions (stale ref / timeout)
  evalResult?: unknown;
  evalError?: Error; // thrown by page.evaluate (page-script runtime exception)
  screenshotError?: Error; // thrown by page.screenshot
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
    async screenshot() { if (opts.screenshotError) throw opts.screenshotError; return Buffer.from("\x89PNGfake"); },
    async evaluate() { if (opts.evalError) throw opts.evalError; return opts.evalResult ?? "ok"; },
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
        // Element-screenshot capture goes through the locator (aria-ref=eN).
        async screenshot() { if (opts.screenshotError) throw opts.screenshotError; return Buffer.from("\x89PNGfake"); },
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
  const tool = createBrowserTool({ session, agentSessionId: "s1", config, maxImageBytes: 5_242_880, workspaceRoot: ws });
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

test("tool: open with a non-http(s) scheme is rejected (bad_url) (#17)", async () => {
  // Mirror the navigate file:// guard for the `open` branch: open also calls
  // assertBrowserUrl, so its rejection path must be covered (drop the call there
  // and nothing catches it).
  await withTool(baseConfig(), {}, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "open", url: "file:///etc/passwd" }),
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

test("tool: a synchronous stale-ref error (no timeout) surfaces as ref_expired (#4)", async () => {
  // Playwright can throw a sync "no node found for aria-ref" rather than timing
  // out; with a valid ref this means the ref went stale. Pre-fix this mapped to
  // bad_request. NB: not a TimeoutError (no name, no "Timeout … exceeded").
  const staleRef = new Error('No node found for selector: aria-ref=e3');
  await withTool(baseConfig(), { refError: staleRef }, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "act", kind: "click", ref: "e3" }),
      /browser:ref_expired/,
    );
  });
});

test("tool: act:evaluate runtime throw surfaces as evaluate_failed (#8)", async () => {
  const boom = new Error("ReferenceError: x is not defined");
  await withTool(baseConfig({ evaluate_enabled: true }), { evalError: boom }, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "act", kind: "evaluate", text: "x()" }),
      /browser:evaluate_failed/,
    );
  });
});

test("tool: a non-timeout screenshot failure surfaces as screenshot_failed (#8)", async () => {
  const detached = new Error("Target page, context or browser has been closed");
  await withTool(baseConfig(), { screenshotError: detached }, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "screenshot" }),
      /browser:screenshot_failed/,
    );
  });
});

test("tool: a screenshot timeout surfaces as act_timeout (#8)", async () => {
  const timeout = Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
  await withTool(baseConfig(), { screenshotError: timeout }, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "screenshot" }),
      /browser:act_timeout/,
    );
  });
});

// ── #9: element-screenshot dispatch (ref-present branch) ─────────────────────

test("tool: screenshot {ref, format:jpeg} returns an image/jpeg block with details.ref and fullPage=false (#9)", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    const result = await tool.execute("c1", { action: "screenshot", ref: "e3", format: "jpeg" }) as {
      content: Array<{ type: string; mimeType?: string; data?: string }>;
      details: { ref?: string; format?: string; fullPage?: boolean };
    };
    const image = result.content.find((c) => c.type === "image");
    assert.ok(image, "has an image block");
    // The jpeg format flows through boundScreenshot's mimeType (the small fake
    // capture is under the cap, so it passes through with the requested format).
    assert.equal(image!.mimeType, "image/jpeg");
    assert.ok(image!.data && image!.data.length > 0, "base64 data present");
    assert.equal(result.details.ref, "e3", "details echoes the element ref");
    assert.equal(result.details.format, "jpeg");
    assert.equal(result.details.fullPage, false, "fullPage is false for an element capture");
  });
});

test("tool: screenshot with a malformed ref is a bad_request (#9)", async () => {
  await withTool(baseConfig(), {}, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "screenshot", ref: "x" }),
      /browser:bad_request/,
    );
  });
});

test("tool: a stale element ref on screenshot surfaces as ref_expired (#9)", async () => {
  // A timeout-shaped capture error on a valid ref means the ref went stale; the
  // dispatch maps it to ref_expired (take a fresh snapshot) rather than
  // screenshot_failed.
  const timeout = Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
  await withTool(baseConfig(), { screenshotError: timeout }, async (tool) => {
    await assert.rejects(
      () => tool.execute("c1", { action: "screenshot", ref: "e3" }),
      /browser:ref_expired/,
    );
  });
});

// ── #10: text maxLength schema bound ─────────────────────────────────────────

// pi-ai's re-exported typebox uses different Kind symbols than the direct
// @sinclair/typebox dep, so a cross-package Value.Check throws "Unknown type".
// Instead validate the emitted JSON Schema fragment directly (same approach as
// sillytavern-card.test.ts): pull `maxLength` off the `text` property and check
// a candidate string against it.
function checkMaxLength(schema: { maxLength?: number }, value: string): boolean {
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  return true;
}

test("tool: schema bounds `text` length, rejecting pathological multi-MB input (#10)", () => {
  const tool = createBrowserTool({
    session: undefined as never,
    agentSessionId: "s1",
    config: baseConfig(),
    maxImageBytes: 5_242_880,
    workspaceRoot: "/tmp",
  });
  const params = tool.parameters as { properties: { text: { maxLength?: number } } };
  const textSchema = params.properties.text;
  assert.equal(textSchema.maxLength, 100000, "text field carries a generous maxLength bound");

  // Just-fits input passes the schema bound; over-length input is rejected.
  assert.equal(checkMaxLength(textSchema, "x".repeat(100000)), true);
  assert.equal(checkMaxLength(textSchema, "x".repeat(100001)), false);
  // A pathological multi-MB fill/evaluate value fails fast at the schema layer.
  assert.equal(checkMaxLength(textSchema, "x".repeat(5 * 1024 * 1024)), false);
});

// ── #11: snapshot truncation marker / refCount on returned text ──────────────

const MARKER = "\n[... snapshot truncated — scroll or interact to reveal more ...]";

/** A page whose ariaSnapshot returns an arbitrary raw string. */
function snapshotPage(raw: string) {
  return { locator: (_sel: string) => ({ async ariaSnapshot() { return raw; } }) } as never;
}

test("aiSnapshot: truncates to ≤ maxChars, marks truncation, and counts refs in returned text only (#11)", async () => {
  // Long raw snapshot with several refs; some fall past a small cut so they
  // must NOT be counted in the returned refCount.
  const head = "- generic [ref=e1]:\n  - link [ref=e2]\n  - link [ref=e3]\n";
  const filler = "  - text node padding line\n".repeat(200);
  const tail = "  - link [ref=e98]\n  - link [ref=e99]\n";
  const raw = head + filler + tail;
  const maxChars = 200;

  const result = await aiSnapshot(snapshotPage(raw), maxChars);

  assert.equal(result.truncated, true, "marked truncated");
  assert.ok(result.text.length <= maxChars, `output length ${result.text.length} ≤ ${maxChars}`);
  assert.ok(result.text.endsWith(MARKER) || result.text.length === maxChars, "marker present (or clamped)");
  assert.ok(result.text.includes(MARKER.trim().slice(0, 10)) || result.text.includes("truncated"), "marker text present");

  // refCount reflects ONLY refs in the returned text, not the trailing refs
  // (e98/e99) that were sliced off.
  const refsInReturned = (result.text.match(/\[ref=e\d+\]/g) ?? []).length;
  assert.equal(result.refCount, refsInReturned, "refCount counts only returned refs");
  assert.ok(!result.text.includes("[ref=e98]"), "trailing refs were sliced off");
  assert.ok(result.refCount < (raw.match(/\[ref=e\d+\]/g) ?? []).length, "refCount is below the raw ref total");
});

test("aiSnapshot: clamps total output to maxChars even when maxChars < marker length (#11)", async () => {
  const raw = "- generic [ref=e1]:\n  - link [ref=e2]\n".repeat(50);
  const tiny = 5; // smaller than MARKER.length
  const result = await aiSnapshot(snapshotPage(raw), tiny);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= tiny, `output length ${result.text.length} ≤ ${tiny}`);
});

test("aiSnapshot: short snapshot passes through untruncated with full refCount", async () => {
  const raw = "- generic [ref=e1]:\n  - heading [ref=e2]\n  - link [ref=e3]";
  const result = await aiSnapshot(snapshotPage(raw), 20000);
  assert.equal(result.truncated, false);
  assert.equal(result.text, raw);
  assert.equal(result.refCount, 3);
});

test("aiSnapshot: raw exactly at the cap (raw.length === maxChars) is NOT truncated (#11 boundary)", async () => {
  // The passthrough guard is `raw.length <= maxChars`, so a raw snapshot whose
  // length is exactly the cap must pass through verbatim — no marker, no slice,
  // full refCount. (Off-by-one in the guard would truncate here.)
  const raw = "- generic [ref=e1]:\n  - link [ref=e2]\n  - link [ref=e3] pad";
  const result = await aiSnapshot(snapshotPage(raw), raw.length);
  assert.equal(result.truncated, false, "exactly-at-cap is not truncated");
  assert.equal(result.text, raw, "raw passes through verbatim");
  assert.equal(result.refCount, 3, "all refs counted when not truncated");
});

// ── §1: frame (iframe) descent in aiSnapshot ─────────────────────────────────

/**
 * A page exposing a main snapshot plus child frames. frames()[0] is the main
 * document (its locator is never used — main is captured via page.locator); each
 * child carries its own url + AI snapshot (or throws to simulate detachment).
 */
function framedSnapshotPage(main: string, children: Array<{ url: string; snapshot?: string; throws?: boolean }>) {
  const mainFrame = { url: () => "main", locator: () => ({ async ariaSnapshot() { return main; } }) };
  const childFrames = children.map((c) => ({
    url: () => c.url,
    locator: () => ({
      async ariaSnapshot() {
        if (c.throws) throw new Error("frame detached");
        return c.snapshot ?? "";
      },
    }),
  }));
  return {
    locator: (_sel: string) => ({ async ariaSnapshot() { return main; } }),
    frames: () => [mainFrame, ...childFrames],
  } as never;
}

test("aiSnapshot: descends into a child frame, namespacing its refs under a boundary", async () => {
  const main = '- generic [ref=e1]:\n  - heading "Host" [ref=e2]';
  const child = '- button "Verify you are human" [ref=e3]';
  const page = framedSnapshotPage(main, [{ url: "https://challenges.example/x", snapshot: child }]);
  const result = await aiSnapshot(page, 20000, 10);
  assert.ok(result.text.includes("[frame f1: https://challenges.example/x]"), "frame boundary present");
  assert.ok(result.text.includes("[ref=f1:e3]"), "child ref namespaced to the frame");
  assert.ok(result.text.includes("[ref=e1]"), "main-document bare refs preserved");
  assert.equal(result.truncated, false);
  assert.equal(result.refCount, 3, "counts bare e1/e2 plus namespaced f1:e3");
  // The frame's snapshot-time URL is recorded by its frames() index so the next
  // act can detect a reorder (#1/#15). Only rendered frames are recorded.
  assert.deepEqual([...result.frameUrls.entries()], [[1, "https://challenges.example/x"]]);
});

test("aiSnapshot: frameUrls records only rendered child frames, keyed by frames() index", async () => {
  const main = "- generic [ref=e1]";
  const page = framedSnapshotPage(main, [
    { url: "https://a.example/", snapshot: "- button [ref=e3]" },
    { url: "https://b.example/", snapshot: "- button [ref=e4]" },
  ]);
  const result = await aiSnapshot(page, 20000, 10);
  assert.deepEqual(
    [...result.frameUrls.entries()],
    [
      [1, "https://a.example/"],
      [2, "https://b.example/"],
    ],
    "each rendered frame recorded at its frames() index",
  );
});

test("aiSnapshot: an inaccessible frame is NOT recorded in frameUrls (no usable refs)", async () => {
  const main = "- generic [ref=e1]";
  const page = framedSnapshotPage(main, [{ url: "https://x", throws: true }]);
  const result = await aiSnapshot(page, 20000, 10);
  assert.equal(result.frameUrls.size, 0, "inaccessible frame yields no recorded URL");
});

test("aiSnapshot: maxFrames=0 stays on the main document even when frames exist", async () => {
  const main = '- generic [ref=e1]';
  const page = framedSnapshotPage(main, [{ url: "https://x", snapshot: "- button [ref=e3]" }]);
  const result = await aiSnapshot(page, 20000, 0);
  assert.equal(result.text, main, "no frame content appended");
  assert.ok(!result.text.includes("[frame"), "no frame boundary");
});

test("aiSnapshot: an inaccessible/detached frame is noted inline without throwing", async () => {
  const main = "- generic [ref=e1]";
  const page = framedSnapshotPage(main, [{ url: "https://x", throws: true }]);
  const result = await aiSnapshot(page, 20000, 10);
  assert.ok(result.text.includes("[frame f1: <inaccessible>]"), "inaccessible frame noted");
});

test("aiSnapshot: a frame budget below the frame count truncates and marks it", async () => {
  const main = "- generic [ref=e1]";
  const children = [
    { url: "https://a", snapshot: "- button [ref=e1]" },
    { url: "https://b", snapshot: "- button [ref=e1]" },
  ];
  const result = await aiSnapshot(framedSnapshotPage(main, children), 20000, 1);
  assert.equal(result.truncated, true, "fewer frames rendered than exist → truncated");
  assert.ok(result.text.includes("[frame f1:"), "first frame within budget rendered");
  assert.ok(!result.text.includes("[frame f2:"), "second frame dropped by the frame cap");
  assert.ok(result.text.includes("truncated"), "truncation marker present");
});

test("aiSnapshot: snapshot_max_frames caps the walk — frames past the cap are never traversed (#18)", async () => {
  // More child frames than the cap; record which frames' ariaSnapshot gets
  // invoked so we can assert the walk stops at the cap rather than touching
  // every frame.
  const main = "- generic [ref=e1]";
  const touched: number[] = [];
  const childFrames = [1, 2, 3, 4, 5].map((n) => ({
    url: () => `https://f${n}.example/`,
    locator: () => ({
      async ariaSnapshot() {
        touched.push(n);
        return `- button [ref=e${n + 1}]`;
      },
    }),
  }));
  const mainFrame = { url: () => "main", locator: () => ({ async ariaSnapshot() { return main; } }) };
  const page = {
    locator: (_sel: string) => ({ async ariaSnapshot() { return main; } }),
    frames: () => [mainFrame, ...childFrames],
  } as never;

  const cap = 2;
  const result = await aiSnapshot(page, 20000, cap);

  assert.deepEqual(touched, [1, 2], "only the first `cap` child frames are traversed");
  assert.ok(result.text.includes("[frame f1:"), "first capped frame included");
  assert.ok(result.text.includes("[frame f2:"), "second capped frame included");
  assert.ok(!result.text.includes("[frame f3:"), "frame past the cap excluded");
  assert.equal(result.truncated, true, "more frames exist than the cap → truncated");
  assert.equal(result.frameUrls.size, cap, "only capped frames recorded in frameUrls");
});

test("aiSnapshot: a mid-ref clamp never emits a partial [ref=…] fragment (#4)", async () => {
  // Construct a raw snapshot so that the truncation cut lands in the MIDDLE of a
  // frame-namespaced ref token. The clamp budget is maxChars - MARKER.length;
  // we place a `[ref=f1:e7]` token straddling that boundary so a naive slice
  // would leave a dangling `[ref=f1:e` fragment.
  const marker = MARKER.length;
  const token = "[ref=f1:e7]";
  // clampWithMarker slices the body to `budget = maxChars - marker`. Place the
  // token so that this cut lands a few chars INTO it: pre ends a little before
  // `budget`, the token straddles `budget`, and a long tail forces overflow
  // (raw.length > maxChars) so truncation actually happens.
  const maxChars = 200;
  const budget = maxChars - marker; // slice point
  const pre = "x".repeat(budget - 7); // token starts 7 chars before the cut
  const raw = `${pre}${token}${" tail".repeat(40)}`; // overflow guarantees truncation
  assert.ok(raw.length > maxChars, "raw must overflow to force truncation");
  // The cut at `budget` lands 7 chars into the token (after `[ref=f1`), so a
  // naive slice keeps an unclosed `[ref=f1` fragment — exactly the #4 bug.
  assert.ok(pre.length < budget && budget < pre.length + token.length, "cut bisects the token");

  const result = await aiSnapshot(snapshotPage(raw), maxChars);

  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= maxChars, `output ${result.text.length} ≤ ${maxChars}`);
  // No partial ref fragment: any `[ref=` that appears must be closed by a `]`
  // before the truncation marker begins.
  const body = result.text.slice(0, result.text.indexOf(MARKER) === -1 ? result.text.length : result.text.indexOf(MARKER));
  const lastOpen = body.lastIndexOf("[ref=");
  if (lastOpen !== -1) {
    assert.ok(body.indexOf("]", lastOpen) !== -1, `partial ref fragment leaked: ${JSON.stringify(body.slice(lastOpen))}`);
  }
});

test("aiSnapshot: main-doc-fills-budget path emits an omitted-frames hint when iframes exist (#8)", async () => {
  // Main document alone overflows the budget AND child frames exist → the agent
  // would otherwise be blind to the iframe content. Assert the hint is emitted,
  // names the child-frame count (excluding the main frame), and the output stays
  // within budget with no `fN:eN` refs (no frame was rendered).
  const main = "- generic [ref=e1]\n".repeat(200); // far over the cap
  const children = [
    { url: "https://a.example/", snapshot: "- button [ref=e2]" },
    { url: "https://b.example/", snapshot: "- button [ref=e3]" },
  ];
  const maxChars = 400;
  const result = await aiSnapshot(framedSnapshotPage(main, children), maxChars, 10);

  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= maxChars, `output ${result.text.length} ≤ ${maxChars}`);
  assert.ok(/2 frames omitted/.test(result.text), `hint names child-frame count: ${JSON.stringify(result.text.slice(-120))}`);
  assert.ok(/snapshot_max_chars/.test(result.text), "hint suggests raising snapshot_max_chars");
  assert.ok(!result.text.includes("[frame f1:"), "no frame was actually rendered on this path");
  assert.ok(result.frameUrls.size === 0, "no frame URLs recorded (no rendered frames)");
});

test("aiSnapshot: main-doc-fills-budget path emits NO hint when maxFrames=0 or no child frames (#8)", async () => {
  const main = "- generic [ref=e1]\n".repeat(200);
  const maxChars = 400;
  // maxFrames = 0 → no descent, no hint.
  const r1 = await aiSnapshot(framedSnapshotPage(main, [{ url: "https://a", snapshot: "x" }]), maxChars, 0);
  assert.ok(!/omitted/.test(r1.text), "no hint when frame descent is disabled");
  // No child frames → nothing to mention.
  const r2 = await aiSnapshot(framedSnapshotPage(main, []), maxChars, 10);
  assert.ok(!/omitted/.test(r2.text), "no hint when there are no child frames");
});

// ── #2: screenshot payload bounding via boundScreenshot ──────────────────────

test("boundScreenshot: a small PNG under the cap passes through untouched (#2)", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png().toBuffer();
  const cap = 5_242_880;
  const bounded = await boundScreenshot(png, cap);
  assert.equal(bounded.downscaled, false, "not downscaled");
  assert.equal(bounded.data, png.toString("base64"), "identical bytes passed through");
  assert.ok(bounded.base64Bytes <= cap);
  assert.equal(bounded.base64Bytes, base64ByteSize(png.byteLength));
});

test("boundScreenshot: an over-cap capture is downscaled to fit (#2)", async () => {
  // A 2000x2000 gradient PNG: photo-like content that compresses and shrinks
  // monotonically under resize (like a real screenshot), with a cap below the
  // full size so real sharp downscaling must run to satisfy it.
  const w = 2000, h = 2000;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 255 / w) | 0;
      raw[i + 1] = (y * 255 / h) | 0;
      raw[i + 2] = ((x + y) * 255 / (w + h)) | 0;
    }
  }
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

  const cap = 350_000; // below the full image's base64 size, reachable above the dimension floor
  assert.ok(base64ByteSize(png.byteLength) > cap, "precondition: capture exceeds the cap");

  const bounded = await boundScreenshot(png, cap);
  assert.equal(bounded.downscaled, true, "downscaled");
  assert.ok(bounded.base64Bytes <= cap, `resulting base64 ${bounded.base64Bytes} ≤ cap ${cap}`);
  // Result is still a valid, smaller PNG.
  const meta = await sharp(Buffer.from(bounded.data, "base64")).metadata();
  assert.equal(meta.format, "png");
  assert.ok((meta.width ?? w) < w, "dimensions were reduced");
});

test("boundScreenshot: an unshrinkable over-cap capture throws screenshot_failed, never ships oversized (#2)", async () => {
  // High-entropy noise already at the 320px dimension floor: it can't be made
  // smaller (already at the floor) and noise doesn't compress, so no downscale
  // can satisfy a tiny cap. The helper must throw rather than loop or ship an
  // over-cap payload (the floor-throw safety branch).
  const dim = 320;
  const raw = Buffer.alloc(dim * dim * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) & 0xff; // cheap deterministic noise
  const png = await sharp(raw, { raw: { width: dim, height: dim, channels: 3 } }).png().toBuffer();

  const cap = 1000; // far below any 320x320 PNG's base64 size
  assert.ok(base64ByteSize(png.byteLength) > cap, "precondition: capture exceeds the cap");

  await assert.rejects(
    boundScreenshot(png, cap),
    (err: unknown) => (err as { code?: string }).code === "screenshot_failed",
    "must throw screenshot_failed rather than ship an oversized block",
  );
});

test("boundScreenshot: jpeg format under the cap passes through with image/jpeg mimeType", async () => {
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg().toBuffer();
  const bounded = await boundScreenshot(jpeg, 5_242_880, "jpeg");
  assert.equal(bounded.downscaled, false);
  assert.equal(bounded.mimeType, "image/jpeg");
  assert.equal(bounded.data, jpeg.toString("base64"));
});

test("boundScreenshot: png format reports image/png mimeType", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png().toBuffer();
  const bounded = await boundScreenshot(png, 5_242_880, "png");
  assert.equal(bounded.mimeType, "image/png");
});

test("boundScreenshot: an over-cap jpeg downscales and re-encodes as jpeg", async () => {
  const w = 2000, h = 2000;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      raw[i] = (i * 2654435761) & 0xff; // noise so it can't trivially compress
      raw[i + 1] = (i * 40503) & 0xff;
      raw[i + 2] = (i * 2246822519) & 0xff;
    }
  }
  const jpeg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  const cap = 200_000;
  assert.ok(base64ByteSize(jpeg.byteLength) > cap, "precondition: capture exceeds the cap");

  const bounded = await boundScreenshot(jpeg, cap, "jpeg");
  assert.equal(bounded.downscaled, true);
  assert.equal(bounded.mimeType, "image/jpeg");
  assert.ok(bounded.base64Bytes <= cap);
  const meta = await sharp(Buffer.from(bounded.data, "base64")).metadata();
  assert.equal(meta.format, "jpeg");
});

// ── upload path policy (resolveUploadFiles) ──────────────────────────────────

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-upload-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolveUploadFiles: reads workspace files into name/mime/buffer", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "doc.png"), Buffer.from([1, 2, 3]));
    const files = await resolveUploadFiles(root, ["doc.png"]);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "doc.png");
    assert.equal(files[0].mimeType, "image/png");
    assert.deepEqual([...files[0].buffer], [1, 2, 3]);
  });
});

test("resolveUploadFiles: resolves nested workspace paths and infers mime from ext", async () => {
  await withWorkspace(async (root) => {
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "f.pdf"), Buffer.from("%PDF"));
    const files = await resolveUploadFiles(root, ["sub/f.pdf"]);
    assert.equal(files[0].name, "f.pdf");
    assert.equal(files[0].mimeType, "application/pdf");
  });
});

test("resolveUploadFiles: rejects an empty list (bad_request)", async () => {
  await withWorkspace(async (root) => {
    await assert.rejects(
      () => resolveUploadFiles(root, []),
      (e: unknown) => (e as { code?: string }).code === "bad_request",
    );
  });
});

test("resolveUploadFiles: rejects a ../ traversal escape (bad_request)", async () => {
  await withWorkspace(async (root) => {
    await assert.rejects(
      () => resolveUploadFiles(root, ["../secret.txt"]),
      (e: unknown) => (e as { code?: string }).code === "bad_request" && /escapes the workspace/.test((e as Error).message),
    );
  });
});

test("resolveUploadFiles: rejects an absolute path outside the workspace (bad_request)", async () => {
  await withWorkspace(async (root) => {
    await assert.rejects(
      () => resolveUploadFiles(root, ["/etc/passwd"]),
      (e: unknown) => (e as { code?: string }).code === "bad_request",
    );
  });
});

test("resolveUploadFiles: rejects a missing file (bad_request)", async () => {
  await withWorkspace(async (root) => {
    await assert.rejects(
      () => resolveUploadFiles(root, ["nope.txt"]),
      (e: unknown) => (e as { code?: string }).code === "bad_request" && /not found/.test((e as Error).message),
    );
  });
});

test("resolveUploadFiles: rejects a directory (not a regular file)", async () => {
  await withWorkspace(async (root) => {
    await mkdir(path.join(root, "adir"), { recursive: true });
    await assert.rejects(
      () => resolveUploadFiles(root, ["adir"]),
      (e: unknown) => (e as { code?: string }).code === "bad_request" && /not a regular file/.test((e as Error).message),
    );
  });
});

test("resolveUploadFiles: rejects a workspace-internal symlink pointing out of tree (bad_request) (#7)", async () => {
  await withWorkspace(async (root) => {
    // A symlink that lives inside the workspace but resolves to a host file
    // outside it: a lexical prefix check string-passes it, the realpath-based
    // resolveWorkspacePath rejects it before it can be read and exfiltrated.
    const outOfTree = await mkdtemp(path.join(os.tmpdir(), "miku-upload-secret-"));
    try {
      const secret = path.join(outOfTree, "id_rsa");
      await writeFile(secret, "PRIVATE KEY");
      await symlink(secret, path.join(root, "leak"));
      await assert.rejects(
        () => resolveUploadFiles(root, ["leak"]),
        (e: unknown) =>
          (e as { code?: string }).code === "bad_request" && /escapes the workspace/.test((e as Error).message),
      );
    } finally {
      await rm(outOfTree, { recursive: true, force: true });
    }
  });
});

test("resolveUploadFiles: rejects more than the file-count cap (bad_request)", async () => {
  await withWorkspace(async (root) => {
    const names: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const n = `f${i}.txt`;
      await writeFile(path.join(root, n), "x");
      names.push(n);
    }
    await assert.rejects(
      () => resolveUploadFiles(root, names),
      (e: unknown) => (e as { code?: string }).code === "bad_request" && /at most/.test((e as Error).message),
    );
  });
});

test("resolveUploadFiles: rejects when total bytes exceed the cap (bad_request)", async () => {
  await withWorkspace(async (root) => {
    // Two ~16 MiB files exceed the 25 MiB total cap.
    const big = Buffer.alloc(16 * 1024 * 1024, 7);
    await writeFile(path.join(root, "a.bin"), big);
    await writeFile(path.join(root, "b.bin"), big);
    await assert.rejects(
      () => resolveUploadFiles(root, ["a.bin", "b.bin"]),
      (e: unknown) => (e as { code?: string }).code === "bad_request" && /total cap/.test((e as Error).message),
    );
  });
});

// ── new act kinds are exposed in the tool schema ─────────────────────────────

test("tool: schema `kind` union includes drag, upload, clear_site_data, dialog", () => {
  const tool = createBrowserTool({
    session: undefined as never,
    agentSessionId: "s1",
    config: baseConfig(),
    maxImageBytes: 5_242_880,
    workspaceRoot: "/tmp",
  });
  const params = tool.parameters as { properties: { kind: { anyOf: Array<{ const?: string }> } } };
  const kinds = params.properties.kind.anyOf.map((s) => s.const);
  for (const k of ["drag", "upload", "clear_site_data", "dialog"]) {
    assert.ok(kinds.includes(k), `kind union includes ${k}`);
  }
});

test("renderConsole: total drained output is bounded to CONSOLE_DRAIN_MAX_CHARS", () => {
  // 500 entries each at the per-entry cap (4 KB) → ~2 MB unbounded. Each entry is
  // already capped at push time; renderConsole is the second layer that bounds the
  // concatenated block the agent sees.
  const messages: ConsoleEntry[] = [];
  for (let i = 0; i < 500; i++) messages.push({ level: "log", text: "z".repeat(4096) });
  const text = renderConsole(messages);
  assert.ok(
    text.length <= CONSOLE_DRAIN_MAX_CHARS + CONSOLE_TRUNCATION_MARKER.length + 1,
    `drained block bounded (got ${text.length})`,
  );
  assert.ok(text.endsWith(CONSOLE_TRUNCATION_MARKER), "truncation marker appended when budget exhausted");
});

test("renderConsole: small message set is rendered verbatim with no marker", () => {
  const text = renderConsole([
    { level: "log", text: "hello" },
    { level: "error", text: "boom" },
  ]);
  assert.equal(text, "[log] hello\n[error] boom");
});

// ── #23: renderDownloads formatting at the tool layer ────────────────────────

// renderDownloads is private to src/tools/browser.ts, so it is exercised through
// the real tool path: an `act:wait` result appends renderDownloads(drainDownloads).
// We seed the session's pendingDownloads buffer (the exact array drainDownloads
// reads) with one successful and one failed DownloadRecord — the shapes the
// capture pipeline produces — then assert the rendered text the model actually
// sees. (Driving the full CDP pipeline here would re-test capture, not formatting.)
type SessionsPrivate = {
  sessions: Map<string, { pendingDownloads: Array<{ path: string; filename: string; url: string; failed?: boolean }> }>;
};

test("tool: a failed download renders as [download failed: name (url)] and a successful one as its path (#23)", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-tool-dl-"));
  const restore = stubManager();
  const cfg = baseConfig();
  const connect: ConnectOverCdp = async () => makeBrowser({}) as unknown as Awaited<ReturnType<ConnectOverCdp>>;
  const session = new BrowserSession({ config: cfg, agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
  const tool = createBrowserTool({ session, agentSessionId: "s1", config: cfg, maxImageBytes: 5_242_880, workspaceRoot: ws });
  try {
    await session.getActivePage("s1"); // creates the session state whose pendingDownloads we seed
    const state = (session as unknown as SessionsPrivate).sessions.get("s1")!;
    state.pendingDownloads.push(
      { path: "browser-downloads/s1/report.pdf", filename: "report.pdf", url: "https://example.com/report.pdf" },
      { path: "", filename: "huge.iso", url: "https://example.com/huge.iso", failed: true },
    );

    // act:wait drains + renders the downloads onto its result text.
    const result = await tool.execute("c1", { action: "act", kind: "wait", ms: 1 });
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });

    // The failed record renders in the [download failed: <name> (<url>)] form.
    assert.match(text, /\[download failed: huge\.iso \(https:\/\/example\.com\/huge\.iso\)\]/);
    // The successful record renders as its workspace path + source url.
    assert.match(text, /browser-downloads\/s1\/report\.pdf \(from https:\/\/example\.com\/report\.pdf\)/);
    // With at least one saved file the header is the "downloaded N file(s)" variant.
    assert.match(text, /\[downloaded 1 file\(s\) to the workspace\]/);
    assert.doesNotMatch(text, /no file produced/, "the saved header is used when something saved");
    // Drained: a second render carries no download lines.
    const again = textOf(await tool.execute("c1", { action: "act", kind: "wait", ms: 1 }) as { content: Array<{ type: string; text?: string }> });
    assert.doesNotMatch(again, /download failed|downloaded 1 file/, "downloads were drained after the first render");
  } finally {
    restore();
    await session.shutdown();
    await rm(ws, { recursive: true, force: true });
  }
});

test("tool: when every drained download failed, the header switches to the 'no file produced' variant (#23)", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-tool-dl-"));
  const restore = stubManager();
  const cfg = baseConfig();
  const connect: ConnectOverCdp = async () => makeBrowser({}) as unknown as Awaited<ReturnType<ConnectOverCdp>>;
  const session = new BrowserSession({ config: cfg, agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger, connectOverCdp: connect });
  const tool = createBrowserTool({ session, agentSessionId: "s1", config: cfg, maxImageBytes: 5_242_880, workspaceRoot: ws });
  try {
    await session.getActivePage("s1");
    const state = (session as unknown as SessionsPrivate).sessions.get("s1")!;
    // Only failed records → nothing saved.
    state.pendingDownloads.push(
      { path: "", filename: "a.zip", url: "https://example.com/a.zip", failed: true },
      { path: "", filename: "b.zip", url: "https://example.com/b.zip", failed: true },
    );

    const text = textOf(await tool.execute("c1", { action: "act", kind: "wait", ms: 1 }) as { content: Array<{ type: string; text?: string }> });
    assert.match(text, /\[download\(s\) failed — no file produced\]/, "the no-file-produced header is used when nothing saved");
    assert.doesNotMatch(text, /downloaded \d+ file/, "the saved-files header is NOT used");
    assert.match(text, /\[download failed: a\.zip \(https:\/\/example\.com\/a\.zip\)\]/);
    assert.match(text, /\[download failed: b\.zip \(https:\/\/example\.com\/b\.zip\)\]/);
  } finally {
    restore();
    await session.shutdown();
    await rm(ws, { recursive: true, force: true });
  }
});
