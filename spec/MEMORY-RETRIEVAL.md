# Memory retrieval: judged candidates, readable excerpts, operator filters

**Status**: PROPOSAL, draft rev 7 (2026-10-08: owner answers, §12; filters, §7; cross-encoder and embedder provider chains, §5.0a–c; late interaction, §5.0d; one passage per judgement, §5). Not implemented.
**Supersedes**: spec/DECISION-MODEL.md §5.5, first half (re-ranking and richer excerpts). Summary pre-expansion (the second half of §5.5) stays out of scope.
**Builds on**: ARCHITECTURE.md §9c (diary memory, recency layer), §9d (hybrid search, `recall_memory`, auto-retrieval), §8h (decision engine, chains, calibration), spec/DECISION-MODEL.md §3 (client, fits, billing).
**Target ARCHITECTURE.md home once implemented**: §9d (auto-retrieval, `recall_memory`), §9c (recency layer filtering), §8h (the `memory` decision point).

## 0. Scope and context

The agent's long-term memory, apart from the hierarchical summaries, is the diary. It is a set of markdown files (`memory/*.md`) written in the persona's voice, cross-channel, tracked in git with the workspace. It keeps that form for continuity with the memory it inherited: months of entries predate the current diary pipeline, and moving to another format would have meant a lossy backfill. The diary is unstructured and editable by ordinary file tools, so nothing guarantees structure or consistency. People are referred to inconsistently, usually by display names that change. The user profile system is rarely used and legacy.

**The root cause of weak memory is the memory format itself.** A better system would store discrete, structured units tagged with the users involved, so retrieval could be scoped to people. **That redesign is out of scope here.** This spec improves only what can be improved without changing the corpus: how memory is retrieved, judged, excerpted and filtered before the agent sees it.

## 1. Measurements (one production deployment, 2026-10-08)

Collected from metadata and pattern counts only; no memory or message content was read.

- **Corpus.** About 4,000 chunks (one per diary block), 336 tokens on average (max 512), ~200 files spanning about seven months. Embeddings: the local default `bge-small-en-v1.5` (384-dim, English).
- **Auto-retrieval is effectively unconditional.** In the last 7 days the `<retrieved_memory>` block was present in 99% of chat sessions. 80% of those carried the maximum of 5 items (3 topical + 2 user-lane), so the `min_score` floor almost never removes anything.
- **Snippets are too short to be comprehensible.** Each item is the first 200 characters of its block (`makeSnippet` in `src/retrieval/search.ts`), about 50 tokens, and much of that is overhead:
  - the citation repeats the date (once in the file name, once as a separate field);
  - the snippet often starts with the block's own heading residue (`## Evening Events (~7:33 PM)`).

  The owner reviewed live blocks: some items are fine, but many are not understandable on their own. They read as noise: fragments too short to tell what was being discussed, so the agent cannot judge whether to look further. Being the head of the block rather than the matching part is a secondary issue. Diary blocks are often lists of loosely related events, so even a longer excerpt of scattered facts is hard to use unless it is relevant. Relevance judging (§5) and longer, cleaner excerpts (§6) address it together.
- **The agent almost never follows up.** Over 30 days and ~6,100 chat sessions:
  - `search_memory` was used in 0.5% of sessions, `recall_memory` in 0.4%, and a diary file was opened in 0.1%.
  - 0.8% of sessions did any manual memory lookup at all.
  - For comparison, `search_messages` was used in 3.3%. `user_profile_read` was used in 0.1%.
- **The user lane has no rename history on Matrix.** Alias expansion (`buildTriggerUsers`, ARCHITECTURE.md "Retrieval alias expansion") only works for senders with a `username`, so Matrix users contribute their current display name only.

## 2. Problems in the current design

1. **The snippet is the block head, not the match.** It is too short and usually the wrong part, so even a relevant hit gives the agent too little to decide whether to look further.
2. **Fixed slots, always filled.** The hybrid score is a similarity, not a relevance judgement. Raising budgets or result counts only adds noise, which is why they were kept tiny.
3. **The query is the trigger body alone.** A terse follow-up ("what about him?", "same as last time") has nothing to match on. The conversation and the reply target are not used.
4. **No relevance decision.** Nothing decides whether a candidate actually bears on the conversation, so "none" is never the answer.
5. **No way to hide undesired memories** short of editing or deleting files. Example: entries describing behaviour the operator no longer wants. Seeing them reinforces the behaviour in a loop, and they keep being written, so one-off deletion does not solve it.

## 3. Design overview

Per interactive session build:

```
query set ─► wide candidate recall (hybrid + participant tags + late-interaction lane, fused, ~60 blocks)
          ─► drop blocks hidden by operator filters (§7)
          ─► late-interaction scoring cuts to ~20 (precomputed token vectors, CPU-cheap, §5.0d)
          ─► cross-encoder ranks and eliminates to ~8 (§5.0a)
          ─► decision model as the final filter, one passage per request (§5)
          ─► excerpt each kept block (whole block, or a match-centred window, §6)
          ─► pack into <retrieved_memory>: 0..N items within a token budget
```

- The block may be empty, and then it is omitted entirely.
- The same filters apply to every surface that shows diary text to the agent (§7.3).
- Recall and the re-rank stages start at launch, in parallel with routing; the decision filter follows them (§8).

## 4. Candidate recall (wider, cheaper to be wrong)

The re-ranker makes recall the goal. The hybrid search's job becomes "do not miss the relevant block", not "rank it first".

- **Queries** (each a hybrid search; results unioned by chunk):
  1. The trigger text, as today.
  2. The trigger plus its reply target's text, when it is a reply.
  3. The conversation window: the text of the last `auto.query_messages` (default 6) messages, as one semantic query.
- **User lanes** (lexical, as today) for every human participant that matters:
  - the requester(s);
  - the reply target's author;
  - users mentioned in the trigger.

  Each lane uses the user's current name plus up to 4 earlier names. **New, generic:** for providers without usernames (Matrix), earlier names come from the distinct `sender_display_name` values that sender id has had in the timeline, newest first.
