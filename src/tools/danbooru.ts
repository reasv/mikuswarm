import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import {
  buildProxyDispatcher,
  type FetchClient,
  type FetchResult,
} from "../enrichment/fetch-client.js";
import { guardedFetch } from "./ssrf.js";
import type { Dispatcher } from "undici";
import {
  conditionImageBufferForInference,
  type ImageProcessingOptions,
} from "../media/index.js";
import type { InferenceClient } from "../captioning/inference-client.js";

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
  defaultOrder?: DanbooruOrder;
  downloadSubdir: string;
  login?: string;
  apiKey?: string;
  /** Append "did you mean" tag suggestions to zero-result searches. */
  suggestOnEmpty: boolean;
  /** Max candidates returned per tag-suggestion lookup. */
  maxSuggestions: number;
};

type DanbooruToolParams = {
  action?: "search" | "download" | "preview" | "tags";
  query?: string;
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
  /**
   * Whether the agent's default model can receive inline image blocks. When
   * false, `preview` must NOT emit an image block the model cannot read (and
   * must not narrate it as if the model can see it). Instead it routes the
   * asset through {@link imageCaptionClient} and returns a text description —
   * the non-vision equivalent of "showing" the image (the same way the inline
   * path hands the image to the model, this hands it to a captioning model).
   */
  modelHasVision: boolean;
  /**
   * Image-captioning client — the same one backing the `media` tool. Used by
   * the non-vision `preview` path to describe the fetched asset. Optional: when
   * captioning is not configured, `preview` degrades to returning the asset
   * URLs plus a pointer to the `media` tool rather than a description.
   */
  imageCaptionClient?: InferenceClient;
  fetchClient: FetchClient;
  /**
   * Optional http(s) proxy URL applied to JSON metadata requests in this
   * tool. Binary asset fetches go through `fetchClient`, which is configured
   * with the same URL at app startup.
   */
  httpProxyUrl?: string;
  config?: {
    base_url?: string;
    login?: string;
    api_key?: string;
    max_regular_tags?: number;
    default_limit?: number;
    default_order?: string;
    download_subdir?: string;
    /** Minimum ms between Danbooru request starts (API + CDN, one budget). */
    min_request_interval_ms?: number;
    /** Max concurrent in-flight Danbooru requests (API + CDN, one budget). */
    max_in_flight?: number;
    /** Append "did you mean" tag suggestions to zero-result searches (default true). */
    suggest_on_empty?: boolean;
    /** Max candidates returned per tag-suggestion lookup (default 6). */
    max_suggestions?: number;
  };
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const DanbooruToolSchema = Type.Object(
  {
    action: Type.Optional(
      Type.Unsafe<"search" | "download" | "preview" | "tags">({
        type: "string",
        enum: ["search", "download", "preview", "tags"],
        description:
          "Use 'search' to query posts, 'preview' to return an inline image for a chosen post, 'download' to save a chosen post into the workspace, or 'tags' to look up real Danbooru tag names from a guess/keyword (use this when a search returns nothing because you are unsure of the exact tag).",
      }),
    ),
    query: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_TERM_LENGTH,
        description:
          "Required for action='tags'. A tag guess, character/series name, or keyword to resolve into real Danbooru tags (e.g. 'mordred pendragon' → mordred_(fate)). Underscores and spaces are both accepted.",
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
  const defaultOrder = normalizeConfiguredDefaultOrder(context.config?.default_order);
  const login = normalizeCredential(context.config?.login);
  const apiKey = normalizeCredential(context.config?.api_key);
  if ((login && !apiKey) || (!login && apiKey)) {
    throw new Error(
      "danbooru.login and danbooru.api_key must be configured together.",
    );
  }
  const baseUrl = normalizeConfiguredBaseUrl(context.config?.base_url);
  const config: DanbooruConfig = {
    baseUrl,
    maxRegularTags: context.config?.max_regular_tags ?? 2,
    defaultLimit: context.config?.default_limit ?? DEFAULT_SEARCH_LIMIT,
    defaultOrder,
    downloadSubdir: context.config?.download_subdir ?? "downloads/danbooru",
    login,
    apiKey,
    suggestOnEmpty: context.config?.suggest_on_empty ?? true,
    maxSuggestions: clampSuggestionCount(context.config?.max_suggestions),
  };

  const authHeader = buildAuthHeader(config);
  const dispatcher = buildProxyDispatcher(context.httpProxyUrl);
  // Tool-owned limiter pacing BOTH the JSON API and asset-CDN hosts as one budget
  // (spec §8.2). Constructed once per tool; shared across all actions.
  const limiter = new DanbooruRateLimiter({
    minIntervalMs: context.config?.min_request_interval_ms ?? DANBOORU_DEFAULT_MIN_INTERVAL_MS,
    maxInFlight: context.config?.max_in_flight ?? DANBOORU_DEFAULT_MAX_IN_FLIGHT,
  });

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

  const previewDescription = context.modelHasVision
    ? "Preview calls return an inline image block for a chosen post."
    : "Preview calls return a text description of a chosen post, produced by the captioning model (this agent's model can't view images directly); ask the `media` tool about a post's asset URL for specific questions.";

  return {
    name: "danbooru",
    label: "Danbooru",
    description:
      "Search Danbooru using structured JSON inputs instead of shell strings. " +
      "includeTags become positive terms, excludeTags become -tag terms, includeRatings and excludeRatings become rating metatags, " +
      "order becomes order:*, and extraTerms are appended verbatim. " +
      "Search calls query /posts.json and returns Danbooru post URLs plus preview/sample/original asset URLs and key metadata. " +
      previewDescription +
      " Download calls save a chosen post into the agent workspace. " +
      "Tags calls resolve a guess or keyword into real Danbooru tag names ranked by popularity — use them when you are unsure of the exact tag; a zero-result search also auto-suggests real tags.",
    parameters: DanbooruToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as DanbooruToolParams;
      const action = params.action ?? "search";

      if (action === "download") {
        return executeDownload({ context, config, authHeader, dispatcher, limiter, params });
      }

      if (action === "preview") {
        return executePreview({ context, config, authHeader, dispatcher, limiter, params });
      }

      if (action === "tags") {
        return executeTags({ config, authHeader, dispatcher, limiter, params });
      }

      return executeSearch({ config, authHeader, dispatcher, limiter, params });
    },
  };
}

// ---------------------------------------------------------------------------
// Execute: search
// ---------------------------------------------------------------------------

async function executeSearch(input: {
  config: DanbooruConfig;
  authHeader: string | undefined;
  dispatcher: Dispatcher | undefined;
  limiter: DanbooruRateLimiter;
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
    input.dispatcher,
    input.limiter,
  );
  const lines = buildSearchOutput({ query, posts, config: input.config });

  // Zero-result recovery: when the search matched nothing AND the caller
  // supplied positive tags, the most common cause is a guessed tag that does
  // not exist (e.g. `mordred_pendragon_(fate)` — the real tag is
  // `mordred_(fate)`). Resolve each include tag through the shared suggestion
  // engine and append a "did you mean" block so the agent can re-query with a
  // real tag without having to know to look one up. Best-effort: a failure
  // here must never turn a successful (if empty) search into a tool error.
  let recovery: TagRecoveryReport | undefined;
  if (
    posts.length === 0 &&
    input.config.suggestOnEmpty &&
    query.includeTags.length > 0
  ) {
    try {
      recovery = await buildEmptySearchRecovery({
        includeTags: query.includeTags,
        config: input.config,
        authHeader: input.authHeader,
        dispatcher: input.dispatcher,
        limiter: input.limiter,
      });
      appendRecoveryLines(lines, recovery);
    } catch {
      // Suggestions are a nicety; swallow and return the plain empty result.
      recovery = undefined;
    }
  }

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
      ...(recovery ? { suggestions: recovery } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Execute: tags (deliberate tag lookup)
// ---------------------------------------------------------------------------

async function executeTags(input: {
  config: DanbooruConfig;
  authHeader: string | undefined;
  dispatcher: Dispatcher | undefined;
  limiter: DanbooruRateLimiter;
  params: DanbooruToolParams;
}) {
  const raw = input.params.query?.trim();
  if (!raw) {
    return textError("`query` is required when action='tags'. Pass a tag guess, character/series name, or keyword.");
  }
  const suggestions = await resolveTagSuggestions({
    query: raw,
    config: input.config,
    authHeader: input.authHeader,
    dispatcher: input.dispatcher,
    limiter: input.limiter,
  });

  const lines = ["## Danbooru Tags", "", `Lookup: \`${raw}\``, ""];
  if (suggestions.length === 0) {
    lines.push("No matching tags found. Try a shorter or differently-spelled keyword.");
  } else {
    lines.push("Closest real tags (most-used first):");
    lines.push("");
    for (const s of suggestions) {
      lines.push(`- ${formatSuggestionLine(s)}`);
    }
    lines.push("");
    lines.push("Pass an exact tag above as an `includeTags` entry to search.");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { action: "tags", query: raw, count: suggestions.length, suggestions },
  };
}

// ---------------------------------------------------------------------------
// Execute: preview
// ---------------------------------------------------------------------------

async function executePreview(input: {
  context: DanbooruToolContext;
  config: DanbooruConfig;
  authHeader: string | undefined;
  dispatcher: Dispatcher | undefined;
  limiter: DanbooruRateLimiter;
  params: DanbooruToolParams;
}) {
  const postId = resolveTargetPostId(input.params, "preview");
  const post = await fetchJson<DanbooruPost>(
    input.config.baseUrl,
    `/posts/${postId}.json`,
    new URLSearchParams(),
    input.authHeader,
    input.dispatcher,
    input.limiter,
  );
  // Without vision the model gets a text description rather than an image
  // block, so prefer the larger `sample` asset by default — the 180px
  // `preview` thumbnail is too small to caption well. The vision path keeps
  // `preview` as its default (small, fits the per-image cap cheaply).
  const variant =
    input.params.previewVariant ?? (input.context.modelHasVision ? "preview" : "sample");
  const assetUrl = resolveDownloadUrl(post, variant);
  if (!assetUrl) {
    return textError(`Post #${postId} does not expose a ${variant} asset URL for your account.`);
  }

  if (!input.context.modelHasVision) {
    return describePreview({ context: input.context, config: input.config, limiter: input.limiter, post, variant, assetUrl });
  }
  return inlinePreview({ context: input.context, config: input.config, limiter: input.limiter, post, variant, assetUrl });
}

/**
 * Vision path: fetch the asset, condition it under the per-image base64 cap,
 * and return it as an inline image block. The accompanying text is intentionally
 * terse — the model can see the image, so step-by-step narration is wasted
 * tokens; we keep only the asset URLs for follow-up (download/media).
 */
async function inlinePreview(input: {
  context: DanbooruToolContext;
  config: DanbooruConfig;
  limiter: DanbooruRateLimiter;
  post: DanbooruPost;
  variant: DanbooruAssetVariant;
  assetUrl: string;
}) {
  const { context, config, limiter, post, variant, assetUrl } = input;
  // The CDN asset shares the tool's one budget (spec §8.2): pace it through the
  // same limiter. The fetch itself still routes via guardedFetch inside the client.
  const fetched = await limiter.run(() =>
    context.fetchClient.fetch(assetUrl, { maxBytes: context.downloadSizeLimit }),
  );
  let rawBuffer: Buffer;
  try {
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      throw new Error(await buildAssetFetchError("Preview fetch", fetched));
    }
    rawBuffer = await fs.readFile(fetched.path);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }

  const sourceMimeType = resolveImageMimeType({ assetUrl, contentType: fetched.contentType, post });
  if (!sourceMimeType) {
    return textError(
      `Post #${post.id} ${variant} asset is not an image that can be returned inline to the model.`,
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
  const rawByteBudget = Math.floor((context.inlineImageMaxBytes * 3) / 4);
  const inlineOptions: ImageProcessingOptions = {
    ...context.inferenceImageOptions,
    maxBytes: rawByteBudget,
  };
  let conditioned: { buffer: Buffer; mimeType: string; sizeBytes: number };
  try {
    conditioned = await conditionImageBufferForInference(rawBuffer, inlineOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return textError(
      `Post #${post.id} ${variant} asset could not be conditioned for inline preview: ${detail}`,
    );
  }

  const pageUrl = buildPostUrl(config, post.id);
  const text = [
    `## Danbooru post #${post.id} (image below)`,
    "",
    ...assetUrlLines(post, pageUrl),
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
      mode: "inline-image",
      post: summarizePost(post, config),
      variant,
      assetUrl,
      sourceMimeType,
      mimeType: conditioned.mimeType,
      inlineSizeBytes: conditioned.sizeBytes,
      pageUrl,
    },
  };
}

/**
 * Non-vision path: the model can't read an image block, so describe the asset
 * with the captioning model instead — the equivalent of the inline path handing
 * the image to the model, except here it goes to a model that *can* see. The
 * result is the caption text plus the asset URLs and a pointer to the `media`
 * tool for specific follow-up questions. If no caption client is configured,
 * degrade to URLs + the `media` pointer rather than emitting an unusable block.
 */
async function describePreview(input: {
  context: DanbooruToolContext;
  config: DanbooruConfig;
  limiter: DanbooruRateLimiter;
  post: DanbooruPost;
  variant: DanbooruAssetVariant;
  assetUrl: string;
}) {
  const { context, config, limiter, post, variant, assetUrl } = input;
  const pageUrl = buildPostUrl(config, post.id);
  const mediaHint =
    "This agent's model can't view images directly; the description above came from the captioning model. " +
    "To ask something specific about this image, call the `media` tool with the sample or original URL and your question.";

  const captionClient = context.imageCaptionClient;
  if (!captionClient) {
    const text = [
      `## Danbooru post #${post.id}`,
      "",
      "This agent's model can't view images directly and no captioning model is configured, so the image can't be described here. Use the URLs below.",
      "",
      ...assetUrlLines(post, pageUrl),
    ].join("\n");
    return {
      content: [{ type: "text" as const, text }],
      details: { action: "preview", mode: "urls-only", post: summarizePost(post, config), variant, assetUrl, pageUrl },
    };
  }

  // Fetch the asset (one budget with the JSON API, spec §8.2) and caption it.
  const fetched = await limiter.run(() =>
    context.fetchClient.fetch(assetUrl, { maxBytes: context.downloadSizeLimit }),
  );
  let caption: string;
  let captionModel: string;
  try {
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      throw new Error(await buildAssetFetchError("Preview fetch", fetched));
    }
    const sourceMimeType = resolveImageMimeType({ assetUrl, contentType: fetched.contentType, post });
    if (!sourceMimeType) {
      return textError(
        `Post #${post.id} ${variant} asset is not an image that can be described.`,
      );
    }
    const result = await captionClient.caption({
      filePath: fetched.path,
      mimeType: sourceMimeType,
      filename: `danbooru-${post.id}.${post.file_ext ?? "jpg"}`,
      context: "tool",
    });
    caption = result.caption;
    captionModel = result.model;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return textError(`Post #${post.id} ${variant} asset could not be described: ${detail}`);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }

  const text = [
    `## Danbooru post #${post.id}`,
    "",
    caption,
    "",
    ...assetUrlLines(post, pageUrl),
    "",
    mediaHint,
  ].join("\n");

  return {
    content: [{ type: "text" as const, text }],
    details: {
      action: "preview",
      mode: "described",
      post: summarizePost(post, config),
      variant,
      assetUrl,
      pageUrl,
      captionModel,
    },
  };
}

/** Shared asset-URL block appended to preview output. */
function assetUrlLines(post: DanbooruPost, pageUrl: string): string[] {
  return [
    "URLs:",
    `- page: ${pageUrl}`,
    `- original: ${post.file_url ?? "(not available)"}`,
    `- sample: ${post.large_file_url ?? "(not available)"}`,
    `- preview: ${post.preview_file_url ?? "(not available)"}`,
  ];
}

// ---------------------------------------------------------------------------
// Execute: download
// ---------------------------------------------------------------------------

async function executeDownload(input: {
  context: DanbooruToolContext;
  config: DanbooruConfig;
  authHeader: string | undefined;
  dispatcher: Dispatcher | undefined;
  limiter: DanbooruRateLimiter;
  params: DanbooruToolParams;
}) {
  const postId = resolveTargetPostId(input.params, "download");
  const post = await fetchJson<DanbooruPost>(
    input.config.baseUrl,
    `/posts/${postId}.json`,
    new URLSearchParams(),
    input.authHeader,
    input.dispatcher,
    input.limiter,
  );
  const variant = input.params.downloadVariant ?? "original";
  const assetUrl = resolveDownloadUrl(post, variant);
  if (!assetUrl) {
    return textError(`Post #${postId} does not expose a ${variant} asset URL for your account.`);
  }

  const outputSubdir = resolveOutputSubdir(input.params.outputSubdir, input.config);
  const outputDir = resolveWorkspacePath(input.context.workspaceRoot, outputSubdir);
  await fs.mkdir(outputDir, { recursive: true });

  // CDN asset on the tool's one budget (spec §8.2).
  const fetched = await input.limiter.run(() =>
    input.context.fetchClient.fetch(assetUrl, {
      maxBytes: input.context.downloadSizeLimit,
    }),
  );
  let buffer: Buffer;
  try {
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      throw new Error(await buildAssetFetchError("Download fetch", fetched));
    }
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
    ...assetUrlLines(post, pageUrl),
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

/** Default pacing for the in-tool Danbooru limiter (see {@link DanbooruRateLimiter}). */
const DANBOORU_DEFAULT_MIN_INTERVAL_MS = 500; // ≈2 req/s start rate — conservative
const DANBOORU_DEFAULT_MAX_IN_FLIGHT = 2;

/**
 * Danbooru's own rate limiter (spec Design D §8.2). Danbooru is the one HTTP
 * caller whose site and documented limits we know ahead of time, and whose JSON
 * API and asset CDN are *different hosts* that must be paced as ONE account-level
 * budget — something the generic per-host limiter at `guardedFetch` cannot model.
 * So the tool owns this limiter and runs both its API and CDN egress through it.
 *
 * It enforces a minimum interval between request *starts* plus a max in-flight
 * count. Danbooru egress still flows through `guardedFetch` for SSRF safety and the
 * unconditional 429/503 backoff (belt-and-suspenders); this limiter sets the pace.
 */
export class DanbooruRateLimiter {
  private active = 0;
  /** Next free instant in the pacing schedule (epoch ms). */
  private nextStartMs = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly opts: { minIntervalMs: number; maxInFlight: number }) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    // Slot admission: FIFO, with DIRECT HANDOFF on release. A caller queues when
    // the limiter is saturated (or anyone is already queued — no overtaking);
    // `release` then transfers slot ownership to the head waiter WITHOUT
    // decrementing `active`, so a fresh caller arriving between the release and
    // the waiter's resumption can never double-grant the freed slot past
    // `maxInFlight`.
    if (this.active >= this.opts.maxInFlight || this.waiters.length > 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      // Slot ownership was handed over in release(); `active` already counts us.
    } else {
      this.active += 1;
    }
    // Pacing: reserve this request's start instant SYNCHRONOUSLY (before any
    // await), so concurrent acquirers each claim a distinct slot in the schedule
    // instead of reading the same stale "last start" and waking together.
    const now = Date.now();
    const startAt = Math.max(now, this.nextStartMs);
    this.nextStartMs = startAt + this.opts.minIntervalMs;
    if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Direct handoff: the slot stays counted in `active` and now belongs to
      // the head waiter.
      next();
      return;
    }
    this.active -= 1;
  }
}

async function fetchJson<T>(
  baseUrl: string,
  pathname: string,
  params: URLSearchParams,
  authHeader: string | undefined,
  dispatcher: Dispatcher | undefined,
  limiter: DanbooruRateLimiter,
): Promise<T> {
  const url = new URL(pathname, baseUrl);
  url.search = params.toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DANBOORU_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    // Through the shared egress chokepoint (SSRF + unconditional 429/503 backoff),
    // paced by the tool's own limiter so the API + CDN share one budget.
    response = await limiter.run(() =>
      guardedFetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": DANBOORU_USER_AGENT,
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        // undici accepts `dispatcher` at runtime; routes this call through
        // `network.http_proxy_url` when configured.
        dispatcher,
      }),
    );
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
      // Settle the unread body so the per-host limiter slot is freed promptly.
      await response.body?.cancel().catch(() => {});
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

