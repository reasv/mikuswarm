import { readFile, rename, mkdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import type { ConcurrencyLimitedFetchClient } from "../enrichment/fetch-client.js";

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
  fetchClient: ConcurrencyLimitedFetchClient;
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
        const fetched = await context.fetchClient.fetch(assetUrl, { maxBytes: context.downloadSizeLimit });
        if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
          await unlink(fetched.path).catch(() => {});
          throw new Error(`Download failed with HTTP ${fetched.statusCode}`);
        }
        const buffer = await readFile(fetched.path);
        await unlink(fetched.path).catch(() => {});
        return {
          content: [
            { type: "text", text: summarizePost(post) },
            { type: "image", data: buffer.toString("base64"), mimeType: fetched.contentType ?? mimeFromUrl(assetUrl) },
          ],
          details: { post, assetUrl },
        };
      }
      const fetched = await context.fetchClient.fetch(assetUrl, { maxBytes: context.downloadSizeLimit });
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        await unlink(fetched.path).catch(() => {});
        throw new Error(`Download failed with HTTP ${fetched.statusCode}`);
      }
      const subdir = args.output_subdir ?? "downloads/danbooru";
      const outputDir = resolveWorkspacePath(context.workspaceRoot, subdir);
      await mkdir(outputDir, { recursive: true });
      const ext = post.file_ext ?? extFromUrl(assetUrl) ?? extFromContentType(fetched.contentType) ?? "jpg";
      const filename = `danbooru-${post.id}.${ext}`;
      const outputPath = path.join(outputDir, filename);
      await rename(fetched.path, outputPath);
      const fileStat = await stat(outputPath);
      return {
        content: [{ type: "text", text: `${summarizePost(post)}\nSaved: ${workspaceRelative(context.workspaceRoot, outputPath)}` }],
        details: { post, assetUrl, path: workspaceRelative(context.workspaceRoot, outputPath), bytes: fileStat.size },
      };
    },
  };
}

function extFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(\w+)$/);
    return match ? match[1] : undefined;
  } catch { return undefined; }
}

function extFromContentType(ct?: string): string | undefined {
  if (!ct) return undefined;
  const mime = ct.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
  };
  return map[mime];
}

function mimeFromUrl(url: string): string {
  const ext = extFromUrl(url);
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp",
  };
  return (ext && map[ext]) ?? "image/jpeg";
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
