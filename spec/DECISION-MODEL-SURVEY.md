# Decision-model survey (measured 2026-10-04)

**Status**: research note supporting `spec/DECISION-MODEL.md` (revision 3). Not a design. Numbers are point-in-time measurements of hosted routes and will drift; re-measure before relying on any single figure.

## Method

- Every model was called **directly on OpenRouter's decisions endpoint** (`POST https://openrouter.ai/api/alpha/decisions`), one key, from one host in Europe, on 2026-10-04.
- All states were **synthetic** (generated chat filler, hand-written test items). No real chat data was sent to any vendor.
- **Capabilities** were probed by sending each request shape and recording acceptance or the error text. That covers question types, choice-option counts (10–255), question counts (16–128), score levels (10/11), state shapes (string, object, array) and image content parts.
- **Latency** is 15 sequential requests per model per size class, one request in flight per model, wall clock at the client.
- **Long context** was tested with a needle fact placed at 5%, 50% or 95% of a generated transcript, at increasing sizes, plus a "wrong value" control question.
- **Accuracy** comes from a 54-item set shaped like the decision points in `DECISION-MODEL.md` and a 20-item judge set (questions about an assistant's reply). The items are deliberately unambiguous, so the top tier hits the ceiling. Read accuracy as a **tiering signal, not a benchmark**.
- Vendor-published facts that were not measured are marked *(documented)*.

Models: `typesafe/jev-1.13`, `cloudflare/clef`, `cloudflare/clef-flash`, `perplexity/pplx-decider-v1-27b`, `liquid/d1`, `upstage/solar-decide`, `togethercomputer/tev1-4b-experimental`, `inception/mercury-decide:free`, `respan/span-01`, `respan/span-01-lite`, `jaredpalmer/kev-4b`.

## 0. Data retention (measured): which routes are ZDR

Checked against OpenRouter's ZDR endpoint list (`GET /api/v1/endpoints/zdr`) and live with `provider: { zdr: true }`. Non-ZDR routes answer 404 "No endpoints found matching your data policy (Zero data retention)".

| ZDR available | no ZDR endpoint (2026-10-04) |
|---|---|
| Jev 1.13 (TypeSafe), Perplexity Decider 27B (Perplexity), Liquid D1 (Liquid), Solar Decide (Upstage), Tev1 (Together), Kev 4B (SiliconFlow) | Clef, Clef-flash (Cloudflare), Span-01, Span-01 Lite (Respan), Mercury Decide free (Inception) |

For a deployment that requires ZDR, this is the first filter, and everything below should be read through it. It removes the only judge model (Span-01) and two of the three vision routes. **The Perplexity Decider is the one ZDR vision route today.** Clef's weights are open (Apache 2.0), so ZDR hosting from other providers is a matter of time; the same is true of anything self-hosted.

## 1. Capabilities (measured)

| model | question types | max choice options | max questions | score levels | state shapes | images |
|---|---|---|---|---|---|---|
| Jev 1.13 | all | 255 | ≥128 | ≤10 | any | no (an image part is accepted and **ignored**: the answer is a low-confidence guess) |
| Clef | all | 255 | 64 | ≤10 | any | **yes** |
| Clef-flash | all | 255 | 64 | ≤10 | any | **yes** |
| Perplexity Decider 27B | all | 255 | ≥128 | ≤10 | any | **yes** |
| Liquid D1 | all | 255 | ≥128 | ≤10 | any | no (ignored) |
| Solar Decide | all | **26** | ≥65, <128 | ≤10 | any | no (ignored, and slow: ~11–13 s) |
| Tev1 4B exp. | all | **20** | ≥128 (5 s at 128) | ≥11 | any | no (ignored) |
| Mercury Decide (free) | all | 255 | ≥128 | ≤10 | any | no (ignored) |
| Span-01 / Span-01 Lite | **`noul` only**, plain-string instructions/criteria | n/a | ≥128 | n/a | **string, or `{input: [messages], output: message}`** | no (state shape rejected) |
| Kev 4B (hosted) | all | 255 | ≥128 | ≥11 | any | no (ignored) |

Notes:

- **Span-01 is a judge model, not a general decision model.**
  - Its API rejects `choice`/`score` ("Respan only accepts noul questions whose instructions and criteria are plain strings").
  - It also rejects any object state other than `{input, output}`, where `input` is a message array and `output` is the assistant message.
  - Its native API scores plain-language behaviour definitions against an LLM trace *(documented)*. OpenRouter maps that onto `noul`.
- **Silent ignoring of images is the norm** for text-only models. The harness must only send image parts to members that declare image input.
- **Errors are explicit** for every structural limit (400/422 with a readable message), with one exception: Clef's context truncation (§2).

## 2. Context: advertised vs measured

| model | advertised | measured behaviour |
|---|---|---|
| Jev | 32k | Clean 400 `max_tokens_exceeded` past ~32k real tokens. Needle found at all positions up to the limit. |
| Clef / Clef-flash | 64k | **The hosted route silently truncates state to its first ~2.2k tokens.** This is a serving configuration, not the model: the weights are a Qwen 3.8 27B / 3.5 9B fine-tune with a far larger native window. OpenRouter drops unknown request fields, so it cannot be raised from the client. Other hosts of the open weights will behave differently. Details: Reported `input_tokens` is constant (2,198 for one question) for any larger state. A needle in the first ~1.6k tokens is found (0.98); one later is missed (0.02–0.05). Same for string and object state. The open weights default to 16k *(documented)*, so this is a serving limit of the hosted route. |
| Perplexity Decider | 262,144 | Needle found at 5/50/95% at ~180k real tokens (13 s). Clean 400 past 262,144. |
| Liquid D1 | 64k | Fine at ~39k. Clean 422 ("prompt for question … is over the model's limit") at ~78k. |
| Solar Decide | 512k | Needle found at ~276k real tokens, but 12–17 s per call. |
| Tev1 | 32k | Needle found at ~68k real tokens (more than advertised). Accuracy outside its ~1.5k-token training range is not established *(documented)*. |
| Mercury Decide | 32k | Not pushed to the limit (free-tier rate limit, §5). |
| Span-01 | not stated | **Effective fact lookup collapses between ~0.5k and ~2.3k tokens.** It answers a flat 0.016 for any question on longer text, at any position, and is still billed for the whole state. |
| Kev 4B (hosted) | 8k | Rejects states of ~8.5k tokens and more ("parameter is invalid"). The 4B weights are validated to 8k *(documented)*. |

### Billing: which routes bill the state once

Most of these models are a generative LLM backbone that evaluates each question as its own prompt over the shared state, batched in parallel. Unsurprisingly, they bill the state once per question. The interesting set is the routes that bill it **once per request**, measured as the marginal tokens per extra question on a 50-token state (16 to 128 questions):

| bills state once per request | bills state once per question |
|---|---|
| **Jev** ~20 tokens/question (ZDR), **Kev** ~19 (ZDR), **Span-01 / Lite** ~23 (no ZDR) | D1 ~74, Clef / Clef-flash ~90, Mercury ~100, Perplexity ~149, Tev1 ~153, Solar ~436 |

Among ZDR routes, only Jev and Kev bill the state once. With 3 questions over an 8.6k state, the per-question routes report ~22–26k input tokens against Jev's 8.7k (table below). This matters for wide fan-outs such as retrieval re-ranking and audits.

| 8.6k-token state, 3 questions | input tokens | cost |
|---|---|---|
| Jev | 8,665 | $0.00036 |
| Clef-flash (truncated to 2.4k) | 2,411 | $0.00022 |
| Clef (truncated) | 2,411 | $0.00058 |
| Liquid D1 | 22,246 | $0.00089 |
| Perplexity | 25,474 | $0.00102 |
| Tev1 | 25,497 | $0.00107 |
| Solar | 26,159 | $0.00131 |

## 3. Latency (measured, seconds, direct to OpenRouter)

15 sequential requests per cell; "medium" and "large" carry 5 mixed questions over a ~2k and ~8k token transcript.

| model | small (1 q) p50 / p90 | medium p50 / p90 | large p50 / p90 | realistic image (43–65 KB JPEG, 2 q) p50 |
|---|---|---|---|---|
| Jev | 0.34 / 0.46 | 0.37 / 0.47 | 0.49 / 0.56 | n/a |
| Clef-flash | 0.26 / 0.50 | 0.45 / 0.65 | 0.54 / 0.96 | 0.49–0.72 |
| Clef | 0.44 / 0.81 | 0.90 / 1.18 | 0.92 / 1.17 | 0.61–0.64 |
| Perplexity | 0.29 / 0.53 | 0.35 / 0.43 | 0.71 / 1.15 | 0.36–0.42 |
| Liquid D1 | 0.49 / 0.80 | 0.70 / 0.73 | 1.18 / 1.52 | n/a |
| Span-01 | 0.31 / 0.43 | 0.33 / 0.60 | 0.36 / 0.53 | n/a |
| Span-01 Lite | 0.34 / 0.53 (judge set, n=20) | | | n/a |
| Tev1 | 0.30 / 0.33 | 0.55 / 0.72 | 0.77 / 1.16 | n/a |
| Mercury (free) | 0.36 / 0.43 (eval set, n=54) | | | n/a |
| Kev 4B | 0.58 / 0.62 | 0.72 / 0.81 | rejected | n/a |
| Solar | 0.68 / 2.85 | **14.6 / 15.3** | **14.6 / 16.3** | n/a |

**Image payload size matters more than pixels on Cloudflare's route.** A 512×512 incompressible PNG (~1 MB of base64) was rejected with 413 because the estimator counted ~262k tokens. Ordinary JPEGs of 43–65 KB cost ~520–820 input tokens. Images should be downscaled and re-encoded as JPEG before sending (the harness's existing inference image conditioning already does this).

