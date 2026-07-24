# Spec: Console demo mode — render the console against curated fixtures, no live agent

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §11 "Console frontend" → "Demo mode";
retained for review. Shipped: `MIKUSWARM_CONSOLE_DEMO` gate in `console/src/lib/server/config.ts`
selecting `AgentApiClientDemo` (`server/api/client.demo.ts`) in `runtime.ts`; fixtures +
router in `server/api/demo/fixtures.ts`; empty-SSE stub in `server/api/demo/sse.ts` wired into
both stream routes; fidelity test `server/api/demo/fixtures.test.ts` (decodes every fixture
through its wire schema). Docs: `console/README.md` "Demo mode", `console/.env.example`.

---

## 1. Problem

The console (`console/`, ARCHITECTURE.md §11) renders real observability data for a live
deployment: room names, Matrix user ids, trigger text, session transcripts, per-user spend.
That makes it impossible to produce **shareable screenshots** — of the Usage & Cost page or the
session-observability view — without leaking real usernames and real conversations.

We want a first-class, generic way to run the *real* console UI (byte-for-byte the production
components + CSS) against **fake, non-sensitive data**, so anyone can:

- capture marketing / documentation screenshots of the console,
- demo the UI without a running agent + populated database,
- develop the frontend without standing up the whole backend.

This must be a generic, default-off capability of the public project — not a fork or a throwaway
script. Every deployment benefits; no deployment's specifics leak into it.

## 2. The seam

The console is a BFF: every server-side read of the agent API funnels through **one** place —
`AgentApiClient` (`console/src/lib/server/api/client.ts`), whose `AgentApiClientLive` layer does
`fetch(apiBaseUrl + path)` and decodes the response through an Effect Schema
(`console/src/lib/schemas.ts`, the "fidelity guard"). Every `*.remote.ts` query and every SSE proxy
route ultimately depends on that service (via `apiGet`/`apiPost` in
`console/src/lib/server/api/runtime.ts`).

The whole feature is: **swap that one layer.** When demo mode is on, provide an alternate
`AgentApiClientDemo` layer that, instead of fetching, resolves a **fixture** for the requested path
and returns it — still decoded through the caller's Effect Schema, so a fixture that does not match
the real wire shape fails exactly like a real backend drift would. Nothing else in the console
changes: pages, components, TanStack Query, routing, theming all run unmodified.

```
  browser ──▶ SvelteKit BFF ──▶ AgentApiClient
                                   ├─ AgentApiClientLive  → fetch(agent API)      (default)
                                   └─ AgentApiClientDemo  → fixtures + same decode (demo mode)
```

## 3. Activation — default off

A single env var, read in `runtime.ts` where the runtime layer is built:

```
MIKUSWARM_CONSOLE_DEMO=1   # anything truthy → demo mode; unset/empty → live (unchanged)
```

Default off. When unset, `runtime.ts` builds exactly today's `AgentApiClientLive` runtime and the
console behaves identically to now — no fetch path, no schema, no fixture is touched. This is the
generic knob; a deployment flips it on only to screenshot/demo.

Because it changes only which layer backs `AgentApiClient`, no page, remote function, or component
is aware of it. `MIKUSWARM_CONSOLE_API_URL` / `MIKUSWARM_CONSOLE_TOKEN` are ignored in demo mode
(there is no upstream to reach).

## 4. Fixtures

Fixtures live under `console/src/lib/server/api/demo/` (server-only, like the rest of
`lib/server/`, so they can never enter a client bundle). A router maps a request `(pathname,
searchParams)` to an `unknown` fixture value; the demo layer decodes that value with the caller's
schema before returning it, reusing the fidelity guard as a correctness check on the fixtures
themselves. An unmatched path fails as a 404 `ApiError`, the same shape the live client produces.

Design constraints on the fixture data:

- **Schema-valid by construction.** Every fixture must decode through its endpoint's Effect Schema
  in `schemas.ts`. A unit test decodes every registered fixture through its schema so drift in
  either surfaces in CI.
- **`Date.now()`-relative.** The demo layer runs server-side in Node, so fixtures are computed
  against the real current time at request: the spend timeseries fills the last 24h, "resets in"
  countdowns and "last seen" times read as live. Screenshots never look stale.
- **No deployment specifics.** Invented display names, invented room labels, invented chat text,
  synthetic Matrix ids (e.g. `@example:matrix.example.org`). No real domains, host paths, account
  ids, or room ids. The public project stays deployment-agnostic (CLAUDE.md "stay generic").
- **Curated to look full.** Enough rooms, sessions, users, budget rules (a healthy one, a `near`
  one, a `blocked` one, a multi-model composite), leaderboard entries, and one meaty session
  transcript (user turn → thinking → assistant text → tool call + result) that both target views
  read as a real, busy deployment rather than an empty shell.

### 4.1 Endpoints the fixtures must cover

Usage & Cost (`/usage-cost`):

- `GET /api/usage/summary?window=` → `UsageSummary`
- `GET /api/usage/timeseries?window=&groupBy=` → `UsageTimeseries`
- `GET /api/usage/sessions` → `UsageSessions`
- `GET /api/usage/tool-calls` → `UsageToolCalls`
- `GET /api/usage/leaderboard?window=` → `UsageLeaderboard`
- `GET /api/usage/budgets` → `UsageBudgets`
- `GET /api/usage/user-limits?scope=&page=` → `UserLimitsPage`

Observability / conversations (`/`):

- `GET /api/rooms` → `RoomsResponse`
- `GET /api/rooms/:key/sessions` → `SessionsResponse`
- `GET /api/rooms/:key/session-facets` → `SessionFacetsResponse`
- `GET /api/rooms/:key/context` → `RoomContextResponse`
- `GET /api/sessions/:id` → `SessionDetailResponse` (persisted snapshot + rollout transcript)

### 4.2 Live SSE streams

The rollout / pipeline-activity SSE routes (`routes/api/sessions/[id]/stream`,
`routes/api/pipelines/stream`) are *not* remote functions and do not go through `AgentApiClient`.
A **completed** persisted session renders fully from `GET /api/sessions/:id` alone (its transcript
is in the snapshot), so the static screenshot needs no live stream. In demo mode these SSE routes
serve an immediately-closed (empty) event stream so nothing hangs waiting for a connection that has
no backend.

## 5. Non-goals

- No admin mutations in demo mode (Stop / Resume / Retry). Their `POST` routes return a benign
  canned response; demo mode is read-only.
- Not a replayable/scriptable backend simulator — fixtures are static shapes (time-relative), not a
  stateful fake agent.
- No new runtime dependency. Screenshots are captured with Playwright, already a console devDep.

## 6. Testing

- A unit test iterates the fixture registry and decodes each fixture through its endpoint schema
  (the fidelity guard, applied to the fixtures).
- `pnpm check` (svelte-check) and `pnpm test` stay green with demo mode code present and default-off.
