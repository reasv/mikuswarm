import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import { isNodeError } from "../types.js";

const execFileAsync = promisify(execFile);

export interface FileToolContext {
  workspaceRoot: string;
  contextWindowTokens?: number;
}

export function createTextEditorTool(context: FileToolContext): AgentTool {
  return {
    name: "str_replace_based_edit_tool",
    label: "Text editor",
    description: "View, create, and edit text files in the workspace using Claude's str_replace editor commands. For str_replace, pass either a single old_str/new_str pair or an edits array; the edits array applies multiple replacements sequentially with all-or-nothing semantics (if any edit fails to match, the file is left unchanged).",
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
      });
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
      throw new Error(`File already exists: ${args.path}`);
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
      if (second >= 0) throw new Error(`old_str matched more than once${edits.length > 1 ? ` (edit ${i + 1}/${edits.length})` : ""}`);
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
) {
  const absolute = resolveWorkspacePath(workspaceRoot, args.path);
  const argv = ["--line-number", "--no-heading", "--color", "never"];
  if (args.case_sensitive === false) argv.push("--ignore-case");
  if (args.context_lines !== undefined && args.context_lines > 0) argv.push("--context", String(args.context_lines));
  for (const glob of args.glob ?? []) argv.push("--glob", glob);
  argv.push(args.pattern, absolute);
  try {
    const { stdout } = await execFileAsync("rg", argv, {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const maxResults = args.max_results ?? 100;
    const selected = lines.slice(0, maxResults);
    return {
      text: selected.join("\n") || "No matches.",
      details: {
        pattern: args.pattern,
        path: workspaceRelative(workspaceRoot, absolute),
        count: lines.length,
        truncated: lines.length > selected.length,
      },
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { code?: number; stdout?: string };
    if (execError.code === 1) {
      return {
        text: "No matches.",
        details: { pattern: args.pattern, path: workspaceRelative(workspaceRoot, absolute), count: 0, truncated: false },
      };
    }
    throw error;
  }
}

function selectLineRange(content: string, range?: [number, number]) {
  const lines = content.split(/\r?\n/);
  const startLine = range?.[0] ?? 1;
  const requestedEnd = range?.[1] ?? -1;
  if (startLine < 1) throw new Error("view_range start must be >= 1");
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
  if (args.edits && args.edits.length > 0) {
    if (args.old_str !== undefined || args.new_str !== undefined) {
      throw new Error("Pass either edits or old_str/new_str, not both");
    }
    return args.edits;
  }
  if (args.old_str !== undefined) return [{ old_str: args.old_str, new_str: args.new_str }];
  throw new Error("str_replace requires old_str or edits");
}

function mismatchError(relPath: string, oldStr: string, currentContent: string, editIndex: number, totalEdits: number): Error {
  const indexHint = totalEdits > 1 ? ` (edit ${editIndex + 1}/${totalEdits})` : "";
  const snippet = currentContent.length > MISMATCH_HINT_LIMIT
    ? `[file is ${currentContent.length} chars; call view to inspect]`
    : currentContent;
  return new Error(`old_str was not found in ${relPath}${indexHint}\nCurrent file contents:\n${snippet}`);
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
