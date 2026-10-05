/**
 * Tool side effects (spec REFUSAL-HANDLING §8.4): every first-party tool is
 * classified explicitly; unknown and MCP tools are irreversible.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  IRREVERSIBLE_TOOLS,
  POSTING_TOOL_NAMES,
  REDO_SAFE_TOOL_NAMES,
  isPostingTool,
  toolEffect,
} from "../src/tools/side-effects.js";

// Every tool name a factory under src/tools/ declares: `name: "x"` literals and
// `*_NAME = "x"` constants (load_skill, tool_search).
async function declaredToolNames(): Promise<Set<string>> {
  const dir = path.resolve(import.meta.dirname, "../src/tools");
  const names = new Set<string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".ts") || file === "side-effects.ts") continue;
    const source = await readFile(path.join(dir, file), "utf8");
    for (const m of source.matchAll(/\bname: "([a-z_]+)"/g)) names.add(m[1]!);
    for (const m of source.matchAll(/\b[A-Z_]+_NAME = "([a-z_]+)"/g)) names.add(m[1]!);
  }
  return names;
}

test("every declared tool is classified, and every classified name is a real tool", async () => {
  const declared = await declaredToolNames();
  assert.ok(declared.size >= 50, `found ${declared.size} tools`);
  for (const name of declared) {
    assert.ok(
      REDO_SAFE_TOOL_NAMES.has(name) !== IRREVERSIBLE_TOOLS.has(name),
      `${name} must be in exactly one of the redo-safe / irreversible lists`,
    );
  }
  for (const name of [...REDO_SAFE_TOOL_NAMES, ...IRREVERSIBLE_TOOLS]) {
    assert.ok(declared.has(name), `${name} is listed but no tool declares it`);
  }
});

test("toolEffect: reads redo-safe; posting, writes, shell, browser irreversible", () => {
  for (const name of ["read_messages", "search_messages", "recall_memory", "web_search", "x_search", "youtube_fetch",
    "yotsuba", "danbooru", "find_source", "read_image", "emoji_list", "list_members", "member_info", "channel_info",
    "expand_summary", "recap", "user_activity", "user_profile_read", "character_card_read", "read_session_record",
    "read_session_transcript", "load_skill", "tool_search", "search_files", "no_reply", "media"]) {
    assert.equal(toolEffect(name), "redo_safe", name);
  }
  for (const name of ["send_message", "send_dm", "send_to_channel", "edit_message", "create_poll", "react", "poll_vote",
    "delete_message", "pins", "str_replace_based_edit_tool", "write_memory", "user_profile_edit", "character_card_create",
    "character_card_edit", "set_profile", "dm_optout", "bash", "browser", "image_generate", "spawn_session",
    "delegate_to_session"]) {
    assert.equal(toolEffect(name), "irreversible", name);
  }
});

test("toolEffect: MCP and unknown tools are irreversible; pins list is a read", () => {
  assert.equal(toolEffect("mcp_exa_web_search_exa"), "irreversible");
  assert.equal(toolEffect("mcp_server_read_file"), "irreversible");
  assert.equal(toolEffect("some_future_tool"), "irreversible");
  assert.equal(toolEffect(""), "irreversible");
  assert.equal(toolEffect("pins", { action: "list" }), "redo_safe");
  assert.equal(toolEffect("pins", { action: "pin", message_id: "x" }), "irreversible");
  assert.equal(toolEffect("pins", "list"), "irreversible");
});

test("isPostingTool: the gated message tools only", () => {
  assert.deepEqual([...POSTING_TOOL_NAMES].sort(), ["create_poll", "edit_message", "send_dm", "send_message", "send_to_channel"]);
  for (const name of POSTING_TOOL_NAMES) assert.equal(isPostingTool(name), true);
  for (const name of ["media", "react", "no_reply", "image_generate", "mcp_x_post"]) assert.equal(isPostingTool(name), false, name);
});
