import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import type { ConcurrencyLimitedFetchClient } from "../enrichment/fetch-client.js";
import {
  conditionImageBufferForInference,
  type ImageProcessingOptions,
} from "../media/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DANBOORU_ORDERS = [
  "id",
  "id_desc",
  "score",
  "score_asc",
  "favcount",
  "favcount_asc",
  "created_at",
  "created_at_asc",
  "change",
  "change_asc",
  "comment",
  "comment_asc",
  "comment_bumped",
  "comment_bumped_asc",
  "note",
  "note_asc",
  "artcomm",
  "artcomm_asc",
  "mpixels",
  "mpixels_asc",
  "filesize",
  "filesize_asc",
  "landscape",
  "portrait",
  "rank",
  "curated",
  "modqueue",
  "random",
  "none",
  "md5",
  "md5_asc",
  "tagcount",
  "tagcount_asc",
  "arttags",
  "arttags_asc",
  "gentags",
  "gentags_asc",
  "copytags",
  "copytags_asc",
  "chartags",
  "chartags_asc",
  "metatags",
  "metatags_asc",
  "comments",
  "comments_asc",
  "deleted_comments",
  "deleted_comments_asc",
  "active_comments",
  "active_comments_asc",
  "notes",
  "notes_asc",
  "deleted_notes",
  "deleted_notes_asc",
  "active_notes",
  "active_notes_asc",
  "flags",
  "flags_asc",
  "child_count",
  "child_count_asc",
  "deleted_child_count",
  "deleted_child_count_asc",
  "active_child_count",
  "active_child_count_asc",
  "pools",
  "pools_asc",
  "deleted_pools",
  "deleted_pools_asc",
  "active_pools",
  "active_pools_asc",
  "series_pools",
  "series_pools_asc",
  "collection_pools",
  "collection_pools_asc",
  "appeals",
  "appeals_asc",
  "approvals",
  "approvals_asc",
  "replacements",
  "replacements_asc",
  "upvote",
  "upvote_asc",
  "downvote",
  "downvote_asc",
] as const;

const DANBOORU_RATINGS = [
  "general",
  "sensitive",
  "questionable",
  "explicit",
] as const;

const ASSET_VARIANTS = ["original", "sample", "preview"] as const;

const MAX_ARRAY_TERMS = 24;
const MAX_TERM_LENGTH = 200;
const MAX_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DanbooruOrder = (typeof DANBOORU_ORDERS)[number];
type DanbooruRating = (typeof DANBOORU_RATINGS)[number];
type DanbooruAssetVariant = (typeof ASSET_VARIANTS)[number];

type DanbooruPost = {
  id: number;
  rating: string;
  score: number;
  fav_count: number;
  file_ext?: string | null;
  file_size?: number | null;
  image_width?: number | null;
  image_height?: number | null;
  tag_string?: string;
  tag_string_general?: string;
  tag_string_character?: string;
  tag_string_copyright?: string;
  tag_string_artist?: string;
  tag_string_meta?: string;
  file_url?: string | null;
  large_file_url?: string | null;
  preview_file_url?: string | null;
  created_at?: string | null;
  source?: string | null;
};

type DanbooruConfig = {
  baseUrl: string;
  maxRegularTags: number;
  defaultLimit: number;
  downloadSubdir: string;
  login?: string;
  apiKey?: string;
};

type DanbooruToolParams = {
  action?: "search" | "download" | "preview";
  includeTags?: string[];
  excludeTags?: string[];
  extraTerms?: string[];
  includeRatings?: DanbooruRating[];
  excludeRatings?: DanbooruRating[];
  order?: DanbooruOrder;
  page?: string;
  limit?: number;
  postId?: number;
  downloadPostId?: number;
  previewVariant?: DanbooruAssetVariant;
  downloadVariant?: DanbooruAssetVariant;
  outputSubdir?: string;
  filename?: string;
};

type SearchQueryInfo = {
  queryTerms: string[];
  queryText: string;
  includeTags: string[];
  excludeTags: string[];
  extraTerms: string[];
  order?: DanbooruOrder;
  includeRatings: string[];
  excludeRatings: string[];
  limit: number;
  page?: string;
};

