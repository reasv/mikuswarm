---
name: character-card
description: Create, read, and edit Character Card V2 PNGs via the `character_card_create` / `character_card_read` / `character_card_edit` tools — including turning a posted image's character or vibe into a card on request. Use bounded reads and file-based long-field rewrites; do not hand-roll PNG metadata.
tools:
  - character_card_create
  - character_card_read
  - character_card_edit
---

# Character Card Workflow

**Purpose:** Create character card PNGs (the widely-supported Character Card V2 standard) from structured definitions plus an image, inspect existing cards without flooding context, and patch them in place.

> These tools exist only when the character-card feature is enabled. If `character_card_create` is not in your tool list, this skill does not apply.

Treat the PNG as the final artifact, not the working surface. Do not dump entire cards into model context. Use bounded reads and file exports.

## Quick Reference

Create a new card:

```json
{
  "imagePath": "reference/hero.png",
  "outputPath": "cards/character/hero.png",
  "draftOutputPath": "drafts/hero.json",
  "card": {
    "name": "Hero Example",
    "description": "Core character description.",
    "personality": "Kind, direct, and stubborn.",
    "scenario": "Travels with {{user}}.",
    "first_mes": "We should get moving.",
    "alternate_greetings": ["Ready?", "You're late."],
    "tags": ["hero", "fantasy"]
  }
}
```

Read only the bounded summary:

```json
{
  "path": "cards/character/hero.png",
  "view": "summary"
}
```

Read one field in bounded pages:

```json
{
  "path": "cards/character/hero.png",
  "view": "field_excerpt",
  "field": "description",
  "offset": 0,
  "maxChars": 2000
}
```

Export the full field to a workspace file instead of context:

```json
{
  "path": "cards/character/hero.png",
  "view": "export_text",
  "field": "description",
  "outputPath": "exports/character/hero-description.txt"
}
```

Edit from a workspace file:

```json
{
  "path": "cards/character/hero.png",
  "overwrite": true,
  "operations": [
    {
      "op": "set_field_from_file",
      "field": "description",
      "sourcePath": "exports/character/hero-description.txt"
    }
  ]
}
```

## How the Tools Work

Create (`character_card_create`):

- Takes exactly one of `imagePath` or `imageUrl`.
- `card` is a structured Character Card V2-style object.
- The tool normalizes the definitions, converts the image to PNG, embeds the card JSON in the PNG metadata, and writes the result into the workspace.
- `draftOutputPath` optionally writes a normalized JSON sidecar for iterative workflows.

Read (`character_card_read`):

- `view: "summary"` returns structure and per-field char/line counts only, never the large bodies.
- Excerpt views return exactly one bounded text target at a time:
  - `field_excerpt`
  - `alternate_greeting_excerpt`
  - `book_entry_excerpt`
- `book_index` pages through lorebook entry summaries without returning full entry content.
- `export_text` writes one selected full text target to a workspace file.
- `export_card_json` writes the normalized full card JSON to a workspace file.
- Excerpt responses include `nextOffset` when the result was truncated so you can page with `offset`.

Edit (`character_card_edit`):

- Applies patch operations instead of requiring a full-card rewrite.
- Supported operations:
  - `set_field`
  - `append_field`
  - `set_field_from_file`
  - `replace_range`
  - `set_tags`
  - `add_alt_greeting`
  - `update_alt_greeting`
  - `remove_alt_greeting`
  - `add_book_entry`
  - `update_book_entry`
  - `remove_book_entry`
  - `replace_image`
- For long rewrites, prefer the `*_from_file` forms or lorebook entry `*SourcePath` fields so the model works through files instead of context.

## Sourcing the Card Image

Every card needs cover art (`imagePath`/`imageUrl` on create, or `replace_image` on edit). How you get one depends on which image tools your deployment has:

- **`image_generate` (nano banana)** — generate a bespoke cover from a prompt. The most flexible and reliable option when available: describe the exact character, pose, and vibe and get art made to order, great when nothing existing matches. **SFW only**, though — its safety classifier refuses NSFW, so for an explicit character render a tasteful, suggestive-at-most cover instead (a clothed portrait, an evocative pose, mood over nudity). See the `image-gen` skill for prompt craft.
- **`danbooru`** — search existing anime art when the character is a known series character, or when a real illustration fits better than a generated one. Download the asset, then pass its workspace path as `imagePath`. Read the `danbooru` skill for the search → preview → download flow. (Available only when the Danbooru feature is enabled.)
- **`x_search`** — another way to *find* existing art, this time on X. Art surfaced here can be SFW or NSFW, so it's an option when generation won't do. Download the media, then use that path. (Available only when X search is configured.)
- **A provided image** — if the user posted or linked an image to base the card on, use that file directly.

Whichever you use, lean on its own skill — the `image-gen` skill for generation/prompt craft, the `danbooru` skill for the search-and-download flow — rather than working from memory.

Default to `image_generate` for original or made-up characters where you want full control; reach for `danbooru` or `x_search` when a specific *existing* image is the point. If a user's image request can't be honored SFW with nano banana, an existing image from `danbooru`/`x_search` may fit — otherwise say so plainly rather than fighting the classifier.

## Context Safety Rules

- The read tool is intentionally conservative.
- A summary call returns char counts and line counts, not the text.
- Excerpt calls are capped and always say whether the result was truncated.
- Truncated responses include the next character offset to continue scrolling.
- If you need the entire field, export it to a workspace file and work from that file.
- Do not repeatedly request large fields inline when a file export would be cleaner.

## Recommended Workflow

Do the work directly in this session — each user-triggered response is already its own session.

For new cards:

1. Think through the character definition.
2. Call `character_card_create`. Set `draftOutputPath` if you expect multiple rounds of editing.
3. Call `summary` to confirm structure.
4. Excerpt or export any field that needs refinement.
5. Patch with `character_card_edit`.

For unknown or existing cards:

1. Call `summary`.
2. If a lorebook is present, call `book_index`.
3. Excerpt only the fields you actually need.
4. Export large fields to files instead of repeatedly paging them inline.

For long rewrites:

1. Call `export_text` for the field.
2. Modify the exported file with `str_replace_based_edit_tool`.
3. Apply with `set_field_from_file` or the relevant lorebook `*SourcePath` field.
4. Re-read summary and a short excerpt to confirm the change landed.

## Inspect vs. Export — Rule of Thumb

- **Inspect inline** when you only need a quick look at a field, you are checking tone or wording, and 1–3 excerpt calls would be enough.
- **Export to file** when the field is long, you need the full content for reasoning, you plan substantial rewrites, or you need to compare/rework lorebook content in detail.

In one sentence: **inspect inline, rewrite from files**.

## After Edits

- Call `summary` again.
- Confirm char and line counts look sane.
- Confirm alternate-greeting and lorebook-entry counts still match expectations.
- Inspect any field you changed with one excerpt call.

## Practical Advice

- Prefer structured creation over hand-editing raw JSON or PNG metadata.
- Use `draftOutputPath` when you expect multiple rounds of editing.
- Read summaries first. Do not ask for a long field inline unless you truly need a slice of it.
- If a field looks large, export it to a file immediately and edit the file instead of scrolling forever.
- PNG cards preserve their existing image unless you explicitly use `replace_image`.

## Recognizing cards in chat

Card PNGs posted in chat are tagged in the message XML: `is_character_card="true"` with a `card_name="..."` attribute on the attachment. When you see one, the file's workspace `path` can be handed straight to `character_card_read`.
