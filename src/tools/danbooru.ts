import { readFile, rename, mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";

type DanbooruPost = {
  id: number;
  tag_string?: string;
  rating?: string;
  score?: number;
  file_ext?: string;
  file_url?: string;
  large_file_url?: string;
  preview_file_url?: string;
  image_width?: number;
  image_height?: number;
};

export interface DanbooruToolContext {
  workspaceRoot: string;
  downloadSizeLimit: number;
}

export function createDanbooruTool(context: DanbooruToolContext): AgentTool {
  return {
    name: "danbooru",
    label: "Danbooru",
    description: "Search Danbooru, preview a post, or download an asset into the workspace.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("search"), Type.Literal("preview"), Type.Literal("download")])),
      tags: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      post_id: Type.Optional(Type.Number({ minimum: 1 })),
      variant: Type.Optional(Type.Union([Type.Literal("original"), Type.Literal("sample"), Type.Literal("preview")])),
      output_subdir: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        action?: "search" | "preview" | "download";
        tags?: string[];
        limit?: number;
        post_id?: number;
        variant?: "original" | "sample" | "preview";
        output_subdir?: string;
      };
      const action = args.action ?? "search";
      if (action === "search") return searchDanbooru(args.tags ?? [], args.limit ?? 10);
      if (!args.post_id) throw new Error(`${action} requires post_id`);
      const post = await fetchDanbooruPost(args.post_id);
      const assetUrl = selectAssetUrl(post, args.variant ?? (action === "preview" ? "preview" : "original"));
      if (!assetUrl) throw new Error(`Post ${post.id} has no usable asset URL.`);
      if (action === "preview") {
        const tmpPath = await streamDownload(assetUrl, context.downloadSizeLimit);
        const buffer = await readFile(tmpPath);
        const { unlink } = await import("node:fs/promises");
        await unlink(tmpPath).catch(() => {});
        return {
          content: [
            { type: "text", text: summarizePost(post) },
            { type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" },
          ],
          details: { post, assetUrl },
        };
      }
      const tmpPath = await streamDownload(assetUrl, context.downloadSizeLimit);
      const subdir = args.output_subdir ?? "downloads/danbooru";
      const outputDir = resolveWorkspacePath(context.workspaceRoot, subdir);
      await mkdir(outputDir, { recursive: true });
      const filename = `danbooru-${post.id}.${post.file_ext ?? "jpg"}`;
      const outputPath = path.join(outputDir, filename);
      await rename(tmpPath, outputPath);
      const { stat } = await import("node:fs/promises");
      const fileStat = await stat(outputPath);
      return {
        content: [{ type: "text", text: `${summarizePost(post)}\nSaved: ${workspaceRelative(context.workspaceRoot, outputPath)}` }],
        details: { post, assetUrl, path: workspaceRelative(context.workspaceRoot, outputPath), bytes: fileStat.size },
      };
    },
  };
}

async function streamDownload(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": "mikuswarm/0.1" } });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Asset too large: Content-Length ${contentLength} exceeds ${maxBytes} byte limit`);
  }

  if (!response.body) throw new Error("No response body");
  const tmpPath = path.join(tmpdir(), `miku-danbooru-${randomBytes(8).toString("hex")}`);
  const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  let totalBytes = 0;
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        callback(new Error(`Asset too large: exceeded ${maxBytes} byte limit during download`));
      } else {
        callback(null, chunk);
      }
    },
  });

  await pipeline(nodeStream, sizeGuard, createWriteStream(tmpPath));
  return tmpPath;
}

async function searchDanbooru(tags: string[], limit: number) {
  const url = new URL("https://danbooru.donmai.us/posts.json");
  url.searchParams.set("tags", tags.join(" "));
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: { "user-agent": "mikuswarm/0.1" } });
  if (!response.ok) throw new Error(`Danbooru search failed with HTTP ${response.status}`);
  const posts = (await response.json()) as DanbooruPost[];
  return {
        content: [
          {
            type: "text" as const,
            text:
              posts.map((post) => `${summarizePost(post)}\nhttps://danbooru.donmai.us/posts/${post.id}`).join("\n\n") ||
              "No Danbooru posts found.",
      },
    ],
    details: { count: posts.length, posts },
  };
}

async function fetchDanbooruPost(postId: number): Promise<DanbooruPost> {
  const response = await fetch(`https://danbooru.donmai.us/posts/${postId}.json`, {
    headers: { "user-agent": "mikuswarm/0.1" },
  });
  if (!response.ok) throw new Error(`Danbooru post fetch failed with HTTP ${response.status}`);
  return (await response.json()) as DanbooruPost;
}

function selectAssetUrl(post: DanbooruPost, variant: "original" | "sample" | "preview"): string | undefined {
  if (variant === "preview") return post.preview_file_url ?? post.large_file_url ?? post.file_url;
  if (variant === "sample") return post.large_file_url ?? post.file_url ?? post.preview_file_url;
  return post.file_url ?? post.large_file_url ?? post.preview_file_url;
}

function summarizePost(post: DanbooruPost): string {
  return `Post ${post.id} rating=${post.rating ?? "?"} score=${post.score ?? "?"} size=${post.image_width ?? "?"}x${post.image_height ?? "?"}\nTags: ${post.tag_string ?? ""}`;
}
