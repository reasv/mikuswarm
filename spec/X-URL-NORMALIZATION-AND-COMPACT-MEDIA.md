# Spec: X URL mirror-domain coverage + compact-tier media fidelity + enrichment tools in generation sessions

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §7a (URL detection, compact-tier rendering), §4 `[fxtwitter]`, §9b (generation-session read/enrich tools); retained for review. The optional §3.2 compact poll/community-note addition was NOT implemented (left as a future decision); §3.3 reply-context media WAS implemented.
**Extends**: spec/FXTWITTER-ENRICHMENT.md (IMPLEMENTED — ARCHITECTURE.md §7a). This is a follow-up that closes two gaps observed after that feature landed, plus a corollary about tool availability in generation sessions.
**Depends on**: `src/fxtwitter/url.ts`, `src/context/renderer.ts`, `src/context/hydrate.ts`, `src/enrichment/worker.ts`, `src/tools/x-fetch.ts`, `src/config/schema.ts`, `config/00-defaults.toml`, `src/agent/factory.ts` (`filterTools`).
**ARCHITECTURE.md target once implemented**: amendments to §7a (URL detection, compact-tier rendering), the `[fxtwitter]` table in §4, renderer notes in §9, and the generation-session tool-allowlist note (§8/§9b/§9c or the `session_types` description in §4). **No schema migration, no new tables, no new tools, no tool-count change.**

---

## 1. Background & the three changes

Three independent but related gaps in the shipped FxTwitter enrichment (spec/FXTWITTER-ENRICHMENT.md):

- **A — Mirror-domain coverage & URL normalization.** Status URLs on x.com/twitter.com and the FixTweet share domains (`fxtwitter`/`fixupx`/`fixvx`/`twittpr`) are already recognized, canonicalized to `https://x.com/{screen|i}/status/{id}`, and have `/photo/N` · `/video/N` · query strings collapsed (`src/fxtwitter/url.ts`). What is **not** handled: (1) other mirror domains people paste daily — notably **`vxtwitter.com`** and legacy **`pxtwitter.com`** — and (2) **subdomains** of any recognized host, because matching is exact-hostname against a hand-enumerated set (`www.`/`mobile.` are listed one-by-one; `d.fxtwitter.com`, `g.fxtwitter.com`, `m.twitter.com` all fall through). The result: those links get either a bare Synapse og-card or nothing, instead of being collapsed to the canonical tweet and enriched.

- **B — Compact-tier media is caption-blind.** The compact renderer summarizes a tweet's media as bare counts (`compactMediaCounts` → `"1 photo"`, `src/context/renderer.ts`), dropping **captions, alt text, and paths**. A tweet whose entire content is one image, embedded in a message whose entire content is that tweet, renders in compact tier as `[tweet: Author (@handle) · 1 photo]` — **zero signal**. This is not hypothetical for aged context: generation sessions (summarize/condense/diary) build with `state: undefined` (`src/context/builder.ts`), so their event window starts at compact tier and is promoted to rich **only if the token budget allows** (`resolveBoundaryIndexes`, `src/context/compaction.ts`). The summarizer therefore routinely sees the caption-less rendering and loses the content entirely — exactly when faithful capture matters most.

- **C — Generation sessions can't recover dropped media.** diary = `["diary_tool"]`, summarize/condense = `["summary_tool"]` (`config/00-defaults.toml`, enforced by `filterTools`, `src/agent/factory.ts`). These sessions have **no escape hatch**: when a tweet is marked `[truncated — full text available via the x_fetch tool]`, or a media caption is missing/aged out, the session literally cannot fetch it. They should be able to read enrichment they're being asked to compress.

These are complementary: B reduces how often C is needed (inline captions mean fewer fetches), and C is the backstop for what B can't carry cheaply (full text behind a truncation hint, individual photos behind a mosaic, un-captioned media).

### Non-goals

- **No redirect/shortener resolution.** `t.co`, `bit.ly`, etc. require a live network round-trip to resolve and are out of scope. (t.co-wrapped x.com links normally arrive already-expanded in Matrix message bodies; the residual case is rare and not worth a per-URL HEAD.) "Redirect-sites" in the original ask means the mirror domains, which §A handles statically by path.
- **No Nitter.** Excluded by the original spec and still excluded — its instances churn and many are dead/hostile.
- **No new render tier, no compaction-budget changes.** B works strictly within the existing compact tier by spending a bounded number of tokens on captions that were already computed and persisted.
- **No widening of write/messaging tools into generation sessions.** C adds only read/enrich tools; `send_message`, `delete_message`, etc. stay out.

---

## 2. Part A — Mirror-domain coverage & subdomain tolerance

