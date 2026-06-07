import { stat, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Page } from "playwright-core";
import sharp from "sharp";

import type { BrowserConfig } from "../config/index.js";
import {
  act,
  aiSnapshot,
  assertBrowserUrl,
  BrowserError,
  isBrowserError,
  isTimeoutError,
  mapError,
  requireRefLocator,
  type ActKind,
  type ActParams,
  type BrowserSession,
  type DownloadRecord,
  type UploadFile,
} from "../browser/index.js";
import { base64ByteSize } from "./read-image.js";
import { resolveWorkspacePath } from "./workspace.js";

/** Upload bounds ship as code constants (proposal §9); promote to config if a deployment needs to tune them. */
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB total across all files

type ScreenshotFormat = "png" | "jpeg";
const JPEG_QUALITY = 80;

export interface BrowserToolContext {
  /** Shared connection/identity manager (one persistent CloakBrowser identity). */
  session: BrowserSession;
  /** The calling chat session — selects this session's tab(s) (spec §4.1). */
  agentSessionId: string;
  config: BrowserConfig;
  /**
   * Max bytes for an inline screenshot payload, measured as the base64-encoded
   * size — the same shared per-model cap `read_image` uses (resolved from
   * `resolveReadImageMaxBytes(config)`). A capture over this is downscaled via
   * sharp to fit rather than shipped oversized.
   */
  maxImageBytes: number;
  /**
   * Workspace root for resolving `upload` paths. Upload files must resolve
   * within this directory (no absolute paths, no `../` escape — see §3.5/§6).
   */
  workspaceRoot: string;
}

const ACTION_VALUES = ["navigate", "snapshot", "act", "screenshot", "pdf", "console", "tabs", "open", "close"] as const;
const ACT_KINDS: ActKind[] = [
  "click", "type", "press", "hover", "select", "fill", "scroll", "wait", "back", "evaluate",
  "drag", "upload", "clear_site_data", "dialog",
];

const DESCRIPTION = [
  "Drive a real, stealth web browser (one persistent identity — shared cookies/logins) to read pages, follow links, and fill the occasional form.",
  "Use this for interactive / JS-heavy / login-gated / bot-checked sites; for just reading a page's text prefer web_fetch.",
  "",
  "Pick an `action`:",
  "- navigate { url }: go to an http/https URL; returns the page's AI snapshot.",
  "- snapshot: return the current page's accessibility tree, with every interactive element tagged [ref=eN].",
  "- act { kind, ... }: interact by ref. kinds: click|type|press|hover|select|fill|scroll|wait|back|evaluate|drag|upload|clear_site_data|dialog.",
  "    click takes `ref`, plus optional `button` (left|right|middle), `double` (double-click), `modifiers` (Alt/Control/Meta/Shift).",
  "    hover/fill/type/select/scroll take `ref` (and fill/type take `text`; select takes `value`). type takes optional `submit` to press Enter after typing.",
  "    press takes `key` (e.g. \"Enter\"), optional `ref`. scroll without `ref` scrolls the page by `delta_y`.",
  "    wait takes exactly one of the wait_* conditions (wait_text / wait_text_gone / wait_selector (CSS) / wait_url (glob) / wait_load_state (load|domcontentloaded|networkidle)); `ms` is the plain sleep used only when no condition is set.",
  "    back navigates history. evaluate runs JS in `text` (only if enabled).",
  "    drag takes `ref` (source) and `to_ref` (target). upload takes `ref` (an <input type=file> or a button that opens the chooser) and `paths` (workspace-relative files).",
  "    clear_site_data discards cookies + all web storage for the CURRENT page's origin (a fresh start on this site; cookies are cleared by security origin, so parent-domain cookies set elsewhere may persist).",
  "    dialog takes `accept` (true/false) and optional `prompt_text`; it arms the NEXT JS dialog — arm it BEFORE the click/act that triggers the dialog. Without it, dialogs are auto-handled by the deployment's dialog_policy.",
  "- screenshot { full_page?, ref?, format? }: return an image to look at. With `ref`, capture just that element (full_page is ignored). `format` is png (default) or jpeg.",
  "- pdf: save the current page to the workspace as a PDF and return its path. You CANNOT read the PDF back — use it to save a page (article/receipt/report) and send the path to the user via the message tool.",
  "- console: return buffered console + page-error messages since the last read, to diagnose why a page misbehaves. Prefer re-snapshot + retry first.",
  "- open { url? }: open a new tab (optionally navigate it). close { index }: close a tab.",
  "- tabs: list this session's tabs; pass `index` to switch the active tab.",
  "",
  "Refs come from the latest snapshot and go STALE after navigation or DOM changes — if an act reports the ref expired, take a fresh snapshot and use a current ref.",
].join("\n");

