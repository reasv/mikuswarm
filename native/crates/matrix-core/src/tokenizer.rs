//! GLM-native tokenizer exposed over NAPI (spec/TOKENIZER-SWAP.md §5.2).
//!
//! Wraps the Hugging Face `tokenizers` Rust crate — the reference engine the
//! model's `tokenizer.json` is authored for, so byte-level BPE, the pretokenizer
//! regex, and special-token handling match the model exactly. The TS seam
//! (`src/context/tokenizer/`) drives this through the `glm` `Tokenizer` impl; the
//! shipped default stays `gpt-tokenizer`, so this code only runs when an operator
//! selects `[tokenizer].primary = "glm"` (or `retrieval = "glm"`).
//!
//! The surface is deliberately synchronous (§4): a tokenize is microseconds and
//! the estimator sits in hot, deterministic render paths. `encodeAsync` is the one
//! escape hatch — it runs the encode on a libuv worker thread (`AsyncTask`) and is
//! wired only into the retrieval indexer's large-file `split` path.
//!
//! Counts use `add_special_tokens = false` so a per-string count never absorbs
//! GLM's BOS/`[gMASK]`/`<sop>` overhead — parity with `gpt-tokenizer`, which adds
//! nothing.

use std::sync::Arc;

use napi::bindgen_prelude::{AsyncTask, Task, Uint32Array};
use napi::{Env, Result};
use napi_derive::napi;
use tokenizers::Tokenizer;

/// A loaded tokenizer. One instance per `tokenizer.json` (the TS registry builds
/// at most two — the primary/chat and the retrieval/embedder tokenizers).
#[napi]
pub struct NativeTokenizer {
    inner: Arc<Tokenizer>,
}

#[napi]
impl NativeTokenizer {
    /// Load a tokenizer from a Hugging Face `tokenizer.json` on disk. Fails loudly
    /// (the path is included) so a missing/invalid GLM asset fail-fasts at startup
    /// rather than silently degrading — matching the explicit-config philosophy.
    #[napi(factory)]
    pub fn from_file(path: String) -> Result<Self> {
        let tokenizer = Tokenizer::from_file(&path).map_err(|err| {
            napi::Error::from_reason(format!("failed to load tokenizer.json from {path}: {err}"))
        })?;
        Ok(Self {
            inner: Arc::new(tokenizer),
        })
    }

    /// Encode `text` to token ids. `add_special_tokens` defaults to **false**
    /// (no BOS/EOS) — the counting contract above. Uses `encode_fast` (skips the
    /// unused offset computation).
    #[napi]
    pub fn encode(&self, text: String, add_special_tokens: Option<bool>) -> Result<Uint32Array> {
        let ids = encode_ids(&self.inner, &text, add_special_tokens.unwrap_or(false))?;
        Ok(Uint32Array::new(ids))
    }

    /// Decode token ids back to text. Special tokens are NOT skipped, so for a
    /// byte-level BPE tokenizer `decode(encode(x))` is an exact round-trip — the
    /// property the TS `truncate`/`split` helpers rely on.
    #[napi]
    pub fn decode(&self, ids: Uint32Array) -> Result<String> {
        self.inner
            .decode(&ids, false)
            .map_err(|err| napi::Error::from_reason(format!("decode failed: {err}")))
    }

    /// Token count for `text`, with `add_special_tokens = false`. The hot path
    /// behind `estimateTokens` when the primary tokenizer is `glm`.
    #[napi(js_name = "countTokens")]
    pub fn count_tokens(&self, text: String) -> Result<u32> {
        let encoding = self
            .inner
            .encode_fast(text.as_str(), false)
            .map_err(|err| napi::Error::from_reason(format!("encode failed: {err}")))?;
        Ok(encoding.len() as u32)
    }

    /// Async encode on a libuv worker thread (§4 escape hatch). Used only by the
    /// retrieval indexer's large-file chunking, where the encode crosses the
    /// multi-millisecond threshold that makes leaving the JS thread worthwhile.
    #[napi(js_name = "encodeAsync")]
    pub fn encode_async(
        &self,
        text: String,
        add_special_tokens: Option<bool>,
    ) -> AsyncTask<EncodeTask> {
        AsyncTask::new(EncodeTask {
            tokenizer: Arc::clone(&self.inner),
            text,
            add_special_tokens: add_special_tokens.unwrap_or(false),
        })
    }
}

/// Shared sync encode → owned id vector (used by both `encode` and `EncodeTask`).
fn encode_ids(tokenizer: &Tokenizer, text: &str, add_special_tokens: bool) -> Result<Vec<u32>> {
    let encoding = tokenizer
        .encode_fast(text, add_special_tokens)
        .map_err(|err| napi::Error::from_reason(format!("encode failed: {err}")))?;
    Ok(encoding.get_ids().to_vec())
}

/// libuv-threadpool encode task (`NativeTokenizer::encodeAsync`).
pub struct EncodeTask {
    tokenizer: Arc<Tokenizer>,
    text: String,
    add_special_tokens: bool,
}

impl Task for EncodeTask {
    type Output = Vec<u32>;
    type JsValue = Uint32Array;

    fn compute(&mut self) -> Result<Self::Output> {
        encode_ids(&self.tokenizer, &self.text, self.add_special_tokens)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Uint32Array::new(output))
    }
}
