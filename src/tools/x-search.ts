import { unlink } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Dispatcher } from "undici";
import { guardedFetch } from "./ssrf.js";
import { buildProxyDispatcher, type FetchClient } from "../enrichment/fetch-client.js";
import type { FxTwitterClient } from "../fxtwitter/client.js";
import { parseXStatusUrl } from "../fxtwitter/url.js";
import { buildTweetDocument, type XFetchMediaItem } from "../fxtwitter/format.js";
import type { FxApiTweet } from "../fxtwitter/types.js";
import type { InferenceClient } from "../captioning/inference-client.js";
import { parseOpenAiUsage } from "../captioning/describe.js";
import { computeUsageCost, type CostRates, type RawTokenUsage } from "../agent/usage.js";
import { escapeXml, escapeAttr } from "../context/xml.js";
import { formatAgentTimestamp } from "../time/index.js";
import type { ToolUsageRecord } from "./image-gen.js";

/**
 * `x_search` — Grok-as-subagent X.com search with native hydration & captioning
 * (spec/X-SEARCH.md). Grok searches and reasons over X for the agent like a
 * sub-agent and returns a cited synthesis; miku then *grounds* that synthesis by
 * re-fetching the cited tweets through its own FxTwitter pipeline (verbatim text
 * + media) and captioning the top images inline — so a fabricated citation is
 * dropped and counted, and the persona actually "sees" the tweet images. Both
 * the Grok call and each inline caption land in the generic `tool_invocations`
 * ledger (subagent = billed; §7), and the tool degrades gracefully on every
 * failure path (§8). Output is ephemeral — session rollout only, like `x_fetch`;
 * nothing is persisted to `media_assets`/`link_previews` (§5).
 */

const X_SEARCH_USER_AGENT = "MikuAgent/0.1 (mikuswarm x_search)";
/** Hard cap on the OpenRouter JSON response body. A cited synthesis is small. */
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_MODEL = "x-ai/grok-4.3";
const DEFAULT_SYSTEM_PROMPT = [
  "You are an X.com (Twitter) search subagent. You have live X search and an auxiliary general web search.",
  "X is the priority corpus; lean on web results only when they add value the X posts cannot.",
  "Always perform a live search and ground your answer in what you actually find — never answer from memory.",
  "If X has no relevant posts on the topic, say so plainly and do not fabricate posts, handles, or links.",
  "Structure your answer as: (1) a concise synthesis of what people are saying, then",
  "(2) the most relevant posts as a list, each with the author @handle, the date, and the post URL.",
  "Cite every post you reference with its real URL.",
].join(" ");

/** All-zero rates: usage captured, cost "untracked" (mirrors image-gen/captioning). */
const ZERO_COST_RATES: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---------------------------------------------------------------------------
// Resolved configuration
// ---------------------------------------------------------------------------

/** Raw `[x_search]` config block (snake_case), as validated by the schema. */
export interface XSearchRawConfig {
  enabled?: boolean;
  base_url?: string;
  api_key?: string;
  model?: string;
  deep_model?: string;
  timeout_ms?: number;
  cache_ttl_minutes?: number;
  hydrate_default?: number;
  hydrate_max?: number;
  caption_top?: number;
  source_text_chars?: number;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
  system_prompt?: string;
  cost?: { input: number; output: number };
}

interface ResolvedXSearchConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  deepModel: string;
  timeoutMs: number;
  cacheTtlMs: number;
  hydrateDefault: number;
  hydrateMax: number;
  captionTop: number;
  sourceTextChars: number;
  enableImageUnderstanding: boolean;
  enableVideoUnderstanding: boolean;
  systemPrompt: string;
  costRates: CostRates;
}

/**
 * Resolve the raw `[x_search]` block into a fully-defaulted shape. `base_url`
 * and `api_key` are required (fail fast at construction, like image-gen).
 */