type DanbooruFetchResponse = {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export interface DanbooruToolContext {
  workspaceRoot: string;
  /**
   * Hard fetch ceiling — refuses to download responses larger than this.
   * The `download` action keeps this as its only size gate (we never want to
   * resize bytes we are saving to disk).
   */
  downloadSizeLimit: number;
  /**
   * Per-image byte cap for the inline base64 emission path (`preview`),
   * measured as the base64-encoded payload (NOT raw bytes). Fetched bytes are
   * conditioned through `conditionImageBufferForInference` to land under this
   * ceiling before being sent to the model. The conditioning pipeline targets
   * raw output bytes, so the budget is converted to a raw target via
   * `raw = floor(base64 * 3 / 4)` at the call site. Derived from the default
   * model's `image_input_bytes` setting.
   */
  inlineImageMaxBytes: number;
  /**
   * Sharp resize options for the inline preview path. Mirrors the captioning
   * pool's image conditioning so the inline path applies the same compress/
   * convert pipeline (re-encode to JPEG, downscale on overflow).
   */
  inferenceImageOptions: ImageProcessingOptions;
  fetchClient: ConcurrencyLimitedFetchClient;
  config?: {
    base_url?: string;
    login?: string;
    api_key?: string;
    max_regular_tags?: number;
    default_limit?: number;
    download_subdir?: string;
  };
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const DanbooruToolSchema = Type.Object(
  {
    action: Type.Optional(
      Type.Unsafe<"search" | "download" | "preview">({
        type: "string",
        enum: ["search", "download", "preview"],
        description:
          "Use 'search' to query posts, 'preview' to return an inline image for a chosen post, or 'download' to save a chosen post into the workspace.",
      }),
    ),
    includeTags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: MAX_TERM_LENGTH }), {
        description:
          "Positive Danbooru tags. Each item is one term; do not prefix these with '-'. The tool joins them with spaces.",
        maxItems: MAX_ARRAY_TERMS,
      }),
    ),
    excludeTags: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: MAX_TERM_LENGTH }), {
        description:
          "Tags to exclude. Pass plain tags here; the tool adds the leading '-' for you.",
        maxItems: MAX_ARRAY_TERMS,
      }),
    ),
    extraTerms: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: MAX_TERM_LENGTH }), {
        description:
          "Advanced Danbooru terms appended as-is, such as 'score:>100', 'age:<1year', or 'filetype:png'. Prefer structured fields when available.",
        maxItems: MAX_ARRAY_TERMS,
      }),
    ),
    includeRatings: Type.Optional(
      Type.Array(
        Type.Unsafe<DanbooruRating>({
          type: "string",
          enum: [...DANBOORU_RATINGS],
        }),
        {
          description:
            "Ratings to include. The tool turns these into a single Danbooru rating:* term such as rating:q,s.",
          maxItems: 4,
        },
      ),
    ),
    excludeRatings: Type.Optional(
      Type.Array(
        Type.Unsafe<DanbooruRating>({
          type: "string",
          enum: [...DANBOORU_RATINGS],
        }),
        {
          description:
            "Ratings to exclude. The tool turns these into negative Danbooru rating terms such as -rating:e.",
          maxItems: 4,
        },
      ),
    ),
    order: Type.Optional(
      Type.Unsafe<DanbooruOrder>({
        type: "string",
        enum: [...DANBOORU_ORDERS],
        description:
          "Optional ordering. The tool turns this into an order:* metatag automatically.",
      }),
    ),
    page: Type.Optional(
      Type.String({
        description:
          "Page number or cursor such as '2', 'b123456', or 'a123456'. Danbooru accepts numeric pages and before/after cursors.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: `Maximum number of results to return. Defaults to plugin config or ${DEFAULT_SEARCH_LIMIT}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
      }),
    ),
    postId: Type.Optional(
      Type.Integer({
        description:
          "Post ID for action='preview' or action='download'. Preferred over the older downloadPostId field.",
        minimum: 1,
      }),
    ),
    downloadPostId: Type.Optional(
      Type.Integer({
        description:
          "Required for action='download'. The Danbooru post ID to download after you have chosen a search result.",
        minimum: 1,
      }),
    ),
    previewVariant: Type.Optional(
      Type.Unsafe<DanbooruAssetVariant>({
        type: "string",
        enum: [...ASSET_VARIANTS],
        description:
          "Which asset URL to use for action='preview': preview, sample, or original. Default: preview.",
      }),
    ),
    downloadVariant: Type.Optional(
      Type.Unsafe<DanbooruAssetVariant>({
        type: "string",
        enum: [...ASSET_VARIANTS],
        description:
          "Which asset URL to save for action='download': original, sample, or preview. Default: original.",
      }),
    ),
    outputSubdir: Type.Optional(
      Type.String({
        description:
          "Optional workspace-relative subdirectory for downloads. Defaults to the plugin config download subdir.",
      }),
    ),
    filename: Type.Optional(
      Type.String({
        description:
          "Optional filename override for action='download'. The extension is preserved or inferred automatically.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDanbooruTool(context: DanbooruToolContext): AgentTool {
  const config: DanbooruConfig = {
    baseUrl: context.config?.base_url ?? "https://danbooru.donmai.us",
    maxRegularTags: context.config?.max_regular_tags ?? 2,
    defaultLimit: context.config?.default_limit ?? DEFAULT_SEARCH_LIMIT,
    downloadSubdir: context.config?.download_subdir ?? "downloads/danbooru",
    login: context.config?.login,
    apiKey: context.config?.api_key,
  };

  const authHeader = buildAuthHeader(config);

  if (authHeader) {
    // Refuse to send Basic credentials over plaintext HTTP. The operator may
    // have misconfigured `base_url` (e.g. `http://danbooru.donmai.us`), in
    // which case the login/api_key would be sent in cleartext on every
    // request. Surface the misconfiguration loudly at tool construction
    // rather than after credentials have already leaked on the wire.
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      throw new Error(
        `Danbooru base_url is not a valid URL: ${config.baseUrl}. Cannot send Basic credentials safely.`,
      );
    }
    if (parsed.protocol === "http:") {
      throw new Error(
        `Refusing to send Basic credentials over plaintext HTTP. ` +
          `Danbooru base_url is "${config.baseUrl}" — set it to an https:// URL ` +
          `or remove the danbooru.login / danbooru.api_key settings.`,
      );
    }
  }

  return {
    name: "danbooru",
    label: "Danbooru",
    description:
      "Search Danbooru using structured JSON inputs instead of shell strings. " +
      "includeTags become positive terms, excludeTags become -tag terms, includeRatings and excludeRatings become rating metatags, " +
      "order becomes order:*, and extraTerms are appended verbatim. " +
      "Search calls query /posts.json and returns Danbooru post URLs plus preview/sample/original asset URLs and key metadata. " +
      "Preview calls return an inline image block for a chosen post. Download calls save a chosen post into the agent workspace.",
    parameters: DanbooruToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as DanbooruToolParams;
      const action = params.action ?? "search";

      if (action === "download") {
        return executeDownload({ context, config, authHeader, params });
      }

      if (action === "preview") {
        return executePreview({ context, config, authHeader, params });
      }

      return executeSearch({ config, authHeader, params });
    },
  };
}

