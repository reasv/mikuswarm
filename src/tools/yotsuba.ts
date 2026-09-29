/**
 * 4chan (yotsuba) browsing tool.
 * (spec/YOTSUBA-SUPPORT.md §7, §9, §10)
 *
 * One tool, `yotsuba`, with five actions:
 *   boards   — list all boards (or filter by query)
 *   catalog  — search / browse a board's catalog
 *   thread   — read a thread in one of five views
 *   view     — inspect a post's file (vision: image block; non-vision: caption)
 *   download — save post file(s) to the workspace
 *
 * Description opens "4chan (yotsuba): …" so the name and the code name are
 * tied together once (spec §0).
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { YotsubaClient } from "../yotsuba/client.js";
import type { ResolvedYotsubaConfig, ApiBoard, ApiCatalogThread } from "../yotsuba/types.js";
import { parseToolInput } from "../yotsuba/url.js";
import { convertComment } from "../yotsuba/markup.js";
import {
  buildThreadGraph,
  repliesTo,
  mostRepliedPosts,
  searchPosts,
  ancestorChain,
} from "../yotsuba/graph.js";
import type { GraphPost, ThreadGraph } from "../yotsuba/graph.js";
import type { Slot } from "../yotsuba/view.js";
import { runView, isGapMarker, isPlacedPost } from "../yotsuba/view.js";
import {
  threadOpenTag,
  postElement,
  omittedElement,
  boardLabel,
  type FileRenderInfo,
} from "../yotsuba/format.js";
import type { YotsubaPostNode } from "../yotsuba/types.js";
import { safeYotsubaExt, safeYotsubaTim } from "../yotsuba/types.js";
import { buildStoryboard } from "../media/storyboard.js";
import { extractPdfText, parsePageRange } from "../media/pdf.js";
import {
  conditionImageBufferForInference,
  type ImageProcessingOptions,
} from "../media/index.js";
import type { InferenceClient } from "../captioning/inference-client.js";
import type { FetchClient } from "../enrichment/fetch-client.js";
import type { ToolUsageRecord } from "./image-gen.js";
import { estimateTokens } from "../context/tokens.js";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import { escapeXml, escapeAttr } from "../context/xml.js";
import { compactAgentTimestamp } from "../time/index.js";

// ---------------------------------------------------------------------------
// Context injected at construction time
// ---------------------------------------------------------------------------

export interface YotsubaToolContext {
  client: YotsubaClient;
  config: ResolvedYotsubaConfig;
  workspaceRoot: string;
  /** Whether the agent's reply model can receive inline image blocks. */
  modelHasVision: boolean;
  /** Per-image base64 byte cap (matches read_image / danbooru). */
  maxImageBytes: number;
  /** Image conditioning pipeline options (same as danbooru / read_image). */
  inferenceImageOptions: ImageProcessingOptions;
  /** Caption client for the non-vision `view` path. Optional. */
  imageCaptionClient?: InferenceClient;
  /** Agent session id for usage ledger attribution. */
  agentSessionId?: string | null;
  /** Durable usage-ledger sink. */
  recordToolUsage?: (record: ToolUsageRecord) => void;
  /** FetchClient for file downloads via the media lane. */
  fetchClient: FetchClient;
}

// ---------------------------------------------------------------------------
// MIME type helpers
// ---------------------------------------------------------------------------

function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webm": return "video/webm";
    case ".mp4": return "video/mp4";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function isAnimated(ext: string): boolean {
  return ext.toLowerCase() === ".gif" || ext.toLowerCase() === ".webm" || ext.toLowerCase() === ".mp4";
}

function isImage(ext: string): boolean {
  return [".jpg", ".jpeg", ".png", ".gif"].includes(ext.toLowerCase());
}

function isPdf(ext: string): boolean {
  return ext.toLowerCase() === ".pdf";
}

// ---------------------------------------------------------------------------
// Board normalization
// ---------------------------------------------------------------------------

