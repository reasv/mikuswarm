/**
 * Worker process of the exact MaxSim scorer (src/retrieval/late/maxsim.ts,
 * ARCHITECTURE.md §9d "Late interaction"): owns one ONNX session running the
 * batched MaxSim graph and the resident windows' vectors, so the q×t×d product
 * never runs on the event loop. A cancelled score stops at its next batch.
 * Documents may arrive as stored fp16 / int8 rows; they are decoded here, never
 * in the parent. Windows are updated in place (`windowAdd` / `windowRemove`).
 */
import * as ort from "onnxruntime-node";
import { isWorkerChild, serveWorker, type HandlerContext } from "../onnx/worker-rpc.js";
import { decodeTokenMatrix } from "./codec.js";
import { buildMaxSimModel, MAXSIM_MASK_PAD } from "./maxsim-graph.js";

export interface WireMatrix {
  key: string;
  tokens: number;
  dim: number;
  data: Float32Array;
}

/** A document as stored (`memory_late_vectors`), decoded in the worker. */
export interface WireEncoded {
  key: string;
  tokens: number;
  dim: number;
  dtype: "fp16" | "int8";
  vectors: Uint8Array;
  scales: Uint8Array | null;
}

export type WireDoc = WireMatrix | WireEncoded;

/** Decode a wire document to float32 rows (a corrupt blob throws). */
export function decodeWire(doc: WireDoc): WireMatrix {
  if ("data" in doc) return doc;
  const m = decodeTokenMatrix({ dtype: doc.dtype, dim: doc.dim, tokenCount: doc.tokens, vectors: doc.vectors, scales: doc.scales });
  return { key: doc.key, tokens: m.tokens, dim: m.dim, data: m.data };
}

/** Decode what decodes; a corrupt document is skipped (no score, it bypasses as vector-less). */
function decodeAll(docs: WireDoc[]): WireMatrix[] {
  const out: WireMatrix[] = [];
  for (const d of docs) {
    try {
      out.push(decodeWire(d));
    } catch {
      // skipped
    }
  }
  return out;
}

export interface WireQuery {
  tokens: number;
  dim: number;
  data: Float32Array;
}

export interface WorkerInit {
  threads: number;
  maxBatchTokens: number;
}

/** A padded batch: `b` documents of `t` tokens each (`t` = the batch's longest). */
interface PackedBatch {
  keys: string[];
  b: number;
  t: number;
  dim: number;
  data: Float32Array;
  mask: Float32Array;
}

/**
 * Pack documents into padded batches bucketed by length: sorted by token count,
 * each batch grows while `count × longest` stays within `maxBatchTokens`, so
 * padding waste stays small. Empty documents are dropped (no score).
 */
export function packBatches(docs: WireMatrix[], maxBatchTokens: number): PackedBatch[] {
  const live = docs.filter((d) => d.tokens > 0);
  if (live.length === 0) return [];
  const dim = live[0]!.dim;
  for (const d of live) {
    if (d.dim !== dim) throw new Error(`MaxSim: mixed dims in one set (${dim} and ${d.dim})`);
    if (d.data.length < d.tokens * d.dim) throw new Error(`MaxSim: document ${d.key} has short data`);
  }
  live.sort((a, b) => a.tokens - b.tokens);
  const batches: PackedBatch[] = [];
  let start = 0;
  while (start < live.length) {
    let end = start + 1;
    while (end < live.length && (end - start + 1) * live[end]!.tokens <= maxBatchTokens) end++;
    const group = live.slice(start, end);
    const t = group[group.length - 1]!.tokens;
    const b = group.length;
    const data = new Float32Array(b * t * dim);
    const mask = new Float32Array(b * t);
    group.forEach((d, i) => {
      data.set(d.data.subarray(0, d.tokens * dim), i * t * dim);
      if (d.tokens < t) mask.fill(MAXSIM_MASK_PAD, i * t + d.tokens, (i + 1) * t);
    });
    batches.push({ keys: group.map((d) => d.key), b, t, dim, data, mask });
    start = end;
  }
  return batches;
}

interface ResidentWindow {
  docs: Map<string, WireMatrix>;
  batches: PackedBatch[];
}

interface State {
  init: WorkerInit;
  session: ort.InferenceSession;
  windows: Map<string, ResidentWindow>;
  staging: Map<string, WireMatrix[]>;
  /** Ad-hoc documents of a score sent ahead in bounded messages. */
  staged: Map<string, WireMatrix[]>;
}

function repack(state: State, w: ResidentWindow): void {
  w.batches = [];
  w.batches = packBatches([...w.docs.values()], state.init.maxBatchTokens);
}

