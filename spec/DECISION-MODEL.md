# Decision-model integration — session gating, model routing, continuation, dedup, style, retrieval

**Status**: PROPOSAL, revision 3.1 (2026-10-04: owner decisions on every open question folded in, §7; revision 2 earlier the same day; revision 1 was the planning session of 2026-09-18). Nothing here is implemented.
**Companion**: `spec/DECISION-MODEL-SURVEY.md`, measured capabilities, context, latency, billing and rate limits of the decision models on OpenRouter (2026-10-04). Facts below marked *measured* come from it.
**Target ARCHITECTURE.md home once implemented**: a new §8h "Decision model" (client, decision-point registry, billing lane, fallback rule, vision routing); touched sections §8 (resumable sessions / follow-up folding / duplicate-reply mitigation), §8a (model resolution), §8f (ledger class), §9 (final user turn additions), §9d (auto-retrieval), §9g (proactive scheduler), §10 (`send_message`), §4 (config schema).
**Related**: PER-USER-LIMITS, MODEL-FALLBACK, PER-MEMBER-CONTEXT-FITS, RESUMABLE-SESSIONS, FOLLOWUP-FOLDING, DUPLICATE-REPLY-MITIGATION, DYNAMIC-TOOL-LOADING, SUMMARY-LAYER-BUDGET.

### What changed in revision 3

Revision 3 replaces revision 2's assumption that "same API means drop-in" with measurements (the survey). The models share a request body but differ in ways that change the design:

- **Different models for different purposes** (§3.7). Each decision point names its own model chain (and vision chain), defaulting to the global one. The measured landscape has no single best model:
  - Jev is the strongest general text decider.
  - Clef-flash and the Perplexity Decider are the vision routes (only Perplexity has ZDR today).
  - Perplexity (to ~250k tokens) and Solar (to 500k+) are the only long-context routes.
  - Span-01 is a cheap, fast judge of assistant replies (no ZDR today).
- **Per-member capability declarations grow** (§3.6):
  - Question types and limits.
  - Accepted state shapes: Span-01 takes only a string or an `{input, output}` conversation.
  - A measured **state budget** separate from `context_window`: Clef silently keeps only the first ~2.2k tokens on OpenRouter, and Span-01's fact lookup collapses above ~0.5–2k tokens.
  - A **billing mode**: five of the routes re-bill the whole state once per question.
- **Judge-shaped state** (§3.8) for points that ask about a reply the agent wrote (style gate, duplicate guard, audit). It is rendered natively for judge models and as a plain object for general ones.
- **Rate-limit isolation** (§3.1): decision models get their own scheduler `rate_limit_group`, so a decision model's 429 (OpenRouter's free tier answers its 21st request/minute with a key-wide 429) can never pause chat traffic.
- **Long-context uses**: the transcript audit sends whole rollouts to a long-context member instead of pruned segments (§5.8). Retrieval re-ranking splits per passage on per-question-billed members (§5.5).

### What changed in revision 2

Revision 1 was written when Jev was the only model of its kind: one small vendor, an alpha OpenRouter route, no second source. That is why it treated the heuristic as a co-equal design target and deferred every hot-path use it could. Within two weeks the situation inverted. As of 2026-10-04 the OpenRouter decisions endpoint lists 13 routes from 9 publishers that take Jev's request body unchanged (TypeSafe Jev, Cloudflare Clef / Clef-flash, Perplexity Decider V1 27B, Liquid D1, Upstage Solar Decide, Together Tev1, Inception Mercury Decide, Respan Span-01, Kev), several have open weights (Clef and Clef-flash under Apache 2.0, Kev, and community reimplementations that serve the native `/v1/systemone` contract), and three of them (both Clefs and the Perplexity Decider) accept images. Decision models are now a commodity API with a fallback market, so this revision:

- **Relaxes the availability posture** (constraints 1–2): availability comes from a *chain of decision models* on the existing MODEL-FALLBACK machinery, with the heuristic as the last rung, not a peer. New capabilities may be decision-model-only; they do not have to invent a heuristic. Existing behaviours keep today's code as their fallback.
- **Adds an optional vision decision model** (§3.5) for evaluations that involve images, with the text model plus captions as the default.
- **Adds per-member capability fits and per-member calibration** (§3.1, §3.6), because "same API" does not mean "same limits" or "same calibration".
- **Corrects the wire facts** against live probes (§2): question `criteria`, `usage.cost`, versioned model ids in responses, and how images travel through OpenRouter.
- **Promotes the inline style gate** from "reserved for later" to a designed point (§5.9), and adds a thinking-effort escalation to routing (§5.1).
- **Fixes code drift** from the 75 commits since revision 1 (method names, the `handleInbound` chain, the fallback scheduler's probe model, the reaction seam, forced-completion prompts).

Owner constraints 3–7 (no shadow mode, never hard-gate, no de-escalation, task-type routing, billing follows the session) are unchanged.

**The reference deployment model** for this revision is official Jev via OpenRouter (`typesafe/jev-1.13`), with any other decision model as a drop-in chain member, plus an optional separate vision decision model (e.g. Clef-flash or Clef) only if the image cases turn out to need one.

**Owner constraints (2026-09-18, revised 2026-10-04)** — these bound every section below:

1. **Opt-in per deployment.** Every decision point is off unless configured, and a deployment without a decision model is byte-identical to today, because this is a public project and most deployments will not configure one. *Revised:* a new capability whose only sensible implementation is a decision (e.g. reactions as a presence signal, the style gate) may ship **without** a heuristic: with no decision model it is simply absent. There is no obligation to invent a heuristic for it.
2. **Availability is a chain, the heuristic is its last rung.** *Revised:* decision models now have drop-in replacements, so a deployment configures a fallback chain of them like any other model (§3.1), optionally ending in a self-hosted one. On any failure of the *whole chain* (unavailable, timeout, rate-limited, unhealthy, malformed, low confidence, budget-blocked) the point falls back to today's behaviour for that decision automatically and silently. Today's code paths stay intact as that fallback; they are no longer a design target that new work must keep in parity.
3. **No dry-run / shadow mode.** Decision points are evaluated by turning them on and watching the bot. Every evaluation is *logged* (answers, confidence, latency, cost, served member, and the heuristic verdict where it is cheap to compute alongside) so decisions can be analysed later, but nothing in this design gates a rollout on that log.
4. **The decision model never hard-gates the agent.** It gates *spend* (whether a session starts, which model heads it) and it *advises*. Where it intervenes on something the agent is doing (the duplicate guard, the style gate), the agent gets an explanatory error and may proceed on the next attempt.
5. **No de-escalation of normal chat.** The default chat model is chosen for writing quality and persona; switching normal chat to a cheaper model degrades every reply and poisons the context. There is no "trivial chat" tier: if a cheaper model were good enough for normal chat it would already be the default. *Revised 2026-10-04:* routing assigns **operator-chosen models to specific task types**, because different models are better at different tasks. The code does not rank models or enforce an "only better" rule; which model suits which task is configuration, bounded by the user's quota (§5.1).
6. **Route by task type first, difficulty second.** The decision model is far more reliable at "what kind of task is this" than at "how hard is this". Task categories map to models and skills; the difficulty scale is only a fallback for requests no category covers.
7. **Billing follows the session.** A decision made for a user-triggered session is billed to that session's payee for per-user limits, because it is part of the cost of serving that user. On top of that, decision-model spend needs its own aggregate cap, because it is used everywhere.

---

## 1. Motivation

The harness separates the chat from the agentic sessions that act on it. That separation is what makes a group chat workable at all, but it leaves a set of *decisions* that today are made by heuristics or by brute force:

- **When to start a session** without being addressed (proactive posting: a random timer plus a message-count gate; every attempt pays a full context build whether or not there was anything to say).
- **Whether to wait** for a follow-up message or image before starting (a 2 s hold).
- **Where a message goes**: a new session, an interjection into a running one, or a resume of a just-completed one (a chain of reply-target, same-sender, and time-window rules).
- **Which model** serves a session (a fixed per-session-type model, degraded by affordability, with no notion of what the request *is*).
- **Whether a reply is redundant** with something another session already sent (claims on trigger messages only).
- **What extra material** goes into context (a fixed top-3 of tiny memory snippets; summaries the agent rarely expands on its own).

A *decision model* — a model that returns typed, calibrated probabilities over options the caller defines, in a few hundred milliseconds, at a fraction of a cent per call — fits exactly these seams. It cannot write text and it is not a reasoning model, but every decision above is a choice among options the code already knows.

This spec designs one integration surface and seven decision points on it, plus a few deferred sketches. The reference provider is TypeSafe's Jev (a "System One" model) via OpenRouter; the design is written against the API shape rather than the vendor, so any provider exposing the same primitives (natively, through OpenRouter, or self-hosted) is configured the same way.

## 2. The decision-model API (as it constrains the design)

Facts the design depends on (TypeSafe and OpenRouter docs, plus the measurements in `spec/DECISION-MODEL-SURVEY.md`, 2026-10-04):

- **One endpoint**: `POST` a JSON body `{ model, state, questions }`. OpenRouter serves it at `https://openrouter.ai/api/alpha/decisions` (still marked alpha) and also accepts the optional `provider` (the same provider-routing object as chat: `order`, `only`, `zdr`, `data_collection`, …), `session_id`, `user`, and `trace`. TypeSafe serves the same body natively at `/v1/systemone`; Cloudflare's native Workers AI REST endpoint serves it wrapped as `{ result: { … } }`. It is **not** a chat-completions endpoint and must not go through pi-ai.
- **Response**: `{ model, answers, usage: { input_tokens, output_tokens, cost? }, id?, provider? }`. On OpenRouter `model` is the **dated served version** (`typesafe/jev-1.13-20260917` for a request naming `typesafe/jev-1.13`) and `usage.cost` is the billed USD amount (input-only pricing: 285 input tokens = $0.00001197 = 285 × $0.042/M, with `output_tokens` reported but free).
- **Questions**: a map of id → `{ type, instructions, criteria }`, three types, any mix per call, each evaluated in isolation:
  - `choice`: `criteria` is a map *option key → description*; returns `{ choice, probabilities: {key: p}, confidence }`.
  - `score`: `criteria` is an ordered array of level descriptions; returns `{ score, probabilities: {index: p}, confidence, legend }`.
  - `noul`: `criteria` is optional `{ "true": …, "false": … }` descriptions; returns `{ noul: p }` and no separate confidence.
  - `instructions` and every criterion may be a string, object, or array. `confidence` is the model's own calibration signal and is **not** the top probability (observed: probabilities 0.43 / 0.38 / 0.19 with `confidence` 0.15), so thresholds read `confidence` for choice/score and `noul` for noul.
- **State** is a string, object, or array. Instructions can reference fields by path (`` `recent[3].text` ``). The recommended shape for a transcript is an array of `{ from, text }` objects under a named field.
- **Adding questions barely changes latency.** The intended pattern is a speculative fan-out: ask everything in one call, decide in code.
- **Limits differ by model** even though the body is shared (*measured*, survey §1–2). This is what §3.6 handles:
  - Score levels: ≤10 almost everywhere.
  - Choice options: ≤20 on Tev1, ≤26 on Solar, 255 elsewhere.
  - Questions per request: ≤64 on Clef.
  - Span-01 answers only `noul` with plain-string instructions, over a string or an `{input, output}` conversation state.
  - Effective state: Jev ~32k (clean 400 above), Liquid D1 ~64k (clean 422), Perplexity 262k (clean 400), Solar 500k+, hosted Kev ~8k.
  - **The hosted Clef / Clef-flash route silently truncates state to its first ~2.2k tokens** on OpenRouter despite a 64k listing. This is a serving configuration: the open weights have a far larger window. **Span-01's fact lookup fails above ~0.5–2k tokens** while still billing the whole state.
  - Errors: `429`/`503`/`529` with backoff; `400`/`413`/`422` on a malformed or oversized request; `402` on credit exhaustion.
- **Cost**: output is free everywhere; input runs from free to $0.24/M (Clef). Only Jev, Kev, and Span-01 bill the state **once per request**. Everything else bills it **once per question** (D1, Clef, Mercury, Perplexity, Tev1, Solar), because those models run a generative backbone with each question as its own prompt over the shared state, so 3 questions over an 8.6k-token state cost $0.00036 on Jev and $0.0009–0.0013 on the per-question routes (*measured*).
- **Latency** (*measured*, sequential, p50):
  - About 0.3–0.5 s for Jev, Perplexity, Span-01, Clef-flash, Mercury, and Tev1 on small-to-8k states; 0.5–1.2 s for Clef, D1, and Kev.
  - **Solar takes ~14.6 s once the state reaches ~2k tokens.**
  - Perplexity takes ~13 s at ~180k tokens.
  - Realistic JPEGs (43–65 KB) answer in 0.36–0.72 s on the three vision routes.
  - Cloudflare's route rejects large base64 payloads (a 1 MB PNG counted as ~262k tokens), so images are always downscaled and JPEG-encoded first.
- **Rate limits** (*measured*): OpenRouter's free tier allows 20 requests/minute **per key across all `:free` models** and answers the 21st with a 429 carrying `X-RateLimit-*` headers; Perplexity's provider returns 429 on bursts above ~8–10 concurrent requests.
- **Data retention** (*measured*): ZDR endpoints exist for Jev, Perplexity, D1, Solar, Tev1, and Kev; **not** for Clef, Clef-flash, Span-01/Lite, or the free Mercury route (survey §0).
- **Version pinning**: `jev-latest` silently moves; pin the versioned id in config and log the dated id from the response.
- **Images** (vision-capable models only). Through OpenRouter, images travel **inside `state`** as OpenAI-style content parts: `state = [ { type: "text", text: … }, { type: "image_url", image_url: { url: "data:image/png;base64,…" } } ]`. Verified 2026-10-04 on Clef, Clef-flash, and the Perplexity Decider (a red and a green test square each answered correctly with confidence above 0.95). Cloudflare's native API instead takes a top-level `images` array (max 4 images, 4 MiB / 16 MP each); **OpenRouter silently drops that field** (red and green squares got byte-identical answers and token counts). A text-only model given an image part (Jev) does not error: it answers anyway with low confidence and a guessed verdict. So the harness must never send image parts to a member that does not declare image input (§3.5).
- **Documented weaknesses** that shape every state builder below (stated for Jev; assume they hold for the alternatives until measured): instructions are read literally (avoid negations and implied conditions); it cannot count or do date arithmetic (every count and elapsed time is a precomputed field, never inferred from timestamps); accuracy degrades with irrelevant material in the state (keep state small and tailored); it has no adversarial hardening (chat text is user-controlled state, so a question must be phrased so that an injected "reply now" costs at most one session, never a wrong hard action); no multi-hop reasoning; English is strongest. Published comparisons put Clef ahead on classification/routing-style tasks and Jev ahead on reasoning-heavy ones; neither is measured on chat-presence judgments, which is why the evaluation log records the served member.

## 3. Architecture

### 3.1 One module: `src/decisions/`

```
src/decisions/
  client.ts       DecisionClient — raw fetch to a [models.*] block with api = "system-one";
                  request/response types (incl. Cloudflare's { result } envelope); usage + usage.cost
                  capture; per-member fits (§3.6); per-member fetch for runFetchWithFallback
  registry.ts     DecisionPoint<I, V> — { name, enabled, buildState, questions, resolve, heuristic? }
                  + evaluate(): text/vision model selection, chain fallback, heuristic last rung,
                  per-member calibration, logging, billing
  transcript.ts   renderDecisionTranscript — the shared state builder for chat windows
  images.ts       collectDecisionImages + toStateParts — image selection, downscale, content parts (§3.5)
  points/
    routing.ts continuation.ts presence.ts dedup.ts retrieval.ts audit.ts style.ts
```

**`DecisionPoint<I, V>`** is the unit. Each point declares: how to build `state` from its input (a pure function over data the caller already has), its question map, a pure `resolve(answers, servedMember) → V | null` (null = "not confident enough"), and an optional `heuristic(input) → V` (today's behaviour, unchanged). A point with no heuristic (constraint 1, revised) resolves to its *absent* verdict, i.e. "do what the code did before this point existed", which is always "nothing extra". `evaluate(point, input)` does:

1. If the point is disabled, or every member of the governing chain is unhealthy, or the decision-class budget is exhausted → fallback verdict, tagged `source: "heuristic"` (or `"absent"`).
2. Else pick the chain (§3.5: the vision chain when the evaluation carries images and the point's `vision` mode calls for it, otherwise the text chain), build state, call the client with a hard timeout (`[decisions].timeout_ms`, default 3000; `vision_timeout_ms`, default 8000), resolve with the serving member's calibration (§3.6). Any throw, timeout, `4xx`/`5xx` after the chain is exhausted, unparsable answer, or `resolve → null` → fallback verdict, tagged with the reason. A vision-chain failure first retries the evaluation once on the text chain with captions (§3.5) before falling back.
3. Log one `decision_evaluated { point, source, reason?, answers, confidence, latencyMs, inputTokens, imageCount, costUsd, modelId, servedVersion, heuristicVerdict? }`. `heuristicVerdict` is filled when the heuristic is a pure cheap function (routing, continuation, presence gate) so the log doubles as an agreement record (constraint 3, logged, never gating).
4. Record one ledger row (§3.3).

**Health and fallback reuse MODEL-FALLBACK wholesale.** The client is a *fetch-shaped consumer* like captioning, `x_search`, image generation, and remote embedding: it composes `runFetchWithFallback` (`src/agent/model-fallback.ts`) over the referenced model's chain, so per-model health in the scheduler (`(endpoint::id)` health keys, unhealthy after `llm_unhealthy_threshold` consecutive environmental failures, half-open admission with exponential probe backoff), the group pause on `429`/`503` with `Retry-After`, `529` as a health strike, at most one attempt per member per call, `400`/`413`/`422` as content failures that never fall over, and scheduler admission all apply with no new machinery. Fetch consumers do not register background probers today (only agent chains do), so a recovering decision member is re-admitted by a live half-open call; that is acceptable here because a failed live call costs one fallback verdict, not a user-visible error. Registering a prober (a one-`noul` request) is a cheap follow-up if the live canary proves noisy.

**Rate-limit isolation.** The scheduler pauses a whole `rate_limit_group` on a plain 429, and models without one share the group `"default"` with every chat model. Startup therefore assigns every `system-one` member without an explicit `rate_limit_group` its own group, `decision:<model key>`. A decision model hitting a provider or free-tier limit pauses only itself, never chat traffic or the other decision members. (A gateway in front of the deployment needs the same property; the survey records why.)

A chain is ordinary config: `[models.decider].fallback = ["decider_alt", "decider_local"]`, e.g. Jev on OpenRouter → another vendor's decision model on OpenRouter → a self-hosted server. Members may use different endpoints, keys, and native or OpenRouter shapes. When the whole chain is unhealthy the registry short-circuits to the fallback verdict without attempting a call (step 1), logging a rate-limited `decision_model_unavailable` once per minute.

**Nothing else in the app imports the client.** Call sites depend only on `evaluate(point, input)` and the typed verdict, so a deployment without `[decisions]` never constructs a client.

### 3.2 A new wire API on `[models.*]`

`ModelSchema.api` (today `anthropic-messages | openai-completions | openai-responses | google-generative-ai`) gains the literal `"system-one"`. A model with this api is never offered to pi-ai: startup refuses it as a session-type model, a `[[user_limits]].models` entry, or a fallback member of a chat model, and refuses a chat model as a fallback member of a system-one chain (fail-fast validation next to the existing `reasoning`/`thinking_level` contradiction check in `app.ts`). Its `endpoint` is the **full URL** of the decisions endpoint, so the native, the OpenRouter, a gateway, and a self-hosted route are all plain config:

```toml
[models.decider]
api = "system-one"
provider = "openrouter"                  # informational; drives nothing
endpoint = "https://openrouter.ai/api/alpha/decisions"   # or a gateway route, or https://api.typesafe.ai/v1/systemone
api_key = "${OPENROUTER_API_KEY}"
id = "typesafe/jev-1.13"                 # pinned; '~typesafe/jev-latest' moves under you
input_modalities = ["text"]
context_window = 32000                   # state + questions budget; the client clamps state to fit
max_tokens = 1                           # schema-required; unused by this api
fallback = ["decider_alt"]               # any other system-one block(s)
[models.decider.openrouter_routing]      # optional; sent verbatim as the request's `provider` object
zdr = true
[models.decider.cost]
input = 0.042
output = 0.0
cache_read = 0.042
cache_write = 0.042                      # real per-token prices; no cache exists on this api

[models.decider_vision]                  # optional, §3.5
api = "system-one"
endpoint = "https://openrouter.ai/api/alpha/decisions"
api_key = "${OPENROUTER_API_KEY}"
id = "cloudflare/clef-flash"
input_modalities = ["text", "image"]
context_window = 65536
max_tokens = 1
[models.decider_vision.decision]         # optional per-member capability limits, §3.6
max_questions = 64
max_choice_options = 255
max_score_levels = 10
max_images = 4
state_budget_tokens = 2000               # measured: this route keeps only the first ~2.2k tokens
billing = "per_question"
[models.decider_vision.cost]
input = 0.09
output = 0.0
cache_read = 0.09
cache_write = 0.09
```

`openrouter_routing` (today a `compat` field valid for `openai-completions` only) is lifted to also apply to `system-one` members, so a deployment that pins chat traffic to zero-data-retention endpoints can do the same for decisions. `cost` records the provider's real prices (owner rule: cost blocks state real prices even when a transport cannot count a class); a self-hosted member declares zero rates and is collected as a zero-cost model like any other.

**Response normalisation.** The client accepts both the bare body and Cloudflare's `{ result: {…} }` envelope, takes `answers`/`usage`, and records the dated `model` from the response as the served version. Image transport is per member: `[models.*.decision].images = "state_parts"` (default; the OpenRouter shape verified in §2) or `"images_field"` (Cloudflare's native top-level array), so a native Clef endpoint works without code changes.

### 3.3 Billing: a `decision` ledger class, payee-attributed

- `UsageEventClass` (today `agent_loop | tool | caption | embedding`) gains `"decision"` (and `"audit"`, §5.8, which is never payee-billed); `[[limits]].classes` accepts both. Rows carry `class = "decision"`, `tool_name = <point name>` (reusing the column as the sub-lane label, as the tool lane does), `model_id`/`logical_model_id` = the served member, and the usual attribution columns.
- **Priced from the provider when it says.** When the response carries `usage.cost` (OpenRouter does), that amount is recorded, exactly as `x_search` records OpenRouter's reported cost for Grok calls; otherwise `usage.input_tokens` (which includes image tokens) is priced from the member's `cost` block. Every attempt the provider billed is recorded, including one whose answer was later discarded (low confidence, unparsable), so the ledger matches the provider's invoice.
- **Session-bound points** (routing, continuation-when-a-session-results, dedup, retrieval, style gate) fire after the session placeholder exists, so the row carries `agent_session_id`, `session_type`, `timeline_key`, and `trigger_sender_id`. The per-user engine (`recordUsageEvent`, `app.ts`) treats class `decision` exactly like class `tool`: `coverageModel` is undefined, so it credits the payee's fungible total and model-agnostic shared pools but never a model-scoped sub-cap (a decision has no requested chat model). This is constraint 7's first half with a one-line change at the fan-in and one added literal in `UsageEventClass`.
- **Session-less points** (the presence evaluator when it decides *not* to launch; a continuation verdict of "ignore") carry `timeline_key` and the *would-be* session type (`proactive.session_type` for presence) but no session and no sender. They count toward `[[limits]]` rules selecting by `classes`/`session_types` and toward nothing per-user.
- **The aggregate cap** is an ordinary `[[limits]]` rule, e.g. `{ name = "decisions-daily", classes = ["decision"], max_usd = 1.5, window = day }`. The BudgetEngine's existing gate covers it; the registry consults `engine.check({ class: "decision", modelId })` in step 1 and falls back to the heuristic when blocked (never refuses the underlying work — a blocked decision budget means "decide the old way", constraint 2).
- Console: the Usage page's per-class breakdown gains the class for free; the session view shows decision rows in the existing tool-lane table keyed by `tool_name`.

### 3.4 The shared transcript state builder

Every chat-window point uses `renderDecisionTranscript(timelineKey, opts)` → `{ messages: [{ id, from, at, reply_to?, mentions_bot?, text, attachments? }], fields }` where:

- `text` is the plain body (rich-reply fallback stripped); `attachments` are the caption strings (never paths; hydrated from `media_assets.caption` the same way the context renderer gets `AttachmentMeta.caption`), or `"[image N]"` labels pointing at image parts when the evaluation runs on the vision chain (§3.5), or `"[image, not yet described]"` when neither is available; ids are the external ids the harness already prints (`send_message`'s `reply_to_id` form), so a verdict can name a message the agent can act on.
- `from` is the display name, with the bot's own messages marked `from: "<bot display name>", self: true`.
- `at` is a short relative label (`"3m ago"`) — *and* every count or elapsed time a question needs is emitted as a top-level field (`fields.minutes_since_self_last_message`, `fields.human_messages_since_self_last_message`, …), because the model must not be asked to derive them.
- Bounded by `opts.maxTokens` (per point, default from `[decisions].state_max_tokens` = 8000) using the same tokenizer as the context builder; newest messages are kept. Rendering reads the same timeline query/compaction inputs the context builder uses (`TimelineStore.queryForContext`, honouring the §7d floor and §9h visibility), so a decision never sees what a session could not.
- Persona text goes into question **instructions**, never into state (TypeSafe's guidance: state holds facts, instructions hold judgments). It comes from `[decisions].persona`, a two-to-four line operator-written summary. **`SOUL.md` is never read** for this or any purpose.

### 3.5 Images: captions by default, an optional vision decision model

The text model sees images as their captions, which the captioning pipeline already produces for every image event. That covers most decisions, because the question is almost always about the *conversation* and a caption carries what the conversation needs. A vision decision model is an **optional second chain** for the cases where captions are missing or insufficient:

```toml
[decisions]
model = "decider"                 # text chain (required)
vision_model = "decider_vision"   # optional; a system-one chain whose members declare "image" input
```

**When an evaluation uses it.** Each point has `vision = "off" | "uncaptioned" | "always"`:

- `"off"`: captions only (unchanged text path).
- `"uncaptioned"` (the default when `vision_model` is set): use the vision chain only when a *subject* image (below) has no caption yet. This is the case that matters on the hot path: routing and presence run within seconds of an image arriving, often before its caption has landed, and today a session started then sees no description either. Otherwise captions go to the text chain.
- `"always"`: any evaluation with a subject image goes to the vision chain, for operators who find captions too lossy for a point (e.g. `image_kind` routing, §5.1).

Point defaults: routing `uncaptioned`, presence `uncaptioned`, reactions (§5.6) `uncaptioned`, continuation/dedup/retrieval/audit/style `off` (they judge text). With no `vision_model`, every point behaves as `off`.

**Subject images** are bounded and point-specific, never "every image in the window": routing takes the request message's and its reply target's images; presence the images of the last `vision_recent_messages` (default 3) human messages; reactions the reacted-to message's. At most `max_images` per evaluation (default 4, the smallest documented per-request limit; the effective cap is the min with the serving member's `decision.max_images`), newest first. Each is downscaled through the existing inference image path (`src/media/image.ts`, the same conditioning `read_image` uses) to `[decisions].image_max_pixels` (default 1,000,000), because a decision needs gist, not detail, and every pixel is latency and input tokens.

**Wire shape.** The state object is serialised into one leading `text` part, followed by one `text` label + one `image_url` part per image (`"image 1: attached to message $abc by Alice"`), and the transcript's `attachments` reference those labels. Instructions on vision calls name messages and images by id/label rather than by state path. (The labelled multi-part form must be re-probed at implementation; the 2026-10-04 probe verified one text part plus one image part.) Members with `decision.images = "images_field"` get the plain state plus the top-level `images` array instead.

**Fallback.** Vision-chain failure (unhealthy, timeout, budget, low confidence) retries the evaluation once on the *text* chain with whatever captions exist (and `"[image, not yet described]"` placeholders), then falls to the point's fallback verdict. A member that does not declare `"image"` in `input_modalities` never receives image parts: startup rejects such a member in the vision chain, and it is skipped by the fits check (§3.6) if one slips in by inheritance. This matters because a text-only model given an image part answers anyway, silently and wrongly (§2).

**Cost and latency.**
- Vision calls are billed in the same `decision` class (image tokens are in `usage.input_tokens`) and count against the same aggregate cap.
- Measured on OpenRouter with realistic 43–65 KB JPEGs, two questions: p50 0.36–0.42 s on Perplexity, 0.49–0.72 s on Clef-flash, 0.61–0.64 s on Clef. That's about 520–820 input tokens per image, i.e. $0.00005–0.0002 per evaluation.
- `vision_timeout_ms` (default 8000) stays well above that, because launch-day native Clef image calls took 13–30 s.
- Images are always re-encoded as JPEG by the conditioning step, under `max_image_bytes` (default 200 KB). Cloudflare's route counts base64 bytes against its token estimate and rejected a 1 MB PNG with 413.
- The vision chain's members are typically per-question billed, so vision evaluations ask only the image-dependent questions. The remaining questions of the same point go to the text chain in a parallel call, and the verdict merges both answer maps. Under `uncaptioned` they are rare by construction: they only fire in the window between an image arriving and its caption landing.

**What a vision decision model does not replace.** Captioning stays: captions are what sessions, summaries, search, and the diary read, and a decision model cannot write text.

### 3.6 Per-member fits and calibration

"Same request body" does not mean "same limits" or "same probabilities". Two mechanisms keep a heterogeneous chain correct without per-vendor code:

**Fits.** `[models.*.decision]` optionally declares:

- `question_types` (default all three).
- `max_questions`, `max_choice_options`, `max_score_levels`.
- `state_shapes`: `"any"` (default) or `"text_or_conversation"` for judge models that accept only a string or an `{input, output}` conversation (§3.8).
- `state_budget_tokens`: the largest state the member *actually reads*. It defaults to `context_window` and is set lower for routes that truncate or degrade silently (Clef on OpenRouter ~2,000; Span-01 ~500 for lookups).
- `billing`: `"per_request"` (default) or `"per_question"` (the state is re-billed for every question).
- `max_images`, `max_image_bytes`, and `images` (transport, §3.2).

`context_window` is the existing field. The client **never relies on provider truncation**: a state is clamped to the serving member's `state_budget_tokens` by the state builder's own rule (newest messages kept, §3.4) before it is sent, so a silently truncating route sees the same window the log records. Before each attempt, `runFetchWithFallback`'s member selection skips a member whose declared limits the request exceeds (a 40-option `choice` skips a member capped at 20; a `noul`-only member is skipped for any request containing `choice`), exactly as PER-MEMBER-CONTEXT-FITS skips chat members whose window is too small. A request no member fits falls to the fallback verdict with `reason: "no_fitting_member"`. Members whose `state_budget_tokens` is below the point's minimum (`[decisions.<point>].min_state_tokens`, default 1,000) are skipped rather than fed a uselessly short window. Startup warns (not errors) when an enabled point's static question shape fits no member of its chain, since some shapes (e.g. routing's skill list) are only known per session.

**Calibration.** Thresholds are written per point (`min_confidence`, `join_threshold`, …) and tuned against the head model. Different models calibrate differently, so a fallback member may carry overrides, applied when that member served the answer:

```toml
[decisions.calibration.decider_alt]       # keyed by [models.*] key
min_confidence = 0.8                      # any threshold name; overrides every point's value
"presence.join_threshold" = 0.8           # or point-scoped
```

Without an override, a member uses the point's thresholds. The evaluation log records the served member and its dated version, so per-member agreement can be checked later; nothing gates on it (constraint 3).

### 3.7 Different models for different purposes

The points ask different kinds of questions over different amounts of state, under different latency budgets. No single route is best at all of them (survey §7). So every point may name its own chains:

```toml
[decisions]
model = "decider"                # default text chain for every point (e.g. Jev → Perplexity → D1)
vision_model = "decider_vision"  # default vision chain (e.g. Clef-flash → Perplexity)

[decisions.style_gate]
model = "decider_judge"          # e.g. Span-01 → Jev: short judge state, cheapest, ~0.3 s

[decisions.audit]
model = "decider_long"           # e.g. Perplexity → Solar: whole rollouts, latency irrelevant
```

Resolution: `[decisions.<point>].model` → `[decisions].model`; `[decisions.<point>].vision_model` → `[decisions].vision_model`. Per-agent overrides (§4) apply on top. Fits (§3.6) still govern each member, so a point pointed at a judge chain with a `choice` question simply skips the judge member.

**Data retention is a filter on chains, not a point setting.** A deployment that requires zero data retention sets `openrouter_routing = { zdr = true }` (§3.2) on every decision member and lists only members that have a ZDR endpoint (survey §0: today Jev, Perplexity, D1, Solar, Tev1, Kev; not Clef, Span-01 or the free routes). A ZDR-filtered request to a member without one returns 404 "No endpoints found matching your data policy". The client treats that as a **configuration failure of that member**: it is not a health strike, it is not retried, and it is logged as an error once per member. The chain moves to the next member, so a misconfigured member never silently becomes the source of every verdict.

Reference mapping, from the measurements (deployments choose freely; nothing in code assumes a vendor). With a ZDR requirement, the chains reduce to: general Jev → Perplexity → D1; vision Perplexity (the only ZDR vision route today); judge Jev; long state Perplexity → Solar.

| point | wants | sensible chain |
|---|---|---|
| routing, continuation, presence, dedup (general) | top-tier accuracy, <0.5 s, 2–8k state, `choice` with many options | Jev → Perplexity / D1 (Clef-flash only for states under ~2k) |
| any point's image evaluations | vision, <1 s | Clef-flash → Perplexity → Clef |
| style gate, dedup (judge form), refusal/ism audit | `noul` over one reply plus a little context, cheapest | Span-01 → Jev |
| retrieval re-rank | many independent `noul`s, per-request billing preferred | Jev (one call) or Perplexity (split per passage, §5.5) |
| transcript audit, future summary pre-expansion | 50k–250k state, background | Perplexity → Solar |
| self-hosted | local GPU, Jev contract | Kev (text), Clef-flash weights (vision) |

Routes to avoid in chains: Solar on any hot path (~14.6 s at 2k tokens); hosted Kev and Tev1 (weaker calibration, low option/context limits). Free routes share a 20/minute key-wide limit, which rate-limit isolation (§3.1) contains.

### 3.8 Judge-shaped state

Three points ask about something the agent itself wrote: the style gate (§5.9), the duplicate guard (§5.4), and the refusal/ism audits (§5.8). Their state is built as a **conversation plus the reply under judgment**:

```json
{ "input":  [ { "role": "user", "content": "<the triggering message>" },
              { "role": "assistant", "content": "<another session's message, dedup only>" } ],
  "output": { "role": "assistant", "content": "<the draft or sent message>" } }
```

- Members with `state_shapes = "text_or_conversation"` receive exactly this, with plain-string instructions and criteria. Their questions must be `noul`; the fits check skips them otherwise.
- Other members receive the same content as `{ conversation: [...], reply: "..." }`, so instructions can reference `reply`.

The builder keeps judge state short by construction (the reply, its trigger, at most the few messages the question needs). That is what a judge route reads well.

## 4. Configuration

```toml
[decisions]
enabled = false                 # master switch; every point below also has its own
model = "decider"               # a [models.*] block with api = "system-one" (its fallback chain applies)
vision_model = ""               # optional §3.5; a system-one chain with image input
timeout_ms = 3000
vision_timeout_ms = 8000
min_confidence = 0.6            # default per-point floor for choice/score verdicts
state_max_tokens = 8000         # clamped further to the serving member's state_budget_tokens
max_images = 4
image_max_pixels = 1000000
max_image_bytes = 200000        # JPEG-encoded; some routes count base64 bytes as tokens
persona = """A regular in these rooms: curious, a little sardonic, likes music and games,
happy to answer questions and to poke at bad takes."""   # operator-written, short

[decisions.calibration.decider_alt]   # §3.6, optional per-member threshold overrides
min_confidence = 0.8

[decisions.routing]             # §5.1
enabled = false
state_max_tokens = 6000
min_confidence = 0.75           # escalation requires a confident category
preload_skills = true
vision = "uncaptioned"          # §3.5
[decisions.routing.tasks.creative_writing]
description = "Writing a character card, story, scene, song, or other long-form creative text."
models = ["frontier", "frontier_alt"]   # optional per-task preference cascade (§5.1); `model = "x"` = ["x"]
thinking_level = "high"         # optional per-task effort on the model that heads the session
skills = ["character-cards"]    # preloaded on route; optional
tail_files = ["tail/creative.md"]   # extra tail instructions for this task; optional
[decisions.routing.tasks.coding]
description = "Writing, fixing, or explaining code or a shell command, including code in a screenshot."
model = "frontier"
skills = ["coding"]
[decisions.routing.tasks.image_source]
description = "Asking where an image comes from, who drew it, or for the original or a higher-resolution copy."
skills = ["image-source"]
[decisions.routing.tasks.research]
description = "Answering a factual question that needs looking things up or reading sources."
skills = ["web-research"]
# ... any number of operator-defined categories; 'other' is implicit
[decisions.routing.difficulty]  # fallback axis, optional
levels = [
  "A one-line reply or reaction.",
  "A short explanation or opinion needing no lookup.",
  "Several steps of work, e.g. reading a page and comparing two things.",
  "Careful multi-constraint work where quality matters more than speed.",
]
models = { 4 = ["frontier"] }   # level index → cascade; only the listed levels route

[decisions.continuation]        # §5.2
enabled = false
window_ms = 1800000             # completed sessions younger than this are candidates
untriggered_senders = "recent"  # "recent" | "none" — evaluate bare messages from recent session participants
min_confidence = 0.7

[decisions.presence]            # §5.3 — replaces the random proactive cadence when on
enabled = false
eval_after_messages = 3
eval_quiet_ms = 90000
min_eval_gap_ms = 60000
state_max_tokens = 8000
join_threshold = 0.7
addressed_threshold = 1.0       # default off; e.g. 0.85 enables "answer when talked to without a mention"
vision = "uncaptioned"
vision_recent_messages = 3
kickoff_prompt = """..."""      # structured template, see §5.3; {reason} {targets} {time}

[decisions.dedup]               # §5.4
enabled = false
duplicate_threshold = 0.7

[decisions.retrieval]           # §5.5
enabled = false
model = ""                      # §3.7 per-point chain; empty = [decisions].model
candidates = 12
relevance_threshold = 0.55
injection_threshold = 0.7
excerpt_lines = 12
max_tokens = 1500

[decisions.style_gate]          # §5.9
enabled = false
model = "decider_judge"         # §3.7, e.g. a judge route first, a general decider as fallback
threshold = 0.8
isms = ["not_x_but_y", "tricolon", "closing_moral"]   # keys into [decisions.audit.isms]

[decisions.audit]               # §5.8 (abridged)
enabled = false
model = "decider_long"          # §3.7, a long-context chain; whole rollouts instead of segments

[[limits]]
name = "decisions-daily"
classes = ["decision"]
max_usd = 1.5
window = { type = "calendar", period = "day", tz = "UTC" }
```

Validation (fail-fast at startup, in `app.ts` next to the other cross-field checks): `[decisions].model` and every member of its chain must have `api = "system-one"`; `vision_model`, when set, likewise, and every member of its chain must declare `"image"` in `input_modalities`; every per-point `model`/`vision_model` likewise; a member whose `decision.state_shapes` is `"text_or_conversation"` heading a point whose questions include `choice`/`score` is a warning (it will always be skipped); every `tasks.*.model` / `difficulty.models.*` must be a `[models.*]` key with a chat api; `tasks.*.thinking_level` must be a valid `thinking_level`; every `tasks.*.skills` entry must name a listed skill in the workspace (a warning, not an error, because workspaces vary per agent); `tail_files` must exist under the workspace; every threshold in `[0, 1]`; `[decisions.calibration.*]` keys must name members of a decision chain.

Per-agent overrides (MULTI-AGENT, PER-AGENT-MODEL-OVERRIDES) follow the existing pattern: `[agents.<name>.decisions]` may override any `[decisions.*]` table, most usefully `persona`, `routing.tasks`, per-point `enabled`, and per-point `model`.

## 5. Decision points

Each point states: **when** it runs (the trigger condition is always a cheap mechanical check — the model is never called on every message), **state**, **questions**, **verdict** mapping, **heuristic** (must be exactly today's behaviour), and **touchpoints**.

### 5.1 Routing — model, skills, and instructions for a new session

**When.** Inside `AgentSessionFactory.create` for a **human-triggered, default-lane** session (trigger `dm`/`mention`/`reply`, session type resolved to the chat lane), *before* `buildModelFallback` and the factory's `buildContext` wrapper (which calls `ContextBuilder.build`). Not for background types, not for proactive sessions (§5.3 launches with its own verdict), not on resume (the persisted context was built for its model; changing it mid-rollout is the "poisoned context" case constraint 5 forbids).

**State.**
```json
{ "request": { "from": "...", "text": "...", "reply_to": { "from": "...", "text": "..." }, "attachments": ["caption, or [image N] on the vision chain"] },
  "recent": [ { "from": "...", "text": "..." } ],            // last ~10 messages, ≤ state_max_tokens
  "skills": [ { "name": "character-cards", "description": "..." } ] }   // the session's listed skills
```
**Questions** (one call):
- `task` — `choice` over the operator's `[decisions.routing.tasks.*]` keys with their descriptions, plus `other: "None of the above; ordinary conversation."`
- `difficulty` — `score` over `[decisions.routing.difficulty].levels` (only if configured).
- `skill` — `choice` over the session's listed skills plus `none` (only if `preload_skills`). This is the cookbook pattern that measured 2.3× fewer wrong loads than a roster prompt; it is orthogonal to the static `tasks.*.skills` mapping and the union of both is preloaded.
- `image_kind` — `choice` over `photo`, `screenshot_of_text_or_code`, `artwork_or_illustration`, `meme_or_reaction_image`, `chart_or_document`, `other` (asked only when `[decisions.routing.image_kinds]` is configured and the request or its reply target carries an image). The table maps a kind to extra skills to preload, e.g. `screenshot_of_text_or_code = ["coding"]`; confident kinds add their skills to the preload union and never pick a model. It is the one routing question that clearly benefits from the vision chain under `vision = "always"`; under the default it is answered from the caption.

**Verdict** `{ models: string[], thinkingLevel?: string, skills: string[], tailFiles: string[], task: string | "other" }`:
- `models` = `tasks[task].models` when `task ≠ other` and `confidence ≥ min_confidence`; else `difficulty.models[round(score)]` when configured and confident; else empty.
  - `models` is a **per-task preference cascade**: an ordered list of `[models.*]` keys. `model = "x"` is shorthand for `models = ["x"]`.
  - It is applied **as configured**: there is no ranking check (constraint 5, revised), because the operator decides which models suit which task.
- **Selection with a routed cascade** (owner decision, 2026-10-04):
  - The cascade is tried in order, and each entry goes through exactly the affordability and health checks normal selection applies to a preference-list entry: `engine.affordable` under per-user limits, preference-outer, chain-inner.
  - The first entry that passes heads the session.
  - When **every** cascade entry is exhausted, selection proceeds **as if the router had picked nothing**: the user's normal preference list (or the session type's default chain) is tried exactly as today.
  - So the effective order is `cascade ++ normal selection`. A routed task can never leave a user with less than they would have had without routing.
  - Without per-user limits, the cascade's entries (each with its own `fallback` chain) are tried before the default chain the same way.
- `thinkingLevel` = `tasks[task].thinking_level` (or `difficulty.thinking_levels[round(score)]`) under the same confidence rule, applied **as configured** to the member that heads the session. Effort is a per-task knob for deployments whose best model is already the default: the session keeps its model, persona and cache lineage and only changes effort. A member whose `reasoning` is false, or whose `thinking_level_map` has no entry for the level, ignores it. Fallback members keep their own levels.
- `skills` are preloaded through the dynamic-tool registry (`registry.load(matches)`) so their tools are in `initialState.tools`, and each body is rendered in the **final user turn** as `<preloaded_skill name="…">…</preloaded_skill>` immediately before `<tail_instructions>`. The final turn is already volatile per session, so this costs the prompt cache nothing; putting bodies in the system prompt would break the cross-session stable prefix. (Open: whether to instead seed the transcript with a synthetic `load_skill` call/result pair so the model sees the load as its own action; the satellite render is simpler and cache-identical, and is the recommendation.)
- `tailFiles` are appended to `<tail_instructions>` after `TAIL.md`. This is the first step toward **tailored instructions**: an operator splits task-specific guidance out of the always-on tail into per-task files, so a routed session sees fewer, more specific instructions and every other session sees a shorter tail. A later revision may add conditional sections inside one file (`<when task="creative_writing">…</when>`); per-task files need no parser and are recommended for v1.

**Heuristic.** No routing: today's `resolveModelKey` result, no preloads, `TAIL.md` only.

**Touchpoints.** `factory.ts` (`create`: call the point after `resolveModelKey`, which now resolves through per-agent model overrides first; feed `model` into the head passed to `buildModelFallback` and `thinkingLevel` into the head member's options; feed `skills` into the dynamic split; feed `tailFiles`/skill bodies into the `buildContext` wrapper's options for `ContextBuilder.build`); `workspace/prompt.ts` `renderSatelliteBlock` (preloaded skill bodies + extra tail files next to `<tail_instructions>`; tail stays suppressed on resume as today); `agent/dynamic-tools.ts` (a `loadInitial(names)` on `DynamicToolRegistry` that marks tools loaded before the first turn; `seedFromTranscript` gains "∪ initial preloads", persisted on the session row so resume recomputes identically). On providers that declare deferred tools up front (`compat.declare_deferred_tools`, the `tool_reference` load point), initial preloads are simply tools that start loaded: the declared catalog is unchanged, so the cached prefix is too; `usage_events` row per evaluation.

**Interaction with the deterministic skill→model switch.** A skill loaded *mid-session* via `load_skill` still cannot change the model (context is frozen for it). That remains a possible separate feature and is not designed here; routing at creation is the general answer.

### 5.2 Continuation — where does this message go?

Today's chain (`handleInbound`, after edit/self-echo/gap-freeze handling, the activation gate, and `router.route`): reply to a running session → steer (`steerReplyToActiveSession`); quick same-sender follow-up → fold (`foldFollowUp`: steer/park/resume); no trigger → stop; bot-chain cap (`botChainCapGate`, multi-agent); shared reply-target → coalesce (`coalesceCoTargetReply`); accept/claim; reply to a completed session → resume gate (`evaluateResumeGate`: same-user, window, capability, work gate); else fresh (`launchSession`). It is all reply-target and same-sender rules, and it mostly needs an explicit reply. The gap the owner wants closed: a follow-up that is *not* a reply and *not* quick — a fresh `@` thirty seconds later, or a bare "and what about X?" from the same person — starts an amnesiac session.

**When.** A message reaches this point only when there is something to continue: at least one **running** session in the timeline, or at least one **completed** session younger than `continuation.window_ms` that is resume-eligible on the mechanical gates (row `completed`, generation current, context below ceiling, not a synthetic type). The message must be one of:
- an **explicit reply to a bot message of a completed session** (owner decision 2026-10-04: explicit replies are judged too; the work gate still applies first, see Verdict). Explicit replies to a *running* session keep the existing steer path. Or:
- a trigger-bearing message that is **not** an explicit reply, or
- when `untriggered_senders = "recent"`: an *untriggered* group message from a sender who triggered, or was the reply target of, one of the candidate sessions. Everything else stays inert, which bounds cost to "people who were just talking to the bot".

Existing precedence stays ahead of it: `steerReplyToActiveSession` (explicit reply to a running session) and `coalesceCoTargetReply` run first. For an explicit reply to a completed session, this point replaces the decision part of `evaluateResumeGate`. Follow-up folding's *quick* windows also run first; this point is the slow, context-judged extension of the same idea and takes over where the fold's clocks give up.

**State.**
```json
{ "message": { "from": "...", "text": "...", "mentions_bot": true },
  "context": [ { "from": "...", "text": "..." } ],                       // the few messages around it
  "candidates": [
    { "id": "s-abc", "status": "running",   "asked_by": "...", "asked": "...", "last_reply": "...", "age": "40s ago" },
    { "id": "s-def", "status": "completed", "asked_by": "...", "asked": "...", "last_reply": "...", "age": "6m ago" } ] }
```
**Questions.** `target` — `choice` over candidate ids (each described by its `asked`/`last_reply`) plus `new: "A new request unrelated to the candidates."` and, for untriggered messages, `not_for_bot: "The message is not directed at the bot and continues nothing of its."`; `is_followup` — `noul` "The message continues, corrects, or asks about the candidate's exchange."

**Verdict.** `target = running id` → steer as an `<interjection>` (the existing path, image-capable); `target = completed id` → resume via `runResumeSession` with the **decision gate**:
- The mechanical checks above, the CAS, material viability, and the **work gate** stay mandatory for every resume. A completed session that fails the work gate is never a candidate, because its conversation is already in the shared chat context and resuming it would only add cost. (Owner decision 2026-10-04, for explicit replies and non-reply follow-ups alike.)
- `same_user_only` and the time window are **replaced by the model's judgment**: whether this is a follow-up is a question about the conversation. **Any participant may resume a session**, not only the user who started it. Per-user billing follows the resuming message's sender, as for any session.

`new` → the normal fresh path; `not_for_bot` → inert. Confidence below `min_confidence` → heuristic (today's chain, including `same_user_only` and the window).

Explicitly kept: the **capability gate** (persisted `context_tokens` below the ceiling). A long browser session near its ceiling is never resumed, decision or not, until rollout compaction exists.

**Heuristic.** Today's chain verbatim. For an untriggered message the heuristic verdict is always inert (it is not a trigger today), which is what makes `untriggered_senders` safe to leave on with the model down.

**Touchpoints.** `app.ts` `handleInbound` (one new fork after `botChainCapGate` and before `coalesceCoTargetReply`, so the multi-agent bot-chain cap still applies to anything the point would route; plus the untriggered-message entry, which sits where `handleInbound` returns early for "no trigger": an untriggered message from a recent *human* participant (never another agent, so the bot-chain cap cannot be bypassed) is offered to the point there instead of being dropped, with no provider change needed, because the message already reaches `handleInbound` after routing); a `evaluateContinuationGate` sibling of `evaluateResumeGate`/`evaluateFollowUpResumeGate`; `session-claims.ts` unchanged (the claim is taken by whichever session the verdict picks); `usage_events` row.

### 5.3 Presence — activity-driven proactive participation

The current scheduler wakes at random times inside a quota-derived cadence, checks a message-count gate, and pays a full session that then decides whether to say anything; the prompt is built around "you probably shouldn't". It works, but the bot arrives after conversations have ended and the session cost is paid on every miss.

**When (replaces the random timer when enabled).** Per opted-in channel, an **evaluation** is scheduled on activity rather than on a clock: after `eval_after_messages` new human messages since the last evaluation, or `eval_quiet_ms` of silence following at least one new message, whichever first; never more often than `min_eval_gap_ms`. The free pre-gates stay: `daily_posts` remaining > 0 (hard ceiling on sessions, sent and `NO_REPLY` alike), no active session in the timeline, dead-channel backstop, DM opt-out, `active_hours`. `min_user_messages` remains configurable but is **not** applied when presence is on unless set explicitly per channel, because counting non-bot messages is exactly the rule that prevents back-and-forth (the owner's "conversation mode" goal).

**State.** `renderDecisionTranscript` window (`state_max_tokens`), plus fields: `minutes_since_self_last_message`, `human_messages_since_self_last_message`, `self_last_message_got_reply`, `self_posts_today`, `daily_post_budget_remaining`. Images in the last `vision_recent_messages` human messages go to the vision chain when they are still uncaptioned (§3.5); "someone just posted a picture" is one of the most natural moments to join, and it is exactly when the caption is most likely still pending.

**Questions** (one call; `[decisions].persona` in every instruction that needs it):
- `join` — `noul`: "A regular of this room matching the persona, who has been reading along, would naturally say something now."
- `addressed` — `noul`: "One of the latest messages is talking to the bot or asking it something without naming it."
- `open` — `noul`: "The conversation is still going rather than concluded."
- `pending_media` — `noul`: "The latest message announces something that has not arrived yet (an image, a link, 'hold on')."
- `reason` — `choice`: `answer_question`, `react_to_something_shared`, `add_an_opinion`, `joke`, `correct_or_inform`, `continue_own_earlier_point`, `other`.
- `target` — `choice` over the ids of the last K (default 8) human messages plus `none`: the message the bot would most naturally respond to.

**Verdict.** Launch when `¬pending_media ∧ (addressed ≥ addressed_threshold ∨ (join ≥ join_threshold ∧ open ≥ 0.5))`. Otherwise no session, no quota consumed, one ledger row (session-less), and the next evaluation is armed by activity as above. `pending_media = true` re-arms a short evaluation (`eval_quiet_ms / 3`) instead of skipping.

**Structured kickoff.** The proactive launch is unchanged (`launchSession(inbound, false, { proactive: true })`, synthetic inbound, `proactive.session_type`, typing suppressed) except that the kickoff is rendered from `[decisions.presence].kickoff_prompt` with `{time}`, `{reason}` (the chosen reason's label), `{targets}` (the `target` id with a short quote, plus the runner-up when its probability is within 0.2), and `{addressed}` (a sentence when the addressed threshold fired). The default template inverts today's framing: *"It is {time}. You were not mentioned, but this looks like a good moment to join: {reason}. The most relevant messages are {targets}. Reply as a participant, briefly, in one message — or output NO_REPLY if on reading it you have nothing to add."* `NO_REPLY` stays available and the session type's `session_instruction` (length rules) stays as is. The `target` id lets the session `send_message` with `reply_to_id` when a reply is the natural shape.

**Billing an addressed launch** (owner decision 2026-10-04, v1): when `addressed` fires and `target` names a message, the launched session is attributed to that message's sender for per-user limits, like an ordinary reply. That also stops someone from farming the bot by talking to it without mentions. Launches on `join` alone are billed to the proactive session type as today. **Quota** (owner decision): `daily_posts` keeps counting every unprompted session, `NO_REPLY` included, so it bounds spend as well as volume.

**Heuristic.** When the point is disabled or the model is unavailable, the scheduler runs today's cadence (`computeNextAttempt` + `evaluateGate` + today's `proactive.kickoff_prompt`), automatically. The two modes share the quota counter and the launch path, so switching between them mid-day is safe.

**The paradigm note.** With `addressed_threshold < 1`, users can talk to the bot without mentions and it will answer — a materially different interaction model that some deployments will not want. It ships default-off (`1.0`) and is a per-channel override. Mentions and replies keep triggering reliably regardless: presence adds entry points, it never removes them.

**Touchpoints.** `proactive/scheduler.ts` (an activity-armed timer fed by the timeline's inbound hook, replacing `computeNextAttempt` when the point is on; `evaluateGate`, which now also takes `siblingUserIds` for multi-agent rooms, stays the free pre-gate so other agents' messages are not counted as human activity; the tick's decision enum gains `skip_decision` and `run_decision`; `proactive_tick` logs the answers); kickoff render where `proactive.kickoff_prompt` is rendered today (`context/builder.ts`, `{time}` substitution); config; `usage_events` row.

### 5.4 Duplicate-send guard

Today `send_message` refuses to *reply to a message another session has claimed* (`isClaimedByOther`) — a check on the target, not on the content. The residual failure is two near-simultaneous sessions saying the same thing, usually because one sent a reply the other had not seen when it drafted its own.

**When.** At `send_message`, only if **another session in the same timeline has sent a message after this session's context was built** (or after this session's last delivered interjection, whichever is later) — a timeline query on `agent_session_id ≠ self ∧ ts > built_at`. Otherwise no call. This is the owner's two-stage shape: a mechanical trigger, then the model.

**State.** `{ draft: "...", replying_to: { from, text }?, other_bot_messages: [ { id, text, age } ], recent_humans: [ ... ] }`. On a judge member (§3.8) the same content is sent as the conversation `[replying_to (user), other bot message (assistant)]` with the draft as `output`, one call per other message (rarely more than one).
**Questions.** `duplicate` — `noul`: "The draft says substantially the same thing as one of `other_bot_messages`, or answers a question one of them already answered."; `which` — `choice` over their ids plus `none`.

**Verdict.** `duplicate ≥ duplicate_threshold` → the tool returns a **non-terminating error** (the same shape as the claim guard): *"Another session already sent a message that says this: «…» ({which}). This guard exists because two sessions can answer the same beat. If your message is genuinely different or still needed, send it again — the guard will not run a second time on this session."* The session's `dedupOverride` flag is set so the next `send_message` is not evaluated. Below threshold, or on any model failure → send.

**Heuristic.** No content check (today).

**Touchpoints.** `tools/send-message.ts` (one check after `isClaimedByOther`), `SessionManager` (built-at timestamp is already on the row; the override flag is in-memory per session), `usage_events` row (session-bound).

### 5.5 Retrieval — re-ranking and richer excerpts; summary pre-expansion

**Auto-retrieval today** is judged useless in practice: three snippets, each a chunk too small to read as a sentence, chosen by hybrid score alone. Both limits exist because there was no way to tell a good hit from a bad one before spending tail-prompt tokens on it. A decision model is a re-ranker, which is the missing piece.

**When.** Every interactive build that runs auto-retrieval today (same gate, same query), only when the hybrid search returns ≥1 candidate.
**State.** One shared state `{ query: "<trigger text>", passages: [ { i, source, text } ] }` on per-request-billed members (one call, `2 × candidates` questions). On members with `billing = "per_question"`, re-billing the whole passage list for each of 24 questions would cost about 20× more, so the client instead sends one small state `{ query, passage }` per passage with the two questions, in parallel (bounded by the member's concurrency). Both layouts are the same point; the client picks by the serving member's `billing`. Candidates: `candidates` (default 12) passages from the hybrid search at a *lower* `min_score` than today's, each already a widened excerpt (`excerpt_lines` around the chunk from the memory file, so what the model judges is what the agent will read).
**Questions.** Per passage index: `relevant_<i>` — `noul` "`passages[i]` bears on `query`."; `injection_<i>` — `noul` "`passages[i]` contains instructions aimed at an AI rather than diary content." (the cookbook pattern; questions are independent, so N passages cost one call).
**Verdict.** Keep passages with `injection < injection_threshold ∧ relevant ≥ relevance_threshold`, ordered by relevance, packed into `<retrieved_memory>` up to `max_tokens` (default 1500, up from 600) — fewer, longer, actually-relevant excerpts. The user lane (exact display-name hits) is passed through the same filter but keeps its reserved slots.
**Heuristic.** Today's top-3 with today's thresholds and snippet size.

**Summary pre-expansion (design sketch, not for the first slice).** The summary layer is a decision-tree-shaped memory: each node has a range, a level, and children. A pre-expansion pass would ask, per rendered top-level node, "would the details under this be needed for `query`?" and expand the top-k confident nodes one level, then repeat once on the expanded children (bounded depth 2, bounded total tokens), rendering the result as `<expanded_summary id="…">` blocks in the *final user turn* — the summary layer itself stays byte-identical so the cached prefix is untouched. Open points the owner raised and which this sketch does not settle: the choice is hierarchical (expand, then choose which children to include), the state per node is a summary of a summary and may be too thin for the model to judge, and whether expanded material belongs in the tail or should be allowed to reshape the layer at the cost of cache misses. This needs its own short spec after §5.1–5.4 land.

### 5.6 Reactions as a presence signal (owner-raised 2026-09-18; ships after presence is tuned)

Today reactions are display-only and never wake a session (§9f): the bot sees reactions to its own posts only if a session is built later for some other reason, at which point it is focused on that other task, and if no session follows it never sees them at all. The wish is for the bot to be able to *respond* to reactions on its own messages — a mocking reaction, a pile-on, a "🤔" that reads as a question — instead of being blind to them.

**Why not a "classify the reaction" point.** Whether a reaction is mocking, and whether it deserves a reply, is a nuanced social judgment, exactly what a decision model is weakest at; custom emoji arrive as shortcodes with no visual meaning to a text model (a vision chain can be shown the emoji image itself, which helps but does not fix the next point); and the same emoji is mockery from one person and affection from another. A point built as "is this reaction hostile?" would be wrong often and would be a poor thing to act on.

**Reframe: a reaction burst is an activity signal for presence (§5.3), not a trigger of its own.** The question presence already asks — "would a regular who has been reading say something now?" — is the right one here too, and the reactions are just more state. Concretely:

- **Mechanical pre-gates carry the burden.** A reaction *episode* on a **bot-authored** message (new code: today §9f only splits reaction bursts at *render* time, by intervening-message count and minutes, in `context/reactions.ts`; there is no live settle logic and no reaction-triggered wake. The point adds a live tracker: a burst on one message is settled when no new reaction arrives for `reaction_settle_ms`, default 20 s, reusing the render-time split thresholds so the evaluation and the eventual context agree on what one episode is) on a message that is younger than `reaction_max_age_ms`, from a non-bot sender, where the bot has not posted since, and where the message has not already earned a reaction-armed evaluation (once per message), **arms a presence evaluation** in a presence-enabled channel — subject to all of presence's gates (quota, no active session, min gap, dead channel). Rooms not opted into presence see no change; reactions in them stay display-only.
- **State addition.** The transcript window plus a `reactions_to_self` field: the §9f View B lines for the bot's recent messages (`Fleur, Alice and Bo reacted 🤡 to your message [$id]: "snippet"`), with `fields.reactions_since_self_last_message` precomputed.
- **Questions.** The presence fan-out, unchanged, plus `reaction_response` — `noul`: "A person whose message received these reactions would naturally say or do something in response (answer, clarify, push back, or play along)." `reason` gains `respond_to_reactions`; `target` may name the bot's own reacted-to message.
- **Verdict.** A reaction-armed evaluation launches only on `reaction_response ≥ reaction_threshold` (default 0.85 — deliberately high; a false positive costs one cheap session that may `NO_REPLY` or just react back, a false negative is today's behaviour). The kickoff carries the reaction lines and the target id, so the natural cheap response — an emoji reaction back via `react` — is one tool call away, and a text reply can `reply_to_id` the reacted-to message.
- **Spam control** is presence's: the daily quota, `min_eval_gap_ms`, once-per-message arming, and an optional `reaction_daily_max` (default 2) sub-cap on reaction-armed launches so a busy room's pile-ons cannot consume the whole quota.

**Heuristic.** None (constraint 1, revised): without the decision model, reactions stay display-only, as today.

**Vision.** Under `vision = "uncaptioned"`, an uncaptioned image in the reacted-to message goes to the vision chain; under `"always"`, custom-emoji reactions are also sent as their emoji images (up to `max_images`), since a shortcode like `:kekw:` or `:ayaya:` carries its meaning only in the picture.

**Not designed here**: reactions to *other users'* messages as a signal (inter-user reactions are already surfaced on a tight horizon and are conversation topics, not addresses); a startup backfill of reaction history (§9f, deferred).

### 5.7 Deferred: hold extension

Asking `pending_media` at trigger time and stretching the 2 s hold to ~10 s only when it fires is cheap and fits the same client, but follow-up folding already covers the common late-image case. Listed for completeness; not designed.

### 5.8 Transcript audit — offline classification of model failures (sketch, owner-raised 2026-09-18)

Everything above is on the hot path. This point is not: it reads **completed** sessions and classifies what went wrong, for statistics and examples. It is the best-suited use of a decision model in this spec — the questions are about the *shape of text in a transcript*, not about social judgment — and a wrong answer costs nothing but a miscounted statistic.

**Mechanical triggers (no model needed to detect).** The runner already knows when a session: entered forced completion (≥1 corrective user message injected, §8 "Forced completion"); ended `noReply` because `forced_completion_retries` was exhausted; received one or more `send_message` error results; sent a `final: false` progress message and then never sent again; or was force-completed after prior sends. Each of these is a row-level fact and should be **persisted as such** on `agent_sessions` (a small `contract_events` JSON column, or counters) regardless of the decision model — the counts alone are useful and today they exist only in logs. The audit worker consumes these facts; a configurable sample of *clean* sessions is also audited for the refusal questions, since a refusal is a terminally valid turn.

**Backfill is mandatory (owner, 2026-09-18).** Months of expensive rollouts already exist and must be used. Consequently the mechanical facts are **derived from the persisted transcript**, never only captured live: `deriveContractEvents(transcript)` is a pure function over `agent_session_payloads.transcript_json` (count of corrective user turns — matched on the two corrective prompts, which today are inline string literals inside `forceCompletion` in `agent/runner.ts` and must first be exported as constants (`FORCED_COMPLETION_PROMPTS`) so the runner and the derivation share one source of truth; older transcripts are matched against every historical wording of those prompts, kept in the same module; whether a prior `send_message` call preceded each; `send_message` error results; a `final: false` send with no later send; the `NO_REPLY` outcome, already on `agent_sessions.no_reply`). The live path calls the same function at completion and writes the result; a **one-time reconciliation** (startup step, resumable, batched through the single-writer queue) computes it for every historical row with a payload and stamps a `contract_version` so a later change to the derivation can re-run only what changed. The decision-model audit worker then treats history and new sessions identically: its queue is "sessions with a payload and no `session_audits` row for an enabled audit", oldest-first for the backlog and newest-first for live, paced by the `audit` budget cap so the backlog never starves anything (`audit_backlog_max_age_ms` defaults to unlimited — the whole history is in scope). A transcript-less session (payload pruned or never persisted) is marked `unauditable`, not retried.

**Worker.** A background pool in the shape of the diary/summarization pools: claims sessions on completion (or by reconciliation over `agent_sessions` after a restart), runs at `background` scheduler priority, never blocks or delays anything, and stops claiming when its budget is blocked. State is built from the persisted `transcript_json`: the trigger, the assistant text and tool calls immediately before each corrective prompt, the corrective prompt, everything after it, and the messages actually delivered (from `timeline_events` by `agent_session_id`). Long rollouts are pruned to those segments to stay under `state_max_tokens`. **With a long-context member** (`[decisions.audit].model` pointing at a chain whose `state_budget_tokens` is 100k+, e.g. Perplexity at ~250k or Solar at 500k+), the whole rollout is sent instead, so the model judges corrective prompts and refusals in full context. Pruning becomes the fallback for rollouts that exceed the budget. These members re-bill state per question, so audits over long state are asked as few, high-value questions (one audit group per call) rather than the full catalogue at once. At ~$0.007 per question over 180k tokens (*measured*), a full-history backfill is budgeted and paced by the `audit` cap as before.

**Audits and questions** (one call per audited session; each audit is a group of questions):

- *Send-contract audit* (runs when a corrective prompt fired):
  - `had_user_message` — `noul`: "The assistant text before the corrective prompt contains a message written to be read by the users, not notes to itself."
  - `after_correction` — `choice`: `sent_same` ("sent essentially the same text"), `sent_reworded` ("same content, substantially reworded"), `sent_cut` ("sent it with a significant part removed"), `sent_different` ("sent something with different content"), `switched_to_no_reply`, `nothing` (retries exhausted).
  - `self_talk_only` — `noul`: "Before the corrective prompt the assistant only reasoned or narrated to itself and finished without addressing anyone."
- *Refusal audit* (runs on every audited session):
  - `refused` — `noul`: "The assistant declines to do what was asked on safety, policy, or capability grounds."
  - `refusal_kind` — `choice`: `safety_policy`, `capability`, `persona_boundary`, `misunderstood_request`, `none`.
  - `refusal_delivered` — `noul`: "The refusal was sent to the users rather than kept in internal text."
- *LLM-ism audit* (owner priority; runs on every audited session's **sent messages only** — the `send_message` argument text, never internal text, and never on generation-session output). The "isms" are an operator-editable catalogue, `[decisions.audit.isms.<key>]` with `description` and `examples`, each becoming one `noul` per message: "The message uses this construction: <description>. Examples: <examples>." Independent questions make the whole catalogue one call per message. Two layers, because many isms are mechanical:
  - **Regex layer** (no model, always on when the audit is enabled, backfills instantly): em-dash chains, bullet or header structure in a chat message, emoji-led list items, "Let me know if…" sign-offs, "Great question", "I hope this helps", "As an AI…". A regex ism is declared with `pattern` instead of `description`.
  - **Model layer** for the constructions regex cannot see: the *rhetorical* "not X, but Y" / "it's not about X, it's about Y" (as distinct from a plain factual correction — the `examples` carry both a positive and a negative case, which is what lifts confidence on this model), the tricolon flourish, the "Here's the thing:" / "Let me be clear" pivot, rhetorical-question-then-answer, stacked hedges ("it's worth noting that…"), the closing moral or summary line on a casual message, the therapist register ("that sounds really hard"), and vocabulary tells (`delve`, `tapestry`, `testament to`, `navigate` as a metaphor). The shipped default catalogue is a starting point; deployments edit it freely, and the harness never rewrites a message on this path.
  - **Granularity and storage.** Results are per *message*, so `session_audits` gains a nullable `event_id` (the sent message's timeline event id); an ism row records the set of keys that fired with their probabilities. Attribution to a model uses the session's served model for that request (the ledger has it per request; the session row's head model is the fallback). Each ism row also stores the message's **token count** (the context tokenizer, `[tokenizer].primary`, so counts are comparable across models), and the console reports **both** denominators per model and per ism: **hits per 1k tokens** (fair across verbosity — a long researched reply trips more entries than a one-liner regardless of model) and **share of messages with at least one hit** (how often a reader actually meets one). Neither replaces the other (owner decision 2026-09-18). The console shows per-ism, per-model rates over time on both, and a per-message chip in the session view so examples are one click away — the point of the feature is "which models do this more", which this makes a single query.
  - **Backfill** covers every historical sent message with a surviving transcript (§ backfill above), which is what makes the per-model comparison meaningful across the model changes of the past months.

- *Candidates for later audits* (listed, not designed): a `final: false` progress message followed by no further send ("promised and did not deliver"); answering a `<handled_by_session>` message despite the marker; an interjection that was ignored; persona breaks ("as an AI…"); internal reasoning sent as the message; replying in the wrong language; tool use that nothing in the request called for.

**Storage and console.** A new `session_audits` table: `(session_id, audit, answers_json, confidence, model_id, cost_usd, created_at)`, one row per audit per session. The console session view shows the audit chips next to the existing forced-completion/no-reply markers; the usage/pipelines pages gain a per-model, per-day breakdown (e.g. share of sessions that hit forced completion, and of those, `after_correction` distribution; refusal rate per model). This is the one place the spec adds a table, and it is worth it: the value of this point *is* the aggregate over time, and examples must be findable later.

**Billing.** Audits are operator observability, not part of serving a user, so they must never touch a per-user meter. They use a distinct ledger class, `"audit"`, which the per-user fan-in ignores and which `[[limits]].classes` can cap on its own (`{ classes = ["audit"], max_usd = … }`). Rows still carry `agent_session_id` for provenance. (§3.3 is amended: the decision lane has two classes, `decision` for runtime points billed to the session payee and `audit` for this point, never payee-billed.)

**Heuristic.** None; the mechanical counters persist without the model (and are backfilled regardless), and the semantic classification is simply absent when it is off or unavailable — reconciliation picks unaudited sessions up whenever the model is back, history included.

**Inline style gate.** The owner's eventual goal of checking every outgoing message before it is sent was deferred in revision 1 until the provider was faster and more reliable. With sub-second calls and a fallback chain that condition is met, so it is now its own point, §5.9.

**Config.** `[decisions.audit]`: `enabled`, `sample_clean_sessions` (0–1, default 0.1; applies to history and live alike, seeded per session id so re-runs pick the same sample), `audits = ["send_contract", "refusal", "isms"]`, `[decisions.audit.isms.<key>]` catalogue entries (`description` + `examples`, or `pattern`), `state_max_tokens`, `audit_backlog_max_age_ms` (default unlimited), `workers` (default 1). The contract-event reconciliation has no switch: it runs once per `contract_version` on every deployment, model or not.

### 5.9 Style gate: catch LLM-isms before they are sent

**Why.** §5.8 measures which models produce which isms; this point acts on it. It is the one hot-path point that touches every reply, which is why revision 1 deferred it, and the reason it is designed now (provider latency and redundancy, §2 and §3.1).

**When.** At `send_message`, for session types where `[decisions.style_gate].session_types` includes them (default: the chat lane and proactive), on drafts of at least `min_chars` (default 80; one-liners rarely carry these constructions and are where added latency is most visible). Ordering inside the tool: claim guard (`isClaimedByOther`) → duplicate guard (§5.4) → style gate → send. The style gate never runs on a send the duplicate guard rejected.

**Two layers, one verdict.** The regex isms of the §5.8 catalogue (`pattern` entries) run first, free and synchronous, and work even when the decision chain is down. The model-layer isms named in `[decisions.style_gate].isms` (keys into `[decisions.audit.isms]`) are asked in one call, through the point's own chain (`[decisions.style_gate].model`, typically a judge route such as Span-01 → Jev, §3.7): judge-shaped state (§3.8) with the draft as `output` and its trigger as the only `input` message, one `noul` per ism with the catalogue's `description` as instructions and its positive/negative `examples` as `criteria.true` / `criteria.false`. No transcript, no persona: style is a property of the message alone, which also keeps the call small and fast.

**Verdict.** Any regex hit, or any model ism at or above its threshold (`threshold`, default 0.8, overridable per ism as `[decisions.audit.isms.<key>].gate_threshold`), returns a **non-terminating tool error** in the claim-guard shape: *"Not sent. The draft uses: «description of ism A», «description of ism B». Reword those parts and call send_message again. If the construction is deliberate, send it again unchanged: the next send is not checked."* The decision model cannot quote spans or rewrite, so the error names the constructions; the agent does the rewording. After a rejection the session's next `send_message` is unchecked (one override per rejection, so a long session is still gated on its later messages), and after `max_rejections_per_session` (default 2) the gate stays off for the rest of the session. It can never loop and never blocks a message outright (constraint 4).

**Cost.** The decision call is cheap (a few hundred tokens). The real cost is the extra chat-model turn on each rejection, which is bounded by `max_rejections_per_session` and is the point of the feature. Forced-completion accounting must treat the rejection like a claim-guard rejection (a tool error the session recovers from), never as a missing send.

**Interaction with the audit.** Rejected drafts are recorded (`style_gate_rejected { draft, isms }` in the session log, plus an `event_id`-less `session_audits` row) and §5.8's per-model ism statistics count **drafts**, not only sent messages. Otherwise the gate would hide exactly the model tendency the audit exists to measure.

**Heuristic.** None for the model layer (constraint 1, revised): with the chain down only the regex layer runs. With the point disabled, `send_message` is unchanged.

**Touchpoints.** `tools/send-message.ts` (one check after the duplicate guard; per-session override and rejection counter in memory, like `dedupOverride`); the shared ism catalogue loader with §5.8; config; `usage_events` row (session-bound).

## 6. Phasing

Revised for revision 2: with the availability risk gone, the foundation ships together with its first consumer instead of as an invisible phase, and independent points are grouped.

1. **Foundation + routing (§3, §5.1).** `api = "system-one"`, `DecisionClient` over `runFetchWithFallback` (chains, fits, `usage.cost`, the Cloudflare envelope), registry with chain-then-fallback, per-member calibration, per-point model chains and judge-shaped state (§3.7–3.8), per-member fits incl. state budgets and billing mode, decision rate-limit groups, logging, the `decision` ledger class through the fan-in and the per-user engine, `[decisions]` schema + validation, console class breakdown, and routing with skill preload, per-task tail files, and thinking-effort escalation. The vision chain's plumbing (§3.5) lands here too, since routing is its first user; with no `vision_model` it is inert. Tests: fake client (answers, 429/503/529, timeout, malformed, envelope), chain fallback and fits-skip matrix, vision → text → fallback ladder, ledger attribution for session-bound vs session-less points.
2. **Contract counters + backfill (§5.8, model-free part).** Can ship at any time, in parallel with everything else; it needs no decision model.
3. **Presence + continuation (§5.3, §5.2).** The two points that change how the bot participates; tuned live, together, because both read the same transcript state.
4. **Dedup + style gate (§5.4, §5.9).** Both live in `send_message` and share the override pattern.
5. **Transcript audit, model layers (§5.8).** Runs over the backlog under its own cap.
6. **Retrieval re-rank (§5.5, first half)**; summary pre-expansion gets its own spec.
7. **Reactions as a presence signal (§5.6)**, after presence has been tuned live.

Each phase is independently switchable per point.

## 7. Owner decisions (2026-10-04)

All open questions are resolved:

1. **Routing to models.** No ranking or "escalation-only" check: different models are better at different tasks, and the operator configures which. Each task may name a **preference cascade**. Each entry is checked for affordability as normal, and once the cascade is exhausted, selection proceeds as if routing had picked nothing (§5.1).
2. **Skill preload placement.** Satellite render in the final user turn, next to `<tail_instructions>`.
3. **Continuation and resume.** The work gate stays mandatory for every resume. Beyond it, the decision model decides (replacing `same_user_only` and the time window), for explicit replies to completed sessions as well as non-reply follow-ups. Any participant may resume a session (§5.2).
4. **Presence quota.** `daily_posts` keeps counting every unprompted session.
5. **Addressed launches** are billed to the addressed message's sender (§5.3).

Resolved in revision 2 without an owner decision: *decision budget exhaustion* (formerly question 6). At $0.04–0.24 per million input tokens a reserved slice for routing is not worth its configuration surface; on the daily cap every point falls back for the rest of the window, and the cap is sized so that this does not happen in normal operation.

## 8. What this deliberately does not do

- No evaluation of every inbound chat message; every inbound point has a mechanical pre-condition. The style gate (§5.9) is the one point that runs on every qualifying *outgoing* message, by design and only when enabled.
- No change to how mentions, DMs, and explicit replies trigger.
- No model switching mid-session, and no de-escalation.
- No dependence on a vendor SDK; the client is a small fetch against a documented JSON shape shared by every vendor in §2.
- No replacement of captioning by the vision decision model; it only covers the window before a caption exists, or points an operator explicitly sets to `vision = "always"`.
- No new database tables for the runtime points: two enum literals on `usage_events.class` (`decision`, `audit`), one column on `agent_sessions` for initial preloads (phase 2), contract counters on `agent_sessions` (§5.8). The only new table is `session_audits` (§5.8).