- **Floor and cap.** `auto.candidate_min_score` (default 0.25, below today's 0.45) and `auto.candidates` (default 60, widened for the re-rankers, §5.0), with user-lane hits reserved up to `auto.user_lane_candidates` (default 8).
- **Exclusions**: blocks already in the recency layer (as today), and blocks hidden by a filter (§7).
- **The candidate unit is the whole chunk** (one diary block, at most 512 tokens).

## 4a. Participant tags from provenance (mechanical, no model)

The diary has no structural author or participant tags, but **every diary block written by the pipeline has exact provenance**. It is generated from one level-1 summary range (§9c "Trigger & unit"): one room, a time range, a known set of source events. Those events carry stable sender ids.

So the indexer attaches a `participants` list to each such chunk: the human sender ids of its source range, with message counts.
- **Exact.** It reads ids, not names, so it is immune to display-name changes.
- **Free.** It needs no model call; it is a join over data already stored (the block header's room and time range locate the range, the `summaries` lineage gives its events).
- **Backfill** for existing blocks is the same join, run once.
- **Legacy blocks** (imported, header-less) get no tags and keep relying on name matching.

These are *presence* tags: the user took part in the conversation the entry was written from. That is not the same as the entry being about them, but it is the right scope for "my history with this person". The user lane (§4) becomes "blocks whose source conversation included this user id", with name matching as a second signal. `recall_memory` gains an optional `user` argument that scopes a manual search the same way.

**Person-cued recall** (owner, 2026-10-08; one more heuristic): this lane needs no text match.
- For each human active in the conversation (the requester, the reply target's author, mentioned users, and the senders in the last `auto.query_messages` messages), take the newest `auto.person_recent` (default 2) tagged entries they took part in, outside the recency layer. The total is capped at `auto.person_recent_max` (default 8).
- These candidates **skip the re-rank cut** and go straight to the judge. A message with nothing to match ("hey, how's it going") would otherwise score them out. The judge decides whether each is worth having in mind.
- Within the user lanes, ranking follows the query's similarity when the query has content, and recency otherwise.

## 5.0 Ranking and relevance methods considered

The decision model is one option among several. They differ in what they answer (a ranking vs a keep/drop decision), where they run, and whether they can see the conversation.

| Method | What it gives | Cost and latency | Data path | Notes |
|---|---|---|---|---|
| Hybrid score as today (vector + BM25, decay) | similarity rank | free, ms | local | Not a relevance decision; the floor does not bite (§1). |
| Fusion and retrieval tuning: reciprocal rank fusion instead of the weighted sum, MMR on, multiple queries (§4) | a better candidate set | free, ms | local | Cheap wins for recall. Does not decide relevance. |
| Better embedding model (multilingual, larger, longer context) | better semantic recall | one re-embed of the corpus; per-query embed | local or remote (remote needs ZDR) | Today's model is small, English-only and capped at 512 tokens. Worth an offline comparison. |
| Local cross-encoder re-ranker (e.g. the open bge-reranker family, run on ONNX like today's embedder) | a query–passage relevance score per candidate | to be measured: a large multilingual model over 24 passages of ~400 tokens likely costs hundreds of ms to seconds of CPU per build, and tens of ms on a GPU; a small English model is much cheaper but weaker | local, no data leaves | Scores a query against a passage. It does not read the conversation or the participants, and needs a calibrated cutoff. |
| Late interaction (ColBERT-style multi-vector: one small vector per token, scored by MaxSim; e.g. pplx-embed-v2-late, released 2026-10-07) | a query–passage score that sees token-level matches, usually between single-vector similarity and a cross-encoder in quality | the passage side is encoded once at index time and stored; per query, one short query encode plus MaxSim, milliseconds on CPU even over the whole corpus | local (or a remote encoder with ZDR for indexing) | A re-ranker whose expensive half is precomputed. Also usable as a recall lane. The index is tied to one model, like an embedder (§5.0d). |
| Hosted re-rank APIs | as above | ~100–300 ms, per-search pricing | remote; ZDR status per provider must be verified | Same limits as the local cross-encoder. Adds a vendor. |
| Decision model (§5) | a calibrated keep/drop decision per passage, with conversation, request and participants in state | ~1–1.5 s, ~$0.0005 per session | remote, ZDR routes exist | Judges "relevant to this conversation", not "similar to the query". Same machinery as the filters (§7) and other points. |
| Listwise re-ranking by a chat LLM (rank or select from the candidate list) | ranking plus selection | seconds, cents per call | remote, needs a ZDR model | The strongest reasoning, but the slowest and most expensive per session. Better as an offline labeller (§9) than on the hot path. |
| Query rewriting / hypothetical-entry generation (an LLM writes the search query or a fake diary entry to embed) | better recall on terse follow-ups | an LLM call per session | remote, needs a ZDR model | Addresses problem 3 differently from §4's conversation-window query. |
| Provenance participant tags (§4a) | exact "was in the conversation" tags | free | local | Fixes the user lane at the source, not per query. |

**Segmentation is already solved** (owner, 2026-10-08). The hardest part of dense retrieval is usually cutting documents into units: windows split a fact across two chunks or bury it among unrelated text. Here the memories are nearly always discrete blocks, one diary entry from one summary range, with a header naming the room and time. Every method in this table therefore scores a whole, natural unit:
- no sliding windows or overlap;
- per-block token vectors for late interaction;
- whole-block pairs for the cross-encoder;
- whole-block excerpts (§6).

Methods built to repair segmentation (contextual chunk embeddings, parent-document retrieval) buy little here. Blocks longer than a model's input window are the only exception, and their share is to be measured (§5.0c).

**The pipeline** (owner, 2026-10-08):

```
wide recall (§4, ~60 blocks) + exhaustive late interaction over recent blocks ─► late interaction scores and cuts (§5.0d) ─► cross-encoder ranks and eliminates (§5.0a)
   ─► the few survivors ─► decision model as the FINAL FILTER, one passage per request (§5) ─► excerpts (§6)
```

- **The cross-encoder ranks and eliminates.** It reads each query–passage pair together, so it is far better at "does this passage answer this" than vector or BM25 similarity. Because each pair is cheap, recall can widen to ~60 candidates, and most are cut here.
- **The decision model is the final filter, not a re-ranker.** It only sees the cross-encoder's survivors, one passage per request, with the conversation, the reply target and the participants in view. It keeps or drops each, and "none" is a valid outcome.
- **The fallback improves too.** When the decision chain is down, the cross-encoder's calibrated cutoff selects the items in place of hybrid similarity.
- **Late interaction: exhaustive over recent blocks, a re-ranker beyond** (owner, 2026-10-08, §5.0d). Passage token vectors are computed in the background, where latency does not matter. At query time it costs one short query encode plus a native matrix product, so the newest blocks are scored exhaustively and older recall candidates are re-scored. It cuts the list before the cross-encoder, the expensive per-pair stage, and is a strong rung on its own when no cross-encoder is available.
- **Every stage is optional and degrades in order:**
  - no late interaction → the cross-encoder sees the recall set;
  - no cross-encoder → the late-interaction top ~8, or the hybrid top ~12, go to the decision model;
  - no decision model → the last scorer's calibrated cutoff;
  - none → the hybrid ranking with the higher floor.
- **Measure offline first** with the §9 harness, scored against ZDR-labelled relevance:
  - the combinations: hybrid alone, late interaction alone, cross-encoder alone, late interaction → cross-encoder, each with and without the final filter;
  - the embedding axis (§5.0b).

  The measurements set cut-offs and `top_n`, and decide whether both re-rankers earn their place. They do not change the shape.

### 5.0a The cross-encoder: a provider chain

Re-ranker scores are not stored anywhere, so providers can be swapped per request. That makes a fallback chain straightforward, as with chat models.

**Trade-offs between the kinds of provider** (owner, 2026-10-08):

| Provider | Quality | Latency | Standing cost | Risks |
|---|---|---|---|---|
| Self-hosted GPU (an inference server with a `/rerank` endpoint) | best open models at full size | lowest, typically tens of ms | VRAM held permanently, even though GPU time is small | the GPU may be needed for other work; another service to run |
| API (hosted re-rank) | can include proprietary or too-large-to-host models | network round trip plus long-tail latency; parallel requests do not slow it, but rate limits can | per-call cost, nothing idle | another vendor, another outage source; must be ZDR (diary text derives from user messages), and free routes usually are not |
| CPU, in process (ONNX) | smaller models, likely worse | slower, possibly much slower for large models | none worth counting: spare cores, memory to spare | none external |

**Decision rule.**
- **Primary: self-hosted GPU,** unless an API exists that is ZDR, meaningfully better than anything self-hostable (proprietary, or too large to host), and acceptable in cost and latency. Only if all of that holds does the API become primary.
- **API otherwise a fallback** for when the GPU is busy or down.
- **CPU always the last rung.** It is always available, so the GPU's memory can be reclaimed for other work at any time.

**Built-in CPU re-ranker (proposal):** ship it the way the embedder ships today.
- A small model that is lazy-loaded on first use, with weights cached under the data dir and the download in the background (never on a trigger).
- Present on every deployment that enables `[retrieval.rerank]`, even with no other provider configured. So a deployment can turn re-ranking on without running anything else, and a GPU outage never removes it.
- Pick the model by measured quality per CPU-millisecond (§5.0c).

**Config:**

```toml
[retrieval.rerank]
enabled = true
chain = ["gpu", "api", "builtin"]   # tried in order; health and fallback as for chat models
top_n = 8                           # survivors passed to the filter
timeout_ms = 1500                   # per member; a slow member falls over to the next

[retrieval.rerank.providers.gpu]
kind = "remote"                     # POST {endpoint}/rerank, open inference-server shape
endpoint = "${RERANK_GPU_URL}"
model = "..."
self_hosted = true                  # or zdr = true for an external API

[retrieval.rerank.providers.api]
kind = "remote"
endpoint = "..."
model = "..."
zdr = true                          # required for a non-self-hosted remote provider

[retrieval.rerank.providers.builtin]
kind = "local"                      # in-process ONNX, CPU; the shipped default model
```

- **Per-provider calibration.** Scores from different models are not comparable, so the fallback cutoff (`min_score`) and any score-based logic are calibrated per provider, like per-member decision calibration.
- **Taking the GPU away.** Stopping or pausing the GPU server is enough: its health fails and the chain moves on. To skip it without waiting for a failure, set `enabled = false` on that provider and reload the config.
- **Query.** The request plus a short conversation tail, clipped to the model's input budget alongside the passage.
- **Placement.** The stage starts at launch, in parallel with routing. Only the filter waits for it.

### 5.0b The embedding model: the same trade-offs, plus an index constraint

The embedder has the same three kinds of provider and the same decision rule. One constraint changes the fallback design: **query vectors and document vectors must come from the same model** (the single-active-model invariant, ARCHITECTURE.md §9d). Swapping embedders per request, the way the re-ranker does, would compare vectors across spaces.

- **Proposal: two indexes.**
  - The **built-in CPU embedder's index is always maintained** (cheap: a few thousand chunks).
  - An optional **primary embedder** (GPU or API) keeps a second vector index (`memory_vec_<model>`).
  - A query uses the primary index when its embedder answers in time, otherwise the built-in index.
  - Lexical search is unaffected either way.
- **Re-embedding** on a primary-model change works as today, for that index only. The built-in index keeps serving meanwhile.
- **Quality.** Today's built-in model is small, English-only and capped at 512 tokens. Choose the built-in by measured quality per CPU-millisecond and language coverage, and the primary by the same decision rule as the re-ranker (§5.0c).
- **With a cross-encoder in the pipeline,** the embedder's job is recall, not precision. A stronger embedder matters less than before, but still sets the ceiling on what the cross-encoder can see.

### 5.0d Late interaction: exhaustive over recent blocks, a re-ranker beyond

A late-interaction model encodes text into one small vector per token (e.g. 128 dimensions). The score of a passage for a query is the sum, over query tokens, of each one's best match among the passage's tokens (MaxSim). The passage side does not depend on the query, so it is computed once at index time and stored.

**Indexing is not latency-critical; query time is the whole budget** (owner, 2026-10-08). The recency layer (ARCHITECTURE.md §9c) shows the newest diary blocks in full at all times, so a block only needs to be retrievable once it leaves that layer.
- **How long the buffer is depends on the deployment:** the layer's token budget, block length, and how many entries the agent writes (more channels mean more entries). An operator can judge it.
- **One busy deployment, measured 2026-10-08:**
  - A 4,000-token layer holds about 12 blocks.
  - That agent writes ~12–39 blocks a day (typically ~20, ~5–8k tokens), with one peak day of 73 and at most 9 in one hour.
  - So the buffer is about 15 hours normally, and about an hour in the worst burst.
- **Seconds per block is therefore ample.** Indexing runs in a low-priority background worker, on CPU, using the same model as the query side, and never competes with query-time work.
- **Index lag is a metric.** Startup and the indexer warn if a block has left the recency layer without vectors.
- **The index** is a token-vector store (`memory_late_<model>`, one blob per chunk, keyed by chunk hash like the vector index).
  - Size: about 350 MB at fp16 for ~4k blocks of ~340 tokens, half at int8, less again with token pooling.
  - **The index is tied to one model,** as for embedders (§5.0b). A family that shares one space counts as one model: pplx-embed-v2-late's 0.6B model can query an index built by its 9B model.

**Query-time cost has two parts, and both must fit the latency budget:**
1. **Query encoding,** in proportion to the query model's size times the query's tokens.
   - A model of a few hundred million active parameters over a few dozen tokens is expected to take tens of milliseconds on CPU (to be measured).
   - **A multi-billion query model needs a GPU at query time:** ~17–18 GB for a 9B in bf16/fp16, nearly a whole 24 GB card, held permanently. That is acceptable only for a meaningful gain, not a marginal one (owner, 2026-10-08).
   - **A large model on the index side is an option, if it is worthwhile** (owner). Index time is off the hot path (above), so the large model's cost is paid in the background:
     - seconds per block on CPU for increments, within the buffer;
     - a one-off rebuild of hours on CPU, or about half an hour on a GPU that is released afterwards.
     A small model in the same space then queries that index on CPU.
   - **Published gain of this asymmetric pair** (pplx-embed-v2-late: 0.6B queries on a 9B index, against 0.6B on both sides): ViDoRe v3 image 62.3 → 63.5, and +1.6 points on Perplexity's domain-specific set. 9B on both sides is better still, but needs the GPU at query time.
   - **The bar is a meaningful, useful benefit, not a marginal one** (owner, 2026-10-08). A large model can have 10–20 GB of memory on a server that has it, but that is not free.
   - **A shared-space pair makes the query side a provider chain over one index.** Index with the large model. The query encoder chain is then the large model on the GPU first, with the small model on CPU as the always-ready fallback. Both are valid against the same index, so moving between them, or dropping the GPU member, never touches the index.
   - **Rebuilding is cheap anyway.** A full re-index takes minutes to about half an hour on one GPU. Moving to an unrelated model costs one rebuild, and the offline comparison (§5.0c) can index the whole corpus with many candidate models.
   - **Whether it is worthwhile is a measurement on the §9 set.** Compare small/small, small-query/large-index, and the best small CPU alternative (e.g. an ONNX late model).
     - **Weigh the gain against the costs:** the large model's index-time compute, and the serving path. Today the pplx late models have no ONNX export and use linear-attention layers with no known fast CPU kernel, so even the small query encoder may need a PyTorch sidecar (see the survey).
2. **MaxSim,** in proportion to query tokens × document tokens scored × dimensions.
   - Exhaustive over ~1.4M document tokens with a 32-token query is about 11 GFLOP. That is tens of milliseconds as a vectorised native matrix product across cores, and seconds in plain JavaScript.
   - So scoring runs **off the event loop (a worker thread) on a native matrix path** (the ONNX runtime the embedder already uses, or equivalent), with the window's vectors resident in memory.

**Compressed vectors and a fused kernel: TurboQuant** (owner, 2026-10-08).

*What it is.* TurboQuant applies a random rotation, then quantises each coordinate to 2–4 bits against fixed Lloyd-Max levels.
- It is data-oblivious: there is no codebook to train. Each block is quantised on its own as it is indexed, so incremental indexing works and nothing is retrained as the corpus grows.
- Scoring reads the codes directly: rotate the query tokens once, then use SIMD table lookups.

*Measured* (2026-10-08, one 24-core AVX2 server under moderate load, random unit vectors, 1.36M document token vectors × 32 query tokens, about one deployment's whole corpus):

| Path | Time | Size |
|---|---|---|
| fp32 matrix product (OpenBLAS via numpy) + per-block max + sum | 100–150 ms (90–150 GFLOP/s, far below peak: a 32-column product and an unfused reduction) | 696 MB |
| TurboQuant 4-bit, fused SIMD scan (turbovec 1.0, MIT, Rust) | 15 ms | 93 MB |
| TurboQuant 2-bit | 7 ms | 49 MB |

The turbovec figure is a top-k scan, which does the same per-token work as MaxSim's per-block max.

*Consequences:*
- The off-the-shelf matrix path fits today's corpus within the budget, but with little headroom.
- A fused kernel on quantised codes is about 7–15× faster and 7–14× smaller. That keeps "search everything" affordable for years of growth.
- This needs native code: no ONNX op scores quantised codes with a per-block max, and plain JavaScript is far slower. The repo already builds a Rust N-API crate into the image, so the kernel belongs there, reusing a TurboQuant library's quantiser and SIMD layout (turbovec, MIT) with a MaxSim reduction (max per block over its tokens, sum over query tokens).

*Quality guard: approximate scan, exact rescoring.*
- The quantised scan picks the top `late.rescore` blocks (default 60).
- Those blocks are re-scored exactly from the stored fp16 vectors: ~5 MB read, a few ms.
- The scan therefore only has to keep the true top 20 inside its top 60, which is far more forgiving than ranking them exactly. The noise also biases a max over many tokens upward, which could otherwise favour long blocks.
- Measured on the §9 set: TurboQuant 4/3/2-bit, with and without rescoring and token pooling, against exact MaxSim (top-20 overlap and labelled relevance).

*Storage:* fp16 vectors on disk (SQLite blobs) for rescoring, plus the TurboQuant codes resident in memory for the scan. The exact fp32 matrix path stays as the portable fallback when the native module is unavailable.

**Two branches, one score** (owner, 2026-10-08):
- **Exhaustive window.** The newest `late.exhaustive_blocks` indexed blocks outside the recency layer are all scored on every query, newest first.
  - Recent memory matters more.
  - Exhaustive late interaction is expected to be a stronger first stage than single-vector retrieval over the same blocks: it matches at the token level and has no recall cut-off. Within the window it replaces the dense lane as the semantic signal.
  - BM25 and the user lanes (§4, §4a) still run there. They are structural and lexical signals, not a competing similarity.
- **Beyond the window,** recall is the hybrid of §4 as before, and its candidates are re-scored by MaxSim (late interaction as a re-ranker).
- **Merging.** Both branches produce MaxSim scores for the same query, so they merge directly into one list. The top `late.top_n` (default 20) go on to the cross-encoder.
- **Sizing the window.**
  - Cost is linear in the document tokens scored. A bench command measures throughput on the host for the configured query length and model, and prints the window that fits a target (default 100 ms for MaxSim).
  - The setting is a block count, or `"all"` when the whole corpus fits.
  - TurboQuant codes (above) and token pooling widen the window for the same budget; their quality cost is measured on the §9 set.
  - A scoring pass that overruns `late.timeout_ms` is abandoned for that query, and the hybrid lanes alone carry recall.
- **Not assumed strictly better.** Late interaction usually beats single-vector retrieval at similar scale, but not on every query type, and a small late model can lose to a strong dense one. The §9 harness compares exhaustive late interaction with dense recall over the same window. The dense index stays maintained either way: it is the fallback when the late query encoder is unavailable, and the signal beyond the window.

**Queries.** MaxSim sums over query tokens, so a long query costs more and dilutes the request's own terms. The late query is the trigger plus its reply target, capped at `late.query_max_tokens`. The conversation-window query (§4) stays on the hybrid lanes. Whether a short conversation tail helps the late query is measured, not assumed.

**Coverage gaps never hide memories.** A candidate with no vectors (not yet indexed, or the index is mid-rebuild) bypasses the cut and goes on to the next stage. A missing or stale index degrades to "no late interaction", never to dropping blocks.

**Calibration** is per model, like the cross-encoder's, when its score is the last cutoff.

**Latency placement (§8).** The rerank stages now sit between recall and the decision filter. Query encoding and MaxSim start at launch, in parallel with routing, and the filter starts when the stages before it finish. Every stage has its own timeout, and skipping one is the degrade path (§5.0).

```toml
[retrieval.late]
enabled = false
model = "..."                 # the document-side model; the index belongs to it
query_chain = []              # query encoders, tried in order; default [model]. Any shared-space member is
                              # valid against the index, e.g. a large model on GPU, then a small one on CPU
query_max_tokens = 64
exhaustive_blocks = 0         # newest N indexed blocks outside the recency layer, scored exhaustively; "all"; 0 = re-rank only
top_n = 20                    # candidates passed on to the cross-encoder
timeout_ms = 300              # query encode + MaxSim; past it, the hybrid lanes alone carry recall
resident = true               # keep the exhaustive window's scan codes in memory
quantization = "turboquant"   # scan codes: "turboquant" (native kernel) | "none" (exact fp32 path)
bits = 4                      # TurboQuant bits per coordinate (2–4)
rescore = 60                  # blocks re-scored exactly from fp16 after the quantised scan
chain = ["builtin"]           # document encoding providers, all serving `model`; background, low priority
```

### 5.0c Model survey and measurements

**Desk survey done:** `spec/MEMORY-RETRIEVAL-SURVEY.md` (2026-10-08). Its findings for this pipeline:
- **pplx-embed-v2-late:**
  - It has no text-retrieval benchmarks yet, and no ONNX, GGUF or server support.
  - Its hybrid linear-attention layers have no known fast CPU kernel, so even its small query encoder may need a PyTorch sidecar.
- **mLateOn** (Apache, multilingual, official int8 ONNX) is the practical CPU late-interaction candidate. It is first in the one independent comparison, ahead of bge-reranker-v2-m3.
- **The built-in embedder runtime (fastembed-js 2.1.0) has three defects:**
  - its model download source now returns 403;
  - it applies e5 prefixes to every model;
  - it pools by CLS only.

  New built-in models therefore need a direct onnxruntime-node path.

Still to do: the measurements below, on real hardware and the labelled set.

A companion `spec/MEMORY-RETRIEVAL-SURVEY.md`, like DECISION-MODEL-SURVEY.md. For re-rankers (cross-encoder and late interaction) and embedders it records:
- **Open-weights candidates:** quality on retrieval benchmarks and languages, size, VRAM at the serving precision, GPU latency, CPU latency on ONNX, and licence.
- **API candidates:** quality, price, latency, rate limits, and **ZDR status, verified per provider and route** (direct and through aggregators).
- **Comparisons by full re-index:** indexing the whole corpus is minutes per model on one GPU, so candidate embedders and late models are compared on complete indexes, not samples.
- **Measurements on the deployment's own hardware** for the shortlist: latency for ~60 × ~400-token pairs, VRAM held, CPU time; for late interaction, index build time (GPU and CPU), index size and query-side CPU time.
- **Corpus shape:** the share of blocks longer than each shortlisted model's input window (the only segmentation question left, §5.0). Measured on one deployment: none. The pipeline caps blocks at 512 tokens, and the average is ~336.
- **Offline quality** on the §9 labelled items.

## 5. Relevance judgement: the `memory` decision point

**When.** Every human-triggered chat-lane session build that runs auto-retrieval. Proactive sessions too, with the conversation window standing in for the request. It starts at launch, as soon as the trigger group is known: candidate recall needs only the trigger, the window and the local index. It runs in parallel with routing, records planning and the context build.

**One request per surviving passage**, all sent in parallel (bounded by the member's concurrency). Putting several passages in one state would degrade every answer (the decision model's documented weakness with irrelevant material), and cost is not a reason to accept that.

**State** (per request; long fields clipped):

```json
{ "conversation": [ { "from": "alice", "text": "..." } ],
  "request": { "from": "alice", "text": "...", "reply_to": { "from": "bob", "text": "..." } },
  "participants": [ "alice", "bob" ],
  "passage": { "date": "2026-05-14", "room": "general", "text": "<the whole block>" } }
```

- `conversation` is the last ~8 messages, newest last, in the recent-tier rendering. Deleted messages show as placeholders (ARCHITECTURE.md §9 "Deleted messages").
- `participants` are the display names the lanes searched.
- The persona and the system prompt are left out.

**Questions** (two independent `noul`s per request):

- `relevant`: "`passage` contains information that would help respond to `request` in this `conversation`: facts, history or earlier events about the people, things or topics being discussed."
- `about_participant`: "`passage` describes one of `participants` or an interaction with them."

Phrasing follows the documented weaknesses (§2 of DECISION-MODEL): literal, no negation, no counting.

**Verdict.**
- Keep passages with `relevant ≥ relevance_threshold`. The default is 0.7, calibrated per member like the other points.
- Order the kept passages by `relevant` probability (ties broken by the cross-encoder score). `about_participant` (and §4a presence) only breaks near-ties (within 0.1): it never outranks a clearly more relevant passage, and reserves no slots.
- Pack up to `auto.max_results` (default 4) items and `auto.max_tokens` (default 2000) tokens.
- **Zero kept means no block.**
- `about_participant` never admits a passage on its own. Participant-tied and other relevant memories are wanted alike.

**Cost.** About 8 requests of ~2k tokens each, roughly $0.0007 per session on Jev. Per-question-billed members cost a few times more. Wall time is one request, since they run in parallel. Judged-filter questions (§7) ride in the same per-passage requests.

**Fallback** (the whole chain failed, timed out or is budget-blocked; owner, 2026-10-08): today's hybrid ranking with a higher floor (`auto.fallback_min_score`, default 0.6), at most `auto.fallback_max_results` (default 2) items, with the §6 excerpts. The candidates are always available, so a fallback never costs latency.

**Proactive sessions** run the judged retrieval too (owner, 2026-10-08), with the conversation window standing in for the request.

**Billing class.** `decision`, billed to the session payee like every runtime point.

## 6. Excerpts the agent can read

Excerpts must be long enough to tell what was being discussed. The citation must not eat the budget.

- **Whole blocks by default.** A kept block of up to `auto.excerpt_max_tokens` (default 400) is shown whole. With today's chunk sizes that is most of them.
- **Longer blocks.** A longer block shows its own heading text plus a window around its best-matching region: the sentence or line range with the highest query-term overlap, or the highest vector similarity at sentence granularity when embeddings exist. The window is expanded to sentence boundaries and marked `…` where cut.
- **Compact, non-repeating citation.** One short header per item, then the text:
  - The path stays, so the agent can open the full block (`memory/<file>.md:<lines>`).
  - The date is shown separately only when the file name does not already contain it. Pipeline-written day files always do.
  - The room is shown when known.
  - The block's own markdown heading markers are stripped. Heading text that only restates the time is dropped.
  - Example: `- [memory/2026-05-22.md:90-109 · general] <text>`.
- **`recall_memory` gets the same treatment:** match-centred, cleaned excerpts with the same citation form. Its default length goes from 200 characters to about 600, configurable.
- **The block's note** tells the agent that items were judged relevant to this conversation and can be opened in full. It drops the current phrasing that frames the block as incidental.

Diary blocks are often lists of loosely related events. Whole, relevant blocks are the best this spec can do with that format; making individual memories self-contained is part of the out-of-scope memory redesign (§11).

## 7. Operator memory filters (soft delete)

**Purpose.** The operator defines criteria for memories that should not be pushed into the agent's context. This is a reversible alternative to editing or deleting diary entries, and it keeps working as new entries are written. Example: entries in which the agent describes behaviour the operator no longer wants, which would otherwise reinforce it in a loop.

It is **not an access control**. A memory that must never be reachable should be deleted. Filters keep unwanted memories out of what the harness *pushes* into context. They are also applied to the memory search tools because that is easy and consistent, but direct file reads (editor, bash) stay unfiltered by design.

### 7.1 Filter kinds and configuration

A filter hides a block when it matches. There are three kinds of match, and any filter can be limited to a time range.

```toml
[retrieval.filters.unwanted_habit]           # judged: a decision-model question
description = "The entry describes the assistant <doing the unwanted thing>."
examples = { hide = ["..."], keep = ["..."] } # optional, become criteria.true / criteria.false
threshold = 0.8                               # hide at or above

[retrieval.filters.old_nickname]             # keyword: cheap, mechanical
keywords = ["some phrase", "another"]         # case-insensitive, whole words/phrases

[retrieval.filters.old_bit]                  # pattern: cheap, mechanical
patterns = ['(?i)\bsome\s+regex\b']        # regular expressions over the block text

[retrieval.filters.that_week_incident]       # any kind, scoped to a time range
description = "The entry is about <a specific event>."
after = "2026-05-10"                          # optional; date or datetime (with zone or agent tz)
before = "2026-05-18T12:00"                   # optional; either bound alone is fine
```

- **Kinds:**
  - **Judged** (`description`): one `noul` per block, "`entry` matches: <description>", with the examples as `criteria.true` / `criteria.false`. The model is the `memory` point's chain, or `[retrieval.filters].model`.
  - **Keyword** (`keywords`): a case-insensitive whole-word or whole-phrase match against the block text. No model, no cost, deterministic.
  - **Pattern** (`patterns`): regular expressions against the block text. They are validated at startup, and an invalid pattern is a config error.
- **Combining.** A filter with both `description` and `keywords`/`patterns` uses the mechanical match as a **pre-gate**: only blocks that match it are judged, so judgement runs only where it is needed. A filter with only `keywords`/`patterns` hides on the match alone.
- **Time scope** (`after` / `before`, both optional, each a date or a datetime):
  - It is compared with the block's entry time: the `entry_ts` the indexer derives from the block header, or the file date for legacy blocks.
  - A block outside the range is never hidden by that filter and is never judged for it. A filter about a past event therefore costs nothing for, and never touches, memories written later.
  - `after` is inclusive, `before` exclusive. A bare date means the start of that day in the agent's timezone.
  - A block with no entry time is out of range for any filter that has a time bound.
- `enabled = true|false` on every filter. Per-agent overrides go in `[agents.<name>.retrieval.filters]`.

### 7.2 Evaluation: mechanical first, judged lazily, cached

There is **no corpus pass and no backfill**.

- **Time scope first.** It costs nothing, and an out-of-range block skips the filter entirely.
- **Keyword and pattern filters** run inline wherever a block is about to be shown. They are deterministic, cost microseconds per block, and need no cache.
- **Judged filters** run only where a block is about to be shown, and only when it passed the filter's time scope and its pre-gate, if any. The verdict is cached:
  - The cache is `memory_filter_verdicts(agent, content_hash, filter_key, filter_hash, probability, hidden, model, served_version, evaluated_at)`.
  - `filter_hash` covers the description, examples, threshold, pre-gate and time range. Editing a filter makes its old verdicts stale. Blocks are re-judged lazily the next time they surface; nothing is re-run in bulk.
  - Disabling a filter simply stops consulting it.
- **Where judged verdicts come from:**
  - **Auto-retrieval:** a candidate without a fresh verdict has its judged-filter questions ride in the same relevance call (§5), at nearly no extra cost on per-request members. The verdict is stored.
  - **Recency diary layer and the diary writer's continuity window:** these show a handful of recent blocks that change a few times a day. Each block is judged once when it first enters the layer, at layer build time, bounded by the point's timeout, and served from the cache afterwards.
  - **Memory search tools** (`recall_memory`, `search_memory`): results without a fresh verdict are judged in one call before the tool returns.
- **Unavailable verdict** (timeout, decision-chain outage): `filters.pending` decides (`"show"`, default, or `"hide"`) for judged filters only. Mechanical filters always apply. Cached verdicts keep applying during an outage.

### 7.3 Enforcement

| Surface | Today | With filters |
|---|---|---|
| Auto-retrieval | top-K snippets | hidden blocks are never candidates |
| Recency diary layer (§9c read side) | the latest N files' blocks | hidden blocks dropped from the layer |
| Diary writer's continuity window | the latest N files' blocks | hidden blocks dropped (stops the loop where new entries are written) |
| `recall_memory` | ranked snippets | hidden blocks dropped (easy and consistent, not required) |
| `search_memory` (ripgrep over files) | matching lines | lines inside a hidden block dropped (line ranges map to chunks) |
| Direct file reads (editor, bash) | raw file | not filtered, by design |

### 7.4 Audit

- **Console.** A filters page lists, per filter, its kind, time scope and the blocks it has hidden so far, with probabilities (judged) or the matched keyword/pattern (mechanical) and citations (the operator can read them there). Hidden blocks also appear in a session's retrieval card as "hidden by <filter>".
- **Logs.** `memory_filter_hidden` (per surface, counts only).
- **Write-time filtering** (refusing to write such entries) is NOT part of this spec. Display-time filtering is reversible and auditable. A counterfactual entry that was never written is neither.

## 8. Placement, latency and cost

- **Latency.** Query time is the whole budget; indexing is background work (§5.0d).
  - Candidate recall is local: a query embed plus FTS, tens of milliseconds.
  - Late interaction adds a query encode plus MaxSim, bounded by `late.timeout_ms`.
  - The cross-encoder is bounded by its per-member timeout.
  - The decision calls take about 1–1.5 s through a gateway, one passage per request in parallel, and start when the re-rank stages finish.
  - All of this starts at launch, alongside routing. The build waits for it only when assembling the final user turn, bounded by the point's timeout (default the global `[decisions].timeout_ms`). Today the auto-retrieval block is built inside the build too, so the added wall time is the part of the decision call that outlasts routing and the build, usually little or none.
- **Cost.** About $0.0005 per session on Jev; around $0.10/day at a few hundred interactive sessions. Filters add a few questions to calls that happen anyway, plus a handful of small calls per day for the recency layer.
- **Prompt cache.** Unchanged: the block stays in the volatile final user turn. Filtering the recency layer changes that layer only when a verdict changes, like a diary write does today.

## 9. Observability and evaluation

- **Decision rows** (point `memory`) carry the candidates (citations and hybrid scores), the answers and the kept set. A console card in the session view shows kept, dropped and hidden passages.
- **One `memory_retrieval` log per build**: `{candidates, judged, kept, tokens, source: model|fallback, ms}`.
- **Follow-up rate.** The share of sessions that open a cited memory after the block (`recall_memory`, `search_memory`, a view of a cited path). This is the before/after metric against the 0.8% baseline.
- **Offline evaluation** before tuning thresholds:
  - Build (request, conversation, candidate) items from historical sessions.
  - Label relevance with a ZDR-eligible labeller through the existing calibration tool (scripts/calibrate-checks.ts generalised to the `memory` point).
  - Calibrate `relevance_threshold` per member.
  - The harness prints only ids, labels and aggregates.
- **Does late interaction earn its place on this corpus?**
  - Blocks are short (~336 tokens), so one vector may be enough. But many blocks are lists of loosely related events, and a single vector averages them, so a query about one item matches the block only weakly.
  - Compare recall at the cut (top 20 and top 60), each alone and fused with BM25:
    1. one vector per block;
    2. one vector per sentence or list item, scoring a block by its best item (a coarse multi-vector using the existing embedder);
    3. late interaction.
  - Report separately for blocks with many list items or many participants (the multi-topic cases).
- **The recall ceiling, measured first:** the share of sessions with at least one labelled-relevant entry anywhere in the recall set. A ranker cannot beat that, so it decides how much the re-rank work (the TurboQuant kernel, a large index model) is worth.
- **Experiment, offline only: write-time cues.**
  - A ZDR model writes, for each entry, a few lines naming what it would come up for. These are indexed beside the entry; the diary file is unchanged.
  - Compare recall with and without cues on the labelled set.
  - It is unclear whether generated cues work as an index: many different messages could call for one memory, and the cues have to anticipate them. No production code unless it shows a real gain.

## 10. Configuration sketch

```toml
[retrieval.auto]
judge = true                  # use the memory decision point when [decisions] is on
candidates = 60
candidate_min_score = 0.25
user_lane_candidates = 8
query_messages = 6
max_results = 4
max_tokens = 2000
excerpt_max_tokens = 400

# [retrieval.late] (§5.0d), [retrieval.rerank] (§5.0a), embedder chain (§5.0b)

[decisions.memory]            # usual point settings: enabled, model, timeout_ms, thresholds
enabled = true
relevance_threshold = 0.7

[retrieval.filters]
pending = "show"              # unevaluated blocks on non-judged surfaces
# model = "..."               # default: the memory point's chain
[retrieval.filters.<key>]     # description, examples, threshold, enabled
```

- **Without `[decisions]`, or with `judge = false`,** auto-retrieval keeps today's behaviour with the match-centred excerpt fix (§6), so a deployment without a decision model still benefits.
- **Without a decision model,** keyword and pattern filters still apply (§7.2) but judged filters do not, and startup warns if judged filters are configured.

## 11. Out of scope

- A "long gap" prompt (telling the agent to search its memories when a person or room returns after a long absence). Considered and rejected as too ad hoc and opinionated (owner, 2026-10-08).

- A new memory format: structured units, user-id tags, consistent references to people. This is the root-cause fix, to be designed separately.
- Summary pre-expansion (DECISION-MODEL §5.5, second half).
- Session records in the retrieval corpus, so that a follow-up asking "why did you say that" finds the records an earlier reply used. This is related, but records have their own selection point today.
- The user profile system.

## 12. Owner decisions (2026-10-08) and remaining questions

Decided:
1. **Fallback** when the decision chain is unavailable: today's ranking with a higher floor, at most 2 items, the §6 excerpts (§5).
2. **Proactive sessions** run the judged retrieval, with the conversation window as the request (§5).
3. **Filters** are about not pushing memories into context, not access control. They also apply to the memory search tools because that is easy. Direct file reads stay unfiltered. There is no backfill: blocks are judged lazily when they are about to be shown. Keyword and pattern filters are cheap mechanical alternatives (or pre-gates) to judgement, and any filter can be scoped to a time range so it never touches later memories (§7).
4. **Budgets:** up to 4 items and ~2k tokens when relevant, none otherwise (§10).
5. **Participants** only break near-ties in the ordering (§5); no reserved slots.
6. **Participant tags** come from provenance only (§4a). There are no model-assisted "about" tags.
7. **Snippets** were noise because they were too short to understand and wasted space on repeated citation parts, more than because they were the wrong part of the block (§1, §6).

Also decided (rev 5):
8. **One passage per judgement request.** Batching passages degrades accuracy; cost does not justify it. The decision model is the final filter on the cross-encoder's survivors, not a re-ranker.
9. **Re-ranker and embedder provider chains** (§5.0a, §5.0b):
   - the self-hosted GPU is primary unless a ZDR API is meaningfully better and acceptable in cost and latency;
   - the API is otherwise a fallback;
   - an always-available CPU rung keeps working when the GPU's memory is needed elsewhere.

10. **The re-ranker stage is implemented regardless** (owner): the pipeline always has it, and a deployment that finds no worthwhile re-ranker disables it. Model choices (re-ranker and embedder) therefore do NOT block implementing any of the code. The built-in CPU re-ranker may be added later, once a model is chosen.
11. **Late interaction** (owner, 2026-10-08, §5.0d):
    - Indexing is background and CPU-capable (the recency layer buffers new blocks), and query time is the whole budget.
    - The newest `exhaustive_blocks` are scored exhaustively, sized by a host bench. Older blocks come through hybrid recall and are re-scored by MaxSim.
    - It sits before the cross-encoder. Its code is implemented regardless of the model choice.
12. **Segmentation is not a problem here** (owner): memories are discrete blocks, so every stage scores whole blocks (§5.0).

Remaining:
- **The survey and measurements of §5.0c,** which choose the models: GPU primary, API fallback (or primary), and the built-in CPU models. These run in parallel with the implementation.
- **Whether the built-in CPU re-ranker ships enabled by default,** like the embedder. Proposed yes (§5.0a), pending its measured quality.
- **Late interaction details to settle with measurements (§5.0d):**
  - the exhaustive window's default budget (proposed 100 ms of MaxSim);
  - the late query's content (trigger plus reply target, or a short conversation tail too);
  - whether a large model on the index side, queried by a small one, is worth its index-time cost;
  - whether the dense lane still adds anything inside the window.