export function createBrowserTool(context: BrowserToolContext): AgentTool {
  const { session, agentSessionId, config, maxImageBytes, workspaceRoot } = context;
  const actTimeoutMs = config.act_timeout_ms;

  return {
    name: "browser",
    label: "Browser",
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(ACTION_VALUES.map((v) => Type.Literal(v))),
      url: Type.Optional(Type.String({ description: "URL for navigate/open (http/https only)." })),
      kind: Type.Optional(Type.Union(ACT_KINDS.map((v) => Type.Literal(v)))),
      ref: Type.Optional(Type.String({ description: "A [ref=eN] handle from the latest snapshot (act target, or element to screenshot)." })),
      to_ref: Type.Optional(Type.String({ description: "Drop-target [ref=eN] handle for act:drag." })),
      // maxLength is a generous defensive bound: a pathological multi-MB
      // fill/evaluate value fails fast with a clear schema error instead of by
      // timeout (issue #10). 100k chars is far above any legitimate input.
      text: Type.Optional(Type.String({ maxLength: 100000, description: "Text to type/fill, or JS for evaluate." })),
      key: Type.Optional(Type.String({ description: 'Key for act:press, e.g. "Enter".' })),
      value: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], { description: "Option value(s) for act:select." }),
      ),
      delta_y: Type.Optional(Type.Number({ description: "Pixels to scroll (act:scroll without a ref)." })),
      ms: Type.Optional(Type.Number({ description: "Milliseconds for act:wait (sleep fallback when no wait_* condition is set)." })),
      button: Type.Optional(
        Type.Union(["left", "right", "middle"].map((v) => Type.Literal(v)), { description: "Mouse button for act:click (default left)." }),
      ),
      double: Type.Optional(Type.Boolean({ description: "Double-click instead of single-click (act:click)." })),
      modifiers: Type.Optional(
        Type.Array(Type.Union(["Alt", "Control", "Meta", "Shift"].map((v) => Type.Literal(v))), {
          description: "Keyboard modifiers held during act:click.",
        }),
      ),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing (act:type)." })),
      paths: Type.Optional(
        Type.Array(Type.String(), { description: "Workspace-relative file paths to upload (act:upload)." }),
      ),
      wait_text: Type.Optional(Type.String({ description: "act:wait until this text is visible." })),
      wait_text_gone: Type.Optional(Type.String({ description: "act:wait until this text is hidden/detached." })),
      wait_selector: Type.Optional(Type.String({ description: "act:wait until this CSS selector is visible." })),
      wait_url: Type.Optional(Type.String({ description: "act:wait until the page URL matches this glob." })),
      wait_load_state: Type.Optional(
        Type.Union(["load", "domcontentloaded", "networkidle"].map((v) => Type.Literal(v)), {
          description: "act:wait until the page reaches this load state.",
        }),
      ),
      accept: Type.Optional(Type.Boolean({ description: "act:dialog — accept (true) or dismiss (false) the next JS dialog." })),
      prompt_text: Type.Optional(Type.String({ description: "act:dialog — text to answer a window.prompt() with when accepting." })),
      full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (screenshot; ignored when ref is set)." })),
      format: Type.Optional(
        Type.Union(["png", "jpeg"].map((v) => Type.Literal(v)), { description: "Screenshot image format (default png)." }),
      ),
      index: Type.Optional(Type.Number({ description: "Tab index for close / tabs-switch." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as BrowserToolArgs;
      try {
        // Bracket the whole op with beginOp/endOp (via runOp) so the idle
        // sweeper never reaps this session's page mid-operation (issue #1).
        // Symmetric even on throw; endOp also refreshes the idle clock so a long
        // op resets it on completion.
        return await session.runOp(agentSessionId, () =>
          dispatch(session, agentSessionId, config, actTimeoutMs, maxImageBytes, workspaceRoot, args),
        );
      } catch (error) {
        if (isBrowserError(error)) {
          // Surface a clean, actionable failure to the model (not a raw crash).
          throw new Error(`browser:${error.code} — ${error.message}`);
        }
        throw error;
      }
    },
  };
}

