import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

export interface MediaToolContext {
  workspaceRoot: string;
}

export function createDescribeMediaTool(context: MediaToolContext): AgentTool {
  return {
    name: "describe_media",
    label: "Describe media",
    description: "Inspect an image file in the workspace and return metadata plus a preview image block.",
    parameters: Type.Object({
      path: Type.String(),
      include_image: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { path: string; include_image?: boolean };
      const absolute = resolveWorkspacePath(context.workspaceRoot, args.path);
      const input = await readFile(absolute);
      const metadata = await sharp(input).metadata();
      const lines = [
        `File: ${workspaceRelative(context.workspaceRoot, absolute)}`,
        `Format: ${metadata.format ?? "unknown"}`,
        `Size: ${metadata.width ?? "?"}x${metadata.height ?? "?"}`,
        `Channels: ${metadata.channels ?? "?"}`,
      ];
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: lines.join("\n") },
      ];
      if (args.include_image ?? true) {
        const preview = await sharp(input)
          .resize({ width: 1280, height: 720, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        content.push({ type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" });
      }
      return {
        content,
        details: {
          path: workspaceRelative(context.workspaceRoot, absolute),
          format: metadata.format,
          width: metadata.width,
          height: metadata.height,
        },
      };
    },
  };
}
