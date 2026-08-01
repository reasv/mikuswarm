# Console Multi-Agent Adaptation — Design

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §11 "Observability console (in-process read API + SSE)" and "Console frontend (SvelteKit BFF, `console/`)", plus the §4c note; retained for review.

**Settled operator decisions** (2026-08-01): labeling is **agent-primary,
account-secondary** (§3) — where the UI today shows account tags it shows
the agent instead, with the account demoted to a disambiguator; the
**provider is never implicit** — single-platform agents carry their
provider on the agent tab, multi-platform agents carry an explicit `MULTI`
indicator (an empty slot is not a state, §3.2); the agents meta endpoint
ships with **minimal scope** — mode + agent names + account lists only, no
per-agent config (workspace root, sandbox, browser profile) on the wire
(§2). A richer endpoint plus an "agents overview" surface is deferred
(§8).

**Guiding constraint** (same as MULTI-AGENT-SUPPORT): every change lands
generic and default-off. In legacy mode, and in agents mode with a single
agent, every surface renders byte-identically to today. Agent chrome
appears only when more than one agent is configured.

---

## 1. Problem

Every row the console sees is keyed by **account**: `timeline_key`
(`provider:accountKey:kind:channelId…`) is the universal attribution key
across sessions, usage rows, pipeline items, and backfetch jobs, and the
UI renders exactly that — per-account room tabs (`RoomList`), `accountId
PROVIDER` mini-tags (`ChannelCell`, `PipelineItemDetail`), `(accountId)`
parentheticals (backfetch tables), raw timeline keys (top bar, popovers).

But the operator's mental model is the **agent** (spec
MULTI-AGENT-SUPPORT §3): the identity that owns 1..N accounts. Two
accounts of one agent are one persona behind two doors; the current UI
presents them as unrelated. Conversely the wire API exposes no agent data
at all: the `(provider, accountKey) → agent` map lives only inside
`resolveWorkspaceForTimeline` in `src/app.ts`, and the console cannot
even distinguish agents mode from legacy mode.

Three layers fix this: expose the model once (§2), define one display
rule (§3), apply it per surface (§4).

## 2. The agents meta endpoint

One new read-only endpoint on the observability server:

```
GET /api/agents
```

```json
{
  "mode": "agents",
  "agents": [
    { "name": "miku",
      "accounts": [ { "provider": "matrix",  "accountId": "miku" },
                    { "provider": "discord", "accountId": "miku-dc" } ] },
    { "name": "rin",
      "accounts": [ { "provider": "discord", "accountId": "rin" } ] }
  ]
}
```

- `mode` is `"agents"` or `"legacy"`. In legacy mode `agents` is `[]` and
  the console suppresses all agent chrome — it must not synthesize a
  pseudo-agent from the implicit legacy identity.
- **Ordering**: agents are in config declaration order. Accounts within
  each agent are listed matrix accounts then discord accounts, each in
  config declaration order; strict cross-provider interleaved ordering is
  not recoverable from the parsed config, and nothing consuming the payload
  is order-sensitive within an agent. *(Implementation amendment,
  2026-08-01.)* The ordering is stable across requests and drives
  deterministic accent color assignment (§3.4).
- **Minimal scope (settled)**: no workspace roots, sandbox modes, browser
  profiles, or limit config on this payload. It exists solely so the
  client can label rows; ops-level per-agent detail is deferred (§8).
- The payload is **pure config**, fixed for the process lifetime: `app.ts`
  builds the projection once, next to the existing
  `agentAccountPrefixesMap` construction, and injects it via
  `ConsoleServerDeps` as a static snapshot. The handler serves it from
  memory. Same bearer auth as every other route.

**Client side**: a new `console/src/lib/agents.ts` mirrors the style of
`timeline-key.ts` — given the payload it builds a lookup
`"provider:accountId" → {agentName, agentIndex}` and exposes:

- `agentFor(key)` — timeline key → agent entry, or `undefined` when the
  account is not in the map;
- `distinctAgents(keys)` — the agent-level analogue of
  `distinctAccounts`, for per-table gating;
- the label-grammar helpers of §3 (platform-set of an agent, whether an
  accountId disambiguates).

The payload is fetched once through a TanStack-cached remote function
(`agents.remote.ts`), never re-polled (config cannot change without a
process restart).

