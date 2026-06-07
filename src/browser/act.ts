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
  | "clear_site_data"
  | "dialog";

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
  /** `dialog`: accept (true) or dismiss (false) the next JS dialog. */
  accept?: boolean;
  /** `dialog`: text to answer a `window.prompt()` with when accepting. */
  prompt_text?: string;
}

export interface ActOptions {
  timeoutMs: number;
  evaluateEnabled: boolean;
  /**
   * Arm a one-shot override for the next JS dialog on the page (the `dialog`
   * kind). Supplied by the tool layer, wired to the session's standing dialog
   * handler. Absent in contexts without a session (the bare `act` unit tests can
   * still assert the bad_request when it's missing).
   */
  armDialog?: (accept: boolean, promptText: string | undefined) => void;
  /**
   * Snapshot-time URL of each child frame, keyed by its `page.frames()` index
   * (the `N` in an `fN:eN` ref) — the `frameUrls` map from the most recent
   * `aiSnapshot`. Supplied by the tool layer from per-page session state. Used to
   * detect frame REORDERING between snapshot and act: a frame ref resolves
   * against `page.frames()[N]`, but if the live frame at N no longer carries the
   * recorded URL, index N now points at a DIFFERENT frame and the ref is stale
   * (`ref_expired`). Absent in contexts without snapshot state (bare unit tests),
   * where frame refs keep the missing-frame-only guard.
   */
  frameUrls?: Map<number, string>;
}

// A ref handle is either a bare main-document `eN` or a frame-namespaced
// `fN:eN` (N = index into page.frames()). REF_RE accepts both; BARE_REF_RE and
// FRAME_REF_RE split the two cases when resolving the owning frame.
export const REF_RE = /^(?:f\d+:)?e\d+$/;
const BARE_REF_RE = /^e\d+$/;
const FRAME_REF_RE = /^f(\d+):(e\d+)$/;
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
      const source = requireRefLocator(page, params.ref, "drag", opts.frameUrls);
      const target = requireRefLocator(page, params.to_ref, "drag (to_ref)", opts.frameUrls);
      try {
        await source.dragTo(target, { timeout: opts.timeoutMs });
      } catch (error) {
        // A stale ref on either end → ref_expired.
        throw mapError(error, true, `${params.ref}→${params.to_ref}`);
      }
      return done(kind, `dragged ${params.ref} → ${params.to_ref}`);
    }

    case "upload": {
      const loc = requireRefLocator(page, params.ref, "upload", opts.frameUrls);
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
      if (isFileInput) {
        // Direct <input type=file>: setInputFiles resolves the ref, so a timeout
        // / no-node failure here means the ref went stale → map with refUsed=true
        // (ref_expired). Any other failure → upload_failed.
        try {
          await loc.setInputFiles(files, { timeout: opts.timeoutMs });
        } catch (error) {
          throw uploadError(error, mapError(error, true, params.ref), params.ref);
        }
      } else {
        // Styled button → file chooser. Only loc.click() resolves the ref; the
        // chooser arm and chooser.setFiles do NOT, so they must not be mapped as
        // stale-ref failures.
        const chooserP = page.waitForEvent("filechooser", { timeout: opts.timeoutMs });
        // click() resolves the ref — keep refUsed=true so a stale ref → ref_expired.
        try {
          await loc.click({ timeout: opts.timeoutMs });
        } catch (error) {
          throw uploadError(error, mapError(error, true, params.ref), params.ref);
        }
        // The chooser never opening (a styled button that does nothing) or
        // chooser.setFiles timing out is NOT a stale ref — map with refUsed=false
        // so a timeout surfaces as act_timeout, not a misleading ref_expired that
        // would tell the model to re-snapshot a still-valid ref.
        try {
          const chooser = await chooserP;
          await chooser.setFiles(files, { timeout: opts.timeoutMs });
        } catch (error) {
          throw uploadError(error, mapError(error, false), params.ref);
        }
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

    case "dialog": {
      // Arm a one-shot override for the NEXT dialog, taking precedence over the
      // standing dialog_policy for that one event. Returns immediately — the
      // ergonomic flow is: arm `dialog`, THEN perform the act that triggers it
      // (a JS dialog blocks the page, so it can't be triggered in this same
      // call). The override is consumed by the next dialog or expires on the
      // session side (see BrowserSession.armDialog) so it can't leak.
      if (typeof params.accept !== "boolean") {
        throw new BrowserError("bad_request", "act:dialog requires `accept` (boolean).");
      }
      if (!opts.armDialog) {
        throw new BrowserError("bad_request", "act:dialog is not available in this context.");
      }
      opts.armDialog(params.accept, params.prompt_text);
      const note = params.accept
        ? params.prompt_text !== undefined
          ? "accept with text"
          : "accept"
        : "dismiss";
      return done(kind, `armed next dialog → ${note}`);
    }

    default:
      throw new BrowserError("bad_request", `Unknown act kind: ${String(kind)}`);
  }
}

