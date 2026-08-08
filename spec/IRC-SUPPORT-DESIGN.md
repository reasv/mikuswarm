# IRCv3 Support — Implementation Design

**Status**: DRAFT — proposed, nothing implemented.
Builds directly on `spec/DISCORD-SUPPORT-DESIGN.md` (the provider contract,
key grammar, identity model, `ChannelClient`/tool gating, and enrichment
capability registry established there are treated as settled and cited without
re-arguing them; its §13 is the design check this document expands into a full
design). Target ARCHITECTURE.md home once implemented: the Providers section
(a new IRC provider subsection), plus per-subsystem notes where marked below.

**Guiding constraint** (unchanged from the Discord work): every change lands
as a generic, default-off upstream feature. Matrix-only and Discord-only
deployments must be byte-identical in behaviour after every phase below. IRC
is enabled only by adding an `[irc]` config block.

---

## 1. Goals and non-goals

Goals:

- IRC as a **first-class** provider alongside Matrix and Discord: the agent
  runs with any subset of the three enabled. No subsystem may assume any
  particular provider exists.
- **Modern IRCv3 servers only.** The provider targets the capability set that
  every mainstream modern ircd family (Solanum, InspIRCd, UnrealIRCd, Ergo)
  ships. It is *not* a goal to function on every IRC server ever deployed;
  it *is* a goal that getting mikuswarm running on a current mainstream
  network requires no special effort. See §3 for the exact line.
- Graceful capability collapse: IRC exercises the low end of the
  `ProviderCapabilities` surface (no edits, no reactions, no attachments,
  no history). The tool layer already degrades on capability flags; this
  design keeps those switches honest rather than inventing workarounds.

Non-goals:

- Solving nick mutability. Identity instability is inherent to the protocol.
  The provider uses the most stable identity the network offers, selected in
  a principled, deterministic manner (§5), and goes no further. Beyond that,
  identity stability is an **operational** concern: the operator can run the
  bot on networks with services, require registration in its channels, or
  gate channel access. mikuswarm does not attempt to out-engineer the
  protocol here.
- Legacy-server compatibility shims (self-echo synthesis, fuzzy own-message
  reconstruction, NickServ-IDENTIFY-and-hope auth). Servers missing the
  required floor get a hard, clearly-worded startup error, not a degraded
  mode (§3.1).
- Draft-spec features as v1 surface: `chathistory`, `draft/react`,
  `draft/reply`, `draft/multiline` are all deferred (§13). v1 consumes only
  ratified, widely-deployed extensions.
- Outbound media of any kind (no uploads exist in IRC; no pastebin/CDN
  side-channel is built). Inbound media arrives only as links and is handled
  by the existing link-preview enrichment path (§9).
- DCC (file transfer or chat), CTCP beyond the minimum in §8.4, server
  operator features, and multi-network aggregation through a single account
  entry (one account = one network connection; bouncers work transparently
  underneath, but mikuswarm itself does not multiplex).

---

## 2. Decision summary

Decisions settled by the operator for this design:

- **D1 — Required capability floor, hard-error enforcement.** The provider
  requires CAP negotiation v3.2 and the caps `server-time`, `message-tags`,
  and `echo-message`. SASL is additionally required whenever credentials are
  configured. A server missing any required cap fails account startup with an
  error naming the missing cap and the server (§3.1). Rationale: these are
  correctness-critical and universally available on modern ircds; a network
  without them is genuinely archaic and should fail loudly, not limp.
- **D2 — Opportunistic caps are auto-detected, never config knobs.** Caps
  beyond the floor (`msgid`, `labeled-response`, `batch`, `account-tag`,
  `account-notify`, `extended-join`, `away-notify`, `chghost`, `setname`)
  are requested when advertised and silently improve internal fidelity when
  present. There is no configuration to enable/disable individual caps; the
  CAP LS response is the single source of truth (§3.2).
- **D3 — Identity ladder.** Per-message identity is the services account when
  the network exposes one (via `account-tag`), else the casemapped nick. The
  selection is deterministic and per-message; the mutable display identity is
  always the nick (§5).
- **D4 — No history in v1.** `history: false`; initial-activation backfill is
  skipped (an existing, tested path). `chathistory` is a follow-up (§13).
