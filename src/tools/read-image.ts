import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

export interface ReadImageToolContext {
  workspaceRoot: string;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function createReadImageTool(context: ReadImageToolContext): AgentTool {
  return {
    name: "read_image",
    label: "Read image",
    description: "Read an image file from the workspace and return it directly. Use this to view image contents without captioning.",
    parameters: Type.Object({
      path: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { path: string };
      const absolute = resolveWorkspacePath(context.workspaceRoot, args.path);
      const relPath = workspaceRelative(context.workspaceRoot, absolute);

      const ext = path.extname(absolute).toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      if (!mimeType) {
        throw new Error(`Unsupported image format: ${ext || "(no extension)"}. Supported: ${Object.keys(MIME_BY_EXT).join(", ")}`);
      }

      const info = await stat(absolute);
      if (info.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large: ${(info.size / (1024 * 1024)).toFixed(1)}MB (limit: ${MAX_IMAGE_BYTES / (1024 * 1024)}MB)`);
      }

      const buffer = await readFile(absolute);
      const data = buffer.toString("base64");

      return {
        content: [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data, mimeType },
        ],
        details: { path: relPath, mimeType, sizeBytes: info.size },
      };
    },
  };
}
