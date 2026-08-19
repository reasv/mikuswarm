# Browser `console` action: capture path for stealth Chromium backends

**Status**: PROPOSED — target section once implemented: ARCHITECTURE.md §11b
(Browser control layer).

## 1. Problem

The browser tool's `console` action drains a per-page buffer that
`BrowserSession.trackPage` fills from Playwright's `page.on("console")` and
`page.on("pageerror")` events. Against the CloakBrowser-Manager backend
(`cloakhq/cloakbrowser-manager`, image `27098d4bf330`), that buffer is **always
empty** — the action can never report anything, so the one tool the agent has for
self-diagnosing a silently-failing page is inert.

`test/browser.docker.test.ts` "feature additions" fails at the console step
("console.log captured"). This was previously masked by the dialog-step failure
fixed in commit 99bf7ef; the dialog and pdf steps now pass.

## 2. Root cause (measured, not inferred)

Playwright synthesises both `console` and `pageerror` events exclusively from the
**CDP `Runtime` domain** — `Runtime.consoleAPICalled` and
`Runtime.exceptionThrown`. Those two events are precisely the ones a stealth
build suppresses, because a live `Runtime.enable` event stream is a classic
automation-detection vector.

Probing a real Manager container with raw `playwright-core` over its CDP proxy
(a page that runs `console.log`, `console.warn`, `console.debug`, a thrown
`setTimeout` error, and a `Promise.reject`) gives:

| CDP surface | Delivered? |
|---|---|
| `Runtime.consoleAPICalled` | **no** — 0 events |
| `Runtime.exceptionThrown` | **no** — 0 events |
| `Runtime.executionContextCreated` | yes (6) |
| `Runtime.addBinding` → `Runtime.bindingCalled` | accepted, but binding absent in page; no events |
| `Log.entryAdded` | **no** — 0 events |
| `Console.messageAdded` (legacy Console domain) | **yes** — full level + text |
| `Page.frameNavigated` | yes |
| `Page.addScriptToEvaluateOnNewDocument` / `page.addInitScript` | **yes**, and persists across navigations |

So the suppression is scoped to the `Runtime` (and `Log`) event stream. The
**deprecated `Console` domain still reports `console.*` calls**, and page-side
script injection is fully functional. Two working channels remain.

`Console.messageAdded` carries only `source: "console-api"` messages — it does
**not** carry uncaught exceptions or unhandled rejections. So `console.*` and
page errors need different treatment.

### 2.1 Control: vanilla Chromium

The same instrumentation against a stock Playwright Chromium over CDP:

| | `page.on(...)` (Runtime) | `Console.messageAdded` |
|---|---|---|
| `console.log` / `console.warn` | yes | **also yes** |
| uncaught error / unhandled rejection | yes (`pageerror`) | no |

Both transports deliver `console.*` on a standard backend. **Any design that
keeps both paths must de-duplicate**, or every message double-logs off-Cloak.

## 3. Options considered

- **(a) Alternative capture path.** Implemented below. Restores the feature on
  the deployment's actual backend and leaves standard backends untouched.
- **(b) Degrade with an honest "console capture unavailable" message.** Rejected:
  a working capture path demonstrably exists, so degrading throws away a
  diagnostic the agent has no substitute for.
- **(c) Relax the docker test.** Rejected as a primary fix — it would encode a
  backend limitation that is not in fact a limitation. The test is kept as-is and
  becomes the regression guard for (a).

## 4. Design

Two additions to `BrowserSession`, both backend-agnostic and default-on. Neither
is CloakBrowser-specific: they are extra transports that happen to be the only
live ones on a stealth build.

### 4.1 Transport 2 — legacy `Console` domain (covers `console.*`)

Per tracked page, open a CDP session, `Console.enable`, and feed
`Console.messageAdded` into the same per-page buffer. Verified to survive
navigation with no re-arming (the domain stays enabled for the page's CDP
session), so no per-navigation hook is needed.

### 4.2 Transport 3 — page-side error hook (covers `pageerror`)

`Console.messageAdded` never reports uncaught errors, so page errors are bridged
**onto the channel that does work**: an init script installs `error` and
`unhandledrejection` listeners that re-emit through `console.error` with a
sentinel prefix. The Node side decodes the sentinel back into a `pageerror`-level
entry and strips it, so the rendered output is unchanged.

Shipped as a raw **source string** (`CONSOLE_HOOK_SOURCE`), for exactly the
reason documented on `DIALOG_OVERRIDE_SOURCE`: under `tsx`, transferring a
function serialises the esbuild-compiled body and throws `ReferenceError:
__name is not defined` in the page
(spec/BROWSER-DIALOG-OVERRIDE-INJECTION-FIX.md §2). It is installed via
`addInitScript` (all future documents) **and** evaluated once for the current
document, and is idempotent via a non-enumerable sentinel so a double install is
a no-op.

The bridged text uses `event.error.message` / `reason.message` rather than the
`ErrorEvent`'s decorated `message`, so a bridged entry is **byte-identical** to
what native `pageerror` produces for the same throw. That is what lets §4.3
recognise the two as the same occurrence.

### 4.3 De-duplication (required by §2.1)

Entries carry their transport (`native` = Playwright events, `cdp` =
`Console.messageAdded`). Two rules:

1. **Sentinel lines are honoured only from the `cdp` transport.** If the `native`
   console transport is alive then `Runtime` events are not suppressed, so native
   `pageerror` already covers the error and the bridged copy is redundant. A
   sentinel line arriving via `page.on("console")` is dropped.
2. **Cross-transport one-shot matching.** An arrival is suppressed only if an
   *unmatched* arrival with the same `level|text` fingerprint, **from the other
   transport**, occurred within a short window; matching consumes it.

Matching only across transports is what keeps genuinely repeated identical logs
intact: a page logging `"tick"` ten times on a single live transport records ten
entries, because same-transport arrivals never match each other.

Resulting behaviour, one entry per real occurrence on both backends:

| Event | Vanilla Chromium | CloakBrowser |
|---|---|---|
| `console.log('x')` | native pushes; cdp copy matched → dropped | cdp pushes |
| uncaught error | native `pageerror` pushes; sentinel-via-native dropped (rule 1); sentinel-via-cdp matched → dropped | sentinel-via-cdp pushes |

### 4.4 Failure posture

Every part is best-effort and wrapped: a backend that rejects `Console.enable`
or init-script injection degrades to exactly today's behaviour (native events
only) rather than failing page tracking. Bounded state only — the unmatched-
arrival map is pruned by window and capped.

## 5. Test plan

- Unit: evaluate `CONSOLE_HOOK_SOURCE` byte-for-byte in `vm.runInNewContext`
  with a fake window and no helper shims (mirrors the `DIALOG_OVERRIDE_SOURCE`
  tests) — asserts listener registration, sentinel emission, message
  normalisation, and idempotence. Plus direct tests of the dedup rules.
- Docker: `test/browser.docker.test.ts` "feature additions" console step is left
  unchanged and becomes the regression guard.
