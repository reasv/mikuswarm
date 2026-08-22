# Cross-Channel Messaging — DMs, directory tools, and the context-note bridge

**Status**: DRAFT — design settled with operator 2026-08-22; pending
implementation review.

**Settled operator decisions** (2026-08-22): feature ships **on by default**
(core capability, opt-out via config — not a default-off knob); a mandatory
machine-stored **context note** bridges intent across channels, with **no
recipient-visible watermark** (the agent frames its own messages; the note is
internal context only); DM eligibility requires a **shared visible channel**
(an existing DM timeline counts, so any DM opens standing eligibility);
`send_to_channel` is **in scope for v1** (required for relay-back);
**visibility gates reads and enumeration, never sends**; cross-channel
reply-steer/resume is **rejected** (see §11 Non-goals); no per-user tool
gating (no enforcement substrate exists; authorization is structural instead);
DM opt-out is a **tool call**, not a chat command (no command precedent
exists, and commands aren't discoverable — users just ask the agent);
`list_*` tools are **dual-homed** in both the new skill and chat-history;
no new immediate-core tools — the whole surface is skill-loaded.

Target ARCHITECTURE.md home once implemented: §10 Tools (new tools + dynamic
loading additions), §9h Channel visibility (reads-not-writes principle,
`read_messages` amendment), §9g Proactive (opt-out eligibility gate), §4
(config schema), §6 (storage: `dm_optouts`, cross-channel event metadata).

---

## 1. Motivation

The agent can only speak into the channel that triggered it. `send_message`
has no target parameter — the target is closure-bound at session creation
(`buildSessionTools`, `src/app.ts`; `src/tools/send-message.ts` stamps
`context.target.timelineKey` on every outbound event). There is no way to
enumerate joined channels, no way to list a channel's members, no way to
resolve a display name or nick to a stable user id, and no way to initiate a
DM on any platform. A request as basic as:

> @bot DM alice for me and tell her the meetup moved to Saturday

is unfulfillable today, as are "who's in #a but not #b?", "tell #general the
build is fixed", and "how did that DM go?".

The design goal is not just tools but an end-to-end path the agent finds
without guessing: always-on nudges that route the request to the right skill,
naive-call-tolerant errors that carry their own corrections, and a bridging
mechanism for intent that crosses channel boundaries.

## 2. Current state (audit, 2026-08-22)

What exists at the adapter layer but is unexposed:

| Capability | Matrix | Discord | IRC |
|---|---|---|---|
| DM initiation | `resolveTarget("@user:server")` in the NAPI surface checks `get_dm_room`, creates + invites via `create_dm` when absent (`native/crates/matrix-core/src/client/mod.rs`) — reachable from TS, wrapped by nothing | absent; discord.js supports `client.users.createDM(id)` natively | already works: `send()` to a `dm:` timeline key unscopes to the bare nick and PRIVMSGs it (`src/irc/provider.ts`) |
| Member roster | `roomMembers` NAPI + `ChannelClient.members()` | guild member cache behind `member_intent: true` (`membershipRoster` capability flag) | `RosterTracker` fed by NAMES/join/part/quit/nick |
| Identity corpus | **`user_identities` never written** | upserted every `messageCreate` + `guildMemberUpdate` | upserted on NICK renames |

Tool-surface absences (verified under multiple naming conventions): no
channel list, no member list (`user_activity include_silent:true` unions the
roster into an activity report — closest thing), no name→id resolution
anywhere in the stack (`member_info` goes id→name only), no DM or
cross-channel send. `read_messages` is hard-bound to the current channel.
Reply-steer and reply-resume are both gated
`targetEvent.timelineKey !== inbound.timelineKey → bail`
(`src/app.ts`, `steerReplyToActiveSession` / `tryReplyResume`).

Precedents this design builds on: `channel_info`'s optional `room_id` param
grafts a foreign channel id onto the session's account (`channelClientFor`,
`src/app.ts`); outbound events already carry structured local-only metadata
(`agentSessionId`, `agentSessionGeneration`) into the timeline row; the
dynamic tool loading system (spec `DYNAMIC-TOOL-LOADING.md`) provides
skill-gated tools, an always-visible `<available_skills>` index, and the
"tool not found → load its skill" error backstop.