Perplexity's probabilities vary slightly between identical requests (e.g. 0.36–0.42 on the same image). Clef's were identical across repeats.

## 4. Accuracy (tiering signal only)

| model | chat-decision set (54) | judge set (20) | calibration (mean Brier on yes/no items) |
|---|---|---|---|
| Jev | 53 | 20 | very good |
| Clef | 53 | 20 | very good |
| Clef-flash | 53 | 19 | very good |
| Mercury (free) | 53 | 20 | very good |
| Perplexity | 52 | 20 | very good |
| Liquid D1 | 51 | 19 | good |
| Span-01 / Lite | n/a (shape) | 20 / 20 | very good on judge items |
| Kev 4B | 48 | 17 | weaker (Brier 0.13–0.19 on several families) |
| Tev1 | 47 | 16 | weaker |
| Solar | 48 | 16 | weaker (confident misses, Brier up to 0.25) |

The top six share their misses on the same few items, most of which are borderline labels (e.g. "ok bot, what time is it" counted as "addressed without naming it"; "sauce?" with an image counted as an image-source request). **The set does not separate the top tier.** Separating it needs a harder, adversarially labelled set built from the deployment's own anonymised decisions. The evaluation log of `DECISION-MODEL.md` is designed to produce that set.

Published comparisons *(documented, vendor-run)*:

