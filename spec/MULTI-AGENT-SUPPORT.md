# Multi-Agent Support — Design

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §4c (Agents and accounts) and per-subsystem sections (§7a, §8e/§8f/§8g, §9b, §9d, §9e, §11a, §11b); retained for review.
Defines first-class support for multiple disjoint agents (personas) in a single
mikuswarm process: separate identities, workspaces, memories, and sandboxes,
sharing one storage layer and one set of process-wide governors (rate limits,
budgets, model health). Target ARCHITECTURE.md home once implemented: a new
"Agents and accounts" section under Core Architecture, plus per-subsystem
updates (workspace, diary, retrieval, enrichment, sandbox, budget).

**Settled operator decisions** (2026-07-31): relink semantics (§5) accepted as
specced; the feature ships only as one complete reviewed unit — no
intermediate state is pushed or deployed (§13); bot-to-bot replies are a
wanted feature and must be contained, not only suppressible (§9); strict
sandboxes are the recommendation, shared mode is retained with its write
hazard accepted by declaration (§10); browser resolved as per-agent Manager
profiles (§10a); §7.5 resolved — shared identity map, per-agent profile
files; the per-agent summarization cost (the one traffic-proportional cost,
which alone would sink many-personas-one-community) is addressed by opt-in
summary mirroring (§10b).

**Settled in review round 2** (2026-07-31, claims code-verified):
webhook-authored messages are always human, never bot-capped; third-party-bot
containment is a separate default-off knob (§9); a mirrored timeline whose
donor stops covering it falls back to native summarization automatically,
one-way (§10b); embedding spend is excluded from agent-scoped limit rules
(§8); the participant-naming summarization instruction ships default-on
(§10b); account-key validation is colon-only hard error (§3).

**Review round 3** (2026-07-31, code-verified): factual corrections only, no
new operator decisions — mirror-worker hook is the pool's external
`onComplete` callback (condensation is an internal call, §10b); context
builder added as a root-resolution touchpoint (§6, §12); proactive
eligibility gate added as a sibling-exclusion touchpoint (§12); recent-memory
window is file-scoped, not an index query (§7.1); self-id exclusion targets
the user-limit engine's `selfUserIds` set (§8, §9); "sibling" includes
same-agent accounts; chain counting is knob-independent; agents-mode global
browser `profile_name` is a startup error; donor-account tie-break is
deterministic (§9, §10a, §10b).

**Guiding constraint** (same as the Discord design): every change lands as a
generic, default-off upstream feature. An existing single-agent config must be
byte-identical in behaviour after every phase below. Multi-agent is enabled
only by adding `[agents.*]` config blocks.

---

## 1. Goals and non-goals

Goals:

- **Two or more fully independent agents/personas in one process.** Each has
  its own workspace (persona files, diary, memory, skills, downloads), its own
  retrieval scope, optionally its own sandbox, and its own connector
  account(s). Nothing identity-shaped ever leaks between agents.
- **Both community regimes.** Overlapping communities: multiple agents serving
  the same channels without cross-contamination (no shared memories, no
  confused message attribution, no trigger loops). Disjoint communities: no
  data visible across agents at all (their channels never overlap).
- **One persona reachable on multiple platforms.** A Matrix account and a
  Discord account can be two doors to the *same* agent — same workspace, same
  diary, same memory.
- **Shared process-wide governors.** This is the substantive reason to prefer
  one process over N containers (§2): upstream LLM rate limits, `[[limits]]`
  cost budgets, `[[user_limits]]`, per-host HTTP politeness, and the SauceNAO
  account window must be enforceable across ALL agents together, because they
  model per-API-key / per-account / per-deployment resources, not per-persona
  ones.
- **Optional agent scoping on limit rules** (§8): the ability to also write
  rules that apply to one agent, additively, without changing the meaning of
  any existing rule.

Non-goals:

- **Per-agent variation of non-identity settings.** Models, session types,
  tool configuration, enrichment/captioning/summarization tuning, global limit
  values — all remain process-global. Agents differ in identity (workspace,
  accounts, sandbox), not configuration. If a deployment needs two bots with
  different *settings*, that is what two deployments are for.
- **Multi-tenancy of end users or operators.** One operator, one console, one
  trust domain. The console sees everything.
- **A provider-neutral shared timeline** (rejected; §11.1).
- **Running N containers.** That is the zero-code baseline, not this spec. It
  remains available and remains the right answer for strict isolation with
  divergent settings. Its known deficiency — each process independently
  enforces "global" limits, so N processes on one API key/budget enforce N×
  the intended ceiling, and a user capped by one bot walks to the next with a
  fresh allowance — is precisely what §2 exists to fix.

---

## 2. Why one process — what is gained over N containers

Correctness (the significant ones):

- **One `LlmScheduler`** (`src/agent/scheduler.ts`): shared `max_in_flight`
  per rate-limit group AND shared model-health/backoff state. When a model
  starts failing, every agent inherits the backoff instead of rediscovering
  it. N processes each believe they own the provider's full concurrency.
- **One `BudgetEngine` / `UserLimitEngine`** seeded from one `usage_events`
  table: `[[limits]]` bounds the whole deployment's spend and `[[user_limits]]`
  bounds a *human* across every agent they can reach. With one shared DB this
  falls out for free — no shared-budget sidecar, no new machinery (§8).
- **One per-host HTTP limiter** (`src/tools/http-limiter.ts` is module-global
  already) and **one SauceNAO limiter** (documented as per-account-global in
  `src/saucenao/rate-limiter.ts`): the resources they model are per-deployment,
  and only one process can actually enforce that.
- **Sibling awareness** (§9): each agent knows every other agent's self-ids
  in-process, so bot-to-bot trigger loops and sibling messages polluting
  per-user limits are set-membership checks, not a config treaty between
  containers.

Efficiency (real but secondary; honest sizing):

- One node heap, native module, and tokenizer set instead of N.
- One enrichment/caption/summarization/diary worker fleet with one global
  concurrency setting, instead of N fleets each sized as if alone.
