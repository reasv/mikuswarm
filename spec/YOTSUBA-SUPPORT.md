# Yotsuba: 4chan support (rich link previews, `yotsuba` browsing tool, skill)

**Status**: PROPOSED (design session 2026-09-29, revised same day). Not implemented.

**Target ARCHITECTURE.md homes once implemented**: new §7f "Yotsuba (4chan) enrichment"
(sibling of §7a "X.com enrichment via FxTwitter" and §7e YouTube); §10 "Yotsuba tool"; §4
"Feature gates" (new flag; the gate now also covers an enrichment stage); §9 rendering notes.

---

## 0. Naming

**Yotsuba** is the one name for 4chan in code: the feature flag (`[features].yotsuba`),
the config table (`[yotsuba]`), the module (`src/yotsuba/`), classes and functions
(`YotsubaClient`, `extractYotsubaRefs`, …), the DB `source_kind` (`"yotsuba"`), log events
(`enrichment_yotsuba_failed`), the tool and skill (`yotsuba`), and workspace download paths
(`downloads/yotsuba/…`). No `fourchan`/`4chan` identifiers anywhere.

Prose that the model or a person reads as a description of the site (the tool and skill
descriptions, the `site` attribute and footer of a rendered preview, the compact-tier label,
error messages) says **4chan**, because that is the word users type and the word the model
knows. The tool description opens with "4chan (yotsuba): …" so the two are tied together
once.

---

## 1. Goal

4chan links are a dead end today. A thread URL posted in chat goes through the generic
Synapse / direct-scrape path, which yields at best a page title ("/g/ - Technology - 4chan")
and a thumbnail: no subject, no opening post, no idea whether the link points at the thread
or at one reply, no stats, nothing the agent can act on. The agent also has no way to look
at a board on request: `web_fetch` returns raw imageboard HTML (huge, noisy, full of
navigation), and the browser is heavyweight for what is a structured-data problem.

4chan publishes a read-only JSON API (`a.4cdn.org`) that needs no authentication, is
CDN-cached, and has simple published usage rules (§3). This spec adds, as one opt-in
feature:

1. **T1: rich link previews.** A dedicated enrichment stage that stores a budgeted,
   structured snapshot of the linked thread or post, with the chosen images downloaded into
   the normal captioning / image-block pipeline (§6, exact renderings in §6.5).
2. **T2: the `yotsuba` tool.** Active browsing: list boards, search a board's catalog, read
   a thread (in order, one post's conversation, the replies to a post, the most-replied
   posts, a keyword search), and inspect or download any attachment (image, video, PDF)
   (§7).
3. **A skill and activation path** so the agent gets from "someone mentions a board / drops a
   thread link" to the right call without guessing (§9).

Both surfaces share one **post-view engine** (§5): the same selection, budgeting, and
omission-marking logic, so a preview and a tool page describe what they left out in the
same vocabulary.

### User stories

- A user drops `https://boards.4chan.org/g/thread/109930292#p109931450` and says "lol". The
  agent sees the linked reply in full with its image, the posts it was answering (the
  setup of the joke), the thread it lives in, and the first few replies to it with a count
  of the rest.
- "What's /lmg/ saying about the new MiMo release?" The agent loads the skill, runs a
  catalog query on /g/ for `lmg`, then a `search` view of the thread for `mimo`, and
  answers with post links.
- "Summarize this thread" on a 435-post thread. The agent reads the `most_replied` view
  first (each hot post shown with what it was answering), then pages chronologically only
  where needed. Every page says exactly what it skipped and gives the call for the next one.
- "Anything new in that thread since earlier?" A chronological view with `after` set to the
  last post number the agent saw.
- "Post the image from >>109931450." `download`, then `send_message` with the path.
- A thread linked last week has since been pruned. The stored snapshot still shows what it
  was; the tool reports it gone.

### Non-goals (v1)

- **No posting, no captcha, no pass login.** Read-only.
- **No third-party archives.** The FoolFuuka-style archives (desuarchive, 4plebs, …) are
  hostile to automated clients and not reliably reachable through a VPN egress; that is an
  operational problem, not something code in this project can fix. When 4chan's own
  archive has let a thread go, it is gone, and the stored preview snapshot is the only
  record we keep.
- **No cross-board or historical search.** 4chan has no search API. The practical search
  is a per-board catalog filter (§7.1) and an in-thread keyword view.
- **No bare post-number resolution.** Verified 2026-09-29: both
  `a.4cdn.org/{b}/thread/{reply_no}.json` and `boards.4chan.org/{b}/thread/{reply_no}` return
  404 for a reply number, and nothing maps a post to its thread. Normal post URLs always
  carry the thread number, so this only affects hand-typed `>>>/g/123` references (§4.1).
- **No other imageboards.** The module is 4chan-specific in the way `src/fxtwitter/` is
  X-specific. A mirror of the same API shape can be used via `api_base` / `media_base`.
- **No thread watching.** Fetches happen on enrichment or on a tool call only.

---

## 2. Feature gate

`[features].yotsuba` (boolean, default **off**, same semantics as `character_card` and
`danbooru`) is the single master switch:

- `FEATURE_TOOLS` gains `yotsuba: ["yotsuba"]` (tool registration and skill seeding from
  `templates/features/yotsuba/skills/yotsuba/`, both existing mechanisms);
- **new:** the flag also gates the T1 enrichment stage. App wiring passes the `yotsuba`
  option into `EnrichmentWorkerOptions` only when `config.features?.yotsuba === true` and
  `[yotsuba.enrichment].enabled`. With the flag off, 4chan URLs stay on the generic preview
  path exactly as today.

