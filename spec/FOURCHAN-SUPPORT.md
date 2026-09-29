# 4chan Support: rich link previews + `fourchan` browsing tool + skill

**Status**: PROPOSED (design session 2026-09-29). Not implemented. Open owner decision: D1 (§8).

**Target ARCHITECTURE.md homes once implemented**: new §7f "4chan Enrichment" (sibling of
§7a "X.com enrichment via FxTwitter" and §7e YouTube); §10 "4chan tool"; §4 "Feature gates"
(new flag, and the gate now also covers an enrichment stage); §9 rendering notes.

---

## 1. Goal

4chan links are a dead end today. A thread URL posted in chat goes through the generic
Synapse / direct-scrape path, which yields at best a page title ("/g/ - Technology - 4chan")
and a thumbnail: no subject, no OP text, no idea whether the link points at the OP or at a
specific reply, no stats, and nothing the agent can act on. The agent also has no way to
look at a board on request: `web_fetch` returns raw imageboard HTML (huge, noisy, full of
navigation) and the browser is heavyweight for what is a structured-data problem.

4chan publishes a read-only JSON API (`a.4cdn.org`) that needs no authentication, is cached
at the CDN, and has simple published usage rules (§3). Everything we want is one or two
cheap GETs away. This spec adds, as one opt-in feature:

1. **T1: Rich link previews.** A dedicated enrichment stage for 4chan URLs that stores a
   structured snapshot of the thread / targeted post (subject, OP, the linked reply and the
   posts it answers, stats, status) with the relevant images downloaded into the normal
   captioning pipeline.
2. **T2: `fourchan` tool.** Active browsing: list boards, search a board's catalog, read a
   thread (paged, focused on a post, filtered, "most replied" highlights, "new since"), and
   view / download post images.
3. **Skill + activation path** so the agent gets from "someone mentions a board / drops a
   thread link" to the right call without guessing.

### User stories

- A user drops `https://boards.4chan.org/g/thread/109930292#p109930400` and says "lol".
  The agent sees which thread it is, the targeted reply, what that reply was answering, and
  the reply's image (captioned), and can react to the actual joke.
- "What's /lmg/ saying about the new MiMo release?" The agent loads the skill, runs a
  catalog query on /g/ for `lmg`, reads the thread with `query: "mimo"`, and answers with
  post links.
- "Summarize this thread" on a 400-post thread. The agent reads `order: "most_replied"`
  first (the posts that drew the most responses), then pages chronologically only if needed.
- "Anything new in that thread since earlier?" `since: <last post number it saw>`.
- "Post the image from >>109930400." `download_media` then `send_message` with the path.
- A thread linked last week has since been pruned. The stored preview snapshot still shows
  what it was; the tool reports it gone with an actionable message (and, when the operator
  configured an archive, reads it from there, §8).

### Non-goals (v1)

- **No posting, no captcha, no pass login.** Read-only.
- **No cross-board full-text search.** 4chan has no search API; the practical search is a
  per-board catalog filter (§6.2). Archive search is §8, default off.
- **No bare post-number resolution against 4chan itself.** Verified 2026-09-29: both
  `a.4cdn.org/{b}/thread/{reply_no}.json` and `boards.4chan.org/{b}/thread/{reply_no}` return
  404 for a reply number; there is no post-to-thread lookup. Normal post URLs always carry
  the thread number, so this only affects hand-typed `>>>/g/123` references (§5.3).
- **No other imageboards.** vichan/lynxchan sites have different (or no) APIs. The module
  is 4chan-specific in the same way `src/fxtwitter/` is X-specific. (Mirrors of the 4chan
  API shape can be pointed at with `api_base`/`media_base`.)
- **No automatic thread polling / watching.** A "watch this thread and tell us when X"
  feature is future work; v1 only fetches on enrichment or on a tool call.

---

## 2. Feature gate

`[features].fourchan` (boolean, default **off**, same semantics as `character_card` and
`danbooru`). It is the single master switch for the whole feature:

- adds `fourchan: ["fourchan"]` to `FEATURE_TOOLS` (tool registration + skill seeding from
  `templates/features/fourchan/skills/fourchan/`, both existing mechanisms);
- **new:** also gates the T1 enrichment stage. App wiring passes the `fourchan` option into
  `EnrichmentWorkerOptions` only when `config.features?.fourchan === true` and
  `[fourchan.enrichment].enabled`. With the flag off, 4chan URLs stay on the generic preview
  path exactly as today (status quo preserved for every existing deployment).

