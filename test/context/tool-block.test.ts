import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToolBlock } from "../../src/context/tool-block.js";
import { estimateTokens } from "../../src/context/tokens.js";

const TOOLS = [
  { name: "send_message", description: "Send a message to the room.", parameters: { type: "object", properties: { message: { type: "string" } } } },
  { name: "react", description: "Add an emoji reaction.", parameters: { type: "object", properties: { emoji: { type: "string" } } } },
];

test("renderToolBlock: whole estimate matches estimateTokens of the wire array", () => {
  const block = renderToolBlock(TOOLS);
  const wire = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  assert.equal(block.tokenEstimate, estimateTokens(JSON.stringify(wire)));
});

test("renderToolBlock: one segment per tool, in declaration order, each > 0", () => {
  const block = renderToolBlock(TOOLS);
  assert.deepEqual(block.segments.map((s) => s.name), ["send_message", "react"]);
  for (const s of block.segments) assert.ok(s.tokenEstimate > 0, `${s.name} should cost tokens`);
});

test("renderToolBlock: per-tool segments are close to (slightly under) the whole-block estimate", () => {
  const block = renderToolBlock(TOOLS);
  const segSum = block.segments.reduce((n, s) => n + s.tokenEstimate, 0);
  // The whole serialization adds array brackets/commas; the subtotal sits within a
  // handful of tokens of the whole (same "do not sum exactly" property as system
  // prompt segments). Assert it's in a tight band rather than exactly equal.
  assert.ok(segSum <= block.tokenEstimate, "segment sum must not exceed the whole");
  assert.ok(block.tokenEstimate - segSum < 10, "segment sum should be within a few tokens of the whole");
});

test("renderToolBlock: empty tool set → zero estimate, empty segments, empty text", () => {
  const block = renderToolBlock([]);
  assert.equal(block.tokenEstimate, 0);
  assert.deepEqual(block.segments, []);
  assert.equal(block.text, "");
});

test("renderToolBlock: text is the pretty-printed wire definitions", () => {
  const block = renderToolBlock(TOOLS);
  assert.match(block.text, /"type": "function"/);
  assert.match(block.text, /"name": "send_message"/);
});
