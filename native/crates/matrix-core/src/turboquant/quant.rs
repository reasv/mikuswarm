//! TurboQuant encoding of token vectors into the scan layout.
//!
//! The quantiser is turbovec's (MIT, <https://github.com/RyanCodrai/turbovec>),
//! used through its public API: the deterministic block-Hadamard rotation
//! ([`turbovec::rotation::Rotation`]) and the Lloyd-Max codebook for the
//! rotated-coordinate distribution ([`turbovec::expected_codebook`]). Each row is
//! normalised, rotated, quantised coordinate by coordinate against the codebook
//! boundaries, and given turbovec's bias-correcting scale
//! `‖x‖ / ⟨u_rot, x̂⟩`, so `scale · ⟨q_rot, x̂⟩` is the inner-product estimate.
//! It is data-oblivious: every row is encoded on its own, nothing is trained.
//!
//! The code layout is our own (turbovec's blocked layout and kernels are
//! crate-private): FastScan-style 32-row chunks of 4-bit "nibble groups", see
//! [`Layout`]. At 3 and 4 bits a group is one coordinate; at 2 bits a group
//! packs two coordinates (`c[2g] | c[2g+1] << 2`), so its 16-entry lookup table
//! holds the sum of both coordinates' contributions.

use turbovec::rotation::Rotation;

/// Rows per chunk: one 256-bit lookup covers 32 rows of one nibble-group pair.
pub const CHUNK: usize = 32;

/// Shape of one encoded chunk.
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    /// Nibble groups per row (even).
    pub groups: usize,
}

impl Layout {
    /// Code bytes per 32-row chunk: 16 bytes per group (two rows per byte).
    pub fn chunk_bytes(&self) -> usize {
        16 * self.groups
    }

    /// Byte offset (within a chunk) and nibble shift of row `lane`, group `g`.
    ///
    /// Groups are stored in pairs of 32 bytes: the first 16 bytes hold group
    /// `2p` and the next 16 group `2p + 1`. Byte `i` of a half holds row `i` in
    /// its low nibble and row `i + 16` in its high nibble, which is what one
    /// AVX2 `pshufb` against `[lut(2p) | lut(2p+1)]` consumes.
    #[inline]
    pub fn position(&self, lane: usize, g: usize) -> (usize, u32) {
        let byte = (g / 2) * 32 + (g % 2) * 16 + (lane % 16);
        let shift = if lane < 16 { 0 } else { 4 };
        (byte, shift)
    }
}

/// Where row `lane` (0..32) of a chunk keeps its scale. The SIMD reduction
/// yields rows in the order even 0..14, odd 1..15, even 16..30, odd 17..31, so
/// scales are stored in that order and the kernel reads them contiguously.
#[inline]
pub fn scale_slot(lane: usize) -> usize {
    let half = (lane / 16) * 16;
    let w = lane % 16;
    half + if w % 2 == 0 { w / 2 } else { 8 + w / 2 }
}

/// A seeded signed permutation applied before turbovec's fixed-seed rotation,
/// so different seeds give independent rotations. Orthogonal, so inner
/// products are unchanged.
struct PreFlip {
    perm: Vec<u32>,
    signs: Vec<f32>,
}

impl PreFlip {
    fn new(dim: usize, seed: u64) -> Self {
        let mut state = seed;
        let mut next = move || {
            // splitmix64
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        let mut perm: Vec<u32> = (0..dim as u32).collect();
        for i in (1..dim).rev() {
            let j = (next() % (i as u64 + 1)) as usize;
            perm.swap(i, j);
        }
        let signs = (0..dim).map(|_| if next() & 1 == 1 { -1.0 } else { 1.0 }).collect();
        Self { perm, signs }
    }
}

/// The per-index quantiser: rotation, codebook and code geometry.
pub struct Quantizer {
    /// Input dimension.
    pub dim: usize,
    /// Working dimension: `dim` zero-padded to a multiple of 8 (the rotation's
    /// constraint). Padding with zeros leaves inner products unchanged.
    pub pdim: usize,
    pub bits: u32,
    pub layout: Layout,
    pub centroids: Vec<f32>,
    boundaries: Vec<f32>,
    rotation: Rotation,
    pre: Option<PreFlip>,
}

/// Scratch buffers for [`Quantizer::rotate`] (reused across rows).
pub struct Scratch {
    /// The rotated row (output of [`Quantizer::rotate`]).
    pub a: Vec<f32>,
    b: Vec<f32>,
    c: Vec<f32>,
}

impl Quantizer {
    pub fn check(dim: usize, bits: u32) -> Result<(), String> {
        if !(2..=4).contains(&bits) {
            return Err(format!("TurboQuant bits must be 2, 3 or 4, got {bits}"));
        }
        if dim == 0 || dim > turbovec::MAX_DIM {
            return Err(format!("TurboQuant dim must be in 1..={}, got {dim}", turbovec::MAX_DIM));
        }
        Ok(())
    }

