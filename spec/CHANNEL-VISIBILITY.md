# Channel Visibility — Design

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §9h; retained for
review. Original target sections were §4 (config schema), §9h (new section),
§9c (diary gate), and §9e (room resolution and per-tool filtering) — all
implemented as designed.

**Settled operator decisions** (2026-08-21): unified `[visibility]` block
(not feature-scoped lists split across `[diary]` and a privacy table); mode
vocabulary `shared` / `no_diary` / `isolated`; explicitly-named excluded
channels are omitted **with a visible note** in tool results, never silently;
diary ranges skipped while a channel was excluded **stay skipped** when the
exclusion is later lifted (terminal status at claim time, no backfill on
config change).

## 1. Motivation

The diary (§9c) is deliberately a single cross-channel store: every channel's
level-1 summary ranges produce entries in the same `memory/YYYY-MM-DD.md`
files, and the recent-diary layer surfaces those entries into **every** chat
session. Two problems follow, in priority order:

1. **Hygiene** (the primary driver). Diary volume is proportional to traffic,
   so one high-traffic channel — or one person who chats with the bot a lot in
   a DM — dominates the shared recency window that every other channel reads.
   Channels with low-quality discourse likewise pollute the shared memory with
   entries nobody wants surfaced elsewhere. The operator needs a per-channel
   "don't diarize this" knob that changes nothing else: the channel stays
   searchable, appears in activity stats, and is summarized normally.

2. **Privacy** (secondary, best-effort). MikuSwarm is a public bot with
   shared state and makes **no privacy guarantee** — but mixing DM
   conversations into public-channel context via the diary, or surfacing DM
   history to a public channel through `search_messages`, is more bad than
   good. The operator can opt a channel into an *isolation* mode: no diary
   entries, and its data is invisible to sessions running on other channels.
   This is policy hygiene, not a security boundary (see §7 Non-goals).

The privacy tier strictly contains the hygiene tier: an isolated channel
**must** also skip the diary, because the diary store is read by every channel
— isolation without diary exclusion would leak the channel's content
everywhere through the recency layer, `recall_memory`, auto-retrieval, and
`search_memory`.

## 2. The cross-channel exposure surface

What "one channel's data visible from another" means in the current codebase
— the complete set of paths this feature must gate:

| Path | Mechanism | Gated by |
|---|---|---|
| Diary write | level-1 summary → `diary_status` queue → entry in shared `memory/*.md`, surfaced everywhere via the recent-diary layer, `recall_memory`, auto-retrieval, `search_memory` | `no_diary` and `isolated` |
| `search_messages` (raw corpus) | `rooms:"all"` or explicit room lists over `chat_index` | `isolated` |
| `search_messages` (`corpus:"summaries"`) | same resolved `timelineKeys` filter over `summaries_fts` | `isolated` |
| `recap` | same rooms resolution (§9e) | `isolated` |
| `user_activity` | defaults to all rooms; per-room count rows | `isolated` |
| `expand_summary` | drills any summary id (ids leak via summary-search hits and recap output) | `isolated` |

Already safe, no changes: `read_messages`, `channel_info`, `member_info`,
`pins`, `list_reactions`, and the summary *layer* are all scoped to the
session's own channel. Summaries continue to be **generated** for every
channel regardless of mode — an excluded channel still needs them for its own
context assembly and for in-channel `recap`.

## 3. Modes

Three ordered levels, resolved per timeline:

- **`shared`** (default) — exactly today's behavior. Diary entries are
  written; the channel is visible to every search path.
- **`no_diary`** — the hygiene tier. The diary worker never writes entries
  for this channel's ranges. Everything else is unchanged: fully searchable
  from anywhere, present in `user_activity`, summarized normally.
- **`isolated`** — the privacy tier. Implies `no_diary`, plus a query-time
  viewer check: the channel's rows (messages, summaries, activity counts) are
  visible **only to sessions running on that same channel** (threads count as
  their parent room, in both directions). The ban is one-directional:
  sessions *in* an isolated channel can still search public channels — the
  DM partner is a community member and the bot is public; only the isolated
  channel's own data is fenced.

## 4. Configuration

```toml
[visibility]
dms = "shared"                # blanket mode for every dm-kind timeline,
                              # any provider/account; "shared" (default) |
                              # "no_diary" | "isolated"

[[visibility.channels]]       # per-channel entries; exact timeline keys,
timeline_key = "..."          # same addressing as [proactive.channels]
mode = "no_diary"             # required; "shared" | "no_diary" | "isolated"
```

**Precedence** (most specific wins): exact `timeline_key` entry → `dms`
blanket (dm-kind timelines only) → `shared`. An exact entry overrides the
blanket in *either* direction — `dms = "isolated"` with one
`mode = "shared"` DM entry re-opens that DM; `dms = "shared"` with one
`mode = "isolated"` DM entry closes just that one.