The §4 "Feature gates" text currently says the gate is "purely a tool-availability gate";
the implementing commit updates that paragraph: a feature may additionally own a
non-tool subsystem, and `fourchan` is the first that does. `FeaturesSchema` (StrictObject)
gains `fourchan`; its header comment gets the new line (and the stale "skill seeding is
NOT implemented yet" note in that comment is corrected while there).

Tunables live in a top-level `[fourchan]` table (§9) shipped in `00-defaults.toml`. The
table has no `enabled` of its own: presence of defaults never turns anything on.

---

## 3. The 4chan API and its rules

Endpoints used (all JSON, `https://a.4cdn.org`):

| Endpoint | Use | Freshness we allow |
|---|---|---|
| `/boards.json` | board list: `board`, `title`, `ws_board`, `meta_description`, limits, `is_archived` | 24 h |
| `/{b}/catalog.json` | every live thread's OP + counts + `last_replies` (array of pages) | 10 s |
| `/{b}/thread/{no}.json` | full thread `{ posts: [...] }`; also serves archived threads (`archived: 1`) | 10 s |
| `/{b}/archive.json` | archived thread numbers (not used in v1; noted for §8) | n/a |

Media: `https://i.4cdn.org/{b}/{tim}{ext}` (original), `https://i.4cdn.org/{b}/{tim}s.jpg`
(thumbnail).

Published usage rules we must honor (4chan API README), with how we honor them:

1. **No more than one request per second** to the API. A process-wide paced limiter on
   the API host, `min_request_interval_ms = 1000` (§4.2). Shared by enrichment and every
   session's tool calls.
2. **Threads should not be refreshed more than once every 10 seconds.** Per-resource
   freshness window (table above) in the client cache: inside the window the cached body
   is served with zero requests.
3. **Use `If-Modified-Since`.** Every refetch of a cached resource is conditional; a `304`
   reuses the cached body. (Verified: the API returns `Last-Modified` and honors the
   header with `304`.)
4. The API is CORS-restricted to 4chan's own origins; irrelevant for a server-side client.

Verified facts from the 2026-09-29 probe (inform parsing, not config):

- `com` is HTML: `<br>`, `<wbr>` (soft break inside long URLs; must be removed, not turned
  into whitespace), `<a class="quotelink" href="#p123">&gt;&gt;123</a>` (same-thread),
  `href="/g/thread/456#p456"` (cross-thread), `<span class="quote">&gt;…</span>`
  (greentext), plus board-specific `<s>` (spoiler), `<pre class="prettyprint">` (/g/ code),
  `<span class="deadlink">`, `[math]`/`[eqn]` (/sci/), and mod text such as
  `<b style="color:red;">(USER WAS BANNED FOR THIS POST)</b>`.
- An archived thread keeps being served by the same endpoint with `closed: 1`,
  `archived: 1`, `archived_on`; once the board archive rotates it out (or on a board with
  no archive) the endpoint 404s.
- Optional fields vary by board: `id` (poster ID, e.g. /pol/, /biz/), `country` /
  `country_name` or `board_flag` / `flag_name`, `trip`, `capcode`, `sub`, `spoiler`,
  `filedeleted`, `unique_ips` (OP only, not always present), `sticky`, `closed`,
  `bumplimit`, `imagelimit`, `semantic_url`.

---

## 4. Module layout (`src/fourchan/`)

Pure TS, no Matrix/native imports (the `src/fxtwitter/` precedent):

- `url.ts`: URL recognition + canonicalization (§5).
- `client.ts`: `FourChanClient` (§4.1): typed endpoint methods, cache, single-flight,
  limiter, `guardedFetch` + proxy dispatcher.
- `types.ts`: tolerant API types (every field optional), persisted payload types,
  `FOURCHAN_SOURCE_KIND = "4chan"`, config resolution.
- `markup.ts`: `com` HTML to annotated plain text (§4.3). Pure, heavily unit-tested.
- `thread.ts`: thread graph helpers: backlink index (who quotes whom), ancestor chain,
  most-replied ranking, `since` / `query` filters.
- `format.ts`: preview payload building, flat description (FTS), tool document assembly.

The tool lives in `src/tools/fourchan.ts`.

### 4.1 `FourChanClient`

One instance, constructed at app wiring when the feature is on, shared by the enrichment
stage and every session's tool (the `FxTwitterClient` precedent).

- `boards()`, `catalog(board)`, `thread(board, no)`: each returns the parsed body plus
  `{ fetchedAt, lastModified, fromCache }`, so outputs can say how fresh they are.
- **Cache**: in-memory, keyed by path, bounded by entry count and total bytes (defaults
  64 entries / 32 MiB; implementer's choice). Inside the freshness window: served from
  cache. After it: conditional GET; `304` refreshes `fetchedAt`.
- **Negative cache**: a 404 is remembered for 10 minutes (a dead thread linked repeatedly,
  or a backfill burst of old links, costs one request).
- **Single-flight**: concurrent identical requests share one promise (three links to one
  thread in a message, or enrichment and a tool call racing, cost one GET).
- Transport: `guardedFetch` (SSRF guard, per-host unconditional 429/503 + Retry-After
  backoff), `[network].http_proxy_url` dispatcher, `timeout_ms`, response-size bound
  `max_response_bytes`, a stable identifying `User-Agent` (`mikuswarm/<version>`). Any
  non-2xx other than 304/404 throws with the status.

### 4.2 Pacing: one shared limiter, extracted from Danbooru

`DanbooruRateLimiter` (`src/tools/danbooru.ts`) is already a correct generic paced limiter
(synchronous start-instant reservation, FIFO slot admission with direct handoff). Extract
it verbatim to `src/net/paced-limiter.ts` as `PacedLimiter`, keep Danbooru on it
unchanged (existing tests move with it), and add one capability:

- **Two priority classes**, `interactive` and `background`: two FIFO queues; a released
  slot is handed to the interactive head first. Tool calls are `interactive`; enrichment is
  `background`. Rationale: with a 1 req/s budget, a backfill burst of old 4chan links must
  never make a user-facing tool call wait behind it. Danbooru passes nothing and gets the
  current single-queue behavior.

Two instances for 4chan:

- **API lane** (`a.4cdn.org`): `min_request_interval_ms = 1000`, `max_in_flight = 1`.
- **Media lane** (`i.4cdn.org`): `media_min_request_interval_ms = 250`,
  `media_max_in_flight = 2`. The CDN has no published rule; this is a courtesy pace so a
  `download_media: "all"` on a 150-image thread cannot open a firehose.

Both compose with (and sit inside) the per-host HTTP limiter and its unconditional backoff.

### 4.3 Markup conversion (`markup.ts`)

`com` HTML to text that preserves what matters to a reader and to the thread graph:

| Input | Output |
|---|---|
| `<br>` | newline |
| `<wbr>` | removed (no whitespace) |
| same-thread quotelink `>>123` | `>>123`, plus ` (OP)` when 123 is the OP; collected into `quotes[]` |
| cross-thread quotelink `/b/thread/456#p789` | `>>>/b/789` (4chan's own notation); collected into `crossQuotes[]` |
| `<span class="quote">` greentext | kept as-is (leading `>` preserved) |
| `<span class="deadlink">>>123</span>` | `>>123 (dead)` |
| `<s>x</s>` | `[spoiler]x[/spoiler]` |
| `<pre class="prettyprint">` | fenced code block |
| `[math]…[/math]`, `[eqn]…[/eqn]` | kept verbatim |
| red mod text | `[mod: USER WAS BANNED FOR THIS POST]` |
| any other tag | stripped, text kept |
| entities | decoded (`&gt;`, `&#039;`, `&amp;` …) |

Output is untrusted text: XML-escaped at render time, wrapped in an untrusted envelope in
tool output (§6.4). Nothing in a post body is ever fed to a fetcher.

---

## 5. URL recognition and the enrichment partition

### 5.1 Recognized forms (`url.ts`)

Hosts: `boards.4chan.org`, `boards.4channel.org` (legacy, still pasted), `4chan.org` /
`www.4chan.org`; plus `[fourchan].extra_hosts` (for a deployment fronting the site under
another name). Base-domain matching with subdomain tolerance and lookalike rejection, same
helper shape as `isStatusHost` in `src/fxtwitter/url.ts`.

| Form | Ref |
|---|---|
| `/{b}/thread/{no}[/{slug}][#p{post}\|#q{post}]` | `{ kind: "thread", board, threadNo, postNo? }` |
| `/{b}/` , `/{b}/catalog`, `/{b}/{page}` | `{ kind: "board", board }` |
| anything else on these hosts (`/rules`, `/search`, `/{b}/archive`) | not recognized: generic path |

`board` must match `^[a-z0-9]{1,10}$`. Canonical URL:
`https://boards.4chan.org/{b}/thread/{no}` (+ `#p{post}` when targeted) and
`https://boards.4chan.org/{b}/`. Dedup per body by `(board, threadNo, postNo)`. A link
whose `#p` equals the thread number is a plain thread ref.

Direct media links (`i.4cdn.org/...jpg|png|gif|webm|mp4`) are **not** handled here: the
existing linked-media path already downloads them by extension.

### 5.2 Partition

Inside `fetchLinkPreviews`, after the X and YouTube partitions and before the generic stage:
recognized 4chan refs are stripped from `filteredBody` (the Synapse / scrape stage never
produces the bare og-card for them) and their raw matches are added to the linked-media
exclusions. Message and reply bodies get identical treatment. They share
`enrichment.max_previews_per_message` with every other kind, allocated in order of first
appearance (existing rule).

**Eligibility: every event** (the X precedent, not the YouTube trigger-group gate). The
cost is one cached, paced, CDN-served GET per link; inference spend on the downloaded images
is still governed by the existing captioning gates (`caption_all`, trigger groups,
`caption_assistant_messages`). A snapshot taken at post time is also the only way to keep a
record of a thread that will be pruned within hours, which argues for enriching everything.

**Discord ingest embeds**: Discord's own unfurl of a 4chan URL is a bare og-card and is
stored at ingest as a `discord_embed` row. The 4chan stage still runs for that URL (the X
precedent). Additionally, the renderer suppresses a `discord_embed` row when the same event
carries a `4chan` row for the same `(board, threadNo)`: the embed is a strict subset and
rendering both wastes tokens. (Scoped to `4chan` rows; X behavior is unchanged.)

### 5.3 Cross-board text references

Chat users sometimes write `>>>/g/109930400` without a URL. Not enriched in v1: without the
thread number there is nothing to fetch (§1 non-goals), and a thread-number-only guess would
be wrong for every reply. The tool accepts the notation (§6.1) and explains the limitation
when it is a reply number.

---

## 6. T1: the preview snapshot

### 6.1 What is captured

Per thread ref (one `thread(board, no)` call, plus `boards()` for the board title, cached
24 h):

- **Thread header**: board code + title, worksafe flag, thread no, subject, reply / image
  counts, `unique_ips` when present, status (`live` / `sticky` / `closed` / `archived`),
  bump-limit / image-limit reached, `as_of` (fetch time).
- **OP**: author block (name, trip, poster ID, flag, capcode), time, text (capped at
  `max_text_chars`, default 1500, with a truncation flag), file metadata (filename, ext,
  WxH, size, spoiler, deleted).
- **When the link targets a reply (`#p`)**: the target post (full author block, text capped
  at `max_text_chars`, file) plus its **quote context**: the posts it quotes, recursively,
  up to `quote_context_depth` (default 2) and at most 4 posts total, text capped at
  `max_text_chars / 3` each. The OP text in this case is capped at `max_text_chars / 3` too:
  the reply is the point of the link. The target's own backlink count ("N replies to this")
  is recorded.
- **When the link is to the thread itself**: the `top_replies` (default 3) most-quoted
  replies (ties to the earlier post), text capped at `max_text_chars / 3`. This gives the
  model the thread's flavor at a fixed cost.
- **Board refs**: board title, worksafe flag, `meta_description` (entity-decoded), and the
  first `board_preview_threads` (default 5) non-sticky threads in bump order (subject or
  OP teaser, reply count). One `catalog(board)` call. `board_previews = false` skips board
  refs (they then fall through to the generic path).

A targeted post number that is not in the thread (deleted, or a typo) degrades to a
thread preview with `target_missing` recorded, never a failure.

### 6.2 Media

Downloaded via `FetchClient` on the media lane (egress guard, proxy,
`media.download_size_limit`), stored as `preview_media` / `reply_preview_media` assets hung
off the link-preview row by `link_preview_id`, `caption_status` set by the existing
post-pass. Which files:

- `media = "op_and_target"` (default): the OP's file and, for a `#p` link, the target
  post's file. Board previews download nothing. Quote-context and top-reply posts are text
  only (their file metadata is still listed).
- `media = "none"`: metadata only.

Per file: images (`.jpg .png .gif`) download the original (the 250 px thumbnail captions
poorly). `.webm`/`.mp4` download the original as a `video` asset (video caption lane, same
as X videos); on size/fetch failure fall back to the `s.jpg` thumbnail as an image asset
(`kind: "video_thumbnail"`). Other types (`.pdf` on /po/, `.swf` on /f/) are listed, not
downloaded. `spoiler` files download normally and render with `spoiler="true"` so the model
can choose to be coy. `filedeleted` files are listed as deleted.

`media_boards = "all"` (default) or `"worksafe"` restricts downloads to `ws_board = 1`
boards. Default `all` because the operator has explicitly opted into 4chan and every
download is still subject to the captioning gates; the knob exists for deployments whose
caption model or storage policy should not see NSFW-board images.

### 6.3 Persistence

No new tables, no migration (the X precedent). One `link_previews` row per ref:

- `source_kind = "4chan"`, `site_name = "4chan"`, canonical `url`
- `title`: `"/{b}/ - {subject or OP teaser}"` (board ref: `"/{b}/ - {board title}"`)
- `description`: flat text of the whole snapshot (subject, OP text, target + context text,
  top replies). This is what the compact tier falls back to and, critically, what the
  chat-search FTS indexes, so thread content becomes searchable with zero search changes.
- `payload_json`: `FourChanPreviewPayload`:

```ts
interface FourChanPreviewPayload {
  v: 1;
  kind: "thread" | "board";
  board: string; boardTitle?: string; worksafe?: boolean;
  asOf: number;                       // epoch s of the fetch
  // thread kind
  threadNo?: number; subject?: string;
  replies?: number; images?: number; posters?: number;
  status?: "live" | "sticky" | "closed" | "archived";
  bumpLimit?: boolean; imageLimit?: boolean;
  targetNo?: number; targetMissing?: boolean;
  posts?: FourChanPostNode[];         // OP first, then target, then context/top in thread order
  // board kind
  description?: string;
  threads?: { no: number; teaser: string; replies: number }[];
}
interface FourChanPostNode {
  no: number;
  role: "op" | "target" | "quoted" | "top";
  name?: string; trip?: string; posterId?: string; capcode?: string;
  flag?: string;                      // country_name or flag_name
  time: number;
  text: string; textTruncated?: boolean;
  quotes?: number[];                  // same-thread >>refs, for the renderer's "replying to"
  backlinks?: number;                 // how many posts quote this one
  file?: { name: string; ext: string; w?: number; h?: number; bytes?: number;
           spoiler?: boolean; deleted?: boolean; assetId?: string;
           kind?: "image" | "video" | "video_thumbnail" | "listed" };
}
```

Media slots reference assets by id (provenance lives in the payload, the X precedent).
Malformed JSON degrades to the generic flat rendering.

**Failures** (`fetch_status: "failed"`, logged `enrichment_fourchan_failed`, event-level
retry not triggered, the X/YouTube policy): a 404 stores error `"gone"` so the renderer can
say the thread was already dead when posted; any other failure stores the error text and
renders as the plain URL.

### 6.4 Rendering

Full tier (`renderRichMessage`), new branch next to the X and YouTube renderers:

```xml
<link_preview url="https://boards.4chan.org/g/thread/109930292#p109930400" kind="4chan">
<chan_thread board="/g/ - Technology" no="109930292" subject="/lmg/ - Local Models General" replies="434" images="88" posters="120" status="live" bump_limit="reached" as_of="2026-09-29 01:00">
<chan_post no="109930292" role="op" author="Anonymous" time="2026-09-28 10:31">
…OP text (truncated)…
[file: foo.png 1200x800]
</chan_post>
<chan_post no="109930380" role="quoted" author="Anonymous ID:Ab12Cd34 (Finland)" time="…">…</chan_post>
<chan_post no="109930400" role="target" author="Anonymous" time="…" replying_to="109930380" replies="7">
…text…
<media …existing preview-media block, caption included…/>
</chan_post>
[partial snapshot: read the full thread, replies to a post, or newer posts with the fourchan tool]
</chan_thread>
</link_preview>
```

- Post and subject text are XML-escaped (`escapeXml`), attributes via `escapeAttr`
  (untrusted-content convention, same as tweet bodies). Times use the renderer's existing
  agent-timezone timestamp helper.
- Each post's asset renders inside its own `<chan_post>` using the per-slot mechanism of the
  X renderer, so a caption is attributed to the right post.
- The trailing marker is trusted structural text and is the tool's entry point (§7.1). It
  is omitted for board previews, which end with
  `[board snapshot: search or list threads with the fourchan tool]`.
- A `"gone"` failure renders `<link_preview url="…" kind="4chan" status="gone"/>`.

Compact tier (`renderCompactMessage`), bounded by `MAX_COMPACT_MEDIA_CAPTION`:

```
 [4chan /g/: "/lmg/ - Local Models General" · 434 replies · >>109930400: target head…]
 [4chan /g/: "Subject" · 12 replies · OP head…]
 [4chan /g/ board: Technology]
 [4chan /g/ thread 123: gone]
```

---

## 7. T2: the `fourchan` tool

One tool with an `action` field (the `danbooru` precedent: one definition, cheaper than four
when loaded). Registered only when the feature is on. Every action tolerates the naive
call: a `url` alone is enough, `board` accepts `g`, `/g/`, `/g`, and `thread` accepts a
number, a URL, `>>123`, or `>>>/g/123`.

### 7.1 Actions

**`boards`**: `{ query? }`. Code, title, worksafe marker, one per line; `query` filters by
code/title/description substring. Cached 24 h, so effectively free.

**`catalog`**: `{ board, query?, order?, limit?, offset? }`

- `order`: `bump` (default, 4chan's own order), `replies`, `images`, `created`,
  `last_reply`.
- `query`: case-insensitive; every whitespace-separated term must appear in subject + OP
  text (4chan's own catalog search semantics). This is the "find the /xyz/ general" and
  "is there a thread about X" path.
- One line per thread plus a teaser: `#{no} "{subject}" · {R}R/{I}I · started 3h ago ·
  last reply 2m ago [sticky] [closed]` then the first ~200 chars of OP text. `limit`
  default 15, max 50. Ends with the thread URL pattern so the agent can link.

**`thread`**: `{ board?, thread | url, post?, order?, since?, query?, offset?, max_chars? }`

Builds one document, then returns the `[offset, offset + max_chars)` window with the
x_fetch windowing contract (`details: { totalChars, nextOffset, truncated }`,
`[truncated, continue with offset=N]`). Header: board, subject, counts, status, `as_of`,
thread URL. Each post:

```
#109930400 · Anonymous ID:Ab12Cd34 (Finland) · 09-28 10:41 · [file: pepe.png 800x600 212KB]
>>109930380
<text>
  ↳ 7 replies: >>109930411 >>109930420 >>109930433 (+4)
```

Views (mutually composable where sensible; tolerant of empty/zero padding values):

- default: chronological, whole thread.
- `post`: focus view. The post's ancestor chain (depth 3), the post, its direct replies,
  and their direct replies (depth 1), in thread order. This is "what did anons say to
  this?" and is the default when the input URL carries `#p`.
- `order: "most_replied"`: posts ranked by backlink count (OP excluded), each with its
  direct replies' heads. The cheap summary path for big threads.
- `since: N`: only posts numbered above N (the incremental "what's new" path; the header
  states how many were skipped).
- `query`: only posts containing all terms, each with the post it replies to (one line
  head) for context.

**`view_media`**: `{ board?, thread | url, posts: number[] | "all" }` (clamped to
`max_view_blocks` with a note). Vision-aware on the session's reply model, the
danbooru `preview` precedent: vision models get image blocks (originals conditioned through
`conditionImageBufferForInference` to the model's `image_input_bytes` cap; videos as their
thumbnail frame); non-vision models get a caption of each through the session's caption
client (billed as a §8c `tool_invocations` row, counted against §8d), plus URLs and a pointer
to the `media` tool for follow-up questions. Captioning unconfigured: URLs only.

**`download_media`**: `{ board?, thread | url, posts: number[] | "all" }`. Originals saved
under `downloads/4chan/{board}/{threadNo}/{postNo}{ext}` (exclusive create, collision
suffixes, the x_fetch helper), returns workspace-relative paths for `send_message` /
`read_image`. `"all"` is capped at `max_download_files` (default 50) per call with a note.

All output is **ephemeral** (session rollout only, no DB writes; downloads are ordinary
workspace files). Post text in tool output is wrapped in
`<untrusted_4chan source="thread|catalog" board="g" thread="…">` envelopes, bodies escaped,
structure trusted (the `youtube_fetch` convention).

### 7.2 Errors (all actionable)

- Unknown board: `Unknown board "/lmgg/". Closest: /g/ (Technology), … Call action "boards"
  for the full list.`
- Thread 404: `Thread 123 on /g/ is gone (pruned or deleted; not in 4chan's archive).` plus,
  when §8 archives are configured and also missed, `Also not found in: <archive names>.`
  plus, when the input was a `>>>/b/N` or bare number: `If 123 is a reply number, 4chan
  cannot map it to its thread: pass the full post URL (…/thread/<thread>#p123), or find
  the thread with action "catalog" and a query.`
- `post` not in thread: names the thread's post-number range and suggests `order:
  "most_replied"` or `query`.
- Media on a post with no file / deleted file: names which requested posts do have files.
- Rate limiting is invisible to the caller (the limiter waits); a sustained upstream
  429/503 surfaces as `4chan is throttling requests; retry in ~Ns.`

---

## 8. Archive fallback via FoolFuuka (optional, default off)

**Owner decision requested (D1)**: whether this section is in v1.

4chan threads live hours to days; many boards' own archives keep them only a few days more,
and some boards have no archive (`is_archived: 0`). Third-party archives run FoolFuuka,
which exposes a stable JSON API:

- `GET {base}/_/api/chan/thread/?board={b}&num={no}`: full thread
- `GET {base}/_/api/chan/post/?board={b}&num={no}`: one post, **including its
  `thread_num`** (this also solves bare post-number resolution, §5.3)
- `GET {base}/_/api/chan/search/?boards={b}&text={q}`: full-text search over history

Proposal: `[[fourchan.archives]]`, **empty by default** (the public project ships no
third-party endpoints and endorses none), each entry
`{ name, base_url, boards = [...], min_request_interval_ms = 2000 }`. When a board has a
configured archive:

- T1: a 404 from 4chan retries against the archive; the snapshot records
  `source: "<archive name>"`. Archive URLs themselves (`{base_url host}/{b}/thread/{no}`)
  become recognized refs, so a pasted archive link previews too.
- T2: `thread` falls back the same way (output header names the archive); a bare post
  number resolves through `/chan/post/`; a new `search` action `{ board, query }` queries
  the archive's history (error when no archive is configured for that board, naming the
  config key).
- Each archive gets its own `PacedLimiter` (they are volunteer-run and some sit behind
  Cloudflare bot protection; a challenge page is reported as "archive unavailable", never
  retried in a loop).
- FoolFuuka field names differ (`num`, `thread_num`, `comment` as plain text with `>>`
  markup, `media.media_link` / `thumb_link`, `poster_hash`, `poster_country`); `types.ts`
  normalizes both shapes into the same internal post type so everything downstream is
  source-agnostic.

Recommendation: **include it in v1 as a separate implementation phase** (§11 phase 3),
default off. It is the only fix for the most common failure (the thread is gone) and the
only real search, and default-off keeps the public project neutral. Deferring is also safe:
nothing else in the design depends on it.

---

## 9. Configuration

```toml
# 90-local (or any overlay): the switch
[features]
fourchan = true

# 00-defaults: tunables only, nothing here turns the feature on
[fourchan]
api_base = "https://a.4cdn.org"
media_base = "https://i.4cdn.org"
site_base = "https://boards.4chan.org"   # used to build post links in output
extra_hosts = []                         # extra site base-domains recognized as 4chan links
min_request_interval_ms = 1000           # 4chan API rule: <= 1 request/second
max_in_flight = 1
media_min_request_interval_ms = 250
media_max_in_flight = 2
timeout_ms = 15000
max_response_bytes = 8388608             # a 750-post thread is ~1-2 MB

[fourchan.enrichment]
enabled = true                           # effective only with [features].fourchan
max_text_chars = 1500                    # OP / target post; context posts get a third
quote_context_depth = 2
top_replies = 3
media = "op_and_target"                  # "op_and_target" | "none"
media_boards = "all"                     # "all" | "worksafe"
board_previews = true
board_preview_threads = 5

[fourchan.tool]
default_max_chars = 6000
max_chars_limit = 16000
max_total_chars = 262144                 # whole-thread document; paged via offset
catalog_default_limit = 15
catalog_max_limit = 50
max_view_blocks = 4
max_download_files = 50
```

Validation at app wiring (fail-fast, the x_fetch/youtube pattern):
`default_max_chars <= max_chars_limit <= max_total_chars`;
`catalog_default_limit <= catalog_max_limit`; bases are `https://` URLs (`http://` refused);
`extra_hosts` entries are bare hostnames. A `[fourchan]` table with the feature off is
valid and inert (it ships in defaults).

---

## 10. Activation and discovery

Per the repo's tool-activation rules (CLAUDE.md "Agent-facing tools").

**Immediate vs deferred: deferred.** Every entry point is cued (a link in context, or a user
ask naming a board/thread), so there is no reactive mid-flow need that would justify an
always-on definition. The tool is declared only by the feature skill.

**Always-on cost when the feature is on**: one skill description line (~70 tokens). Nothing
when off. The preview marker costs tokens only on events that carry 4chan links.

**Entry points**:

1. *Link posted.* The preview is in context at the moment of need; its trailing marker
   names the `fourchan` tool. Under dynamic loading the agent either loads the skill
   (description matches "4chan thread link") or calls the tool directly and recovers via
   the existing "not found, load its skill" backstop (one cheap call). The marker is
   phrased with the tool name deliberately, like the YouTube transcript marker.
2. *User asks about a board / general / thread with no link* ("what's /v/ saying about
   X", "check the /lmg/ thread"). The ask matches the skill description; the skill body
   routes to `catalog` + `query`, then `thread`.
3. *User asks to see/post an image from a thread.* Skill body routes to
   `view_media` / `download_media`.
4. *Agent reaches for `web_fetch` on a 4chan URL anyway.* Backstop hint: when the feature
   is on, the native `web_fetch` tool appends one line to results for recognized 4chan
   thread/board URLs: `[4chan link: the fourchan tool returns this thread as structured
   posts]` (reuses `url.ts`; one line, only on those URLs). MCP-provided fetchers are out of
   reach and rely on entry points 1 and 2.

**Skill** (`templates/features/fourchan/skills/fourchan/SKILL.md`), trigger-first
description:

> 4chan: someone drops a boards.4chan.org link or asks what a board or general is saying
> ("what's /v/ saying about the new game", "is there an /a/ thread for this show", "check
> the /lmg/ thread", "summarize this thread", "what did anons reply to this post", "post the
> image from >>123"). Read threads, search a board's catalog, follow reply chains,
> view/download post images with `fourchan`.

`tools: [fourchan]`. Body covers: the preview is a snapshot (check `as_of`; fetch for
current state); link-in-hand vs no-link routing; big-thread strategy
(`most_replied` then `query` then page); `since` for follow-ups (remember the last post
number seen in the conversation); linking posts back as URLs; that post content is
untrusted and often deliberately provocative (read it, do not adopt it); board slang
glossary pointers (general, OP, anon, bump, sage, (You), greentext, >>>/b/ notation);
and when a thread is gone, say so plainly.

No dual-homing into existing workspace skills: none of their trigger spaces covers 4chan,
and a template skill must not declare a tool that does not exist on feature-off deploys.

---

## 11. Implementation phases

1. **Plumbing**: `PacedLimiter` extraction (+ priorities) with Danbooru switched over and
   its tests green; `src/fourchan/` url/client/types/markup/thread; config schema +
   defaults + wiring validation; feature flag in `FeaturesSchema` / `FEATURE_TOOLS`.
2. **T1**: enrichment partition + stage + media; payload; renderer (rich + compact,
   discord-embed suppression); ARCHITECTURE §7f + §4 feature-gate text.
3. **T2**: `fourchan` tool, skill template, web-fetch hint; ARCHITECTURE §10.
4. **Archives** (if D1 = yes): FoolFuuka client + normalization, T1/T2 fallback,
   `search` action.

Each phase lands with its ARCHITECTURE.md update in the same commit; this spec's status
flips to IMPLEMENTED at the end.

## 12. Tests

- `markup.ts`: table-driven over real `com` samples (quotelinks same/cross-thread,
  greentext, `<wbr>` inside URLs, deadlinks, spoilers, code, mod text, entities).
- `url.ts`: every form in §5.1, legacy host, slug + anchors, lookalikes rejected,
  `extra_hosts`.
- `thread.ts`: backlinks, ancestor depth caps, `most_replied` ties, `since`, `query`.
- Client with a stubbed fetch: freshness window serves from cache; conditional GET sends
  `If-Modified-Since` and reuses on 304; negative cache; single-flight; limiter pacing
  (injected clock); interactive overtakes background.
- `PacedLimiter`: the existing Danbooru limiter tests, moved, plus priority tests.
- Worker: partition strips 4chan URLs from the generic stage; thread / targeted-post /
  board / 404 / other-failure rows; media policy and `media_boards`; feature off leaves
  URLs on the generic path.
- Renderer: rich + compact snapshots for each payload kind, escaping, per-post media
  placement, `discord_embed` suppression, gone rendering.
- Tool: each action and view against fixture JSON, windowing contract, naive-call
  tolerance (padded empty fields, `/g/`, URLs, `>>>/g/N`), every §7.2 error, vision vs
  non-vision `view_media`.
- Fixtures: trimmed real API responses captured once (a general thread with quotes, an
  archived thread, a /pol/-style post with ID + flag, a catalog page, boards.json).
