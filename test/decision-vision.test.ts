import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  DecisionClient,
  DecisionEngine,
  createDecisionImageLoader,
  decisionsFor,
  lateAdditionPoint,
  memberMisfit,
  pointSettings,
  requestShapeOf,
  validateDecisionsConfig,
  wireImageState,
  type DecisionEvaluationRow,
  type DecisionImage,
  type DecisionImageLoader,
  type DecisionImageRef,
  type DecisionPoint,
  type LateAdditionInput,
} from "../src/decisions/index.js";

// ---------------------------------------------------------------------------
// Vision decision chain (DECISION-MODEL §3.5, ARCHITECTURE.md §8h): mode
// selection, wire shapes, member fits, vision → text retry → fallback, config.
// ---------------------------------------------------------------------------

function decider(over: Record<string, unknown> = {}): any {
  return {
    id: "vendor/decider-1",
    provider: "openrouter",
    api: "system-one",
    endpoint: "https://gw.example/decisions",
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 1,
    context_window: 32000,
    cost: { input: 0.04, output: 0, cache_read: 0.04, cache_write: 0.04 },
    ...over,
  };
}

function baseConfig(decisions: Record<string, unknown>, models: Record<string, unknown> = {}): any {
  return {
    models: {
      default: { id: "chat-1", provider: "x", endpoint: "https://chat.example", input_modalities: ["text"], max_tokens: 10 },
      decider: decider(),
      vision: decider({ id: "vendor/vision-1", input_modalities: ["text", "image"], fallback: ["vision_alt"] }),
      vision_alt: decider({ id: "vendor/vision-2", input_modalities: ["text", "image"] }),
      ...models,
    },
    agent: { session_types: {} },
    decisions,
  };
}

interface FakeCall {
  url: string;
  body: any;
  raw: string;
}

function fakeFetch(handler: (call: FakeCall) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const raw = String(init.body);
    const call = { url, body: JSON.parse(raw), raw };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const belongs = (p: number) => ({ model: "served", answers: { belongs: { noul: p } }, usage: { input_tokens: 900, cost: 0.0001 } });

function loader(log: Array<{ id: string; maxBytes: number; maxPixels: number }> = []): DecisionImageLoader {
  return async (ref, limits) => {
    log.push({ id: ref.id, maxBytes: limits.maxBytes, maxPixels: limits.maxPixels });
    if (!ref.localPath) return undefined;
    const bytes = Math.min(limits.maxBytes, 5000);
    return { mimeType: "image/jpeg", base64: Buffer.from(`${ref.id}:${bytes}`).toString("base64"), bytes };
  };
}

function makeEngine(config: any, fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  const logs: Array<[string, any]> = [];
  const rows: DecisionEvaluationRow[] = [];
  const logger: any = {
    info: (e: string, f: any) => logs.push([e, f]),
    warn: (e: string, f: any) => logs.push([e, f]),
    error: (e: string, f: any) => logs.push([e, f]),
    debug() {},
    child() {
      return logger;
    },
  };
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl: fetchFn, logger }),
    logger,
    onEvaluation: (row) => rows.push(row),
    ...extra,
  });
  return { engine, logs, rows };
}

const ctx = { agentName: null, attribution: { timelineKey: "t1" } };

function ref(id: string, over: Partial<DecisionImageRef> = {}): DecisionImageRef {
  return { id, messageId: `$${id}`, from: "Alice", localPath: `/media/${id}.png`, ...over };
}

function lateInput(images: DecisionImageRef[]): LateAdditionInput {
  return {
    before: [{ from: "Bob", text: "nice cat", age: "40s before" }],
    request: { from: "Alice", text: "what breed is this?", attachments: [] },
    between: [],
    message: {
      from: "Alice",
      text: "",
      age: "12s after request",
      attachments: images.map((r) => ({ kind: "image" as const, caption: r.caption ?? null, imageRefId: r.id })),
    },
    images,
  };
}

const visionDecisions = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  model: "decider",
  vision_model: "vision",
  late_addition: { enabled: true },
  ...over,
});

// --- settings ------------------------------------------------------------------