- **D5 — Static conservative capability floor.** `ProviderCapabilities`
  stays a static declaration (§6). Opportunistic caps never change the
  tool-visible surface — they only improve message IDs, identity resolution,
  and echo correlation internally. Per-connection dynamic capabilities are
  explicitly deferred until something tool-visible (like chathistory) would
  need them.

---

## 3. IRCv3 capability policy

### 3.1 Required floor (hard error when absent)

Requested and **required** at connect, for every account:

| Cap | Why it is load-bearing |
|---|---|
| CAP negotiation v3.2 (`CAP LS 302`) | prerequisite for everything below; `cap-notify` implied |
| `server-time` | trustworthy timestamps for the timeline (append order, trigger holds, diary/summary boundaries) |
| `message-tags` | the tag transport: carries `account`, `msgid`, `label`, `+typing`; without it half the ladder below cannot exist |
| `echo-message` | the bot must observe its own sends; the timeline echo-merge path (`isSelf: true` inbound flow, match on `(provider, externalId)`) depends on it |
| `sasl` (PLAIN) | **iff** SASL credentials are configured for the account — configured credentials that cannot be used are a misconfiguration, not a degradation |

If, after `CAP LS`, any required cap is missing, the account fails startup
with an error of the form
`irc account "<key>": server <host> does not advertise required capability
"<cap>" — mikuswarm requires a modern IRCv3 server (Solanum, InspIRCd,
UnrealIRCd, Ergo or equivalent)`. This is a per-account failure handled like
any other provider account startup failure; other accounts and providers are
unaffected. A cap withdrawn mid-connection via `CAP DEL` is treated as a
fatal connection error and enters the normal reconnect path (§7.3) — if the
server permanently dropped it, reconnection fails with the same clear error.

All four mainstream server families ship this floor. The one caveat found in
the ircv3.net support matrix: *upstream* Solanum merged `message-tags` /
`batch` / `labeled-response` only in 2025–2026, so a years-stale Solanum
deployment could fail the check. That is the intended behaviour — the error
message is the feature. (Libera.Chat's Solanum lineage has advertised the
floor for years.)

### 3.2 Opportunistic caps (use if present, degrade silently)

Requested when advertised; never configurable; absence changes internal
mechanics only:

| Cap | Present | Absent |
|---|---|---|
| `msgid` | server message IDs used as `externalId` | synthetic IDs (§8.2) |
| `labeled-response` + `batch` | exact send→echo correlation via label | echo matched by (target, body) FIFO against the guaranteed `echo-message` stream (§7.2) |
| `account-tag` | identity ladder rung 1 (§5) | nick-keyed identity |
| `account-notify`, `extended-join` | account↔nick tracking kept current without polling | account learned per-message from `account-tag` only |
| `away-notify` | roster freshness for `user_activity` | staleness acceptable |
| `chghost`, `setname` | hostmask/realname freshness | staleness acceptable |
| `+typing` (client tag) | rides on `message-tags`, which is required — so typing effectively always works | — |

`+typing` note: outbound typing is a `TAGMSG` with the `+typing=active` tag,
refreshed on the same cadence pattern as the Discord typing loop and cleared
with `done`. Whether *recipients* see it depends on their clients; sending it
is always safe.

### 3.3 Explicitly not consumed in v1

`chathistory`, `draft/react`, `draft/reply`, `draft/multiline`,
`draft/relaymsg`, `batch` types beyond what `labeled-response` needs, and
`monitor`. See §13 for which of these are plausible follow-ups.

---

## 4. Timeline keys

Per the shared grammar and parser (`src/storage/timeline-key.ts`), which
already accepts any `[a-z0-9-]+` provider prefix:

- Channel: `irc:<accountKey>:room:<#channel>` — channel name lowercased per
  the network's advertised `CASEMAPPING` for key stability. Channel names
  containing `:` are rejected at key build — a belt-and-braces check: the
  RFC 2812 channel grammar already excludes `:` (along with space, comma,
  and ^G), so such names cannot occur on a conforming server (validated,
  per the §13 design check in the Discord spec).
- DM (query): `irc:<accountKey>:dm:<identity>` — where `<identity>` is the
  ladder result (§5): the services account name when known at first contact,
  else the casemapped nick.

