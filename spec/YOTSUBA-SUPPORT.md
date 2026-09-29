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

1. **T1: link previews, one fetch, two renderings.** Every 4chan link is fetched once
   and rendered cheaply by default: thread metadata plus the linked post (the OP for a
   thread link), truncated. Links the agent is actually being asked about (in the trigger
   group, or in the message a trigger replies to) are upgraded at trigger time, from the
   stored capture and without another API call, to a richer rendering: 900 tokens per link,
   1800 per trigger group, and 4 processed images per trigger group (§6, exact renderings
   in §6.6).
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

- A channel trades 4chan links all day. Each costs about as much as an ordinary link preview
  in the agent's context: board, subject, counts, a short excerpt of the linked post (the OP
  for a thread link), its image stored.
- Someone replies to one of those links with "@miku explain the joke". The agent sees the
  linked post with its image, the posts it was answering (the setup), and the first replies
  to it with a count of the rest.
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
| `/{b}/catalog.json` | every live thread's OP + counts + `last_replies` (array of pages); tool only | 10 s |
| `/{b}/1.json` | board page 1 (bump order, stickies first), about 50 KB; board-link previews | 10 s |
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
the module because nothing about them is 4chan-specific: `src/media/storyboard.ts` (§6.5)
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

- `boards()`, `catalog(board)`, `page(board, n)`, `thread(board, no)` return the parsed body plus
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
  (preview rules in §6.2 and §6.4, tool views in §7.2). `tier` is `full` (the post's text up to
  `textCap`, or whole when uncapped) or `excerpt` (the first `excerpt_chars` characters,
  default 160, ending in `…`; no file shown).
- A **budget**: `max_posts`, `max_text_tokens` (estimated with the shared
  `estimateTokens`), `max_files` (attachments shown, §5.3), plus a `contiguous` flag used by
  paged views, a `reserveTokens` amount charged up front (the frame, gap markers, footer, and
  caption allowances, so the budget is all-inclusive), and an `excerptFallback` flag
  (trigger previews turn it off: their posts are whole or absent). For trigger renderings the
  file budget is group-wide, so the upgrade allocates files across refs itself (§6.5) and
  runs the engine with no `max_files`.

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
   presented (§6.5, §7.3); the rest are listed with metadata and `status="not shown"`.

Selection happens once, when the snapshot or page is built. Rendering is a pure function of
the result, so a stored preview renders byte-identically on every context build (the
deterministic-rendering invariant).

### 5.3 What "shown" means for each attachment kind

| Kind (4chan ext) | Shown as | Notes |
|---|---|---|
| image (`.jpg .png .gif` still) | the original file | the 250 px thumbnail captions poorly |
| animated `.gif`, video (`.webm .mp4`) | a **storyboard** image (§6.5) plus the original file | the storyboard is the image-block / caption representation; the original is kept for the `media` tool (audio, full analysis) |
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

### 6.1 One fetch, two renderings

A 4chan link in a channel is usually not addressed to the agent: a board-heavy channel can
carry dozens of links an hour that have nothing to do with it. So the preview has two
**renderings** of one stored snapshot:

- **Ambient** (§6.3): the default for every 4chan link. Thread metadata plus the **headline
  post**, truncated; about as much as an ordinary link preview.
- **Trigger** (§6.4): for links the agent is being asked about. The headline post, the
  posts around it, and processed images, within a small budget.

There is exactly **one API fetch per link**, at enrichment time. Enrichment stores a
bounded **capture** of everything either rendering can use (§6.2). What is deferred to the
trigger is only the costly part: downloading the extra files, captioning them, and spending
context tokens on the richer rendering. None of that needs another API call.

The **headline post** is the OP for a thread link, and the linked post for a post link
(`#p`). A link to a post is a link to *that post*; the OP of its thread matters only as
thread metadata (the subject line), exactly as a thread link does not show its replies.

A link is **trigger-related** when it is in the body of any event of a session's trigger
group (the trigger message and the messages grouped with it), or in the body of the message
a trigger-group event replies to (its `<reply_to>` context). The link may have been enriched
long before: a link posted a few seconds before "@miku thoughts?" is enriched as an ordinary
message, and joins the trigger group only when the trigger arrives. That is why the
upgrade is a separate step at trigger time (§6.4), and why it works from the stored capture.

