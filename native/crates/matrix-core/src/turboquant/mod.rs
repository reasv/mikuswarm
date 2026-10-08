//! TurboQuant MaxSim scan for late-interaction retrieval
//! (spec/MEMORY-RETRIEVAL.md §5.0d).
//!
//! A resident set of document blocks (one block = the token vectors of one
//! document) is held as 2–4-bit TurboQuant codes ([`quant`]) and scored against
//! a multi-vector query by a fused MaxSim kernel ([`kernel`]): for each query
//! token the best estimated inner product over the block's tokens, summed over
//! query tokens and divided by the query length. Scores are approximate; the
//! caller re-scores the top blocks exactly.
//!
//! Every heavy operation (encoding, scanning) runs on the libuv thread pool as
//! an `AsyncTask`, the scan itself fanned out over `threads` OS threads. The
//! resident set is copy-on-write: a scan works on a snapshot, so mutations
//! never wait for a scan and a scan never sees a half-applied mutation.

mod kernel;
mod quant;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::{AsyncTask, Either, Float32Array, Float64Array, Task, Uint32Array};
use napi::{Env, Result};
use napi_derive::napi;

use kernel::{Block, QueryLuts};
use quant::Quantizer;

fn err(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message.into())
}

#[napi(object)]
pub struct TurboQuantOptions {
    /// Token vector dimension.
    pub dim: u32,
    /// Bits per coordinate: 2, 3 or 4.
    pub bits: u32,
    /// Rotation seed (0 or absent: turbovec's fixed rotation).
    pub seed: Option<u32>,
    /// Scan threads (default: the available parallelism).
    pub threads: Option<u32>,
}

#[napi(object)]
pub struct TurboQuantScanResult {
    /// Block keys, best first.
    pub keys: Vec<String>,
    /// MaxSim scores normalised by the query token count, aligned with `keys`.
    pub scores: Float64Array,
}

#[derive(Clone, Default)]
struct BlockSet {
    blocks: Vec<Arc<Block>>,
    index: HashMap<String, usize>,
}

impl BlockSet {
    fn upsert(&mut self, block: Block) {
        let block = Arc::new(block);
        match self.index.get(&block.key) {
            Some(&i) => self.blocks[i] = block,
            None => {
                self.index.insert(block.key.clone(), self.blocks.len());
                self.blocks.push(block);
            }
        }
    }

    fn remove(&mut self, key: &str) -> bool {
        let Some(i) = self.index.remove(key) else { return false };
        self.blocks.swap_remove(i);
        if i < self.blocks.len() {
            self.index.insert(self.blocks[i].key.clone(), i);
        }
        true
    }
}

struct Shared {
    dim: usize,
    bits: u32,
    seed: Option<u64>,
    threads: usize,
    quantizer: OnceLock<std::result::Result<Arc<Quantizer>, String>>,
    set: Mutex<Arc<BlockSet>>,
}

impl Shared {
    fn quantizer(&self) -> Result<Arc<Quantizer>> {
        self.quantizer
            .get_or_init(|| Quantizer::new(self.dim, self.bits, self.seed).map(Arc::new))
            .clone()
            .map_err(err)
    }

    fn snapshot(&self) -> Arc<BlockSet> {
        self.set.lock().expect("TurboQuant set lock poisoned").clone()
    }
}

/// A resident TurboQuant-coded block set with a MaxSim scan.
#[napi]
pub struct TurboQuantMaxSim {
    shared: Arc<Shared>,
}

#[napi]
impl TurboQuantMaxSim {
    /// Cheap: the rotation and codebook are built on first use, off the JS thread.
    #[napi(constructor)]
    pub fn new(options: TurboQuantOptions) -> Result<Self> {
        Quantizer::check(options.dim as usize, options.bits).map_err(err)?;
        let threads = match options.threads {
            Some(t) if t > 0 => t as usize,
            _ => std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        };
        Ok(Self {
            shared: Arc::new(Shared {
                dim: options.dim as usize,
                bits: options.bits,
                seed: options.seed.map(u64::from),
                threads,
                quantizer: OnceLock::new(),
                set: Mutex::new(Arc::new(BlockSet::default())),
            }),
        })
    }