`channelType` is `"group"` for channels and `"dm"` for queries; there are no
threads. One accepted consequence of the DM key rule: a user who first DMs
while logged out and later registers gets a new DM timeline under the account
identity. This is the protocol's identity model showing through and is
accepted (see non-goals); the alias history in `user_identities` (§5.3) keeps
the trail auditable.

---

## 5. Identity

### 5.1 The ladder

Deterministic, applied per message:

1. **Services account** — when the message carries `account-tag` (or the
   sender's account is known from `extended-join`/`account-notify` tracking):
   `SenderInfo.id` = the account name. Stable across nick changes, renames,
   and reconnects.
2. **Nick** — otherwise: `SenderInfo.id` = the nick, casemapped per
   `CASEMAPPING`.

In both cases `SenderInfo.username` = the current nick (the display
identity), so rendering always shows what channel members see, while identity
follows the account when one exists. This is the `SenderInfo` absorption
anticipated by the Discord spec §13, made concrete.

Self-identity follows the same ladder (the bot's own account name via SASL,
else its nick).

### 5.2 `ownsUserId`

The budget-enforceability shape test: an IRC id is a services account name or
nick — by RFC grammar it cannot begin with a digit and never begins with `@`.
This is disjoint from Matrix ids (`@`-prefixed) and Discord ids (all-digit
snowflakes), so the existing predicate style extends cleanly. The predicate
must be **permissive**, not a strict RFC1459 grammar check: on
`CASEMAPPING=precis` networks (Ergo) nicks and account names may be
non-ASCII, so the test is "non-empty, no whitespace/NUL, not `@`-prefixed,
not all-digit" — disjointness from Matrix and Discord is preserved either
way. (A hypothetical all-digit precis nick would simply fail the shape test
and not be recognized as a user identity — a safe, accepted edge.)

### 5.3 `user_identities`

IRC ingest upserts into the existing `user_identities` table (built in
Discord Phase 3, no DDL change): identity key per the ladder, current nick as
username, with alias history capturing NICK changes observed while connected.
This is exactly the "display name changes, identity persists" shape the table
was designed for.

### 5.4 Renames

Inbound `NICK` changes are observed and applied the same way Discord renames
are (Discord spec §6.5): tracked state updates, alias history appended. The
bot renaming *itself* is model-invocable nowhere — like Discord's global
username rename, self-rename is an operational footgun (nick collisions,
services enforcement) and stays operator-controlled via config. There is no
`setProfile` implementation (no avatars in IRC; nick excluded by decision).

---

## 6. `ProviderCapabilities` declaration

Static and conservative (D5):

```ts
{
  typing: true,                    // TAGMSG +typing; rides on required message-tags
  reactions: false,                // draft/react deferred (§13)
  mediaUpload: false,
  maxAttachmentsPerMessage: 0,
  maxMessageChars: 400,            // tool-visible budget; byte-accurate split in §7.1
  formatting: "plain",
  edits: false,
  deletes: false,
  pollCreate: false,
  pollVote: false,
  pins: false,
  voiceMessages: false,
  threads: false,
  history: false,                  // v1; chathistory is a follow-up (§13)
  encrypted: false,
  linkPreviews: "none",            // direct-HTTP preview fallback, as Discord uses
  singleAttachmentPerMessage: false,
  membershipRoster: true,          // NAMES/WHO(X) — no privileged intent concept
}
```

Everything the tool layer needs follows from the flags: no `html` parameter,
no media array, no edit/delete/pin/poll/reaction tools, no `read_messages`,
plain-text send with 400-char chunking. `undecryptable` stays a dormant
field, as it is for Discord.

---

## 7. The IRC provider (`src/irc/`)

### 7.1 Library, connection, outbound

- **Library**: `irc-framework` (the mature client Kiwi IRC and The Lounge
  are built on) — handles CAP negotiation, SASL PLAIN, line parsing/tags,
  and reconnection primitives. Plain JavaScript with no published type
  definitions (no `types` field, no `@types/irc-framework`); the provider
  ships a local `.d.ts` module declaration covering only the surface it
  uses. No NAPI module, unlike Matrix.
- **Connection**: one TCP/TLS connection per account. TLS default on
  (port 6697). On connect: CAP LS 302 → validate floor (§3.1) → SASL if
  configured → REQ floor + advertised opportunistic caps → register → join
  the configured channel list.
- **Outbound sends**: plain text only. The IRC line limit is **512 bytes
  including the server-prepended source prefix and CRLF**, so the usable
  payload per PRIVMSG is `512 − len("​:<own-hostmask> PRIVMSG <target> :\r\n")`.
  The provider learns its own hostmask post-registration (from the
  registration burst or a self-WHO) and computes the real per-target byte
  budget, recomputing it if the server later changes the bot's hostmask
  (cloak application, `CHGHOST`), splitting on UTF-8 boundaries, preferring
  whitespace. The static
  `maxMessageChars: 400` is the conservative tool-visible number; the
  byte-accurate splitter is the enforcement. Multi-line model output becomes
  multiple PRIVMSGs; `DeliveryReceipt.externalIds` carries all of them
  (the multi-id form already exists for Discord chunking).
- **Flood control**: outbound lines go through the library's token-bucket
  throttle with its defaults. No mikuswarm-level knob in v1.
- **Formatting**: outbound never emits mIRC control codes (bold/color/etc.);
  `formatting: "plain"` means plain. Inbound control codes are stripped at
  normalization so the timeline stores clean text.

### 7.2 Echo and message identity

`echo-message` is guaranteed (floor). Own sends therefore arrive back as
normal inbound lines and flow through the standard `isSelf: true` echo-merge
path.

- With `labeled-response`: each PRIVMSG carries a label; the echo arrives
  correlated, and its `msgid` (if any) becomes the `externalId` in the
  `DeliveryReceipt`.
- Without it: a per-target FIFO of pending sends is matched against incoming
  self-echoes by (target, body). Deterministic given IRC's per-connection
  ordered delivery.
- With `msgid`: server IDs are used everywhere an external id is needed.
- Without: the provider synthesizes ids unique within the account
  (server-time + sender + monotonic counter). With `edits`/`deletes`/
  `reactions` all false, ids only serve dedup, echo-merge, and trigger
  bookkeeping — synthetic ids are sufficient.

### 7.3 Reconnection

Auto-reconnect with exponential backoff; on reconnect, re-run the full §3.1
validation and rejoin configured channels. Messages missed while
disconnected are simply absent (`history: false`); this matches the
protocol's own semantics and is accepted for v1 (chathistory backfill is the
§13 follow-up). Netsplits appear as bulk QUITs and are roster-only events —
they are not ingested as timeline messages.

