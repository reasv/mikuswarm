import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

export interface FileToolContext {
  workspaceRoot: string;
}

export function createReadFileTool(context: FileToolContext): AgentTool {
  return {
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file from the agent workspace.",
    parameters: Type.Object({
      path: Type.String(),
      max_chars: Type.Optional(Type.Number({ minimum: 1, maximum: 200_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { path: string; max_chars?: number };
      const absolute = resolveWorkspacePath(context.workspaceRoot, args.path);
      const content = await readFile(absolute, "utf8");
      const maxChars = args.max_chars ?? 50_000;
      const text = content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content;
      return {
        content: [{ type: "text", text }],
        details: {
          path: workspaceRelative(context.workspaceRoot, absolute),
          bytes: Buffer.byteLength(content),
          truncated: content.length > maxChars,
        },
      };
    },
  };
}

export function createWriteFileTool(context: FileToolContext): AgentTool {
  return {
    name: "write_file",
    label: "Write file",
    description: "Write a UTF-8 text file inside the agent workspace.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
      append: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { path: string; content: string; append?: boolean };
      const absolute = resolveWorkspacePath(context.workspaceRoot, args.path);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, args.content, { encoding: "utf8", flag: args.append ? "a" : "w" });
      return {
        content: [{ type: "text", text: `wrote ${workspaceRelative(context.workspaceRoot, absolute)}` }],
        details: {
          path: workspaceRelative(context.workspaceRoot, absolute),
          bytes: Buffer.byteLength(args.content),
          append: args.append ?? false,
        },
      };
    },
  };
}