// ---------------------------------------------------------------------------
// Execute: search
// ---------------------------------------------------------------------------

async function executeSearch(input: {
  config: DanbooruConfig;
  authHeader: string | undefined;
  params: DanbooruToolParams;
}) {
  const query = buildSearchQuery(input.params, input.config);
  const searchParams = new URLSearchParams({
    tags: query.queryText,
    limit: String(query.limit),
  });
  if (query.page) {
    searchParams.set("page", query.page);
  }

  const posts = await fetchJson<DanbooruPost[]>(
    input.config.baseUrl,
    "/posts.json",
    searchParams,
    input.authHeader,
  );
  const lines = buildSearchOutput({ query, posts, config: input.config });

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "search",
      query: query.queryText,
      queryTerms: query.queryTerms,
      limit: query.limit,
      page: query.page,
      count: posts.length,
      posts: posts.map((post) => summarizePost(post, input.config)),
    },
  };
}

// ---------------------------------------------------------------------------
// Execute: preview
// ---------------------------------------------------------------------------

async function executePreview(input: {
  context: DanbooruToolContext;
  config: DanbooruConfig;
  authHeader: string | undefined;
  params: DanbooruToolParams;
}) {
  const postId = resolveTargetPostId(input.params, "preview");
  const post = await fetchJson<DanbooruPost>(
    input.config.baseUrl,
    `/posts/${postId}.json`,
    new URLSearchParams(),
    input.authHeader,
  );
  const variant = input.params.previewVariant ?? "preview";
  const assetUrl = resolveDownloadUrl(post, variant);
  if (!assetUrl) {
    return textError(`Post #${postId} does not expose a ${variant} asset URL for your account.`);
  }

  const fetched = await input.context.fetchClient.fetch(assetUrl, {
    maxBytes: input.context.downloadSizeLimit,
  });
  if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
    await fs.unlink(fetched.path).catch(() => {});
    throw new Error(`Preview fetch failed with HTTP ${fetched.statusCode}`);
  }

  let rawBuffer: Buffer;
  try {
    rawBuffer = await fs.readFile(fetched.path);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }

  const sourceMimeType = resolveImageMimeType({
    assetUrl,
    contentType: fetched.contentType,
    post,
  });
  if (!sourceMimeType) {
    return textError(
      `Post #${postId} ${variant} asset is not an image that can be returned inline to the model.`,
    );
  }

  // Inline emission must always fit under the per-image byte cap. Route the
  // fetched bytes through the same conditioning pipeline used by captioning
  // (resize + re-encode to JPEG) with `maxBytes` set to the per-image
  // ceiling. This is the explicit operator guidance: inline image paths
  // never just gate size — they always try to compress/convert to fit.
  //
  // `inlineImageMaxBytes` is a base64-encoded byte budget (what providers
  // measure), but `ImageProcessingOptions.maxBytes` is the raw output JPEG
  // size the conditioning loop targets. Convert: raw = floor(base64 * 3 / 4).
  const rawByteBudget = Math.floor((input.context.inlineImageMaxBytes * 3) / 4);
  const inlineOptions: ImageProcessingOptions = {
    ...input.context.inferenceImageOptions,
    maxBytes: rawByteBudget,
  };
  let conditioned: { buffer: Buffer; mimeType: string; sizeBytes: number };
  try {
    conditioned = await conditionImageBufferForInference(rawBuffer, inlineOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return textError(
      `Post #${postId} ${variant} asset could not be conditioned for inline preview: ${detail}`,
    );
  }

  const pageUrl = buildPostUrl(input.config, post.id);
  const conditionedKb = (conditioned.sizeBytes / 1024).toFixed(1);
  const text = [
    "## Danbooru Preview",
    "",
    `Showing post #${post.id} inline from the ${variant} asset.`,
    "",
    "How this worked:",
    `- fetched metadata from \`/posts/${post.id}.json\``,
    `- selected the ${variant} asset URL`,
    `- fetched the binary asset (source type: ${sourceMimeType})`,
    `- re-encoded to ${conditioned.mimeType} at ${conditionedKb} KB to fit the per-image cap`,
    `- returned the asset as an inline image block in the tool result`,
    "",
    "Useful URLs:",
    `- page: ${pageUrl}`,
    `- original: ${post.file_url ?? "(not available)"}`,
    `- sample: ${post.large_file_url ?? "(not available)"}`,
    `- preview: ${post.preview_file_url ?? "(not available)"}`,
  ].join("\n");

  return {
    content: [
      { type: "text" as const, text },
      {
        type: "image" as const,
        data: conditioned.buffer.toString("base64"),
        mimeType: conditioned.mimeType,
      },
    ],
    details: {
      action: "preview",
      post: summarizePost(post, input.config),
      variant,
      assetUrl,
      sourceMimeType,
      mimeType: conditioned.mimeType,
      inlineSizeBytes: conditioned.sizeBytes,
      pageUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Execute: download
// ---------------------------------------------------------------------------

async function executeDownload(input: {
  context: DanbooruToolContext;
  config: DanbooruConfig;
  authHeader: string | undefined;
  params: DanbooruToolParams;
}) {
  const postId = resolveTargetPostId(input.params, "download");
  const post = await fetchJson<DanbooruPost>(
    input.config.baseUrl,
    `/posts/${postId}.json`,
    new URLSearchParams(),
    input.authHeader,
  );
  const variant = input.params.downloadVariant ?? "original";
  const assetUrl = resolveDownloadUrl(post, variant);
  if (!assetUrl) {
    return textError(`Post #${postId} does not expose a ${variant} asset URL for your account.`);
  }

  const outputSubdir = resolveOutputSubdir(input.params.outputSubdir, input.config);
  const outputDir = resolveWorkspacePath(input.context.workspaceRoot, outputSubdir);
  await fs.mkdir(outputDir, { recursive: true });

  const fetched = await input.context.fetchClient.fetch(assetUrl, {
    maxBytes: input.context.downloadSizeLimit,
  });
  if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
    await fs.unlink(fetched.path).catch(() => {});
    throw new Error(`Download fetch failed with HTTP ${fetched.statusCode}`);
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fetched.path);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }

  const filePath = await writeDownload({
    dir: outputDir,
    fileName: input.params.filename,
    post,
    assetUrl,
    buffer,
  });

  const relativePath = toWorkspaceRelativePath(input.context.workspaceRoot, filePath);
  const pageUrl = buildPostUrl(input.config, post.id);
  const lines = [
    "## Danbooru Download",
    "",
    `Saved post #${post.id} (${variant}) to \`${relativePath}\`.`,
    "",
    "How this worked:",
    `- fetched metadata from \`/posts/${post.id}.json\``,
    `- selected the ${variant} asset URL`,
    `- downloaded the file through the configured HTTP client`,
    `- wrote the file inside the agent workspace at \`${relativePath}\``,
    "",
    "Useful URLs:",
    `- page: ${pageUrl}`,
    `- original: ${post.file_url ?? "(not available)"}`,
    `- sample: ${post.large_file_url ?? "(not available)"}`,
    `- preview: ${post.preview_file_url ?? "(not available)"}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "download",
      post: summarizePost(post, input.config),
      variant,
      filePath,
      workspacePath: relativePath,
      assetUrl,
      pageUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Identifier for outbound Danbooru requests. Surfaced in `User-Agent`. */
const DANBOORU_USER_AGENT = "MikuAgent/0.1 (mikuswarm)";
/**
 * Per-request timeout for Danbooru JSON calls. The endpoint is fast in
 * practice; if it stalls past this we'd rather fail the tool call than block
 * a session indefinitely.
 */
const DANBOORU_FETCH_TIMEOUT_MS = 30_000;
/**
 * Response-body byte cap for `/posts.json` and `/posts/<id>.json`. Even at
 * `limit=200` the JSON is well under 1 MiB, so 4 MiB leaves comfortable
 * headroom while refusing pathological payloads.
 */
const DANBOORU_FETCH_MAX_BYTES = 4 * 1024 * 1024;

async function fetchJson<T>(
  baseUrl: string,
  pathname: string,
  params: URLSearchParams,
  authHeader: string | undefined,
): Promise<T> {
  const url = new URL(pathname, baseUrl);
  url.search = params.toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DANBOORU_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": DANBOORU_USER_AGENT,
        ...(authHeader ? { authorization: authHeader } : {}),
      },
    });
  } catch (error) {
    clearTimeout(timeout);
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error(
        `Danbooru request timed out after ${DANBOORU_FETCH_TIMEOUT_MS}ms: ${url.pathname}`,
      );
    }
    throw error;
  }
  try {
    if (!response.ok) {
      throw new Error(await buildDanbooruHttpError(response));
    }
    // Pre-flight: refuse early when the server declared an oversized body.
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > DANBOORU_FETCH_MAX_BYTES) {
      throw new Error(
        `Danbooru response too large: declared content-length ${declared} > ${DANBOORU_FETCH_MAX_BYTES} bytes.`,
      );
    }
    // Read the body with a running byte counter so a server that lies about
    // (or omits) content-length still can't blow the budget.
    const reader = response.body?.getReader();
    if (!reader) {
      return (await response.json()) as T;
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > DANBOORU_FETCH_MAX_BYTES) {
        controller.abort();
        throw new Error(
          `Danbooru response exceeded ${DANBOORU_FETCH_MAX_BYTES} bytes; aborting.`,
        );
      }
      chunks.push(value);
    }
    const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return JSON.parse(combined.toString("utf8")) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function buildAuthHeader(config: DanbooruConfig): string | undefined {
  const login = config.login;
  const apiKey = config.apiKey;
  if (!login || !apiKey) {
    return undefined;
  }
  return `Basic ${Buffer.from(`${login}:${apiKey}`, "utf8").toString("base64")}`;
}

async function buildDanbooruHttpError(response: DanbooruFetchResponse): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  let detail = "";
  try {
    if (contentType.includes("application/json")) {
      const json = (await response.json()) as Record<string, unknown>;
      const reason = typeof json.reason === "string" ? json.reason : undefined;
      detail = reason ? ` (${reason})` : "";
    } else {
      const text = (await response.text()).trim();
      detail = text ? ` (${text.slice(0, 200)})` : "";
    }
  } catch {
    detail = "";
  }
  return `Danbooru request failed with HTTP ${response.status}${detail}.`;
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

function buildSearchQuery(
  params: Pick<
    DanbooruToolParams,
    | "includeTags"
    | "excludeTags"
    | "extraTerms"
    | "includeRatings"
    | "excludeRatings"
    | "order"
    | "limit"
    | "page"
  >,
  config: DanbooruConfig,
): SearchQueryInfo {
  const includeTags = normalizeTagTerms(params.includeTags, false);
  const excludeTags = normalizeTagTerms(params.excludeTags, true);
  const extraTerms = normalizeFreeformTerms(params.extraTerms);
  validateExtraTerms(extraTerms);
  // `extraTerms` are arbitrary Danbooru search terms (e.g. `score:>100`).
  // Each entry contributes one term to the final query, so it must count
  // against the same budget as `includeTags` / `excludeTags` — otherwise a
  // caller could route an unlimited number of tag-equivalent expressions
  // through `extraTerms` and bypass the regular-tag cap entirely.
  const regularTagCount = includeTags.length + excludeTags.length + extraTerms.length;
  if (regularTagCount > config.maxRegularTags) {
    throw new Error(
      `This workspace is configured for at most ${config.maxRegularTags} regular tags per search ` +
        `(includeTags + excludeTags + extraTerms). ` +
        `Reduce these or raise max_regular_tags if your account tier allows more.`,
    );
  }

  const includeRatings = normalizeRatings(params.includeRatings);
  const excludeRatings = normalizeRatings(params.excludeRatings);
  validateRatingSelections(includeRatings, excludeRatings);
  const order = params.order;
  const queryTerms = [
    ...includeTags,
    ...excludeTags.map((tag) => `-${tag}`),
    ...extraTerms,
    ...(includeRatings.length > 0 ? [buildPositiveRatingTerm(includeRatings)] : []),
    ...excludeRatings.map((rating) => `-rating:${ratingToShortCode(rating)}`),
    ...(order ? [`order:${order}`] : []),
  ];

  if (queryTerms.length === 0) {
    throw new Error("Danbooru search needs at least one query term. Provide includeTags, excludeTags, extraTerms, rating, or order.");
  }

  const limit = params.limit ?? config.defaultLimit ?? DEFAULT_SEARCH_LIMIT;
  const page = normalizeOptionalPage(params.page);

  return {
    queryTerms,
    queryText: queryTerms.join(" "),
    includeTags,
    excludeTags,
    extraTerms,
    includeRatings,
    excludeRatings,
    order,
    limit,
    page,
  };
}

// ---------------------------------------------------------------------------
// Search output formatting
// ---------------------------------------------------------------------------

function buildSearchOutput(input: {
  query: SearchQueryInfo;
  posts: DanbooruPost[];
  config: DanbooruConfig;
}): string[] {
  const lines: string[] = [];
  lines.push("## Danbooru Search");
  lines.push("");
  lines.push(
    "This tool turns structured fields into a Danbooru tag query, then calls `GET /posts.json` and formats the results for follow-up.",
  );
  lines.push("");
  lines.push("How the query was built:");
  lines.push(`- includeTags: ${formatList(input.query.includeTags)}`);
  lines.push(`- excludeTags: ${formatList(input.query.excludeTags)}`);
  lines.push(`- extraTerms: ${formatList(input.query.extraTerms)}`);
  lines.push(
    `- includeRatings: ${input.query.includeRatings.length > 0 ? formatList(input.query.includeRatings) : "(none)"}`,
  );
  lines.push(
    `- excludeRatings: ${input.query.excludeRatings.length > 0 ? formatList(input.query.excludeRatings) : "(none)"}`,
  );
  lines.push(`- order metatag: ${input.query.order ? `order:${input.query.order}` : "(site default)"}`);
  lines.push(`- limit: ${input.query.limit}`);
  lines.push(`- page: ${input.query.page ?? "(default)"}`);
  lines.push(
    `- regular tag budget in this workspace: ${input.config.maxRegularTags} include/exclude tags`,
  );
  lines.push("");
  lines.push(`Final query: \`${input.query.queryText}\``);
  lines.push("");

  if (input.posts.length === 0) {
    lines.push("No posts matched.");
    return lines;
  }

  lines.push(`Returned ${input.posts.length} post(s):`);
  lines.push("");
  for (const post of input.posts) {
    const urls = [
      `page=${buildPostUrl(input.config, post.id)}`,
      `preview=${post.preview_file_url ?? "n/a"}`,
      `sample=${post.large_file_url ?? "n/a"}`,
      `original=${post.file_url ?? "n/a"}`,
    ].join(" | ");
    const generalTags = (post.tag_string_general ?? post.tag_string ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 12)
      .join(" ");
    lines.push(
      `- #${post.id} | rating=${post.rating} | score=${post.score} | favs=${post.fav_count} | ${post.image_width ?? "?"}x${post.image_height ?? "?"} | ext=${post.file_ext ?? "?"} | size=${formatFileSize(post.file_size)} | created=${post.created_at ?? "?"}`,
    );
    if (post.source) {
      // `source` is uploader-controlled text — surface verbatim so the agent
      // sees it as data, never feed it into any fetcher.
      lines.push(`  source: ${post.source}`);
    }
    if (generalTags) {
      lines.push(`  tags: ${generalTags}`);
    }
    lines.push(`  urls: ${urls}`);
  }
  lines.push("");
  lines.push(
    "To save a result into the workspace, call the same tool again with `action: \"download\"` and `postId` set to a post ID from this list.",
  );

  return lines;
}

function summarizePost(post: DanbooruPost, config: DanbooruConfig) {
  return {
    id: post.id,
    postUrl: buildPostUrl(config, post.id),
    rating: post.rating,
    score: post.score,
    favCount: post.fav_count,
    width: post.image_width ?? null,
    height: post.image_height ?? null,
    fileExt: post.file_ext ?? null,
    fileSize: post.file_size ?? null,
    createdAt: post.created_at ?? null,
    // `source` is uploader-controlled free text. Surface it verbatim in
    // tool output as data only — never feed it back into `fetchClient` or
    // any other URL-consuming path.
    source: post.source ?? null,
    previewUrl: post.preview_file_url ?? null,
    sampleUrl: post.large_file_url ?? null,
    originalUrl: post.file_url ?? null,
  };
}

function buildPostUrl(config: DanbooruConfig, postId: number): string {
  return `${config.baseUrl.replace(/\/+$/, "")}/posts/${postId}`;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(", ") : "(none)";
}

function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "?";
  }
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Tag & query term normalization
// ---------------------------------------------------------------------------

