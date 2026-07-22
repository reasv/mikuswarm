# Spec: `x_search` — Grok-as-subagent X.com search with native hydration & captioning

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §10 (`x_search`), §4 (`[x_search]`), §7a (shared FxTwitterClient), §8c (tool-invocations reuse); retained for review. Shipped in `src/tools/x-search.ts` + `test/x-search.test.ts`. One open item remains for the maintainer: the live smoke (§11) to confirm the OpenRouter citation field names against a real payload — the extractor tolerates both documented shapes (message `annotations` of type `url_citation` and a top-level `citations` array) and the no-citations case, but no real response has been captured yet.

**Extension (2026-06-14) — image input** (post-spec; authoritative description in ARCHITECTURE.md §10): the tool now accepts an `images` param (≤4 workspace paths or http(s) URLs), loaded to base64 `data:` URLs and sent as `image_url` blocks on the user turn (the user `content` becomes a multimodal array), giving Grok vision over the attached image as a **`find_source`/SauceNAO fallback** for sourcing media (visual recognition + text search, not true reverse-image). Separately, `enable_video_understanding` was **removed as a model-facing param** and made config-only (joining `enable_image_understanding`), and **both now default on** — these are corpus-vision flags (images/video Grok finds *while searching*), not user-supplied-image controls, so the §3 parameter table below is superseded on those two rows. A failed image load is a hard error; attached image refs partition the cache key. (Open smoke item: confirm a live OpenRouter/Grok request accepts `image_url` blocks alongside `x_search_filter` in one call — Grok 4.3 lists text+image input, but the combined search+vision payload has not been captured against a real response.)
**Date**: 2026-06-14
**Author**: design session
**Replaces**: OpenClaw's `x_search` extension (`../openclaw/extensions/xai/`), which called xAI's Responses API directly with an `XAI_API_KEY` and returned Grok's free-form synthesis + raw citation URLs. This spec keeps the "ask Grok, get a cited synthesis" core but routes through the existing OpenRouter-via-gateway LLM path and fuses the result into miku's own X enrichment + captioning stack.
**Depends on** (all already in-tree):
- OpenRouter-via-gateway LLM transport — `OPENROUTER_BASE_URL` + shared `LLM_API_KEY` (config/env, see ARCHITECTURE.md §4); usage parsing `parseOpenAiUsage` (`src/captioning/describe.ts:49`).
- FxTwitter pipeline — `FxTwitterClient.fetchStatus` (`src/fxtwitter/client.ts:40`), `buildTweetDocument` (`src/fxtwitter/format.ts`), `parseXStatusUrl` (`src/fxtwitter/url.ts`), `FxTwitterToolConfig` (`src/fxtwitter/types.ts:158`). Same surface `x_fetch` uses (`src/tools/x-fetch.ts`).
- Captioning — `InferenceClient.caption({…, context: "tool"})` (`src/captioning/inference-client.ts`), as used by the `media` tool (`src/tools/media.ts:64`); modality map + default prompts (`MediaModality`, `src/captioning/describe.ts`).
- Tool-spend accounting — the generic `tool_invocations` ledger (ARCHITECTURE.md §8c, schema v21), `recordToolUsage` callback wired in `buildSessionTools` (`src/app.ts:1892`), `ToolUsageRecord` (`src/tools/image-gen.ts:175`); session cost ceiling (ARCHITECTURE.md §8d, `SessionUsageTracker.recordToolCost`, `src/agent/usage.ts:127`).
- Fetch + egress — `FetchClient` (`src/enrichment/fetch-client.ts`); the Grok HTTP call itself goes to operator-configured OpenRouter infra (trusted, like MCP URLs — no SSRF guard needed; cf. ARCHITECTURE.md §10 "No SSRF validation" note).
- Untrusted-content wrapping — the `<untrusted_card_field>` pattern (ARCHITECTURE.md §9 / `character_card_read`), `escapeXml`/`escapeAttr` (`src/context/xml.ts`).

