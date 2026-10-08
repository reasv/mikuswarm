use std::sync::Arc;
use std::time::Instant;

use super::kernel::{self, block_score_scalar, Block, QueryLuts};
use super::quant::{scale_slot, Quantizer, CHUNK};
use super::{top_indices, BlockSet};

/// splitmix64 + Box-Muller: deterministic, dependency-free test data.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn gauss(&mut self) -> f64 {
        let u = self.uniform().max(1e-300);
        let v = self.uniform();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
    fn unit(&mut self, dim: usize) -> Vec<f32> {
        let v: Vec<f64> = (0..dim).map(|_| self.gauss()).collect();
        normalize(&v)
    }
}

fn normalize(v: &[f64]) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    v.iter().map(|x| (x / n) as f32).collect()
}

fn dot(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum()
}

/// Exact f32-input MaxSim / query tokens.
fn exact_maxsim(query: &[f32], rows: &[f32], dim: usize) -> f64 {
    let mut total = 0.0;
    for qt in query.chunks_exact(dim) {
        let best = rows.chunks_exact(dim).map(|r| dot(qt, r)).fold(f64::NEG_INFINITY, f64::max);
        total += best;
    }
    total / (query.len() / dim) as f64
}

/// Query tokens plus documents with planted graded relevance: each document
/// has a relevance `r` drawn from `r_range`; a share of its tokens are near random query tokens at
/// cosine ~`0.9·r`, the rest are random. Returns (query, docs).
fn planted(
    rng: &mut Rng,
    dim: usize,
    q: usize,
    docs: usize,
    (min_len, max_len): (usize, usize),
    (r_lo, r_hi): (f64, f64),
) -> (Vec<f32>, Vec<Vec<f32>>) {
    let query: Vec<f32> = (0..q).flat_map(|_| rng.unit(dim)).collect();
    let mut out = Vec::with_capacity(docs);
    for _ in 0..docs {
        let r = r_lo + (r_hi - r_lo) * rng.uniform();
        let len = min_len + (rng.next_u64() as usize) % (max_len - min_len + 1);
        let mut rows = Vec::with_capacity(len * dim);
        for _ in 0..len {
            let noise = rng.unit(dim);
            if rng.uniform() < 0.3 {
                let t = (rng.next_u64() as usize) % q;
                let c = 0.9 * r;
                let s = (1.0 - c * c).sqrt();
                let v: Vec<f64> = (0..dim)
                    .map(|k| c * query[t * dim + k] as f64 + s * noise[k] as f64)
                    .collect();
                rows.extend(normalize(&v));
            } else {
                rows.extend(noise);
            }
        }
        out.push(rows);
    }
    (query, out)
}

fn encode_all(q: &Quantizer, docs: &[Vec<f32>]) -> Vec<Arc<Block>> {
    docs.iter().enumerate().map(|(i, rows)| Arc::new(Block::encode(q, format!("b{i}"), rows))).collect()
}

/// The nibble groups of row `t` of a block, read back from the chunk layout.
fn row_nibbles(q: &Quantizer, block: &Block, t: usize) -> Vec<u8> {
    let cb = q.layout.chunk_bytes();
    let chunk = &block.codes[(t / CHUNK) * cb..(t / CHUNK + 1) * cb];
    (0..q.layout.groups)
        .map(|g| {
            let (byte, shift) = q.layout.position(t % CHUNK, g);
            (chunk[byte] >> shift) & 0x0f
        })
        .collect()
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        sab += (x - ma) * (y - mb);
        saa += (x - ma) * (x - ma);
        sbb += (y - mb) * (y - mb);
    }
    sab / (saa * sbb).sqrt()
}

