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

- **Late input** (`[agent.sessions.late_input]`, on by default): a person's request can be
  corrected after its chat session started. While the session has done nothing
  irreversible, an edit of the triggering message (or a part grouped with it), a late
  addition from the same sender, or a reply from that sender to the request **redoes
  the session from scratch** with the corrected input; routing and record selection run
  again, at most `max_redos` times (default 3). Removing the bot mention from the
  trigger, or deleting it, cancels the session, and an edit that adds a bot mention to
  a recent message triggers it. Once something irreversible has happened, the
  correction is **interjected** instead: a generation in flight is aborted and the
  correction is delivered at once. An edit made after the reply only updates the stored
  message.
  To give corrections time to land, the session's first irreversible tool call (a send
  included) is **held** until `hold_ms` (default 8 s) after the trigger arrived,
  extended by `extend_ms` per correction up to `max_hold_ms` (default 20 s). The model
  keeps working meanwhile, so the hold is usually over before it sends.
  A message the sender wrote before the session's run ended, but which arrived after
  it, **revives** the finished session within `revive_max_ms` (default 5 min) and
  continues it, with the record turn written again at the new end. This replaces the
  fresh session that such a follow-up used to start. A reply to the request belongs to
  it without any judgement; after the run ended it triggers like a reply to the bot's
  message. A Matrix redaction of a message is a deletion like a Discord one (only the
  sender's own redaction withdraws a request; a moderator's leaves the request alone),
  and a session evicted by a restart cannot be revived.
  A discarded rollout is kept as a branch with the message that caused it. The console
  session view labels redo, revival and aborted-turn branches with that message, shows
  how long a call was held, labels each interjection's kind, and marks redone sessions
  with a `restarted n` chip. Spans discarded by late input are left out of the model
  behaviour statistics and the send-contract records. Database schema v30 adds
  `agent_sessions.redo_count`, `agent_session_branches.cause_event_id` and
  `usage_events.estimated`. See ARCHITECTURE.md §8 "Late input".
- **Deleted messages show as deleted** (Discord and Matrix). A deleted Discord message
  or a redacted Matrix message keeps its stored content and gets a deletion marker
  (when, and by whom when Matrix says). Sessions then see it as a placeholder in their
  recent history, the way clients show it: its place, its sender and
  `[message deleted]` (`[message deleted by <moderator>]` when someone else deleted
  it), never its text, attachments or captions. Quotes of it, the decision points'
  recent chat, and a level-1 summary written after the deletion show the same
  placeholder. Search, `read_messages` and the other history tools still show the
  message, and summaries written before the deletion are never remade. See
  ARCHITECTURE.md §6 "Message edits" and §9 "Deleted messages".
- **Tool effect classes.** Every tool is classified as `redo_safe` (no external
  effect), `repeatable` (no visible effect, but repeating it costs money or time),
  `undoable` (`react`, pinning and unpinning) or `irreversible`. MCP tools take their
  class from the server's tool annotations (`readOnlyHint` makes a tool redo-safe,
  `idempotentHint` without `destructiveHint` repeatable, anything else irreversible),
  and `[mcp.servers.<name>].effects = { <tool> = "<class>" }` overrides them for a
  server that annotates badly or not at all. A late-input redo serves the results of
  redo-safe and repeatable calls with the same arguments from the discarded run instead
  of running them again, and undoes reactions and pins newest first; a reaction or pin
  call that changed nothing is left alone, and an effect that cannot be undone turns the
  redo into an interjection.
- **Late-addition and implicit-reply decision points** (`[decisions.late_addition]`,
  `[decisions.implicit_reply]`, off by default; need `[decisions]` enabled).
  `late_addition` judges whether a message the trigger's sender sent within
  `candidate_window_ms` (default 60 s) of the request belongs to it (`threshold` 0.7;
  at most `max_judged` candidates judged and `max_folded` joining per request, default
  8 and 3); the irreversibility hold waits for the verdict. Without the point, the quick
  follow-up windows decide. `implicit_reply` judges whether a bare group message (no
  reply, no mention) answers one of the bot's last messages (within
  `max_messages_after` messages and `max_age_ms`, default 3 and 2 min; `threshold`
  0.8), and handles it as a reply to that message on a yes.