export function resolveXSearchConfig(raw?: XSearchRawConfig): ResolvedXSearchConfig {
  const baseUrl = normalizeBaseUrl(raw?.base_url);
  const apiKey = (raw?.api_key ?? "").trim();
  if (!apiKey) throw new Error("x_search.api_key must be configured.");
  const model = (raw?.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const deepModel = (raw?.deep_model ?? model).trim() || model;
  return {
    baseUrl,
    apiKey,
    model,
    deepModel,
    timeoutMs: raw?.timeout_ms ?? 60_000,
    cacheTtlMs: Math.max(0, (raw?.cache_ttl_minutes ?? 10) * 60_000),
    hydrateDefault: raw?.hydrate_default ?? 5,
    hydrateMax: raw?.hydrate_max ?? 10,
    captionTop: raw?.caption_top ?? 4,
    sourceTextChars: raw?.source_text_chars ?? 600,
    enableImageUnderstanding: raw?.enable_image_understanding ?? true,
    enableVideoUnderstanding: raw?.enable_video_understanding ?? false,
    systemPrompt: (raw?.system_prompt ?? "").trim() || DEFAULT_SYSTEM_PROMPT,
    costRates: raw?.cost
      ? { input: raw.cost.input, output: raw.cost.output, cacheRead: 0, cacheWrite: 0 }
      : ZERO_COST_RATES,
  };
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error("x_search.base_url must be configured.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`x_search.base_url must be a valid URL, got "${trimmed}".`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("x_search.base_url must use http or https.");
  return trimmed.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Short-TTL Grok-result cache (§9)
// ---------------------------------------------------------------------------

/** The parsed, pre-hydration Grok result that the cache stores. */
export interface GrokResult {
  synthesis: string;
  /** Citation URLs in Grok's order, deduped. */
  citations: string[];
  usage: RawTokenUsage | null;
  model: string;
}

/**
 * Process-lifetime cache keyed on the normalized query+filters+model, holding the
 * expensive Grok synthesis only (hydration/captioning are cheap to redo and media
 * URLs expire — §9). One instance is shared across sessions (constructed in
 * app.ts) so a reactive and a proactive session hitting the same topic dampen to
 * one Grok call. `nowMs` is injected so tests need not stub `Date.now`.
 */
export class GrokResultCache {
  private readonly entries = new Map<string, { expiresAt: number; result: GrokResult }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, nowMs: number): GrokResult | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.result;
  }

  set(key: string, result: GrokResult, nowMs: number): void {
    if (this.ttlMs <= 0) return;
    this.entries.set(key, { expiresAt: nowMs + this.ttlMs, result });
  }
}

/** Normalize a cache key from the search inputs (whitespace-collapsed, sorted). */
export function buildCacheKey(input: {
  query: string;
  allowedHandles: string[];
  excludedHandles: string[];
  fromDate?: string;
  toDate?: string;
  model: string;
}): string {
  return JSON.stringify({
    q: input.query.trim().replace(/\s+/g, " ").toLowerCase(),
    a: [...input.allowedHandles].map((h) => h.toLowerCase()).sort(),
    x: [...input.excludedHandles].map((h) => h.toLowerCase()).sort(),
    f: input.fromDate ?? null,
    t: input.toDate ?? null,
    m: input.model,
  });
}

// ---------------------------------------------------------------------------
// Tool context + parameters
// ---------------------------------------------------------------------------

export interface XSearchToolContext {
  /** Raw `[x_search]` config block. */
  config: XSearchRawConfig;
  /** Shared FxTwitter client (hydration), same instance x_fetch uses. */
  fxTwitterClient: FxTwitterClient;
  /** Recognized X status base-domains (built-ins + extra_status_hosts). */
  statusHosts: readonly string[];
  /** Image caption client (the `media` tool's image path), or undefined to skip captioning. */
  imageCaptionClient?: InferenceClient;
  /** Shared fetch client for downloading citation media to caption. */
  fetchClient: FetchClient;
  /** Hard fetch ceiling for media downloads. */
  downloadSizeLimit: number;
  /** Optional http(s) proxy applied to the Grok POST. */
  httpProxyUrl?: string;
  /** Shared Grok-result cache (§9). */
  cache: GrokResultCache;
  /** Ambient agent session (ledger attribution). */
  agentSessionId?: string | null;
  /** Durable usage-ledger sink (§7); also feeds the in-memory cost lane. */
  recordToolUsage?: (record: ToolUsageRecord) => void;
  /** Clock injection for cache TTL + tookMs (defaults to Date.now). */
  now?: () => number;
}

interface XSearchParams {
  query: string;
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  effort?: "fast" | "deep";
  hydrate?: number;
  enable_video_understanding?: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createXSearchTool(context: XSearchToolContext): AgentTool {
  const config = resolveXSearchConfig(context.config);
  const dispatcher = buildProxyDispatcher(context.httpProxyUrl);
  const now = context.now ?? Date.now;

  return {
    name: "x_search",
    label: "X search",
    description:
      "Search X.com (Twitter) via Grok, which searches and reasons over X for you like a sub-agent. " +
      "Returns a cited synthesis plus the actual cited tweets (verbatim text + media), with the top images already " +
      "captioned. Grok can also pull in general web results when useful. Use this for DISCOVERY across X " +
      "(\"what are people saying about…\", \"find posts from @x about…\"); use `x_fetch` when you already have a " +
      "specific tweet URL.",
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "The research task / question in natural language. Grok reasons over this and searches X for you.",
      }),
      allowed_x_handles: Type.Optional(Type.Array(Type.String(), {
        maxItems: 10,
        description: "Restrict the X search to these handles (max 10, without @). Mutually exclusive with excluded_x_handles.",
      })),
      excluded_x_handles: Type.Optional(Type.Array(Type.String(), {
        maxItems: 10,
        description: "Exclude these handles from the X search (max 10, without @). Mutually exclusive with allowed_x_handles.",
      })),
      from_date: Type.Optional(Type.String({ description: "Earliest post date, YYYY-MM-DD." })),
      to_date: Type.Optional(Type.String({ description: "Latest post date, YYYY-MM-DD." })),
      effort: Type.Optional(Type.Unsafe<"fast" | "deep">({
        type: "string",
        enum: ["fast", "deep"],
        description: "Depth/latency knob: 'fast' (default, quick non-reasoning) or 'deep' (slower reasoning model).",
      })),
      hydrate: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: config.hydrateMax,
        description: `How many cited tweets to re-fetch verbatim via FxTwitter (default ${config.hydrateDefault}, cap ${config.hydrateMax}). 0 = synthesis + raw URLs only.`,
      })),
      enable_video_understanding: Type.Optional(Type.Boolean({
        description: "Let Grok analyze cited video frames (default from config; off by default — slower/costlier).",
      })),
    }),
    execute: async (toolCallId, rawParams, agentSignal) => {
      const params = rawParams as XSearchParams;
      const query = params.query?.trim();
      if (!query) return textError("x_search requires a non-empty 'query'.");

      const allowedHandles = sanitizeHandles(params.allowed_x_handles);
      const excludedHandles = sanitizeHandles(params.excluded_x_handles);
      if (allowedHandles.length > 0 && excludedHandles.length > 0) {
        return textError("allowed_x_handles and excluded_x_handles are mutually exclusive — pass at most one.");
      }
      if (allowedHandles.length > 10) return textError("allowed_x_handles allows at most 10 handles.");
      if (excludedHandles.length > 10) return textError("excluded_x_handles allows at most 10 handles.");
      for (const d of [params.from_date, params.to_date]) {
        if (d !== undefined && !DATE_PATTERN.test(d)) {
          return textError(`Dates must be YYYY-MM-DD, got "${d}".`);
        }
      }

      const effort: "fast" | "deep" = params.effort ?? "fast";
      const model = effort === "deep" ? config.deepModel : config.model;
      const hydrate = Math.min(params.hydrate ?? config.hydrateDefault, config.hydrateMax);
      const enableVideo = params.enable_video_understanding ?? config.enableVideoUnderstanding;

      const startMs = now();
      const cacheKey = buildCacheKey({
        query,
        allowedHandles,
        excludedHandles,
        fromDate: params.from_date,
        toDate: params.to_date,
        model,
      });

      // 1) Grok call (cache → live). A cache hit makes no billable call, so it
      //    records no Grok ledger row; hydration/captioning still run fresh.
      let grok = context.cache.get(cacheKey, startMs);
      let cached = grok !== undefined;
      if (!grok) {
        const body = buildGrokRequestBody({
          model,
          query,
          systemPrompt: config.systemPrompt,
          allowedHandles,
          excludedHandles,
          fromDate: params.from_date,
          toDate: params.to_date,
          enableImageUnderstanding: config.enableImageUnderstanding,
          enableVideoUnderstanding: enableVideo,
        });
        let live: GrokResult | { error: string };
        try {
          live = await postGrok({
            url: `${config.baseUrl}/chat/completions`,
            apiKey: config.apiKey,
            body,
            dispatcher,
            timeoutMs: config.timeoutMs,
            signal: agentSignal,
          });
        } catch (error) {
          return textError(`X search failed (model ${model}): ${errMessage(error)}`);
        }
        if ("error" in live) {
          // Graceful: no throw, just surface what went wrong (§8).
          return textError(`X search failed (model ${model}): ${live.error}`);
        }
        grok = live;
        cached = false;
        context.cache.set(cacheKey, grok, now());

        // Grok-call ledger row (§7): one billable subagent call. Usage may be
        // null (gateway omitted it) — then nothing is recorded. Never throws.
        recordGrokUsage(context, { toolCallId, model, baseUrl: config.baseUrl, usage: grok.usage, costRates: config.costRates });
      }

      // 2) Hydrate citations via FxTwitter (§5). Drop+count unreachable/non-X
      //    citations as an anti-hallucination signal.
      const sources: HydratedSource[] = [];
      let dropped = 0;
      if (hydrate > 0) {
        // Citations that don't parse as an x.com status at all (a non-X link, or a
        // fabricated/garbled URL) are dropped+counted — an anti-hallucination
        // signal (§5). Duplicate citations of the SAME tweet collapse silently
        // (they resolve to one hydrated source, not a drop); refs beyond the
        // `hydrate` cap are simply not fetched, also not a drop.
        const parsableCount = grok.citations.filter((c) => parseXStatusUrl(c, context.statusHosts)).length;
        dropped += grok.citations.length - parsableCount;
        const refs = dedupeStatusRefs(grok.citations, context.statusHosts);
        for (const ref of refs.slice(0, hydrate)) {
          try {
            const tweet = await context.fxTwitterClient.fetchStatus(ref.statusId, ref.screenName);
            sources.push(buildSource(ref.requestedUrl, tweet, config.sourceTextChars));
          } catch {
            dropped += 1; // unreachable / fabricated → dropped, counted (§5)
          }
        }
      }

      // 3) Caption the first `caption_top` images across the hydrated tweets,
      //    in order (§5). Inline-lane captioning, ephemeral (no media_assets).
      let captionedCount = 0;
      if (config.captionTop > 0 && context.imageCaptionClient && sources.length > 0) {
        captionedCount = await captionTopImages(context, sources, config.captionTop, { toolCallId });
      }

      // 4) Assemble output (§3).
      const tookMs = now() - startMs;
      const text = renderOutput({
        synthesis: grok.synthesis,
        sources,
        citationCount: grok.citations.length,
        hydrated: sources.length,
        dropped,
        captionedCount,
        hydrate,
        cached,
      });

      return {
        content: [{ type: "text" as const, text }],
        details: {
          query,
          model,
          effort,
          cached,
          tookMs,
          droppedCitations: dropped,
          captionedCount,
          citations: grok.citations.map((url) => {
            const src = sources.find((s) => s.requestedUrl === url || s.canonicalUrl === url);
            return {
              url,
              handle: src?.handle ?? null,
              date: src?.dateMs ? formatAgentTimestamp(src.dateMs) : null,
              hydrated: Boolean(src),
              text: src?.text,
              media: src?.media.map((m) => ({ kind: m.kind, url: m.url, caption: m.caption ?? null })),
            };
          }),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Grok request building
// ---------------------------------------------------------------------------

/**
 * Build the OpenRouter chat-completions body (§2). `x_search_filter` is emitted
 * only when it carries a field; the `web` plugin leaves Grok's web_search on
 * alongside x_search (§2 corpus note). `allowed`/`excluded` handles are mutually
 * exclusive (validated upstream) — at most one is set.
 */
export function buildGrokRequestBody(input: {
  model: string;
  query: string;
  systemPrompt: string;
  allowedHandles: string[];
  excludedHandles: string[];
  fromDate?: string;
  toDate?: string;
  enableImageUnderstanding: boolean;
  enableVideoUnderstanding: boolean;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    enable_image_understanding: input.enableImageUnderstanding,
    enable_video_understanding: input.enableVideoUnderstanding,
  };
  if (input.allowedHandles.length > 0) filter.allowed_x_handles = input.allowedHandles;
  if (input.excludedHandles.length > 0) filter.excluded_x_handles = input.excludedHandles;
  if (input.fromDate) filter.from_date = input.fromDate;
  if (input.toDate) filter.to_date = input.toDate;

  return {
    model: input.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.query },
    ],
    plugins: [{ id: "web" }],
    x_search_filter: filter,
  };
}

// ---------------------------------------------------------------------------
// Grok HTTP + response parsing
// ---------------------------------------------------------------------------

/** Minimal shape of the OpenRouter chat-completions response we read from. */
interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      annotations?: unknown[];
    };
  }>;
  citations?: unknown[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

async function postGrok(input: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  dispatcher: Dispatcher | undefined;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<GrokResult | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  // Compose the agent's abort signal with the wall-clock timeout so a cancelled
  // turn or a slow reasoning search both abort the request promptly.
  const onAgentAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onAgentAbort, { once: true });
  }
  let response: Response;
  try {
    // Routes through the shared egress chokepoint (per-host limiter + 429/503
    // backoff). The OpenRouter host is trusted operator infra, so the SSRF
    // address guard never trips on it; the per-host limiter is the relevant part.
    response = await guardedFetch(input.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": X_SEARCH_USER_AGENT,
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(input.body),
      dispatcher: input.dispatcher,
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      return { error: input.signal?.aborted ? "request aborted" : `timed out after ${input.timeoutMs}ms` };
    }
    return { error: errMessage(error) };
  } finally {
    clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener("abort", onAgentAbort);
  }

  if (!response.ok) {
    const snippet = await safeReadText(response);
    return { error: `HTTP ${response.status}${snippet ? ` (${snippet})` : ""}` };
  }
  let parsed: OpenRouterResponse;
  try {
    parsed = (await readJsonCapped(response, controller)) as OpenRouterResponse;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      return { error: `timed out after ${input.timeoutMs}ms` };
    }
    return { error: `unreadable response: ${errMessage(error)}` };
  }

  const synthesis = extractSynthesis(parsed);
  const citations = extractCitations(parsed);
  return { synthesis, citations, usage: parseOpenAiUsage(parsed.usage), model: input.body.model as string };
}

