//! The fused MaxSim scan over TurboQuant codes.
//!
//! Per query token, a 16-entry u8 lookup table per nibble group holds the
//! quantised contribution `⟨q_rot, centroid⟩` of every code (FastScan-style).
//! One chunk of 32 document tokens is scored by summing table lookups over
//! the groups (AVX2 `pshufb`, u16 accumulators), the sums are dequantised to
//! f32, multiplied by each token's scale and max-reduced; the block score is
//! the sum over query tokens of that max (MaxSim), divided by the query length.
//!
//! The scalar path computes exactly the same integers and the same f32
//! operations in the same order, so both paths return identical scores.

use super::quant::{scale_slot, Layout, Quantizer, CHUNK};

/// One encoded document block (e.g. one diary block): `tokens` rows of codes
/// in 32-row chunks, plus one scale per row slot (`NaN` for padding slots, so
/// they never win a max).
pub struct Block {
    pub key: String,
    pub tokens: usize,
    pub codes: Vec<u8>,
    pub scales: Vec<f32>,
}

impl Block {
    pub fn chunks(&self) -> usize {
        self.tokens.div_ceil(CHUNK)
    }

    pub fn memory_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.key.capacity()
            + self.codes.capacity()
            + self.scales.capacity() * std::mem::size_of::<f32>()
    }

    /// Encode `rows` (`tokens × dim`, row-major) into a block.
    pub fn encode(q: &Quantizer, key: String, rows: &[f32]) -> Block {
        let tokens = rows.len() / q.dim;
        let layout = q.layout;
        let chunks = tokens.div_ceil(CHUNK);
        let mut codes = vec![0u8; chunks * layout.chunk_bytes()];
        let mut scales = vec![f32::NAN; chunks * CHUNK];
        let mut nibbles = vec![0u8; layout.groups];
        let mut scratch = q.scratch();
        for (t, row) in rows.chunks_exact(q.dim).enumerate() {
            let scale = q.encode_row(row, &mut nibbles, &mut scratch);
            let (c, lane) = (t / CHUNK, t % CHUNK);
            let chunk = &mut codes[c * layout.chunk_bytes()..(c + 1) * layout.chunk_bytes()];
            for (g, &n) in nibbles.iter().enumerate() {
                let (byte, shift) = layout.position(lane, g);
                chunk[byte] |= n << shift;
            }
            scales[c * CHUNK + scale_slot(lane)] = scale;
        }
        Block { key, tokens, codes, scales }
    }
}

/// Lookup tables for a whole query: `tokens × groups × 16` bytes, plus the
/// per-token dequantisation `value = acc · delta + bias`.
pub struct QueryLuts {
    pub tokens: usize,
    pub luts: Vec<u8>,
    pub delta: Vec<f32>,
    pub bias: Vec<f32>,
}

impl QueryLuts {
    /// Rotate each query token and build its quantised tables. The u8 entries
    /// are capped so the sum over all groups fits a u16 accumulator.
    pub fn build(q: &Quantizer, query: &[f32]) -> QueryLuts {
        let tokens = query.len() / q.dim;
        let groups = q.layout.groups;
        let qmax = (65535 / groups).min(255) as f32;
        let mut luts = vec![0u8; tokens * groups * 16];
        let mut delta = Vec::with_capacity(tokens);
        let mut bias = Vec::with_capacity(tokens);
        let mut scratch = q.scratch();
        let mut raw = vec![0f32; groups * 16];
        let levels = 1usize << q.bits;
        let c = &q.centroids;
        for (t, row) in query.chunks_exact(q.dim).enumerate() {
            q.rotate(row, 1.0, &mut scratch);
            let r = &scratch.a;
            for g in 0..groups {
                let table = &mut raw[g * 16..(g + 1) * 16];
                if q.bits == 2 {
                    for (e, v) in table.iter_mut().enumerate() {
                        *v = r[2 * g] * c[e & 3] + r[2 * g + 1] * c[e >> 2];
                    }
                } else {
                    for (e, v) in table.iter_mut().enumerate().take(levels) {
                        *v = r[g] * c[e];
                    }
                    // 3-bit: codes 8..15 never occur; give them the table minimum.
                    if levels < 16 {
                        let m = table[..levels].iter().copied().fold(f32::INFINITY, f32::min);
                        table[levels..].fill(m);
                    }
                }
            }
            let mut range = 0f32;
            let mut b = 0f64;
            let mins: Vec<f32> = raw
                .chunks_exact(16)
                .map(|t| {
                    let lo = t.iter().copied().fold(f32::INFINITY, f32::min);
                    let hi = t.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                    range = range.max(hi - lo);
                    b += lo as f64;
                    lo
                })
                .collect();
            let d = if range > 0.0 { range / qmax } else { 1.0 };
            let out = &mut luts[t * groups * 16..(t + 1) * groups * 16];
            for g in 0..groups {
                for e in 0..16 {
                    let v = ((raw[g * 16 + e] - mins[g]) / d).round();
                    out[g * 16 + e] = v.clamp(0.0, qmax) as u8;
                }
            }
            delta.push(d);
            bias.push(b as f32);
        }
        QueryLuts { tokens, luts, delta, bias }
    }
}