function normalizeTagTerms(values: readonly string[] | undefined, stripLeadingDash: boolean): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const cleaned = stripLeadingDash ? value.replace(/^-+/, "") : value;
      if (!cleaned) {
        throw new Error("Tag terms must not be empty.");
      }
      if (!stripLeadingDash && cleaned.startsWith("-")) {
        throw new Error(`Include tags must not start with '-'. Use excludeTags for negation: ${value}`);
      }
      return cleaned;
    });
}

function normalizeFreeformTerms(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Metatag keys that the structured `DanbooruToolParams` fields are the sole
 * source of. Allowing them through `extraTerms` would let a caller inject a
 * second `rating:` / `order:` / `limit:` term after the validated one,
 * which Danbooru happily accepts and which would silently override the
 * structured selection. Comparison is case-insensitive (Danbooru is).
 */
const RESERVED_METATAG_KEYS: ReadonlySet<string> = new Set(["rating", "order", "limit"]);

function validateExtraTerms(values: readonly string[]): void {
  for (const value of values) {
    if (/\s/.test(value)) {
      // Joining the final query with spaces means one entry containing
      // whitespace would silently become N tag terms after Danbooru parses
      // it — bypassing both the metatag-only check and the per-term length
      // limit. Reject up front.
      throw new Error(
        `extraTerms entries must not contain whitespace. Pass each term as its own array element: "${value}"`,
      );
    }
    // A metatag may be negated with a leading `-` (e.g. `-rating:e`). Strip
    // it for the key-overlap check so the structured-field carve-out
    // catches both polarities.
    const unsigned = value.startsWith("-") ? value.slice(1) : value;
    const colonIndex = unsigned.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `extraTerms only supports Danbooru metatags, not plain tags. Move "${value}" into includeTags or excludeTags.`,
      );
    }
    const key = unsigned.slice(0, colonIndex).toLowerCase();
    if (RESERVED_METATAG_KEYS.has(key)) {
      throw new Error(
        `extraTerms must not set "${key}:" — use the structured ${key === "rating" ? "includeRatings/excludeRatings" : key} field instead. Offending term: "${value}"`,
      );
    }
  }
}