    /// Build the quantiser. The codebook solve takes tens of ms on a cold
    /// shape (memoised process-wide by turbovec), so call this off the JS thread.
    pub fn new(dim: usize, bits: u32, seed: Option<u64>) -> Result<Self, String> {
        Self::check(dim, bits)?;
        let pdim = dim.div_ceil(8) * 8;
        let (boundaries, centroids) = turbovec::expected_codebook(bits as usize, pdim);
        let groups = if bits == 2 { pdim / 2 } else { pdim };
        Ok(Self {
            dim,
            pdim,
            bits,
            layout: Layout { groups },
            centroids,
            boundaries,
            rotation: Rotation::new(pdim),
            pre: seed.filter(|s| *s != 0).map(|s| PreFlip::new(pdim, s)),
        })
    }

    pub fn scratch(&self) -> Scratch {
        Scratch { a: vec![0.0; self.pdim], b: vec![0.0; self.pdim], c: vec![0.0; self.pdim] }
    }

    /// Rotate `x` (length `dim`) into `s.a` (length `pdim`), scaled by `inv`.
    pub fn rotate(&self, x: &[f32], inv: f32, s: &mut Scratch) {
        debug_assert_eq!(x.len(), self.dim);
        match &self.pre {
            None => {
                s.b[..self.dim].copy_from_slice(x);
                s.b[self.dim..].fill(0.0);
            }
            Some(pre) => {
                for (i, (&p, &sg)) in pre.perm.iter().zip(pre.signs.iter()).enumerate() {
                    let p = p as usize;
                    s.b[i] = if p < self.dim { x[p] * sg } else { 0.0 };
                }
            }
        }
        self.rotation.apply_scaled_into(&s.b, inv, &mut s.a, &mut s.c);
    }

    /// Quantise one coordinate of a rotated unit row.
    #[inline]
    fn code(&self, v: f32) -> u8 {
        self.boundaries.partition_point(|&b| b < v) as u8
    }

    /// Encode row `x` into its nibble groups (`out.len() == groups`), returning
    /// its scale (0 for a zero row: it then scores 0 against every query).
    pub fn encode_row(&self, x: &[f32], out: &mut [u8], s: &mut Scratch) -> f32 {
        let norm = x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt() as f32;
        if !(norm > 0.0) {
            out.fill(0);
            return 0.0;
        }
        self.rotate(x, 1.0 / norm, s);
        let r = &s.a;
        let mut dot = 0.0f64;
        if self.bits == 2 {
            for g in 0..self.layout.groups {
                let c0 = self.code(r[2 * g]);
                let c1 = self.code(r[2 * g + 1]);
                dot += r[2 * g] as f64 * self.centroids[c0 as usize] as f64
                    + r[2 * g + 1] as f64 * self.centroids[c1 as usize] as f64;
                out[g] = c0 | (c1 << 2);
            }
        } else {
            for (j, o) in out.iter_mut().enumerate() {
                let c = self.code(r[j]);
                dot += r[j] as f64 * self.centroids[c as usize] as f64;
                *o = c;
            }
        }
        if dot > 1e-12 {
            (norm as f64 / dot) as f32
        } else {
            0.0
        }
    }

    /// The dequantised reconstruction of a nibble-group row in the rotated
    /// basis, before its scale (`x̂`, length `pdim`). Tests only.
    #[cfg(test)]
    pub fn decode_row(&self, nibbles: &[u8]) -> Vec<f32> {
        let mut out = vec![0.0; self.pdim];
        for (g, &n) in nibbles.iter().enumerate() {
            if self.bits == 2 {
                out[2 * g] = self.centroids[(n & 3) as usize];
                out[2 * g + 1] = self.centroids[(n >> 2) as usize];
            } else {
                out[g] = self.centroids[n as usize];
            }
        }
        out
    }
}
