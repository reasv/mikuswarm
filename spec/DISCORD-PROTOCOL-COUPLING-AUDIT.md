# Discord Protocol Coupling Audit

**Status**: AUDIT / REVIEW ARTIFACT — describes the *current* Matrix coupling of the
codebase as of this audit, to inform proposed Discord support. This is not an
implementation spec and defines no built behaviour; it is a coupling map that
subsequent design docs (per root cause) will build on. Nothing here should be
mirrored into ARCHITECTURE.md. Retained in `spec/` as the baseline a later
implementation session reviews its work against.

**Scope**: expand MikuSwarm to add Discord as a first-class second connection
alongside Matrix. This document catalogs where Matrix-protocol assumptions,
mechanics, data types, and shapes are baked into the codebase, subsystem by
subsystem, with file:line citations, severity, and suggested direction.

**Method**: nine parallel subsystem reviews, one per cluster (provider contract and
core types; the Matrix-to-canonical boundary; timeline/routing/triggers; context
assembly and rendering; enrichment/media/link-previews; reactions and emoji;
tools and agent layer; downstream consumer worker pools; storage/config/bootstrap).
The Matrix layer itself (`src/matrix/`) is reviewed only for what it leaks past its
boundary, since it is simply unused for Discord connections.

**Guiding constraint**: MikuSwarm is a public, general-purpose project. Every change
proposed here must land as a generic, default-off upstream feature or config option,
never a Discord-specific hack, so every deployment benefits and the project stays
protocol-agnostic. The `[sandbox].dns` knob is the reference example.

**Severity legend**: **Blocker** (Discord cannot function correctly without this) ·
**Significant** (works wrong or silently degrades) · **Minor** (localized, low-risk) ·
**Cosmetic** (naming/docs/prompt-wording drift).

---

## 0. Protocol reference: Matrix vs Discord

The mismatches this audit turns on:

| Concept | Matrix | Discord |
|---|---|---|
| User identity | Immutable `@user:homeserver` id (semi-readable); per-room display name | Immutable numeric snowflake id (opaque); mutable unique **username** (shown where an MXID would be); per-guild **nickname** |
| Channel identity | Homeserver-qualified room id; may or may not belong to a Space | Numeric snowflake channel id; always belongs to exactly one immutable **guild** (id + name); never multiple, never changes |
| Container | Spaces are optional and multiple | Guild is mandatory and single (roughly a required, single Space) |
| Encryption | E2EE (megolm sessions, device keys, re-decryption) | None |
| Media per message | One attachment per message | Multiple images + non-media files per message (up to 10) |
| Media reference | `mxc://` URI, downloaded/decrypted via native client | Plain HTTPS CDN URL |
| Link previews | No enrichment on the message; Synapse serves a client-side `preview_url` endpoint | No client preview endpoint; Discord supplies its own embeds; our client must work with no homeserver present, so enrichment needs a direct-HTTP fallback |
| Reactions | Arbitrary key (any unicode, any custom `:shortcode:`/mxc image, or text); each reaction is its own `m.reaction` event with an id | Restricted: unicode is free, custom emoji limited to the bot's usable set (guild emoji, Nitro-like privileges); identified by numeric id `<:name:id>`; no per-reaction event id (keyed by message+emoji+user) |
| Accounts | User accounts only | Bot vs user accounts distinct (different permissions, rate limits, API scopes) |
| Edits | `m.replace` relation event | Message-update event carrying the new message object |
| Formatting | HTML body (`org.matrix.custom.html`) | Discord markdown dialect (no HTML) |
| Threads | Sub-timelines of a room (`:thread:` sub-key) | Standalone channels with their own snowflake ids |
| History | Backward pagination tokens (`next_batch`) | before/after snowflake message-id pagination |

---

## 1. Executive summary: the shape of the problem

The `ChatProvider` interface (`src/types.ts:210-218`) exists and its send/receive
happy path is genuinely provider-neutral. The problem is that the rest of the
codebase reaches around that interface: it parses Matrix-shaped strings directly,
imports `MatrixNativeClient` into tool contexts, and calls two escape-hatch methods
(`getClient`, `getEnrichmentCapabilities`) that are not on the interface at all.

The roughly forty Blocker and Significant findings below collapse into **8 recurring
root causes**. Fixing those unblocks most subsystems, because they are all downstream
of the same handful of leaks. Two framing conclusions:

- **Multi-attachment is already mostly supported** structurally. `AttachmentMeta` is
  an array everywhere, the renderers and download loop iterate all attachments, and
  captioning treats each as an independent asset. The trigger-hold machinery the
  original question worried about is largely reusable; only one app-level scan is pure
  Matrix scaffolding.
- **Several Matrix-only paths are cleanly gate-able** rather than blocking:
  re-decryption, the `undecryptable` field, and backfill's pagination-token model.

### The 8 root causes

1. **RC1 — `timelineKey` is a parseable Matrix string, not an opaque key.** Parsed by
   `^matrix:` regex in 12+ places outside `src/matrix/`; non-Matrix keys silently
   no-op instead of erroring. The keystone; radiates into 5 subsystems.
2. **RC2 — No provider registry; `provider: "matrix"` hardcoded.** Single
   `new MatrixProvider()`; two load-bearing methods off-interface; synthetic events
   hardcode the provider string.
3. **RC3 — Identity is two-field; Discord needs three** (`id` snowflake, `username`,
   `displayName` nick). ARCHITECTURE.md already documents a `username` field that the
   code never landed.
4. **RC4 — 12 tools inject `MatrixNativeClient` directly** and are wired via the
   off-interface `getClient`. Only `send_message` routes through `ChatProvider`, and
   even it leaks Matrix concepts into the model-facing schema.
5. **RC5 — Reaction/emoji storage is structurally Matrix-shaped.** Reaction PK is a
   Matrix event id; custom-emoji identity is `mxc://`; catalog is scraped from Matrix
   HTML; no sendability gate. The one area flagged as not reusable as-is.
6. **RC6 — Enrichment capabilities are Synapse/room-shaped.** `roomId`/`eventId`
   params; link previews via Synapse. Good news: `FetchClient`, Discord CDN patterns,
   and a count-agnostic media pipeline already exist.
7. **RC7 — Config and DB schema hardcode Matrix.** `[matrix]` is a hard top-level key
   under global `additionalProperties: false`; `timeline_key` is the universal
   identity across ~20 tables; `usage_events.room_id`/`space_id` are Matrix-only.
8. **RC8 — Matrix-only subsystems, cleanly gate-able.** Re-decryption, `undecryptable`,
   backfill pagination. Dead weight for Discord, not blockers.

---

## 2. Root causes in detail

### RC1 — `timelineKey` is a parseable Matrix string

Format: `matrix:<accountId>:(room|dm):<roomId>[:thread:<rootId>]`
(`src/storage/timeline-key.ts:11-27`). This is a Matrix-specific encoding, not an
opaque key, and it is parsed directly in at least these places outside `src/matrix/`:

- `src/storage/timeline-key.ts:23-28` — `roomIdFromTimelineKeyOpt`, regex
  `/^matrix:[^:]+:(?:room|dm):(.+?)(?::thread:.+)?$/`. The single shared extractor.
- `src/proactive/scheduler.ts:241-247` — `parseMatrixTimelineKey` (exported as public
  API from `src/proactive/index.ts:6`).
- `src/context/builder.ts:1397-1401` — `resolveSelfUserId` splits the key and reads
  `config.matrix.accounts`.
- `src/enrichment/worker-pool.ts:209-215` — `resolveCapabilityKey` checks
  `parts[0] === "matrix"`.
- `src/timeline/router.ts:32-34` — `isDmTimeline` via `:dm:` substring.
- `src/agent/recovery.ts:637` — session recovery.
- `src/redecryption/index.ts:547-548` — `threadTimelineKeyFrom`.
- `src/backfill/coordinator.ts:148`, `src/backfill/message-backfetch.ts:99` — backfill
  regexes.

The dangerous property: `roomIdFromTimelineKeyOpt` returns `undefined` for any
non-Matrix key, and callers **silently no-op** rather than raise. A Discord key would
therefore cause, all silently:

- Enrichment to skip attachment download and reply resolution
  (`src/enrichment/worker.ts:59,72-77`).
- Captioning to never queue (it is downstream of that download gate).
- Diary to write the raw machine key as the room label (see §10).
- Proactive posting to skip the channel (`src/proactive/scheduler.ts:470-476`).
- `usage_events.room_id` / `space_id` to be null, breaking budget partitioning.

**Direction**: formalize `timelineKey` as
`<provider>:<accountId>:<kind>:<channelId>[:<subKind>:<subId>]`. Move all parsing
behind provider-registered functions exposed through the provider interface. Rename
`roomIdFromTimelineKeyOpt` to a provider-dispatched `channelIdFromTimelineKey` (plus a
`scopeIdFromTimelineKey` for the budget `space_id`/guild case). No code outside a
provider should parse key internals. Consider a first-class `channelType` field on
`InboundChatEvent` (`group` / `dm` / `thread`) so DM detection stops parsing the key.