## 3. Design principles

1. **The timeline carries continuity, not the session.** Sessions are
   ephemeral per-trigger instances; by the time a DM recipient answers, the
   originating session is gone regardless. Intent crosses channels as *data
   on the message* (§6), never as control flow. No session bridging.
2. **Errors are the primary UX.** Every tool accepts the naive call; every
   failure returns the correction inline (candidates, valid targets, retry
   handles). The naive path must cost at most one extra cheap call and must
   never require the agent to have planned ahead.
3. **Visibility gates reads and enumeration, never sends.** Isolation
   (spec `CHANNEL-VISIBILITY.md`) prevents content leaking *out* of a channel
   through ambient access. A send *into* any channel leaks nothing out of it;
   a deliberate relay *out* by a session legitimately running inside that
   channel is agent judgment governed by instructions, not by the resolver.
   `send_dm` therefore works regardless of DM isolation — that is normal DM
   interaction, not a leak. The only send-path block anywhere is the consent
   gate (§7), which is not a visibility mechanism.
4. **Authorization is structural.** Where a check would be needed (opt-out
   targeting), the tool is scoped so the unauthorized call cannot be
   expressed, rather than expressed-then-rejected.

## 4. Tools

All five new tools are **deferred**, declared by a new `contacts` skill;
`list_members` and `list_channels` are additionally declared by
`chat-history` (skills declare tool patterns matched against the catalog;
enabling is idempotent, so dual-homing needs no loader changes). No
immediate-core additions: every trigger here is an explicit user ask, and the
ask itself is the retrieval cue that matches a skill description — unlike the
reactive tools (`expand_summary`, `emoji_list`) that earned immediate slots
because nothing external names their moment of need.

In multi-agent deployments all tools are scoped to the session agent's
accounts, same as `search_messages`' account-prefix scoping.

### 4.1 `send_dm`

Send a direct message to a user, opening the DM channel if the platform
requires one.

| Param | Type | Req | Notes |
|---|---|---|---|
| `user` | string | yes | Stable user id (`@user:server` / snowflake / `network/identity`). Any string accepted; inexact input → resolution error (§5.1), never a guess. |
| `message` | string | yes* | *Or `message_ref`. |
| `message_ref` | string | no | Handle from a prior resolution error (§5.2); re-sends the stashed body without retyping. `message` wins if both given. |
| `context_note` | string | yes | 1–2 sentences: what prompted this DM; whether/where a reply should be relayed. Free text only — provenance is auto-stamped (§6). |
| `media` | per provider caps | no | Mirrors `send_message` (path or URL; array on multi-attachment providers; `as_voice` where supported). |