test("pointSettings: vision chain resolution, per-point default modes, limits", () => {
  const none = pointSettings(decisionsFor(baseConfig({ enabled: true, model: "decider", late_addition: { enabled: true } }), null), "late_addition")!;
  assert.equal(none.vision, undefined, "no vision_model → off");
  assert.equal(none.threshold, 0.7);

  const config = baseConfig(
    visionDecisions({
      vision_timeout_ms: 5000,
      max_images: 2,
      routing: { enabled: true },
      records: { enabled: true },
      implicit_reply: { enabled: true, threshold: 0.9 },
    }),
  );
  const d = decisionsFor(config, null);
  assert.deepEqual(pointSettings(d, "late_addition")!.vision, {
    model: "vision",
    mode: "always",
    timeoutMs: 5000,
    maxImages: 2,
    imageMaxPixels: 1_000_000,
    maxImageBytes: 200_000,
  });
  assert.equal(pointSettings(d, "routing")!.vision?.mode, "uncaptioned");
  assert.equal(pointSettings(d, "records")!.vision, undefined, "records default off");
  assert.equal(pointSettings(d, "implicit_reply")!.vision, undefined, "implicit_reply default off");
  assert.equal(pointSettings(d, "implicit_reply")!.threshold, 0.9);

  const overridden = decisionsFor(
    baseConfig(visionDecisions({ late_addition: { enabled: true, vision: "uncaptioned", vision_model: "vision_alt" } })),
    null,
  );
  assert.deepEqual(
    [pointSettings(overridden, "late_addition")!.vision?.model, pointSettings(overridden, "late_addition")!.vision?.mode],
    ["vision_alt", "uncaptioned"],
  );
  const off = decisionsFor(baseConfig(visionDecisions({ late_addition: { enabled: true, vision: "off" } })), null);
  assert.equal(pointSettings(off, "late_addition")!.vision, undefined);
});

test("validateDecisionsConfig: vision chains must be system-one with image input on every member", () => {
  validateDecisionsConfig(baseConfig(visionDecisions()));
  assert.throws(
    () => validateDecisionsConfig(baseConfig(visionDecisions({ vision_model: "default" }))),
    /vision_model = "default" must name a model with api = "system-one"/,
  );
  assert.throws(
    () => validateDecisionsConfig(baseConfig(visionDecisions({ vision_model: "decider" }))),
    /vision chain member "decider" does not declare "image"/,
  );
  const textFallback = baseConfig(visionDecisions(), {
    vision: decider({ input_modalities: ["text", "image"], fallback: ["decider"] }),
  });
  assert.throws(() => validateDecisionsConfig(textFallback), /vision chain member "decider"/);
  assert.throws(
    () => validateDecisionsConfig(baseConfig(visionDecisions({ late_addition: { enabled: true, vision_model: "decider" } }))),
    /late_addition\.vision_model/,
  );
  assert.throws(
    () => validateDecisionsConfig(baseConfig(visionDecisions({ late_addition: { enabled: true, min_confidence: 0.5 } }))),
    /late_addition\.min_confidence is not used/,
  );
  assert.throws(
    () => validateDecisionsConfig(baseConfig(visionDecisions({ implicit_reply: { min_confidence: 0.5 } }))),
    /implicit_reply\.min_confidence is not used/,
  );
  const warnings: string[] = [];
  validateDecisionsConfig(baseConfig({ enabled: true, model: "decider", late_addition: { enabled: true, vision: "always" } }), {
    warn: (event) => warnings.push(event),
  });
  assert.deepEqual(warnings, ["decisions_vision_without_chain"]);
  assert.throws(
    () => validateDecisionsConfig(baseConfig({ enabled: true, late_addition: { enabled: true } })),
    /late_addition is enabled but neither it nor decisions names a decision model/,
  );
});

test("memberMisfit: a text-only member never fits a request with images", () => {
  const shape = requestShapeOf({ q: { type: "noul", instructions: "x" } });
  assert.equal(memberMisfit(decider(), shape, 5000, 100, "object", true), "image_input");
  assert.equal(memberMisfit(decider({ input_modalities: ["text", "image"] }), shape, 5000, 100, "object", true), undefined);
  assert.equal(memberMisfit(decider(), shape, 5000, 100, "object", false), undefined);
});

// --- wire shapes ------------------------------------------------------------------

