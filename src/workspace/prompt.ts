import type { WorkspaceContent, SessionTypeConfig, SatelliteRuntimeInput } from "./types.js";
import { escapeXml, escapeAttr } from "../context/xml.js";

/**
 * Tag name mapping for workspace files.
 * Each workspace filename maps to an XML tag name used to delineate it
 * in the system prompt.
 */
const FILE_TAG_MAP: Record<string, string> = {
  "AGENTS.md": "agent_instructions",
  "SOUL.md": "soul",
  "TOOLS.md": "tools_guide",
};

/**
 * Order in which workspace file sections appear in the system prompt.
 * Files not in this list are appended in alphabetical order after the known ones.
 */
const FILE_ORDER = ["AGENTS.md", "SOUL.md", "TOOLS.md"];

/**
 * Render the system prompt from workspace content.
 *
 * Assembles workspace files, inlined skills, and the available skills index
 * into the full system prompt string.
 *
 * @param workspace Loaded workspace content.
 * @param fallbackPrompt Optional fallback string used when AGENTS.md is missing.
 * @returns The assembled system prompt string, or empty string if no content.
 */
export function renderSystemPrompt(
  workspace: WorkspaceContent,
  fallbackPrompt?: string,
): string {
  const sections: string[] = [];

  // Inject AGENTS.md fallback when the file is missing or empty.
  // An empty AGENTS.md on disk is treated the same as a missing one — the
  // fallback prompt provides a minimal instruction set in either case.
  let files = workspace.files;
  if (fallbackPrompt) {
    const existing = files.get("AGENTS.md");
    if (existing === undefined || existing === "") {
      files = new Map(files);
      files.set("AGENTS.md", fallbackPrompt);
    }
  }

  // Resolve ordered file list: known files first, then any extras in alphabetical order
  const orderedFiles = resolveFileOrder(files);

  for (const filename of orderedFiles) {
    const content = files.get(filename)!;
    if (!content) continue;

    const tagName = FILE_TAG_MAP[filename] ?? filenameToTag(filename);
    sections.push(`<${tagName} source="${escapeAttr(filename)}">\n${content}\n</${tagName}>`);
  }

  // Inlined skills (always_loaded: true)
  for (const skill of workspace.skills.inlined) {
    sections.push(
      `<skill_instructions source="${escapeAttr(skill.path)}" name="${escapeAttr(skill.name)}">\n${skill.content}\n</skill_instructions>`,
    );
  }

  // Available skills index (always_loaded: false)
  if (workspace.skills.listed.length > 0) {
    const skillEntries = workspace.skills.listed
      .map(
        (skill) =>
          `<skill name="${escapeAttr(skill.name)}" path="${escapeAttr(skill.path)}">${escapeXml(skill.description)}</skill>`,
      )
      .join("\n");
    sections.push(`<available_skills>\n${skillEntries}\n</available_skills>`);
  }

  return sections.join("\n\n");
}

/**
 * Render the satellite block content for the final user turn.
 *
 * Assembles three parts:
 * 1. Runtime state (time, timeline, sessions)
 * 2. Tail instructions (from TAIL.md or override)
 * 3. Session instruction (per-session-type directive)
 */
export function renderSatelliteBlock(
  options: SatelliteRuntimeInput,
  workspace: WorkspaceContent,
  sessionType?: SessionTypeConfig,
): string {
  const parts: string[] = [];

  // Part 1: Runtime state
  parts.push(`<runtime_state>\n${renderRuntimeState(options)}\n</runtime_state>`);

  // Part 2: Tail instructions
  if (workspace.tailContent) {
    const sourceFile = sessionType?.tail_file ?? "TAIL.md";
    // Only add source attr if it's a real file (not suppressed)
    if (typeof sourceFile === "string") {
      parts.push(
        `<tail_instructions source="${escapeAttr(sourceFile)}">\n${workspace.tailContent}\n</tail_instructions>`,
      );
    }
  }

  // Part 3: Session instruction
  if (sessionType?.session_instruction) {
    parts.push(
      `<session_instruction>\n${sessionType.session_instruction}\n</session_instruction>`,
    );
  }

  return parts.join("\n\n");
}

/**
 * Render runtime state content (the volatile per-session data).
 */
function renderRuntimeState(options: SatelliteRuntimeInput): string {
  const sessions = options.activeSessions
    .map(
      (session) =>
        `<session id="${escapeAttr(session.id)}" started="${new Date(session.createdAt).toISOString()}" triggered_by="${escapeAttr((session.trigger.event.body ?? "").slice(0, 160))}"/>`,
    )
    .join("\n");

  const sessionsBlock = sessions
    ? `\n\n<active_sessions>\n${sessions}\n</active_sessions>`
    : "";

  return `Current time: ${(options.now ?? new Date(options.trigger.timestamp)).toISOString()}
Current timeline: ${escapeXml(options.timelineKey)}
Trigger event: ${escapeXml(options.trigger.id)}${sessionsBlock}`;
}

/**
 * Determine the order of files for rendering.
 */
function resolveFileOrder(files: Map<string, string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  // Known files in canonical order
  for (const filename of FILE_ORDER) {
    if (files.has(filename)) {
      result.push(filename);
      seen.add(filename);
    }
  }

  // Any extra files in alphabetical order
  for (const filename of [...files.keys()].sort()) {
    if (!seen.has(filename)) {
      result.push(filename);
    }
  }

  return result;
}

/**
 * Convert a filename to a valid XML tag name.
 * Strips extension, lowercases, replaces non-alphanumeric with underscore.
 */
function filenameToTag(filename: string): string {
  let tag = filename
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (!tag || /^[0-9]/.test(tag)) tag = `ws_${tag || "unknown"}`;
  return tag;
}

