/**
 * Tool effect classes (spec LATE-INPUT §4.1, REFUSAL-HANDLING §8.4): whether a
 * tool call can be discarded and redone, or left an effect a redo must not
 * repeat (or must first compensate). The refusal/contract fork point is the
 * later of the last delivered message and the last tool effect that is not
 * `redo_safe`.
 *
 * Every first-party name here is checked against the tool factories
 * (test/side-effects.test.ts). MCP tools (`mcp_<server>_<tool>`) take the class
 * the MCP adapter registers for them ({@link registerToolEffect}: the server's
 * tool annotations, or the per-server `effects` override). Unknown names are
 * irreversible: the safe direction only moves the fork point later.
 */

/**
 * `redo_safe`: no external effect. `repeatable`: no effect anyone else sees, but
 * repeating it costs money or time (its result is replayed on a redo).
 * `undoable`: visible, with a compensating action ({@link compensationFor}).
 * `irreversible`: anything else.
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
  // web and media fetches (downloads into the workspace are idempotent; paid
  // reads such as web_search and x_search stay here, their cost is covered by replay)
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
 * No effect anyone else sees, but repeating the call costs money or time:
 * image generation (a paid model call; the file lands in the workspace and is
 * posted only by a later send) and starting a paid Exa research job.
 */
const REPEATABLE_TOOLS = new Set(["image_generate", "exa_research"]);

/**
 * Visible, with a compensating call through the same tool
 * ({@link compensationFor}): a reaction (added or removed) and a pin or unpin.
 * `pins` is args-refined: `list` is a read, a call without a known action is
 * irreversible.
 */
const UNDOABLE_TOOLS = new Set(["react", "pins"]);

/**
 * Irreversible, listed for documentation and the coverage test (anything not
 * listed elsewhere is irreversible anyway): posting and editing, votes,
 * deletes, workspace / memory / profile writes, sandbox shell, browser actions,
 * Exa research cancellation, session spawning and delegation, and the
 * background jobs' draft tools (their in-memory draft is not rewound by a fork).
 * `str_replace_based_edit_tool` and `browser` are args-refined: their read
 * actions are redo-safe.
 */
export const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
  ...POSTING_TOOLS,
  "poll_vote",
  "delete_message",
  "str_replace_based_edit_tool",
  "write_memory",
  "user_profile_edit",
  "character_card_create",
  "character_card_edit",
  "set_profile",
  "dm_optout",
  "bash",
  "browser",
  "exa_research_cancel",
  "spawn_session",
  "delegate_to_session",
  "summary_tool",
  "diary_tool",
  "session_record_tool",
]);

export const REDO_SAFE_TOOL_NAMES: ReadonlySet<string> = REDO_SAFE_TOOLS;
export const REPEATABLE_TOOL_NAMES: ReadonlySet<string> = REPEATABLE_TOOLS;
export const UNDOABLE_TOOL_NAMES: ReadonlySet<string> = UNDOABLE_TOOLS;
export const POSTING_TOOL_NAMES: ReadonlySet<string> = POSTING_TOOLS;

/** Tools whose class depends on their arguments (see {@link toolEffect}). */
export const ARGS_REFINED_TOOL_NAMES: ReadonlySet<string> = new Set(["pins", "str_replace_based_edit_tool", "browser"]);

/**
 * `browser` actions that only read or navigate: going to a URL (the GET a
 * navigation makes, like `web_fetch`), snapshots, screenshots, the console
 * buffer, and opening, listing or switching tabs. `close`, `pdf` (a workspace
 * write) and every `act` kind not in {@link BROWSER_READ_ACT_KINDS} are
 * irreversible.
 */
export const BROWSER_READ_ACTIONS: ReadonlySet<string> = new Set(["navigate", "snapshot", "screenshot", "console", "tabs", "open"]);

/**
 * `browser` `act` kinds that only move the view or wait: hover, scroll, wait,
 * and history back. Clicks, typing, key presses, fills, selects, drags,
 * uploads, `evaluate`, `dialog` and `clear_site_data` are irreversible.
 */
export const BROWSER_READ_ACT_KINDS: ReadonlySet<string> = new Set(["hover", "scroll", "wait", "back"]);

/** Effects registered at runtime by full exposed tool name (MCP tools). */
const registered = new Map<string, ToolEffect>();

