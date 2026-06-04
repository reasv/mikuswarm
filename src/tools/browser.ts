import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Page } from "playwright-core";

import type { BrowserConfig } from "../config/index.js";
import {
  act,
  aiSnapshot,
  assertBrowserUrl,
  BrowserError,
  isBrowserError,
  isTimeoutError,
  type ActKind,
  type ActParams,
  type BrowserSession,
  type DownloadRecord,
} from "../browser/index.js";

export interface BrowserToolContext {
  /** Shared connection/identity manager (one persistent CloakBrowser identity). */
  session: BrowserSession;
  /** The calling chat session — selects this session's tab(s) (spec §4.1). */
  agentSessionId: string;
  config: BrowserConfig;
}

const ACTION_VALUES = ["navigate", "snapshot", "act", "screenshot", "tabs", "open", "close"] as const;
const ACT_KINDS: ActKind[] = ["click", "type", "press", "hover", "select", "fill", "scroll", "wait", "back", "evaluate"];

const DESCRIPTION = [
  "Drive a real, stealth web browser (one persistent identity — shared cookies/logins) to read pages, follow links, and fill the occasional form.",
  "Use this for interactive / JS-heavy / login-gated / bot-checked sites; for just reading a page's text prefer web_fetch.",
  "",
  "Pick an `action`:",
  "- navigate { url }: go to an http/https URL; returns the page's AI snapshot.",
  "- snapshot: return the current page's accessibility tree, with every interactive element tagged [ref=eN].",
  "- act { kind, ... }: interact by ref. kinds: click|type|press|hover|select|fill|scroll|wait|back|evaluate.",
  "    click/hover/fill/type/select/scroll take `ref` (and fill/type take `text`; select takes `value`).",
  "    press takes `key` (e.g. \"Enter\"), optional `ref`. scroll without `ref` scrolls the page by `delta_y`.",
  "    wait takes `ms`. back navigates history. evaluate runs JS in `text` (only if enabled).",
  "- screenshot { full_page? }: return a PNG of the page to look at.",
  "- open { url? }: open a new tab (optionally navigate it). close { index }: close a tab.",
  "- tabs: list this session's tabs; pass `index` to switch the active tab.",
  "",
  "Refs come from the latest snapshot and go STALE after navigation or DOM changes — if an act reports the ref expired, take a fresh snapshot and use a current ref.",
].join("\n");

export function createBrowserTool(context: BrowserToolContext): AgentTool {
  const { session, agentSessionId, config } = context;
  const actTimeoutMs = config.act_timeout_ms;

  return {
    name: "browser",
    label: "Browser",
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(ACTION_VALUES.map((v) => Type.Literal(v))),
      url: Type.Optional(Type.String({ description: "URL for navigate/open (http/https only)." })),
      kind: Type.Optional(Type.Union(ACT_KINDS.map((v) => Type.Literal(v)))),
      ref: Type.Optional(Type.String({ description: "A [ref=eN] handle from the latest snapshot." })),
      text: Type.Optional(Type.String({ description: "Text to type/fill, or JS for evaluate." })),
      key: Type.Optional(Type.String({ description: 'Key for act:press, e.g. "Enter".' })),
      value: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], { description: "Option value(s) for act:select." }),
      ),
      delta_y: Type.Optional(Type.Number({ description: "Pixels to scroll (act:scroll without a ref)." })),
      ms: Type.Optional(Type.Number({ description: "Milliseconds for act:wait." })),
      full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (screenshot)." })),
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
          dispatch(session, agentSessionId, config, actTimeoutMs, args),
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
  text?: string;
  key?: string;
  value?: string | string[];
  delta_y?: number;
  ms?: number;
  full_page?: boolean;
  index?: number;
}

async function dispatch(
  session: BrowserSession,
  sessionId: string,
  config: BrowserConfig,
  actTimeoutMs: number,
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
      const actParams: ActParams = {
        kind: args.kind,
        ref: args.ref,
        text: args.text,
        key: args.key,
        value: args.value,
        delta_y: args.delta_y,
        ms: args.ms,
      };
      const result = await act(page, actParams, { timeoutMs: actTimeoutMs, evaluateEnabled: config.evaluate_enabled });
      // evaluate/wait don't change what's worth re-snapshotting; return terse.
      if (args.kind === "evaluate" || args.kind === "wait") {
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
      let buffer: Buffer;
      try {
        buffer = await page.screenshot({ fullPage: args.full_page ?? false, timeout: config.act_timeout_ms });
      } catch (error) {
        // Distinguish a genuine capture timeout from any other failure so the
        // code isn't misleading (issue #8): a timeout is act_timeout, everything
        // else (detached page, encoding error, …) is screenshot_failed.
        const message = error instanceof Error ? error.message : String(error);
        if (isTimeoutError(error)) {
          throw new BrowserError("act_timeout", `Screenshot timed out: ${message}`, { cause: error });
        }
        throw new BrowserError("screenshot_failed", `Screenshot failed: ${message}`, { cause: error });
      }
      return {
        content: [
          { type: "text", text: `screenshot of ${page.url()}${args.full_page ? " (full page)" : ""}` },
          { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
        ],
        details: { action: "screenshot", url: page.url(), fullPage: args.full_page ?? false },
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
  const snap = await aiSnapshot(page, config.snapshot_max_chars);
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
