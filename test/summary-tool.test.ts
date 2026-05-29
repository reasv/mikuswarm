import assert from "node:assert/strict";
import test from "node:test";
import { SummaryDraft, createSummaryTool } from "../src/tools/index.js";

function toolFor(targetTokenCount = 100, maxOverageFactor = 2) {
  const draft = new SummaryDraft();
  const tool = createSummaryTool({ draft, targetTokenCount, maxOverageFactor });
  return { draft, tool };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

test("create then view returns line-numbered content", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "line one\nline two" });
  assert.equal(draft.isCreated(), true);
  const view = await tool.execute("2", { command: "view" });
  assert.match(text(view), /1: line one/);
  assert.match(text(view), /2: line two/);
});

test("str_replace edits in place", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "hello world" });
  await tool.execute("2", { command: "str_replace", old_str: "world", new_str: "there" });
  assert.equal(draft.getContent(), "hello there");
});

test("insert adds a line at the given position", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "a\nc" });
  await tool.execute("2", { command: "insert", insert_line: 1, new_str: "b" });
  assert.equal(draft.getContent(), "a\nb\nc");
});

test("finalize terminates the turn", async () => {
  const { tool } = toolFor();
  const result = await tool.execute("1", { command: "create", file_text: "done", finalize: true });
  assert.equal(result.terminate, true);
});

test("over-budget mutation is rejected atomically and does not create the draft", async () => {
  const { draft, tool } = toolFor(10, 2); // limit ≈ 20 tokens
  const huge = "word ".repeat(500);
  const result = await tool.execute("1", { command: "create", file_text: huge });
  assert.match(text(result), /exceed token limit/i);
  assert.equal(draft.isCreated(), false);
  assert.notEqual(result.terminate, true);
});

test("finalize is suppressed when a mutation fails the token limit", async () => {
  const { tool } = toolFor(10, 2);
  const huge = "word ".repeat(500);
  const result = await tool.execute("1", { command: "create", file_text: huge, finalize: true });
  assert.notEqual(result.terminate, true);
});
