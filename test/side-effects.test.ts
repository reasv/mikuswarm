/**
 * Tool effect classes (spec LATE-INPUT §4.1, REFUSAL-HANDLING §8.4): every
 * first-party tool is classified explicitly, args-refined tools per action,
 * MCP tools from their annotations or the per-server override, and every
 * undoable call has a compensation the tool accepts.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import { adaptMcpTools } from "../src/mcp/tool-adapter.js";
import type { McpClientPool } from "../src/mcp/client-pool.js";
import type { Logger } from "../src/observability/logger.js";
import { createReactTool } from "../src/tools/react.js";
import { createPinsTool } from "../src/tools/pins.js";
import type { ChannelClient } from "../src/types.js";
import {
  ARGS_REFINED_TOOL_NAMES,
  BROWSER_READ_ACTIONS,
  BROWSER_READ_ACT_KINDS,
  IRREVERSIBLE_TOOLS,
  POSTING_TOOL_NAMES,
  REDO_SAFE_TOOL_NAMES,
  REPEATABLE_TOOL_NAMES,
  UNDOABLE_TOOL_NAMES,
  compensationFor,
  isPostingTool,
  mcpToolEffect,
  registerToolEffect,
  toolEffect,
  type ToolEffect,
} from "../src/tools/side-effects.js";

const TOOLS_DIR = path.resolve(import.meta.dirname, "../src/tools");

// Every tool name a factory under src/tools/ declares: `name: "x"` literals and
// `*_NAME = "x"` constants (load_skill, tool_search).
async function declaredToolNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of await readdir(TOOLS_DIR)) {
    if (!file.endsWith(".ts") || file === "side-effects.ts") continue;
    const source = await readFile(path.join(TOOLS_DIR, file), "utf8");
    for (const m of source.matchAll(/\bname: "([a-z_]+)"/g)) names.add(m[1]!);
    for (const m of source.matchAll(/\bname: \w+ \? "([a-z_]+)" : "([a-z_]+)"/g)) { names.add(m[1]!); names.add(m[2]!); }
    for (const m of source.matchAll(/\b[A-Z_]+_NAME = "([a-z_]+)"/g)) names.add(m[1]!);
  }
  return names;
}

const LISTS: Record<ToolEffect, ReadonlySet<string>> = {
  redo_safe: REDO_SAFE_TOOL_NAMES,
  repeatable: REPEATABLE_TOOL_NAMES,
  undoable: UNDOABLE_TOOL_NAMES,
  irreversible: IRREVERSIBLE_TOOLS,
};

test("every declared tool is in exactly one class list, and every listed name is a real tool", async () => {
  const declared = await declaredToolNames();
  assert.ok(declared.size >= 50, `found ${declared.size} tools`);
  for (const name of declared) {
    const classes = Object.entries(LISTS).filter(([, set]) => set.has(name)).map(([c]) => c);
    assert.equal(classes.length, 1, `${name} must be in exactly one class list, found [${classes.join(", ")}]`);
  }
  for (const [effect, set] of Object.entries(LISTS)) {
    for (const name of set) {
      assert.ok(declared.has(name), `${name} is listed but no tool declares it`);
      // A listed, non-refined tool's class is its list.
      if (!ARGS_REFINED_TOOL_NAMES.has(name)) assert.equal(toolEffect(name), effect, name);
    }
  }
  for (const name of ARGS_REFINED_TOOL_NAMES) assert.ok(declared.has(name), name);
});

test("toolEffect: reads redo-safe; posting, writes, shell irreversible", () => {
  for (const name of ["read_messages", "search_messages", "recall_memory", "web_search", "x_search", "youtube_fetch",
    "yotsuba", "danbooru", "find_source", "read_image", "emoji_list", "list_members", "member_info", "channel_info",
    "expand_summary", "recap", "user_activity", "user_profile_read", "character_card_read", "read_session_record",
    "read_session_transcript", "load_skill", "tool_search", "search_files", "no_reply", "media"]) {
    assert.equal(toolEffect(name), "redo_safe", name);
  }
  for (const name of ["send_message", "send_dm", "send_to_channel", "edit_message", "create_poll", "poll_vote",
    "delete_message", "write_memory", "user_profile_edit", "character_card_create",
    "character_card_edit", "set_profile", "dm_optout", "bash", "spawn_session", "delegate_to_session",
    "exa_research_cancel", "summary_tool", "diary_tool", "session_record_tool"]) {
    assert.equal(toolEffect(name), "irreversible", name);
  }
});

test("toolEffect: repeatable and undoable tools", () => {
  assert.deepEqual([...REPEATABLE_TOOL_NAMES].sort(), ["exa_research", "image_generate"]);
  assert.equal(toolEffect("image_generate", { prompt: "x" }), "repeatable");
  assert.equal(toolEffect("exa_research", { query: "q" }), "repeatable");
  assert.deepEqual([...UNDOABLE_TOOL_NAMES].sort(), ["pins", "react"]);
  assert.equal(toolEffect("react", { message_id: "m", emoji: "👍" }), "undoable");
  assert.equal(toolEffect("react", { message_id: "m", emoji: "👍", remove: true }), "undoable");
  assert.equal(toolEffect("react"), "undoable");
});

test("Exa paid reads follow existing redo-safe read policy; create is repeatable, cancel irreversible", () => {
  for (const name of ["exa_search", "exa_search_advanced", "exa_fetch", "exa_research_list", "exa_research_result"]) assert.equal(toolEffect(name), "redo_safe", name);
  assert.equal(toolEffect("exa_research"), "repeatable");
  assert.equal(toolEffect("exa_research_cancel"), "irreversible");
});

test("toolEffect: unknown tools are irreversible; pins refined by action", () => {
  assert.equal(toolEffect("mcp_unregistered_read_file"), "irreversible");
  assert.equal(toolEffect("some_future_tool"), "irreversible");
  assert.equal(toolEffect(""), "irreversible");
  assert.equal(toolEffect("pins", { action: "list" }), "redo_safe");
  assert.equal(toolEffect("pins", { action: "pin", message_id: "x" }), "undoable");
  assert.equal(toolEffect("pins", { action: "unpin", message_id: "x" }), "undoable");
  assert.equal(toolEffect("pins", { action: "other" }), "irreversible");
  assert.equal(toolEffect("pins"), "irreversible");
  assert.equal(toolEffect("pins", "list"), "irreversible");
});

test("toolEffect: str_replace_based_edit_tool view is a read, every other command irreversible", async () => {
  const source = await readFile(path.join(TOOLS_DIR, "file.ts"), "utf8");
  const block = source.slice(source.indexOf('name: "str_replace_based_edit_tool"'), source.indexOf('name: "search_files"'));
  const commands = [...block.matchAll(/Type\.Literal\("([a-z_]+)"\)/g)].map((m) => m[1]!);
  assert.ok(commands.includes("view") && commands.length >= 4, `commands: ${commands.join(", ")}`);
  for (const command of commands) {
    assert.equal(toolEffect("str_replace_based_edit_tool", { command, path: "a" }), command === "view" ? "redo_safe" : "irreversible", command);
  }
  assert.equal(toolEffect("str_replace_based_edit_tool"), "irreversible");
  assert.equal(toolEffect("str_replace_based_edit_tool", { path: "a" }), "irreversible");
});

test("toolEffect: every browser action and act kind is classified", async () => {
  const source = await readFile(path.join(TOOLS_DIR, "browser.ts"), "utf8");
  const literal = (constName: string): string[] => {
    const m = source.match(new RegExp(`const ${constName}[^=]*= \\[([^\\]]*)\\]`));
    assert.ok(m, constName);
    return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
  };
  const actions = literal("ACTION_VALUES");
  const kinds = literal("ACT_KINDS");
  const expectAction: Record<string, ToolEffect> = {
    navigate: "redo_safe", snapshot: "redo_safe", screenshot: "redo_safe", console: "redo_safe", tabs: "redo_safe",
    open: "redo_safe", close: "irreversible", pdf: "irreversible",
  };
  const expectKind: Record<string, ToolEffect> = {
    hover: "redo_safe", scroll: "redo_safe", wait: "redo_safe", back: "redo_safe",
    click: "irreversible", type: "irreversible", press: "irreversible", select: "irreversible", fill: "irreversible",
    evaluate: "irreversible", drag: "irreversible", upload: "irreversible", clear_site_data: "irreversible", dialog: "irreversible",
  };
  for (const action of actions.filter((a) => a !== "act")) {
    assert.ok(action in expectAction, `browser action ${action} needs an explicit classification`);
    assert.equal(toolEffect("browser", { action }), expectAction[action], action);
  }
  for (const kind of kinds) {
    assert.ok(kind in expectKind, `browser act kind ${kind} needs an explicit classification`);
    assert.equal(toolEffect("browser", { action: "act", kind }), expectKind[kind], kind);
  }
  for (const a of BROWSER_READ_ACTIONS) assert.ok(actions.includes(a), a);
  for (const k of BROWSER_READ_ACT_KINDS) assert.ok(kinds.includes(k), k);
  assert.equal(toolEffect("browser"), "irreversible");
  assert.equal(toolEffect("browser", { action: "act" }), "irreversible");
  assert.equal(toolEffect("browser", { kind: "hover" }), "irreversible");
});

test("mcpToolEffect: annotations mapping and the override", () => {
  assert.equal(mcpToolEffect(undefined), "irreversible");
  assert.equal(mcpToolEffect({}), "irreversible");
  assert.equal(mcpToolEffect({ readOnlyHint: true }), "redo_safe");
  assert.equal(mcpToolEffect({ readOnlyHint: true, destructiveHint: true }), "redo_safe");
  assert.equal(mcpToolEffect({ idempotentHint: true, destructiveHint: false }), "repeatable");
  assert.equal(mcpToolEffect({ idempotentHint: true }), "irreversible");
  assert.equal(mcpToolEffect({ destructiveHint: false }), "irreversible");
  assert.equal(mcpToolEffect({ readOnlyHint: false, openWorldHint: true }), "irreversible");
  assert.equal(mcpToolEffect({ readOnlyHint: "true" }), "irreversible");
  assert.equal(mcpToolEffect({ readOnlyHint: true }, "irreversible"), "irreversible");
  assert.equal(mcpToolEffect(undefined, "redo_safe"), "redo_safe");
});

test("MCP adapter registers each tool's effect from annotations, override winning", () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger } as unknown as Logger;
  const def = (name: string, annotations?: McpToolDef["annotations"]): McpToolDef =>
    ({ name, inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) }) as McpToolDef;
  const tools = adaptMcpTools("fxsrv", [
    def("read_file", { readOnlyHint: true }),
    def("render", { idempotentHint: true, destructiveHint: false }),
    def("write_file", { destructiveHint: true }),
    def("plain"),
    def("lookup"),
    def("dangerous_read", { readOnlyHint: true }),
  ], {} as McpClientPool, logger, { lookup: "redo_safe", dangerous_read: "irreversible" });
  assert.deepEqual(tools.map((t) => t.name), [
    "mcp_fxsrv_read_file", "mcp_fxsrv_render", "mcp_fxsrv_write_file", "mcp_fxsrv_plain", "mcp_fxsrv_lookup", "mcp_fxsrv_dangerous_read",
  ]);
  assert.equal(toolEffect("mcp_fxsrv_read_file"), "redo_safe");
  assert.equal(toolEffect("mcp_fxsrv_render"), "repeatable");
  assert.equal(toolEffect("mcp_fxsrv_write_file"), "irreversible");
  assert.equal(toolEffect("mcp_fxsrv_plain"), "irreversible");
  assert.equal(toolEffect("mcp_fxsrv_lookup"), "redo_safe");
  assert.equal(toolEffect("mcp_fxsrv_dangerous_read"), "irreversible");
  // A registered MCP tool has no compensation, even when an override calls it undoable.
  registerToolEffect("mcp_fxsrv_toggle", "undoable");
  assert.equal(toolEffect("mcp_fxsrv_toggle"), "undoable");
  assert.equal(compensationFor("mcp_fxsrv_toggle", {}), undefined);
});

test("registerToolEffect never overrides a first-party classification", () => {
  registerToolEffect("send_message", "redo_safe");
  registerToolEffect("read_messages", "irreversible");
  assert.equal(toolEffect("send_message"), "irreversible");
  assert.equal(toolEffect("read_messages"), "redo_safe");
});

test("compensationFor: the inverse of every undoable call, accepted by the tool itself", async () => {
  const calls: string[] = [];
  const client = {
    react: async (id: string, emoji: string) => { calls.push(`react ${id} ${emoji}`); return { display: emoji }; },
    unreact: async (id: string, emoji: string) => { calls.push(`unreact ${id} ${emoji}`); return { removed: 1 }; },
    pinMessage: async (id: string) => { calls.push(`pin ${id}`); },
    unpinMessage: async (id: string) => { calls.push(`unpin ${id}`); },
  } as unknown as ChannelClient;
  const tools = { react: createReactTool({ channelClient: client }), pins: createPinsTool({ channelClient: client }) };
  const cases: { name: "react" | "pins"; args: Record<string, unknown>; inverse: Record<string, unknown>; effect: string }[] = [
    { name: "react", args: { message_id: "$m", emoji: "👍" }, inverse: { message_id: "$m", emoji: "👍", remove: true }, effect: "unreact $m 👍" },
    { name: "react", args: { message_id: "$m", emoji: ":blob:", remove: true }, inverse: { message_id: "$m", emoji: ":blob:" }, effect: "react $m :blob:" },
    { name: "react", args: { message_id: "$m", emoji: "👍", remove: false }, inverse: { message_id: "$m", emoji: "👍", remove: true }, effect: "unreact $m 👍" },
    { name: "pins", args: { action: "pin", message_id: "$p" }, inverse: { action: "unpin", message_id: "$p" }, effect: "unpin $p" },
    { name: "pins", args: { action: "unpin", message_id: "$p" }, inverse: { action: "pin", message_id: "$p" }, effect: "pin $p" },
  ];
  for (const c of cases) {
    const comp = compensationFor(c.name, c.args);
    assert.deepEqual(comp, { name: c.name, args: c.inverse }, JSON.stringify(c.args));
    // The compensation is itself undoable, and its inverse is the original call's effect.
    assert.equal(toolEffect(comp!.name, comp!.args), "undoable");
    calls.length = 0;
    const result = await tools[c.name].execute("t", comp!.args, undefined);
    assert.ok(!JSON.stringify(result.content).includes("error"), JSON.stringify(result.content));
    assert.deepEqual(calls, [c.effect]);
  }
  for (const name of UNDOABLE_TOOL_NAMES) assert.ok(cases.some((c) => c.name === name), `${name} needs a compensation case`);
});

test("compensationFor: undefined for anything that is not a well-formed undoable call", () => {
  assert.equal(compensationFor("pins", { action: "list" }), undefined);
  assert.equal(compensationFor("pins", { action: "pin" }), undefined);
  assert.equal(compensationFor("pins", { action: "pin", message_id: " " }), undefined);
  assert.equal(compensationFor("react", { message_id: "m" }), undefined);
  assert.equal(compensationFor("react", { emoji: "👍" }), undefined);
  assert.equal(compensationFor("react", undefined), undefined);
  assert.equal(compensationFor("send_message", { body: "x" }), undefined);
  assert.equal(compensationFor("image_generate", { prompt: "x" }), undefined);
  assert.equal(compensationFor("read_messages", {}), undefined);
});

test("isPostingTool: the gated message tools only", () => {
  assert.deepEqual([...POSTING_TOOL_NAMES].sort(), ["create_poll", "edit_message", "send_dm", "send_message", "send_to_channel"]);
  for (const name of POSTING_TOOL_NAMES) assert.equal(isPostingTool(name), true);
  for (const name of ["media", "react", "no_reply", "image_generate", "mcp_x_post"]) assert.equal(isPostingTool(name), false, name);
});
