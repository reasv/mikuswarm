/**
 * Yotsuba (4chan) shared rendering vocabulary.
 * (spec/YOTSUBA-SUPPORT.md §5.4, §6.6)
 *
 * Produces the XML elements shared by BOTH the context renderer (phase 2)
 * and the tool (phase 3). The exact layouts here match spec §6.6 so phase 2
 * and phase 3 can build their outputs verbatim from these helpers.
 *
 * All text is escaped with the existing `escapeXml` / `escapeAttr` helpers.
 * File-element rendering takes a per-file render-info object so callers
 * control the asset paths and caption state.
 */

import { escapeXml, escapeAttr } from "../context/xml.js";
import { compactAgentTimestamp } from "../time/index.js";
import type { PlacedPost, GapMarker, ViewResult } from "./view.js";
import { isGapMarker, isPlacedPost, DEFAULT_EXCERPT_CHARS } from "./view.js";
import { annotateQuotes } from "./markup.js";
import type { GraphPost } from "./graph.js";

// ---------------------------------------------------------------------------
// File render info (injected by the caller)
// ---------------------------------------------------------------------------

/**
 * Per-file render information provided by the caller. The caller resolves
 * asset paths, caption state, and storyboard presence before calling the
 * format helpers.
 */
export interface FileRenderInfo {
  /** Original filename (without extension). */
  name: string;
  /** Extension including dot, e.g. ".jpg" */
  ext: string;
  /** MIME type, e.g. "image/png" */
  mimeType?: string;
  /** Width in pixels. */
  w?: number;
  /** Height in pixels. */
  h?: number;
  /** File size in bytes. */
  bytes?: number;
  /** Duration in seconds (for video/gif). */
  durationSec?: number;
  /** True if the file is a spoiler. */
  spoiler?: boolean;
  /** True if the file was deleted from 4chan. */
  deleted?: boolean;
  /**
   * Workspace-relative path to the downloaded file. Absent when not downloaded.
   */
  path?: string;
  /**
   * Workspace-relative path to the storyboard image (for video/gif). Absent
   * when not generated.
   */
  storyboardPath?: string;
  /**
   * Caption text, if available.
   */
  caption?: string;
  /**
   * `"shown"`: file is the active image block for this session.
   * `"stored"`: downloaded but not shown as image block (auto="off").
   * `"not shown"`: not downloaded.
   * `"gone"`: deleted from 4chan after capture.
   */
  status: "shown" | "stored" | "not shown" | "gone" | "deleted";
  /**
   * True when this file's asset should be passed as an image block to the
   * model in the CURRENT session. Only set by the trigger upgrade path.
   */
  imageBlock?: boolean;
  /** Block index for vision tool output (1-based). */
  blockIndex?: number;
}

// ---------------------------------------------------------------------------
// Thread metadata rendering
// ---------------------------------------------------------------------------

/**
 * Build the opening `<thread …>` tag attributes string.
 * Does NOT include the closing angle bracket — callers append children then
 * a `</thread>` close.
 *
 * @param board       Board code + title, e.g. "/g/ - Technology"
 * @param threadNo    Thread post number.
 * @param subject     Thread subject, if any.
 * @param opExcerpt   Short OP excerpt (post links, or thread links w/o subject).
 * @param postCount   Total post count.
 * @param fileCount   Total file count.
 * @param posters     Unique poster count.
 * @param statusFlags Array of status strings ("sticky", "closed", etc.).
 * @param asOf        Epoch ms of the snapshot.
 * @param linkedNo    Linked post number (for post links).
 */