- Shared content-addressed caches come for free where they already exist
  (`embedding_cache`, the video re-encode cache). Captioning dedup is
  explicitly NOT a significant saving: the default captions trigger messages
  only, and two personas' triggers barely overlap. Link-preview dedup is
  marginal as cost but useful for not re-hitting the same URLs (politeness /
  upstream rate limits). The one storage item that matters at scale is
  **attachments**: many personas in the same channels would otherwise each
  store a full copy of the channel's media. A shared attachment store is
  deliberately deferred to an optional phase (§13, Phase 5) because per-agent
  copies are functionally correct. The one *LLM-cost* item that matters at
  many-personas scale is **summarization** — traffic-proportional per agent
  and independent of how much the persona is used — addressed by the opt-in
  summary-mirroring design (§10b), likewise default-off.

Management: one config tree with small per-agent blocks (vs N full config
dirs drifting apart), one deploy, one DB, one console. Symmetric cost: shared
blast radius — one crash or restart affects every agent.

---

## 3. Core model: accounts vs agents

The central definitional split. Everything else in this spec is a consequence
of it.

- An **account** is a connector credential: `(provider, accountKey)`, i.e. one
  entry under `[matrix.accounts.*]` or `[discord.accounts.*]`. An account owns
  its sync loop, its self-ids, and its `timeline_key` namespace
  (`<provider>:<accountKey>:…`, `src/storage/timeline-key.ts`). Two accounts
  never share timelines, even in the same channel and even under the same
  agent: each observes the channel independently and stores disjoint rows.
- An **agent** is an identity: a named bundle of workspace root (persona
  files, diary, memory, skills, downloads), retrieval scope, sandbox, and the
  value limit rules can scope on. An agent owns **1..N accounts**; every
  account belongs to **exactly one agent**.

Ownership table — which concept each piece of state belongs to:

| Account-owned (per `(provider, accountKey)`) | Agent-owned (per agent name) |
|---|---|
| timelines, summaries, sessions, reactions, reply contexts, link previews, media asset *rows*, chat index, activation state, backfill/backfetch, echo resolution, trigger claims, proactive schedule | workspace root: persona files (`SOUL.md` etc.), `AGENTS.md`, skills, `memory/` (diary), `msg-attach/` (attachment *files*, §7.4), tool downloads, character cards |
| self-ids, sync, credentials | retrieval index scope (§7.1) |
| `usage_events` rows (attributed to an agent at *read* time, §8) | sandbox container / working directory (§10) |

**Account keys are frozen identifiers, not labels.** The accountKey is baked
into every stored `timeline_key` across eleven tables (including
`usage_events` history; `media_assets` joins through `timeline_events`). Renaming one orphans the namespace: on restart the provider syncs the
same channels under new keys, the activation lifecycle treats them as
brand-new timelines, history is re-backfilled, re-enriched, re-summarized and
re-diaried at real LLM cost, and every budget/user-limit meter seeded from the
old namespace silently resets — while the old rows sit unreachable. There is
no migration path worth building (a string FK denormalized across the whole
schema). Consequence: **agent membership must never be expressed by renaming
account keys** (§11.2), and a fresh identity is created by making a *new*
account, never by renaming an old one. Accounts are free (Matrix accounts and
Discord bot applications cost nothing); key churn is not.

Agent names share the account-key character class (`[a-z0-9-]+`, no colon) so
they are safe in paths and rule scopes. Today that class is only a doc
contract — the account Records take bare strings. Phase 1 adds validation
with a deliberate back-compat asymmetry: for **account keys** (frozen;
an existing deployment with a nonconforming key cannot rename to comply
without orphaning its data), only a colon is a hard startup error — it
breaks `parseTimelineKey` (a hard parse failure in most positions, a silent
mis-parse when the segment after the colon happens to read as a valid kind),
on which §8 attribution and every
per-event resolver in this spec depend — while other out-of-class
characters only log a warning. **Agent names** are new identifiers with
nothing stored under them, so they enforce the full class strictly.

**Agent names, by contrast, are renameable.** Nothing durable stores them
except `memory_chunks.agent` (re-stamped from config by the next
reconciliation walk, §7.1) and limit-rule scopes (config; the operator
updates them in the same edit). A rename is a config edit plus one
reconciliation pass, not a data migration.

---

## 4. Configuration

### 4.1 The `agent` field and `[agents.*]` blocks

Each account block gains an optional `agent` field, **defaulting to the
account key**:

```toml
[agents.miku]
workspace_root = "./workspaces/miku"

[agents.rin]
workspace_root = "./workspaces/rin"
# optional per-agent sandbox override; absent = shared [sandbox] (§10)
[agents.rin.sandbox]
container_name = "mikuswarm-sandbox-rin"

[matrix.accounts.miku]        # agent defaults to "miku" — same-name convention
homeserver = "…"
user_id = "…"
store_path = "…"

[discord.accounts.miku-dc]
token = "${DISCORD_TOKEN_MIKU}"
agent = "miku"                # explicit link: second door to the same persona

[discord.accounts.rin]        # agent defaults to "rin"
token = "${DISCORD_TOKEN_RIN}"
```

The same-name convention is the zero-config default (naming a Matrix and a
Discord account identically links them deliberately); the explicit field
exists so that linking and unlinking are **one-line config edits that never
touch stored data** — because account keys are frozen (§3), the field is the
only mutation-safe place for this relationship to live.

The resolution map `(provider, accountKey) → agentName` is built at config
load and is **pure config**: it is never persisted, never diffed against a
stored copy, and read only at the points listed in §12. Changing it and
changing it back are both complete, side-effect-free operations (§5).

### 4.2 Legacy mode and validation

- **No `[agents]` table** → legacy single-agent mode, behaviour-identical to
  today: ALL accounts (regardless of their keys) map to one implicit agent;
  its workspace is `[workspace].root_dir`; its sandbox is `[sandbox]`. Any
  account-level `agent` field is a validation error in this mode (it could
  only be a mistake).
