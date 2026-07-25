# Discord Support — Implementation Design

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md (Providers section and per-subsystem updates); retained for review.
Builds directly on `spec/DISCORD-PROTOCOL-COUPLING-AUDIT.md` (the coupling
baseline; its findings are treated as verified and are cited by root cause
RC1–RC8 and open question Q1–Q14 without re-arguing them). This document makes
the design decisions and settles every open question the audit left to the
architect. Target ARCHITECTURE.md home once implemented: a new "Providers"
section replacing the Matrix-specific parts of §5, plus per-subsystem updates.

**Guiding constraint** (unchanged from the audit): every change lands as a
generic, default-off upstream feature. Matrix-only deployments must be
byte-identical in behaviour after every phase below. Discord is enabled only by
adding a `[discord]` config block.

---

## 1. Goals and non-goals

Goals:

- Discord as a **first-class** provider: the agent runs with Matrix only,
  Discord only, or both. No subsystem may assume a Matrix connection exists.
- Bot accounts only (Discord ToS; user-token automation is out of scope
  permanently, not just for v1).
- The same generic provider contract must later accommodate IRCv3 with far
  fewer features. Nothing in this design implements IRC; the contract is simply
  kept honest by asking "could a provider with no edits/reactions/attachments
  implement this?" at each decision.

Non-goals:

- Cross-provider identity linking (the same human on Matrix and Discord stays
  two users). Per-provider absence/retrieval/profiles are correct and
  documented as such.
- Slash commands, components/buttons, voice channels, presence-rich features.
  The agent is a chat participant, not an application-command bot.
- Sharding. One gateway connection per account; guild counts that require
  sharding are far beyond this project's scale.

---

## 2. Decision summary

Answers to the audit's §6 open questions; each is elaborated in the section
cited.

| # | Question | Decision |
|---|---|---|
| Q1 | `timelineKey` scheme | Universal grammar `<provider>:<accountId>:<room\|dm>:<channelId>[:thread:<threadId>]`, one shared parser. Discord guild id is **not** in the key. §4 |
| Q2 | First-class `channelType` | Yes — `channelType?: "group" \| "dm" \| "thread"` on `InboundChatEvent`; all DM detection moves to the shared parser/field. Discord group DMs are unreachable for bots; treat as `dm` if ever seen. §4.3 |
| Q3 | Threads | `:thread:` sub-keys under the **parent channel** key, exactly like Matrix. Forum/media posts are threads of the forum channel. §4.2, §12.5 |
| Q4 | Budget partitioning | Keep `room_id`/`space_id` columns; redefine semantics as channel-scope/server-scope. New partition vars `{channel_id}`/`{server_id}` (aliases of the old ones, which remain valid). Config load warns when a rule uses a var no enabled provider can supply. §6.4, §11.2 |
| Q5 | Own-message echo | Live: the gateway delivers the bot's own `MESSAGE_CREATE`. Echo-merge by `(provider, externalId)` works as-is; the fuzzy fallback is dead for Discord. §12.7 |
| Q6 | v1 feature scope | See the table in §14. Everything the platform permits and the existing tool surface promises is in v1 (including poll **creation** and outbound voice messages). Excluded: poll **voting** (no bot vote endpoint exists — platform-impossible), global username rename (operational footgun; per-guild nick covers it), thread creation (not a Discord gate — no such tool exists on any provider; separate follow-up feature). |
| Q7 | Single vs per-provider DB | Single DB. Provider-prefixed keys and event ids namespace everything; one writer queue; cross-provider queries stay possible. |
| Q8 | `ChannelClient` scope | Tool-facing per-target action surface obtained from the provider; `ChatProvider.send` remains the only outbound-message path. §7 |
| Q9 | Enrichment capabilities keying | Per account, registry key `<provider>:<accountId>`, derived via the shared parser; the wiring loop iterates all providers. §9.1 |
| Q10 | Reaction identity | **Single `reactions` table.** Discord PK is the deterministic synthetic key `discord:<messageId>:<emojiKey>:<userId>`; un-react reconstructs the PK, so tombstone-by-PK survives. Bulk clears get two new tombstone queries. §10.1 |
| Q11 | `emoji_list` / `react` coupling | The model never sees emoji snowflakes: `emoji_list` returns `:name:` + `animated` flag scoped to the sendable set; `react` resolves `:name:` → id internally. §10.3 |
| Q12 | Diary room label | `#channel-name (Guild Name)`, mirroring `Room (Space)`. No provider prefix; the server name disambiguates. Fallback after retries is `#<channelId>`, never the raw key. §6.6 |
| Q13 | Profile workspace path | `deriveProviderUsername` gains a Discord branch returning the username; directory stays keyed on the stable hash, slug frozen at first observation. No alias/redirect machinery. §6.3 |
| Q14 | DB migration path | No data rewrite: Matrix keys/ids already carry their prefix. Column names are kept with generalized semantics. New rule: every future migration touching provider-shaped data carries an explicit provider predicate. §11 |
| — | `external_id` in the prompt (audit §3.4 finding 11) | **Keep it.** Tools address messages by provider id; that is the one declared exception to "no snowflakes in the prompt". Sender identity, by contrast, always renders as `username ?? id`. §6.2 |

---

## 3. Provider contract v2 and the registry (RC2)

