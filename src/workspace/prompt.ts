import type { WorkspaceContent, SessionTypeConfig, SatelliteRuntimeInput } from "./types.js";

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

  // Resolve ordered file list: known files first, then any extras in alphabetical order
  const orderedFiles = resolveFileOrder(workspace.files);

  for (const filename of orderedFiles) {
    let content = workspace.files.get(filename)!;

    // Apply fallback for AGENTS.md
    if (filename === "AGENTS.md" && !content && fallbackPrompt) {
      content = fallbackPrompt;
    }

    if (!content) continue;

    const tagName = FILE_TAG_MAP[filename] ?? filenameToTag(filename);
    sections.push(`<${tagName} source="${escapeAttr(filename)}">\n${content}\n</${tagName}>`);
  }

  // Handle case where AGENTS.md doesn't exist but fallback is available
  if (!workspace.files.has("AGENTS.md") && fallbackPrompt) {
    const tagName = FILE_TAG_MAP["AGENTS.md"]!;
    sections.unshift(`<${tagName} source="AGENTS.md">\n${fallbackPrompt}\n</${tagName}>`);
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

  return `Current time: ${(options.now ?? new Date(options.trigger.timestamp)).toISOString()}
Current timeline: ${escapeXml(options.timelineKey)}
Trigger event: ${escapeXml(options.trigger.id)}

<active_sessions>
${sessions}
</active_sessions>`;
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
  return filename
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