export function threadOpenTag(opts: {
  board: string;
  threadNo: number;
  subject?: string;
  opExcerpt?: string;
  postCount?: number;
  fileCount?: number;
  posters?: number;
  statusFlags?: string[];
  asOf: number;
  linkedNo?: number;
  worksafe?: boolean;
}): string {
  const attrs: string[] = [];
  attrs.push(`board="${escapeAttr(opts.board)}"`);
  attrs.push(`no="${opts.threadNo}"`);
  if (opts.subject) attrs.push(`subject="${escapeAttr(opts.subject)}"`);
  if (opts.opExcerpt) attrs.push(`op_excerpt="${escapeAttr(opts.opExcerpt)}"`);
  if (opts.postCount != null) attrs.push(`posts="${opts.postCount}"`);
  if (opts.fileCount != null) attrs.push(`files="${opts.fileCount}"`);
  if (opts.posters != null) attrs.push(`posters="${opts.posters}"`);
  if (opts.statusFlags && opts.statusFlags.length > 0) {
    attrs.push(`status="${escapeAttr(opts.statusFlags.join(" "))}"`);
  }
  attrs.push(`as_of="${escapeAttr(compactAgentTimestamp(new Date(opts.asOf)))}"`);
  if (opts.linkedNo != null) attrs.push(`linked="${opts.linkedNo}"`);
  return `<thread ${attrs.join(" ")}>`;
}

// ---------------------------------------------------------------------------
// Post element rendering
// ---------------------------------------------------------------------------

/**
 * Build a `<post …>…</post>` element string for a placed post.
 *
 * Author attributes: id, flag, trip, capcode are included when present;
 * `Anonymous` without a trip is omitted (spec §6.6). The role attr is always
 * included. Time uses `compactAgentTimestamp`.
 *
 * `>>N` references in the text are annotated at render time via `annotateQuotes`.
 *
 * @param pp         The placed post (from the view engine).
 * @param shownNos   Set of post numbers in this view (for quote annotation).
 * @param opNo       OP post number (for (OP) annotation).
 * @param fileInfo   File render info for this post's file, if any.
 * @param showBacklinks Whether to include the backlinks line (§5.4).
 * @param backlinkNos  Array of reply post numbers for the backlinks line.
 * @param shownBacklinks  Post numbers from backlinkNos that appear in shownNos.
 */