/**
 * Validate a `ref`'s shape and build its `aria-ref` locator. Shared by `withRef`
 * (single-target acts), the multi-target acts (`drag` source + target), and the
 * tool-layer element screenshot, so a malformed ref produces a consistent
 * `bad_request` everywhere. A frame-namespaced ref (`fN:eN`) resolves against
 * `page.frames()[N]`; a missing/detached frame surfaces as `ref_expired` (take a
 * fresh snapshot). A bare ref resolves against the main document exactly as
 * before. Does NOT run the action — the caller owns error mapping for the
 * resolved locator (stale element-ref detection happens when it fails to
 * resolve).
 *
 * `frameUrls` (the most recent snapshot's per-index frame URLs) closes the frame
 * REORDER hole: in-place navigation is already caught by the detached aria-ref
 * node timing out, but reordering can land index N on a DIFFERENT live frame
 * that still holds a valid `eN`, which would otherwise silently act on the wrong
 * element. When `frameUrls` is supplied and records index N, we compare the live
 * `page.frames()[N].url()` to the snapshot-time URL and throw `ref_expired` on
 * mismatch BEFORE building the locator. When it's absent (no snapshot context,
 * e.g. bare unit tests) the check is skipped and only the missing-frame guard
 * applies. Bare `eN` refs are unaffected.
 */
export function requireRefLocator(
  page: Page,
  ref: string | undefined,
  kindLabel: string,
  frameUrls?: Map<number, string>,
): ReturnType<Page["locator"]> {
  if (!ref) throw new BrowserError("bad_request", `act:${kindLabel} requires a \`ref\` from the latest snapshot.`);
  const framed = ref.match(FRAME_REF_RE);
  if (framed) {
    const frameIndex = Number(framed[1]);
    const bareRef = framed[2]!;
    const frame = page.frames()[frameIndex];
    if (!frame) {
      // Frame indices are snapshot-scoped: a frame that navigated/detached since
      // the snapshot is gone from page.frames() → treat as expired (re-snapshot).
      throw new BrowserError(
        "ref_expired",
        `Frame ref ${ref} did not resolve (frame f${frameIndex} likely navigated or detached). Take a fresh \`snapshot\` and retry with a current ref.`,
      );
    }
    // Frame-reorder staleness: if the snapshot recorded a URL for this index and
    // the live frame there no longer carries it, index N now points at a
    // different frame — the ref is stale even though page.frames()[N] exists and
    // may hold its own valid `eN`. Catch it here, before acting on the wrong
    // element. A read of frame.url() that throws (detaching frame) is itself
    // treated as a mismatch → expired.
    const recordedUrl = frameUrls?.get(frameIndex);
    if (recordedUrl !== undefined) {
      let liveUrl: string | undefined;
      try {
        liveUrl = frame.url();
      } catch {
        liveUrl = undefined;
      }
      if (liveUrl !== recordedUrl) {
        throw new BrowserError(
          "ref_expired",
          `Frame ref ${ref} is stale (frame f${frameIndex} is now ${liveUrl ?? "<detached>"}, not ${recordedUrl} as at snapshot time — the frames were reordered or navigated). Take a fresh \`snapshot\` and retry with a current ref.`,
        );
      }
    }
    return frame.locator(`aria-ref=${bareRef}`);
  }
  if (!BARE_REF_RE.test(ref)) {
    throw new BrowserError("bad_request", `Invalid ref "${ref}" — expected a snapshot handle like "e12" or "f1:e3".`);
  }
  return page.locator(`aria-ref=${ref}`);
}

async function withRef(
  page: Page,
  params: ActParams,
  opts: ActOptions,
  fn: (loc: ReturnType<Page["locator"]>) => Promise<unknown>,
): Promise<void> {
  const locator = requireRefLocator(page, params.ref, params.kind, opts.frameUrls);
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

/**
 * Finalize an upload failure. `mapped` is the result of running the raw error
 * through `mapError` with the refUsed value appropriate to the failing call
 * (true for ref-resolving click/setInputFiles, false for the chooser arm /
 * chooser.setFiles). Preserve the actionable `ref_expired` / `act_timeout`
 * codes; collapse everything else to `upload_failed`.
 */
function uploadError(error: unknown, mapped: BrowserError, ref?: string): BrowserError {
  if (mapped.code === "ref_expired" || mapped.code === "act_timeout") return mapped;
  return new BrowserError(
    "upload_failed",
    `Upload to ${ref ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
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
