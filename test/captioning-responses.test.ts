import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaptionContentError, describeMedia, parseResponsesUsage, type DescribeMediaOptions } from "../src/captioning/describe.js";
import { InferenceClient } from "../src/captioning/inference-client.js";
import { LlmScheduler } from "../src/agent/scheduler.js";
import type { ModelChainEntry } from "../src/agent/model-fallback.js";

type Request = { url?: string; authorization?: string; body: Record<string, any> };
async function withServer(
  handler: (request: Request, response: http.ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    handler({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) }, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
function options(endpoint: string): DescribeMediaOptions {
  return {
    modality: "image", data: Buffer.from("pixels"), mimeType: "image/png", prompt: "Describe the image.",
    model: { id: "gpt-6-astra", endpoint, api_key: "test-key", api: "openai-responses", reasoning_effort: "low" },
    maxChars: 100, maxTokens: 1024,
  };
}

test("Responses caption sends image input and keeps only assistant output text", async () => {
  let captured: Request | undefined;
  await withServer((request, res) => {
    captured = request;
    res.end(JSON.stringify({
      status: "completed", model: "global.openai.gpt-6-astra",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "private reasoning" }] },
        { type: "custom_tool_call", input: "not a caption" },
        { type: "message", role: "user", content: [{ type: "output_text", text: "not assistant output" }] },
        message(" A red "), message("square. "),
      ],
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 40 }, output_tokens: 25,
        output_tokens_details: { reasoning_tokens: 15 } },
    }));
  }, async (url) => {
    const result = await describeMedia(options(url + "/"));
    assert.deepEqual(result, { text: "A red square.", model: "global.openai.gpt-6-astra",
      usage: { input: 80, output: 25, cacheRead: 40, cacheWrite: 0 } });
    assert.equal(captured?.url, "/responses");
    assert.equal(captured?.authorization, "Bearer test-key");
    assert.deepEqual(captured?.body, {
      model: "gpt-6-astra", store: false, max_output_tokens: 1024, reasoning: { effort: "low" },
      input: [{ role: "user", content: [
        { type: "input_text", text: "Describe the image. Respond in at most 100 characters." },
        { type: "input_image", image_url: "data:image/png;base64,cGl4ZWxz", detail: "auto" },
      ] }],
    });
  });
});

test("Responses caption preserves unknown usage and omits unconfigured reasoning", async () => {
  await withServer((request, res) => {
    assert.equal(request.body.reasoning, undefined);
    res.end(JSON.stringify({ output: [message("A square.")] }));
  }, async (url) => {
    const input = options(url);
    delete input.model.reasoning_effort;
    assert.deepEqual(await describeMedia(input), { text: "A square.", model: "gpt-6-astra", usage: null });
  });
  assert.equal(parseResponsesUsage(null), null);
  assert.deepEqual(parseResponsesUsage({ input_tokens: 2, input_tokens_details: { cached_tokens: 4 } }),
    { input: 0, output: 0, cacheRead: 4, cacheWrite: 0 });
});

