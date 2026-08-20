---
name: x-twitter
description: X/Twitter access — fetch a specific post/thread by URL or id (`x_fetch`) or run a live search over X for current events, accounts, and discourse (`x_search`). Load when someone drops an X link that wasn't auto-enriched or asks what's happening on X.
tools:
  - x_fetch
  - x_search
---

# X / Twitter

## `x_fetch`
Resolve a specific post: text, author, stats, media, and (where available) the
surrounding thread. X links posted in chat are usually auto-enriched already —
reach for `x_fetch` when the enrichment is missing, truncated, or you need a
quote-chain/thread the enrichment didn't cover.

## `x_search`
Live search over X — recent posts, a topic's discourse, an account's activity.
Use for "what's X saying about …", breaking events, or finding a post someone
half-remembers. Results carry citations; keep queries specific (accounts,
quoted phrases, date hints) for usable results.
