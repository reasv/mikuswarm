# Spec: Browser dialog override injection fix — ship the page script as string source

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §11b (act:dialog dual override mechanism); retained for review.

**Author**: design session 2026-08-09.

**Scope**: `src/browser/session.ts` (`injectPageDialogOverride`, `dialogOverrideScript`),
`test/browser-session.test.ts` (vm harness), no schema/config changes. Target
ARCHITECTURE.md home once implemented: §11b (dialog handling).

---

## 1. Background — why the JS-level override exists at all

The CloakBrowser-Manager launches each profile through cloakbrowser's Playwright
wrapper (`launch_persistent_context_async`) and holds that Playwright context for the
profile's lifetime. That resident client registers **no `dialog` listener**, and
Playwright's default in that case is to **auto-dismiss every JS dialog**. Verified
against the published Manager image (built 2026-05-26, `sha256:27098d4b…` — `:latest`
and `:v0.0.10` are the same image ID):

- Through the Manager's CDP proxy, an external client's `dialog.accept()` always fails
  with `Protocol error (Page.handleJavaScriptDialog): No dialog is showing` — the
  resident client wins the race every time. Dialogs don't even block page JS
  (`alert()` returns instantly).
- The same CloakBrowser Chromium binary launched directly (no Manager Playwright
  layer, one CDP client) handles dialogs normally: they block, `accept()` succeeds,
  `confirm()` returns `true`. The browser is innocent; the Manager's resident client
  is the dismisser.

So the CDP-path `dialogOverrides` mechanism can never answer a dialog against current
Manager versions, and commit `22f0b98` added the right workaround: when `act:dialog`
arms an override, also inject a one-shot JS-level replacement of
`window.confirm`/`prompt`/`alert` into the page, so the armed answer is returned
in-page and no native dialog ever opens.

## 2. Problem — the shipped injection never works, and fails dirty

The workaround as shipped is broken at runtime. `test/browser.docker.test.ts`
("feature additions") still fails at the dialog step, and a debug run against a fresh
Manager container shows why:

```
dialog_inject_override_failed
  error: page.evaluate: ReferenceError: __name is not defined
         at dialogOverrideScript (eval at evaluate ...)
```

Three defects, one root cause:

### 2.1 Compiled-function transfer breaks in the page (the root cause)

`injectPageDialogOverride` calls `page.evaluate(dialogOverrideScript, spec)`.
Playwright transfers the function via `Function.prototype.toString()` — but what it
serializes is the **tsx/esbuild-compiled** body, and esbuild's `keepNames` transform
wraps inner function definitions in `__name(fn, "name")` helper calls. The `__name`
helper is defined once per compiled module, not inside the function, so the
re-evaluated body throws `ReferenceError: __name is not defined` in the page. The
injection has therefore never worked when running under tsx (i.e. always — the
project runs exclusively via tsx).

### 2.2 Partial install poisons the page (re-arm lockout)

The script sets the `__miku_dlg_wrapped__` sentinel to `true` **before** defining the
wrappers. The `__name` ReferenceError fires between those points, so every armed page
is left with: slot armed, sentinel `true`, wrappers absent, natives untouched. Any
subsequent `act:dialog` on that page early-returns at the `if (w.__miku_dlg_wrapped__)
return;` guard — the arm is silently dead until the next navigation wipes the globals.
Observed in-page after one failed arm: `__miku_dlg_wrapped__ === true`,
`window.confirm.toString()` still native, `__ok === false` after the click.

### 2.3 The vm unit tests mask exactly this bug

The vm harness in `test/browser-session.test.ts` runs
`dialogOverrideScript.toString()` in `vm.runInNewContext` and **supplies a no-op
`__name` shim** ("so we supply a no-op shim that just returns the function"). The
harness author saw the `__name` artifact and patched the *test sandbox* instead of the
*transport*, so all 6 unit tests pass against a script that can never execute in a
real page. Only the docker integration test catches it.

### 2.4 (Adjacent, same fix) The JS path silently dropped expiry parity

