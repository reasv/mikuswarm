# Memory-retrieval model survey: re-rankers, late interaction, embedders (desk research, 2026-10-08)

**Status**: research note supporting `spec/MEMORY-RETRIEVAL.md` §5.0a–§5.0c. Not a design. Desk research only: no model was run and no API was called. Every figure is a published claim or an estimate, and must be re-measured on real hardware and the §9 labelled set before a choice is made (§9 below).

## Method and reading rules

- **Sources** are model cards, provider docs and policy pages, cited as `[n]` (list at the end; all accessed 2026-10-08).
- **Quality numbers** are vendor-reported unless marked *(3p)* (third party). Benchmarks run by different parties, or on different MTEB versions, are **not comparable**; the tables keep them apart.
- **Estimates** are marked *(est.)*. VRAM estimates are weights only (params × 2 bytes at fp16/bf16, × 1 at int8); activations for a 60 × 512-token batch add roughly 0.5–2 GB *(est.)*.
- **The workload** assumed throughout: ~60 candidates per query; diary blocks of ~200–512 tokens (~340 average); a query of a chat request plus a short conversation tail (~50–200 tokens); a corpus of ~4,000 blocks (~1.36M tokens), growing slowly. One re-rank call is therefore ~60 × (340 + ~150) ≈ 30k tokens.
- **ZDR** is classified as: *default* (no retention by default), *self-serve opt-in*, *by request / enterprise*, *unavailable*, or *unverified*. A route counts only if the provider's own docs say so for that route.

## 0. Data retention first (verified from provider docs)

Diary text derives from user messages, so this is the first filter. Self-hosted routes need no entry.

| Route | Serves (rerank / embed) | ZDR class | Evidence |
|---|---|---|---|
| **AWS Bedrock** | Cohere Rerank 3.5, Amazon Rerank 1.0 / Titan Text Embeddings V2, Cohere Embed v4, Nova embeddings | **default** | "Amazon Bedrock uses a zero data retention (ZDR) data security model. This means that by default, Amazon Bedrock does not store model inputs or outputs." The listed exceptions are named GPT and Claude chat models only [A1]. The account-level `data_retention_mode` switch is documented for the chat APIs, not for Rerank or embeddings [A2]. |
| **Fireworks** (serverless) | `qwen3-reranker-8b` / open embedders | **default** | "does not log or store prompt or generation data for any open models, without explicit user opt-in" [A3]. Embeddings and rerank are not named individually. |
| **DeepInfra** | Qwen3-Reranker 0.6B/4B/8B / Qwen3-Embedding, bge-m3, multilingual-e5 | **default** (not branded ZDR on the policy page) | "we do not store the data you submit to our APIs on disk"; "We do not log the content of your requests" [A4]. |
| **Voyage AI** (direct, voyageai.com) | rerank-3, rerank-3-lite, rerank-2.5 / voyage-4 family | **self-serve opt-in** | Opting out gives "zero-day retention of the data"; needs an org Admin and a payment method; cannot be reversed in the dashboard [A5]. Default is opted in. The MongoDB Atlas route states training opt-out only, with no retention statement [A6]. |
| **Nebius Token Factory** | / Qwen3-Embedding-8B | **self-serve opt-in** | Keeps inputs and outputs by default; ZDR is an account-profile toggle [A7]. |
| **OpenRouter** | `/api/v1/rerank`, `/api/v1/embeddings` | **unverified for these endpoints** | `provider.zdr` routes "only to endpoints that have a Zero Data Retention policy", but "ZDR enforcement only applies to provider routing for inference requests" [A8]. The live ZDR endpoint list includes the Fireworks `qwen3-reranker-8b` endpoint and no Cohere or Voyage rerank endpoint [A9] *(3p reading of the list, not exhaustive)*. Whether `zdr` is enforced on `/rerank` and `/embeddings` is not documented. |
| **Vercel AI Gateway** | Cohere rerank-v3.5 (via Bedrock) | ZDR on Pro/Enterprise plans, rerank-v3.5 only; "not currently available" for rerank-v4-pro [A10] | |
| **Cohere** (direct) | Rerank 4 Pro/Fast, 3.5 / Embed v4, v5 | **by request, enterprise only** | 30-day deletion of logged prompts; "we only allow ZDR for enterprise customers who can make additional commitments" [A11]. Through Bedrock or Azure, the cloud's terms apply instead [A11]. |
| **Azure AI Foundry** | Cohere rerank v4 / v3.5, OpenAI embeddings | **by request** (modified abuse monitoring via Limited Access) | [A12] |
| **OpenAI** (direct) | / text-embedding-3 | **by request** (30-day abuse retention by default; `/v1/embeddings` is ZDR-eligible after approval) | [A13] |
| **Google Gemini API** (AI Studio) | / gemini-embedding | **unavailable self-serve** (55 days) | [A14] |
| **Google Vertex AI** | Ranking API / gemini-embedding | **by request** for embeddings (exempt by default under a Master Agreement) [A15]; **ambiguous** for the Ranking API (no retention statement found) [A16] | |
| **Mistral** | / mistral-embed | **by request**, at Mistral's discretion; `/v1/embeddings` covered [A17] | |
| **Perplexity API** | / pplx-embed-v1, context-v1 | **unverified**: ZDR is stated for "the Chat Completions API" only; API terms have no retention clause [A18]. | |
| Jina (Elastic), Mixedbread, ZeroEntropy, Contextual AI, Pinecone Inference, SiliconFlow, Novita, NVIDIA trial API | | **unverified / ambiguous** | Jina stores data "to the extent required to provide the Services" [A19]; Mixedbread: "limited to what is necessary" on paid tiers [A20]; ZeroEntropy states no training, nothing on retention [A21]; the others published nothing usable. |

**Usable without a sales contract today:** Bedrock, Fireworks, DeepInfra, Voyage (after opt-out), Nebius (embeddings, after toggle). Aggregators add an unverified hop and should not be relied on for ZDR until their rerank/embeddings enforcement is documented.

## 1. Cross-encoder re-rankers, open weights

### 1.1 Specifications

