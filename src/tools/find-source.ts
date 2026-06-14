import fs from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import { buildProxyDispatcher, type FetchClient } from "../enrichment/fetch-client.js";
import { guardedFetch } from "./ssrf.js";
import type { Dispatcher } from "undici";
import {
  conditionImageBufferForInference,
  type ImageProcessingOptions,
} from "../media/index.js";
import type { SauceNaoRateLimiter } from "../saucenao/rate-limiter.js";

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://saucenao.com";
const DEFAULT_NUMRES = 8;
const DEFAULT_MAX_RESULTS_LIMIT = 16;
const DEFAULT_MIN_SIMILARITY = 55;
const DEFAULT_DB = 999; // all indexes
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_IMAGE_BYTES = 4_000_000; // condition uploads down to ~4MB
const DEFAULT_VIEW_MAX_BLOCKS = 3;
const DEFAULT_MAX_WAIT_MS = 8_000;
/** Hard cap on the SauceNAO JSON response body (results are small KB-scale). */
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT = "MikuAgent/0.1 (mikuswarm find_source)";

// ---------------------------------------------------------------------------
// Config / context
// ---------------------------------------------------------------------------

export interface FindSourceToolConfig {
  api_key?: string;
  base_url?: string;
  numres?: number;
  max_results_limit?: number;
  min_similarity?: number;
  db?: number;
  timeout_ms?: number;
  max_image_bytes?: number;
  view_max_blocks?: number;
}

export interface FindSourceToolContext {
  /** Resolve the image path (workspace-relative input). */
  workspaceRoot: string;
  /** Used to fetch matched thumbnails for the vision `view` path. */
  fetchClient: FetchClient;
  /** Per-image base64 cap for inlined thumbnails (same budget as read_image). */
  inlineImageMaxBytes: number;
  /** Sharp resize/encode options shared with captioning + the inline paths. */
  inferenceImageOptions: ImageProcessingOptions;
  /** Gates `view` — only honored when the default model can see images. */
  modelHasVision: boolean;
  /**
   * SHARED process-wide limiter for the per-account SauceNAO short-window quota
   * (spec §4). Constructed once at app startup, injected into every session.
   */
  rateLimiter: SauceNaoRateLimiter;
  /** Per-acquire wall-clock bound on the rate-limiter wait. */
  maxWaitMs?: number;
  /** Optional http(s) proxy for the SauceNAO API call. */
  httpProxyUrl?: string;
  config: FindSourceToolConfig;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const FindSourceSchema = Type.Object(
  {
    image: Type.String({
      minLength: 1,
      description:
        "The image to look up: either a workspace-relative path (copy the path=\"…\" from an <attachment> you see in context, e.g. ./attachments/…/foo.jpg) OR an http(s) image URL. A path is uploaded; a URL is passed to SauceNAO to fetch server-side.",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: DEFAULT_MAX_RESULTS_LIMIT,
        description: "Max results to return (1–16, default 8). Drops anything below the similarity floor.",
      }),
    ),
    min_similarity: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 100,
        description:
          "Similarity floor as a percentage (0–100). Results below are dropped. Default 55. Lower it to see weaker candidates, raise it for only near-certain matches.",
      }),
    ),
    view: Type.Optional(
      Type.Boolean({
        description:
          "When true and your model has vision, also inline the top matched thumbnails as image blocks so you can visually confirm the match. Ignored (with a note) on a non-vision model — rely on the similarity score instead.",
      }),
    ),
  },
  { additionalProperties: false },
);

type FindSourceParams = {
  image?: string;
  limit?: number;
  min_similarity?: number;
  view?: boolean;
};

// ---------------------------------------------------------------------------
// SauceNAO API types (tolerant — treat every field optional)
// ---------------------------------------------------------------------------

interface SauceNaoHeaderRaw {
  status?: number;
  message?: string;
  short_limit?: string | number;
  long_limit?: string | number;
  short_remaining?: number;
  long_remaining?: number;
  results_returned?: number;
}

interface SauceNaoResultHeaderRaw {
  similarity?: string | number;
  thumbnail?: string;
  index_id?: number;
  index_name?: string;
}

interface SauceNaoResultDataRaw {
  ext_urls?: string[];
  title?: string;
  member_name?: string;
  member_id?: number | string;
  author_name?: string;
  author_url?: string;
  creator?: string | string[];
  source?: string;
  pixiv_id?: number | string;
  danbooru_id?: number | string;
  gelbooru_id?: number | string;
  yandere_id?: number | string;
  konachan_id?: number | string;
  da_id?: number | string;
  [key: string]: unknown;
}