function img(id: string, label: string): DecisionImage {
  return { ref: ref(id), label, mimeType: "image/jpeg", base64: "QUJD", bytes: 3 };
}

test("wireImageState: state_parts, images_field, and pass-through without images", () => {
  const state = { a: 1 };
  assert.deepEqual(wireImageState(state, [], "state_parts"), { state, logged: state });
  const parts = wireImageState(state, [img("x", "image 1"), img("y", "image 2")], "state_parts");
  assert.deepEqual(parts.state, [
    { type: "text", text: '{"a":1}' },
    { type: "text", text: "image 1: attached to message $x by Alice" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    { type: "text", text: "image 2: attached to message $y by Alice" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
  ]);
  assert.equal(parts.images, undefined);
  assert.ok(!JSON.stringify(parts.logged).includes("base64"), "logged form carries markers, not pixels");
  const field = wireImageState(state, [img("x", "image 1")], "images_field");
  assert.deepEqual(field.state, { a: 1, image_labels: ["image 1: attached to message $x by Alice"] });
  assert.deepEqual(field.images, ["data:image/jpeg;base64,QUJD"]);
});

// --- engine -----------------------------------------------------------------------

test("engine: late_addition (default always) sends labelled image parts to the vision chain", async () => {
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.9)));
  const { engine, logs, rows } = makeEngine(baseConfig(visionDecisions()), fn, { loadImage: loader() });
  const out = await engine.evaluate(lateAdditionPoint, lateInput([ref("a"), ref("b", { caption: "a cat" })]), ctx);
  assert.equal(out.source, "model");
  assert.deepEqual(out.verdict, { belongs: true, probability: 0.9, judged: true });
  assert.deepEqual([out.visionServed, out.imageCount], [true, 2]);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body;
  assert.equal(body.model, "vendor/vision-1");
  assert.equal(body.state.length, 5);
  const head = JSON.parse(body.state[0].text);
  assert.deepEqual(head.message.attachments, [
    { kind: "image", image: "image 1", caption: null },
    { kind: "image", image: "image 2", caption: "a cat" },
  ]);
  assert.equal(body.state[1].text, "image 1: attached to message $a by Alice");
  assert.equal(body.state[2].type, "image_url");
  assert.match(body.state[2].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(body.questions.belongs.instructions, /label/);
  const log = logs.find(([e]) => e === "decision_evaluated")![1];
  assert.deepEqual([log.imageCount, log.visionServed, log.servedModel], [2, true, "vision"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.imageCount, 2);
  assert.equal(rows[0]!.visionServed, true);
  assert.ok(!rows[0]!.stateJson!.includes(Buffer.from("a:5000").toString("base64")), "row stores markers");
  assert.match(rows[0]!.stateJson!, /image 1: image\/jpeg, 5000 bytes/);
});

test("engine: uncaptioned mode uses the vision chain only when a subject image lacks a caption", async () => {
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.8)));
  const config = baseConfig(visionDecisions({ late_addition: { enabled: true, vision: "uncaptioned" } }));
  const { engine } = makeEngine(config, fn, { loadImage: loader() });
  const captioned = await engine.evaluate(lateAdditionPoint, lateInput([ref("a", { caption: "a dog" })]), ctx);
  assert.equal(captioned.visionServed, undefined, "no vision attempt planned");
  assert.equal(calls[0]!.body.model, "vendor/decider-1");
  assert.ok(!Array.isArray(calls[0]!.body.state), "text request keeps the object state");
  assert.deepEqual(Object.keys(calls[0]!.body).sort(), ["model", "questions", "state"]);
  assert.equal(calls[0]!.body.state.message.attachments[0].caption, "a dog");
  await engine.evaluate(lateAdditionPoint, lateInput([ref("a", { caption: "a dog" }), ref("b")]), ctx);
  assert.equal(calls[1]!.body.model, "vendor/vision-1");
});

test("engine: no subject image, or a point without images(), never uses the vision chain", async () => {
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.8)));
  const { engine } = makeEngine(baseConfig(visionDecisions()), fn, { loadImage: loader() });
  await engine.evaluate(lateAdditionPoint, lateInput([]), ctx);
  const noImages: DecisionPoint<LateAdditionInput, unknown> = { ...lateAdditionPoint, images: undefined };
  await engine.evaluate(noImages, lateInput([ref("a")]), ctx);
  assert.deepEqual(calls.map((c) => c.body.model), ["vendor/decider-1", "vendor/decider-1"]);
});