| Model | Params | Max len | Languages | Licence | VRAM fp16 / int8 *(est.)* | ONNX | `/rerank` servers |
|---|---|---|---|---|---|---|---|
| cross-encoder/ms-marco-MiniLM-L6-v2 / L12-v2 | 22.7M / 33.4M | 512 | en | Apache-2.0 | <0.1 GB | official, fp32 + qint8 (avx2/avx512/vnni/arm64) | TEI, vLLM, llama.cpp, Infinity |
| cross-encoder/ettin-reranker-{17m,32m,68m,150m,400m,1b}-v1 (2026-05) | 17.6M–1.0B | 7,999 | en | Apache-2.0 | 150m: 0.3 / 0.15 GB | official, same variant set as MiniLM | vLLM (ModernBERT); TEI pending (PR) |
| BAAI/bge-reranker-v2-m3 | 568M (~300M non-embedding) | not stated on card | multilingual | Apache-2.0 | 1.1 / 0.6 GB | onnx-community: fp32/fp16/int8/q4; in Python fastembed 0.9.0 (fp32 2.27 GB, int8 0.57 GB) | TEI, vLLM, llama.cpp, SGLang, Infinity |
| Alibaba-NLP/gte-multilingual-reranker-base | 306M | 8,192 | 70+ | Apache-2.0 | 0.6 / 0.3 GB | onnx-community, 8 variants | TEI, vLLM (arch override), Infinity |
| Alibaba-NLP/gte-reranker-modernbert-base | 150M | 8,192 | en | Apache-2.0 | 0.3 / 0.15 GB | official | TEI, vLLM, llama.cpp |
| ibm-granite/granite-embedding-reranker-english-r2 | 150M | 8,192 | en | Apache-2.0 | 0.3 / 0.15 GB | none | TEI, vLLM |
| Qwen/Qwen3-Reranker-0.6B / 4B / 8B | 0.6B / 4.0B / 8.2B | 32k | 100+ | Apache-2.0 | 1.2 / 0.6; 8 / 4; 16.4 / 8.2 GB | community only (onnx-community q4 for 0.6B) | vLLM (needs `hf_overrides` or a converted seq-cls checkpoint), llama.cpp (use ggml-org GGUF; most community GGUFs score wrongly), SGLang. **Not TEI** (PRs open) |
| mixedbread-ai/mxbai-rerank-base-v2 / large-v2 | 0.5B / 1.5B (Qwen2.5) | 8k | 100+ | Apache-2.0 | 1.0 / 0.5; 3.1 / 1.5 GB | community int8 only | vLLM (override) |
| nvidia/llama-nemotron-rerank-1b-v2 | 1.24B | 8,192 | 26 evaluated | NVIDIA open model + Llama 3.2 terms, commercial use allowed | 2.5 / 1.2 GB | none | vLLM ≥0.14; NIM (production NIM needs an AI Enterprise licence) |
| zeroentropy/zerank-1-small / zerank-1 / zerank-2 | 1.7B / 4.0B / 4.0B | 32k | tagged en | Apache-2.0 since 2026-07 (zerank-1/2 were CC-BY-NC before) | 3.4 / 1.7; 8 / 4 GB | community int8 | vLLM (Qwen3 path) |
| lightonai/LightOn-rerank-{PW,LW}-{0.8B,2B,4B} (2026-07) | 0.85–4.5B | not stated | trained on en | Apache-2.0 | | | |
| jinaai/jina-reranker-v2-base-multilingual, v3, v3.5 (2026-07), m0 | 278M; 0.6B; 0.6B; 2.4B | 1,024; 131k; 131k; 10k | multilingual | **CC-BY-NC-4.0** | | v2 official | v2: llama.cpp, Python fastembed; v3: vLLM |
| ContextualAI/ctxl-rerank-v2-instruct-multilingual-1b/2b/6b | 1.3–6.8B | 32k | multilingual | **CC-BY-NC-SA-4.0** | | | |

Sources: model cards [R1]–[R14]; licence and file lists from the HF API [R15]; servers [S1]–[S6].
Not found as of 2026-10-08: an official Qwen3.5/Qwen4 text reranker, a BGE text reranker newer than v2/v2.5, open Voyage weights (the `voyageai/rerank-3*` repos hold config and tokenizer only) [R16].

**Licence filter.** The Jina and Contextual AI models are non-commercial. They are listed for reference only.

### 1.2 Published quality

The rankings disagree depending on who runs them. Each block below is one party's protocol.

| Model | Qwen card [R6]: MTEB-R / MMTEB-R / MLDR (top-100 of Qwen3-Emb-0.6B) | HF Ettin blog [R2] *(one protocol for all; publisher of Ettin)*: MTEB(eng,v2) retrieval nDCG@10 | Jina v3 card [R12]: BEIR / MIRACL |
|---|---|---|---|
| ms-marco-MiniLM-L6 | | .508 | |
| ettin-32m / 150m / 400m | | .578 / .599 / .609 | |
| bge-reranker-v2-m3 | 57.03 / 58.36 / 59.51 | .553 | 56.51 / **69.32** |
| gte-multilingual-reranker-base | 59.51 / 59.44 / 66.33 | | |
| gte-reranker-modernbert-base | | .584 | |
| granite-reranker-english-r2 | | .566 | |
| Qwen3-Reranker-0.6B | 65.80 / 66.36 / 67.28 | .594 | 56.28 / 57.70 |
| Qwen3-Reranker-4B | 69.76 / 72.74 / 69.97 | .637 | 61.16 / 67.52 |
| Qwen3-Reranker-8B | 69.02 / 72.94 / 70.19 | | |
| mxbai-rerank-base-v2 / large-v2 | | .592 / .612 | 58.40 / 55.32; 61.44 / 57.94 |
| jina-reranker-v2 (NC) | 58.22 / 63.73 / 39.66 | | 57.06 / 63.65 |

- **Multilingual is contested.** Qwen's run puts Qwen3-0.6B well above bge-v2-m3 on MMTEB-R; Jina's MIRACL run puts bge-v2-m3 first and Qwen3-0.6B last. An independent late-interaction benchmark (HAKARI, §3.3) ranks Qwen3-Reranker-0.6B above bge-v2-m3 on its multilingual set *(3p)* [L9].
- No public benchmark covers chat-derived text with slang, handles and mixed scripts. Only the §9 labelled set can settle the choice.
- Leaderboards that aggregate rerankers (Agentset, presenc.ai) were inconsistent with every vendor card and are not used here.

### 1.3 Latency

