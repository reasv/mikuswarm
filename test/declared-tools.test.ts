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
const text = { references: false };
const refs = { references: true };
const assistantCall = (id: string, name: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: 1 }) as any;
const result = (id: string, name: string, added?: string[]) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1, ...(added ? { addedToolNames: added } : {}) }) as any;

test("declareDeferredTools: tools is always the whole catalog in catalog order, whatever is loaded", () => {
  const loadedOnly = [catalog[0], catalog[2]];
  const before = declareDeferredTools({ systemPrompt: "s", tools: loadedOnly, messages: [user("hi")] } as any, set, text);
  const after = declareDeferredTools({ systemPrompt: "s", tools: [...loadedOnly, catalog[1]], messages: [user("hi"), result("1", "tool_search", ["roll_dice"])] } as any, set, text);
  assert.deepEqual(before.tools!.map((t) => t.name), ["send_message", "roll_dice", "tool_search", "flip_coin"]);
  assert.deepEqual(after.tools, before.tools, "a load does not change the tools array");
  assert.equal(before.systemPrompt, "s");
});

test("declareDeferredTools: with references on, the load point is left to the driver's tool_reference block (no text)", () => {
  const load = result("1", "tool_search", ["roll_dice", "flip_coin"]);
  const messages = [user("hi"), assistantCall("1", "tool_search"), load];
  const out = declareDeferredTools({ tools: [], messages } as any, set, refs);
  assert.equal(out.messages[2], load, "untouched: the driver emits the reference");
  assert.equal(out.tools!.length, 4, "the catalog is still declared in full");
});

test("declareDeferredTools: with references on, a tool the model called BEFORE loading it still gets its definition as text", () => {
  // pi-ai's splitDeferredTools treats a name used before its load point as already in
  // use and emits no tool_reference for it, so the definition must arrive as text.
  const load = result("2", "tool_search", ["roll_dice", "flip_coin"]);
  const messages = [user("hi"), assistantCall("0", "roll_dice"), result("0", "roll_dice"), assistantCall("2", "tool_search"), load];
  const out = declareDeferredTools({ tools: [], messages } as any, set, refs);
  const content = (out.messages[4] as any).content;
  assert.equal(content.length, 2);
  assert.equal(content[1].text, renderLoadedToolDefinitions([catalog[1]]), "only the already-called tool, flip_coin gets a reference");
});

test("declareDeferredTools: a load point gets the added definitions as one extra text block, identically on every replay", () => {
  const load = result("1", "tool_search", ["roll_dice", "flip_coin"]);
  const messages = [user("hi"), load, result("2", "roll_dice")];
  const a = declareDeferredTools({ tools: [], messages } as any, set, text);
  const b = declareDeferredTools({ tools: [], messages } as any, set, text);
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
  const out = declareDeferredTools({ tools: [], messages } as any, set, text);
  assert.equal(out.messages[0], messages[0]);
});

test("withDeclaredDeferredTools: no registry (session without dynamic loading) → context untouched", () => {
  const seen: any[] = [];
  const base = ((_m: unknown, context: unknown) => { seen.push(context); return "stream"; }) as any;
  const context = { tools: [catalog[0]], messages: [user("hi")] };
  assert.equal(withDeclaredDeferredTools(base, () => undefined)({} as any, context as any, undefined), "stream");
  assert.equal(seen[0], context);
  withDeclaredDeferredTools(base, () => set, text)({} as any, context as any, undefined);
  assert.equal(seen[1].tools.length, 4);
});

test("makeDeferLoadingInjector: catalog order + defer_loading on non-immediate tools, only for a member that opted in", () => {
  const wire = (t: any, extra: object = {}) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...extra });
  const payload = { model: "m", tools: catalog.map((t) => wire(t)) };
  const inject = makeDeferLoadingInjector(() => set);
  const out = inject(payload, { compat: { declareDeferredTools: true } }) as any;
  assert.deepEqual(out.tools.map((t: any) => [t.name, t.defer_loading === true]), [["send_message", false], ["roll_dice", true], ["tool_search", false], ["flip_coin", true]]);
  assert.equal("defer_loading" in payload.tools[1], false, "the input payload is not mutated");
  assert.equal(inject(payload, { compat: {} }), payload, "member without the option → untouched");
  assert.equal(inject(payload, undefined), payload);
  assert.equal(makeDeferLoadingInjector(() => undefined)(payload, { compat: { declareDeferredTools: true } }), payload, "no registry → untouched");
});

test("makeDeferLoadingInjector: the tools array is byte-identical before and after a load, however the driver ordered it", () => {
  const wire = (t: any, extra: object = {}) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...extra });
  const inject = makeDeferLoadingInjector(() => set);
  const member = { compat: { declareDeferredTools: true } };
  // Before any load the driver sends the catalog in order, all plain.
  const before = inject({ tools: catalog.map((t) => wire(t)) }, member) as any;
  // After loading roll_dice by reference the driver moves it to the END, marked deferred.
  const after = inject({ tools: [wire(catalog[0]), wire(catalog[2]), wire(catalog[3]), wire(catalog[1], { defer_loading: true })] }, member) as any;
  assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools));
});

test("makeDeferLoadingInjector: a cache_control marker stays on the last non-deferred tool", () => {
  const wire = (t: any, extra: object = {}) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...extra });
  const inject = makeDeferLoadingInjector(() => set);
  const marker = { type: "ephemeral" };
  const out = inject({ tools: [wire(catalog[0]), wire(catalog[1]), wire(catalog[2]), wire(catalog[3], { cache_control: marker })] }, { compat: { declareDeferredTools: true } }) as any;
  assert.deepEqual(out.tools.map((t: any) => [t.name, t.cache_control ?? null]), [["send_message", null], ["roll_dice", null], ["tool_search", marker], ["flip_coin", null]]);
});