The CDP-path override carries `expiresAt = now + act_timeout_ms` ("expires … so it
can't leak into a later, unrelated dialog" — `armDialog` JSDoc). The injected slot has
no expiry: once armed, it answers *whenever* the next `confirm`/`prompt`/`alert` call
happens — minutes later, on an unrelated dialog. Restore the documented one-shot
window while we're rewriting the script.

## 3. Fix — evaluate a raw source string, not a compiled function

### 3.1 Transport

Replace the exported `dialogOverrideScript` **function** with an exported
`DIALOG_OVERRIDE_SOURCE` **string** (a template literal holding a plain-JS IIFE-style
arrow, written directly in browser JS — no TypeScript syntax). Injection becomes:

```ts
await page.evaluate(`(${DIALOG_OVERRIDE_SOURCE})(${JSON.stringify(spec)})`);
```

A string expression is passed to the browser verbatim — no `toString()` of compiled
output, so it is immune to `keepNames` and to any *future* compiler/minifier
transform. `spec` is embedded via `JSON.stringify` (it is
`{ accept: boolean, promptText: string | null, expiresAt: number }`, all
JSON-representable; `prompt_text` is agent-supplied text with no injection surface
beyond what `fill`/`type` already accept).

Verified end-to-end against a fresh Manager container (raw playwright-core, string
transport, same wrapper logic): armed confirm → `true`, armed prompt → `"Miku"`,
armed dismiss → `false`, natives restored after each consume.

### 3.2 Script-body changes (behavior otherwise preserved)

Keep the shipped semantics: one-shot slot (`__miku_dlg_ov__`), re-arm replaces the
slot value, restore-all-natives on first consumption by any wrapper, non-enumerable
globals, wrapper `.toString()`/`.name`/`.length` masked to native-looking. Two
changes:

1. **Sentinel last.** Set `__miku_dlg_wrapped__ = true` only *after* the three
   wrappers are assigned, as the final statement. Any mid-script throw then leaves
   natives untouched and the page re-armable (fixes §2.2 by construction).
2. **Expiry check in `take()`.** The consume helper reads the slot; if
   `Date.now() > ov.expiresAt`, it clears the slot, restores natives, and returns
   null so the call falls through to the native function (same outcome an expired
   CDP-path slot produces: default policy). `expiresAt` is computed by
   `injectPageDialogOverride` as `Date.now() + act_timeout_ms` — agent-clock and
   page-clock are compared only through this embedded absolute value; a skewed page
   clock degrades to "expires early/late", never to a wrong answer.

### 3.3 `injectPageDialogOverride` contract unchanged

Success still deletes the CDP-path WeakMap slot (so a stale CDP override can't fire
on the next unrelated dialog on Managers where the CDP path *does* work); failure
still logs `dialog_inject_override_failed` at warn and leaves the CDP path armed as
the fallback for such Managers. No config knob: the injection only acts while armed
and returns exactly the armed answer, so it is correct on both broken and healthy
Managers.

## 4. Tests

- **Rewrite the vm harness to evaluate `DIALOG_OVERRIDE_SOURCE` directly** —
  `vm.runInNewContext("(" + DIALOG_OVERRIDE_SOURCE + ")(spec)", ctx)` — and **delete
  the `__name` shim**. The harness then executes byte-for-byte what the page
  executes; a reintroduced compile-artifact dependency fails the unit suite instead
  of only the docker suite. Keep all six existing cases (consume-restores,
  unarmed-delegates, re-arm-reinstalls, prompt accept/dismiss, non-enumerable
  globals, native toString).
- **New unit cases**: (a) expired slot → wrapper delegates to native, restores, and a
  re-arm works; (b) sentinel ordering — evaluate a copy of the source truncated
  before the final sentinel assignment, assert the sandbox window is left re-armable
  (regression for §2.2); simpler acceptable variant: assert sentinel is the last
  assignment by asserting `__miku_dlg_wrapped__` is unset if wrapper assignment threw
  via a poisoned `window.confirm` setter.
- **Integration**: the dialog step of `test/browser.docker.test.ts` (armed confirm →
  `__ok === true`, armed prompt → `"Miku"`) is the end-to-end acceptance and is
  expected to go green with no test changes.

## 5. Alternatives considered

- **Define a local `__name` inside the function** (`const __name = (f) => f`): keeps
  the compiled-function transport and silences today's artifact, but is coupled to
  one bundler's helper name and silently breaks on the next transform esbuild or a
  different runner introduces. Rejected.
- **`context.addInitScript`**: wrong lifetime — it re-applies on every future
  navigation for the context's life; the override is a one-shot with an
  `act_timeout_ms` window. Rejected.
- **Upstream Manager fix** (resident client registers a pass-through dialog handler):
  correct long-term, out of this repo's control, and the string-source shim remains
  correct after it lands. File upstream independently; not a substitute.

## 6. Non-goals / known limits (unchanged from the shipped design)

- Frames: the override installs on the page's main world/main frame only; a
  `confirm()` inside a cross-origin iframe is not intercepted (arm-then-click flows
  target main-frame dialogs; revisit only if a real page needs it).
- A page that captured `window.confirm` into a local before the arm bypasses the
  wrapper; detectability via `Function.prototype.toString.call(...)` during the armed
  window remains a documented tradeoff.
- `alert`/`beforeunload` behavior under the Manager's auto-dismiss (non-blocking
  alerts, auto-answered beforeunload) is unaffected outside an armed window.
