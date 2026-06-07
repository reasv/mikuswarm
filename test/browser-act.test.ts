import assert from "node:assert/strict";
import test from "node:test";

import { act, type ActParams } from "../src/browser/act.js";

// A structural fake Page/Locator that records calls. act() only depends on the
// Playwright surface it actually touches, so a hand-rolled fake exercises the
// dispatch logic without a real browser.
interface FakeOpts {
  url?: string;
  isFileInput?: boolean;
  clickError?: Error;
  waitForError?: Error;
  dragError?: Error;
  setFilesError?: Error;
  cdpSendError?: Error;
  /** Number of CHILD frames page.frames() exposes (index 0 is the main frame). */
  frameCount?: number;
}

function recordingPage(opts: FakeOpts = {}) {
  const calls: unknown[][] = [];
  const cdp = {
    async send(method: string, params: unknown) {
      calls.push(["cdp.send", method, params]);
      if (opts.cdpSendError) throw opts.cdpSendError;
    },
    async detach() {
      calls.push(["cdp.detach"]);
    },
  };
  const chooser = {
    async setFiles(files: unknown, o: unknown) {
      calls.push(["chooser.setFiles", files, o]);
      if (opts.setFilesError) throw opts.setFilesError;
    },
  };
  const makeLocator = (selector: string) => {
    const loc = {
      selector,
      first() {
        return loc;
      },
      async click(o: unknown) {
        calls.push(["click", selector, o]);
        if (opts.clickError) throw opts.clickError;
      },
      async dblclick(o: unknown) {
        calls.push(["dblclick", selector, o]);
      },
      async hover(o: unknown) {
        calls.push(["hover", selector, o]);
      },
      async fill(t: string, o: unknown) {
        calls.push(["fill", selector, t, o]);
      },
      async pressSequentially(t: string, o: unknown) {
        calls.push(["pressSequentially", selector, t, o]);
      },
      async waitFor(o: unknown) {
        calls.push(["waitFor", selector, o]);
        if (opts.waitForError) throw opts.waitForError;
      },
      async dragTo(target: { selector: string }, o: unknown) {
        calls.push(["dragTo", selector, target.selector, o]);
        if (opts.dragError) throw opts.dragError;
      },
      async setInputFiles(files: unknown, o: unknown) {
        calls.push(["setInputFiles", selector, files, o]);
        if (opts.setFilesError) throw opts.setFilesError;
      },
      async evaluate(_fn: unknown) {
        calls.push(["evaluate", selector]);
        return opts.isFileInput ?? false;
      },
    };
    return loc;
  };
  const page = {
    _url: opts.url ?? "https://example.com/page",
    url() {
      return this._url;
    },
    locator(sel: string) {
      return makeLocator(sel);
    },
    // frames()[0] is the main document; child frames tag their locator selectors
    // with `frameN:` so a namespaced ref's resolution target is observable.
    frames() {
      const main = { locator: (sel: string) => makeLocator(sel) };
      const children = [];
      for (let i = 1; i <= (opts.frameCount ?? 0); i++) {
        children.push({ locator: (sel: string) => makeLocator(`frame${i}:${sel}`) });
      }
      return [main, ...children];
    },
    getByText(t: string) {
      calls.push(["getByText", t]);
      return makeLocator(`text=${t}`);
    },
    async waitForTimeout(ms: number) {
      calls.push(["waitForTimeout", ms]);
    },
    async waitForURL(u: string, o: unknown) {
      calls.push(["waitForURL", u, o]);
    },
    async waitForLoadState(s: string, o: unknown) {
      calls.push(["waitForLoadState", s, o]);
    },
    async waitForEvent(name: string, o: unknown) {
      calls.push(["waitForEvent", name, o]);
      return chooser;
    },
    keyboard: {
      async press(k: string) {
        calls.push(["keyboard.press", k]);
      },
    },
    context() {
      return {
        async newCDPSession() {
          return cdp;
        },
      };
    },
    calls,
  };
  return page;
}