function normalizeRatings(values: readonly DanbooruRating[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function validateRatingSelections(includeRatings: readonly string[], excludeRatings: readonly string[]): void {
  const overlap = includeRatings.filter((value) => excludeRatings.includes(value));
  if (overlap.length > 0) {
    throw new Error(`Cannot both include and exclude the same rating: ${overlap.join(", ")}.`);
  }
}

function buildPositiveRatingTerm(ratings: readonly string[]): string {
  return `rating:${ratings.map((rating) => ratingToShortCode(rating)).join(",")}`;
}

function ratingToShortCode(rating: string): string {
  switch (rating) {
    case "general":
      return "g";
    case "sensitive":
      return "s";
    case "questionable":
      return "q";
    case "explicit":
      return "e";
    default:
      throw new Error(`Unsupported Danbooru rating: ${rating}`);
  }
}

function normalizeOptionalPage(page: string | undefined): string | undefined {
  if (!page) {
    return undefined;
  }
  const trimmed = page.trim();
  if (/^\d+$/.test(trimmed) || /^[ab]\d+$/.test(trimmed)) {
    return trimmed;
  }
  throw new Error("page must be a positive integer string or a Danbooru cursor like b123456 / a123456.");
}

function resolveTargetPostId(
  params: Pick<DanbooruToolParams, "postId" | "downloadPostId">,
  action: "preview" | "download",
): number {
  const postId = params.postId ?? params.downloadPostId;
  if (!postId) {
    if (action === "preview") {
      throw new Error("`postId` is required when action='preview'. Search first, then preview a chosen post ID.");
    }
    throw new Error(
      "`postId` or `downloadPostId` is required when action='download'. Search first, then download a chosen post ID.",
    );
  }
  return postId;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

function resolveDownloadUrl(
  post: DanbooruPost,
  variant: DanbooruAssetVariant,
): string | undefined {
  if (variant === "original") {
    return post.file_url ?? post.large_file_url ?? post.preview_file_url ?? undefined;
  }
  if (variant === "sample") {
    return post.large_file_url ?? post.file_url ?? post.preview_file_url ?? undefined;
  }
  return post.preview_file_url ?? post.large_file_url ?? post.file_url ?? undefined;
}

function resolveOutputSubdir(outputSubdir: string | undefined, config: DanbooruConfig): string {
  const raw = (outputSubdir ?? config.downloadSubdir).trim();
  const portable = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!portable || portable === "." || portable === ".." || portable.startsWith("/") || portable.includes("../")) {
    throw new Error("outputSubdir must be a safe workspace-relative subdirectory.");
  }
  return portable;
}

/**
 * Cap on collision-suffix retries. The previous unbounded loop could spin
 * indefinitely under sustained concurrent calls into the same directory;
 * after this many attempts we fall back to a random nonce to break the
 * spiral while still avoiding a clobber.
 */
const DOWNLOAD_COLLISION_RETRY_CAP = 100;

async function writeDownload(input: {
  dir: string;
  fileName: string | undefined;
  post: DanbooruPost;
  assetUrl: string;
  buffer: Buffer;
}): Promise<string> {
  const ext = inferExtension(input.fileName, input.post, input.assetUrl);
  const preferredBase = sanitizeFileBaseName(input.fileName) ?? `danbooru-${input.post.id}`;

  // Use `fs.open(path, "wx")` (exclusive create) so the existence check and
  // the create are a single atomic syscall — two concurrent downloads of
  // the same post can no longer pick the same suffix between the `exists`
  // check and the `writeFile`. `EEXIST` means another writer beat us to
  // that suffix; bump and retry.
  let suffix = 0;
  for (let attempt = 0; attempt <= DOWNLOAD_COLLISION_RETRY_CAP; attempt++) {
    const candidate =
      suffix === 0
        ? path.join(input.dir, `${preferredBase}.${ext}`)
        : path.join(input.dir, `${preferredBase}-${suffix}.${ext}`);
    try {
      const handle = await fs.open(candidate, "wx");
      try {
        await handle.writeFile(input.buffer);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;
      suffix += 1;
    }
  }

  // We hit the retry cap. Append a random nonce so we still find a free
  // name in one shot instead of looping forever; the nonce also keeps the
  // base name human-recognizable for the operator.
  const nonce = randomBytes(6).toString("hex");
  const fallback = path.join(input.dir, `${preferredBase}-${nonce}.${ext}`);
  const handle = await fs.open(fallback, "wx");
  try {
    await handle.writeFile(input.buffer);
  } finally {
    await handle.close();
  }
  return fallback;
}

/**
 * Allow-list of file extensions an agent-supplied `filename` is permitted to
 * carry. Anything outside this set silently falls back to the post's
 * `file_ext` so a hostile prompt can't coerce a Danbooru download into a
 * `.html` / `.exe` / `.bat` blob on disk by passing a misleading name.
 *
 * Mirrors Danbooru's documented set of acceptable upload formats.
 */
const ALLOWED_FILENAME_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "mp4",
  "webm",
  "zip",
  "swf",
]);

function inferExtension(
  explicitFileName: string | undefined,
  post: DanbooruPost,
  assetUrl: string,
): string {
  const explicitExt = explicitFileName ? path.extname(explicitFileName).replace(/^\./, "").toLowerCase() : "";
  if (explicitExt && ALLOWED_FILENAME_EXTENSIONS.has(explicitExt)) {
    return explicitExt;
  }
  // Explicit extension was either absent or not in the allow-list. Fall
  // through to the post-derived defaults so a misleading `filename`
  // (e.g. "owned.html") can't dictate the on-disk extension.
  const postExt = (post.file_ext ?? "").trim();
  if (postExt) {
    return postExt.toLowerCase();
  }
  try {
    const pathname = new URL(assetUrl).pathname;
    const derivedExt = path.extname(pathname).replace(/^\./, "");
    if (derivedExt) {
      return derivedExt.toLowerCase();
    }
  } catch {
    // Ignore URL parsing failures and fall through to the default.
  }
  return "bin";
}

function sanitizeFileBaseName(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  const base = path.basename(raw, path.extname(raw));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

function resolveImageMimeType(input: {
  assetUrl: string;
  contentType?: string;
  post: DanbooruPost;
}): string | undefined {
  const rawContentType = input.contentType?.split(";")[0]?.trim().toLowerCase();
  if (rawContentType?.startsWith("image/")) {
    return rawContentType;
  }

  const ext = inferExtension(undefined, input.post, input.assetUrl).toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.startsWith("..") ? absolutePath : `./${relative.replace(/\\/g, "/")}`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function textError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      error: message,
    },
  };
}

export { ASSET_VARIANTS };