Once a link has been upgraded, **the trigger rendering is its rendering from then on**,
wherever the event appears in the rich zone of later contexts: the agent keeps seeing what
it answered about in follow-up conversations. That persistence is why the trigger budget is
small (§6.4). Image blocks are the one exception: they exist only in the session of the
trigger that upgraded the link (§6.5); afterwards the files render as captions and paths,
like all other media in history.

### 6.2 The capture (enrichment, one API call)

Per ref, one `thread(board, no)` call (plus the 24 h-cached `boards()` for the board title).
Enrichment stores, in the row's payload:

- **Thread metadata**: board code and title, thread number, subject (or, when the thread has
  none, the first `untitled_words` (8) words of the OP as `op_excerpt`), post / file / poster
  counts, status (sticky, closed, archived, bump limit, image limit), and `as_of`.
- **Candidate posts**, full text and file metadata (not the files):

| Link | Headline | Candidates |
|---|---|---|
| thread | the OP | the last `latest_replies` (3) replies; up to `replied_to_max` (3) posts those answer, the newest first (the OP and posts already captured don't count) |
| post (`#p`) | the linked post | up to `replied_to_max` (3) posts it answers, the newest first; its first `replies_max` (3) replies |

At most 7 posts of at most `max_comment_chars` each, so a capture is bounded (a few KB
typically, about 15 KB worst case). A `#p` number that is not in the thread degrades to a
thread link with `linked_missing="N"`.

- **Files**: only the **headline post's file** is downloaded at enrichment (video: the
  original plus its storyboard, §6.5; PDF: 4chan's page-1 thumbnail). Its captioning follows
  the **normal rules** (`caption_all`, or an assistant message under
  `caption_assistant_messages`); otherwise it is stored and referenced by path, like any
  other preview image the agent may open with `read_image` / `media`.

The snapshot is the thread as it was when the link was posted. A trigger that arrives much
later (a reply to a week-old link) renders that snapshot with its `as_of`; the tool shows the
thread's current state.

**Reply contexts reuse the capture.** A trigger that replies to a message containing a 4chan
link makes enrichment process that message's body again, as the trigger's reply context. When
the replied-to event already has a stored `yotsuba` row for the same ref, the reply-context
row copies its payload and references the already-downloaded files instead of fetching
anything. Only a replied-to message that was never enriched (older than the feature, for
example) costs a fetch.

**Board links** fetch page 1 (`/{b}/1.json`, about 50 KB for /g/, CDN-cached) and store the
first `board_threads` (3) non-sticky threads in bump order: number, subject (or the first
`untitled_words` words of the OP), reply and file counts, creation time. Board previews have
one rendering (§6.6 H) whatever the context; no files.

### 6.3 Ambient rendering

Thread metadata, the headline post truncated to `ambient_chars` (300) with a
`[… N more characters]` marker, its file element, and a one-line footer pointing at the
tool. About 100 to 180 tokens, plus a caption only where the normal rules produced one.

### 6.4 Trigger upgrade

**Where it runs.** `awaitTriggerReadiness` (`src/app.ts`) today waits for the group's
enrichment, then for its captions. The upgrade runs **between the two waits**: every capture
is stored and the reply contexts are resolved, and nothing it adds has been captioned yet.
It makes **no API calls**. For every trigger-related ref it selects posts from the capture,
applies the budgets, downloads the chosen posts' files through the media lane at
`interactive` priority, flips the processed files to `pending`, and records the result on the
row (§6.7). It is idempotent (a re-dispatched or resumed session finds the upgrade already
recorded; a later trigger on an already-upgraded link reuses it) and bounded by
`enrichment.trigger_wait_timeout_ms`: a ref not upgraded in time stays ambient for that
session and is retried by the next trigger that includes it.

**Content, before budgeting:**

| Link | Pinned | Then, in keep order |
|---|---|---|
| thread | the OP, up to `trigger_headline_chars` (800) | 1. the latest replies; 2. the posts they answer |
| post | the linked post, up to `trigger_headline_chars` (800) | 1. the posts it answers; 2. its replies |

Non-headline posts are always whole (a comment is at most `max_comment_chars`) or absent.

**Budgets**, counted on the rendered output **including** the frame (thread element, gap
markers, footer) and a caption allowance of `captioning.image.max_chars / 4` tokens for each
processed file:

- `trigger_link_tokens` = **900** per ref;
- `trigger_group_tokens` = **1800** across all trigger-related refs of the group;
- `trigger_group_files` = **4** processed files across the group (§6.5).

**Drop order** when a ref is over its budget: for a thread link, the replied-to posts first
(the oldest first), then the latest replies (the oldest first); for a post link, its replies
first (the newest first), then the posts it answers (the oldest first). The headline is never
dropped. Refs are budgeted in **group order**: the trigger message's own refs in order of
appearance, then its reply context's, then the other grouped events (chronological) with
their reply contexts. A ref that no longer fits even its headline in the remaining group
budget stays ambient.

**Selection is one deterministic loop**: allocate processed files over the currently
included posts (§6.5 order), compute every ref's cost with those caption allowances, drop the
next post of any ref over budget, repeat until everything fits. Posts only ever decrease, so
the loop ends, and a slot freed by a dropped post goes to the next file in order.

The 800-character headline cap in this rendering is what keeps a long OP (an /lmg/-style
general OP is around 2,000 characters) from consuming the whole 900; the tool always has the
full text.

### 6.5 Files and the group image budget

**Download rule.** Every file of every post included in a trigger rendering is downloaded
(`preview_media`, or `reply_preview_media` for reply-context rows) and rendered with its
workspace path, so the agent can always open it with `read_image` / `media` or post it with
`send_message`. Files of posts not included are not downloaded.

**Processing budget.** Of those files, at most `trigger_group_files` (**4**) for the whole
trigger group, shared by every trigger-related ref, are **processed**: captioned, and passed
to a vision reply model as image blocks. The rest are **stored**: downloaded and referenced
only. Allocation order:

1. each ref's headline file, in group order;
2. thread links: the latest replies' files; post links: the files of the posts it answers.
   Per ref in group order, the newest post first;
3. thread links: the replied-to posts' files; post links: its replies' files. Per ref in
   group order, the newest post first.

With five thread links in one message, the first four OP images are processed, the fifth
OP's is stored only, and nothing further down is processed.

| State | Captioning | Image block | Renders as |
|---|---|---|---|
| processed | `caption_status = 'pending'`, captioned before the context build (the existing caption wait) | in the upgrading trigger's session, for a vision reply model | `path`, `image_block="true"` (that session only), `[caption: …]` |
| stored | `caption_status = 'deferred'`, never auto-captioned | never | `path` and `auto="off"` |

`deferred` already exists (§7d backfetch: downloaded, held back from automatic captioning,
retroactively promotable); its only promotion path is scoped to backfetched events, so it
never touches these files. To keep the budget race-free, **every yotsuba file is created
`deferred` unless the ordinary rule captions it immediately** (`caption_all` or the
assistant-message rule), and the upgrade flips exactly the processed files to `pending`.
Nothing can be captioned before the budget is decided. (Under `caption_all`, a headline file
is captioned by that rule regardless of the trigger budget: the budget governs what a
trigger adds.)

**Image blocks.** The existing conservative cascade (§9 "Image block handling") uses one
priority tier only, and never considers `reply_preview_media`, so it would drop exactly the
cases this feature is for (a reply to a link; a link next to an attachment). Processed
yotsuba files therefore get **their own lane**: the context builder adds the processed asset
ids recorded by *this* trigger group's upgrade (§6.7) as image blocks after the cascade's
own selection, and marks them `image_block="true"` in place. At most 4 per session; the
cascade itself is unchanged.

**Per kind.** Images: the original. Videos and animated GIFs: the original (`video` asset)
plus a **storyboard** (`src/media/storyboard.ts`: ffmpeg samples 4 frames at 12/37/62/87% of
the duration into one 2×2 JPEG, an `image` asset). The storyboard is the image block; the
caption comes from the original through the video caption lane (motion and audio), so each
file is captioned once and the storyboard is never captioned itself. On ffmpeg or download
failure, 4chan's thumbnail replaces the storyboard. PDFs: 4chan's page-1 thumbnail (block and
caption source) and the original; text extraction is a tool feature (§7.4). Other types:
listed only. A file is one unit of the budget whatever its kind. A file deleted from 4chan
between the capture and the upgrade renders as `status="gone"`.

`media_boards = "worksafe"` (default `"all"`) stops all yotsuba downloads on non-worksafe
boards: files there are listed, never downloaded.

### 6.6 Exact renderings

Illustrative data, real layout. Times use `compactAgentTimestamp` (agent timezone). Absent
attributes are omitted; `Anonymous` without a trip is not printed; text is escaped as usual.

**A. Ambient, thread link.** Someone posts a link; nobody asks the agent anything.

```xml
<link_preview url="https://boards.4chan.org/g/thread/109930292" kind="4chan">
<thread board="/g/ - Technology" no="109930292" subject="/lmg/ - Local Models General" posts="435" files="88" posters="121" status="bump limit" as_of="2026-09-29 02:10">
<post no="109930292" role="op" time="2026-09-28 10:31" replies="3">
/lmg/ - a general dedicated to the discussion and development of local language models.

Previous threads: &gt;&gt;&gt;/g/109925219 (other thread) &amp; &gt;&gt;&gt;/g/109921422 (other thread)

►News
&gt;(09/26) koboldcpp-1.122 + bundled harness
[… 1,690 more characters]
<file name="lmg.png" type="image/png" dims="1024x1024" size="1.1 MB" path="msg-attach/k2m9x0q1zab3d.png"/>
</post>
[4chan: opening post only. The yotsuba tool reads the thread.]
</thread>
</link_preview>
```

About 170 tokens. The image is stored; with `caption_all` on it would also carry a caption.

**B. Ambient, post link**, in an untitled thread:

```xml
<link_preview url="https://boards.4chan.org/g/thread/109933629#p109934102" kind="4chan">
<thread board="/g/ - Technology" no="109933629" op_excerpt="why does every linux distro installer still" posts="54" files="7" as_of="2026-09-29 02:10">
<post no="109934102" role="linked" time="2026-09-29 01:40" replies="5">
&gt;&gt;109934055 (not shown)
because the people who write installers are not the people who use installers
<file name="calamares.png" type="image/png" dims="800x600" size="96 KB" path="msg-attach/c7v2n9m1qx4ke.png"/>
</post>
[4chan: the linked post only. The yotsuba tool reads the thread and the conversation around this post.]
</thread>
</link_preview>
```

**C. Trigger, thread link.** Alice posts the link together with "@miku is this general worth
reading?". The capture (taken when the message was enriched) holds the OP, the last three
replies (109935841, 109935870, 109935902) and the two posts they answer (109935650,
109934410). Everything fits in 900 tokens:

```xml
<link_preview url="https://boards.4chan.org/g/thread/109930292" kind="4chan">
<thread board="/g/ - Technology" no="109930292" subject="/lmg/ - Local Models General" posts="435" files="88" posters="121" status="bump limit" as_of="2026-09-29 02:10">
<post no="109930292" role="op" time="2026-09-28 10:31" replies="3">
/lmg/ - a general dedicated to the discussion and development of local language models.

Previous threads: &gt;&gt;&gt;/g/109925219 (other thread) &amp; &gt;&gt;&gt;/g/109921422 (other thread)

►News
&gt;(09/26) koboldcpp-1.122 + bundled harness
&gt;(09/26) exllamav3 v1.5.2 with Turing support
&gt;(09/25) MiMo-V2.6-RL training dataset released
[… 1,190 more characters]
<file name="lmg.png" type="image/png" dims="1024x1024" size="1.1 MB" path="msg-attach/k2m9x0q1zab3d.png" image_block="true">
[caption: An anime girl with teal twintails sitting at a desk with three GPUs and a llama plush.]
</file>
</post>
<omitted posts="410" files="80"/>
<post no="109934410" role="replied_to" time="2026-09-29 01:22" replies="1">
what's the actual context limit before it starts repeating itself
</post>
<omitted posts="15" files="3"/>
<post no="109935650" role="replied_to" time="2026-09-29 02:01" replies="2">
is there any point running 70b dense anymore or is it all moe now
</post>
<omitted posts="4" files="1"/>
<post no="109935841" role="latest" time="2026-09-29 02:06" replies="1">
&gt;&gt;109935650
dense still wins on long context coherence desu
<file name="needle.png" type="image/png" dims="1400x900" size="140 KB" path="msg-attach/p0x8c1v7ma2ke.png" image_block="true">
[caption: A line chart of needle-in-a-haystack accuracy against context length for four models.]
</file>
</post>
<post no="109935870" role="latest" time="2026-09-29 02:07">
&gt;&gt;109935841
source: my ass
</post>
<post no="109935902" role="latest" time="2026-09-29 02:09">
&gt;&gt;109935650
&gt;&gt;109934410
moe for chat, dense if you need it to remember what happened 20k tokens ago
<file name="1790650140221.webm" type="video/webm" dims="720x720" duration="0:14" audio="yes" size="2.9 MB" path="msg-attach/w4n7s2k9dq0le.webm" storyboard_path="msg-attach/b8r1c5m3xz7aa.jpg" image_block="true">
[caption: A cat knocks a glass off a table in slow motion while dramatic choir music plays.]
</file>
</post>
[4chan thread snapshot as of 2026-09-29 02:10: the opening post, the last 3 replies and the 2 posts they answer (6 of 435). Read more with the yotsuba tool.]
</thread>
</link_preview>
```

About 850 tokens including the three captions, plus three image blocks in this session only.
In later contexts the same element renders without the `image_block` attributes.

**D. Trigger, the same link in a crowded group.** The message also carried four other thread
links in front of this one: the file budget went to their four OPs, and the group text
budget left this ref room for its OP and the two newest replies only.

```xml
<post no="109930292" role="op" time="2026-09-28 10:31" replies="3">
…the OP, up to 800 characters…
<file name="lmg.png" type="image/png" dims="1024x1024" size="1.1 MB" path="msg-attach/k2m9x0q1zab3d.png" auto="off"/>
</post>
<omitted posts="432" files="86"/>
<post no="109935870" role="latest" time="2026-09-29 02:07">
&gt;&gt;109935841 (not shown)
source: my ass
</post>
<post no="109935902" role="latest" time="2026-09-29 02:09">
&gt;&gt;109935650 (not shown)
&gt;&gt;109934410 (not shown)
moe for chat, dense if you need it to remember what happened 20k tokens ago
<file name="1790650140221.webm" type="video/webm" dims="720x720" duration="0:14" audio="yes" size="2.9 MB" path="msg-attach/w4n7s2k9dq0le.webm" storyboard_path="msg-attach/b8r1c5m3xz7aa.jpg" auto="off"/>
</post>
[4chan thread snapshot as of 2026-09-29 02:10: the opening post and the last 2 replies (3 of 435); 1 more latest reply and 2 replied-to posts left out for length. Files marked auto="off" were saved but not captioned or shown (image budget); open them by path with read_image or media. Read more with the yotsuba tool.]
```

**E. Trigger, post link, in a reply context.** Bob replies to a message containing
`https://boards.4chan.org/g/thread/109930292#p109931450` with "@miku explain the joke". The
reply context reuses the replied-to message's capture (no fetch); the upgrade renders it inside
the trigger's `<reply_to>`, and the original message further up in history renders the same
upgraded element from now on.

```xml
<reply_to sender="…" time="…" external_id="…">
lmao look at this
<link_preview url="https://boards.4chan.org/g/thread/109930292#p109931450" kind="4chan">
<thread board="/g/ - Technology" no="109930292" subject="/lmg/ - Local Models General" posts="435" files="88" posters="121" status="bump limit" as_of="2026-09-28 12:20" linked="109931450">
<omitted posts="101" files="20"/>
<post no="109931388" role="replied_to" time="2026-09-28 11:59" replies="4">
benchmarks mean nothing, show me it holding a coherent story past 8k
</post>
<omitted posts="2"/>
<post no="109931402" role="replied_to" time="2026-09-28 12:00" id="Ab12Cd34" flag="Finland" replies="6">
&gt;&gt;109931377 (not shown)
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
<file name="preset.png" type="image/png" dims="640x480" size="52 KB" path="msg-attach/z9q2w8e7r6t5y.png" image_block="true">
[caption: A settings panel with the repetition penalty slider set to 1.0.]
</file>
</post>
<omitted posts="314" files="64"/>
[4chan post snapshot as of 2026-09-28 12:20: the linked post, the 2 posts it answers and its first 3 replies (6 of 435). Read more with the yotsuba tool: the other 23 replies, or the conversation around any post.]
</thread>
</link_preview>
</reply_to>
```

About 700 tokens. Files: the linked post's (tier 1), then the posts it answers (no files),
then its replies newest first: 109931502's is the second processed file, leaving two for the
rest of the group.

**F. Compact zone** (older history, generation sessions), built from the headline post:

```
 [4chan /g/ "/lmg/ - Local Models General" (435 posts): /lmg/ - a general dedicated to the discussion and development of local…]
 [4chan /g/ "why does every linux distro installer still…" (54 posts), post >>109934102: because the people who write installers are not the people who…]
 [4chan /g/ board: 3 threads]
 [4chan /g/ thread 109800000: already gone when linked]
```

**G. Gone** (404 at enrichment):

```xml
<link_preview url="https://boards.4chan.org/g/thread/109800000" kind="4chan" status="gone" checked="2026-09-29 02:10"/>
```

**H. Board link** (one rendering, trigger or not; stickies skipped):

```xml
<link_preview url="https://boards.4chan.org/g/" kind="4chan">
<board code="/g/" title="Technology" worksafe="true" as_of="2026-09-29 02:10">
<thread no="109934266" replies="97" files="13" started="2026-09-28 22:40">/lmg/ - Local Models General</thread>
<thread no="109934884" replies="0" started="2026-09-29 02:08" op_excerpt="true">is it worth upgrading from a 3080 to</thread>
<thread no="109933660" replies="3" files="2" started="2026-09-28 20:15">Autumn Dive/g/rass</thread>
[4chan board: the top 3 threads on page 1. The yotsuba tool can search the catalog.]
</board>
</link_preview>
```

About 120 tokens.

### 6.7 Persistence

No new tables, no migration. One `link_previews` row per ref (the X precedent):

- `source_kind = "yotsuba"`, `site_name = "4chan"`, canonical `url`.
- `title`: `"/{b}/ - {subject or OP excerpt}"`; board refs `"/{b}/ - {board title}"`.
- `description`: the ambient rendering's flat text (subject + headline excerpt). This is what
  chat search indexes; the upgrade does not change it.
- `payload_json`:

```ts
interface YotsubaPreviewPayload {
  v: 1;
  kind: "thread" | "board";
  board: string; boardTitle?: string; worksafe?: boolean;
  asOf: number;                        // epoch ms of the one fetch
  // thread kind: the capture (§6.2)
  threadNo?: number; subject?: string; opExcerpt?: string;
  postCount?: number; fileCount?: number; posters?: number;
  status?: string[];                   // "sticky" | "closed" | "archived" | "bump limit" | "image limit"
  linkedNo?: number; linkedMissing?: number;
  headlineNo?: number;                 // OP (thread link) or linked post (post link)
  posts?: YotsubaPostNode[];           // headline + candidates, thread order, full text
  upgrade?: {                          // present once a trigger upgraded this row (§6.4)
    triggerGroupId: string;            // the upgrading group: only its session gets image blocks
    includedNos: number[];
    processedAssetIds: string[];
    left?: { latest?: number; repliedTo?: number; replies?: number };  // dropped for budget
    headlineChars?: number;            // the trigger_headline_chars in force
  };
  // board kind
  threads?: { no: number; subject?: string; opExcerpt?: string; replies: number; files: number; time: number }[];
}
interface YotsubaPostNode {
  no: number; index: number;           // position in thread (gap counts)
  role: "op" | "linked" | "latest" | "replied_to" | "reply";
  name?: string; trip?: string; posterId?: string; capcode?: string; flag?: string;
  time: number;
  text: string;                        // full comment text
  quotes: number[]; deadQuotes?: number[]; crossQuotes?: string[];
  replies: number; replyNos?: number[];
  file?: {
    name: string; ext: string; w?: number; h?: number; bytes?: number; durationSec?: number;
    spoiler?: boolean; deleted?: boolean; tim: number;
    assetId?: string; storyboardAssetId?: string;   // absent: not downloaded
  };
}
```

Both renderings are pure functions of this payload (plus the session's trigger group id for
the `image_block` marks), so every context build renders the same event byte-identically.
The only change to an event's rendering happens once, at the upgrade, on an event that is at
the recent end of the timeline (it was just part of a trigger), so the prompt-cache cost is
the same as a caption arriving late.

The upgrade writes through the single-writer queue in one transaction per trigger group:
the `upgrade` sections, the new `media_assets` rows, and the `deferred → pending` flips.

**Failures** (logged `enrichment_yotsuba_failed`; the event-level retry is not triggered, the
X/YouTube policy): a 404 stores `fetch_status: "failed"` with error `"gone"` and renders as
§6.6 G; any other failure renders as the bare URL. An upgrade failure (a file download
error) leaves that file unprocessed and is logged `yotsuba_upgrade_file_failed`; the rest of
the upgrade proceeds.

### 6.8 Enrichment partition

Inside `fetchLinkPreviews`, after the X and YouTube partitions and before the generic stage,
recognized refs are stripped from `filteredBody` (Synapse / direct scrape never produces the
bare og-card for them), and their raw matches join the linked-media exclusions. Message and
reply bodies are treated identically, and refs share `enrichment.max_previews_per_message`
in order of first appearance.

**Every event gets the capture** (the X precedent, not YouTube's trigger-group gate): one
cached, paced, CDN-served GET and at most one file per link, at `background` priority. The
capture is also the only record left once the thread is pruned.

**Discord ingest embeds.** Discord's unfurl of a 4chan URL is a bare og-card stored at ingest
as a `discord_embed` row. The yotsuba stage still runs for that URL (the X precedent), and
the renderer suppresses a `discord_embed` row when the same event has a `yotsuba` row for
the same `(board, threadNo)`. (Scoped to yotsuba rows; X behavior is unchanged.)

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
- `media_boards` (§6.5) is the knob for NSFW-board files in previews. The tool shows what
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

[yotsuba.preview]                        # §6
ambient_chars = 300                      # ambient rendering: headline post excerpt
untitled_words = 8                       # subject stand-in for untitled threads (first words of the OP)
latest_replies = 3                       # capture, thread links
replied_to_max = 3                       # capture: posts the latest replies / the linked post answer
replies_max = 3                          # capture, post links: first replies to the linked post
board_threads = 3                        # board links: top non-sticky threads on page 1
trigger_headline_chars = 800             # trigger rendering: headline post cap
trigger_link_tokens = 900                # per ref, all-inclusive (frame, text, caption allowance)
trigger_group_tokens = 1800              # all trigger-related refs of one trigger group
trigger_group_files = 4                  # processed (captioned + image-block) files per trigger group

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
3. **T1**: enrichment partition and ambient stage, storyboard helper, payload; trigger
   upgrade in `awaitTriggerReadiness`; the image-block lane in the context builder;
   renderer (ambient, trigger, compact, discord-embed suppression); ARCHITECTURE §7f, the §4
   feature-gate text, and the §9 image-block note.
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
- Worker: partition strips refs from the generic stage; captures for thread / post / board
  / missing-post / gone / other-failure; only the headline file downloaded, created
  `deferred` unless the ordinary caption rule applies; reply contexts copy the replied-to
  event's capture with no fetch (and fetch when there is none); `media_boards`; feature off
  leaves URLs on the generic path.
- Trigger upgrade: makes no API calls (assert on the stubbed client); grouped events
  enriched before the trigger; reply-context refs; drop order for thread and post links (no
  post twice; a latest reply that is also a replied-to post counted once); the headline cap;
  per-ref (900) and group (1800) budgets including frame and caption allowances, with ambient
  fallback; the selection loop's convergence; the group file allocation (five links: the
  fifth OP stays `deferred`); exactly the processed files flipped to `pending`; idempotence;
  a later trigger reusing an upgrade; timeout leaves the ref ambient.
- Context builder: the yotsuba image-block lane adds exactly the recorded in-budget assets,
  alongside an unchanged cascade; nothing added for non-vision models.
- Renderer: golden outputs for §6.6 A-H; an upgraded row renders the trigger rendering in
  every later context, with `image_block` only in the upgrading group's session; escaping;
  per-post file placement and `auto="off"`; `discord_embed` suppression.
- Tool: every action and view against fixtures; footers contain valid, literal next calls
  (parse them back and execute them in the test); naive-call tolerance; every §7.5 error;
  vision vs non-vision file handling; storyboard and PDF paths.
- Fixtures: trimmed real API responses captured once (a general with dense quoting, an
  archived thread, a post with ID and flag, a catalog, boards.json, a webm post, a /po/ PDF
  post).
