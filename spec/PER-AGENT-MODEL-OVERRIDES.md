# Per-Agent Model Overrides — `[agents.<name>.models]`

**Status**: PROPOSED — design signed off, ready for implementation planning.

**Author**: design session 2026-08-08.

**Owner sign-offs (2026-08-08)**:
- v1 covers **all overridable roles** (chat-lane session types + captioning
  incl. per-modality + image_gen + x_search) in one feature; retrieval
  embedding is a permanent non-goal.
- Captioning ladder uses **strict same-rung shadowing** (consistent with the
  chat lane): agent-modality → global-modality → agent-shared → global-shared.
- Key name is **`[agents.<name>.models]`**.

Target ARCHITECTURE.md home once implemented: §4c "Agents and accounts" (the
per-agent configuration list, alongside `sandbox`, `browser`, `summaries_from`),
§8 (the session-factory model resolution ladder), §7a/captioning (per-agent chain
selection), and the image-gen / x_search tool sections.

---

## 1. Problem

Every configurable model role is process-global. The unified `[models.*]` registry
is shared (correctly — see §2), but so is every *assignment* of a role to a
registry block: `agent.session_types.<type>.model`, `captioning.model` (and its
per-modality overrides), `image_gen.models.pro|flash`, `x_search.model|deep_model`.
In a multi-agent deployment all agents therefore run identical models in every
role. There is no way to pair a persona with a model, tier agents by cost (a
premium main agent and a cheap sidekick), or trial a new chat model on one agent
while the others stay on the incumbent.

The existing escape hatches don't cover this:

- Agent-scoped `[[user_limits]]` rules can give different agents different
  per-user *preference lists*, but that governs only the metered per-user
  selection lane — not the baseline session-type model, and nothing outside chat.
- `summaries_from` lets a secondary agent reuse a donor's summaries, which avoids
  duplicate summarization spend but cannot express "summarize with a different
  model".
- Separate deployments per agent forfeit exactly what multi-agent support exists
  to provide (one process, one timeline store, sibling suppression, shared pools).

MULTI-AGENT-SUPPORT.md §1 listed per-agent model variation as a non-goal
("agents differ in identity, not configuration"). This spec deliberately amends
that boundary for **model role assignments only** — all other settings (session
type behavior, enrichment/captioning tuning, limits values, tools) remain
process-global.

## 2. Design principles

1. **The `[models.*]` registry stays global.** A per-agent override is a
   *reference* to a registry block by logical name — never an inline model
   definition. Connection details, pricing, `context_window`, capability flags,
   `thinking_level`, and `fallback` chains all continue to live on registry
   blocks, so health tracking, rate-limit groups, budget accounting, and the
   per-member context-fits machinery work unchanged. An agent that needs its own
   fallback chain uses the established virtual-model pattern:

   ```toml
   [models.chat-sidekick]
   inherits = "chat-cheap"
   fallback = ["chat-floor"]
   ```

2. **Absent = today's behavior, exactly.** Overrides are optional keys; a config
   without them is byte-identical in behavior. Legacy single-agent mode (no
   `[agents]` table) has no such knob and is untouched — the table lives on the
   agent block, so this holds structurally (same rationale as `mcp_servers` in
   PER-AGENT-MCP-SCOPING.md).

3. **Per-role, mirroring the global keys.** The override surface reuses the
   global role names and nesting so an operator can find the per-agent knob by
   analogy with the global one, and only the model *reference* is overridable —
   never the surrounding behavioral settings.

## 3. Config shape

One optional sub-table per agent, mirroring the global model-bearing keys.
Every value is a `[models.*]` logical name.

```toml
[agents.main]
workspace_root = "./workspaces/main"
# no [agents.main.models] → all roles resolve exactly as today

[agents.sidekick]
workspace_root = "./workspaces/sidekick"

[agents.sidekick.models.session_types]
default   = "chat-sidekick"     # shadows agent.session_types.default.model
proactive = "chat-cheap"        # shadows agent.session_types.proactive.model

[agents.sidekick.models.captioning]
model = "caption-cheap"         # shadows captioning.model
image = "caption-flash"         # shadows captioning.image.model
# video / audio likewise

[agents.sidekick.models.image_gen]
pro   = "imagegen-pro-alt"      # shadows image_gen.models.pro
flash = "imagegen-flash"        # shadows image_gen.models.flash

[agents.sidekick.models.x_search]
model      = "grok-alt"         # shadows x_search.model
deep_model = "grok-deep-alt"    # shadows x_search.deep_model
```