### 2.1 Host matching becomes base-domain + subdomain-suffix

Replace the exact-match `STATUS_HOSTS` Set (which forces enumerating every `www.`/`mobile.` variant) with a **base-domain set** and a suffix match:

```ts
const STATUS_BASE_HOSTS = [
  "x.com",
  "twitter.com",
  // FixTweet / FxTwitter share domains (users paste these for better previews).
  "fxtwitter.com",
  "fixupx.com",
  "fixvx.com",
  "twittpr.com",
  "pxtwitter.com",   // legacy FxTwitter domain, still in the wild
  // FixTweet joke aliases (same path structure; used in chat).
  "girlcockx.com",
  "stupidpenisx.com",
  "cunnyx.com",
  // vxtwitter family.
  "vxtwitter.com",
];

function isStatusHost(hostname: string, bases: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return bases.some((base) => h === base || h.endsWith("." + base));
}
```

`endsWith("." + base)` accepts `www.`, `mobile.`, `m.`, `d.`, `g.`, … of any listed base for free, and **cannot** false-positive on `notfxtwitter.com` or `evilx.com` (no leading dot) — the previous hand-enumeration is both incomplete and a maintenance trap.

The rest of `parseXStatusUrl` is unchanged: protocol check, `STATUS_PATH` regex (already tolerant of `/photo/N`, `/video/N`, trailing segments, query strings), screen-name lowercasing, canonicalization to `https://x.com/{screen|i}/status/{id}`. `extractXStatusUrls` / `stripXStatusUrls` are unchanged except they consult the new matcher.

### 2.2 Config-extensible host list

The mirror ecosystem churns (new FixTweet aliases appear; domains get seized/replaced). To avoid a code change + redeploy per new domain, add an optional config array merged into the base set:

```toml
[fxtwitter]
# … existing keys …
extra_status_hosts = []   # additional mirror base-domains, e.g. ["girlcockx.com"]
```

- Resolved in `resolveFxTwitterConfig` (`src/fxtwitter/types.ts`) into `config.statusHosts = [...STATUS_BASE_HOSTS, ...extra]` (lowercased, deduped).
- Threaded to the two consumers: the enrichment worker (`extractXStatusUrls`/`stripXStatusUrls`) and the `x_fetch` tool (`parseXStatusUrl`).
- **Signature change, default-preserving**: `parseXStatusUrl(input, bases = STATUS_BASE_HOSTS)`, `extractXStatusUrls(body, bases = STATUS_BASE_HOSTS)`, `stripXStatusUrls(body, bases = STATUS_BASE_HOSTS)`. Existing callers/tests that pass no `bases` keep working against the built-in set; the worker and tool pass the config-extended set.

The known FixTweet joke aliases (`girlcockx.com`, `stupidpenisx.com`, `cunnyx.com`) are real and used, so they ship **in-code** in `STATUS_BASE_HOSTS` for zero-config coverage; `extra_status_hosts` remains the redeploy-free path for the next domain the ecosystem invents.

### 2.3 Behavior with enrichment disabled

Unchanged from the original spec: when `fxtwitter.enabled = false`, X URLs are still **partitioned and stripped** from the Synapse body (no bare og-card) but not enriched. Mirror domains that previously slipped past the matcher and produced a Synapse card for `fxtwitter.com`/`vxtwitter.com` will now be stripped too — the desired "collapse to the tweet" behavior even in the disabled case.

---

## 3. Part B — Compact-tier media fidelity

### 3.1 What changes

In `compactLinkPreview` / `compactTweetPart` / `compactMediaCounts` (`src/context/renderer.ts`), per-tweet-node media stops being counts-only and carries the **already-persisted caption (preferred) or alt text (fallback)**, bounded.

Captions live on the hydrated media assets (`preview.media: AttachmentMeta[]`), not on the payload `XMediaSlot`. So `compactLinkPreview` builds the same `assetById` map the rich path already builds (`renderXPreview`) and threads it into `compactTweetPart` → a new `compactMediaParts(slots, assetById)`:

```
[tweet: Frieren Daily (@FRIERENanime_): "Tweet text…" · video: an animated scene of Frieren casting a spell over a moonlit field · photo: a four-panel collage of the party at camp]
```

`compactMediaParts` rules, per slot in payload order:
- Caption from `assetById.get(slot.assetId)?.caption`, else `slot.altText`, truncated to a new renderer constant `MAX_COMPACT_MEDIA_CAPTION = 200` (sibling of the existing `MAX_COMPACT_TWEET_TEXT = 280`). Rendered as `"{kind}: {text}"` where `kind ∈ {photo, mosaic, video, gif}` (`video_thumbnail` → `video`; mosaic keeps its `photoCount`, e.g. `mosaic(4): …`).
- Slots with **no caption and no alt** fall back to the existing aggregate count form (`"2 photos"`), appended after the captioned entries — so a tweet with 3 plain photos + 1 captioned video reads `· video: … · 3 photos`, not four noisy fragments.
- Failed-download slots (`asset.processing?.downloaded === false`) render `"{kind}: [media unavailable]"` — visible, never silent (parity with the rich `status="failed"` convention).