**Unresolvable accounts** (MULTI-AGENT-SUPPORT §4.3): stored rows may
reference accounts no longer in config. `agentFor` returns `undefined`;
the UI falls back to today's raw `accountId PROVIDER` tag with a muted
"unassigned" treatment. Never guess a default agent — the same rule the
core's resolvers follow.

## 3. Display rule

### 3.1 Gates

- **Global gate**: agent chrome exists only when `mode === "agents"` and
  `agents.length > 1`. Legacy mode and single-agent deployments render
  exactly today's UI, including the existing per-account room tabs and
  `distinctAccounts`-gated tags.
- **Per-table gate**: list surfaces that today gate account tags on
  `distinctAccounts(rows) > 1` gate agent chips on
  `distinctAgents(rows) > 1` instead (same philosophy: no noise when a
  table is homogeneous).
- **Single-item surfaces** (top bar, detail panels) use the global gate
  alone.

### 3.2 Label grammar

The existing visual slot (small uppercase sub-label after the name, as in
today's `accountId PROVIDER` tags) is reused; only what fills it changes.
The rule differs by whether a concrete account is in scope:

| Context | Chip reads | Why |
|---|---|---|
| Agent-level surface (room-list tab), all accounts on one provider | `miku MATRIX` | the platform is a well-defined fact about the agent — covers multi-account-same-platform too |
| Agent-level surface, accounts span providers | `miku MULTI` | the slot is **always occupied**: an empty slot would be a third state, visually identical to the unparseable case |
| Row-level surface (channel cell, pipeline item, breadcrumb) | `miku DISCORD` | a row has a concrete timeline key → a concrete provider; show *that row's* platform, never the agent's set |
| Row-level, agent has >1 account **on that provider** | `miku DISCORD miku-dc2` | accountId is appended only when the provider alone no longer identifies the door |
| Unresolvable account (§4.3) | `miku-old MATRIX`, unassigned styling | fall back to the account-level fact we still have |

The accountId disambiguation rule is deliberately per-provider, not
per-agent: an agent with one Matrix and one Discord account never shows
account ids — the provider already says which door.

### 3.3 The raw key never disappears

`timeline_key` remains the copy-pasteable ground truth: it stays in the
`ChannelCell` popover (with Copy), in tooltips, in the Col3 identifiers
block, and as the `room` URL parameter. Agent labels are presentation
over it, never a replacement.

### 3.4 Accent color

Each agent gets a deterministic accent color: `agentIndex` (config order,
§2) into a small fixed palette, used as a subtle accent (dot or left
border) on every agent chip across all surfaces. Same agent, same color,
everywhere. No configuration; deployments that dislike it get it only
when they configure >1 agent.

### 3.5 URL state

The room-list tab selection is promoted from transient client state to a
URL parameter: `/?agent=<name>` (`nav.ts`). Filtered views become
deep-linkable and survive reload. An unknown or absent name means "All".

## 4. Per-surface changes

| Surface | Today | Change |
|---|---|---|
| `RoomList` | one tab per `(provider, accountId)`, gated on >1 account | tabs become **agent** tabs (All / per agent, grammar §3.2); rows inside a tab carry the row-level account tag when the agent needs it; a channel legitimately appears once per account (two doors = two timelines) |
| `ChannelCell` | `accountId PROVIDER` tag, `showAccount` prop gated on `distinctAccounts > 1` | row-level agent chip per §3.2; caller gate becomes `distinctAgents > 1`; popover unchanged (raw key + Copy) |
| `PipelineItemDetail` | always-on account badge when key parses | row-level agent chip (global gate; account badge as today below the gate); raw key stays |
| `PipelineItemList` | no identity on rows | agent chip when the page's rows span >1 agent (rows already carry `room`) |
| `TopBar` (conversations) | raw timeline key breadcrumb | agent chip prefix + raw key |
| `DetailPanel` identifiers | `timeline` row only | add an `agent` row (client-derived) |
| `SessionList` / `SessionFilters` | room-scoped, no account dimension | **unchanged** — agent filtering happens upstream at the room list; this satisfies MULTI-AGENT-SUPPORT §12's deferred "agent/account filter chips" via tabs rather than a new chip row |
| Usage & Cost page | `ChannelCell` gate per above | inherits the `ChannelCell` change; adds an **agent filter chip row** above the sessions and tool-calls tables (pure client-side filter over parsed keys); budget rule cards render agent scope (§5) |
| `backfetch` / `gap-backfetch` | `roomId (accountId)` | account stays primary — backfetch operates on the account credential — with an agent tag appended under the global gate; `RoomPicker` groups options under agent headers and matches agent names in its filter |
| Scheduler page | session ids, no timeline keys | **unchanged** — the scheduler snapshot carries no timeline keys and per-request agent tags are not worth a core payload change (§8) |
| `SpendSummaryCard` / leaderboard | per-user, cross-agent | **unchanged** — users span agents by design |

Everything is client/BFF labeling over the one §2 payload: no schema
changes, no new DB columns, consistent with the core's decision that
agent attribution is derived at read time from `timeline_key`.

## 5. Budget rule scope display

Agent- and account-scoped `[[limits]]` rules (MULTI-AGENT-SUPPORT §8)
already reach the console: normalization resolves the `agent`/`account`
matcher into `selector.timelineKeyPrefixes`
(`src/budget/normalize.ts`), and `GET /api/usage/budgets` serializes the
full `RuleStatus.scope` — the prefixes are on the wire today. The
console's Effect Schema simply doesn't decode them.

Change (console-only): add optional `timelineKeyPrefixes` to the
`RuleStatus.scope` schema; on the rule card, reverse-map the prefixes
through the §2 payload — when they exactly equal one agent's account set,
render an `agent: rin` chip (with the agent's accent); otherwise render
per-account chips. Unresolvable prefixes render raw, unassigned-styled.
No core change.

## 6. Demo mode

Demo fixtures (spec CONSOLE-DEMO-MODE) gain an agents payload with two
agents, one of them multi-platform, so every piece of agent chrome —
tabs, `MULTI` indicator, row chips, accent colors, the budget scope
chip — is exercised without a live multi-agent deployment. Fixtures
decode through the same schema, so they cannot drift from the wire
shape.

## 7. Implementation touchpoints

| Site | Change |
|---|---|
| `src/app.ts` | build the §2 projection once (next to `agentAccountPrefixesMap`); inject via `ConsoleServerDeps` |
| `src/observability/server/types.ts` | new optional dep: the static agents snapshot |
| `src/observability/server/handlers.ts` + `index.ts` | `GET /api/agents` handler + route |
| `console/src/lib/schemas.ts` | `AgentsResponse` schema; `timelineKeyPrefixes` on `RuleStatus.scope` (§5) |
| `console/src/lib/api/agents.remote.ts` + `server/api/client.ts` | remote function + BFF client method |
| `console/src/lib/server/api/demo/fixtures.ts` | demo agents payload (§6) |
| `console/src/lib/agents.ts` (+ `query/agents.ts`) | lookup, `distinctAgents`, label-grammar helpers, palette assignment; unit tests alongside `timeline-key.test.ts` |
| `console/src/lib/nav.ts` | `agent` param on the conversations route (§3.5) |
| `RoomList`, `ChannelCell`, `PipelineItemDetail`, `PipelineItemList`, `TopBar`, `DetailPanel`, `RoomPicker`, `backfetch/+page`, `gap-backfetch/+page`, `usage-cost/+page` | per-surface rendering (§4) |

## 8. Deferred and rejected

Deferred (compatible later additions, no rework implied):

- **Agents overview surface** + richer endpoint (sandbox mode, browser
  profile, workspace seeded state per agent). The minimal endpoint's
  shape is forward-compatible: new optional fields on each agent entry.
- **Server-side per-agent spend aggregation** on the cost overview —
  real value now that limits scope on agent, but it is a `usage_events`
  aggregation with key parsing on the core side; separable work.
- **Scheduler per-request agent tags** — requires adding timeline keys
  to the attempt-ring payload.

Rejected:

- **Account-primary labeling everywhere** (status quo extended): with
  the same-name convention (`[matrix.accounts.miku]` → agent `miku`)
  most deployments would render doubled `miku miku` chips; and it keeps
  presenting one persona's two doors as unrelated identities.
- **Empty sub-label slot for multi-platform agents**: absence would be a
  third state, indistinguishable from the unparseable/unassigned case;
  the slot is always occupied (§3.2).
- **Persisting agent names in new DB columns for the console's benefit**:
  agent membership is pure config (MULTI-AGENT-SUPPORT §4.1); read-time
  derivation via one meta endpoint keeps renames free and the schema
  untouched.
