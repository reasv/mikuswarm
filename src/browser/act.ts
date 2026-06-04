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
  | "evaluate";

export interface ActParams {
  kind: ActKind;
  /** A [ref=eN] handle from the latest snapshot (required for element actions). */
  ref?: string;
  /** Text to type/fill, or the JS expression for `evaluate`. */
  text?: string;
  /** Key name for `press` (e.g. "Enter", "Control+A"). */
  key?: string;
  /** Option value(s) for `select`. */
  value?: string | string[];
  /** Wheel delta for `scroll` (pixels; positive = down). */
  delta_y?: number;
  /** Milliseconds for `wait`. */
  ms?: number;
}

export interface ActOptions {
  timeoutMs: number;
  evaluateEnabled: boolean;
}

const REF_RE = /^e\d+$/;
const MAX_WAIT_MS = 30_000;

export interface ActResult {
  ok: true;
  kind: ActKind;
  detail: string;
}

export async function act(page: Page, params: ActParams, opts: ActOptions): Promise<ActResult> {
  const { kind } = params;
  switch (kind) {
    case "click":
      await withRef(page, params, opts, (loc) => loc.click({ timeout: opts.timeoutMs }));
      return done(kind, `clicked ${params.ref}`);

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
      return done(kind, `typed into ${params.ref}`);
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

    default:
      throw new BrowserError("bad_request", `Unknown act kind: ${String(kind)}`);
  }
}

async function withRef(
  page: Page,
  params: ActParams,
  _opts: ActOptions,
  fn: (loc: ReturnType<Page["locator"]>) => Promise<unknown>,
): Promise<void> {
  const ref = params.ref;
  if (!ref) throw new BrowserError("bad_request", `act:${params.kind} requires a \`ref\` from the latest snapshot.`);
  if (!REF_RE.test(ref)) {
    throw new BrowserError("bad_request", `Invalid ref "${ref}" — expected a snapshot handle like "e12".`);
  }
  const locator = page.locator(`aria-ref=${ref}`);
  try {
    await fn(locator);
  } catch (error) {
    throw mapError(error, true, ref);
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
const REF_UNRESOLVED_RE = /not found|no node|cannot find|no element|resolve|unable to|did not match/i;

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
