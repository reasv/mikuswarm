import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ExaClient } from "../exa/client.js";
import { ExaContentStore, type ExaOwner } from "../exa/content-store.js";
import { exaRetrievalCost, type ExaUsageRecord } from "../exa/accounting.js";
import { EXA_CATEGORIES, type ExaSearchMode, type ExaCategory, type ExaSearchRequest, type ExaRetrievalResponse } from "../exa/types.js";
import { ExaError } from "../exa/errors.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
export interface ExaRetrievalContext {
  client: ExaClient; store: ExaContentStore; owner: ExaOwner; sessionId: string | null; visibility?: ChannelVisibilityResolver;
  checkBudget?: (tool: string, service: string) => string | undefined;
  recordUsage?: (record: ExaUsageRecord) => void;
  fallbackNames?: string[]; backgroundFallback?: AgentTool;
}
function bad(message: string): never { throw new Error(`${message} Load web-research for parameter guidance.`); }
function validateSchema(schema: Record<string, unknown>, search: boolean) {
  if (Buffer.byteLength(JSON.stringify(schema)) > 16000) bad("output_schema exceeds 16KB.");
  let properties = 0;
  function walk(value: unknown, depth: number, objectDepth = 0) {
    if (depth > 30) bad("output_schema nesting exceeds the supported limit.");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1, objectDepth); return; }
    const object = value as Record<string, unknown>;
    if (object.$ref !== undefined || object.$dynamicRef !== undefined) bad("output_schema references are unsupported; inline the schema.");
    if (object.type === "array" && (!object.items || !Number.isInteger(object.maxItems) || Number(object.maxItems) > 100 || Number(object.maxItems) < 1)) bad("Every output_schema array requires items and maxItems between 1 and 100.");
    const nextDepth = objectDepth + (object.type === "object" || object.properties ? 1 : 0);
    if (nextDepth > (search ? 2 : 12)) bad("output_schema object nesting exceeds the supported limit.");
    if (object.properties && typeof object.properties === "object") properties += Object.keys(object.properties).length;
    for (const child of Object.values(object)) if (child && typeof child === "object") walk(child, depth + 1, nextDepth);
  }
  walk(schema, 0); if (search && (schema.type !== "object" || properties > 10)) bad("Search output_schema requires an object root and at most 10 total properties.");
}
export { validateSchema as validateExaOutputSchema };
const textResult = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
export function createExaRetrievalTools(ctx: ExaRetrievalContext): AgentTool[] {
  const cfg = ctx.client.config;
  const error = (cause: unknown): never => {
    if (!(cause instanceof ExaError)) throw cause;
    const permitted = ctx.fallbackNames?.filter((name) => name === (cause.scope === "contents" ? "web_fetch" : "web_search")) ?? [];
    const fallback = permitted.length ? ` Use tool_search to load ${permitted.join(" or ")} for basic fallback.` : "";
    throw new ExaError(cause.code, `${cause.message}${cause.code === "invalid_request" ? " Correct request arguments; load web-research for permitted filters." : ""}${cause.retryAt ? ` Retry after ${new Date(cause.retryAt).toISOString()}.` : ""}${["exa_unavailable", "rate_limited", "transport_failed", "upstream_failed", "auth_failed", "credit_exhausted", "timeout"].includes(cause.code) ? fallback : ""}`, cause.scope, cause.status, cause.retryAt, cause.requestId, cause.submissionUncertain, cause.reportedCostUsd);
  };
  const budget = (tool: string, service: string) => { const reason = ctx.checkBudget?.(tool, service); if (reason) throw new Error(reason); };
  const record = (response: ExaRetrievalResponse, tool: string, call: string, started: number, kind: "search" | "contents", count: number, mode?: ExaSearchMode) => {
    const cost = exaRetrievalCost(response.costDollars, kind, count, mode);
    const metadata = { requestId: response.requestId, latencyMs: Date.now() - started, costProvenance: cost.provenance, estimateVersion: "estimateVersion" in cost ? cost.estimateVersion : undefined, mode, reportedCost: response.costDollars };
    ctx.recordUsage?.({ agentSessionId: ctx.sessionId, toolName: tool, toolCallId: call, modelId: `exa/${kind}`, provider: "exa", cost: cost.dollars, metadata }); return { costUsd: cost.dollars, ...metadata };
  };
  function renderSearch(response: ExaRetrievalResponse, fullText: boolean) {
    return response.results.map((source, i) => {
      const body = source.highlights?.join("\n") ?? source.text ?? "";
      const limit = fullText ? cfg.fetch.display_chars : cfg.search.highlight_chars;
      const contentId = fullText && body ? ctx.store.put({ owner: ctx.owner, url: source.url, title: source.title, text: body.slice(0, cfg.fetch.extraction_chars), extractionTruncated: body.length >= cfg.fetch.extraction_chars }) : undefined;
      return `${i + 1}. ${source.title ?? source.url}\n${source.url}${source.publishedDate ? `\nPublished: ${source.publishedDate}` : ""}\n${body.slice(0, limit)}${body.length > limit ? contentId ? `\n[more: exa_fetch(content_id: "${contentId}", offset: ${limit})]` : "\n[excerpt truncated; call exa_fetch with this URL for more]" : ""}`;
    }).join("\n\n") || "No search results.";
  }
  const searchTool = (advanced: boolean): AgentTool => ({
    name: advanced ? "exa_search_advanced" : "exa_search", label: advanced ? "Exa advanced search" : "Exa search",
    description: advanced ? "Search with explicit constraints, deeper retrieval or structured extraction. Publication dates and page freshness are different controls." : "Search the web for sources and excerpts. Use exa_fetch to inspect a source; load web-research for filters, deeper search, structured extraction or X coverage.",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 20000 }), num_results: Type.Optional(Type.Integer({ minimum: 1, maximum: cfg.search.max_results })), ...(advanced ? {
      mode: Type.Optional(Type.Union(cfg.search.allowed_modes.map((mode) => Type.Literal(mode)))),
      include_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 100 })), exclude_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 100 })),
      start_published_date: Type.Optional(Type.String({ description: "Hard publication-window start, ISO 8601; excludes undated pages." })), end_published_date: Type.Optional(Type.String()),
      category: Type.Optional(Type.Union(EXA_CATEGORIES.map((category) => Type.Literal(category)))), country: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2}$" })),
      content_mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("highlights")])), max_age_hours: Type.Optional(Type.Integer({ minimum: -1, description: "Extracted page cache age: 0 live crawl, -1 cache only; not publication recency." })),
      output_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())), instructions: Type.Optional(Type.String({ maxLength: 10000 })),
    } : {}) }),
    execute: async (call, params, signal) => {
      const args = params as { query: string; num_results?: number; mode?: ExaSearchMode; include_domains?: string[]; exclude_domains?: string[]; start_published_date?: string; end_published_date?: string; category?: ExaCategory; country?: string; content_mode?: string; max_age_hours?: number; output_schema?: Record<string, unknown>; instructions?: string };
      if (!args.query.trim()) bad("query must not be blank.");
      for (const date of [args.start_published_date, args.end_published_date]) if (date && (!/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(Date.parse(date)))) bad("Publication dates must be ISO 8601 dates.");
      if (args.start_published_date && args.end_published_date && Date.parse(args.start_published_date) > Date.parse(args.end_published_date)) bad("Publication start must precede end.");
      if (["company", "people"].includes(args.category ?? "") && (args.start_published_date || args.end_published_date || args.exclude_domains?.length)) bad("company and people categories do not support publication-date or exclude_domains filters.");
      if (args.output_schema) validateSchema(args.output_schema, true);
      const request: ExaSearchRequest = { query: args.query, type: args.mode ?? "auto", numResults: args.num_results ?? cfg.search.default_results,
        contents: args.content_mode === "text" ? { text: { maxCharacters: cfg.fetch.extraction_chars } } : { highlights: { maxCharacters: cfg.search.highlight_chars } } };
      if (args.max_age_hours !== undefined) { request.contents!.maxAgeHours = args.max_age_hours; request.contents!.livecrawlTimeout = Math.min(90000, cfg.request_timeout_ms); }
      Object.assign(request, { includeDomains: args.include_domains, excludeDomains: args.exclude_domains, startPublishedDate: args.start_published_date, endPublishedDate: args.end_published_date, category: args.category, userLocation: args.country?.toUpperCase(), outputSchema: args.output_schema, systemPrompt: args.instructions });
      budget(advanced ? "exa_search_advanced" : "exa_search", "exa/search"); const started = Date.now();
      try { const response = await ctx.client.search(request, signal, advanced); const usage = record(response, advanced ? "exa_search_advanced" : "exa_search", call, started, "search", request.numResults!, request.type);
        return textResult(`${renderSearch(response, args.content_mode === "text")}${response.output ? `\n\nStructured output and grounding:\n${JSON.stringify(response.output)}` : ""}`, { ...response, usage });
      } catch (cause) {
        if (cause instanceof ExaError && cause.code === "invalid_response" && cause.status === 200) record({ results: [], requestId: cause.requestId, costDollars: cause.reportedCostUsd === undefined ? undefined : { total: cause.reportedCostUsd } }, advanced ? "exa_search_advanced" : "exa_search", call, started, "search", request.numResults!, request.type);
        return error(cause);
      }
    },
  });
  const fetch: AgentTool = {
    name: "exa_fetch", label: "Exa fetch", description: "Read public web pages, or more stored content without refetching. Returns each URL outcome and content handles. X posts need x_fetch; interactive pages need browser.",
    parameters: Type.Object({ urls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: cfg.fetch.max_urls })), content_id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: cfg.fetch.max_extraction_chars })), mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("highlights")])), max_age_hours: Type.Optional(Type.Integer({ minimum: -1 })) }),
    execute: async (call, params, signal) => {
      const args = params as { urls?: string[]; content_id?: string; offset?: number; max_chars?: number; mode?: "text" | "highlights"; max_age_hours?: number };
      if (!!args.urls === !!args.content_id) bad("Set exactly one of urls or content_id.");
      const max = args.max_chars ?? cfg.fetch.display_chars;
      if (args.content_id) {
        if (args.mode || args.max_age_hours !== undefined) bad("mode and max_age_hours apply only to new URL fetching.");
        const content = ctx.store.get(args.content_id, ctx.owner, ctx.visibility); const offset = args.offset ?? 0;
        if (offset > content.text.length) bad(`offset exceeds stored length ${content.text.length}.`);
        return textResult(content.text.slice(offset, offset + max) + (offset + max < content.text.length ? `\n[more: exa_fetch(content_id: "${content.id}", offset: ${offset + max})]` : ""), { url: content.url, contentId: content.id, offset, totalChars: content.text.length, extractionTruncated: content.extractionTruncated, cached: true });
      }
      if (args.offset !== undefined) bad("offset requires content_id.");
      const urls = args.urls!.map((value) => { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) bad("Use HTTP URLs without credentials."); return url.toString(); });
      budget("exa_fetch", "exa/contents"); const started = Date.now(); const cap = Math.max(cfg.fetch.extraction_chars, max);
      try {
        const response = await ctx.client.contents({ urls, ...(args.mode === "highlights" ? { highlights: { maxCharacters: cap } } : { text: { maxCharacters: cap } }), ...(args.max_age_hours !== undefined ? { maxAgeHours: args.max_age_hours, livecrawlTimeout: Math.min(90000, cfg.request_timeout_ms) } : {}) }, signal);
        const usage = record(response, "exa_fetch", call, started, "contents", urls.length);
        const outcomes = urls.map((url, index) => {
          const status = response.statuses?.find((s) => s.id === url) ?? (response.statuses?.length === urls.length ? response.statuses[index] : undefined);
          const result = response.results.find((s) => s.url === url || s.id === url) ?? (status?.status === "success" ? response.results.find((s) => s.url === status.id || s.id === status.id) : undefined);
          const body = result ? (args.mode === "highlights" ? result.highlights?.join("\n") : result.text) : undefined;
          if (!result || body === undefined || status?.status === "error") return { url, status: "error", error: status?.error ?? "No extracted content returned." };
          const text = body.slice(0, cap); const contentId = ctx.store.put({ owner: ctx.owner, url: result.url, title: result.title, text, extractionTruncated: body.length >= cap });
          return { url, resolvedUrl: result.url, title: result.title, publishedDate: result.publishedDate, status: "success", contentId, text: text.slice(0, max), totalChars: text.length, displayTruncated: text.length > max, extractionTruncated: body.length >= cap };
        });
        return textResult(outcomes.map((o) => o.status === "error" ? `${o.url}\n[fetch failed: ${JSON.stringify(o.error)}]` : `${o.title ?? o.url}\n${o.resolvedUrl}\n${o.text}${o.displayTruncated && o.contentId ? `\n[more: exa_fetch(content_id: "${o.contentId}", offset: ${max})]` : o.displayTruncated ? "\n[content could not be cached; refetch this URL with a larger max_chars]" : ""}`).join("\n\n"), { outcomes, usage });
      } catch (cause) {
        if (cause instanceof ExaError && cause.code === "invalid_response" && cause.status === 200) record({ results: [], requestId: cause.requestId, costDollars: cause.reportedCostUsd === undefined ? undefined : { total: cause.reportedCostUsd } }, "exa_fetch", call, started, "contents", urls.length);
        if (ctx.backgroundFallback && cause instanceof ExaError && ["exa_unavailable", "auth_failed", "credit_exhausted", "rate_limited", "transport_failed", "upstream_failed", "timeout"].includes(cause.code) && args.max_age_hours === undefined && args.mode !== "highlights") {
          const results = []; for (const url of urls) { try { results.push(await ctx.backgroundFallback.execute(call, { url, max_chars: max }, signal)); } catch (err) { results.push(textResult(`[fetch failed: ${String(err)}]`, {})); } }
          return textResult(`[Fallback provider: direct web_fetch; Exa unavailable]\n${results.flatMap((r) => r.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n\n")}`, { fallbackProvider: "web_fetch", urls });
        }
        return error(cause);
      }
    },
  };
  return [...(cfg.search.enabled ? [searchTool(false), searchTool(true)] : []), ...(cfg.fetch.enabled ? [fetch] : [])];
}
