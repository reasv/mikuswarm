import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import type { ConcurrencyLimitedInferenceClient } from "../captioning/inference-client.js";

export interface ImageToolContext {
  workspaceRoot: string;
  inferenceClient: ConcurrencyLimitedInferenceClient;
  defaultPrompt: string;
  modelHasVision: boolean;
}

export function createImageTool(context: ImageToolContext): AgentTool {
  const description = context.modelHasVision
    ? "Analyze one or more images with a vision model. Use image for a single path/URL, or images for multiple (up to 20). Only use this tool when images were NOT already provided in the user's message. Images mentioned in the prompt are automatically visible to you."
    : "Analyze one or more images with the configured vision model. Use image for a single path/URL, or images for multiple (up to 20). Provide a prompt describing what to analyze.";

  return {
    name: "image",
    label: "Image",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Custom prompt describing what to analyze." })),
      image: Type.Optional(Type.String({ description: "Single image path or URL." })),
      images: Type.Optional(Type.Array(Type.String(), { description: "Multiple image paths or URLs (up to 20)." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { prompt?: string; image?: string; images?: string[] };
      const prompt = args.prompt ?? context.defaultPrompt;

      const candidates: string[] = [];
      if (args.image) candidates.push(args.image);
      if (args.images) candidates.push(...args.images);

      const unique = [...new Set(candidates)];
      if (unique.length === 0) {
        return { content: [{ type: "text", text: "Error: provide at least one image path or URL via image or images." }], details: {} };
      }
      if (unique.length > 20) {
        return { content: [{ type: "text", text: "Error: maximum 20 images per call." }], details: {} };
      }

      const results: string[] = [];
      for (const source of unique) {
        try {
          const imageData = await loadImage(context.workspaceRoot, source);
          const result = await context.inferenceClient.caption({
            imageData,
            mediaType: "image/jpeg",
            filename: source,
            prompt,
          });
          const label = unique.length > 1 ? `[${source}]\n` : "";
          results.push(`${label}${result.caption}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push(`[${source}]\nError: ${msg}`);
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n") }],
        details: { imageCount: unique.length },
      };
    },
  };
}

async function loadImage(workspaceRoot: string, source: string): Promise<Buffer> {
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to fetch image: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`URL did not return an image (content-type: ${contentType})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const absolute = resolveWorkspacePath(workspaceRoot, source);
  return readFile(absolute);
}

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
