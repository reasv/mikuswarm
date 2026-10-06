import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetchTool, createWebSearchTool } from "../src/tools/web.js";
import { setEgressGuardEnabled } from "../src/tools/ssrf.js";

for (const kind of ["fetch", "search"] as const) {
  const args = kind === "fetch" ? { url: "https://example.org" } : { query: "test" };
  test(`${kind}: caller abort cancels stalled response body`, async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const tool = kind === "fetch" ? createWebFetchTool({ fetchImpl }) : createWebSearchTool({ fetchImpl });
    const controller = new AbortController();
    const pending = tool.execute("call", args, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("caller cancelled"));
    await assert.rejects(pending, /caller cancelled/);
    assert.equal(cancelled, true);
  });
  test(`${kind}: deadline bounds stalled headers and body`, async () => {
    for (const fetchImpl of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream())]) {
      const tool = kind === "fetch" ? createWebFetchTool({ fetchImpl, timeoutMs: 5 }) : createWebSearchTool({ fetchImpl, timeoutMs: 5 });
      await assert.rejects(tool.execute("call", args), /timed out after 5ms/);
    }
  });
  test(`${kind}: non-success HTTP body is cancelled`, async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 });
    const tool = kind === "fetch" ? createWebFetchTool({ fetchImpl }) : createWebSearchTool({ fetchImpl });
    await assert.rejects(tool.execute("call", args), /HTTP 500/);
    assert.equal(cancelled, true);
  });
}
test("search distinguishes bot checks and parser failures from explicit empty results", async () => {
  for (const html of ["<form class='challenge-form'>captcha</form>", "<html>unexpected markup</html>", ""]) {
    const tool = createWebSearchTool({ fetchImpl: async () => new Response(html) });
    await assert.rejects(tool.execute("call", { query: "test" }), /bot check|could not be parsed/);
  }
  const tool = createWebSearchTool({ fetchImpl: async () => new Response('<div class="no-results">No results found</div>') });
  const result = await tool.execute("call", { query: "test" });
  assert.deepEqual((result.details as { results: unknown[] }).results, []);
  assert.match((result.content[0] as { text: string }).text, /No search results found/);
});
test("search uses guarded transport with request cancellation", async (t) => {
  setEgressGuardEnabled(false);
  try {
    let seenSignal: AbortSignal | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal;
      return new Response('<div class="result web-result"><a class="result__a" href="https://example.org">Example</a></div>');
    });
    const result = await createWebSearchTool().execute("call", { query: "test" });
    assert.ok(seenSignal);
    assert.equal((result.details as { results: unknown[] }).results.length, 1);
  } finally { setEgressGuardEnabled(true); }
});
test("fetch rejects oversized content and cancels remaining stream", async () => {
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(createWebFetchTool({ fetchImpl }).execute("call", { url: "https://example.org" }), /size limit/);
  assert.equal(cancelled, true);
});
test("pre-aborted caller makes no transport request", async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const fetchImpl = async () => { calls++; return new Response("unused"); };
  await assert.rejects(createWebSearchTool({ fetchImpl }).execute("call", { query: "test" }, controller.signal));
  assert.equal(calls, 0);
});
test("a late transport response after timeout has its body cancelled", async () => {
  let resolve!: (response: Response) => void; let cancelled = false;
  const fetchImpl = () => new Promise<Response>((r) => { resolve = r; });
  await assert.rejects(createWebFetchTool({ fetchImpl, timeoutMs: 5 }).execute("call", { url: "https://example.org" }), /timed out/);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, true);
});
test("search permits CAPTCHA documentation in valid result titles and snippets", async () => {
  const html = '<div class="result web-result"><a class="result__a" href="https://example.org/captcha">CAPTCHA documentation</a><a class="result__snippet">Explain captcha and challenge-form integration.</a></div>';
  const result = await createWebSearchTool({ fetchImpl: async () => new Response(html) }).execute("call", { query: "captcha documentation" });
  const results = (result.details as { results: Array<{ title: string; snippet: string }> }).results;
  assert.equal(results.length, 1);
  assert.equal(results[0]!.title, "CAPTCHA documentation");
  assert.match(results[0]!.snippet, /captcha/);
});
test("search rejects structural DuckDuckGo challenge endpoints and modal markers", async () => {
  for (const html of ['<form action="//duckduckgo.com/anomaly.js?x=1"></form>', '<div id="anomaly-modal">Verify</div>']) {
    await assert.rejects(createWebSearchTool({ fetchImpl: async () => new Response(html) }).execute("call", { query: "test" }), /bot check/);
  }
});