### 3.1 The interface

The existing `ChatProvider` (`src/types.ts:210-218`) is extended and the
off-interface surface is formalized. The constructor-options callbacks
(`onReaction`, `onNativeEvent`, `onDiagnostics`, `onError`,
`resolveReplyTrigger`) become a **host object** passed at `start`; `subscribe`
is subsumed by `host.onEvent`.

```ts
export interface ChatProviderHost {
  onEvent(event: InboundChatEvent): void;
  onReaction(event: ReactionStreamEvent, ctx: { accountId: string }): void;
  /** Gateway/sync lifecycle + diagnostics for the console. Optional to emit. */
  onNativeEvent?(event: ProviderLifecycleEvent, ctx: { accountId: string }): void;
  onDiagnostics?(diagnostics: unknown, ctx: { accountId: string }): void;
  onError(error: unknown, ctx: { accountId?: string; phase: string }): void;
  /** Reply-as-trigger resolver (RESUMABLE-SESSIONS §5); provider stays resume-unaware. */
  resolveReplyTrigger?(args: {
    provider: string; externalId: string; timelineKey: string; sender: SenderInfo;
  }): TriggerInfo | undefined;
}

export interface IChatProvider {
  readonly id: string;                        // "matrix" | "discord" | later "irc"
  readonly capabilities: ProviderCapabilities;
  start(host: ChatProviderHost): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, message: OutboundMessage): Promise<DeliveryReceipt>;
  setTyping(target: OutboundTarget, typing: boolean): Promise<void>;

  accountIds(): string[];
  /** Resolved at start; replaces every config.matrix.accounts[*].user_id read. */
  getSelf(accountId: string): SelfIdentity | undefined;   // { id, username?, displayName? }
  /** Shape test for budget enforceability etc.: "is this one of my user ids?" */
  ownsUserId(id: string): boolean;

  /** Tool/action surface for one target; undefined when the target is foreign. */
  channelClient(target: OutboundTarget): ChannelClient | undefined;
  /** Enrichment capability object for one account (§9). */
  enrichment(accountId: string): EnrichmentCapabilities | undefined;
  /** History paging for backfill/read_messages; absent when capabilities.history is false. */
  history?(target: OutboundTarget): HistoryClient | undefined;
}
```

`MatrixProvider` adapts to this shape (mechanical: its existing constructor
options move into the host; `getClient` becomes private). The Rust NAPI module
remains Matrix-internal — Discord is pure TypeScript.

### 3.2 The registry

`src/app.ts` holds `providers: Map<string, IChatProvider>` built from config.
Every current `provider.getClient(...)` / `config.matrix.accounts` /
`provider: "matrix"` literal is replaced by a registry lookup keyed on the
provider segment of the timeline key (via the shared parser, §4) or the
`provider` field already present on events, targets, and sessions. The
synthetic-event sites the audit lists (recovery, backfill classify, proactive,
plus the five positional literals on the backfill edit path) all take the
provider id from the record they are reconstructing, never a literal.

At least one enabled provider is required at startup; zero is a fatal config
error. `agent_sessions` already effectively carries the provider via
`timeline_key`; resume paths read it from there instead of assuming Matrix.

### 3.3 Capabilities become load-bearing

`ProviderCapabilities` is extended and — per the audit's finding that the
struct is currently decorative — the gating sites are required to consult it:

```ts
export interface ProviderCapabilities {
  typing?: boolean;
  reactions?: boolean;
  reactionKinds?: Array<"unicode" | "custom" | "text">;  // matrix: all three; discord: unicode+custom
  customEmojiScoped?: boolean;      // discord: true (guild-scoped sendability)
  mediaUpload?: boolean;
  maxAttachmentsPerMessage: number; // matrix: 1; discord: 10
  maxMessageChars: number;          // chunker limit: matrix 4000 (today's constant); discord 2000
  formatting: "html" | "markdown" | "plain";
  edits: boolean; deletes: boolean;
  pollCreate: boolean; pollVote: boolean; // discord: create true, vote false (no bot vote endpoint)
  pins: boolean; voiceMessages: boolean; threads: boolean;
  history: boolean;                 // read_messages + backfill
  encrypted: boolean;               // gates re-decryption instantiation (RC8)
  linkPreviews: "provider" | "none"; // "none" → framework direct-HTTP fallback (§9.3)
  singleAttachmentPerMessage: boolean; // gates resolveTriggerGroup (§8.4)
  membershipRoster: boolean;        // user_activity include_silent (§7.2)
}
```

The two Matrix-derived size constants in `send_message`
(`MATRIX_MAX_CONTENT_BYTES`, the hardcoded `chunkMarkdownText(body, 4000)`)
become reads of `maxMessageChars` / a provider byte cap.

---

## 4. Timeline keys: one grammar, one parser (RC1)

### 4.1 The grammar

`timelineKey` stays a string (it is the universal FK across ~20 tables and in
countless logs) but its shape is promoted from "Matrix convention" to a
**documented cross-provider grammar**:

```
<provider>:<accountId>:<kind>:<channelId>[:thread:<threadId>]
  provider   [a-z0-9-]+ , no colon
  accountId  operator-chosen config key, no colon
  kind       "room" | "dm"
  channelId  provider-native id; MAY contain colons (Matrix room ids do)
  threadId   provider-native id
```

