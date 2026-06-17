# Tokenizer test fixtures

`byte-bpe.tokenizer.json` is a **synthetic** tiny byte-level BPE tokenizer (413
vocab / 155 merges), trained on a fixed in-repo corpus. It is **not** the GLM
tokenizer — it exists only to exercise the native tokenizer machinery
(`Tokenizer::from_file`, encode/decode/count, `add_special_tokens`) with
deterministic, lossless round-trips in both the Rust (`tests/tokenizer.rs`) and
TypeScript (`test/tokenizer.test.ts`) test suites.

Properties relied on by the tests:
- byte-level BPE → `decode(encode(x)) == x` for any input (incl. multibyte/emoji);
- a `<s>` (id 0) BOS special token added by a `TemplateProcessing` post-processor
  **only** when `add_special_tokens = true`, so `countTokens` (which uses
  `add_special_tokens = false`) never absorbs BOS overhead.

Regenerate with:

```
cd native/crates/matrix-core
cargo run --example gen_test_tokenizer -- tests/fixtures/byte-bpe.tokenizer.json
```

The real GLM-5.1 `tokenizer.json` (MIT) is vendored separately at
`native/assets/glm-5.1/` and selected via `[tokenizer].glm_tokenizer_path`; this tiny
fixture exists only so the test suites stay fast and self-contained (the real
tokenizer is 20 MB / 154 820 vocab). See spec/TOKENIZER-CALIBRATION.md.