/**
 * Register the effect class of a tool not in the first-party lists, by its full
 * exposed name (`mcp_<server>_<tool>`). The MCP adapter calls this for every
 * tool it adapts; a later registration of the same name replaces the earlier
 * one. First-party names are never overridden by a registration.
 */
export function registerToolEffect(name: string, effect: ToolEffect): void {
  registered.set(name, effect);
}

/**
 * The effect class an MCP tool's annotations imply (spec LATE-INPUT §4.1):
 * `readOnlyHint: true` → `redo_safe`; `idempotentHint: true` with
 * `destructiveHint: false` → `repeatable`; anything else, or no annotations,
 * → `irreversible`. A per-server override (`[mcp.servers.<name>].effects`,
 * keyed by the bare tool name) wins over the annotations.
 */
export function mcpToolEffect(annotations: unknown, override?: ToolEffect): ToolEffect {
  if (override !== undefined) return override;
  if (!isRecord(annotations)) return "irreversible";
  if (annotations["readOnlyHint"] === true) return "redo_safe";
  if (annotations["idempotentHint"] === true && annotations["destructiveHint"] === false) return "repeatable";
  return "irreversible";
}

/**
 * The side effect of a tool call. `args` refines tools whose actions differ:
 * `pins` (`list` is a read, `pin`/`unpin` undoable), `str_replace_based_edit_tool`
 * (`view` is a read) and `browser` (its read actions and view-only `act` kinds).
 * A refined tool whose args name no known action is irreversible.
 */
export function toolEffect(name: string, args?: unknown): ToolEffect {
  if (REDO_SAFE_TOOLS.has(name)) return "redo_safe";
  if (REPEATABLE_TOOLS.has(name)) return "repeatable";
  switch (name) {
    case "pins": {
      const action = isRecord(args) ? args["action"] : undefined;
      if (action === "list") return "redo_safe";
      if (action === "pin" || action === "unpin") return "undoable";
      return "irreversible";
    }
    case "str_replace_based_edit_tool":
      return isRecord(args) && args["command"] === "view" ? "redo_safe" : "irreversible";
    case "browser": {
      if (!isRecord(args)) return "irreversible";
      const action = args["action"];
      if (typeof action === "string" && BROWSER_READ_ACTIONS.has(action)) return "redo_safe";
      const kind = args["kind"];
      if (action === "act" && typeof kind === "string" && BROWSER_READ_ACT_KINDS.has(kind)) return "redo_safe";
      return "irreversible";
    }
  }
  if (UNDOABLE_TOOLS.has(name)) return "undoable";
  if (IRREVERSIBLE_TOOLS.has(name)) return "irreversible";
  return registered.get(name) ?? "irreversible";
}

/**
 * The inverse call that undoes an undoable call, through the same tool set;
 * undefined = cannot be compensated (the caller then treats the call as
 * irreversible). `react` is undone by the same reaction with `remove` flipped
 * (each provider's removal takes away only the agent's own reaction); `pins`
 * pin by unpin and unpin by pin. The inverse restores the state before the
 * call only when the call changed it (re-adding a reaction the agent had
 * already placed, then compensating, removes it). Registered (MCP) tools have
 * no known inverse.
 */
export function compensationFor(name: string, args: unknown): { name: string; args: Record<string, unknown> } | undefined {
  if (toolEffect(name, args) !== "undoable" || !isRecord(args)) return undefined;
  if (name === "react") {
    const messageId = args["message_id"];
    const emoji = args["emoji"];
    if (!nonBlank(messageId) || !nonBlank(emoji)) return undefined;
    return args["remove"] === true
      ? { name: "react", args: { message_id: messageId, emoji } }
      : { name: "react", args: { message_id: messageId, emoji, remove: true } };
  }
  if (name === "pins") {
    const messageId = args["message_id"];
    if (!nonBlank(messageId)) return undefined;
    return { name: "pins", args: { action: args["action"] === "pin" ? "unpin" : "pin", message_id: messageId } };
  }
  return undefined;
}

/** True for tools that post or edit model-written text in a chat. */
export function isPostingTool(name: string): boolean {
  return POSTING_TOOLS.has(name);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The inverse call that undoes an undoable call, through the same tool set;
 * undefined = it cannot be compensated (treated as irreversible).
 */
export function compensationFor(_name: string, _args: unknown): { name: string; args: Record<string, unknown> } | undefined {
  return undefined;
}
