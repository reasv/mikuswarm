# Changelog

All notable user-visible changes to MikuSwarm are documented here. Release
sections are kept newest first and are published verbatim as the GitHub release
notes for each version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [RELEASING.md](RELEASING.md) for how a release is cut.

## [Unreleased]

<!--
Accumulate user-visible changes here as they land, under any of:

  ### Added
  ### Changed
  ### Fixed
  ### Removed

Cutting a release renames this heading to `## [vX.Y.Z] - YYYY-MM-DD` and adds a
fresh, empty Unreleased section above it. Keep this guidance comment in the
Unreleased section; it is not part of any release's notes.
-->

### Added

- **OpenAI Responses API prefill**: `[models.<name>.prefill]` forces a required `analysis` argument on every tool call via strict JSON schema `pattern`, anchoring persona adherence on GPT-6 Sol/Luna. Includes `no_reply` tool, `drop_reasoning` option, and per-serving-member gating via `onPayload`. See spec/OPENAI-PREFILL.md.
- **Captioning via OpenAI Responses API**: `[models.*]` with `api = "openai-responses"` can now serve as a caption model for images. Incomplete, refused, and unsupported-modality results are classified as content failures. (Port of MR !1 captioning code by contributor nopm.)

- **Bedrock explicit prompt-cache breakpoints** (`cache_breakpoints = "explicit"` on
  `[models.<name>]` with `api = "openai-responses"`). Injects up to 3 explicit
  breakpoints at the stable prefix boundaries (agent instructions, conversation
  summary, last stable timeline batch) so consecutive sessions in the same room
  reuse the shared prefix at Amazon Bedrock's 0.1x cache-read rate instead of
  rewriting ~28k tokens at each session start. Default off; ignored on all wire
  APIs other than `openai-responses`.

### Changed

- **Prefill: past `analysis` arguments are no longer replayed to the model.** They stay in the stored transcript; the wire history is stripped deterministically so prompt caching is unaffected.
- **Silence is now a tool call.** `no_reply` is part of every chat session's tool set
  (next to `send_message`, same session-type filtering, always in the initial set
  under dynamic loading); calling it ends the turn. The shipped prompts, workspace
  templates, proactive kickoff, and forced-completion messages now say "call
  `no_reply`" instead of "output `NO_REPLY`". The text marker is still accepted for
  compatibility.

### Fixed

- **Every chat request failed on OpenAI-compatible servers that reject tuple-form JSON
  Schema (e.g. SGLang).** `view_range` on `str_replace_based_edit_tool` and
  `write_memory` was declared with `items` as an array, which such servers answer
  with a 400 for the whole request. It is now a plain two-number array, matching the
  summary and diary tools.
- **An agent- or account-scoped `[[user_limits]]` rule with a shared pool failed
  startup** (`SqliteError: no such column: timeline_key`). The pool's ledger reseed
  filters by the agent's timeline keys, but the overflow table
  `usage_event_partitions` had no `timeline_key` column. The **v20→v21** migration
  adds it and back-fills it from `usage_events`, and new overflow rows record it.

- **Matrix: quoted and looked-up messages showed their pre-edit text.** Reply
  context and `read_messages` with `message_id` fetch the message from the
  homeserver, which returns the original event (an edit is a separate event), so an
  edited message was quoted with its old body even though the edit had been applied
  to the stored copy. Both now use the stored post-edit body, and applying an edit
  also refreshes existing stored quotes of that message. The **v19→v20** migration
  (one-way, data only) repairs quotes stored before this fix.

- **Discord: messages carrying an embed at delivery time lost it** (`provider_error`
  `FOREIGN KEY constraint failed` in `messageCreate`). On an active channel the
  inbound pipeline yields to the activation gate before it enqueues the event
  insert, so the provider's separate ingest-embed write landed on the single-writer
  queue first and failed the `link_previews → timeline_events` foreign key. Typical
  victims were bot replies (link-fixer bots) whose embed is already in the payload.
  Ingest-time previews now ride on the event and are persisted in the same write
  transaction as the event row on every ingest path (active, inactive, trigger-hold
  flush, backfetch). The message itself was never lost; only its preview was.