Matrix keys are already exactly this; **no existing row changes**. Discord:

```
discord:<accountId>:room:<channelId>              guild text channel
discord:<accountId>:dm:<dmChannelId>              DM channel
discord:<accountId>:room:<parentId>:thread:<tid>  thread / forum post
```

The guild id is deliberately **not** in the key: channel snowflakes are
globally unique (audit §0), the key stays short, and guild scope is resolved
via channel metadata (§6.4). Event ids follow the same pattern:
`discord:<accountId>:<messageId>` mirroring `matrix:<acct>:<eventId>`.

### 4.2 The shared parser

`src/storage/timeline-key.ts` becomes the single grammar module (it already
has the "dependency-free leaf" role):

```ts
parseTimelineKey(key):
  { provider, accountId, kind: "room" | "dm", channelId, threadId? } | undefined
buildTimelineKey(parts): string
channelIdFromTimelineKey(key): string | undefined   // replaces roomIdFromTimelineKeyOpt
timelineKindOf(key): "room" | "dm" | undefined
threadKeyLikePattern(roomKey)                        // unchanged; grammar-compatible
```

All 13+ parse sites the audit lists (scheduler, builder, worker-pool, router,
the two `app.ts` DM detectors, recovery, redecryption, backfill,
observability backfetch handlers, the Gate-A `UserLimitContext.roomId`
derivation, the `roomMembers` closure) switch to these functions, and the
backfill key-construction site switches to `buildTimelineKey`. Because Discord
keys use the same `room|dm` kind segment in the same position, every DM
detector, the follow-up-folding gate, `threadKeyLikePattern`, and
`resolveEditTargetTimelineKey` work for Discord with **no per-site logic**.
`roomIdFromTimelineKeyOpt` survives one release as a deprecated alias of
`channelIdFromTimelineKey` to keep the diff reviewable.

Failure mode change: shared-parser misses on a *present but malformed* key now
log a structured warning at each formerly-silent no-op site (the audit's
"silently no-op" hazard), while genuinely-absent keys keep their current
behaviour.

Per-provider parsing beyond the grammar (e.g. Matrix account-config lookup) is
reached through the registry, never by a local regex. `parseMatrixTimelineKey`
is deleted from the public proactive API.

### 4.3 `channelType`

`InboundChatEvent.channelType?: "group" | "dm" | "thread"` is added and
populated by both normalizers. Routing prefers the field when present and falls
back to `timelineKindOf(key)` for stored keys (the common case in workers that
only have a key). Discord bots cannot be added to group DMs; if the API ever
surfaces one, it is treated as `dm`.

---

## 5. Configuration (RC7)

A `[discord]` block is added as a **peer of `[matrix]`** (decision: no
`providers[]` array migration — it buys nothing until a third simultaneous
protocol exists, and IRC will simply add `[irc]` later):

```toml
[matrix]                  # becomes OPTIONAL (Type.Optional); enabled=false or absent = no provider
enabled = false

[discord]
enabled = true            # default false
trigger_hold_ms = 0       # default 0 (Discord messages are self-contained; knob kept for bursts)

[discord.accounts.main]
token = "${DISCORD_BOT_TOKEN}"
application_id = "…"      # optional; for app-emoji lookup
guilds = ["…"]            # optional allowlist of guild ids; absent = all joined guilds
dm_enabled = true         # accept DMs (from users sharing a guild)
member_intent = false     # default off: GUILD_MEMBERS privileged intent (rosters, §7.2)
```

Secrets follow the existing rule: `${VAR}` templating only. The token is
covered by the existing key-name-based redaction (`token` matches). Making
`matrix` optional is the change that delivers "runs with no Matrix at all";
`app.ts` boot iterates enabled providers and instantiates Matrix-only
subsystems (re-decryption, Matrix backfill, Rust client) only when a provider
with `encrypted: true` / the matrix id is present.

---

## 6. Identity (RC3)

### 6.1 Three-field `SenderInfo`

```ts
export interface SenderInfo {
  id: string;           // stable opaque key (MXID / snowflake); DB + trigger matching only
  username?: string;    // stable-ish unique handle; mutable over months (Discord username)
  displayName?: string; // room/guild-scoped nick; freely mutable
  isSelf?: boolean;
}
```

Matrix leaves `username` unset — behaviour byte-identical. Discord sets
`username` = the account username, `displayName` = guild nick ?? global
display name ?? username. ARCHITECTURE.md line 370 vs 705 contradiction is
fixed in the same commit (370 becomes correct; 705 is rewritten).

### 6.2 Rendering rule

Everywhere a human-facing identity is emitted — `sender=""` XML attribute,
`compactSenderLabel`, `compactReply`, reaction lines, refusal templates —
render `username ?? id`. The suppression guard becomes
`displayName === (username ?? id)`. Raw `id` remains in exactly two prompt
places, both deliberate: `external_id` on `<message>`/`<reply_to>` (tools
target messages by provider id — the declared exception) and nowhere else.
`formatTargetRef`'s `[id]` bracket on reaction lines becomes conditional on the
body snippet being absent (audit §3.4 finding 12). The auto-retrieval user lane
keys on `username ?? displayName`, expanded with known prior names via the
identity map (§6.5), so neither nick changes nor username renames orphan diary
history (audit §3.4 finding 13).