function normalizeBoard(input: string | undefined | null): string | null {
  if (!input || typeof input !== "string") return null;
  // Accept: g, /g/, /g
  const s = input.trim().replace(/^\//, "").replace(/\/$/, "").toLowerCase();
  if (!s || !/^[a-z0-9]{1,10}$/.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Naive input tolerance for thread/post fields
// ---------------------------------------------------------------------------

interface ParsedRef {
  board?: string;
  threadNo?: number;
  postNo?: number;
  isCrossQuote?: boolean;
}

function parseRef(input: unknown): ParsedRef | null {
  if (input == null) return null;
  if (typeof input === "number") {
    if (!isFinite(input) || input === 0) return null;
    return { threadNo: Math.round(input) };
  }
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return null;
    return parseToolInput(s);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fuzzy board matching for error messages
// ---------------------------------------------------------------------------

function closestBoards(target: string, boards: ApiBoard[], n = 3): string[] {
  const candidates = boards.filter((b) => b.board);
  // Exact substring match first, then fallback to title match.
  const scored = candidates.map((b) => {
    const code = b.board!.toLowerCase();
    const title = (b.title ?? "").toLowerCase();
    let score = 0;
    if (code === target) score = 100;
    else if (code.includes(target) || target.includes(code)) score = 50;
    else if (title.includes(target)) score = 30;
    return { b, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => `/${s.b.board}/ (${s.b.title ?? "?"})`);
}

// ---------------------------------------------------------------------------
// Build post nodes from API data
// ---------------------------------------------------------------------------

function apiPostToNode(p: {
  no?: number;
  name?: string;
  trip?: string;
  id?: string;
  capcode?: string;
  country?: string;
  country_name?: string;
  flag_name?: string;
  time?: number;
  com?: string;
  replies?: number;
  tim?: number;
  filename?: string;
  ext?: string;
  fsize?: number;
  w?: number;
  h?: number;
  filedeleted?: number;
  spoiler?: number;
}, index: number, role: YotsubaPostNode["role"]): YotsubaPostNode {
  const converted = convertComment(p.com);
  return {
    no: p.no ?? 0,
    index,
    role,
    name: p.name && p.name !== "Anonymous" ? p.name : undefined,
    trip: p.trip,
    posterId: p.id,
    capcode: p.capcode,
    flag: p.country_name ?? p.flag_name ?? p.country,
    time: (p.time ?? 0) * 1000,
    text: converted.text,
    quotes: converted.quotes,
    deadQuotes: converted.deadQuotes,
    crossQuotes: converted.crossQuotes,
    replies: p.replies ?? 0,
    file: safeYotsubaTim(p.tim) && safeYotsubaExt(p.ext) ? {
      name: p.filename ?? "",
      ext: safeYotsubaExt(p.ext)!,
      w: p.w,
      h: p.h,
      bytes: p.fsize,
      spoiler: p.spoiler === 1,
      deleted: p.filedeleted === 1,
      tim: safeYotsubaTim(p.tim)!,
    } : undefined,
  };
}

// ---------------------------------------------------------------------------
// File download helpers
// ---------------------------------------------------------------------------

async function downloadFileToTemp(
  ctx: YotsubaToolContext,
  board: string,
  tim: number,
  ext: string,
  thumb = false,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  const fileRef = thumb ? `${tim}s.jpg` : `${tim}${ext}`;
  let buf: Buffer;
  try {
    buf = await ctx.client.fetchFile(board, fileRef, "interactive");
  } catch {
    return null;
  }
  const tmpPath = path.join(os.tmpdir(), `miku-yotsuba-${randomBytes(8).toString("hex")}${thumb ? ".jpg" : ext}`);
  await fs.writeFile(tmpPath, buf);
  return { path: tmpPath, cleanup: () => fs.unlink(tmpPath).catch(() => {}) };
}

/** Condition a buffer to a base64-encoded image block. */
async function conditionToBlock(
  ctx: YotsubaToolContext,
  buf: Buffer,
): Promise<{ data: string; mimeType: string } | null> {
  const rawByteBudget = Math.floor((ctx.maxImageBytes * 3) / 4);
  try {
    const conditioned = await conditionImageBufferForInference(buf, {
      ...ctx.inferenceImageOptions,
      maxBytes: rawByteBudget,
    });
    return { data: conditioned.buffer.toString("base64"), mimeType: conditioned.mimeType };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exclusive-create write with collision suffixes (matching x_fetch convention)
// ---------------------------------------------------------------------------

async function writeExclusive(dir: string, filename: string, data: Buffer): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let suffix = 0; suffix <= 100; suffix++) {
    const candidate = path.join(dir, suffix === 0 ? filename : `${stem}-${suffix}${ext}`);
    try {
      const handle = await fs.open(candidate, "wx");
      try { await handle.writeFile(data); } finally { await handle.close(); }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not find a free filename for ${filename} after 100 attempts.`);
}

// ---------------------------------------------------------------------------
// Thread output building
// ---------------------------------------------------------------------------

function buildFileInfoForDisplay(
  post: GraphPost,
  fileShown: boolean,
  blockIndex?: number,
): FileRenderInfo | undefined {
  const f = post.file;
  if (!f) return undefined;
  const mime = extToMime(f.ext);
  if (f.deleted) {
    return {
      name: f.name, ext: f.ext, mimeType: mime,
      w: f.w, h: f.h, bytes: f.bytes, durationSec: f.durationSec,
      spoiler: f.spoiler, deleted: true,
      status: "deleted",
    };
  }
  if (!fileShown) {
    return {
      name: f.name, ext: f.ext, mimeType: mime,
      w: f.w, h: f.h, bytes: f.bytes, durationSec: f.durationSec,
      spoiler: f.spoiler,
      status: "not shown",
    };
  }
  return {
    name: f.name, ext: f.ext, mimeType: mime,
    w: f.w, h: f.h, bytes: f.bytes, durationSec: f.durationSec,
    spoiler: f.spoiler,
    status: "shown",
    blockIndex,
  };
}

// ---------------------------------------------------------------------------
// Tool footer building
// ---------------------------------------------------------------------------

function buildThreadFooter(opts: {
  board: string;
  threadNo: number;
  view: string;
  postNo?: number;
  query?: string;
  after?: number;
  placedCount: number;
  totalPosts: number;
  shownFiles: number;
  totalFiles: number;
  pageFiles: number;
  hasNextPage: boolean;
  nextAfter?: number;
  unplacedPosts: Array<{ no: number; role: string }>;
  postsWithUnshownFiles: number[];
  asOf: number;
  fromCache: boolean;
  cachedAgoSec?: number;
}): string {
  const lines: string[] = [];

  // Freshness line
  const freshness = opts.fromCache && opts.cachedAgoSec != null
    ? `, cached ${opts.cachedAgoSec}s ago`
    : "";
  const asOfStr = compactAgentTimestamp(new Date(opts.asOf));

  // Shown summary
  lines.push(`[Shown: ${opts.placedCount} of ${opts.totalPosts} posts, ${opts.shownFiles} of ${opts.totalFiles} files as images; as_of ${asOfStr}${freshness}.`);

  // Next page
  if (opts.hasNextPage && opts.nextAfter != null) {
    const nextCall = JSON.stringify({
      action: "thread",
      board: opts.board,
      thread: opts.threadNo,
      view: opts.view,
      ...(opts.postNo ? { post: opts.postNo } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      after: opts.nextAfter,
    });
    lines.push(` Next page: ${nextCall}`);
  }

  // Posts not shown (non-pinned unplaced)
  const notShownNos = opts.unplacedPosts.map((u) => u.no).filter(Boolean);
  if (notShownNos.length > 0) {
    const sample = notShownNos[0]!;
    // Conversation link for the first not-shown post (literal JSON the agent can execute)
    const openCall = JSON.stringify({
      action: "thread",
      board: opts.board,
      thread: opts.threadNo,
      post: sample,
    });
    const others = notShownNos.length > 1 ? ` (and ${notShownNos.length - 1} more)` : "";
    lines.push(` Posts marked (not shown): open >>${sample}${others} with ${openCall}`);
  }

  // Files not shown on this page
  if (opts.postsWithUnshownFiles.length > 0) {
    const refs = opts.postsWithUnshownFiles.map((n) => `>>${n}`).join(" ");
    const viewCall = JSON.stringify({
      action: "view",
      board: opts.board,
      thread: opts.threadNo,
      posts: opts.postsWithUnshownFiles.slice(0, 20),
    });
    lines.push(` Files not shown on this page: ${refs}`);
    lines.push(`   view them: ${viewCall}`);
  }

  lines.push("]");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Slot builders for each view
// ---------------------------------------------------------------------------

function buildChronologicalSlots(
  graph: ThreadGraph,
  after?: number,
): Slot[] {
  let startIdx = 0;
  if (after != null) {
    const afterPost = graph.byNo.get(after);
    if (afterPost) startIdx = afterPost.index + 1;
  }
  const posts = graph.posts.slice(startIdx);
  return posts.map((p, i) => ({
    no: p.no,
    role: i === 0 && startIdx === 0 ? ("op" as const) : ("latest" as const),
    tier: "full" as const,
    priority: startIdx + i,
    pinned: false,
  }));
}

function buildConversationSlots(
  graph: ThreadGraph,
  focusNo: number,
): Slot[] {
  const slots: Slot[] = [];

  // Focus post (pinned)
  slots.push({ no: focusNo, role: "linked", tier: "full", pinned: true, priority: 0 });

  // Ancestors up to depth 3 (depth 1 = full, deeper = excerpt)
  const ancestors = ancestorChain(graph, focusNo, 3);
  for (let i = 0; i < ancestors.length; i++) {
    const depth = ancestors.length - i; // 1 = most direct parent
    slots.push({
      no: ancestors[i]!.no,
      role: "replied_to",
      tier: depth === 1 ? "full" : "excerpt",
      priority: 10 + i,
    });
  }

  // OP (pinned if not already in ancestors/focus)
  if (graph.opNo !== focusNo && !ancestors.some((a) => a.no === graph.opNo)) {
    slots.push({ no: graph.opNo, role: "op", tier: "full", pinned: true, priority: 1 });
  }

  // First replies to focus (full)
  const replies = repliesTo(graph, focusNo);
  for (let i = 0; i < replies.length; i++) {
    slots.push({ no: replies[i]!.no, role: "reply", tier: "full", priority: 20 + i });
  }

  // Each shown reply's replies (excerpts)
  let excerptPriority = 50;
  for (const reply of replies) {
    const subReplies = repliesTo(graph, reply.no);
    for (const sr of subReplies) {
      slots.push({ no: sr.no, role: "context", tier: "excerpt", priority: excerptPriority++ });
    }
  }

  return slots;
}

function buildRepliesSlots(
  graph: ThreadGraph,
  focusNo: number,
  after?: number,
): Slot[] {
  const slots: Slot[] = [];
  // Focus post (pinned)
  slots.push({ no: focusNo, role: "linked", tier: "full", pinned: true, priority: 0 });

  let replies = repliesTo(graph, focusNo);
  if (after != null) {
    const afterIdx = replies.findIndex((r) => r.no === after);
    if (afterIdx >= 0) replies = replies.slice(afterIdx + 1);
  }

  for (let i = 0; i < replies.length; i++) {
    slots.push({ no: replies[i]!.no, role: "reply", tier: "full", priority: 10 + i });
  }

  // Excerpts of posts each reply quotes (context)
  let excerptPriority = 100;
  for (const reply of replies) {
    for (const qNo of reply.quotes) {
      if (qNo !== focusNo) {
        slots.push({ no: qNo, role: "context", tier: "excerpt", priority: excerptPriority++ });
      }
    }
  }

  return slots;
}

function buildMostRepliedSlots(
  graph: ThreadGraph,
  after?: number,
): Slot[] {
  const ranked = mostRepliedPosts(graph, 2, after);
  const slots: Slot[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i]!;
    slots.push({ no: p.no, role: "most_replied", tier: "full", priority: i });
    // Posts it quotes (as excerpts)
    for (const qNo of p.quotes) {
      slots.push({ no: qNo, role: "replied_to", tier: "excerpt", priority: 1000 + i * 10 });
    }
  }
  return slots;
}

function buildSearchSlots(
  graph: ThreadGraph,
  terms: string[],
  after?: number,
): Slot[] {
  const matches = searchPosts(graph, terms, after);
  const slots: Slot[] = [];
  for (let i = 0; i < matches.length; i++) {
    const p = matches[i]!;
    slots.push({ no: p.no, role: "match", tier: "full", priority: i });
    // Posts it quotes (as excerpts)
    for (const qNo of p.quotes) {
      slots.push({ no: qNo, role: "replied_to", tier: "excerpt", priority: 1000 + i * 10 });
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Thread renderer
// ---------------------------------------------------------------------------

/** Per-post rendering overhead beyond its escaped text (element, attributes, file element, gap marker). */
const POST_RENDER_OVERHEAD_TOKENS = 45;

type ImageBlock = { type: "image"; data: string; mimeType: string };

async function renderThread(
  ctx: YotsubaToolContext,
  opts: {
    board: string;
    boardTitle: string | undefined;
    threadNo: number;
    posts: Array<{
      no?: number;
      name?: string;
      trip?: string;
      id?: string;
      capcode?: string;
      country?: string;
      flag_name?: string;
      time?: number;
      com?: string;
      replies?: number;
      images?: number;
      unique_ips?: number;
      sticky?: number;
      closed?: number;
      archived?: number;
      archived_on?: number;
      bumplimit?: number;
      imagelimit?: number;
      sub?: string;
      tim?: number;
      filename?: string;
      ext?: string;
      fsize?: number;
      w?: number;
      h?: number;
      filedeleted?: number;
      spoiler?: number;
      [key: string]: unknown;
    }>;
    view: string;
    postNo?: number;
    query?: string;
    after?: number;
    maxTokens?: number;
    filesOff?: boolean;
    fetchedAt: number;
    fromCache: boolean;
  },
): Promise<{ content: Array<{ type: "text"; text: string } | ImageBlock>; details: Record<string, unknown> }> {
  const { config } = ctx;
  const toolCfg = config.tool;

  const pageTokens = Math.min(opts.maxTokens ?? toolCfg.pageTokens, toolCfg.pageTokensMax);
  // -1 = show no files (runView treats 0 as "no limit"); every file then
  // lands in the footer's "not shown" list with its view call.
  // Without vision nothing is sent as an image, so every file counts as not
  // shown and the footer points at "view" (which captions them).
  const filesPerPage = opts.filesOff || !ctx.modelHasVision ? -1 : toolCfg.filesPerPage;

  // Build thread nodes.
  const opApiPost = opts.posts[0];
  const nodes: YotsubaPostNode[] = opts.posts.map((p, i) =>
    apiPostToNode(p, i, i === 0 ? "op" : "latest"),
  );
  const graph = buildThreadGraph(nodes);
  // The API's `replies` is the thread-level reply count (OP only); a post's
  // reply count is its backlinks within the thread.
  for (const gp of graph.posts) gp.replies = gp.backlinks.length;

  const opPost = opts.posts[0];
  const subject = opPost?.sub;
  const postCount = opts.posts.length;
  const fileCount = opts.posts.filter((p) => p.tim != null).length;
  const posters = opApiPost?.unique_ips;

  const statusFlags: string[] = [];
  if (opPost?.sticky) statusFlags.push("sticky");
  if (opPost?.closed) statusFlags.push("closed");
  if (opPost?.archived) statusFlags.push("archived");
  if (opPost?.bumplimit) statusFlags.push("bump limit");
  if (opPost?.imagelimit) statusFlags.push("image limit");

  // Build slot list based on view.
  let slots: Slot[];
  let isContiguous = false;
  const view = opts.view;
  switch (view) {
    case "chronological":
      slots = buildChronologicalSlots(graph, opts.after);
      isContiguous = true;
      break;
    case "conversation":
      slots = buildConversationSlots(graph, opts.postNo ?? graph.opNo);
      break;
    case "replies":
      slots = buildRepliesSlots(graph, opts.postNo ?? graph.opNo, opts.after);
      isContiguous = true;
      break;
    case "most_replied":
      slots = buildMostRepliedSlots(graph, opts.after);
      break;
    case "search": {
      const terms = (opts.query ?? "").split(/\s+/).filter(Boolean);
      slots = buildSearchSlots(graph, terms, opts.after);
      break;
    }
    default:
      slots = buildChronologicalSlots(graph, opts.after);
      isContiguous = true;
  }

  const RESERVE_TOKENS = 250; // thread frame, envelope, footer with next calls
  const result = runView(
    graph,
    slots,
    {
      maxPosts: 200,
      maxTextTokens: pageTokens,
      maxFiles: filesPerPage,
      reserveTokens: RESERVE_TOKENS,
      contiguous: isContiguous,
      excerptFallback: true,
    },
    // Charge what the page actually renders: the escaped text plus each post's
    // element, attributes, file element and gap marker (~45 tokens), so a page
    // stays within max_tokens.
    (text: string) => estimateTokens(escapeXml(text)) + POST_RENDER_OVERHEAD_TOKENS,
  );

  // Collect shown posts with files
  const placedWithFiles: Array<{ post: GraphPost; priority: number }> = [];
  for (const item of result.items) {
    if (isPlacedPost(item) && item.fileShown && item.post.file && !item.post.file.deleted) {
      placedWithFiles.push({ post: item.post, priority: item.filePriority });
    }
  }
  placedWithFiles.sort((a, b) => a.priority - b.priority);

  // Build image blocks (vision only, files not off)
  const imageBlocks: ImageBlock[] = [];
  const blockIndexMap = new Map<number, number>(); // postNo → block index
  const fileInfoMap = new Map<number, FileRenderInfo>();

  if (ctx.modelHasVision && filesPerPage > 0) {
    let blockIdx = 1;
    for (const { post } of placedWithFiles.slice(0, filesPerPage)) {
      const f = post.file!;
      if (f.deleted) continue;
      let block: { data: string; mimeType: string } | null = null;
      if (isPdf(f.ext)) {
        // PDF: thumbnail
        const tmp = await downloadFileToTemp(ctx, opts.board, f.tim, f.ext, true);
        if (tmp) {
          try {
            const buf = await fs.readFile(tmp.path);
            block = await conditionToBlock(ctx, buf);
          } finally {
            await tmp.cleanup();
          }
        }
      } else if (isAnimated(f.ext)) {
        // Video/animated GIF: storyboard
        const tmp = await downloadFileToTemp(ctx, opts.board, f.tim, f.ext, false);
        if (tmp) {
          try {
            const storyboard = await buildStoryboard(tmp.path, { timeoutMs: 30_000 });
            if (storyboard) {
              const buf = await fs.readFile(storyboard.path);
              block = await conditionToBlock(ctx, buf);
              await fs.unlink(storyboard.path).catch(() => {});
            }
          } finally {
            await tmp.cleanup();
          }
        }
      } else if (isImage(f.ext)) {
        const tmp = await downloadFileToTemp(ctx, opts.board, f.tim, f.ext, false);
        if (tmp) {
          try {
            const buf = await fs.readFile(tmp.path);
            block = await conditionToBlock(ctx, buf);
          } finally {
            await tmp.cleanup();
          }
        }
      }
      if (block) {
        blockIndexMap.set(post.no, blockIdx);
        imageBlocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
        blockIdx++;
      }
    }
  }

  // Build fileInfoMap
  for (const item of result.items) {
    if (isPlacedPost(item) && item.post.file) {
      const blockIndex = blockIndexMap.get(item.post.no);
      const info = buildFileInfoForDisplay(item.post, item.fileShown, blockIndex);
      if (info) fileInfoMap.set(item.post.no, info);
    }
  }

  // Build the XML content
  const boardStr = boardLabel(opts.board, opts.boardTitle);
  const shownNos = new Set<number>();
  for (const item of result.items) {
    if (isPlacedPost(item)) shownNos.add(item.post.no);
  }

  const innerParts: string[] = [];
  // Image block labels (vision only)
  const labelParts: string[] = [];
  if (imageBlocks.length > 0) {
    for (const item of result.items) {
      if (isPlacedPost(item)) {
        const bi = blockIndexMap.get(item.post.no);
        if (bi != null && item.post.file) {
          labelParts.push(`[image ${bi}: >>${item.post.no} ${item.post.file.name}${item.post.file.ext}]`);
        }
      }
    }
  }

  // Show backlinks for linked/focus posts in conversation/replies view
  const showBacklinksFor = new Set<number>();
  if (view === "conversation" && opts.postNo) showBacklinksFor.add(opts.postNo);
  if (view === "replies" && opts.postNo) showBacklinksFor.add(opts.postNo);
  const allBacklinksMap = new Map<number, number[]>();
  for (const gp of graph.posts) {
    if (gp.backlinks.length > 0) allBacklinksMap.set(gp.no, gp.backlinks);
  }

  for (const item of result.items) {
    if (isGapMarker(item)) {
      innerParts.push(omittedElement(item));
    } else {
      const pp = item;
      const fInfo = fileInfoMap.get(pp.post.no);
      const showBL = showBacklinksFor.has(pp.post.no);
      const blNos = allBacklinksMap.get(pp.post.no);
      const shownBL = blNos ? new Set(blNos.filter((n) => shownNos.has(n))) : undefined;
      innerParts.push(postElement(pp, shownNos, graph.opNo, fInfo, showBL, blNos, shownBL));
    }
  }

  if (result.hasTrailingGap) {
    innerParts.push(omittedElement(result.trailingGap));
  }

  // Build footer
  const postsWithUnshownFiles: number[] = [];
  for (const item of result.items) {
    if (isPlacedPost(item) && item.fileShown === false && item.tier === "full" && item.post.file && !item.post.file.deleted) {
      postsWithUnshownFiles.push(item.post.no);
    }
  }

  // For paged views, determine next cursor
  let hasNextPage = false;
  let nextAfter: number | undefined;
  if (isContiguous && result.hasTrailingGap) {
    // Find last placed post
    const lastPlaced = [...result.items].reverse().find(isPlacedPost);
    if (lastPlaced) {
      hasNextPage = true;
      nextAfter = lastPlaced.post.no;
    }
  } else if (view === "most_replied") {
    // After is rank offset
    // Advance by the ranked posts shown, not the context excerpts placed
    // alongside them; more pages exist only while ranked posts remain.
    const rankedShown = result.items.filter(
      (it) => isPlacedPost(it) && it.role === "most_replied",
    ).length;
    nextAfter = (opts.after ?? 0) + rankedShown;
    hasNextPage = mostRepliedPosts(graph, 2, nextAfter).length > 0;
  } else if (view === "search") {
    const lastPlaced = [...result.items].reverse().find(isPlacedPost);
    if (lastPlaced && result.unplaced.length > 0) {
      hasNextPage = true;
      nextAfter = lastPlaced.post.no;
    }
  }

  const cachedAgoSec = opts.fromCache ? Math.round((Date.now() - opts.fetchedAt) / 1000) : undefined;
  const footer = buildThreadFooter({
    board: opts.board,
    threadNo: opts.threadNo,
    view,
    postNo: opts.postNo,
    query: opts.query,
    after: opts.after,
    placedCount: result.placedCount,
    totalPosts: postCount,
    shownFiles: result.shownFiles,
    totalFiles: fileCount,
    pageFiles: filesPerPage,
    hasNextPage,
    nextAfter,
    unplacedPosts: result.unplaced,
    postsWithUnshownFiles,
    asOf: opts.fetchedAt,
    fromCache: opts.fromCache,
    cachedAgoSec,
  });

  const nonVisionFilesHint = !ctx.modelHasVision && fileCount > 0
    ? `\n[Files are listed as metadata only (your model has no vision); the footer's "view" call captions them.]`
    : "";

  const threadOpenStr = threadOpenTag({
    board: boardStr,
    threadNo: opts.threadNo,
    subject,
    postCount,
    fileCount,
    posters,
    statusFlags: statusFlags.length > 0 ? statusFlags : undefined,
    asOf: opts.fetchedAt,
  });

  const innerContent = [
    ...labelParts,
    ...innerParts,
    footer + nonVisionFilesHint,
  ].join("\n");

  const asOfStr = compactAgentTimestamp(new Date(opts.fetchedAt));
  const envelope = `<untrusted_4chan board="${escapeAttr(opts.board)}" thread="${opts.threadNo}" view="${escapeAttr(view)}" as_of="${escapeAttr(asOfStr)}">\n${threadOpenStr}\n${innerContent}\n</thread>\n</untrusted_4chan>`;

  return {
    content: [
      { type: "text", text: envelope },
      ...imageBlocks,
    ],
    details: {
      board: opts.board,
      threadNo: opts.threadNo,
      view,
      placedCount: result.placedCount,
      totalPosts: postCount,
      imageBlocks: imageBlocks.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Main tool factory
// ---------------------------------------------------------------------------

export function createYotsubaTool(ctx: YotsubaToolContext): AgentTool {
  const { config } = ctx;
  const toolCfg = config.tool;

  return {
    name: "yotsuba",
    label: "4chan browser",
    description:
      "4chan (yotsuba): browse boards, search catalogs, read threads with reply chains, and view or download images, videos and PDFs. " +
      "Actions: boards (list all boards), catalog (search a board), thread (read with views: chronological/conversation/replies/most_replied/search), " +
      "view (inspect a file as image block or caption), download (save files to workspace). " +
      "A thread URL alone is enough to start: the tool infers the action and view automatically.",
    parameters: Type.Object({
      action: Type.Optional(Type.Unsafe<"boards" | "catalog" | "thread" | "view" | "download">({
        type: "string",
        enum: ["boards", "catalog", "thread", "view", "download"],
        description: "Action to perform. Inferred from other fields when absent: url with board → catalog; url with thread → thread; default → thread.",
      })),
      url: Type.Optional(Type.String({
        description: "4chan URL (thread, post, or board). When provided, board/thread/post are inferred from it.",
      })),
      board: Type.Optional(Type.String({
        description: "Board code: g, /g/, /g all work.",
      })),
      thread: Type.Optional(Type.Unsafe<string | number>({
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "Thread number, URL, >>N, or >>>/g/N.",
      })),
      post: Type.Optional(Type.Unsafe<string | number>({
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "Post number for conversation/replies view, or for view/download.",
      })),
      posts: Type.Optional(Type.Array(Type.Unsafe<string | number>({
        anyOf: [{ type: "string" }, { type: "number" }],
      }), {
        description: "Post numbers for view or download (array). Use \"all\" via posts:[\"all\"] not supported — pass numbers or omit to use post field.",
      })),
      view: Type.Optional(Type.Unsafe<"chronological" | "conversation" | "replies" | "most_replied" | "search">({
        type: "string",
        enum: ["chronological", "conversation", "replies", "most_replied", "search"],
        description: "Thread view. Default: chronological (without post/query), conversation (with post), search (with query).",
      })),
      query: Type.Optional(Type.String({
        description: "Search query for catalog or search view (space-separated terms, all must match).",
      })),
      order: Type.Optional(Type.Unsafe<"bump" | "replies" | "files" | "created" | "last_reply">({
        type: "string",
        enum: ["bump", "replies", "files", "created", "last_reply"],
        description: "Catalog sort order (default: bump).",
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: toolCfg.catalogMaxLimit,
        description: `Catalog result limit (default ${toolCfg.catalogDefaultLimit}, max ${toolCfg.catalogMaxLimit}).`,
      })),
      after: Type.Optional(Type.Unsafe<string | number>({
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "Pagination cursor: post number to continue after (chronological/replies/search) or rank offset (most_replied).",
      })),
      max_tokens: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: toolCfg.pageTokensMax,
        description: `Override the page token budget (default ${toolCfg.pageTokens}, max ${toolCfg.pageTokensMax}).`,
      })),
      pages: Type.Optional(Type.String({
        description: 'Page range for PDF text extraction in the view action, e.g. "7-12".',
      })),
      files: Type.Optional(Type.String({
        description: 'Pass "none" to suppress image blocks (text-only pass).',
      })),
    }),
    execute: async (toolCallId, rawParams) => {
      const params = rawParams as {
        action?: string;
        url?: string;
        board?: string;
        thread?: string | number;
        post?: string | number;
        posts?: Array<string | number>;
        view?: string;
        query?: string;
        order?: string;
        limit?: number;
        after?: string | number;
        max_tokens?: number;
        pages?: string;
        files?: string;
      };

      // Treat empty/zero values as absent
      const clean = (v: string | undefined | null) => (v != null && v.trim() !== "" ? v.trim() : undefined);
      const cleanNum = (v: string | number | undefined | null): string | number | undefined => {
        if (v == null) return undefined;
        if (typeof v === "number") return v === 0 ? undefined : v;
        if (typeof v === "string") return v.trim() === "" || v.trim() === "0" ? undefined : v.trim();
        return undefined;
      };

      const rawUrl = clean(params.url);
      const rawBoard = clean(params.board);
      const rawThread = cleanNum(params.thread);
      const rawPost = cleanNum(params.post);
      const rawAfter = cleanNum(params.after);
      const rawPosts = params.posts?.map(cleanNum).filter((v): v is string | number => v != null);
      const rawQuery = clean(params.query);
      const rawOrder = clean(params.order);
      const rawView = clean(params.view);
      const rawAction = clean(params.action);
      const filesOff = clean(params.files) === "none";

      // --- URL inference ---
      let urlBoard: string | undefined;
      let urlThreadNo: number | undefined;
      let urlPostNo: number | undefined;
      let urlKind: "thread" | "board" | undefined;

      if (rawUrl) {
        const parsed = parseToolInput(rawUrl, config.extraHosts, config.siteBase);
        if (parsed) {
          urlBoard = parsed.board;
          urlThreadNo = parsed.threadNo;
          urlPostNo = parsed.postNo;
          urlKind = parsed.threadNo != null ? "thread" : (parsed.board != null ? "board" : undefined);
        }
      }

      // --- Action inference ---
      let action = rawAction;
      if (!action) {
        if (rawUrl) {
          if (urlKind === "board") action = "catalog";
          else action = "thread";
        } else if (rawThread != null || rawBoard != null) {
          action = "thread";
        } else {
          action = "boards";
        }
      }

      // ================================================================
      // ACTION: boards
      // ================================================================
      if (action === "boards") {
        const result = await ctx.client.boards("interactive");
        const boards = result.body;
        const query = rawQuery?.toLowerCase();
        let filtered = boards.filter((b) => b.board);
        if (query) {
          filtered = filtered.filter((b) => {
            const code = (b.board ?? "").toLowerCase();
            const title = (b.title ?? "").toLowerCase();
            const desc = (b.meta_description ?? "").toLowerCase();
            return code.includes(query) || title.includes(query) || desc.includes(query);
          });
        }
        const lines = filtered.map((b) => {
          const ws = b.ws_board ? " [SFW]" : "";
          return `/${b.board}/ - ${b.title ?? "?"}${ws}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") || "(no boards matched)" }],
          details: { action: "boards", count: lines.length, query: query ?? null },
        };
      }

      // ================================================================
      // ACTION: catalog
      // ================================================================
      if (action === "catalog") {
        const board = normalizeBoard(urlBoard ?? rawBoard);
        if (!board) {
          return {
            content: [{ type: "text", text: "Specify a board: {\"action\":\"catalog\",\"board\":\"g\",\"query\":\"...\"}" }],
            details: { action: "catalog", error: "board_required" },
          };
        }

        // Validate board exists
        const boardsResult = await ctx.client.boards("interactive");
        const boardMeta = boardsResult.body.find((b) => b.board === board);
        if (!boardMeta) {
          const closest = closestBoards(board, boardsResult.body);
          const hint = closest.length > 0 ? ` Closest: ${closest.join(", ")}.` : "";
          return {
            content: [{
              type: "text",
              text: `Unknown board "/${board}/".${hint} Call {"action":"boards"} for the full list.`,
            }],
            details: { action: "catalog", error: "unknown_board", board },
          };
        }

        const catalogResult = await ctx.client.catalog(board, "interactive");
        const pages: Array<{ threads?: ApiCatalogThread[] }> = catalogResult.body;
        const allThreads: ApiCatalogThread[] = pages.flatMap((p) => p.threads ?? []);

        const query = rawQuery;
        const queryTerms = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];

        // Filter by query
        let filtered = allThreads;
        if (queryTerms.length > 0) {
          filtered = allThreads.filter((t) => {
            const subjectLower = (t.sub ?? "").toLowerCase();
            const converted = convertComment(t.com);
            const textLower = converted.text.toLowerCase();
            const combined = subjectLower + " " + textLower;
            return queryTerms.every((term) => combined.includes(term));
          });
        }

        // Sort
        const order = rawOrder ?? "bump";
        switch (order) {
          case "replies":
            filtered = [...filtered].sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0));
            break;
          case "files":
            filtered = [...filtered].sort((a, b) => (b.images ?? 0) - (a.images ?? 0));
            break;
          case "created":
            filtered = [...filtered].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
            break;
          case "last_reply":
            filtered = [...filtered].sort((a, b) => (b.last_modified ?? b.time ?? 0) - (a.last_modified ?? a.time ?? 0));
            break;
          // "bump" = 4chan's natural order, keep as-is
        }

        const limit = Math.min(params.limit ?? toolCfg.catalogDefaultLimit, toolCfg.catalogMaxLimit);
        const afterNum = rawAfter != null ? (typeof rawAfter === "number" ? rawAfter : parseInt(String(rawAfter), 10)) : 0;
        const afterOffset = afterNum > 0 ? afterNum : 0;
        const page = filtered.slice(afterOffset, afterOffset + limit);
        const totalMatching = filtered.length;
        const hasMore = afterOffset + limit < totalMatching;

        const now = Date.now();
        const lines: string[] = [];
        for (const t of page) {
          if (!t.no) continue;
          const subject = t.sub ? `"${t.sub}"` : "(no subject)";
          const replies = t.replies ?? 0;
          const files = t.images ?? 0;
          const started = t.time ? formatRelativeTime(t.time * 1000, now) : "?";
          const lastReply = t.last_modified ? formatRelativeTime(t.last_modified * 1000, now) : "?";
          const statusParts: string[] = [];
          if (t.sticky) statusParts.push("sticky");
          if (t.closed) statusParts.push("closed");
          if (t.archived) statusParts.push("archived");
          if (t.bumplimit) statusParts.push("bump limit");
          if (t.imagelimit) statusParts.push("image limit");
          const statusStr = statusParts.length > 0 ? ` · ${statusParts.join(", ")}` : "";
          const summary = `#${t.no} ${subject} · ${replies} replies · ${files} files · started ${started} · last reply ${lastReply}${statusStr}`;
          const converted = convertComment(t.com);
          const excerpt = converted.text.slice(0, 200);
          lines.push(summary);
          lines.push(excerpt);
          lines.push("");
        }

        let footer = `[${afterOffset + page.length} of ${totalMatching} matching threads shown]`;
        if (hasMore) {
          const nextCall = JSON.stringify({
            action: "catalog",
            board,
            ...(query ? { query } : {}),
            ...(rawOrder && rawOrder !== "bump" ? { order: rawOrder } : {}),
            limit,
            after: afterOffset + limit,
          });
          footer += `\nNext page: ${nextCall}`;
        }
        lines.push(footer);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { action: "catalog", board, query: query ?? null, totalMatching, shown: page.length },
        };
      }

      // ================================================================
      // ACTION: thread
      // ================================================================
      if (action === "thread") {
        // Resolve board
        let board = normalizeBoard(urlBoard ?? rawBoard);

        // Resolve thread ref
        const threadRef = parseRef(rawThread ?? (rawUrl && !urlBoard ? rawUrl : undefined));
        const finalThreadNo = urlThreadNo ?? threadRef?.threadNo;
        // A bare post number arrives from parseRef as `.threadNo` (parseRef treats
        // bare numbers as thread-like); use whichever field is set.
        const rawPostRef = parseRef(rawPost);
        const finalPostNo = urlPostNo ?? rawPostRef?.postNo ?? rawPostRef?.threadNo;
        if (!board && threadRef?.board) board = normalizeBoard(threadRef.board);

        if (!board || !finalThreadNo) {
          // Provide a helpful error
          if (!board) {
            return {
              content: [{ type: "text", text: "Specify a board and thread number, or pass a full 4chan thread URL." }],
              details: { action: "thread", error: "board_required" },
            };
          }
          return {
            content: [{ type: "text", text: "Specify a thread number or pass a full 4chan thread URL." }],
            details: { action: "thread", error: "thread_required" },
          };
        }

        // Determine view
        let view = rawView ?? "chronological";
        if (!rawView) {
          if (finalPostNo != null) view = "conversation";
          else if (rawQuery) view = "search";
          else view = "chronological";
        }

        // Parse after
        let afterNo: number | undefined;
        if (rawAfter != null) {
          const parsed = parseRef(rawAfter);
          afterNo = parsed?.threadNo ?? parsed?.postNo ?? (typeof rawAfter === "number" ? rawAfter : parseInt(String(rawAfter), 10));
          if (!isFinite(afterNo!)) afterNo = undefined;
        }

        // Validate board
        const boardsResult = await ctx.client.boards("interactive");
        const boardMeta = boardsResult.body.find((b) => b.board === board);
        if (!boardMeta) {
          const closest = closestBoards(board, boardsResult.body);
          const hint = closest.length > 0 ? ` Closest: ${closest.join(", ")}.` : "";
          return {
            content: [{
              type: "text",
              text: `Unknown board "/${board}/".${hint} Call {"action":"boards"} for the full list.`,
            }],
            details: { action: "thread", error: "unknown_board", board },
          };
        }

        // Fetch thread
        const threadResult = await ctx.client.thread(board, finalThreadNo, "interactive");
        if (!threadResult) {
          let msg = `Thread ${finalThreadNo} on /${board}/ is gone (pruned or deleted, and not in 4chan's own archive).`;
          // Extra hint when the input was a bare number or cross-quote (could be a reply not a thread)
          const wasBareOrCrossQuote = threadRef?.isCrossQuote || (typeof rawThread === "number" || /^\d+$/.test(String(rawThread ?? "")));
          if (wasBareOrCrossQuote) {
            msg += ` If ${finalThreadNo} is a reply rather than a thread, 4chan cannot map it to its thread: use the full post URL (${config.siteBase}/${board}/thread/<thread>#p${finalThreadNo}), or find the thread with {"action":"catalog","board":"${board}","query":"..."}.`;
          }
          return {
            content: [{ type: "text", text: msg }],
            details: { action: "thread", error: "thread_gone", board, threadNo: finalThreadNo },
          };
        }

        const posts = threadResult.body.posts ?? [];
        if (posts.length === 0) {
          return {
            content: [{ type: "text", text: `Thread ${finalThreadNo} on /${board}/ returned no posts.` }],
            details: { action: "thread", error: "empty_thread", board, threadNo: finalThreadNo },
          };
        }

        // Validate postNo if provided
        if (finalPostNo != null && (view === "conversation" || view === "replies")) {
          const postNos = posts.map((p) => p.no!).filter(Boolean);
          if (!postNos.includes(finalPostNo)) {
            const first = postNos[0]!;
            const last = postNos[postNos.length - 1]!;
            return {
              content: [{
                type: "text",
                text: `>>${finalPostNo} is not in this thread (posts run >>${first} to >>${last}; it may have been deleted). ` +
                  `Try {"action":"thread","board":"${board}","thread":${finalThreadNo},"view":"most_replied"} or ` +
                  `{"action":"thread","board":"${board}","thread":${finalThreadNo},"view":"search","query":"<keyword>"}.`,
              }],
              details: { action: "thread", error: "post_not_found", board, threadNo: finalThreadNo, postNo: finalPostNo },
            };
          }
        }

        return renderThread(ctx, {
          board,
          boardTitle: boardMeta.title,
          threadNo: finalThreadNo,
          posts,
          view,
          postNo: finalPostNo,
          query: rawQuery,
          after: afterNo,
          maxTokens: params.max_tokens ?? undefined,
          filesOff,
          fetchedAt: threadResult.fetchedAt,
          fromCache: threadResult.fromCache,
        });
      }

      // ================================================================
      // ACTION: view
      // ================================================================
      if (action === "view") {
        let board = normalizeBoard(urlBoard ?? rawBoard);
        const threadRef = parseRef(rawThread ?? rawUrl);
        const finalThreadNo = urlThreadNo ?? threadRef?.threadNo;
        if (!board && threadRef?.board) board = normalizeBoard(threadRef.board);

        if (!board || !finalThreadNo) {
          return {
            content: [{ type: "text", text: "Specify board and thread (or a thread URL) to view files from." }],
            details: { action: "view", error: "board_thread_required" },
          };
        }

        // Collect post numbers
        const postNums: number[] = [];
        if (rawPosts && rawPosts.length > 0) {
          for (const p of rawPosts) {
            const ref = parseRef(p);
            const n = ref?.threadNo ?? ref?.postNo;
            if (n) postNums.push(n);
          }
        } else if (rawPost != null) {
          const ref = parseRef(rawPost);
          const n = ref?.threadNo ?? ref?.postNo;
          if (n) postNums.push(n);
        } else if (urlPostNo != null) {
          postNums.push(urlPostNo);
        }

        if (postNums.length === 0) {
          return {
            content: [{ type: "text", text: "Specify post number(s) to view files from (posts field or post field)." }],
            details: { action: "view", error: "posts_required" },
          };
        }

        // Fetch thread to get file metadata
        const threadResult = await ctx.client.thread(board, finalThreadNo, "interactive");
        if (!threadResult) {
          return {
            content: [{ type: "text", text: `Thread ${finalThreadNo} on /${board}/ is gone.` }],
            details: { action: "view", error: "thread_gone" },
          };
        }

        const posts = threadResult.body.posts ?? [];
        const postMap = new Map(posts.map((p) => [p.no!, p]));

        const viewMaxFiles = toolCfg.viewMaxFiles;
        const requested = postNums.slice(0, viewMaxFiles);
        const remainder = postNums.slice(viewMaxFiles);

        const textParts: string[] = [];
        const imageBlocks: ImageBlock[] = [];
        let blockIdx = 1;

        for (const postNo of requested) {
          const apiPost = postMap.get(postNo);
          if (!apiPost) {
            textParts.push(`>>${postNo}: not found in this thread.`);
            continue;
          }

          if (!apiPost.tim) {
            textParts.push(`>>${postNo}: no file attached.`);
            continue;
          }

          if (apiPost.filedeleted) {
            textParts.push(`>>${postNo}: file was deleted.`);
            continue;
          }

          const tim = apiPost.tim;
          const ext = safeYotsubaExt(apiPost.ext);
          if (!ext || !safeYotsubaTim(apiPost.tim)) {
            textParts.push(`>>${postNo}: unrecognized file type.`);
            continue;
          }
          const filename = (apiPost.filename ?? "") + ext;
          const mime = extToMime(ext);
          const dims = apiPost.w && apiPost.h ? ` dims="${apiPost.w}x${apiPost.h}"` : "";
          const size = apiPost.fsize ? ` size="${formatBytes(apiPost.fsize)}"` : "";

          if (isPdf(ext)) {
            // PDF: thumbnail + text extraction
            const thumb = await downloadFileToTemp(ctx, board, tim, ext, true);
            let thumbnailBlock: { data: string; mimeType: string } | null = null;
            if (thumb) {
              try {
                const buf = await fs.readFile(thumb.path);
                thumbnailBlock = await conditionToBlock(ctx, buf);
              } finally {
                await thumb.cleanup();
              }
            }

            // Text extraction
            const original = await downloadFileToTemp(ctx, board, tim, ext, false);
            let pdfText = "";
            let pdfMeta = "";
            if (original) {
              try {
                const buf = await fs.readFile(original.path);
                const pdfResult = await extractPdfText(buf, {
                  maxChars: toolCfg.pdfMaxChars,
                  pages: clean(params.pages),
                });
                if (pdfResult.noTextLayer) {
                  pdfText = `[No text layer detected — this PDF may be a scanned image. Use download to keep the original.]`;
                } else {
                  pdfText = pdfResult.text;
                  const nextPages = pdfResult.truncated
                    ? `\n[pages ${pdfResult.fromPage}-${pdfResult.toPage} of ${pdfResult.totalPages} shown. ` +
                      `Continue: {"action":"view","board":"${board}","thread":${finalThreadNo},"posts":[${postNo}],"pages":"${pdfResult.toPage + 1}-${pdfResult.totalPages}"}]`
                    : `\n[All ${pdfResult.totalPages} page${pdfResult.totalPages !== 1 ? "s" : ""} extracted.]`;
                  pdfMeta = nextPages;
                }
              } catch (err) {
                pdfText = `[PDF text extraction failed: ${err instanceof Error ? err.message : String(err)}]`;
              } finally {
                await original.cleanup();
              }
            }

            if (ctx.modelHasVision && thumbnailBlock) {
              textParts.push(`>>${postNo} ${filename}${dims}${size} — PDF (page-1 thumbnail, image ${blockIdx}, text below)`);
              textParts.push(pdfText);
              textParts.push(pdfMeta);
              imageBlocks.push({ type: "image", data: thumbnailBlock.data, mimeType: thumbnailBlock.mimeType });
              blockIdx++;
            } else if (!ctx.modelHasVision) {
              // Caption the thumbnail instead of showing it as an image block
              const thumb2 = await downloadFileToTemp(ctx, board, tim, ext, true);
              if (thumb2 && ctx.imageCaptionClient) {
                try {
                  const buf = await fs.readFile(thumb2.path);
                  const captionResult = await ctx.imageCaptionClient.caption({
                    filePath: thumb2.path,
                    mimeType: "image/jpeg",
                    filename: `yotsuba-${board}-${tim}s.jpg`,
                    context: "tool",
                  });
                  if (captionResult.usage && ctx.recordToolUsage) {
                    try {
                      ctx.recordToolUsage({
                        agentSessionId: ctx.agentSessionId ?? null,
                        toolName: "yotsuba",
                        toolCallId,
                        modelId: captionResult.model,
                        logicalModelId: captionResult.logicalModelId,
                        provider: captionResult.provider,
                        usage: captionResult.usage,
                        cost: captionResult.cost ?? 0,
                        ref: `caption:${postNo}`,
                      });
                    } catch { /* ledger is observability */ }
                  }
                  textParts.push(`>>${postNo} ${filename}${dims}${size} — PDF`);
                  textParts.push(`Page 1 thumbnail: ${captionResult.caption}`);
                  textParts.push(pdfText);
                  textParts.push(pdfMeta);
                  void buf; // used in caption
                } finally {
                  await thumb2.cleanup();
                }
              } else {
                textParts.push(`>>${postNo} ${filename}${dims}${size} — PDF`);
                textParts.push(pdfText);
                textParts.push(pdfMeta);
                if (thumb2) await thumb2.cleanup();
              }
            } else {
              textParts.push(`>>${postNo} ${filename}${dims}${size} — PDF (thumbnail unavailable)`);
              textParts.push(pdfText);
              textParts.push(pdfMeta);
            }
          } else if (isAnimated(ext)) {
            // Video/animated GIF: storyboard + duration/dims/audio
            const duration = apiPost.w ? undefined : undefined; // no standard duration in API
            const tmp = await downloadFileToTemp(ctx, board, tim, ext, false);
            let block: { data: string; mimeType: string } | null = null;
            let storyboardNote = "";
            if (tmp) {
              try {
                const storyboard = await buildStoryboard(tmp.path, { timeoutMs: 30_000 });
                if (storyboard) {
                  const buf = await fs.readFile(storyboard.path);
                  block = await conditionToBlock(ctx, buf);
                  await fs.unlink(storyboard.path).catch(() => {});
                }
              } finally {
                await tmp.cleanup();
              }
            }
            if (!block) {
              // Fallback: thumbnail
              const thumb = await downloadFileToTemp(ctx, board, tim, ext, true);
              if (thumb) {
                try {
                  const buf = await fs.readFile(thumb.path);
                  block = await conditionToBlock(ctx, buf);
                  storyboardNote = " (thumbnail; storyboard unavailable)";
                } finally {
                  await thumb.cleanup();
                }
              }
            }

            const mediaCall = `{"media":"${config.mediaBase}/${board}/${tim}${ext}"}`;
            const durationStr = duration != null ? ` duration="${duration}"` : "";

            if (ctx.modelHasVision && block) {
              textParts.push(`>>${postNo} ${filename}${dims}${durationStr}${size} — video/gif (storyboard${storyboardNote} as image ${blockIdx})\nFor full audio/visual analysis: ${mediaCall}`);
              imageBlocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
              blockIdx++;
            } else if (!ctx.modelHasVision && ctx.imageCaptionClient && block) {
              // Write storyboard to temp file for captioning
              const tmpCapPath = path.join(os.tmpdir(), `miku-yotsuba-cap-${randomBytes(8).toString("hex")}.jpg`);
              try {
                await fs.writeFile(tmpCapPath, Buffer.from(block.data, "base64"));
                const captionResult = await ctx.imageCaptionClient.caption({
                  filePath: tmpCapPath,
                  mimeType: block.mimeType,
                  filename: `yotsuba-${board}-${tim}-storyboard.jpg`,
                  context: "tool",
                });
                if (captionResult.usage && ctx.recordToolUsage) {
                  try {
                    ctx.recordToolUsage({
                      agentSessionId: ctx.agentSessionId ?? null,
                      toolName: "yotsuba",
                      toolCallId,
                      modelId: captionResult.model,
                      logicalModelId: captionResult.logicalModelId,
                      provider: captionResult.provider,
                      usage: captionResult.usage,
                      cost: captionResult.cost ?? 0,
                      ref: `caption:${postNo}`,
                    });
                  } catch { /* ledger */ }
                }
                textParts.push(`>>${postNo} ${filename}${dims}${durationStr}${size} — video/gif${storyboardNote}`);
                textParts.push(`Storyboard: ${captionResult.caption}`);
                textParts.push(`For full audio/visual analysis: ${mediaCall}`);
              } finally {
                await fs.unlink(tmpCapPath).catch(() => {});
              }
            } else {
              textParts.push(`>>${postNo} ${filename}${dims}${durationStr}${size} — video/gif\nFor full audio/visual analysis: ${mediaCall}`);
            }
          } else if (isImage(ext) && ext !== ".gif") {
            // Static image
            const tmp = await downloadFileToTemp(ctx, board, tim, ext, false);
            let block: { data: string; mimeType: string } | null = null;
            if (tmp) {
              try {
                const buf = await fs.readFile(tmp.path);
                block = await conditionToBlock(ctx, buf);
              } finally {
                await tmp.cleanup();
              }
            }

            if (ctx.modelHasVision && block) {
              textParts.push(`>>${postNo} ${filename}${dims}${size} — image ${blockIdx}`);
              imageBlocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
              blockIdx++;
            } else if (!ctx.modelHasVision && ctx.imageCaptionClient && tmp) {
              // Re-download for captioning since we cleaned up above
              const tmp2 = await downloadFileToTemp(ctx, board, tim, ext, false);
              if (tmp2) {
                try {
                  const captionResult = await ctx.imageCaptionClient.caption({
                    filePath: tmp2.path,
                    mimeType: mime,
                    filename,
                    context: "tool",
                  });
                  if (captionResult.usage && ctx.recordToolUsage) {
                    try {
                      ctx.recordToolUsage({
                        agentSessionId: ctx.agentSessionId ?? null,
                        toolName: "yotsuba",
                        toolCallId,
                        modelId: captionResult.model,
                        logicalModelId: captionResult.logicalModelId,
                        provider: captionResult.provider,
                        usage: captionResult.usage,
                        cost: captionResult.cost ?? 0,
                        ref: `caption:${postNo}`,
                      });
                    } catch { /* ledger */ }
                  }
                  textParts.push(`>>${postNo} ${filename}${dims}${size}`);
                  textParts.push(captionResult.caption);
                } finally {
                  await tmp2.cleanup();
                }
              } else {
                textParts.push(`>>${postNo} ${filename}${dims}${size} — image (download failed)`);
              }
            } else {
              textParts.push(`>>${postNo} ${filename}${dims}${size} — type: ${mime}\nURL: ${config.mediaBase}/${board}/${tim}${ext}`);
            }
          } else {
            // Other / unknown type
            textParts.push(`>>${postNo} ${filename}${dims}${size} — type: ${mime}\nURL: ${config.mediaBase}/${board}/${tim}${ext}\nUse download to save it.`);
          }
        }

        // Footer with remainder
        if (remainder.length > 0) {
          const continueCall = JSON.stringify({
            action: "view",
            board,
            thread: finalThreadNo,
            posts: remainder.slice(0, 20),
          });
          textParts.push(`\n[${requested.length} of ${postNums.length} files shown. Continue: ${continueCall}]`);
        }

        return {
          content: [
            { type: "text", text: textParts.join("\n\n") },
            ...imageBlocks,
          ],
          details: { action: "view", board, threadNo: finalThreadNo, postNos: requested, imageBlocks: imageBlocks.length },
        };
      }

      // ================================================================
      // ACTION: download
      // ================================================================
      if (action === "download") {
        let board = normalizeBoard(urlBoard ?? rawBoard);
        const threadRef = parseRef(rawThread ?? rawUrl);
        const finalThreadNo = urlThreadNo ?? threadRef?.threadNo;
        if (!board && threadRef?.board) board = normalizeBoard(threadRef.board);

        if (!board || !finalThreadNo) {
          return {
            content: [{ type: "text", text: "Specify board and thread (or a thread URL) to download from." }],
            details: { action: "download", error: "board_thread_required" },
          };
        }

        // Collect post numbers; "all" is indicated by absence of posts
        let postNums: number[] = [];
        const downloadAll = !rawPosts?.length && rawPost == null;

        if (!downloadAll) {
          if (rawPosts && rawPosts.length > 0) {
            for (const p of rawPosts) {
              const ref = parseRef(p);
              const n = ref?.threadNo ?? ref?.postNo;
              if (n) postNums.push(n);
            }
          } else if (rawPost != null) {
            const ref = parseRef(rawPost);
            const n = ref?.threadNo ?? ref?.postNo;
            if (n) postNums.push(n);
          }
        }

        const threadResult = await ctx.client.thread(board, finalThreadNo, "interactive");
        if (!threadResult) {
          return {
            content: [{ type: "text", text: `Thread ${finalThreadNo} on /${board}/ is gone.` }],
            details: { action: "download", error: "thread_gone" },
          };
        }

        const posts = threadResult.body.posts ?? [];
        const postMap = new Map(posts.map((p) => [p.no!, p]));

        if (downloadAll) {
          postNums = posts
            .filter((p) => p.tim && !p.filedeleted)
            .map((p) => p.no!)
            .filter(Boolean);
        }

        const maxDl = toolCfg.maxDownloadFiles;
        const requested = postNums.slice(0, maxDl);
        const remainder = postNums.slice(maxDl);

        // Download files
        const saved: Array<{ postNo: number; path: string }> = [];
        const failed: Array<{ postNo: number; reason: string }> = [];
        const noFile: number[] = [];
        const withFiles = posts.filter((p) => p.tim && !p.filedeleted).map((p) => p.no!);

        for (const postNo of requested) {
          const apiPost = postMap.get(postNo);
          if (!apiPost) { noFile.push(postNo); continue; }
          if (!apiPost.tim) { noFile.push(postNo); continue; }
          if (apiPost.filedeleted) {
            failed.push({ postNo, reason: "file deleted" });
            continue;
          }

          const tim = apiPost.tim;
          const ext = safeYotsubaExt(apiPost.ext);
          if (!ext || !safeYotsubaTim(apiPost.tim)) { failed.push({ postNo, reason: "unrecognized file type" }); continue; }
          const filename = `${postNo}-${(apiPost.filename ?? String(tim)).replace(/[^A-Za-z0-9._-]+/g, "-")}${ext}`;

          try {
            const buf = await ctx.client.fetchFile(board, `${tim}${ext}`, "interactive");
            const dir = resolveWorkspacePath(
              ctx.workspaceRoot,
              path.posix.join("downloads/yotsuba", board, String(finalThreadNo)),
            );
            await fs.mkdir(dir, { recursive: true });
            const target = await writeExclusive(dir, filename, buf);
            saved.push({ postNo, path: workspaceRelative(ctx.workspaceRoot, target) });
          } catch (err) {
            failed.push({ postNo, reason: err instanceof Error ? err.message : String(err) });
          }
        }

        const textParts: string[] = [];
        if (saved.length > 0) {
          textParts.push("Downloaded:");
          for (const s of saved) textParts.push(`  >>${s.postNo} → ${s.path}`);
        }
        if (noFile.length > 0) {
          const noFileWithFile = noFile.filter((n) => !withFiles.includes(n));
          const noFileFound = noFile.filter((n) => !postMap.has(n));
          if (noFileFound.length > 0) textParts.push(`Not found in thread: ${noFileFound.map((n) => `>>${n}`).join(" ")}`);
          if (noFileWithFile.length > 0) textParts.push(`No file on: ${noFileWithFile.map((n) => `>>${n}`).join(" ")}`);
        }
        if (failed.length > 0) {
          textParts.push("Failed:");
          for (const f of failed) textParts.push(`  >>${f.postNo}: ${f.reason}`);
        }
        if (remainder.length > 0) {
          const continueCall = JSON.stringify({
            action: "download",
            board,
            thread: finalThreadNo,
            posts: remainder.slice(0, 50),
          });
          textParts.push(`\n[${requested.length} of ${postNums.length} files downloaded. Continue: ${continueCall}]`);
        }

        return {
          content: [{ type: "text", text: textParts.join("\n") || "No files downloaded." }],
          details: { action: "download", board, threadNo: finalThreadNo, saved: saved.length, failed: failed.length },
        };
      }

      // Unknown action
      return {
        content: [{ type: "text", text: `Unknown action "${action}". Valid: boards, catalog, thread, view, download.` }],
        details: { error: "unknown_action", action },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatRelativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
