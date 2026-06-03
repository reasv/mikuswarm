import assert from "node:assert/strict";
import test from "node:test";
import { SummaryDraft, createDiaryTool } from "../src/tools/index.js";

const HEADER = "## 2026-06-03 14:05 → 2026-06-03 15:30 · UTC · Room";

function toolFor(perSessionBudget = 1000) {
  const draft = new SummaryDraft();
  const tool = createDiaryTool({ draft, perSessionBudget, requiredHeader: HEADER });
  return { draft, tool };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

test("create with the dictated header first is accepted", async () => {
  const { draft, tool } = toolFor();
  const result = await tool.execute("1", { command: "create", file_text: `${HEADER}\nDear diary, I helped Alice.` });
  assert.notEqual(result.isError, true);
  assert.equal(draft.isCreated(), true);
  assert.ok(draft.getContent().startsWith(HEADER));
});

test("create WITHOUT the header is rejected and leaves the draft uncreated", async () => {
  const { draft, tool } = toolFor();
  const result = await tool.execute("1", { command: "create", file_text: "Dear diary, no header here." });
  assert.equal(result.isError, true);
  assert.match(text(result), /must BEGIN with exactly this header/);
  assert.match(text(result), /UTC · Room/);
  assert.equal(draft.isCreated(), false, "rejected create does not lock the draft");
});

test("create with a wrong header is rejected (strict, not house-style)", async () => {
  const { draft, tool } = toolFor();
  const result = await tool.execute("1", { command: "create", file_text: "## 2026-06-03 14:05 - 2026-06-03 15:30 · UTC · Room\nbody" });
  assert.equal(result.isError, true);
  assert.equal(draft.isCreated(), false);
});

test("an edit that removes the header is reverted", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: `${HEADER}\nbody text` });
  const result = await tool.execute("2", { command: "str_replace", old_str: HEADER, new_str: "## different header" });
  assert.equal(result.isError, true);
  assert.match(text(result), /must BEGIN with exactly this header/);
  assert.ok(draft.getContent().startsWith(HEADER), "draft reverted to the valid header");
});

test("over-budget mutation is rejected atomically and never terminates", async () => {
  const { draft, tool } = toolFor(20); // tiny budget
  const huge = `${HEADER}\n` + "word ".repeat(500);
  const result = await tool.execute("1", { command: "create", file_text: huge, finalize: true });
  assert.equal(result.isError, true);
  assert.match(text(result), /exceed token budget/i);
  assert.notEqual(result.terminate, true, "finalize suppressed on a failed edit");
  assert.equal(draft.isCreated(), false);
});

test("finalize on an empty draft (via view) terminates as the legitimate skip", async () => {
  const { draft, tool } = toolFor();
  const result = await tool.execute("1", { command: "view", finalize: true });
  assert.equal(result.terminate, true);
  assert.equal(draft.isCreated(), false, "empty-draft finalize leaves nothing to append");
});

test("finalize on a valid created draft terminates", async () => {
  const { tool } = toolFor();
  const result = await tool.execute("1", { command: "create", file_text: `${HEADER}\ndone`, finalize: true });
  assert.equal(result.terminate, true);
  assert.match(text(result), /create applied/);
});

test("str_replace that keeps the header still applies", async () => {
  const { draft, tool } = toolFor();
  await tool.execute("1", { command: "create", file_text: `${HEADER}\nplaceholder` });
  const result = await tool.execute("2", { command: "str_replace", old_str: "placeholder", new_str: "the real entry" });
  assert.notEqual(result.isError, true);
  assert.equal(draft.getContent(), `${HEADER}\nthe real entry`);
});