Notes on the shape:

- `session_types` is a flat map `type-name → model-name` (values are strings,
  not blocks). This is intentional: the per-agent surface overrides *which
  model*, never the session type's behavioral settings (`max_tool_calls`,
  `max_turns`, `tools`, context tiers) — those stay global per the amended
  non-goal.
- `captioning` mirrors the global two-level form: `model` is the shared default,
  `image`/`video`/`audio` are per-modality overrides. Per-agent per-modality
  wins over per-agent shared, which wins over the corresponding global (see §4).
- A role sub-table for a subsystem the deployment doesn't configure (e.g.
  `x_search` overrides with no `[x_search]` table) is a startup error — dead
  config, strict-config philosophy.

## 4. Resolution semantics

The rule everywhere: **the agent override shadows the global value at the same
rung of the existing ladder** — it never reorders the ladder.

**Chat lane** (everything launched through the session factory: chat session
types, `proactive`, `summarize`, `condense`, `diary`). Today's ladder is
type-specific → `default` type → literal `"default"`. Per-agent it becomes,
for a session owned by agent A with session type T:

1. `agents.A.models.session_types[T]`, else `agent.session_types[T].model`
2. else `agents.A.models.session_types["default"]`, else
   `agent.session_types["default"].model`
3. else the literal model name `"default"`

So an agent that overrides only `default` inherits that override wherever the
global config would have fallen through to the default type's model — but a
session type with an explicit global model keeps it unless the agent overrides
that type by name. Legacy sessions (agent name `null`) skip rung's agent half
and resolve exactly as today.

**Captioning**: per-asset owning agent A, modality M — strict same-rung
shadowing (owner-decided, consistent with the chat lane):

1. `agents.A.models.captioning[M]`, else `captioning[M].model`
2. else `agents.A.models.captioning.model`, else `captioning.model`

That is, a global per-modality assignment keeps winning over an agent's shared
override — the agent must override the modality by name to displace it, exactly
as a globally-modeled session type must be overridden by name in the chat lane.

**image_gen / x_search**: single-rung roles — agent override else global value
(`deep_model` keeps its existing fall-through to `model`, evaluated after the
per-agent/global shadowing of each key).

**Per-user limits lane**: unchanged. When a `[[user_limits]]` rule matches, its
`models` preference list governs selection exactly as today; per-agent overrides
set the *baseline* (unmetered) model only. Operators who want the metered lane
to differ per agent already have agent-scoped rules — composing the two
mechanisms is the intended pattern, and this spec adds no coupling between them.

## 5. Role coverage

| Role | Overridable | Seam |
|---|---|---|
| Chat / custom session types | yes | session factory ladder (§4) |
| `proactive`, `summarize`, `condense`, `diary` | yes | same factory ladder — these are session types |
| Captioning (shared + per-modality) | yes | per-agent chain map, chosen per asset by owning agent |
| Image generation (`pro`/`flash`) | yes | per-agent chains, chosen by the session's agent at tool-context build |
| `x_search` (`model`/`deep_model`) | yes | same as image gen |
| Retrieval embedding (remote/local) | **no — permanent non-goal** | one shared vector store; chunks are stamped with one `model_id`, vectors are only comparable within one embedding space, and the local path fixes dimensionality at index build. Per-agent embedding models mean per-agent indexes — a different feature, out of scope. |
| Tokenizer assignments (`[tokenizers]`) | **no** | counting calibration, not a model role; must stay consistent with the estimator machinery |

Future model roles (e.g. the proposed YouTube enrichment model) should ship with
a matching entry in this table — the pattern generalizes: global assignment key,
optional same-shaped per-agent shadow.