### 7.4 Scoping

Only channels listed in the account's `channels` config are joined and
served. `dm_enabled` gates query handling. There is no equivalent of "all
joined guilds": IRC requires explicit joins, so the join list *is* the
allowlist. Unsolicited channel invites are ignored.

The server-scope id (`serverIdsFor`, usage/budget partitioning) for an IRC
target is the network identity: the `NETWORK` ISUPPORT token lowercased when
advertised, else the configured host. Stable across reconnects; recorded in
durable rows, hence fixed here.

### 7.5 Inbound pipeline

Normalization (IRC → canonical) is a pure mapping, per the established
provider pattern:

- `PRIVMSG` to a joined channel/self → `CanonicalChatEvent` with body,
  sender per §5, timestamp from `server-time`, id per §7.2.
- `CTCP ACTION` (`/me`) → body rendered as the conventional emote form
  (`* <nick> <action>`); it is a normal message event otherwise.
- Other CTCP requests (VERSION, PING, …) are ignored — the bot is a chat
  participant, not a CTCP responder.
- `NOTICE` → in channels: ingested into the timeline as a normal event but
  **never triggers** (IRC convention: notices must not provoke automated
  responses; expressible as-is — the provider populates `trigger` on
  `InboundChatEvent`, so it simply never sets one). In queries: **not
  ingested** — query notices are overwhelmingly services chatter
  (NickServ/ChanServ login and info notices), and ingesting them would mint
  a junk DM timeline per pseudoclient on every connect. Server notices
  (from the server itself, not a user) are never ingested anywhere.
