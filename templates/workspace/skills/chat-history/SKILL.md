---
name: chat-history
description: Dig deeper into this channel's past than the visible context — expand a stored summary to its raw messages (`expand_summary`), catch up on a period you were away (`recap`), or profile a user's activity over time (`user_activity`). For plain keyword search, `search_messages` is always available without this skill.
tools:
  - expand_summary
  - recap
  - user_activity
---

# Chat History Deep-Dive

Three tools for going beyond `search_messages`:

## `expand_summary`
Summaries in your context carry ids. When a summary mentions something you need
verbatim (an exact quote, a link, a decision's wording), expand it to the raw
messages it covers. Prefer expanding ONE summary over paging raw history — it is
the cheapest way to recover detail the summary compressed away.

## `recap`
"What did I miss?" — builds a chronological digest of a time range from stored
summaries and messages. Use when someone asks what happened while they (or you)
were away, or when you need to re-orient after a long gap. Give it the range;
don't reconstruct history by hand from repeated searches.

## `user_activity`
Per-user view: when and how much a user has been active, their recent messages.
Use for "when was X last here?", "what has X been up to?", or to ground a
per-user judgement in their actual history.

## Choosing
- Exact keyword/phrase → `search_messages` (no skill needed).
- A summary says it, you need the details → `expand_summary`.
- A time window's story → `recap`.
- One user's story → `user_activity`.
