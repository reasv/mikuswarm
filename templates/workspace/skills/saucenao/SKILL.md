---
name: saucenao
description: Reverse-image search via the `find_source` tool — find the source/artist of an image someone posted ("source?", "sauce?", "who drew this?", "where's this from?").
---

# SauceNAO Source Lookup

**Purpose:** Find the **source / origin** of an image — the Pixiv/booru/X/anime-screencap/DeviantArt page it came from, plus the artist — by reverse-image-searching it through SauceNAO with the `find_source` tool.

When someone wants credit/provenance for a picture, this is the tool: it goes *image → source URL + artist*.

> This tool exists only when the SauceNAO source-lookup feature is configured (it needs an API key). If `find_source` is not in your tool list, this skill does not apply.

## When to Use

- A user posts an image and asks **"source?" / "sauce?" / "who drew this?" / "where's this from?"** → look it up.
- You're about to repost or reference an image and want to **credit the artist** → find the source first.

## Naming the Image

`find_source` takes one input, `image`:

- **A chat attachment** → copy the `path="…"` straight out of the `<attachment …>` you see in context, e.g.

  ```json
  { "image": "./attachments/2026-06-14/abcd.jpg" }
  ```

- **An image URL** → pass it directly; SauceNAO fetches it server-side.

  ```json
  { "image": "https://example.com/pic.png" }
  ```

A path is uploaded (conditioned down first); a URL is passed through. Either way SauceNAO does the perceptual-hash match.

Optional params: `limit` (max results, default 8), `min_similarity` (% floor, default 55), `view` (vision models only — see below).

## Reading Similarity — the Core Skill

Each candidate **leads with a perceptual-similarity percentage**. *That score — not the picture's vibe — is the identity signal.* Read it like this:

- **≥ ~80%** → almost certainly the **same image**. Trust it as the source.
- **~55–80%** → plausible but **verify** before asserting (could be a different version, a crop, or a similar-but-different piece).
- **< 55%** → weak / likely wrong. These are filtered out by default; if you lowered `min_similarity` to see them, treat them as leads, not answers.

A generic resemblance ("anime girl, blue hair") means nothing here — two unrelated drawings share that. The number is what tells you it's the same picture.

## Verify Before You Report

Look before you commit — but the verification signal differs by your model:

- **If you have vision:** pass `view: true`. The tool inlines the top matched thumbnails so you can **see them and confirm** they're the same image as the query (which you can also see). Eyeball it before claiming the source.

  ```json
  { "image": "./attachments/2026-06-14/abcd.jpg", "view": true }
  ```

- **If you don't have vision:** `view` is ignored (the tool says so). Lean on a **high similarity** (≥ ~80% is strong same-image evidence). If you're unsure on a middling score, ask the **`media`** tool a targeted question about the source/thumbnail URL and compare against the **query image's own caption** that's already in your context — don't claim you "saw" pixels you didn't.

## Reporting the Sauce in Chat

- **Link the source** (`ext_urls`), **name the artist** (the `artist:` line), and say the **source type** (Pixiv / Twitter / booru / etc.).
- If the only hits are low-similarity, **say it's uncertain** ("closest I found is ~50%, might not be it") rather than asserting a wrong source. A confidently wrong credit is worse than "couldn't find it."
- No matches at all → the image may simply not be indexed (original, heavily edited, or a fresh crop). Say so — but consider the fallback below before giving up.

## When SauceNAO Whiffs — the `x_search` Fallback

> Applies only when X search is configured. Skip this section if `x_search` is not in your tool list.

SauceNAO is a perceptual-hash match: it only finds images that are **indexed**. When it comes up empty (no match, only weak <55% hits, or the quota's exhausted), you have a second, different angle: hand the same image to **`x_search`** via its `images` param.

```json
{ "query": "who is this character / who drew this / what's this from?", "images": ["./attachments/2026-06-14/abcd.jpg"] }
```

Grok *sees* the image and searches X/web for what it **recognizes** — the character, artist, series, meme, or scene. That's a fundamentally different mechanism from SauceNAO:

- It **shines** on well-known subjects (a recognizable character, a popular artist's style, a viral meme/screencap) even when the exact image isn't in any index.
- It **won't** identify an obscure original the way a hash match would — it's recognition + search, not reverse-image.
- So **report it honestly**: "SauceNAO didn't have it, but it looks like <X> from <Y>" — frame it as recognition, not a confirmed hash match, and don't manufacture confidence the method can't give you.

Order of operations: `find_source` **first** (precise when it hits), `x_search` images **second** (broader recognition when the hash match misses).

## Rate-Limit Etiquette

SauceNAO's free quota is **tight** — roughly **6 searches / 30s** and **~200 / day**. The result surfaces the remaining counts (`short N left`, `daily N left`). So:

- **One good lookup per image.** Don't fire it repeatedly at the same picture or spray it across a gallery.
- If it reports the **short window is exhausted** ("try again shortly"), **hold off** — don't retry in a tight loop. Come back to it.

## NSFW Note

SauceNAO indexes explicit sources too, so a result may point at an NSFW page. Handle it per your normal content norms — surface the link as data, and don't go out of your way to embed explicit previews.