**Thread inheritance.** A thread timeline (`…:thread:<id>`) always inherits
its parent room's resolved mode. Entries may not carry a `:thread:` suffix —
startup validation fails fast on one (v1 has no per-thread granularity; the
suffix would otherwise silently never match anything the resolver strips).

**Validation** (fail-fast at app wiring, house style):
- every `timeline_key` must parse via `parseTimelineKey` (the shared grammar
  module — no local parsing), with kind `room` or `dm` and no thread suffix;
- no duplicate `timeline_key` entries;
- `mode` and `dms` must be members of the enum.

Keys for channels the bot has not yet seen are **valid** — config routinely
predates channel activation, and the resolver is a pure string-policy lookup
that needs no live channel state.

**Schema addition** (§4 schema shape):

```
visibility?: { dms?,                                  // "shared" (default) | "no_diary" | "isolated"
               channels?: Array<{ timeline_key,      // required; exact key, room/dm kind, no :thread:
                                  mode }> }          // required; same enum
```

`00-defaults.toml` ships the block absent/empty (all-shared) — the feature is
pure opt-in and a deployment that never touches it is byte-identical to
today.

**Agents mode.** The config is global, but timeline keys embed
`<provider>:<accountId>`, so exact entries are naturally per-account (and
therefore per-agent). The `dms` blanket is deliberately global across all
providers, accounts, and agents — a per-agent blanket is deferred until a
deployment actually needs one (it would slot in as an
`[agents.<name>.visibility]` override without changing the resolver seam).

## 5. Resolver (`src/visibility/`)

One small module, built once at config load and injected where needed:

- `ChannelVisibilityResolver.modeFor(timelineKey): "shared" | "no_diary" | "isolated"`
  — strip any `:thread:` suffix (via the shared timeline-key module), then
  exact-entry map → dm-kind blanket → `shared`. A malformed key resolves to
  `shared` and logs `timeline_key.malformed` (the established convention);
  policy must never crash a worker or a tool call.
- `sameChannel(a, b): boolean` — thread-stripped key equality; the viewer
  check for §6.
- `hasIsolation(): boolean` — false when no `isolated` mode is configured
  anywhere; lets every query path keep its exact current shape (including
  `resolveRoomsForAgent`'s legacy `undefined` = no-filter fast path) when the
  feature is unused.

No subsystem consults raw config; everything goes through the resolver, so
the precedence rules live in exactly one place.

## 6. Enforcement

### 6.1 Diary (both `no_diary` and `isolated`)

A new **exclusion gate** in the `DiaryWorkerPool` job body, after claim and
before the existing zero-assistant-message skip-gate: if
`modeFor(job.timeline_key) !== "shared"`, set the row terminal and stop — no
session, no lineage load. Claim-time (not insert-time) evaluation means a
config change applies on the next poll without restart-order coupling, and
`insertSummaryWithLineage` stays unconditional (unchanged), including for
mirrored L1 rows (§9b summary mirroring) — a mirror's diary job is gated by
its own timeline key like any other.

**Terminal status: a new `excluded` value.** `skipped` is reserved
exclusively for the zero-assistant-message case (§9c) and the console
pipelines monitor groups by status — "excluded by operator config" and "bot
didn't participate" are different operational answers to "why is there no
entry?", and conflating them would make *is my visibility config working?*
unanswerable from the monitor. The `summaries.diary_status` CHECK constraint
must therefore widen to
`('pending','processing','done','skipped','failed','excluded')`. SQLite
cannot alter a CHECK in place, so this is a table-rebuild migration —
the same pattern as the v6→v7 `memory_chunks` rebuild: `CREATE TABLE
summaries_new` with the widened constraint, `INSERT … SELECT` preserving
**rowids** (external-content `summaries_fts` addresses by rowid), `DROP` +
`RENAME`, recreate the `summaries_ai`/`summaries_ad` triggers and indexes,
then `INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')`.

**No backfill on un-exclude** (settled decision). `excluded` is terminal;
lifting the exclusion diarizes only ranges summarized from then on. Past
ranges stay `excluded` — a missing diary entry is already an accepted loss
(§9c treats `failed` the same way), and retroactively diarizing a formerly
excluded period is more likely to be the thing the operator explicitly did
not want. The console's diary requeue affordances (single-row requeue,
requeue-failed) must **not** sweep `excluded` rows into `pending`; the
existing failed-requeue path already filters on `diary_status = 'failed'`
and stays that way.

The read side is untouched: entries written *before* a channel was excluded
remain in `memory/*.md` and keep surfacing through the recency layer and
retrieval index until they age out of the window (or the operator hand-edits
the files). Forward-looking only, by design.

