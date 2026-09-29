/**
 * Yotsuba (4chan) types: tolerant API response types, persisted payload types,
 * and resolved config types with a resolver from the raw schema config.
 * (spec/YOTSUBA-SUPPORT.md §4, §6.7, §10)
 */

// ---------------------------------------------------------------------------
// DB source kind
// ---------------------------------------------------------------------------

export const YOTSUBA_SOURCE_KIND = "yotsuba" as const;

/**
 * Validate a file extension from the API before it is used in a URL, a temp
 * path, or a workspace filename: a leading dot plus 1-5 alphanumerics
 * (".jpg", ".webm", ".pdf"). Anything else (a compromised or misconfigured
 * `api_base` sending "/../x") yields undefined and the file is treated as
 * absent. Lower-cased.
 */
export function safeYotsubaExt(ext: string | undefined | null): string | undefined {
  if (typeof ext !== "string") return undefined;
  return /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : undefined;
}

/** A 4chan `tim` must be a positive integer to be used in a file URL or path. */
export function safeYotsubaTim(tim: unknown): number | undefined {
  return typeof tim === "number" && Number.isSafeInteger(tim) && tim > 0 ? tim : undefined;
}

// ---------------------------------------------------------------------------
// 4chan API response types (every field optional — tolerant parsing)
// ---------------------------------------------------------------------------

/** One entry from `boards.json`. */
export interface ApiBoard {
  board?: string;
  title?: string;
  ws_board?: number;          // 1 = worksafe
  meta_description?: string;
  max_comment_chars?: number;
  is_archived?: number;       // 1 = board has an archive
  // counts / other fields tolerated and ignored
  [key: string]: unknown;
}

export interface ApiBoardsResponse {
  boards?: ApiBoard[];
}

/** One post from a thread or catalog. Every field is optional. */
export interface ApiPost {
  no?: number;
  resto?: number;             // 0 = OP, otherwise thread no
  sticky?: number;
  closed?: number;
  archived?: number;
  archived_on?: number;
  now?: string;
  time?: number;
  name?: string;
  trip?: string;
  id?: string;                // poster ID (random per-thread hex)
  capcode?: string;           // mod/admin/etc.
  country?: string;
  country_name?: string;
  board_flag?: string;
  flag_name?: string;
  sub?: string;               // subject
  com?: string;               // comment HTML
  // file fields
  tim?: number;               // epoch ms, unique per file
  filename?: string;
  ext?: string;
  fsize?: number;
  md5?: string;
  w?: number;
  h?: number;
  tn_w?: number;
  tn_h?: number;
  filedeleted?: number;       // 1 = file was deleted
  spoiler?: number;           // 1 = spoiler image
  // thread-level counters (OP only, or catalog)
  replies?: number;
  images?: number;
  unique_ips?: number;
  bumplimit?: number;
  imagelimit?: number;
  // video/audio (webm)
  tag?: string;
  semantic_url?: string;
  // animated gif / video duration (seconds, may be float)
  // not standard in the API; checked on some boards
  [key: string]: unknown;
}

export interface ApiThread {
  posts?: ApiPost[];
}

/** One thread entry in a catalog page. */
export interface ApiCatalogThread extends ApiPost {
  last_replies?: ApiPost[];
  last_modified?: number;
}

export interface ApiCatalogPage {
  page?: number;
  threads?: ApiCatalogThread[];
}

/** Board page (/{b}/N.json). */
export interface ApiBoardPage {
  page?: number;
  threads?: ApiThread[];
}

// ---------------------------------------------------------------------------
// Persisted payload types (§6.7)
// ---------------------------------------------------------------------------

export interface YotsubaPostNode {
  no: number;
  index: number;              // position in thread (0 = OP)
  role: "op" | "linked" | "latest" | "replied_to" | "reply";
  name?: string;
  trip?: string;
  posterId?: string;
  capcode?: string;
  flag?: string;
  time: number;               // epoch ms
  text: string;               // full comment (plain text, markup converted)
  quotes: number[];           // same-thread quotelinks (existing posts)
  deadQuotes?: number[];      // quotelinks to deleted posts
  crossQuotes?: string[];     // cross-thread quotelinks as ">>>/b/N"
  replies: number;            // backlink count
  replyNos?: number[];        // backlink post numbers (if captured)
  file?: YotsubaPostFile;
  // count of files in all thread posts BEFORE this post's position (0-indexed prefix sum)
  filesBefore?: number;
}

