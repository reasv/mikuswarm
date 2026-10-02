import assert from "node:assert/strict";
import test from "node:test";

import {
  declareDeferredTools,
  makeDeferLoadingInjector,
  renderLoadedToolDefinitions,
  withDeclaredDeferredTools,
} from "../src/agent/declared-tools.js";

// ---------------------------------------------------------------------------
// Declared-deferred tool loading (`[models.<name>.compat] declare_deferred_tools`).
// `tools` is the whole catalog on every request; a load is text appended to the
// loading tool's result. Synthetic pi-ai contexts and Messages API payloads.
// ---------------------------------------------------------------------------

const tool = (name: string) => ({ name, description: `${name} description`, parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } }) as any;
const catalog = [tool("send_message"), tool("roll_dice"), tool("tool_search"), tool("flip_coin")];
const set = { catalog, immediate: new Set(["send_message", "tool_search"]) };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as any;
const result = (id: string, name: string, added?: string[]) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1, ...(added ? { addedToolNames: added } : {}) }) as any;

test("declareDeferredTools: tools is always the whole catalog in catalog order, whatever is loaded", () => {
  const loadedOnly = [catalog[0], catalog[2]];
  const before = declareDeferredTools({ systemPrompt: "s", tools: loadedOnly, messages: [user("hi")] } as any, set);
  const after = declareDeferredTools({ systemPrompt: "s", tools: [...loadedOnly, catalog[1]], messages: [user("hi"), result("1", "tool_search", ["roll_dice"])] } as any, set);
  assert.deepEqual(before.tools!.map((t) => t.name), ["send_message", "roll_dice", "tool_search", "flip_coin"]);
  assert.deepEqual(after.tools, before.tools, "a load does not change the tools array");
  assert.equal(before.systemPrompt, "s");
});

test("declareDeferredTools: a load point gets the added definitions as one extra text block, identically on every replay", () => {
  const load = result("1", "tool_search", ["roll_dice", "flip_coin"]);
  const messages = [user("hi"), load, result("2", "roll_dice")];
  const a = declareDeferredTools({ tools: [], messages } as any, set);
  const b = declareDeferredTools({ tools: [], messages } as any, set);
  const content = (a.messages[1] as any).content;
  assert.equal(content.length, 2);
  assert.equal(content[0].text, "ok", "the tool's own result is kept first");
  assert.equal(content[1].text, renderLoadedToolDefinitions([catalog[1], catalog[3]]));
  assert.match(content[1].text, /roll_dice\nroll_dice description\nInput schema \(JSON Schema\): \{"type":"object"/);
  assert.deepEqual(a.messages, b.messages, "deterministic: the appended block never differs between requests");
  assert.equal(a.messages[2], messages[2], "results that loaded nothing are passed through untouched");
  assert.equal(load.content.length, 1, "the session's own message is not mutated");
});

test("declareDeferredTools: immediate and unknown names in addedToolNames add no text", () => {
  const messages = [result("1", "load_skill", ["send_message", "not_in_catalog"])];
  const out = declareDeferredTools({ tools: [], messages } as any, set);
  assert.equal(out.messages[0], messages[0]);
});

test("withDeclaredDeferredTools: no registry (session without dynamic loading) → context untouched", () => {
  const seen: any[] = [];
  const base = ((_m: unknown, context: unknown) => { seen.push(context); return "stream"; }) as any;
  const context = { tools: [catalog[0]], messages: [user("hi")] };
  assert.equal(withDeclaredDeferredTools(base, () => undefined)({} as any, context as any, undefined), "stream");
  assert.equal(seen[0], context);
  withDeclaredDeferredTools(base, () => set)({} as any, context as any, undefined);
  assert.equal(seen[1].tools.length, 4);
});

test("makeDeferLoadingInjector: marks non-immediate tools defer_loading only for a member that opted in", () => {
  const payload = { model: "m", tools: catalog.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) };
  const inject = makeDeferLoadingInjector(() => set.immediate);
  const out = inject(payload, { compat: { declareDeferredTools: true } }) as any;
  assert.deepEqual(out.tools.map((t: any) => [t.name, t.defer_loading === true]), [["send_message", false], ["roll_dice", true], ["tool_search", false], ["flip_coin", true]]);
  assert.equal("defer_loading" in payload.tools[1], false, "the input payload is not mutated");
  assert.equal(inject(payload, { compat: {} }), payload, "member without the option → untouched");
  assert.equal(inject(payload, undefined), payload);
  assert.equal(makeDeferLoadingInjector(() => undefined)(payload, { compat: { declareDeferredTools: true } }), payload, "no registry → untouched");
});
