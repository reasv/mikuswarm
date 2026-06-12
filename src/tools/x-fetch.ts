import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { FetchClient } from "../enrichment/fetch-client.js";
import type { FxTwitterClient } from "../fxtwitter/client.js";
import type { FxTwitterToolConfig } from "../fxtwitter/types.js";
import { parseXStatusUrl } from "../fxtwitter/url.js";
import { buildTweetDocument, type XFetchMediaItem } from "../fxtwitter/format.js";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import {
  conditionImageBufferForInference,
  type ImageProcessingOptions,
} from "../media/index.js";

/**
 * `x_fetch` — on-demand tweet fetching via the FxTwitter API (ARCHITECTURE.md
 * §10; spec/FXTWITTER-ENRICHMENT.md §7). The generic `web_fetch` is blocked by
 * X server-side; this is the model's manual path for (a) reading tweets marked
 * `[truncated]` in previews, (b) tweets that never went through enrichment,
 * and (c) individual tweet media — including the photos behind an enrichment
 * mosaic. A normal ephemeral tool: output lives in the session rollout only —
 * no enrichment rows, no captioning; downloads are ordinary workspace files.
 */

export interface XFetchToolContext {
  workspaceRoot: string;
  fetchClient: FetchClient;
  client: FxTwitterClient;
  /** Per-image base64 cap for view_media blocks (same budget as read_image). */
  maxImageBytes: number;
  /** Shared inline-image conditioning options (same pipeline as danbooru preview). */
  inferenceImageOptions: ImageProcessingOptions;
  config: FxTwitterToolConfig;
  /** Recognized X status base-domains (built-ins + extra_status_hosts). */
  statusHosts: readonly string[];
}

function mediaSelectionSchema(description: string) {
  return Type.Union(
    [Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }), Type.Literal("all")],
    { description },
  );
}

type MediaSelection = number[] | "all";

interface XFetchParams {
  url: string;
  max_chars?: number;
  offset?: number;
  download_media?: MediaSelection;
  view_media?: MediaSelection;
}

export function createXFetchTool(context: XFetchToolContext): AgentTool {
  const { config } = context;
  return {
    name: "x_fetch",
    label: "X fetch",
    description:
      "Fetch a tweet (X.com post) via the FxTwitter API — use this instead of web_fetch for X links (X blocks generic fetchers). " +
      "Returns the full tweet text (paginate long posts with offset), author, stats, polls, community notes, the quoted tweet, " +
      "and a numbered media listing. Optionally download tweet media into the workspace (download_media) or view photos/video " +
      "thumbnails inline as image blocks (view_media), both addressed by the listing's indices. " +
      "Accepts x.com/twitter.com/fxtwitter share URLs or a bare numeric status id.",
    parameters: Type.Object({
      url: Type.String({
        description: "X status URL (x.com, twitter.com, fxtwitter.com share forms) or a bare numeric status id.",
      }),
      max_chars: Type.Optional(Type.Integer({
        description: `Max characters of the text document returned in this call (default ${config.defaultMaxChars}, cap ${config.maxCharsLimit}).`,
        minimum: 1,
        maximum: config.maxCharsLimit,
      })),
      offset: Type.Optional(Type.Integer({
        description: "Character offset into the assembled document, for paginating long posts. Default 0.",
        minimum: 0,
      })),
      download_media: Type.Optional(mediaSelectionSchema(
        "Media indices from the listing to download into the workspace (or \"all\"). Photos at original resolution; videos/GIFs as mp4.",
      )),
      view_media: Type.Optional(mediaSelectionSchema(
        `Media indices to return inline as image blocks (or "all", clamped to ${config.maxViewBlocks} per call). Videos/GIFs return their thumbnail frame.`,
      )),
    }),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as XFetchParams;
      const ref = parseXStatusUrl(params.url, context.statusHosts);
      if (!ref) {
        throw new Error(
          "Not a recognizable X status URL. Pass an x.com/twitter.com status link, an FxTwitter share link, or a bare numeric status id.",
        );
      }

      const tweet = await context.client.fetchStatus(ref.statusId, ref.screenName);
      const document = buildTweetDocument(tweet, config.maxTotalChars);

      // Text window.
      const maxChars = Math.min(params.max_chars ?? config.defaultMaxChars, config.maxCharsLimit);
      const totalChars = document.text.length;
      const offset = Math.min(Math.max(params.offset ?? 0, 0), totalChars);
      const windowEnd = Math.min(offset + maxChars, totalChars);
      const truncated = windowEnd < totalChars;
      let text = document.text.slice(offset, windowEnd);
      if (truncated) text += `\n[truncated — continue with offset=${windowEnd}]`;

      const textSections: string[] = [text];
      const details: Record<string, unknown> = {
        statusId: ref.statusId,
        url: ref.canonicalUrl,
        totalChars,
        nextOffset: truncated ? windowEnd : null,
        truncated,
        mediaCount: document.media.length,
      };

      const downloadSelection = resolveSelection(params.download_media, document.media, "download_media");
      if (downloadSelection.length > 0) {
        const saved = await downloadMedia(context, ref.statusId, downloadSelection);
        textSections.push(
          ["Downloaded media:", ...saved.map((s) => `  [${s.index}] ${s.kind} → ${s.path}`)].join("\n"),
        );
        details.downloaded = saved;
      }

      const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
      let viewSelection = resolveSelection(params.view_media, document.media, "view_media");
      if (viewSelection.length > config.maxViewBlocks) {
        textSections.push(
          `[view_media clamped to the first ${config.maxViewBlocks} of ${viewSelection.length} selected items]`,
        );
        viewSelection = viewSelection.slice(0, config.maxViewBlocks);
      }
      if (viewSelection.length > 0) {
        const viewNotes: string[] = [];
        for (const item of viewSelection) {
          const block = await viewMediaItem(context, item, viewNotes);
          if (block) imageBlocks.push(block);
        }
        if (viewNotes.length > 0) textSections.push(viewNotes.join("\n"));
        details.viewed = viewSelection.map((item) => item.index);
      }

      return {
        content: [
          { type: "text" as const, text: textSections.join("\n\n") },
          ...imageBlocks,
        ],
        details,
      };
    },
  };
}

