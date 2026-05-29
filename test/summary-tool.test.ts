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

test("double create returns isError: true with already created message", async () => {
  const { tool } = toolFor();
  const first = await tool.execute("1", { command: "create", file_text: "initial content" });
  assert.notEqual(first.isError, true);

  const second = await tool.execute("2", { command: "create", file_text: "second attempt" });
  assert.equal(second.isError, true);
  assert.match(text(second), /already created/);
});

test("create with empty string is rejected and does not lock the draft", async () => {
  const { draft, tool } = toolFor();
  const result = await tool.execute("1", { command: "create", file_text: "" });
  assert.match(text(result), /must not be empty/);
  assert.equal(draft.isCreated(), false);
  // Model can retry with real content.
  await tool.execute("2", { command: "create", file_text: "actual content" });
  assert.equal(draft.isCreated(), true);
  assert.equal(draft.getContent(), "actual content");
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

// --- str_replace error paths ---

test("str_replace with non-matching old_str returns error and leaves draft unchanged", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "hello world" });
  const result = await tool.execute("2", { command: "str_replace", old_str: "xyz", new_str: "abc" });
  assert.match(text(result), /old_str was not found/);
  assert.equal(draft.getContent(), "hello world");
});

test("str_replace matching more than once returns error and leaves draft unchanged", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "aaa bbb aaa" });
  const result = await tool.execute("2", { command: "str_replace", old_str: "aaa", new_str: "ccc" });
  assert.match(text(result), /old_str matched more than once/);
  assert.equal(draft.getContent(), "aaa bbb aaa");
});

// --- view error paths ---

test("view with start < 1 returns error", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "line one\nline two" });
  const result = await tool.execute("2", { command: "view", view_range: [0, 2] });
  assert.match(text(result), /view_range start must be >= 1/);
});

test("view with start past end of draft returns error", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "line one\nline two" });
  const result = await tool.execute("2", { command: "view", view_range: [5, 6] });
  assert.match(text(result), /past end of draft/);
});

test("view with end < start returns error", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "line one\nline two\nline three" });
  const result = await tool.execute("2", { command: "view", view_range: [3, 1] });
  assert.match(text(result), /view_range end must be >= start/);
});

// --- parameter-validation errors return isError: true ---

test("create without file_text returns isError: true", async () => {
  const { tool } = toolFor();
  const result = await tool.execute("1", { command: "create" });
  assert.match(text(result), /create requires file_text/);
  assert.equal(result.isError, true);
});

test("str_replace without old_str returns isError: true", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "hello" });
  const result = await tool.execute("2", { command: "str_replace" });
  assert.match(text(result), /str_replace requires old_str/);
  assert.equal(result.isError, true);
});

test("insert without insert_line returns isError: true", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "hello" });
  const result = await tool.execute("2", { command: "insert" });
  assert.match(text(result), /insert requires insert_line/);
  assert.equal(result.isError, true);
});

// --- finalize: true on non-create commands ---

test("view with finalize: true sets terminate: true", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "some content" });
  const result = await tool.execute("2", { command: "view", finalize: true });
  assert.equal(result.terminate, true);
  assert.match(text(result), /1: some content/);
});

test("str_replace with finalize: true sets terminate: true", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "hello world" });
  const result = await tool.execute("2", { command: "str_replace", old_str: "world", new_str: "there", finalize: true });
  assert.equal(result.terminate, true);
  assert.match(text(result), /str_replace applied/);
});

test("insert with finalize: true sets terminate: true", async () => {
  const { tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: "a\nc" });
  const result = await tool.execute("2", { command: "insert", insert_line: 1, new_str: "b", finalize: true });
  assert.equal(result.terminate, true);
  assert.match(text(result), /insert applied/);
});
