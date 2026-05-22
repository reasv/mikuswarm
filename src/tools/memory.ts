import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { runRipgrep, runTextEditorCommand } from "./file.js";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

export interface MemoryToolContext {
  workspaceRoot: string;
  now?: Date;
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

export function createWriteMemoryTool(context: MemoryToolContext): AgentTool {
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
      file_text: Type.Optional(Type.String()),
      insert_line: Type.Optional(Type.Number({ minimum: 0 })),
      insert_text: Type.Optional(Type.String()),
      max_characters: Type.Optional(Type.Number({ minimum: 1, maximum: 500_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const memoryPath = await ensureDailyMemoryFile(context.workspaceRoot, context.now ?? new Date());
      const relativePath = workspaceRelative(context.workspaceRoot, memoryPath);
      const args = params as {
        command: "view" | "str_replace" | "insert";
        view_range?: [number, number];
        old_str?: string;
        new_str?: string;
        file_text?: string;
        insert_line?: number;
        insert_text?: string;
        max_characters?: number;
      };
      const result = await runTextEditorCommand(context.workspaceRoot, { ...args, path: relativePath } as any);
      return {
        content: [{ type: "text", text: result.text }],
        details: { ...result.details, memoryPath: relativePath },
      };
    },
  };
}

export function createDailyMemoryEditorTool(context: MemoryToolContext): AgentTool {
  return createWriteMemoryTool(context);
}

async function ensureMemoryDirectory(workspaceRoot: string): Promise<string> {
  const memoryDir = resolveWorkspacePath(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  return memoryDir;
}

async function ensureDailyMemoryFile(workspaceRoot: string, now: Date): Promise<string> {
  const date = now.toISOString().slice(0, 10);
  const memoryDir = await ensureMemoryDirectory(workspaceRoot);
  const memoryPath = path.join(memoryDir, `${date}.md`);
  try {
    await stat(memoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(memoryPath, `# ${date} Daily Memory\n`, "utf8");
  }
  return memoryPath;
}