export function postElement(
  pp: PlacedPost,
  shownNos: ReadonlySet<number>,
  opNo: number,
  fileInfo?: FileRenderInfo,
  showBacklinks?: boolean,
  backlinkNos?: number[],
  shownBacklinks?: ReadonlySet<number>,
): string {
  const post = pp.post;
  const attrs: string[] = [];
  attrs.push(`no="${post.no}"`);
  attrs.push(`role="${pp.role}"`);
  // Author attrs.
  if (post.posterId) attrs.push(`id="${escapeAttr(post.posterId)}"`);
  if (post.flag) attrs.push(`flag="${escapeAttr(post.flag)}"`);
  if (post.trip) attrs.push(`trip="${escapeAttr(post.trip)}"`);
  if (post.capcode) attrs.push(`capcode="${escapeAttr(post.capcode)}"`);
  attrs.push(`time="${escapeAttr(compactAgentTimestamp(new Date(post.time)))}"`);
  if (post.replies > 0) attrs.push(`replies="${post.replies}"`);

  if (pp.tier === "excerpt") attrs.push(`excerpt="true"`);

  const parts: string[] = [];
  parts.push(`<post ${attrs.join(" ")}>`);

  // Text content.
  const deadNos = new Set(post.deadQuotes ?? []);
  let text: string;
  if (pp.tier === "excerpt") {
    const raw = post.text.slice(0, DEFAULT_EXCERPT_CHARS);
    text = annotateQuotes(raw, shownNos, opNo, deadNos);
    parts.push(escapeXml(text));
    if (post.text.length > DEFAULT_EXCERPT_CHARS) parts.push("…");
  } else if (pp.textCap > 0 && post.text.length > pp.textCap) {
    const raw = post.text.slice(0, pp.textCap);
    text = annotateQuotes(raw, shownNos, opNo, deadNos);
    parts.push(escapeXml(text));
    parts.push(`[… ${post.text.length - pp.textCap} more characters]`);
  } else {
    text = annotateQuotes(post.text, shownNos, opNo, deadNos);
    parts.push(escapeXml(text));
  }

  // File element.
  if (pp.tier === "full" && fileInfo) {
    parts.push(fileElement(fileInfo));
  }

  // Backlinks line (§5.4).
  if (showBacklinks && backlinkNos && backlinkNos.length > 0) {
    parts.push(backlinksLine(backlinkNos, shownBacklinks ?? new Set()));
  }

  parts.push("</post>");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// File element
// ---------------------------------------------------------------------------

/**
 * Build a `<file …/>` element (self-closing when no caption).
 *
 * Attributes per spec §6.6: name, type, dims, duration, audio, size, path,
 * storyboard_path, image_block, auto, status, spoiler, block (tool only).
 */
export function fileElement(info: FileRenderInfo): string {
  if (!info) return "";
  const attrs: string[] = [];
  attrs.push(`name="${escapeAttr(info.name + info.ext)}"`);
  if (info.mimeType) attrs.push(`type="${escapeAttr(info.mimeType)}"`);
  if (info.w != null && info.h != null) attrs.push(`dims="${info.w}x${info.h}"`);
  if (info.durationSec != null) {
    const m = Math.floor(info.durationSec / 60);
    const s = Math.floor(info.durationSec % 60);
    attrs.push(`duration="${m}:${s.toString().padStart(2, "0")}"`);
    // Note: audio flag not available from 4chan API; caller may inject it via extra logic
  }
  if (info.bytes != null) attrs.push(`size="${formatBytes(info.bytes)}"`);
  if (info.path) attrs.push(`path="${escapeAttr(info.path)}"`);
  if (info.storyboardPath) attrs.push(`storyboard_path="${escapeAttr(info.storyboardPath)}"`);
  if (info.imageBlock) attrs.push(`image_block="true"`);
  if (info.status === "stored") attrs.push(`auto="off"`);
  if (info.status === "not shown" || info.status === "gone" || info.status === "deleted") {
    attrs.push(`status="${info.status}"`);
  }
  if (info.spoiler) attrs.push(`spoiler="true"`);
  if (info.blockIndex != null) attrs.push(`block="${info.blockIndex}"`);

  if (info.caption) {
    return `<file ${attrs.join(" ")}>\n[caption: ${escapeXml(info.caption)}]\n</file>`;
  }
  return `<file ${attrs.join(" ")}/>`;
}

// ---------------------------------------------------------------------------
// Omitted marker
// ---------------------------------------------------------------------------

/**
 * Build an `<omitted posts="N" files="M"/>` element.
 * When files is 0, the files attribute is omitted.
 */
export function omittedElement(gap: GapMarker): string {
  if (gap.files > 0) {
    return `<omitted posts="${gap.posts}" files="${gap.files}"/>`;
  }
  return `<omitted posts="${gap.posts}"/>`;
}

// ---------------------------------------------------------------------------
// Backlinks line
// ---------------------------------------------------------------------------

/**
 * Build the backlinks line for a post's replies section (§5.4).
 * Format: `[N replies: >>A >>B shown; M more not shown]`
 */
export function backlinksLine(
  allBacklinkNos: number[],
  shownNos: ReadonlySet<number>,
): string {
  const shown = allBacklinkNos.filter((n) => shownNos.has(n));
  const notShownCount = allBacklinkNos.length - shown.length;
  const shownRefs = shown.map((n) => `&gt;&gt;${n}`).join(" ");
  const total = allBacklinkNos.length;
  const notShownText = notShownCount > 0 ? `; ${notShownCount} more not shown` : "";
  return `[${total} replies: ${shownRefs} shown${notShownText}]`;
}

// ---------------------------------------------------------------------------
// Full view rendering
// ---------------------------------------------------------------------------

/**
 * Render a complete view result into the `<thread>…</thread>` inner content.
 * Returns the inner content only (no `<thread>` wrapper — callers add that).
 *
 * @param result        The view result from `runView`.
 * @param graph         The thread graph (for building shownNos).
 * @param fileInfoMap   Map from post number to FileRenderInfo.
 * @param opNo          OP post number.
 * @param showBacklinksFor  Set of post numbers for which to show backlinks.
 * @param allBacklinksMap   Map from post number to all backlink post numbers.
 */
export function renderViewContent(
  result: ViewResult,
  opNo: number,
  fileInfoMap: ReadonlyMap<number, FileRenderInfo>,
  showBacklinksFor?: ReadonlySet<number>,
  allBacklinksMap?: ReadonlyMap<number, number[]>,
): string {
  // Build the set of shown post numbers.
  const shownNos = new Set<number>();
  for (const item of result.items) {
    if (isPlacedPost(item)) shownNos.add(item.post.no);
  }

  const parts: string[] = [];

  for (const item of result.items) {
    if (isGapMarker(item)) {
      parts.push(omittedElement(item));
    } else {
      const pp = item;
      const fInfo = pp.fileShown ? fileInfoMap.get(pp.post.no) : undefined;
      const showBL = showBacklinksFor?.has(pp.post.no) ?? false;
      const blNos = allBacklinksMap?.get(pp.post.no);
      const shownBL = blNos ? new Set(blNos.filter((n) => shownNos.has(n))) : undefined;
      parts.push(postElement(pp, shownNos, opNo, fInfo, showBL, blNos, shownBL));
    }
  }

  if (result.hasTrailingGap) {
    parts.push(omittedElement(result.trailingGap));
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Compact zone (flat text, §6.6 F)
// ---------------------------------------------------------------------------

/**
 * Build the compact-zone flat text line for a thread or board ref.
 * Used in the compact zone of older history (generation sessions).
 *
 * Examples from spec §6.6 F:
 *   [4chan /g/ "/lmg/ - Local Models General" (435 posts): /lmg/ - a general…]
 *   [4chan /g/ "why does every linux distro…" (54 posts), post >>N: because…]
 *   [4chan /g/ board: 3 threads]
 *   [4chan /g/ thread 109800000: already gone when linked]
 */
export function compactLine(opts: {
  board: string;
  kind: "thread" | "board";
  subject?: string;
  opExcerpt?: string;
  postCount?: number;
  linkedNo?: number;
  headlineExcerpt?: string;
  threadNo?: number;
  gone?: boolean;
  threadCount?: number; // for board kind
}): string {
  if (opts.kind === "board") {
    const n = opts.threadCount ?? 0;
    return `[4chan /${opts.board}/ board: ${n} thread${n !== 1 ? "s" : ""}]`;
  }

  if (opts.gone) {
    return `[4chan /${opts.board}/ thread ${opts.threadNo}: already gone when linked]`;
  }

  const count = opts.postCount != null ? ` (${opts.postCount} posts)` : "";
  const label = opts.subject ? `"${opts.subject}"` : opts.opExcerpt ? `"${opts.opExcerpt}"` : "";

  if (opts.linkedNo) {
    const headExcerpt = opts.headlineExcerpt ? `: ${opts.headlineExcerpt}` : "";
    return `[4chan /${opts.board}/ ${label}${count}, post >>${opts.linkedNo}${headExcerpt}]`;
  }

  const headExcerpt = opts.headlineExcerpt ? `: ${opts.headlineExcerpt}` : "";
  return `[4chan /${opts.board}/ ${label}${count}${headExcerpt}]`;
}

// ---------------------------------------------------------------------------
// FTS description (for link_previews.description)
// ---------------------------------------------------------------------------

/**
 * Build the flat text description for FTS indexing. Format: subject or OP
 * excerpt followed by the headline post's text (truncated).
 */
export function ftsDescription(opts: {
  subject?: string;
  opExcerpt?: string;
  headlineText?: string;
  maxChars?: number;
}): string {
  const parts: string[] = [];
  if (opts.subject) parts.push(opts.subject);
  else if (opts.opExcerpt) parts.push(opts.opExcerpt);
  if (opts.headlineText) {
    const max = opts.maxChars ?? 500;
    const text = opts.headlineText.slice(0, max);
    parts.push(text);
  }
  return parts.join(" — ");
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the board code + title string used in the `board` attribute.
 * E.g.: "/g/ - Technology"
 */
export function boardLabel(code: string, title?: string): string {
  if (title) return `/${code}/ - ${title}`;
  return `/${code}/`;
}