interface BrowserToolArgs {
  action: (typeof ACTION_VALUES)[number];
  url?: string;
  kind?: ActKind;
  ref?: string;
  to_ref?: string;
  text?: string;
  key?: string;
  value?: string | string[];
  delta_y?: number;
  ms?: number;
  button?: "left" | "right" | "middle";
  double?: boolean;
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  submit?: boolean;
  paths?: string[];
  wait_text?: string;
  wait_text_gone?: string;
  wait_selector?: string;
  wait_url?: string;
  wait_load_state?: "load" | "domcontentloaded" | "networkidle";
  accept?: boolean;
  prompt_text?: string;
  full_page?: boolean;
  format?: ScreenshotFormat;
  index?: number;
}

async function dispatch(
  session: BrowserSession,
  sessionId: string,
  config: BrowserConfig,
  actTimeoutMs: number,
  maxImageBytes: number,
  workspaceRoot: string,
  args: BrowserToolArgs,
): Promise<AgentToolResult<unknown>> {
  switch (args.action) {
    case "navigate": {
      if (!args.url) throw new BrowserError("bad_request", "navigate requires `url`.");
      const url = assertBrowserUrl(args.url);
      const page = await session.getActivePage(sessionId);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.nav_timeout_ms });
      } catch (error) {
        throw mapNavError(error, url);
      }
      return pageResult(session, sessionId, page, config, `navigated to ${page.url()}`);
    }

    case "snapshot": {
      const page = await session.getActivePage(sessionId);
      return pageResult(session, sessionId, page, config, `snapshot of ${page.url()}`);
    }

    case "act": {
      if (!args.kind) throw new BrowserError("bad_request", "act requires `kind`.");
      const page = await session.getActivePage(sessionId);
      // Path policy lives here (not in act.ts) so `act` stays filesystem-agnostic:
      // resolve+read upload files into buffers before handing them to act.
      const files = args.kind === "upload" ? await resolveUploadFiles(workspaceRoot, args.paths) : undefined;
      const actParams: ActParams = {
        kind: args.kind,
        ref: args.ref,
        to_ref: args.to_ref,
        text: args.text,
        key: args.key,
        value: args.value,
        delta_y: args.delta_y,
        ms: args.ms,
        button: args.button,
        double: args.double,
        modifiers: args.modifiers,
        submit: args.submit,
        files,
        wait_text: args.wait_text,
        wait_text_gone: args.wait_text_gone,
        wait_selector: args.wait_selector,
        wait_url: args.wait_url,
        wait_load_state: args.wait_load_state,
        accept: args.accept,
        prompt_text: args.prompt_text,
      };
      const result = await act(page, actParams, {
        timeoutMs: actTimeoutMs,
        evaluateEnabled: config.evaluate_enabled,
        // act:dialog arms a one-shot override on this page; the next dialog (from
        // a subsequent triggering act) is handled per the override.
        armDialog: (accept, promptText) => session.armDialog(page, accept, promptText),
        // Snapshot-time frame URLs for this page → lets requireRefLocator catch a
        // reordered frame ref (fN index now on a different live frame) as stale.
        frameUrls: session.frameUrlsFor(page),
      });
      // evaluate/wait/dialog don't change what's worth re-snapshotting; return terse.
      if (args.kind === "evaluate" || args.kind === "wait" || args.kind === "dialog") {
        const downloads = session.drainDownloads(sessionId);
        return {
          content: [{ type: "text", text: result.detail + renderDownloads(downloads) }],
          details: { action: "act", kind: args.kind, url: page.url(), downloads },
        };
      }
      return pageResult(session, sessionId, page, config, result.detail);
    }

    case "screenshot": {
      const page = await session.getActivePage(sessionId);
      const format: ScreenshotFormat = args.format ?? "png";
      // With a `ref`, capture just that element; otherwise capture the page.
      // full_page has no meaning for an element capture, so it's ignored there.
      // requireRefLocator validates the ref shape (bad_request) and resolves a
      // frame-namespaced ref to its owning frame (missing frame → ref_expired),
      // matching how `act` targets elements — it's called BEFORE the try so its
      // structured errors propagate as-is rather than through the screenshot
      // error mapper below.
      const elementRef = args.ref;
      const target = elementRef
        ? requireRefLocator(page, elementRef, "screenshot", session.frameUrlsFor(page))
        : page;
      let buffer: Buffer;
      try {
        buffer = await target.screenshot({
          ...(elementRef ? {} : { fullPage: args.full_page ?? false }),
          type: format,
          timeout: config.act_timeout_ms,
        });
      } catch (error) {
        // Distinguish a genuine capture timeout from any other failure so the
        // code isn't misleading (issue #8): a timeout is act_timeout, everything
        // else (detached page, encoding error, …) is screenshot_failed. A stale
        // element ref surfaces as ref_expired (take a fresh snapshot).
        const message = error instanceof Error ? error.message : String(error);
        if (elementRef) {
          // A stale element ref only surfaces as ref_expired when its error matches
          // the timeout-or-REF_UNRESOLVED_RE heuristic; a stale-ref error of an
          // unusual shape degrades to screenshot_failed below, consistent with the
          // act-layer heuristic (issue #6).
          const mapped = mapError(error, true, elementRef);
          if (mapped.code === "ref_expired") throw mapped;
        }
        if (isTimeoutError(error)) {
          throw new BrowserError("act_timeout", `Screenshot timed out: ${message}`, { cause: error });
        }
        throw new BrowserError("screenshot_failed", `Screenshot failed: ${message}`, { cause: error });
      }
      // Bound the inline payload to the shared per-model base64 cap (issue #2):
      // a long full-page capture can be many MB and blow the per-image/context
      // budget. Downscale to fit rather than reject — the model should still see
      // the page.
      const bounded = await boundScreenshot(buffer, maxImageBytes, format);
      const scope = elementRef ? ` (element ${elementRef})` : args.full_page ? " (full page)" : "";
      return {
        content: [
          { type: "text", text: `screenshot of ${page.url()}${scope}` },
          { type: "image", data: bounded.data, mimeType: bounded.mimeType },
        ],
        details: {
          action: "screenshot",
          url: page.url(),
          ref: elementRef,
          format,
          fullPage: elementRef ? false : args.full_page ?? false,
          downscaled: bounded.downscaled,
          base64Bytes: bounded.base64Bytes,
        },
      };
    }

    case "pdf": {
      const page = await session.getActivePage(sessionId);
      const record = await session.exportPdf(sessionId, page);
      return {
        content: [
          {
            type: "text",
            text: `saved page as PDF: ${record.path}\n(you can't read this PDF back — send the path to the user via the message tool)`,
          },
        ],
        details: { action: "pdf", url: record.url, path: record.path, filename: record.filename },
      };
    }

    case "console": {
      const page = await session.getActivePage(sessionId);
      const messages = session.drainConsole(page);
      const text = messages.length
        ? messages.map((m) => `[${m.level}] ${m.text}`).join("\n")
        : "(no console messages since the last read)";
      return {
        content: [{ type: "text", text }],
        details: { action: "console", url: page.url(), count: messages.length },
      };
    }

    case "open": {
      const index = await session.openTab(sessionId);
      const page = await session.getActivePage(sessionId);
      if (args.url) {
        const url = assertBrowserUrl(args.url);
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.nav_timeout_ms });
        } catch (error) {
          throw mapNavError(error, url);
        }
      }
      return pageResult(session, sessionId, page, config, `opened tab ${index}${args.url ? ` at ${page.url()}` : ""}`);
    }

    case "close": {
      if (typeof args.index !== "number") throw new BrowserError("bad_request", "close requires `index`.");
      await session.closeTab(sessionId, args.index);
      const tabs = await session.listTabs(sessionId);
      return {
        content: [{ type: "text", text: `closed tab ${args.index}\n${renderTabs(tabs)}` }],
        details: { action: "close", tabs },
      };
    }

    case "tabs": {
      if (typeof args.index === "number") {
        session.setActiveTab(sessionId, args.index);
        const page = await session.getActivePage(sessionId);
        return pageResult(session, sessionId, page, config, `switched to tab ${args.index}`);
      }
      const tabs = await session.listTabs(sessionId);
      return {
        content: [{ type: "text", text: renderTabs(tabs) }],
        details: { action: "tabs", tabs },
      };
    }

    default:
      throw new BrowserError("bad_request", `Unknown action: ${String((args as { action: string }).action)}`);
  }
}