- **`[agents]` table present** → every account's resolved agent name MUST
  match a declared `[agents.<name>]` block (strict-config: an unmatched name
  is a startup error naming the account), and every block requires
  `workspace_root`. `[workspace].root_dir` is mutually exclusive with
  `[agents]` — but the shipped `00-defaults.toml` sets it and the TOML
  merge cannot unset keys, so "absent" is not checkable as-is.
  Prerequisite, behaviour-preserving change: make `root_dir`
  schema-optional, remove it from `00-defaults.toml`, and apply the same
  default in code when `[agents]` is absent. With that in place, an
  explicitly-set `root_dir` alongside `[agents]` is a startup error — no
  silently-ignored keys. `[sandbox]` remains the shared default; per-agent
  `[agents.<name>.sandbox]` overrides it wholesale (§10).
- Workspace roots must be pairwise disjoint paths (no nesting), checked at
  startup. Each is seeded independently (`seedWorkspace` /
  `seedFeatureSkills` per root).

### 4.3 Unresolvable accounts — one rule

Every per-event resolver in this spec (`timeline_key` → account → agent:
factory, diary, enrichment, recovery, search filters, §8 attribution) can
encounter an account that is no longer in config — queued jobs, backlogged
events, or historical rows for a removed account. One shared rule, one shared
helper: **skip the identity-dependent action and warn** (drop the diary job,
skip the download, omit the rows from agent-scoped meters and
account-filtered search). Global limit rules are unaffected (they never
resolve an agent). No resolver may guess a default agent.

---

## 5. Identity semantics: history follows the account

The settled rule, stated once and applied everywhere:

> **History follows the account; persona follows the config. The current
> agent owns everything its accounts ever said, retroactively and without
> exception.**

Re-pointing an account's `agent` field ("relink") therefore:

- changes which workspace/persona/diary/memory/sandbox its future sessions
  use — from the next session on;
- changes nothing in storage. The account's timelines, summaries, sessions and
  usage rows are untouched and remain fully rendered in context;
- is fully reversible: pointing the field back restores the previous state of
  the world exactly, because nothing was written anywhere.

Consequences, accepted deliberately:

- `role='assistant'` on timeline rows encodes self/other at the **account**
  level. After a relink, the new agent's context renders the account's old
  assistant turns as its own first-person speech — including words uttered
  under the previous persona — while the previous persona's diary stays in the
  previous agent's workspace. This asymmetry is accepted: the alternative
  (automatic history rebasing) was examined and rejected (§11.3) because it is
  irreversible, requires hidden persisted state, and encodes an assumption
  about operator intent. An operator who wants a persona with no inherited
  history creates a **new account** (§3) — that is the supported "fresh
  start", and it is free.
- The **context floor** (`context_floor_event_id`, established by the
  message-backfetch feature) remains the mechanism for cutting an account's
  rendered history. Note its actual shape: it is set automatically (set-once)
  by the backfetch runner when the operator triggers a backfetch job from the
  console — there is no direct "set floor at point X" operator affordance
  today, and this spec neither adds one nor moves the floor automatically.
- Attachment files downloaded under the previous agent's workspace do not
  follow automatically; §7.4 defines the layout that makes moving them a
  single documented `mv`.

---

## 6. What already works with no changes

For the implementer's orientation — the transport and storage layers are
already multi-account end-to-end, and none of this spec touches them:

- `[matrix.accounts.*]` / `[discord.accounts.*]` are Records; sync loops,
  self-id resolution (`provider.getSelf(accountId)`), redecryption retry and
  gap backfetch are all per-account.
- `timeline_key` carries the accountId through every keyed table, so two
  accounts in the same channel already produce fully disjoint timelines,
  summaries, sessions, indexes and usage rows.
- A sibling agent's messages arrive as ordinary `role='user'` rows from
  another participant — which is semantically correct, so "the chatlog is not
  neutral" is a non-issue by construction: no log is ever shared between
  agents, each account records its own view.
- Summarization, diary *scheduling*, proactive posting, activation lifecycle,
  echo resolution and trigger claims are all timeline-key-scoped.

The account axis currently collapses into "one bot" at session/workspace
assembly: every session gets the one global `config.workspace.root_dir` —
read by the session factory (`src/agent/factory.ts`) and directly by the
context builder (`src/context/builder.ts`) — every diary lands in the one
`memory/`, and the one retrieval index spans it. §7 and §12 are the
enumeration of exactly those convergence points.

---

## 7. Isolation requirements (the leak audit)

In severity order. "Leak" means agent-identity material crossing agents; the
console/operator sees everything by design.

### 7.1 Memory retrieval — critical

`memory_chunks` has no owner column; the index spans whatever `memory/` it is
pointed at. With per-agent workspaces feeding one index, agent B would
retrieve agent A's diary verbatim.

Required: an `agent` column on `memory_chunks`, stamped by the reconciliation
indexer from the workspace root it is walking; every index query path
(hybrid search and context auto-retrieval) filters on the requesting
session's agent. (The recent-memory window is not an index query — it reads
`memory/*.md` files straight from the workspace, so it is per-agent by
construction once roots are per-agent, §7.3.) One index, one embedding model, one
`embedding_cache` (content-hash keyed — safe to share by construction; shared
cache hits across agents are free wins). A per-agent index DB was considered
and rejected: `index_meta`/embedding-model state is process-global settings,
and one column is strictly less machinery.

One subtlety is load-bearing: chunk identity is `id =
sha256(<workspace-relative path>\0<chunk text>)`, so two agents whose
workspaces contain an identically-named file with an identical chunk
(seeded boilerplate, shared headers) collide on `id` — with a single owner
column, each agent's reconciliation walk would re-stamp the shared row to
itself, flapping ownership and hiding the chunk from the other agent's
retrieval. Uniqueness therefore becomes `(agent, id)`: two rows, one per
owner. Do NOT widen the `id` derivation itself — hashing the agent in
would invalidate every existing row and force a full re-embed on upgrade.

