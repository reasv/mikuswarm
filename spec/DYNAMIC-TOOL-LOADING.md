# Dynamic Session-Time Tool Loading — deferred catalog, skill-bound loading, tool search

**Status**: PROPOSAL — pending owner sign-off on §11.

**Author**: design session 2026-08-20.

Target ARCHITECTURE.md home once implemented: §10 Tools (new subsection "Dynamic
tool loading"), §9a Workspace & Prompt System (skills additions), §8 (loop
integration note), §14 (invariant amendment).

---

## 1. Problem

Every default session ships **every** tool it could ever need in the provider
`tools[]` parameter: the full native tool set plus every adapted MCP tool the agent
is scoped to. On a well-equipped deployment that is 60+ tool definitions and can
run to ~18k tokens of schemas — resent (or re-cached) with **every** LLM request of
**every** session, before a single message of conversation.

This costs on three axes:

- **Tokens**: tool schemas are a fixed tax on every request; for short-lived
  per-trigger sessions the tax dominates.
- **Quality**: 60+ always-visible tools measurably degrade tool selection; most are
  irrelevant to any given trigger.
- **Scalability**: every new feature or MCP server grows the tax linearly. The tool
  set is fixed at startup (ARCHITECTURE.md §MCP remote tools) and at session
  creation — there is no way to add capability mid-session, so nothing can be left
  out either.

The goal is an arbitrary-size tool catalog with a small always-loaded core, where
everything else is discoverable and loadable at runtime — without breaking provider
prompt caching.

## 2. The cache constraint, per wire API

On every supported API the serialized tool definitions land in the cached request
prefix (ahead of, or interleaved with, the earliest messages). Naively changing the
tool list mid-session therefore invalidates the prefix cache from the tools block
onward — usually the entire cached context.

pi-ai (≥0.80) already ships the primitive that solves this: the **`addedToolNames`
contract**. `Context.tools` carries the full current tool set; a
`ToolResultMessage.addedToolNames: string[]` marks the point in the transcript
where new tools became available. Each driver then does the best its wire API
allows (`utils/deferred-tools.js` `splitDeferredTools` partitions immediate vs
transcript-loaded definitions):

| API | Mechanism | Cache effect of a load event |
|---|---|---|
| `anthropic-messages` | `supportsToolReferences` compat (default on for first-party Claude ≥4.5, non-Haiku): added tools sent with `defer_loading: true` after the immediate list (which keeps its `cache_control` breakpoint); a `tool_reference` block is injected into the loading tool result | None — prefix stable |
| `openai-responses` | `supportsToolSearch` compat (default off): added tools sent with `defer_loading: true`; a `tool_search_call`/`tool_search_output` item pair is injected at the load point | None — prefix stable (when the endpoint supports it) |
| `openai-completions`, `deferredToolsMode: "kimi"` | Added tools are **excluded** from `params.tools` and injected as a `{ role: "system", tools: [...] }` message at the load point | None — prefix stable |
| `openai-completions` (plain), google, bedrock, mistral | No native mechanism: added tools simply appear in the serialized tool list | One-time prefix-cache bust at the first request after the load event; subsequent requests re-cache |

Two consequences drive the whole design:

1. **The application never implements per-API logic.** MikuSwarm's only jobs are:
   (a) withhold not-yet-loaded tools from `Context.tools`, (b) on a load event, add
   them and stamp `addedToolNames` on the loading tool's result (pi-agent-core
   already forwards the field from `AgentToolResult` to the transcript message),
   and (c) hand the updated array to the running loop. pi-ai does the rest,
   governed by existing per-model compat flags. Future upstream improvements (e.g.
   a generic in-transcript textual schema mode for plain completions providers)
   slot in with zero app changes.
2. **On providers with no native mechanism, a load event costs one uncached prefix
   replay** — bounded, and typically cheap on providers that price cache writes at
   zero. Mitigation is behavioral, not mechanical: loads are batched (a skill loads
   all its tools in one event) and tend to happen early in a session, before the
   transcript grows.