export interface YotsubaPostFile {
  name: string;               // original filename (without extension)
  ext: string;                // e.g. ".jpg", ".webm", ".pdf"
  w?: number;
  h?: number;
  bytes?: number;
  durationSec?: number;       // for webm/mp4/gif
  spoiler?: boolean;
  deleted?: boolean;
  tim: number;                // 4chan file id (epoch ms)
  assetId?: string;           // workspace media_asset id; absent = not downloaded
  storyboardAssetId?: string; // for video/animated gif
}

export interface YotsubaPreviewPayload {
  v: 1;
  kind: "thread" | "board";
  board: string;
  boardTitle?: string;
  worksafe?: boolean;
  asOf: number;               // epoch ms of the one fetch
  // thread kind fields
  threadNo?: number;
  subject?: string;
  opExcerpt?: string;
  postCount?: number;
  fileCount?: number;
  posters?: number;
  status?: string[];          // "sticky" | "closed" | "archived" | "bump limit" | "image limit"
  linkedNo?: number;
  linkedMissing?: number;
  headlineNo?: number;
  /** Ambient-rendering cap on the headline text (`[yotsuba.preview].ambient_chars` at capture). */
  ambientChars?: number;
  posts?: YotsubaPostNode[];
  upgrade?: YotsubaUpgradeRecord;
  // board kind fields
  threads?: YotsubaPreviewThread[];
}

export interface YotsubaPreviewThread {
  no: number;
  subject?: string;
  opExcerpt?: string;
  replies: number;
  files: number;
  time: number;               // epoch ms
}

export interface YotsubaUpgradeRecord {
  triggerGroupId: string;
  includedNos: number[];
  processedAssetIds: string[];
  left?: {
    latest?: number;
    repliedTo?: number;
    replies?: number;
  };
  headlineChars?: number;
}

// ---------------------------------------------------------------------------
// URL ref types (§4.1)
// ---------------------------------------------------------------------------

export interface YotsubaThreadRef {
  kind: "thread";
  board: string;
  threadNo: number;
  postNo?: number;            // specific post anchor (#p)
  canonicalUrl: string;
  rawUrl: string;
  bodyIndex: number;
}

export interface YotsubaBoardRef {
  kind: "board";
  board: string;
  canonicalUrl: string;
  rawUrl: string;
  bodyIndex: number;
}

export type YotsubaRef = YotsubaThreadRef | YotsubaBoardRef;

// ---------------------------------------------------------------------------
// Config types (§10)
// ---------------------------------------------------------------------------

/** Raw config from TOML, all fields optional. */
export interface RawYotsubaConfig {
  api_base?: string;
  media_base?: string;
  site_base?: string;
  extra_hosts?: string[];
  min_request_interval_ms?: number;
  max_in_flight?: number;
  media_min_request_interval_ms?: number;
  media_max_in_flight?: number;
  timeout_ms?: number;
  max_response_bytes?: number;
  enrichment?: RawYotsubaEnrichmentConfig;
  preview?: RawYotsubaPreviewConfig;
  tool?: RawYotsubaToolConfig;
}

export interface RawYotsubaEnrichmentConfig {
  enabled?: boolean;
  media_boards?: string;      // "all" | "worksafe"
  board_previews?: boolean;
}

export interface RawYotsubaPreviewConfig {
  ambient_chars?: number;
  op_excerpt_words?: number;
  latest_replies?: number;
  replied_to_max?: number;
  replies_max?: number;
  board_threads?: number;
  trigger_headline_chars?: number;
  trigger_link_tokens?: number;
  trigger_group_tokens?: number;
  trigger_group_files?: number;
}

export interface RawYotsubaToolConfig {
  page_tokens?: number;
  page_tokens_max?: number;
  files_per_page?: number;
  view_max_files?: number;
  pdf_max_chars?: number;
  catalog_default_limit?: number;
  catalog_max_limit?: number;
  max_download_files?: number;
}

