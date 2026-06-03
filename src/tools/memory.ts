import { mkdir } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { runRipgrep, type TextEditorArgs } from "./file.js";
import { resolveWorkspacePath } from "./workspace.js";
import { agentDateStamp } from "../time/index.js";
import type { MemoryFileWriter } from "../storage/memory-writer.js";

export interface MemoryToolContext {
  workspaceRoot: string;
  now?: Date;
}

export interface WriteMemoryToolContext extends MemoryToolContext {
  /**
   * Single-writer FIFO for memory-file mutations (ARCHITECTURE.md §9b). All
   * `write_memory` edits route through it so they serialize with diary appends.
   */
  memoryWriter: MemoryFileWriter;
}

export function createSearchMemoryTool(context: MemoryToolContext): AgentTool {
  return {
    name: "search_memory",
    label: "Search memory",
    description: "Search workspace daily memory markdown files with ripgrep.",
    parameters: Type.Object({
      pattern: Type.String(),
      glob: Type.Optional(Type.Array(Type.String())),
      case_sensitive: Type.Optional(Type.Boolean()),
      context_lines: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        pattern: string;
        glob?: string[];
        case_sensitive?: boolean;
        context_lines?: number;
        max_results?: number;
      };
      await ensureMemoryDirectory(context.workspaceRoot);
      const result = await runRipgrep(context.workspaceRoot, {
        pattern: args.pattern,
        path: "memory",
        glob: args.glob ?? ["*.md"],
        case_sensitive: args.case_sensitive,
        context_lines: args.context_lines,
        max_results: args.max_results,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  };
}

export function createWriteMemoryTool(context: WriteMemoryToolContext): AgentTool {
  return {
    name: "write_memory",
    label: "Daily memory editor",
    description: "View and edit today's daily memory markdown file in the workspace memory folder.",
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("view"),
        Type.Literal("str_replace"),
        Type.Literal("insert"),
      ]),
      view_range: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
      old_str: Type.Optional(Type.String()),
      new_str: Type.Optional(Type.String()),
      insert_line: Type.Optional(Type.Number({ minimum: 0 })),
      insert_text: Type.Optional(Type.String()),
      max_characters: Type.Optional(Type.Number({ minimum: 1, maximum: 500_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const date = agentDateStamp(context.now ?? new Date());
      // `ensureDailyFile` and `editorCommand` are two separate FIFO ops, not a
      // single critical section. A diary `appendEntry` for the same day may
      // interleave between them — this is design-accepted concurrency: each op is
      // atomic, and the editor re-reads the file under `str_replace`/`insert`, so a
      // stale `old_str` simply errors back to the caller rather than corrupting.
      // View-then-edit atomicity (if ever needed) would require a single combined
      // op enqueued on the writer; we intentionally don't do that here.
      const memoryPath = await context.memoryWriter.ensureDailyFile(date);
      const relativePath = context.memoryWriter.relative(memoryPath);
      const args = params as {
        command: "view" | "str_replace" | "insert";
        view_range?: [number, number];
        old_str?: string;
        new_str?: string;
        insert_line?: number;
        insert_text?: string;
        max_characters?: number;
      };
      const result = await context.memoryWriter.editorCommand(memoryEditorArgs(relativePath, args));
      return {
        content: [{ type: "text", text: result.text }],
        details: { ...result.details, memoryPath: relativePath },
      };
    },
  };
}

function memoryEditorArgs(
  relativePath: string,
  args: {
    command: "view" | "str_replace" | "insert";
    view_range?: [number, number];
    old_str?: string;
    new_str?: string;
    insert_line?: number;
    insert_text?: string;
    max_characters?: number;
  },
): TextEditorArgs {
  if (args.command === "view") {
    return {
      command: "view",
      path: relativePath,
      view_range: args.view_range,
      max_characters: args.max_characters,
    };
  }
  if (args.command === "str_replace") {
    return {
      command: "str_replace",
      path: relativePath,
      old_str: args.old_str,
      new_str: args.new_str,
    };
  }
  return {
    command: "insert",
    path: relativePath,
    insert_line: args.insert_line,
    insert_text: args.insert_text,
  };
}

async function ensureMemoryDirectory(workspaceRoot: string): Promise<string> {
  const memoryDir = resolveWorkspacePath(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  return memoryDir;
}
