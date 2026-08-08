# YouTube Video Understanding — `youtube_fetch` tool + `media` routing + link enrichment

**Status**: PROPOSED.

**Author**: design session 2026-08-01.

---

## 1. Goal

Give the agent the ability to understand linked YouTube videos. Today a YouTube URL is a
dead end at every layer:

- The **link-preview pipeline** yields only `og:title`/`og:description` (plus a captioned
  thumbnail on the Matrix/Synapse path) — the agent cannot tell a 40-second meme from a
  three-hour lecture, let alone what is said in it.
- The **`media` tool** rejects YouTube URLs: it requires the URL to serve media bytes, and
  a watch page is HTML.
- The **captioning pipeline** never sees YouTube content because `processLinkedMedia`
  only downloads direct media URLs (known extensions / known CDN hosts).
- **No reply model receives video content blocks** — all video understanding is
  caption-model-mediated (§8a gating is image-only) — so there is no "native" path either.

### User stories

- A user posts a YouTube link and asks *"thoughts?"* → the agent sees an enriched preview
  (title, channel, duration, chapters, start of the transcript), calls `youtube_fetch` to
  read the relevant part of the transcript, and answers — **zero video-inference cost**.
- *"What happens at 12:30?"* / the transcript is missing or the content is visual →
  the agent calls `media` with the YouTube URL and `start_time: 750`, and the existing
  video caption lane describes that segment (frames + audio) under the existing
  `max_duration_seconds` cap.
- A music video / no-dialogue clip → transcript tier is empty; the agent escalates to
  segment analysis directly.

### Non-goals (v1)

- **No automatic visual captioning of posted YouTube videos.** Video inference at
  ~300 tokens/sec (Gemini default media resolution) is far too expensive to run
  unprompted; auto-enrichment is text-only (metadata + transcript, no LLM calls).
- **No YouTube-URL passthrough to the caption model.** OpenRouter does support
  `video_url: <youtube link>` — but only when routed to Gemini on **AI Studio** (not
  Vertex), with no segment/offset/fps control, so the *whole* video is tokenized: past
  ~7 minutes it exceeds a 128k caption-model context outright. Unbounded cost, provider
  pinning, no reuse of the 2-minute discipline. Documented as a possible future
  fast-path config for short videos (§11); rejected for v1.
- **No native video content blocks to reply models.** Even a reply model declaring
  `input_modalities: ["video"]` gets no video blocks — the context builder stays
  image-only. Video understanding remains tool-mediated (caption lane), matching the
  cost-control posture of the rest of the media system. Revisit only if a deployment
  demand materializes (§11).
- **No playlists, no live streams, no premieres.** Single, finished, public videos only
  (`--no-playlist`; `is_live`/upcoming → tool error).
- **No non-YouTube sites** through the structured path, despite yt-dlp supporting
  thousands. The URL partition (§5) gates the pipeline to recognized YouTube URLs; a
  generic "any yt-dlp site" mode is future work (§11). (The sandbox escape hatch, §12,
  covers exotic one-offs.)

---

## 2. Acquisition backend: yt-dlp (decision)

**Decision (owner, 2026-08-01): yt-dlp as the sole backend.** The alternative — a
pure-JS Innertube client (youtubei.js) — was considered and rejected: its only
advantages are avoiding a system dependency and an in-process typed API, neither of
which is a functionality or reliability argument. yt-dlp subsumes everything the JS
client offers (metadata via `--dump-json`, transcripts via subtitle extraction,
segment-ranged downloads via `--download-sections`) and has a much larger maintainer
team tracking YouTube's extractor churn. A dual/pluggable backend adds complexity with
no complementary capability. This is a Docker-first project; shipping a binary in the
image is not a real cost.

### Invocation contract

One thin wrapper module (`src/youtube/ytdlp.ts`) owns all subprocess invocation. Three
operations, each a separate `yt-dlp` run:

1. **`probe(videoId)`** → metadata: `yt-dlp --dump-json --no-playlist --skip-download <url>`.
   Parsed fields (all tolerant/optional): `id`, `title`, `channel`, `channel_id`,
   `duration`, `upload_date`, `view_count`, `like_count`, `description`, `chapters[]`
   (`title`, `start_time`, `end_time`), `subtitles`/`automatic_captions` (available
   tracks + languages), `is_live`, `live_status`, `age_limit`, `thumbnail`.
