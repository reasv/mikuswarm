# Decision-model integration — session gating, model routing, continuation, dedup, retrieval

**Status**: PROPOSAL (planning session 2026-09-18). Nothing here is implemented.
**Target ARCHITECTURE.md home once implemented**: a new §8h "Decision model" (client, decision-point registry, billing lane, fallback rule); touched sections §8 (resumable sessions / follow-up folding / duplicate-reply mitigation), §8a (model resolution), §8f (ledger class), §9 (final user turn additions), §9d (auto-retrieval), §9g (proactive scheduler), §10 (`send_message`), §4 (config schema).
**Related**: PER-USER-LIMITS, MODEL-FALLBACK, RESUMABLE-SESSIONS, FOLLOWUP-FOLDING, DUPLICATE-REPLY-MITIGATION, DYNAMIC-TOOL-LOADING, SUMMARY-LAYER-BUDGET.

**Owner constraints (2026-09-18)** — these bound every section below:

1. **Opt-in, everywhere, forever.** Every decision point is off unless configured. A deployment without a decision model is byte-identical to today. New features that *could* use the decision model still ship a heuristic path.
2. **The heuristic path is first-class, not a degraded mode.** The decision model is a single small provider with dynamic capacity and no drop-in replacement. On any failure (unavailable, timeout, rate-limited, unhealthy, malformed, low confidence) the harness switches to the existing heuristic for that decision point automatically and silently, and returns when the provider is healthy again.
3. **No dry-run / shadow mode.** Decision points are evaluated by turning them on and watching the bot. Every evaluation is *logged* (answers, confidence, latency, cost, and the heuristic verdict where it is cheap to compute alongside) so decisions can be analysed later, but nothing in this design gates a rollout on that log.
4. **The decision model never hard-gates the agent.** It gates *spend* (whether a session starts, which model heads it) and it *advises*. Where it intervenes on something the agent is doing (the duplicate guard), the agent gets an explanatory error and may proceed on the next attempt.
5. **No de-escalation.** The default chat model is chosen for writing quality and persona; switching normal chat to a cheaper model degrades every reply and poisons the context. Routing only ever *escalates* to a more capable model for specific task types, bounded by the user's quota. There is no "trivial chat" tier: if a cheaper model were good enough for normal chat it would already be the default.
6. **Route by task type first, difficulty second.** The decision model is far more reliable at "what kind of task is this" than at "how hard is this". Task categories map to models and skills; the difficulty scale is only a fallback for requests no category covers.
7. **Billing follows the session.** A decision made for a user-triggered session is billed to that session's payee for per-user limits, because it is part of the cost of serving that user. On top of that, decision-model spend needs its own aggregate cap, because it is used everywhere.

---

## 1. Motivation

The harness separates the chat from the agentic sessions that act on it. That separation is what makes a group chat workable at all, but it leaves a set of *decisions* that today are made by heuristics or by brute force:

- **When to start a session** without being addressed (proactive posting: a random timer plus a message-count gate; every attempt pays a full context build whether or not there was anything to say).
- **Whether to wait** for a follow-up message or image before starting (a 2 s hold).
- **Where a message goes**: a new session, an interjection into a running one, or a resume of a just-completed one (a chain of reply-target, same-sender, and time-window rules).
- **Which model** serves a session (a fixed per-session-type model, degraded by affordability, with no notion of what the request *is*).
- **Whether a reply is redundant** with something another session already sent (claims on trigger messages only).
- **What extra material** goes into context (a fixed top-3 of tiny memory snippets; summaries the agent rarely expands on its own).

A *decision model* — a model that returns typed, calibrated probabilities over options the caller defines, in a few hundred milliseconds, at a fraction of a cent per call — fits exactly these seams. It cannot write text and it is not a reasoning model, but every decision above is a choice among options the code already knows.

This spec designs one integration surface and five decision points on it. The reference provider is TypeSafe's Jev (a "System One" model); the design is written against the API shape rather than the vendor so that any provider exposing the same primitives can be configured.

## 2. The decision-model API (as it constrains the design)

Facts the design depends on (TypeSafe docs, September 2026):