### 6.3 Derivation and self-identity

- `deriveProviderUsername`: add a `discord` branch returning `sender.username`.
  Workspace path stays keyed on the stable hash; the human-readable slug is
  frozen at first observation (renames do not move directories; the profile
  body records the current username). No alias machinery.
- Every `config.matrix.accounts[*].user_id` read outside `src/matrix/`
  (`resolveSelfUserId`, `src/app.ts:870/3872/4819`, proactive scheduler,
  `selfUserIds` wiring) is replaced by `provider.getSelf(accountId)` /
  a registry-built self-id set. `send_message`'s hardcoded
  `{ id: "mikuswarm" }` synthetic sender becomes the provider self.

### 6.4 Budget enforceability and partitioning

- **Phase 0 (ships first, standalone)**: `isEnforceableUser`'s
  `startsWith("@")` sigil test is replaced by an injected
  `isUserIdentity: (id: string) => boolean` predicate supplied by the app —
  today built from the Matrix provider alone (same behaviour), later
  `providers.some(p => p.ownsUserId(id))`. JSDoc de-Matrixed. This is the only
  finding whose cost is money spent outside configured limits; it does not wait
  for the registry.
- `homeserverOf` becomes a provider-dispatched partition-var resolver.
  Partition vars: `{channel_id}`/`{server_id}` are added as canonical names;
  `{room_id}`/`{space_id}` remain as aliases; `{homeserver}` stays
  Matrix-only. Config load emits a warning when a `[[user_limits]]`/`[[limits]]`
  rule uses a var that no enabled provider can supply.
- `usage_events.room_id` = channel id from the shared parser (thread keys
  resolve to the parent channel, as today). `usage_events.space_id` = server
  scope: Matrix canonical space (unchanged) or Discord guild id, resolved from
  channel metadata (§6.6). `resolveParentSpaceIds` generalizes to
  `serverIdsFor(timelineKey)` returning `[guildId]` for Discord.

### 6.5 Identity mutation: applying renames gracefully

Usernames, global display names, and guild nicks are all mutable. The bot
renaming *itself* is excluded (§14), but **other people renaming must be
observed and applied**, not merely tolerated. Two facts bound the problem:
every `MESSAGE_CREATE` carries a fresh user object (username, global name) and
member object (nick), so current identity arrives with every message without
any privileged intent; and all storage, budget, and trigger paths key on the
immutable snowflake, so a rename can only ever affect presentation and recall,
never correlation. The failure modes to prevent: the model treating one person
as two, and retrieval orphaning a user's history at the rename boundary.

- **`user_identities` table** (additive DDL, §11.2): PK `(provider, user_id)` →
  current `username`, `display_name`, first/last seen, updated-at — upserted at
  ingest whenever a message shows a change (plus `GUILD_MEMBER_UPDATE` when
  `member_intent` is on; without it, nick changes are picked up on the user's
  next message, which is acceptable). Prior values are kept as alias-history
  rows (bounded).
- **Render-time current-identity resolution**: the context builder resolves
  sender labels (the §6.2 `username ?? id` rule, compact labels, reaction
  lines) through this map, falling back to the per-event stored values. Old
  events therefore render under the person's *current* name, so a renamed user
  is one person in the window, not two. Matrix does not populate the map in
  v1, so the fallback path makes Matrix rendering byte-identical with **no
  config knob** — the behaviour difference falls out of data presence, and
  Matrix (which has the same displayName-drift problem) can opt in later by
  simply upserting.
- **Retrieval alias expansion**: the auto-retrieval user lane ORs the current
  name with recent prior names from the alias history, so diary/history recall
  survives renames instead of silently truncating at the rename date. Diary
  prose already written under an old name is left as-is (it is historical
  text); the alias expansion is what makes it findable.
- **Profiles**: workspace dirs are hash-keyed and unaffected; the frozen slug
  is cosmetic. The `user_identities` row is the machine record of "currently
  known as"; profile prose remains the agent's own to update.
- **Operator-side bot rename** (via the Discord developer portal): absorbed
  automatically — self-detection is id-based, and `getSelf` refreshes from
  `READY`/`USER_UPDATE`.

### 6.6 Channel metadata and labels

The Discord normalizer upserts channel metadata at ingest (channel id → guild
id, channel name, guild name) into the existing `room_metadata` table (columns
reused; "room" is now read as "channel"). This makes guild scope derivable
without putting it in the key, and feeds labels:

- `resolveChannelContext` / `resolveChannelLabel` / `RoomLabelCache` become
  provider-dispatched via `ChannelClient.channelInfo`. Discord label:
  `#channel-name (Guild Name)`; `isDirect` from the key kind.
- Diary headers and `memory_chunks.room` therefore record
  `#channel-name (Guild Name)` — permanent data fixed **before** any live
  Discord traffic (§15). The last-resort fallback becomes `#<channelId>`,
  never the raw timeline key.

---

## 7. `ChannelClient` and the tool layer (RC4)

### 7.1 The interface