**Measured** (HF Ettin blog [R2]): natural-questions pairs (~150 tokens per pair *(est. from the dataset's character counts)*), `max_length=512`, sentence-transformers.

| Model | RTX 3090, bf16 + FlashAttention 2, pairs/s | i7-13700K, PyTorch fp32, pairs/s |
|---|---|---|
| ettin-17m | 9,008 | 267 |
| ms-marco-MiniLM-L6 / L12 | 4,234 / 2,847 | 144 / 76 |
| bge-reranker-base | 1,329 | 19.2 |
| ettin-150m / gte-modernbert / granite-r2 | 982 / 586 / 598 | 14.0 / 14.7 / 14.5 |
| bge-reranker-v2-m3 | 436 | 6.0 |
| mxbai-rerank-base-v2 | 221 | 3.5 |
| ettin-1b / mxbai-large-v2 | 189 / 69 | 2.1 / n/a |

No published consumer-GPU or CPU numbers exist for Qwen3-Reranker or zerank. NVIDIA publishes NIM/TensorRT figures for nemotron-rerank-1b at 512-token passages: 40 passages in 877 ms on an A10G, 267 ms on an A100 [S6].

**Estimated** for one call of 60 pairs × ~500 tokens (~30k tokens): Ettin throughput scaled by ~3.3× for pair length, cross-checked against 2 × non-embedding params × tokens. The server-CPU column assumes ONNX int8 on a many-core CPU with VNNI/AMX, at 2–4× the i7 PyTorch fp32 figure from int8 and 2–3× from cores. int8 can be *slower* than fp32 on CPUs without VNNI [S7].

| Class | 3090-class GPU *(est.)* | Many-core server CPU, ONNX int8 *(est.)* |
|---|---|---|
| 17–33M (MiniLM, ettin-17m/32m) | 50–80 ms | 0.15–0.6 s |
| 150–300M (gte-multilingual, gte-modernbert, ettin-150m) | 0.15–0.35 s | 1.5–5 s |
| 568M XLM-R large (bge-v2-m3) | 0.4–0.8 s | 4–10 s |
| 0.5–0.6B decoder (Qwen3-0.6B, mxbai-base-v2) | 0.8–1.2 s on the HF path (vLLM with prefix caching of the shared query prefix is probably faster) | 8–20 s |
| 1–1.5B | 0.6–3 s | impractical |
| 4B (Qwen3-4B, zerank-2) | 6–10 s | impractical |
| 8B | 12–20 s fp16 (16.4 GB, tight on 24 GB) | impractical |

Against the spec's per-member `timeout_ms = 1500`, only models up to ~0.6B fit on a 3090-class GPU, and only the 17–33M class fits on CPU. Cost scales linearly with candidates × tokens, so clipping passages (e.g. to 256 tokens) or cutting candidates moves a model up one row.

## 2. In-process runtime notes (Node, onnxruntime-node)

The built-in embedder runs on the npm `fastembed` package (2.1.0, onnxruntime-node 1.21.0). Reading the installed source and the registry:

- **No cross-encoder or late-interaction class** in fastembed-js 2.1.0 or 3.0.0 (only dense `FlagEmbedding` and SPLADE) [S8]. A built-in re-ranker therefore needs its own small ONNX path (onnxruntime-node plus a tokenizer, both already dependencies), reading the logits output. Python fastembed 0.9.0 has `TextCrossEncoder` (MiniLM, bge-reranker-base, **bge-reranker-v2-m3 fp32/int8 since 0.9.0**, jina v1/v2) and `LateInteractionTextEmbedding` (colbertv2.0, answerai-colbert-small-v1, jina-colbert-v2) [S9].
- **The 2.1.0 model download source is gone.** 2.1.0 fetches `storage.googleapis.com/qdrant-fastembed/<model>.tar.gz`, which now returns HTTP 403 (checked 2026-10-08). Existing caches keep working; a fresh data dir cannot download the default model. The package moved to `qdrant-labs/fastembed-js`: 2.1.1 (dist-tag `v2-hf`, 2026-09-30) and 3.0.0 (`latest`, 2026-09-24) download from Hugging Face [S8][S10]. Whether the HF weights are byte-identical to the old tarball is unverified, so a version bump should be treated as a possible model change (re-embed or compare vectors). *Resolved after this survey: the HF export is fp16 (66 MB) where the tarball was fp32 (133 MB), so they are not identical. The built-in embedder now loads BAAI's fp32 ONNX from a pinned commit on fastembed 3.0.0 and re-embeds (ARCHITECTURE.md §9d).*
- **Fixed prefixes.** `passageEmbed`/`queryEmbed` prepend the e5 prefixes `passage: `/`query: ` for every model. bge-small-en-v1.5 was trained with an optional query instruction and no passage prefix [E1], so today's index carries an untrained prefix. The effect is unmeasured. Any new model needs its own prefixes via `embed()`. *Resolved after this survey: a per-model prefix table with config overrides (ARCHITECTURE.md §9d).*
- **Pooling.** 2.1.0 pools by CLS only and reads `last_hidden_state`; 2.1.1/3.0.0 add mean pooling for custom models. No version supports last-token pooling (Qwen3, Jina v5, harrier) or a different output name (EmbeddingGemma's ONNX exposes `sentence_embedding`) [S8]. Custom models load from a directory with `tokenizer.json`, `tokenizer_config.json`, `config.json` and `special_tokens_map.json`.

## 3. Late interaction (multi-vector, MaxSim)

Late interaction encodes every token of a document into a small vector, ahead of time. At query time the query is encoded the same way and each query token takes its best match among a document's token vectors (MaxSim); the sum is the score. It sits between a single-vector embedder (cheap, coarse) and a cross-encoder (expensive, reads the pair jointly).

**The property that matters here:** document vectors are precomputed, so a query costs one short query encode plus MaxSim, which is CPU-cheap. A GPU is needed only for (re)indexing, which addresses the "VRAM held permanently" concern: load, index, unload. Like an embedder (and unlike a cross-encoder), an index is tied to one model, or to one shared-space family.

### 3.1 Perplexity pplx-embed late models

Verified against the cards and repo configs [L1][L2]; blog [L3].

| Item | pplx-embed-v2-late-0.6b | pplx-embed-v2-late-9b |
|---|---|---|
| Licence | MIT | MIT |
| Backbone | Qwen3.5, bidirectional; **hybrid** Gated DeltaNet linear attention with full attention every 4th layer (from `config.json`) | same family, 32 layers (24 linear + 8 full) |
| Params | 594M total incl. vision tower; **340M active** | 8.39B total; **7.4B active** |
| Per-token dim | 128 (Dense 1024→128, normalised); MaxSim | 128 |
| Max length (config; not on the card) | query 1,024, document 4,096 | same |
| Markers | `[Q] ` / `[D] `, added by `encode_query`/`encode_document`; punctuation masked from document vectors | same |
| Usage | sentence-transformers ≥ 6.0 `MultiVectorEncoder` (`encode_query`, `encode_document`, `similarity`), transformers ≥ 5.4 | same |
| PyLate caveat (card, verbatim) | "PyLate inserts Q/D markers at the second position; this model expects them first." | same |
| Shared space | The 0.6b can query a 9b-built index: ViDoRe v3 image 62.3 → 63.5, domain-specific +1.6 pp; 9b on both sides is still better [L3] | |
| Languages | tagged "multilingual"; training data "594 datasets in 46 languages" [L3]; no per-language results | |
| Published quality | ViDoRe v3 nDCG@10 image 62.3 / markdown 61.2; in-house 72-task "domain-specific" average 78.0 [L3] | 65.2 / 64.7; 81.3 |
| Text benchmarks | **None** (no BEIR, MIRACL or MTEB retrieval). A technical report is promised "later this year" [L3]. | |
| ONNX / GGUF | none | none |
| Servers | none documented: vLLM's ColBERT support covers BERT, ModernBERT, Jina-XLMR and LFM2; TEI and Infinity have no multi-vector support [L4][S1] | |
| VRAM *(est.)* | ~1.2 GB bf16 weights | 16.8 GB bf16 (stored fp32 at 33.6 GB, so it must be loaded in bf16 to fit 24 GB) |
| Release | blog dated 2026-10-07; HF repos last modified 2026-10-05 | |

- **Risk:** the Gated DeltaNet layers run on slow fallback paths unless fast linear-attention kernels are installed, and no CPU ONNX path is known for this bidirectional variant. ONNX Runtime 1.30 added a CUDA `GatedDeltaNet` op only [L5]. Today the pplx late models need a PyTorch sidecar, even for CPU query encodes.
- **pplx-embed-v1-late-0.6b** (MIT, 596M, Qwen3 backbone with custom code, 128-dim, max 511 tokens, no ONNX): BEIR 56.61, MIRACL 66.62 (card) [L6]; LightOn's re-run gives BEIR 56.11 *(3p)* [L7]. Its space differs from v2's (different backbone; inferred, not stated).
- **Contextual models** (chunks encoded with the whole document in view; relevant because diary blocks live in day files). These are single-vector per chunk, so they belong with embedders:
  - `pplx-embed-v2-context-9b-preview` (2026-09-30, MIT, 2048-dim with MRL to 1024, 32k document window, `<|chunk_sep|>` between chunks, mean per chunk). Preview: the card warns that weights and embeddings may change. Results are only on Perplexity's own context-bench [L8].
  - `pplx-embed-context-v1-0.6b` / `-4b` (MIT, 1024 / 2560-dim, 32k). The 0.6b ships ONNX. Both are on the Perplexity API at $0.008 / $0.05 per 1M tokens, but ZDR is unverified there (§0) [A18].
  - One encode per day file with blocks as chunks would give context-aware block vectors. Note that this re-embeds a whole day file whenever one block in it changes.
- **API:** no pplx late model is served by Perplexity, OpenRouter or any host found [A18][L3].

### 3.2 Established text ColBERTs

| Model | Params | Dim | Max doc / query | Languages | Licence | Text quality | ONNX |
|---|---|---|---|---|---|---|---|
| answerdotai/answerai-colbert-small-v1 | 33M | 96 | 512 / 32 | en | Apache-2.0 | BEIR 53.79 (card) | official, fp32 to q4; in Python fastembed |
| lightonai/GTE-ModernColBERT-v1 | 149M | 128 | 300 trained (8k usable) / 32 | en | Apache-2.0 | BEIR 54.67 | tag only |
| lightonai/LateOn (2026) | 149M | 128 | 300 / 32 | en | Apache-2.0 | BEIR 57.22 | tag, community quantised |
| **lightonai/mLateOn** (2026-07) | 307M (~115M non-embedding) | 128 | 8,192 / 8,192 | 9 named (en, fr, de, it, es, pt, sv, no, ar) | Apache-2.0 | BEIR 57.56, MIRACL 65.61 (LightOn); HAKARI macro 65.52, first of 11 *(3p)* | official `model.onnx` + `model_int8.onnx` |
| LiquidAI/LFM2-ColBERT-350M (and LFM2.5) | 353M | 128 | 512 / 32 | 8 (LFM2.5: 11 incl. ja, ko) | LFM Open License: free below $10M annual revenue | BEIR 54.50 *(3p, LightOn)* | GGUF (LFM2.5) |
| mixedbread-ai/mxbai-edge-colbert-v0-17m / 32m | 17M / 32M | 48 / 64 | 32k docs | en | Apache-2.0 | BEIR 49.0 / 52.1 | official fp32 + int8 |
| jinaai/jina-colbert-v2 | 559M | 128 | 8,192 | 94 | **CC-BY-NC-4.0** | BEIR 53.1, MIRACL 62.7 | via Python fastembed |
| colbert-ir/colbertv2.0 | 110M | 128 | 300 / 32 | en | MIT | BEIR ~50 | yes |

Sources: cards [L7][L10]–[L15]; HAKARI-Bench (independent, 2026-08) [L9].

- **Query length.** Most small ColBERTs were trained on 32-token queries, so a 50–200-token conversation tail is truncated or out of distribution. mLateOn (8k) and pplx (1k) accept the full tail.
- **sentence-transformers 6 `MultiVectorEncoder`** loads PyLate checkpoints and has an ONNX backend, but exports the transformer only. A Node port must apply the Dense projection, mask and normalisation itself [L16].

### 3.3 Late interaction against cross-encoders

HAKARI-Bench (independent, fixed candidate pool, quality only) [L9]: mLateOn beats bge-reranker-v2-m3 by +3.97 macro, gte-multilingual-reranker by +4.04 and jina-reranker-v2 by +5.01. Against Qwen3-Reranker-0.6B it trails on macro (66.21 vs 67.27) and leads on micro and on short queries. This is the only third-party comparison found. answerai-colbert-small claims to outperform cross-encoders of its size, with no numbers [L10].

### 3.4 Cost on this corpus *(all est.)*

~4,000 blocks × ~340 tokens ≈ **1.36M token vectors**; +0.34M per 1,000 blocks.

**Storage** (1.36M × dim × bytes). Token pooling ×2 keeps ~100% of retrieval quality and ×3 ~99% (sentence-transformers / PyLate figures) [L16].

| Dim | fp16 | int8 | fp16, pool ×2 | fp16, pool ×3 | fp16 per +1k blocks |
|---|---|---|---|---|---|
| 128 (pplx, mLateOn, LateOn) | 348 MB | 174 MB | 174 MB | 116 MB | 87 MB |
| 96 (answerai-small) | 261 MB | 131 MB | 131 MB | 87 MB | 65 MB |
| 64 / 48 (mxbai-edge 32m / 17m) | 174 / 131 MB | 87 / 65 MB | 87 / 65 MB | 58 / 44 MB | 44 / 33 MB |

Re-ranking 60 candidates touches ~60 × 340 × 128 × 2 B ≈ 5 MB, so vectors can live on disk or in SQLite blobs.

**Query time.**
- MaxSim over 60 candidates: 0.17 GFLOP (32 query tokens) to 0.78 GFLOP (150 query tokens): well under 10 ms on one core.
- Exhaustive MaxSim over the whole corpus: 11–52 GFLOP, reading ~348 MB: roughly 10–100 ms on a many-core CPU. At this corpus size, late interaction could also serve as a recall lane in addition to re-ranking.
- Query encode (~150 tokens): pplx 0.6b ~0.1–0.5 s on CPU (if a fast CPU path exists; see the risk above), 10–20 ms on GPU; pplx 9b 2–10 s on CPU, ~0.1 s on GPU with ~17 GB resident; mLateOn/LateOn 30–150 ms on CPU; answerai-small a few ms.

**Index time** (full re-index of 1.36M tokens):

| Model | 3090-class GPU | Many-core CPU |
|---|---|---|
| pplx 0.6b (≈0.93 PFLOP) | 1–2 min | 8–30 min |
| pplx 9b (≈20 PFLOP) | 25–35 min, bf16 | 3–11 h (impractical) |
| mLateOn / LateOn / GTE-ModernColBERT (0.3–0.4 PFLOP) | ~30 s | 4–8 min |
| answerai-small, mxbai-edge | seconds | 1–2 min |

A new diary block costs well under a second on CPU for every model except the 9b.

## 4. Re-rank APIs

| Route | Models (2026-10) | Quality claims (vendor) | Price | Billing unit | Max tokens | Rate limits | ZDR (§0) |
|---|---|---|---|---|---|---|---|
| **Voyage** (direct) | rerank-3, rerank-3-lite (2026-09-30), rerank-2.5(-lite) | rerank-3 +2.72% nDCG@10 over Cohere Rerank 4 Pro and +3.02% over Qwen3-Reranker-8B on 95 datasets; lite "matches 2.5" [P1] | $0.05/M (3, 2.5), $0.02/M (lite); first 200M tokens free [P1] | query tokens × docs + doc tokens | 32k per pair, ≤1,000 docs | Tier 1: 2,000 RPM, 2M TPM (4M lite) [P1] | self-serve opt-in |
| **AWS Bedrock** | Cohere Rerank 3.5, Amazon Rerank 1.0 (no Rerank 4) | none | Cohere 3.5: $2.00 per 1k queries [P2]; Amazon 1.0: not on the AWS page ($1/1k *(3p)*) | ≤100 docs per query; documents over ~500 tokens incl. query are split and billed as extra units | 4k (3.5) | not found | default |
| **Cohere** (direct) | Rerank 4 Pro / Fast, 3.5 | Rerank 4 claimed ahead of Voyage and Jina (chart only) [P3] | not on cohere.com/pricing; $2.00–2.50 per 1k searches *(3p)* | as Bedrock | 32k (v4), 4k (3.5) | trial 10/min; production 1,000/min [P3] | enterprise only |
| **DeepInfra** | Qwen3-Reranker 0.6B / 4B / 8B | Qwen card | 8B $0.05/M; 0.6B $0.01/M [P4] | tokens | 32k | not published | default |
| **Fireworks** | qwen3-reranker-8b (serverless) | Qwen card | $0.20/M [P5] | tokens | 40,960 | not published | default |
| **OpenRouter** `/api/v1/rerank` | Cohere 3.5 / 4 Pro / 4 Fast, Voyage 2.5 / 3 / 3-lite, Qwen3-Reranker-8B (Fireworks) [P6] | n/a | not exposed in the endpoint API | | | | unverified on `/rerank` |
| Jina (Elastic) | v3.5, v3, m0, v2 | v3.5 BEIR 63.20 | pricing page 404; ~$0.05/M *(3p)* | tokens | 131k | paid 500 RPM | unverified; the open weights are non-commercial |
| Google Vertex Ranking API | semantic-ranker default/fast-004 (005 preview) | none | $1 per 1k queries *(3p)* | ≤100 records per query | 1,024 per record | | ambiguous |
| ZeroEntropy | zerank-2, zerank-1(-small) | domain benchmarks, vendor-run | $0.025/M [A21] | bytes | | free 100 RPM | unverified (no-training only) |
| Mixedbread, Contextual AI, Pinecone Inference, Together (dedicated only), NVIDIA (trial only) | | | | | | | unverified or not applicable |

**Per-call cost** for one ~30k-token call *(est.)*: Voyage rerank-3 ≈ $0.0015 (lite ≈ $0.0006); DeepInfra Qwen3-8B ≈ $0.0015; Fireworks ≈ $0.006; Bedrock Cohere 3.5 ≈ $0.002–0.004 (1 unit, 2 if passages plus query exceed ~500 tokens and get split; passing a per-document token cap avoids the split).

**Latency:** no provider publishes latency for this payload. The only figures found are Jina's ~150 ms for 100 × 256-token documents and ZeroEntropy's 0.7–1.5 s p50 on SageMaker [P7][A21]. These need measuring from the deployment's own network.

## 5. Embedding models, open weights

Scores are kept by source. **Eng-R** = MTEB(eng, v2) Retrieval average; **ML-R** = MTEB(Multilingual, v2) Retrieval average. V = vendor; P = a third-party paper that evaluates many models ([E2] Google's EmbeddingGemma paper, [E3] Jina's v5 report). The live MTEB leaderboard could not be read, so no figure is a direct leaderboard read.

| Model | Params (compute) | Dim / MRL | Max len | Languages | Licence | Eng-R | ML-R | ONNX for CPU | Pooling, prefixes | Servers |
|---|---|---|---|---|---|---|---|---|---|---|
| bge-small-en-v1.5 (today) | 33M | 384 / no | 512 | en | MIT | 53.9 V(IBM table) | n/a | fastembed-js built-in | CLS; optional query instruction | TEI, vLLM, llama.cpp |
| **granite-embedding-97m-multilingual-r2** (2026-04) | 97M | 384 / no | 32,768 | 52 tuned, 200+ pretrained | Apache-2.0 | 50.1 V | 60.3 V | official, quint8_avx2 98 MB | CLS, no prefixes | vLLM, llama.cpp |
| granite-embedding-311m-multilingual-r2 | 311M | 768 / to 128 | 32,768 | same | Apache-2.0 | 52.6 V | 65.2 V | official, quint8 313 MB | CLS | vLLM, llama.cpp |
| multilingual-e5-small / base | 118M / 278M | 384 / 768 | 512 | ~94 | MIT | n/a | 49.3 / 52.7 P | official, qint8 118 / 279 MB | mean; `query: ` / `passage: ` | TEI, vLLM, llama.cpp |
| snowflake-arctic-embed-m-v2.0 | 305M (113M) | 768 / 256 | 8,192 | 74 | Apache-2.0 | n/a | 54.8 P | official int8 311 MB | CLS; `query: ` on queries only | TEI, vLLM, Ollama |
| gte-multilingual-base | 305M (113M) | 768 / elastic | 8,192 | 70+ | Apache-2.0 | n/a | 56.5 P | onnx-community int8 | CLS; remote code | TEI, vLLM (override); not llama.cpp |
| bge-m3 | 568M | 1024 | 8,192 | 100+ | MIT | n/a | 54.6 P | official fp32 2.27 GB | CLS, no prefixes | TEI, vLLM, llama.cpp, Ollama |
| EmbeddingGemma-300m (v1) | 308M (~100M transformer) | 768 / 512, 256, 128 | 2,048 | 100+ | Gemma terms, gated | ~55.7 P | 62.49 P | onnx-community q8 309 MB | mean; `task: search result \| query: ` / `title: none \| text: ` | TEI, vLLM, llama.cpp, Ollama |
| **EmbeddingGemma 2** (§5.1) | 740M multimodal; **270M text-only** | 768 / 512, 256, 128 | 8,192 | 100+ | Apache-2.0 | not published | not published | onnx-community text q8 314 MB, q4 175 MB | mean; same prompts as v1 | vLLM (nightly), llama.cpp, Ollama; **not TEI** |
| Qwen3-Embedding-0.6B | 596M | 1024 / 32–1024 | 32k | 100+ | Apache-2.0 | 61.83 V | 64.64 V | community (int8 614 MB) | **last-token**; instruction on queries | TEI, vLLM, llama.cpp, Ollama |
| Qwen3-Embedding-4B | 4.0B | to 2560 | 32k | 100+ | Apache-2.0 | 68.46 V | 69.60 V | n/a | same | same |
| Qwen3-Embedding-8B | 7.6B | to 4096 | 32k | 100+ | Apache-2.0 | 69.44 V | 70.88 V | n/a | same | same |
| harrier-oss-v1-270m / 0.6b (2026-03) | 270M / 0.6B | 640 / 1024 | 32k | 94 | MIT | no retrieval subscore published (ML mean 66.5 / 69.0 V) | | none official | last-token | TEI 1.9.4 |
| jina-embeddings-v5-text-nano / small (2026-02) | 239M / 677M | 768 / 1024, MRL | 8k–32k | multi | **CC-BY-NC-4.0** | 58.8 / 60.1 | 63.3 / 64.9 | yes | last-token | vLLM, llama.cpp |
| NV-Embed-v2, llama-embed-nemotron-8b | ~8B | 4096 | 32k | | **non-commercial** | | | | | |

Sources: cards [E1], [E4]–[E14]; papers [E2][E3]; runtime support [S1][S2][S3][E15]. Also screened: all-MiniLM-L6-v2, paraphrase-multilingual-MiniLM-L12-v2, static embeddings (static-retrieval-mrl-en-v1, potion; ~35–50 on retrieval, far below the rest), mxbai-embed-large/xsmall, nomic v1.5 and v2-moe, gte-modernbert, granite English r2. None beats the rows above for either role.

**VRAM** *(est., weights)*: ≤0.3 GB under 150M; ~0.6 GB at 300M; ~1.2 GB at 0.6B; ~8 GB Qwen3-4B; ~15 GB Qwen3-8B.

**CPU cost** *(est.; 2 × non-embedding params per token at 0.3–1 TFLOPS effective, fp32, unbatched; anchored on bge-base at ~3.7k tokens/s on an i7-13700K [E15])*. Multilingual models' large vocabularies cost memory, not compute.

| Compute class | Full re-embed, 4,000 × 400 tokens | One ~150-token query |
|---|---|---|
| ~21M non-embedding (bge-small) | 1.5–5 min | 5–20 ms |
| ~100–150M (granite-97m, mE5-small/base, arctic-m-v2, EmbeddingGemma text) | 6–20 min | 25–75 ms |
| ~300M (bge-m3, mE5-large) | 17–60 min | 65–200 ms |
| ~440M decoder (Qwen3-0.6B) | 25–80 min | 110–370 ms |

int8 on a VNNI/AMX CPU typically adds 1.5–3× *(est.)*.

### 5.1 EmbeddingGemma 2

Owner-supplied facts checked against the card [E10], the Google model card [E11], the ONNX repo [E12] and the GGUF repo [E13]:

- **Confirmed:** Apache-2.0 (the Gemma prohibited-use policy still applies [E11]); mean pooling then normalise, single vector; 740M total, ~270M for text; 768-dim with MRL to 512/256/128; 8,192 context (1,024-token sliding window); 100+ languages; MTEB Multilingual v2 61.36, English v2 68.46, code 78.68 (Mean(Task)); prompts `task: search result | query: ` and `title: none | text: `; fp16 "returns NaN or silently degraded embeddings", so use fp32 or bf16; GGUF at `ggml-org/embeddinggemma-2-GGUF` (BF16 558 MB, Q8_0 310 MB).
- **Against v1** (61.15 / 69.67 / 68.76): about equal on multilingual, **1.2 points lower on English**, +9.9 on code. No retrieval-only subscore is published for v2, so its retrieval rank is unknown.
- **Text-only loading** works: sentence-transformers with `vision_config` and `audio_config` set to None; the ONNX repo ships separate text, vision and audio graphs.
- **CPU path:** fastembed-js cannot load it as is (it reads `last_hidden_state`, and the export exposes `sentence_embedding`). It needs the same small direct onnxruntime-node path as a built-in re-ranker. The onnx-community fp16 export reports cosine 0.9998 against fp32 *(vendor of the export; unverified, possibly mixed precision)*; q8 reports 0.9997.
- **Servers:** TEI unsupported (request opened 2026-10-08); vLLM merged 2026-10-06, after the 0.31.0 release; llama.cpp from 2026-10-06; Ollama tags 270m–740m [E14].
- **Verdict:** a good candidate for the **built-in** (permissive, 8k context, multilingual, real int8 ONNX, MRL to 256 to keep the index small), at about 4–5× bge-small's CPU time *(est.)*. Not a primary: a 270M model is unlikely to match Qwen3-Embedding-4B, and the GPU serving stack is days old.

## 6. Embedding APIs

| Route | Model | Dim | Max input | $/1M tokens | Full re-embed (1.6M tokens) | Quality (vendor) | ZDR (§0) |
|---|---|---|---|---|---|---|---|
| DeepInfra | Qwen3-Embedding-8B / 0.6B; bge-m3; multilingual-e5-large | 4096 / 1024; 1024 | 32k; 8k; 512 | $0.01 [P8] | $0.016 | Qwen card (§5) | default |
| Fireworks | Qwen3-Embedding-8B; small open models | | | $0.10; $0.008–0.016 [P5] | $0.16 | | default |
| AWS Bedrock | Titan Text Embeddings V2 | 256/512/1024 | 8,192 | $0.02 [P9] | $0.03 | MTEB 60.37 (vendor, older version) | default |
| AWS Bedrock | Cohere Embed v4 | 256–1536 | 128k | $0.12 *(3p)* | $0.19 | | default |
| Voyage | voyage-4-large / 4 / 4-lite (2026-01) | 1024 (256–2048) | 32k | $0.12 / $0.06 / $0.02; 200M free | $0.19 / $0.10 / $0.03 | 4-large: RTEB +8.2% over Cohere v4, +3.9% over gemini-embedding-001 [P10] | self-serve opt-in |
| Nebius | Qwen3-Embedding-8B | 4096 | 32k+ | $0.01 *(3p)* | $0.016 | | self-serve opt-in |
| Cohere direct | Embed v5 Pro/Fast (2026-09-30), v4 | to 2048 | 128k | $0.08–0.12 *(3p)* | ~$0.19 | | enterprise only |
| OpenAI | text-embedding-3-small / large | 1536 / 3072 | 8,191 | $0.02 / $0.13 [A13] | $0.03 / $0.21 | older generation | by request |
| Google | gemini-embedding-2 (2026-04) | 128–3072 | 8,192 | $0.20 [P11] | $0.32 | MTEB multilingual 69.9 | Gemini API no; Vertex by request |
| Perplexity | pplx-embed-v1-0.6b / 4b, context-v1 | 1024 / 2560 | 32k | $0.004 / $0.03 [A18] | ≤ $0.05 | | unverified |
| Mistral | mistral-embed | 1024 | 8k | $0.10 *(3p)* | $0.16 | | by request |
| Jina | v5-text-small | 1024 | 32k | ~$0.05 *(3p)* | $0.08 | | unverified |

Cost is negligible on every route: a full re-embed costs under $0.35, and a few thousand query embeds a day cost well under $0.10 a day. Together AI offers no serverless embedding models [A22].

## 7. Shortlist per role

### Re-ranker

| Role | Shortlist | Reasoning |
|---|---|---|
| **GPU primary** | 1. **bge-reranker-v2-m3** via TEI. 2. **Qwen3-Reranker-0.6B** via vLLM or llama.cpp. 3. mxbai-rerank-base-v2 or gte-multilingual-reranker-base as the fast alternative. | bge-v2-m3: Apache, multilingual, best MIRACL in Jina's run, ~1.1 GB fp16, the best-supported model in every server, ~0.4–0.8 s per call *(est.)*. Qwen3-0.6B: stronger on Qwen's and HF's English runs, weaker on Jina's MIRACL, similar VRAM, ~0.8–1.2 s *(est.)*, and not in TEI. Both hold only ~1–3 GB of VRAM. The 4B and 8B models are estimated at 6–20 s per call on a 3090-class card, so they miss the 1.5 s member timeout unless measurement says otherwise. |
| **API** | 1. **Voyage rerank-3** (or rerank-3-lite) direct, after the zero-day-retention opt-out. 2. **Bedrock Cohere Rerank 3.5**. 3. **DeepInfra Qwen3-Reranker-8B**. | Voyage is the strongest vendor claim with self-serve ZDR and the cheapest route (~$0.0015 per call, 200M free tokens); it is proprietary, so it is the one API that could qualify as **primary** under the §5.0a rule if it measures meaningfully above the self-hosted models. Bedrock is ZDR by default but serves an older model with 4k context and unit billing. DeepInfra serves an 8B model too large to self-host within the timeout, ZDR by its docs. OpenRouter is not recommended until `zdr` enforcement on `/rerank` is documented. |
| **Built-in CPU** | 1. **mLateOn** (late interaction, int8 ONNX). 2. **ettin-reranker-32m-v1** (or 17m) cross-encoder, int8 ONNX. 3. ms-marco-MiniLM-L6-v2 as the baseline. | On CPU, the only cross-encoders that fit a ~1.5 s budget are the 17–33M English models (0.15–0.6 s *(est.)*); multilingual cross-encoders cost 1.5–10 s *(est.)*. mLateOn is multilingual, Apache, ships int8 ONNX, ranks first in the one independent late-interaction comparison (above bge-v2-m3 there), and costs ~30–150 ms per query on CPU *(est.)* because document vectors are precomputed. Its price is an index (116–348 MB) maintained like the built-in embedder's, with a 4–8 min full rebuild on CPU *(est.)*. Ettin-32m is the simplest stateless option but English-only. |

**Late interaction as a GPU option:** pplx-embed-v2-late (index with the 9b or 0.6b on the GPU, query with the 0.6b) would need no permanently held VRAM, but it has no text benchmarks, no ONNX and no serving support yet. Watch it, and re-check after the technical report.

### Embedder

| Role | Shortlist | Reasoning |
|---|---|---|
| **Primary** (second index) | GPU: 1. **Qwen3-Embedding-4B** (~8 GB). 2. Qwen3-Embedding-0.6B (~1.2 GB) if VRAM is the constraint. API: 3. **DeepInfra Qwen3-Embedding-8B** or **Voyage-4** (opt-out), or **Bedrock** Cohere Embed v4 / Titan V2 for an existing AWS account. | Qwen3: Apache, 32k, 100+ languages, Eng-R 68.5 / ML-R 69.6 (4B, vendor), supported by TEI, vLLM, llama.cpp and Ollama. Because the primary only needs an index rebuild plus one small query embed per session, an API primary avoids holding VRAM at negligible cost (§6), so it fits the decision rule well. With a cross-encoder downstream the embedder's job is recall, which reduces the gain from the largest models. |
| **Built-in CPU** | 1. **EmbeddingGemma 2** (text, q8 ONNX). 2. **granite-embedding-97m-multilingual-r2** (quint8 ONNX). 3. multilingual-e5-small. Baseline: bge-small-en-v1.5. | EmbeddingGemma 2: strongest multilingual quality in the ~100M-compute class, 8k context, Apache; needs a direct ONNX path. Granite-97m: same 384 width as today, CLS pooling, no prefixes, loads through fastembed-js `CUSTOM`, 32k context, ML-R 60.3; but lower English retrieval than bge-small (50.1 vs 53.9, vendor table). mE5-small is the conservative fallback. |

## 8. Open uncertainties

- **ZDR not verified:** OpenRouter on `/rerank` and `/embeddings`; Perplexity embeddings (stated for Chat Completions only); Jina, Mixedbread, ZeroEntropy, Contextual AI, Pinecone, SiliconFlow, Novita; Google Ranking API; whether Bedrock's `data_retention_mode` enforcement covers Rerank and embeddings (the default statement does); whether Cohere's enterprise ZDR covers Rerank. The Voyage opt-out is one-way in the dashboard.
- **Prices from third parties only:** Cohere direct per-search prices, Amazon Rerank 1.0, Google Ranking, Cohere Embed on Bedrock, Nebius, Mistral, Jina.
- **Quality:** no benchmark covers chat-derived text with slang and handles; multilingual reranker rankings conflict between vendors; no text benchmarks for pplx-embed-v2-late; no retrieval subscore for EmbeddingGemma 2 or harrier.
- **Latency:** every GPU and CPU latency for 60 × ~500-token pairs above is an estimate. No published numbers exist for Qwen3-Reranker on consumer GPUs, for any reranker on server-CPU ONNX int8, or for any API at this payload size.
- **Runtime:** whether fastembed-js 2.1.1/3.0.0's Hugging Face weights match the 2.1.0 tarball; the effect of the fixed `passage: `/`query: ` prefixes on today's index; CPU kernels for Gated DeltaNet (pplx late models).

## 9. What to measure before choosing

On the deployment's own hardware and the §9 labelled items (the spec's harness):

1. **Re-ranker quality:** hybrid alone vs each shortlisted cross-encoder vs mLateOn vs the API candidates, on recall@8 and nDCG of the labelled relevance, split by language and by slang- or handle-heavy items. This decides whether any API is "meaningfully better" (the §5.0a rule for an API primary).
2. **Re-ranker latency** for 60 real candidates and real query lengths: GPU p50/p95 per model and server (TEI vs vLLM vs llama.cpp), VRAM held at idle and peak; CPU int8 p50/p95 for the built-in candidates on the real CPU (check VNNI/AMX); API p50/p95 from the deployment's network.
3. **Passage clipping:** quality and latency at 256 vs 512 tokens per passage, and at 30 vs 60 candidates.
4. **Score calibration** per provider: a `min_score` for the fallback cutoff, and the score distribution of irrelevant candidates.
5. **Late interaction:** mLateOn index size with pooling ×2/×3, rebuild time on CPU, query-encode latency with the full conversation tail; exhaustive MaxSim as a recall lane against today's hybrid recall.
6. **Embedders:** recall@60 (the cross-encoder's ceiling) for bge-small (with and without the current `passage: ` prefix), EmbeddingGemma 2 q8 (at 768 and 256 dims), granite-97m, mE5-small and one primary (Qwen3-4B or an API); CPU re-embed time and query-embed latency for the built-in candidates.
7. **Contextual embedding:** whether per-day-file contextual chunk vectors (pplx context models) improve recall for terse diary blocks enough to justify re-embedding a whole day on each change.

## Sources (all accessed 2026-10-08)

**Data retention and APIs**
- [A1] https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html
- [A2] https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html ; https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html
- [A3] https://docs.fireworks.ai/guides/security_compliance/data_handling
- [A4] https://docs.deepinfra.com/account/data-privacy
- [A5] https://docs.voyageai.com/docs/faq
- [A6] https://www.mongodb.com/docs/atlas/tutorial/manage-organization-settings/
- [A7] https://docs.tokenfactory.nebius.com/legal/legal-quick-guide
- [A8] https://openrouter.ai/docs/guides/features/zdr ; https://openrouter.ai/docs/api-reference/embeddings
- [A9] https://openrouter.ai/api/v1/endpoints/zdr
- [A10] https://vercel.com/docs/ai-gateway/capabilities/zdr ; https://vercel.com/ai-gateway/models/rerank-v3.5/faq ; https://vercel.com/ai-gateway/models/rerank-v4-pro/faq
- [A11] https://cohere.com/data-usage-policy ; https://cohere.com/enterprise-data-commitments
- [A12] https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring ; https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/limited-access
- [A13] https://developers.openai.com/api/docs/guides/your-data
- [A14] https://ai.google.dev/gemini-api/docs/abuse-monitoring ; https://ai.google.dev/gemini-api/docs/zdr
- [A15] https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention ; https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring
- [A16] https://docs.cloud.google.com/generative-ai-app-builder/docs/data-governance
- [A17] https://docs.mistral.ai/admin/monitor-comply/zero-data-retention ; https://help.mistral.ai/en/articles/347612-can-i-activate-zero-data-retention-zdr
- [A18] https://docs.perplexity.ai/docs/resources/privacy-security ; https://docs.perplexity.ai/docs/embeddings/quickstart ; https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service
- [A19] https://jina.ai/legal/
- [A20] https://www.mixedbread.com/pages/privacy
- [A21] https://docs.zeroentropy.dev/models
- [A22] https://docs.together.ai/docs/zero-data-retention
- [P1] https://docs.voyageai.com/docs/reranker ; https://docs.voyageai.com/docs/pricing ; https://docs.voyageai.com/docs/rate-limits
- [P2] https://aws.amazon.com/bedrock/pricing/ ; https://docs.aws.amazon.com/bedrock/latest/userguide/rerank.html
- [P3] https://docs.cohere.com/docs/rerank ; https://docs.cohere.com/docs/rate-limits
- [P4] https://deepinfra.com/Qwen/Qwen3-Reranker-8B
- [P5] https://fireworks.ai/pricing
- [P6] https://openrouter.ai/docs/cookbook/evaluate-and-optimize/rag.md ; https://openrouter.ai/docs/client-sdks/typescript/sdks/rerank/README.md ; https://openrouter.ai/api/v1/models?output_modalities=rerank
- [P7] https://jina.ai/reranker/
- [P8] https://deepinfra.com/Qwen/Qwen3-Embedding-8B
- [P9] https://aws.amazon.com/blogs/aws/amazon-titan-text-v2-now-available-in-amazon-bedrock-optimized-for-improving-rag/
- [P10] https://blog.voyageai.com/ (voyage-4 announcement)
- [P11] https://ai.google.dev/gemini-api/docs/pricing

**Re-rankers**
- [R1] https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2
- [R2] https://huggingface.co/blog/ettin-reranker ; https://huggingface.co/cross-encoder/ettin-reranker-150m-v1
- [R3] https://huggingface.co/BAAI/bge-reranker-v2-m3
- [R4] https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base
- [R5] https://huggingface.co/Alibaba-NLP/gte-reranker-modernbert-base ; https://huggingface.co/ibm-granite/granite-embedding-reranker-english-r2
- [R6] https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
- [R7] https://www.mixedbread.com/blog/mxbai-rerank-v2 ; https://huggingface.co/mixedbread-ai/mxbai-rerank-base-v2
- [R8] https://huggingface.co/nvidia/llama-nemotron-rerank-1b-v2
- [R9] https://huggingface.co/zeroentropy/zerank-2 ; https://huggingface.co/zeroentropy/zerank-1-small
- [R10] https://huggingface.co/lightonai/LightOn-rerank-PW-0.8B
- [R11] https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual
- [R12] https://huggingface.co/jinaai/jina-reranker-v3 ; https://huggingface.co/jinaai/jina-reranker-v3.5
- [R13] https://huggingface.co/jinaai/jina-reranker-m0
- [R14] https://huggingface.co/ContextualAI/ctxl-rerank-v2-instruct-multilingual-1b
- [R15] `https://huggingface.co/api/models/<repo>` for each repo named
- [R16] https://huggingface.co/voyageai/rerank-3-lite ; https://huggingface.co/infgrad/Prism-Qwen3.5-Reranker-0.8B

**Servers and runtimes**
- [S1] https://github.com/huggingface/text-embeddings-inference (README, releases to v1.9.4, PR #835)
- [S2] https://docs.vllm.ai/en/latest/models/pooling_models/scoring/ ; https://docs.vllm.ai/en/latest/models/pooling_models/embed.html
- [S3] https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md ; https://github.com/ggml-org/llama.cpp/issues/16407 ; https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF
- [S4] https://docs.sglang.io/docs/supported-models/rerank_models
- [S5] https://github.com/michaelfeil/infinity ; https://github.com/ollama/ollama/issues/3368
- [S6] https://docs.nvidia.com/nim/nemo-retriever/text-reranking/latest/performance.html
- [S7] https://arxiv.org/pdf/2609.16085
- [S8] https://github.com/qdrant-labs/fastembed-js ; https://github.com/Anush008/fastembed-js ; the installed `fastembed@2.1.0` package source
- [S9] https://github.com/qdrant/fastembed (v0.9.0) ; https://qdrant.github.io/fastembed/examples/Supported_Models/
- [S10] https://registry.npmjs.org/fastembed ; https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-en-v1.5.tar.gz (HTTP 403)

**Late interaction**
- [L1] https://huggingface.co/perplexity-ai/pplx-embed-v2-late-0.6b
- [L2] https://huggingface.co/perplexity-ai/pplx-embed-v2-late-9b
- [L3] https://www.perplexity.ai/hub/blog/multimodal-embeddings-beyond-a-single-vector
- [L4] https://docs.vllm.ai/en/latest/models/pooling_models/specific_models/
- [L5] https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0
- [L6] https://huggingface.co/perplexity-ai/pplx-embed-v1-late-0.6b
- [L7] https://huggingface.co/lightonai/mLateOn ; https://huggingface.co/lightonai/LateOn
- [L8] https://huggingface.co/perplexity-ai/pplx-embed-v2-context-9b-preview ; https://www.perplexity.ai/hub/blog/contextual-embedding-beyond-the-gold-passage ; https://huggingface.co/perplexity-ai/pplx-embed-context-v1-0.6b
- [L9] https://huggingface.co/blog/hotchpotch/mlateon-multilingual-colbert-hakari-bench
- [L10] https://huggingface.co/answerdotai/answerai-colbert-small-v1
- [L11] https://huggingface.co/lightonai/GTE-ModernColBERT-v1
- [L12] https://huggingface.co/LiquidAI/LFM2-ColBERT-350M ; https://www.liquid.ai/lfm-license
- [L13] https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-17m ; https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-32m
- [L14] https://huggingface.co/jinaai/jina-colbert-v2
- [L15] https://huggingface.co/colbert-ir/colbertv2.0 ; https://huggingface.co/lightonai/Reason-ModernColBERT
- [L16] https://sbert.net/docs/multi_vector_encoder/usage/efficiency.html ; https://github.com/huggingface/sentence-transformers/releases/tag/v6.0.0

**Embedders**
- [E1] https://huggingface.co/BAAI/bge-small-en-v1.5
- [E2] https://arxiv.org/html/2509.20354
- [E3] https://arxiv.org/html/2602.15547
- [E4] https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2 ; https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2 ; https://huggingface.co/ibm-granite/granite-embedding-small-english-r2
- [E5] https://huggingface.co/intfloat/multilingual-e5-small
- [E6] https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0
- [E7] https://huggingface.co/Alibaba-NLP/gte-multilingual-base ; https://huggingface.co/BAAI/bge-m3
- [E8] https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- [E9] https://huggingface.co/google/embeddinggemma-300m
- [E10] https://huggingface.co/google/embeddinggemma-2
- [E11] https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2
- [E12] https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
- [E13] https://huggingface.co/ggml-org/embeddinggemma-2-GGUF
- [E14] https://ollama.com/library/embeddinggemma-2 ; https://github.com/vllm-project/vllm/pull/60254
- [E15] https://huggingface.co/blog/static-embeddings ; https://sbert.net/docs/sentence_transformer/usage/efficiency.html
- Also: https://huggingface.co/microsoft/harrier-oss-v1-270m ; https://huggingface.co/jinaai/jina-embeddings-v5-text-small ; https://huggingface.co/nvidia/NV-Embed-v2 ; https://huggingface.co/nvidia/llama-embed-nemotron-8b