### RC2 — No provider registry; `provider: "matrix"` hardcoded

`src/app.ts:758` is a single `const provider = new MatrixProvider({...})`; roughly 200
uses point at that one object. Two methods the whole app depends on are **not on the
`ChatProvider` interface**:

- `provider.getClient(target): MatrixNativeClient` — called at `src/app.ts:1215, 1505,
  1519, 1602, 1635, 3299, 4820`. Every session assembly, the redecryption sweep, and
  RoomLabelCache init call it.
- `provider.getEnrichmentCapabilities(accountId): EnrichmentCapabilities` — returns a
  Matrix-shaped capability object (see RC6).

`provider: "matrix"` is hardcoded on synthetic events in:
`src/agent/recovery.ts:666, 672, 680`; `src/backfill/classify.ts:65, 90`;
`src/proactive/scheduler.ts:477, 487, 495`; and branches in `src/app.ts:872, 877, 885`.
The re-decryption startup at `src/app.ts:1594-1644` iterates
`Object.entries(config.matrix.accounts)` directly.

**Direction**: extract an `IChatProvider` interface covering `subscribe`, `send`,
`getClient`, `getEnrichmentCapabilities` (or split those into provider-supplied
capability objects), `start`, `stop`. Hold `providers: IChatProvider[]` in `app.ts`.
Persist provider id with each session (`agent_sessions`) and read it back at resume
instead of assuming Matrix.

### RC3 — Identity is two-field; Discord needs three

`SenderInfo = { id: string; displayName?: string; isSelf?: boolean }`
(`src/types.ts:20-24`). Discord's `id` is an opaque 18-digit snowflake that must never
appear in the prompt, yet it is rendered directly:

- `src/context/renderer.ts:136` — `["sender", event.sender.id]` as the XML `sender=""`
  attribute.
- `src/context/renderer.ts:414-419, 422-435` — `compactSenderLabel` /
  `compactReply` render `${displayName} (${sender.id})`.
- `src/context/reactions.ts:126-128` — reaction lines fall back to `senderId` when
  `senderDisplay` is null.

Doc/code drift: **ARCHITECTURE.md §5 (line 370) documents `SenderInfo` as
`{ id, displayName, username, isSelf }`, but `username` does not exist in
`src/types.ts`.** The three-field identity was partly designed and never landed.

All identity derivation is MXID-shaped:

- `src/tools/user-profile.ts:1017-1022` — `deriveProviderUsername` only handles
  `provider === "matrix"` (strips `@` and `:homeserver`); returns `undefined`
  otherwise, so Discord profiles get a hash-only slug.
- `src/tools/user-profile.ts:1025-1033` — `buildLegacyMatrixWorkspacePath` regex
  `/^@([^:]+):(.+)$/`.
- `src/budget/user-limits.ts:348-349` — `homeserverOf(userId)` splits on `:`; the
  `{homeserver}` budget partition var yields `""` for Discord snowflakes.
- `src/context/builder.ts:1397-1401` — `resolveSelfUserId` reads
  `config.matrix.accounts[accountId]?.user_id`; returns `undefined` for Discord, so
  the "You" reaction label never fires and any self-gated logic degrades.
- `src/matrix/inbound.ts:73-77` — `role`/`isSelf` from MXID equality against
  `selfUserId`; the `selfUserIds` set at `src/app.ts:1054-1058` is wired to
  `config.matrix.accounts[*].user_id`.
- `src/tools/send-message.ts:175` — hardcodes the bot identity as
  `{ id: "mikuswarm", displayName: "Miku", isSelf: true }`.

**Direction**: add `username?: string` to `SenderInfo` with documented invariants
(`id` = stable opaque key; `username` = stable-ish display alias, mutable over months;
`displayName` = room/guild-scoped nick). Render `username ?? id` everywhere an id is
shown to the model. Update the display-name suppression guard from `displayName === id`
to `displayName === (username ?? id)` (`src/context/renderer.ts:138-139, 415`). Make
username derivation and self-identity provider methods rather than MXID parsing. Bot
self-identity should come from the provider (a `getSelf()` accessor resolved at start),
not from `config.matrix`.

### RC4 — 12 tools inject `MatrixNativeClient` directly

These tools take a concrete `MatrixNativeClient` in their context and are Matrix-only
by construction: `react` (`src/tools/react.ts:3`), `emoji` (`src/tools/emoji.ts:3`),
`channel-info` (`src/tools/channel-info.ts:3`), `create-poll`
(`src/tools/create-poll.ts:3`), `poll-vote` (`src/tools/poll-vote.ts:3`),
`delete-message` (`src/tools/delete-message.ts:3`), `edit-message`
(`src/tools/edit-message.ts:3`), `list-reactions` (`src/tools/list-reactions.ts:3`),
`member-info` (`src/tools/member-info.ts:3`), `pins` (`src/tools/pins.ts:3`),
`read-messages` (`src/tools/read-messages.ts:3`), `set-profile`
(`src/tools/set-profile.ts:4`). They are wired via the off-interface
`provider.getClient(target)` at `src/app.ts:3252-3264`, gated on `target.roomId`.

Only `send_message` routes through `ChatProvider.send`, and even it leaks Matrix into
the model-facing schema (`src/tools/send-message.ts`):

- `:56` description: "Send a message to the current **Matrix room**."
- `:58` "An exact **Matrix user ID like @name:server** in the text is turned into a
  real mention automatically."
- `:59` `html` optional body, auto-generated for `@user:server` mentions. Discord uses
  markdown, no HTML; an HTML body renders as raw text.