/** Flatten the assistant message content into plain text. */
export function extractSynthesis(payload: OpenRouterResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => typeof b?.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
  }
  return "";
}

/**
 * Extract citation URLs, tolerating both response shapes (§2): message
 * `annotations` of type `url_citation` (nested `url_citation.url` or a flat
 * `url`) and/or a top-level `citations` array (strings or `{url}`). Deduped,
 * order-preserving. Returns [] when there are no citations.
 */
export function extractCitations(payload: OpenRouterResponse): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  const annotations = payload.choices?.[0]?.message?.annotations;
  if (Array.isArray(annotations)) {
    for (const a of annotations) {
      if (!a || typeof a !== "object") continue;
      const ann = a as { type?: string; url?: unknown; url_citation?: { url?: unknown } };
      if (ann.type && ann.type !== "url_citation") continue;
      push(ann.url_citation?.url ?? ann.url);
    }
  }

  if (Array.isArray(payload.citations)) {
    for (const c of payload.citations) {
      if (typeof c === "string") push(c);
      else if (c && typeof c === "object") push((c as { url?: unknown }).url);
    }
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Hydration (§5)
// ---------------------------------------------------------------------------

interface SourceMedia {
  kind: XFetchMediaItem["kind"];
  url: string;
  width?: number;
  height?: number;
  caption?: string;
}

interface HydratedSource {
  /** The citation URL Grok emitted (for matching back into details). */
  requestedUrl: string;
  canonicalUrl: string;
  handle?: string;
  dateMs?: number;
  /** Verbatim, untrusted tweet-authored text (windowed). */
  text: string;
  media: SourceMedia[];
}

interface ParsedCitationRef {
  statusId: string;
  screenName?: string;
  canonicalUrl: string;
  requestedUrl: string;
}

/** Keep only parsable x.com status citations, deduped by status id, in order. */
function dedupeStatusRefs(citations: string[], statusHosts: readonly string[]): ParsedCitationRef[] {
  const refs: ParsedCitationRef[] = [];
  const seen = new Set<string>();
  for (const url of citations) {
    const parsed = parseXStatusUrl(url, statusHosts);
    if (!parsed) continue;
    if (seen.has(parsed.statusId)) continue;
    seen.add(parsed.statusId);
    refs.push({
      statusId: parsed.statusId,
      screenName: parsed.screenName,
      canonicalUrl: parsed.canonicalUrl,
      requestedUrl: url,
    });
  }
  return refs;
}

function buildSource(requestedUrl: string, tweet: FxApiTweet, sourceTextChars: number): HydratedSource {
  const doc = buildTweetDocument(tweet, 32_768);
  const handle = tweet.author?.screen_name?.toLowerCase();
  const canonicalUrl = tweet.url ?? requestedUrl;
  return {
    requestedUrl,
    canonicalUrl,
    handle,
    dateMs: typeof tweet.created_timestamp === "number" ? tweet.created_timestamp * 1000 : undefined,
    text: tweetVerbatim(tweet, sourceTextChars),
    media: doc.media.map((m) => ({ kind: m.kind, url: m.url, width: m.width, height: m.height })),
  };
}

/** Assemble the untrusted, tweet-authored body (text + community note + quote). */
function tweetVerbatim(tweet: FxApiTweet, maxChars: number): string {
  const parts: string[] = [];
  if (tweet.text) parts.push(tweet.text);
  if (tweet.community_note) parts.push(`[Community note] ${tweet.community_note}`);
  if (tweet.quote?.text) {
    const qh = tweet.quote.author?.screen_name ? `@${tweet.quote.author.screen_name}` : "a quoted post";
    parts.push(`↳ Quoting ${qh}: ${tweet.quote.text}`);
  }
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return text || "(no text)";
}

// ---------------------------------------------------------------------------
// Captioning (§5) — inline tool lane, ephemeral
// ---------------------------------------------------------------------------

/**
 * Caption the first `cap` photos across the hydrated sources, in order, inlining
 * the caption onto each media item. Per-item failures degrade silently (the
 * media is still listed). Each caption is recorded in the `tool_invocations`
 * ledger (§7). Returns the number of images actually captioned.
 */
async function captionTopImages(
  context: XSearchToolContext,
  sources: HydratedSource[],
  cap: number,
  meta: { toolCallId: string | null },
): Promise<number> {
  const client = context.imageCaptionClient;
  if (!client) return 0;
  let captioned = 0;
  for (const source of sources) {
    for (const item of source.media) {
      if (captioned >= cap) return captioned;
      if (item.kind !== "photo") continue;
      const caption = await captionOneImage(context, client, item.url, meta);
      if (caption) {
        item.caption = caption;
        captioned += 1;
      }
    }
  }
  return captioned;
}

async function captionOneImage(
  context: XSearchToolContext,
  client: InferenceClient,
  url: string,
  meta: { toolCallId: string | null },
): Promise<string | undefined> {
  let fetched: Awaited<ReturnType<FetchClient["fetch"]>> | undefined;
  try {
    fetched = await context.fetchClient.fetch(url, { maxBytes: context.downloadSizeLimit });
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) return undefined;
    const mimeType = fetched.contentType?.split(";")[0]?.trim() || "image/jpeg";
    // Exact path the `media` tool uses (context:"tool"); the image client applies
    // its own conditioning + scheduler admission internally.
    const result = await client.caption({ filePath: fetched.path, mimeType, filename: url, context: "tool" });
    // Caption ledger row (§7): the InferenceClient already computed usage + cost.
    if (result.usage && context.recordToolUsage) {
      const statusId = url.match(/\/(\d+)(?:[/?#]|$)/)?.[1] ?? "?";
      try {
        context.recordToolUsage({
          agentSessionId: context.agentSessionId ?? null,
          toolName: "x_search",
          toolCallId: meta.toolCallId,
          modelId: result.model,
          provider: "openrouter",
          usage: result.usage,
          cost: result.cost ?? 0,
          ref: `caption:${statusId}`,
        });
      } catch {
        /* ledger is observability — never fail the tool */
      }
    }
    return result.caption;
  } catch {
    return undefined; // per-item degrade (§8)
  } finally {
    if (fetched) await unlink(fetched.path).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Usage ledger (§7)
// ---------------------------------------------------------------------------

function recordGrokUsage(
  context: XSearchToolContext,
  input: { toolCallId: string | null; model: string; baseUrl: string; usage: RawTokenUsage | null; costRates: CostRates },
): void {
  if (!input.usage || !context.recordToolUsage) return;
  const cost = computeUsageCost(input.costRates, input.usage).total;
  try {
    context.recordToolUsage({
      agentSessionId: context.agentSessionId ?? null,
      toolName: "x_search",
      toolCallId: input.toolCallId,
      modelId: input.model,
      provider: "openrouter",
      usage: input.usage,
      cost,
      ref: "grok",
    });
  } catch {
    /* ledger is observability — never fail the tool */
  }
}

// ---------------------------------------------------------------------------
// Output rendering (§3 / §6)
// ---------------------------------------------------------------------------

function renderOutput(input: {
  synthesis: string;
  sources: HydratedSource[];
  citationCount: number;
  hydrated: number;
  dropped: number;
  captionedCount: number;
  hydrate: number;
  cached: boolean;
}): string {
  const blocks: string[] = [];

  // Synthesis (untrusted — Grok summarised hostile tweet text).
  const synthesis = input.synthesis || "(Grok returned no synthesis.)";
  blocks.push(
    `<untrusted_x_search source="grok-synthesis">\n${escapeXml(synthesis)}\n</untrusted_x_search>`,
  );

  // Sources.
  if (input.sources.length > 0) {
    const sourceBlocks: string[] = ["## Sources"];
    let uncaptionedMedia = false;
    input.sources.forEach((source, i) => {
      const handle = source.handle ? `@${source.handle}` : "(unknown)";
      const date = source.dateMs ? formatAgentTimestamp(source.dateMs) : "(no date)";
      sourceBlocks.push("", `[${i + 1}] ${handle} · ${date} · ${source.canonicalUrl}`);
      sourceBlocks.push(
        `<untrusted_x_search source="tweet" handle="${escapeAttr(source.handle ?? "")}" url="${escapeAttr(source.canonicalUrl)}">`,
        escapeXml(source.text),
        `</untrusted_x_search>`,
      );
      if (source.media.length > 0) {
        sourceBlocks.push("Media:");
        for (const m of source.media) {
          const dims = m.width && m.height ? ` ${m.width}x${m.height}` : "";
          if (m.caption) {
            // Caption WE generated — trusted, not wrapped.
            sourceBlocks.push(`  - ${m.kind}${dims} — ${m.caption}`);
          } else {
            uncaptionedMedia = true;
            sourceBlocks.push(`  - ${m.kind}${dims} — ${m.url}`);
          }
        }
      }
    });
    if (uncaptionedMedia) {
      sourceBlocks.push(
        "",
        "To caption or inspect the uncaptioned media above, call the `media` tool with those URLs (up to 20 at once).",
      );
    }
    blocks.push(sourceBlocks.join("\n"));
  }

  // Coverage line (trusted; surfaces grounding honestly — §3).
  blocks.push(coverageLine(input));

  return blocks.join("\n\n");
}

function coverageLine(input: {
  citationCount: number;
  hydrated: number;
  dropped: number;
  captionedCount: number;
  hydrate: number;
  cached: boolean;
}): string {
  const parts: string[] = [`Grok cited ${input.citationCount} ${plural(input.citationCount, "post")}`];
  if (input.hydrate === 0) {
    parts.push("hydration disabled (hydrate=0)");
  } else {
    parts.push(`hydrated ${input.hydrated}`);
    if (input.dropped > 0) {
      parts.push(`${input.dropped} ${plural(input.dropped, "citation")} unreachable (dropped)`);
    }
    parts.push(`captioned ${input.captionedCount} ${plural(input.captionedCount, "image")}`);
  }
  let line = parts.join("; ") + ".";
  if (input.cached) line += " (Grok synthesis served from cache.)";
  return line;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sanitizeHandles(handles: string[] | undefined): string[] {
  if (!handles) return [];
  return handles
    .map((h) => h.trim().replace(/^@+/, ""))
    .filter((h) => h.length > 0);
}

async function readJsonCapped(response: Response, controller: AbortController): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`response too large: declared content-length ${declared} > ${RESPONSE_MAX_BYTES} bytes`);
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
      throw new Error(`response exceeded ${RESPONSE_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 300) : "";
  } catch {
    return "";
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