const OPTS = { timeoutMs: 15000, evaluateEnabled: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(page: ReturnType<typeof recordingPage>, params: ActParams) {
  return act(page as never, params, OPTS);
}

// ── frame-namespaced refs ──────────────────────────────────────────────────────

test("act on a bare ref still resolves against the main document", async () => {
  const page = recordingPage({ frameCount: 2 });
  await run(page, { kind: "click", ref: "e5" });
  const call = page.calls.find((c) => c[0] === "click") as [string, string, unknown];
  assert.equal(call[1], "aria-ref=e5", "bare ref hits the page-level locator");
});

test("act on a frame-namespaced ref (f1:e3) clicks inside that frame", async () => {
  const page = recordingPage({ frameCount: 2 });
  const r = await run(page, { kind: "click", ref: "f1:e3" });
  assert.equal(r.detail, "clicked f1:e3");
  const call = page.calls.find((c) => c[0] === "click") as [string, string, unknown];
  assert.equal(call[1], "frame1:aria-ref=e3", "ref resolved against frames()[1]");
});

test("act on a ref for a missing/detached frame surfaces as ref_expired", async () => {
  const page = recordingPage({ frameCount: 1 }); // only f1 exists
  await assert.rejects(
    () => run(page, { kind: "click", ref: "f2:e1" }),
    (e: unknown) => (e as { code?: string }).code === "ref_expired",
  );
});

// ── click modifiers ──────────────────────────────────────────────────────────

test("act:click double → dblclick, detail says double-clicked", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "click", ref: "e1", double: true });
  assert.equal(r.detail, "double-clicked e1");
  assert.ok(page.calls.some((c) => c[0] === "dblclick"));
  assert.ok(!page.calls.some((c) => c[0] === "click"));
});

test("act:click button/modifiers pass through to Playwright; right-click noted in detail", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "click", ref: "e2", button: "right", modifiers: ["Control", "Shift"] });
  assert.equal(r.detail, "clicked e2 (right)");
  const call = page.calls.find((c) => c[0] === "click") as [string, string, { button?: string; modifiers?: string[] }];
  assert.equal(call[2].button, "right");
  assert.deepEqual(call[2].modifiers, ["Control", "Shift"]);
});

test("act:click left button omits the button note", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "click", ref: "e3", button: "left" });
  assert.equal(r.detail, "clicked e3");
});

// ── type {submit} ────────────────────────────────────────────────────────────

test("act:type submit presses Enter after typing and notes it", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "type", ref: "e1", text: "hello", submit: true });
  assert.equal(r.detail, "typed into e1 and submitted");
  const seq = page.calls.map((c) => c[0]);
  const typeIdx = seq.indexOf("pressSequentially");
  const enterIdx = page.calls.findIndex((c) => c[0] === "keyboard.press" && c[1] === "Enter");
  assert.ok(typeIdx >= 0 && enterIdx > typeIdx, "Enter pressed after typing");
});

test("act:type without submit does not press Enter", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "type", ref: "e1", text: "hello" });
  assert.equal(r.detail, "typed into e1");
  assert.ok(!page.calls.some((c) => c[0] === "keyboard.press"));
});

// ── rich wait ────────────────────────────────────────────────────────────────

test("act:wait with no condition falls back to the ms sleep", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "wait", ms: 250 });
  assert.equal(r.detail, "waited 250ms");
  assert.ok(page.calls.some((c) => c[0] === "waitForTimeout" && c[1] === 250));
});

test("act:wait defaults to 1000ms when neither ms nor a condition is set", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "wait" });
  assert.equal(r.detail, "waited 1000ms");
});

test("act:wait with ≥2 condition fields is a bad_request", async () => {
  const page = recordingPage();
  await assert.rejects(
    () => run(page, { kind: "wait", wait_text: "Done", wait_selector: ".x" }),
    (e: unknown) => (e as { code?: string }).code === "bad_request",
  );
});

test("act:wait wait_selector waits for the selector visible (uses act timeout)", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "wait", wait_selector: ".ready" });
  assert.match(r.detail, /waited for selector \.ready/);
  const call = page.calls.find((c) => c[0] === "waitFor") as [string, string, { state?: string; timeout?: number }];
  assert.equal(call[1], ".ready");
  assert.equal(call[2].state, "visible");
  assert.equal(call[2].timeout, OPTS.timeoutMs);
});

test("act:wait wait_text_gone waits for hidden state", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "wait", wait_text_gone: "Loading" });
  assert.match(r.detail, /waited for text gone/);
  const call = page.calls.find((c) => c[0] === "waitFor") as [string, string, { state?: string }];
  assert.equal(call[2].state, "hidden");
});

test("act:wait wait_url uses waitForURL with the glob", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "wait", wait_url: "**/dashboard" });
  assert.match(r.detail, /waited for url \*\*\/dashboard/);
  assert.ok(page.calls.some((c) => c[0] === "waitForURL" && c[1] === "**/dashboard"));
});

test("act:wait wait_load_state uses waitForLoadState", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "wait", wait_load_state: "networkidle" });
  assert.match(r.detail, /waited for load state networkidle/);
  assert.ok(page.calls.some((c) => c[0] === "waitForLoadState" && c[1] === "networkidle"));
});

