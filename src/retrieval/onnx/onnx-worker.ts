/**
 * Worker process of one local ONNX provider model (src/retrieval/onnx/session.ts,
 * ARCHITECTURE.md §9d "Re-rank stages"): loads the tokenizer and the
 * onnxruntime session and runs tokenization, inference and post-processing,
 * so neither model loading nor a forward pass ever blocks the event loop.
 *
 * Ops (one batch per request; the caller checks its abort signal between):
 * - `crossScore` {query, documents, maxTokens} → number[] (probabilities)
 * - `lateEncode` {texts, maxTokens} → TokenMatrix[] (unit rows, real tokens only)
 */
import { readFile } from "node:fs/promises";
import { Tokenizer } from "tokenizers";
import * as ort from "onnxruntime-node";
import type { TokenMatrix } from "../models/types.js";
import { buildFeeds, clipText, encodeInput, padTokenId, truncateInput, type EncodedInput } from "./encoding.js";
import { isWorkerChild, serveWorker } from "./worker-rpc.js";

export interface OnnxWorkerInit {
  onnxPath: string;
  tokenizerPath: string;
  configPath?: string;
  /** onnxruntime intra-op threads (unset: onnxruntime's own choice). */
  threads?: number;
}

export interface OnnxWorkerInfo {
  inputNames: string[];
  outputNames: string[];
}

interface State {
  session: ort.InferenceSession;
  tokenizer: Tokenizer;
  padId: number;
}

/**
 * Token-vector outputs by preference: a ColBERT model's projected vectors
 * (the space it was trained to score in) before the raw encoder states. With
 * none of these names, any other [B, T, D] output wins over
 * `last_hidden_state`, which is the last resort before the first output.
 */
const TOKEN_OUTPUTS = ["colbert_vecs", "token_embeddings", "embeddings", "contextual_embeddings", "output"];

/** The output holding the token vectors (see {@link TOKEN_OUTPUTS}). */
export function pickTokenOutput(names: readonly string[], rank: (name: string) => number): string {
  const named = TOKEN_OUTPUTS.find((n) => names.includes(n));
  if (named) return named;
  const projected = names.find((n) => n !== "last_hidden_state" && rank(n) === 3);
  if (projected) return projected;
  return names.includes("last_hidden_state") ? "last_hidden_state" : names[0]!;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

async function run(state: State, batch: EncodedInput[]): Promise<{ result: ort.InferenceSession.ReturnType; length: number }> {
  const { feeds, length } = buildFeeds(ort, state.session.inputNames, batch, state.padId);
  // All outputs: onnxruntime-node 1.21 mislabels a fetched subset of outputs.
  return { result: await state.session.run(feeds), length };
}

/** Cross-encoder: sigmoid of a single logit, or the positive class's softmax for two. */
async function crossScore(state: State, p: { query: string; documents: string[]; maxTokens: number }): Promise<number[]> {
  const q = clipText(p.query, p.maxTokens);
  const batch = await Promise.all(
    p.documents.map(async (doc) => truncateInput(await encodeInput(state.tokenizer, q, clipText(doc, p.maxTokens)), p.maxTokens)),
  );
  const { result } = await run(state, batch);
  const names = state.session.outputNames;
  const tensor = result[names.includes("logits") ? "logits" : names[0]!]!;
  const data = tensor.data as Float32Array;
  const b = batch.length;
  const width = tensor.dims.length === 1 ? 1 : Number(tensor.dims[tensor.dims.length - 1]);
  if (data.length !== b * width || (width !== 1 && width !== 2)) {
    throw new Error(`unexpected logits shape [${tensor.dims.join(", ")}]`);
  }
  const scores: number[] = [];
  for (let i = 0; i < b; i++) scores.push(width === 1 ? sigmoid(data[i]!) : sigmoid(data[i * 2 + 1]! - data[i * 2]!));
  return scores;
}

/** Late encoder: token vectors of real (mask 1) positions, each row L2-normalized. */
async function lateEncode(state: State, p: { texts: string[]; maxTokens: number }): Promise<TokenMatrix[]> {
  const batch = await Promise.all(
    p.texts.map(async (text) => truncateInput(await encodeInput(state.tokenizer, clipText(text, p.maxTokens)), p.maxTokens)),
  );
  const { result, length: t } = await run(state, batch);
  const names = state.session.outputNames;
  const tensor = result[pickTokenOutput(names, (n) => result[n]?.dims.length ?? 0)]!;
  if (tensor.dims.length !== 3 || Number(tensor.dims[0]) !== batch.length || Number(tensor.dims[1]) !== t) {
    throw new Error(`expected token vectors [${batch.length}, ${t}, D], got [${tensor.dims.join(", ")}]`);
  }
  const dim = Number(tensor.dims[2]);
  const data = tensor.data as Float32Array;
  return batch.map((input, row) => {
    // Padding sits at the end, so the real positions are the first `n`.
    const n = input.ids.length;
    const out = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) {
      const src = (row * t + i) * dim;
      let norm = 0;
      for (let k = 0; k < dim; k++) norm += data[src + k]! * data[src + k]!;
      const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
      for (let k = 0; k < dim; k++) out[i * dim + k] = data[src + k]! * inv;
    }
    return { tokens: n, dim, data: out };
  });
}

if (isWorkerChild("onnx")) {
  serveWorker<State, OnnxWorkerInit>(
    async (init) => {
      const tokenizerJson = JSON.parse(await readFile(init.tokenizerPath, "utf8")) as Record<string, unknown>;
      const config = init.configPath
        ? (JSON.parse(await readFile(init.configPath, "utf8")) as Record<string, unknown>)
        : {};
      const tokenizer = Tokenizer.fromFile(init.tokenizerPath);
      // Truncation and padding are done on the id arrays, so the file's own
      // settings (often a fixed max length) must not apply.
      tokenizer.disableTruncation();
      tokenizer.disablePadding();
      const session = await ort.InferenceSession.create(init.onnxPath, {
        graphOptimizationLevel: "all",
        ...(init.threads ? { intraOpNumThreads: init.threads } : {}),
        interOpNumThreads: 1,
        executionMode: "sequential",
      });
      const info: OnnxWorkerInfo = { inputNames: [...session.inputNames], outputNames: [...session.outputNames] };
      return { state: { session, tokenizer, padId: padTokenId(config, tokenizerJson) }, info };
    },
    (state) => ({
      crossScore: (p: { query: string; documents: string[]; maxTokens: number }) => crossScore(state, p),
      lateEncode: (p: { texts: string[]; maxTokens: number }) => lateEncode(state, p),
    }),
    async (state) => {
      await state.session.release();
    },
  );
}
