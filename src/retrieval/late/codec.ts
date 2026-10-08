/**
 * On-disk format of late-interaction token vectors (ARCHITECTURE.md §9d "Late
 * interaction"): one SQLite blob per block and model in `memory_late_vectors`.
 *
 * - `fp16` (default): `tokens × dim` IEEE half floats, little endian, row-major.
 * - `int8`: `tokens × dim` signed bytes, row-major, plus a `scales` blob of
 *   `tokens` float32 (little endian): value = byte × scale, one symmetric scale
 *   per token (its max |x| / 127). Half the size of fp16.
 *
 * Rows are L2-normalized before encoding; decoding returns float32 rows as
 * stored (not re-normalized, so a quantization error stays visible to MaxSim
 * the same way on every path).
 */
import type { TokenMatrix } from "../models/types.js";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 → IEEE 754 half (round to nearest even). */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
  if (exp >= 0x1f) return sign | 0x7c00; // overflow → inf
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow → ±0
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half += 1;
    return sign | half;
  }
  let half = sign | (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half += 1;
  return half;
}

/** IEEE 754 half → float32. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export interface EncodedVectors {
  dtype: "fp16" | "int8";
  dim: number;
  tokenCount: number;
  vectors: Buffer;
  scales: Buffer | null;
}

export function encodeTokenMatrix(m: TokenMatrix, dtype: "fp16" | "int8"): EncodedVectors {
  const n = m.tokens * m.dim;
  if (dtype === "fp16") {
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeUInt16LE(toHalf(m.data[i]!), i * 2);
    return { dtype, dim: m.dim, tokenCount: m.tokens, vectors: buf, scales: null };
  }
  const buf = Buffer.alloc(n);
  const scales = Buffer.alloc(m.tokens * 4);
  for (let t = 0; t < m.tokens; t++) {
    let max = 0;
    for (let d = 0; d < m.dim; d++) max = Math.max(max, Math.abs(m.data[t * m.dim + d]!));
    const scale = max > 0 ? max / 127 : 1;
    scales.writeFloatLE(scale, t * 4);
    for (let d = 0; d < m.dim; d++) {
      const q = Math.max(-127, Math.min(127, Math.round(m.data[t * m.dim + d]! / scale)));
      buf.writeInt8(q, t * m.dim + d);
    }
  }
  return { dtype, dim: m.dim, tokenCount: m.tokens, vectors: buf, scales };
}

export function decodeTokenMatrix(row: {
  dtype: "fp16" | "int8";
  dim: number;
  tokenCount: number;
  vectors: Buffer | Uint8Array;
  scales: Buffer | Uint8Array | null;
}): TokenMatrix {
  const n = row.tokenCount * row.dim;
  const data = new Float32Array(n);
  const v = Buffer.isBuffer(row.vectors) ? row.vectors : Buffer.from(row.vectors);
  if (row.dtype === "fp16") {
    if (v.length < n * 2) throw new Error("late vector blob too short");
    for (let i = 0; i < n; i++) data[i] = fromHalf(v.readUInt16LE(i * 2));
  } else {
    if (!row.scales) throw new Error("int8 late vectors need scales");
    const s = Buffer.isBuffer(row.scales) ? row.scales : Buffer.from(row.scales);
    if (v.length < n || s.length < row.tokenCount * 4) throw new Error("late vector blob too short");
    for (let t = 0; t < row.tokenCount; t++) {
      const scale = s.readFloatLE(t * 4);
      for (let d = 0; d < row.dim; d++) data[t * row.dim + d] = v.readInt8(t * row.dim + d) * scale;
    }
  }
  return { tokens: row.tokenCount, dim: row.dim, data };
}