test("act:wait condition timeout surfaces as act_timeout", async () => {
  const timeout = Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
  const page = recordingPage({ waitForError: timeout });
  await assert.rejects(
    () => run(page, { kind: "wait", wait_selector: ".never" }),
    (e: unknown) => (e as { code?: string }).code === "act_timeout",
  );
});

// ── drag ─────────────────────────────────────────────────────────────────────

test("act:drag drags source ref to target to_ref", async () => {
  const page = recordingPage();
  const r = await run(page, { kind: "drag", ref: "e1", to_ref: "e2" });
  assert.equal(r.detail, "dragged e1 → e2");
  const call = page.calls.find((c) => c[0] === "dragTo") as [string, string, string];
  assert.equal(call[1], "aria-ref=e1");
  assert.equal(call[2], "aria-ref=e2");
});

test("act:drag with a malformed to_ref is a bad_request", async () => {
  const page = recordingPage();
  await assert.rejects(
    () => run(page, { kind: "drag", ref: "e1", to_ref: "not-a-ref" }),
    (e: unknown) => (e as { code?: string }).code === "bad_request",
  );
});

test("act:drag with a stale ref surfaces as ref_expired", async () => {
  const stale = new Error("No node found for selector: aria-ref=e2");
  const page = recordingPage({ dragError: stale });
  await assert.rejects(
    () => run(page, { kind: "drag", ref: "e1", to_ref: "e2" }),
    (e: unknown) => (e as { code?: string }).code === "ref_expired",
  );
});

// ── upload ───────────────────────────────────────────────────────────────────

const FILE: ActParams["files"] = [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hi") }];

test("act:upload on a file input sets the files directly", async () => {
  const page = recordingPage({ isFileInput: true });
  const r = await run(page, { kind: "upload", ref: "e1", files: FILE });
  assert.equal(r.detail, "uploaded 1 file(s) to e1");
  assert.ok(page.calls.some((c) => c[0] === "setInputFiles"));
  assert.ok(!page.calls.some((c) => c[0] === "waitForEvent"));
});

test("act:upload on a button arms the file chooser, clicks, and sets files", async () => {
  const page = recordingPage({ isFileInput: false });
  const r = await run(page, { kind: "upload", ref: "e1", files: FILE });
  assert.equal(r.detail, "uploaded 1 file(s) to e1");
  assert.ok(page.calls.some((c) => c[0] === "waitForEvent" && c[1] === "filechooser"));
  assert.ok(page.calls.some((c) => c[0] === "click"));
  assert.ok(page.calls.some((c) => c[0] === "chooser.setFiles"));
});

test("act:upload with no files is a bad_request", async () => {
  const page = recordingPage({ isFileInput: true });
  await assert.rejects(
    () => run(page, { kind: "upload", ref: "e1", files: [] }),
    (e: unknown) => (e as { code?: string }).code === "bad_request",
  );
});

test("act:upload non-timeout set failure surfaces as upload_failed", async () => {
  const boom = new Error("could not set files");
  const page = recordingPage({ isFileInput: true, setFilesError: boom });
  await assert.rejects(
    () => run(page, { kind: "upload", ref: "e1", files: FILE }),
    (e: unknown) => (e as { code?: string }).code === "upload_failed",
  );
});

// ── clear_site_data ──────────────────────────────────────────────────────────

test("act:clear_site_data clears the current origin via CDP", async () => {
  const page = recordingPage({ url: "https://site.example/path?q=1" });
  const r = await run(page, { kind: "clear_site_data" });
  assert.equal(r.detail, "cleared site data for https://site.example");
  const send = page.calls.find((c) => c[0] === "cdp.send") as [string, string, { origin: string; storageTypes: string }];
  assert.equal(send[1], "Storage.clearDataForOrigin");
  assert.equal(send[2].origin, "https://site.example");
  assert.equal(send[2].storageTypes, "all");
  assert.ok(page.calls.some((c) => c[0] === "cdp.detach"), "CDP session detached");
});

test("act:clear_site_data on a non-http origin (about:blank) is a bad_request", async () => {
  const page = recordingPage({ url: "about:blank" });
  await assert.rejects(
    () => run(page, { kind: "clear_site_data" }),
    (e: unknown) => (e as { code?: string }).code === "bad_request",
  );
});

test("act:clear_site_data CDP failure surfaces as clear_failed and still detaches", async () => {
  const page = recordingPage({ url: "https://site.example", cdpSendError: new Error("CDP boom") });
  await assert.rejects(
    () => run(page, { kind: "clear_site_data" }),
    (e: unknown) => (e as { code?: string }).code === "clear_failed",
  );
  assert.ok(page.calls.some((c) => c[0] === "cdp.detach"), "detaches even on failure");
});
