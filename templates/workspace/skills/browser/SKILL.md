---
name: browser
description: Drive a real stealth web browser (one persistent identity — shared cookies/logins) via the `browser` tool to read and interact with JS-heavy, login-gated, or bot-checked sites. Use when web_fetch is not enough — for clicking, typing, forms, multi-step flows, or pages that need a real browser to render.
---

# Browser Workflow

**Purpose:** Operate a single persistent, stealth Chromium identity to read and interact with the live web. Everything is driven through one tool, `browser`, whose behaviour is selected by the `action` field.

## When to use this vs `web_fetch`

- **`web_fetch`** — first choice for *just reading* a page's text or markdown. Faster, cheaper, no session.
- **`browser`** — use when you actually need a browser: interactive or JS-heavy pages, login/cookie-gated content, bot-checked sites, multi-step flows (search → click → read), forms, file uploads, or anything that only renders after scripts run.

If a plain read works, prefer `web_fetch`. Reach for `browser` when it doesn't.

## The core loop

The browser is driven blind through an **accessibility snapshot**, not pixels. The loop is almost always:

1. **`navigate`** (or `open`) to a URL — this *returns a fresh snapshot*.
2. **Read the snapshot.** Every interactive element is tagged `[ref=eN]` (e.g. `[ref=e12]`).
3. **`act`** on a ref (click, type, …) — this *also returns a fresh snapshot* of the resulting page.
4. Repeat from the new snapshot.

You rarely need a standalone `snapshot` call — `navigate`, `open`, and most `act` kinds already return one.

### Refs go stale — this is the #1 thing to get right

A `[ref=eN]` is only valid for the snapshot it came from. **After any navigation or DOM change, old refs are dead.** If an action fails with `browser:ref_expired`, do not retry the same ref — take a fresh `snapshot` (or use the snapshot the last action returned) and pick the current ref for the element you want. Frame-namespaced refs (`f1:e3`, see **Frames / iframes**) go stale with their frame too — if a frame navigates, detaches, or the page's frames reorder between snapshot and action, its refs return `ref_expired`.

### Frames / iframes

Snapshots include the content of embedded `<iframe>`s — third-party login/OAuth widgets, captchas, embedded checkout/booking forms, comment systems. Each frame's content appears under a boundary line:

```
[frame f1: https://challenges.example/turnstile]
  - button "Verify you are human" [ref=f1:e3]
```

Refs inside a frame look like `f1:e3` (the `f1:` names the frame). **Pass them to `act`/`screenshot` exactly as given** — the ref itself carries the frame, so there's no extra parameter. Bare refs (`e12`) are the main document as always. If the element you need isn't in the snapshot, it may be in a frame that wasn't shown (frame budget) or one marked `[frame fN: <inaccessible>]` (detached/unreadable) — re-snapshot. If the main page alone fills the snapshot budget, frames are dropped and you'll see a `[N frames omitted — raise snapshot_max_chars …]` note: the interactive content is in a frame you can't see yet, so narrow the page or ask the operator to raise the budget.

## Quick Reference

Navigate (returns a snapshot):

```json
{ "action": "navigate", "url": "https://example.com" }
```

Re-read the current page:

```json
{ "action": "snapshot" }
```

Click a ref from the latest snapshot:

```json
{ "action": "act", "kind": "click", "ref": "e12" }
```

Type into a field and submit:

```json
{ "action": "act", "kind": "type", "ref": "e8", "text": "hello world", "submit": true }
```

Take a screenshot to *look* at the page:

```json
{ "action": "screenshot", "full_page": false }
```

## Actions

### navigate `{ url }`
Go to an `http`/`https` URL (other schemes are rejected). Returns the page's AI snapshot. Operates on the active tab.

### snapshot
Return the current page's accessibility tree with interactive elements tagged `[ref=eN]`. Snapshots are truncated to bound context cost — if the result says it was truncated and the element you need isn't shown, scroll toward it (`act:scroll`) and snapshot again.

### act `{ kind, ... }`
Interact with the page. Pick a `kind`:

- **click** — `ref` (required); optional `button` (`left`|`right`|`middle`, default `left`), `double` (boolean, double-click), `modifiers` (array of `Alt`|`Control`|`Meta`|`Shift` held during the click).
- **type** — `ref` + `text`. Types character-by-character. Optional `submit: true` presses Enter after typing (use for search boxes / login fields).
- **fill** — `ref` + `text`. Clears the field and sets the value in one shot (faster than `type` for long values; no per-char events).
- **select** — `ref` + `value` (a string, or an array of strings for multi-select `<select>`).
- **press** — `key` (e.g. `"Enter"`, `"Escape"`, `"Control+A"`); optional `ref` to target an element, otherwise the key is pressed at page level.
- **hover** — `ref`. Reveals hover menus / tooltips, then snapshot to see what appeared.
- **scroll** — optional `ref` (scrolls that element into view) or `delta_y` (pixels to scroll the page, default 600). Use to reach content below a truncated snapshot.
- **wait** — give **exactly one** condition: `wait_text` (text appears), `wait_text_gone` (text disappears), `wait_selector` (CSS selector visible), `wait_url` (URL glob matches), `wait_load_state` (`load`|`domcontentloaded`|`networkidle`), or `ms` (plain sleep, fallback when no condition is set). Prefer a real condition over a fixed `ms` sleep.
- **back** — go back in history.
- **drag** — `ref` (source) + `to_ref` (drop target). For sliders, reordering, drag-and-drop UIs.
- **upload** — `ref` (an `<input type=file>` *or* a button that opens the file chooser) + `paths` (workspace-relative files). See **Uploads** below.
- **evaluate** — run JavaScript in `text` on the page. **Gated** — only works when the deployment enables it; otherwise returns `browser:evaluate_disabled`. Don't rely on it by default.
- **clear_site_data** — wipe cookies + all web storage for the **current page's origin**. See **Shared identity** below.
- **dialog** — `accept` (true/false), optional `prompt_text`. Override how the **next** JS dialog (`alert`/`confirm`/`prompt`) is handled. See **Dialogs** below.

Examples:

```json
{ "action": "act", "kind": "select", "ref": "e22", "value": ["us", "ca"] }
```

```json
{ "action": "act", "kind": "wait", "wait_text": "Results" }
```

```json
{ "action": "act", "kind": "scroll", "delta_y": 1200 }
```

### screenshot `{ full_page?, ref?, format? }`
Return an image to **look at** when the accessibility tree isn't enough (visual layout, charts, captchas, rendering bugs). With `ref`, capture just that element (`full_page` is ignored). `format` is `png` (default) or `jpeg`. Large captures are auto-downscaled to fit the image budget. Use the snapshot for *driving*; use screenshots for *seeing*.

### pdf
Save the current page to the workspace as a PDF and return its path:

```json
{ "action": "pdf" }
```

**You cannot read the PDF back** — there's no PDF ingestion. Use this only to *save a page and send it to the user*: export the page, then pass the returned path to the message tool (same download→send pattern as saved images). Good for "save this article/receipt/report as a PDF."

### console
Return the page's buffered `console` + uncaught-error messages since your last read:

```json
{ "action": "console" }
```

Use it to **diagnose** why a page misbehaves — a click that did nothing, a form that won't submit — when the snapshot doesn't explain it (a blocked request or a JS error may show up here). Reading drains the buffer. Output is size-bounded — very long individual messages and the overall result are truncated (you'll see a `… [truncated]` marker), so a chatty page can't flood the result. Prefer re-snapshotting and trying a different element first; reach for `console` when you're stuck.

### open `{ url? }` / close `{ index }` / tabs `{ index? }`
- **open** — open a new tab, optionally navigating it; returns its snapshot and makes it active.
- **tabs** — list this session's tabs (index, title, URL, which is active). Pass `index` to switch the active tab (returns that tab's snapshot).
- **close** — close the tab at `index`.

```json
{ "action": "tabs" }
```

```json
{ "action": "tabs", "index": 1 }
```

## Shared identity (important)

There is **one persistent browser identity** shared across everything: cookies, logins, and fingerprint persist between sessions and are *not* per-conversation. Consequences:

- If a site is already logged in, you're logged in — reuse it; don't re-authenticate needlessly.
- Don't log into a personal account on the user's behalf without being asked.
- **`clear_site_data`** discards cookies + web storage for the **current origin only** (a clean slate on this one site). Cookies are scoped by security origin, so parent-domain cookies set elsewhere may survive. Use it when a site's state is broken or you deliberately want a fresh, logged-out start — then reload the page.

## Uploads

`act:upload` reads files from the **workspace** and sends their bytes to the page.

```json
{ "action": "act", "kind": "upload", "ref": "e30", "paths": ["downloads/photo.png"] }
```

- `paths` are **workspace-relative** — no absolute paths, no `../` escaping the workspace.
- `ref` must be a file input or a button that opens the OS file chooser.
- Limits: at most 10 files, 25 MiB total.
- After uploading, snapshot — forms often reveal the chosen filename or enable a submit button.

## Downloads

Files a page downloads are saved into the workspace automatically; the tool result lists their paths. Use those paths to send the file or reuse it later.

## Dialogs

By default the browser auto-handles JS dialogs (`alert`/`confirm`/`prompt`) — alerts are accepted, confirms/prompts follow the deployment's policy (usually dismiss). Use `act:dialog` to override the **next** one:

```json
{ "action": "act", "kind": "dialog", "accept": true, "prompt_text": "my answer" }
```

- `accept` (required) — accept (`true`) or dismiss (`false`) the next dialog.
- `prompt_text` (optional) — the text to answer a `window.prompt()` with when accepting.
- **Arm it BEFORE the click/act that triggers the dialog.** A JS dialog freezes the page, so the order is: `act:dialog {…}` → then the `act:click` (or whatever) that pops the dialog. `act:dialog` returns immediately after arming (it does *not* wait for a dialog); the override is one-shot — it applies to exactly the next dialog, then the default behavior resumes. If no dialog fires, the armed override simply expires with no error.
- **The override is bound to the tab that was active when you armed it.** Don't switch tabs between arming and triggering — arm immediately before the act on the *same* tab, or the dialog on the other tab falls back to the default policy.

Use it for "Are you sure?" confirmations on the critical path, prompts that need a specific answer, or to dismiss an unexpected "Leave site?" dialog.

## Errors and recovery

Failures come back as `browser:<code> — <message>`. Common ones and what to do:

- **`ref_expired`** — the ref is stale. Take a fresh `snapshot` and use a current ref. (Most common — don't retry the dead ref.)
- **`act_timeout`** — the action/wait exceeded its budget. The element may not be there yet; `act:wait` for a real condition, or snapshot to re-check state.
- **`nav_timeout`** — navigation took too long. Retry, or try `wait_load_state: "domcontentloaded"` instead of waiting for full load.
- **`bad_url`** — non-`http(s)` URL. Only web URLs are allowed.
- **`evaluate_disabled`** — `act:evaluate` is off in this deployment. Achieve the goal with click/type/etc. instead.
- **`evaluate_failed`** — your JS threw on the page. Fix the expression.
- **`pdf_failed`** — the `pdf` export couldn't be produced or written. Fall back to a full-page `screenshot` if you just need to save what the page looks like.
- **`backend_unavailable`** — the browser backend is down. The browser is unavailable right now; fall back to `web_fetch` if you only need to read, and tell the user the browser isn't reachable.
- **`bad_request`** — malformed action/params (e.g. missing `url`, bad upload path, `wait` with no/too-many conditions). Re-read the action's required fields.

## Strategy notes

- **Snapshot to drive, screenshot to see.** The accessibility tree is how you find refs and read content; only screenshot when you genuinely need the visual.
- **Let actions feed you snapshots.** `navigate`/`open`/most `act` kinds already return a fresh snapshot — read it instead of calling `snapshot` again.
- **Prefer conditions over sleeps.** `act:wait` with `wait_text`/`wait_selector`/`wait_url` is more reliable than a fixed `ms` sleep.
- **Truncated snapshot?** Scroll toward the target and snapshot again rather than guessing refs.
- **One thing at a time.** Click/type, read the returned snapshot, then decide the next step — don't fire a chain of acts against refs from an old snapshot.
