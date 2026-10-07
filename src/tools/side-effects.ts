/**
 * Tool side effects (spec REFUSAL-HANDLING §8.4, shared with SESSION-RECORDS §9):
 * whether a tool call can be discarded and redone, or left an effect a redo must
 * not repeat. The fork point of a redo is the later of the last delivered message
 * and the last irreversible tool effect.
 *
 * Every name here is checked against the tool factories (test/side-effects.test.ts).
 * Unknown names, and every MCP tool (`mcp_<server>_<tool>`), are irreversible: the
 * safe direction only moves the fork point later.
 */

/**
 * `redo_safe`: no external effect. `repeatable`: no effect anyone else sees, but
 * repeating it costs money or time (its result is replayed on a redo).
 * `undoable`: visible, with a compensating action. `irreversible`: anything else.
 */
export type ToolEffect = "redo_safe" | "repeatable" | "undoable" | "irreversible";

/** Tools that post or edit model-written text in a chat (the output gate's tools, §6.1). */
const POSTING_TOOLS = new Set(["send_message", "send_dm", "send_to_channel", "edit_message", "create_poll"]);

/** Reads, searches, fetches and control-flow tools: no external effect, safe to redo. */
const REDO_SAFE_TOOLS = new Set([
  // chat reads
  "read_messages",
  "search_messages",
  "search_summaries",
  "expand_summary",
  "recap",
  "user_activity",
  "member_info",
  "channel_info",
  "list_channels",
  "list_members",
  "list_reactions",
  "emoji_list",
  // memory and profile reads
  "recall_memory",
  "search_memory",
  "user_profile_read",
  "character_card_read",
  "read_session_record",
  "read_session_transcript",
  // workspace reads
  "search_files",
  "read_image",
  // web and media fetches (downloads into the workspace are idempotent)
  "web_fetch",
  "web_search",
  "exa_search",
  "exa_search_advanced",
  "exa_fetch",
  "exa_research_list",
  "exa_research_result",
  "x_fetch",
  "x_search",
  "youtube_fetch",
  "yotsuba",
  "danbooru",
  "find_source",
  // media analysis with a model (posts nothing)
  "media",
  // control flow
  "load_skill",
  "tool_search",
  "no_reply",
]);

/**
 * Irreversible, listed for documentation and the coverage test (anything not
 * redo-safe is irreversible anyway): posting and editing, reactions and votes,
 * deletes and pins, workspace / memory / profile writes, sandbox shell, browser
 * actions, image generation, session spawning and delegation, and the
 * background jobs' draft tools (their in-memory draft is not rewound by a fork).
 */
export const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
  ...POSTING_TOOLS,
  "react",
  "poll_vote",
  "delete_message",
  "pins",
  "str_replace_based_edit_tool",
  "write_memory",
  "user_profile_edit",
  "character_card_create",
  "character_card_edit",
  "set_profile",
  "dm_optout",
  "bash",
  "browser",
  "image_generate",
  "exa_research",
  "exa_research_cancel",
  "spawn_session",
  "delegate_to_session",
  "summary_tool",
  "diary_tool",
  "session_record_tool",
]);

export const REDO_SAFE_TOOL_NAMES: ReadonlySet<string> = REDO_SAFE_TOOLS;
export const POSTING_TOOL_NAMES: ReadonlySet<string> = POSTING_TOOLS;

/**
 * The side effect of a tool call. `args` refines tools whose actions differ:
 * `pins` with `action = "list"` is a read.
 */
export function toolEffect(name: string, args?: unknown): ToolEffect {
  if (REDO_SAFE_TOOLS.has(name)) return "redo_safe";
  if (name === "pins" && isRecord(args) && args["action"] === "list") return "redo_safe";
  return "irreversible";
}

/** True for tools that post or edit model-written text in a chat. */
export function isPostingTool(name: string): boolean {
  return POSTING_TOOLS.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