```ts
export interface ChannelClient {
  react(externalId: string, emoji: string): Promise<void>;      // emoji: unicode or ":name:"
  unreact(externalId: string, emoji: string): Promise<void>;
  listReactions(externalId: string): Promise<ReactionListing>;
  editMessage(externalId: string, body: string): Promise<void>;
  deleteMessage(externalId: string, reason?: string): Promise<void>;
  readMessages(req: HistoryPageRequest): Promise<HistoryPageResult>;
  memberInfo(userId: string): Promise<MemberInfo | undefined>;
  members?(): Promise<SenderInfo[]>;          // present iff membershipRoster
  channelInfo(): Promise<ChannelInfo>;        // { label, serverName?, isDirect, topic?, … }
  pins(): Promise<PinnedMessage[]>;
  emojiList(): Promise<EmojiEntry[]>;         // sendable set only (§10.3)
  createPoll?(…): Promise<…>;                 // present iff pollCreate; discord: poll object on send, plus end-poll
  votePoll?(…): Promise<…>;                   // present iff pollVote; discord: absent (tool not offered)
}
```

All twelve Matrix-native tools switch from injected `MatrixNativeClient` to
`ChannelClient`; `buildSessionTools` wires tools by consulting
`ProviderCapabilities` instead of `roomId`-presence, and `set_profile` (the
one currently wired outside the gate) becomes an explicit provider-level
capability (`provider.setProfile(accountId, …)` — Discord: avatar + per-guild
nick; global username rename excluded). `send_message` keeps routing through
`ChatProvider.send`.

Tool schemas become provider-aware: descriptions are assembled from a small
per-provider terminology bundle (id-format sentence, "room"/"channel" noun,
size limits), so the model sees "Discord message ID" and never "Matrix event
ID" in a Discord session. The `html` parameter is offered only when
`formatting === "html"`; `as_voice` only when `voiceMessages`.

### 7.2 `user_activity` roster

The `roomMembers` closure becomes `channelClient.members()`. For Discord this
requires the privileged `GUILD_MEMBERS` intent, so it is config-gated
(`member_intent`); when absent, `members` is undefined and the tool reports
"roster unavailable on this channel" explicitly instead of silently returning
`[]`.

### 7.3 `send_message` changes

- `media` accepts an array (up to `maxAttachmentsPerMessage`; Matrix sends N
  events as today, Discord one message with N files). Singular stays accepted.
- Chunking uses `maxMessageChars` (Discord 2000), preserving the existing
  fence-aware chunker.
- Mentions: the Matrix `@user:server` exact-match convention generalizes to
  "exact `@username` match against known channel participants" — the Discord
  provider resolves exact `@username` tokens to `<@id>` at send, using its
  member cache / REST member search; unresolved tokens pass through as text.
  Outbound `allowed_mentions` is always restricted to the explicitly resolved
  users (plus the replied-to user), so the model can never trigger
  `@everyone`/role pings.

---

## 8. Inbound pipeline

### 8.1 Normalization (Discord → canonical)

`MESSAGE_CREATE` → `InboundChatEvent`:

- Body: Discord markup translated to the readable vocabulary the rest of the
  system already uses — `<@id>`/`<@!id>` → `@username` (nick for `<@!id>`),
  `<#id>` → `#channel-name`, `<@&id>` → `@role-name`, `<:name:id>`/`<a:name:id>`
  → `:name:` (and the pair recorded into the emoji catalog, §10.2). Raw
  markdown is otherwise kept (`formatting: "markdown"`, no `htmlBody`).
- `sender` per §6.1; `mentions.mentionedSelf` from `message.mentions`.
- Attachments: every attachment → `AttachmentMeta` with `remoteUrl` = CDN URL
  (the audit-confirmed dead field becomes the Discord media path, §9.2).
  Stickers → an image attachment (`remoteUrl` = sticker CDN URL) so captioning
  works. Discord voice messages → `audio` attachment with `durationMs`.
- Embeds → `LinkPreviewMeta[]` with `source_kind: "discord_embed"` populated
  at ingest (§9.3).
- Reply: `referenced_message` (present on gateway reply payloads) populates
  `event.replyTo` fully at ingest, making the `messageSummary` enrichment
  capability a no-op for Discord.
- Poll messages (inbound only, v1): body fallback `[poll] <question> — <answers>`.

### 8.2 Triggers

Trigger = DM channel, direct user mention of the bot, or reply-to-bot via
`host.resolveReplyTrigger` (consulted on every untriggered reply regardless of
hold, so reply-resume works with `trigger_hold_ms = 0`). Role mentions and
`@everyone` do **not** trigger. `detectTrigger` logic lives in the Discord
normalizer, mirroring the Matrix layering.

### 8.3 Edits and deletes

- `MESSAGE_UPDATE` with a non-null `edited_timestamp` →
  `edit: { targetExternalId }` (the generic path the audit confirmed works).
- `MESSAGE_UPDATE` with null `edited_timestamp` is Discord's late-embed
  resolution, **not** a user edit: v1 merges the embeds into the stored
  event's link previews and does not re-trigger; it must never be routed as an
  edit (double-processing hazard worth a test).
- `MESSAGE_DELETE` routes to the same store path Matrix redactions use.

### 8.4 Trigger grouping and hold

`resolveTriggerGroup` (the app-level attachment-lookback scan) runs only when
`capabilities.singleAttachmentPerMessage` — pure Matrix scaffolding stays
Matrix-only; `trigger_group_lookback_ms` stays under `[matrix]`. The
provider-level hold timer is reimplemented trivially in the Discord provider
behind `[discord].trigger_hold_ms`, default 0.

