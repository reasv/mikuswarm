/**
 * Remote re-rank and late-interaction providers (ARCHITECTURE.md §9d
 * "Re-rank stages"). Both are configured per provider and must be
 * self-hosted or zero-data-retention (enforced at config resolution).
 *
 * Re-ranker: the common open `/rerank` HTTP shape served by TEI, Infinity,
 * vLLM, llama.cpp's server and hosted re-rank APIs. Two request formats:
 * `documents` (`{ model, query, documents, top_n }`, the default) and `texts`
 * (`{ query, texts }`, TEI). The response may be a bare array
 * `[{ index, score }]`, or `{ results | data: [{ index, relevance_score | score }] }`.
 * Documents are trimmed client-side to the provider's `max_tokens` (a
 * conservative character estimate, the query counted against it), since not
 * every server truncates; TEI's `texts` format also asks it to.
 *
 * Late encoder: an embeddings-shaped endpoint returning one vector per token:
 * `{ model, input: [...], input_type: "query" | "document" }` →
 * `{ data: [{ index, embedding | embeddings: number[][] }] }`. The input-type
 * field name is configurable (empty to omit).
 */
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { ResolvedModelProvider } from "../config.js";
import type { LateEncoder, RerankProvider, TokenMatrix } from "./types.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

async function postJson(
  url: string,
  body: unknown,
  opts: { apiKey?: string; signal: AbortSignal; dispatcher?: Dispatcher; maxResponseBytes?: number },
): Promise<unknown> {
  const maxBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
    dispatcher: opts.dispatcher,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`response too large: ${declared} bytes`);
  }
  // Enforced while streaming too: a missing or false content-length never buffers past the cap.
  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        await res.body.cancel().catch(() => undefined);
        throw new Error(`response too large: over ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

/** Characters per token assumed when trimming for a remote model (conservative: real text runs ~4). */
const TRIM_CHARS_PER_TOKEN = 3;

/** `doc` trimmed so query + document fit `maxTokens` (at least a short head of the document is kept). */
export function trimForModel(query: string, doc: string, maxTokens: number): string {
  const budget = Math.max(64 * TRIM_CHARS_PER_TOKEN, (maxTokens - 8) * TRIM_CHARS_PER_TOKEN - query.length);
  return doc.length <= budget ? doc : doc.slice(0, budget);
}

/** Parse a `/rerank` response into scores aligned with the input documents. */
export function parseRerankResponse(json: unknown, count: number): number[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? ((json as Record<string, unknown>)["results"] ?? (json as Record<string, unknown>)["data"])
      : undefined;
  if (!Array.isArray(list)) throw new Error("rerank response has no result list");
  const out = new Array<number | undefined>(count).fill(undefined);
  for (const item of list) {
    if (!item || typeof item !== "object") throw new Error("malformed rerank result");
    const r = item as Record<string, unknown>;
    const index = r["index"];
    const score = r["relevance_score"] ?? r["score"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`rerank result index out of range: ${String(index)}`);
    }
    if (typeof score !== "number" || !Number.isFinite(score)) throw new Error(`rerank result ${index} has no score`);
    out[index] = score;
  }
  if (out.some((s) => s === undefined)) throw new Error(`rerank response scored ${list.length} of ${count} documents`);
  return out as number[];
}

export class RemoteRerankProvider implements RerankProvider {
  readonly kind = "remote" as const;
  readonly name: string;
  readonly model?: string;
  private readonly dispatcher?: Dispatcher;
  private readonly maxResponseBytes?: number;

  constructor(
    private readonly cfg: ResolvedModelProvider,
    opts: { httpProxyUrl?: string; maxResponseBytes?: number } = {},
  ) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.dispatcher = opts.httpProxyUrl ? new ProxyAgent(opts.httpProxyUrl) : undefined;
    this.maxResponseBytes = opts.maxResponseBytes;
  }

  async score(query: string, documents: string[], signal: AbortSignal): Promise<number[]> {
    if (documents.length === 0) return [];
    const url = `${this.cfg.endpoint}${this.cfg.path ?? "/rerank"}`;
    const out: number[] = [];
    for (let i = 0; i < documents.length; i += this.cfg.batchSize) {
      const batch = documents.slice(i, i + this.cfg.batchSize).map((d) => trimForModel(query, d, this.cfg.maxTokens));
      const body =
        this.cfg.requestFormat === "texts"
          ? { query, texts: batch, raw_scores: false, truncate: true }
          : { ...(this.model ? { model: this.model } : {}), query, documents: batch, top_n: batch.length, return_documents: false };
      const json = await postJson(url, body, { apiKey: this.cfg.apiKey, signal, dispatcher: this.dispatcher, maxResponseBytes: this.maxResponseBytes });
      out.push(...parseRerankResponse(json, batch.length));
    }
    return out;
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}

/** L2-normalize each token row of a `number[][]` into a TokenMatrix. */
export function toTokenMatrix(rows: number[][]): TokenMatrix {
  const tokens = rows.length;
  const dim = tokens > 0 ? rows[0]!.length : 0;
  const data = new Float32Array(tokens * dim);
  for (let t = 0; t < tokens; t++) {
    const row = rows[t]!;
    if (row.length !== dim) throw new Error(`token ${t} has ${row.length} dims, expected ${dim}`);
    let sum = 0;
    for (const x of row) sum += x * x;
    const norm = Math.sqrt(sum) || 1;
    for (let d = 0; d < dim; d++) data[t * dim + d] = row[d]! / norm;
  }
  return { tokens, dim, data };
}

export function parseMultiVectorResponse(json: unknown, count: number): TokenMatrix[] {
  const data = json && typeof json === "object" ? (json as Record<string, unknown>)["data"] : undefined;
  if (!Array.isArray(data) || data.length !== count) throw new Error(`multi-vector response: expected ${count} items`);
  const out = new Array<TokenMatrix | undefined>(count).fill(undefined);
  data.forEach((item, position) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const index = typeof r["index"] === "number" ? (r["index"] as number) : position;
    const rows = r["embeddings"] ?? r["embedding"];
    if (!Array.isArray(rows) || !rows.every((row) => Array.isArray(row))) {
      throw new Error(`multi-vector item ${index} is not a token-vector matrix`);
    }
    if (index < 0 || index >= count || out[index]) throw new Error(`multi-vector index ${index} invalid or repeated`);
    out[index] = toTokenMatrix(rows as number[][]);
  });
  return out as TokenMatrix[];
}

export class RemoteLateEncoder implements LateEncoder {
  readonly kind = "remote" as const;
  readonly name: string;
  readonly model?: string;
  private readonly dispatcher?: Dispatcher;

  constructor(
    private readonly cfg: ResolvedModelProvider,
    opts: { httpProxyUrl?: string } = {},
  ) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.dispatcher = opts.httpProxyUrl ? new ProxyAgent(opts.httpProxyUrl) : undefined;
  }

  private async encode(texts: string[], side: "query" | "document", signal: AbortSignal): Promise<TokenMatrix[]> {
    const url = `${this.cfg.endpoint}${this.cfg.path ?? "/embeddings"}`;
    const out: TokenMatrix[] = [];
    for (let i = 0; i < texts.length; i += this.cfg.batchSize) {
      const batch = texts.slice(i, i + this.cfg.batchSize);
      const body: Record<string, unknown> = { ...(this.model ? { model: this.model } : {}), input: batch };
      if (this.cfg.inputTypeField) body[this.cfg.inputTypeField] = side;
      const json = await postJson(url, body, { apiKey: this.cfg.apiKey, signal, dispatcher: this.dispatcher });
      out.push(...parseMultiVectorResponse(json, batch.length));
    }
    return out;
  }

  encodeDocuments(texts: string[], signal: AbortSignal): Promise<TokenMatrix[]> {
    return this.encode(texts.map((t) => this.cfg.documentPrefix + t), "document", signal);
  }

  async encodeQuery(text: string, maxTokens: number, signal: AbortSignal): Promise<TokenMatrix> {
    const [m] = await this.encode([this.cfg.queryPrefix + text], "query", signal);
    // The server tokenizes; cap the token rows we score to the late query budget.
    if (m!.tokens <= maxTokens) return m!;
    return { tokens: maxTokens, dim: m!.dim, data: m!.data.slice(0, maxTokens * m!.dim) };
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
