// Element actions by ref (spec §5.1/§5.3). Targets come from the most recent AI
// snapshot's [ref=eN] tags, resolved through Playwright's `aria-ref=eN` selector
// engine. A ref that has gone stale (after a navigation or DOM mutation) fails to
// resolve and surfaces as a structured `ref_expired` error telling the model to
// take a fresh snapshot — rather than acting on the wrong element.

import type { Page } from "playwright-core";
import { BrowserError } from "./errors.js";

export type ActKind =
  | "click"
  | "type"
  | "press"
  | "hover"
  | "select"
  | "fill"
  | "scroll"
  | "wait"
  | "back"
  | "evaluate"
  | "drag"
  | "upload"
  | "clear_site_data";

/** A file to upload, shipped inline as bytes (never a host path — see §3.5). */
export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export type ClickButton = "left" | "right" | "middle";
export type ClickModifier = "Alt" | "Control" | "Meta" | "Shift";
export type LoadState = "load" | "domcontentloaded" | "networkidle";

export interface ActParams {
  kind: ActKind;
  /** A [ref=eN] handle from the latest snapshot (required for element actions). */
  ref?: string;
  /** Target [ref=eN] handle for `drag` (the drop destination). */
  to_ref?: string;
  /** Text to type/fill, or the JS expression for `evaluate`. */
  text?: string;
  /** Key name for `press` (e.g. "Enter", "Control+A"). */
  key?: string;
  /** Option value(s) for `select`. */
  value?: string | string[];
  /** Wheel delta for `scroll` (pixels; positive = down). */
  delta_y?: number;
  /** Milliseconds for `wait` (sleep fallback when no condition field is set). */
  ms?: number;
  /** Mouse button for `click` (defaults to left). */
  button?: ClickButton;
  /** Double-click instead of single-click (`click`). */
  double?: boolean;
  /** Keyboard modifiers held during `click`. */
  modifiers?: ClickModifier[];
  /** Press Enter after typing (`type`). */
  submit?: boolean;
  /** Resolved upload files (bytes, not paths) for `upload`; the tool layer fills these in. */
  files?: UploadFile[];
  /** `wait`: resolve when this text becomes visible. */
  wait_text?: string;
  /** `wait`: resolve when this text becomes hidden/detached. */
  wait_text_gone?: string;
  /** `wait`: resolve when this CSS selector becomes visible. */
  wait_selector?: string;
  /** `wait`: resolve when the page URL matches this glob (Playwright glob, not http-validated). */
  wait_url?: string;
  /** `wait`: resolve when the page reaches this load state. */
  wait_load_state?: LoadState;
}

export interface ActOptions {
  timeoutMs: number;
  evaluateEnabled: boolean;
}

export const REF_RE = /^e\d+$/;
const MAX_WAIT_MS = 30_000;

export interface ActResult {
  ok: true;
  kind: ActKind;
  detail: string;
}