/** Build a result that pairs a one-line header with a fresh, bounded AI snapshot. */
async function pageResult(
  session: BrowserSession,
  sessionId: string,
  page: Page,
  config: BrowserConfig,
  header: string,
): Promise<AgentToolResult<unknown>> {
  const snap = await aiSnapshot(page, config.snapshot_max_chars, config.snapshot_max_frames);
  // Record the snapshot's per-index frame URLs so the NEXT act on this page can
  // detect frame reordering (a reused fN index landing on a different live frame
  // → ref_expired; see requireRefLocator). Each snapshot replaces the previous
  // map, matching the snapshot-scoped staleness contract of the refs themselves.
  session.recordFrameUrls(page, snap.frameUrls);
  const downloads = session.drainDownloads(sessionId);
  return {
    content: [{ type: "text", text: `${header}${renderDownloads(downloads)}\n\n${snap.text}` }],
    details: {
      url: page.url(),
      truncated: snap.truncated,
      refCount: snap.refCount,
      downloads,
    },
  };
}

/**
 * Bound a screenshot to `maxBytes` measured as its base64-encoded size (the
 * size providers meter against the per-image budget — the exact accounting
 * read_image uses via `base64ByteSize`). If the capture already fits it passes
 * through untouched (`downscaled: false`). Otherwise it's iteratively downscaled
 * via sharp (re-encoded in `format`) until it fits or a minimum dimension /
 * iteration cap is hit. If it genuinely can't be made to fit, throws a clean
 * `screenshot_failed` BrowserError rather than shipping an oversized block.
 * Returns the `mimeType` matching `format` so the caller's image block is tagged
 * correctly (png vs jpeg).
 *
 * Factored out (and exported) for direct testing.
 */
