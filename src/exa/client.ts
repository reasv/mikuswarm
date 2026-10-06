import { guardedFetch, type GuardedFetchOptions } from "../tools/ssrf.js";
import type { ExaConfig } from "./config.js";
import { ExaError } from "./errors.js";
import { ExaHealth } from "./health.js";
import { ExaPacer } from "./pacer.js";
import { EXA_EFFORTS } from "./types.js";
import type { ExaContentsRequest, ExaRetrievalResponse, ExaRun, ExaResearchRequest, ExaScope, ExaSearchRequest } from "./types.js";
export type ExaTransport = (url: string, options: GuardedFetchOptions) => Promise<Response>;
const ORIGIN = "https://api.exa.ai";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validateCost(value: Record<string, unknown>): boolean {
  return value.costDollars === undefined || (object(value.costDollars) && typeof value.costDollars.total === "number" && Number.isFinite(value.costDollars.total) && value.costDollars.total >= 0);
}
function retrieval(value: unknown): value is ExaRetrievalResponse {
  return object(value) && Array.isArray(value.results) && value.results.every((item) => object(item) && typeof item.url === "string" && ["text", "title", "author", "publishedDate", "id"].every((key) => item[key] === undefined || (["title", "author", "publishedDate"].includes(key) && item[key] === null) || typeof item[key] === "string") && (item.highlights === undefined || (Array.isArray(item.highlights) && item.highlights.every((h) => typeof h === "string")))) && validateCost(value) && (value.statuses === undefined || (Array.isArray(value.statuses) && value.statuses.every((s) => object(s) && typeof s.id === "string" && typeof s.status === "string")));
}
function run(value: unknown): value is ExaRun {
  return object(value) && typeof value.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value.id) && ["queued", "running", "completed", "failed", "cancelled"].includes(String(value.status)) && validateCost(value) && (value.output === undefined || (object(value.output) && (value.output.text === undefined || typeof value.output.text === "string")));
}
/** One app-scoped API client. One attempt per request; create is never retried. */
export class ExaClient {
  readonly health: ExaHealth;
  private readonly pacer: ExaPacer;
  constructor(readonly config: ExaConfig, private readonly transport: ExaTransport = guardedFetch, health?: ExaHealth,
    private readonly now: () => number = Date.now, private readonly dispatcher?: unknown) {
    this.health = health ?? new ExaHealth(now); this.pacer = new ExaPacer(config.max_in_flight, 1000 / config.requests_per_second);
  }
  search(request: ExaSearchRequest, signal?: AbortSignal, advanced = false) {
    if (!request.query.trim() || request.query.length > 20000 || (request.numResults !== undefined && (!Number.isInteger(request.numResults) || request.numResults < 1 || request.numResults > this.config.search.max_results)) || (request.type !== undefined && !this.config.search.allowed_modes.includes(request.type))) throw new ExaError("invalid_request", "Search requires a nonblank query, permitted mode and bounded integer result count.", "search");
    return this.request("search", "/search", "POST", request, retrieval, signal, advanced ? this.config.search.advanced_timeout_ms : undefined); }
  contents(request: ExaContentsRequest, signal?: AbortSignal) {
    if (!request.urls.length || request.urls.length > this.config.fetch.max_urls || request.urls.some((url) => { try { const parsed = new URL(url); return !["http:", "https:"].includes(parsed.protocol) || !!parsed.username || !!parsed.password; } catch { return true; } })) throw new ExaError("invalid_request", "Contents requires permitted public HTTP URLs within max_urls.", "contents");
    return this.request("contents", "/contents", "POST", request, retrieval, signal); }
  createRun(request: ExaResearchRequest, signal?: AbortSignal) {
    if (!request.query.trim() || request.query.length > 20000 || !EXA_EFFORTS.includes(request.effort) || EXA_EFFORTS.indexOf(request.effort) > EXA_EFFORTS.indexOf(this.config.research.max_effort) || (request.dataSources && (request.dataSources.length > 5 || request.dataSources.some((source) => !this.config.research.allowed_data_sources.includes(source.provider))))) throw new ExaError("invalid_request", "Research requires a nonblank bounded query, permitted fixed effort and allowlisted data sources.", "research-create");
    return this.request("research-create", "/agent/runs", "POST", request, run, signal); }
  getRun(id: string, signal?: AbortSignal) { return this.request("research-collection", `/agent/runs/${this.runId(id)}`, "GET", undefined, run, signal); }
  cancelRun(id: string, signal?: AbortSignal) { return this.request("research-collection", `/agent/runs/${this.runId(id)}/cancel`, "POST", {}, run, signal); }
  private runId(id: string): string { if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new ExaError("invalid_request", "Invalid research run identifier.", "research-collection"); return encodeURIComponent(id); }
  private async request<T>(scope: ExaScope, path: string, method: string, body: unknown, validate: (v: unknown) => v is T, caller?: AbortSignal, timeout?: number): Promise<T> {
    if (!this.config.enabled) throw new ExaError("exa_unavailable", "Native Exa is disabled by configuration.", scope);
    if ((scope === "search" && !this.config.search.enabled) || (scope === "contents" && !this.config.fetch.enabled) || (scope === "research-create" && !this.config.research.enabled)) throw new ExaError("exa_unavailable", "This Exa capability is disabled by configuration.", scope);
    const controller = new AbortController();
    const abort = () => controller.abort(caller?.reason); caller?.addEventListener("abort", abort, { once: true });
    if (caller?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Exa request deadline reached")), timeout ?? this.config.request_timeout_ms);
    let sent = false;
    try {
      return await this.pacer.run(async () => {
        const admission = this.health.enter(scope);
        try {
          controller.signal.throwIfAborted(); sent = true;
          const response = await this.transport(`${ORIGIN}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
            headers: { Authorization: `Bearer ${this.config.api_key}`, "Content-Type": "application/json", Accept: "application/json" },
            signal: controller.signal, rejectRedirects: true, dispatcher: this.dispatcher });
          const requestIdHeader = response.headers.get("x-request-id") ?? undefined;
          // Bound decoding even when upstream omits or lies about Content-Length.
          const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
          if (reader) { try { for (;;) { controller.signal.throwIfAborted(); const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            const aborted = () => { void reader.cancel().catch(() => {}); reject(controller.signal.reason); };
            controller.signal.addEventListener("abort", aborted, { once: true });
            if (controller.signal.aborted) aborted();
            else void reader.read().then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", aborted));
          }); if (done) break; bytes += value.byteLength; if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ExaError("invalid_response", "Exa response exceeds the supported size limit.", scope, response.status, undefined, requestIdHeader, scope === "research-create"); } chunks.push(value); } } finally { if (controller.signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); } }
          let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { value = undefined; }
          const requestId = object(value) && typeof value.requestId === "string" ? value.requestId.slice(0, 200) : requestIdHeader;
          if (!response.ok) {
            const code = response.status === 401 || response.status === 403 ? "auth_failed" : response.status === 402 ? "credit_exhausted" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "upstream_failed" : "invalid_request";
            const retry = response.headers.get("retry-after"); const numeric = retry === null ? NaN : Number(retry);
            const retryMs = Number.isFinite(numeric) ? numeric * 1000 : retry ? Date.parse(retry) - this.now() : 30000;
            throw new ExaError(code, `Exa ${scope} returned HTTP ${response.status}.`, scope, response.status, code === "rate_limited" ? this.now() + Math.max(1000, Math.min(300000, Number.isFinite(retryMs) ? retryMs : 30000)) : undefined, requestId, scope === "research-create" && response.status >= 500);
          }
          if (!validate(value)) throw new ExaError("invalid_response", "Exa returned an unsupported response shape.", scope, response.status, undefined, requestId, scope === "research-create", object(value) && validateCost(value) ? (value.costDollars as { total: number } | undefined)?.total : undefined);
          if (object(value) && Array.isArray(value.results)) for (const item of value.results) if (object(item)) for (const key of ["title", "author", "publishedDate"]) if (item[key] === null) delete item[key];
          admission.success(); return value;
        } catch (cause) {
          const error = cause instanceof ExaError ? cause : new ExaError(caller?.aborted ? "aborted" : controller.signal.aborted ? "timeout" : "transport_failed", caller?.aborted ? "Exa call aborted; remote work may still exist." : controller.signal.aborted ? "Exa request timed out." : "Exa transport failed.", scope, undefined, undefined, undefined, scope === "research-create" && sent);
          admission.failure(error); throw error;
        } finally { admission.finish(); }
      }, controller.signal);
    } catch (cause) {
      if (cause instanceof ExaError) throw cause;
      throw new ExaError(caller?.aborted ? "aborted" : "timeout", caller?.aborted ? "Exa call aborted before request admission." : "Exa request admission timed out.", scope, undefined, undefined, undefined, scope === "research-create" && sent);
    } finally { clearTimeout(timer); caller?.removeEventListener("abort", abort); }
  }
}