/// The reduction itself is exact: against an f64 MaxSim over the same
/// dequantised vectors (scale · ⟨q_rot, x̂⟩), the only difference is the u8
/// rounding of the lookup tables, which is bounded analytically; and the AVX2
/// kernel returns bit-identical scores to the scalar path.
#[test]
fn turboquant_reduction_matches_dequantised_reference() {
    let mut rng = Rng(7);
    // 60 exercises zero-padding to a multiple of 8; lengths exercise partial chunks.
    for &(dim, bits, seed) in &[(64usize, 4u32, None), (60, 3, Some(9u64)), (128, 2, None), (128, 4, Some(3))] {
        let q = Quantizer::new(dim, bits, seed).unwrap();
        let (query, docs) = planted(&mut rng, dim, 7, 12, (1, 75), (0.0, 1.0));
        let blocks = encode_all(&q, &docs);
        let luts = QueryLuts::build(&q, &query);
        let scanned = kernel::scan(&blocks, q.layout, &luts, 4);
        let mut scratch = q.scratch();
        for (bi, block) in blocks.iter().enumerate() {
            let mut reference = 0.0;
            let mut bound = 0.0;
            for (t, qt) in query.chunks_exact(dim).enumerate() {
                q.rotate(qt, 1.0, &mut scratch);
                let qr = scratch.a.clone();
                let mut best = f64::NEG_INFINITY;
                let mut max_scale = 0f64;
                for v in 0..block.tokens {
                    let scale = block.scales[(v / CHUNK) * CHUNK + scale_slot(v % CHUNK)] as f64;
                    max_scale = max_scale.max(scale.abs());
                    let xh = q.decode_row(&row_nibbles(&q, block, v));
                    best = best.max(scale * dot(&qr, &xh));
                }
                reference += best;
                bound += max_scale * q.layout.groups as f64 * luts.delta[t] as f64 / 2.0;
            }
            let n = luts.tokens as f64;
            let (reference, bound) = (reference / n, bound / n + 1e-4);
            let got = scanned[bi];
            assert!(
                (got - reference).abs() <= bound,
                "dim {dim} bits {bits} block {bi}: kernel {got} vs dequantised {reference} (bound {bound})"
            );
            let scalar = block_score_scalar(block, q.layout, &luts) / n;
            assert_eq!(got.to_bits(), scalar.to_bits(), "SIMD and scalar paths diverge on block {bi}");
        }
    }
}

/// Quality on planted data: quantised scores track exact MaxSim, the exact
/// top 20 stays inside the quantised top 60 at 4 bits, and 4-bit error is
/// below 2-bit error. Two corpora: relevance spread over [0, 1] (easy), and a
/// narrow band [0.35, 0.55] where many blocks nearly tie (hard).
#[test]
fn turboquant_quality_vs_exact_maxsim() {
    let dim = 128;
    for (name, band, min_corr, min_contained) in [("wide", (0.0, 1.0), 0.98, 19), ("narrow", (0.35, 0.55), 0.9, 18)] {
        let mut rng = Rng(42);
        let (query, docs) = planted(&mut rng, dim, 32, 400, (20, 160), band);
        let exact: Vec<f64> = docs.iter().map(|d| exact_maxsim(&query, d, dim)).collect();
        let exact_top20 = top_indices(&exact, 20);

        let mut mean_err = Vec::new();
        for bits in [4u32, 3, 2] {
            let q = Quantizer::new(dim, bits, None).unwrap();
            let blocks = encode_all(&q, &docs);
            let luts = QueryLuts::build(&q, &query);
            let approx = kernel::scan(&blocks, q.layout, &luts, 8);
            let corr = pearson(&exact, &approx);
            let err = exact.iter().zip(&approx).map(|(a, b)| (a - b).abs()).sum::<f64>() / exact.len() as f64;
            let top60 = top_indices(&approx, 60);
            let contained = exact_top20.iter().filter(|i| top60.contains(i)).count();
            let top20 = top_indices(&approx, 20);
            let overlap20 = exact_top20.iter().filter(|i| top20.contains(i)).count();
            println!(
                "{name} bits {bits}: pearson {corr:.4}, mean |err| {err:.4}, top20 in top60 {contained}/20, top20 overlap {overlap20}/20"
            );
            if bits == 4 {
                assert!(corr > min_corr, "{name} 4-bit: correlation {corr}");
                assert!(
                    contained >= min_contained,
                    "{name} 4-bit: only {contained}/20 of the exact top 20 in the quantised top 60"
                );
            }
            mean_err.push(err);
        }
        assert!(mean_err[0] < mean_err[1] && mean_err[1] < mean_err[2], "{name}: error not decreasing with bits: {mean_err:?}");
    }
}