- **Vision decision chain** (`[decisions].vision_model`, or per point; unset by
  default): a decision point can send images to a decision chain whose members read
  them, instead of only their captions. `[decisions.<point>].vision` (`"off"`,
  `"uncaptioned"`, `"always"`) chooses when; `vision_timeout_ms`, `max_images`,
  `image_max_pixels` and `max_image_bytes` bound the request, and
  `[models.*.decision].max_images`, `max_image_bytes` and `images` describe what each
  member accepts. Any failure of the vision attempt retries once on the text chain with
  captions. `late_addition` is the first point that uses it (`always`), so a picture
  sent after the question is judged by what it shows before it has a caption. Every
  member of a vision chain must declare `"image"` input, checked at startup.
- **4chan support** (`[features].yotsuba`, off by default; configured under
  `[yotsuba]`). 4chan thread and post links get rich previews (the opening or linked
  post with its files, upgraded with images when the link triggers the bot), and the
  `yotsuba` tool, with a matching skill, browses boards, catalogs and threads in several
  views, shows a post's image, video storyboard or PDF, and downloads files. API
  requests follow 4chan's one-request-per-second rule and use
  `[network].http_proxy_url` when set. See ARCHITECTURE.md §7f.
- **`compat.openrouter_routing`** (Chat Completions models, unset by default): an
  OpenRouter provider-routing object (`order`, `only`, `ignore`, `zdr`, `sort`, ...)
  sent as the request's `provider` field, to pin a model to specific upstream providers
  or to zero-data-retention endpoints. A gateway in front of OpenRouter must forward it.
- **`[[limits]].reserve_usd`** (optional, default 0): the headroom a new spend needs.
  The rule blocks once less than `reserve_usd` is left, so a cap over expensive single
  calls (for example `x_search`) no longer lets the last call overshoot it by a full
  call's cost.
- Optional native Exa API search, batch page extraction and separately enabled
  durable delegated research, with cost accounting, runtime fallback and recoverable
  job results. New web/deep research skills combine web sources with Grok X evidence;
  generic skill capability requirements prevent unavailable workflows being preloaded.
  Database schema v28 adds `tool_invocations.metadata_json` and v29 `exa_research_jobs`.
- Operator console Exa health and saved research-job monitoring without exposing
  API credentials or full research output.

- **`cache_breakpoints = "explicit"` works on Anthropic models** (`api =
  "anthropic-messages"`, off by default). Two more `cache_control` markers go on
  the conversation summary and on the stable end of the room timeline, so a new
  session in the same room reads the previous session's timeline from the cache
  instead of writing it again. Before, only the system prompt and tools were
  shared between sessions.