Migration and legacy semantics: the column is added nullable; existing rows
stay NULL. In legacy mode nothing stamps or filters (single implicit agent,
behaviour-identical). On first startup with `[agents]`, the reconciliation
walk stamps rows in place: a walked chunk whose `id` (the path+text
content address the reconciler already keys on) matches an indexed row
gets its `agent` set to the walking agent's name — no re-chunk, no
re-embed. Agents-mode queries filter `agent =
<requester>`, which excludes any still-NULL stragglers (safe by default);
NULL rows whose files no longer exist under any root are deleted by the
normal reconciliation diff. This is also the upgrade path for an existing
single-agent deployment: point one agent's `workspace_root` at the old
`[workspace].root_dir` and the index re-owns itself on the first walk.

### 7.2 Chat-history and summary search — required

`chat_index` rows are timeline-key-scoped, so the *data* is already
partitioned, and the default query path is too: `search_messages` and `recap`
resolve `rooms` to the current timeline unless the agent passes
`rooms: "all"`, which drops the timeline filter entirely. That `"all"` path
(and summary-corpus search over it) is the leak: it must restrict matches to
timelines owned by the calling session's agent's accounts. For overlapping
communities this also
kills duplicate results (every message is indexed once per observing
account); for disjoint communities it is mandatory isolation.

### 7.3 Diary and persona — solved by per-agent workspaces

One `MemoryFileWriter` per agent (keyed by workspace root); the diary pool
resolves the owning agent from each job's summary `timeline_key` and writes to
that agent's `memory/`. Summarize/diary/proactive sessions load the owning
agent's workspace files, so persona files never cross. The recent-memory
window reads per-agent (workspace files); the diary header is derived from
job timestamps and needs nothing.

### 7.4 Attachments — required, with a relink story

Enrichment currently writes downloads to `<workspaceRoot>/msg-attach/…` and
stores workspace-relative `local_path` on `media_assets`. Under multi-agent,
the enrichment worker resolves the owning agent's root from the event's
`timeline_key` at download time, and writes to an **account-scoped subdir**:

```
<agentRoot>/msg-attach/<provider>.<accountKey>/…
```

Stored `local_path` stays workspace-relative and includes the subdir. This
makes the relink story a one-liner: moving an account to another agent, the
operator moves that one subdir (`mv`) and every stored path remains valid
under the new root — the file layer stays human-fixable, consistent with §5.
Pre-existing flat `msg-attach/` paths remain valid for the agent that inherits
them (no migration; paths are stored per-row). If the files are not moved,
context is unaffected (captions/detected content live in the DB); only direct
file access to old attachments degrades, soft.

The same per-event root resolution applies to every other workspace write
made on behalf of a timeline (x_fetch downloads, character card output), and
to session recovery's media re-reads (`src/agent/recovery.ts`).

### 7.5 User identities and profiles — resolved: shared DB map, per-agent files

Two different stores, two different answers:

- **`user_identities` / `user_identity_aliases` (DB) stay shared.** Audited:
  the rows hold only `(provider, user_id, username, display_name, seen
  timestamps)` plus up to 16 prior name pairs, written only by Discord ingest
  (the Matrix path is a guaranteed zero-write). Their only agent-facing
  consumer is the context builder, which does keyed lookups for senders
  already present in the timeline being rendered — and timelines are
  account-scoped, so an agent can only ever resolve identities of users its
  own accounts observe. No tool enumerates or searches the table (the
  provider-wide index is console-only). With current consumers the
  cross-community leak is therefore unreachable, and the table stays shared
  with one standing rule: **any future agent-facing consumer of
  `user_identities` must filter to senders observed by the calling agent's
  accounts.**
- **User profile *files* are per-agent by construction.** The
  `user_profile_read`/`user_profile_edit` tools operate on
  `<workspaceRoot>/users/<provider>/…` — workspace files, not DB rows — so
  under per-agent workspaces each persona keeps its own private notes about
  the humans it knows. For overlapping communities this is the desired
  no-leak behaviour, not a deficiency.

### 7.6 Sandbox — see §10

### Needs nothing

Timelines, summaries, sessions, reactions, proactive scheduling, activation
state, echo resolution, trigger claims, backfill/backfetch — all
account-scoped already (§6). Logs and context dumps are operator-facing.

---

## 8. Limit-rule scoping and usage attribution

`usage_events` already stores `timeline_key` and `provider` per row, and the
schema's established pattern for scoped rules is resolve-at-admission +
denormalized columns (`room_id`, `space_id`) with matching reseed indexes.

- **New optional rule matcher**: `agent = "<name>"` on `[[limits]]` and
  `[[user_limits]]` rules (and, should it ever be needed, `account =
  "<provider>:<key>"` — same shape). Absent = global: **every existing rule
  keeps its exact meaning**; the feature is purely additive.
- **Attribution is derived at seed/enforcement time**, not stored: parse the
  event's `timeline_key` → `(provider, accountKey)` → current config map →
  agent. No schema change. This is a deliberate decision, consistent with §5:
  after a relink, the account's historical spend counts toward its *current*
  agent — "the agent owns everything its accounts have, retroactively". A
  denormalized `agent_id` column (attribution frozen at insert) was considered
  and rejected because it makes usage attribution the one place where a relink
  is *not* a pure config edit. The seeding paths already parse timeline keys
  (that is how `room_id` is derived); the added cost is a map lookup.
- **Background lanes already stamp `timeline_key` — except embedding.**
  `usage_events.timeline_key` and `provider` are nullable, but the
  agent-session lanes (summarize, diary, proactive) stamp them via the
  factory's usage emit, and captioning carries the key through its claim
  query. The one NULL-writing lane is embedding — and it cannot be
  stamped: memory-chunk embedding is workspace-file-scoped, not
  timeline-scoped. Accepted consequence (settled): **agent-scoped rules
  never count embedding spend** — fractions of a cent, still visible to
  global rules as today. Agent-scoped rules match only attributable rows
  (NULL-key rows count toward global rules exactly as today); rows for
  accounts no longer in config are likewise skipped by agent-scoped rules
  (§4.3).
- Per-user limits: unchanged mechanics; because all agents share one
  `usage_events`, a user's spend already counts across every agent — which is
  the correct default and previously impossible with N processes. The user
  limit engine's self-id exclusion set (`selfUserIds`, checked alongside the
  `isUserIdentity` shape predicate) must include **all** agents' account
  self-ids so no sibling bot is ever metered as a user (§9).

