import assert from "node:assert/strict";
import test from "node:test";

import { capImages, OMITTED_IMAGE_TEXT, withImageCap } from "../src/agent/image-cap.js";

// ---------------------------------------------------------------------------
// Per-model image cap (`[models.<name>] max_images`). Synthetic pi-ai messages:
// the newest N image blocks survive, older ones become a text placeholder.
// ---------------------------------------------------------------------------

const img = (tag: string) => ({ type: "image", data: tag, mimeType: "image/png" });
const text = (t: string) => ({ type: "text", text: t });
const user = (...content: any[]) => ({ role: "user", content, timestamp: 1 }) as any;
const result = (...content: any[]) => ({ role: "toolResult", toolCallId: "c", toolName: "read_image", content, isError: false, timestamp: 1 }) as any;
const assistant = (t: string) => ({ role: "assistant", content: [text(t)], timestamp: 1 }) as any;
const images = (messages: any[]) => messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b: any) => b.type === "image").map((b: any) => b.data)));

test("capImages: at or under the cap → same array", () => {
  const messages = [user(text("hi"), img("a"), img("b")), assistant("ok"), result(img("c"))];
  assert.equal(capImages(messages, 3), messages);
  assert.equal(capImages([user("plain string")] as any, 1).length, 1);
});

test("capImages: keeps the newest N across user turns and tool results", () => {
  const first = user(text("look"), img("a"), img("b"));
  const middle = assistant("calling");
  const tool = result(text("shot"), img("c"));
  const last = user(text("and these"), img("d"), img("e"));
  const out = capImages([first, middle, tool, last], 3);
  assert.deepEqual(images(out), ["c", "d", "e"]);
  // Dropped blocks become placeholders in place; the leading text part stays first.
  assert.deepEqual(out[0]!.content, [text("look"), text(OMITTED_IMAGE_TEXT), text(OMITTED_IMAGE_TEXT)]);
  // Untouched messages keep their identity.
  assert.equal(out[1], middle);
  assert.equal(out[2], tool);
  assert.equal(out[3], last);
});

test("capImages: splits within one message, dropping its older blocks", () => {
  const out = capImages([user(text("x"), img("a"), img("b"), img("c"))], 2);
  assert.deepEqual(images(out), ["b", "c"]);
  assert.equal((out[0]!.content as any)[1].text, OMITTED_IMAGE_TEXT);
});

test("capImages: preserves extra message properties (symbol keys, tool-load markers)", () => {
  const sym = Symbol("slot");
  const message = { ...result(img("a"), img("b")), addedToolNames: ["x"], [sym]: 7 };
  const [out] = capImages([message], 1) as any[];
  assert.deepEqual(out.addedToolNames, ["x"]);
  assert.equal(out[sym], 7);
  assert.notEqual(out, message);
});

test("withImageCap: base receives the capped context, unchanged context passes through", () => {
  const seen: any[] = [];
  const base = ((_model: any, context: any) => {
    seen.push(context);
    return undefined;
  }) as any;
  const wrapped = withImageCap(base, 1);
  const small = { systemPrompt: "s", messages: [user(text("t"), img("a"))] };
  wrapped({} as any, small as any, {});
  assert.equal(seen[0], small);
  const big = { systemPrompt: "s", messages: [user(text("t"), img("a"), img("b"))] };
  wrapped({} as any, big as any, {});
  assert.equal(seen[1].systemPrompt, "s");
  assert.deepEqual(images(seen[1].messages), ["b"]);
  assert.deepEqual(images(big.messages), ["a", "b"]);
});
