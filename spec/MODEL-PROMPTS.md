# Model Prompts — per-model system preamble and tail

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §8 "Model prompts" (plus the
config overview, the session-type field list and the v22→v23 migration note); retained
for review. Deviations from this draft, decided during implementation:
- The slot is recorded as `modelTailAt: { offset, join }` (`join` says which side the
  satellite's `\n\n` separator goes on, so the result equals a direct render).
- §4.3: the wrapper is installed through a new `wrapMember` hook on `buildModelFallback`
  (outermost, outside admission), not inside `makeBase`, because `makeBase`'s output is
  also the background prober's bare stream fn, which is shared across sessions.
- §5: fits subtracts each member's model-prompt tokens from that member's operative
  window (`memberOverheadTokens`); the running context counter stays model-neutral, so
  the head's tokens are not also added to the frozen estimate (that would count them twice).
- §6: the prompt text is not persisted. The console session panel lists member, profile,
  hash and request count from `usage_events`; context dumps carry the head member's
  resolved text. The context inspector does not render the text.
- §3.2 (owner, 2026-10-04): an empty or whitespace-only source is "not set" and is omitted
  silently (still the resolved profile, so it overrides like "none"), so placeholder
  files can be kept and filled in later. A `workspace_file` that does not exist is also
  silent (debug), since that is how an agent goes without a shared profile.

**Author**: design session 2026-10-04.

**Owner decisions (2026-10-04)**:
- A model prompt applies to **every session type** served by that model by default.
  Nothing is opt-out: a session type **overrides** the prompt per model, and "no
  prompt" is just one override value.
- Overrides are per **(session type, model)**. The common setup is per model only,
  the same in every session, and most models have no model prompt at all.
- **Two positions in v1**, both needed for different use cases:
  1. **Preamble**: the very first bytes of the context, inside the system prompt,
     with nothing before it. This is the in-distribution place for a model's own
     system prompt.
  2. **Tail**: appended to the tail instructions in the satellite block.
- Ordering variants (end of the system prompt, before the satellite, after the
  trigger group) are **out of scope** until shown to be needed.
- Prompt files may live in **either** the config directory or the agent workspace;
  both are legitimate, so both are supported.
- No config-level per-agent layer: `workspace_file` already gives per-agent text.
- Edits are picked up by the next session. The cache cost of an edit (one cold
  request per affected lineage) is expected and accepted.

Target ARCHITECTURE.md home once implemented: §8 "Agent Sessions" (a "Model
prompts" subsection next to "Model-scoped OpenAI prefill" and "Model fallback"),
plus the config reference.

---

## 1. Problem

The system prompt is rendered once per session from the workspace
(`renderSystemPrompt`, `AgentSessionFactory.create`) and is identical for every
model. But the model that serves a request is chosen per attempt, by the
fallback composite (`buildModelFallback` → `chooseChainMember`), and per
session by decision-model routing (§8h), per-user model selection (§8g), and
per-agent overrides. One session can be served by three model families.

That was tolerable when a model switch was only a cost or availability fallback.
With routing picking a model per task, model choice is a first-class decision,
and some models need their own framing to perform as intended: an identity or
behaviour preamble at the top of the system prompt in the shape they were
trained on, or a short reminder near the end of context. There is no place to
put model-specific text today without forcing it on every other model.

## 2. Concepts

A **model prompt profile** is a named pair of optional texts:

- `preamble`: prepended to the system prompt.
- `tail`: appended to the satellite's tail instructions.

A model block names its default profile. A session type may override the profile
per model. Resolution happens **per serving member**, so a fallback chain
`A → B` sends A's profile when A serves and B's when B serves, inside the same
session.

## 3. Configuration

```toml
# A named profile. Each position takes exactly one source:
#   text           = inline string
#   file           = path relative to the config directory
#   workspace_file = path relative to the serving agent's workspace
[model_prompts.claude]
preamble = { file = "model-prompts/claude.md" }
tail     = { workspace_file = "MODEL_TAIL.md" }

[model_prompts.claude_worker]
preamble = { file = "model-prompts/claude-worker.md" }

# Default profile for every session type this model serves.
[models.claude_opus]
model_prompt = "claude"

# Per-session-type overrides, keyed by [models.*] logical id.
# "*" matches every model not listed. "none" means no model prompt.
[agent.session_types.summarize.model_prompts]
claude_opus = "claude_worker"
"*" = "none"
```

### 3.1 Resolution

For a session of type `T` served (this attempt) by member `M`:

1. `agent.session_types.T.model_prompts[M]`
2. `agent.session_types.T.model_prompts["*"]`
3. `models.M.model_prompt`
4. no model prompt.

The first rung present wins, including when its value is `"none"`. An override
replaces the whole profile; to change one position and keep the other, define a
profile with the wanted pair. Session types resolved through the role-designated
names (`proactive`, `summarize`, `condense`, `diary`) and the `default` type use
the same table.

### 3.2 Sources and freshness

- `text`: inline.
- `file`: resolved against the config directory (the directory `loadConfig`
  reads). Must exist at startup.
- `workspace_file`: resolved against the serving agent's workspace root, with
  the same path rules as `tail_file`. Workspaces are per-agent, so this is also
  the way to give agents different text for the same profile.

Files are read when a session is created, for every chain member the session can
reach (lazily, on first build of that member's fallback composite), and held for
the session's lifetime. A running session never sees its bytes change mid-flight;
the next session (including a resume, which re-creates the session) reads the
current file.

A file that is missing or empty at session time omits that position and logs
`model_prompt_source_missing` (warn) once per session. A `file` missing at
startup is a startup error; a `workspace_file` is not checked at startup
(workspaces are agent-editable and may be seeded later).

Content is sent verbatim after trimming trailing whitespace. No templating.

### 3.3 Validation (startup errors)

- `model_prompt` or a `model_prompts` value names an undefined profile.
- A `model_prompts` key is neither `"*"` nor a defined `[models.*]` id.
- A profile is named `none`.
- A profile has neither position, or a position has zero or several sources.
- `model_prompt` is set on a decision model (`api = "system-one"`, §8h).
- A `file` source does not exist.

## 4. Rendering

### 4.1 Preamble

At dispatch, the serving member's preamble is prepended to the request's system
prompt:

```
<preamble>\n\n<rendered system prompt>
```

Nothing precedes it and it has no wrapper element. pi-ai maps `systemPrompt` to
each API's native slot (Anthropic `system`, Responses `instructions`, Chat
Completions `system` message), so the preamble is the first thing the model
reads on every wire API.

The session's stored system prompt (`AgentState.systemPrompt`, the builder's
system message, `systemPromptSegments`) stays model-neutral, so the two renders
that must match (factory and `ContextBuilder`) are untouched.

### 4.2 Tail

The model tail goes after `TAIL.md` and the routed tail files, before
`<session_instruction>`:

```
<runtime_state>…</runtime_state>
<preloaded_skill>…</preloaded_skill>
<tail_instructions source="TAIL.md">…</tail_instructions>
<tail_instructions source="…">…</tail_instructions>   (routing tail files)
<tail_instructions …>model tail</tail_instructions>   ← inserted per attempt
<session_instruction>…</session_instruction>
```

It renders as `<tail_instructions source="<workspace path>">…</tail_instructions>`
for a `workspace_file` source and `<tail_instructions>…</tail_instructions>`
otherwise (config-dir files are not readable by the agent, so no path is shown),
joined to its neighbours with the satellite's usual `\n\n` separator.

**Nothing goes into the text.** The stored satellite content is exactly what it
is today. The insertion point is carried **beside** the message, never inside it:

- The builder records the character offset of the tail position in the
  satellite-bearing message (`triggerGroup` / `satellite`) as a field,
  `modelTailAt`. It is persisted with the snapshot and transcript like
  `tier` / `tokenEstimate`, so resume reuses it verbatim. The content is frozen
  (§2b freeze invariant), so the offset stays valid for the session's life.
- `convertToLlm` (our code) copies the offset onto the wire `Message` under a
  module-private `Symbol`. Symbol keys never reach a payload (pi-ai builds
  payloads from named fields, and `JSON.stringify` drops them).
- `withModelPrompt` is the **outermost** per-member wrapper, so it sees the
  messages before any other wrapper rebuilds them. It splices the member's tail
  in at each recorded offset, or does nothing when the member has no tail.

So a member without a tail gets content byte-identical to today's, and a path
that bypassed the wrapper would still send clean content with no tail rather
than a stray marker. Nothing the user writes or a tool returns can create an
insertion point, because insertion points exist only as builder-written metadata.

The offset is recorded for **every** satellite the session sends: the kickoff
turn, generation-build satellites, and each reply-resume turn when
`[agent.sessions.resume.satellite].tail = true` (it follows that toggle exactly
like `TAIL.md`). It is independent of `tail_file = null`: a session type that
suppresses `TAIL.md` still gets the model tail unless it overrides the profile.

Because insertion happens per attempt over the whole message list, a failover
mid-session puts the new member's tail into every satellite, including those in
earlier kickoff turns. Each member therefore always sees a byte-stable history of
its own.

### 4.3 Where the dispatch hook lives

`buildModelFallback`'s `makeBase` already wraps per-member stream functions
(`withDeclaredDeferredTools`, `withStaleThinkingDropped`). Model prompts are one
more per-member wrapper, `withModelPrompt(base, resolved)`, built from the
member's logical id and the session's session type. This covers the
single-member path and every fallback reason (primary, health, budget, context,
failover) with no change to member selection.

Background health probes (`makeProber`) use the bare stream function and never
receive a model prompt.

## 5. Accounting and caching

- **Estimates.** The frozen context estimate includes the head member's preamble
  and tail tokens. Per-member fits gating (PER-MEMBER-CONTEXT-FITS §2) adds each
  member's own model-prompt tokens to the observed context, so a member is never
  picked for a context its additions push over its window.
- **Caching.** Every provider cache is per upstream model, so per-member text
  adds no misses: a failover already starts the new member cold, and within a
  member the bytes are stable for the session. Editing a prompt file makes the
  next session's first request cold for that lineage, which is expected.
  Bedrock explicit breakpoints and Anthropic system-block cache control operate
  on the final payload and need no change.

## 6. Observability

- `usage_events` records, per request, `model_prompt` (profile name, or null) and
  `model_prompt_hash` (short hash of the preamble and tail bytes actually sent).
  The hash is what tells an operator which text a model saw after a file edit.
  Nullable columns; one migration.
- `model_prompt_resolved` (info) logs once per session per member: session id,
  session type, member, profile, which rung matched, source paths, hash.
- Console: the context inspector shows the preamble as a system-prompt segment
  and the model tail as a labelled block at its offset, both marked "resolved per serving
  model", with the profile of the session's head member. The session view lists
  the profile and hash for each member that served.
- Context dumps (`app.context_dump_dir`) show the stored content plus the head
  member's resolution alongside.

## 7. Scope

**In**: every agent session type (chat, proactive, summarize, condense, diary,
and declared types), on every wire API, for every way a member gets chosen
(session-type model, per-agent override, per-user selection, decision routing,
fallback).

**Out**:
- Decision models (`system-one`, §8h): not chat models, no system prompt.
- Fetch-chain lanes that are not sessions: captioning, embeddings, the x_search
  and image_gen tool calls. The same profile reference could be added to them
  later if a need appears.
- Ordering variants within each position (§ owner decisions).
- Templating inside prompt text.

## 8. Per-agent variation

No config-level per-agent layer (owner, 2026-10-04). `workspace_file` resolves
against the serving agent's own workspace, which already gives each agent its own
text for the same profile; an agent without the file simply gets no text for that
position (with the §3.2 warning).

## 9. Tests

- Resolution ladder: exact model, `"*"`, model default, none; `"none"` at each rung.
- Preamble is byte 0 of the system prompt on Anthropic, Responses and Chat
  Completions payloads; the stored system prompt is unchanged.
- Fallback: a chain `A → B` sends A's texts, then B's after failover, in one
  session; every earlier kickoff satellite gets B's tail.
- No tail for the serving member: the wire content is byte-identical to the
  feature-off rendering. Stored snapshot and transcript content never contain
  model-tail text or any marker.
- Resume: `modelTailAt` survives the snapshot round-trip; the tail is inserted in
  the reply-resume turn when `resume.satellite.tail` is on, not when off.
- The wire payload (all three APIs) carries no trace of the offset field.
- `withModelPrompt` runs before `withDeclaredDeferredTools` /
  `withStaleThinkingDropped` rebuild messages.
- Probes carry no model prompt.
- Freshness: a file edit between sessions is picked up; an edit mid-session is not.
- Missing `workspace_file` at session time omits the position and warns.
- Startup validation cases from §3.3.
- `usage_events.model_prompt_hash` matches the bytes on the wire.