/// Unnormalised MaxSim of one block: Σ over query tokens of the max estimated
/// inner product over the block's tokens.
pub fn block_score(block: &Block, layout: Layout, luts: &QueryLuts, simd: bool) -> f64 {
    #[cfg(target_arch = "x86_64")]
    {
        if simd {
            // SAFETY: `simd` is only true when AVX2 was detected at runtime.
            return unsafe { block_score_avx2(block, layout, luts) };
        }
    }
    let _ = simd;
    block_score_scalar(block, layout, luts)
}

/// True when the AVX2 kernel can run on this CPU.
pub fn simd_available() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

/// Portable path: identical integers and f32 operations to the AVX2 kernel.
pub fn block_score_scalar(block: &Block, layout: Layout, luts: &QueryLuts) -> f64 {
    let groups = layout.groups;
    let cb = layout.chunk_bytes();
    let mut total = 0f64;
    for t in 0..luts.tokens {
        let lut = &luts.luts[t * groups * 16..(t + 1) * groups * 16];
        let (d, b) = (luts.delta[t], luts.bias[t]);
        let mut best = f32::NEG_INFINITY;
        for c in 0..block.chunks() {
            let chunk = &block.codes[c * cb..(c + 1) * cb];
            for lane in 0..CHUNK {
                let mut acc = 0u32;
                for g in 0..groups {
                    let (byte, shift) = layout.position(lane, g);
                    let n = (chunk[byte] >> shift) & 0x0f;
                    acc += lut[g * 16 + n as usize] as u32;
                }
                let v = (acc as f32 * d + b) * block.scales[c * CHUNK + scale_slot(lane)];
                // NaN (padding) never compares greater.
                if v > best {
                    best = v;
                }
            }
        }
        total += best as f64;
    }
    total
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn block_score_avx2(block: &Block, layout: Layout, luts: &QueryLuts) -> f64 {
    use std::arch::x86_64::*;

    let groups = layout.groups;
    let pairs = groups / 2;
    let cb = layout.chunk_bytes();
    let chunks = block.chunks();
    let mask = _mm256_set1_epi8(0x0f);
    let codes = block.codes.as_ptr();
    let scales = block.scales.as_ptr();
    let mut total = 0f64;
    for t in 0..luts.tokens {
        let lut = luts.luts.as_ptr().add(t * groups * 16);
        let dv = _mm256_set1_ps(luts.delta[t]);
        let bv = _mm256_set1_ps(luts.bias[t]);
        let mut best = _mm256_set1_ps(f32::NEG_INFINITY);
        for c in 0..chunks {
            let base = codes.add(c * cb);
            let mut a0 = _mm256_setzero_si256();
            let mut a1 = _mm256_setzero_si256();
            let mut b0 = _mm256_setzero_si256();
            let mut b1 = _mm256_setzero_si256();
            for p in 0..pairs {
                let x = _mm256_loadu_si256(base.add(p * 32) as *const __m256i);
                let l = _mm256_loadu_si256(lut.add(p * 32) as *const __m256i);
                let lo = _mm256_and_si256(x, mask);
                let hi = _mm256_and_si256(_mm256_srli_epi16(x, 4), mask);
                let rl = _mm256_shuffle_epi8(l, lo);
                let rh = _mm256_shuffle_epi8(l, hi);
                // u16 lanes: even rows in the low byte, odd rows in the high byte.
                // a0 accumulates (even + 256·odd) mod 2^16, a1 the odd bytes, so
                // a0 − (a1 << 8) is the exact even-row sum (it fits a u16).
                a0 = _mm256_add_epi16(a0, rl);
                a1 = _mm256_add_epi16(a1, _mm256_srli_epi16(rl, 8));
                b0 = _mm256_add_epi16(b0, rh);
                b1 = _mm256_add_epi16(b1, _mm256_srli_epi16(rh, 8));
            }
            let ae = _mm256_sub_epi16(a0, _mm256_slli_epi16(a1, 8));
            let be = _mm256_sub_epi16(b0, _mm256_slli_epi16(b1, 8));
            // The two 128-bit halves hold groups 2p and 2p+1 of the same rows.
            let sums = [
                _mm_add_epi16(_mm256_castsi256_si128(ae), _mm256_extracti128_si256(ae, 1)),
                _mm_add_epi16(_mm256_castsi256_si128(a1), _mm256_extracti128_si256(a1, 1)),
                _mm_add_epi16(_mm256_castsi256_si128(be), _mm256_extracti128_si256(be, 1)),
                _mm_add_epi16(_mm256_castsi256_si128(b1), _mm256_extracti128_si256(b1, 1)),
            ];
            for (k, s) in sums.iter().enumerate() {
                let f = _mm256_cvtepi32_ps(_mm256_cvtepu16_epi32(*s));
                let sc = _mm256_loadu_ps(scales.add(c * CHUNK + k * 8));
                let v = _mm256_mul_ps(_mm256_add_ps(_mm256_mul_ps(f, dv), bv), sc);
                // maxps returns its second operand when either is NaN, so
                // padding slots (NaN scale) leave `best` unchanged.
                best = _mm256_max_ps(v, best);
            }
        }
        let mut lanes = [0f32; 8];
        _mm256_storeu_ps(lanes.as_mut_ptr(), best);
        let mut m = f32::NEG_INFINITY;
        for v in lanes {
            if v > m {
                m = v;
            }
        }
        total += m as f64;
    }
    total
}

/// Score every block (MaxSim normalised by the query length) on up to
/// `threads` threads; returns the scores in block order.
pub fn scan(blocks: &[std::sync::Arc<Block>], layout: Layout, luts: &QueryLuts, threads: usize) -> Vec<f64> {
    let simd = simd_available();
    let qn = luts.tokens.max(1) as f64;
    let n = blocks.len();
    let mut out = vec![0f64; n];
    if n == 0 || luts.tokens == 0 {
        return out;
    }
    // ~200 cycles of kernel work per (chunk, query token): spread only when
    // there is enough of it to pay for the thread spawns.
    let work: usize = blocks.iter().map(|b| b.chunks()).sum::<usize>() * luts.tokens;
    let threads = threads.min(work / 4096 + 1).min(n).max(1);
    if threads == 1 {
        for (o, b) in out.iter_mut().zip(blocks) {
            *o = block_score(b, layout, luts, simd) / qn;
        }
        return out;
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    const STEP: usize = 8;
    let parts: Vec<Vec<(usize, f64)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut local = Vec::new();
                    loop {
                        let start = next.fetch_add(STEP, std::sync::atomic::Ordering::Relaxed);
                        if start >= n {
                            break;
                        }
                        for i in start..(start + STEP).min(n) {
                            local.push((i, block_score(&blocks[i], layout, luts, simd) / qn));
                        }
                    }
                    local
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("TurboQuant scan thread panicked")).collect()
    });
    for part in parts {
        for (i, v) in part {
            out[i] = v;
        }
    }
    out
}