- **Discord: every reply rendered its quoted message as `[original message
  unavailable]`** and logged `enrichment_reply_target_missing`. The Discord
  provider's reply-context lookup (`messageSummary`) was a stub that always
  answered "no such message", so enrichment wrote a body-less `reply_contexts`
  row for every reply, and that stub row overrode the full quote the message
  already carried from the gateway payload at hydration time. The provider
  lookup is now optional; when a provider has none, the enrichment worker
  resolves the target from the event's own ingest-time reply snapshot (body or
  attachments) and then from the stored copy of the target message, and only
  warns when both come up empty. Matrix keeps its native lookup unchanged.

- **Startup gap backfetch now covers Discord** (and any provider with paged history). The coordinator looked up each account's self-id at `prepare()`, which runs before any provider starts, so every Discord account (whose id is only resolved inside `start()`) was skipped on every boot with `gap_backfetch_skip_room: unknown_self_user`, and Discord channels never recovered the messages missed while the bot was down. Self-ids and read clients are now resolved from the providers at `run()`; descent units are provider-qualified; Discord threads (separate history channels) are paged as their own units with their own floors; and a unit that cannot be filled at all (no self-id, no read client, or history the provider reports as permanently unavailable, e.g. a Discord 403) is released instead of left frozen. New optional `ProviderCapabilities.threadHistory` (`"inline"` default / `"separate"`).
- **Discord history reads**: messages read from a thread channel now carry `threadRootExternalId` (initial backfill of a Discord thread timeline previously filtered every message out), and an edited message is no longer flagged as a replacement event (previously dropped by the backfill classifiers).

## [v0.5.1] - 2026-09-13

### Fixed

- Dynamic tool loading on the OpenAI Responses API (`compat.supports_tool_search`,
  default on) broke the turn after a loaded tool was called on endpoints that
  accept the `tool_search_*` items but omit the `namespace` field on the model's
  `function_call` item and then reject the replay with 400 "Missing namespace for
  function_call '<tool>'. It does not exist in the default namespace." A bare
  deferred function lives in a namespace named after itself, so the bundled
  pi-ai is patched (`patches/`) to default the replayed namespace to the function
  name when the provider left it out. Loaded tools keep riding the prefix-stable
  transport; no prompt-cache re-write.

## [v0.5.0] - 2026-09-06

### Added

