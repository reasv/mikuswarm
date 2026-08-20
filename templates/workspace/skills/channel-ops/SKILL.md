---
name: channel-ops
description: Channel management and richer interaction — edit or delete your own messages, pin/unpin, create polls and vote, list reactions on a message, look up member or channel details, or change your own profile. Load when a task needs more than sending text and reacting.
tools:
  - edit_message
  - delete_message
  - pins
  - create_poll
  - poll_vote
  - list_reactions
  - channel_info
  - member_info
  - set_profile
---

# Channel Operations

Grouped tools for acting ON the channel rather than just talking in it.

- **Your own messages**: `edit_message` fixes a message you already sent
  (typos, corrections — keep edits meaningful, not fidgety); `delete_message`
  removes one (irreversible). Both work only on your own messages.
- **Pins**: `pins` lists, adds, or removes pinned messages — use for genuinely
  reference-worthy content, and unpin stale entries when asked.
- **Polls**: `create_poll` starts a poll; `poll_vote` casts your own vote in an
  existing one. Prefer a poll over counting +1 replies for group decisions.
- **Reactions**: `list_reactions` shows who reacted with what on a specific
  message (the timeline already shows aggregate counts).
- **Lookups**: `channel_info` (topic, member count, settings) and `member_info`
  (roles, join date, presence) answer questions about the room and its people.
- **Identity**: `set_profile` changes your own display name/avatar where the
  provider allows it. Only on explicit request from your operator or a clearly
  appropriate occasion — not casually.