2. **`transcript(videoId, lang?)`** → subtitle JSON:
   `yt-dlp --skip-download --no-playlist --write-subs --write-auto-subs --sub-format json3 --sub-langs <lang> -o <tmp>` —
   prefer a **manual** subtitle track in the video's original language, fall back to
   auto-generated captions, then to any available track. json3 events are folded into
   plain text with periodic `[m:ss]` timestamp markers (one marker roughly every
   30–60s of video / at caption-group boundaries) so the agent can map transcript
   positions to `start_time` values for segment analysis. This synergy is the point of
   the two-tier design.
3. **`download(videoId, opts)`** → one media file. `opts`: `startSec?`/`durationSec?`
   (→ `--download-sections "*<start>-<end>"`; omitted = whole video), `maxHeight`
   (→ `-f "bv*[height<=?<h>]+ba/b[height<=?<h>]" --merge-output-format mp4`),
   `audioOnly?` (→ `-f ba -x --audio-format m4a`), `maxBytes` (→ `--max-filesize`),
   `outPath`. One implementation serves both callers: the `media` analysis lane (§7:
   segment cut at `media.video.max_resolution`/`max_duration_seconds`) and the
   workspace file download (§6a). ffmpeg is already in the image
   (`--download-sections` requires it).

Common flags on every run: `--no-playlist`, `--proxy <network.http_proxy_url>` (when
set — yt-dlp does **not** ride `FetchClient`/`guardedFetch`, so the proxy must be
passed explicitly; this is the one egress path in the app that bypasses the shared
fetch stack, and it is confined to YouTube URLs by the §5 partition), `--socket-timeout`,
and a hard subprocess wall-clock timeout (`[youtube].timeout_ms`, kill on expiry).
Cookies: `[youtube].cookies_file` (optional, default unset) is passed as `--cookies`
for deployments that hit bot-detection walls. Stderr is captured and surfaced (bounded)
in error messages — yt-dlp's messages ("Video unavailable", "Sign in to confirm your
age", geo errors) are exactly what the agent should see.

**Concurrency**: a module-level semaphore caps concurrent yt-dlp subprocesses
(`[youtube].concurrency`, default 2) across all callers (enrichment + both tools).
Probe/transcript runs are cheap; downloads are the reason for the cap.

### Binary shipping & graceful degradation

- **Agent image** (`Dockerfile`): install the pinned standalone `yt-dlp` release binary
  (single file, no Python runtime needed) into `/usr/local/bin`. Pin the version with a
  build arg so it is bumped deliberately; yt-dlp staleness is the operational knob when
  YouTube churns.
- **Non-Docker / binary absent**: at app wiring, probe `[youtube].yt_dlp_path`
  (`--version`, short timeout). On failure: log one structured warning, do **not**
  register the tools, and the enrichment stage (if enabled) marks previews
  `fetch_status: "failed"` — never a crash. `[youtube].enabled` (default **true**)
  is the master switch; the effective feature is `enabled && binary present`.
- **Sandbox image**: see §12.

---

## 3. Design overview — three tiers

| Tier | What | Cost | When |
|---|---|---|---|
| **T1: enriched preview** | metadata + chapters + transcript head on the link preview (automatic for caption-eligible messages) | 1–2 yt-dlp runs per posted link; no LLM | passively, when a YouTube link is posted on a message captioning would touch |
| **T2: `youtube_fetch`** | full metadata + description + chapters + windowed timestamped transcript | 1–2 yt-dlp runs; no LLM | agent wants to *read* the video |
| **T3: `media` segment analysis** | download one ≤`max_duration_seconds` segment → existing video caption lane | download + one video-caption call (~36k input tokens / 120s at default media resolution) | agent wants to *watch* a segment |

T1/T2 are nearly free and will answer most questions about talk-heavy content; T3 is
the existing 2-minutes-at-a-time video discipline, extended to YouTube sources
unchanged. Nothing new is invented at the inference layer.

---

## 4. URL recognition (§5 partition input)

`src/youtube/url.ts`: `parseYouTubeUrl(url) → { videoId, startSec? } | null`.
Recognized hosts/forms (http/https, with/without `www.`/`m.`/`music.`):

- `youtube.com/watch?v=<id>` (+ `t=`/`start=` → `startSec`)
- `youtu.be/<id>` (+ `t=`)
- `youtube.com/shorts/<id>`, `youtube.com/live/<id>`, `youtube.com/embed/<id>`