    #[napi(getter)]
    pub fn dim(&self) -> u32 {
        self.shared.dim as u32
    }

    #[napi(getter)]
    pub fn bits(&self) -> u32 {
        self.shared.bits
    }

    /// Replace the resident set with these blocks: `tokenCounts[i]` rows of
    /// `vectors` (concatenated `tokens × dim` rows, row-major) belong to
    /// `keys[i]`. A repeated key keeps its last occurrence. Encoding runs off
    /// the JS thread; `vectors` must not be mutated until the promise settles.
    /// Concurrent un-awaited mutations commit in completion order.
    #[napi(js_name = "setBlocks", ts_return_type = "Promise<void>")]
    pub fn set_blocks(
        &self,
        keys: Vec<String>,
        token_counts: Either<Uint32Array, Vec<u32>>,
        vectors: Float32Array,
    ) -> AsyncTask<MutateTask> {
        self.mutate(true, keys, token_counts, vectors)
    }

    /// Add (or replace, by key) blocks without touching the others.
    #[napi(js_name = "addBlocks", ts_return_type = "Promise<void>")]
    pub fn add_blocks(
        &self,
        keys: Vec<String>,
        token_counts: Either<Uint32Array, Vec<u32>>,
        vectors: Float32Array,
    ) -> AsyncTask<MutateTask> {
        self.mutate(false, keys, token_counts, vectors)
    }

    /// Remove blocks by key; returns how many were present. O(blocks) pointer
    /// copy, never waits for a running scan.
    #[napi(js_name = "removeBlocks")]
    pub fn remove_blocks(&self, keys: Vec<String>) -> u32 {
        let mut guard = self.shared.set.lock().expect("TurboQuant set lock poisoned");
        let mut next = (**guard).clone();
        let removed = keys.iter().filter(|k| next.remove(k)).count();
        if removed > 0 {
            *guard = Arc::new(next);
        }
        removed as u32
    }

    #[napi(js_name = "blockCount")]
    pub fn block_count(&self) -> u32 {
        self.shared.snapshot().blocks.len() as u32
    }

    /// Resident bytes of the codes, scales and keys.
    #[napi(js_name = "memoryBytes")]
    pub fn memory_bytes(&self) -> f64 {
        let set = self.shared.snapshot();
        set.blocks.iter().map(|b| b.memory_bytes()).sum::<usize>() as f64
    }

    /// Score the resident blocks against `query` (`queryTokens × dim` floats);
    /// resolves with the best `topK` (0 = all) by MaxSim / queryTokens. Runs on
    /// the libuv thread pool, fanned out over the configured threads.
    #[napi(ts_return_type = "Promise<TurboQuantScanResult>")]
    pub fn scan(&self, query: Float32Array, query_tokens: u32, top_k: u32) -> Result<AsyncTask<ScanTask>> {
        let need = query_tokens as usize * self.shared.dim;
        if query.len() < need {
            return Err(err(format!(
                "TurboQuant scan: query has {} floats, expected {query_tokens} × {} = {need}",
                query.len(),
                self.shared.dim
            )));
        }
        Ok(AsyncTask::new(ScanTask {
            shared: self.shared.clone(),
            query: query[..need].to_vec(),
            top_k: top_k as usize,
        }))
    }
}

impl TurboQuantMaxSim {
    fn mutate(
        &self,
        replace: bool,
        keys: Vec<String>,
        token_counts: Either<Uint32Array, Vec<u32>>,
        vectors: Float32Array,
    ) -> AsyncTask<MutateTask> {
        let counts = match token_counts {
            Either::A(a) => a.to_vec(),
            Either::B(v) => v,
        };
        AsyncTask::new(MutateTask { shared: self.shared.clone(), replace, keys, counts, vectors })
    }
}

pub struct MutateTask {
    shared: Arc<Shared>,
    replace: bool,
    keys: Vec<String>,
    counts: Vec<u32>,
    vectors: Float32Array,
}