- `:61` `reply_to_id`: "**Matrix event ID** to reply to."
- `:17` `MATRIX_MAX_CONTENT_BYTES = 60_000` (Matrix's 65536-byte event limit). Discord
  is 2000 chars (4000 Nitro).
- `:127-135` `attachments` is always an array of one; `media` takes a single path.
  Discord allows up to 10 files in one message.
- `:63` `as_voice` maps to a Matrix voice-message type.

The same "Matrix event ID" / "Matrix user ID" wording appears in the model-facing
descriptions of `react.ts:18`, `edit-message.ts:18`, `delete-message.ts:18`,
`pins.ts:24`, `list-reactions.ts:16`, `read-messages.ts:30`, `poll-vote.ts:18`,
`member-info.ts:16`, `channel-info.ts:15`, and `spawn_session.ts:49`.

**Direction**: define a provider-neutral `ChannelClient` / `ProviderToolContext`
interface (send, react, edit, delete, read history, member info, channel info, pins);
Matrix and Discord each produce one from their native client. Tools take that, not
`MatrixNativeClient`. Gate Matrix-only or asymmetric features (pins with Discord's
50-cap, MSC3381 vs Discord poll API, custom-emoji catalog, `read_messages` via native
SDK) on `ProviderCapabilities`. Inject tool descriptions from provider context so the
model sees the right id format and terminology.

### RC5 — Reaction/emoji storage is structurally Matrix-shaped

- `src/storage/database.ts:7570-7572, 7166-7172` — the `reactions` table PK is
  `reaction_event_id` (the `m.reaction` event's own `$…` id); un-react is a
  single-column tombstone (`UPDATE reactions SET redacted_at = ? WHERE
  reaction_event_id = ?`). The design comment states "A Matrix event id is unique
  across rooms" as the invariant. Discord reactions have **no per-reaction event id**;
  identity is the `(message_id, emoji, user_id)` triple, and message ids are unique
  only per channel.
- `src/storage/database.ts:7591-7592` — `normalized_key` stores `mxc://server/mediaId`
  for custom emoji; all dedup and View-A aggregation group on it. Discord custom emoji
  identity is a numeric snowflake; the same-named emoji in two guilds are different
  objects.
- `src/matrix/emoji-resolve.ts:4-58` — the inbound emoji catalog is populated by
  scraping `<img data-mx-emoticon>` tags from `formattedBody`, extracting
  `mxc://` + shortcode pairs. Discord sends no such HTML; custom emoji appear inline as
  `<:name:id>` / `<a:name:id>` and the catalog must come from the Discord API
  (`GET /guilds/{id}/emojis`, `GUILD_EMOJIS_UPDATE`).
- `src/tools/emoji.ts:14-26` — `emoji_list` returns shortcodes with no sendability
  gate; on Matrix any observed emoji is sendable. Discord restricts custom emoji to the
  bot's usable set.
- `src/tools/react.ts:18-19` — `emoji` accepts free-form `:shortcode:`; resolution
  (`:shortcode:` -> mxc -> `m.reaction`) runs inside the native Rust layer. Discord
  requires a `name:id` pair valid for the target guild and a "can the bot send this?"
  check.
- `src/matrix/reaction-ingest.ts:51` — `timelineKey` composed internally as
  `matrix:${accountId}:room:${event.roomId}` (locality hint; should be an injected
  parameter).
- `src/matrix/native-types.ts:33-34`, `src/matrix/provider.ts:422-423` — Rust state
  files `emojiCatalogFile` / `reactionsFile` are Matrix-native persistence.
- `src/context/reactions.ts:100-146` — `synthesizeReactionLines` groups by
  `normalizedKey` and renders `:shortcode:` display, which has no meaning on Discord.
- `src/types.ts:97-103` — `ReactionAggregate.kind: "unicode" | "custom" | "text"` is
  portable, but `normalizedKey` for `custom` implicitly assumes `mxc://` format.

**Direction**: provider-agnostic reaction identity. For Matrix keep the `$` event id;
for Discord construct a synthetic key like `discord:{messageId}:{emojiId}:{userId}`.
Make `normalized_key` an opaque documented contract (unicode: codepoint sequence;
custom: provider emoji id). This is the one area flagged **not reusable as-is**; a
separate `discord_reactions` table (PK on the message/emoji/user triple) is likely
cleaner than extending the Matrix table. Add a per-guild usable-emoji catalog with a
`canBotSend(emojiId, guildId)` gate; `emoji_list` returns id + name + animated flag,
scoped per guild. Resolve emoji at the TS provider level, not in Rust. Extend
`ProviderCapabilities` with `allowedReactionKinds` / `customEmojiScoped`. Handle
Discord bulk-clear events (remove-all, remove-emoji) in the tombstone model.

### RC6 — Enrichment capabilities are Synapse/room-shaped

`src/enrichment/types.ts:10-50` — every non-trivial capability method keys on Matrix
concepts:

- `downloadMedia({ roomId, eventId, outputPath, sizeLimit })` — Matrix RPC: looks up
  the event, resolves `mxc://`, downloads and decrypts via the native module.
- `messageSummary({ roomId, eventId })` — fetches the replied-to message from the
  homeserver.
- `memberInfo({ roomId, userId })` — Matrix membership query (never actually called by
  the worker; safe to drop or stub).
- `resolveLinkPreviews(...)` — calls Synapse's `preview_url`; the worker variable is
  literally `synapseBody` (`src/enrichment/worker.ts:308`).

The gate at `src/enrichment/worker.ts:59, 72-77` skips both download and reply
resolution when `roomId` is `undefined` (i.e. for every Discord event). The
`resolveLinkPreviews` failure is swallowed at `:331`, degrading to zero previews.

**Good news** (already provider-neutral and reusable):

- `src/enrichment/fetch-client.ts` — `FetchClient` provides timeout, size cap, retry,
  proxy, and SSRF guard. Exactly the primitives a direct-HTTP path needs.
- `src/enrichment/linked-media.ts:9-14` — `IMAGE_HOST_PATTERNS` already includes
  `cdn.discordapp.com/attachments/` and `media.discordapp.net/attachments/`.
- `src/enrichment/worker.ts:136-180` — `downloadAttachments` already loops over all
  `event.attachments` with `source_index = index`.
- `src/media/*.ts` — image/video/audio processing operates on one `MediaAssetRow` at a
  time; no single-attachment assumption.
- `src/fxtwitter/*` — fully protocol-neutral, pure HTTPS, no Matrix imports; zero work
  for Discord.
- `src/types.ts:69-83`, `src/storage/database.ts:78-147` — `LinkPreviewMeta`,
  `LinkPreviewRow`, `MediaAssetRow` carry no Matrix-specific fields; `source_kind` is a
  free string, `payload_json` is opaque. `AttachmentMeta.remoteUrl` (`src/types.ts:44`)
  already exists but is never set by the Matrix normalizer.

**Remaining multi-attachment gap**: `src/enrichment/worker.ts:243-289`
(`downloadReplyAttachment`) hardcodes `source_index: 0` and downloads only the first
attachment of a replied-to message; loop over `summary.media[]` to fix for both
protocols.

**Direction**: split `EnrichmentCapabilities` into a channel-neutral `downloadUrl(url)`
(Discord supplies the CDN URL via `AttachmentMeta.remoteUrl`; add `remoteUrl` to the
download params), a neutral reply fetch by channel handle + message id (or populate
`event.replyTo` fully at Discord ingest), and an **optional** `resolveUrlPreviews`
with a direct-HTTP fallback (absent means the framework scrapes `og:`/`twitter:` meta
tags via `FetchClient`). Discord embeds can feed the same `LinkPreviewMeta` with
`source_kind: "discord_embed"`, populated at ingest. Fix the capability routing at
`src/enrichment/worker-pool.ts:209-215` to a provider registry rather than a `matrix:`
prefix check.

### RC7 — Config and DB schema hardcode Matrix

Config (`src/config/schema.ts`):

- `:1362-1367` — `AppConfigSchema.matrix` is a hard top-level key
  (`enabled`, `trigger_hold_ms`, `trigger_group_lookback_ms`, `accounts`).
- `:677-685` — `MatrixAccountSchema` is all Matrix credentials (`homeserver`,
  `access_token`, `password`, `recovery_key`, `user_id`, `device_id`, `store_path`).
- Global `additionalProperties: false`, so an unknown top-level provider block is a
  fatal load error. There is no `providers` array and no `kind` discriminator.
- `:305` — `ProactiveChannelSchema.timeline_key` stores a literal `matrix:...` key, so
  operators must write provider-prefixed keys.

Schema (`src/storage/database.ts`, `LATEST_SCHEMA_VERSION = 4` at `:8304`, inline DDL,
no migration files):

| Table | Coupling | Notes |
|---|---|---|
| `timeline_events.id` | Matrix-only PK format | `matrix:<acct>:<eventId>`; v1->v2 migration queries `id like 'matrix:%'` (`:8339`) |
| `timeline_events.timeline_key` | Matrix-only | universal FK/PK across ~20 tables |
| `timeline_events.provider` | neutral column | only ever written `"matrix"` |
| `timeline_events.event_json` | Matrix-shaped | carries `undecryptable`, `sessionId`, `utdReason`, `htmlBody`, `relatesTo.relType` |
| `timeline_events` E2EE cols | Matrix-only | `redecrypt_attempts`, `is_undecryptable` generated col (`:7955`), `last_edit_timestamp` comment names `m.replace` (`:7928`) |
| `timeline_compaction_state` | Matrix-only | cursor fields store Matrix event ids |
| `room_metadata` | Matrix-shaped | "room" terminology; console labels |
| `reactions` | Matrix-only | see RC5 |
| `backfetch_jobs` | Matrix-only | `cursor_token` = homeserver `next_batch`; `target_kind = 'oldest_decryptable'` meaningless without E2EE |
| `pending_edits` | Matrix-shaped | reusable; comment names `m.replace origin_server_ts` (`:8207`) |
| `agent_sessions` | Matrix-shaped | `trigger_sender_id` holds `@user:server` by convention |
| `usage_events` | Matrix-only cols | `room_id` "bare Matrix room id" (`:7681`), `space_id` "canonical parent space id" (`:7684`), derived via the Matrix regex |
| `usage_event_partitions` | Matrix-only | mirrors parent |
| `summarization_jobs`, `summaries` | Matrix-shaped via key | otherwise neutral |
| `media_assets`, `link_previews`, `reply_contexts` | neutral | `reply_external_id` holds a Matrix event id by convention |
| `chat_index` (FTS5), retrieval/embedding tables | Matrix-shaped indirectly | no direct Matrix columns |

**Direction**: add a `[discord]` config block as a peer of `[matrix]` (least invasive)
or migrate both into a `providers[]` array with a `kind` discriminator. Generalize the
`timeline_key` namespace and the `room_id`/`space_id` derivation (channel id / guild
id for Discord). Add a `provider` discriminator to `backfetch_jobs` and exclude
`oldest_decryptable` for Discord. Plan a DB migration before Discord events touch the
live DB, especially renaming/​generalizing `usage_events.room_id`.

### RC8 — Matrix-only subsystems, cleanly gate-able

- `src/redecryption/index.ts` — the whole sweeper is E2EE-specific (megolm retry, UTD
  tracking, `m.replace`/`m.thread` re-homing). It is a no-op when
  `timeline.redecryption_sweep_interval_ms <= 0` (the default), and it is never called
  with Discord events. It imports `MatrixMessageSummary` and `mediaToAttachment` from
  `src/matrix/inbound.ts` directly; a `kind !== "matrix"` guard at the app
  instantiation site is enough.
- `src/types.ts:155-158` — `undecryptable` is a Matrix E2EE leak on the canonical
  type; the renderer branch (`src/context/renderer.ts:44, 74, 123`) never fires for
  Discord. Move to a `providerMeta` bag or a narrow `unreadable?: { reason }`.
- `src/backfill/*` — `BackfillReadClient` and the pipeline use `MatrixMessageSummary`
  and Matrix pagination tokens; `downloadRoomKeysForRoom?` is E2EE-only (optional,
  omit cleanly). Backfill is injected as a callback (`activation.ts:38`), so a Discord
  or no-op impl slots in without touching the coordinator.

**Direction**: add an `encrypted` (or `supportsBackfill`) capability flag and gate
instantiation on it. Define a generic `BackfillSummary` type and a provider-agnostic
`HistoryPageRequest`/`HistoryPageResult` so Discord can implement before/after
snowflake paging; the `cursor_token` column is already opaque text.

---

## 3. Full subsystem findings

Each subsystem's complete findings follow, with file:line, severity, the Matrix
assumption, what Discord needs, and suggested direction. Findings that duplicate a root
cause are cross-referenced rather than repeated in full.

### 3.1 Provider contract and core canonical types
(`src/types.ts`, `src/chat/index.ts`)

Role: `ChatProvider<Config>` is the interface every network implements;
`CanonicalChatEvent`/`InboundChatEvent` flow inbound; `OutboundTarget`/
`OutboundMessage`/`DeliveryReceipt` flow outbound. This contract sits between
`src/matrix/` and every downstream subsystem. There is exactly one implementation and
it was never tested against a second provider, so Matrix assumptions permeated both the
contract and its consumers.

1. `src/types.ts:20-24` · **Significant** · doc/code drift: `SenderInfo` lacks the
   `username` ARCHITECTURE.md §5 documents. See RC3.
2. `src/storage/timeline-key.ts:11-27` · **Blocker** · `timelineKey` parsed by 12+
   consumers. See RC1.
3. `src/timeline/router.ts:32-34` · **Significant** · `isDmTimeline()` hard-wired to
   `:dm:` substring; controls DM concurrency limit (`src/timeline/trigger.ts:82`) and
   the "direct message" label. Move DM detection into a provider helper or a
   `channelType` field.
4. `src/types.ts:155-158` · **Significant** · `undecryptable` E2EE field on the
   canonical type. See RC8.
5. `src/types.ts:168-175` · **Minor/Cosmetic** · `InboundChatEvent.edit` comment names
   `m.replace`; the mechanism (edit identifies its target by external id) is neutral.
   Rewrite the comment abstractly.
6. `src/enrichment/types.ts:10-50` · **Blocker** · `EnrichmentCapabilities` is
   Matrix-shaped. See RC6.
7. `src/enrichment/worker-pool.ts:209-215` · **Significant** · capability lookup keyed
   on `matrix:` prefix. See RC1/RC6.
8. `src/types.ts:179-184` + `src/matrix/provider.ts:144, 202` · **Significant** ·
   `OutboundTarget.roomId` required by Matrix `send`/`setTyping`; semantically a
   channel id for Discord; no `guildId` field though Discord needs guild scope for
   emoji/member lookups. Rename to `channelId?`, add `serverId?`/`guildId?`.
9. `src/matrix/inbound.ts:73-77` · **Significant** · `isSelf`/`role` from MXID
   equality; `selfUserIds` wired to `config.matrix`. See RC3.
10. `src/tools/send-message.ts:56-61` · **Minor** · tool descriptions name Matrix
    primitives (also `react`, `edit-message`, `delete-message`, `pins`,
    `list-reactions`, `read-messages`, `poll-vote`, `member-info`). See RC4.
11. `src/tools/user-profile.ts:1017-1033` · **Significant** · MXID parsing hardcoded;
    no Discord branch. See RC3.
12. `src/budget/normalize-user-limits.ts:49` · **Significant** ·
    `KNOWN_PARTITION_VARS = ["user_id", "room_id", "homeserver", "space_id"]`;
    `homeserver` and `space_id` are Matrix concepts derived from MXID/Spaces. Budget
    rules scoped to them silently no-match Discord. Formalize a provider-neutral tenant
    concept (Discord guild = Matrix homeserver+space); validate partition template vars
    against what configured providers can supply.
13. `src/types.ts:196-199` · **Minor** · `DeliveryReceipt.externalIds` plural exists
    because Matrix `send` splits text + N media into N events; Discord sends one
    message with one id. Document that plural is for split-send providers.
14. `src/types.ts:204-208` · **Minor** · `ProviderCapabilities.reactions?: boolean` is
    too coarse; Discord supports reactions but restricts custom emoji. Add
    `allowedReactionKinds` / `customEmojiScoped`.
15. `src/tools/member-info.ts:5-8` and the 12 Matrix-native tools · **Blocker** · tools
    take `MatrixNativeClient` directly. See RC4.

Canonical-type verdict: the `ChatProvider` interface survives a second provider with
minor changes; `CanonicalChatEvent`/`OutboundTarget`/`OutboundMessage` are structurally
close to neutral but carry two direct Matrix leaks (`undecryptable`, the `edit`
comment) and one structural assumption (`timelineKey` opaque in name, Matrix-parseable
in fact). The deeper issue is that consumers reach past the canonical types and parse
the key format or call Matrix-native interfaces directly, so the canonical layer as a
whole is not a sound base without the surgical refactors in the root causes.

### 3.2 The Matrix-to-canonical boundary
(`src/matrix/`, reviewed only for leaks)

Role: `MatrixProvider` is the sole concrete `ChatProvider`. Its real obligations exceed
the declared interface via `getClient()` and `getEnrichmentCapabilities()` and via the
Matrix-shaped `timelineKey` its `subscribe()` emits.

Contract a Discord provider must fulfill (beyond the declared interface): supply
`getClient`-equivalent channel actions or have `app.ts` route those through a capability
object; supply enrichment capabilities keyed on channel/message rather than room/event;
emit a provider-neutral `timelineKey`; never require callers to see `undecryptable`;
populate `edit.targetExternalId` on message-update events; provide a rich-body path that
is markdown, not HTML; provide a reaction ingest path (the current one imports
`ingestReactionEvent` directly from `src/matrix/index.js` into `src/app.ts:8`).

Leak findings (those not already in root causes):

1. `src/enrichment/worker-pool.ts:211` · **Blocker** · hardcoded `"matrix"` in
   capability routing. See RC1/RC6.
2. `src/enrichment/types.ts` (whole file) · **Blocker** · Matrix field names. See RC6.
3. `src/backfill/classify.ts:1,3,65,90` · **Blocker** · imports `mediaToAttachment`
   from `src/matrix/inbound.ts`, hardcodes `provider: "matrix"`, uses
   `MatrixMessageSummary` throughout. See RC8.
4. `src/redecryption/index.ts` (whole file) · **Blocker** · E2EE-specific. See RC8.
5. `src/tools/` (12 files) · **Blocker** · `MatrixNativeClient` injected. See RC4.
6. `src/proactive/scheduler.ts:241` · **Blocker** · `parseMatrixTimelineKey`. See RC1.
7. `src/app.ts:8` · **Blocker** · direct import of `MatrixProvider`, `RoomLabelCache`,
   `ingestReactionEvent` from `src/matrix/index.js`. `RoomLabelCache` fetches display
   names via `getDisplayName()` on the native client and has no abstraction;
   `ingestReactionEvent` has no abstraction. Make `RoomLabelCache` a provider-supplied
   optional service; route reaction ingest through the provider's subscribe path.
8. `src/agent/recovery.ts:666,672,680` · **Significant** · hardcodes
   `provider: "matrix"` on synthetic resume events. Persist provider id with the
   session. See RC2.
9. `src/context/renderer.ts:44,74,123` · **Significant** · UTD placeholder and
   `undecryptable` branch in the shared renderer. See RC8.
10. `src/context/builder.ts:1397-1401` · **Significant** · `resolveSelfUserId` parses
    the key and reads `config.matrix`. See RC3.
11. `src/budget/user-limits.ts:348-349` · **Significant** · `homeserverOf()`
    presupposes MXID format. See RC3/§3.1 finding 12.
12. `src/storage/timeline-key.ts:19,34` · **Significant** · `roomIdFromTimelineKeyOpt`
    regex bakes in the Matrix format; used by `database.ts:1117, 3697` for
    `usage_events.room_id`/`space_id`. See RC1/RC7.
13. `src/tools/send-message.ts:17` · **Minor** · `MATRIX_MAX_CONTENT_BYTES`. See RC4.
14. `src/tools/set-profile.ts:43` · **Minor** · `if (source.startsWith("mxc://"))`
    fast-path. Route through a provider `setAvatar(url)` capability.
15. `src/tools/user-profile.ts:1018` · **Minor** · `if (provider === "matrix")`
    localpart branch. See RC3.
16. `src/enrichment/worker.ts:703` · **Minor** · `isMediaMsgtype()` checks Matrix
    `m.image`/`m.video`/`m.audio`/`m.file` strings; verify it operates on
    `event.attachments`, not raw Matrix message types. Variable `synapseMedia` at `:319`
    is Synapse-named in shared code.
17. `src/tools/channel-info.ts`, `member-info.ts` · **Cosmetic** · schema descriptions
    embed Matrix id formats. See RC4.

Direct-import coupling map (every non-`src/matrix/` file importing from `src/matrix/`):

| File | Imports |
|---|---|
| `src/app.ts:8` | `MatrixProvider`, `RoomLabelCache`, `ingestReactionEvent` |
| `src/backfill/classify.ts:1,3` | `mediaToAttachment`, `MatrixMessageSummary` |
| `src/backfill/coordinator.ts:6` | `MatrixMessageSummary` |
| `src/backfill/message-backfetch.ts:12` | `MatrixMessageSummary` |
| `src/backfill/index.ts:5` | `MatrixMessageSummary` |
| `src/redecryption/index.ts:6,7` | `MatrixMessageSummary`, `mediaToAttachment` |
| `src/tools/react.ts:3` | `MatrixNativeClient` |
| `src/tools/emoji.ts:3` | `MatrixNativeClient` |
| `src/tools/channel-info.ts:3` | `MatrixNativeClient` |
| `src/tools/create-poll.ts:3` | `MatrixNativeClient` |
| `src/tools/delete-message.ts:3` | `MatrixNativeClient` |
| `src/tools/edit-message.ts:3` | `MatrixNativeClient` |
| `src/tools/list-reactions.ts:3` | `MatrixNativeClient` |
| `src/tools/member-info.ts:3` | `MatrixNativeClient` |
| `src/tools/pins.ts:3` | `MatrixNativeClient` |
| `src/tools/poll-vote.ts:3` | `MatrixNativeClient` |
| `src/tools/read-messages.ts:3` | `MatrixNativeClient` |
| `src/tools/set-profile.ts:4` | `MatrixNativeClient` |

Plus `parseMatrixTimelineKey` imported into `src/app.ts:121` and
`src/agent/recovery.ts:8` from `src/proactive/index.js`.

### 3.3 Timeline, routing, triggers, edits, echo, activation
(`src/timeline/`, plus the trigger-hold in `src/matrix/provider.ts` and
`resolveTriggerGroup` in `src/app.ts`)

Role: `TimelineStore` owns SQLite append/dedup, in-place edit application, send/echo
merge, and trigger-group persistence. `TimelineRouter` routes inbound events.
`TriggerCoordinator` enforces per-timeline concurrency. `ActivationCoordinator` owns the
inactive->activating->active lifecycle. `AssistantEchoResolver` delegates send/echo
dedup. The hold timer and grouping scan live outside this directory.

1. `src/matrix/provider.ts:306` · **Significant** · trigger-hold key is
   `timelineKey:senderId`; correct for Discord bursts too, but its primary motivation is
   the Matrix one-image-per-event problem. Fully contained in `MatrixProvider`; a
   Discord provider can pick its own hold duration or skip it.
2. `src/app.ts:1976-2013` · **Blocker** · `resolveTriggerGroup` scans backward
   `trigger_group_lookback_ms` for same-sender attachment messages and folds them into
   `groupedEventIds`. Pure Matrix scaffolding for the one-image-per-event problem. On
   Discord the event already carries all attachments; the scan does nothing useful and
   could wrongly fold in an unrelated prior message. Called from `handleInbound`
   (`:1784`), `ActivationCoordinator` (`:4744`), `redispatchCoReply` (`:2563`), and
   reads `config.matrix.trigger_group_lookback_ms` (`:1981`). Make provider-conditional.
3. `src/app.ts:1981` · **Significant** · the group-lookback param is under
   `config.matrix`; runs unconditionally on every trigger. Lift into a
   provider-agnostic namespace or make the scan provider-aware.
4. `src/matrix/inbound.ts:37-45` · **Significant** · key format
   `matrix:accountId:(dm|room):roomId[:thread:rootId]`; the `:dm:` token drives
   `isDmTimeline` and `max_concurrent_dm` (`src/timeline/trigger.ts:81-83`). A Discord
   key `discord:botId:(dm|guild):channelId` works with `isDmTimeline` only if Discord
   uses the same `:dm:` convention; make that explicit in the Discord normalizer.
5. `src/proactive/scheduler.ts:241` + `src/app.ts:868` + `src/agent/recovery.ts:637` ·
   **Significant** · `parseMatrixTimelineKey` called outside `src/matrix/`; returns
   `null` for Discord, degrading proactive scheduling and recovery silently. See RC1.
6. `src/matrix/inbound.ts:113-133` · **Significant** · `detectTrigger` is Matrix
   (`chatType === "direct"`, `mentions.userIds.includes(selfUserId)`); correctly scoped
   inside `src/matrix/`. The canonical trigger types are generic. Discord needs its own
   equivalent (DM channel, `message.mentions` contains the bot).
7. `src/matrix/inbound.ts:55-58` · **Minor** · edit detection
   (`relatesTo.relType === "m.replace"`) is Matrix, correctly scoped. Downstream
   `edits.ts` / `store.applyEdit` operate on `(provider, targetExternalId, replacement)`
   with no Matrix knowledge; a Discord provider sets `inbound.edit = { targetExternalId:
   message.id }` on `MESSAGE_UPDATE` and the rest flows through.
8. `src/timeline/store.ts:161-175, 477-482` · **Minor** · the `ingestAssistantSend`
   comment describes a Matrix-specific DM key mismatch; the lookup at `:182` is
   correctly unscoped and remains correct for Discord. Generalize the comment.
9. `src/timeline/store.ts:476-521` · **Minor** · `findAssistantEchoCandidate` primary
   match is `(provider, externalId)` (generic); the 5-minute fuzzy body-match fallback
   (`:516-521`) is dead for Discord since every send returns an id immediately.
10. `src/app.ts:1935-1948` · **Blocker** · `runInitialBackfill` hardwired to Matrix
    (`config.matrix.accounts[accountId].user_id`, `provider.getClient(target)`, backward
    paging). Injected as a callback via `activation.ts:38`, so a Discord/no-op impl slots
    in cleanly. See RC8.
11. `src/app.ts:870, 3872, 4819` · **Significant** · several generic call sites resolve
    bot self-identity via `config.matrix.accounts[accountId].user_id`, returning
    `undefined` for Discord. See RC3.
12. `src/types.ts:177-184` · **Cosmetic** · `OutboundTarget.roomId` is Matrix
    terminology; semantically holds the target channel. See §3.1 finding 8.

Trigger-hold / multi-media verdict: two separable layers. Layer A (the provider-level
hold timer in `MatrixProvider.emitWithTriggerHold`, `:276-366`) is already encapsulated
and reusable for rapid message bursts; a Discord provider can shorten or skip it. Layer
B (the app-level `resolveTriggerGroup` attachment-lookback scan) is pure Matrix
one-image scaffolding and must become provider-conditional. "One message = many
attachments" needs nothing structural: `AttachmentMeta` is already an array
(`src/matrix/inbound.ts:83`); `awaitTriggerReadiness` waits on `groupedEventIds` then
`countPendingCaptions(eventIds)` (`src/app.ts:2051`), which for a Discord trigger is
just `[inbound.event.id]` counting all N captions on that one event; enrichment
processes all attachments on a single event atomically.

### 3.4 Context assembly and rendering
(`src/context/`)

Role: reads the timeline store and renders `CanonicalChatEvent` records into the
token-budgeted LLM context: a compact prose tier, a rich XML tier, and a satellite
block naming the room and session state. This is where Matrix identity and channel
concepts surface as prompt text.

1. `src/context/renderer.ts:136, 414-419, 422-435` · **Blocker** · `sender.id` emitted
   as the XML `sender=""` attribute and in the compact `Name (id)` parenthetical. For
   Discord this is a meaningless 18-digit snowflake in every line. See RC3.
2. `src/context/builder.ts:1397-1401` · **Blocker** · `resolveSelfUserId` hardcoded to
   `config.matrix.accounts[accountId].user_id`, parsing the key as `matrix:...`; returns
   `undefined` for Discord, so the "You" reaction label (`reactions.ts:126-128`) never
   fires. Inject `selfUserId` as a resolved value into `BuildContextOptions`. See RC3.
3. `src/context/renderer.ts:138-139, 415, 152` · **Significant** · `displayName === id`
   suppression guard; after adding `username`, becomes `displayName === (username ?? id)`.
4. `src/context/reactions.ts:126-128`, `src/matrix/reaction-ingest.ts:53-54` ·
   **Significant** · discrete reaction renderer falls back to `senderId` when
   `senderDisplay` is null; Discord ingest must populate `senderDisplay` with the
   username/nick. `DiscreteReactionRow.senderDisplay` is already nullable, so the fix is
   in the Discord ingest layer only.
5. `src/context/builder.ts:254-257`, `src/context/prompt.ts:234-240`,
   `src/matrix/native-client.ts:183-184` · **Minor** · `resolveChannelContext` is an
   injected hook returning `{ label, isDirect }`; the Matrix impl produces
   `displayName ?? canonicalAlias ?? roomId` + parent space. Discord supplies a concrete
   impl: `channelName (guildName)`, `isDirect=false` for guild channels. Interface is
   generic; the `prompt.ts:229-231` "resolvable Matrix room" comment is doc-level only.
6. `src/context/renderer.ts:97-98, 128-130` · **Non-issue** · `event.attachments` is
   already plural and both tiers iterate all of them; multi-image Discord messages render
   as multiple `<attachment>` blocks with no change.
7. `src/types.ts:133`, `src/context/hydrate.ts:56` · **Cosmetic** · `htmlBody` is stored
   and hydrated but never read by the renderer; Matrix HTML is silently dropped, which is
   harmless for Discord markdown. `htmlBody` serves only `emoji-resolve.ts` at enrichment
   time.
8. `src/types.ts:85-88`, `src/context/renderer.ts:142`, `src/matrix/inbound.ts:136-137` ·
   **Cosmetic** · `mentions.mentionedUserIds` stored but never rendered; only
   `mentionedSelf` reaches the model as `mentions_you="true"`. Trigger detection compares
   ids at normalization time (a provider concern).
9. `src/types.ts:157-158`, `src/context/renderer.ts:74, 123, 44` · **Cosmetic** ·
   `undecryptable` and the "unable to decrypt" placeholder are E2EE-specific; dormant for
   Discord. See RC8.
10. `src/context/prompt.ts:247` · **Cosmetic** · the `Current timeline:` line renders the
    raw `timelineKey`; the LLM can distinguish protocols from the prefix.

Identity-rendering verdict: the two-field model maps Discord's snowflake into `id` and
leaves the renderer to display it, a direct failure. Add `username?: string` to
`SenderInfo`; render `username ?? id` for human consumption; keep raw `id` for DB
correlation and trigger matching only. For Matrix `username` is absent so behaviour is
byte-identical to today. See RC3.

### 3.5 Enrichment, media, link previews, fxtwitter
(`src/enrichment/`, `src/media/`, `src/fxtwitter/`)

Role: an async worker pool that runs post-persistence per event: download attachments via
a provider-supplied `EnrichmentCapabilities`, resolve reply context, fetch link previews
(via Synapse today), partition X.com URLs to the FxTwitter stage, extract direct-media
URLs. Results land in `media_assets` and `link_previews`. `src/media/` is processing
utility called by captioning downstream. `src/fxtwitter/` is pure HTTP.

1. `src/storage/timeline-key.ts:23-28` + `src/enrichment/worker.ts:59, 72-77` ·
   **Blocker** · `roomIdFromTimelineKey` Matrix-only; the worker skips download and reply
   resolution when `roomId` is undefined. The deepest structural coupling. See RC1.
2. `src/enrichment/types.ts:10-14`, `src/matrix/provider.ts:214-227` · **Blocker** ·
   `downloadMedia` is Matrix RPC (mxc lookup + megolm decrypt). `AttachmentMeta.remoteUrl`
   already exists (`src/types.ts:44`) but is never set by the Matrix normalizer. Add
   `remoteUrl` to the download params; Discord fetches it via `FetchClient`. See RC6.
3. `src/enrichment/types.ts:26-45`, `src/matrix/provider.ts:231-234`,
   `src/enrichment/worker.ts:321-334` · **Blocker** · `resolveLinkPreviews` is a Synapse
   round-trip; failure swallowed at `:331`. Interface shape is neutral. See RC6.
4. `src/enrichment/types.ts:17-24`, `src/matrix/provider.ts:228-230`,
   `src/enrichment/worker.ts:183-241` · **Significant** · `messageSummary` fetches the
   replied-to message from the homeserver; Discord supplies it inline, so the Discord
   normalizer can populate `event.replyTo` at ingest, making the capability a no-op.
5. `src/enrichment/worker-pool.ts:209-215` · **Significant** · `resolveCapabilityKey`
   Matrix-format aware; fine if Discord caps are registered under key `"discord"` in
   `providerCapabilities`, which `app.ts` must wire.
6. `src/enrichment/worker.ts:243-289` · **Minor** · `downloadReplyAttachment` hardcodes
   `source_index: 0`; only the first reply attachment is captured. Loop over
   `summary.media[]`.
7. `src/enrichment/linked-media.ts:9-14` · **Minor/good** · `IMAGE_HOST_PATTERNS` already
   includes `cdn.discordapp.com/attachments/` and `media.discordapp.net/attachments/`.
8. `src/enrichment/worker.ts:136-180` · **Minor/good** · `downloadAttachments` iterates
   all attachments with `source_index = index`; multi-attachment ready.
9. `src/fxtwitter/*` · **Clean** · fully protocol-neutral; zero work for Discord.
10. `src/storage/database.ts:78-147`, `src/types.ts:69-83` · **Clean** · `LinkPreviewRow`,
    `MediaAssetRow`, `LinkPreviewMeta` are neutral; `source_kind` free string,
    `payload_json` opaque.
11. `src/enrichment/types.ts:47-49` · **Cosmetic** · `memberInfo` defined but never
    called; safe to drop or stub.

Link-preview verdict: implement a standalone `DirectLinkPreviewClient` using
`FetchClient` (extract URLs, fetch HTML, parse `og:`/`twitter:` meta, optionally fetch
`og:image`). Make `resolveLinkPreviews` optional (absent means direct-HTTP fallback).
Discord embeds map directly to `LinkPreviewMeta`; populate `event.linkPreviews` from
embeds at ingest with `source_kind: "discord_embed"`, optionally carrying a typed embed
payload in `payload_json` mirroring the FxTwitter pattern.

Multi-attachment verdict: main message ready; reply message partial (finding 6); media
processing layer stateless w.r.t. count.

### 3.6 Reactions and emoji
(`src/matrix/reaction-ingest.ts`, `src/matrix/emoji-resolve.ts`, the reaction store,
`ReactionAggregate`, the reaction/emoji tools)

Role: inbound passive observation (Matrix sync -> `ingestReactionEvent` -> `reactions`
table), two render views (View A aggregate counts, View B discrete prose lines), outbound
reaction sending (`react` tool -> `reactMessage` -> Rust), and an emoji catalog built by
observing `<img data-mx-emoticon>` tags and exposed via `emoji_list`.

Full findings are in RC5. Summary of the ten:
1. `src/matrix/reaction-ingest.ts:51` · **Minor** · internal `timelineKey` composition.
2. `src/storage/database.ts:7591-7592` · **Blocker** · `normalized_key` = `mxc://`.
3. `src/storage/database.ts:7570-7572, 7166-7172` · **Blocker** · PK = Matrix event id;
   single-column tombstone.
4. `src/matrix/emoji-resolve.ts:4-58` · **Blocker** · catalog scraped from
   `<img data-mx-emoticon>`.
5. `src/tools/emoji.ts:14-26` · **Blocker** · `emoji_list` has no sendability gate.
6. `src/tools/react.ts:18-19` · **Blocker** · free-form `:shortcode:` assumption;
   resolution in Rust.
7. `src/types.ts:97-103` · **Significant** · `normalizedKey` implicitly mxc for custom.
8. `src/tools/list-reactions.ts:17` · **Significant** · "Matrix event ID"; native
   `/relations`.
9. `src/matrix/native-types.ts:33-34`, `src/matrix/provider.ts:422-423` · **Minor** ·
   Rust state files.
10. `src/context/reactions.ts:100-146` · **Minor** · `:shortcode:` display meaningless on
    Discord.

Emoji-catalog verdict and grafting details: see RC5. Key point: the `reactions` table is
not reusable as-is; a separate `discord_reactions` table (triple PK) is likely cleaner.
`ingestReactionEvent` is nearly provider-agnostic already (it uses pre-resolved
`kind`/`display`/`normalizedKey`/`targetEventId`), so a Discord equivalent can construct a
structurally identical event object with a synthetic reaction key.

### 3.7 Tools and the agent/session layer
(`src/tools/`, `src/agent/`)

Role: 39 tool factories are the model's action surface; `src/agent/` builds and runs
sessions. Tools are wired in `app.ts::buildSessionTools` per inbound event with a
`target: OutboundTarget` derived from a Matrix `timelineKey`. Sessions are keyed per
timeline (`AgentSessionRecord.timelineKey`), one Matrix room per session.

Group A (direct `MatrixNativeClient`, Blocker each): `edit_message`
(`src/tools/edit-message.ts:3-7,18`, `m.replace`), `delete_message`
(`delete-message.ts:3-7,18`, redact + reason; bots need `MANAGE_MESSAGES` on Discord),
`react` (`react.ts:3-7,19`, free-form shortcode), `list_reactions`
(`list-reactions.ts:3-7,16`, `/relations`), `read_messages`
(`read-messages.ts:3-8,30,57`, Matrix pagination tokens vs Discord before/after
snowflakes), `member_info` (`member-info.ts:3-7,16`, membership state has no Discord
analog; identity trichotomy), `channel_info` (`channel-info.ts:3-7,15`, canonicalAlias /
altAliases have no Discord analog), `emoji_list` (`emoji.ts:3-7,21`, room-scoped MSC2545
pack vs guild-scoped), `pins` (`pins.ts:3-7,18,24`, room state vs channel pins, 50-cap),
`create_poll`/`poll_vote` (`create-poll.ts:3-7`, `poll-vote.ts:3-7,18`, MSC3381 vs
Discord poll API with integer answer ids). `set_profile`
(`set-profile.ts:3-10,22-24,43`, Significant): accepts `mxc://` directly; Discord bots
`PATCH /users/@me` with CDN URLs and stricter rename limits.

Group B (`send_message`, Significant): see RC4, findings on description, MXID mentions,
HTML body, size constant, single attachment, `as_voice`.

Group C (`user-profile`, Significant): `senderId` description anchors to MXID
(`user-profile.ts:159`); `deriveProviderUsername` matrix-only (`:1017-1022`); legacy
Matrix path (`:1025-1033`); profiles under `users/<provider>/` (`:841`) but hash-only
slug for Discord. See RC3.

Group D (`spawn_session`/`delegate_to_session`, Minor): `spawn_session.ts:49` and
`session-claims.ts:57` describe `$…` event ids; implementation is provider-agnostic.

Group E (agent layer):
- Session keying / `timelineKey` (`src/proactive/scheduler.ts:241-247`, `src/app.ts:868`,
  `src/storage/timeline-key.ts:23-26`) · **Blocker** · See RC1.
- `resolveChannelLabel` / `resolveChannelContext` (`src/app.ts:1501-1523`) · **Blocker** ·
  hardcoded to `provider.getClient({ provider: "matrix", ... })` then
  `client.channelInfo({ roomId })`. Move to the `ChannelClient` interface.
- `buildSessionTools` wiring (`src/app.ts:3134-3263`) · **Blocker** · unconditionally
  calls `parseMatrixTimelineKey` then `provider.getClient(target)` with
  `target.provider === "matrix"`; Matrix-only tools wired whenever `roomId` present. The
  wiring block must accept a provider-typed client factory.
- `SessionClaim` docstrings (`src/agent/session-claims.ts:28, 57`) · **Cosmetic** ·
  "Matrix external ids"; implementation generic.
- Self-detection / bot-vs-user (`src/app.ts:870`, `src/tools/send-message.ts:175`) ·
  **Significant** · `selfUserId` from `config.matrix`; bot identity hardcoded synthetic.
  Discord bots have distinct scopes, rate limits, and permission gates (delete-others,
  poll voting). See RC3.
- `resolveParentSpaceIds` (`src/app.ts:1210-1222`) · **Significant** · queries Matrix
  Spaces; Discord's analog is the guild. Generalize to return `[guildId]` or remove.

Tool-surface verdict: provider-neutral as-is (no change): `search_messages`,
`expand_summary`, `recap`, `user_activity`, the `memory` family, `diary_tool`,
`summary_tool`, `browser`, `bash`, `file` family, `web`, `x_fetch`, `x_search`,
`danbooru`, `find_source`, `image_gen`, `read_image`, `media`, `character_card` family,
`workspace`, `delegate_to_session`. Need a capability gate + `ChannelClient` impl:
`send_message`, `edit_message`, `delete_message`, `react`, `list_reactions`,
`read_messages`, `member_info`, `channel_info`, `pins`, `set_profile`, `emoji_list`,
`user_profile`. Need reshaping for Discord's model: `create_poll`/`poll_vote`,
`emoji_list`/`react` (restricted emoji), `send_message` html + multi-media,
`channel_info` alias fields.

### 3.8 Downstream consumer worker pools
(`src/retrieval/`, `src/search/`, `src/summarization/`, `src/captioning/`, `src/diary/`,
`src/proactive/`)

Role: the long-lived memory and query layer. Summarization compresses timelines by
`timelineKey`. Diary writes first-person entries to `memory/YYYY-MM-DD.md` with
`## start -> end · TZ · ROOM` headers. Retrieval chunks/embeds those files into
sqlite-vec. Chat-history search maintains an FTS5 `chat_index`. Captioning runs after
media download. Proactive posting runs per-channel timers that synthesize a fake inbound.

Proactive:
1. `src/proactive/scheduler.ts:241-247` · **Blocker** · `parseMatrixTimelineKey` sole
   parser. See RC1.
2. `src/proactive/scheduler.ts:470-476` · **Blocker** · `buildSyntheticInbound` returns
   `skip_unresolved` for any non-Matrix key; Discord channels never get proactive posts.
3. `src/proactive/scheduler.ts:473-474` · **Blocker** · `selfUserId` from
   `config.matrix.accounts`. Add `resolveAccountBotId(provider, accountId)`.
4. `src/proactive/scheduler.ts:479` · **Blocker** · `OutboundTarget` with
   `provider: "matrix"` literal.
5. `src/proactive/scheduler.ts:495` · **Blocker** · `InboundChatEvent` with
   `provider: "matrix"` literal.

Diary + room-label:
6. `src/app.ts:1501-1507` · **Blocker** · `resolveChannelLabel` wired to the Matrix
   client; `roomIdFromTimelineKey` returns undefined for Discord, so it throws before
   reaching the client; the three diary retries (`diary/worker-pool.ts:539-551`) fail.
   Make provider-dispatched (`#channel-name (Server Name)`).
7. `src/diary/worker-pool.ts:553-561` · **Significant** · the final fallback returns the
   raw `timelineKey`, which is written permanently into every diary `## ... · <ROOM>`
   header and the `memory_chunks.room` index, making room-filtered recall useless for
   Discord entries and naming channels by a machine id in prose.
8. `src/storage/timeline-key.ts:23-28` · **Blocker (shared root)** ·
   `roomIdFromTimelineKeyOpt` regex. See RC1.

Search / absence:
9. `src/search/project.ts:15-28` · **Minor** · `parseMentions` stores
   `mentionedUserIds` verbatim in `chat_index.mentions`; MXIDs vs snowflakes coexist
   structurally, but mixed deployments need scoping by `timeline_key` prefix or a
   `provider` column.
10. `src/search/absence.ts:19` · **Minor** · `senderId` treated as opaque (works for
    snowflakes); cross-provider identity is unlinked (per-provider absence; probably
    correct, worth documenting).

Summarization:
11. `src/context/renderer.ts:134-145` · **Minor** · rich renderer writes
    `sender="<id>"`; the model usually uses `display_name` in prose, so raw ids rarely
    land in stored summaries, but it is not enforced.
12. `src/summarization/indexer.ts:77, 103, 113-125` · **Cosmetic** · treats keys as
    opaque; already provider-agnostic.

Retrieval:
13. `src/retrieval/chunk.ts:26-27` · **Minor (inherited)** · `room` inherits the raw-key
    label from finding 7; fixing 6/7 resolves it.
14. `src/retrieval/vector-store.ts:98-100` · **Cosmetic** · KNN partitioned by
    `source = 'memory'`; no provider assumption.

Captioning:
15. `src/captioning/worker.ts:49` + `src/captioning/describe.ts:63-83` · **Minor
    (upstream)** · internally provider-agnostic (reads `local_path`, calls an
    OpenAI-compatible API), but blocked by the enrichment download gate (finding 1 /
    RC1). Fix enrichment; captioning needs no change.
16. `src/captioning/describe.ts:67-70` · **Minor** · one media item per inference call;
    the enrichment pipeline already creates one asset per attachment, so there is no
    multi-image gap, only the upstream download gate.

Derived-memory hygiene verdict: diary headers in `memory/*.md` are the critical
long-lived corruption risk. `resolveChannelLabel` currently returns the raw
`discord:...` key for Discord, permanently baked into flat files and the
`memory_chunks.room` index that drives room-scoped retrieval. Summary content is
relatively clean (LLM-generated prose). `chat_index` sender/mention ids are verbatim, so
mixed deployments need a `provider` discriminator or key-prefix scoping. Three fixes,
each resolving several findings: provider-dispatch `resolveChannelLabel` (6, 7, 13);
provider-key the timeline-key extractor (3, 8, 15); replace the five proactive Matrix
literals (1-5).

### 3.9 Storage, config, bootstrap, backfill, re-decryption, workspace
(`src/storage/`, `src/config/`, `src/bootstrap/`, `src/app.ts`, `src/index.ts`,
`src/backfill/`, `src/redecryption/`, `src/workspace/`)

Role: the data spine and startup layer. `database.ts` owns the schema (single-writer
queue, ~20 tables, inline DDL, `LATEST_SCHEMA_VERSION = 4`). `config/schema.ts` validates
TOML via TypeBox with `additionalProperties: false` everywhere. `app.ts` instantiates the
single `MatrixProvider` and subscribes; there is no provider registry. `backfill/` drives
backward pagination. `redecryption/` polls UTD events. The workspace loader is a pure
filesystem reader with no protocol coupling.

Schema table: see RC7.

Findings:
1. `src/storage/timeline-key.ts:11-25` · **Blocker** · universal `timeline_key` scheme
   and Matrix regex. See RC1.
2. `src/backfill/classify.ts:62, 87` · **Blocker** · `buildEvent`/`buildUtdEvent`
   hardcode `id: matrix:${accountId}:${eventId}` and `provider: "matrix"`; affects the
   `id like 'matrix:%'` migration guard (`database.ts:8339`). Inject provider + id
   constructor.
3. `src/backfill/paginate.ts:10-18` + `src/backfill/classify.ts:1` · **Blocker** ·
   `BackfillReadClient.readMessages` takes/returns Matrix native types; `cursor_token` is
   a homeserver `next_batch`; `target_kind = 'oldest_decryptable'` is meaningless without
   E2EE. Define a provider-agnostic `HistoryPageRequest`/`HistoryPageResult`. See RC8.
4. `src/config/schema.ts:1362-1367` · **Blocker** · hard `matrix` top-level key under
   global strict mode; no `providers` array, no `kind`. See RC7.
5. `src/app.ts:758` · **Blocker** · single `new MatrixProvider(...)`; no interface, no
   registry; re-decryption sweep iterates `config.matrix.accounts`
   (`src/app.ts:1594-1644`). See RC2.
6. `src/storage/database.ts:7574-7609` · **Significant** · `reactions` fully
   Matrix-shaped; build a separate `discord_reactions` table. See RC5.
7. `src/storage/database.ts:7681, 7684` · **Significant** · `usage_events.room_id`
   ("bare Matrix room id") and `space_id` ("canonical parent space id") derived via the
   Matrix regex; repurpose for channel id / guild id and provider-dispatch the derivation.
8. `src/redecryption/index.ts:1-8, 47-51, 97` · **Minor** · imports from
   `src/matrix/inbound.ts`; no-op when `intervalMs <= 0` (default). A `kind !== "matrix"`
   guard at the app instantiation site suffices. See RC8.
9. `src/storage/database.ts:7929` and reaction comments · **Cosmetic** · column comments
   name `m.replace`/`m.thread`/`m.reaction`; generalize.
10. `src/backfill/paginate.ts:11-17` · **Minor** · `downloadRoomKeysForRoom?` E2EE-only;
    optional, omit cleanly for Discord.

Provider-registration verdict (ordered): (1) define `IChatProvider`; (2) generalize the
`timeline_key` scheme and the `channelId`/`scopeId` derivation, the highest-impact schema
change; (3) add a `[discord]` config block as a peer of `[matrix]` with a
`DiscordAccountSchema` (`token`, guild allowlist, etc.); (4) add a `provider`
discriminator to `backfetch_jobs` and exclude `oldest_decryptable` for Discord; (5)
re-decryption stays dormant at `intervalMs = 0`, no migration needed for Discord bring-up;
(6) inject provider + id-prefix into `classify.ts`; (7) a separate `discord_reactions`
table.

---

## 4. Cross-cutting verdicts

### 4.1 Multi-attachment and trigger-hold (the original question)

Mostly a non-issue structurally. `AttachmentMeta[]` is plural everywhere; the rich and
compact renderers loop over all attachments; `downloadAttachments` indexes
`source_index` per attachment; captioning treats each as an independent asset. The
provider-level hold timer is encapsulated in `MatrixProvider` and reusable for rapid
bursts. The only genuine Matrix scaffolding is the app-level `resolveTriggerGroup`
attachment-lookback scan (`src/app.ts:1976`), which must become provider-conditional.
Remaining gaps: `downloadReplyAttachment` hardcodes attachment index 0
(`src/enrichment/worker.ts:252`), and `send_message` needs a `media[]` parameter.

### 4.2 Durable-data corruption risks (address before Discord writes to the live DB)

These persist wrong data that outlives any later code fix:
- Diary headers + `memory_chunks.room` bake `resolveChannelLabel` output permanently;
  for Discord it currently degrades to the raw timeline key. Fix `resolveChannelLabel`
  first.
- `usage_events.room_id`/`space_id` null for all Discord rows, silently no-matching
  budget partition rules.
- Cross-provider id heterogeneity in `chat_index.mentions`/`sender_id` (MXID vs snowflake
  in one column, no `provider` discriminator).
- Profile workspace paths keyed on un-derivable Discord usernames.
- The `timeline_key` namespace generalization and `reactions`/`room_id` changes are DB
  migrations that should land before live Discord traffic.

### 4.3 What is already fine (bounds the work)

`ChatProvider` core interface · `timeline_events.provider` column + `ProviderCapabilities`
struct exist · edit and echo paths are generic once the provider sets
`edit.targetExternalId` and returns an external id on send · `src/fxtwitter/*` fully
neutral · `FetchClient` SSRF-safe HTTP · `linked-media.ts` Discord CDN patterns · media
processing count-agnostic · search/absence/summarization treat keys and ids as opaque
strings · `LinkPreviewMeta`/`MediaAssetRow`/`LinkPreviewRow` neutral · renderers already
iterate all attachments.

---

## 5. Suggested reshape sequencing

Each of these is a candidate `spec/*.md` design doc, and each must land as a generic,
default-off upstream feature.

1. **Provider-neutral `timelineKey`** (RC1) + **provider registry** (RC2). Unblocks
   everything else.
2. **`SenderInfo.username` + provider-owned identity/self** (RC3). Lands the
   already-documented-but-missing field.
3. **`ChannelClient` abstraction under the 12 tools** (RC4).
4. **Enrichment capability split + direct-HTTP previews** (RC6).
5. **Reaction/emoji redesign** (RC5). The deepest schema change; likely a separate
   `discord_reactions` table.
6. **Config `providers[]` + DB migration** (RC7); **capability-gate E2EE/backfill**
   (RC8).

RC1 and RC5 carry the most design surface and warrant their own design docs first.

---

## 6. Open questions for the architect

Deduplicated across the nine reviews:

1. **`timelineKey` scheme**: `discord:<botId>:guild:<gid>:channel:<cid>` mirroring Matrix,
   or flat `discord:<cid>` since channel snowflakes are globally unique? Ripples into the
   capability key, budget `room_id`/`space_id`, and dedup.
2. **First-class `channelType`**: add `group`/`dm`/`thread` to `InboundChatEvent` so DM
   detection stops parsing `:dm:`? Discord DMs and group DMs need a policy (group DM as
   DM timeline with a higher concurrency budget, or a distinct kind).
3. **Threads**: Discord threads are standalone channels with their own snowflakes, not
   `:thread:` sub-keys. Key them as top-level timelines? The `resolveEditTargetTimelineKey`
   LIKE pattern (`threadKeyLikePattern`) would not match otherwise.
4. **Budget partitioning**: Discord analogs for `{homeserver}` and `{space_id}`. Guild id
   is the natural tenant/`space`. Add a generic `{provider_shard}`/`{server_id}` var, or
   leave the Matrix-only vars no-matching for Discord?
5. **Own-message echo**: does Discord's gateway deliver the bot's own sends? If yes the
   send/echo race is live; if the bot intent suppresses echoes, only `ingestAssistantSend`
   runs. Determines whether the echo-merge path is live or dead for Discord.
6. **Feature scope for v1**: polls (MSC3381 vs Discord's 2024 poll API), pins (50-cap),
   voice messages, `set_profile` (bot-account rename limits). Which are in-scope initially
   vs capability-gated-off?
7. **Single DB vs per-provider DB** for a mixed deployment (the `timeline_key` namespace
   keeps rows distinct in a single DB; is that sufficient?).
8. **`ChannelClient` scope**: a thin subset of the methods tools call, or a full provider
   channel client that also handles send/typing? How does it compose with the existing
   `ChatProvider.send`?
9. **`EnrichmentCapabilities` per-provider or per-account** (Synapse preview auth is
   per-account today; Discord CDN/embeds may be per-provider).
10. **Reaction identity**: extend the `reactions` table with nullable columns, or a
    separate `discord_reactions` table with a `(channel, message, emoji, user)` PK? How to
    model Discord bulk-clear (remove-all, remove-emoji) in the tombstone scheme?
11. **`emoji_list` vs `react` coupling**: does `emoji_list` expose the numeric id and
    `react` accept a `name:id` pair, or does `react` resolve a plain name to an id
    internally (hiding the id from the model)? Animated emoji need an `animated` flag.
12. **Room-label format for Discord diary headers**: `#channel (Server)` mirroring
    Matrix's `Room (Space)`, or bare `#channel`? Permanent in `memory/*.md`. Should the
    stored `room` be provider-qualified to avoid `#general`-vs-`#general` retrieval
    collisions across providers?
13. **Profile workspace path for Discord users**: hash-only like the current new-format
    path, or a human-readable username path with alias/redirect support given usernames
    are mutable?
14. **DB migration path**: when the `timeline_key` format is generalized, existing
    `matrix:...` keys already carry the prefix and are unchanged, but the `room_id`
    derivation must be updated for both prefixes. Rename `usage_events.room_id` to
    `channel_id`?