No `is_reply`/`reply_to_id` (replies inside a DM conversation are the DM
session's `send_message` job) and **no `final`** — `send_dm` never ends the
turn; the expected next step is confirming the outcome in the originating
channel.

**Eligibility**: target must share ≥1 visible channel with the sending
account (an existing DM timeline counts — any DM grants standing
eligibility). Users outside the corpus simply never resolve, so the rule is
mostly self-enforcing; an exact-id target with no shared channel errors
explaining the rule. When multiple accounts could reach the user, the account
sharing the most channels with them sends (implementer may simplify to
first-match).

**Returns**: `{ dm_timeline_key, event_id, status }` where `status` is
`delivered` or `pending_invite` (Matrix: DM room created, invite not yet
accepted — reported as success-with-caveat, wording in §8.1, never silently
dropped).

**Order of checks**: opt-out (§7) → resolution → eligibility → platform send.
The opt-out error must fire even for fuzzy input that would resolve uniquely
to a blocked user.

### 4.2 `send_to_channel`

Send a message to another channel the account is in.

| Param | Type | Req | Notes |
|---|---|---|---|
| `channel` | string | yes | Full timeline key. Unknown/unjoined → error listing nearest valid targets inline (no follow-up `list_channels` call needed). |
| `message` / `message_ref` | string | yes* | As §4.1. |
| `context_note` | string | yes | As §4.1. Canonical use: the relay-back leg of a DM errand. |
| `media` | per caps | no | As §4.1. |

Not visibility-gated (§3.3): sending into an isolated channel moves
information *inward*. Enumeration in errors and in `list_channels` is
visibility-filtered — suggesting an isolated channel would reveal its
existence, which is a read.

Returns `{ event_id }`. The event is ingested into the target timeline via
the normal `ingestAssistantSend` path with the §6 metadata attached.

### 4.3 `list_members`

Roster listing, set operations, and (with `query`) the directory / name
resolution surface.

| Param | Type | Req | Notes |
|---|---|---|---|
| `rooms` | `"current"` \| string[] \| `"all"` | no | Default `"current"`. `"all"` requires `query` (directory mode) — an unfiltered global roster dump is never useful and always huge. |
| `query` | string | no | Fuzzy match over display name, username/nick, alias history, and id, across the identity corpus (§8.4) + live rosters + search-index sender names. |
| `op` | `"union"` \| `"intersection"` \| `"difference"` | no | Default `union`. Requires ≥2 rooms. `difference` is ordered: first room minus the rest. Computed server-side — the agent never diffs two 400-member lists in context. |

Output rows: `{ id, username?, display_name?, last_seen? }`, plus per-room
presence flags when multiple rooms are given, plus shared-channel summaries in
query mode (the disambiguator humans actually use: "the alice from #dev").
Rooms are resolved through the visibility resolver exactly as
`search_messages` does (isolated non-member channels dropped **with a visible
note**, per the CHANNEL-VISIBILITY convention).

Where the provider lacks a roster (`membershipRoster` false — e.g. Discord
without `member_intent`), degrade to the identity corpus + posting history
and say so in the result rather than failing.

### 4.4 `list_channels`

Enumerate channels the session's account(s) are joined to: one row per
channel — timeline key, human label, kind, member count when cheap.

| Param | Type | Req | Notes |
|---|---|---|---|
| `include_dms` | boolean | no | Default `false`: rooms + the current channel only. `true` adds DM timelines, visibility-filtered (isolated DMs never listed). Existence of a DM is metadata worth defaulting closed even when not isolated. |

Isolated channels the session isn't in are always omitted (with the standard
visible note when they were explicitly requested — not applicable here since
there is no room-list input, so plain omission).

### 4.5 `dm_optout`

Self-service consent gate for unprompted DMs.

| Param | Type | Req | Notes |
|---|---|---|---|
| `action` | `"opt_out"` \| `"opt_in"` | yes | |
| `user` | string | no | Default: the session's trigger sender. When given, must match one of the session's **addressing senders** (trigger sender(s) + steered-interjection senders — `trigger_sender_id` is already on the session record; interjection senders are known to the session runner). Anything else errors: "only alice can opt themselves out — they need to ask me directly." |

