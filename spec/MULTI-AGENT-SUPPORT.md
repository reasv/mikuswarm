# Multi-Agent Support — Design

**Status**: PROPOSED.
Defines first-class support for multiple disjoint agents (personas) in a single
mikuswarm process: separate identities, workspaces, memories, and sandboxes,
sharing one storage layer and one set of process-wide governors (rate limits,
budgets, model health). Target ARCHITECTURE.md home once implemented: a new
"Agents and accounts" section under Core Architecture, plus per-subsystem
updates (workspace, diary, retrieval, enrichment, sandbox, budget).

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
  copies are functionally correct.

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
into every stored `timeline_key` across ~20 tables plus `usage_events`
history. Renaming one orphans the namespace: on restart the provider syncs the
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
they are safe in paths and rule scopes.

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
  `workspace_root`. `[workspace].root_dir` must be absent in this mode
  (mutually exclusive with `[agents]`; both present is a startup error — no
  silently-ignored keys). `[sandbox]` remains the shared default; per-agent
  `[agents.<name>.sandbox]` overrides it wholesale (§10).
- Workspace roots must be pairwise disjoint paths (no nesting), checked at
  startup. Each is seeded independently (`seedWorkspace` /
  `seedFeatureSkills` per root).

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
- The **context floor** (the `context_floor_event_id` mechanism the
  message-backfetch feature established) remains available as a *manual,
  explicit* operator action to cut an account's rendered history at a chosen
  point. It is never moved automatically by anything in this spec.
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

The single point where the account axis currently collapses into "one bot" is
session/workspace assembly: every session gets the one global
`config.workspace.root_dir` (`src/agent/factory.ts`), every diary lands in the
one `memory/`, and the one retrieval index spans it. §7 and §12 are the
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
indexer from the workspace root it is walking; every retrieval query
(hybrid search, auto-retrieval, recent-memory window) filters on the
requesting session's agent. One index, one embedding model, one
`embedding_cache` (content-hash keyed — safe to share by construction; shared
cache hits across agents are free wins). A per-agent index DB was considered
and rejected: `index_meta`/embedding-model state is process-global settings,
and one column is strictly less machinery.

### 7.2 Chat-history and summary search — required

`chat_index` rows are timeline-key-scoped, so the *data* is already
partitioned; the leak is in the query. The search tools (`search_messages`,
summary-corpus search, recap) must restrict matches to timelines owned by the
calling session's agent's accounts. For overlapping communities this also
kills duplicate results (every message is indexed once per observing
account); for disjoint communities it is mandatory isolation.

### 7.3 Diary and persona — solved by per-agent workspaces

One `MemoryFileWriter` per agent (keyed by workspace root); the diary pool
resolves the owning agent from each job's summary `timeline_key` and writes to
that agent's `memory/`. Summarize/diary/proactive sessions load the owning
agent's workspace files, so persona files never cross. The dictated diary
header and recent-memory window read per-agent.

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

### 7.5 User identities and profiles — shared, documented

`user_identities` / user profiles stay shared. For overlapping communities
this is a feature (one identity map). For disjoint communities it is a soft
leak (each agent's tools could surface the other community's known users);
scoping it is deferred (§14). Not identity-shaped for the *agents*, hence not
critical here.

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
- Per-user limits: unchanged mechanics; because all agents share one
  `usage_events`, a user's spend already counts across every agent — which is
  the correct default and previously impossible with N processes. The
  `isUserIdentity` predicate must include **all** agents' account self-ids so
  no sibling bot is ever metered as a user (§9).

---

## 9. Sibling awareness: loop guard and self-id sets

Trigger detection is mention/DM/reply-to-self, with no sender-is-a-bot check;
two agents that can mention each other are an unbounded ping-pong loop at LLM
prices. In one process the guard is trivial because the full set of sibling
self-ids `(provider, accountId, userId)` is known at boot:

- **Sibling messages never trigger.** A mention of / reply to agent B by
  agent A's account is ingested and stored normally (it is visible history)
  but is not a trigger for B. Default-on, not configurable in v1; a
  deliberate bot-to-bot conversation feature (with depth caps) is out of
  scope (§14).
- **Sibling messages never count toward per-user limits**: fold every
  account's self-ids across all agents into the existing bot-self-id
  exclusion set and the `isUserIdentity` predicate.
- Proactive eligibility and any "recent human activity" heuristics likewise
  treat sibling messages as bot traffic, not user traffic.

---

## 10. Sandbox

Two modes, matching the two community regimes:

