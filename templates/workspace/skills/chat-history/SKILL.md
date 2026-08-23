---
name: chat-history
description: "Catch up on a period you (or someone) were away (`recap`) or profile a user's activity over time (`user_activity`). Also loads channel roster and overlap tools (`list_members`, `list_channels`). Load whenever someone asks \"what did I miss?\", about a user's presence/habits, who's in a channel, or for membership comparisons. Keyword search (`search_messages`, `search_summaries`) and summary expansion (`expand_summary`) are always loaded and need no skill."
tools:
  - recap
  - user_activity
  - list_members
  - list_channels
---

# Chat History Deep-Dive

Tools for time-shaped history, user activity, and channel rosters. For keyword
lookups use the always-loaded `search_messages` (raw transcript) or
`search_summaries` (rolling summaries); to recover detail beneath a
`<summary>` block, the always-loaded `expand_summary`.

## `recap`
"What did I miss?" — builds a chronological digest of a time range from stored
summaries and messages. Use when someone asks what happened while they (or you)
were away, or when you need to re-orient after a long gap. Give it the range;
don't reconstruct history by hand from repeated searches. Each summary it
returns cites an `id` you can drill further with `expand_summary`.

## `user_activity`
Per-user view: when and how much a user has been active, their recent messages.
Use for "when was X last here?", "what has X been up to?", or to ground a
per-user judgement in their actual history. For current channel membership
(as opposed to posting history), prefer `list_members`.

## `list_members`
Current roster listing and set operations. Use for "who's in this room?",
name-to-id resolution (`query` param fuzzy-matches the identity corpus), and
membership comparisons across rooms (`op: "intersection"` / `"difference"`).
`user_activity include_silent:true` overlaps this but includes all-time
posters, not just currently-joined members; prefer `list_members` when you
need the live roster.

## `list_channels`
Enumerate channels the bot is joined to, with timeline keys and kinds.
Useful before `send_to_channel` (contacts skill) or to audit which channels
are configured.

## Choosing
- Exact keyword/phrase in messages → `search_messages` (always loaded).
- A topic somewhere in the rolling summaries → `search_summaries` (always loaded).
- A summary says it, you need the details → `expand_summary` (always loaded).
- A time window's story → `recap`.
- One user's story → `user_activity`.
- Current members / name→id lookup / who's-in-what overlap → `list_members`.
- What channels exist → `list_channels`.