The §4 "Feature gates" paragraph that calls the gate "purely a tool-availability gate" is
updated in the implementing commit: a feature may also own a non-tool subsystem, and
`yotsuba` is the first that does. `FeaturesSchema` (a StrictObject) gains `yotsuba`; its
header comment gets the new line (and loses its stale "skill seeding is NOT implemented
yet" note).

Tunables live in a top-level `[yotsuba]` table (§10) shipped in `00-defaults.toml`. The
table has no `enabled` of its own; shipped defaults never turn anything on.

---

## 3. The 4chan API and its rules

Endpoints (JSON, `https://a.4cdn.org`):

| Endpoint | Use | Freshness we allow |
|---|---|---|
| `/boards.json` | board list: `board`, `title`, `ws_board`, `meta_description`, `max_comment_chars`, `is_archived`, … | 24 h |
| `/{b}/catalog.json` | every live thread's OP + counts + `last_replies` (array of pages) | 10 s |
| `/{b}/thread/{no}.json` | full thread `{ posts: [...] }`; also serves archived threads (`archived: 1`) | 10 s |

Files: `https://i.4cdn.org/{b}/{tim}{ext}` (original) and `https://i.4cdn.org/{b}/{tim}s.jpg`
(thumbnail; 4chan generates one for images, videos, and PDFs).

Published usage rules, and how we honor them:

1. **At most one request per second** to the API: a process-wide paced limiter on the API
   host with `min_request_interval_ms = 1000` (§4.3), shared by enrichment and every
   session's tool calls.
2. **A thread is refreshed at most once per 10 seconds**: a per-resource freshness window in
   the client cache (table above). Inside it, the cached body is served with no request.
3. **Use `If-Modified-Since`**: every refetch of a cached resource is conditional, and a
   `304` reuses the cached body. (Verified: the API sends `Last-Modified` and honors the
   header.)

Facts from the 2026-09-29 probe that shape parsing:

- `com` is HTML: `<br>`, `<wbr>` (a soft break inside long URLs, to be removed without
  inserting whitespace), same-thread quotelinks (`<a class="quotelink" href="#p123">`),
  cross-thread quotelinks (`href="/g/thread/456#p456"`), greentext
  (`<span class="quote">&gt;…</span>`), and board-specific markup: `<s>` spoilers, `<pre
  class="prettyprint">` code on /g/, `<span class="deadlink">`, `[math]`/`[eqn]` on /sci/,
  red mod text such as `(USER WAS BANNED FOR THIS POST)`.
- A post's comment is bounded by the board's `max_comment_chars` (2000 on the boards
  checked), which is why the tool can always show a post whole (§7.2).
- An archived thread is still served by the same endpoint with `closed: 1`, `archived: 1`,
  `archived_on`; once the board archive rotates it out, or on a board without an archive,
  the endpoint 404s.
- Optional fields vary by board: `id` (poster ID), `country`/`country_name` or
  `board_flag`/`flag_name`, `trip`, `capcode`, `sub`, `spoiler`, `filedeleted`,
  `unique_ips` (OP only, not always present), `sticky`, `closed`, `bumplimit`,
  `imagelimit`.

---

## 4. Module layout (`src/yotsuba/`)

Pure TS, no Matrix/native imports (the `src/fxtwitter/` precedent):

- `url.ts`: URL recognition and canonicalization (§4.1).
- `client.ts`: `YotsubaClient` (§4.2).
- `types.ts`: tolerant API types (every field optional), the persisted payload types,
  `YOTSUBA_SOURCE_KIND = "yotsuba"`, config resolution.
- `markup.ts`: `com` HTML to plain text plus quote extraction (§4.4).
- `graph.ts`: the thread graph: post index, quotes (parents), backlinks (replies).
- `view.ts`: the post-view engine (§5). Pure; renders nothing itself.
- `format.ts`: preview payload building, flat description (FTS), tool text rendering.

The tool lives in `src/tools/yotsuba.ts`. Two small generic media helpers are added outside
the module because nothing about them is 4chan-specific: `src/media/storyboard.ts` (§6.3)
and `src/media/pdf.ts` (§7.4).

### 4.1 URL recognition (`url.ts`)

Hosts: `boards.4chan.org`, `boards.4channel.org` (legacy, still pasted), `4chan.org` /
`www.4chan.org`, plus `[yotsuba].extra_hosts`. Base-domain matching with subdomain
tolerance and lookalike rejection, the `isStatusHost` shape from `src/fxtwitter/url.ts`.

| Form | Ref |
|---|---|
| `/{b}/thread/{no}[/{slug}][#p{post}\|#q{post}]` | `{ kind: "thread", board, threadNo, postNo? }` |
| `/{b}/`, `/{b}/catalog`, `/{b}/{page}` | `{ kind: "board", board }` |
| anything else on these hosts | not recognized (generic path) |

`board` must match `^[a-z0-9]{1,10}$`. Canonical URLs: `https://boards.4chan.org/{b}/thread/{no}`
(+ `#p{post}` when a reply is targeted) and `https://boards.4chan.org/{b}/`. A `#p` equal to
the thread number is a plain thread ref. Dedup per message body by `(board, threadNo,
postNo)`. Direct file links (`i.4cdn.org/…`) are not refs: the existing linked-media path
already downloads them by extension.

`>>>/g/123` text (no URL) is not a ref: without the thread number there is nothing to fetch.
The tool accepts the notation and explains the limitation when 123 turns out to be a reply
(§7.5).

### 4.2 `YotsubaClient`

One instance, constructed at app wiring when the feature is on, shared by the enrichment
stage and every session's tool (the `FxTwitterClient` precedent).

- `boards()`, `catalog(board)`, `thread(board, no)` return the parsed body plus
  `{ fetchedAt, lastModified, fromCache }`, so every output can state how fresh it is.
- **Cache**: in-memory, keyed by path, bounded by entry count and total bytes (implementer's
  choice; order of 64 entries / 32 MiB). Inside the freshness window: served from cache;
  after it: conditional GET, and a `304` refreshes `fetchedAt`.
- **Negative cache**: a 404 is remembered for 10 minutes, so a dead thread linked
  repeatedly (or a backfill burst of old links) costs one request.
- **Single-flight**: concurrent identical requests share one promise.
- **Transport**: `guardedFetch` (SSRF guard, per-host unconditional 429/503 + Retry-After
  backoff), the `[network].http_proxy_url` dispatcher, `timeout_ms`, a
  `max_response_bytes` bound, and a stable identifying `User-Agent`. Any non-2xx other than
  304/404 throws with the status.
- **Files**: `fetchFile(board, tim, ext | "thumb")` via `FetchClient` on the media lane
  (egress guard, proxy, `media.download_size_limit`).

### 4.3 Pacing

`DanbooruRateLimiter` (`src/tools/danbooru.ts`) is already a correct generic paced limiter
(synchronous start-instant reservation, FIFO admission with direct handoff). Extract it
unchanged to `src/net/paced-limiter.ts` as `PacedLimiter`, keep Danbooru on it (its tests
move with it), and add **two priority classes**: `interactive` and `background`, two FIFO
queues, with a released slot handed to the interactive head first. Tool calls are
interactive, enrichment is background, so a backfill burst of old links never makes a
user-facing tool call wait behind it. Callers that pass no class (Danbooru) get today's
single-queue behavior.

Two instances: the **API lane** (`min_request_interval_ms = 1000`, `max_in_flight = 1`) and
the **media lane** on `i.4cdn.org` (`media_min_request_interval_ms = 250`,
`media_max_in_flight = 2`; no published rule, a courtesy pace so `download` of a whole
thread cannot open a firehose). Both sit inside the per-host HTTP limiter and its
unconditional backoff.

### 4.4 Markup conversion (`markup.ts`)

| Input | Output |
|---|---|
| `<br>` | newline |
| `<wbr>` | removed |
| same-thread quotelink `>>123` | `>>123`, collected into the post's `quotes` |
| cross-thread quotelink (`/b/thread/456#p789`) | `>>>/b/789`, collected into `crossQuotes` |
| greentext span | kept, leading `>` preserved |
| `<span class="deadlink">>>123</span>` | `>>123`, marked dead |
| `<s>x</s>` | `[spoiler]x[/spoiler]` |
| `<pre class="prettyprint">` | fenced code block |
| `[math]…[/math]`, `[eqn]…[/eqn]` | verbatim |
| red mod text | `[mod: USER WAS BANNED FOR THIS POST]` |
| other tags | stripped, text kept |
| entities | decoded |

The converter produces plain text plus the structural quote list. Reference
**annotations** (`(OP)`, `(not shown)`, …) are not baked in here: they depend on which
posts a particular view shows, so the renderer adds them (§5.4).

All post text is untrusted: XML-escaped when rendered into context, and wrapped in an
untrusted envelope in tool output (§7.2). Nothing in a post body is ever fed to a fetcher.

---

## 5. The post-view engine (`view.ts`)

Every 4chan surface answers the same question: from a thread of up to ~750 posts, which
posts do we show, how much of each, which attachments, and how do we tell the reader
precisely what was left out and how to get it. One engine answers it for the preview and
for every tool view; only the requested slots and the budget differ.

### 5.1 Inputs

- The thread graph: posts in thread order, each with its position (`index`, 0 = OP),
  `quotes` (parents, same thread, existing posts only) and backlinks (replies).
- A **slot list**: `{ no, role, tier, textCap?, priority }` entries built by the caller
  (preview rules in §6.1, tool views in §7.2). `tier` is `full` (the post's text up to
  `textCap`, or whole when uncapped) or `excerpt` (the first `excerpt_chars` characters,
  default 160, ending in `…`; no file shown).
- A **budget**: `max_posts`, `max_text_tokens` (estimated with the shared
  `estimateTokens`), `max_files` (attachments shown, §5.3), plus a `contiguous` flag used by
  paged views.

### 5.2 Selection

1. Slots are processed in priority order. A post that appears in several slots is placed
   once: at the highest tier any of its slots asked for, with the highest-precedence role
   (`linked > op > replied_to > reply > most_replied > match > latest > context`). **No post
   is ever rendered twice**; in particular the OP is never repeated as a reply or a
   most-replied entry.
2. **Pinned slots** (the linked post of a post link, and the OP) are always placed and may
   take the budget past its limit. Their size is bounded anyway: a comment is at most
   `max_comment_chars`.
3. Every other slot is placed at its tier if `posts < max_posts` and the rendered cost fits
   the remaining `max_text_tokens`; a `full` slot that does not fit is retried as an
   `excerpt`; a slot that fits neither is not placed.
4. With `contiguous` set (chronological pages), selection stops at the first slot that does
   not fit, so a page never skips a post in the middle and always ends at a clean cursor.
5. **File pass**: attachments of placed `full` posts are shown in file-priority order (the
   caller's slot priority) up to `max_files`. Shown attachments are the ones downloaded and
   presented (§6.3, §7.3); the rest are listed with metadata and `status="not shown"`.

Selection happens once, when the snapshot or page is built. Rendering is a pure function of
the result, so a stored preview renders byte-identically on every context build (the
deterministic-rendering invariant).

### 5.3 What "shown" means for each attachment kind

| Kind (4chan ext) | Shown as | Notes |
|---|---|---|
| image (`.jpg .png .gif` still) | the original file | the 250 px thumbnail captions poorly |
| animated `.gif`, video (`.webm .mp4`) | a **storyboard** image (§6.3) plus the original file | the storyboard is the image-block / caption representation; the original is kept for the `media` tool (audio, full analysis) |
| PDF (`.pdf`, e.g. /po/) | 4chan's page-1 thumbnail; the tool's `view` adds extracted text (§7.4) | |
| anything else (`.swf` on /f/) | listed only | |
| `filedeleted` | listed as deleted | |

Each shown attachment costs one unit of `max_files`, whatever its kind. `spoiler` files are
shown normally and rendered with `spoiler="true"`.

### 5.4 Omission vocabulary

The same markers appear in previews and tool output:

- **Gaps.** Placed posts render in thread order. Between two placed posts whose positions
  are not adjacent, an `<omitted posts="N" files="M"/>` element states how many posts (and
  how many of them carried files) were skipped. A gap after the last placed post covers the
  rest of the thread.
- **References.** Inside post text, a `>>N` reference is annotated at render time: the OP
  gets `(OP)`; a post not placed in this view gets `(not shown)`; a quote of a post that no
  longer exists gets `(deleted)`; a cross-thread reference gets `(other thread)`. References
  to posts that *are* shown are left bare.
- **Replies.** A `full` post with backlinks carries `replies="N"`. When the view is about that
  post's replies (the linked post of a preview, the focus of a conversation view) it also
  gets a backlinks line, which is 4chan's own "Replies:" row:
  `[26 replies: >>109931461 >>109931470 >>109931502 shown; 23 more not shown]`.
- **Truncation.** A capped `full` post that was cut ends with
  `[… N more characters]`; an `excerpt` post carries `excerpt="true"`.
- **Files.** An attachment not shown renders as `<file … status="not shown"/>`; the view
  footer lists which posts have unshown files.
- **Footer.** Every view ends with one trusted line saying what was shown out of what, and
  (in the tool) the exact next call(s) that retrieve the rest (§7.2).

---

## 6. T1: link previews

### 6.1 What a preview selects

All budgets below are `[yotsuba.preview]` defaults (§10). A preview is in the full-tier
context of every session that renders the event, so it is deliberately a few hundred
tokens, not a transcript.

**Post link (`#p` targets a reply).** Causal context first, then thread context, then
reactions:

| Priority | Slot | Tier / cap |
|---|---|---|
| 1 (pinned) | the linked post | full, uncapped |
| 2 | posts it replies to (depth 1), in the order it quotes them | full, 600 chars each, at most `parents_max` (4) |
| 3 (pinned) | the OP | full, 300 chars |
| 4 | posts those reply to (depth 2) | excerpt |
| 5 | replies to the linked post, oldest first | full, 300 chars, at most `replies_max` (3) |

If the linked post quotes the OP, the OP is simply one of its parents and appears once.

**Thread link.** Mirrors 4chan's own board index (OP plus the latest replies) and adds the
posts that drew the most replies, clearly labelled as such:

| Priority | Slot | Tier / cap |
|---|---|---|
| 1 (pinned) | the OP | full, 800 chars |
| 2 | the latest replies | full, 400 chars, `latest_replies` (3) |
| 3 | most-replied posts: OP excluded, at least `most_replied_min` (5) replies, not already a latest reply, highest count first (ties to the earlier post) | full, 400 chars, at most `most_replied_max` (2) |
| 4 | the posts each most-replied post was answering (depth 1) | excerpt |

A thread with no post over the threshold simply has no most-replied entries, which is the
normal case for a young thread. Each most-replied post renders with its `replies="N"` count
and its role, and sits in its chronological place between gap markers, so the model can see
both why it was picked and that it is out of context; the depth-1 excerpts give it the
setup it was responding to.

**Board link.** Board title, worksafe flag, the board's description, and the first
`board_threads` (5) non-sticky threads in bump order (subject or OP excerpt, reply count).
One `catalog(board)` call. No files. `board_previews = false` sends board links to the
generic path instead.

**Budget**: `max_posts = 10`, `max_text_tokens = 1500`, `max_files = 2`. File priority
follows slot priority: for a post link, the linked post's file, then its parents', then the
OP's; for a thread link, the OP's, then the most-replied posts', then the newest reply's.

A `#p` number that is not in the thread (deleted, or a typo) degrades to a thread preview
with `linked_post_missing="N"` on the thread element.

### 6.2 Persistence

No new tables, no migration. One `link_previews` row per ref (the X precedent):

- `source_kind = "yotsuba"`, `site_name = "4chan"`, canonical `url`.
- `title`: `"/{b}/ - {subject or OP excerpt}"`; board refs `"/{b}/ - {board title}"`.
- `description`: the flat text of every placed post. This is what the chat-search FTS
  indexes, so the snapshotted text is searchable with no search-layer change.
- `payload_json`: `YotsubaPreviewPayload`, the engine's result frozen:

```ts
interface YotsubaPreviewPayload {
  v: 1;
  kind: "thread" | "board";
  board: string; boardTitle?: string; worksafe?: boolean;
  asOf: number;                        // epoch ms of the fetch
  // thread kind
  threadNo?: number; subject?: string;
  postCount?: number; fileCount?: number; posters?: number;
  status?: string[];                   // "sticky" | "closed" | "archived" | "bump limit" | "image limit"
  linkedNo?: number; linkedMissing?: number;
  posts?: YotsubaPostNode[];           // placed posts, thread order
  // board kind
  description?: string;
  threads?: { no: number; subject?: string; excerpt: string; replies: number }[];
}
interface YotsubaPostNode {
  no: number; index: number;           // index = position in thread, for gap counts
  role: "linked" | "op" | "replied_to" | "reply" | "most_replied" | "latest" | "context";
  tier: "full" | "excerpt";
  name?: string; trip?: string; posterId?: string; capcode?: string; flag?: string;
  time: number;                        // epoch ms
  text: string; moreChars?: number;    // text as placed; moreChars when capped
  quotes: number[]; deadQuotes?: number[]; crossQuotes?: string[];
  replies: number; shownReplies?: number[];
  filesBetweenPrev?: number;           // files among the omitted posts before this one
  file?: {
    name: string; ext: string; w?: number; h?: number; bytes?: number; durationSec?: number;
    spoiler?: boolean; deleted?: boolean;
    shown: boolean; assetId?: string; storyboardAssetId?: string;
  };
}
```

Gap counts are derived from consecutive `index` values (plus `postCount` for the trailing
gap), so no separate gap list is stored. Malformed payload JSON degrades to the generic
link-preview rendering from `title`/`description`.

**Failures** (logged `enrichment_yotsuba_failed`; event-level retry is not triggered, the
X/YouTube policy): a 404 stores `fetch_status: "failed"` with error `"gone"`, which renders
as an explicit "already gone when linked" preview (§6.5 example D); any other failure
renders as the bare URL.

### 6.3 Files and images

Shown files are downloaded through the media lane into `media_assets` rows hung off the
preview row (`link_preview_id`), roles `preview_media` / `reply_preview_media`, and the
existing post-pass sets their `caption_status`. Nothing about captioning, the attachment
store, or the pipeline monitor changes.

**Image blocks.** The existing context-builder cascade (§9 "Image block handling") already
promotes a trigger message's preview media to real image blocks for a vision reply model
(tier 3, after the trigger's own attachments and reply attachments), and marks them
`image_block="true"` in the XML. So a 4chan link in the message that triggers the agent
reaches a vision model as actual images; the rendered `<file>` element carries the
workspace path, the `image_block` flag, and (once captioned) the caption, and sits inside
the `<post>` it belongs to, so the model knows which post each image came from. For older
messages, and for non-vision models, the same files are present as captions and paths
(the conservative policy for every other kind of media). `max_files` is what keeps a
multi-link message from flooding that tier: at most 2 image blocks per 4chan link.

**Videos and animated GIFs** get a storyboard (`src/media/storyboard.ts`): ffmpeg samples 4
frames at 12/37/62/87% of the duration into one 2×2 JPEG tile, stored as an `image` asset.
It is what becomes the image block and what the image caption lane describes, so a vision
model sees the clip's arc in one block. The original is also downloaded (as the X precedent
does for tweet videos) and stored as a `video` asset, so it goes through the video caption
lane under the existing gates and is available to the `media` tool for audio or full
analysis. On download or ffmpeg failure the 4chan thumbnail is used as the image instead.

**PDFs** in previews show 4chan's page-1 thumbnail only; text extraction is a tool feature.

`media_boards = "all"` (default) or `"worksafe"` restricts preview downloads to worksafe
(`ws_board = 1`) boards; on other boards files are listed but never shown. Default `all`,
because the operator opted into 4chan and every download still passes the captioning gates;
the knob is for deployments whose caption model or storage policy must not see NSFW-board
images.

### 6.4 Enrichment partition

Inside `fetchLinkPreviews`, after the X and YouTube partitions and before the generic stage,
recognized refs are stripped from `filteredBody` (Synapse / direct scrape never produces the
bare og-card for them) and their raw matches join the linked-media exclusions. Message and
reply bodies are treated identically, and refs share `enrichment.max_previews_per_message`
in order of first appearance.

**Every event is eligible** (the X precedent, not YouTube's trigger-group gate): the cost is
one cached, paced, CDN-served GET per link, inference spend on the files is still governed by
the captioning gates, and a snapshot taken when the link is posted is the only record that
survives the thread's pruning.

**Discord ingest embeds.** Discord's unfurl of a 4chan URL is a bare og-card stored at ingest
as a `discord_embed` row. The yotsuba stage still runs for that URL (the X precedent), and
the renderer suppresses a `discord_embed` row when the same event has a `yotsuba` row for
the same `(board, threadNo)`. (Scoped to yotsuba rows; X behavior is unchanged.)

### 6.5 Exact renderings

Illustrative data, real layout. Times use `compactAgentTimestamp` (agent timezone). Every
attribute is omitted when absent; `Anonymous` with no trip is the default and is not
printed. Element and attribute text is escaped as usual.

**A. Post link (the common case).** A user posts
`https://boards.4chan.org/g/thread/109930292#p109931450` and says "lol". The linked post
quotes two posts; one of those quotes a third; the linked post has 26 replies.

```xml
<link_preview url="https://boards.4chan.org/g/thread/109930292#p109931450" kind="4chan">
<thread board="/g/ - Technology" no="109930292" subject="/lmg/ - Local Models General" posts="435" files="88" posters="121" status="bump limit" as_of="2026-09-29 02:10" linked="109931450">
<post no="109930292" role="op" time="2026-09-28 10:31" replies="3">
/lmg/ - a general dedicated to the discussion and development of local language models.

Previous threads: >>>/g/109925219 (other thread) &amp; >>>/g/109921422 (other thread)

►News
&gt;(09/26) koboldcpp-1.122 + bundled harness
[… 1,690 more characters]
<file name="lmg.png" type="image/png" dims="1024x1024" size="1.1 MB" status="not shown"/>
</post>
<omitted posts="97" files="19"/>
<post no="109931377" role="context" time="2026-09-28 11:58" excerpt="true">Just tried MiMo 2.6 Flash on a single 3090, 38 t/s at Q4 with 32k context, this might actually be the one for…</post>
<omitted posts="4" files="1"/>
<post no="109931388" role="replied_to" time="2026-09-28 11:59" replies="4">
benchmarks mean nothing, show me it holding a coherent story past 8k
</post>
<omitted posts="2"/>
<post no="109931402" role="replied_to" time="2026-09-28 12:00" id="Ab12Cd34" flag="Finland" replies="6">
&gt;&gt;109931377
&gt;38 t/s
that's with spec decoding off? post settings or it didn't happen
</post>
<omitted posts="9" files="2"/>
<post no="109931450" role="linked" time="2026-09-28 12:04" replies="26">
&gt;&gt;109931388
&gt;&gt;109931402
&gt;38 t/s on a 3090
yeah and here is what it actually writes after 4k tokens
<file name="context_rot.png" type="image/png" dims="1180x2400" size="612 KB" path="msg-attach/ab3kd92mx0q1z.png" image_block="true">
[caption: A screenshot of a chat log where a model's reply degrades into the word "shivers" repeated dozens of times.]
</file>
[26 replies: &gt;&gt;109931461 &gt;&gt;109931470 &gt;&gt;109931502 shown; 23 more not shown]
</post>
<omitted posts="3"/>
<post no="109931461" role="reply" time="2026-09-28 12:05" replies="2">
&gt;&gt;109931450
skill issue, wrong chat template
</post>
<omitted posts="2"/>
<post no="109931470" role="reply" time="2026-09-28 12:05">
&gt;&gt;109931450
&gt;shivers
it's over
</post>
<omitted posts="8" files="1"/>
<post no="109931502" role="reply" time="2026-09-28 12:07" replies="1">
&gt;&gt;109931450
&gt;&gt;109931455 (not shown)
nta but his template is fine, the repetition penalty is off in the default preset
</post>
<omitted posts="314" files="64"/>
[4chan thread snapshot as of 2026-09-29 02:10: 8 of 435 posts shown. The yotsuba tool can read the rest of the thread, the full conversation around any post, or all 26 replies to the linked post.]
</thread>
</link_preview>
```

Notes on A: the OP is pinned but capped (it is thread context, not the point of the link);
its image lost the 2-file budget to the linked post and a parent (the parents here have no
files, so only one file is actually shown). Replies-of-replies and excerpts carry `(not
shown)` on their unresolved references. Rough cost: about 900 text tokens plus one image.

**B. Thread link.**

```xml
<link_preview url="https://boards.4chan.org/g/thread/109930292" kind="4chan">
<thread board="/g/ - Technology" no="109930292" subject="/lmg/ - Local Models General" posts="435" files="88" posters="121" status="bump limit" as_of="2026-09-29 02:10">
<post no="109930292" role="op" time="2026-09-28 10:31" replies="3">
/lmg/ - a general dedicated to the discussion and development of local language models.
…OP text…
[… 1,190 more characters]
<file name="lmg.png" type="image/png" dims="1024x1024" size="1.1 MB" path="msg-attach/…" image_block="true">
[caption: …]
</file>
</post>
<omitted posts="140" files="27"/>
<post no="109931980" role="context" time="…" excerpt="true">has anyone actually compared the new quant formats at the same bpw or is it all vibes…</post>
<omitted posts="1"/>
<post no="109931995" role="most_replied" time="…" replies="17">
&gt;&gt;109931980
I did, KL divergence table attached. IQ4 is still king under 5 bpw
<file name="kld.png" type="image/png" dims="900x620" size="88 KB" path="msg-attach/…" image_block="true">
[caption: …]
</file>
</post>
<omitted posts="285" files="58"/>
<post no="109935841" role="latest" time="…">…</post>
<post no="109935870" role="latest" time="…">
&gt;&gt;109935841
…
</post>
<omitted posts="1"/>
<post no="109935902" role="latest" time="…">
&gt;&gt;109935650 (not shown)
…
<file name="…" status="not shown" …/>
</post>
[4chan thread snapshot as of 2026-09-29 02:10: 6 of 435 posts shown (the opening post, the most-replied post, the latest replies). The yotsuba tool can read the whole thread in order, the most-replied posts, or the conversation around any post.]
</thread>
</link_preview>
```

**C. Board link** (`https://boards.4chan.org/g/`):

```xml
<link_preview url="https://boards.4chan.org/g/" kind="4chan">
<board code="/g/" title="Technology" worksafe="true" as_of="2026-09-29 02:10">
"/g/ - Technology" is 4chan's imageboard for discussing computer hardware and software, programming, and general technology.
<thread no="109930292" replies="434">/lmg/ - Local Models General</thread>
<thread no="109933120" replies="211">/dpt/ - Daily Programming Thread</thread>
<thread no="109934007" replies="12">why do open source projects obfuscate their code?</thread>
…
[4chan board snapshot: the 5 most recently bumped threads. The yotsuba tool can search this board's catalog.]
</board>
</link_preview>
```

**D. Gone** (404 at enrichment time):

```xml
<link_preview url="https://boards.4chan.org/g/thread/109800000" kind="4chan" status="gone" checked="2026-09-29 02:10"/>
```

**E. Compact tier** (older events, generation sessions), bounded like the other kinds:

```
 [4chan /g/ "/lmg/ - Local Models General" (435 posts), post >>109931450: >38 t/s on a 3090 yeah and here is what it actually writes after 4k tokens · image: A screenshot of a chat log where a model's reply degrades into…]
 [4chan /g/ "/lmg/ - Local Models General" (435 posts): /lmg/ - a general dedicated to the discussion and development of local…]
 [4chan /g/ board: Technology]
 [4chan /g/ thread 109800000: already gone when linked]
```

The compact line shows the linked post (post links) or the OP (thread links), text first,
then the first shown file's caption, bounded by `MAX_COMPACT_MEDIA_CAPTION`-style caps (text
200 chars, caption 120).

---

## 7. T2: the `yotsuba` tool

One tool with an `action` field (the `danbooru` precedent: one definition to load, not
five). Registered only when the feature is on. Every call tolerates naive input: a `url`
alone is enough (a thread URL means `thread`, a `#p` URL means the conversation view on that
post, a board URL means `catalog`); `board` accepts `g`, `/g/`, `/g`; `thread` and `post`
accept numbers, URLs, `>>123`, or `>>>/g/123`. Empty-string / zero / empty-array padding of
optional fields is treated as absent.

### 7.1 `boards` and `catalog`

**`boards`** `{ query? }`: one line per board: code, title, worksafe marker; `query` filters
on code/title/description. Served from the 24 h cache, so effectively free.

**`catalog`** `{ board, query?, order?, limit?, after? }`

- `order`: `bump` (default, 4chan's own), `replies`, `files`, `created`, `last_reply`.
- `query`: case-insensitive; every term must occur in subject + OP text (4chan's catalog
  search semantics). This is the "find the /xyz/ general" and "is there a thread about X"
  path.
- Per thread, one header line and one excerpt line:
  `#109930292 "/lmg/ - Local Models General" · 434 replies · 87 files · started 16h ago · last reply 1m ago · bump limit`
  then the first 200 characters of the OP.
- `limit` default 15, max 50. The footer states `N of M matching threads shown` and the
  exact call for the next page when there is one.

### 7.2 `thread`: the views

`{ action: "thread", board?, thread | url, view?, post?, after?, query?, files? }`

| `view` | Shows | Pages by |
|---|---|---|
| `chronological` (default without `post`/`query`) | every post in order, from the start or `after` a post number | `after` (contiguous) |
| `conversation` (default with `post`) | the post's ancestors (depth 3; depth 1 full, deeper as excerpts), the post itself, its first replies (full), and each shown reply's replies as excerpts | nothing to page: omissions point at `replies` |
| `replies` (needs `post`) | every direct reply to `post`, in order, each with its own reply count and the other posts it quotes as excerpts | `after` |
| `most_replied` | posts ranked by reply count (OP excluded, minimum 2 replies), each with the post(s) it answers as excerpts | `after` = rank offset |
| `search` (default with `query`) | posts containing every term, each with the post(s) it answers as excerpts | `after` |

The page budget is `[yotsuba.tool]` `page_tokens` (default 6000; a `max_tokens` argument can
lower it or raise it to `page_tokens_max`, 12000) plus `files_per_page` (default 4). Inside
the tool, **a post's text is never cut**: a comment is at most `max_comment_chars`, so the
engine runs with `full` tier uncapped and pages at whole-post boundaries instead.

Output is the same `<thread>` / `<post>` / `<omitted>` vocabulary as the preview (§5.4),
inside one untrusted envelope:
`<untrusted_4chan board="g" thread="109930292" view="conversation" as_of="…">…</untrusted_4chan>`
(post text escaped; the envelope and structure are trusted, the `youtube_fetch` convention).
The header states the thread's live state and freshness (`as_of`, and `cached 4s ago` when
served from cache).

**Every page ends with a trusted footer** that states exactly what was shown and gives the
literal next call for each kind of omission present on the page. Example after a
conversation view:

```
[Shown: 11 posts (the post, 3 ancestors, 5 of its 26 replies, 2 replies-to-replies as excerpts); 3 of 4 files as images.
 More replies to >>109931450 (21): {"action":"thread","board":"g","thread":109930292,"view":"replies","post":109931450,"after":109931530}
 Posts marked (not shown): open any with {"action":"thread","board":"g","thread":109930292,"post":N}
 File not shown on >>109931502: {"action":"view","board":"g","thread":109930292,"posts":[109931502]}]
```

and after a chronological page:

```
[Shown: posts 1-58 of 435 (through >>109930875), 4 of 11 files as images.
 Next page: {"action":"thread","board":"g","thread":109930292,"after":109930875}
 Files not shown on this page: >>109930412 >>109930598 >>109930601 >>109930733 >>109930740 >>109930802 >>109930870
   view them: {"action":"view","board":"g","thread":109930292,"posts":[109930412,109930598,109930601,109930733,109930740,109930802,109930870]}]
```

### 7.3 Files in tool output

- **Vision reply model** (the danbooru `preview` precedent, keyed on the session's reply
  model): each shown file is appended to the result as an image block (originals, or
  storyboards for video/animated GIF, or the page-1 thumbnail for PDFs), conditioned through
  `conditionImageBufferForInference` to the model's `image_input_bytes` cap. Each `<file>`
  element carries `block="N"`, and each block is preceded by a text label
  `[image N: >>109931450 context_rot.png]`, so the model can match every block to its post.
- **Non-vision reply model**: thread views list files as metadata only (captioning every
  image on a page would be an unrequested spend); the footer points at `view`, which
  captions.
- `files: "none"` turns image blocks off for a text-only pass; any other value (including
  padded empties) means the default.

Each image block is charged against the §8b running-context counter by the existing tool
result shaping (`PER_IMAGE_TOKEN_ESTIMATE`), so `files_per_page` is the knob that bounds a
page's image cost.

### 7.4 `view` and `download`

**`view`** `{ board?, thread | url, posts, pages? }`: full inspection of the files of the
given posts (up to `view_max_files`, default 4; the rest named in the footer with the call
to continue).

- Image: the original as an image block (vision) or its caption through the session's
  caption client (non-vision; billed as a §8c `tool_invocations` row and counted against
  §8d).
- Video / animated GIF: the storyboard as an image block or caption, plus duration,
  dimensions, whether it has audio, and the literal `media` call for full audio-visual
  analysis of the original URL (`{"media":"https://i.4cdn.org/g/1790626296534393.webm"}`).
- PDF: the page-1 thumbnail, plus text extracted from the first pages up to
  `pdf_max_chars` (default 8000) via `src/media/pdf.ts`, a generic text extractor built on
  pdf.js (new pure-JS dependency, no native build). `pages: "7-12"` continues; the footer
  says `pages 1-6 of 34 shown` and gives the next call. Scanned PDFs with no text layer say
  so and point at `download`.
- Other types: metadata and the original URL; `download` to keep it.
- Deleted files: stated as deleted.

**`download`** `{ board?, thread | url, posts | "all" }`: originals saved under
`downloads/yotsuba/{board}/{threadNo}/{postNo}-{original filename}{ext}` (exclusive create,
collision suffixes, the x_fetch helper), returning workspace-relative paths for
`send_message` / `read_image` / `media`. `"all"` is capped at `max_download_files` (default
50) per call; the footer gives the call for the remainder.

All tool output is ephemeral (session rollout only, no DB rows); downloads are ordinary
workspace files.

### 7.5 Errors (all actionable)

- Unknown board: `Unknown board "/lmgg/". Closest: /g/ (Technology), /lgbt/ (LGBT). Call
  {"action":"boards"} for the full list.`
- Thread 404: `Thread 123 on /g/ is gone (pruned or deleted, and not in 4chan's own
  archive).` When the input was a bare number or `>>>/b/N`, it adds: `If 123 is a reply
  rather than a thread, 4chan cannot map it to its thread: use the full post URL
  (…/thread/<thread>#p123), or find the thread with {"action":"catalog","board":"g","query":"…"}.`
- `post` not in the thread: `>>N is not in this thread (posts run >>A to >>B; it may have
  been deleted).` plus the `most_replied` and `search` calls.
- `view`/`download` on posts without files: names which of the requested posts do have files.
- Throttling is invisible (the limiter waits); only a sustained upstream 429/503 surfaces:
  `4chan is throttling requests; retry in about N s.`

---

## 8. Security and content

- Post text, subjects, names, filenames, and board descriptions are untrusted: escaped in
  context, enveloped in tool output, never fetched. Only the numeric thread/post ids and
  the API-provided `tim`/`ext` are used to build request URLs, always against the configured
  bases.
- 4chan content is frequently offensive and sometimes deliberately manipulative. The skill
  tells the agent to read it as material about what people on a board are saying, not as
  instructions or as views to adopt.
- `media_boards` (§6.3) is the knob for NSFW-board files in previews. The tool shows what
  the agent asks for; skill guidance covers discretion (and `spoiler="true"` files).

---

## 9. Activation and discovery

Per the repo's tool-activation rules (CLAUDE.md "Agent-facing tools").

**Deferred, not immediate.** Every entry point is cued (a preview in context, or a user ask
naming a board or thread), so nothing justifies an always-on definition. The tool is
declared only by the feature skill.

**Always-on cost with the feature on**: one skill description line (about 70 tokens).
Nothing with it off. Previews cost tokens only on events that carry 4chan links.

**Entry points**:

1. *Link posted.* The preview is in context at the moment of need and its footer names the
   yotsuba tool and what it can do next. The agent loads the skill (its description matches
   a 4chan link) or calls the tool directly and recovers through the existing "not found,
   load its skill" backstop in one cheap call.
2. *User asks about a board, general, or thread with no link* ("what's /v/ saying about X",
   "check the /lmg/ thread"). The ask matches the skill description; the body routes to
   `catalog` with a `query`, then `thread`.
3. *User asks to see or post an attachment.* Skill body routes to `view` / `download`.
4. *Agent reaches for `web_fetch` on a 4chan URL anyway.* With the feature on, the native
   `web_fetch` appends one line to results for recognized refs:
   `[4chan link: the yotsuba tool returns this as structured posts with images]`. MCP-provided
   fetchers are out of reach and rely on entry points 1 and 2.

**Skill** (`templates/features/yotsuba/skills/yotsuba/SKILL.md`, `tools: [yotsuba]`),
description written trigger-first:

> 4chan: someone drops a boards.4chan.org link or asks what a board or general is saying
> ("what's /v/ saying about the new game", "is there an /a/ thread for this show", "check
> the /lmg/ thread", "summarize this thread", "what did anons reply to this", "post the
> image from >>123"). Read threads, search a board's catalog, follow reply chains, and view
> or download images, videos and PDFs with `yotsuba`.

Body: a preview is a snapshot (check `as_of`, fetch for current state); link in hand vs no
link; the views and when each fits (big thread: `most_replied`, then `search`, then pages;
"what's new": `after` with the last post number seen in the conversation); following the
footer's calls instead of guessing; linking posts back as URLs; the content caveat of §8;
a short glossary (general, OP, anon, bump, sage, (You), greentext, `>>>/b/` notation); and
saying plainly when a thread is gone.

No dual-homing into existing workspace skills: none of their trigger spaces covers 4chan,
and a template skill must not declare a tool that is absent on feature-off deployments.

---

## 10. Configuration

```toml
# any overlay: the switch
[features]
yotsuba = true

# 00-defaults: tunables only; nothing here turns the feature on
[yotsuba]
api_base = "https://a.4cdn.org"
media_base = "https://i.4cdn.org"
site_base = "https://boards.4chan.org"   # post links in output
extra_hosts = []                         # extra site base-domains recognized as 4chan links
min_request_interval_ms = 1000           # 4chan API rule: <= 1 request/second
max_in_flight = 1
media_min_request_interval_ms = 250
media_max_in_flight = 2
timeout_ms = 15000
max_response_bytes = 8388608             # a 750-post thread is ~1-2 MB

[yotsuba.enrichment]
enabled = true                           # effective only with [features].yotsuba
media_boards = "all"                     # "all" | "worksafe"
board_previews = true

[yotsuba.preview]                        # §6.1
max_posts = 10
max_text_tokens = 1500
max_files = 2
excerpt_chars = 160
parents_max = 4
replies_max = 3
latest_replies = 3
most_replied_max = 2
most_replied_min = 5
board_threads = 5

[yotsuba.tool]                           # §7
page_tokens = 6000
page_tokens_max = 12000
files_per_page = 4
view_max_files = 4
pdf_max_chars = 8000
catalog_default_limit = 15
catalog_max_limit = 50
max_download_files = 50
```

Validation at app wiring (fail-fast): `page_tokens <= page_tokens_max`, and `page_tokens_max`
at most `[agent.tools].result_max_tokens` when that cap is on (a page must never be cut by the
generic per-result cap, which would break the footer contract);
`catalog_default_limit <= catalog_max_limit`; bases are `https://` URLs; `extra_hosts` entries
are bare hostnames. A `[yotsuba]` table with the feature off is valid and inert.

---

## 11. Implementation phases

1. **Plumbing**: `PacedLimiter` extraction with priorities (Danbooru switched over, its
   tests green); `src/yotsuba/` url, client, types, markup, graph; config schema, defaults,
   wiring validation; the feature flag.
2. **Engine**: `view.ts` with the selection rules and omission vocabulary, fully unit-tested
   on fixtures before any caller exists.
3. **T1**: enrichment partition and stage, storyboard helper, payload, renderer (rich and
   compact, discord-embed suppression); ARCHITECTURE §7f and the §4 feature-gate text.
4. **T2**: the tool, PDF helper, skill template, `web_fetch` hint; ARCHITECTURE §10.

Each phase lands with its ARCHITECTURE.md update in the same commit; this spec flips to
IMPLEMENTED at the end.

## 12. Tests

- `markup.ts`: table-driven over real `com` samples (quotelinks same/cross-thread, greentext,
  `<wbr>` inside URLs, dead links, spoilers, code, mod text, entities).
- `url.ts`: every form in §4.1, legacy host, slug and anchors, lookalikes, `extra_hosts`.
- `graph.ts`: backlinks, quotes to deleted posts, self-quotes, quotes of the OP.
- `view.ts`: no post rendered twice (OP quoted by the linked post; a latest reply that is
  also most-replied); pinned slots over budget; full-to-excerpt fallback; contiguous paging
  stops at the first misfit; gap and file counts; reference annotations; file priority and
  `max_files`; most-replied threshold and OP exclusion; deterministic output.
- Client with stubbed fetch and injected clock: freshness window, `If-Modified-Since` / 304,
  negative cache, single-flight, pacing, interactive overtaking background.
- `PacedLimiter`: the moved Danbooru tests plus priority tests.
- Worker: partition strips refs from the generic stage; post / thread / board / missing-post
  / gone / other-failure rows; `media_boards`; feature off leaves URLs on the generic path.
- Renderer: golden outputs for §6.5 A-E; escaping; per-post file placement and
  `image_block`; `discord_embed` suppression.
- Tool: every action and view against fixtures; footers contain valid, literal next calls
  (parse them back and execute them in the test); naive-call tolerance; every §7.5 error;
  vision vs non-vision file handling; storyboard and PDF paths.
- Fixtures: trimmed real API responses captured once (a general with dense quoting, an
  archived thread, a post with ID and flag, a catalog, boards.json, a webm post, a /po/ PDF
  post).