test("engine: images_field members get the plain state and a top-level images array", async () => {
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.9)));
  const config = baseConfig(visionDecisions(), {
    vision: decider({ id: "vendor/vision-1", input_modalities: ["text", "image"], decision: { images: "images_field" } }),
  });
  const { engine } = makeEngine(config, fn, { loadImage: loader() });
  await engine.evaluate(lateAdditionPoint, lateInput([ref("a")]), ctx);
  const body = calls[0]!.body;
  assert.equal(body.images.length, 1);
  assert.match(body.images[0], /^data:image\/jpeg;base64,/);
  assert.equal(body.state.message.attachments[0].image, "image 1");
  assert.deepEqual(body.state.image_labels, ["image 1: attached to message $a by Alice"]);
});

test("engine: a vision-chain member without image input is skipped; max_images / max_image_bytes fit per member", async () => {
  const loads: Array<{ id: string; maxBytes: number; maxPixels: number }> = [];
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.9)));
  const config = baseConfig(visionDecisions({ max_images: 3, image_max_pixels: 500_000 }), {
    vision: decider({ id: "vendor/text-only", input_modalities: ["text"], fallback: ["vision_alt"] }),
    vision_alt: decider({
      id: "vendor/vision-2",
      input_modalities: ["text", "image"],
      decision: { max_images: 2, max_image_bytes: 2048 },
    }),
  });
  const { engine } = makeEngine(config, fn, { loadImage: loader(loads) });
  const out = await engine.evaluate(lateAdditionPoint, lateInput([ref("a"), ref("b"), ref("c"), ref("d")]), ctx);
  assert.equal(calls.length, 1, "the text-only member is never sent the request");
  assert.equal(calls[0]!.body.model, "vendor/vision-2");
  assert.equal(out.imageCount, 3, "max_images caps the loaded set");
  const imageParts = calls[0]!.body.state.filter((p: any) => p.type === "image_url");
  assert.equal(imageParts.length, 2, "the member's max_images caps what it is sent");
  assert.deepEqual(
    loads.map((l) => [l.id, l.maxBytes, l.maxPixels]),
    [
      ["a", 200_000, 500_000],
      ["b", 200_000, 500_000],
      ["c", 200_000, 500_000],
      ["a", 2048, 500_000],
      ["b", 2048, 500_000],
    ],
    "loaded at the point's limits, re-conditioned under the member's byte cap",
  );
  const head = JSON.parse(calls[0]!.body.state[0].text);
  assert.deepEqual(
    head.message.attachments.map((a: any) => a.image ?? null),
    ["image 1", "image 2", null, null],
    "only the images sent are labelled in the state",
  );
});

test("engine: vision failure retries once on the text chain with captions", async () => {
  const { fn, calls } = fakeFetch((call) =>
    call.body.model.startsWith("vendor/vision") ? json(500, { error: "down" }) : json(200, belongs(0.75)),
  );
  const { engine, logs } = makeEngine(baseConfig(visionDecisions()), fn, { loadImage: loader() });
  const out = await engine.evaluate(lateAdditionPoint, lateInput([ref("a")]), ctx);
  assert.deepEqual(
    calls.map((c) => c.body.model),
    ["vendor/vision-1", "vendor/vision-2", "vendor/decider-1"],
  );
  assert.equal(out.source, "model");
  assert.deepEqual([out.visionServed, out.visionReason, out.imageCount], [false, "error", 1]);
  const text = calls[2]!.body;
  assert.deepEqual(text.state.message.attachments, [{ kind: "image", caption: null }]);
  assert.doesNotMatch(text.questions.belongs.instructions, /label/);
  const log = logs.find(([e]) => e === "decision_evaluated")![1];
  assert.deepEqual([log.source, log.visionServed, log.visionReason, log.servedModel], ["model", false, "error", "decider"]);
});