`<id>` is the canonical 11-char `[A-Za-z0-9_-]` video id. Everything else (channel,
playlist, search URLs) is unrecognized → generic link-preview path as today.

---

## 5. Enrichment stage (T1) — default ON for caption-eligible messages

**Decision (owner, 2026-08-01 revision):** the enrichment tier follows the captioning
gating model, not a blanket default-off. It is **on by default for exactly the
population captioning covers** — the `captionEligibleSql` predicate
(`src/storage/database.ts`): trigger-group messages, promoted backfetch events, and
assistant messages when `caption_assistant_messages` is set. The non-default opt-in is
`enrich_all` (analog of `caption_all`): enrich *every* message carrying a YouTube link
(still no LLM cost — the exposure is YouTube traffic volume, not inference spend).

Modeled directly on the FxTwitter partition (§7a): when `[youtube.enrichment].enabled`
(default **true**), `fetchLinkPreviews` partitions recognized YouTube URLs away from
the generic preview path into a YouTube stage for eligible events:

- **Eligibility**: the captioning predicate above, evaluated with the same
  trigger-wait grace captioning uses (`trigger_wait_timeout_ms`) so a link in the
  very message that triggers a reply is enriched before context assembly, not raced.
  `enrich_all = true` removes the gate. An **ineligible** event's YouTube URL falls
  through to the generic preview path (og:title/description as today) — the row is
  not parked for later upgrade; a message that enters a trigger group only later
  keeps its generic preview (deliberate simplification — the agent covers that case
  with `youtube_fetch`, and reply-context preview fetches run at trigger time when
  eligibility already holds).

- `probe()` + `transcript()` (transcript failure is non-fatal — metadata-only payload).
- Store one `link_previews` row per URL: `source_kind: "youtube"`, `title`, `description`
  (channel + duration line), and **`payload_json`** carrying the structured payload:
  `{ videoId, title, channel, durationSeconds, uploadDate, viewCount, chapters[],
  transcriptHead, transcriptLang, transcriptKind: "manual"|"auto"|"none" }`.
  `transcriptHead` is the first `[youtube.enrichment].transcript_head_chars`
  (default 1000) of the folded transcript.
- **Thumbnail**: download `thumbnail` via the shared `FetchClient` and store as a
  `preview_media` media asset (`caption_status: "pending"`) — parity with the Synapse
  og:image path today, and it makes the *direct-scrape* (Discord) path finally show
  YouTube visuals. Note this is the one LLM cost in T1 (one image caption per link),
  governed by the existing captioning gates (trigger-group, `caption_all`, budgets);
  `[youtube.enrichment].thumbnail` (default true) turns it off entirely.
- Disabled (`enabled = false`): YouTube URLs stay on the generic preview path for
  every message — behavior as today.

**Rendering** (`src/context/renderer.ts`), same two-tier scheme as tweets:

- Full tier: the `<link_preview>` body gains a structured block — duration/channel/date
  line, chapter list (`[12:34] Chapter title`), then `transcript_head` (marked as
  partial, pointing at `youtube_fetch`). Transcript text is externally-sourced →
  rendered inside the existing untrusted-content conventions (escaped, clearly
  attributed), like tweet bodies.
- Compact tier: `[youtube: "Title" · Channel · 47:12 · transcript head…]` bounded by
  the existing `MAX_COMPACT_MEDIA_CAPTION`-style cap (200 chars).

---

## 6. `youtube_fetch` tool (T2)

An `x_fetch`-family tool (`src/tools/youtube-fetch.ts`): ephemeral in the `x_fetch`
sense — windowed canonical text document, no DB writes; downloads (§6a) are ordinary
workspace files.

- **Params**: `url` (any recognized form or bare 11-char id), `offset` (default 0),
  `max_chars` (default `[youtube.tool].default_max_chars` 4000, cap `max_chars_limit`
  16000), `transcript_lang` (optional BCP-47; default = original/default track).
- **Document layout**: header (title, channel, upload date, duration, views), bounded
  description, chapter list with timestamps, then the full folded transcript with
  `[m:ss]` markers. Document bounded at `[youtube.tool].max_total_chars` (default
  32768); returned as the `[offset, offset+max_chars)` window with the standard
  `[truncated — continue with offset=N]` trailer and `details: { totalChars,
  nextOffset, truncated }` — identical mechanics and config validation
  (`default_max_chars <= max_chars_limit <= max_total_chars`, fail-fast) to
  `x_fetch`.