This applies to the main tweet (cap 200) and, identically, the quoted tweet. The tweet/quote **text** caps (280/140) are unchanged.

### 3.2 What stays dropped in compact (and why)

- **Paths** — still omitted for tweet media in compact. A summarizer that needs the bytes uses Part C's `x_fetch`/`media` on the tweet URL (which is present in the message body); carrying long workspace paths in aged context is not worth the tokens.
- **Stats** (replies/retweets/likes/views) — low signal for summarization; stays rich-only.
- **Polls / community notes** — content, but lower-frequency. **Recommended minimal addition** (smaller, can ship together or follow): a compact poll renders as the leading choice only (`poll: "<winning choice>"`), and a community note as a short truncated marker (`note: <first 120 chars>…`). Flagged as a decision point rather than baked in, to keep the primary change (captions) focused.

### 3.3 Audit of other compact-tier media drops (corollary "what else are we dropping")

A sweep of `renderCompactMessage` and its helpers found one more genuine media drop beyond tweets:

- **Reply-context media is dropped in compact.** `compactReply` (`src/context/renderer.ts`) renders only sender/time/body — a compact reply to a media-only message shows nothing of the media. **Recommended fix** (small): append reply attachment/linked-media filenames + captions to the compact reply line, bounded (mirror the message-level `[attachment: … caption=…]` form, one short entry, capped). Lower priority than tweets but the same class of bug.
- **Not a gap:** top-level message `attachments` and `linkedMedia` in compact **already** include `caption` (300 chars) and `localPath` (`renderCompactMessage`). Generic link previews already carry title + 1000-char description. Reactions are deliberately rich-only (cache-volatility design, ARCHITECTURE.md §9f) — out of scope.

### 3.4 Token cost

Bounded and deliberate: ≤200 chars per captioned slot, captions already computed/persisted (no new work at render time), mosaics collapse a multi-photo set into one caption. Typical tweets contribute 1–2 caption strings. The tradeoff — a media-only tweet was costing ~8 useless tokens and conveying nothing; it now costs ~40–60 and conveys the content — is the entire point. No compaction-budget knobs change; if a window is caption-heavy the existing compact→drop boundary handles it.

---

## 4. Part C — Read/enrich tools in generation sessions

### 4.1 Allowlist changes (`config/00-defaults.toml`)

Extend the `tools` allowlists for the generation session types. The web-fetch capability is **not** the native `web_fetch` tool — that is intentionally globally disabled (§4.2). Live web access is provided by the **Exa MCP server** (`[mcp.servers.exa]` in `90-local.toml`), whose tools are registered as `mcp_exa_web_fetch_exa`, `mcp_exa_web_search_exa`, `mcp_exa_web_search_advanced_exa` (MCP naming is `mcp_${server}_${tool}`, `src/mcp/tool-adapter.ts`). The generation sessions allowlist the Exa **fetch** tool:

```toml
[agent.session_types.diary]
tools = ["diary_tool", "x_fetch", "media", "read_image", "mcp_exa_web_fetch_exa"]

[agent.session_types.summarize]
tools = ["summary_tool", "x_fetch", "media", "read_image", "mcp_exa_web_fetch_exa"]

[agent.session_types.condense]
tools = ["summary_tool", "x_fetch", "mcp_exa_web_fetch_exa"]
```

Rationale per tool:
- **`x_fetch`** — recovers full text behind a `[truncated]` hint and individual photos behind an enrichment mosaic; resolves a tweet URL the session sees in a body but that never got enriched. Primary backstop for B. Governed only by `fxtwitter.tool.enabled` (default true); not affected by the native-web-tool disable.
- **`media`** — fetch + caption an image/video/audio by path or URL on demand (e.g. an aged-out or never-captioned asset). Note: this issues a multimodal model call inheriting the session's background priority — fine under the scheduler, just not free.
- **`read_image`** — load a workspace image inline (when the session model is multimodal and wants to look rather than read a caption).
- **`mcp_exa_web_fetch_exa`** — fetch the contents of a non-X URL the session sees in a body (the Exa replacement for `web_fetch`). Open-ended search (`mcp_exa_web_search_exa`) is deliberately **not** added — a background summarizer should recover *referenced* content, not go spelunking; add it only if a need shows up.
- **`condense`** operates over existing summary text (no raw media events in scope), so `media`/`read_image` are pointless there; it keeps `x_fetch` and the Exa fetch tool for URL recovery only.

