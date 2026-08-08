# Per-Agent MCP Server Scoping — `[agents.<name>].mcp_servers`

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §MCP remote tools; retained for review.

**Author**: design session 2026-08-08.

**Owner sign-off (2026-08-08)**: feature requested — a generic per-agent allowlist for
MCP servers, in the same spirit as other default-off deployment knobs.

Target ARCHITECTURE.md home once implemented: § "MCP remote tools" (a scoping
paragraph) and the multi-agent section's per-agent configuration list (alongside
`sandbox`, `browser`, `summaries_from`).

---

## 1. Problem

`[mcp.servers.*]` is global: every configured server's tools are adapted at startup
and exposed to **every** session of **every** agent. In a multi-agent deployment this
is wrong whenever a server is meaningful to only one agent — e.g. an MCP server
fronting a service whose resources (a media library, a download folder, an account)
belong to a single agent. Sibling agents then see tools that are useless to them at
best (results reference paths/resources they don't have) and confusing at worst: the
model may attempt them, waste turns, and surface irrelevant errors.

Session-type `tools` allowlists cannot express this: they are keyed by session *type*,
shared across agents. There is no per-agent dimension to tool visibility today.

## 2. Design

One optional key on the per-agent block:

```toml
[agents.main]
workspace_root = "./workspaces/main"
mcp_servers = ["exa", "medialib"]   # only these servers' tools for this agent

[agents.helper]
workspace_root = "./workspaces/helper"
mcp_servers = ["exa"]               # helper never sees medialib tools
```

Semantics:

- **Absent** (default) → all configured servers, exactly today's behavior. Existing
  multi-agent deployments are unaffected; legacy single-agent mode (no `[agents]`
  table) has no such knob and is unchanged.
- **Present** → only tools from the listed servers (`mcp_<server>_*`) are visible to
  sessions belonging to that agent — every session type of that agent (chat and
  worker types alike).
- **`[]`** → valid: this agent gets no MCP tools at all.

Scoping is by **server key** (the `[mcp.servers.<key>]` table name — the same
namespace already used as the tool-name prefix), not by individual tool name.
Per-tool granularity already exists via session-type `tools` allowlists; both filters
compose (intersection).

## 3. Validation

- Config-time cross-field check (app startup, alongside the other cross-field
  validations): every entry in every `mcp_servers` must name a configured
  `[mcp.servers.<key>]`. Unknown key → startup error naming the agent and the bad
  entry (strict-config philosophy; catches typos and stale entries when a server is
  removed).
- A listed server that is configured but **fails to connect** at startup is not an
  error here — that is the existing runtime skip path (its tools simply don't exist
  for anyone).
- `mcp_servers` is only meaningful under an `[agents]` table; it lives on the agent
  block so this holds structurally (no legacy-mode variant).

## 4. Mechanics

The `McpClientPool` stays global and unchanged — one connection per server at startup,
shared across agents; scoping is purely a **per-session visibility filter**, applied
where the per-session tool set is assembled (the session factory's tool filtering,
before/with the session-type allowlist — the same seam that already produces
`filteredTools`). The filter drops any tool whose name matches `mcp_<server>_` for a
server not in the owning agent's allowlist; a plain prefix test against the configured
server keys, so cost is negligible and non-MCP tools are never affected.

Interaction with session-type `tools` allowlists: unchanged composition. A session
type that allowlists an MCP tool excluded by the agent's `mcp_servers` simply doesn't
get it — the same silent no-op semantics as an allowlisted tool from a server the
deployment doesn't configure (established behavior, see ARCHITECTURE.md on the Exa
default).

## 5. Observability

At startup, per agent with an explicit `mcp_servers`, one info log:
`mcp_agent_scoping { agent, servers }`. No per-session logging — the filter is
deterministic config.

## 6. Testing

- Unit: filter drops `mcp_<excluded>_*` and keeps `mcp_<allowed>_*` + native tools;
  absent list keeps everything; `[]` drops all MCP tools; composition with a
  session-type allowlist.
- Config: unknown server key fails startup with a path-precise error; valid configs
  load.