- **`[storage].cache_size_mb` / `[storage].mmap_size_mb`.** SQLite page-cache size
  (default raised from SQLite's ~2 MiB to 64 MiB) and an opt-in memory-mapped I/O
  window (default off) for large databases, where the tiny default cache made even
  index-only probes re-read pages through syscalls on every call.

- **Console favicon.** The observability console now ships a tab icon (SVG with
  ICO/PNG fallbacks) instead of the browser's default blank page icon.

### Fixed

- **Dynamic tool loading no longer busts the prompt cache on the OpenAI Responses API.** Loading a skill mid-session grew the request's `tools` array, which leads the Responses prompt-cache prefix, so the next request re-wrote the entire cached context at the cache-write price (on GPT-5.6, every load cost a full-context re-bill). pi-ai's prefix-stable `tool_search_call/output` + `defer_loading` serialization is now on by default for every `api = "openai-responses"` model (`compat.supports_tool_search`, default `true`; set `false` only for a Responses-compatible endpoint that rejects those item types).

- **Console pipelines page took seconds per request and stalled the agent.** Every
  `/api/pipelines*` read ran synchronously on the agent's main thread, and three of
  them scanned: the summarization/diary item lists resolved each row's session with
  an unindexed `agent_sessions.trigger_event_id` probe (51 full scans per page, ~3 s
  on a 10k-session database), the dashboard counts re-aggregated hundreds of
  thousands of index entries on every 5 s poll, and the captioning list was planned
  off the wrong index. Counts are now a trigger-maintained `pipeline_counts` table
  (exact, rebuilt from the base tables at every open, read in microseconds), the
  session probe and the caption usage sums are index-backed, and the captioning list
  walks its keyset index — every request on the page now answers in single-digit
  milliseconds on the same data, and no longer blocks message handling while it runs.
  The `pipeline_counts` captioning buckets could drift upward across bot restarts:
  `insert or replace into media_assets` uses SQLite REPLACE conflict resolution,
  which skips DELETE triggers without `recursive_triggers`, so re-inserting a tracked
  asset incremented its bucket without decrementing the old one; a new BEFORE INSERT
  trigger settles the replaced row's bucket first, keeping the counts exact.
- **Inactive channels were being summarized.** The eager summarization indexer
  had no channel-lifecycle check, and two of its entry points bypass the inbound
  activation gate: an applied message edit (applied for any timeline state so
  edits work uniformly) and the worker pool's completion callback. A single edit
  in a never-engaged channel with a large stored backlog therefore enqueued a
  level-1 summary job, and each completion cascaded into the next chunk until the
  whole backlog (and its condensations) had been sent to the LLM provider —
  against the §7b lifecycle rule that inactive channels incur no upstream
  traffic (a cost and privacy boundary). The indexer now skips any timeline whose
  state is not `active` before counting anything, on every path.


## [v0.4.0] - 2026-08-23

### Added

- **Cross-channel messaging**: the agent can now act beyond the channel that
  triggered it. New tools `send_dm` (open or reuse a direct-message timeline
  with a user), `send_to_channel` (post into any joined channel),
  `list_channels`, `list_members`, and `dm_optout`, plus `room`/`anchor`
  arguments on `read_messages` for reading other timelines. Every
  cross-channel send stores an internal context note bridging the originating
  conversation; DMs can only be initiated with users who share a visible
  channel with the agent (an existing DM counts); and a user can ask the agent
  to stop DMing them — the opt-out is honored by `send_dm` and by the
  proactive scheduler. A new seeded `contacts` workspace skill covers
  discovery and usage. Configured under `[messaging]` (`enabled`,
  `dm_initiation`), on by default; channel-visibility policy gates reads and
  enumeration, never sends.
- Dynamic session-time tool loading (`[agent.tools.dynamic]`): sessions start with a configurable immediate tool core; all other tools are deferred and loadable mid-session via the new `load_skill` and `tool_search` tools (or by viewing a tools-declaring markdown file), cache-safely per provider through pi-ai's `addedToolNames` contract. Skills gain a frontmatter `tools` list; under dynamic loading the skills index hides file paths and a `<deferred_tools>` discovery index is rendered (`index = "orphans" | "names" | "descriptions" | "none"`).
- Six new seeded default skills grouping the built-in tools for dynamic loading: `chat-history`, `channel-ops`, `media`, `x-twitter`, `shell`, and `sessions`; all seeded skills (new and existing) now declare their tools in frontmatter.
- **Channel visibility** (`[visibility]`): operators can assign each timeline (DM or channel) one of three modes — `shared` (default, full cross-channel search and diary access), `no_diary` (search remains cross-channel but diary is suppressed for that timeline), or `isolated` (diary suppressed and search is scoped so the timeline cannot be seen or queried from other timelines). Configure per-channel via `[[visibility.channels]]` entries (each with `timeline_key` and `mode`) and/or a blanket `dms = "…"` applied to every DM. The `expand_summary` tool refuses to surface a summary from an isolated channel when called from a different timeline. Diary rows from suppressed timelines are set to a new terminal status `excluded` (visible in the console pipeline view) rather than being retried or written. The `search_messages`, `recap`, and `user_activity` tools emit a note when operator policy silently removes rooms from a requested scope. No cross-channel access changes occur unless `[visibility]` is explicitly configured; all existing deployments behave identically on upgrade.
- **Summary-layer token budget**: the in-context summary layer — previously
  the only context segment with no size knob — can now be bounded. When the
  layer's rendered size exceeds `summary_max_tokens`, eager condensation
  absorbs the finest-grained resident summaries into higher-level ones until
  the layer fits under `summary_target_tokens` (a target/max split, so
  condensation runs in occasional bursts rather than continuously). Coverage
  is never elided or replaced with pointers; the budget only moves the
  coarsening boundary. Both knobs live in `[summarization]` and default to 0
  (off) — existing deployments behave identically until they opt in.
- **Workspace template reconciliation** (`[seeding]`): established workspaces
  now receive new and updated template files on upgrade. A per-file seed
  ledger records what was seeded and with what content hash; on boot, each
  template file is created if absent, and an existing file is updated only
  when it is still byte-identical to what was originally seeded — a file the
  agent or an operator has modified is never touched. Previously only empty
  workspaces were seeded, so template additions (such as new skills) never
  reached existing deployments. `mode = "reconcile"` is the default;
  `"first-run"` restores the old empty-workspace-only behavior and `"off"`
  disables workspace seeding entirely; `update_unmodified = false` limits the
  reconcile to creating missing files.
- MCP servers that fail to connect at startup are now retried in the
  background with exponential backoff instead of being dropped for the
  process lifetime; on a late success their tools are registered and reach
  every session created afterwards. Tunable via `[mcp]`
  `startup_retry_max_attempts` (default 5), `startup_retry_initial_delay_ms`,
  and `startup_retry_max_delay_ms`.

### Changed

- **Dynamic tool loading ships ON in `00-defaults.toml`** with a lean always-loaded core (messaging, reactions, history read/search, native web, file tools, memory). On upgrade, sessions no longer carry every tool definition on every request — deferred tools remain reachable through skills, the `<deferred_tools>` index, and `tool_search`. Set `[agent.tools.dynamic] enabled = false` to restore the previous everything-always-loaded behavior, or override `immediate` to choose your own core.
- Summary keyword search is now its own tool, **`search_summaries`**, instead of a `corpus:"summaries"` flag on `search_messages` — the union schema invited cross-corpus mis-fills, and dynamic tool loading removed the tool-count pressure behind the flag. The two tools have disjoint schemas sharing the common search facets (`query`, `rooms`, time window, pagination, order); `search_summaries` carries `level`/`min_level`/`status` and joins the shipped dynamic-loading immediate core.
- **Database schema v19 (one-way migrations).** The schema advances from v11
  through v19: the `dm_optouts` table and cross-channel event metadata, user
  identity upserts for Matrix inbound events, summary supersession backfill
  and stale-job cleanup for the budget work, and the workspace seed ledger.
  Migration is automatic on first boot; a migrated database refuses to open
  on an older build, so rolling back past this release requires a
  pre-migration backup.
- Updated `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 0.84.2.

### Fixed

- Per-user limits no longer under-price a request served by a different
  upstream than the one holding the prompt cache. The within-TTL cache-read
  discount is now credited only to a candidate whose predicted serving
  upstream (endpoint + wire model) matches the one that served the prior
  request; any other candidate is priced as a cache miss, so a request can no
  longer slip past a user's spending cap at the discounted estimate and then
  bill at full cache-miss price.
- The chat-search tools no longer fail a call over filters that belong to the other search tool. Semantically-empty argument values (`""`, `[]`, `null`, and `0` for `level`/`min_level`) are stripped before interpretation — models that pad every optional schema field instead of omitting unused ones no longer trip errors or phantom filters (`mentions: []` matching nothing, `level: 0` matching no summaries). A meaningful filter that belongs to the other tool (e.g. `level: 2` on `search_messages`) runs the search without it and appends a note naming the ignored field and the tool that accepts it, instead of erroring the whole round trip.

## [v0.3.0] - 2026-08-20

### Added

- **Multi-agent support**: one MikuSwarm process can now host multiple agents
  (personas), each with its own accounts, workspace, memory, and identity. Declare
  one `[agents.<name>]` block per agent (required `workspace_root`); every
  Matrix/Discord account block gains an `agent` field naming its owning agent
  (defaulting to the account key, so giving accounts on two providers the same key
  is the zero-config way to give one persona two doors). Memory retrieval, diary
  writes, chat-history search, and attachment downloads are all scoped per agent.
  Agents may declare their own sandbox container (`[agents.<name>.sandbox]`) and
  browser profile (`[agents.<name>.browser]`, required for browser tools in agents
  mode); without a sandbox override they share the global `[sandbox]` container.
  A `[siblings]` block governs whether agents respond to each other: `replies =
  "never"` (default) or `"capped"`, allowing bot-to-bot replies up to
  `max_bot_chain` (default 4) consecutive bot messages since the last human one,
  with `third_party_bots` optionally subjecting unrelated bots to the same cap.
  `[[limits]]` and `[[user_limits]]` rules gain optional `agent` and `account`
  matchers (absent = global, so existing rules are unchanged). `summaries_from =
  "<donor>"` on an agent block lets a secondary agent reuse the donor's channel
  summaries instead of paying for its own summarization pass, falling back to
  native summarization automatically if the donor stops covering a channel. An
  optional content-addressed attachment store (`[attachment_store]`) deduplicates
  downloaded files across all agents' workspaces via SHA-256-keyed hardlinks.
  Deployments without `[agents.*]` run in single-agent mode, byte-identical to
  before.

- **Discord provider**: first-class Discord support. A `[discord]` config block
  (peer of `[matrix]`, default `enabled = false`) wires one or more Discord bot
  accounts. All user-facing behaviour — trigger detection, context assembly, tool
  calls, memory, enrichment, reactions, polls, history backfetch, proactive
  posting, budget enforcement, and the observability console — works across both
  providers without provider-specific code paths in the agent layer.

- **Cross-provider `ChannelClient` interface**: all channel-scoped tools
  (`channel_info`, `member_info`, `emoji_list`, `react`, `list_reactions`,
  `edit_message`, `delete_message`, `pins`, `read_messages`, `create_poll`,
  `poll_vote`) now dispatch through a provider-neutral `ChannelClient` obtained
  from the session's registered `IChatProvider`. Matrix behaviour is byte-identical
  to before.

- **Provider-aware tool descriptions**: a `ProviderTerminology` bundle drives
  parameter descriptions in all 12 provider-aware tools. Discord sessions see
  Discord-native vocabulary (channel, snowflake ID, etc.); Matrix sessions remain
  byte-identical to their pre-Discord strings.

- **Discord voice messages**: the agent can send ogg/opus voice messages to
  Discord channels (transcoded from arbitrary audio via ffmpeg), matching the
  existing Matrix voice-message capability.

- **Discord polls**: `create_poll` is supported on Discord channels
  (`capabilities.pollCreate = true`). `poll_vote` is not available on Discord
  because Discord has no bot vote endpoint.

- **Discord history backfetch**: history paging uses before-snowflake cursors for
  Discord channels. The console backfetch form hides the `oldest_decryptable`
  target (a Matrix E2EE concept) and uses provider-neutral wording for non-Matrix
  timeline keys.

- **IRC provider**: MikuSwarm now supports IRC as a third chat provider alongside Matrix and Discord. Enable with `[irc] enabled = true` and one or more `[irc.accounts.*]` blocks. Requires a modern IRCv3 server (Solanum, InspIRCd, UnrealIRCd, Ergo) — hard startup error when `server-time`, `message-tags`, or `echo-message` caps are absent. Full identity ladder (services account > tracked account > casemapped nick) with **network-scoped user ids** (`libera.chat/alice` style — `<networkId>/<ladderResult>`), byte-accurate UTF-8 chunking, echo-merge via `labeled-response` or FIFO fallback, per-channel roster (`members`, `member_info`, `channel_info` tools), and the `{server_id}` per-user-limit partition variable keyed to the network identity. Network-scoped ids make cross-network user collision impossible and close the multi-network identity-sharing limitation.

- **YouTube video understanding**: posted YouTube links receive structured
  enrichment automatically for caption-eligible messages — title, channel,
  duration, chapter list, and a transcript preview with `[m:ss]` markers — at
  no LLM cost (one yt-dlp probe + transcript fetch per link). Thumbnail download
  and captioning follow the existing captioning gates. Full enrichment can be
  extended to every message's links via `[youtube.enrichment].enrich_all`.
  New `youtube_fetch` tool lets the agent retrieve the full timestamped
  transcript and metadata on demand (`offset`/`max_chars` windowing identical
  to `x_fetch`), or download the video or audio as a workspace file
  (`download: "video"|"audio"`, with optional clip and resolution bounds). The
  `media` tool now accepts YouTube URLs and analyzes a segment (`start_time`
  semantics preserved, segment pre-cut by yt-dlp and cached in `MediaCache`).
  The yt-dlp standalone binary is preinstalled in both the agent and sandbox
  images; the sandbox binary additionally lets the agent hand-drive exotic
  downloads via `bash`. Controlled by `[youtube]` config (master switch +
  proxy + concurrency + timeout + optional `cookies_file`),
  `[youtube.enrichment]`, and `[youtube.tool]` (windowing caps and download
  height limit).

- **Per-agent model overrides**: each agent can now declare an optional `[agents.<name>.models]` block to
  selectively override model role assignments for that agent only. Chat session types (including `proactive`,
  `summarize`, `condense`, `diary`) are overridden via `[agents.<name>.models.session_types]` (flat map of
  type name → `[models.*]` logical name); captioning per-modality via `[agents.<name>.models.captioning]`
  (same two-level shadowing as the global config, with strict same-rung precedence); image generation tiers
  via `[agents.<name>.models.image_gen]`; and X search tiers via `[agents.<name>.models.x_search]`. All
  values are references into the shared global `[models.*]` registry — connection details, fallback chains,
  cost, and health tracking remain centralized. Absent = all roles resolve exactly as before. Fail-fast
  validation at startup rejects unknown model names, overrides for unconfigured subsystems, and
  `summaries_from` + summarization-override conflicts, with path-precise error messages. A startup info log
  (`agent_model_overrides`) lists each agent's effective overrides.

- **Per-agent MCP server scoping**: `[agents.<name>]` gains an optional
  `mcp_servers` array listing which `[mcp.servers.*]` entries that agent may use.
  Absent means all configured servers (the legacy behavior); an empty array means
  no MCP tools at all. The filter composes with per-session-type tool allowlists
  as an intersection. Tool-to-server attribution is exact (a map built at startup,
  immune to prefix collisions between server keys), and unknown server keys are a
  startup error.

- **Tool-result context budget**: oversized tool results are now shaped before
  they enter the context, in two layers — a per-result cap (`result_max_tokens`,
  default 16384, `0` disables) and a per-turn aggregate clamp that reserves
  headroom for subsequent turns (`result_reserve_tokens`, default 32768) while
  guaranteeing every result a useful minimum (`result_min_tokens`, default 1024).
  Truncation is tail-only with a visible marker stating how much survived. All
  three knobs live under `[agent.tools]` and default on. The console rollout view
  annotates any truncated tool call with `truncated N→M`.

- **Served-model attribution**: every LLM attempt now records the model that
  actually served it alongside the requested one, and the session row records the
  actually-billed model after each committed request — authoritative even after
  fallback. The console scheduler view renders `requested → served` (highlighted)
  whenever the two differ.

- **Console: agent-aware labeling**: deployments with more than one configured
  agent gain agent-primary labels across every console surface — room-list tabs
  become per-agent ("All" plus one tab per agent, labeled `name PROVIDER` or
  `name MULTI`) with a `?agent=` deep-link URL param, channel cells and pipeline
  items show an `agent PROVIDER` chip instead of the raw account tag (with an
  `accountId` disambiguator only when the agent has more than one account on that
  provider), the top bar and session detail carry agent context, and budget rule
  scope cards label agent-scoped limits by agent name with a deterministic accent
  color. Legacy and single-agent deployments render identically to before. Backed
  by a new `GET /api/agents` read-only endpoint that serves the config-declared
  agents snapshot from memory.

- **Console: Usage & Cost by-agent breakdown and page-wide agent filter**: in
  multi-agent deployments the Usage & Cost page gains a per-agent cost dimension —
  an agent tab row (All / one tab per agent, in `?agent=`, composing with the time
  window) that filters the total-spend card, by-class / top-models breakdowns,
  spend-over-time chart, recent-sessions and paid-calls tables, and the user
  leaderboard server-side (Limits keep their own scope); a **By agent** summary
  card and a **by agent** chart grouping (each agent in its accent color, plus an
  "unattributed" residual for background spend); and a leading **agent** column in
  both tables, shown on the All view and omitted when a single agent is filtered.
  The recent-sessions table now orders identity columns first (session, type,
  channel, trigger, then model and figures). The usage read endpoints accept an
  optional `agent=` filter and the summary returns a `byAgent` breakdown in agents
  mode; single-agent and legacy deployments are unchanged.

- **Console: per-account room tabs**: when the room list spans more than one
  chat account (e.g. a Matrix account and a Discord account), the Conversations
  room list gains a sub-tab row — "All" plus one tab per account, each tagged
  with its provider — filtering the list to that account's rooms. With a single
  account the layout is unchanged. `GET /api/rooms` now carries each room's
  `provider` and `accountId`. The remaining channel-mixing surfaces get the
  same treatment: the Usage & Cost recent-sessions and paid-calls channel cells
  show an account tag whenever their rows span multiple accounts, and the
  Pipelines item detail labels its room key with the owning account.

- **Console: human sender labels on per-user limits**: the Usage & Cost
  "Per-user limits" strips (and the live model-selection chips) now render each
  sender as "Display Name (handle)" — the Discord unique username, or the MXID
  for Matrix — instead of a raw user id / snowflake, truncating long names with
  the full label on a hover tooltip. Names resolve from observed identities
  (`user_identities`) with a fallback to the latest session-recorded display
  name; unknown senders still show the bare id.

### Changed

- **Model fallback now fits context per chain member.** A fallback chain member's
  viability is evaluated against its *own* `context_window` rather than the
  minimum over the whole chain, so adding a smaller fallback model no longer
  silently shrinks the head model's effective context ceiling and misroutes large
  contexts to the floor model while the preferred model is healthy. Context-based
  termination now happens only when the observed context fits no member at all,
  the text-editor read budget follows the head model's window, and
  `model_fallback_resolved` events gain a `context-fallback` reason.

- **Database schema v11 (non-additive migration).** Session context snapshots and
  transcripts move out of `agent_sessions` into a new `agent_session_payloads`
  side table, dropping the two blob columns; a v11 database refuses to open on an
  older build, so rolling back past this release requires a pre-migration backup.
  New covering indexes and a single-pass room-list aggregation make the console
  room list and captioning counts fast on large databases.

- **Tool-triggered captions are billed to the tool ledger.** Captions produced
  inside the `media` tool, danbooru's non-vision `preview`, and `x_search` inline
  captions now append rows to the `tool_invocations` ledger and count against the
  per-session cost ceiling. This spend was previously invisible to per-session
  accounting, so reported per-session tool cost may read higher for sessions that
  use those tools heavily.

- Tool description strings for Matrix sessions are byte-identical to their values
  before Discord support was added. No model vocabulary change for existing Matrix
  deployments.

### Fixed

- **Browser `act:dialog` overrides now actually take effect.** The JS-level one-shot
  override for `window.confirm`/`prompt`/`alert` (the workaround for CloakBrowser-Manager
  versions whose resident client auto-dismisses every JS dialog) was shipped as a compiled
  function whose esbuild `keepNames` helper calls threw `ReferenceError: __name is not
  defined` in the page, so it never installed — and the failed install left the page
  sentinel-locked against re-arming until the next navigation. The override now ships as a
  raw source string (immune to compiler transforms), sets its install sentinel last (a
  failed install leaves the page re-armable), and carries the same `act_timeout_ms` expiry
  as the CDP-path slot so a never-triggered arm can't answer a later, unrelated dialog.
  (spec/BROWSER-DIALOG-OVERRIDE-INJECTION-FIX.md)

- **Browser `console` action now works on stealth Chromium backends.** Playwright
  synthesizes `console`/`pageerror` events from the CDP `Runtime` domain, which
  stealth builds (e.g. the CloakBrowser Manager) suppress — so the action's buffer
  was always empty. Console output is now additionally captured via the legacy CDP
  `Console` domain, and page errors are bridged through a page-side
  `error`/`unhandledrejection` hook, with de-duplication so standard backends
  don't double-log. (spec/BROWSER-CONSOLE-CAPTURE-STEALTH-FALLBACK.md)

- **Sandbox reuse survives network-anchor restarts.** When the sandbox joins
  another container's network namespace (`network = "container:..."`) and that
  anchor container is recreated, the stale sandbox is now detected and recreated
  instead of being reused with a dead network namespace.

- **Workspace seeding works in the published agent image.** The image now ships
  `templates/`, and seeding logs a warning when its source directory is missing
  instead of silently seeding nothing.

- **Discord typing indicator no longer sticks.** Fixed a stop/in-flight race that
  could orphan the typing keepalive refresh loop, leaving the bot "typing"
  indefinitely; duplicate keepalives are also coalesced.

## [v0.2.0] - 2026-07-24

### Added

- The observability console gains a session inspector column: selecting a
  session surfaces its decoded record beside the rendered view, including
  metadata, the session cost ceiling, tool invocations, the context dump path,
  and the raw record.
- The console now has a demo mode that serves built-in fixtures instead of a
  live backend, so it can be run and explored without a running agent. Demo mode
  includes pipeline-monitor fixtures with placeholder media.

### Changed

- The CloakBrowser Manager is now pulled from the upstream
  `cloakhq/cloakbrowser-manager` image instead of being vendored and built from a
  git submodule. Deployments no longer need the `vendor/cloakbrowser-manager`
  submodule or a local browser-image build.
