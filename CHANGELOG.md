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

### Added

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

### Changed

- Tool description strings for Matrix sessions are byte-identical to their values
  before Discord support was added. No model vocabulary change for existing Matrix
  deployments.

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
