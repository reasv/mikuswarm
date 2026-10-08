/**
 * Tokenization and tensor helpers of the local ONNX providers, run inside the
 * provider worker (src/retrieval/onnx/onnx-worker.ts): trimming to the token
 * budget on id arrays, padding a batch, and building the int64 feeds.
 */
import type { Tokenizer } from "@anush008/tokenizers";
import type * as Ort from "onnxruntime-node";

/** One tokenized input: ids, type ids, and per-token sequence index (null = special). */
export interface EncodedInput {
  ids: number[];
  typeIds: number[];
  sequenceIds: Array<number | null | undefined>;
}

/** Text is clipped to this many characters per allowed token before tokenizing. */
export const CHARS_PER_TOKEN_CLIP = 16;

/** Clip text that cannot fit `maxTokens` anyway, so huge inputs are not tokenized whole. */
export function clipText(text: string, maxTokens: number): string {
  const limit = maxTokens * CHARS_PER_TOKEN_CLIP;
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Tokenize a text or a (text, pair) with the model's special tokens. */
export async function encodeInput(tokenizer: Tokenizer, text: string, pair?: string): Promise<EncodedInput> {
  const enc = pair === undefined ? await tokenizer.encode(text) : await tokenizer.encode(text, pair);
  return { ids: enc.getIds(), typeIds: enc.getTypeIds(), sequenceIds: enc.getSequenceIds() };
}

/**
 * Truncate to `maxTokens`, never dropping special tokens: tokens are removed
 * from the end of the second sequence first (the document of a pair), and from
 * the first sequence only when the second is exhausted (a query that alone
 * exceeds the budget, or a single text).
 */
export function truncateInput(input: EncodedInput, maxTokens: number): EncodedInput {
  let excess = input.ids.length - maxTokens;
  if (excess <= 0) return input;
  const keep = input.ids.map(() => true);
  for (const seq of [1, 0]) {
    for (let i = input.ids.length - 1; i >= 0 && excess > 0; i--) {
      if (input.sequenceIds[i] === seq && keep[i]) {
        keep[i] = false;
        excess--;
      }
    }
  }
  const pick = <T,>(xs: T[]): T[] => xs.filter((_, i) => keep[i]).slice(0, maxTokens);
  return { ids: pick(input.ids), typeIds: pick(input.typeIds), sequenceIds: pick(input.sequenceIds) };
}

/** The pad token id: config.json `pad_token_id`, else tokenizer.json padding, else 0. */
export function padTokenId(config: Record<string, unknown>, tokenizerJson: Record<string, unknown>): number {
  const fromConfig = config.pad_token_id;
  if (typeof fromConfig === "number") return fromConfig;
  const padding = tokenizerJson.padding as { pad_id?: unknown } | null | undefined;
  if (padding && typeof padding.pad_id === "number") return padding.pad_id;
  return 0;
}

const KNOWN_INPUTS = new Set(["input_ids", "attention_mask", "token_type_ids"]);

/**
 * Pad a batch to its longest input and build the int64 feeds the session
 * declares (`input_ids`, `attention_mask`, and `token_type_ids` only if declared).
 */
export function buildFeeds(
  ort: typeof Ort,
  inputNames: readonly string[],
  batch: EncodedInput[],
  padId: number,
): { feeds: Record<string, Ort.Tensor>; length: number } {
  const unknown = inputNames.filter((n) => !KNOWN_INPUTS.has(n));
  if (unknown.length > 0) throw new Error(`unsupported model inputs: ${unknown.join(", ")}`);
  const b = batch.length;
  const t = Math.max(1, ...batch.map((x) => x.ids.length));
  const ids = new BigInt64Array(b * t).fill(BigInt(padId));
  const mask = new BigInt64Array(b * t);
  const types = new BigInt64Array(b * t);
  batch.forEach((x, row) => {
    for (let i = 0; i < x.ids.length; i++) {
      ids[row * t + i] = BigInt(x.ids[i]!);
      mask[row * t + i] = 1n;
      types[row * t + i] = BigInt(x.typeIds[i] ?? 0);
    }
  });
  const dims = [b, t];
  const feeds: Record<string, Ort.Tensor> = {};
  const declared = new Set(inputNames);
  if (declared.has("input_ids")) feeds.input_ids = new ort.Tensor("int64", ids, dims);
  if (declared.has("attention_mask")) feeds.attention_mask = new ort.Tensor("int64", mask, dims);
  if (declared.has("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", types, dims);
  return { feeds, length: t };
}

/** Throw the signal's abort reason (as an AbortError) when aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new DOMException("aborted", "AbortError");
}