function resolveSelection(
  selection: MediaSelection | undefined,
  media: XFetchMediaItem[],
  field: string,
): XFetchMediaItem[] {
  if (selection === undefined) return [];
  if (selection === "all") return [...media];
  return selection.map((index) => {
    const item = media.find((m) => m.index === index);
    if (!item) {
      if (media.length === 0) {
        throw new Error(`${field}: this tweet has no media.`);
      }
      throw new Error(`${field}: index ${index} is out of range (valid: 1–${media.length}).`);
    }
    return item;
  });
}

async function downloadMedia(
  context: XFetchToolContext,
  statusId: string,
  items: XFetchMediaItem[],
): Promise<Array<{ index: number; kind: string; path: string }>> {
  const dir = resolveWorkspacePath(context.workspaceRoot, path.posix.join("downloads/x", statusId));
  await fs.mkdir(dir, { recursive: true });
  const saved: Array<{ index: number; kind: string; path: string }> = [];
  for (const item of items) {
    const fetched = await context.fetchClient.fetch(item.url);
    try {
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        throw new Error(`Media fetch [${item.index}] failed with HTTP ${fetched.statusCode}`);
      }
      const filename = mediaFilename(item);
      const target = await writeExclusive(dir, filename, await fs.readFile(fetched.path));
      saved.push({ index: item.index, kind: item.kind, path: workspaceRelative(context.workspaceRoot, target) });
    } finally {
      await fs.unlink(fetched.path).catch(() => {});
    }
  }
  return saved;
}

async function viewMediaItem(
  context: XFetchToolContext,
  item: XFetchMediaItem,
  notes: string[],
): Promise<{ type: "image"; data: string; mimeType: string } | null> {
  // Photos return directly; a video cannot be an image block, so its
  // thumbnail frame substitutes (labeled in the notes).
  let url = item.url;
  if (item.kind !== "photo") {
    if (!item.thumbnailUrl) {
      notes.push(`[media ${item.index}: ${item.kind} has no thumbnail to show inline — use download_media instead]`);
      return null;
    }
    url = item.thumbnailUrl;
    notes.push(`[media ${item.index}: showing the ${item.kind}'s thumbnail frame — download_media fetches the mp4]`);
  }
  const fetched = await context.fetchClient.fetch(url);
  let raw: Buffer;
  try {
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      notes.push(`[media ${item.index}: fetch failed with HTTP ${fetched.statusCode}]`);
      return null;
    }
    raw = await fs.readFile(fetched.path);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }
  // Same conditioning pipeline + base64 budget as the danbooru preview path:
  // `maxImageBytes` is an encoded budget; the conditioner targets raw bytes.
  const rawByteBudget = Math.floor((context.maxImageBytes * 3) / 4);
  try {
    const conditioned = await conditionImageBufferForInference(raw, {
      ...context.inferenceImageOptions,
      maxBytes: rawByteBudget,
    });
    return {
      type: "image" as const,
      data: conditioned.buffer.toString("base64"),
      mimeType: conditioned.mimeType,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    notes.push(`[media ${item.index}: could not be conditioned for inline viewing: ${detail}]`);
    return null;
  }
}

function mediaFilename(item: XFetchMediaItem): string {
  let base = "";
  try {
    base = path.posix.basename(new URL(item.url).pathname);
  } catch {
    /* fall through */
  }
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned) return cleaned;
  const ext = item.kind === "photo" ? "jpg" : "mp4";
  return `media-${item.index}.${ext}`;
}

/** Exclusive-create write with a bounded collision-suffix loop. */
async function writeExclusive(dir: string, filename: string, data: Buffer): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let suffix = 0; suffix <= 100; suffix++) {
    const candidate = path.join(dir, suffix === 0 ? filename : `${stem}-${suffix}${ext}`);
    try {
      const handle = await fs.open(candidate, "wx");
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not find a free filename for ${filename} after 100 attempts.`);
}