- **Perplexity Decider:** ahead of Jev on retrieval-grounded and table tasks (RAGTruth, TabFact), behind on reasoning (BBH, WinoGrande, TruthfulQA).
- **Clef:** ahead on intent classification and tool routing (BANKING77, BFCL), behind on knowledge-heavy tasks.
- **Kev:** about 4 points behind Jev on held-out data, with the best-documented calibration among open models.

## 5. Rate limits (measured)

- **OpenRouter free tier: 20 requests/minute per key across `:free` models.** The 21st request returns 429 with `X-RateLimit-Limit: 20`, `X-RateLimit-Remaining: 0`, `X-RateLimit-Reset: <epoch ms>` and `limit_source: openrouter_free_tier_per_minute`. Paid routes showed no such limit at the same volume (26 sequential requests in 10 s). 20/minute may well exceed a single bot's decision volume. The real hazard is a client or gateway that scopes this 429 to the whole endpoint and so stalls paid traffic. Rate-limit state must be scoped per model.
- **Perplexity** returned its own 429 ("Request rate limit exceeded") on bursts above ~8–10 concurrent requests.
- Span-01 Lite has a daily cap *(documented)*.

## 6. Self-hosting and off-OpenRouter options *(documented, not measured)*

- **Clef / Clef-flash**:
  - Weights: Apache 2.0, 27B / 9B on a Qwen backbone with a vision encoder.
  - Serving: vLLM and SGLang supported.
  - Context: 16k default in the reference code.
  - The one open-weight vision option with mainstream serving support.
