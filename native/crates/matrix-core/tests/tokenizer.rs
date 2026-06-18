//! Validates the `tokenizers`-crate operations the NAPI `NativeTokenizer` wraps
//! (spec/TOKENIZER-SWAP.md §9): loading a `tokenizer.json` by path, encode/decode
//! round-trips, and the `add_special_tokens = false` counting contract. Runs
//! against the committed synthetic byte-level BPE fixture (see
//! `tests/fixtures/README.md`); the known vectors come from
//! `examples/gen_test_tokenizer.rs`.

use tokenizers::Tokenizer;

fn fixture() -> Tokenizer {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/byte-bpe.tokenizer.json"
    );
    Tokenizer::from_file(path).expect("load fixture tokenizer.json by path")
}

#[test]
fn loads_from_file_and_counts_without_special_tokens() {
    let t = fixture();
    // add_special_tokens=false → no BOS/EOS overhead (parity with gpt-tokenizer,
    // which adds nothing). Empty string is 0 tokens, not 1.
    assert_eq!(t.encode_fast("", false).unwrap().len(), 0);
    // Known vectors from gen_test_tokenizer.
    assert_eq!(t.encode_fast("hello world", false).unwrap().len(), 2);
    assert_eq!(t.encode_fast("tokenization", false).unwrap().len(), 1);
}

#[test]
fn special_tokens_add_bos_only_when_requested() {
    let t = fixture();
    let no = t.encode_fast("hello world", false).unwrap();
    let yes = t.encode_fast("hello world", true).unwrap();
    assert_eq!(yes.len(), no.len() + 1, "exactly one special token added");
    assert_eq!(yes.get_ids()[0], 0, "<s> BOS is id 0");
    // Empty string: false → 0 tokens; true → just the BOS. This is precisely why
    // counts use add_special_tokens=false.
    assert_eq!(t.encode_fast("", false).unwrap().len(), 0);
    assert_eq!(t.encode_fast("", true).unwrap().len(), 1);
}

#[test]
fn byte_level_round_trip_is_lossless() {
    let t = fixture();
    // decode(encode(x)) == x for any input — the property the TS truncate/split
    // helpers rely on. Includes multibyte + emoji.
    for s in [
        "hello world",
        "こんにちは 🎉",
        "tokenization",
        "café ümlauts 日本語 🚀",
        "https://example.com/path?q=1 x += 1;",
        "",
    ] {
        let ids = t.encode_fast(s, false).unwrap();
        let decoded = t.decode(ids.get_ids(), false).unwrap();
        assert_eq!(decoded, s, "round-trip failed for {s:?}");
    }
}

#[test]
fn count_equals_encoded_length() {
    let t = fixture();
    for s in ["a", "the quick brown fox", "こんにちは 世界 🎉 emoji"] {
        let n = t.encode_fast(s, false).unwrap().len();
        assert!(n > 0, "{s:?} should encode to ≥1 token");
        // Re-encoding is deterministic.
        assert_eq!(n, t.encode_fast(s, false).unwrap().len());
    }
}