---

## 9. Enrichment, media, link previews (RC6)

### 9.1 Capability registry

`providerCapabilities` is keyed `<provider>:<accountId>`;
`resolveCapabilityKey` derives that from the shared parser. The wiring loop in
`app.ts` iterates every provider's `accountIds()` — fixing the actual defect
the audit isolated (registration, not routing).

### 9.2 Download

`EnrichmentCapabilities.downloadMedia` gains a URL form: when the attachment
carries `remoteUrl`, the worker calls a channel-neutral
`downloadUrl({ url, outputPath, sizeLimit })` implemented once on
`FetchClient` (SSRF guard, size cap, retry — already built). The Matrix
RPC path is unchanged for `mxc://` attachments. The worker's gate stops keying
on `roomId` presence and keys on "what does this attachment/provider need".

### 9.3 Reply summaries and link previews

- `messageSummary`'s return type drops `msgtype` for
  `attachments?: Array<{ mediaType, … }>` (audit's direction), which also
  fixes the `isMediaMsgtype` silent-drop gate and — in the same change —
  `downloadReplyAttachment` loops over all reply attachments instead of
  hardcoding index 0.
- `resolveLinkPreviews` becomes optional. When `linkPreviews: "none"`
  (Discord), a new `DirectLinkPreviewClient` on `FetchClient` scrapes
  `og:`/`twitter:` meta as the fallback for URLs Discord embeds didn't cover;
  ingest-time `discord_embed` previews take precedence per URL.

---

## 10. Reactions and emoji (RC5)

### 10.1 Storage

Single `reactions` table (per the audit's corrected recommendation). The PK
column stores:

- Matrix: the `$…` reaction event id (unchanged).
- Discord: the deterministic synthetic key
  `discord:<messageId>:<emojiKey>:<userId>` where `emojiKey` is the
  `normalized_key` value (below). Because the key is reconstructible from
  `MESSAGE_REACTION_REMOVE`'s `(message, emoji, user)` triple, **un-react
  reuses today's tombstone-by-PK update untouched.**

Bulk clears add two tombstone queries:
`MESSAGE_REACTION_REMOVE_ALL` → tombstone by `target_event_id`;
`…_REMOVE_EMOJI` → tombstone by `(target_event_id, normalized_key)`.

`normalized_key` becomes a documented opaque contract:
unicode → the emoji string (unchanged); Matrix custom → `mxc://…` (unchanged);
Discord custom → `discord:<emojiSnowflake>` (same-named emoji in two guilds
stay distinct). `ReactionAggregate` is unchanged; `display` for Discord custom
is `:name:`.

### 10.2 Catalog

The `<img data-mx-emoticon>` scrape stays Matrix-internal. The Discord
provider builds its catalog from the API: guild emoji for every joined guild
(`GUILD_EMOJIS_UPDATE` / startup fetch) plus application emoji, and records
name↔id pairs observed inline in messages. Emoji resolution happens in the
TS provider (Matrix keeps its Rust path internally).

### 10.3 Sendability and the model surface

`emoji_list` returns only the **sendable** set for the target: the target
guild's emoji plus application emoji, as `:name:` with an `animated` flag —
no snowflakes. `react` accepts unicode or `:name:`; the provider resolves
name → id (target guild first, then application emoji) and returns a clear
error naming near-matches when the emoji isn't sendable. Unicode is
passthrough. `ProviderCapabilities.reactionKinds`/`customEmojiScoped` document
the asymmetry; the reaction tools start consulting them.

---

## 11. Storage and migration (RC7)

### 11.1 What does *not* change

No data rewrite. `timeline_key` and `timeline_events.id` values are already
provider-prefixed; the `reactions` table needs no DDL (the PK column holds the
synthetic key); `media_assets`/`link_previews`/`chat_index`/summaries are
neutral or key-namespaced. `backfetch_jobs` needs no new column — provider is
derivable from the key prefix; the coordinator and console simply refuse/hide
`target_kind = 'oldest_decryptable'` for non-Matrix keys.

### 11.2 What changes

- New `user_identities` table + alias history (§6.5): purely additive DDL,
  populated only by providers that opt in (Discord in v1).
- `usage_events.room_id`/`space_id`: physical names kept, semantics
  generalized to channel/server scope (comments + ARCHITECTURE.md updated; the
  audit's suggested rename is declined as pure churn across the budget
  subsystem for zero behaviour).
- `chat_index` sender/mention ids: already provider-scoped in practice via
  `timeline_key`; queries that aggregate across timelines add key-prefix
  scoping where identity collisions could matter. No new column.
- New standing rule (from the audit's migration-chain finding): any migration
  that reasons about provider-shaped data (like `repairReplyFallbackOverstrip`)
  must carry an explicit provider predicate, not rely on a Matrix-only column
  being absent.

### 11.3 Gate-able Matrix subsystems (RC8)

Re-decryption instantiates only for providers with `encrypted: true`; its
`#probe` non-Matrix-key branch becomes an early logged return, never
`retireUndecrypted` (the audit's latent irreversible-write hazard).
`undecryptable` stays on the canonical type, documented Matrix-only (the
`providerMeta` refactor is declined for now — dormant field, zero Discord
cost). Backfill's Matrix types are replaced in shared code by neutral types:

```ts
interface HistoryPageRequest { cursor?: string; limit: number }   // cursor: next_batch | snowflake
interface HistoryPageResult  { messages: HistorySummary[]; nextCursor?: string }
interface HistorySummary     { externalId; sender: SenderInfo; timestamp; body;
                               attachments?: AttachmentMeta[]; replyToExternalId?; edited? }
```

`BackfillReadClient` is retyped on these; the Matrix impl adapts its NAPI
types at the provider boundary; `downloadRoomKeysForRoom` stays an optional
Matrix extra. `classify.ts` takes injected provider id + id-constructor.
The Discord `HistoryClient` implements before-snowflake paging
(`GET /channels/{id}/messages?before=…`), giving both `read_messages` and
initial-activation backfill for free.

---

## 12. The Discord provider (`src/discord/`)

### 12.1 Library and connection

**discord.js v14** — the latest **stable** major as of this design (14.25.x,
July 2026; v15 is pre-release with its milestone incomplete and is explicitly
not production-recommended — plan a migration once it stabilizes). Alternatives
considered and rejected: Eris/Oceanic.js (smaller ecosystems, weaker typing);
`@discordjs/core`+`rest`+`ws` (the same team's modular low-level stack — viable,
but we want the managed cache for thread-parent resolution, member lookup, and
the emoji catalog, and the modular stack means hand-writing that glue for no
gain); raw gateway (buys nothing but bugs). One client per configured account,
with cache limits tuned down to what §12.5/§7.3/§10.2 need — the timeline
store, not the library cache, remains the source of truth for history. Reconnect/resume is discord.js's job; state
transitions surface via `host.onNativeEvent` (ready, resumed, disconnected,
rate-limit warnings) so the console shows gateway health the way it shows sync
health today.

### 12.2 Intents

Default: `Guilds`, `GuildMessages`, `DirectMessages`, `MessageContent`
(privileged — required, documented in the setup guide), `GuildMessageReactions`,
`DirectMessageReactions`, `GuildExpressions`. `GuildMembers` (privileged) only
when `member_intent = true`.

### 12.3 Scoping

`guilds` allowlist filters every inbound event and the emoji catalog. DMs are
accepted when `dm_enabled` (Discord only delivers DMs from users sharing a
guild with the bot).

### 12.4 Outbound

`send` maps `OutboundMessage` → one Discord message: content (chunked at
2000), up to 10 files, `message_reference` for replies, restricted
`allowed_mentions` (§7.3). Returns the REST-response message id as
`externalId`. `setTyping` uses the typing endpoint, refreshed every ~8s while
active.

Voice messages (`as_voice`): Discord's format is strict — a single audio
attachment, ogg/opus, message flag `IS_VOICE_MESSAGE` (8192), empty text
content, and `duration_secs` + base64 `waveform` metadata on the attachment.
The provider transcodes via the existing ffmpeg media pipeline and computes the
waveform (peak samples, ≤256 bytes) at send. Bounded work; kept in v1 because
`as_voice` is an existing model-facing parameter and dropping it silently would
be a parity hole.

### 12.5 Threads

Messages arriving with `channel_id` = a thread resolve the parent via the
channel cache (REST fetch on miss) and key as
`…:room:<parentId>:thread:<threadId>`. Replies into a thread target the thread
channel id. Forum posts are threads of the forum channel. v1 responds within
existing threads; *creating* threads is a new cross-provider capability (no
such tool exists for Matrix either) and gets its own follow-up spec (§14).

### 12.6 Reactions

`MESSAGE_REACTION_ADD/REMOVE` → `host.onReaction` with pre-resolved
`kind`/`display`/`normalizedKey`/synthetic key (the audit confirmed
`ingestReactionEvent` is nearly provider-agnostic); bulk-clear events call the
two new tombstone paths (§10.1).

### 12.7 Echo

Own `MESSAGE_CREATE`s flow through the normal inbound path with
`isSelf: true`; echo-merge matches on `(provider, externalId)`. No fuzzy
fallback needed.

---

## 13. IRCv3 outlook (design check only — nothing implemented)

The contract above survives an IRC provider by construction: key
`irc:<acct>:room:<#channel>` / `irc:<acct>:dm:<nick>` fits the grammar (IRC
channel names cannot contain `:` in practice; validated at key build);
capabilities collapse to `formatting: "plain"`, `maxMessageChars` ≈ 400,
`maxAttachmentsPerMessage: 0`, `edits/deletes/pins/polls/threads/history:
false`, `reactions` possibly via `draft/react` later; `ChannelClient` shrinks
to `memberInfo`/`members`/`channelInfo`; enrichment is links-only via the
direct-HTTP preview fallback. The one IRC-specific wrinkle — the nick *is* the
identity and is mutable — is absorbed by `SenderInfo` (`id` = nick or
account-name where available, `username` = nick), and is explicitly deferred.
No IRC accommodation beyond keeping these capability switches honest is built
now.

---

## 14. v1 Discord feature scope

| Feature | v1 | Notes |
|---|---|---|
| Send / reply / chunked markdown | ✅ | 2000-char chunks, fence-aware |
| Multi-file send (≤10) | ✅ | `send_message.media[]` |
| Mentions (exact `@username`) | ✅ | restricted `allowed_mentions` |
| Edit / delete own messages | ✅ | delete-others surfaces permission errors |
| Reactions + custom emoji + catalog | ✅ | sendability-gated, §10 |
| `read_messages` / pins / member_info / channel_info | ✅ | pins note the 50 cap |
| Threads (respond within) | ✅ | creation gated off |
| Inbound edits / deletes / embeds / stickers / voice msgs | ✅ | §8 |
| Link previews (embeds + direct-HTTP fallback) | ✅ | §9.3 |
| Initial-activation backfill | ✅ | before-snowflake paging |
| Proactive posting | ✅ | falls out of RC1/RC2 fixes |
| Typing indicator | ✅ | |
| `set_profile` (avatar, guild nick) | ✅ | global rename excluded — see below |
| Per-user budgets / partitions | ✅ | Phase 0 + §6.4 |
| Poll creation (`create_poll`, reshaped) | ✅ | poll object on send + end-poll; schema reshaped (question, ≤10 answers, duration, multiselect) |
| Outbound voice messages (`as_voice`) | ✅ | ogg/opus + waveform via existing ffmpeg pipeline, §12.4 |
| Poll voting (`poll_vote`) | ❌ impossible | the Discord API has no endpoint for bots to vote; tool not offered on Discord sessions (`pollVote: false`) |
| Global username rename (bot renaming itself) | ❌ deliberate | usernames globally unique + rename rate-limited (~2/hr): a model-invocable rename can permanently lose the handle to a snipe or fail on collision. Per-guild nick covers the visible effect; the global handle stays operator-controlled. **Inbound** renames (other users, or the operator renaming the bot) are fully observed and applied — §6.5 |
| Thread creation | ❌ not a Discord gate | no create-thread tool exists on *any* provider (Matrix threads are only replied-into). A new cross-provider capability → its own follow-up spec |
| Group DMs | n/a | unreachable for bots |
| Sharding | n/a | out of scope |

Scope philosophy: v1 includes everything the platform permits and the existing
tool surface promises. The only exclusions are one API impossibility, one
operational footgun, and one genuinely-new feature that is out of scope for a
parity milestone.

---

## 15. Durable-data ordering (must hold before live Discord traffic)

From audit §4.2, restated as hard sequencing constraints — all are satisfied
by the phase order in §16, but they are the invariants to re-check at bring-up:

1. Phase 0 budget predicate landed (money outside limits is unrepairable).
2. `resolveChannelLabel` provider-dispatched (diary headers / `memory_chunks.room`
   are permanent).
3. `usage_events` channel/server derivation generalized (budget partitioning).
4. Reaction synthetic-key + bulk-clear paths landed.
5. Profile username derivation landed (workspace paths are sticky).

---

## 16. Implementation sequencing

Each phase is one implementation session / PR, lands green
(`tsc --noEmit` + tests), and leaves Matrix-only behaviour identical. Phases
1–6 are pure generalization (testable against Matrix alone); phase 7 is the
payoff.

- **Phase 0 — budget enforceability predicate** (§6.4). Tiny, standalone,
  ships first.
- **Phase 1 — key grammar + shared parser** (§4). Convert all parse/build
  sites; add `channelType`; add the malformed-key warnings. Test: Matrix
  behaviour byte-identical; Discord-shaped keys parse.
- **Phase 2 — provider contract v2 + registry + config** (§3, §5). Host
  object, `IChatProvider`, `providers` map, optional `[matrix]`, `[discord]`
  schema (unused yet), capability-registry wiring per provider, provider ids
  persisted/read on synthetic-event paths.
- **Phase 3 — identity** (§6). `username`, rendering rule, `getSelf`,
  derivations, the `user_identities` map + render-time resolution + retrieval
  alias expansion (§6.5), partition vars. Test: with an empty identity map,
  Matrix rendering is byte-identical.
- **Phase 4 — `ChannelClient` + tool layer** (§7). Re-wire the 12 tools,
  capability gating (including `set_profile`), provider-aware schemas,
  `media[]`, provider size limits, conditional `resolveTriggerGroup`.
- **Phase 5 — enrichment** (§9). `downloadUrl`, `messageSummary` reshape +
  reply-attachment loop, optional previews + `DirectLinkPreviewClient`.
- **Phase 6 — reactions/emoji generalization + history types** (§10, §11.3).
  Synthetic-PK path, bulk tombstones, catalog interface, neutral
  history/backfill types, RC8 gating.
- **Phase 7 — the Discord provider** (§12). `src/discord/`: gateway client,
  normalizer, send, echo, threads, reactions, emoji catalog, history client,
  diagnostics. Integration-tested against a staging guild before any live
  deployment.
- **Phase 8 — polish**. Console backfetch page (shared parser, hide
  `oldest_decryptable`, neutral wording), doc sweep of remaining
  Matrix-worded tool descriptions, ARCHITECTURE.md consolidation, bring-up
  checklist (§15) verification.

Test additions per phase are part of that phase, plus two cross-cutting ones:
a **no-Matrix boot test** (Discord-only config starts, serves a synthetic
event end-to-end via a fake provider) and a **dual-provider test** (both
registered; events route to the right provider; keys never cross).
