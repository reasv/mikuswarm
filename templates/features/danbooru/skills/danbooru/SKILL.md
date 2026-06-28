---
name: danbooru
description: Structured search, inline preview, and workspace download against danbooru.donmai.us via the `danbooru` tool. Use when picking, previewing, or saving anime images.
---

# Danbooru Workflow

**Purpose:** Search Danbooru with structured fields, review result metadata and URLs, preview a chosen post (shown or described depending on your model's vision), then optionally download it into the workspace.

> This tool exists only when the Danbooru feature is enabled. If `danbooru` is not in your tool list, this skill does not apply.

## Quick Reference

Search (1 regular tag + `order` = 2 against the budget; ratings are free):

```json
{
  "includeTags": ["hanekawa_tsubasa"],
  "excludeRatings": ["explicit"],
  "order": "score",
  "limit": 5
}
```

Preview a chosen result (image block if your model has vision, else a text description):

```json
{
  "action": "preview",
  "postId": 123456
}
```

Download a chosen result:

```json
{
  "action": "download",
  "postId": 123456,
  "downloadVariant": "original"
}
```

Download to a specific workspace subdirectory:

```json
{
  "action": "download",
  "postId": 123456,
  "outputSubdir": "cards/reference"
}
```

Resolve a tag spelling without searching (secondary — usually unnecessary, see [When You Don't Know the Exact Tag](#when-you-dont-know-the-exact-tag)):

```json
{
  "action": "tags",
  "query": "mordred pendragon"
}
```

## When You Don't Know the Exact Tag

Danbooru tags are exact, underscored strings and often unintuitive — e.g. the character is `mordred_(fate)`, **not** `mordred_pendragon_(fate)`. Don't try to look the tag up first. **Just search with your best guess.** If you guessed wrong and the search returns zero posts, the tool automatically appends a "Did you mean?" list of real, similar tags (with category and post count) — pick the right one from there and search again. This costs no extra tool call: the search you were going to run anyway tells you the correct tag when it comes up empty.

If a search returns zero posts but every tag you gave is actually real, the tool says so — that means it's a *combination* problem (those tags just don't co-occur), so drop a tag, loosen filters, or change `order` rather than hunting for a different spelling.

**`action: "tags"` is a secondary, optional lookup** — reach for it only when search-and-read-the-suggestions isn't enough, e.g. you want to browse the candidate tags for a name without committing to a search, disambiguate between several similar tags, or a search returned the *wrong* kind of results and you suspect your tag silently matched something unintended. Most of the time you won't need it.

```json
{ "action": "tags", "query": "saber alter" }
```

It returns candidates ranked by popularity with their category (character / copyright / artist / general / meta) and post count, and does not count against the search tag budget.

## How the Tool Works

- `includeTags`: positive Danbooru tags. One tag per array item. Do not prefix with `-`.
- `excludeTags`: tags to negate; pass plain tags and the tool prepends `-`.
- `includeRatings`: become one positive Danbooru `rating:*` term like `rating:q,s`.
- `excludeRatings`: become negative Danbooru rating terms like `-rating:e`.
- `order`: becomes `order:*`. **Counts as one tag against the search budget** (see Tag Search Limits).
- `extraTerms`: advanced Danbooru metatags appended as-is, for cases like `score:>100`, `age:<1year`, or `filetype:png`. Must contain a `:` — metatags only, not plain tags.
- `page`: numeric page or before/after cursor like `b123456` / `a123456`.
- `limit`: number of results to fetch (1–200, default 20).

The tool prints the exact final query it sent to Danbooru. Search results include both the post page URL and the direct preview/sample/original asset URLs.

## Tag Search Limits

**You get exactly 2 search terms. This is permanent — treat it as a law of physics, not a setting to work around.** Danbooru caps anonymous and basic accounts at 2 tags per search; the higher-tier ("Gold") accounts that lifted this have not been purchasable for years, so there is no plan, upgrade, or credential that raises it. Stop and design every search around 2 terms from the start. **`order:*` counts as one of those terms.** Read this carefully; it is the #1 cause of a search failing:

Do **not** try to escape the limit. In particular:
- Don't add a 3rd, 4th tag "just in case" — the call is rejected before it even reaches Danbooru.
- Don't move a plain tag into `extraTerms` to dodge the count. `extraTerms` is **metatags only** (`score:>100`, `filetype:png`) AND still counts against the 2 — it is not a side door for extra tags.
- Don't ask for or assume a higher account tier. There isn't one available.

- The budget counts **`includeTags` + `excludeTags` + `extraTerms` + `order`** (an `order` value costs **1**, because Danbooru counts the `order:*` metatag as a tag).
- `includeRatings` / `excludeRatings` are **free** — they do NOT count.
- The budget is **2**. So with an `order` set you have room for only **1** regular include/exclude/extra tag; without an `order` you have room for **2**.
  - ✅ `includeTags: ["a"]` + `order: "score"` → 2, OK.
  - ✅ `includeTags: ["a", "b"]` (no order) → 2, OK.
  - ❌ `includeTags: ["a", "b"]` + `order: "score"` → 3, rejected.
  - ✅ `includeTags: ["a"]` + `excludeRatings: ["explicit"]` + `order: "score"` → 2 (rating free), OK.
- If you exceed the budget the tool rejects the call locally with a clear message **before** hitting Danbooru — drop a tag or drop the `order` and retry.
- It is a TOTAL limit — you cannot have, say, 2 include and 2 exclude tags simultaneously.
- `extraTerms` are metatags only (must contain `:`), not plain tags, and each one counts against the budget.
- Use `includeRatings` / `excludeRatings` instead of writing `rating:*` terms yourself.
- Use `excludeTags` instead of prefixing tags with `-`.

**Want to sort but out of room?** You can't have it all — choose. Omit `order` to spend both slots on tags, or spend one slot on `order` and one on a single tag. Two character tags plus a sort is impossible and always will be; pick the two things that matter most and let go of the third.

## Ordering

Common useful `order` values:

- `score`, `favcount`, `rank`, `change`, `comment`
- `mpixels`, `filesize`
- `landscape`, `portrait`
- `random`, `none`

Pass just the value, e.g. `order: "score"`.

## Pagination

- `page: "2"` for the second page.
- Danbooru before/after cursors: `page: "b123456"` or `page: "a123456"`.
- Increase `limit` when you want a wider preview pass on a single page.

## Search Strategy: Spend Your 2 Slots on the Most Selective Tags

With only 2 slots, the winning move is to **pick the 1–2 most *selective* tags and filter the rest by looking at the results** — not to cram more tags in. A tag is selective when few posts have it; broad descriptive tags are weak filters and waste a precious slot.

- **Selective (worth a slot):** character tags (`mordred_(fate)`), copyright/series (`fate/grand_order`), artist tags, a specific named outfit.
- **Broad (almost never worth a slot):** action/pose/scene words like `fight`, `sword`, `running`, `1girl`, `solo`, `looking_at_viewer`. There are millions of these; they barely narrow anything.

So for "Mordred and Artoria fighting with swords": the two characters ARE your whole budget. Search `["mordred_(fate)", "artoria_pendragon_(fate)"]` (2 tags, no room for `fight`/`sword`/`order`), then **scan the returned images** for the ones that actually show a sword fight. Don't try to encode "fight" and "sword" as tags — you don't have the slots, and you can just see it in the results.

How to narrow when 2 tags isn't enough:
1. Lead with your most selective tag(s). Ratings are free — add `includeRatings`/`excludeRatings` freely, they don't cost a slot.
2. **Eyeball the results** (raise `limit`, use `preview`) and pick what fits — this is how you apply all the criteria that didn't fit in 2 tags.
3. If you still need to cut the set down server-side, spend a slot on ONE lever: a second selective tag, an `excludeTags` term, an `order` sort, or a metatag `extraTerm` (`score:>100`, `filetype:png`). You can use one of these, not several.
4. Paginate with `page` to browse further within the same query.

When two characters must both appear, that's your entire budget spent — there is no slot left for descriptive tags or a sort, and that's expected. Search the two characters, then choose from the results.

## Identifying Who/What Is in a Post

Don't guess at character identity from the picture (or, on a vision-less model, from a caption) — **read the tags.** Danbooru's tags are the authoritative, human-curated labels for a post:

- **Search results** list each post's `characters:` and `series:` lines, so you can confirm at a glance which results actually contain the characters you searched for.
- **`action: "preview"`** returns the full tag set, character/series tags first, alongside the image/description. The character tags tell you *who* with certainty; the **general tags** usually describe *what they're doing* and the setting too — pose, action, clothing, mood, composition. Read the whole list.

Danbooru is densely tagged, so beyond characters you can also lean on general tags for the action/pose/composition you want — both to read off a candidate and, when you can spare a slot, to **narrow the search itself** (`fighting`, `holding_sword`, `from_behind`, `close-up` filter far more reliably than eyeballing). So you usually do **not** need the separate `media` tool to ask "who is this" or even "what's happening" — the tags usually say. Reach for `media` only when the tags are ambiguous or silent on what you need (see next section).

## Verify a Candidate Actually Depicts What You Want

Tags are thorough, but they list the *elements* of a post without always pinning down how those elements **relate or are arranged**. A post tagged with two characters AND `fighting` AND `sword` might show them fighting *each other* — or both fighting a third party, or one simply watching the other; the tags name the ingredients, not the exact scene. Tagging can also be incomplete or lag the image. So when the **precise depiction matters and the tags leave it ambiguous**, don't assume from tags alone — look before you commit (send it, attach it as cover art, download it as "the one").

Two ways to verify, depending on the question:

- **Just need to eyeball "is this the right image?"** → `action: "preview"` the candidate. You see it (vision) or get a description of it (no vision), plus its tags.
- **Have a specific yes/no or detail question the tags can't settle** → call the **`media`** tool on the post's `sample` (or `original`) URL with that exact question — e.g. *"Are Mordred and Artoria fighting each other with swords here, or just standing together?"*, *"Which of the two is in the foreground?"*. A targeted question is often more useful than a generic preview, because it forces a direct answer about the relationship the tags don't confirm.

Don't over-verify: when the tags already pin down what you need, trust them. If a candidate doesn't fit, go back to the results and try another — or refine the search.

## Preview vs. Download

`action: "preview"` lets you inspect a chosen post before committing. It **adapts to whether your model can see images** — you don't need to know which mode is active, just call it and read the result:

- If your model has vision, it returns the image **inline as a vision block**.
- If it does not, it returns a **text description** of the image (produced by the captioning model) plus the asset URLs. To ask something specific about the image, call the `media` tool with the `sample` or `original` URL and your question.

Either mode also returns the post's **Danbooru tags, character/series first** — the authoritative labels for who/what is in the image (see [Identifying Who/What Is in a Post](#identifying-whowhat-is-in-a-post)).

Either way, trust the result you get — if it's a text description, that is what you can actually perceive of the image; do not narrate as if you saw pixels you didn't. `previewVariant` selects which asset is used (`preview` thumbnail, `sample`, or `original`); the default is small for vision and `sample` for description.

- `action: "download"` saves the file into the workspace (default `downloads/danbooru/`). Use this when you want to send the file by path, attach it as cover art, or keep it for later reuse. `downloadVariant` defaults to `original`.
- Override the destination with `outputSubdir` (workspace-relative) or set an explicit `filename`.

## Sending Results

- First confirm the image actually depicts what you wanted (see [Verify a Candidate Actually Depicts What You Want](#verify-a-candidate-actually-depicts-what-you-want)) — don't send a result picked on tags alone.
- If the asset URL is trusted and you do not need a local copy, send it directly with the message tool's `media` field.
- If you want local inspection or reuse, `download` first and send the saved workspace path.
- If you need to perceive the image yourself, use `preview` (it shows or describes the image depending on your model's vision) or the `media` tool on an asset URL — do not assume the normal chat path already has the file in multimodal scope.

## Rating Quick Reference

- `general`: safe for work
- `sensitive`: mild suggestive content
- `questionable`: suggestive or borderline NSFW
- `explicit`: overt NSFW / sexual content