- **Cross-links**: when a URL carried `t=`, the window opens at the transcript position
  nearest that timestamp (offset auto-computed) — the agent lands where the user
  pointed. The doc's trailer notes: *"To watch a segment, call `media` with this URL
  and `start_time`."*
- **No transcript** (none/disabled/music): document still returns metadata +
  chapters + description, with an explicit `Transcript: none available` line and the
  `media` hint.
- **Errors**: unavailable/private/age-restricted/geo/live surface yt-dlp's message;
  live/upcoming refused explicitly.
- **Untrusted wrapping**: description and transcript are external content — wrap in
  the established untrusted envelope (escaped, like `x_search`/`x_fetch` bodies);
  headers/structure the tool emits stay trusted.
- **Registration**: when `[youtube].enabled` and the binary probe passed. Persona docs
  (TOOLS.md/AGENTS.md) get the standard entry in the implementing change.
- **Billing**: no LLM calls → nothing to bill. Subprocess runs are free.

### 6a. Workspace file downloads

**Decision (owner, 2026-08-01):** the agent can download YouTube videos as ordinary
workspace files — useful for re-sharing via `send_message`, archiving, sandbox
processing — without hand-driving yt-dlp over `bash`. This is `youtube_fetch`'s
escalation step, mirroring `x_fetch`'s `download_media`:

- **Params** (on `youtube_fetch`): `download: "video" | "audio"` switches the call
  from document mode to download mode; optional `max_height` (default and cap
  `[youtube.tool].download_max_height`, default 720), optional `clip_start` /
  `clip_duration` (seconds → `--download-sections`) to save just a clip; omitted =
  full video. `audio` grabs the best audio track as M4A (music use case).
- **Destination**: `downloads/youtube/{videoId}/{sanitized-title-slug}[-<start>-<end>].{mp4|m4a}`
  under the workspace — exclusive-create with collision suffixes, exactly the
  `x_fetch` convention. Files are ordinary workspace files (agent/operator manage
  cleanup, as with `downloads/x/`).
- **Return**: metadata header + one line per saved file (workspace-relative path,
  bytes, duration/resolution) — ready to pass to `send_message`, `media`, or sandbox
  `bash`. No transcript document in download mode.
- **Bounds**: `--max-filesize` from `[youtube].max_download_bytes` still applies; on
  abort the error suggests lowering `max_height`, using `download: "audio"`, or
  clipping. Same refusals as document mode (live/upcoming/playlists). No LLM cost;
  disk is the only spend.

---

## 7. `media` tool routing (T3)

`loadMedia` in `src/tools/media.ts` gains one branch: if `parseYouTubeUrl` recognizes
the source, resolve via `download(videoId, start_time ?? urlT ?? 0, max_duration_seconds)`
instead of `FetchClient`. The rest of the path is **unchanged**: the downloaded MP4
segment flows through `processVideoForInference` → video caption lane → caption text.

- **`start_time` semantics preserved**: the segment is *cut at download*, so the
  wrapper threads the probed total duration through to the truncation-warning
  machinery (synthesizing `processedRange`/`totalDuration`) so the agent still sees
  `Warning: media duration is 47:12. Only 5:00-7:00 was processed… Use start_time to
  analyze a different segment.` — the exact affordance that makes segment-by-segment
  traversal discoverable today.
- **Caching**: segment downloads are cached in the existing `MediaCache` keyed on
  `(videoId, startSec, durationSec, resolution)` (no content hash — the source is
  remote), same LRU/atomic-write behavior. Re-analyzing the same segment with a
  different prompt costs no second download.
- **Cost**: identical to any 120s/480p video today (~36k input tokens at default media
  resolution ≈ $0.05 at current deployment caption pricing) plus the bounded download.
  The per-call item cap (20) already bounds fan-out; each YouTube item is one segment.
- **Billing**: already in place — the `media` tool records a `tool_invocations` row
  per captioned item (`recordToolUsage`, x_search inline-caption pattern), so YouTube
  segment captions are billed with no additional work. (This was a prerequisite when
  the spec was first drafted; it has since landed.)
- The tool description gains one line: YouTube URLs are accepted and analyzed
  segment-wise via `start_time`.

