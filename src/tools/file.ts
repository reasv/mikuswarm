import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

const execFileAsync = promisify(execFile);

export interface FileToolContext {
  workspaceRoot: string;
}

export function createTextEditorTool(context: FileToolContext): AgentTool {
  return {
    name: "str_replace_based_edit_tool",
    label: "Text editor",
    description: "View, create, and edit text files in the workspace using Claude's str_replace editor commands.",
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
      file_text: Type.Optional(Type.String()),
      insert_line: Type.Optional(Type.Number({ minimum: 0 })),
      insert_text: Type.Optional(Type.String()),
      max_characters: Type.Optional(Type.Number({ minimum: 1, maximum: 500_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as TextEditorArgs;
      const result = await runTextEditorCommand(context.workspaceRoot, args);
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

export async function runTextEditorCommand(workspaceRoot: string, args: TextEditorArgs) {
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
    const maxCharacters = args.max_characters ?? 100_000;
    const truncated = numbered.length > maxCharacters;
    return {
      text: truncated ? `${numbered.slice(0, maxCharacters)}\n[truncated]` : numbered,
      details: {
        command: args.command,
        path: workspaceRelative(workspaceRoot, absolute),
        startLine: selected.startLine,
        endLine: selected.endLine,
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
      if (error instanceof Error && !("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
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
    if (args.old_str === undefined) throw new Error("str_replace requires old_str");
    const newStr = args.new_str ?? "";
    const first = content.indexOf(args.old_str);
    if (first < 0) throw new Error("old_str was not found");
    const second = content.indexOf(args.old_str, first + args.old_str.length);
    if (second >= 0) throw new Error("old_str matched more than once");
    const updated = `${content.slice(0, first)}${newStr}${content.slice(first + args.old_str.length)}`;
    await writeFile(absolute, updated, "utf8");
    return {
      text: `updated ${workspaceRelative(workspaceRoot, absolute)}`,
      details: { command: args.command, path: workspaceRelative(workspaceRoot, absolute), replacements: 1 },
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