/** Resolved (defaults applied) config types. */
export interface ResolvedYotsubaConfig {
  apiBase: string;
  mediaBase: string;
  siteBase: string;
  extraHosts: string[];
  minRequestIntervalMs: number;
  maxInFlight: number;
  mediaMinRequestIntervalMs: number;
  mediaMaxInFlight: number;
  timeoutMs: number;
  maxResponseBytes: number;
  enrichment: ResolvedYotsubaEnrichmentConfig;
  preview: ResolvedYotsubaPreviewConfig;
  tool: ResolvedYotsubaToolConfig;
}

export interface ResolvedYotsubaEnrichmentConfig {
  enabled: boolean;
  mediaBoards: "all" | "worksafe";
  boardPreviews: boolean;
}

export interface ResolvedYotsubaPreviewConfig {
  ambientChars: number;
  opExcerptWords: number;
  latestReplies: number;
  repliedToMax: number;
  repliesMax: number;
  boardThreads: number;
  triggerHeadlineChars: number;
  triggerLinkTokens: number;
  triggerGroupTokens: number;
  triggerGroupFiles: number;
}

export interface ResolvedYotsubaToolConfig {
  pageTokens: number;
  pageTokensMax: number;
  filesPerPage: number;
  viewMaxFiles: number;
  pdfMaxChars: number;
  catalogDefaultLimit: number;
  catalogMaxLimit: number;
  maxDownloadFiles: number;
}

/**
 * Parse a `YotsubaPreviewPayload` from a nullable JSON string. Returns null when
 * the string is absent, empty, or not a valid payload.
 */
export function parseYotsubaPreviewPayload(
  payloadJson: string | null | undefined,
): YotsubaPreviewPayload | null {
  if (!payloadJson) return null;
  try {
    const obj = JSON.parse(payloadJson);
    if (!obj || typeof obj !== "object" || obj.v !== 1) return null;
    return obj as YotsubaPreviewPayload;
  } catch {
    return null;
  }
}

/** Resolve raw config to a fully defaulted config object. */
export function resolveYotsubaConfig(raw?: RawYotsubaConfig): ResolvedYotsubaConfig {
  const r = raw ?? {};
  const e = r.enrichment ?? {};
  const p = r.preview ?? {};
  const t = r.tool ?? {};
  return {
    apiBase: r.api_base ?? "https://a.4cdn.org",
    mediaBase: r.media_base ?? "https://i.4cdn.org",
    siteBase: r.site_base ?? "https://boards.4chan.org",
    extraHosts: r.extra_hosts ?? [],
    minRequestIntervalMs: r.min_request_interval_ms ?? 1000,
    maxInFlight: r.max_in_flight ?? 1,
    mediaMinRequestIntervalMs: r.media_min_request_interval_ms ?? 250,
    mediaMaxInFlight: r.media_max_in_flight ?? 2,
    timeoutMs: r.timeout_ms ?? 15000,
    maxResponseBytes: r.max_response_bytes ?? 8388608,
    enrichment: {
      enabled: e.enabled ?? true,
      mediaBoards: (e.media_boards === "worksafe" ? "worksafe" : "all"),
      boardPreviews: e.board_previews ?? true,
    },
    preview: {
      ambientChars: p.ambient_chars ?? 300,
      opExcerptWords: p.op_excerpt_words ?? 8,
      latestReplies: p.latest_replies ?? 3,
      repliedToMax: p.replied_to_max ?? 3,
      repliesMax: p.replies_max ?? 3,
      boardThreads: p.board_threads ?? 3,
      triggerHeadlineChars: p.trigger_headline_chars ?? 800,
      triggerLinkTokens: p.trigger_link_tokens ?? 900,
      triggerGroupTokens: p.trigger_group_tokens ?? 1800,
      triggerGroupFiles: p.trigger_group_files ?? 4,
    },
    tool: {
      pageTokens: t.page_tokens ?? 6000,
      pageTokensMax: t.page_tokens_max ?? 12000,
      filesPerPage: t.files_per_page ?? 4,
      viewMaxFiles: t.view_max_files ?? 4,
      pdfMaxChars: t.pdf_max_chars ?? 8000,
      catalogDefaultLimit: t.catalog_default_limit ?? 15,
      catalogMaxLimit: t.catalog_max_limit ?? 50,
      maxDownloadFiles: t.max_download_files ?? 50,
    },
  };
}
