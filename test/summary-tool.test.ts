import assert from "node:assert/strict";
import test from "node:test";
import { SummaryDraft, createSummaryTool } from "../src/tools/index.js";
import { resultText as text, runToolCalls, type ToolRun } from "./helpers/pi-tool-run.js";

// Every call runs through a real pi-agent-core Agent, so `isError` is the flag
// the agent loop put on the toolResult (set only when execute() throws).

function toolFor(targetTokenCount = 100, maxOverageFactor = 2) {
  const draft = new SummaryDraft();
  const tool = createSummaryTool({ draft, targetTokenCount, maxOverageFactor });
  const run = (...calls: Array<Record<string, unknown>>) => runToolCalls(tool, calls);
  return { draft, run };
}

/** A terminating result ends the run with no further model turn. */
function terminated(run: ToolRun): boolean {
  return run.turns === run.results.length;
}

test("create then view returns line-numbered content", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create", file_text: "line one\nline two" }, { command: "view" });
  assert.equal(draft.isCreated(), true);
  assert.equal(results[0]!.isError, false);
  assert.equal(results[1]!.isError, false);
  assert.match(text(results[1]!), /1: line one/);
  assert.match(text(results[1]!), /2: line two/);
});

test("str_replace edits in place", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: "hello world" },
    { command: "str_replace", old_str: "world", new_str: "there" },
  );
  assert.equal(results[1]!.isError, false);
  assert.equal(draft.getContent(), "hello there");
});

test("insert adds a line at the given position", async () => {
  const { draft, run } = toolFor();
  await run({ command: "create", file_text: "a\nc" }, { command: "insert", insert_line: 1, new_str: "b" });
  assert.equal(draft.getContent(), "a\nb\nc");
});

test("finalize terminates the turn", async () => {
  const { run } = toolFor();
  const result = await run({ command: "create", file_text: "done", finalize: true });
  assert.equal(result.results[0]!.isError, false);
  assert.equal(terminated(result), true);
});

test("double create is an error tool result with the already-created message", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: "initial content" },
    { command: "create", file_text: "second attempt" },
  );
  assert.equal(results[0]!.isError, false);
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /already created/);
  assert.equal(draft.getContent(), "initial content", "failed create leaves the draft as it was");
});

test("create with empty string is rejected and does not lock the draft", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create", file_text: "" }, { command: "create", file_text: "actual content" });
  assert.equal(results[0]!.isError, true);
  assert.match(text(results[0]!), /must not be empty/);
  // Model can retry with real content.
  assert.equal(results[1]!.isError, false);
  assert.equal(draft.isCreated(), true);
  assert.equal(draft.getContent(), "actual content");
});

test("over-budget mutation is rejected atomically and does not create the draft", async () => {
  const { draft, run } = toolFor(10, 2); // limit ≈ 20 tokens
  const huge = "word ".repeat(500);
  const result = await run({ command: "create", file_text: huge });
  const toolResult = result.results[0]!;
  assert.equal(toolResult.isError, true);
  assert.match(text(toolResult), /exceed token limit/i);
  assert.match(text(toolResult), /limit: 20 tokens \(target: 10\)/);
  assert.match(text(toolResult), /Shorten the summary and try again/);
  assert.equal(draft.isCreated(), false);
});

test("finalize is suppressed when a mutation fails the token limit", async () => {
  const { draft, run } = toolFor(10, 2);
  const huge = "word ".repeat(500);
  const result = await run({ command: "create", file_text: huge, finalize: true });
  assert.equal(result.results[0]!.isError, true);
  assert.equal(terminated(result), false, "the model gets another turn to fix the error");
  assert.equal(draft.isCreated(), false);
});

test("an over-budget edit reverts to the last good draft", async () => {
  const { draft, run } = toolFor(10, 2);
  const { results } = await run(
    { command: "create", file_text: "short" },
    { command: "str_replace", old_str: "short", new_str: "word ".repeat(500) },
  );
  assert.equal(results[1]!.isError, true);
  assert.equal(draft.getContent(), "short");
});

// --- str_replace error paths ---