interface SauceNaoResultRaw {
  header?: SauceNaoResultHeaderRaw;
  data?: SauceNaoResultDataRaw;
}

interface SauceNaoResponseRaw {
  header?: SauceNaoHeaderRaw;
  results?: SauceNaoResultRaw[];
}

/** One normalized candidate (also the shape surfaced under `details.results`). */
export interface NormalizedSauceResult {
  similarity: number;
  indexId: number | null;
  indexName: string | null;
  thumbnail: string | null;
  title: string | null;
  author: string | null;
  sourceUrls: string[];
  ids: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFindSourceTool(context: FindSourceToolContext): AgentTool {
  const apiKey = (context.config.api_key ?? "").trim();
  if (!apiKey) {
    // Early validation, matching image_gen: an enabled-but-unkeyed tool is a
    // config error, surfaced loudly at construction rather than per call.
    throw new Error("saucenao.api_key must be configured when find_source is enabled.");
  }
  const baseUrl = normalizeBaseUrl(context.config.base_url);
  const numres = clampInt(context.config.numres, 1, 30, DEFAULT_NUMRES);
  const maxResultsLimit = clampInt(context.config.max_results_limit, 1, 30, DEFAULT_MAX_RESULTS_LIMIT);
  const defaultMinSimilarity = clampNum(context.config.min_similarity, 0, 100, DEFAULT_MIN_SIMILARITY);
  const db = clampInt(context.config.db, 0, 999_999, DEFAULT_DB);
  const timeoutMs = context.config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxImageBytes = context.config.max_image_bytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const viewMaxBlocks = clampInt(context.config.view_max_blocks, 1, 16, DEFAULT_VIEW_MAX_BLOCKS);
  const maxWaitMs = context.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const dispatcher = buildProxyDispatcher(context.httpProxyUrl);

  return {
    name: "find_source",
    label: "Find source",
    description:
      "Reverse-image search via SauceNAO — find the SOURCE/origin of an image (Pixiv, Danbooru/booru, X/Twitter, anime screencaps, DeviantArt, etc.). " +
      "The inverse of `danbooru` (which goes tags → images); this goes image → source URL + artist. " +
      "Pass `image` as a workspace path (copy it from an <attachment path=…> you see in context) or an http(s) URL. " +
      "Returns ranked candidates led by a perceptual-similarity % — that score, NOT the picture's vibe, is the identity signal: ≥~80% is almost certainly the same image. " +
      "On a vision model, pass `view: true` to also see the top thumbnails and confirm the match. " +
      "SauceNAO's free quota is tight (~6/30s, ~200/day); the result surfaces remaining counts — don't spam it.",
    parameters: FindSourceSchema,
    execute: async (_toolCallId, rawParams, agentSignal) => {
      const params = rawParams as FindSourceParams;
      const image = params.image?.trim();
      if (!image) {
        return textError("find_source requires a non-empty 'image' (workspace path or http(s) URL).");
      }
      const minSimilarity =
        params.min_similarity != null ? clampNum(params.min_similarity, 0, 100, defaultMinSimilarity) : defaultMinSimilarity;
      const limit = params.limit != null ? clampInt(params.limit, 1, maxResultsLimit, numres) : numres;

      // 1. Resolve the image input → url passthrough or conditioned upload bytes.
      let queriedBy: "url" | "upload";
      let imageUrl: string | undefined;
      let upload: { buffer: Buffer; mimeType: string } | undefined;
      if (isUrlInput(image)) {
        queriedBy = "url";
        try {
          const parsed = new URL(image);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return textError("Only http(s) image URLs are supported.");
          }
        } catch {
          return textError(`Not a valid URL: ${image}`);
        }
        imageUrl = image;
      } else {
        queriedBy = "upload";
        let raw: Buffer;
        try {
          const abs = resolveWorkspacePath(context.workspaceRoot, image);
          raw = await fs.readFile(abs);
        } catch (error) {
          return textError(`Could not read image '${image}': ${errMessage(error)}`);
        }
        try {
          // Condition to bound the upload (SauceNAO only needs a modest image for
          // perceptual hashing; this also respects its file-size cap).
          const conditioned = await conditionImageBufferForInference(raw, {
            ...context.inferenceImageOptions,
            maxBytes: maxImageBytes,
          });
          upload = { buffer: conditioned.buffer, mimeType: conditioned.mimeType };
        } catch (error) {
          return textError(`Could not prepare image '${image}' for upload: ${errMessage(error)}`);
        }
      }

      // 2. Acquire a short-window rate-limiter slot (shared per-account quota).
      let admission;
      try {
        admission = await context.rateLimiter.acquire({ signal: agentSignal, maxWaitMs });
      } catch (error) {
        // Abort = the agent turn was cancelled; propagate as a tool error.
        return textError(`find_source aborted while waiting for a SauceNAO slot: ${errMessage(error)}`);
      }
      if (!admission.admitted) {
        const secs = Math.ceil(admission.waitMs / 1000);
        const snap = context.rateLimiter.snapshot();
        return softResult(
          `SauceNAO short-window quota is exhausted (~${secs}s until a slot frees; ${snap.remaining}/${snap.max} short-window slots free). ` +
            `Try again shortly — don't retry in a tight loop.`,
          { rateLimited: true, waitMs: admission.waitMs, queriedBy },
        );
      }

      // 3. Call SauceNAO.
      let outcome: SauceNaoCallOutcome;
      try {
        outcome = await callSauceNao({
          baseUrl,
          apiKey,
          db,
          numres: limit,
          minSimilarity,
          imageUrl,
          upload,
          dispatcher,
          timeoutMs,
          signal: agentSignal,
        });
      } catch (error) {
        return textError(`SauceNAO request failed: ${errMessage(error)}`);
      }

      // 4. Reconcile the limiter from authoritative counters (best-effort).
      const header = outcome.kind === "ok" ? outcome.body.header : undefined;
      if (header?.short_remaining != null) {
        context.rateLimiter.reconcileShort(header.short_remaining, toNumber(header.short_limit) ?? undefined);
      }

      // 5. Status handling.
      if (outcome.kind === "http") {
        if (outcome.status === 429) {
          return softResult(
            `SauceNAO returned HTTP 429 (rate limited)${outcome.detail ? ` — ${outcome.detail}` : ""}. ` +
              `The daily (~200) or short (~6/30s) quota is likely spent; wait before retrying.`,
            { rateLimited: true, status: 429, queriedBy },
          );
        }
        return textError(`SauceNAO request failed: HTTP ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}.`);
      }

      const status = outcome.body.header?.status ?? 0;
      const statusKind = sauceStatusKind(status);
      if (statusKind === "fatal") {
        const msg = outcome.body.header?.message?.trim();
        return textError(`SauceNAO error: ${msg || `status ${status}`}.`);
      }
      const partial = statusKind === "partial";

      // 6. Filter + rank.
      const filtered = rankResults(outcome.body.results, minSimilarity, limit);

      // 7. Format output (vision-adaptive).
      const shortRemaining = outcome.body.header?.short_remaining ?? null;
      const longRemaining = outcome.body.header?.long_remaining ?? null;
      const viewRequested = params.view === true;
      const viewActive = viewRequested && context.modelHasVision;

      const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];
      const viewed: number[] = [];
      const viewNotes: string[] = [];
      if (viewActive && filtered.length > 0) {
        const toView = filtered.slice(0, viewMaxBlocks);
        for (let i = 0; i < toView.length; i++) {
          const r = toView[i]!;
          if (!r.thumbnail) continue;
          const block = await fetchThumbnailBlock(context, r.thumbnail, viewNotes, i + 1);
          if (block) {
            imageBlocks.push(block);
            viewed.push(i);
          }
        }
        if (filtered.length > viewMaxBlocks) {
          viewNotes.push(`[only the top ${viewMaxBlocks} of ${filtered.length} matches shown inline]`);
        }
      } else if (viewRequested && !context.modelHasVision) {
        viewNotes.push("[view ignored: this model has no vision — relying on the similarity score instead]");
      }

      const text = buildOutputText({
        results: filtered,
        minSimilarity,
        queriedBy,
        partial,
        shortRemaining,
        longRemaining,
        viewActive,
        viewNotes,
      });

      return {
        content: [{ type: "text" as const, text }, ...imageBlocks],
        details: {
          queriedBy,
          status,
          partial,
          minSimilarity,
          limit,
          count: filtered.length,
          shortRemaining,
          longRemaining,
          viewed,
          results: filtered,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// SauceNAO client
// ---------------------------------------------------------------------------

type SauceNaoCallOutcome =
  | { kind: "ok"; body: SauceNaoResponseRaw }
  | { kind: "http"; status: number; detail?: string };

async function callSauceNao(input: {
  baseUrl: string;
  apiKey: string;
  db: number;
  numres: number;
  minSimilarity: number;
  imageUrl?: string;
  upload?: { buffer: Buffer; mimeType: string };
  dispatcher: Dispatcher | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SauceNaoCallOutcome> {
  const url = new URL("/search.php", input.baseUrl);
  url.searchParams.set("api_key", input.apiKey);
  url.searchParams.set("output_type", "2");
  url.searchParams.set("db", String(input.db));
  url.searchParams.set("numres", String(input.numres));
  // SauceNAO's `minsim` is an integer percentage; floor it.
  url.searchParams.set("minsim", String(Math.floor(input.minSimilarity)));
  if (input.imageUrl) {
    url.searchParams.set("url", input.imageUrl);
  }

  // Compose the agent abort signal with a per-request timeout.
  const controller = new AbortController();
  const onAgentAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onAgentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  let body: BodyInit | undefined;
  let method = "GET";
  if (input.upload) {
    // Multipart upload: only the `file` field rides the body; everything else
    // stays in the query string (SauceNAO accepts query params on POST). We do
    // NOT set content-type — undici derives the multipart boundary from FormData.
    method = "POST";
    const form = new FormData();
    const ext = mimeToExt(input.upload.mimeType);
    form.append("file", new Blob([new Uint8Array(input.upload.buffer)], { type: input.upload.mimeType }), `image.${ext}`);
    body = form;
  }

  let response: Response;
  try {
    response = await guardedFetch(url.toString(), {
      method,
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      ...(body !== undefined ? { body } : {}),
      dispatcher: input.dispatcher,
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      // Distinguish a timeout from an agent-initiated abort.
      if (input.signal?.aborted) throw new Error("aborted");
      throw new Error(`timed out after ${input.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener("abort", onAgentAbort);
  }

  if (!response.ok) {
    const detail = await safeReadText(response);
    return { kind: "http", status: response.status, detail };
  }
  const parsed = (await readJsonCapped(response, controller)) as SauceNaoResponseRaw;
  return { kind: "ok", body: parsed ?? {} };
}

/** Stream the JSON body with a running byte cap (SauceNAO bodies are small). */
async function readJsonCapped(response: Response, controller: AbortController): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`SauceNAO response too large: declared content-length ${declared} > ${RESPONSE_MAX_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > RESPONSE_MAX_BYTES) {
      controller.abort();
      throw new Error(`SauceNAO response exceeded ${RESPONSE_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return JSON.parse(combined.toString("utf8"));
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/** Known source-id fields surfaced (in this order) under `ids`. */
const ID_FIELDS = [
  "pixiv_id",
  "danbooru_id",
  "gelbooru_id",
  "yandere_id",
  "konachan_id",
  "da_id",
] as const;

/** Whether the agent's `image` input is an http(s) URL (→ passthrough) vs a path (→ upload). */
export function isUrlInput(image: string): boolean {
  return /^https?:\/\//i.test(image.trim());
}

/**
 * Classify SauceNAO's `header.status`: 0 (or absent) ok, < 0 a fatal API error
 * (bad key/image), > 0 a partial result (some indexes failed but others returned).
 */
export function sauceStatusKind(status: number | undefined): "ok" | "partial" | "fatal" {
  if (status == null || !Number.isFinite(status) || status === 0) return "ok";
  return status < 0 ? "fatal" : "partial";
}

/** Normalize, drop below-floor matches, sort by similarity desc, cap to `limit`. */
export function rankResults(
  results: SauceNaoResultRaw[] | undefined,
  minSimilarity: number,
  limit: number,
): NormalizedSauceResult[] {
  return normalizeResults(results)
    .filter((r) => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(0, limit));
}

export function normalizeResults(results: SauceNaoResultRaw[] | undefined): NormalizedSauceResult[] {
  if (!Array.isArray(results)) return [];
  const out: NormalizedSauceResult[] = [];
  for (const r of results) {
    const header = r.header ?? {};
    const data = r.data ?? {};
    const similarity = toNumber(header.similarity) ?? 0;
    const sourceUrls = Array.isArray(data.ext_urls)
      ? data.ext_urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
      : [];
    const ids: Record<string, string> = {};
    for (const field of ID_FIELDS) {
      const v = data[field];
      if (v != null && v !== "") ids[field] = String(v);
    }
    // `source` and `author_url` are sometimes URLs, sometimes free text — surface
    // verbatim as data only (never fed to a fetcher).
    if (typeof data.source === "string" && data.source.trim()) ids.source = data.source.trim();
    out.push({
      similarity,
      indexId: typeof header.index_id === "number" ? header.index_id : null,
      indexName: typeof header.index_name === "string" ? header.index_name : null,
      thumbnail: typeof header.thumbnail === "string" && /^https?:\/\//i.test(header.thumbnail) ? header.thumbnail : null,
      title: firstNonEmpty(data.title),
      author: firstNonEmpty(data.member_name, data.author_name, firstString(data.creator)),
      sourceUrls,
      ids,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function buildOutputText(input: {
  results: NormalizedSauceResult[];
  minSimilarity: number;
  queriedBy: "url" | "upload";
  partial: boolean;
  shortRemaining: number | null;
  longRemaining: number | null;
  viewActive: boolean;
  viewNotes: string[];
}): string {
  const lines: string[] = ["## SauceNAO Source Lookup", ""];
  const quota: string[] = [];
  if (input.shortRemaining != null) quota.push(`short ${input.shortRemaining} left`);
  if (input.longRemaining != null) quota.push(`daily ${input.longRemaining} left`);
  lines.push(
    `Queried by ${input.queriedBy === "url" ? "URL" : "uploaded image"}; similarity floor ${input.minSimilarity}%` +
      (quota.length > 0 ? ` · quota: ${quota.join(", ")}` : ""),
  );
  if (input.partial) {
    lines.push("");
    lines.push("_Partial result — some SauceNAO indexes were unavailable; matches there may be missing._");
  }
  lines.push("");

  if (input.results.length === 0) {
    lines.push(
      `No matches at or above ${input.minSimilarity}% similarity. The image may not be indexed, or it's a crop/edit — ` +
        `try lowering min_similarity, but treat anything below ~55% as weak/likely wrong rather than a real source.`,
    );
  } else {
    lines.push(`${input.results.length} candidate(s), best first (lead with the similarity %, it's the identity signal):`);
    lines.push("");
    input.results.forEach((r, i) => {
      const sim = r.similarity.toFixed(2);
      const confidence = r.similarity >= 80 ? "strong" : r.similarity >= 55 ? "plausible — verify" : "weak";
      const kind = r.indexName ? r.indexName.replace(/^Index #\d+:\s*/, "").split(" - ")[0] : "unknown source";
      lines.push(`${i + 1}. **${sim}%** (${confidence}) — ${kind}`);
      if (r.author) lines.push(`   - artist: ${r.author}`);
      if (r.title) lines.push(`   - title: ${r.title}`);
      for (const url of r.sourceUrls) lines.push(`   - source: ${url}`);
      const idStr = Object.entries(r.ids)
        .map(([k, v]) => `${k}=${v}`)
        .join(" · ");
      if (idStr) lines.push(`   - ids: ${idStr}`);
      if (r.thumbnail) lines.push(`   - thumbnail: ${r.thumbnail}`);
    });
  }

  if (input.viewActive) {
    lines.push("");
    lines.push("_Top matched thumbnails inlined below — confirm they're the SAME image as the query, not just similar._");
  }
  if (input.viewNotes.length > 0) {
    lines.push("");
    lines.push(...input.viewNotes);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Thumbnail view (vision path)
// ---------------------------------------------------------------------------

async function fetchThumbnailBlock(
  context: FindSourceToolContext,
  thumbnailUrl: string,
  notes: string[],
  index: number,
): Promise<{ type: "image"; data: string; mimeType: string } | null> {
  let raw: Buffer;
  const fetched = await context.fetchClient.fetch(thumbnailUrl).catch((error) => {
    notes.push(`[match ${index}: thumbnail fetch failed (${errMessage(error)}) — see its URL above]`);
    return null;
  });
  if (!fetched) return null;
  try {
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      notes.push(`[match ${index}: thumbnail fetch failed with HTTP ${fetched.statusCode} — see its URL above]`);
      return null;
    }
    raw = await fs.readFile(fetched.path);
  } finally {
    await fs.unlink(fetched.path).catch(() => {});
  }
  // Same conditioning pipeline + base64 budget as read_image / danbooru preview.
  const rawByteBudget = Math.floor((context.inlineImageMaxBytes * 3) / 4);
  try {
    const conditioned = await conditionImageBufferForInference(raw, {
      ...context.inferenceImageOptions,
      maxBytes: rawByteBudget,
    });
    return { type: "image" as const, data: conditioned.buffer.toString("base64"), mimeType: conditioned.mimeType };
  } catch (error) {
    notes.push(`[match ${index}: thumbnail could not be conditioned for inline viewing (${errMessage(error)})]`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`saucenao.base_url must be a valid URL, got "${trimmed}".`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("saucenao.base_url must use http or https.");
  }
  return trimmed.replace(/\/+$/, "");
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clampNum(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstNonEmpty(...values: Array<unknown>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const s = value.find((v) => typeof v === "string" && v.trim());
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

function mimeToExt(mimeType: string): string {
  const m = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (m) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textError(message: string) {
  return {
    content: [{ type: "text" as const, text: `error: ${message}` }],
    details: { error: message },
  };
}

/** A non-error, agent-visible result (e.g. rate-limited) the model should read and act on. */
function softResult(message: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
  };
}
