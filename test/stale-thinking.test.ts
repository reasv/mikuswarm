import assert from "node:assert/strict";
import test from "node:test";

import { dropStaleThinking, withStaleThinkingDropped } from "../src/agent/stale-thinking.js";

// ---------------------------------------------------------------------------
// Stale-thinking omission (`[models.<name>.compat] drop_stale_thinking`).
// Synthetic pi-ai messages: a thinking block is stale once the request prefix
// changed after it was produced (a tool load that grew `tools`, or a resume).
// ---------------------------------------------------------------------------

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as any;
const assistant = (...content: any[]) => ({ role: "assistant", content, timestamp: 1 }) as any;
const thinking = (t: string) => ({ type: "thinking", thinking: t, thinkingSignature: `sig-${t}` });
const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
const result = (id: string, name: string, added?: string[]) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1, ...(added ? { addedToolNames: added } : {}) }) as any;
const kinds = (m: any) => m.content.map((b: any) => b.type);

test("dropStaleThinking: no load point and no resume → same array, nothing touched", () => {
  const messages = [user("hi"), assistant(thinking("a"), call("1", "get")), result("1", "get"), assistant(thinking("b"), { type: "text", text: "done" })];
  assert.equal(dropStaleThinking(messages), messages);
});

test("dropStaleThinking: thinking before the LAST tool-load point is removed, later thinking kept", () => {
  const before = assistant(thinking("a"), call("1", "tool_search"));
  const between = assistant(thinking("b"), call("2", "load_skill"));
  const after = assistant(thinking("c"), call("3", "roll"));
  const messages = [user("hi"), before, result("1", "tool_search", ["roll"]), between, result("2", "load_skill", ["sing"]), after, result("3", "roll")];
  const out = dropStaleThinking(messages);
  assert.deepEqual(kinds(out[1]), ["toolCall"], "before the first load → stripped");
  assert.deepEqual(kinds(out[3]), ["toolCall"], "before the latest load → stripped");
  assert.deepEqual(kinds(out[5]), ["thinking", "toolCall"], "after the latest load → replayed unchanged");
  assert.equal(out[5], after, "untouched messages keep their identity");
  assert.deepEqual(kinds(before), ["thinking", "toolCall"], "the caller's messages are never mutated");
});

test("dropStaleThinking: atToolLoads=false keeps thinking across a load (append-only loading), still strips resumed turns", () => {
  const before = assistant(thinking("a"), call("1", "tool_search"));
  const resumedTurn = assistant(thinking("r"), { type: "text", text: "earlier" });
  const messages = [resumedTurn, user("hi"), before, result("1", "tool_search", ["roll"]), assistant(thinking("b"), call("2", "roll"))];
  assert.equal(dropStaleThinking([user("hi"), before, result("1", "tool_search", ["roll"])], { atToolLoads: false }).length, 3);
  const out = dropStaleThinking(messages, { atToolLoads: false, resumed: new WeakSet([resumedTurn]) });
  assert.deepEqual(kinds(out[0]), ["text"], "resumed turn stripped");
  assert.equal(out[2], before, "turn before the load keeps its thinking");
});

test("dropStaleThinking: an empty addedToolNames is not a load point", () => {
  const messages = [user("hi"), assistant(thinking("a"), call("1", "tool_search")), result("1", "tool_search", [])];
  assert.equal(dropStaleThinking(messages), messages);
});

test("dropStaleThinking: resumed-transcript turns are stripped wherever they sit", () => {
  const old = assistant(thinking("a"), { type: "text", text: "earlier answer" });
  const fresh = assistant(thinking("b"), call("1", "get"));
  const messages = [user("hi"), old, user("follow-up"), fresh, result("1", "get")];
  const out = dropStaleThinking(messages, { resumed: new WeakSet([old]) });
  assert.deepEqual(kinds(out[1]), ["text"]);
  assert.equal(out[3], fresh, "turns produced after the resume are kept");
});

test("dropStaleThinking: a thinking-only stale turn becomes empty (the provider driver skips it)", () => {
  const only = assistant(thinking("a"));
  const out = dropStaleThinking([user("hi"), only], { resumed: new WeakSet([only]) });
  assert.deepEqual(out[1].content, []);
});

test("withStaleThinkingDropped: forwards a rewritten context only when something changed", () => {
  const seen: any[] = [];
  const base = ((_model: unknown, context: unknown) => { seen.push(context); return "stream"; }) as any;
  const wrapped = withStaleThinkingDropped(base);
  const clean = { systemPrompt: "s", messages: [user("hi")], tools: [] };
  assert.equal(wrapped({} as any, clean as any, undefined), "stream");
  assert.equal(seen[0], clean, "unchanged context is passed through by reference");
  const loaded = { systemPrompt: "s", tools: [], messages: [user("hi"), assistant(thinking("a"), call("1", "tool_search")), result("1", "tool_search", ["roll"])] };
  wrapped({} as any, loaded as any, undefined);
  assert.notEqual(seen[1], loaded);
  assert.equal(seen[1].systemPrompt, "s");
  assert.deepEqual(kinds(seen[1].messages[1]), ["toolCall"]);
  assert.deepEqual(kinds(loaded.messages[1]), ["thinking", "toolCall"], "the session's own context is not mutated");
});