---

## 9. Sibling awareness: self-id sets and contained bot-to-bot replies

"Sibling" throughout this section means **any other account in the process,
including a second account of the same agent** — two doors of one persona
must not trigger each other any more than two personas may.

Trigger detection is mention/DM/reply-to-self, with no sender-is-a-bot check;
two agents that can mention each other are an unbounded ping-pong loop at LLM
prices. In one process the guard is cheap because the full set of sibling
self-ids `(provider, accountId, userId)` is knowable up front — with one
correction to "known at boot": Discord self-ids currently resolve at gateway
READY, not from config. Before any inbound processing starts, self-ids for
every account must be resolved eagerly (one REST `GET /users/@me` per Discord
account at startup), so the suppression sets are complete before the first
event — no startup window where a sibling triggers or is metered as a user.

- **Sibling messages never count toward per-user limits**: fold every
  account's self-ids across all agents into the trigger-path bot-self-id
  exclusion sets and the user limit engine's `selfUserIds` set (§8). Holds
  in every mode below.
- Proactive eligibility and any "recent human activity" heuristics likewise
  treat sibling messages as bot traffic, not user traffic, in every mode.
- **Sibling replies are governed by a process-global mode** (the default is
  full suppression):

  ```toml
  [siblings]
  replies = "never"        # default; sibling messages never trigger
  # replies = "capped"     # bot-to-bot conversation with hard containment
  max_bot_chain = 4        # capped mode: bot messages allowed since last human message
  ```

  - `"never"`: a mention of / reply to agent B by agent A's account is
    ingested and stored normally (it is visible history) but is never a
    trigger for B.
  - `"capped"`: a sibling mention/reply triggers only while the observing
    account's timeline contains fewer than `max_bot_chain` bot-authored
    messages since the most recent human message in that channel.
    **Counting is knob-independent**: bot-authored means self, any sibling,
    or a flagged third-party bot (`author.bot` without `webhook_id`);
    webhook-authored messages count as human. The `replies` /
    `third_party_bots` knobs gate only whether a message may *trigger*,
    never how it is counted. Any human message resets the window; at the cap, every
    agent goes silent until a human speaks, so a back-and-forth always
    terminates. The counter spans *all* bots in the channel, not per-pair,
    so K agents cannot multiply the ceiling; in-flight generations racing
    the cap can overshoot by at most the number of concurrently-triggered
    agents. Bot-to-bot spend still counts toward deployment `[[limits]]`
    (spend is spend) and never toward any per-user meter.

- **Third-party bots** (not siblings): Discord exposes `author.bot` and
  `webhook_id`, both currently dropped by the normalizer; extract and
  store both. **Webhook-authored messages (`webhook_id` set) are always
  treated as human** — bridge puppets relay real humans through webhooks,
  so capping or suppressing them would mute bridged users. Genuine bot
  senders (`author.bot` without `webhook_id`) get their own knob:

  ```toml
  [siblings]
  third_party_bots = "unlimited"  # default; today's behaviour — no cap
  # third_party_bots = "capped"   # apply the same max_bot_chain window
  ```

  The default is `"unlimited"` because that is the status quo (the
  byte-identical constraint); `"capped"` opts foreign bots into the chain
  window above — without it, an agent can still ping-pong with someone
  else's bot regardless of sibling handling. Matrix has no reliable bot
  marker; out of scope there (§14).

**Bridged channels caveat** (documented limitation): "one persona, two doors"
assumes the two doors see *different* conversations. If a channel is bridged
Matrix↔Discord and one agent has an account on both sides, each account
observes every message independently and the persona replies twice. Do not
attach two accounts of one agent to bridged views of the same conversation;
detecting bridges automatically is out of scope.

---

## 10. Sandbox

Two modes, matching the two community regimes:

- **Strict** (default when a per-agent block exists): `[agents.<name>.sandbox]`
  declares a full sandbox config — own container, own `workspace_mount` (that
  agent's workspace root). Complete filesystem isolation between agents. Cost:
  one container per agent.
- **Shared soft-isolation** (the many-personas-one-community case): agents
  without a sandbox override share the `[sandbox]` container. The operator
  sets `workspace_mount` to the **common parent** of the participating
  agents' workspace roots (validated at startup: every participating root
  must live under it), and each exec runs with the calling agent's subdir as
  working directory (the exec backend's per-call `cwd` support already
  exists). Documented property, not a bug — and stated at full strength:
  `bash` in this mode can **read and write** sibling workspaces, including
  their persona files and memory. Cross-agent workspace writes are
  cross-agent prompt injection; choosing shared mode accepts that hazard by
  declaration. The in-process file tools remain hard-confined per agent
  regardless (their path-traversal guards are rooted at the session's
  `workspaceRoot`). Per-exec isolation inside one container was examined and
  rejected: `docker exec` cannot scope mount namespaces per exec, and
  per-agent Unix users break on host-side bind-mount ownership (the node
  process writes the same trees as itself).

Sizing note: the "cost: one container per agent" of strict mode is mostly
imagined — an idle sandbox container is a sleeping process worth a few MB,
and the image is shared. Containers are NOT lazily created today:
`SandboxManager.ensure` runs once at startup (fail-fast), and nothing
re-ensures after that — under multi-agent, strict mode ensures N containers
at startup the same way. (Compose is uninvolved either way: the sandbox is a
sibling container the agent creates by driving the docker CLI, never a
compose service.) At a-dozen-personas scale, **strict mode is the recommended
default**; shared mode exists for operators who prefer one container anyway
and accept the hazard above.

Validation: shared mode requires all participating roots to live under one
parent directory; strict blocks must not share `container_name` or mounts;
and **no strict agent's workspace root may lie under the shared
`workspace_mount` parent** — otherwise the shared container's mount
exposes the strict agent's workspace and its isolation guarantee is
silently void.

## 10a. Browser: per-agent Manager profiles