---

## 8. Cost & safety controls (summary)

- No automatic video inference, ever — T1 is text + (optional, gated) one thumbnail
  image caption.
- Visual analysis is agent-initiated, one ≤`max_duration_seconds` segment per call,
  billed to `tool_invocations`, inside the per-session cost ceiling and period budgets.
- Downloads bounded: resolution-capped format selection, `--max-filesize`,
  subprocess timeout, concurrency semaphore; the analysis lane (§7) additionally
  fetches only the needed `--download-sections` segment — whole-file downloads
  happen only on explicit agent request (§6a) and land as ordinary workspace files.
- Egress: confined to recognized YouTube URLs; proxy honored via `--proxy`; the
  partition means yt-dlp is never handed an arbitrary user URL.
- Live/playlists/premieres refused; age-restricted fails with a clear message unless
  `cookies_file` is provided.

## 9. Config schema sketch

```toml
[youtube]
enabled = true                 # master switch; effective only if yt-dlp probe succeeds
yt_dlp_path = "yt-dlp"
max_download_bytes = 209715200 # 200 MB segment cap (--max-filesize)
concurrency = 2                # max concurrent yt-dlp subprocesses
timeout_ms = 120000            # per-subprocess wall clock
# cookies_file = "/path/cookies.txt"   # optional; bot-detection / age-restriction

[youtube.enrichment]
enabled = true                 # T1 on by default, gated to caption-eligible messages
enrich_all = false             # analog of caption_all: enrich every message's links
transcript_head_chars = 1000
thumbnail = true               # store+caption thumbnail as preview_media

[youtube.tool]                 # youtube_fetch windowing (x_fetch conventions)
max_total_chars = 32768
default_max_chars = 4000
max_chars_limit = 16000
download_max_height = 720      # default + cap for workspace file downloads (§6a)
```

Validation: windowing cross-field check as in `[fxtwitter.tool]`;
`[youtube.enrichment].enabled` requires `[youtube].enabled`.

## 10. Tests

- URL parser table tests (all forms, `t=` variants, non-video URLs rejected).
- ytdlp wrapper: arg construction per operation (snapshot), json3 → folded transcript
  with markers, error surfacing, timeout kill, semaphore.
- Enrichment stage with a mocked wrapper: payload_json shape, transcript-failure
  degrade, disabled-path passthrough, eligibility gate (trigger-group vs not,
  `enrich_all`, assistant per captioning config), thumbnail asset row.
- `youtube_fetch`: document layout, windowing/offset math, `t=`-anchored offset,
  no-transcript document, config validation; download mode — arg mapping
  (video/audio/clip/max_height clamp), title-slug sanitization + collision
  suffixes, size-abort error text.
- `media` routing: recognized-URL branch, synthesized truncation warning, cache key,
  billing row.
- Renderer: full + compact tiers, untrusted wrapping.

## 11. Future work (explicitly out of v1)

- **Gemini URL-passthrough fast path**: default-off config to send short videos'
  YouTube URLs straight through `video_url` (AI-Studio-pinned via OpenRouter provider
  routing — `describeMedia` would need provider-preference support). Only sane under a
  probed-duration guard (~≤5 min).
- **Native video blocks to a `input_modalities: ["video"]` reply model** — builder +
  pi-agent-core surface work; no current deployment demand.
- **Generic yt-dlp site support** for the `media` routing behind a config allowlist.
- **Parked-upgrade enrichment**: re-running the YouTube stage when a previously
  ineligible message later joins a trigger group (captioning's deferred-claim model);
  v1 deliberately evaluates eligibility once.

## 12. Sandbox escape hatch (in scope, v1)

Add the pinned `yt-dlp` standalone binary to the sandbox image
(`docker/Dockerfile.sandbox`) so the agent can manually download exotic or
non-YouTube videos via `bash` into the workspace and run `media` on the file.
No app code; deployments with egress filtering must allow the relevant CDN hosts for
this path to work (operator concern, documented in the sandbox docs).

## 13. Target ARCHITECTURE.md sections (once implemented)

New §7b "YouTube enrichment + tools" (partition, payload, rendering) mirroring §7a;
tool table entries for `youtube_fetch` and the `media` routing note; §4 config for
`[youtube]`; §11a note for the sandbox binary; media-cache paragraph gains the
remote-keyed segment cache.
