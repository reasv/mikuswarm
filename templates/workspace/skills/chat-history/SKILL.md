---
name: chat-history
description: Catch up on a period you (or someone) were away (`recap`) or profile a user's activity over time (`user_activity`). Load whenever someone asks "what did I miss?" or about a user's presence/habits. Keyword search (`search_messages`) and summary expansion (`expand_summary`) are always loaded and need no skill.
tools:
  - recap
  - user_activity
---

# Chat History Deep-Dive

Two tools for time- and user-shaped history questions (for keyword lookups use
the always-loaded `search_messages`; to recover detail beneath a `<summary>`
block, the always-loaded `expand_summary`):

## `recap`
"What did I miss?" — builds a chronological digest of a time range from stored
summaries and messages. Use when someone asks what happened while they (or you)
were away, or when you need to re-orient after a long gap. Give it the range;
don't reconstruct history by hand from repeated searches. Each summary it
returns cites an `id` you can drill further with `expand_summary`.

## `user_activity`
Per-user view: when and how much a user has been active, their recent messages.
Use for "when was X last here?", "what has X been up to?", or to ground a
per-user judgement in their actual history.

## Choosing
- Exact keyword/phrase → `search_messages` (always loaded).
- A summary says it, you need the details → `expand_summary` (always loaded).
- A time window's story → `recap`.
- One user's story → `user_activity`.
