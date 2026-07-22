# Resumable Sessions (reply-to-continue)

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §8 "Resumable sessions (reply-to-continue)" (mechanism), the §4 config schema section (the `[agent.sessions.resume]` knobs), §8 "Schema versioning" (the v25→v26 migration), and the §11b browser tab note; retained for review. Schema v26; `src/agent/work-gate.ts`, `ContextBuilder.buildResumeTurn`, factory `resumeContinuation`, `tryReplyResume`/`runReplyResumeSession` in app.ts, `storage.acceptResumeGeneration`, `loadCompletedSessionMaterial`. Open questions §17 resolved as: window defaults shipped as proposed (6h DM / 1h group); `enabled` is the per-context global toggle (no per-channel allowlist — the §14 config block, the authoritative surface, has none); `failed-resumable`/`interrupted` stay console-only; the capability gate is the hard FRESH-redirect on `context_tokens ≥ ceiling`; the reply-target bot-message lookup lives in `app.ts` (a step after `detectTrigger`), keeping the pipeline resume-unaware.
**Target ARCHITECTURE.md home once implemented**: §8 (session lifecycle) for the mechanism; the config schema section for the new knobs; a short note in §11b (browser) for tab handling.
**Author/Date**: planning session, 2026-06-16.

---

## 1. Motivation

Every user-triggered reply runs in its own single-turn agentic session: the chat history is rendered into a frozen context at session start, the agent does its rollout (thinking + tool calls), emits output via `send_message`, and the session settles. This is the right primitive for the overwhelmingly common case (a specific request → a response) and buys us concurrency, cache-friendliness, and fine-grained chat/rollout separation.

It fails in one situation: **multi-step tasks that span a reply.** The bot generates an image but forgets to post it; you ask where it is and it genuinely has no idea, because the prior session's rollout (where it knows the path) is gone. It does research but doesn't cite sources; you ask and it can't reconstruct them. The artifact usually still exists on disk (the workspace is shared and session-agnostic), but the *memory of what was done* died with the session.

The fix: **replying to an agent message resumes the session that produced it**, appending the user's message as a new turn and continuing the same rollout — rather than spawning a fresh, amnesiac session. `@`-mentioning (or any non-reply trigger) still starts a fresh session, as today.