test("str_replace with non-matching old_str is an error and leaves draft unchanged", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: "hello world" },
    { command: "str_replace", old_str: "xyz", new_str: "abc" },
  );
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /old_str was not found/);
  assert.match(text(results[1]!), /Current draft contents:\nhello world/);
  assert.equal(draft.getContent(), "hello world");
});

test("str_replace matching more than once is an error and leaves draft unchanged", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: "aaa bbb aaa" },
    { command: "str_replace", old_str: "aaa", new_str: "ccc" },
  );
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /old_str matched more than once/);
  assert.equal(draft.getContent(), "aaa bbb aaa");
});

test("insert past the end of the draft is an error and leaves draft unchanged", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create", file_text: "a" }, { command: "insert", insert_line: 5, new_str: "b" });
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /past end of draft/);
  assert.equal(draft.getContent(), "a");
});

// --- view error paths ---

test("view with start < 1 is an error", async () => {
  const { run } = toolFor();
  const { results } = await run({ command: "create", file_text: "line one\nline two" }, { command: "view", view_range: [0, 2] });
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /view_range start must be >= 1/);
});

test("view with start past end of draft is an error", async () => {
  const { run } = toolFor();
  const { results } = await run({ command: "create", file_text: "line one\nline two" }, { command: "view", view_range: [5, 6] });
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /past end of draft/);
});

test("view with end < start is an error", async () => {
  const { run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: "line one\nline two\nline three" },
    { command: "view", view_range: [3, 1] },
  );
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /view_range end must be >= start/);
});

test("a failing view with finalize: true does not terminate", async () => {
  const { run } = toolFor();
  const result = await run({ command: "create", file_text: "x" }, { command: "view", view_range: [0, 1], finalize: true });
  assert.equal(result.results[1]!.isError, true);
  assert.equal(terminated(result), false);
});

// --- parameter-validation errors ---

test("create without file_text is an error tool result", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create" });
  assert.equal(results[0]!.isError, true);
  assert.match(text(results[0]!), /create requires file_text/);
  assert.equal(draft.isCreated(), false);
});

test("str_replace without old_str is an error tool result", async () => {
  const { run } = toolFor();
  const { results } = await run({ command: "create", file_text: "hello" }, { command: "str_replace" });
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /str_replace requires old_str/);
});

test("insert without insert_line is an error tool result", async () => {
  const { run } = toolFor();
  const { results } = await run({ command: "create", file_text: "hello" }, { command: "insert" });
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /insert requires insert_line/);
});

// --- finalize: true on non-create commands ---

test("view with finalize: true terminates", async () => {
  const { run } = toolFor();
  const result = await run({ command: "create", file_text: "some content" }, { command: "view", finalize: true });
  assert.equal(terminated(result), true);
  assert.match(text(result.results[1]!), /1: some content/);
});

test("str_replace with finalize: true terminates", async () => {
  const { run } = toolFor();
  const result = await run(
    { command: "create", file_text: "hello world" },
    { command: "str_replace", old_str: "world", new_str: "there", finalize: true },
  );
  assert.equal(terminated(result), true);
  assert.match(text(result.results[1]!), /str_replace applied/);
});

test("insert with finalize: true terminates", async () => {
  const { run } = toolFor();
  const result = await run(
    { command: "create", file_text: "a\nc" },
    { command: "insert", insert_line: 1, new_str: "b", finalize: true },
  );
  assert.equal(terminated(result), true);
  assert.match(text(result.results[1]!), /insert applied/);
});

// --- standalone `finalize` command ---

test("finalize command terminates without mutating the draft", async () => {
  const { draft, run } = toolFor();
  const result = await run({ command: "create", file_text: "the summary" }, { command: "finalize" });
  assert.equal(result.results[1]!.isError, false);
  assert.equal(terminated(result), true);
  assert.match(text(result.results[1]!), /finalized/);
  // The draft is committed exactly as written — no spurious edit.
  assert.equal(draft.getContent(), "the summary");
});

test("finalize command on an uncreated draft is an error and does not terminate", async () => {
  const { run } = toolFor();
  const result = await run({ command: "finalize" });
  assert.equal(result.results[0]!.isError, true);
  assert.equal(terminated(result), false);
  assert.match(text(result.results[0]!), /nothing to finalize/i);
  assert.match(text(result.results[0]!), /use `create`/);
});
