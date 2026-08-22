---
name: contacts
description: "Reach beyond the current channel — DM a user (`send_dm`), send a message to another channel (`send_to_channel`), list or compare channel rosters (`list_members`), list your channels (`list_channels`), honor DM opt-outs (`dm_optout`). Load when asked to DM/tell/ask someone privately, deliver a message elsewhere, when someone asks not to be DMed (or to be DMed again), or for who's-in-what and membership-overlap questions."
tools:
  - send_dm
  - send_to_channel
  - list_members
  - list_channels
  - dm_optout
---

# Contacts — Cross-Channel Messaging

These tools let you reach outside the current channel: DM users, send messages
to other rooms, and manage DM consent.

## Protocol

1. **Have the exact id?** Send directly. The exact id is the `sender` attribute
   on a message, or the `id` in search/roster results. When uncertain (only a
   display name), call `list_members` with a `query` to resolve candidates first.
   The `send_dm` send-error path is a safety net, not the plan; never auto-pick
   when multiple candidates are plausible.

2. **Ambiguous candidates?** Ask the requester in the originating channel —
   never pick without confirming. A wrong-recipient DM is the one unrecoverable
   error in this feature.

3. **Always include `context_note`.** State why you're DMing and whether a reply
   should be relayed back. The note is stored on the sent message internally and
   surfaces in the DM session's context — this is the entire bridging mechanism.
   Write the DM body in your own voice (mentioning the requester when natural is
   your call, not a requirement).

4. **After sending:** confirm the outcome in the originating channel, including
   `pending_invite` ("sent; they haven't accepted the DM invite yet") and failures
   ("her DMs are closed") — honestly, no pretending.

5. **Checking on an errand** (asked how it went with nothing relayed back):
   `read_messages(room: <user or dm key>, anchor: "last_self")` and report.
   If the room is isolation-blocked, say the conversation is private — don't
   speculate.

6. **Opt-out requests**, however phrased ("stop DMing me", "leave me alone" in a
   DM you initiated): run `dm_optout`, confirm, **stop**. Do not negotiate,
   explain, or ask why. A bot arguing about its right to DM someone is the
   exact annoyance the tool exists to prevent.

7. **Relay only what the errand asked for** — not other things said in the DM.

## Tools

### `send_dm`
Open a DM with a user and send a message. Requires the user's exact stable id
(`@user:server` for Matrix, snowflake for Discord, `network/nick` for IRC).
On an inexact id you get a candidate list; retry with one exact id and a
`message_ref` (avoids retyping the body). Always fails before sending if the
user has opted out.

### `send_to_channel`
Send a message to another channel the bot is in. Pass a full timeline key
(`list_channels` gives them all). On an unknown key you get a list of valid
targets; same `message_ref` retry pattern.

### `list_members`
Roster listing + identity search. Accepts `rooms: "current"` / array of keys /
`"all"` (requires `query`); `query` does fuzzy name-to-id resolution across the
corpus. Supports `op: "intersection"` or `"difference"` for set comparisons
across multiple rooms (e.g. "who's in #a but not #b?").

### `list_channels`
Enumerate channels the bot is joined to. `include_dms: true` also lists open
DM channels.

### `dm_optout`
Toggle a user's opt-out preference. Default target is the trigger sender.
Authorization is structural: only someone who addressed this session can flip
their own bit — proxy requests ("opt out for alice") are rejected with a
message to relay to the real requester.