Authorization is structural (§3.4): sender ids are platform-verified, and the
only person who can flip the bit is a person who addressed this session — in
their own DM (peer = trigger sender) or in any channel ("@bot never DM me").
Third-party and proxy requests are inexpressible, and the rejection text *is*
the sentence the agent should relay to the proxy requester. Reversal has the
same property: a blocked user can still DM the bot (their own messages spawn
sessions normally — that's user-initiated, not proactive) or ask in a
channel, so opt-in is always reachable by exactly the preference's owner.

Semantics: blocks **agent-initiated** DMs only. Replying within a DM session
the user started is untouched. Enforcement points in §7.

### 4.6 `read_messages` extension (existing immediate tool)

Two optional params, no behavior change when absent:

| Param | Type | Notes |
|---|---|---|
| `room` | string | Timeline key, **or a user id** as sugar for "my existing DM with this user" (no DM exists → error with candidates, §5.1 grammar; never creates one). Absent → current channel (today's behavior). |
| `anchor` | `"end"` \| `"last_self"` | Default `end` (tail). `last_self`: window centered on the agent's own most recent message in that channel — one indexed lookup, assistant rows are already tagged. In a quiet DM the anchors coincide; in a busy channel `last_self` is one call instead of five pages of backscroll. |

`last_self` exists specifically to repair the dead-end errand: the user asks
"so what did alice say?", nothing was relayed back, and the agent must find
its own message and what followed without hunting.

**Visibility amendment**: `CHANNEL-VISIBILITY.md` §2 listed `read_messages`
as "already safe, no changes" *because* it was current-channel-bound. The
`room` param brings it under the resolver: an isolated non-member `room` is
refused with the standard note. Under a `dms: isolated` deployment the repair
flow above is therefore unavailable by the operator's own choice, and the
honest agent answer is "that conversation is private — ask alice." This spec
supersedes that line of §2.

Always-on cost: ~25 tokens of schema description on a tool every session
already loads. Accepted.

## 5. Error grammar

One shape everywhere, so the agent learns it once. All errors are actionable:
they name the exact re-call that fixes the problem.

### 5.1 Resolution errors (`send_dm` fuzzy target, `read_messages` user-id sugar, bad room keys)

```
No exact user id match for "joe". Closest known users:
  @joe:example.org      "Joe" — shares #general, #dev; last seen 2h ago
  discord/188...301     "joey_p" (joeyp) — shares #memes; last seen 3d ago
Re-send the same call with `user` set to one exact id (message_ref: "m1"
re-sends your text without retyping it), or ask the requester which person
they meant if genuinely ambiguous.
```

Candidate lines carry id, names, shared channels, last-seen — ranked by match
quality then recency. Bad `channel` / `room` values get the same treatment
with channel rows (label + timeline key), visibility-filtered.

**Never auto-send on a single fuzzy match.** The corpus only contains users
the bot has seen; "the one joe the bot knows" is not necessarily the joe the
requester means, and a wrong-recipient DM is the one unrecoverable failure in
this feature. Exact stable-id match is the only thing that sends.

### 5.2 `message_ref` retry

When `send_dm`/`send_to_channel` reject on target resolution, the composed
body (and media list) is stashed in session-scoped tool state under a short
ref (`m1`, `m2`, …) offered in the error. The stash is inert — nothing can
send it except an explicit re-call citing the ref — and dies with the
session, so there is no staging half-state and no un-sent message lingering.
This caps the naive path at one short retry call regardless of message
length, which dissolves the cost objection to error-path resolution: resolve-
first and send-naively converge on the same price, and neither is wrong.

### 5.3 Missing `context_note`

Schema-required, so omission is a validation error **before any side
effect**; resubmission is safe. The error does the teaching:

```
Missing required `context_note` — resubmit the same call adding 1–2
sentences: what prompted this message, and whether/where a reply should be
relayed back.
```

Required-param omission is rare in practice (the schema is in the tool
definition); the param description is the real enforcement and this is the
backstop. Deferred-note designs were rejected: pre-send staging risks silent
non-delivery when the confirm is forgotten; post-send annotation makes the
note optional in fact and needs turn-end auditing to pretend otherwise.

### 5.4 Opt-out rejection (`send_dm`)

```
@joe:example.org opted out of unprompted DMs (requested 2026-08-22 in
#general). Do not DM them. Tell the requester joe has asked not to be DMed.
Joe can reverse this himself by asking you — in any channel or by DMing you —
to allow DMs again (dm_optout, action "opt_in").
```

The error carries the whole social protocol: what to tell the requester, and
the exact reversal path, so a session that never loaded any instructions is
fully briefed at the moment it matters.

## 6. Cross-channel context note

Every `send_dm` / `send_to_channel` event stores, **locally only** (timeline
row + `event_json`, alongside the existing `agentSessionId` /
`agentSessionGeneration` fields — same precedent, same plumbing):

```
cross_channel: {
  origin_timeline_key,   // auto-stamped from the session
  origin_sender_id,      // trigger sender, auto-stamped
  origin_session_id,     // auto-stamped
  note,                  // the agent's free text — the only authored field
}
```

The agent writes one sentence of *why*; it never writes an address. The
relay-back destination is therefore always machine-correct — immune to typos
and to the agent forgetting to mention it.

**Rendering**: context assembly renders the note as an annotation on the
assistant message in the *destination* timeline (e.g. a `cross_channel_note`
attribute or child element in rich format, a bracketed suffix in compact
format). The fresh session spawned by the recipient's reply thus sees, in its
own timeline, both the message the agent "sent" and its purpose — including
relay instructions with a concrete origin key it can hand to
`send_to_channel`. This is the entire bridging mechanism; nothing rides the
wire, so it is protocol-independent and identical across all three platforms.
The agent remains free to *choose* human framing in the body ("alice asked me
to pass this along") — persona behavior, not machinery.

**Round trips fall out**: channel → `send_dm` (note: "relay the answer back")
→ recipient replies → fresh DM session reads the note → `send_to_channel`
(origin key) → done. Zero session plumbing, no heuristics, every hop
explained in-band. If the recipient never replies, the errand parks safely:
`read_messages(room, anchor:"last_self")` recovers it on demand.

## 7. DM opt-out storage and enforcement

**Table** (new migration):

```sql
CREATE TABLE dm_optouts (
  provider             TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  origin_timeline_key  TEXT,        -- where the request was made
  origin_session_id    TEXT,
  PRIMARY KEY (provider, user_id)
);
```

Global per user, **not per-agent**: "don't DM me in any way" is a statement
about the person's inbox, not about one persona, and the abuse case argues
for the blanket reading. Opt-in deletes the row.

**Enforcement point 1 — `send_dm`**: hard error (§5.4), checked before
resolution so fuzzy input cannot sidestep it.

**Enforcement point 2 — proactive scheduler**: the eligibility gate (§9g)
skips runs on `dm`-kind timelines whose peer has opted out. This closes the
"proactively in any way" requirement — `send_dm` is not the only path to an
unprompted DM when an operator configures a DM as a proactive channel.

Not enforced on: `send_message` inside a session the user's own DM message
triggered (user-initiated by definition), reactions, or channel messages
mentioning the user.

## 8. Platform mechanics

### 8.1 Matrix

`send_dm` calls the existing NAPI `resolveTarget` with `create_dm: true`
(reuses `get_dm_room` / `create_dm` exactly as shipped), then sends into the
resolved room. New room ⇒ the create carries the invite; return
`status: "pending_invite"` with result text "sent; they haven't accepted the
DM invite yet and may not see it until they do." A provider-level
`createDm(userId)` method wraps this — the tool layer stays
platform-agnostic. Invite-send beyond DMs stays unexposed.

### 8.2 Discord

`client.users.createDM(snowflake)` then send; the resulting DM channel
snowflake keys the timeline as usual. "Cannot send messages to this user"
(DMs closed to non-friends without a mutual-guild allowance) surfaces as an
error naming the cause — the tool never pretends delivery. Roster and
resolution quality degrade without `member_intent` (§4.3); docs note the
trade-off, deployments decide.

### 8.3 IRC

Construct the `dm:` timeline key from the network-scoped identity and use the
existing send path (PRIVMSG to the unscoped nick). One pre-flight: if the
nick is absent from all rosters and WHOIS misses, error "nick not currently
online — they won't receive this" instead of letting the PRIVMSG vanish.
Respects the existing `dm_enabled` account flag (§10).

### 8.4 Identity corpus prerequisite

Matrix must start upserting `user_identities` per-message exactly as Discord
does (`callbacks.upsertUserIdentity` exists; Matrix never calls it). Without
this the biggest resolution surface has no corpus beyond live rosters. Cheap
(one upsert per inbound message, table already indexed), and load-bearing for
§5.1.

## 9. Instructions and discovery

The requirement is not "the agent may use these tools" but "the agent gets
from *situation* to *exact next action* without guessing." Three always-on
hooks, ~150 tokens total, plus the free error backstop ("tool not found →
load its skill"):

**TOOLS.md § Message Delivery, one added line** (the highest-value sentence —
it converts the known limit of the one tool every session reads into a
router, at the moment the agent is thinking "I need to talk"):

> `send_message` only reaches the current channel. DMing a user or messaging
> another channel goes through the contacts skill.

**TOOLS.md lookup table, three added rows**:

| You want… | Use |
|---|---|
| DM someone / deliver a message privately | `send_dm` — contacts skill |
| Say something in another channel | `send_to_channel` — contacts skill |
| Who's in a channel / member overlap between channels | `list_members` — contacts skill |

**`contacts` skill description** (house trigger-first style, ~85 tokens):

> Reach beyond the current channel — DM a user (`send_dm`), send a message to
> another channel (`send_to_channel`), list or compare channel rosters
> (`list_members`), list your channels (`list_channels`), honor DM opt-outs
> (`dm_optout`). Load when asked to DM/tell/ask someone privately, deliver a
> message elsewhere, when someone asks not to be DMed (or to be DMed again),
> or for who's-in-what and membership-overlap questions.

**`chat-history` skill**: description gains a clause for rosters/overlap;
its SKILL.md documents `list_members`/`list_channels` as complements to
search and positions `user_activity include_silent` relative to the real
roster tool.

**`contacts` SKILL.md protocol** (loaded on demand, free until then):

1. Have the exact id from message context (`sender` attribute, search hits)?
   Send. Identity uncertain or the message is long? Resolve first
   (`list_members` with `query`) — the send-error path is the safety net, not
   the plan.
2. Candidates that are plausibly *different people*: ask the requester in the
   originating channel — never pick.
3. `context_note` states the why and the relay expectation; write the DM body
   in your own voice (mention the requester when natural — your call).
4. After sending: confirm the outcome in the originating channel, including
   `pending_invite` and failures ("her DMs are closed") — honestly, no
   pretending.
5. Asked how an errand went with nothing relayed back?
   `read_messages(room: <user or dm key>, anchor: "last_self")` and report.
   If the room is isolation-blocked, say the conversation is private.
6. Opt-out requests, however phrased ("stop DMing me", "leave me alone" in a
   DM you initiated): run `dm_optout`, confirm, **stop** — no negotiating, no
   asking why. A bot arguing about its right to DM you is the exact
   annoyance the tool exists to prevent.
7. Relay only what the errand asked for — not other things said in the DM.

## 10. Config

```toml
[messaging]
enabled = true            # master switch for send_dm/send_to_channel; default ON
dm_initiation = true      # send_dm specifically (send_to_channel unaffected)
```

Per-account inbound DM flags that already exist (IRC `dm_enabled`, Discord
`dmEnabled`) also gate *outbound* initiation on their accounts: a deployment
that disabled DMs stays DM-free in both directions without new knobs. No
other configuration: eligibility, note requirement, and opt-out semantics are
fixed behavior, not per-deployment policy.

## 11. Non-goals

- **Cross-channel reply-steer/resume.** Rejected, not deferred. (1) Resume
  rebuilds context from the session's own channel timeline — summary
  coverage, gap backfill since `chat_upper_bound_ts` are all keyed to one
  timeline; a cross-channel resume injects a DM message into a foreign
  context and backfills the wrong gap. (2) The resumed session's
  `send_message` still targets the original channel, so its natural reply to
  the DM user lands in public; fixing that breaks the one-session-one-channel
  invariant everywhere (trigger slots, claim guards, active-session blocks
  are per-timeline). (3) DM users won't use explicit reply affordances, so
  routing needs heuristics whose failure mode is delivering a private DM
  into a public room. The §6 note gives fresh sessions the intent instead;
  `origin_session_id` is stored, so an errand-thread view remains
  reconstructable later if ever wanted.
- **Recipient-visible provenance** (watermarks/signatures): the agent acts
  like a user and frames its own messages.
- **Per-user or per-channel tool permissions**: no enforcement substrate;
  out of scope.
- **Softer mute tiers** ("not right now"): one hard bit with self-service
  reversal; the table can grow granularity later if anyone asks.
- **Join/leave ingestion into timelines; roster persistence in SQLite**:
  rosters stay live-queried per provider.
- **Channel discovery/joining** (join new rooms, accept invites): unchanged.

## 12. Testing

- Unit: resolution ranking + candidate formatting; set ops (union /
  intersection / ordered difference, multi-room flags); `message_ref`
  lifecycle (stash, consume, session death, `message`-wins conflict);
  opt-out gate ordering (fires before resolution), structural authorization
  (trigger sender / interjection sender / stranger); `read_messages` room +
  anchor resolution incl. user-id sugar and visibility refusal;
  context-note validation error before side effects; eligibility
  (shared-channel, DM-counts-as-shared).
- Provider-mocked: Matrix `pending_invite` path; Discord closed-DM error
  mapping; IRC offline-nick pre-flight.
- Docker (`test:docker`): one Matrix end-to-end — resolve, create DM room,
  send, read back with `anchor:"last_self"`, opt out, verify §5.4 error.