- `TAGMSG` → not ingested (`+typing` is ephemeral presence, not content).
- `NICK` / `ACCOUNT` / `AWAY` / `CHGHOST` / `QUIT` / `JOIN` / `PART` →
  tracked-state and `user_identities` updates only; not timeline events.

Triggers: `dm` for any query message; `mention` in channels on an exact
nick token match (case-insensitive per casemapping) — the conventional
`nick: …` address form and bare-nick word-boundary occurrences both count.
`trigger_hold_ms` defaults to 0 (IRC messages are self-contained lines;
knob retained for rapid-fire bursts, same rationale as Discord).

Reply-as-trigger (`resolveReplyTrigger`) has no native hook — IRC has no
reply concept in v1 — so it is simply never invoked. The "reply to active
session" steering path is likewise inert.

### 7.6 `ChannelClient`

Shrinks to exactly what the capability flags promise:

- `memberInfo(id)` — WHOIS (nick, account, away state, channel prefixes).
- `members()` — present (`membershipRoster: true`): NAMES kept current via
  join/part/quit tracking, enriched with accounts via WHOX where available.
- `channelInfo()` — topic (TOPIC/332), member count, modes summary.

Everything else (`react`, `editMessage`, `pins`, `emojiList`, polls, …) is
absent, and the tool layer already omits the corresponding tools based on
the capability flags — no new gating logic is needed.

### 7.7 Enrichment

`EnrichmentCapabilities`: no attachments to download, no reply context to
resolve; links-only via the existing framework-level `DirectLinkPreviewClient`
fallback (`linkPreviews: "none"`), exactly as Discord uses it for
non-embedded links. Media arriving as URLs benefits from the existing linked
media extraction in that path unchanged.

---

## 8. Configuration

An `[irc]` block is added as a peer of `[matrix]` and `[discord]` — per the
Discord-era decision, no `providers[]` migration; each protocol adds its own
top-level block:

```toml
[irc]
enabled = true              # default false
trigger_hold_ms = 0         # default 0

[irc.accounts.main]
host = "irc.example.org"
port = 6697                 # default 6697
tls = true                  # default true
nick = "mikubot"
username = "mikubot"        # optional; defaults to nick
realname = "mikuswarm"      # optional; defaults to nick
sasl_user = "mikubot"       # optional; presence of sasl_* makes SASL required (§3.1)
sasl_password = "${IRC_SASL_PASSWORD}"
server_password = ""        # optional PASS (bouncers: ZNC/soju user/network syntax)
channels = ["#example"]     # explicit join list = the allowlist (§7.4)
dm_enabled = true           # accept queries
agent = "miku"              # optional agent assignment, as with matrix/discord accounts
```

Schema: `IrcSchema` / `IrcAccountSchema` in `src/config/schema.ts` following
the `DiscordSchema` precedent (StrictObject values, dictionary account keys).
Secrets follow the existing rule: `${VAR}` templating only; `sasl_password` /
`server_password` are covered by existing key-name redaction. Auth is SASL
PLAIN or nothing — no NickServ-IDENTIFY fallback (non-goal).

---

## 9. Storage

Nothing changes. No DDL, no migration:

- Timeline, enrichment, reactions (unused), summaries, retrieval, usage
  tables all key on the opaque provider string and the shared key grammar.
- `user_identities` (Discord Phase 3) is reused as-is (§5.3).
- `room_metadata` gets IRC channel rows via the existing generalized
  `setChannelMetadata` ingest callback (display name = channel name,
  server id/name per §7.4).
- The content-addressed attachment store scopes automatically to the new
  `irc:<account>` prefix (and will see near-zero traffic).

---

## 10. Known structural touch points

The Discord audit/design eliminated ad-hoc provider branching; four small
sites enumerate providers and need an IRC arm, plus the console:

| Site | Change |
|---|---|
| `serverIdsFor()` (`src/app.ts`) | add IRC branch returning the §7.4 network id |
| `deriveProviderUsername()` (`src/tools/user-profile.ts`) | add IRC branch: nick as username |
| terminology selection (`src/app.ts`) | the two-way `discord ? … : MATRIX` ternary becomes a provider→bundle map; add `IRC_TERMINOLOGY` to `src/tools/terminology.ts` (messageIdFmt "message ID", userIdFmt "IRC nick or services account", channelNoun "channel", providerName "IRC", mention note describing bare-nick mentions) |
| `buildMirrorAgentEntries()` (`src/summarization/mirror-worker.ts`) | iterate `config.irc?.accounts` alongside matrix/discord |
| console (`console/src/lib/agents.ts`, `ChannelCell.svelte`) | `platformOf()` / provider chip gain `IRC`; `needsAccountId()` rule for irc keys |