#[test]
fn turboquant_block_set_and_top_k() {
    let q = Quantizer::new(16, 4, None).unwrap();
    let mut rng = Rng(1);
    let mut set = BlockSet::default();
    for i in 0..5 {
        let rows: Vec<f32> = (0..3).flat_map(|_| rng.unit(16)).collect();
        set.upsert(Block::encode(&q, format!("k{i}"), &rows));
    }
    let rows: Vec<f32> = rng.unit(16);
    set.upsert(Block::encode(&q, "k2".into(), &rows));
    assert_eq!(set.blocks.len(), 5);
    assert_eq!(set.blocks[set.index["k2"]].tokens, 1);
    assert!(set.remove("k0"));
    assert!(!set.remove("k0"));
    assert_eq!(set.blocks.len(), 4);
    for (k, &i) in &set.index {
        assert_eq!(&set.blocks[i].key, k);
    }

    let s = [0.1, 0.9, 0.3, 0.5, 0.7];
    assert_eq!(top_indices(&s, 0), vec![1, 4, 3, 2, 0]);
    assert_eq!(top_indices(&s, 3), vec![1, 4, 3]);
    assert_eq!(top_indices(&s, 10).len(), 5);
}

/// Throughput at one deployment's scale: ~4,000 blocks of ~340 tokens
/// (≈1.36M token vectors, dim 128) × 32 query tokens. Run with
/// `cargo test --release -p openclaw-matrix-native turboquant_bench -- --ignored --nocapture`.
#[test]
#[ignore]
fn turboquant_bench() {
    let dim = 128;
    let mut rng = Rng(5);
    let docs: Vec<Vec<f32>> = (0..4000)
        .map(|_| {
            let len = 300 + (rng.next_u64() as usize) % 81;
            (0..len).flat_map(|_| rng.unit(dim)).collect()
        })
        .collect();
    let tokens: usize = docs.iter().map(|d| d.len() / dim).sum();
    let query: Vec<f32> = (0..32).flat_map(|_| rng.unit(dim)).collect();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    println!("{tokens} token vectors, dim {dim}, 32 query tokens, {threads} threads, avx2 {}", kernel::simd_available());
    for bits in [4u32, 3, 2] {
        let q = Quantizer::new(dim, bits, None).unwrap();
        let start = Instant::now();
        let blocks: Vec<Arc<Block>> = std::thread::scope(|s| {
            let per = docs.len().div_ceil(threads);
            let handles: Vec<_> = docs
                .chunks(per)
                .enumerate()
                .map(|(c, part)| {
                    let q = &q;
                    s.spawn(move || {
                        part.iter()
                            .enumerate()
                            .map(|(i, rows)| Arc::new(Block::encode(q, format!("b{}", c * per + i), rows)))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        let encode = start.elapsed();
        let bytes: usize = blocks.iter().map(|b| b.memory_bytes()).sum();
        let luts = QueryLuts::build(&q, &query);
        let _ = kernel::scan(&blocks, q.layout, &luts, threads);
        let mut times = Vec::new();
        for _ in 0..10 {
            let start = Instant::now();
            let s = kernel::scan(&blocks, q.layout, &luts, threads);
            let _ = top_indices(&s, 60);
            times.push(start.elapsed().as_secs_f64() * 1e3);
        }
        times.sort_by(f64::total_cmp);
        let start = Instant::now();
        let _ = kernel::scan(&blocks, q.layout, &luts, 1);
        let single = start.elapsed().as_secs_f64() * 1e3;
        println!(
            "bits {bits}: encode {:.0} ms, {:.1} MB ({:.1} B/token), scan median {:.2} ms (min {:.2}), 1 thread {:.1} ms",
            encode.as_secs_f64() * 1e3,
            bytes as f64 / 1e6,
            bytes as f64 / tokens as f64,
            times[times.len() / 2],
            times[0],
            single
        );
    }
}