test("engine: vision low confidence → text retry; text failure → the point's fallback verdict", async () => {
  const { fn, calls } = fakeFetch((call) =>
    call.body.model.startsWith("vendor/vision") ? json(200, { model: "v", answers: { belongs: { bad: 1 } } }) : json(503, {}),
  );
  const config = baseConfig(visionDecisions(), {
    vision: decider({ id: "vendor/vision-1", input_modalities: ["text", "image"] }),
  });
  const { engine, rows } = makeEngine(config, fn, { loadImage: loader() });
  const out = await engine.evaluate(lateAdditionPoint, lateInput([ref("a")]), ctx);
  assert.equal(calls.length, 2);
  assert.equal(out.source, "heuristic");
  assert.deepEqual(out.verdict, { belongs: false, probability: null, judged: false });
  assert.equal(out.reason, "error");
  assert.equal(out.visionServed, false);
  assert.equal(rows.length, 1, "one row per evaluation");
  assert.equal(rows[0]!.source, "heuristic");
});

test("engine: a vision resolve below confidence (resolve null) also retries on the text chain", async () => {
  const point: DecisionPoint<LateAdditionInput, string> = {
    ...lateAdditionPoint,
    resolve: (answers) => ((answers.belongs as any).noul > 0.5 ? "yes" : null),
    fallback: () => "fallback",
    describe: (v) => v,
  } as any;
  const { fn, calls } = fakeFetch((call) => json(200, belongs(call.body.model.startsWith("vendor/vision") ? 0.2 : 0.9)));
  const config = baseConfig(visionDecisions(), { vision: decider({ id: "vendor/vision-1", input_modalities: ["text", "image"] }) });
  const { engine } = makeEngine(config, fn, { loadImage: loader() });
  const out = await engine.evaluate(point, lateInput([ref("a")]), ctx);
  assert.equal(calls.length, 2);
  assert.deepEqual([out.verdict, out.visionReason], ["yes", "low_confidence"]);
});

test("engine: no image loader or no loadable image → the text chain directly", async () => {
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.9)));
  const noLoader = makeEngine(baseConfig(visionDecisions()), fn);
  const a = await noLoader.engine.evaluate(lateAdditionPoint, lateInput([ref("a")]), ctx);
  assert.deepEqual([a.visionServed, a.visionReason], [false, "no_image_loader"]);
  const unloadable = makeEngine(baseConfig(visionDecisions()), fn, { loadImage: loader() });
  const b = await unloadable.engine.evaluate(lateAdditionPoint, lateInput([ref("a", { localPath: undefined })]), ctx);
  assert.deepEqual([b.visionServed, b.visionReason], [false, "no_loadable_image"]);
  assert.deepEqual(calls.map((c) => c.body.model), ["vendor/decider-1", "vendor/decider-1"]);
});

test("engine: a disabled point never loads images", async () => {
  const loads: Array<{ id: string; maxBytes: number; maxPixels: number }> = [];
  const { fn, calls } = fakeFetch(() => json(200, belongs(0.9)));
  const { engine } = makeEngine(baseConfig(visionDecisions({ late_addition: { enabled: false } })), fn, {
    loadImage: loader(loads),
  });
  const out = await engine.evaluate(lateAdditionPoint, lateInput([ref("a")]), ctx);
  assert.equal(out.reason, "disabled");
  assert.equal(loads.length + calls.length, 0);
});

// --- loader adapter -------------------------------------------------------------

test("createDecisionImageLoader: downscales and re-encodes JPEG under the limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-img-"));
  try {
    const path = join(dir, "big.png");
    const noise = Buffer.alloc(1600 * 1200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;
    await writeFile(path, await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer());
    const load = createDecisionImageLoader({ mozjpeg: false });
    const out = await load(ref("x", { localPath: path }), { maxPixels: 250_000, maxBytes: 60_000 });
    assert.ok(out);
    assert.equal(out.mimeType, "image/jpeg");
    assert.ok(out.bytes <= 60_000);
    const meta = await sharp(Buffer.from(out.base64, "base64")).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width! * meta.height! <= 250_000 * 1.01);
    assert.equal(await load(ref("y", { localPath: undefined }), { maxPixels: 1000, maxBytes: 2000 }), undefined);
    assert.equal(await load(ref("z", { localPath: join(dir, "missing.png") }), { maxPixels: 1000, maxBytes: 2000 }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