Resolved (previously an open question). The CloakBrowser-Manager is already a
multi-profile service — `POST /api/profiles` creates named profiles with
their own fingerprint seed, cookie state and launch lifecycle, and each
profile exposes its own CDP endpoint. The one-browser limit is a mikuswarm
choice (one `BrowserSession` bound to `[browser].profile_name`), not a
Manager constraint. Browser access becomes per-agent and default-off:

```toml
[agents.rin.browser]
profile_name = "rin"   # required in the block; connection settings inherited from [browser]
```

- An agent with a `browser` block gets its own `BrowserSession` (own Manager
  profile, lazily launched on first tool use — the launch endpoint is already
  idempotent; the session tab map is keyed by chat session id, so N sessions
  coexist cleanly). An agent without one gets no browser tools.
- Legacy mode: the global `[browser]` block is the implicit agent's browser —
  byte-identical behaviour. With `[agents]` present, the global `[browser]`
  block supplies connection settings only; a global `profile_name` explicitly
  set alongside `[agents]` is a startup error (no silently-ignored identity
  keys — the same rule as `[workspace].root_dir`, §4.2, including the same
  schema-optional treatment if a shipped default ever sets it).
- Validation: `profile_name`s must be pairwise distinct across agents.
- Sharing one profile between personas was rejected: a profile carries
  outward identity (fingerprint, cookies, logins) — two personas sharing one
  are the same "user" to every site they touch, and each can read sessions
  the other logged into. The browser profile is identity-shaped, and
  identity-shaped state never crosses agents (§1).
- Cost is real here (unlike sandbox containers): each running profile is a
  full stealth browser. Lazy launch bounds it to agents that actually browse.

## 10b. Summary mirroring: one summarizer per community

> **IMPLEMENTED** — superseded by ARCHITECTURE.md §9b "Summary mirroring" and §4c "`summaries_from` validation"; retained for review.

Motivation: summarization is the one **traffic-proportional per-agent LLM
cost** — it scales with channel volume, not with how much a persona is used.
N agents in one community pay N× for near-identical work, which on its own
would kill the dozen-personas deployment. Every other background cost is
already participation-gated or trigger-gated (diary skip-gates ranges with
zero own assistant messages; captioning defaults to trigger messages only).
Mirroring makes the whole background cost of an extra persona in a covered
community approximately zero; what remains scales with actual participation.

Two sharing shapes were considered and rejected:

- **Render-time layer theft** (secondary disables summarization and renders
  the donor's summary layer directly): summaries are not just a render
  layer — the level-1 rows ARE the diary queue (`diary_status`), the FTS
  corpus for `corpus:"summaries"`, recap's coverage source, and
  `expand_summary`'s lineage anchor. Every consumer would need
  cross-timeline redirection, diary would lose its trigger entirely, and
  becoming independent later requires a wholesale state copy.
- **Independent-range matching** (secondary computes its own ranges, then
  steals a covering donor summary): unfixable misalignment. Chunk boundaries
  are compact-token-accumulation driven and include each agent's *own*
  assistant turns, so two accounts never compute the same boundaries even in
  principle, and condensation (runs of `condense_fanout`) compounds the skew
  upward.

The design instead **adopts the donor's tiling**: mirrored summaries become
real rows in the secondary's timeline, inserted through the normal path.

```toml
[agents.rin]
workspace_root = "./workspaces/rin"
summaries_from = "miku"   # optional; the named donor agent must not itself mirror (no chains)
```

Mechanics:

- **Per-timeline, not global**: a timeline of the secondary is mirrored iff
  the donor has an account observing the same `(provider, channel[, thread])`.
  Every other timeline (the secondary's DMs, channels the donor is not in)
  summarizes natively, unchanged. This falls out of the definition; there is
  no global summarization switch. If the donor has more than one account of
  its own observing the same channel (degenerate but legal), the mirror
  source is picked deterministically — first matching account in config
  order — and logged.
- **Coordinate system**: `timeline_events.external_id` (Matrix event id /
  Discord snowflake) and `timestamp` (`origin_server_ts`) are identical
  across two accounts observing one channel; only internal ids and
  `timeline_key` differ, and the `(provider, external_id)` index already
  exists. Donor lineage therefore translates row-by-row.
- **L1 mirror**: a mirror worker watches donor summary completions (hooked
  on the summarization pool's external `onComplete` callback — already wired
  to the indexer and diary pool; condensation itself runs as an internal
  call inside the pool, not on this hook — plus a periodic reconciliation
  sweep)
  and, per summary, copies `content`/`token_count`/`model_id`/timestamps/status and
  maps `summary_events` lineage via `external_id` into the secondary's rows
  (the donor's timeline contains the secondary's messages as ordinary
  participants, so coverage is near-total; unmatched events drop from
  lineage). Inserting via `insertSummaryWithLineage` sets
  `diary_status='pending'` — **diary falls out for free, and stays
  authentic**: the diary-range build re-reads the raw events from the
  secondary's *own* timeline (its own turns as `assistant`), and the
  skip-gate prunes ranges where the persona never spoke.
- **L2+ mirror**: copy the condensation tree using a donor-id → mirror-id map
  for `summary_parents`. The condensation evaluator MUST skip mirrored
  timelines, or it would re-condense at real LLM cost; likewise the
  summarization indexer never enqueues level-1 jobs for them.
- **Consumers unchanged**: coverage selection, rendering, summary FTS,
  `recap` and `expand_summary` all operate on the secondary's own real rows
  and lineage. Drill-down degrades to "constituents unavailable" exactly
  where the events don't exist locally (pre-join history).
- **Wait-or-omit**: on a mirrored timeline, "reconcile" means sweep the
  mirror and escalate the *donor's* covering job priority — interactive
  pressure crosses the link instead of spawning duplicate work. If no
  covering donor job exists yet, the sweep has the donor's indexer enqueue
  the covering range immediately (threshold bypassed).
- **Status propagation**: donor `superseded`/`truncated` transitions are
  propagated by the mirror sweep (idempotent reconciliation, like the other
  indexers).

Transition and failure modes:

- **Becoming independent is the null operation**: remove `summaries_from`
  and the coverage cursor sits at the last mirrored summary; the indexer's
  normal threshold logic sees the un-summarized tail and starts chunking
  natively from there. No backfill, no state copy.
- **Donor liveness — fall back, never stall** (settled): a timeline is
  mirrored only while the donor is actually covering it. If donor
  summaries stop coming — donor account removed from config, donor left or
  was kicked from the channel, or donor coverage stalls past a threshold —
  the secondary's indexer resumes native summarization from the end of
  mirrored coverage (mechanically the previous bullet, triggered
  automatically). The stall threshold is an implementer default defined
  relative to `generation_threshold_tokens` — e.g. flip when the un-mirrored
  tail exceeds the native generation threshold and a sweep escalation
  produces no covering donor job. The flip is **one-way per timeline**: once a timeline
  has native summaries it never becomes mirrored again — donor and
  secondary tilings never align, so re-mirroring would splice misaligned
  chunk boundaries.
- **Sync-gap divergence** (events one account has and the other lacks —
  decryption failures, join windows): the contiguity probe stops the
  secondary's coverage cursor early and the tail renders raw. Safe
  degradation, not corruption.

Accepted properties and requirements:

- **Perspective skew, mitigated**: the summarize/condense session
  instructions gain a requirement to refer to every participant — *including
  yourself* — by name. Summaries observed in practice already do this; the
  instruction pins the behaviour against model drift rather than changing
  it, so it ships default-on (settled — changes nothing observable). It
  also makes summaries relink-safe (§5), since first-person summary text is
  what would make a summary owner-specific. Residual donor-perspective
  focus in mirrored text is accepted by the operator choosing
  `summaries_from`.
- **Pre-join history**: donor summaries predating the secondary's first
  event mirror with empty lineage — renderable ancient history, no
  drill-down, diary skipped. The inverse topology (secondary has events
  *older* than the donor's coverage start) makes the timeline
  mirror-ineligible: it summarizes natively, like any timeline that
  already has native summaries (a per-timeline DB condition, so the mirror
  sweep decides it — startup config validation cannot see it). The
  intended mirroring case is a new persona joining an already-covered
  community.
- **Cost attribution**: mirrored rows cost ~nothing; the donor's meters
  absorb the community's whole summarization load. Visible — and
  intentionally schedulable — via the §8 `agent` matcher.
- **Trust**: donor session output enters the secondary's context verbatim.
  Siblings are one operator's trust domain and already read each other's
  messages as history; documented, not guarded.
- **Not a neutral shared timeline** (§11.1 stands): rows, ownership and
  every per-observer mechanism stay per-account; only summary *text* is
  replicated, through the existing insert path.

---

## 11. Rejected alternatives

Recorded so the implementer does not re-derive them.

### 11.1 Provider/agent-neutral shared timeline

Store channel history once, neutrally, and share it between co-located
agents. Rejected: `role`, echo resolution, trigger claims, resume
generations, reaction attribution, context floor and activation state are all
inherently per-observer; making them neutral is a timeline-layer rewrite — to
deduplicate the *cheapest* data (text rows). The expensive duplicated work is
better addressed by content-addressed caches (§13 Phase 5), which need no
timeline changes. Per-account timelines also make each agent's view
self-consistent by construction (a sibling is just another `user` sender).

### 11.2 Agent linkage by account-key naming alone

"Same key on two providers = same agent" **as the mechanism** (not just the
default). Rejected: account keys are frozen (§3), so changing agent
composition would require key renames — which orphan stored namespaces and
re-ingest history at real cost — and independently-chosen identical names on
two providers would silently merge personas, the exact accident this whole
design exists to prevent. The convention survives as the *default value* of
an explicit, mutation-safe field (§4.1).

### 11.3 Automatic context-floor on relink

On detecting an account's `agent` changed, floor its timelines so the new
agent does not inherit first-person history it never uttered. Rejected: it
turns a config edit into a persistent, hard-to-reverse data mutation
(reverting a split has no well-defined un-floor target); it requires hidden
state (a persisted account→agent map plus boot-time diffing) purely to detect
the change; and it encodes an assumption about operator intent. The
assumption-free rule is §5: relinked history is owned wholesale; a fresh
start is a new account; the floor stays operator-initiated (via backfetch,
§5), never automatic.

### 11.4 A shared budget/limits sidecar for N processes

Making N containers share governors via an external store. Rejected as
strictly more machinery than hosting N agents in the process whose governors
are already singletons — the entire correctness column of §2 falls out of
co-location for free.

### 11.5 Filesystem-level dedup instead of the Phase-5 store

Delegating attachment dedup (§13 Phase 5) to the host filesystem was
considered and rejected as the *shipped* mechanism:

- **FUSE deduplicating filesystems**: privileged mounts and mount-propagation
  friction with Docker binds, real overhead, poor maturity. Rejected outright.
- **ZFS inline dedup**: the DDT is pool-level state and `dedup=on` changes the
  write path and is effectively irreversible until the data is rewritten — a
  whole-pool operational commitment, disproportionate for deduplicating tens
  of GB, and unreasonable to demand of a host serving other workloads. ZFS
  also lacks `FIDEDUPERANGE`, so out-of-band tools cannot target it, and block
  cloning is another sticky pool feature that still requires application-side
  `copy_file_range`. Never a recommendation.
- **Out-of-band `FIDEDUPERANGE` (btrfs/XFS via `duperemove`/`bees`)**: genuinely
  free where available — userspace tool, no format commitment, CoW-safe extent
  sharing invisible to Docker binds. This is a legitimate *operator-side
  complement*, worth an ops-documentation note, but upstream cannot assume the
  host filesystem, so it cannot be the mechanism.

Conclusion: the app-level content-addressed store with hardlinks (Phase 5)
remains the portable mechanism — plain POSIX, no filesystem opinions, and the
only variant that also avoids duplicate *downloads* and yields content hashes.
Its adoption of pre-existing files is a resumable background reconciliation
sweep (hash → `link()` into the store, or link+`rename()` swap for
duplicates), idempotent via inode comparison, never rewriting stored paths.

---

## 12. Implementation touchpoints

The composition root (`src/app.ts`) constructs everything via options
objects, so this is plumbing, not redesign. The account→agent map and the
per-agent root resolver are built once at startup and injected.

| Site | Change |
|---|---|
| `src/config/schema.ts` | `agent` field on Matrix/Discord account schemas; `[agents.*]` Record (strict values: `workspace_root`, optional `sandbox`); §4.2 validation (legacy exclusivity, unmatched names, disjoint roots); make `workspace.root_dir` schema-optional + drop from `00-defaults.toml` with code-side default (§4.2); §3 key/name validation (colon = hard error on account keys, warn otherwise; full class on agent names) |
| `src/app.ts` | build resolver `(provider, accountKey) → {agent, workspaceRoot, memoryWriter, sandbox}` (today's single `workspace.root_dir` resolution at app.ts is the injection point everything else inherits from); seed each workspace; construct per-agent `MemoryFileWriter`s; resolve all account self-ids eagerly before inbound starts and fold them into limit/trigger exclusion sets (§9) |
| `src/agent/factory.ts` | both `workspace.root_dir` reads become per-session resolution from the trigger's `timeline_key` |
| `src/context/builder.ts` | its two direct `workspace.root_dir` reads become the session's resolved root (passed in, like the tools) |
| `src/workspace/` | unchanged (already parameterized by root) |
| `src/diary/worker-pool.ts` | per-job agent resolution from the summary's `timeline_key`; write via that agent's `MemoryFileWriter`; per-agent recent-memory window + header |
| `src/retrieval/` | `agent` column on `memory_chunks` (+ `(agent, id)` uniqueness + index + migration, §7.1); indexer walks every agent's `memory/`, stamping owner; all query paths filter by requesting agent; `embedding_cache` untouched |
| `src/search/` + search/recap tools | account-set filter derived from the calling session's agent (§7.2) |
| `src/enrichment/worker*.ts` | per-event root resolution; `msg-attach/<provider>.<accountKey>/` layout (§7.4) |
| `src/captioning/` | same per-event root resolution for media reads (takes `workspaceRoot` as a constructor option today, like enrichment) |
| `src/summarization/` | mirror worker (donor-completion watch, `external_id` lineage mapping, condensation-tree copy, status propagation); indexer + condensation evaluator skip mirrored timelines; participant-naming tweak in summarize/condense instructions (§10b) |
| `src/agent/recovery.ts` | per-session root resolution for media re-reads |
| `src/tools/*` (memory, read-image, x-fetch, character card, set-profile) | already take `workspaceRoot` via context — thread the session's resolved root |
| `src/sandbox/` | `SandboxManager` per strict agent; shared-mode parent mount + per-exec cwd; §10 validation incl. no-strict-root-under-shared-mount |
| `src/browser/` + factory | per-agent `BrowserSession` construction and session routing (§10a) |
| trigger paths (`src/matrix/inbound.ts`, `src/discord/normalizer.ts`, reply-trigger resolution) | sibling self-id handling per `[siblings]` mode; extract Discord `author.bot` + `webhook_id` (§9) |
| `src/proactive/scheduler.ts` | eligibility gate counts `role !== 'assistant'` as human activity today — exclude sibling senders by self-id set (§9) |
| `src/budget/` | optional `agent` matcher on rule normalization + enforcement; attribution via timeline-key parse + config map (§8; embedding-lane rows have no `timeline_key` and match only global rules) |
| console | BFF's single `workspaceRoot` dependency becomes per-session agent resolution (context/media re-reads are functional, not cosmetic); agent/account filter chips may lag all phases |

---

## 13. Phasing

Each phase lands generic and default-off; a config without `[agents]` is
behaviour-identical throughout. **Phases are implementation checkpoints on
one feature branch, not release points**: the feature merges and ships as a
single reviewed unit after all phases, and this deployment does not rebuild
onto any intermediate state — so no phase needs an interim-safety release
note.

1. **Agent core**: config (§4, incl. key/name pattern validation §3 and the
   §4.3 unresolvable-account rule), per-agent workspace/factory/diary/
   recovery/tool roots, per-agent seeding, eager self-id resolution + sibling
   sets with default `"never"` suppression (§9). Outcome: N personas with
   separate memories and shared governors. (Not independently shippable:
   with retrieval enabled, Phase 1 alone has the §7.1 leak — Phase 2 closes
   it before anything ships.)
2. **Index scoping**: retrieval `agent` column + query scoping + legacy
   re-stamp walk (§7.1); search tool account filters on the `rooms:"all"`
   path (§7.2). Multi-agent becomes safe with retrieval on.
3. **Attachments**: account-scoped `msg-attach` subdirs + per-event root
   resolution (§7.4).
4. **Sandbox modes** (§10) and per-agent browser profiles (§10a).
5. **Optional, default-off**: `agent` matcher on limit rules (§8);
   `[siblings] replies = "capped"` bot-to-bot containment, the
   `third_party_bots` knob and Discord `author.bot`/`webhook_id` extraction
   (§9); **summary mirroring**
   (§10b) with the participant-naming instruction tweak (the tweak itself is
   generic and may land in any earlier phase); shared content-addressed
   attachment store with per-agent hardlinks (the only *storage* item with
   material savings at many-personas scale; requires same-fs and a read-only
   or copy-on-write discipline); console filters.

Phases 2–5 are independent of each other once 1 is in.

---

## 14. Open questions

Resolved since first draft: browser (per-agent Manager profiles, §10a),
bot-to-bot conversation (capped mode, §9), `user_identities` scoping
(audited; shared with a guard rule, §7.5), third-party bots and webhooks
(§9), donor-silent mirroring fallback (§10b), embedding-spend attribution
(excluded from agent-scoped rules, §8), shared-DB write throughput
(non-issue: SQLite is single-writer regardless — multi-agent adds row
volume through the same queue, not a new bottleneck).

- **Matrix third-party-bot marking**: no reliable bot flag exists on Matrix;
  the §9 chain cap covers siblings and flagged Discord bots only.