export async function boundScreenshot(
  buffer: Buffer,
  maxBytes: number,
  format: ScreenshotFormat = "png",
): Promise<{ data: string; downscaled: boolean; base64Bytes: number; mimeType: string }> {
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const reencode = (pipeline: sharp.Sharp): sharp.Sharp =>
    format === "jpeg" ? pipeline.jpeg({ quality: JPEG_QUALITY }) : pipeline.png();

  if (base64ByteSize(buffer.byteLength) <= maxBytes) {
    return {
      data: buffer.toString("base64"),
      downscaled: false,
      base64Bytes: base64ByteSize(buffer.byteLength),
      mimeType,
    };
  }

  // Establish the current pixel dimensions to scale from.
  const meta = await sharp(buffer).metadata();
  let width = meta.width ?? 0;
  let height = meta.height ?? 0;
  if (!width || !height) {
    // Can't introspect dimensions — we have no safe way to downscale, so refuse
    // rather than ship an oversized payload.
    throw new BrowserError(
      "screenshot_failed",
      `Screenshot is ${(base64ByteSize(buffer.byteLength) / (1024 * 1024)).toFixed(1)}MB (base64) — exceeds the ${(maxBytes / (1024 * 1024)).toFixed(1)}MB image cap and its dimensions can't be read to downscale.`,
    );
  }

  // A capped iterative shrink: each step scales linear dimensions by ~0.8
  // (≈0.64× pixels). Seed the first step from the byte ratio so a wildly
  // oversized capture converges quickly instead of crawling down 20% at a time.
  const MIN_DIMENSION = 320; // below this a screenshot is no longer useful
  const MAX_ITERATIONS = 12;
  let current = buffer;
  let currentBytes = base64ByteSize(current.byteLength);
  const initialRatio = Math.sqrt(maxBytes / currentBytes); // <1
  let scale = Math.min(0.9, Math.max(0.1, initialRatio));

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const nextWidth = Math.max(MIN_DIMENSION, Math.floor(width * scale));
    const nextHeight = Math.max(MIN_DIMENSION, Math.floor(height * scale));
    // No further progress possible (already at the floor) and still too big.
    if (nextWidth === width && nextHeight === height) break;
    width = nextWidth;
    height = nextHeight;
    current = await reencode(
      sharp(buffer).resize({ width, height, fit: "inside", withoutEnlargement: true }),
    ).toBuffer();
    currentBytes = base64ByteSize(current.byteLength);
    if (currentBytes <= maxBytes) {
      return { data: current.toString("base64"), downscaled: true, base64Bytes: currentBytes, mimeType };
    }
    // After the first (ratio-seeded) step, shrink more conservatively.
    scale = 0.8;
    if (width <= MIN_DIMENSION && height <= MIN_DIMENSION) break;
  }

  throw new BrowserError(
    "screenshot_failed",
    `Screenshot could not be downscaled under the ${(maxBytes / (1024 * 1024)).toFixed(1)}MB image cap (smallest attempt was ${(currentBytes / (1024 * 1024)).toFixed(1)}MB at ${width}x${height}). Try a non-full-page capture or a smaller viewport.`,
  );
}