- **One endpoint** — `POST` a JSON body `{ model, state, questions }`; the response is `{ model, answers, usage: { input_tokens, output_tokens } }`. TypeSafe serves it at `/v1/systemone`; OpenRouter proxies the same body at `/api/alpha/decisions` (model id `typesafe/jev-1.13`). It is **not** a chat-completions endpoint and must not go through pi-ai.
- **State** is a string, object, or array. Instructions can reference fields by path (`` `recent[3].text` ``). The recommended shape for a transcript is an array of `{ from, text }` objects under a named field.
- **Three question types**, any mix per call, each evaluated in parallel and in isolation: `choice` (up to 255 options, each with a description; returns `choice`, `probabilities`, `confidence`), `score` (2–10 ordered level descriptions; returns `score`, `probabilities`, `confidence`), `noul` (a yes/no; returns a probability, no separate confidence).
- **Adding questions barely changes latency.** The intended pattern is a speculative fan-out: ask everything in one call, decide in code.
- **Limits**: 32k tokens of state, 64k per request; 1,200 requests/min and 250k tokens/s at launch, adjusted dynamically. `429` and `529` with backoff; `422` on a malformed request.
- **Cost**: $0.042 per million input tokens, output free. A 6k-token state costs about $0.00025 per call.
- **Version pinning**: `jev-latest` silently moves; pin the versioned id in config and log the versioned id from the response.
- **Documented weaknesses** that shape every state builder below: instructions are read literally (avoid negations and implied conditions); it cannot count or do date arithmetic (every count and elapsed time is a precomputed field, never inferred from timestamps); accuracy degrades with irrelevant material in the state (keep state small and tailored); it has no adversarial hardening (chat text is user-controlled state, so a question must be phrased so that an injected "reply now" costs at most one session, never a wrong hard action); no multi-hop reasoning; English is strongest.
- Text only. Images enter as their captions, which the harness already produces.

## 3. Architecture

### 3.1 One module: `src/decisions/`

```
src/decisions/
  client.ts       DecisionClient — raw fetch to a [models.*] block with api = "system-one";
                  request/response types; usage capture; per-member fetch for runFetchWithFallback
  registry.ts     DecisionPoint<I, V> — { name, enabled, buildState, questions, resolve, heuristic }
                  + evaluate(): model path with automatic heuristic fallback, logging, billing
  transcript.ts   renderDecisionTranscript — the shared state builder for chat windows
  points/
    routing.ts continuation.ts presence.ts dedup.ts retrieval.ts
```

