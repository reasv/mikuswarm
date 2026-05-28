import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath, workspaceRelative } from "./workspace.js";
import { buildProxyDispatcher, type ConcurrencyLimitedFetchClient } from "../enrichment/fetch-client.js";
import type { Dispatcher } from "undici";

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
  created_at?: string;
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
  downloadSizeLimit: number;
  fetchClient: ConcurrencyLimitedFetchClient;
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
  const defaultOrder = normalizeConfiguredDefaultOrder(context.config?.default_order);
  const config: DanbooruConfig = {
    baseUrl: context.config?.base_url ?? "https://danbooru.donmai.us",
    maxRegularTags: context.config?.max_regular_tags ?? 2,
    defaultLimit: context.config?.default_limit ?? DEFAULT_SEARCH_LIMIT,
    defaultOrder,
    downloadSubdir: context.config?.download_subdir ?? "downloads/danbooru",
    login: context.config?.login,
    apiKey: context.config?.api_key,
  };

  const authHeader = buildAuthHeader(config);
  const dispatcher = buildProxyDispatcher(context.httpProxyUrl);

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
        return executeDownload({ context, config, authHeader, dispatcher, params });
      }

      if (action === "preview") {
        return executePreview({ context, config, authHeader, dispatcher, params });
      }

      return executeSearch({ config, authHeader, dispatcher, params });
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
  dispatcher: Dispatcher | undefined;
  params: DanbooruToolParams;
}) {
  const postId = resolveTargetPostId(input.params, "preview");
  const post = await fetchJson<DanbooruPost>(
    input.config.baseUrl,
    `/posts/${postId}.json`,
    new URLSearchParams(),
    input.authHeader,
    input.dispatcher,
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

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fetched.path);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }

  const mimeType = resolveImageMimeType({
    assetUrl,
    contentType: fetched.contentType,
    post,
  });
  if (!mimeType) {
    return textError(
      `Post #${postId} ${variant} asset is not an image that can be returned inline to the model.`,
    );
  }

  const pageUrl = buildPostUrl(input.config, post.id);
  const text = [
    "## Danbooru Preview",
    "",
    `Showing post #${post.id} inline from the ${variant} asset.`,
    "",
    "How this worked:",
    `- fetched metadata from \`/posts/${post.id}.json\``,
    `- selected the ${variant} asset URL`,
    `- fetched the binary asset`,
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
      { type: "image" as const, data: buffer.toString("base64"), mimeType },
    ],
    details: {
      action: "preview",
      post: summarizePost(post, input.config),
      variant,
      assetUrl,
      mimeType,
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
  dispatcher: Dispatcher | undefined;
  params: DanbooruToolParams;
}) {
  const postId = resolveTargetPostId(input.params, "download");
  const post = await fetchJson<DanbooruPost>(
    input.config.baseUrl,
    `/posts/${postId}.json`,
    new URLSearchParams(),
    input.authHeader,
    input.dispatcher,
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

async function fetchJson<T>(
  baseUrl: string,
  pathname: string,
  params: URLSearchParams,
  authHeader: string | undefined,
  dispatcher: Dispatcher | undefined,
): Promise<T> {
  const url = new URL(pathname, baseUrl);
  url.search = params.toString();
  const response = await globalThis.fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    // Node's native fetch (undici) accepts `dispatcher` at runtime.
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
  if (!response.ok) {
    throw new Error(await buildDanbooruHttpError(response));
  }
  return (await response.json()) as T;
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
  const regularTagCount = includeTags.length + excludeTags.length;
  if (regularTagCount > config.maxRegularTags) {
    throw new Error(
      `This workspace is configured for at most ${config.maxRegularTags} regular tags per search. ` +
        `Reduce includeTags/excludeTags or raise max_regular_tags if your account tier allows more.`,
    );
  }

  const includeRatings = normalizeRatings(params.includeRatings);
  const excludeRatings = normalizeRatings(params.excludeRatings);
  validateRatingSelections(includeRatings, excludeRatings);
  const order = params.order ?? config.defaultOrder;
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
      `- #${post.id} | rating=${post.rating} | score=${post.score} | favs=${post.fav_count} | ${post.image_width ?? "?"}x${post.image_height ?? "?"} | ext=${post.file_ext ?? "?"}`,
    );
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

function validateExtraTerms(values: readonly string[]): void {
  for (const value of values) {
    if (!value.includes(":")) {
      throw new Error(
        `extraTerms only supports Danbooru metatags, not plain tags. Move "${value}" into includeTags or excludeTags.`,
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

async function writeDownload(input: {
  dir: string;
  fileName: string | undefined;
  post: DanbooruPost;
  assetUrl: string;
  buffer: Buffer;
}): Promise<string> {
  const ext = inferExtension(input.fileName, input.post, input.assetUrl);
  const preferredBase = sanitizeFileBaseName(input.fileName) ?? `danbooru-${input.post.id}`;
  let filePath = path.join(input.dir, `${preferredBase}.${ext}`);
  let suffix = 1;

  while (await fileExists(filePath)) {
    filePath = path.join(input.dir, `${preferredBase}-${suffix}.${ext}`);
    suffix += 1;
  }

  await fs.writeFile(filePath, input.buffer);
  return filePath;
}

function inferExtension(
  explicitFileName: string | undefined,
  post: DanbooruPost,
  assetUrl: string,
): string {
  const explicitExt = explicitFileName ? path.extname(explicitFileName).replace(/^\./, "") : "";
  if (explicitExt) {
    return explicitExt.toLowerCase();
  }
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