Two alternatives were considered and rejected as the primary mechanism:
- **A cross-session "recall" tool** (let the agent read its own past transcripts). Rejected as the spine: it inverts the natural data flow (a fresh session reaching *backward* and pulling, on the agent's own initiative, which agents rarely do for non-obvious tool calls), and it is badly off-distribution — a continued multi-turn rollout is exactly what models are trained on, whereas "fresh session reconstructs its own past via a tool call" is a contrived shape. A recall tool may still be worth adding later as a minor standalone convenience, but it is not this design.
- **"New session seeded with prior state as initial state."** Rejected: it is *more* work and *less* clean than true resume, which already exists for failure recovery (see §3). True resume reuses that machinery.

## 2. Goals / Non-goals

**Goals**
- Replying to an agent message continues its session as a genuine multi-turn rollout (true resume, same session row).
- The trigger pipeline (detection, hold/lookback grouping, claims, coalescing) stays **entirely unaware of resume**; the resume-vs-fresh decision is a fork made *downstream*, at session creation.
- Behavior is predictable and configurable; wrong guesses degrade to "fresh session," never to corruption or silent message loss.

**Non-goals (explicitly out of scope for this iteration)**
- **Session forking.** A session cannot be resumed from the *same state twice*. The second attempt to resume from an already-consumed point becomes a **new session**, always. (See §6 — this is a load-bearing constraint, not a footnote.)
- **Rollout compaction.** A resumed session whose context approaches the model ceiling re-parks exactly as today (`checkContextBudget` → `failed-resumable`). This bounds how far long sessions (esp. browser-use) can be carried. Compaction is a known, deferred follow-up (§12).
- **Prefix rebase / mutating the frozen context.** The frozen prefix is never rebuilt or rewritten on resume. Rebuilding it to absorb intervening messages reintroduces exactly the incoherence the freeze invariant exists to prevent (the agent's own replied-to message reappearing in rebuilt history while also living in the rollout that produced it; the rollout dangling off a foundation it never saw). The gap (§9) is surfaced in the appended turn instead.
- **Models delegating to *dead* sessions** via visible session IDs. Possible future extension (§8); not built here.

## 3. Current code this builds on

- **True resume already exists** for failure recovery. `loadResumeMaterial` reconstructs a session from its persisted `context_snapshot_json` (the frozen prefix) + `transcript_json` (the full rollout: assistant turns, tool calls, tool results), `SessionManager.adopt()` re-registers the row, and the agent re-issues via `continue()`. The only thing stopping a *completed* session from being resumed is policy: the gate `MANUAL_RESUME_STATUSES = {failed-resumable, interrupted}` at [recovery.ts:415](src/agent/recovery.ts:415). Nothing in completion teardown is destructive — `evict()` clears in-memory maps but the durable row survives, and `adopt()` rebuilds state.
- **Context is frozen at creation and append-only** (`Object.freeze(frozenBase)`; `transformContext` returns `[...frozenBase, ...liveMessages]`; [factory.ts](src/agent/factory.ts)). The chat prefix and the agentic rollout are cleanly separable. Resume must preserve this — never rebuild the prefix.
- **The agent→message backlink is persisted**: every agent-sent message carries `agent_session_id` on its `timeline_events` row ([database.ts:1490](src/storage/database.ts:1490)), survives restart, and is already used by `steerReplyToActiveSession` to route replies into *running* sessions.
- **Reply relations are already parsed**: `event.replyToId` → `replyTo.externalId` ([inbound.ts:84](src/matrix/inbound.ts:84)). `detectTrigger` ([inbound.ts:113](src/matrix/inbound.ts:113)) currently emits only `dm`/`mention`, but the trigger-type union already contains `"reply"` ([types.ts:106](src/types.ts:106)).
- **Claims & coalescing**: `SessionClaims` (synchronous-at-accept) and co-target coalescing ([session-claims.ts](src/agent/session-claims.ts), `coalesceCoTargetReply` in [app.ts](src/app.ts)) — these keep working for resume triggers for free (§10).
- **Browser tabs close on settle** in the run's `.finally` ([app.ts](src/app.ts)); the persistent identity/cookies survive (shared context). See §11.

## 4. Design overview

```
inbound message
   │
   ▼
trigger pipeline  ── unchanged ──  detect → hold/lookback → trigger group → claims/coalesce
   │                               (a reply to a bot message now counts as a trigger; §5)
   ▼
FORK (at session creation) ─────────────────────────────────────────────┐
   │ reply targets a resume-eligible completed session (all gates pass)? │
   ├── yes ──▶ RESUME: adopt the row, append [gap (§9) + trigger group],  │
   │          re-render satellite (§11), continue(); consume generation   │
   └── no  ──▶ FRESH: a normal new session (no state inheritance)         │
```

The fork is the *only* new branch. Everything above it is the existing trigger machinery; everything the resume branch needs (snapshot, transcript, adopt, continue) already exists for failure recovery.

## 5. Trigger detection change

Today a room message triggers only on `@`-mention; a bare reply does not. For resume we need a reply *to a bot message* to enter the pipeline.

- **Gating**: a message triggers iff `dm` OR `mention` OR **reply-to-a-bot-message** (the reply target resolves, via `agent_session_id`, to a message we sent). Replying to a *non-bot* message with no mention still does not trigger (unchanged). Replying to a bot message **always** triggers — even if the target turns out non-resumable — because addressing the bot should always get a response; resumability only decides *continue vs fresh*, downstream.
- Emit `trigger.type = "reply"` (the union member already exists). In DMs a reply already triggers as `dm`; the `replyTo` field carries the target regardless of type, so the fork (§7) reads `replyTo`, not the trigger type.
- Resolving "is the reply target a bot message" needs a timeline lookup by `externalId` (as `steerReplyToActiveSession` already does). Whether that lookup lives inside `detectTrigger` or in a step immediately after is an implementation choice; the rest of the pipeline (hold/lookback/claims/coalescing) must run unchanged.

## 6. The no-fork / single-consumption rule (load-bearing)

**A session cannot be resumed from the same state twice.** Linear continuation is allowed (reply to the latest output → resume → it completes → reply to *its* new output → resume again …). Branching is not (reply to a *superseded* output → new session).

**Mechanism — resume generation:**
- Add `agent_sessions.resume_generation INTEGER NOT NULL DEFAULT 0`.
- Tag every outbound agent message with the session's current `resume_generation` at send time. Add `timeline_events.agent_session_generation INTEGER` (nullable; existing rows = `NULL`, treated as `0`).
- Increment `resume_generation` **atomically when a resume is accepted** (status → `resuming`), so the new run's sends are tagged with the incremented value and the prior outputs are immediately stale.
- A completed session is reply-resumable **only via a target message whose tagged generation equals the session's current `resume_generation`.** A reply to an older-generation message → FRESH.

This yields, with no extra bookkeeping:
- **Linear chains work**: latest-generation outputs are always the live handle.
- **Forking is impossible**: once a state is consumed, its outputs are stale forever.
- **Failed resumes are safe**: if a resume is accepted (gen bumped) then fails/discards, the session is no longer `completed`, so the fork yields FRESH regardless; the orphaned bump is harmless.
- **In-flight replies** (during the resume run) are caught by the existing running-session interjection path *before* the fork (§10), so the generation check only governs the post-completion case.

**Why this makes the same-user heuristic matter more** (§7): single-consumption makes the resume a *scarce* resource — one continuation per state. If anyone could consume it, a third party replying to the bot for an unrelated reason would burn the original asker's one continuation and force their real follow-up into a fresh session. Gating the scarce resume to the original trigger sender reserves it for the person most likely to actually be continuing. Scarcity is what turns the heuristic from arbitrary into meaningful allocation.

## 7. The fork: resume eligibility

At session creation for a reply trigger whose `replyTo` resolves to agent message `M` of session `S` — and where resume is **enabled for this context** (`enabled.dm`/`enabled.group`); if not, skip straight to FRESH:

1. If `S` is currently `running`/`resuming` → **not handled here**; the existing interjection path already steered it (§10).
2. If `S.status != "completed"` → **FRESH**. (`failed-resumable`/`interrupted` keep their existing console-resume path; `discarded` is dead.) `NO_REPLY` sessions sent no message, so they have no reply handle and cannot be reached this way at all.
3. `S.session_type` not in `SYNTHETIC_SESSION_TYPES` → else FRESH (synthetic worker sessions aren't repliable anyway).
4. **Generation** (§6): `M.agent_session_generation (NULL→0) == S.resume_generation` → else FRESH (stale/consumed handle).
5. **Work gate** (structural, mandatory; §7a): ≥1 non-exempt tool call within the configured scope (per-context: `any_in_history` in DMs, `since_last_turn` in groups) → else FRESH. Thinking blocks never count. The core protection against resuming pure conversation, and what keeps satellites from accumulating across back-and-forth.
6. **Heuristic gates** — *skipped for explicit agent delegations* (§8); applied to human replies:
   - `same_user_only` (config) AND replier `sender_id != S.trigger_sender_id` → FRESH.
   - `window` (per-context: DM/group) AND `now - S.completed_at > window` → FRESH.
7. **Capability gate** (recommended): if `S`'s persisted context is already at/over the ceiling, resume would immediately re-park (no compaction; §12) → FRESH instead. A structural/capability gate that applies even to explicit decisions (§8) — the decider can't observe it for itself.
8. **Material viability**: `loadResumeMaterial(S)` non-null → else FRESH. (The work-gate scan, §7a, can reuse this loaded transcript.)

All pass → **RESUME**: adopt `S`, bump generation (status → `resuming`), build the appended turn (§9) + re-render satellite (§11), `continue()`. On completion, `resume_generation` is already incremented and the new outputs are tagged with it.

**FRESH** = a normal new session triggered by this message, with **no state inheritance**. Context is not lost — the replied-to message and surrounding chat appear in the new session's rendered history as usual; the thread simply isn't *continued*.

### 7a. The work gate — why and how

Resume exists to continue **stateful work**, not conversation. A session whose rollout is pure chat (only `send_message`, maybe a reaction) holds nothing a fresh session lacks — the chat history already carries it — so resuming it is pure cost: dragging the whole prior rollout back in, and (the real motivator) re-injecting a fresh **satellite system block** on every conversational reply, with each resume burying another stale satellite. The work gate forbids this. **It is always on** — there is never a reason to continue a chat that did no work — but two aspects of *how* it measures "work" are tunable (and tuned differently for DMs vs groups).

**Base rule (mandatory):** resume only if there is ≥1 **non-exempt tool call** within the configured scope. **Thinking / content blocks never count** — this is about resuming agentic *rollouts* (tool-driven state), not about preserving the reasoning behind a message, which isn't reliably reconstructable anyway.

**Knob 1 — scope (`since_last_turn` vs `any_in_history`).** Where must the work appear?
- `since_last_turn` (strict): ≥1 non-exempt tool call in the segment since the *last real user turn* — equivalently, in the **latest resume-generation's rollout** (each generation starts with exactly one real user turn, §6). Forces each turn to *itself* keep doing work; a work session whose resume turn produces only conversation stops being resumable. This is what prevents a single early tool lookup from silently swallowing a long back-and-forth into one ever-growing session.
- `any_in_history` (loose): ≥1 non-exempt tool call *anywhere* in the session so far. Keeps a thread resumable as long as it ever did work — so a research result carries through a chain of follow-up questions that themselves make no new tool calls. The cost is the swallowing risk above.
- The tradeoff is real and direction-dependent (strict loses the research-Q&A chain after the first toolless follow-up; loose risks runaway sessions), so scope is **per-context configurable**, defaulting **`any_in_history` in DMs** (low-noise, one-on-one, follow-up chains are the norm) and **`since_last_turn` in groups** (noisy — a lookup must not capture the room's back-and-forth).
- **Real user turns only — not interjections.** For `since_last_turn`, interjections (steered `<interjection>` messages) are messages *within* a segment, never boundaries: work triggered by an interjection still counts toward its segment. Only true triggers / resume-triggers delimit segments; the implementer must distinguish them in the transcript (the `<interjection>` envelope is the existing signal; explicit metadata is more robust).

**Knob 2 — extra exempt tools.** A per-context list of additional tool names to treat as non-work, on top of the built-in exempt set below. **Must accept MCP tool names** (`mcp__…`) as well as first-party names, since the agent can reach MCP tools.

**What's exempt (does NOT count as work).** Principle: *a tool whose entire effect is already visible on the chat surface leaves no rollout state worth continuing* — and because this application's default is to start fresh sessions, **classification leans exempt**: when a tool is borderline, exclude it. The safe failure direction is "didn't resume" (degrades to a fresh session, today's behavior), never "resumed stale chatter." Built-in exempt set:
- Chat-surface: `send_message`, `react`, `edit_message`, `delete_message`, `create_poll`, `poll_vote`, `pins`, `set_profile`.
- Control (flow, not state): `spawn_session`, `delegate_to_session`.
- `media` (the captioning / VQA tool, [media.ts](src/tools/media.ts)) — **exempt**. Its source must be a path/URL already in the chat, and its result is referenced in the agent's reply; the only thing a fresh session loses is the specific caption, which the agent can regenerate by calling `media` again with the follow-up question — better than reading it off the prior answer. (See §18 for the proper long-term fix.)

**What counts as work.** Everything that deposits non-chat information or external state into the rollout — `browser`, `bash`, file edits, `image_generate`, `find_source`, `web_*`/`x_*` fetch & search, the retrieval/read tools (`search_messages`, `recap`, `read_messages`, `read_image`, `search_memory`/`recall_memory`, …), `write_memory`/`diary_tool`, etc. Read/retrieval tools **do** count: their *results* live in the rollout, not the chat — precisely the "research whose sources are only in the rollout" case.

**Implementation.** Classify first-party tools via a flag on the `AgentTool` definition (e.g. `chatSurface: true`) rather than a hidden central list, so a new tool is forced to declare its bucket and can't silently drift; supplement with the per-context `extra_exempt_tools` config list for MCP tools and operator overrides. Lean exempt for anything ambiguous. The base gate (≥1 work call somewhere in scope) is **mandatory** — only the two knobs are configurable.

## 8. Heuristics vs. explicit decisions

A heuristic (same-user, time-window) only earns its place when it is *inferring* intent we have no explicit signal for — a bare human reply. An **explicit agent decision** already *is* the signal and must not be gated behind an intent-guess. So:

- **Human reply** → all gates: structural (generation, **work** §7a, material viability) + intent heuristics (same-user, window) + capability.
- **Agent delegation** (`delegate_to_session`, or a future "delegate to dead session") → **bypasses the intent heuristics only** (same-user, window). The **structural gates still apply** — including the work gate (delegating to a session that did no continuable work has nothing to continue) — as does the capability/budget gate (the one thing the decider can't observe for itself).

Note: delegation today only ever targets *running* sessions, so "delegation resumes a dead session" is presently just the end-of-session race (handled as a normal completed-session fork). Letting models deliberately delegate to dead sessions via the visible IDs on rich messages is a future extension; when built, it follows the same principle — no heuristic gate, only the budget gate.

## 9. The appended turn (trigger group + gap)

The new user turn appended to the resumed rollout has two parts, in chronological order: the **gap** (older, missed context) then the **trigger group** (the actual request).

### 9.1 Trigger group
Produced by the normal pipeline (hold/lookback), unchanged. It is the set of messages "considered the trigger" and may be non-contiguous (other messages can fall between its members).

### 9.2 Gap backfill
Gives the resumed session awareness of what happened in the room while it was away. **Off by default, configured per-context (DM/group)** — see §9.3.

- **Direction & bounds**: contiguous, **newest-first**, walking **backward from the trigger group's *latest* member** (NOT its earliest — earliest would silently drop any non-trigger messages interleaved *between* trigger members). Excludes the trigger-group members themselves. Lower bound = the newest message already present in the session's context (for a first resume, the original trigger group's latest member; for a linear chain, the previous resume's trigger group). Never re-render what the session already has.
- **Include the bot's own sends** from the gap window, rendered as in-room messages. This is **not** redundant with the rollout: the rollout holds them as `send_message` tool calls (and inbound as interjections); the gap renders them as chat messages — a different, legitimate view that also carries reactions / who-replied and anchors the human messages.
- **Respect session ownership.** Some gap messages are themselves triggers claimed by *other* sessions — in a **DM that is *every* gap message** (each is its own trigger), in groups it's the occasional @-mention/reply. Surfacing an *unanswered* such message invites the resumed session to duplicate-handle work another session already owns (the exact failure SessionClaims prevents). So when the gap is enabled, messages that are triggers claimed by another session must be **excluded, or rendered with a `handled_by_session`-style marker** so the resumed session knows they are not its to answer. (Already-answered ones are merely redundant.) In a DM this rule alone would empty the gap — which is why DMs default it off outright.
- **Contiguity is mandatory**: a chat slice must be a contiguous run — newest-that-fit, oldest truncated at the boundary. **Never** punch holes / filter to a subset (e.g. "keep human messages, drop the bot's") to fit a budget — that misrepresents the conversation.
- **Truncation marker**: when the budget cuts the gap short, emit a marker (`"N earlier messages omitted"`) so the agent does not read the backfill as contiguous-to-its-last-turn.

### 9.3 Gap budget (config, per-context)
**Off by default in both contexts; in DMs it stays off for a stronger reason than size** (§9.2 ownership — a DM's gap is entirely other sessions' triggers). Configured separately for DMs and groups (groups are the case where enabling it is meaningful). Two independent limits; the backfill stops at whichever is hit **first**:
- `max_messages` — message count.
- `max_tokens` — token count, **excluding the trigger group** (the request is never budgeted away).

Convention: `0` = include none (the default → gap off), `>0` = cap, `-1` = unlimited. **Cross-field rule (per context): not both unlimited.** The time-window heuristic (§7) keeps gaps small in practice; surfacing *every* intervening message is not the goal — most chatbots of this kind do not feed full chat history into a continuation.

## 10. Interjection unification

The existing "steer a message into a session" has, today, three implicit outcomes; resume fills in the one that currently silently drops:

| Target session state | Behavior |
|---|---|
| `running` / `resuming` | **interject** (existing `steerReplyToActiveSession`) |
| `completed` + resume-eligible (§7) | **resume** (new) |
| `completed` but stale/gated, or non-resumable status | **new session** (FRESH) |

This replaces the current "interject into an already-ended session → no-op/drop" dead-end. It applies uniformly to human replies and to cross-session delegation/co-reply handoffs (both of which currently fail when the target has ended).

Because the trigger layer stays free (§4), `SessionClaims` and co-target coalescing cover resume triggers automatically — and that matters: two near-simultaneous replies to the same dead message would, with the timeline-slot guard alone, see the second *rejected*; coalescing instead makes the second **land as an interjection into the resumed session**, which is the desired behavior. Verify this path, but it should fall out of the layering.

## 11. Satellite re-rendering on resume

The satellite system block normally sits near the context end (after history, before the trigger group) to put volatile data and high-adherence instructions where the model sees them last. After a rollout + appended turn, the *original* satellite is **doubly degraded**: its data is stale AND it is no longer near the end. We render a **fresh** satellite at the new position. We do **not** touch the buried original (that would be a frozen-context rewrite — out of scope, §2). The work gate (§7a) is what makes this safe at scale: fresh satellites are only ever added for genuine work continuations, which are ceiling-bounded, so they cannot pile up across ordinary back-and-forth.

The buried stale copy is acceptable, not contradictory: the rollout between the two establishes time passing, so it reads as "state when I started" vs "state now," and `runtime_state` already carries the current time, so latest-wins orders them with nothing added.

Content is split by **volatility**:
- **`runtime_state` — always fresh.** Volatile and necessary; this is the floor, and the reason the block can never be fully disabled.
- **`retrieved_memory` — always omitted on resume; not a knob.** Volatile, marginal, expensive. Omitting it does not *lose* the original memories (they remain buried in the frozen prefix); it only forgoes *new* retrieval against the follow-up, which the rollout has already largely contextualized. A genuinely new sub-topic that needs memory is a fresh-session case.
- **Tail instructions — the single toggle, default ON.** Stable, so repeating is pure redundancy with zero contradiction risk; the only axis is recency-vs-tokens, and recency is the entire point of the satellite. A long resumed rollout is *precisely* where instruction adherence drifts worst and the buried tail no longer counters it, so it is the highest-value-per-token thing to keep near the end. It is also the one block whose value is genuinely empirical — hence it being *the* knob.

Net config surface: `runtime_state` always, `retrieved_memory` never, `tail` toggle (default on). There is **no `{reduced, full}` mode** — the only thing a "full" option would add is retrieval, the lowest-value and most-redundant-on-resume block.

**Browser note** (§3): the prior session's browser tab was closed on settle, but the persistent identity/cookies survive. On resume, surface a one-line note (e.g. in `runtime_state`) that the previous tab was closed and can be reopened, with login preserved. Cheap; non-blocker.

## 12. Context growth & compaction (deferred)

Resumable sessions make context growth a real concern, but compaction is **not built here**. Consequence to document honestly: a resumed session that approaches the ceiling re-parks via the existing `checkContextBudget` → `failed-resumable` path; long browser-use sessions get at most a turn or two of continuation before that. There is no file-offload/handover workaround — a parked session is dead, and a later session cannot find or even know about files it wrote; that path does not work and must not be specced as a mitigation.

When compaction is built, the least-bad first cut is **eliding old tool *results*** (browser snapshots, file/search dumps — where the tokens are) while keeping assistant turns and tool-call args so the "what I did" narrative survives — far better than dropping whole turns, and reusing the summarization worker-pool concept (§9b) applied to the rollout segment. The capability gate (§7.6) is the clean place this later plugs in.

## 13. Persistence / schema

Bump `LATEST_SCHEMA_VERSION` 25 → 26 ([database.ts:6751](src/storage/database.ts:6751)). Migration step (additive, guarded for rewound test fixtures, per the existing migration conventions):
- `agent_sessions.resume_generation INTEGER NOT NULL DEFAULT 0`.
- `timeline_events.agent_session_generation INTEGER` (nullable; `NULL` ≡ generation 0 for pre-migration rows, so existing completed sessions remain resumable exactly once).
- Extend the resume gate: add `"completed"` to the set the resume path accepts for the **reply-triggered** entry point (keep the console/manual path on `{failed-resumable, interrupted}` as-is, or unify into a `RESUMABLE_STATUSES` that the two entry points filter differently). Reuse the existing `resuming` status and `adopt()`.
- Tag outbound sends with the current `resume_generation` at append time (`send_message` write path).

No new tables. No change to `context_snapshot_json` / `transcript_json` shape.

## 14. Config schema

Proposed under `[agent.sessions.resume]` (sibling to the existing `coalesce_window_ms`). Per project convention: ship defaults in `00-defaults.toml`, set explicitly in local config, fail-fast on invalid, and put **cross-field validation in `app.ts`, not the loader** (mirrors proactive).

```toml
[agent.sessions.resume]
same_user_only = true       # §6/§7 — global; reserve the scarce single resume for the original asker (inert in DMs)

# Enable, per-context (§14). Resume is off unless the message's context is enabled here.
[agent.sessions.resume.enabled]
dm    = false
group = false

# Resume time window (§7), per-context. 0 or -1 = unlimited. Proposed; tune.
[agent.sessions.resume.window]
dm    = 21600000            # 6h — focused 1:1; a reply carries explicit continuation intent
group = 3600000             # 1h — noisy; bound staleness / blast-radius of a wrong guess

# Gap (§9) is per-context; DM stays off — its gap is entirely other-session triggers (§9.2).
[agent.sessions.resume.gap.dm]
max_messages = 0            # off; 0 = none, >0 = cap, -1 = unlimited
max_tokens   = 0            # excludes the trigger group

[agent.sessions.resume.gap.group]
max_messages = 0            # off by default; the meaningful one to enable
max_tokens   = 0

[agent.sessions.resume.satellite]
tail = true                 # §11 — the only satellite knob; runtime_state forced on, retrieved_memory forced off

# Work gate (§7a) is always on (>=1 non-exempt tool call required); these knobs
# tune HOW it measures work, separately for DMs and group chats.
[agent.sessions.resume.work_gate.dm]
scope              = "any_in_history"   # follow-up chains keep prior work's context
extra_exempt_tools = []                 # extra tool names (incl. mcp__*) to NOT count as work

[agent.sessions.resume.work_gate.group]
scope              = "since_last_turn"  # a single lookup can't swallow the room's back-and-forth
extra_exempt_tools = []
```

Cross-field validations (app.ts): each `gap.<context>` `max_messages` and `max_tokens` not *both* `-1`; a `gap.<ctx>`/`window.<ctx>` setting only matters when `enabled.<ctx>` is true (warn if set while that context is disabled); `work_gate.*.scope ∈ {since_last_turn, any_in_history}`.

**Open**: global vs per-channel enablement. Proactive uses a per-channel allowlist; resume may want the same (a room opts into reply-continuation) rather than a single global switch. Recommend mirroring the proactive allowlist if per-channel control is wanted; otherwise the global `enabled` suffices. Decide before implementation.

## 15. Edge cases

- **`NO_REPLY` sessions**: no sent message → no reply handle → unreachable by reply-resume. Correct by construction.
- **Pure-conversation session** (rollout is only chat-surface tools): reply → FRESH via the work gate (§7a). The conversational context isn't lost — it's in the fresh session's rendered chat history. This is the primary case the gate protects.
- **Work that drifts into conversation**: once a resumed turn produces only chat-surface activity, the *next* reply → FRESH (the gate inspects only the latest segment), even though earlier turns did real work.
- **`discarded` / `failed-resumable` / `interrupted`**: reply → FRESH (the latter two keep their console path). Possible future extension: let a reply also adopt a `failed-resumable` session, but out of scope now.
- **Concurrent replies to the same handle**: first accepted resume flips status → `resuming` (generation bumped) synchronously; the second hits the running-session interjection path (§10) or coalesces. No double-resume.
- **Reply to a stale (superseded) output after a linear chain**: generation mismatch → FRESH (§6).
- **Resume that immediately re-parks** (over ceiling, no compaction): either pre-empted by the capability gate → FRESH (§7.6), or it parks `failed-resumable` and falls to the console path. Document as a known limitation, not a bug.
- **Replied-to message whose session row was pruned/missing**: `agent_session_id` resolves but the row is gone → FRESH.
- **Multi-send sessions** (S sent several messages in one run): all carry the same generation; a reply to any of them resolves to S and resumes from S's *current end* (resume always continues the whole rollout, not "from that message"). The first such reply consumes the generation; later replies to sibling messages of the same run → stale → FRESH.

## 16. Touchpoints (for the implementer)

- Trigger detection / reply-as-trigger: [src/matrix/inbound.ts](src/matrix/inbound.ts) (`detectTrigger`, `replyTo`), trigger-type union [src/types.ts:106](src/types.ts:106).
- Fork at creation + interjection unification: [src/app.ts](src/app.ts) (`steerReplyToActiveSession`, `coalesceCoTargetReply`, launch/creation path).
- Resume mechanism: [src/agent/recovery.ts](src/agent/recovery.ts) (`MANUAL_RESUME_STATUSES`, `loadResumeMaterial`), [src/agent/session-manager.ts](src/agent/session-manager.ts) (`adopt`, statuses, generation bump).
- Appended turn / gap rendering: context + render layer ([src/context/](src/context/), [src/timeline/](src/timeline/)); satellite assembly in [src/context/builder.ts](src/context/builder.ts) / [src/agent/factory.ts](src/agent/factory.ts).
- Generation tagging on send: [src/tools/send-message.ts](src/tools/send-message.ts) + storage write path.
- Work gate (§7a): scan the candidate transcript for a non-exempt tool call within the configured scope (`since_last_turn` ⇒ from the last real user turn, distinguishing real turns from `<interjection>` messages; `any_in_history` ⇒ anywhere). Per-tool `chatSurface` flag on the `AgentTool` type ([src/types.ts](src/types.ts)) + each [src/tools/](src/tools/) factory, plus a per-context `extra_exempt_tools` name list that must match MCP `mcp__…` names. Can reuse the transcript `loadResumeMaterial` loads. `media` already tags captions `context:"tool"` ([media.ts:70](src/tools/media.ts:70)) — the hook for §18.
- Schema/migration + columns: [src/storage/database.ts](src/storage/database.ts).
- Claims/coalescing (verify they cover resume triggers): [src/agent/session-claims.ts](src/agent/session-claims.ts).
- Browser tab note: [src/browser/session.ts](src/browser/session.ts), close-on-settle in [src/app.ts](src/app.ts).
- Config: schema in [src/config/](src/config/), defaults in `config/00-defaults.toml`, cross-field validation in [src/app.ts](src/app.ts).

## 17. Open questions (decide before / during implementation)

1. `window` defaults (proposed 6h DM / 1h group) — confirm, and whether `unlimited` is ever wanted.
2. `enabled` is now per-context (DM/group); the further question is whether **group** resume should be a **per-channel allowlist** (specific rooms opt in, like proactive §9g) rather than an all-groups toggle.
3. Whether `failed-resumable`/`interrupted` should also be reply-resumable, or stay console-only (§15).
4. Capability gate (§7, item 7): hard FRESH-redirect when over ceiling, or attempt-and-re-park? (Recommend hard redirect once a cheap context-size estimate is available.)
5. Exact home of the reply-target bot-message lookup (inside `detectTrigger` vs a step after) — keep the rest of the pipeline free regardless.

(`enabled`, `window`, `gap`, and the work gate are all per-context now; `same_user_only` stays global as it is inert in DMs. The work-gate exemption set is settled per §7a.)

## 18. Related future work — persist interactive captions (out of scope)

Exempting `media` (§7a) means a resume no longer carries the specific caption it produced. The proper fix is orthogonal to resume and belongs to the captioning pipeline; it is recorded here only because the rationale surfaced with the `media` exemption.

When `media` is called with the **default caption prompt** (no custom VQA prompt) on a source we recognise as an **attachment/URL already present in the chat timeline**, the tool should: trigger a normal captioning job (at elevated priority, since it's interactive), return the caption to the agent as today, **and persist it as the timeline caption** for that attachment — exactly where the enrichment pipeline would have written it (matching by attachment path / URL). That makes manual captioning transparently permanent. VQA (a custom-prompt, one-off question) is *not* persisted — it isn't a reusable caption. The `media` tool already tags its inference calls `context: "tool"` ([media.ts:70](src/tools/media.ts:70)), so the pipeline can already distinguish this path. Likely warrants its own spec when picked up.
