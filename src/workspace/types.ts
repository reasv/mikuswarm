import type { CanonicalChatEvent } from "../types.js";

/**
 * Input for rendering the satellite block's runtime state section.
 */
export interface SatelliteRuntimeInput {
  timelineKey: string;
  trigger: CanonicalChatEvent;
  activeSessions: Array<{
    id: string;
    createdAt: number;
    trigger: { event: { body: string } };
  }>;
  now?: Date;
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

/**
 * Resolved session type configuration used during workspace loading and context building.
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

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
}