Everything else — timeline store, context builder, enrichment pool, proactive
scheduler, retrieval, search, summarization, diary, budget engine, sandbox,
shared key parser — is provider-agnostic and untouched. The Matrix-only
gap/message backfetch coordinators are irrelevant (`history: false`) and,
being gated on the matrix provider's presence, stay inert.

---

## 11. v1 feature scope

| Feature | v1 | Notes |
|---|---|---|
| Send (plain, byte-accurate chunking) | ✅ | §7.1 |
| Mentions (bare nick) | ✅ | nick in text *is* the mention; no markup exists |
| DMs (queries) | ✅ | identity-keyed timelines, §4 |
| Typing indicator | ✅ | `TAGMSG +typing`, §3.2 |
| Identity ladder + rename tracking | ✅ | §5 |
| `member_info` / `user_activity` roster / `channel_info` | ✅ | §7.6 |
| Link previews (direct-HTTP fallback) | ✅ | §7.7 |
| Proactive posting | ✅ | provider-agnostic, falls out |
| Per-user budgets / partitions | ✅ | §5.2, §7.4 |
| CTCP ACTION inbound | ✅ | emote form, §7.5 |
| Edits / deletes / pins / polls / threads / reactions | ❌ protocol | capability-gated off |
| Media upload / voice messages | ❌ protocol | no upload primitive; no side-channel built (non-goal) |
| History / backfill / `read_messages` | ❌ deferred | chathistory follow-up, §13 |
| Replies (native) | ❌ deferred | `draft/reply`, §13 |
| Self-rename (`NICK` by the model) | ❌ deliberate | operator-controlled, §5.4 |
| CTCP responder, DCC, bouncer multiplexing | ❌ non-goal | §1 |

---

## 12. Durable-data checkpoints

Restating the invariants that touch permanent rows, to re-check at bring-up
(the Discord-era generalizations already satisfy them by design):

1. `SenderInfo.id` per the ladder from the **first** ingested message —
   identity rows, budgets, and DM keys are durable; the ladder must be in
   place before live traffic, not retrofitted.
2. Server-scope id fixed per §7.4 before any `usage_events` rows are written
   for IRC targets.
3. Synthetic-id scheme (§7.2) fixed before live traffic — ids land in
   permanent timeline rows.

---

## 13. Deferred follow-ups (each its own future spec, if wanted)

- **`chathistory`** — flips `history: true` where the network supports it
  (UnrealIRCd, Ergo, soju). This is the feature that would force
  per-connection *tool-visible* capabilities, which D5 defers; a follow-up
  must solve that contract question first.
- **`draft/react` / `draft/reply`** — reactions and native replies on
  networks that relay the client tags. Blocked on the drafts ratifying and
  deploying meaningfully; the reaction storage layer already supports
  synthetic keys (Discord work), so the storage side is ready.
- **`draft/multiline`** — batch-send long messages without chunking.
  Cosmetic; low priority.
- **Per-connection capability variance** — the general form of the
  chathistory problem. Explicitly out of v1 (D5).

---

## 14. Implementation sequencing

Small enough to be one milestone; phases are review checkpoints, each
type-checks and passes tests:

- **Phase 1 — schema + provider core.** `IrcSchema`; `src/irc/` with
  connection lifecycle, floor validation + hard error, SASL, inbound
  normalization, send/chunking/echo-merge, typing. Bot converses in a
  channel end-to-end.
- **Phase 2 — identity + DMs.** The ladder, `user_identities` writes, NICK
  tracking, WHOX account resolution, query timelines.
- **Phase 3 — tool surface + touch points.** `ChannelClient`,
  `IRC_TERMINOLOGY`, the four code sites in §10 (the console row is
  Phase 4).
- **Phase 4 — polish.** Console chip/labels, ARCHITECTURE.md Providers
  section, this spec's status header flipped to IMPLEMENTED.