/// Encode blocks on up to `threads` threads, in input order.
fn encode_blocks(q: &Quantizer, keys: Vec<String>, counts: &[u32], vectors: &[f32], threads: usize) -> Vec<Block> {
    let mut spans = Vec::with_capacity(keys.len());
    let mut offset = 0usize;
    for &n in counts {
        let len = n as usize * q.dim;
        spans.push((offset, len));
        offset += len;
    }
    let rows = offset / q.dim.max(1);
    let threads = threads.min(rows / 2048 + 1).min(spans.len()).max(1);
    if threads == 1 {
        return keys
            .into_iter()
            .zip(spans)
            .map(|(k, (o, l))| Block::encode(q, k, &vectors[o..o + l]))
            .collect();
    }
    let slots: Vec<OnceLock<Block>> = (0..spans.len()).map(|_| OnceLock::new()).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if i >= spans.len() {
                    break;
                }
                let (o, l) = spans[i];
                let _ = slots[i].set(Block::encode(q, keys[i].clone(), &vectors[o..o + l]));
            });
        }
    });
    slots.into_iter().map(|s| s.into_inner().expect("block not encoded")).collect()
}

impl Task for MutateTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        if self.keys.len() != self.counts.len() {
            return Err(err(format!(
                "TurboQuant: {} keys but {} token counts",
                self.keys.len(),
                self.counts.len()
            )));
        }
        if let Some(i) = self.counts.iter().position(|&n| n == 0) {
            return Err(err(format!("TurboQuant: block {:?} has no tokens", self.keys[i])));
        }
        let dim = self.shared.dim;
        let rows: usize = self.counts.iter().map(|&n| n as usize).sum();
        let vectors: &[f32] = &self.vectors;
        if vectors.len() != rows * dim {
            return Err(err(format!(
                "TurboQuant: vectors has {} floats, expected {rows} rows × {dim} = {}",
                vectors.len(),
                rows * dim
            )));
        }
        if let Some(i) = vectors.iter().position(|v| !v.is_finite()) {
            return Err(err(format!("TurboQuant: non-finite value at float {i}")));
        }
        let q = self.shared.quantizer()?;
        let keys = std::mem::take(&mut self.keys);
        let blocks = encode_blocks(&q, keys, &self.counts, vectors, self.shared.threads);
        let mut guard = self.shared.set.lock().expect("TurboQuant set lock poisoned");
        let mut next = if self.replace { BlockSet::default() } else { (**guard).clone() };
        for b in blocks {
            next.upsert(b);
        }
        *guard = Arc::new(next);
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

pub struct ScanTask {
    shared: Arc<Shared>,
    query: Vec<f32>,
    top_k: usize,
}

pub struct ScanOutput {
    keys: Vec<String>,
    scores: Vec<f64>,
}

/// Indices of the `top_k` best scores (0 = all), best first.
fn top_indices(scores: &[f64], top_k: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..scores.len()).collect();
    let cmp = |a: &usize, b: &usize| scores[*b].total_cmp(&scores[*a]);
    if top_k > 0 && top_k < idx.len() {
        idx.select_nth_unstable_by(top_k - 1, cmp);
        idx.truncate(top_k);
    }
    idx.sort_unstable_by(cmp);
    idx
}

impl Task for ScanTask {
    type Output = ScanOutput;
    type JsValue = TurboQuantScanResult;

    fn compute(&mut self) -> Result<ScanOutput> {
        let set = self.shared.snapshot();
        if set.blocks.is_empty() || self.query.is_empty() {
            return Ok(ScanOutput { keys: Vec::new(), scores: Vec::new() });
        }
        let q = self.shared.quantizer()?;
        let luts = QueryLuts::build(&q, &self.query);
        let scores = kernel::scan(&set.blocks, q.layout, &luts, self.shared.threads);
        let top = top_indices(&scores, self.top_k);
        Ok(ScanOutput {
            keys: top.iter().map(|&i| set.blocks[i].key.clone()).collect(),
            scores: top.iter().map(|&i| scores[i]).collect(),
        })
    }

    fn resolve(&mut self, _env: Env, output: ScanOutput) -> Result<TurboQuantScanResult> {
        Ok(TurboQuantScanResult { keys: output.keys, scores: Float64Array::new(output.scores) })
    }
}