**ARCHITECTURE.md target once implemented**: a new tool entry under `## 10. Tools` (`x_search`; bump the tool count there and in CLAUDE.md's project structure — currently "37 tools"), a `[x_search]` table under `## 4. Configuration System`, a cost-lane note under `## 8c` (tool-context captions gain a durable home via this tool), and a one-line cross-reference from `## 7a` (FxTwitter) that the same client now backs search-citation hydration.

---

## 1. Background & motivation

Grok is uniquely good at searching X, and — as the maintainer put it — it is *effectively a subagent*: you hand it a research task, it decides how to search, reasons over the firehose, and returns a cited synthesis. OpenClaw exploited this with a thin `x_search` tool. miku should too, but a thin proxy throws away two things miku already has that OpenClaw lacked:

1. **A native FxTwitter pipeline** (`x_fetch`, enrichment) that turns an `x.com/.../status/…` URL into verbatim tweet text + author + media.
2. **A generic tool-spend ledger** (`tool_invocations`) and a **session cost ceiling** that any LLM-calling tool can plug into.

So the design goal is not "wire up Grok" — it is to treat Grok as a *discovery* subagent whose output is then **grounded, enriched, and captioned by miku's own stack**, and whose spend is **accounted like any other subagent**.

### Why grounding matters

Grok returns a prose answer plus citation URLs. The prose is a lossy paraphrase and Grok *does* occasionally fabricate citation URLs. By re-fetching the cited tweets through FxTwitter we get: (a) **verification** — dead/fabricated citations are dropped or flagged; (b) **verbatim text** for accurate quoting; (c) **media in miku's own captioning pipeline**, so the persona actually "sees" tweet images rather than trusting Grok's inline `enable_image_understanding`. None of (a)–(c) is obtainable from the Grok response alone.

---

## 2. Transport — OpenRouter via the LLM gateway

Routing decision (maintainer-confirmed): **OpenRouter via the LLM gateway**, reusing `OPENROUTER_BASE_URL` + `LLM_API_KEY`. No new credential, no new egress-allowlist host. (The alternative — direct `api.x.ai/v1/responses` with an `XAI_API_KEY`, OpenClaw's exact path, which would grant the native 20-handle cap and the Responses API — is rejected for the credential/egress cost.)

Single request to OpenRouter **chat completions** (`POST {OPENROUTER_BASE_URL}/chat/completions`):

```jsonc
{
  "model": "x-ai/grok-4.1-fast",          // config x_search.model; default fast non-reasoning
  "messages": [
    { "role": "system",  "content": "<scaffold, §4.2>" },
    { "role": "user",    "content": "<the agent's task/query>" }
  ],
  "plugins": [{ "id": "web" }],            // enables BOTH web_search and x_search server-side tools
  "x_search_filter": {                      // top-level; scopes the X corpus
    "allowed_x_handles": ["…"],            //  ── XOR excluded_x_handles (mutually exclusive, max 10)
    "from_date": "2026-01-01",             // ISO-8601 YYYY-MM-DD
    "to_date":   "2026-06-14",
    "enable_image_understanding": true,
    "enable_video_understanding": false
  }
}
```

**Auth**: `Authorization: Bearer ${LLM_API_KEY}`. **Corpus** (maintainer-confirmed): the `web` plugin leaves Grok's `web_search` enabled alongside `x_search`; the tool is *positioned* as X search, with web as an auxiliary capability the model is told it can lean on. We do **not** attempt to disable `web_search` (OpenRouter exposes no documented toggle for that today).

**Response shape** — Grok's answer is `choices[0].message.content`; citations arrive as message `annotations` of type `url_citation` and/or a top-level `citations` array (mirrors OpenClaw's dual extraction in `web-search-shared.ts`). ⚠️ **Verify the exact OpenRouter field names against a live response at implementation time** and capture one real payload in the implementing commit's notes; the extraction must tolerate both shapes and "no citations".

**Usage** — the response `usage` block is parsed by the existing `parseOpenAiUsage` (`src/captioning/describe.ts:49`) → `{input, output, cacheRead}`.

---

## 3. Tool surface

```
name:  x_search
label: X search
```

**Description** (agent-facing, abridged): "Search X.com (Twitter) via Grok, which searches and reasons over X for you like a sub-agent. Returns a cited synthesis plus the actual cited tweets (verbatim text + media), with the top images already captioned. Grok can also pull in general web results when useful. Use this for *discovery* across X ('what are people saying about…', 'find posts from @x about…'); use `x_fetch` when you already have a specific tweet URL."

**Parameters** (TypeBox):

| param | type | notes |
|---|---|---|
| `query` | string (required) | The research task / question, natural language. Sent as the user turn — Grok reasons over it. |
| `allowed_x_handles` | string[] optional | max 10; mutually exclusive with `excluded_x_handles` (validated in `execute`). |
| `excluded_x_handles` | string[] optional | max 10. |
| `from_date` / `to_date` | string optional | `YYYY-MM-DD`. |
| `effort` | enum `fast`\|`deep` optional | maps to model tier (`x_search.model` vs `x_search.deep_model`); default `fast`. Depth/latency knob for the subagent. |
| `hydrate` | integer optional | how many cited tweets to re-fetch via FxTwitter (default `x_search.hydrate_default`, cap `x_search.hydrate_max`). `0` = synthesis + raw URLs only. |
| `enable_video_understanding` | boolean optional | passthrough; default from config. |

`enable_image_understanding` is forced on by config default (cheap, improves Grok's own reasoning); not exposed as a knob in v1.

**Output** (`{ content, details }`, ephemeral — session rollout only, like `x_fetch`):

1. **Synthesis block** — Grok's answer, wrapped untrusted (§6).
2. **Sources block** — for each hydrated citation: index, `@handle`, date, canonical URL, verbatim text (windowed), and a media listing. The first `caption_top` images carry an inline caption (§5). Remaining media are listed with a one-line suggestion: *"to caption/inspect these, call `media` with these URLs."*
3. **Coverage line** — e.g. `Grok cited 9 posts; hydrated 5, 1 citation was unreachable (dropped); captioned 3 images.` Surfaces grounding honestly (no silent truncation — CLAUDE.md "thorough over shortcuts").
4. `details`: structured `{ query, model, effort, citations: [{url, handle, date, hydrated, text?, media?}], droppedCitations, captionedCount, tookMs, cached }` for any programmatic downstream use.

---

## 4. The Grok subagent call

### 4.1 Flow (`execute`)
1. Validate handle exclusivity + caps; build `x_search_filter`.
2. Resolve model from `effort`. Build the request (§2).
3. `fetch` with an `AbortController` wall-clock timeout (`x_search.timeout_ms`, default 60s — reasoning search is slow; see §8). On non-2xx / timeout / abort → graceful failure (§8).
4. Parse synthesis text + citations + `usage`.
5. Hydrate (§5), caption (§5), record spend (§7), assemble output (§3).

### 4.2 System scaffold (the "subagent contract")
Unlike OpenClaw's raw passthrough, we author a fixed system message so output is reliable:
- **Force a live search** and require citations; if nothing relevant is found, say so plainly rather than answering from parametric memory ("If X has no relevant posts, state that explicitly — do not fabricate").
- **Structured answer**: a concise synthesis, then the most relevant posts as a list with `@handle`, date, and URL.
- Note that web results may be used when they add value, but X is the priority corpus.

This scaffold is the main lever that makes the tool's output predictable; it is config-overridable (`x_search.system_prompt`) for tuning without a code change.

---

## 5. Hydration + captioning (the native value-add)

This is where the tool stops being a Grok proxy.

**Hydration.** Take Grok's citation URLs in order, `parseXStatusUrl` each (keep only real `x.com/.../status/…`), de-dup, take the first `hydrate`. For each: `FxTwitterClient.fetchStatus(statusId, screenName)` → `buildTweetDocument(tweet, …)` → verbatim text + numbered media listing (identical to `x_fetch`). A citation that fails to parse or fetch is **dropped and counted** (anti-hallucination signal in the coverage line), never silently.

**Captioning (capped).** Maintainer requirement: *the equivalent of the full enrichment pipeline, including image captioning*, but bounded to cap spend, with a one-call manual path for the rest.

- Across the hydrated tweets, walk their media in order; for the first `x_search.caption_top` (default e.g. 4) **image** items: download via `FetchClient`, then `InferenceClient.caption({ filePath, mimeType, filename, prompt, context: "tool" })` — the *exact* path the `media` tool uses (`src/tools/media.ts:64`). The caption is inlined under its tweet in the Sources block.
- Videos/GIFs are listed but not auto-captioned in v1 (cost/latency); the model can `media`-tool them.
- Media beyond the cap (and all video/audio): listed with their URLs and an explicit suggestion to call the **existing `media` tool** (which already accepts a URL or workspace path and captions up to 20 items in one call). This satisfies "manually invoke it on those with a single tool call" with **zero new surface** — `media` already does it.

**Design decision — ephemeral, not persisted (settled).** Captioning runs *inline in the tool lane*, not by enqueuing into the enrichment/captioning **worker pools**, and nothing is written to `media_assets`/`link_previews`. This matches `x_fetch`'s "ephemeral, no enrichment rows" stance. Durable storage is not merely unnecessary here — it would be *wrong*: a tweet Grok surfaced during a search was never posted in the channel and was never experienced by the bot, so writing it into channel history / the memory-retrieval corpus would fabricate lived context. The only thing persistence could buy is a cache hit if the identical tweet ID is hydrated again later — a marginal win already covered for the realistic case by the §9 Grok-result cache, and cheap to redo regardless (FxTwitter media URLs expire anyway). Inline captioning also keeps spend session-attributable and capped, instead of leaking into the detached captioning lane the §8d ceiling excludes.

---

## 6. Untrusted-content posture

Both Grok's synthesis **and** every hydrated tweet are externally-sourced and a prompt-injection surface (Grok is itself summarising hostile tweet text — a double hop). All such text is wrapped, following the `<untrusted_card_field>` precedent:

```
<untrusted_x_search source="grok-synthesis"> … </untrusted_x_search>
<untrusted_x_search source="tweet" handle="…" url="…"> …verbatim… </untrusted_x_search>
```

Structural strings the tool emits (indices, dates, the coverage line, captions we generated) are trusted; only model/tweet-authored text is wrapped. Bodies via `escapeXml`, attributes via `escapeAttr`, so a tweet quoting `</untrusted_x_search>` can't forge the boundary (cf. the auto-retrieval escaping in ARCHITECTURE.md §9c). The system prompt already teaches the agent to treat `untrusted_*` blocks as data, not instructions.

---

## 7. Cost & usage accounting (subagent = billed)

The tool makes **two** kinds of billable calls — the Grok request and the inline captions — and **both** land in the generic `tool_invocations` ledger under `tool_name: "x_search"`:

- **Grok call**: `parseOpenAiUsage(response.usage)` → price via a `[x_search.cost]` tier (per-MTok input/output, like image-gen's `[image_gen.costs.*]`) → `recordToolUsage({ toolName: "x_search", model, provider: "openrouter", …tokens, cost, toolCallId, ref: "grok" })`.
- **Each caption**: the `caption` result already returns usage; price via the configured captioning model's `[captioning.<model>.cost]` and record a ledger row (`ref: "caption:<statusId>:<index>"`).

This gives **tool-context captions a durable home for the first time** (today they "compute usage … but have no durable home", ARCHITECTURE.md §8c) — a small bonus the ledger's generic-over-`tool_name` design anticipated.

Because the ledger feeds `SessionUsageTracker.recordToolCost` → `combinedCost()` (`src/app.ts:1892`, `src/agent/usage.ts:127`), x_search spend **automatically participates in the §8d session cost ceiling and the soft-warn interjection**. A search that hydrates+captions a lot can trip the same budget guard as any other spend — exactly the "treat it as a real subagent" goal. A ledger-write failure never fails the tool (the search result is already in hand), matching image-gen.

Console surfacing is free: the existing tool-spend line (`tools: N calls · … · $…`) and `/api/cost-overview` already aggregate the `tool_invocations` lane.

---

## 8. Failure, timeout, concurrency posture

- **Tool lane / non-blocking.** Runs in the tool lane off the agent loop; a slow Grok reasoning search never blocks the runner.
- **Separate provider budget.** The Grok call goes to OpenRouter (xAI), a different provider lane than the main Anthropic model, so it is **not** admitted through the main `LlmScheduler` (ARCHITECTURE.md §8a) — no contention with the agent loop's shared rpm budget. It does take a per-host HTTP-limiter slot for OpenRouter like other gateway calls.
- **Timeout.** `x_search.timeout_ms` (default 60s) wall-clock via `AbortController`; on timeout return a graceful "X search timed out" tool result, not a thrown turn-killer.
- **Graceful degradation.** Grok error / no citations / all hydration failures → return whatever we have (synthesis-only, or "no relevant X posts found"), never throw. Hydration/caption failures degrade per-item.

---

## 9. Caching

Short-TTL in-memory cache (OpenClaw used 15 min) keyed on `{normalized query, handles, dates, effort, model}` → the parsed Grok result (pre-hydration). TTL `x_search.cache_ttl_minutes` (default 10). Dampens duplicate/near-duplicate calls when reactive + proactive sessions hit the same topic in a busy channel. Hydration/captioning are **not** cached (cheap to redo, and media URLs expire); only the expensive Grok synthesis is. `details.cached` reports hits.

---

## 10. Config — `[x_search]`

Added to `src/config/schema.ts` (TypeBox), documented under ARCHITECTURE.md §4 on landing. Per the "explicit deployment config" rule, ship defaults in `00-defaults.toml` but require real values in local config.

```toml
[x_search]
enabled = true
model = "x-ai/grok-4.1-fast"            # fast / non-reasoning tier (effort=fast)
deep_model = "x-ai/grok-4.1-fast"       # effort=deep tier (set to a reasoning model)
timeout_ms = 60000
cache_ttl_minutes = 10
hydrate_default = 5
hydrate_max = 10
caption_top = 4                          # images auto-captioned inline; rest → media tool
enable_image_understanding = true        # Grok's own inline vision
enable_video_understanding = false
system_prompt = "<scaffold §4.2>"        # overridable

[x_search.cost]                          # per-MTok, for the tool_invocations ledger
input = 0.0
output = 0.0
```

Routing reuses the existing OpenRouter base URL + `LLM_API_KEY` already in config (no new keys). Construction happens in `buildSessionTools` (`src/app.ts:1704`), closing over the session id + `recordToolUsage`, and is gated on `x_search.enabled` (like `x_fetch`).

---

## 11. Open decisions & out of scope

- **OPEN — exact OpenRouter response fields (§2).** Must be confirmed against a live payload at implementation time; capture one in the commit.
- **Out of scope, future:** thread/conversation expansion of cited tweets; de-dup of cited tweets against ones already enriched in the channel timeline; auto-captioning video/GIF; a model-driven "force this exact search" mode beyond prompt scaffolding.

---

## 12. Test plan

- **Unit (no network):** handle exclusivity + cap validation; `x_search_filter` assembly (omitting empty fields, mutual exclusion); citation extraction over both response shapes + the no-citations case; untrusted-wrap escaping (a tweet body containing `</untrusted_x_search>` cannot forge the boundary); coverage-line accounting (dropped vs hydrated vs captioned counts); cache key normalization + TTL.
- **Mocked clients:** `FxTwitterClient` + `InferenceClient` + the OpenRouter fetch stubbed → end-to-end `execute` asserting Sources block shape, caption cap honoured, `recordToolUsage` called once per Grok call + once per caption with correct token/cost fields, graceful degradation on Grok error / hydration failure / timeout.
- **Manual live smoke (implementation session):** one real query through the LLM gateway to capture the OpenRouter response shape (the §11 open item) and confirm citations hydrate + caption.

---

## 13. Persona-file sync

Per the "persona files tool-sync" rule: on landing, update the workspace `TOOLS.md`/`AGENTS.md`/`TAIL.md` with `x_search` — the flagship intent→tool phrasing ("what's X saying about …", "find posts from @… about …") and the `x_search` (discovery) vs `x_fetch` (known URL) distinction, plus the "suggest the `media` tool for uncaptioned results" handoff.
