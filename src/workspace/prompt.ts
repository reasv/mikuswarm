import type { WorkspaceContent, SessionTypeConfig, SatelliteRuntimeInput } from "./types.js";
import { escapeXml, escapeAttr } from "../context/xml.js";
import { estimateTokens } from "../context/tokens.js";
import { formatAgentTimestamp } from "../time/index.js";

/**
 * One named piece of the system prompt and its token contribution.
 *
 * A "segment" is one rendered top-level XML block in {@link renderSystemPrompt} —
 * a workspace file (`<agent_instructions>`, `<soul>`, …), one inlined skill
 * (`<skill_instructions>`), or the available-skills index (`<available_skills>`).
 * `tokenEstimate` is the gpt-4o BPE length of that block's rendered string,
 * INCLUDING its wrapping tags. Segment estimates do not sum exactly to the whole
 * system-prompt estimate: the `\n\n` joiners between blocks and BPE boundary
 * effects cost a handful of tokens that are deliberately left unattributed — the
 * authoritative whole-prompt figure stays on the system message itself.
 */
export interface SystemPromptSegment {
  /** XML tag that wraps this block (e.g. "soul", "skill_instructions"). */
  tag: string;
  /** Human label for display: filename, skill name, or "available_skills". */
  label: string;
  /** Source path (workspace filename or skill path); null for the skills index. */
  source: string | null;
  /** gpt-4o token estimate of the rendered block, wrapping tags included. */
  tokenEstimate: number;
}

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
  return renderSystemPromptWithSegments(workspace, fallbackPrompt).text;
}

/**
 * Render the system prompt and, alongside it, the per-segment token breakdown.
 *
 * `text` is byte-identical to {@link renderSystemPrompt} (which delegates here),
 * so every caller that needs only the string is unaffected. `segments` carries
 * each rendered block's token contribution for the console's live system-prompt
 * inspector (ARCHITECTURE.md §10a) — see {@link SystemPromptSegment}.
 */
export function renderSystemPromptWithSegments(
  workspace: WorkspaceContent,
  fallbackPrompt?: string,
): { text: string; segments: SystemPromptSegment[] } {
  // Each block is rendered once; its string drives BOTH the joined prompt and
  // its own token estimate, so the breakdown can never drift from the text.
  const blocks: { tag: string; label: string; source: string | null; text: string }[] = [];

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
    blocks.push({
      tag: tagName,
      label: filename,
      source: filename,
      text: `<${tagName} source="${escapeAttr(filename)}">\n${content}\n</${tagName}>`,
    });
  }

  // Inlined skills (always_loaded: true)
  for (const skill of workspace.skills.inlined) {
    blocks.push({
      tag: "skill_instructions",
      label: skill.name,
      source: skill.path,
      text: `<skill_instructions source="${escapeAttr(skill.path)}" name="${escapeAttr(skill.name)}">\n${skill.content}\n</skill_instructions>`,
    });
  }

  // Available skills index (always_loaded: false)
  if (workspace.skills.listed.length > 0) {
    const skillEntries = workspace.skills.listed
      .map(
        (skill) =>
          `<skill name="${escapeAttr(skill.name)}" path="${escapeAttr(skill.path)}">${escapeXml(skill.description)}</skill>`,
      )
      .join("\n");
    blocks.push({
      tag: "available_skills",
      label: "available_skills",
      source: null,
      text: `<available_skills>\n${skillEntries}\n</available_skills>`,
    });
  }

  return {
    text: blocks.map((b) => b.text).join("\n\n"),
    segments: blocks.map((b) => ({
      tag: b.tag,
      label: b.label,
      source: b.source,
      tokenEstimate: estimateTokens(b.text),
    })),
  };
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

  // Part 1: Runtime state (suppressed for summarization builds)
  if (!options.suppressRuntimeState) {
    parts.push(`<runtime_state>\n${renderRuntimeState(options)}\n</runtime_state>`);
  }

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
/**
 * Code-owned coordination instruction for `<handled_by_session>` markers (spec
 * DUPLICATE-REPLY-MITIGATION §4.2). Rendered ONLY here (a conditional child of
 * `<active_sessions>`), never in TAIL.md: the dedup rule is a system invariant, it
 * must not be silently editable per-agent, and it must stay out of the cached
 * stable prefix — `<runtime_state>` is already volatile-per-build. The final
 * clause preserves the wanted behaviour (referencing other in-context messages)
 * and forbids only re-answering a claimed one.
 */
const COORDINATION_LINE =
  "<coordination>Messages tagged &lt;handled_by_session&gt; are already being answered by " +
  "another running session. Don't reply to or address them — you may still use them as " +
  "context.</coordination>";

function renderRuntimeState(options: SatelliteRuntimeInput): string {
  const sessions = options.activeSessions
    .map(
      (session) =>
        `<session id="${escapeAttr(session.id)}" started="${formatAgentTimestamp(session.createdAt)}" triggered_by="${escapeAttr((session.trigger.event.body ?? "").slice(0, 160))}"/>`,
    )
    .join("\n");

  // Emit the coordination line only when ≥1 OTHER active session exists — the
  // sole condition under which a `<handled_by_session>` marker could appear (spec
  // §4.2, the "ship first" gate). `activeSessions` includes the building session
  // itself, so filter it out by id; with no self id (preview build) every entry
  // counts as other.
  const otherSessionCount = options.activeSessions.filter(
    (session) => session.id !== options.selfSessionId,
  ).length;
  const coordination = otherSessionCount > 0 ? `\n${COORDINATION_LINE}` : "";

  const sessionsBlock = sessions
    ? `\n\n<active_sessions>\n${sessions}${coordination}\n</active_sessions>`
    : "";

  // Human-readable location, when the builder's resolveChannelContext hook
  // supplied it (live/proactive/preview builds over a resolvable Matrix room).
  // `Channel` is the `Name (Space)` label; `Type` distinguishes a DM from a
  // group room — both omitted when unresolved, leaving the raw timeline key as
  // the sole (machine-readable) room identifier. The trigger event id is no
  // longer surfaced here: it is an opaque coordination id with no agent use.
  const channelLine = options.channelLabel
    ? `\nChannel: ${escapeXml(options.channelLabel)}`
    : "";
  const typeLine =
    options.isDirect === undefined
      ? ""
      : `\nType: ${options.isDirect ? "direct message" : "group room"}`;

  return `Current time: ${formatAgentTimestamp(options.now ?? options.trigger.timestamp)}${channelLine}${typeLine}
Current timeline: ${escapeXml(options.timelineKey)}${sessionsBlock}`;
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