export async function act(page: Page, params: ActParams, opts: ActOptions): Promise<ActResult> {
  const { kind } = params;
  switch (kind) {
    case "click": {
      // Playwright treats `undefined` button/modifiers as defaults (left / none),
      // so the only branch needed is double vs single click.
      const clickOpts = { timeout: opts.timeoutMs, button: params.button, modifiers: params.modifiers };
      await withRef(page, params, opts, (loc) => (params.double ? loc.dblclick(clickOpts) : loc.click(clickOpts)));
      const buttonNote = params.button && params.button !== "left" ? ` (${params.button})` : "";
      return done(kind, `${params.double ? "double-" : ""}clicked ${params.ref}${buttonNote}`);
    }

    case "hover":
      await withRef(page, params, opts, (loc) => loc.hover({ timeout: opts.timeoutMs }));
      return done(kind, `hovered ${params.ref}`);

    case "fill": {
      const text = requireText(params, "fill");
      await withRef(page, params, opts, (loc) => loc.fill(text, { timeout: opts.timeoutMs }));
      return done(kind, `filled ${params.ref}`);
    }

    case "type": {
      const text = requireText(params, "type");
      await withRef(page, params, opts, (loc) => loc.pressSequentially(text, { timeout: opts.timeoutMs }));
      // Submit by pressing Enter on the same LOCATOR (not page.keyboard) so the
      // ref is re-targeted: a focus loss or DOM change between typing and submit
      // surfaces as ref_expired via withRef's mapError, rather than a blind
      // global keypress landing on the wrong element.
      if (params.submit) {
        await withRef(page, params, opts, (loc) => loc.press("Enter", { timeout: opts.timeoutMs }));
      }
      return done(kind, params.submit ? `typed into ${params.ref} and submitted` : `typed into ${params.ref}`);
    }

    case "select": {
      if (params.value === undefined) {
        throw new BrowserError("bad_request", "act:select requires `value`.");
      }
      const value = params.value;
      await withRef(page, params, opts, (loc) => loc.selectOption(value, { timeout: opts.timeoutMs }));
      return done(kind, `selected on ${params.ref}`);
    }

    case "press": {
      const key = params.key;
      if (!key) throw new BrowserError("bad_request", "act:press requires `key` (e.g. \"Enter\").");
      if (params.ref) {
        await withRef(page, params, opts, (loc) => loc.press(key, { timeout: opts.timeoutMs }));
      } else {
        await page.keyboard.press(key);
      }
      return done(kind, `pressed ${key}`);
    }

    case "scroll": {
      if (params.ref) {
        await withRef(page, params, opts, (loc) => loc.scrollIntoViewIfNeeded({ timeout: opts.timeoutMs }));
        return done(kind, `scrolled ${params.ref} into view`);
      }
      const dy = typeof params.delta_y === "number" ? params.delta_y : 600;
      await page.mouse.wheel(0, dy);
      return done(kind, `scrolled by ${dy}px`);
    }

    case "wait": {
      // Exactly one condition field may be set; the bare `ms` sleep is the
      // fallback when none is. Count the dedicated fields and reject ambiguity.
      const conditions = [
        params.wait_text,
        params.wait_text_gone,
        params.wait_selector,
        params.wait_url,
        params.wait_load_state,
      ].filter((v) => v !== undefined);
      if (conditions.length > 1) {
        throw new BrowserError(
          "bad_request",
          "wait accepts exactly one of ms / wait_text / wait_text_gone / wait_selector / wait_url / wait_load_state.",
        );
      }
      // Condition waits use the action budget (act_timeout_ms); the pure sleep
      // keeps its own MAX_WAIT_MS cap. A condition that exceeds the budget
      // surfaces as act_timeout via mapError — the agent can re-issue.
      const T = opts.timeoutMs;
      try {
        if (params.wait_text !== undefined) {
          await page.getByText(params.wait_text).first().waitFor({ state: "visible", timeout: T });
          return done(kind, `waited for text ${JSON.stringify(params.wait_text)}`);
        }
        if (params.wait_text_gone !== undefined) {
          await page.getByText(params.wait_text_gone).first().waitFor({ state: "hidden", timeout: T });
          return done(kind, `waited for text gone ${JSON.stringify(params.wait_text_gone)}`);
        }
        if (params.wait_selector !== undefined) {
          await page.locator(params.wait_selector).first().waitFor({ state: "visible", timeout: T });
          return done(kind, `waited for selector ${params.wait_selector}`);
        }
        if (params.wait_url !== undefined) {
          await page.waitForURL(params.wait_url, { timeout: T });
          return done(kind, `waited for url ${params.wait_url}`);
        }
        if (params.wait_load_state !== undefined) {
          await page.waitForLoadState(params.wait_load_state, { timeout: T });
          return done(kind, `waited for load state ${params.wait_load_state}`);
        }
      } catch (error) {
        // A condition that never holds times out → act_timeout; a bad CSS
        // selector / glob surfaces as bad_request.
        throw mapError(error, false);
      }
      const ms = Math.min(Math.max(0, params.ms ?? 1000), MAX_WAIT_MS);
      await page.waitForTimeout(ms);
      return done(kind, `waited ${ms}ms`);
    }

    case "back":
      await page.goBack({ timeout: opts.timeoutMs }).catch((error) => {
        throw mapError(error, false);
      });
      return done(kind, "navigated back");

    case "evaluate": {
      if (!opts.evaluateEnabled) {
        throw new BrowserError(
          "evaluate_disabled",
          "act:evaluate is disabled. Set [browser].evaluate_enabled = true to allow arbitrary page JS.",
        );
      }
      const expr = requireText(params, "evaluate");
      let result: unknown;
      try {
        result = await page.evaluate(expr);
      } catch (error) {
        // A runtime exception from the page expression — not a malformed request.
        // This is the page's own JS throwing; report it as evaluate_failed so
        // observability/programmatic handling isn't misled (see issue #8).
        throw new BrowserError(
          "evaluate_failed",
          `act:evaluate threw: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return done(kind, `evaluate → ${stringifyResult(result)}`);
    }

    case "drag": {
      const source = requireRefLocator(page, params.ref, "drag");
      const target = requireRefLocator(page, params.to_ref, "drag (to_ref)");
      try {
        await source.dragTo(target, { timeout: opts.timeoutMs });
      } catch (error) {
        // A stale ref on either end → ref_expired.
        throw mapError(error, true, `${params.ref}→${params.to_ref}`);
      }
      return done(kind, `dragged ${params.ref} → ${params.to_ref}`);
    }

    case "upload": {
      const loc = requireRefLocator(page, params.ref, "upload");
      const files = params.files;
      if (!files || files.length === 0) {
        throw new BrowserError("bad_request", "act:upload requires resolved files.");
      }
      // Detect a direct <input type=file> vs. a styled button that opens the
      // chooser. A fixed predicate (not agent-supplied JS) — the evaluate_enabled
      // gate doesn't apply.
      // The `.catch(() => false)` deliberately treats any probe failure as "not a
      // file input" and falls through to the chooser path. A genuinely stale ref
      // makes the probe throw, but rather than mapping it here we let the
      // subsequent `loc.click(...)` fail and surface as ref_expired via its
      // mapError — so a single, consistent stale-ref error reaches the model.
      const isFileInput = await loc
        .evaluate((el) => el instanceof HTMLInputElement && el.type === "file")
        .catch(() => false);
      try {
        if (isFileInput) {
          await loc.setInputFiles(files, { timeout: opts.timeoutMs });
        } else {
          const chooserP = page.waitForEvent("filechooser", { timeout: opts.timeoutMs });
          await loc.click({ timeout: opts.timeoutMs });
          const chooser = await chooserP;
          await chooser.setFiles(files, { timeout: opts.timeoutMs });
        }
      } catch (error) {
        // Stale ref → ref_expired; chooser/set timeout → act_timeout; any other
        // set/arm failure → upload_failed.
        const mapped = mapError(error, true, params.ref);
        if (mapped.code === "ref_expired" || mapped.code === "act_timeout") throw mapped;
        throw new BrowserError(
          "upload_failed",
          `Upload to ${params.ref} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return done(kind, `uploaded ${files.length} file(s) to ${params.ref}`);
    }

    case "clear_site_data": {
      const url = page.url();
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = "";
      }
      if (!origin || origin === "null") {
        // about:blank, data:, etc. — there is no security origin to clear.
        throw new BrowserError(
          "bad_request",
          "clear_site_data needs a page on an http(s) origin (current page has none).",
        );
      }
      // Opening the CDP session is itself a failure point: if it throws, it must
      // surface as a structured clear_failed (not a raw error) so the tool layer
      // can map it. Declare `cdp` first and only run detach once it's defined.
      let cdp: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;
      try {
        cdp = await page.context().newCDPSession(page);
      } catch (error) {
        throw new BrowserError(
          "clear_failed",
          `Failed to open a CDP session to clear ${origin}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      try {
        await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
      } catch (error) {
        throw new BrowserError(
          "clear_failed",
          `Failed to clear site data for ${origin}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        await cdp.detach().catch(() => {});
      }
      return done(kind, `cleared site data for ${origin}`);
    }

    default:
      throw new BrowserError("bad_request", `Unknown act kind: ${String(kind)}`);
  }
}

/**
 * Validate a `ref`'s shape and build its `aria-ref` locator. Shared by `withRef`
 * (single-target acts) and the multi-target acts (`drag` source + target) so a
 * malformed ref produces a consistent `bad_request` everywhere. Does NOT run the
 * action — the caller owns error mapping (stale-ref detection happens when the
 * locator fails to resolve).
 */
function requireRefLocator(
  page: Page,
  ref: string | undefined,
  kindLabel: string,
): ReturnType<Page["locator"]> {
  if (!ref) throw new BrowserError("bad_request", `act:${kindLabel} requires a \`ref\` from the latest snapshot.`);
  if (!REF_RE.test(ref)) {
    throw new BrowserError("bad_request", `Invalid ref "${ref}" — expected a snapshot handle like "e12".`);
  }
  return page.locator(`aria-ref=${ref}`);
}

async function withRef(
  page: Page,
  params: ActParams,
  _opts: ActOptions,
  fn: (loc: ReturnType<Page["locator"]>) => Promise<unknown>,
): Promise<void> {
  const locator = requireRefLocator(page, params.ref, params.kind);
  try {
    await fn(locator);
  } catch (error) {
    throw mapError(error, true, params.ref);
  }
}

/** True for Playwright timeout errors (by error name or message shape). */
export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (error as { name?: string })?.name === "TimeoutError" || /Timeout .*exceeded/i.test(message);
}

// A stale `aria-ref` can fail to resolve *synchronously* (Playwright throwing a
// "no node found"-style error) rather than timing out. By the time mapError runs
// with refUsed=true, withRef has already accepted the ref via REF_RE, so the ref
// was syntactically valid — a resolution failure means it went stale. Scope this
// strictly to aria-ref resolution failures so a genuine bad_request (invalid
// params) isn't misclassified. Empirical confirmation of the exact thrown error
// lives in the docker integration test (test/browser.docker.test.ts).
const ARIA_REF_RE = /aria-ref/i;
// Match only genuine "the ref points at nothing" phrasings. Deliberately NOT
// matching the generic "resolve"/"unable to" — `aria-ref=eN` is echoed in nearly
// every locator error message, so a strict-mode "...resolved to 2 elements"
// violation (a real, non-stale error) would otherwise be misclassified.
const REF_UNRESOLVED_RE = /not found|no node|cannot find|no element|did not match/i;

/** Map Playwright errors to structured BrowserErrors. */
export function mapError(error: unknown, refUsed: boolean, ref?: string): BrowserError {
  const message = error instanceof Error ? error.message : String(error);
  const isTimeout = isTimeoutError(error);
  // A stale ref surfaces either as a resolution timeout or a synchronous
  // "no node for aria-ref" error — both mean "take a fresh snapshot" (§5.3).
  const isStaleRef =
    refUsed && (isTimeout || (ARIA_REF_RE.test(message) && REF_UNRESOLVED_RE.test(message)));
  if (isStaleRef) {
    return new BrowserError(
      "ref_expired",
      `Ref ${ref ?? ""} did not resolve (it likely went stale after a navigation or DOM change). Take a fresh \`snapshot\` and retry with a current ref.`,
      { cause: error },
    );
  }
  if (isTimeout) {
    return new BrowserError("act_timeout", `Action timed out: ${message}`, { cause: error });
  }
  return new BrowserError("bad_request", message, { cause: error });
}

function requireText(params: ActParams, kind: string): string {
  if (typeof params.text !== "string" || params.text.length === 0) {
    throw new BrowserError("bad_request", `act:${kind} requires non-empty \`text\`.`);
  }
  return params.text;
}

function done(kind: ActKind, detail: string): ActResult {
  return { ok: true, kind, detail };
}

function stringifyResult(value: unknown): string {
  if (value === undefined) return "undefined";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}