### 6.2 Search-layer viewer check (`isolated` only)

Every §9e read path gains the calling session's own timeline key as
`viewerTimelineKey` (already present in tool context as
`currentTimelineKey`). The rule everywhere: a row whose timeline resolves
`isolated` is visible iff `sameChannel(viewer, row)`.

Enforcement rides the existing **rooms-resolution seam** — the same place
agents-mode account filtering already lives — so both `search_messages`
corpora, `recap`, and `user_activity` are covered by one change per tool
rather than per-query-site WHERE surgery:

- **`rooms:"current"`** — always allowed (viewer's own channel). Unchanged.
- **`rooms:"all"`** — when `hasIsolation()`, the resolver path materializes
  the concrete key list (the distinct-`timeline_key` query over `chat_index`
  that `resolveRoomsForAgent` already runs in agents mode, now also used in
  legacy mode when isolation is configured) and drops isolated keys that are
  not the viewer's channel. When no isolation is configured, the legacy
  `undefined` no-filter fast path is preserved bit-for-bit.
- **Explicit room lists** — partitioned into allowed and excluded. Excluded
  keys are dropped from the query and **reported in the tool result** (settled
  decision): a trailing note of the form
  `note: N room(s) excluded by operator visibility config` (count only, no
  key echo needed — the caller named them). Never silent: a silently-empty
  result reads as "no such history", and the agent will retry variants or
  confidently assert an absence. If *every* requested room is excluded, the
  tool returns just the note, not an error.
- **`user_activity`** — same rooms partition + note; additionally, roster
  aggregations over "all rooms" must not leak isolated channels through
  per-room count rows, which the materialized-key-list approach handles for
  free (isolated keys never enter `timelineKeys`).
- **`expand_summary`** — the one id-addressed path, checked directly: load
  the target summary's `timeline_key`; if it resolves `isolated` and
  `!sameChannel(viewer, target)`, return a tool error
  (`summary belongs to a channel excluded by operator visibility config`)
  before any lineage walk. Level-1 raw-message hydration inherits the check
  from its parent summary, so no per-event filtering is needed.

Filtering happens at the **tool/resolution layer**, not inside
`Storage.searchChatIndex` — storage stays policy-free (consistent with how
agents-mode account filtering was placed), and the console/BFF (an operator
surface) intentionally keeps seeing everything.

**Generation sessions** (`summarize`/`condense`/`diary`) never carry the
search tools (their allowlists are read/enrich hatches only), and proactive
sessions run *on* their channel — so `viewerTimelineKey` is well-defined
everywhere the tools register.

## 7. Non-goals & accepted leaks (documented, deliberate)

Best-effort policy, not a security boundary. The spec-level list of what this
feature does **not** do:

- **No scrubbing.** Diary entries, retrieval-index chunks, and summaries
  written before a channel was excluded remain readable everywhere the
  read paths already reach.
- **No agent-volition control.** The agent can still quote an isolated
  channel's content in its replies elsewhere, `write_memory` facts it learned
  there, or carry context across sessions in its own words. In particular
  **user profiles are global by design** — per-person facts learned in an
  isolated DM land in that user's profile and are readable from any channel.
- **No transport/storage privacy.** Everything is still stored, enriched,
  captioned, summarized, and indexed identically; the operator and console
  see everything.
- **No membership secrecy.** Tool results acknowledge that exclusions exist
  (the visible note) — the feature hides content, not the fact of a policy.
- **No per-thread granularity** in v1.

## 8. Observability

- `diary_job_excluded` structured log (timeline key, summary id, resolved
  mode) at the diary gate; the console pipelines monitor picks up the new
  `excluded` status from the existing status-grouped queries — the console's
  status vocabulary (chips/colors) adds the one value.
- `search_rooms_excluded` structured log (tool name, viewer key, excluded
  count) whenever the viewer check drops explicitly-requested rooms —
  the operator-side answer to "why does the bot say it can't see that room?".

## 9. Testing

- Resolver: precedence (exact > blanket > default, both override
  directions), thread inheritance, malformed-key fallback, `hasIsolation`.
- Config validation: malformed key, thread-suffixed key, duplicate entries,
  bad enum — each fails fast.
- Diary gate: `no_diary` and `isolated` rows terminalize as `excluded`
  without a session; `shared` unaffected; requeue-failed leaves `excluded`
  rows alone; migration round-trips rowids and FTS integrity.
- Search: each tool × {current, all, explicit-allowed, explicit-excluded,
  explicit-mixed} × {viewer inside, viewer outside}; the note renders; the
  no-isolation fast path produces identical SQL to today; `expand_summary`
  denies by id from outside and allows from inside (including from a thread
  of the isolated room).
