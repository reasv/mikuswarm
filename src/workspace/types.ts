import type { CanonicalChatEvent, InboundChatEvent } from "../types.js";
import type { AgentSessionRecord } from "../agent/session-manager.js";

/**
 * Input for rendering the satellite block's runtime state section.
 *
 * `activeSessions` uses a Pick of AgentSessionRecord to stay coupled with the
 * canonical session record type, avoiding silent structural drift.
 */
export interface SatelliteRuntimeInput {
  timelineKey: string;
  trigger: CanonicalChatEvent;
  activeSessions: Array<Pick<AgentSessionRecord, "id" | "createdAt" | "trigger">>;
  /**
   * Human-readable channel label for `<runtime_state>` — `Name (Space)` (the
   * same descriptor the diary header uses), resolved from the current room by
   * the builder's injected `resolveChannelContext` hook. Undefined when the
   * timeline isn't a resolvable Matrix room or resolution failed; the Channel
   * line is then omitted (the raw timeline key still identifies the room).
   */
  channelLabel?: string;
  /**
   * Whether the current timeline is a direct message, resolved alongside
   * {@link channelLabel}. Undefined when unresolved → the Type line is omitted.
   */
  isDirect?: boolean;
  /**
   * The building session's own id (spec DUPLICATE-REPLY-MITIGATION §4.2). Used to
   * count *other* active sessions when deciding whether to emit the code-owned
   * `<coordination>` explanation line for `<handled_by_session>` markers. Undefined
   * for builds with no owning session (e.g. the room-context preview), where every
   * listed session counts as "other".
   */
  selfSessionId?: string;
  now?: Date;
  /** When true, the <runtime_state> section is omitted (summarization builds). */
  suppressRuntimeState?: boolean;
}

/**
 * Workspace content loaded from disk at session creation time.
 */
export interface WorkspaceContent {
  /** Loaded workspace files keyed by filename (e.g. "AGENTS.md" → content). */
  files: Map<string, string>;
  /** Content of the tail instructions file, or null if not found. */
  tailContent: string | null;
  /** Scanned skill metadata. */
  skills: SkillIndex;
}

export interface SkillMeta {
  /** Unique identifier from frontmatter (kebab-case). */
  name: string;
  /** One-line description from frontmatter. */
  description: string;
  /** Path relative to workspace root (e.g. "skills/character-cards/SKILL.md"). */
  path: string;
  /** When true, the full skill content is inlined in the system prompt. */
  alwaysLoaded: boolean;
  /** Full body content (frontmatter stripped). Only populated for always_loaded skills. */
  content?: string;
}

export interface SkillIndex {
  /** Skills shown in the <available_skills> list (always_loaded: false). */
  listed: SkillMeta[];
  /** Skills with always_loaded: true — their content is inlined in the system prompt. */
  inlined: SkillMeta[];
}

// Re-export isNodeError from shared types for backward compatibility.
// Consumers that import from workspace/types.ts continue to work.
export { isNodeError } from "../types.js";

export interface SessionTypeConfig {
  /** Which workspace files to load. When undefined, all default files are loaded. */
  workspace_files?: string[];
  /** Tail instructions file path relative to workspace root. null suppresses tail entirely. */
  tail_file?: string | null;
  /** Session-specific instruction text for the satellite block. */
  session_instruction?: string;
  /** Which tools to provide. When undefined, all tools are provided. */
  tools?: string[];
  /** Which skills to surface. "all" = all, "none" = none, string[] = named subset. */
  skills?: "all" | "none" | string[];
  /** Model key from the `models` record in config. Defaults to "default". */
  model?: string;
  /**
   * Per-session-type runaway loop-breakers (ARCHITECTURE.md §9c/§4). When set,
   * `max_tool_calls` overrides the global `agent.sessions.max_tool_calls` for this
   * session type, and `max_turns` adds a completed-turn cap. NOT a wall-clock
   * timeout. Worker session types set these; chat leaves them unset (unbounded).
   */
  max_tool_calls?: number;
  max_turns?: number;
  /**
   * LLM-scheduler priority class (spec CONCURRENCY-AND-RATE-LIMITING §9.3).
   * Unset → the built-in per-session-type default
   * (src/agent/scheduler.ts defaultPriorityForSessionType).
   */
  priority?: "interactive" | "proactive" | "background" | "background_low";
  /**
   * Per-session-type context-token ceiling — an artificial OVERRIDE that tightens
   * the model's `context_window` (spec CONTEXT-LIMIT-UNIFICATION §2.2). Effective
   * ceiling = `min(context_window, max_context_tokens)`, considering the override
   * only when set; a session type can only tighten, never raise, the model
   * ceiling. Unset = the model's `context_window` is the (always-enforced)
   * ceiling. Worker session types set a conservative value to bound runaway
   * diary/summary sessions; interactive types leave it unset.
   */
  max_context_tokens?: number;
  /**
   * Per-session-type USD cost ceiling (spec SESSION-COST-LIMITS §3) — an OVERRIDE
   * of the global `agent.max_session_cost_usd`. Counts agent-loop + tool-use cost
   * (captioning excluded). Unset = inherits the global default; `0` = no cap even
   * when a global default is set.
   */
  max_session_cost_usd?: number;
}
