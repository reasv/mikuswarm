# SauceNAO Source Lookup — `find_source` tool + skill

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §10 (the `find_source` tool entry) and §4 (the `[saucenao]` config block); retained for review. Code: `src/tools/find-source.ts`, `src/saucenao/rate-limiter.ts`, schema/defaults/app wiring, `test/find-source.test.ts`, and the `saucenao` skill + TOOLS.md/AGENTS.md entries in the workspace. One deliberate deviation from this design: `saucenao.api_key` is **optional** in the schema (not required) and the templated `${SAUCENAO_API_KEY}` is **omitted from `00-defaults.toml`** — env substitution errors on a missing var *before* validation, so shipping the template would break startup for any deployment that hasn't set it; the `enabled ⇒ api_key` invariant is enforced as a cross-field check in `app.ts` instead (matching the `danbooru` optional-credential pattern). This spec is retained in `spec/` after landing per CLAUDE.md.

**Author**: design session 2026-06-14.

---

## 1. Goal

Give the agent a tool to find the **source / origin** of an image it has seen in chat (or any image it can name by workspace path or URL) via [SauceNAO](https://saucenao.com), a reverse-image-search service with strong coverage of anime/illustration sources (Pixiv, Danbooru/booru family, X/Twitter, anime screencaps, manga, DeviantArt, ArtStation, etc.).

This is the **inverse** of the existing `danbooru` tool: `danbooru` searches *by tags → images*; `find_source` searches *by image → source URL + artist/title*. The design intentionally mirrors `danbooru`'s conventions (factory tool + on-demand `SKILL.md`, `guardedFetch`, vision-adaptive output) so the two read as a family.

### User stories

- A user posts an image and asks *"source?" / "sauce?" / "who drew this?" / "where's this from?"* → miku calls `find_source` on the attachment's workspace path, gets ranked candidates, **verifies** the top match (visually if it has vision, by similarity score otherwise), and replies with the source link + artist.
- miku is about to repost/reference an image and wants to credit the artist → looks up the source first.

### Non-goals (v1)

- **No deep enrichment of the source page.** The tool reports what SauceNAO returns (source URLs, artist/title, ids). Following `ext_urls` to scrape the Pixiv/Danbooru page for richer metadata is a possible later extension, not v1. (The agent can already do that with `web_fetch` / `x_fetch` / `danbooru` if it wants.)
- **No Matrix event-id download path.** Chat images are already downloaded to the workspace by the enrichment pipeline and surfaced to the agent as `<attachment … path="./attachments/…">` (`src/context/renderer.ts:178`). The tool takes that path (or an http(s) URL) directly — same input model as `read_image` / `image_generate`. No need to wire `downloadMedia`/`roomId`/event-id resolution. (An attachment not yet downloaded — `processing.downloaded = false` — simply has no path to pass; that is a rare trigger-time race and out of scope.)
- **No persistent daily-quota ledger.** Rate limiting is in-memory + surfaced from SauceNAO's own counters (see §4). A SQLite-backed daily budget was considered and rejected for v1 as over-engineered relative to SauceNAO already being the authority.

---

## 2. SauceNAO API primer

- **Endpoint**: `GET`/`POST https://saucenao.com/search.php`
- **Auth**: `api_key` query/form param (per-account key from a free SauceNAO account).
- **Output**: `output_type=2` → JSON.
- **Image input** (two mutually-exclusive ways):
  - `url=<public image url>` query param — SauceNAO fetches it server-side. Used when the agent passes an http(s) URL.
  - multipart `file=<bytes>` upload — used when the agent passes a workspace path (we read + condition + upload the bytes).
- **Scope**: `db=999` searches **all** indexes (our default — chosen in design). `dbmask`/`dbmaski` are advanced bitmask narrow/exclude controls; exposed via config/param but unused by default.
- **Other params**: `numres` (max results, default 8 here), `minsim` (server-side minimum similarity, we set from `min_similarity`).
- **Response shape** (tolerant — treat all fields optional):
  ```jsonc
  {
    "header": {
      "status": 0,                     // 0 ok; <0 fatal error; >0 some dbs failed (partial)
      "short_limit": "6", "long_limit": "200",
      "short_remaining": 5, "long_remaining": 199,   // authoritative quota counters
      "results_returned": 3
    },
    "results": [
      {
        "header": {
          "similarity": "92.41",       // perceptual-hash match %, the primary identity signal
          "thumbnail": "https://img1.saucenao.com/…",  // preview of the matched source
          "index_id": 5, "index_name": "Index #5: Pixiv - …"
        },
        "data": {
          "ext_urls": ["https://www.pixiv.net/artworks/123"],  // source link(s)
          "title": "…", "member_name": "artist", "member_id": 456,
          "pixiv_id": 123, "danbooru_id": …, "source": "…", "author_name": "…"
          // source-specific; varies per index
        }
      }
    ]
  }
  ```
- **Rate limits (free tier)**: short window ≈ **6 searches / 30s**; long window ≈ **200 / day** (registered; lower unregistered). Exhaustion → HTTP **429** with a message; the JSON also reports `short_remaining`/`long_remaining` on every success so a client can self-pace.
- **Error/status handling**: `header.status < 0` is a fatal API error (bad key, bad image) → report the message as a tool error. `header.status > 0` is partial (some DBs down) → still return the results we got, with a note. HTTP 429 → surface as rate-limited with a retry hint, do **not** treat as a tool crash.

---

## 3. Tool design — `find_source`

**Name**: `find_source` (intent-revealing — "find the source of this image"; backed by SauceNAO). Alternative `saucenao` (provider-named, matching `danbooru`) noted but `find_source` chosen for tool-selection clarity. The skill/config remain `saucenao`-named (backend identity).

### 3.1 Parameters (TypeBox)

| param | type | notes |
|---|---|---|
| `image` | `string` (required) | Workspace-relative path (e.g. `./attachments/…/foo.jpg`, taken from `<attachment path=…>`) **or** an http(s) URL. Path → multipart upload; URL → `url=` passthrough. |
| `limit` | `integer` optional | Max results (1–`max_results_limit`, default `numres`). |
| `min_similarity` | `number` optional | Override config default; results below are dropped and `minsim` is sent to SauceNAO. |
| `view` | `boolean` optional (default false) | Inline the top match thumbnail(s) as vision blocks for visual verification. **Honored only when the model has vision** (`context.modelHasVision`); ignored with a note otherwise (see §3.4). |
| `databases` | advanced, optional | Reserved for `dbmask`/`dbmaski` narrowing. Default unset → `db=999` (all). May be deferred entirely from v1 surface. |

### 3.2 Context dependencies (`FindSourceToolContext`)

Mirrors `XFetchToolContext` / `ImageGenToolContext`:

```ts
interface FindSourceToolContext {
  workspaceRoot: string;                 // resolve the image path
  fetchClient: FetchClient;              // / or call guardedFetch directly
  inlineImageMaxBytes: number;           // budget for inlined thumbnails (resolveReadImageMaxBytes)
  inferenceImageOptions: ImageProcessingOptions;  // condition uploaded image + thumbnails
  modelHasVision: boolean;               // gates `view` (same flag danbooru uses)
  rateLimiter: SauceNaoRateLimiter;      // SHARED singleton (see §4) — not per-session
  recordToolUsage?: (r: ToolUsageRecord) => void;  // optional, for the tool_invocations ledger
  config: SauceNaoToolConfig;            // api_key, base_url, numres, min_similarity, timeouts, caps
}
```

Constructed in `buildSessionTools` (`src/app.ts`), gated on `config.saucenao?.enabled`. The `rateLimiter` is created **once** at app startup and shared across all sessions (the SauceNAO quota is per-account, global — a per-session limiter would not bound it). Construction-time validation: throw if `api_key` missing/empty when enabled (matches `image_gen`'s early validation).

### 3.3 Execution flow

1. **Resolve the image input.**
   - http(s) URL → validate scheme is http/https (defense-in-depth; SauceNAO does the actual fetch server-side). Use `url=` passthrough; no local read.
   - else treat as workspace-relative path → resolve under `workspaceRoot`, reject traversal/absolute escapes (same guard `read_image`/`danbooru` use), read bytes, **condition** through `conditionImageBufferForInference` with `inferenceImageOptions` + a `max_image_bytes` cap (SauceNAO only needs a modest image for perceptual hashing; this bounds upload size and respects SauceNAO's file cap).
2. **Acquire a rate-limiter slot** (`rateLimiter.acquire({ signal: agentSignal, maxWaitMs })`). If the short window is exhausted and the wait would exceed `maxWaitMs`, return a soft text result: *"SauceNAO short-window quota exhausted, ~Ns until a slot — try again shortly"* (with current remaining counts if known). The agent self-throttles rather than the turn blocking.
3. **Call SauceNAO** via `guardedFetch` (POST multipart for upload, or GET with `url=`): `api_key`, `output_type=2`, `db=999`, `numres`, `minsim`. `user-agent: mikuswarm/…`. Bounded by `timeout_ms` (AbortController, composed with `agentSignal`).
4. **Reconcile the limiter** from `header.short_remaining`/`long_remaining` (authoritative) — best-effort sync so the in-memory view tracks reality.
5. **Handle status**: HTTP 429 → soft rate-limited result (+ remaining counts). `header.status < 0` → tool error with SauceNAO's message. `header.status > 0` → proceed with a "partial (some indexes unavailable)" note.
6. **Filter + rank**: drop results below `min_similarity`, sort by similarity desc, cap to `limit`.
7. **Format output** (§3.4).

### 3.4 Output & verification (vision-adaptive)

Reverse-image search produces false positives, so the design centers on **verification**, mirroring `danbooru`'s "verify before you trust" ethos — but the verification signal differs by model capability. The key design decision (from this session): **do NOT auto-caption SauceNAO thumbnails.** A generic caption of a thumbnail ("anime girl, blue hair") does not establish that the match is the *same image* as the query — the **perceptual similarity score does**, far more reliably. This is the deliberate divergence from danbooru's non-vision `describePreview` caption path.

**Text result (always returned)** — a ranked list; per result:
- `similarity%` (lead with it — it is the identity signal)
- source type (`index_name`, e.g. "Pixiv", "Danbooru", "Twitter")
- artist/author (`member_name`/`author_name`) and `title` when present
- source link(s) (`ext_urls`) + notable ids (`pixiv_id`, `danbooru_id`, `source`)
- the matched thumbnail URL

Plus a header line with `short_remaining`/`long_remaining` so the agent (and the skill) can pace itself.

**Vision model + `view: true`** → additionally inline the top-N matched thumbnails (N capped by `view_max_blocks`) as `{ type: "image" }` blocks: fetch each thumbnail via `guardedFetch`, condition to `inlineImageMaxBytes`, base64. If a thumbnail fetch fails (hotlink protection etc.), fall back to its URL in text. This lets miku *see* the candidate and confirm it matches the query image it can also see.

**No-vision model** → `view` is ignored (note in the result text: "model has no vision; relying on similarity score"). Verification guidance lives in the skill: (a) treat high similarity (≥ ~80%) as strong same-image evidence; (b) if a closer look is needed, call the existing **`media`** tool on the source/thumbnail URL with a *targeted* question and compare against the **query image's own enrichment caption** (already in context) — rather than this tool emitting a low-value auto-caption.

**`details`** (structured, not shown to model): full normalized results array, `shortRemaining`/`longRemaining`, `status`, `partial`, `queriedBy: "url"|"upload"`, `viewed` indices.

---

## 4. Rate limiting — `SauceNaoRateLimiter` (in-memory, shared, + surface)

Chosen approach: **in-memory short-window guard + surface SauceNAO's authoritative counters.** No cross-restart persistence.

- A process-wide singleton (constructed in `app.ts`, injected into every session's tool context — like `configureHttpLimiter`/`LlmScheduler` are app-level, not per-session).
- **Sliding-window** counter for the short limit: configurable `short_window_max` per `short_window_ms` (default ~6 / 30000ms, set slightly conservative). `acquire()` resolves when a slot is free or rejects/returns-wait when the window is full beyond `max_wait_ms`. Respects `agentSignal`.
- **Surface, don't hard-enforce, the long/daily window**: parse `long_remaining` from each response, include it in tool output; when it hits 0 the next call's 429 is reported gracefully. (No local daily ledger.)
- After each response, reconcile the window view from `short_remaining` (authoritative beats our local count).
- This composes with the existing per-host HTTP limiter (`http-limiter.ts`) and `guardedFetch` egress guard automatically — the SauceNAO-specific limiter only adds the account-quota dimension those don't model.

Note: `Date.now()` is used for the sliding window — fine here (the workflow-script `Date.now()` ban does not apply to app code).

---

## 5. Configuration — `[saucenao]`

### Schema (`src/config/schema.ts`, new `SauceNaoSchema`, strict)

```ts
const SauceNaoSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),                 // opt-in; default false
  api_key: Type.String({ minLength: 1 }),                 // required when present; matches secret regex → auto-redacted
  base_url: Type.Optional(Type.String({ minLength: 1 })), // default https://saucenao.com
  numres: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  max_results_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  min_similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  db: Type.Optional(Type.Integer({ minimum: 0 })),        // default 999 (all)
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  max_image_bytes: Type.Optional(Type.Integer({ minimum: 1 })),  // upload conditioning cap
  view_max_blocks: Type.Optional(Type.Integer({ minimum: 1 })),
  rate_limit: Type.Optional(StrictObject({
    short_window_max: Type.Optional(Type.Integer({ minimum: 1 })),
    short_window_ms: Type.Optional(Type.Number({ minimum: 1000 })),
    max_wait_ms: Type.Optional(Type.Number({ minimum: 0 })),
  })),
});
// in AppConfigSchema: saucenao: Type.Optional(SauceNaoSchema),
```

Cross-field validation (e.g. `enabled && !api_key`) goes in **`app.ts`**, not the loader — consistent with the proactive-posting precedent (`project_proactive_posting`).

### `config/00-defaults.toml` (shipped defaults; opt-in, no secret)

```toml
[saucenao]
enabled = false
api_key = "${SAUCENAO_API_KEY}"
base_url = "https://saucenao.com"
numres = 8
max_results_limit = 16
min_similarity = 55          # below this is usually noise; agent can lower per-call
db = 999                     # all databases
timeout_ms = 15000
max_image_bytes = 4000000    # condition uploads down to ~4MB
view_max_blocks = 3

[saucenao.rate_limit]
short_window_max = 6
short_window_ms = 30000
max_wait_ms = 8000
```

Operator's local config (`config/90-local.toml`) sets `enabled = true` and provides `SAUCENAO_API_KEY` (env-templated, auto-redacted in logs). Per `feedback_explicit_deployment_config`, the live deployment sets these explicitly.

---

## 6. Skill — `workspaces/miku/skills/saucenao/SKILL.md`

On-demand (`always_loaded: false`), same as `danbooru`. Frontmatter:

```markdown
---
name: saucenao
description: Reverse-image search via the `find_source` tool — find the source/artist of an image someone posted ("source?", "sauce?", "who drew this?").
---
```

Body outline (model the structure on `danbooru/SKILL.md`):

- **When to use**: user asks for the source/sauce/artist of an image; before reposting an image you want to credit. How to name the image — copy the `path="…"` from the `<attachment>` you see in context, or pass an image URL.
- **Reading similarity** (the core skill): ≥ ~80% = almost certainly the same image; ~55–80% = plausible but verify; < 55% = weak/likely wrong (filtered by default). The score, not the picture's "vibe", is the identity signal.
- **Verify before you report** (mirrors danbooru's verify ethos):
  - With vision: set `view: true` to see the top match and confirm it's the same image.
  - Without vision: trust a high similarity; if unsure, ask the `media` tool about the source URL and compare to the query image's caption. Don't claim you "saw" pixels you didn't.
- **Reporting the sauce in chat**: link the source (`ext_urls`), name the artist (`member_name`), say the source type (Pixiv/Twitter/etc.). If only low-similarity hits, say it's uncertain rather than asserting a wrong source.
- **Rate-limit etiquette**: SauceNAO's free quota is tight (~6/30s, ~200/day). The tool surfaces remaining counts — don't spam it; one good lookup per image. If it reports a wait, hold off.
- **NSFW note**: SauceNAO indexes explicit sources too; results may point at NSFW pages. Handle per the bot's normal content norms (same as `danbooru` ratings).

---

## 7. Wiring & files

**New:**
- `src/tools/find-source.ts` — `createFindSourceTool(context): AgentTool` + a small SauceNAO client (request build, multipart vs url, response normalization). Keep the client either inline or in `src/saucenao/` if it grows (parallel to `src/fxtwitter/`); inline is fine for v1.
- `src/saucenao/rate-limiter.ts` (or colocated) — `SauceNaoRateLimiter`.
- `workspaces/miku/skills/saucenao/SKILL.md`.

**Edited:**
- `src/tools/index.ts` — export `createFindSourceTool`.
- `src/config/schema.ts` — `SauceNaoSchema` + `saucenao` on `AppConfigSchema`.
- `config/00-defaults.toml` — `[saucenao]` block.
- `src/app.ts` — build the shared `SauceNaoRateLimiter`; in `buildSessionTools`, `...(config.saucenao?.enabled ? [createFindSourceTool({…, modelHasVision, rateLimiter, …})] : [])`; cross-field validation for `enabled && !api_key`.
- `workspaces/miku/TOOLS.md` — add a `find_source` reference entry (per `project_persona_files_tool_sync`, TOOLS.md must be updated in the same change as the tool).
- `ARCHITECTURE.md` — **in the implementing commit only**: a `find_source` entry under §10 (Agent Tools) and the `[saucenao]` table under §4 (per CLAUDE.md, ARCHITECTURE.md documents only shipped code; this spec does not pre-write those sections).

**`modelHasVision` source**: reuse whatever supplies `danbooru`'s `context.modelHasVision` in `buildSessionTools` (the `models.default.multimodal` resolution) — same plumbing.

---

## 8. Testing

- **Unit (no network)**: response normalizer (similarity sort, `min_similarity` filter, `ext_urls`/artist extraction across a few index shapes); `header.status` handling (fatal vs partial); path resolution + traversal rejection; url-vs-upload branch selection; `SauceNaoRateLimiter` sliding-window admission (deterministic with injected clock) and reconciliation from `short_remaining`.
- **Vision branch**: `view` honored only when `modelHasVision`; ignored-with-note otherwise; thumbnail-fetch failure falls back to URL.
- Follow the Node built-in test runner convention; no live SauceNAO calls in unit tests (stub `guardedFetch`/client). Worktree note: `npm test` needs the native `.node` copied in (`project_token_usage_tracking` gotcha).

---

## 9. Open questions / future extensions

- **Source-page enrichment** (follow `ext_urls` to pull richer Pixiv/Danbooru/X metadata) — deferred; agent can chain existing tools.
- **Provider name vs intent name** — shipping as `find_source`; revisit if a second backend (e.g. IQDB, ascii2d, trace.moe for anime screencaps) is ever added, at which point `find_source` as a provider-agnostic front with a `backend` param becomes attractive.
- **trace.moe** for anime *screencap → episode/timestamp* is a natural sibling capability but a separate API/tool; out of scope here.
- **Daily-quota persistence** — only if the in-memory + surface approach proves insufficient in practice.
```