Not covered by the contract: starting a session with a *server-side* hidden catalog
(Anthropic's native tool-search over `defer_loading` tools present from request 1).
pi-ai keys deferral off transcript markers, so tools present at session start are
always immediate. Discovery is therefore **client-side** in this design (skills
index + `tool_search`), which also keeps it uniform across every provider. A future
pi-ai `initialDeferredTools` extension could layer the server-side variant on
later; out of scope here.

## 3. Design overview

Three pieces, all default-off:

1. **Session tool registry** — the per-session catalog, split into *loaded*
   (in `Context.tools` now) and *available* (withheld, loadable). Classification is
   pure config; tool implementations are untouched.
2. **Load triggers** — a `load_skill` tool (skills become the primary grouping and
   discovery unit for tools), and a `tool_search` tool (universal fallback over the
   whole catalog).
3. **Discovery surfaces** — the existing `<available_skills>` index (descriptions
   become load-bearing: they are the always-visible entry point to the tools behind
   them), plus an optional compact `<deferred_tools>` name index.

## 4. Config shape

```toml
[agent.tools.dynamic]
enabled = false        # default: current behavior — everything immediate
immediate = [          # always-loaded core; everything else in the session's
  "send_message",      #   catalog starts deferred
  "read_messages",
  "search_messages",
  "load_skill",        # the loading tools are implicitly immediate; listing
  "tool_search",       #   them is allowed but redundant
]
index = "names"        # deferred-tool index in the system prompt:
                       #   "names" | "descriptions" | "none"
```

- **Direction**: an `immediate` allowlist, not a `deferred` denylist. New tools
  (upstream additions, newly configured MCP servers) then default to deferred —
  fail-frugal rather than fail-noisy.
- **Wildcards**: entries support a trailing-`*` glob (`"mcp_medialib_*"`), matching
  the `mcp_<server>_<tool>` naming convention so whole MCP servers can be pinned
  immediate or (by omission) deferred as a unit.
- **Composition**: the existing filters are unchanged and run first —
  `disabled_tools`/feature gates remove tools from existence, per-agent
  `mcp_servers` scoping and the session-type `tools` allowlist bound the *catalog*.
  The dynamic split applies within the surviving set. Session types with explicit
  small `tools` lists (background summarize/condense/diary types) are naturally
  unaffected: their whole catalog is a handful of tools and `immediate` matching is
  irrelevant unless the operator makes it so.
- **Per-session-type override**: `agent.session_types.<name>.tools_dynamic =
  false` opts a session type out of deferral entirely (its full catalog is
  immediate). Default `true` (follow the global block).
- When `enabled = false` (default) the registry degenerates to "everything
  loaded" and no loading tools, no index, and no behavior change exist.

### Skills frontmatter addition

```yaml
---
name: medialib
description: Queue, play, and browse the media library (load this skill for the mcp_medialib_* tools).
tools:
  - mcp_medialib_*
---
```

A new optional `tools` list (same trailing-`*` globs). Loading the skill loads
every cataloged tool the list matches. Skills without a `tools` key behave exactly
as today (pure instructions). `always_loaded: true` skills with a `tools` key get
those tools promoted to immediate at session build (inlined instructions imply
present tools).

Validation: at session build (skills are per-workspace, scanned at session
creation), a skill `tools` entry matching nothing in the session's catalog logs a
`skill_tools_unmatched` warning once per session — not an error, since catalogs
legitimately vary per agent/session type.

## 5. The `load_skill` tool

Immediate in every dynamic-enabled session whose skill filter yields at least one
listed skill.

- **Params**: `name` (required, a listed skill name).
- **Behavior**: reads the skill's `SKILL.md` body (live from disk, matching the
  existing on-demand read path), resolves its `tools` globs against the session
  catalog, marks the matches loaded, and returns the skill body plus a rendered
  block of the newly loaded tool definitions. The `AgentToolResult` carries
  `addedToolNames` with exactly the newly loaded names.
- **Idempotence**: re-loading a loaded skill returns the body again with a "tools
  already loaded" note and empty `addedToolNames`.
- **Errors**: unknown name → error listing valid skill names.
- **Prompting**: the `<available_skills>` index gains an instruction line: skills
  are loaded by calling `load_skill`, which also enables the tools they describe.
  (Reading the file through the text editor still works but yields instructions
  without the tools — self-defeating, which is exactly the incentive we want.)
- **Detectability**: loading is a first-class tool call — transcript event,
  `skill_loaded { sessionId, skill, tools }` log, console-visible. This replaces
  today's undetectable file-read path as the sanctioned way to use a skill.
- Optionally (Decision D2), the text editor `view` command on a
  `skills/*/SKILL.md` path triggers the same load path (result stamped with
  `addedToolNames`), closing the main backchannel rather than fighting it. Sandbox
  shell reads remain a residual backchannel; they yield instructions only, and the
  tools stay unloaded.

## 6. The `tool_search` tool

Universal fallback for capability the agent suspects exists but no skill describes,
and the recovery path when it remembers a tool name the index shows as deferred.

- **Params**: `query` (required). Two forms, mirroring an emerging convention:
  `"select:name_a,name_b"` loads exact names; anything else is a keyword query
  ranked over name + description substrings. Optional `max_results` (default 5).
- **Behavior**: matches against the session's *deferred* catalog (loaded tools are
  reported as already loaded rather than re-listed), loads every returned match,
  and returns their full rendered definitions. Result carries `addedToolNames`.
- **No-match**: returns the closest names and the skill index, so the model can
  pivot to `load_skill`.

## 7. Loop and lifecycle integration

- **Registry**: built in `AgentSessionFactory.create()` after the existing filter
  chain and the result-budget wrapper — the registry holds the *wrapped* catalog,
  so dynamically loaded tools get result shaping identically to immediate ones.
  Initial `Context.tools` = immediate set (∪ `always_loaded`-skill promotions).