/**
 * Pull a human-readable detail out of a parsed Danbooru JSON error body.
 * Danbooru's API returns `{ success:false, error:"PostQuery::TagLimitError",
 * message:"You cannot search for more than 2 tags at a time." }` — note it
 * uses `message`/`error`, NOT `reason`. Earlier code only checked `reason`, so
 * every API error (e.g. the 422 tag-limit error) surfaced as a bare HTTP code
 * with no explanation. Prefer `message`, then `error`, then legacy `reason`.
 */
function extractDanbooruJsonDetail(json: Record<string, unknown>): string | undefined {
  for (const key of ["message", "error", "reason"] as const) {
    const value = json[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

async function buildDanbooruHttpError(response: DanbooruFetchResponse): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  let detail = "";
  try {
    if (contentType.includes("application/json")) {
      const json = (await response.json()) as Record<string, unknown>;
      const reason = extractDanbooruJsonDetail(json);
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

/**
 * The binary fetch path writes the response body to a temp file before we get
 * a chance to inspect it. When the status is non-2xx that body is usually a
 * small JSON or text error payload; read it from disk so we can surface
 * Danbooru's `reason` (or a snippet of the text) instead of a bare HTTP code.
 *
 * Caller is responsible for unlinking `fetched.path` — keep the same
 * finally-block cleanup pattern that protected the previous bare-throw site.
 */
export async function buildAssetFetchError(
  label: string,
  fetched: FetchResult,
): Promise<string> {
  let detail = "";
  try {
    const body = await fs.readFile(fetched.path);
    const contentType = (fetched.contentType ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
      try {
        const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        const reason = extractDanbooruJsonDetail(json);
        if (reason) {
          detail = ` (${reason})`;
        }
      } catch {
        // Fall through to text snippet below.
      }
    }
    if (!detail) {
      const text = body.toString("utf8").trim();
      if (text) {
        detail = ` (${text.slice(0, 200)})`;
      }
    }
  } catch {
    detail = "";
  }
  return `${label} failed with HTTP ${fetched.statusCode}${detail}`;
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
  const order = params.order ?? config.defaultOrder;
  // `extraTerms` are arbitrary Danbooru search terms (e.g. `score:>100`).
  // Each entry contributes one term to the final query, so it must count
  // against the same budget as `includeTags` / `excludeTags` — otherwise a
  // caller could route an unlimited number of tag-equivalent expressions
  // through `extraTerms` and bypass the regular-tag cap entirely.
  //
  // The auto-appended `order:*` metatag ALSO counts: Danbooru enforces its
  // per-account tag limit over the `order:` metatag too (empirically, an
  // anonymous account 422s on `2 regular tags + order:*` but accepts the same
  // two tags without an order). `rating:*` metatags, by contrast, are exempt
  // from that limit, so they do NOT count here. If we left `order` out of the
  // budget, a search using the full regular-tag budget plus an order — the
  // common case, since `default_order`/`order` is usually set — would pass our
  // check yet 422 at Danbooru with a bare, unexplained error.
  const orderTagCost = order ? 1 : 0;
  const regularTagCount =
    includeTags.length + excludeTags.length + extraTerms.length + orderTagCost;
  if (regularTagCount > config.maxRegularTags) {
    throw new Error(
      `This workspace is configured for at most ${config.maxRegularTags} regular tags per search ` +
        `(includeTags + excludeTags + extraTerms, plus order:* which Danbooru counts as a tag). ` +
        `Reduce these${order ? " (an order:* term is in use — drop it or a tag)" : ""} or raise ` +
        `max_regular_tags if your account tier allows more.`,
    );
  }

  const includeRatings = normalizeRatings(params.includeRatings);
  const excludeRatings = normalizeRatings(params.excludeRatings);
  validateRatingSelections(includeRatings, excludeRatings);
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
  // One compact line with the exact query Danbooru ran (the operator's debugging
  // anchor) plus paging — no step-by-step narration, which is wasted tokens. The
  // full structured breakdown lives in the tool-call `details` for the console.
  const pageSuffix = input.query.page ? `, page ${input.query.page}` : "";
  lines.push(`Query: \`${input.query.queryText}\` (limit ${input.query.limit}${pageSuffix})`);
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

function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "?";
  }
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Tag suggestions ("did you mean")
// ---------------------------------------------------------------------------

/** Default cap on candidates returned per tag-suggestion lookup. */
const SUGGESTION_DEFAULT_MAX = 6;
/** Per-word autocomplete fan-out cap when the whole query doesn't resolve. */
const SUGGESTION_MAX_TOKENS = 5;
/** How many include tags an empty search resolves (bounds added requests). */
const SUGGESTION_MAX_RECOVERY_TAGS = 4;
/** Per-lookup row cap requested from each Danbooru suggestion endpoint. */
const SUGGESTION_FETCH_LIMIT = 10;

type TagSuggestion = {
  name: string;
  category: number | null;
  categoryLabel: string;
  postCount: number;
  /** When the query matched this tag via an alias, the alias text we matched. */
  via?: string;
};

type TagRecoveryReport = {
  /** Per supplied include tag: real candidates (empty when the tag itself is valid). */
  perTag: Array<{ tag: string; valid: boolean; suggestions: TagSuggestion[] }>;
  /** True when every supplied include tag already exists on Danbooru. */
  allValid: boolean;
};

/** Shape of one `/autocomplete.json` entry (tag_query type). */
type DanbooruAutocompleteEntry = {
  value?: string;
  category?: number;
  post_count?: number;
  antecedent?: string | null;
  tag?: { is_deprecated?: boolean } | null;
};

/** Shape of one `/tags.json` row. */
type DanbooruTagRow = {
  name?: string;
  post_count?: number;
  category?: number;
  is_deprecated?: boolean;
};

type SuggestionLookupInput = {
  query: string;
  config: DanbooruConfig;
  authHeader: string | undefined;
  dispatcher: Dispatcher | undefined;
  limiter: DanbooruRateLimiter;
};

function clampSuggestionCount(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return SUGGESTION_DEFAULT_MAX;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

/** Danbooru tag-category code → human label. */
function tagCategoryLabel(category: number | null | undefined): string {
  switch (category) {
    case 0:
      return "general";
    case 1:
      return "artist";
    case 3:
      return "copyright";
    case 4:
      return "character";
    case 5:
      return "meta";
    default:
      return "tag";
  }
}

/** Lowercase + collapse spaces to underscores — the canonical Danbooru tag form. */
function normalizeTagQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Significant word tokens for the per-word fallback. A guessed tag like
 * `mordred_pendragon_(fate)` autocompletes to NOTHING as a whole (the word
 * "pendragon" isn't in the real `mordred_(fate)` tag), so we split it into
 * words and look each up individually. Drops short/numeric noise and dedups.
 */
function tokenizeTagQuery(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const piece of query.toLowerCase().split(/[\s_()/]+/)) {
    const token = piece.trim();
    if (token.length <= 2) continue;
    if (/^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

async function fetchAutocomplete(input: SuggestionLookupInput): Promise<DanbooruAutocompleteEntry[]> {
  const params = new URLSearchParams({
    "search[query]": input.query,
    "search[type]": "tag_query",
    limit: String(SUGGESTION_FETCH_LIMIT),
  });
  const data = await fetchJson<DanbooruAutocompleteEntry[]>(
    input.config.baseUrl,
    "/autocomplete.json",
    params,
    input.authHeader,
    input.dispatcher,
    input.limiter,
  );
  return Array.isArray(data) ? data : [];
}

async function fetchTagWildcard(
  input: Omit<SuggestionLookupInput, "query"> & { token: string },
): Promise<DanbooruTagRow[]> {
  const params = new URLSearchParams({
    "search[name_matches]": `*${input.token}*`,
    "search[order]": "count",
    limit: String(SUGGESTION_FETCH_LIMIT),
  });
  const data = await fetchJson<DanbooruTagRow[]>(
    input.config.baseUrl,
    "/tags.json",
    params,
    input.authHeader,
    input.dispatcher,
    input.limiter,
  );
  return Array.isArray(data) ? data : [];
}

function upsertSuggestion(map: Map<string, TagSuggestion>, suggestion: TagSuggestion): void {
  const existing = map.get(suggestion.name);
  if (!existing) {
    map.set(suggestion.name, suggestion);
    return;
  }
  if (suggestion.postCount > existing.postCount) existing.postCount = suggestion.postCount;
  if (!existing.via && suggestion.via) existing.via = suggestion.via;
  if (existing.category == null && suggestion.category != null) {
    existing.category = suggestion.category;
    existing.categoryLabel = suggestion.categoryLabel;
  }
}

/**
 * Resolve a free-text guess/keyword into real Danbooru tags, ranked best-first.
 * Strategy (each step paced through the tool's one budget via `fetchJson`):
 *   1. autocomplete the whole normalized query (handles typos + aliases);
 *   2. if that found no exact tag, autocomplete each significant word — recovers
 *      multi-word guesses whose words exist but not in that combination;
 *   3. if still empty, a `*token*` wildcard on /tags.json (in-word typos).
 * Candidates are deduped, then ranked by how many query words they contain
 * (so `mordred_(fate)` beats a generic high-count `fate_(series)`), then by
 * post count.
 */
async function resolveTagSuggestions(input: SuggestionLookupInput): Promise<TagSuggestion[]> {
  const normalized = normalizeTagQuery(input.query);
  const tokens = tokenizeTagQuery(input.query);
  const candidates = new Map<string, TagSuggestion>();

  const addEntry = (entry: DanbooruAutocompleteEntry): void => {
    const name = (entry.value ?? "").trim();
    if (!name || entry.tag?.is_deprecated) return;
    upsertSuggestion(candidates, {
      name,
      category: entry.category ?? null,
      categoryLabel: tagCategoryLabel(entry.category),
      postCount: entry.post_count ?? 0,
      via: entry.antecedent && entry.antecedent !== name ? entry.antecedent : undefined,
    });
  };
  const addRow = (row: DanbooruTagRow): void => {
    const name = (row.name ?? "").trim();
    if (!name || row.is_deprecated) return;
    upsertSuggestion(candidates, {
      name,
      category: row.category ?? null,
      categoryLabel: tagCategoryLabel(row.category),
      postCount: row.post_count ?? 0,
    });
  };

  for (const entry of await fetchAutocomplete({ ...input, query: normalized })) addEntry(entry);

  if (!candidates.has(normalized) && tokens.length > 1) {
    for (const token of tokens.slice(0, SUGGESTION_MAX_TOKENS)) {
      for (const entry of await fetchAutocomplete({ ...input, query: token })) addEntry(entry);
    }
  }

  if (candidates.size === 0) {
    const longest = [...tokens].sort((a, b) => b.length - a.length)[0] ?? normalized;
    if (longest) {
      for (const row of await fetchTagWildcard({ ...input, token: longest })) addRow(row);
    }
  }

  return rankSuggestions([...candidates.values()], tokens, input.config.maxSuggestions);
}

function rankSuggestions(
  list: TagSuggestion[],
  tokens: string[],
  max: number,
): TagSuggestion[] {
  const matchCount = (name: string): number =>
    tokens.reduce((count, token) => (name.includes(token) ? count + 1 : count), 0);
  return list
    .map((suggestion) => ({ suggestion, matches: matchCount(suggestion.name) }))
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        b.suggestion.postCount - a.suggestion.postCount ||
        a.suggestion.name.localeCompare(b.suggestion.name),
    )
    .slice(0, max)
    .map((ranked) => ranked.suggestion);
}

/**
 * Build the per-tag recovery report for a zero-result search. For each supplied
 * include tag (capped) we resolve suggestions; a tag is "valid" when it appears
 * among its own suggestions (so we don't "correct" a real tag). When every tag
 * is valid the empty result is a combination/filter problem, not a bad tag.
 */
async function buildEmptySearchRecovery(input: {
  includeTags: string[];
  config: DanbooruConfig;
  authHeader: string | undefined;
  dispatcher: Dispatcher | undefined;
  limiter: DanbooruRateLimiter;
}): Promise<TagRecoveryReport> {
  const perTag: TagRecoveryReport["perTag"] = [];
  for (const tag of input.includeTags.slice(0, SUGGESTION_MAX_RECOVERY_TAGS)) {
    const suggestions = await resolveTagSuggestions({
      query: tag,
      config: input.config,
      authHeader: input.authHeader,
      dispatcher: input.dispatcher,
      limiter: input.limiter,
    });
    const normalized = normalizeTagQuery(tag);
    const valid = suggestions.some((suggestion) => suggestion.name === normalized);
    perTag.push({ tag, valid, suggestions: valid ? [] : suggestions });
  }
  const allValid = perTag.length > 0 && perTag.every((entry) => entry.valid);
  return { perTag, allValid };
}

function appendRecoveryLines(lines: string[], recovery: TagRecoveryReport): void {
  if (recovery.allValid) {
    lines.push("");
    lines.push(
      "Every supplied tag exists on Danbooru, so nothing matches this *combination*. " +
        "Try removing a tag, loosening rating filters, or a different `order`.",
    );
    return;
  }
  const correctable = recovery.perTag.filter(
    (entry) => !entry.valid && entry.suggestions.length > 0,
  );
  if (correctable.length === 0) return;
  lines.push("");
  lines.push("Did you mean? (couldn't find an exact tag for some of your terms)");
  for (const entry of correctable) {
    lines.push(`- \`${entry.tag}\` →`);
    for (const suggestion of entry.suggestions) {
      lines.push(`    ${formatSuggestionLine(suggestion)}`);
    }
  }
  lines.push("");
  lines.push(
    'Re-run `search` with one of the real tags above (or use `action: "tags"` to look up more).',
  );
}

function formatSuggestionLine(suggestion: TagSuggestion): string {
  const via = suggestion.via ? ` (via alias \`${suggestion.via}\`)` : "";
  return `${suggestion.name}  —  ${suggestion.categoryLabel}, ${formatPostCount(suggestion.postCount)} posts${via}`;
}

function formatPostCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  return Math.floor(count).toLocaleString("en-US");
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

function normalizeConfiguredDefaultOrder(value: string | undefined): DanbooruOrder | undefined {
  if (!value) return undefined;
  if (!(DANBOORU_ORDERS as readonly string[]).includes(value)) {
    throw new Error(
      `danbooru.default_order must be one of the supported Danbooru order values, got "${value}".`,
    );
  }
  return value as DanbooruOrder;
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeConfiguredBaseUrl(value: string | undefined): string {
  const DEFAULT = "https://danbooru.donmai.us";
  if (value == null) return DEFAULT;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("danbooru.base_url must be a valid URL.");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("danbooru.base_url must use http or https.");
  }
  return url.toString().replace(/\/+$/, "");
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
