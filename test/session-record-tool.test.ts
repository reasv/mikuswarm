/**
 * Tests for the session_record_tool (spec SESSION-RECORDS §3.2, CONTRACT §1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionRecordTool, SummaryDraft } from "../src/tools/session-record-tool.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTool(maxTokens = 200) {
  const draft = new SummaryDraft();
  const tool = createSessionRecordTool({ draft, maxTokens });
  return { draft, tool };
}

async function call(tool: ReturnType<typeof createSessionRecordTool>, args: object) {
  return tool.execute("tc1", args, undefined as never);
}

// ── flags ────────────────────────────────────────────────────────────────────

test("session_record_tool: has harnessOnly flag", () => {
  const { tool } = makeTool();
  assert.equal((tool as Record<string, unknown>).harnessOnly, true);
});

test("session_record_tool: has resumeWorkExempt flag", () => {
  const { tool } = makeTool();
  assert.equal(tool.resumeWorkExempt, true);
});

test("session_record_tool: name is session_record_tool", () => {
  const { tool } = makeTool();
  assert.equal(tool.name, "session_record_tool");
});

// ── create ────────────────────────────────────────────────────────────────────

test("session_record_tool: create writes text to draft", async () => {
  const { draft, tool } = makeTool(200);
  const res = await call(tool, { command: "create", file_text: "Hello world." });
  assert.ok(!res.isError, `expected no error, got: ${JSON.stringify(res)}`);
  assert.ok(draft.isCreated());
  assert.ok(draft.getContent().includes("Hello world."));
});

test("session_record_tool: create without file_text returns error", async () => {
  const { tool } = makeTool();
  const res = await call(tool, { command: "create" });
  assert.equal(res.isError, true);
});

// ── token budget ─────────────────────────────────────────────────────────────

test("session_record_tool: create within budget succeeds", async () => {
  // With a generous limit, a short create must not trigger budget error.
  const { draft, tool } = makeTool(9999);
  const res = await call(tool, { command: "create", file_text: "Short text." });
  assert.ok(!res.isError);
  assert.ok(draft.isCreated());
});

test("session_record_tool: create that exceeds budget is reverted atomically", async () => {
  // Set a tiny token limit (10 tokens). A long file_text will exceed it.
  const { draft, tool } = makeTool(1);
  const longText = "x ".repeat(500); // Well over 1 token.
  const res = await call(tool, { command: "create", file_text: longText });
  assert.equal(res.isError, true);
  // Draft must be reverted — still uncreated.
  assert.equal(draft.isCreated(), false);
  // Error text mentions "token budget" or "overage".
  const text = res.content[0].type === "text" ? (res.content[0] as { text: string }).text : "";
  assert.ok(text.includes("token"), `error should mention tokens: ${text}`);
});

test("session_record_tool: budget error carries details with overage", async () => {
  const { tool } = makeTool(1);
  const res = await call(tool, { command: "create", file_text: "x ".repeat(100) });
  assert.equal(res.isError, true);
  const details = res.details as Record<string, unknown> | null;
  assert.ok(details !== null, "details should be present on budget error");
  assert.ok(typeof details.overage === "number" && (details.overage as number) > 0);
});

test("session_record_tool: budget applies per-edit — second edit can fail and first survives", async () => {
  // Limit: 50 tokens. First create is fine; a second big str_replace is rejected.
  const { draft, tool } = makeTool(50);
  const res1 = await call(tool, { command: "create", file_text: "Short." });
  assert.ok(!res1.isError);

  const res2 = await call(tool, {
    command: "str_replace",
    old_str: "Short.",
    new_str: "w ".repeat(500),
  });
  assert.equal(res2.isError, true);
  // Original content survives.
  assert.ok(draft.getContent().includes("Short."));
});

// ── finalize on empty draft ───────────────────────────────────────────────────

test("session_record_tool: finalize on empty draft terminates without error", async () => {
  const { draft, tool } = makeTool();
  assert.equal(draft.isCreated(), false);
  const res = await call(tool, { command: "finalize" });
  // Terminates.
  assert.equal(res.terminate, true);
  // No error.
  assert.ok(!res.isError);
  // Draft still not created.
  assert.equal(draft.isCreated(), false);
  // Text says "nothing recorded".
  const text = res.content[0].type === "text" ? (res.content[0] as { text: string }).text : "";
  assert.ok(text.includes("nothing"), `expected 'nothing' in finalize-empty response: ${text}`);
});

// ── finalize on non-empty draft ──────────────────────────────────────────────

test("session_record_tool: finalize on non-empty draft terminates with token count", async () => {
  const { tool } = makeTool();
  await call(tool, { command: "create", file_text: "Real work was done." });
  const res = await call(tool, { command: "finalize" });
  assert.equal(res.terminate, true);
  assert.ok(!res.isError);
  const text = res.content[0].type === "text" ? (res.content[0] as { text: string }).text : "";
  assert.ok(text.includes("finalized"), `expected 'finalized' in response: ${text}`);
  // Details should include tokens.
  const details = res.details as Record<string, unknown> | null;
  assert.ok(details !== null);
  assert.ok(typeof details.tokens === "number");
});

// ── finalize via view ────────────────────────────────────────────────────────

test("session_record_tool: view with finalize:true terminates", async () => {
  const { tool } = makeTool();
  await call(tool, { command: "create", file_text: "Content." });
  const res = await call(tool, { command: "view", finalize: true });
  assert.equal(res.terminate, true);
  assert.ok(!res.isError);
});

test("session_record_tool: view without finalize does not terminate", async () => {
  const { tool } = makeTool();
  await call(tool, { command: "create", file_text: "Content." });
  const res = await call(tool, { command: "view" });
  assert.ok(!res.terminate);
});

// ── finalize via inline flag ─────────────────────────────────────────────────

test("session_record_tool: create with finalize:true terminates if within budget", async () => {
  const { tool } = makeTool(9999);
  const res = await call(tool, { command: "create", file_text: "Done.", finalize: true });
  assert.ok(!res.isError);
  assert.equal(res.terminate, true);
});

test("session_record_tool: budget error with finalize:true does not terminate", async () => {
  // Over budget errors should never terminate — the agent needs to recover.
  const { tool } = makeTool(1);
  const res = await call(tool, { command: "create", file_text: "x ".repeat(100), finalize: true });
  assert.equal(res.isError, true);
  assert.ok(!res.terminate, "budget error must not terminate even with finalize:true");
});

// ── view on empty draft ───────────────────────────────────────────────────────

test("session_record_tool: view on empty draft returns placeholder message", async () => {
  const { tool } = makeTool();
  const res = await call(tool, { command: "view" });
  assert.ok(!res.isError);
  const text = res.content[0].type === "text" ? (res.content[0] as { text: string }).text : "";
  assert.ok(text.includes("empty"), `expected 'empty' in view-empty response: ${text}`);
});