### 4.2 Native web tools stay globally disabled (by design)

`web_fetch`/`web_search` are in `disabled_tools = ["web_fetch", "web_search"]` (`config/00-defaults.toml`) **because the Exa MCP replaces them** — that is the intended configuration, not an oversight. The global disable is applied **before** the session-type allowlist (`src/app.ts` → `filterTools`), so a tool must clear both gates. Consequences for this spec:
- Do **not** add `web_fetch` to any allowlist — it is inert (globally disabled) and the wrong tool; use `mcp_exa_web_fetch_exa`.
- An allowlist may name an MCP tool that isn't registered in a given config (e.g. `00-defaults.toml` has no `[mcp.servers.exa]`); `filterTools` is a name intersection, so the entry is simply a no-op until the Exa server is present. Listing it in defaults declares intent and activates automatically wherever Exa is configured (the live deployment, via `90-local.toml`).

### 4.3 Deployment-config parity

Per project policy (memory: explicit-deployment-config), `90-local.toml` overrides `session_types` wholesale. The `00-defaults.toml` change above is necessary but **not sufficient** — the live deployment's `90-local.toml` must mirror the expanded allowlists, or generation sessions there keep only their single tool. The implementing commit should update both, and the change note should say so explicitly.

### 4.4 Budget & priority

No budget changes. Generation sessions keep `max_tool_calls = 30`, `max_turns = 15`, background/background_low priority. These tools are escape hatches expected to fire rarely; the existing per-session caps and the LlmScheduler admission/priority machinery bound their cost.

---

## 5. Testing

- **url.ts (Part A)**: `vxtwitter.com`, `pxtwitter.com` recognized + canonicalized; subdomain forms (`d.fxtwitter.com`, `m.twitter.com`, `www.vxtwitter.com`) recognized; false-positive guard (`notfxtwitter.com`, `evilx.com`, `x.com.evil.com` → null); `extra_status_hosts` extends the set; default-arg callers unchanged; existing `/photo/N`, bare-id, `/i/status/` cases still pass.
- **renderer.ts (Part B)**: compact tweet with a captioned photo → caption present, bounded at 200; mosaic with caption → `mosaic(4): …`; mixed captioned + plain media → captioned entries then count fallback; alt-text-only slot → alt used; failed slot → `[media unavailable]`; quote media captioned independently; no-media tweet unchanged; reply-context media (3.3) if included.
- **config**: `resolveFxTwitterConfig` merges/dedupes `extra_status_hosts`; cross-field validation unaffected; the generation-session allowlists parse and `filterTools` yields the expected intersection (the `mcp_exa_web_fetch_exa` entry is a no-op where no Exa server is registered, present where it is; native `web_fetch` never appears, being globally disabled).
- **No DB/hydration tests** — no schema change; captions read from the already-hydrated `preview.media` assets.

---

## 6. Implementation checklist

1. `src/fxtwitter/url.ts`: base-host set + `isStatusHost` suffix matcher; `bases` param (default-preserving) on `parseXStatusUrl`/`extractXStatusUrls`/`stripXStatusUrls`; add `vxtwitter.com`, `pxtwitter.com`; update the header comment.
2. `src/fxtwitter/types.ts` + `src/config/schema.ts` + `config/00-defaults.toml`: `fxtwitter.extra_status_hosts` key; resolve into `config.statusHosts`.
3. `src/enrichment/worker.ts` + `src/tools/x-fetch.ts`: pass `config.statusHosts` to the url helpers.
4. `src/context/renderer.ts`: `MAX_COMPACT_MEDIA_CAPTION`; thread `assetById` into compact tweet rendering; `compactMediaParts` (caption→alt→count fallback, failed-slot marker); apply to tweet + quote. (Optional 3.2 poll/note; optional 3.3 reply media.)
5. `config/00-defaults.toml`: expand diary/summarize/condense `tools` allowlists.
6. ARCHITECTURE.md: amend §7a (URL detection — mirror coverage + subdomain tolerance + `extra_status_hosts`; compact-tier rendering — captions/alt now included), §4 `[fxtwitter]` table (`extra_status_hosts`), §9 renderer notes, and the `session_types` allowlist note. Update spec status header to IMPLEMENTED in the landing commit (retain the file).
7. **Deployment**: mirror the §4.1 allowlist change in `90-local.toml` (which overrides `session_types` wholesale and is where `[mcp.servers.exa]` lives, so `mcp_exa_web_fetch_exa` resolves there); add `extra_status_hosts` if any new mirror domains are wanted.