/** Score batches into `out`; false when cancelled midway. */
async function scoreBatches(
  state: State,
  query: WireQuery,
  batches: PackedBatch[],
  out: { keys: string[]; scores: number[] },
  ctx: HandlerContext,
): Promise<boolean> {
  const q = query.tokens;
  const qTensor = new ort.Tensor("float32", query.data.subarray(0, q * query.dim), [q, query.dim]);
  for (const batch of batches) {
    if (ctx.cancelled()) return false;
    if (batch.dim !== query.dim) {
      throw new Error(`MaxSim: query dim ${query.dim} does not match document dim ${batch.dim}`);
    }
    const result = await state.session.run({
      Q: qTensor,
      D: new ort.Tensor("float32", batch.data, [batch.b, batch.t, batch.dim]),
      M: new ort.Tensor("float32", batch.mask, [batch.b, 1, batch.t]),
    });
    const s = result.S!.data as Float32Array;
    for (let i = 0; i < batch.b; i++) {
      let sum = 0;
      for (let j = 0; j < q; j++) sum += s[i * q + j]!;
      out.keys.push(batch.keys[i]!);
      out.scores.push(sum / q);
    }
  }
  return true;
}

if (isWorkerChild("maxsim")) {
  serveWorker<State, WorkerInit>(
    async (init) => {
      const session = await ort.InferenceSession.create(buildMaxSimModel(), {
        graphOptimizationLevel: "all",
        intraOpNumThreads: init.threads,
        interOpNumThreads: 1,
        executionMode: "sequential",
      });
      return { state: { init, session, windows: new Map(), staging: new Map(), staged: new Map() }, info: null };
    },
    (state) => ({
      windowBegin: (p: { windowId: string }) => {
        state.staging.set(p.windowId, []);
      },
      windowAppend: (p: { windowId: string; docs: WireDoc[] }) => {
        const list = state.staging.get(p.windowId);
        if (!list) throw new Error(`MaxSim: window ${p.windowId} was not begun`);
        for (const d of decodeAll(p.docs)) list.push(d);
      },
      windowCommit: (p: { windowId: string }) => {
        const list = state.staging.get(p.windowId) ?? [];
        state.staging.delete(p.windowId);
        state.windows.delete(p.windowId); // free the old one before packing the new
        const w: ResidentWindow = { docs: new Map(list.map((d) => [d.key, d])), batches: [] };
        repack(state, w);
        state.windows.set(p.windowId, w);
      },
      windowAdd: (p: { windowId: string; docs: WireDoc[] }) => {
        let w = state.windows.get(p.windowId);
        if (!w) {
          w = { docs: new Map(), batches: [] };
          state.windows.set(p.windowId, w);
        }
        for (const d of decodeAll(p.docs)) w.docs.set(d.key, d);
        repack(state, w);
      },
      windowRemove: (p: { windowId: string; keys: string[] }) => {
        const w = state.windows.get(p.windowId);
        if (!w) return;
        let removed = 0;
        for (const k of p.keys) if (w.docs.delete(k)) removed++;
        if (removed > 0) repack(state, w);
      },
      dropWindow: (p: { windowId: string }) => {
        state.windows.delete(p.windowId);
        state.staging.delete(p.windowId);
      },
      stageDocs: (p: { stageId: string; docs: WireDoc[] }) => {
        const list = state.staged.get(p.stageId) ?? [];
        for (const d of decodeAll(p.docs)) list.push(d);
        state.staged.set(p.stageId, list);
      },
      unstage: (p: { stageId: string }) => {
        state.staged.delete(p.stageId);
      },
      score: async (p: { query: WireQuery; windowId?: string; stageId?: string; docs?: WireDoc[] }, ctx: HandlerContext) => {
        const staged = p.stageId !== undefined ? (state.staged.get(p.stageId) ?? []) : [];
        if (p.stageId !== undefined) state.staged.delete(p.stageId);
        if (p.query.tokens <= 0) throw new Error("MaxSim: empty query");
        const out = { keys: [] as string[], scores: [] as number[] };
        if (p.windowId !== undefined) {
          const window = state.windows.get(p.windowId);
          if (!window) throw new Error(`MaxSim: unknown window ${p.windowId}`);
          if (!(await scoreBatches(state, p.query, window.batches, out, ctx))) return null;
        }
        const adhocDocs = [...staged, ...decodeAll(p.docs ?? [])];
        if (adhocDocs.length > 0) {
          const adhoc = packBatches(adhocDocs, state.init.maxBatchTokens);
          if (!(await scoreBatches(state, p.query, adhoc, out, ctx))) return null;
        }
        return { keys: out.keys, scores: Float32Array.from(out.scores) };
      },
    }),
    async (state) => {
      state.windows.clear();
      state.staging.clear();
      await state.session.release();
    },
  );
}