- **Decision models** (off by default): `[models.*]` blocks with `api = "system-one"` call a
  decision model (TypeSafe Jev and drop-in alternatives, e.g. through OpenRouter's decisions
  endpoint) with typed `choice`/`score`/`noul` questions. Chains fall back member to member
  like any model; per-member `[models.*.decision]` limits (question types, option/level/question
  counts, state budget, billing mode) skip members that cannot serve a request, and the state
  is clamped to each member's budget. `compat.openrouter_routing` is sent as the request's
  `provider` object (e.g. `{ zdr = true }`); a data-policy 404 skips that member without a
  health strike. While a later member could still answer, a member waits at most its
  `[models.*.decision].attempt_timeout_ms` (default two thirds of the call's timeout), so a
  stalled member is struck and the call falls over instead of spending the whole timeout on
  it; the last member gets whatever time is left. Each decision model gets its own
  rate-limit group, so its 429s never pause chat. Spend is recorded as usage class
  `decision` (with OpenRouter's reported cost), billed to the session's payee like a tool
  call, and `[[limits]].classes` accepts `"decision"`.
  Every evaluation logs `decision_evaluated` and is stored in the `decision_evaluations` table
  with its verdict, its answers and probabilities, the state and questions sent (capped), the
  serving member and version, latency and cost; the console shows each one in the session
  view. Configured under `[decisions]`, with per-agent overrides in
  `[agents.<name>.decisions]`. See ARCHITECTURE.md §8h.
- **Decision-model routing** (`[decisions.routing]`, off by default): when a human starts a
  chat session, the decision model labels the request with every operator-defined task
  category it involves (one yes/no question per task, each with an optional own
  `threshold`; optionally a difficulty level) and with the listed skills it needs. A
  category can name a model preference cascade (`models = [...]`, tried before normal
  selection, with per-user affordability and health checks; when every entry is exhausted
  selection is unchanged), a `thinking_level`, skills to preload, and extra `tail_files`.
  Preloaded skills are loaded by synthetic `load_skill` calls at the start of the session's
  transcript, so the cached prompt prefix is unchanged and a resume finds them already
  loaded; a preload does not count as work done by the session. Several selected tasks join
  their cascades in config order and take the highest thinking level. Proactive sessions carry the built-in `proactive` task (a reserved key).
  Low confidence or any decision-model failure leaves the session exactly as before.
  Database schema v22 adds `agent_sessions.initial_preloads`.
- **Model prompts** (off by default): a model can carry its own system-prompt preamble and
  tail, defined as named `[model_prompts.<name>]` profiles and assigned with
  `[models.*].model_prompt`. The preamble is placed at the very start of the system prompt,
  the tail after the tail instructions; each text can be inline, a file in the config
  directory, or a file in the agent's workspace. Both are applied per request for whichever
  model serves it, so a session that falls back or is routed to another model sends that
  model's text, and the stored context stays model-neutral. Session types override the
  profile per model (`[agent.session_types.<type>.model_prompts]`, with `"*"` for every
  other model and `"none"` for no model prompt). Files are re-read at each session start;
  an empty file counts as unset, so placeholder files can be filled in later without a
  config change.
  Usage rows record the profile and a hash of the text sent, and the console session panel
  lists them. Database schema v23 adds `usage_events.model_prompt` and `model_prompt_hash`.
  See ARCHITECTURE.md §8 "Model prompts".
- **Session records** (`[session_records]`, on by default): every chat or proactive session
  that did tool work writes a compact record of that work in one extra turn right after it
  completes, while the prompt cache is warm. Tools that only talk in the room or steer the
  session (the resume work gate's exempt set, which now also holds `no_reply`, `load_skill`
  and `tool_search`) do not count as work, and neither does anything the harness injected
  (see "Nothing injected counts as work" under Changed). The record is written with
  `session_record_tool`, a harness-only tool the agent cannot use outside that turn, at
  interactive priority and bounded by `max_turns` (default 4); a session with nothing worth
  recording writes none. A reply to a bot message injects that message's session record
  into the new session as a synthetic `read_session_record` call and its result
  (`inject_on_reply`, default on); if the record is still being written, the reply waits for
  it up to `wait_timeout_ms` (default 60 s; `timeout_ms` is a legacy alias) and then goes
  ahead without it, while the record is still finished. The agent can read any record of
  its own on demand with `read_session_record(session_id)` (an immediate tool in chat and
  proactive sessions), which says why a record is missing (still being written, skipped,
  failed or interrupted), and open the full rollout with
  `read_session_transcript(session_id)` (deferred, in the `sessions` skill). Database
  schema v24 adds `session_records` and `decision_evaluations`.
  In the console, the session view shows the session's record, the records it was given, and
  the record turn with its harness prompt collapsed; every decision gets an inline card in
  the rollout and an entry in the details pane's Decisions list.
- **Decision-model records point** (`[decisions.records]`, off by default; needs
  `[decisions]` enabled): the decision model judges which session records a new session
  needs, for every trigger, replies or not. The candidates are the replied-to message's
  session and the sessions behind the last `candidates` bot messages (default 3) within
  `candidate_max_age_ms` (default 1 hour), each only if it has a record the new session
  could read itself; every candidate is its own request, sent in parallel with routing. A
  record whose `relevant` probability is at or above `inject_threshold` (default 0.6) is
  injected, most relevant first, up to `max_injected` (default 2); a replied-to record
  judged below the threshold is left out. When the point is off or fails as a whole, the
  reply rule applies. A failed evaluation of the replied-to record injects it when
  `inject_on_reply` is on, and a failed evaluation of any other candidate injects nothing.
  `[decisions.calibration.<model>]` can override the threshold per decision model with
  `records.inject_threshold` (or `inject_threshold`); `min_confidence` is rejected under
  `[decisions.records]`, because its one question carries no separate confidence. Startup
  logs `decisions_records_capacity_low` when a decision model's rate-limit group admits
  fewer requests at once than one trigger can send.
- **OpenAI Responses API prefill**: `[models.<name>.prefill]` forces a required `analysis` argument on every tool call via strict JSON schema `pattern`, anchoring persona adherence on GPT-6 Sol/Luna. Includes `no_reply` tool, `drop_reasoning` option, and per-serving-member gating via `onPayload`. See spec/OPENAI-PREFILL.md.
- **Captioning via OpenAI Responses API**: `[models.*]` with `api = "openai-responses"` can now serve as a caption model for images. Incomplete, refused, and unsupported-modality results are classified as content failures. (Port of MR !1 captioning code by contributor nopm.)

- **Bedrock explicit prompt-cache breakpoints** (`cache_breakpoints = "explicit"` on
  `[models.<name>]` with `api = "openai-responses"`). Injects up to 3 explicit
  breakpoints at the stable prefix boundaries (agent instructions, conversation
  summary, last stable timeline batch) so consecutive sessions in the same room
  reuse the shared prefix at Amazon Bedrock's 0.1x cache-read rate instead of
  rewriting ~28k tokens at each session start. Default off; ignored on all wire
  APIs other than `openai-responses`.

- **Adaptive-only Claude models.** `adaptive_thinking` (or the built-in id
  heuristic) now also selects the request shape on the Anthropic Messages path:
  adaptive models are sent adaptive thinking with the effort level
  `thinking_level` maps to, instead of a token budget they reject. Models that
  also reject an explicit "thinking off" can omit the field with
  `thinking_level_map = { off = null }`.
- **`compat.declare_deferred_tools`** (Anthropic Messages path, default off):
  keeps the `tools` array fixed for a whole session under dynamic tool loading.
  The full tool catalog is declared on every request, with everything outside
  the immediate set marked `defer_loading`, so a load keeps the prompt cache
  and stays valid for models that bind thinking to the request prefix. The
  load itself is a `tool_reference` block with `supports_tool_references =
  true`, or the added definitions as text in the loading tool's result for an
  endpoint or proxy that rejects the block.
- **`compat.supports_tool_references`** (Anthropic Messages path): overrides
  whether a dynamic tool load is sent as a `tool_reference` block. Unset keeps
  the automatic per-model behaviour.
- **`compat.drop_stale_thinking`** (default off): for models that bind thinking
  blocks to the exact request prefix, thinking produced before a session
  resume, or before a tool load that changed `tools`, is left out of the
  request so it is not rejected. Later thinking is still replayed.

- **Refusal rules** (`[[refusal_fallback]]`, none by default). A refusal can be
  sent to other models chosen by site, reason, refusing model, agent and routed
  task: a matching rule replaces the chain fallover, tries its `models` in order
  (`{ model, tries }` entries, `@same` retries the model that refused), keeps the
  rest of the session on the model that succeeded (with that model's own model
  prompts), and decides what happens when every entry refuses (`on_exhausted`:
  `send_last`, `withhold`, `park`); `exclude_reasons` vetoes a rule when any fired
  refusal check has a listed reason. Rules cover chat and proactive sessions, the
  session record turn, summaries, diary entries and captions. Without a matching rule,
  a refusal falls over within the call to a chain member that has not refused, costs the
  model no health strike, and is never retried on the model that refused. Anthropic refusal
  categories are recognized, a refused attempt's usage is billed to the model
  that refused, and every refusal is recorded. Database schema v25 adds
  `refusal_events`, `contract_attempts` and `agent_session_branches`, plus new
  columns on `agent_sessions`, `decision_evaluations` and `usage_events`
  (`system_prompt_hash`). See ARCHITECTURE.md §8j.

- **Output checks** (`[checks]`, `[decisions.checks]`; judged checks off by
  default). A check catalogue of refusal reasons, style issues and send-contract
  diagnostics, detected by provider stop reasons, patterns and word lists, or
  decision-model questions. Messages, `no_reply` and other endings, summaries,
  diary entries, captions and session records can be judged; a message is held
  only when a verdict could act (5 s deadline, then sent unjudged). A judged
  refusal with a matching rule discards the turn and redoes it on the rule's
  model; the discarded part is kept as a branch. Built-in refusal reasons include
  `sexual_content` (declining sexual, lewd or NSFW requests). Nine starter style
  checks ship disabled (em-dashes, "not X but Y", stock vocabulary, AI
  disclaimers, figurative "load-bearing" and more): when enabled, a flagged
  message is returned to the agent to rewrite, within per-message and
  per-session bounds, and the posting tools gain an `override_checks` argument
  for false positives. A check's `prefilter` patterns make its questions run only
  on outputs they match, so a check about one word costs nothing elsewhere.
  Per-agent overrides in `[agents.<name>.checks]`.

- **Send-contract records and redo.** Every forced-completion nudge is tagged
  and every attempt is recorded per model (`contract_attempts`, with failure
  types such as text-only replies and tool calls written as text), live and for
  history. `[agent.sessions].forced_completion_redo` (default off) discards the
  failed attempts and retries once on the same model before giving up.

- **Model behaviour page** (`/models` in the console): per-model refusal rates,
  send-contract failures and recoveries, style hits, revisions and redos, with
  an overview of every rate over time, a chart for any rate or for the mix of
  failure types, after-correction verdicts, `no_reply` intent and judged refusal
  reasons, per-model mix tables, a breakdown, an incident log linking into
  sessions, and markers for config, code and prompt changes. The scorecard sorts
  by any column and names models by config key, wire model id or both. The
  family toggle groups entries by `[models.<key>].family`, else by the wire model
  id they serve. The session view shows redo branches with a switcher, check
  cards on judged messages and endings, nudge cards, refusal markers and what
  the offline audit found, and the session list shows refused, redone, nudged,
  revised and unjudged counts. Database schema v26 adds the statistics tables,
  filled from history in the background.

- **Offline audit worker** (`[decisions.audit]`, off by default): diagnoses
  send-contract failures and judges past sessions' messages after they finish,
  so the statistics cover history too. Spend is recorded as usage class `audit`
  (`[[limits]].classes` accepts `"audit"`). `scripts/calibrate-checks.ts`
  calibrates check thresholds against model-made labels without anyone reading
  the messages; its `--any-refusal` mode measures "is this a refusal of any
  kind" (the highest score over every refusal check), sampling by the scores
  already recorded and weighting the estimates back to the whole history. The
  history backlog classifies how sessions with nudges or a `no_reply` ending
  failed before it runs refusal checks, and `/models` shows its progress.
  Database schema v27 adds `session_audits`.

- **Duplicate-send check** (`[checks.duplicate]`, off by default; needs judged
  checks): when one agent runs several sessions in parallel, a session can be
  about to post what another session of the same agent already posted to the
  same channel after this session last saw it. At every send (every posting
  tool, every session type, judged against the tool's target channel) the output
  gate collects those unseen messages, and when there are any it asks the
  decision model three questions: does the draft answer what one of them already
  answered, repeat most of it, or contradict it. A yes blocks the send with an
  error that quotes the earlier message and what it was answering and asks for a
  rewrite; `override_checks: ["duplicate"]` sends the draft as written, and the
  gate's revise bounds apply. Messages a rejection quoted count as seen, so the
  next draft is compared only with newer ones; deleted messages never count. If
  another session posts while the send waits for its verdict, the draft is
  judged once more, new messages included, within the same deadline, unless a
  check that blocks the send already fired; a recheck that misses the deadline
  leaves the verdict already in hand in force. Its chain is
  `[decisions.checks.duplicate].model` (default `[decisions].model`); per-question
  thresholds (default 0.8) go in `[checks.duplicate].thresholds`, and
  `scripts/calibrate-checks.ts --check duplicate --question <name>` calibrates
  them on pairs of sessions that sent close together. Check questions may now
  carry a `name`, and any check accepts `thresholds` by question name.

### Changed

- **A deletion no longer wipes the stored message.** A Discord deletion used to empty
  the stored message's body and attachments through the edit path (and a Matrix
  redaction did the same for a short time), re-indexing and re-summarizing it. Now
  only the deletion marker is recorded, and nothing is re-indexed, re-enriched or
  re-summarized. Database schema v31 marks the messages the old path wiped (their
  content cannot be recovered), so they show as the placeholder instead of an empty
  message.
- **A reply to the bot always triggers.** A reply to a bot message starts a session like a
  mention does, whatever `[agent.sessions.resume]` says. Before, a reply without a mention
  (such as a Discord reply with the ping turned off) triggered only where resume was on.
- **Resume is off by default** (`[agent.sessions.resume].enabled`, both `dm` and `group`). A
  reply now starts a fresh session that is given the replied-to session's record. A
  deployment that turns resume back on gets the earlier behaviour: a reply that resumes a
  session injects nothing, and the resumed run writes a new record when it ends. With late
  input on, a session stays revivable for `revive_max_ms` after its run ended and is never
  resumed in that time, so a reply within it starts a fresh session.
- **A follow-up to a finished session no longer resumes it.** With late input on, a
  follow-up the sender wrote before the session's run ended revives that session (see Late
  input). Any other follow-up to a finished session is handled as an ordinary message: one
  that triggers starts its own session. Folding into a running or not-yet-started session
  is unchanged.
- **Nothing injected counts as work.** Record loads the harness injects (`inject_on_reply`,
  the records point) and routing's skill preloads no longer count as tool work. A session
  that was given a record or a skill and did no work of its own neither writes a session
  record nor passes the resume work gate. Only the model's own tool calls count, including
  its own `read_session_record` and `read_session_transcript` calls. The send-contract
  records and the offline audit read transcripts the same way.
- **Aborted requests are billed.** A request the run aborts after it reached the provider
  (operator Stop, a tool or turn cap, a drain, a late-input redo) is now recorded with
  estimated usage: reported input and cache counts are kept, a missing prompt is estimated
  from the context, and the output is the largest of the reported output, a count of the
  streamed text, and 20 tokens per second of streaming (hidden reasoning is billed without
  streaming any text). The estimate counts toward session cost ceilings and `[[limits]]`
  like any request and is marked `estimated` (`usage_events.estimated`, and a badge on the
  console's Usage page, scheduler page and rollout). Before, such a request was recorded
  only with the usage it reported, usually none.
- **Shorter trigger hold.** The shipped `[matrix].trigger_hold_ms` drops from 2000 to
  250 ms, and with late input on every provider's trigger hold is clamped to at most 500 ms
  at startup (`trigger_hold_clamped`). Text or a picture sent after the trigger is handled
  by late input instead of by delaying every trigger.
- **Model fallback makes one pass per request.** Within one request a chain's head gets
  `recovery.llm_primary_attempts_per_request` attempts (default 2), then the request moves
  down the chain with one attempt per remaining member and no backoff between members, so a
  longer chain never means a longer outage. An unhealthy agent-loop model is re-tested by a
  small background probe, sent with the member's own `thinking_level`, instead of with live
  traffic, and no live request goes to it while another member can serve. A zero-token
  attempt cut off by `recovery.llm_request_max_wait_ms` now counts as a failure of its
  model.
- **Faster startup.** The Docker image now compiles the TypeScript to `dist/` at
  build time and runs it with plain `node` (with source maps), instead of
  transpiling the whole codebase through `tsx` on every container start.
  Independent startup work now overlaps: the native tokenizer asset loads on a
  worker thread while storage opens, sandbox containers and MCP servers come up
  concurrently (MCP tools still register in config order, so prompts are
  unchanged), the yt-dlp probe runs in the background, and chat providers start
  concurrently. The observability console starts before the providers and worker
  pools, so it answers while the rest of startup finishes. Each startup milestone
  logs `startup_phase` with its duration.
- **Prefill: past `analysis` arguments are no longer replayed to the model.** They stay in the stored transcript; the wire history is stripped deterministically so prompt caching is unaffected.
- **Silence is now a tool call.** `no_reply` is part of every chat session's tool set
  (next to `send_message`, same session-type filtering, always in the initial set
  under dynamic loading); calling it ends the turn. The shipped prompts, workspace
  templates, proactive kickoff, and forced-completion messages now say "call
  `no_reply`" instead of "output `NO_REPLY`". The text marker is still accepted for
  compatibility.
- **`x_search` streams its Grok request.** OpenRouter cancels a streamed request
  when the client hangs up, and stops billing for providers that support it
  (xAI does). A non-streamed request keeps running after a timeout and is billed
  in full, with no usage ever coming back to record. The timeout now also covers
  reading the response, and a timed-out search tells the model not to retry it in
  the same turn. A gateway that answers the streamed request with plain JSON is
  still accepted.
- **`x_search` records the provider's reported charge.** When OpenRouter returns
  `usage.cost`, the Grok ledger row uses it, since it includes the per-search fees
  that token rates cannot see. Budget caps on the Grok model now track real spend.
  Without a reported cost the configured rates are used, as before.

### Fixed

- **A failed `send_dm` or `send_to_channel` was not reported as an error.** Its result
  text did not start with `error:`, so the harness counted the message as sent (late input
  then interjected instead of redoing). Every failure of the two tools now returns an
  `error:` result.
- **Resuming a parked Discord or IRC session from the console failed.** The resume
  looked up the bot's own user id on the Matrix provider only; it now asks the session's
  own provider.
- **Discord: custom emoji were sent as literal `:name:` text.** Discord does not resolve
  shortcodes for bots, so `send_message` and `edit_message` now rewrite a `:name:` that
  matches a custom emoji the bot can use into Discord's emoji markup.
- **Caption calls ignored `compat.openrouter_routing`.** Media captioning built
  its own request and never sent the model's OpenRouter `provider` object, so a
  caption model set to `{ zdr = true }` (or pinned with `order`/`only`) was still
  routed to any provider. Chat Completions caption calls now send it, the same
  way agent sessions do.

- **Summary and diary editor errors were recorded as successful tool calls.**
  `summary_tool` and `diary_tool` returned their failures (token budget overage,
  missing diary header, `old_str` misses) instead of throwing, so the transcript
  and the console showed them as successes and the provider request carried no
  tool-error flag. They now throw, and each error still names the fix. A failed edit still reverts the draft and never
  finalizes.

- **Explicit cache breakpoints missed the timeline whenever auto-retrieval ran.**
  The per-session tail was recognised only by a bare `<retrieved_memory>` tag,
  but the block is rendered with a `note` attribute, so the last-stable-timeline
  breakpoint on Bedrock Responses models was skipped in those sessions.

- **Agent- and account-scoped `[[limits]]` rules never applied to paid tool
  calls.** The `image_generate` and `x_search` budget gate checked spend without
  the calling session's timeline, so a scoped rule could not match and a
  per-agent tool cap never blocked anything.

- **The local embedder ran every query as a full 512-token forward pass.**
  fastembed pads each input to the model's maximum length, and onnxruntime-node
  runs inference synchronously on the main thread, so embedding a short
  auto-retrieval query blocked the event loop for hundreds of milliseconds (and a
  document batch for seconds). Padding is now disabled after init; vectors are
  unchanged because padded positions are masked.

- **The console rooms list re-counted every event on each poll.** Per-room event
  and session counts are now kept in a trigger-maintained `timeline_counts` table
  (rebuilt at startup, like the pipeline counts), so the 5-second rooms poll no
  longer scans the whole event history on the agent's main thread.

- **Every context build re-tokenized the recent diary window dozens of times.**
  Trimming the recent-memory window to its token ceiling re-counted the whole
  remaining text once per dropped entry, so its cost grew quadratically with diary
  size. With busy multi-day diaries under a native tokenizer this added several
  seconds of main-thread work to every session start and every console room view.
  The trim now counts each entry once, and an unchanged window is reused without
  re-tokenizing.

- **The chat-search startup sweep took minutes and blocked startup.** Its caption
  lookup could be planned through the caption-status index, walking every captioned
  attachment for each event, and its batch loop never yielded to timers or I/O, so
  the console and the bot waited for the whole sweep. The lookup now goes by event
  and the sweep yields between batches.

- **Summary coverage selection stalled the agent for seconds at a time on large
  rooms.** The contiguity probe, the "events after cursor" query, and the summary
  lineage walk could not use their indexes (the cursor predicate gave SQLite no
  seek range; the lineage join built an automatic index over all of
  `summary_events` per call), so each of the hundreds of probes per reconcile
  scanned the room's entire history on the main thread. On a room with ~300k
  events and ~2k summaries this blocked the event loop for up to 20+ seconds,
  delaying replies and making the console unresponsive. All cursor queries now
  carry an explicit timestamp range bound and the lineage walk seeks primary keys.

- **The browser could not create a new profile on current CloakBrowser-Manager
  images.** The Manager now derives the fingerprint platform from its host runtime
  and rejects a `platform` field on profile create with HTTP 422, so the first
  browser use by any agent without an existing profile failed before loading a
  page. Profile creation no longer sends `platform`.

- **`read_image` sent large rasters at full resolution.** Only the byte size was
  checked, so a multi-megapixel JPEG under the byte cap reached the model unresized
  (enough to crash some self-hosted vision servers). Rasters over the `media.image`
  pixel budget are now resized and re-encoded like trigger attachments.
- **Browser screenshots were only bounded by byte size.** A long full-page PNG could
  reach the model at tens of megapixels while under the byte cap. Screenshots over the
  `media.image` pixel budget are now downscaled first, keeping the requested PNG or
  JPEG format.
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

### Removed

- **`[browser].platform`.** The fingerprint platform is chosen by the
  CloakBrowser-Manager from its host runtime and is no longer configurable per
  profile. Delete the key from your local config; a leftover `platform` line now
  fails config validation at startup.

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
