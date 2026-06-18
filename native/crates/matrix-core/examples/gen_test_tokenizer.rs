//! Regenerates the synthetic byte-level BPE test fixture used by the tokenizer
//! tests (`tests/tokenizer.rs` and the TS-side `test/tokenizer.test.ts`).
//!
//! This is NOT the GLM tokenizer — it is a tiny, deterministic byte-level BPE
//! trained on a fixed in-repo corpus, just large enough to exercise the loading +
//! encode/decode/count + `add_special_tokens` machinery with lossless round-trips.
//! The real GLM `tokenizer.json` is operator-supplied at runtime (see
//! spec/TOKENIZER-SWAP.md §5.2 and `[tokenizer].glm_tokenizer_path`).
//!
//! Run from the crate dir to refresh the committed fixture:
//!   cargo run --example gen_test_tokenizer -- tests/fixtures/byte-bpe.tokenizer.json
use std::io::Write;

use tokenizers::models::bpe::{BpeTrainer, BPE};
use tokenizers::pre_tokenizers::byte_level::ByteLevel;
use tokenizers::processors::template::TemplateProcessing;
use tokenizers::{AddedToken, Tokenizer};

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Small but varied corpus so the BPE learns merges (counts < byte length).
    let corpus = "\
the quick brown fox jumps over the lazy dog\n\
hello world hello there general\n\
tokenization tokenizer tokens token tokenize\n\
the the the and and and of of of to to to\n\
GLM and gpt and bpe and byte level encoding\n\
こんにちは 世界 🎉 emoji and multibyte text 🚀\n\
https://example.com/path?q=1 url and code x += 1;\n\
repeat repeat repeat repeat merge merge merge\n"
        .repeat(40);

    let dir = std::env::temp_dir().join("miku-gen-test-tokenizer");
    std::fs::create_dir_all(&dir)?;
    let corpus_path = dir.join("corpus.txt");
    std::fs::File::create(&corpus_path)?.write_all(corpus.as_bytes())?;

    // add_prefix_space=false so decode(encode(x)) is an exact round-trip.
    let byte_level = ByteLevel::new(false, true, true);

    let mut tokenizer = Tokenizer::new(BPE::default());
    tokenizer.with_pre_tokenizer(Some(byte_level));
    tokenizer.with_decoder(Some(byte_level));

    let mut trainer: tokenizers::models::TrainerWrapper = BpeTrainer::builder()
        .vocab_size(512)
        .min_frequency(0)
        .special_tokens(vec![
            AddedToken::from("<s>", true),
            AddedToken::from("</s>", true),
        ])
        .initial_alphabet(ByteLevel::alphabet().into_iter().collect())
        .show_progress(false)
        .build()
        .into();

    tokenizer.train_from_files(&mut trainer, vec![corpus_path.to_string_lossy().into_owned()])?;

    // BOS-style post-processor: adds <s> only when add_special_tokens=true, mirroring
    // GLM's BOS/[gMASK]/<sop> so tests can assert the add_special_tokens=false contract.
    let bos_id = tokenizer.token_to_id("<s>").expect("<s> in vocab");
    let post = TemplateProcessing::builder()
        .try_single("<s> $A")
        .unwrap()
        .special_tokens(vec![("<s>", bos_id)])
        .build()?;
    tokenizer.with_post_processor(Some(post));

    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "tests/fixtures/byte-bpe.tokenizer.json".into());
    tokenizer.save(&out, false)?; // pretty=false → compact, smaller fixture
    println!("saved fixture -> {out} (bos_id={bos_id})");
    Ok(())
}
