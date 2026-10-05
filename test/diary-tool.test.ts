import assert from "node:assert/strict";
import test from "node:test";
import { SummaryDraft, createDiaryTool } from "../src/tools/index.js";
import { resultText as text, runToolCalls, type ToolRun } from "./helpers/pi-tool-run.js";

// Every call runs through a real pi-agent-core Agent, so `isError` is the flag
// the agent loop put on the toolResult (set only when execute() throws).

const HEADER = "## 2026-06-03 14:05 → 2026-06-03 15:30 · UTC · Room";

function toolFor(perSessionBudget = 1000) {
  const draft = new SummaryDraft();
  const tool = createDiaryTool({ draft, perSessionBudget, requiredHeader: HEADER });
  const run = (...calls: Array<Record<string, unknown>>) => runToolCalls(tool, calls);
  return { draft, run };
}

/** A terminating result ends the run with no further model turn. */
function terminated(run: ToolRun): boolean {
  return run.turns === run.results.length;
}

test("create with the dictated header first is accepted", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create", file_text: `${HEADER}\nDear diary, I helped Alice.` });
  assert.equal(results[0]!.isError, false);
  assert.equal(draft.isCreated(), true);
  assert.ok(draft.getContent().startsWith(HEADER));
});

test("create WITHOUT the header is rejected and leaves the draft uncreated", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create", file_text: "Dear diary, no header here." });
  assert.equal(results[0]!.isError, true);
  assert.match(text(results[0]!), /must BEGIN with exactly this header/);
  assert.ok(text(results[0]!).includes(HEADER), "the error echoes the required header");
  assert.equal(draft.isCreated(), false, "rejected create does not lock the draft");
});

test("create with a wrong header is rejected (strict, not house-style)", async () => {
  const { draft, run } = toolFor();
  const { results } = await run({ command: "create", file_text: "## 2026-06-03 14:05 - 2026-06-03 15:30 · UTC · Room\nbody" });
  assert.equal(results[0]!.isError, true);
  assert.equal(draft.isCreated(), false);
});

test("an edit that removes the header is reverted", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: `${HEADER}\nbody text` },
    { command: "str_replace", old_str: HEADER, new_str: "## different header" },
  );
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /must BEGIN with exactly this header/);
  assert.equal(draft.getContent(), `${HEADER}\nbody text`, "draft reverted to the valid header");
});

test("a header-breaking edit with finalize: true does not terminate", async () => {
  const { draft, run } = toolFor();
  const result = await run(
    { command: "create", file_text: `${HEADER}\nbody text` },
    { command: "str_replace", old_str: HEADER, new_str: "## different header", finalize: true },
  );
  assert.equal(result.results[1]!.isError, true);
  assert.equal(terminated(result), false);
  assert.ok(draft.getContent().startsWith(HEADER));
});

test("over-budget mutation is rejected atomically and never terminates", async () => {
  const { draft, run } = toolFor(20); // tiny budget
  const huge = `${HEADER}\n` + "word ".repeat(500);
  const result = await run({ command: "create", file_text: huge, finalize: true });
  assert.equal(result.results[0]!.isError, true);
  assert.match(text(result.results[0]!), /exceed token budget/i);
  assert.match(text(result.results[0]!), /limit: 20 tokens/);
  assert.match(text(result.results[0]!), /Shorten the entry and try again/);
  assert.equal(terminated(result), false, "finalize suppressed on a failed edit");
  assert.equal(draft.isCreated(), false);
});

test("str_replace with non-matching old_str is an error and leaves draft unchanged", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: `${HEADER}\nentry` },
    { command: "str_replace", old_str: "missing", new_str: "x" },
  );
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /old_str was not found/);
  assert.equal(draft.getContent(), `${HEADER}\nentry`);
});

test("create without file_text is an error tool result", async () => {
  const { run } = toolFor();
  const { results } = await run({ command: "create" });
  assert.equal(results[0]!.isError, true);
  assert.match(text(results[0]!), /create requires file_text/);
});

test("view with a bad range is an error tool result", async () => {
  const { run } = toolFor();
  const { results } = await run({ command: "create", file_text: `${HEADER}\nentry` }, { command: "view", view_range: [0, 1] });
  assert.equal(results[1]!.isError, true);
  assert.match(text(results[1]!), /view_range start must be >= 1/);
});

test("finalize on an empty draft (via view) terminates as the legitimate skip", async () => {
  const { draft, run } = toolFor();
  const result = await run({ command: "view", finalize: true });
  assert.equal(result.results[0]!.isError, false);
  assert.equal(terminated(result), true);
  assert.equal(draft.isCreated(), false, "empty-draft finalize leaves nothing to append");
});

test("finalize on a valid created draft terminates", async () => {
  const { run } = toolFor();
  const result = await run({ command: "create", file_text: `${HEADER}\ndone`, finalize: true });
  assert.equal(result.results[0]!.isError, false);
  assert.equal(terminated(result), true);
  assert.match(text(result.results[0]!), /create applied/);
});

test("finalize command on a created draft terminates without mutating it", async () => {
  const { draft, run } = toolFor();
  const result = await run({ command: "create", file_text: `${HEADER}\nthe entry` }, { command: "finalize" });
  assert.equal(terminated(result), true);
  assert.match(text(result.results[1]!), /finalized/);
  assert.equal(draft.getContent(), `${HEADER}\nthe entry`, "committed as-is, no spurious edit");
});

test("finalize command on an empty draft terminates as the legitimate skip", async () => {
  const { draft, run } = toolFor();
  const result = await run({ command: "finalize" });
  assert.equal(result.results[0]!.isError, false);
  assert.equal(terminated(result), true);
  assert.match(text(result.results[0]!), /no entry/i);
  assert.equal(draft.isCreated(), false, "empty-draft finalize leaves nothing to append");
});

test("str_replace that keeps the header still applies", async () => {
  const { draft, run } = toolFor();
  const { results } = await run(
    { command: "create", file_text: `${HEADER}\nplaceholder` },
    { command: "str_replace", old_str: "placeholder", new_str: "the real entry" },
  );
  assert.equal(results[1]!.isError, false);
  assert.equal(draft.getContent(), `${HEADER}\nthe real entry`);
});