## 6. Interactions

- **`summaries_from`**: an agent with `summaries_from` set does not run
  summarization — its `summarize`/`condense` overrides would be dead config.
  Both present → hard startup error naming the agent (same philosophy as the
  donor-chain and self-reference checks).
- **Budgets/limits**: no change. Usage events already stamp the served model and
  are attributable per agent via account prefixes; `[[limits]]`/`[[user_limits]]`
  agent matchers work unchanged. A per-agent model with its own `[models.*].cost`
  block prices correctly for free.
- **Per-member context fits / fallback / health**: no special handling. The
  override resolves to a registry chain via the same `buildModelFallback` path;
  fits, health, and budget viability are already per-member, per-attempt.
  Per-session context ceilings (`resolveSessionContextCeiling`) are already
  computed from the session's resolved chain.
- **Rate-limit groups / scheduler**: unchanged — grouping is a property of the
  registry block, and the scheduler is intentionally process-global.
- **Summary mirroring + captioning**: none; captions are per-asset on the owning
  agent's timeline, mirroring copies summaries, not assets.

## 7. Validation (startup, fail-fast)

All checks live with the existing cross-field validation (`validateAgentConfig`
and the role-resolution fail-fasts in app startup):

- Every override value must resolve via `resolveModelChain` against the global
  registry — unknown name, broken `inherits`/`fallback`, or a chain member
  missing `context_window` fails startup with a path-precise error naming the
  agent and key (identical failure class to the global role checks).
- Every `session_types` override key must name a session type the process can
  launch: a declared `agent.session_types` key, the literal `"default"`, or a
  role-designated type name (the configured proactive/summarization/diary
  types). Unknown key → startup error (typo/stale-entry protection).
- Role-specific capability checks run per agent exactly as they do globally
  (e.g. a captioning override must cover the modality it's assigned to).
- Overrides for an unconfigured subsystem (`image_gen`/`x_search` tables absent)
  → startup error.
- `summaries_from` + `summarize`/`condense` override → startup error (§6).

## 8. Mechanics

- **Chat lane**: the session factory already receives per-agent closures
  (`resolveWorkspaceRoot`); it additionally receives the agent name for the
  session (the `resolveAgentName` normalization already exists on the context
  builder) and consults a precomputed per-agent ladder table when picking
  `modelKey`. One lookup, no new runtime machinery; the composite/fallback build
  is unchanged downstream of the name.
- **Captioning**: today one chain per modality is resolved once at startup. This
  becomes a small map — baseline chains (global) plus per-agent chains for
  agents with overrides, all resolved and validated at startup. The caption
  pool already resolves the owning agent per asset (for workspace paths); it
  picks the chain from the same resolution. Inference concurrency continues to
  be governed by each model's rate-limit group.
- **image_gen / x_search**: same startup-resolved map, selected by the session's
  agent where the tool context is assembled (`buildSessionTools` already shadows
  per-session identity values at the top of tool-set construction).
- No DB changes, no migration, no new processes.

## 9. Observability

At startup, one info log per agent that has any override:
`agent_model_overrides { agent, overrides }` — where `overrides` is the flat
map of role key → model name. No per-session logging (deterministic config);
the served model already appears in usage events and the console's per-agent
usage dimension. Optionally (cheap, can ride the implementing commit or a
follow-up): include the effective per-role model map in `GET /api/agents` so the
console shows which agent runs what.

## 10. Decisions (resolved)

All three open design decisions were resolved by owner sign-off on 2026-08-08
(recorded in the status header): full role coverage in v1, strict same-rung
shadowing for the captioning ladder, and the `[agents.<name>.models]` key name.

## 11. Testing

- Unit: the chat-lane ladder (all rungs, agent × global combinations, legacy
  `null`-agent passthrough); captioning ladder incl. the decided rung order;
  image_gen/x_search selection; absent-table invariance (agents mode with no
  overrides resolves identically to today).
- Config: each §7 validation failure produces a path-precise startup error;
  valid configs load; `summaries_from` conflict rejected.
- No Docker/integration surface — pure config + selection logic.