- **Mid-run updates**: the factory wires pi-agent-core's
  `prepareNextTurn`/`prepareNextTurnWithContext` hook; when the registry has
  changed since the run's snapshot, the hook returns a context carrying the current
  loaded array. Between runs (steering, follow-up folding, resume),
  `agent.state.tools` is reasserted from the registry before `prompt()`/
  `continue()`.
- **Loaded-set persistence — the transcript is the source of truth.** The loaded
  set is exactly (immediate ∪ every `addedToolNames` on any tool result in the
  transcript). Session resume, Layer-0 retry replays, and forced-completion
  continuations recompute it from the transcript rather than persisting parallel
  state — deterministic, and definitionally consistent with what pi-ai's
  serializers will derive from the same messages.
- **Unknown-name calls**: a model calling a deferred tool it never loaded gets
  pi-agent-core's synthesized `Tool <name> not found` error result and the loop
  continues. The `<deferred_tools>` index plus the two loading tools make recovery
  one call away. (A friendlier registry-aware error text requires an upstream
  pi-agent-core hook; nice-to-have, not gating.)
- **Invariant 10 amendment**: workspace files and the skills *index* remain
  read-once at session creation; `load_skill` reads a skill *body* live at call
  time — the same semantics the text-editor read path already has today.

## 8. Discovery index (`index` mode)

When `index = "names"`, the system prompt gains a compact deterministic block after
`<available_skills>`:

```
<deferred_tools>
Loadable via load_skill (per skill) or tool_search:
medialib: mcp_medialib_play, mcp_medialib_queue_list, …
(unskilled): danbooru, find_source, …
</deferred_tools>
```

Grouped by owning skill (a tool matched by several skills lists under the first,
alphabetically), with unmatched tools under a fixed label. `"descriptions"` adds a
≤80-char truncated description per tool (heavier; for deployments prioritizing
discoverability over minimalism). `"none"` relies purely on skill descriptions +
`tool_search`. Names-only costs roughly 5–8 tokens per tool versus ~150–450 for a
full schema.

Determinism: the block is a pure function of the session catalog and skills scan —
byte-identical across sessions of the same config/workspace state (invariant 4
preserved).

## 9. Token accounting & observability

- `renderToolBlock` counts the *initial* loaded set at build; the `<deferred_tools>`
  index is counted as ordinary system-prompt text. On a load event the running
  context counter (`ctxCounter`) adds the loaded definitions' estimate (same OpenAI
  wire-form estimator), so per-member context-fits and per-user affordability see
  loads exactly like organic context growth.
- Events: `tools_loaded { sessionId, source: "load_skill" | "tool_search" |
  "editor_view", names, tokenEstimate }`; `skill_loaded` as in §5;
  `skill_tools_unmatched` as in §4.
- Console: the inspector's `resolveToolDefs` path (per agent + session type) gains
  the immediate/deferred split; the session view surfaces load events. Console work
  is a separate follow-up spec if it grows beyond the inspector split.

## 10. What this does not change

- No tool implementation changes; no MCP adapter changes; discovery of MCP tools
  remains startup-time (the *catalog* is still fixed per session — deferral changes
  visibility, not existence).
- No pi-ai / pi-agent-core changes are required for v1. Identified upstream
  nice-to-haves (registry-aware unknown-tool error text, `initialDeferredTools`
  for server-side catalogs, a generic transcript-text deferred mode for plain
  completions providers) are explicitly not blocking.
- Defaults preserve current behavior byte-for-byte: `enabled = false` renders no
  index, adds no tools, and defers nothing.

## 11. Decisions

- **D1 — Config direction**: `immediate` allowlist with trailing-`*` globs
  (recommended, §4) vs a `deferred` denylist. Allowlist keeps new tools
  token-frugal by default.
- **D2 — Editor interception**: should text-editor `view` of a `SKILL.md` path
  trigger the same load path as `load_skill` (recommended: yes), or is the
  instruction + incentive alignment of §5 sufficient for v1?
- **D3 — Index default**: `index = "names"` (recommended) vs `"none"` when the
  operator enables dynamic loading. (`"descriptions"` exists either way.)

## 12. Implementation plan

1. Config schema: `[agent.tools.dynamic]`, session-type `tools_dynamic`, skills
   frontmatter `tools`; validation + defaults in `00-defaults.toml` (commented).
2. Registry + glob matcher + transcript-derived loaded-set recomputation
   (pure functions; unit-testable without a loop).
3. `load_skill` + `tool_search` tools; `<available_skills>` instruction line;
   `<deferred_tools>` renderer.
4. Factory wiring: registry construction, `prepareNextTurn` hook, between-run
   reassertion, resume/retry recomputation.
5. Accounting: tool-block split, load-event counter charging.
6. Observability + console inspector split.
7. Tests: registry/glob/recompute units; loop-level test that a load event stamps
   `addedToolNames` and the next request's `Context.tools` grows; determinism test
   for the index block; resume test recomputing the loaded set; docker suite
   unaffected.
8. ARCHITECTURE.md sections in the implementing commit; this spec marked
   IMPLEMENTED.