/**
 * Resolve workspace-relative upload paths into inline `{name, mimeType, buffer}`
 * files. Confined to `workspaceRoot` (no absolute paths, no `../` escape — §6),
 * bounded by file count and total bytes. Reads bytes here (the Node harness can
 * see the workspace; the browser container cannot), so uploads ship over CDP as
 * buffers rather than host paths (§3.5). Throws `bad_request` on any policy
 * violation. Exported for direct testing.
 */
export async function resolveUploadFiles(workspaceRoot: string, paths: string[] | undefined): Promise<UploadFile[]> {
  if (!paths || paths.length === 0) {
    throw new BrowserError("bad_request", "upload requires a non-empty `paths` list.");
  }
  if (paths.length > MAX_UPLOAD_FILES) {
    throw new BrowserError("bad_request", `upload accepts at most ${MAX_UPLOAD_FILES} files (got ${paths.length}).`);
  }
  const files: UploadFile[] = [];
  let totalBytes = 0;
  for (const p of paths) {
    // Use the shared realpath-based containment check (realpathSync.native) so a
    // workspace-internal symlink pointing out of tree (e.g. leak -> ~/.ssh/id_rsa)
    // is rejected rather than read and exfiltrated. A lexical prefix check would
    // string-pass it; resolveWorkspacePath returns the resolved absolute path that
    // stat/readFile then operate on.
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(workspaceRoot, p);
    } catch {
      throw new BrowserError("bad_request", `upload path escapes the workspace: ${p}`);
    }
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw new BrowserError("bad_request", `file not found in workspace: ${p}`);
    }
    if (!info.isFile()) {
      throw new BrowserError("bad_request", `upload path is not a regular file: ${p}`);
    }
    totalBytes += info.size;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new BrowserError(
        "bad_request",
        `upload exceeds the ${(MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)} MiB total cap.`,
      );
    }
    const name = path.basename(resolved);
    files.push({ name, mimeType: mimeFromExt(name), buffer: await readFile(resolved) });
  }
  return files;
}

/** Minimal extension→MIME map for uploads; unknown types fall back to octet-stream. */
function mimeFromExt(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
    tiff: "image/tiff", pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
    json: "application/json", xml: "application/xml", html: "text/html",
    zip: "application/zip", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

function renderDownloads(downloads: DownloadRecord[]): string {
  if (downloads.length === 0) return "";
  const lines = downloads.map((d) => `  - ${d.path} (from ${d.url})`);
  return `\n[downloaded ${downloads.length} file(s) to the workspace]\n${lines.join("\n")}`;
}

function renderTabs(tabs: Array<{ index: number; url: string; title: string; active: boolean }>): string {
  if (tabs.length === 0) return "(no open tabs)";
  return tabs
    .map((t) => `${t.active ? "*" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`)
    .join("\n");
}

function mapNavError(error: unknown, url: string): BrowserError {
  const message = error instanceof Error ? error.message : String(error);
  if ((error as { name?: string })?.name === "TimeoutError" || /Timeout .*exceeded/i.test(message)) {
    return new BrowserError("nav_timeout", `Navigation to ${url} timed out.`, { cause: error });
  }
  return new BrowserError("connect_failed", `Navigation to ${url} failed: ${message}`, { cause: error });
}
