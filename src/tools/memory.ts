import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { TimelineStore } from "../timeline/index.js";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

export interface MemoryToolContext {
  workspaceRoot: string;
  timeline: TimelineStore;
  timelineKey: string;
}

export function createSearchMemoryTool(context: MemoryToolContext): AgentTool {
  return {
    name: "search_memory",
    label: "Search memory",
    description: "Search recent stored timeline events for the current chat.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { query: string; limit?: number };
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = context.timeline
        .query({ timelineKey: context.timelineKey, limit: 2000 })
        .filter((event) => {
          const haystack = [
            event.body,
            event.sender.displayName,
            event.sender.id,
            ...(event.attachments ?? []).map((attachment) => `${attachment.filename ?? ""} ${attachment.caption ?? ""}`),
            ...(event.generatedCaptions ?? []).map((caption) => caption.text),
          ]
            .join(" ")
            .toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        .slice(-(args.limit ?? 10));
      const text = matches
        .map(
          (event) =>
            `[${new Date(event.timestamp).toISOString()}] ${event.sender.displayName ?? event.sender.id}: ${event.body}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text: text || "No matching timeline events." }],
        details: { count: matches.length, query: args.query },
      };
    },
  };
}

export function createWriteMemoryTool(context: MemoryToolContext): AgentTool {
  return {
    name: "write_memory",
    label: "Write memory",
    description: "Append a durable markdown note to the current chat memory file.",
    parameters: Type.Object({
      note: Type.String(),
      file: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { note: string; file?: string };
      const memoryPath = resolveWorkspacePath(context.workspaceRoot, args.file ?? "memory/miku-memory.md");
      await mkdir(path.dirname(memoryPath), { recursive: true });
      let existing = "";
      try {
        existing = await readFile(memoryPath, "utf8");
      } catch {
        existing = "# Miku Memory\n";
      }
      const entry = `\n\n## ${new Date().toISOString()}\n\n${args.note.trim()}\n`;
      await writeFile(memoryPath, `${existing.trimEnd()}${entry}`, "utf8");
      return {
        content: [{ type: "text", text: `memory written to ${workspaceRelative(context.workspaceRoot, memoryPath)}` }],
        details: { path: workspaceRelative(context.workspaceRoot, memoryPath) },
      };
    },
  };
}
