import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import { isNodeError } from "../types.js";
import type { ExecBackend } from "../sandbox/index.js";

const execFileAsync = promisify(execFile);

export interface FileToolContext {
  workspaceRoot: string;
  contextWindowTokens?: number;
  /**
   * When present, `search_files` runs ripgrep inside the sandbox container
   * instead of on the host. The workspace is the same bind-mounted files, so
   * results are identical; this just moves the `rg` process into the sandbox.
   */
  sandbox?: ExecBackend;
}

export function createTextEditorTool(context: FileToolContext): AgentTool {
  return {
    name: "str_replace_based_edit_tool",
    label: "Text editor",
    description: "View, create, and edit text files in the workspace using Claude's str_replace editor commands. For str_replace, pass either a single old_str/new_str pair or an edits array; the edits array applies multiple replacements sequentially with all-or-nothing semantics (if any edit fails to match, the file is left unchanged). Edits in the batch apply against the in-progress buffer: an earlier edit's new_str is visible to later edits' old_str matches. For swap-style transforms (A→B and B→A in the same file), use separate calls or include enough surrounding context to make each match unique.",
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("view"),
        Type.Literal("str_replace"),
        Type.Literal("create"),
        Type.Literal("insert"),
      ]),
      path: Type.String(),
      view_range: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
      old_str: Type.Optional(Type.String()),
      new_str: Type.Optional(Type.String()),
      edits: Type.Optional(Type.Array(Type.Object({
        old_str: Type.String({ description: "Exact substring to find in the current file content. Must match exactly once at the time this edit runs (after previous edits in the batch have been applied)." }),
        new_str: Type.Optional(Type.String({ description: "Replacement text. Omit or set to empty string to delete the matched text." })),
      }, { description: "A single str_replace edit." }), { description: "Ordered list of str_replace edits applied sequentially. All-or-nothing: if any edit's old_str does not match, no changes are written to disk." })),
      file_text: Type.Optional(Type.String()),
      insert_line: Type.Optional(Type.Number({ minimum: 0 })),
      insert_text: Type.Optional(Type.String()),
      max_characters: Type.Optional(Type.Number({ minimum: 1, maximum: 500_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as TextEditorArgs;
      const result = await runTextEditorCommand(context.workspaceRoot, args, {
        contextWindowTokens: context.contextWindowTokens,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  };
}

export function createSearchFilesTool(context: FileToolContext): AgentTool {
  return {
    name: "search_files",
    label: "Search files",
    description: "Search workspace files with ripgrep.",
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.Array(Type.String())),
      case_sensitive: Type.Optional(Type.Boolean()),
      context_lines: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        pattern: string;
        path?: string;
        glob?: string[];
        case_sensitive?: boolean;
        context_lines?: number;
        max_results?: number;
      };
      const result = await runRipgrep(context.workspaceRoot, {
        ...args,
        path: args.path ?? ".",
      }, context.sandbox);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  };
}

export type TextEditorArgs =
  | {
      command: "view";
      path: string;
      view_range?: [number, number];
      max_characters?: number;
    }
  | {
      command: "str_replace";
      path: string;
      old_str?: string;
      new_str?: string;
      edits?: Array<{ old_str: string; new_str?: string }>;
    }
  | {
      command: "create";
      path: string;
      file_text?: string;
    }
  | {
      command: "insert";
      path: string;
      insert_line?: number;
      insert_text?: string;
    };

export async function runTextEditorCommand(workspaceRoot: string, args: TextEditorArgs, options?: { contextWindowTokens?: number }) {
  const absolute = resolveWorkspacePath(workspaceRoot, args.path);
  if (args.command === "view") {
    const info = await stat(absolute);
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`);
      return {
        text: lines.join("\n") || "(empty directory)",
        details: { command: args.command, path: workspaceRelative(workspaceRoot, absolute), entries: entries.length },
      };
    }
    const content = await readFile(absolute, "utf8");
    const selected = selectLineRange(content, args.view_range);
    const numbered = addLineNumbers(selected.text, selected.startLine);
    const maxCharacters = args.max_characters ?? resolveMaxCharacters(options?.contextWindowTokens);
    const truncated = numbered.length > maxCharacters;
    const hasExplicitRange = args.view_range !== undefined;
    let displayedText: string;
    let lastVisibleLine: number;
    let continuationHint: string;
    if (truncated) {
      const rawSlice = numbered.slice(0, maxCharacters);
      const completeLines = (rawSlice.match(/\n/g) ?? []).length;
      if (completeLines >= 1) {
        // Slice back to the last newline so the visible region matches the
        // advertised range exactly — no dangling mid-line fragment past the
        // last advertised line.
        const lastNewline = rawSlice.lastIndexOf("\n");
        displayedText = rawSlice.slice(0, lastNewline);
        lastVisibleLine = selected.startLine + completeLines - 1;
        continuationHint = hasExplicitRange
          ? "\n[truncated]"
          : `\n[Showing lines ${selected.startLine}-${lastVisibleLine}. Use view_range to continue.]`;
      } else {
        // Budget can't even fit a single complete line — emit the partial
        // fragment with a plain truncation marker. Floor endLine at startLine
        // so details.endLine never falls below details.startLine.
        displayedText = rawSlice;
        lastVisibleLine = selected.startLine;
        continuationHint = "\n[truncated]";
      }
    } else {
      displayedText = numbered;
      lastVisibleLine = selected.endLine;
      continuationHint = "";
    }
    return {
      text: `${displayedText}${continuationHint}`,
      details: {
        command: args.command,
        path: workspaceRelative(workspaceRoot, absolute),
        startLine: selected.startLine,
        endLine: lastVisibleLine,
        truncated,
      },
    };
  }

  if (args.command === "create") {
    const text = args.file_text;
    if (text === undefined) throw new Error("create requires file_text");
    try {
      await stat(absolute);
      throw new Error(`File already exists: ${workspaceRelative(workspaceRoot, absolute)}`);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        throw error;
      }
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text, "utf8");
    return {
      text: `created ${workspaceRelative(workspaceRoot, absolute)}`,
      details: { command: args.command, path: workspaceRelative(workspaceRoot, absolute), bytes: Buffer.byteLength(text) },
    };
  }

  const content = await readFile(absolute, "utf8");
  if (args.command === "str_replace") {
    const edits = normalizeEdits(args);
    const relPath = workspaceRelative(workspaceRoot, absolute);
    let current = content;
    for (let i = 0; i < edits.length; i++) {
      const { old_str, new_str } = edits[i];
      const newStr = new_str ?? "";
      const first = current.indexOf(old_str);
      if (first < 0) throw mismatchError(relPath, old_str, content, i, edits.length);
      const second = current.indexOf(old_str, first + old_str.length);
      if (second >= 0) throw duplicateMatchError(relPath, current, i, edits.length);
      current = `${current.slice(0, first)}${newStr}${current.slice(first + old_str.length)}`;
    }
    await writeFile(absolute, current, "utf8");
    return {
      text: `updated ${relPath}`,
      details: { command: args.command, path: relPath, replacements: edits.length },
    };
  }

  if (args.insert_line === undefined) throw new Error("insert requires insert_line");
  if (args.insert_text === undefined) throw new Error("insert requires insert_text");
  const updated = insertAfterLine(content, args.insert_line, args.insert_text);
  await writeFile(absolute, updated, "utf8");
  return {
    text: `inserted into ${workspaceRelative(workspaceRoot, absolute)} after line ${args.insert_line}`,
    details: { command: args.command, path: workspaceRelative(workspaceRoot, absolute), insertLine: args.insert_line },
  };
}

export async function runRipgrep(
  workspaceRoot: string,
  args: {
    pattern: string;
    path: string;
    glob?: string[];
    case_sensitive?: boolean;
    context_lines?: number;
    max_results?: number;
  },
  sandbox?: ExecBackend,
) {
  // resolveWorkspacePath runs the host-side containment check (reject `..`/symlink
  // escapes) for both backends. relativePath is the in-workspace target used as
  // ripgrep's path arg in the sandbox and as the reported `details.path`.
  const absolute = resolveWorkspacePath(workspaceRoot, args.path);
  const relativePath = workspaceRelative(workspaceRoot, absolute);
  const argv = ["--line-number", "--no-heading", "--color", "never"];
  if (args.case_sensitive === false) argv.push("--ignore-case");
  if (args.context_lines !== undefined && args.context_lines > 0) argv.push("--context", String(args.context_lines));
  for (const glob of args.glob ?? []) argv.push("--glob", glob);

  const maxResults = args.max_results ?? 100;
  const buildResult = (stdout: string) => {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const selected = lines.slice(0, maxResults);
    return {
      text: selected.join("\n") || "No matches.",
      details: {
        pattern: args.pattern,
        path: relativePath,
        count: lines.length,
        truncated: lines.length > selected.length,
      },
    };
  };
  const noMatches = () => ({
    text: "No matches.",
    details: { pattern: args.pattern, path: relativePath, count: 0, truncated: false },
  });

  if (sandbox) {
    // Run rg inside the container, from /workspace, targeting the relative path.
    // The `--` end-of-options separator guards a pattern that begins with `-`
    // (e.g. `-l`, `--files`) so rg treats it as a search term, not a flag; the
    // path that follows is likewise positional and safe even if it starts `-`.
    // ripgrep exits 1 on "no matches" and 2 on error; docker exec forwards the code.
    const command = ["rg", ...argv, "--", args.pattern, relativePath].map(shellQuote).join(" ");
    const result = await sandbox.exec(command, { maxOutputBytes: 1024 * 1024 });
    if (result.exitCode === 1 && !result.stdout) return noMatches();
    if (result.exitCode > 1) {
      throw new Error(`ripgrep failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    const built = buildResult(result.stdout);
    // The backend caps each stream at maxOutputBytes and sets result.truncated
    // when it clips. Surface that as truncation too — otherwise an over-cap
    // search is mislabeled `truncated: false` and the model may wrongly conclude
    // a symbol is absent. Final truncation reflects EITHER the max_results line
    // cap (set by buildResult) OR the backend byte cap. Mirror the bash tool's
    // `[output truncated]` marker so the model knows output was cut.
    if (result.truncated) {
      built.details.truncated = true;
      if (built.text !== "No matches.") built.text += "\n[output truncated]";
    }
    return built;
  }

  argv.push("--", args.pattern, absolute);
  try {
    const { stdout } = await execFileAsync("rg", argv, {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    return buildResult(stdout);
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { code?: number; stdout?: string };
    if (execError.code === 1) return noMatches();
    throw error;
  }
}

/** Single-quote-escape an argv element for safe interpolation into `sh -lc`. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function selectLineRange(content: string, range?: [number, number]) {
  const lines = content.split(/\r?\n/);
  const startLine = range?.[0] ?? 1;
  const requestedEnd = range?.[1] ?? -1;
  if (startLine < 1) throw new Error("view_range start must be >= 1");
  // Refuse a start past EOF: silently returning would yield an empty slice and
  // an endLine < startLine after Math.min, which is internally inconsistent and
  // confuses the agent into thinking the file is shorter than it is. Throwing
  // a specific message lets the model retry with a valid range.
  if (startLine > lines.length) {
    throw new Error(`view_range.start (${startLine}) is past end of file (${lines.length} lines)`);
  }
  const endLine = requestedEnd === -1 ? lines.length : requestedEnd;
  if (endLine < startLine) throw new Error("view_range end must be >= start or -1");
  return {
    text: lines.slice(startLine - 1, endLine).join("\n"),
    startLine,
    endLine: Math.min(endLine, lines.length),
  };
}

function addLineNumbers(text: string, startLine: number): string {
  return text
    .split(/\r?\n/)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
}

function insertAfterLine(content: string, insertLine: number, insertText: string): string {
  const lines = content.split(/\r?\n/);
  if (insertLine > lines.length) throw new Error(`insert_line ${insertLine} is past end of file`);
  const insertLines = insertText.split(/\r?\n/);
  const next = [...lines.slice(0, insertLine), ...insertLines, ...lines.slice(insertLine)];
  return next.join("\n");
}

const MISMATCH_HINT_LIMIT = 800;
const DEFAULT_MAX_CHARACTERS = 100_000;
const MIN_ADAPTIVE_BUDGET = 50_000;
const MAX_ADAPTIVE_BUDGET = 512_000;
const CHARS_PER_TOKEN = 4;
const ADAPTIVE_CONTEXT_SHARE = 0.2;

function normalizeEdits(args: { old_str?: string; new_str?: string; edits?: Array<{ old_str: string; new_str?: string }> }): Array<{ old_str: string; new_str?: string }> {
  // `edits` being defined is an explicit choice — even an empty array means
  // "I'm using the batch form". Reject mixing the two forms regardless of
  // length, and reject the empty array with a specific message.
  if (args.edits !== undefined) {
    if (args.old_str !== undefined || args.new_str !== undefined) {
      throw new Error("Pass either edits or old_str/new_str, not both");
    }
    if (args.edits.length < 1) {
      throw new Error("edits must contain at least one edit");
    }
    for (let i = 0; i < args.edits.length; i++) {
      if (args.edits[i].old_str === "") {
        const indexHint = args.edits.length > 1 ? ` (edit ${i + 1}/${args.edits.length})` : "";
        throw new Error(`old_str must not be empty${indexHint}`);
      }
    }
    return args.edits;
  }
  if (args.old_str !== undefined) {
    if (args.old_str === "") throw new Error("old_str must not be empty");
    return [{ old_str: args.old_str, new_str: args.new_str }];
  }
  throw new Error("str_replace requires old_str or edits");
}

function mismatchSnippet(currentContent: string): string {
  return currentContent.length > MISMATCH_HINT_LIMIT
    ? `[file is ${currentContent.length} chars; call view to inspect]`
    : currentContent;
}

function mismatchError(relPath: string, oldStr: string, currentContent: string, editIndex: number, totalEdits: number): Error {
  const indexHint = totalEdits > 1 ? ` (edit ${editIndex + 1}/${totalEdits})` : "";
  // CRLF hint: the `view` command splits on /\r?\n/ so what the model "saw" has
  // no \r, but str_replace matches byte-for-byte. If the on-disk file is CRLF
  // and the supplied old_str is LF, the match silently fails. Surfacing this
  // up front saves a round trip.
  const crlfHint = currentContent.includes("\r") && !oldStr.includes("\r")
    ? "\n(file uses CRLF line endings; include \\r\\n in old_str)"
    : "";
  return new Error(`old_str was not found in ${relPath}${indexHint}${crlfHint}\nCurrent file contents:\n${mismatchSnippet(currentContent)}`);
}

function duplicateMatchError(relPath: string, currentContent: string, editIndex: number, totalEdits: number): Error {
  const indexHint = totalEdits > 1 ? ` (edit ${editIndex + 1}/${totalEdits})` : "";
  // When this is a later batch edit, an earlier edit may have introduced the
  // second match. Surface the in-progress buffer (post prior edits) so the
  // agent can see what the file actually looks like at this point.
  const priorEditHint = totalEdits > 1 && editIndex > 0
    ? "\nThis edit ran after earlier edits in the batch; an earlier replacement may have introduced the duplicate match."
    : "";
  return new Error(
    `old_str matched more than once in ${relPath}${indexHint}${priorEditHint}\nCurrent file contents:\n${mismatchSnippet(currentContent)}`,
  );
}

function resolveMaxCharacters(contextWindowTokens?: number): number {
  if (!Number.isFinite(contextWindowTokens) || (contextWindowTokens as number) <= 0) {
    return DEFAULT_MAX_CHARACTERS;
  }
  const fromContext = Math.floor((contextWindowTokens as number) * CHARS_PER_TOKEN * ADAPTIVE_CONTEXT_SHARE);
  // Apply the MIN_ADAPTIVE_BUDGET floor only when the context's share is at
  // least half of it — otherwise the floor would blow a small-context model's
  // entire window on a single tool result. Always cap at MAX_ADAPTIVE_BUDGET.
  const floored = fromContext * 2 >= MIN_ADAPTIVE_BUDGET ? Math.max(MIN_ADAPTIVE_BUDGET, fromContext) : fromContext;
  return Math.max(1, Math.min(MAX_ADAPTIVE_BUDGET, floored));
}