for (const [name, result, expected] of [
  ["incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message("partial")] }, /incomplete.*max_output_tokens/],
  ["refused", { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot caption this." }] }] }, /refused/],
  ["reasoning only", { output: [{ type: "reasoning", summary: [{ text: "not output" }] }] }, /empty response/],
  ["blank", { output: [message(" \n ")] }, /empty response/],
] as const) {
  test(`Responses ${name} caption is a content failure`, async () => {
    await withServer((_request, res) => res.end(JSON.stringify(result)), async (url) => {
      await assert.rejects(describeMedia(options(url)), (error: unknown) => {
        assert.ok(error instanceof CaptionContentError);
        assert.match(error.message, expected);
        return true;
      });
    });
  });
}

test("Responses HTTP failure retains status for scheduling and fallback", async () => {
  await withServer((_request, res) => { res.statusCode = 429; res.end("rate limited"); }, async (url) => {
    await assert.rejects(describeMedia(options(url)), /Caption API returned status 429/);
  });
});

test("Responses failed status remains an environmental error", async () => {
  await withServer((_request, res) => res.end(JSON.stringify({ status: "failed", error: { message: "upstream unavailable" } })), async (url) => {
    await assert.rejects(describeMedia(options(url)), (error: unknown) => {
      assert.ok(error instanceof Error && !(error instanceof CaptionContentError));
      assert.match(error.message, /Caption API failed: upstream unavailable/);
      return true;
    });
  });
});

for (const modality of ["video", "audio"] as const) {
  test(`Responses rejects direct ${modality} before any network request`, async () => {
    let calls = 0;
    await withServer((_request, res) => { calls++; res.end("{}"); }, async (url) => {
      await assert.rejects(describeMedia({ ...options(url), modality }), (error: unknown) => {
        assert.ok(error instanceof CaptionContentError);
        assert.ok(error.message.includes(`[captioning.${modality}].model`));
        return true;
      });
      assert.equal(calls, 0);
    });
  });
}

test("Responses caption timeout and shutdown abort the fetch", async () => {
  await withServer(() => {}, async (url) => {
    await assert.rejects(describeMedia({ ...options(url), timeoutMs: 30 }), { name: "AbortError" });
  });
  const controller = new AbortController();
  await withServer(() => controller.abort(), async (url) => {
    await assert.rejects(describeMedia({ ...options(url), signal: controller.signal }), { name: "AbortError" });
  });
});

async function withImage(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-responses-caption-"));
  try {
    const file = path.join(dir, "image.png");
    await writeFile(file, "pixels");
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function member(endpoint: string, logicalId: string, api: "openai-responses" | "openai-completions"): ModelChainEntry {
  return { logicalId, config: {
    id: logicalId, provider: "openai", api, endpoint, api_key: logicalId + "-key",
    input_modalities: ["text", "image"], max_tokens: 4096, context_window: 272000,
    thinking_level: "off", thinking_level_map: { off: "low" },
  } };
}

test("Caption fallback uses the selected member's API, reasoning, and accounting", async () => {
  await withImage(async (file) => {
    await withServer((request, res) => {
      assert.equal(request.url, "/chat/completions");
      res.statusCode = 503;
      res.end("unavailable");
    }, async (headUrl) => {
      await withServer((request, res) => {
        assert.equal(request.url, "/responses");
        assert.equal(request.authorization, "Bearer astra-key");
        assert.equal(request.body.model, "astra");
        assert.deepEqual(request.body.reasoning, { effort: "low" });
        assert.equal(request.body.tools, undefined, "caption calls do not use agent grammar prefill");
        res.end(JSON.stringify({ status: "completed", output: [message("A square.")],
          usage: { input_tokens: 10, output_tokens: 3 } }));
      }, async (fallbackUrl) => {
        const client = new InferenceClient({ modality: "image", prompt: "describe", maxChars: 100, maxTokens: 1024,
          chain: [member(headUrl, "head", "openai-completions"), member(fallbackUrl, "astra", "openai-responses")] });
        const result = await client.caption({ filePath: file, mimeType: "image/png", filename: "image.png" });
        assert.equal(result.caption, "A square.");
        assert.equal(result.logicalModelId, "astra");
        assert.deepEqual(result.usage, { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 });
      });
    });
  });
});

test("Incomplete Responses captions preserve model health and do not fall over", async () => {
  await withImage(async (file) => {
    let fallbackCalls = 0;
    await withServer((_request, res) => res.end(JSON.stringify({ status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" }, output: [message("partial")] })), async (headUrl) => {
      await withServer((_request, res) => { fallbackCalls++; res.end("{}"); }, async (fallbackUrl) => {
        const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1 } });
        const client = new InferenceClient({ modality: "image", prompt: "describe", maxChars: 100, maxTokens: 1024,
          chain: [member(headUrl, "astra", "openai-responses"), member(fallbackUrl, "fallback", "openai-completions")], scheduler });
        await assert.rejects(client.caption({ filePath: file, mimeType: "image/png", filename: "image.png" }), /incomplete/);
        assert.equal(fallbackCalls, 0);
        assert.equal(scheduler.modelHealth(`${headUrl}::astra`), "healthy");
      });
    });
  });
});