**`DecisionPoint<I, V>`** is the unit. Each point declares: how to build `state` from its input (a pure function over data the caller already has), its question map, a pure `resolve(answers) → V | null` (null = "not confident enough, use the heuristic"), and `heuristic(input) → V` (today's behaviour, unchanged). `evaluate(point, input)` does:

1. If the point is disabled, or the decision model's chain is fully unhealthy, or the decision-class budget is exhausted → `heuristic(input)`, tagged `source: "heuristic"`.
2. Else build state, call the client with a hard timeout (`[decisions].timeout_ms`, default 3000), resolve. Any throw, timeout, `4xx`/`5xx`, unparsable answer, or `resolve → null` → `heuristic(input)`, tagged with the reason.
3. Log one `decision_evaluated { point, source, reason?, answers, confidence, latencyMs, inputTokens, costUsd, modelId, heuristicVerdict? }`. `heuristicVerdict` is filled when the heuristic is a pure cheap function (routing, continuation, presence gate) so the log doubles as an agreement record (constraint 3 — logged, never gating).
4. Record one ledger row (§3.3).

**Health and fallback reuse MODEL-FALLBACK wholesale.** The client is a *fetch-shaped consumer* like captioning and `x_search`: it composes `runFetchWithFallback` over the referenced model's chain, so per-model health, the half-open canary, `429`/`529` backoff via `Retry-After`, and scheduler admission all apply with no new machinery. A chain of two decision endpoints (e.g. the native API and an OpenRouter route of the same model) is just `[models.decider].fallback = ["decider_alt"]`. When the whole chain is unhealthy the registry short-circuits to the heuristic without attempting a call (step 1), logging a rate-limited `decision_model_unavailable` once per minute.

**Nothing else in the app imports the client.** Call sites depend only on `evaluate(point, input)` and the typed verdict, so a deployment without `[decisions]` never constructs a client.

### 3.2 A new wire API on `[models.*]`

`ModelSchema.api` gains the literal `"system-one"`. A model with this api is never offered to pi-ai (the factory refuses it as a session-type or fallback member of a chat model at startup — fail-fast validation, like the existing `reasoning`/`thinking_level` contradiction check). Its `endpoint` is the **full URL** of the decisions endpoint, so both the native and the OpenRouter route are plain config:

```toml
[models.decider]
api = "system-one"
provider = "typesafe"                    # informational; drives nothing
endpoint = "https://api.typesafe.ai/v1/systemone"   # or an OpenRouter/gateway URL ending in /api/alpha/decisions
api_key = "${DECISION_MODEL_API_KEY}"
id = "jev-1.13.0"                        # pinned; 'jev-latest' moves under you
input_modalities = ["text"]
context_window = 32000                   # state budget; the client clamps state to this
max_tokens = 1                           # schema-required; unused by this api
[models.decider.cost]
input = 0.042
output = 0.0
cache_read = 0.042
cache_write = 0.042                      # real per-token prices; no cache exists on this api
```

`cost` records the provider's real prices (owner rule: cost blocks state real prices even when a transport cannot count a class). `usage.input_tokens` from the response is what gets priced.

### 3.3 Billing: a `decision` ledger class, payee-attributed

- `UsageEventClass` gains `"decision"`; `[[limits]].classes` accepts it. Rows carry `class = "decision"`, `tool_name = <point name>` (reusing the column as the sub-lane label, as the tool lane does), `model_id`/`logical_model_id` = the served member, and the usual attribution columns.
- **Session-bound points** (routing, continuation-when-a-session-results, dedup, retrieval) fire after the session placeholder exists, so the row carries `agent_session_id`, `session_type`, `timeline_key`, and `trigger_sender_id`. The per-user engine (`recordUsageEvent`, `app.ts`) treats class `decision` exactly like class `tool`: it credits the payee's fungible total and shared pools but never a model-scoped sub-cap (a decision has no requested chat model). This is constraint 7's first half with a one-line change at the fan-in and one added literal in `UsageEventClass`.
- **Session-less points** (the presence evaluator when it decides *not* to launch; a continuation verdict of "ignore") carry `timeline_key` and the *would-be* session type (`proactive.session_type` for presence) but no session and no sender. They count toward `[[limits]]` rules selecting by `classes`/`session_types` and toward nothing per-user.
- **The aggregate cap** is an ordinary `[[limits]]` rule, e.g. `{ name = "decisions-daily", classes = ["decision"], max_usd = 1.5, window = day }`. The BudgetEngine's existing gate covers it; the registry consults `engine.check({ class: "decision", modelId })` in step 1 and falls back to the heuristic when blocked (never refuses the underlying work — a blocked decision budget means "decide the old way", constraint 2).
- Console: the Usage page's per-class breakdown gains the class for free; the session view shows decision rows in the existing tool-lane table keyed by `tool_name`.

### 3.4 The shared transcript state builder

Every chat-window point uses `renderDecisionTranscript(timelineKey, opts)` → `{ messages: [{ id, from, at, reply_to?, mentions_bot?, text, attachments? }], fields }` where:

- `text` is the plain body (rich-reply fallback stripped); `attachments` are the caption strings (never paths); ids are the external ids the harness already prints (`send_message`'s `reply_to_id` form), so a verdict can name a message the agent can act on.
- `from` is the display name, with the bot's own messages marked `from: "<bot display name>", self: true`.
- `at` is a short relative label (`"3m ago"`) — *and* every count or elapsed time a question needs is emitted as a top-level field (`fields.minutes_since_self_last_message`, `fields.human_messages_since_self_last_message`, …), because the model must not be asked to derive them.
- Bounded by `opts.maxTokens` (per point, default from `[decisions].state_max_tokens` = 8000) using the same tokenizer as the context builder; newest messages are kept. Rendering reads the same timeline query/compaction inputs the context builder uses (`TimelineStore.queryForContext`, honouring the §7d floor and §9h visibility), so a decision never sees what a session could not.
- Persona text goes into question **instructions**, never into state (TypeSafe's guidance: state holds facts, instructions hold judgments). It comes from `[decisions].persona`, a two-to-four line operator-written summary. **`SOUL.md` is never read** for this or any purpose.

## 4. Configuration

```toml
[decisions]
enabled = false                 # master switch; every point below also has its own
model = "decider"               # a [models.*] block with api = "system-one"
timeout_ms = 3000
min_confidence = 0.6            # default per-point floor for choice/score verdicts
state_max_tokens = 8000
persona = """A regular in these rooms: curious, a little sardonic, likes music and games,
happy to answer questions and to poke at bad takes."""   # operator-written, short

[decisions.routing]             # §5.1
enabled = false
state_max_tokens = 6000
min_confidence = 0.75           # escalation requires a confident category
preload_skills = true
[decisions.routing.tasks.creative_writing]
description = "Writing a character card, story, scene, song, or other long-form creative text."
model = "frontier"              # a [models.*] key; optional
skills = ["character-cards"]    # preloaded on route; optional
tail_files = ["tail/creative.md"]   # extra tail instructions for this task; optional
[decisions.routing.tasks.coding]
description = "Writing, fixing, or explaining code or a shell command."
model = "frontier"
skills = ["coding"]
[decisions.routing.tasks.research]
description = "Answering a factual question that needs looking things up or reading sources."
skills = ["web-research"]
# ... any number of operator-defined categories; 'other' is implicit
[decisions.routing.difficulty]  # fallback axis, optional
levels = [
  "A one-line reply or reaction.",
  "A short explanation or opinion needing no lookup.",
  "Several steps of work, e.g. reading a page and comparing two things.",
  "Careful multi-constraint work where quality matters more than speed.",
]
models = { 4 = "frontier" }     # level index → model; only the levels listed escalate

[decisions.continuation]        # §5.2
enabled = false
window_ms = 1800000             # completed sessions younger than this are candidates
untriggered_senders = "recent"  # "recent" | "none" — evaluate bare messages from recent session participants
min_confidence = 0.7

[decisions.presence]            # §5.3 — replaces the random proactive cadence when on
enabled = false
eval_after_messages = 3
eval_quiet_ms = 90000
min_eval_gap_ms = 60000
state_max_tokens = 8000
join_threshold = 0.7
addressed_threshold = 0.85      # set to 1.0 to disable "answer when talked to without a mention"
kickoff_prompt = """..."""      # structured template, see §5.3; {reason} {targets} {time}

[decisions.dedup]               # §5.4
enabled = false
duplicate_threshold = 0.7

[decisions.retrieval]           # §5.5
enabled = false
candidates = 12
relevance_threshold = 0.55
injection_threshold = 0.7
excerpt_lines = 12
max_tokens = 1500

[[limits]]
name = "decisions-daily"
classes = ["decision"]
max_usd = 1.5
window = { type = "calendar", period = "day", tz = "UTC" }
```

Validation (fail-fast at startup, in `app.ts` next to the other cross-field checks): `[decisions].model` must exist and have `api = "system-one"`; every `tasks.*.model` / `difficulty.models.*` must be a `[models.*]` key with a chat api; every `tasks.*.skills` entry must name a listed skill in the workspace (a warning, not an error — workspaces vary per agent); `tail_files` must exist under the workspace; `addressed_threshold`/`join_threshold` in `[0, 1]`.

## 5. Decision points

Each point states: **when** it runs (the trigger condition is always a cheap mechanical check — the model is never called on every message), **state**, **questions**, **verdict** mapping, **heuristic** (must be exactly today's behaviour), and **touchpoints**.

### 5.1 Routing — model, skills, and instructions for a new session

**When.** Inside `AgentSessionFactory.create` for a **human-triggered, default-lane** session (trigger `dm`/`mention`/`reply`, session type resolved to the chat lane), *before* `buildModelFallback` and `buildContext`. Not for background types, not for proactive sessions (§5.3 launches with its own verdict), not on resume (the persisted context was built for its model; changing it mid-rollout is the "poisoned context" case constraint 5 forbids).

**State.**
```json
{ "request": { "from": "...", "text": "...", "reply_to": { "from": "...", "text": "..." }, "attachments": ["caption"] },
  "recent": [ { "from": "...", "text": "..." } ],            // last ~10 messages, ≤ state_max_tokens
  "skills": [ { "name": "character-cards", "description": "..." } ] }   // the session's listed skills
```
**Questions** (one call):
- `task` — `choice` over the operator's `[decisions.routing.tasks.*]` keys with their descriptions, plus `other: "None of the above; ordinary conversation."`
- `difficulty` — `score` over `[decisions.routing.difficulty].levels` (only if configured).
- `skill` — `choice` over the session's listed skills plus `none` (only if `preload_skills`). This is the cookbook pattern that measured 2.3× fewer wrong loads than a roster prompt; it is orthogonal to the static `tasks.*.skills` mapping and the union of both is preloaded.

**Verdict** `{ model?: string, skills: string[], tailFiles: string[], task: string | "other" }`:
- `model` = `tasks[task].model` when `task ≠ other` and `confidence ≥ min_confidence`; else `difficulty.models[round(score)]` when configured and confident; else none.
- **Escalation-only rule (constraint 5), enforced structurally**, not by trusting config: a routed model is applied only if it appears *earlier* than the session's default model in the governing preference order — the user's `[[user_limits]].models` list when per-user limits are active, else the default model's own chain. The preference order *is* the quality order (PER-USER-LIMITS §4.2); "earlier" means "better". A routed model not in that list is ignored with a `decision_route_ignored` log.
- **Quota-bounded**: with per-user limits active, the routed model becomes the *requested head* and the user's preference list stays as the degradation tail — preference-outer, chain-inner, exactly as today. If the user cannot afford the routed model right now (`engine.affordable`), selection proceeds down the list as it would for any exhausted rung; the escalation simply does not happen. Without per-user limits, the routed model's own `fallback` chain applies.
- `skills` are preloaded through the dynamic-tool registry (`registry.load(matches)`) so their tools are in `initialState.tools`, and each body is rendered in the **final user turn** as `<preloaded_skill name="…">…</preloaded_skill>` immediately before `<tail_instructions>`. The final turn is already volatile per session, so this costs the prompt cache nothing; putting bodies in the system prompt would break the cross-session stable prefix. (Open: whether to instead seed the transcript with a synthetic `load_skill` call/result pair so the model sees the load as its own action; the satellite render is simpler and cache-identical, and is the recommendation.)
- `tailFiles` are appended to `<tail_instructions>` after `TAIL.md`. This is the first step toward **tailored instructions**: an operator splits task-specific guidance out of the always-on tail into per-task files, so a routed session sees fewer, more specific instructions and every other session sees a shorter tail. A later revision may add conditional sections inside one file (`<when task="creative_writing">…</when>`); per-task files need no parser and are recommended for v1.

**Heuristic.** No routing: today's `resolveModelKey` result, no preloads, `TAIL.md` only.

**Touchpoints.** `factory.ts` (`create`: call the point after `resolveModelKey`, feed `model` into the head passed to `buildModelFallback`, feed `skills` into the dynamic split, feed `tailFiles`/skill bodies into `ContextBuilder.buildContext` options); `context/builder.ts` (satellite render of preloaded skills + extra tail files); `agent/dynamic-tools.ts` (a `loadInitial(names)` that marks tools loaded before the first turn; the loaded-set-from-transcript rule gains "∪ initial preloads", persisted on the session row so resume recomputes identically); `usage_events` row per evaluation.

**Interaction with the deterministic skill→model switch.** A skill loaded *mid-session* via `load_skill` still cannot change the model (context is frozen for it). That remains a possible separate feature and is not designed here; routing at creation is the general answer.

### 5.2 Continuation — where does this message go?

Today's chain (`handleInbound`): reply to a running session → steer; quick same-sender follow-up → fold (steer/park/resume); shared reply-target → coalesce; reply to a completed session → resume gate (same-user, window, capability, work gate); else fresh. It is all reply-target and same-sender rules, and it mostly needs an explicit reply. The gap the owner wants closed: a follow-up that is *not* a reply and *not* quick — a fresh `@` thirty seconds later, or a bare "and what about X?" from the same person — starts an amnesiac session.

**When.** A message reaches this point only when there is something to continue: at least one **running** session in the timeline, or at least one **completed** session younger than `continuation.window_ms` that is resume-eligible on the mechanical gates (row `completed`, generation current, context below ceiling, not a synthetic type). The message must be one of:
- a trigger-bearing message that is **not** an explicit reply to a bot message (explicit replies keep their existing paths: they are an address, not a guess), or
- when `untriggered_senders = "recent"`: an *untriggered* group message from a sender who triggered, or was the reply target of, one of the candidate sessions. Everything else stays inert, which bounds cost to "people who were just talking to the bot".

Existing precedence stays ahead of it: `steerReplyToActiveSession` and `coalesceCoTargetReply` run first (explicit reply shapes). Follow-up folding's *quick* windows also run first; this point is the slow, context-judged extension of the same idea and takes over where the fold's clocks give up.

**State.**
```json
{ "message": { "from": "...", "text": "...", "mentions_bot": true },
  "context": [ { "from": "...", "text": "..." } ],                       // the few messages around it
  "candidates": [
    { "id": "s-abc", "status": "running",   "asked_by": "...", "asked": "...", "last_reply": "...", "age": "40s ago" },
    { "id": "s-def", "status": "completed", "asked_by": "...", "asked": "...", "last_reply": "...", "age": "6m ago" } ] }
```
**Questions.** `target` — `choice` over candidate ids (each described by its `asked`/`last_reply`) plus `new: "A new request unrelated to the candidates."` and, for untriggered messages, `not_for_bot: "The message is not directed at the bot and continues nothing of its."`; `is_followup` — `noul` "The message continues, corrects, or asks about the candidate's exchange."

**Verdict.** `target = running id` → steer as an `<interjection>` (the existing path, image-capable); `target = completed id` → resume via `runResumeSession` with the **decision gate**: the mechanical checks above, the CAS, and material viability — the *work gate*, `same_user_only`, and the time window are replaced by the model's judgment (the owner's point: whether this is a follow-up is a question about the *conversation*, not about the rollout's tool calls); `new` → the normal fresh path; `not_for_bot` → inert. Confidence below `min_confidence` → heuristic.

Explicitly kept: the **capability gate** (persisted `context_tokens` below the ceiling). A long browser session near its ceiling is never resumed, decision or not, until rollout compaction exists.

**Heuristic.** Today's chain verbatim. For an untriggered message the heuristic verdict is always inert (it is not a trigger today), which is what makes `untriggered_senders` safe to leave on with the model down.

**Touchpoints.** `app.ts` `handleInbound` (one new fork between `foldFollowUp` and `coalesceCoTargetReply`, plus the untriggered-message entry, which needs the provider's raw emit to be offered to the point the way `resolveReplyTrigger` is — a callback wired at provider construction, resume-unaware); a `evaluateContinuationGate` sibling of `evaluateResumeGate`/`evaluateFollowUpResumeGate`; `session-claims.ts` unchanged (the claim is taken by whichever session the verdict picks); `usage_events` row.

### 5.3 Presence — activity-driven proactive participation

The current scheduler wakes at random times inside a quota-derived cadence, checks a message-count gate, and pays a full session that then decides whether to say anything; the prompt is built around "you probably shouldn't". It works, but the bot arrives after conversations have ended and the session cost is paid on every miss.

**When (replaces the random timer when enabled).** Per opted-in channel, an **evaluation** is scheduled on activity rather than on a clock: after `eval_after_messages` new human messages since the last evaluation, or `eval_quiet_ms` of silence following at least one new message, whichever first; never more often than `min_eval_gap_ms`. The free pre-gates stay: `daily_posts` remaining > 0 (hard ceiling on sessions, sent and `NO_REPLY` alike), no active session in the timeline, dead-channel backstop, DM opt-out, `active_hours`. `min_user_messages` remains configurable but is **not** applied when presence is on unless set explicitly per channel, because counting non-bot messages is exactly the rule that prevents back-and-forth (the owner's "conversation mode" goal).

**State.** `renderDecisionTranscript` window (`state_max_tokens`), plus fields: `minutes_since_self_last_message`, `human_messages_since_self_last_message`, `self_last_message_got_reply`, `self_posts_today`, `daily_post_budget_remaining`.

**Questions** (one call; `[decisions].persona` in every instruction that needs it):
- `join` — `noul`: "A regular of this room matching the persona, who has been reading along, would naturally say something now."
- `addressed` — `noul`: "One of the latest messages is talking to the bot or asking it something without naming it."
- `open` — `noul`: "The conversation is still going rather than concluded."
- `pending_media` — `noul`: "The latest message announces something that has not arrived yet (an image, a link, 'hold on')."
- `reason` — `choice`: `answer_question`, `react_to_something_shared`, `add_an_opinion`, `joke`, `correct_or_inform`, `continue_own_earlier_point`, `other`.
- `target` — `choice` over the ids of the last K (default 8) human messages plus `none`: the message the bot would most naturally respond to.

**Verdict.** Launch when `¬pending_media ∧ (addressed ≥ addressed_threshold ∨ (join ≥ join_threshold ∧ open ≥ 0.5))`. Otherwise no session, no quota consumed, one ledger row (session-less), and the next evaluation is armed by activity as above. `pending_media = true` re-arms a short evaluation (`eval_quiet_ms / 3`) instead of skipping.

**Structured kickoff.** The proactive launch is unchanged (`launchSession(inbound, false, { proactive: true })`, synthetic inbound, `proactive.session_type`, typing suppressed) except that the kickoff is rendered from `[decisions.presence].kickoff_prompt` with `{time}`, `{reason}` (the chosen reason's label), `{targets}` (the `target` id with a short quote, plus the runner-up when its probability is within 0.2), and `{addressed}` (a sentence when the addressed threshold fired). The default template inverts today's framing: *"It is {time}. You were not mentioned, but this looks like a good moment to join: {reason}. The most relevant messages are {targets}. Reply as a participant, briefly, in one message — or output NO_REPLY if on reading it you have nothing to add."* `NO_REPLY` stays available and the session type's `session_instruction` (length rules) stays as is. The `target` id lets the session `send_message` with `reply_to_id` when a reply is the natural shape.

**Per-user billing enhancement (optional, later).** When `addressed` fires and `target` names a message, the launched session can be attributed to that message's sender for per-user limits, turning "proactive" into an ordinary reply for accounting. Not in v1: the session is billed to the proactive session type as today.

**Heuristic.** When the point is disabled or the model is unavailable, the scheduler runs today's cadence (`computeNextAttempt` + `evaluateGate` + today's `proactive.kickoff_prompt`), automatically. The two modes share the quota counter and the launch path, so switching between them mid-day is safe.

**The paradigm note.** With `addressed_threshold < 1`, users can talk to the bot without mentions and it will answer — a materially different interaction model that some deployments will not want. It ships default-off (`1.0`) and is a per-channel override. Mentions and replies keep triggering reliably regardless: presence adds entry points, it never removes them.

**Touchpoints.** `proactive/scheduler.ts` (an activity-armed timer fed by the timeline's inbound hook, replacing `computeNextAttempt` when the point is on; the tick's decision enum gains `skip_decision` and `run_decision`; `proactive_tick` logs the answers); `app.ts` kickoff render; config; `usage_events` row.

### 5.4 Duplicate-send guard

Today `send_message` refuses to *reply to a message another session has claimed* (`isClaimedByOther`) — a check on the target, not on the content. The residual failure is two near-simultaneous sessions saying the same thing, usually because one sent a reply the other had not seen when it drafted its own.

**When.** At `send_message`, only if **another session in the same timeline has sent a message after this session's context was built** (or after this session's last delivered interjection, whichever is later) — a timeline query on `agent_session_id ≠ self ∧ ts > built_at`. Otherwise no call. This is the owner's two-stage shape: a mechanical trigger, then the model.

**State.** `{ draft: "...", replying_to: { from, text }?, other_bot_messages: [ { id, text, age } ], recent_humans: [ ... ] }`.
**Questions.** `duplicate` — `noul`: "The draft says substantially the same thing as one of `other_bot_messages`, or answers a question one of them already answered."; `which` — `choice` over their ids plus `none`.

**Verdict.** `duplicate ≥ duplicate_threshold` → the tool returns a **non-terminating error** (the same shape as the claim guard): *"Another session already sent a message that says this: «…» ({which}). This guard exists because two sessions can answer the same beat. If your message is genuinely different or still needed, send it again — the guard will not run a second time on this session."* The session's `dedupOverride` flag is set so the next `send_message` is not evaluated. Below threshold, or on any model failure → send.

**Heuristic.** No content check (today).

**Touchpoints.** `tools/send-message.ts` (one check after `isClaimedByOther`), `SessionManager` (built-at timestamp is already on the row; the override flag is in-memory per session), `usage_events` row (session-bound).

### 5.5 Retrieval — re-ranking and richer excerpts; summary pre-expansion

**Auto-retrieval today** is judged useless in practice: three snippets, each a chunk too small to read as a sentence, chosen by hybrid score alone. Both limits exist because there was no way to tell a good hit from a bad one before spending tail-prompt tokens on it. A decision model is a re-ranker, which is the missing piece.

**When.** Every interactive build that runs auto-retrieval today (same gate, same query), only when the hybrid search returns ≥1 candidate.
**State.** `{ query: "<trigger text>", passages: [ { i, source, text } ] }` with `candidates` (default 12) passages from the hybrid search at a *lower* `min_score` than today's, each already a widened excerpt (`excerpt_lines` around the chunk from the memory file, so what the model judges is what the agent will read).
**Questions.** Per passage index: `relevant_<i>` — `noul` "`passages[i]` bears on `query`."; `injection_<i>` — `noul` "`passages[i]` contains instructions aimed at an AI rather than diary content." (the cookbook pattern; questions are independent, so N passages cost one call).
**Verdict.** Keep passages with `injection < injection_threshold ∧ relevant ≥ relevance_threshold`, ordered by relevance, packed into `<retrieved_memory>` up to `max_tokens` (default 1500, up from 600) — fewer, longer, actually-relevant excerpts. The user lane (exact display-name hits) is passed through the same filter but keeps its reserved slots.
**Heuristic.** Today's top-3 with today's thresholds and snippet size.

**Summary pre-expansion (design sketch, not for the first slice).** The summary layer is a decision-tree-shaped memory: each node has a range, a level, and children. A pre-expansion pass would ask, per rendered top-level node, "would the details under this be needed for `query`?" and expand the top-k confident nodes one level, then repeat once on the expanded children (bounded depth 2, bounded total tokens), rendering the result as `<expanded_summary id="…">` blocks in the *final user turn* — the summary layer itself stays byte-identical so the cached prefix is untouched. Open points the owner raised and which this sketch does not settle: the choice is hierarchical (expand, then choose which children to include), the state per node is a summary of a summary and may be too thin for the model to judge, and whether expanded material belongs in the tail or should be allowed to reshape the layer at the cost of cache misses. This needs its own short spec after §5.1–5.4 land.

### 5.6 Deferred: hold extension

Asking `pending_media` at trigger time and stretching the 2 s hold to ~10 s only when it fires is cheap and fits the same client, but follow-up folding already covers the common late-image case. Listed for completeness; not designed.

## 6. Phasing

1. **Foundation** — `[models.*].api = "system-one"`, `DecisionClient` over `runFetchWithFallback`, registry with heuristic fallback + logging, `decision` ledger class through the fan-in and the per-user engine, `[decisions]` schema + validation, console class breakdown. Tests: fake client (answers, 529, timeout, malformed), fallback matrix, ledger attribution for session-bound vs session-less points.
2. **Routing (§5.1)** — highest value, most objective; includes skill preload and per-task tail files.
3. **Continuation (§5.2)** — fixes the amnesiac-follow-up class of bugs.
4. **Presence (§5.3)** — the structured kickoff and activity-armed evaluator; tuned live.
5. **Dedup (§5.4)**.
6. **Retrieval re-rank (§5.5, first half)**; summary pre-expansion gets its own spec.

Each phase is independently shippable and independently switchable; phase 1 alone changes nothing observable.

## 7. Open questions for the owner

1. **Escalation-only enforcement.** The spec enforces "never route to a model later in the preference order than the default". Is the preference order reliably the quality order in every deployment, or should the rule be config-declared (`[decisions.routing].escalation_order = [...]`)?
2. **Skill preload placement.** Satellite render (recommended) vs a synthetic `load_skill` call/result in the transcript.
3. **Continuation for explicit replies.** Explicit replies to bot messages keep the existing resume gate (work gate included). Should the decision model also be allowed to *override* the work gate for an explicit reply when it judges the reply a follow-up, or is the work gate authoritative there?
4. **Presence quota semantics.** `daily_posts` keeps counting `NO_REPLY` sessions. With the evaluator filtering attempts, is a *sent-only* quota preferable?
5. **Who pays for an `addressed` launch.** v1 bills the proactive type; the enhancement bills the addressed message's sender. Default for v2?
6. **Decision budget exhaustion.** On the daily decision cap, this spec falls back to heuristics for the rest of the window. Alternative: reserve a slice of the cap for routing (the point with the best cost/benefit) and let only presence/retrieval fall back first.

## 8. What this deliberately does not do

- No per-message evaluation of every chat message; every point has a mechanical pre-condition.
- No change to how mentions, DMs, and explicit replies trigger.
- No model switching mid-session, and no de-escalation.
- No dependence on a vendor SDK; the client is ~100 lines of fetch against a documented JSON shape.
- No new database tables: one enum literal on `usage_events.class`, one column on `agent_sessions` for initial preloads (phase 2).