- **Perplexity Decider 27B**:
  - Weights: Apache 2.0, ~49 GiB GPU for weights.
  - Serving: reference Transformers script only.
  - Vision: yes.
- **Kev** (0.8B / 4B / 9B / 27B):
  - Weights: Apache 2.0.
  - Serving: serves the native `/v1/systemone` contract on CUDA or MLX; the 4B fits a 24 GB GPU.
  - Context: validated to 8k (4B) and 64k (27B).
  - The most complete open drop-in.
- **Others**:
  - Laya: ModernBERT, needs fine-tuning.
  - openJev-verdict: 150M, browser-capable.
  - Rizzo Flow: llama.cpp, adds a `numeric` type.
  - SemIf: logit reading over an unmodified base model, uncalibrated.
  - razorback16/openjev: DiffusionGemma, accepts images.
  - All useful mainly where a GPU is already available or data must stay local.
- **Hosted, not System-One compatible**:
  - OpenAI's Decisions API (GPT-6 Luna based, preview).
  - Fastino GLiDE (adaptive "thinking" decisions; Decision Index leader per its vendor).
  - GLiNER2.5-Decide (355M encoder, CPU).
  - Each would need its own client.

## 7. What each is good for

Under a ZDR requirement (§0), the usable set today is Jev, Perplexity, D1, Solar, Tev1 and Kev:

| role (ZDR only) | chain | notes |
|---|---|---|
| general hot-path decisions | Jev → Perplexity → D1 | |
| image-bearing decisions | Perplexity | the only ZDR vision route; add Clef once a ZDR host exists |
| judging an assistant reply | Jev | Span-01 has no ZDR endpoint |
| long state | Perplexity → Solar | |
| self-hosted | Kev, Clef-flash weights | |

Without the ZDR filter:

| role | best fits (measured) | why |
|---|---|---|
| General hot-path decisions (routing, continuation, presence, dedup) | **Jev**, then Clef-flash / Perplexity / D1 as fallbacks | Top-tier accuracy, ~0.35–0.5 s, state billed once, honest limits. Clef-flash only if the state fits in ~2k tokens. |
| Image-bearing decisions | **Clef-flash** (fast, deterministic, cheap), **Perplexity** (fastest on images, long context), Clef | The three vision routes; all read realistic JPEGs in under 0.75 s p50. |
| Long state (whole session transcripts, many retrieved passages, summary trees) | **Perplexity** (to ~250k, ~13 s at 180k), **Solar** (to 500k+, 12–17 s, ≤26 options) | The only routes that use more than 64k. Background work only, and per-question billing argues for few questions over a big state. |
| Judging an assistant reply (style gate, duplicate check, refusal/ism audit) | **Span-01** (≤ ~0.5–2k tokens, $0.02/M, ~0.33 s), Jev | Native `{input, output}` shape, perfect on the judge set, cheapest paid route. Only usable with short context and `noul` questions. |
| Self-hosted / local | **Kev** (text), **Clef-flash** weights (vision) | Open weights, standard serving, Jev contract. |
| Avoid for production | Solar on the hot path (14 s at 2k tokens), Tev1 (≤20 options, weaker), hosted Kev (8k cap, weaker) | Free routes work (Mercury free answered in 0.36 s p50) but have no ZDR and a shared 20/min key limit. |
