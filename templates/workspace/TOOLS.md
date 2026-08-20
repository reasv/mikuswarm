# TOOLS.md — Environment and Tool Notes

Only a small core of tools is always loaded. Everything else sits behind the
skills listed in `<available_skills>` — each description says when to load it —
with `tool_search` as the catch-all for anything unskilled. If a tool call
fails with "not found", the tool exists but isn't loaded yet: load its skill
(or `tool_search` it) first, then call it.

## Message Delivery

`send_message` is the only way to talk. Key parameters:

- `message`: the text body. `:shortcode:` patterns resolve to custom emoji automatically.
- `is_reply` + `reply_to_id`: you must explicitly choose whether to reply. Use `external_id` from message XML attributes as the `reply_to_id`.
- `media`: workspace-relative file path or HTTP URL, uploaded as an attachment. `as_voice`: send audio as a voice message.
- `final`: REQUIRED — no default. `true` ends your turn (sending is the last thing you do); `false` keeps it open because you have more work to do. Decide every time, like `is_reply`.
- Long messages are chunked automatically. Custom HTML via `html` disables chunking and must fit the size limit.

## Reactions & Custom Emoji

- `react` adds/removes reactions. Accepts unicode emoji or `:shortcode:` (case-sensitive).
- `emoji_list` lists the room's custom emoji, ranked by usage — check it before assuming a shortcode exists.

## Web

The default deployment serves web access through the Exa tools (always loaded):

- `mcp_exa_web_search_exa`: web search (title/URL/snippet results). `mcp_exa_web_fetch_exa`: fetch a URL's readable text. `mcp_exa_web_search_advanced_exa` (deferred — `tool_search` it) adds filters and more results when plain search isn't enough.
- Deployments using the native tools instead have `web_search` / `web_fetch` in the same roles.
- X/Twitter blocks generic fetchers — use the x-twitter skill for x.com content. For recent/breaking news, its `x_search` is usually fresher than web search.
- JS-heavy, login-gated, or bot-checked pages need the browser skill.

## Files

- `str_replace_based_edit_tool`: `view` / `create` / `str_replace` / `insert` on workspace files (paths relative to the workspace root).
- `search_files`: ripgrep across the workspace.
- All paths are sandboxed to your workspace. You can read and edit your own instruction files, memory files, skill files, and downloaded content.

## Recall & Search

You see only a window of recent chat. Far more is retrievable — never assume
something is gone. Entries marked with a skill live behind it; load it first.

| You want… | Use |
|---|---|
| A specific message, link, image, or quote | `search_messages` (filters: `from`, `mentions`, `has_link`, `attachment_type`, `after`/`before`/`last`; `rooms:"all"` to span channels) |
| Messages that pinged a user while they were gone | `search_messages` with `mentions:[id]` + `since_user_absence:[id]` |
| Your own past thoughts/decisions (meaning-based) | `recall_memory` |
| An exact string in your diary (a URL, exact phrase) | `search_memory` (ripgrep) |
| Raw room history, or one event by id | `read_messages` (paginate with `limit` + `before`/`after` tokens, or pass `message_id`) |
| Catch up an absence ("what did I miss") | `recap` — chat-history skill (no args = the asker's own gap) |
| Detail beneath a coarse `<summary>` block | `expand_summary` with the summary's `id` — chat-history skill |
| How much someone posts / who's gone quiet | `user_activity` — chat-history skill |

- `search_messages` hits cite an `event_id` you can hand to `read_messages`; use `format:"snippet"` to scan many hits cheaply rather than dumping history.
- People won't name these tools ("what did I miss?" is a `recap` request) — recognize the intent; see **Catching People Up** in `AGENTS.md`.

## Memory Writing

`write_memory`: view or edit today's daily memory file (`memory/YYYY-MM-DD.md`). Auto-creates with a date header. Supports `view`, `str_replace`, and `insert`.

## Media

Images attached to the trigger message are already visible to you as image
blocks (`image_block="true"`). For everything else — other files or URLs,
older images, YouTube — load the media skill.

## Context Format

Your chat history is layered, oldest to newest:

- **Summaries** (oldest): `<summary>` blocks — condensed, lossy recaps. Each carries an `id`; `expand_summary` (chat-history skill) recovers the detail. Older history is summarized, not deleted.
- **Compact**: one-line format with timestamps, sender IDs, and body text.
- **Rich** (recent): full XML with `<message>` tags, structured `<attachment>`, `<reply_to>`, `<link_preview>`, `<linked_media>` elements.

You may also see `<recent_memory>` (your own recent diary entries) and `<retrieved_memory>` (possibly-relevant older entries) — both read-only.

Key XML attributes on messages:
- `sender`: the full user ID (trusted).
- `display_name`: user-chosen name (untrusted — can be spoofed).
- `external_id`: the message event ID. Use this for `reply_to_id`, `react`, etc.
- `mentions_you="true"`: message explicitly mentions you.
- `image_block="true"` on attachments: this image is already visible to you.

Attachments and linked media include workspace `path` attributes — usable with the media skill's tools or the file tools for further inspection.