- **Strict** (default when a per-agent block exists): `[agents.<name>.sandbox]`
  declares a full sandbox config — own container, own `workspace_mount` (that
  agent's workspace root). Complete filesystem isolation between agents. Cost:
  one container per agent.
- **Shared soft-isolation** (the many-personas-one-community case): agents
  without a sandbox override share the `[sandbox]` container. The container
  mounts the **common parent** of the participating agents' workspace roots,
  and each exec runs with the calling agent's subdir as working directory.
  Documented property, not a bug: `bash`/`search_files` in this mode can
  technically traverse into a sibling's workspace — acceptable by declaration
  when the operator chooses one container for many personas of one community.
  The in-process file tools remain hard-confined per agent regardless (their
  path-traversal guards are rooted at the session's `workspaceRoot`).

Validation: shared mode requires all participating roots to live under one
parent directory; strict blocks must not share `container_name` or mounts.

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
start is a new account; the floor stays a manual operator tool.

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
| `src/config/schema.ts` | `agent` field on Matrix/Discord account schemas; `[agents.*]` Record (strict values: `workspace_root`, optional `sandbox`); §4.2 validation (legacy exclusivity, unmatched names, disjoint roots) |
| `src/app.ts` | build resolver `(provider, accountKey) → {agent, workspaceRoot, memoryWriter, sandbox}`; seed each workspace; construct per-agent `MemoryFileWriter`s; fold all self-ids into limit/trigger exclusion sets (§9) |
| `src/agent/factory.ts` | both `workspace.root_dir` reads become per-session resolution from the trigger's `timeline_key` |
| `src/workspace/` | unchanged (already parameterized by root) |
| `src/diary/worker-pool.ts` | per-job agent resolution from the summary's `timeline_key`; write via that agent's `MemoryFileWriter`; per-agent recent-memory window + header |
| `src/retrieval/` | `agent` column on `memory_chunks` (+ index + migration); indexer walks every agent's `memory/`, stamping owner; all query paths filter by requesting agent; `embedding_cache` untouched |
| `src/search/` + search/recap tools | account-set filter derived from the calling session's agent (§7.2) |
| `src/enrichment/worker*.ts` | per-event root resolution; `msg-attach/<provider>.<accountKey>/` layout (§7.4) |
| `src/agent/recovery.ts` | per-session root resolution for media re-reads |
| `src/tools/*` (memory, read-image, x-fetch, character card, set-profile) | already take `workspaceRoot` via context — thread the session's resolved root |
| `src/sandbox/` | `SandboxManager` per strict agent; shared-mode parent mount + per-exec cwd (§10) |
| trigger paths (`src/matrix/inbound.ts`, `src/discord/normalizer.ts`, reply-trigger resolution) | sibling self-id suppression (§9) |
| `src/budget/` | optional `agent` matcher on rule normalization + enforcement; attribution via timeline-key parse + config map (§8) |
| console | agent/account filter chips — cosmetic, may lag all phases |

---

## 13. Phasing

Each phase lands generic and default-off; a config without `[agents]` is
behaviour-identical throughout.

1. **Agent core**: config (§4), per-agent workspace/factory/diary/recovery/
   tool roots, per-agent seeding, sibling self-id sets + trigger suppression
   (§9). Outcome: N personas with separate memories and shared governors.
   Retrieval must be disabled for all-but-one agent in this phase unless the
   operator accepts the §7.1 leak — release notes must say so.
2. **Index scoping**: retrieval `agent` column + query scoping (§7.1); search
   tool account filters (§7.2). Multi-agent becomes safe with retrieval on.
3. **Attachments**: account-scoped `msg-attach` subdirs + per-event root
   resolution (§7.4).
4. **Sandbox modes** (§10).
5. **Optional, default-off**: `agent` matcher on limit rules (§8); shared
   content-addressed attachment store with per-agent hardlinks (the only
   cache with material savings at many-personas scale; requires same-fs and
   a read-only or copy-on-write discipline); console filters.

Phases 2–5 are independent of each other once 1 is in.

---

## 14. Open questions

- **Browser subsystem**: one persistent stealth identity by design. Whether
  two agents can (or should) share it, or need per-agent browser sessions /
  managers, is unverified and unscoped here. Until resolved, multi-agent
  deployments should enable browser tools for at most one agent.
- **Bot-to-bot conversation**: deliberately allowing sibling triggers with a
  depth/turn cap. Out of scope; §9's suppression is the v1 stance.
- **`user_identities` scoping for disjoint communities** (§7.5).
- **Shared-DB write throughput**: N agents multiply write volume through the
  one single-writer queue; assumed fine at persona scale (single-digit N),
  unmeasured.
