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
