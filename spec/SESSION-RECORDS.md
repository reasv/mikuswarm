# Session records — carrying a session's work into later sessions

**Status**: PROPOSAL (2026-10-05, from the owner design discussion of 2026-10-04/05). Nothing here is implemented.
**Supersedes**: the continuation point of `spec/DECISION-MODEL.md` §5.2 as shipped (ARCHITECTURE.md §8h "Continuation", deployed off). It is removed when this lands.
**Replaces as default**: reply-to-continue (`spec/RESUMABLE-SESSIONS.md`). The resume code stays but ships off by default.
**Changes**: decision-model routing's skill preload (ARCHITECTURE.md §8h "Routing") moves from a satellite render to the injection mechanism of §4.
**Target ARCHITECTURE.md home once implemented**: a new §8i "Session records"; touched sections §8 (resumable sessions), §8h (routing, decision points), §9 (final turn), §10 (new tools), §11 (console).
**Related**: DECISION-MODEL, RESUMABLE-SESSIONS, FOLLOWUP-FOLDING, DYNAMIC-TOOL-LOADING, SUMMARY-LAYER-BUDGET.

## 1. Problem

A session does work the chat never sees: searches, pages read, results it looked at and left out, files it made, choices it made. When the conversation comes back to that work, users expect the agent to know it. They ask it to:

- cite or explain its sources;
- explain what it did and why;
- post something it found and mentioned in passing ("found X and Y, not Z" → "post X and Y");
- find and change what it just made (a card, a file, an image).

A fresh session has only the chat. It can search again, but that is slow, costly and often fails.

**Reply-to-continue** (resume the completed session's rollout) was the answer so far, gated by heuristics: same user, explicit reply, time window, work gate. It fails in practice in both directions:

- **Replies are how people talk to the bot.** A back-and-forth conversation becomes one ever-growing session. That happens even when the next request needs nothing from the last one ("find another image of something else"). The result is a stale, fragmented context, wasted tokens, a risk of running out of context, and one session billed as one unit of work that is really several.
- **The heuristics exclude real follow-ups.** Another user asks about the work, an `@` comes without a reply, or the 30 minutes run out.
- **The continuation point** (decision-model §5.2, shipped off) replaced the heuristics with a judgement, but kept "resume the rollout" as the only way to carry work. It also wandered into judging untriggered messages, which is a different decision (§9).

## 2. Design in one paragraph

Every session that did real work writes a **session record** in one extra turn right after it completes, while its prompt cache is guaranteed warm. A record is a compact, purpose-built account of the work, written so that a later session with only the chat and this record can answer questions about the work and carry it on. Every trigger starts a **fresh** session. The relevant records are put into its context by a **synthetic tool call** appended to the start of its live transcript, the same call the agent can make itself. **Without a decision model**, a reply to a bot message injects that message's session record. **With a decision model**, each candidate record is judged for relevance to the request, for replies and plain `@`s alike. The agent can always fetch more on demand: another record, the record a record builds on, or the raw transcript. Resume is off by default.

This is per-session compaction at a natural boundary, tailored to how this bot works. Sessions are short, so there is no multi-level hierarchy. Drill-down to the transcript removes the hard limit on what can be recovered.

## 3. Records

### 3.1 Which sessions write one

A completed chat-lane or proactive session that passes the **work gate** (ARCHITECTURE.md §8 "The work gate": at least one non-exempt tool call). Pure conversation writes nothing, because the chat already carries it. Generation sessions (summarize, condense, diary) never write one. A session that ends with `NO_REPLY` and did work still writes one; its work may still matter.

### 3.2 The record turn

After the run settles from the user's point of view (claims released, timeline slot freed, follow-up watch untouched), the harness appends one user turn to the same agent and prompts it. That is a strict suffix of the last request, so the cache reads the whole rollout at the cache-read rate. The turn:

- states the purpose: *a later session will see only the chat and this record; write what it needs to answer questions about this work and continue it*;
- says that what is needed depends on the work:
  - for a lookup: the sources behind what was said, including things only mentioned in passing, and what was found but not used;
  - for something made or changed: the artifacts (paths, message ids), their state, and how to continue or verify;
  - anything left open;
- tells it to anchor the record to the messages it sent (by message id), because users reply to any of them, not only the last;
- asks for the record as plain text. Not a tool call: a new tool would change `tools`, and that leads the request and would cost the cache.
- never asks it to restate its reasoning. A record of *what* and *where*, with one-line *why*s, is a handoff note. Explicit chain-of-thought extraction is what provider distillation classifiers target (owner concern, §11).

The record is capped (`max_tokens`, configurable, sized like a summary node). Length scales with the work under that cap.

The record turn is billed like any request of the session: class `agent_loop`, the session's payee. It runs at background priority after the settle and never delays the next trigger. Its row (`session_records`, §3.4) is written when it lands. A trigger that arrives before the record exists gets none injected (it may wait up to `[session_records].inject_wait_ms` on an in-flight record). The agent can still fetch it later.

### 3.3 Chains

If session B started with A's record injected, B's own record is written with A's record in context, so it carries forward whatever of A stayed relevant. B's record names A (`builds_on`, from the injection). The agent follows chains one hop at a time with the record tool. The decision model never walks a chain.

### 3.4 Storage

New table `session_records(session_id primary key, text, token_count, builds_on text /* JSON session ids */, model_id, created_at)`, written through the single-writer queue. A resumed session (resume on, §7) writes a new record per resume generation; the latest replaces the row. Indexed by session id only: lookups always come from a known message's `agent_session_id` or a candidate list.

## 4. Injection: a synthetic tool call

Dynamic context goes into a fresh session as a **synthetic tool call and result appended to the start of its live transcript**, after the final user turn, before the model's first response. The call is a real tool the agent has, so the injection looks exactly like the agent having called it.

Why this, and not more blocks in the final user turn:

- it is in-distribution for the model;
- it shows the model the tool works, cueing it to call the same tool for something else it needs;
- anything the decision model can inject should also be retrievable on demand anyway;
- one mechanism replaces a new render position in the already busy tail every time a kind of context is added.

Uses:

- **Records:** `read_session_record(session_id)` (§5).
- **Skill preloads** (routing, ARCHITECTURE.md §8h): `load_skill(name)`. Its result carries `addedToolNames`, so the native dynamic-loading path does the rest (the `tool_reference` load point included), and a resume re-derives the loaded set from the transcript.
  - This **removes** the satellite `<preloaded_skill>` render, `DynamicToolRegistry.loadInitial`, the tool-definitions-as-text path, and the `tools` field of `agent_sessions.initial_preloads`. The column keeps only the routed model, cascade and thinking level.

The synthetic messages are persisted in the transcript like any turn. The console shows them as tool calls with a marker that the harness made them (§8). They follow the final user turn, so the frozen prefix and its cache are untouched.

Verify at implementation: a synthetic `tool_use` with no thinking block, appended after the final user turn, on each wire API in use (the Bedrock relay, OpenAI Responses with prefill, OpenAI completions). Expected fine: there are no reasoning blocks in synthetic content, and `drop_stale_thinking` already sends tool-use turns without thinking.

## 5. Agent-facing tools

Per CLAUDE.md "Agent-facing tools: activation & discovery design".

- **`read_session_record(session_id)`**: returns the record, with `builds_on` ids and a one-line pointer to the transcript tool.
  - Errors are actionable: "no record: this session did no tool work (its messages are all there is)", and "record still being written, try again shortly".
  - **Immediate.** It is reactive: a user points at a bot message mid-conversation with no other cue naming the task. Bot messages already render `agent_session_id`, so the argument is always in sight.
  - Cost: one short definition.
- **`read_session_transcript(session_id, query?, range?)`**: drill-down into the raw rollout. Tool calls with arguments, results clipped per the tool-result budget, either matching `query` or within a turn range.
  - **Deferred**, behind the record tool's pointer and a skill (`sessions` today covers multi-session coordination; dual-home it there, with a description cued on "what did you find earlier / where did you get that").

**Entry points.**

1. "Post the second one" as a reply: the record is already injected (§6). The agent sees the ids and posts.
2. The same ask as a plain `@` with the decision model on: the record is injected if judged relevant. Without the model, the agent sees the earlier bot message in chat with its session id, and the injected-call precedent in other sessions teaches the tool. Calling it is one cheap step.
3. "Where did you get that?" about something not in the record: the record's transcript pointer, then `read_session_transcript`.

## 6. Which records are injected

### 6.1 Without a decision model (default)

A trigger that is a **reply to a bot message** injects that message's session record, if one exists. No time window and no same-user check: context is rebuilt normally, so the reasons for the old limits (a frozen rollout drifting from the room) do not apply. The only cost is context space. Every other trigger injects nothing, and the tools remain.

### 6.2 With a decision model

The decision model replaces the reply rule with a judgement, and extends it to triggers that are not replies (`[decisions.records]`, a new point; DECISION-MODEL §3 machinery).

**Candidates.** The replied-to message's session (if it has a record) plus the sessions behind the last `candidates` (default 3) bot messages in the timeline. That is one message per session, only sessions with a record, and the newest message of each.

**One request per candidate**, in parallel, each with its own state and its own question. Packing several records into one request would only make each answer harder, with no saving: the cost is the context either way, and parallel requests take less prefill time. The saving comes from packing different *questions* over the *same* context, never the same question over different contexts. Routing (request + recent chat) is a different context and is a separate request in the same parallel batch.

**State, shaped so as not to imply a relationship that is not known:**

- Reply: `{ request: { from, text, attachments? }, reply_to: { from: "<bot>", text }, record }`.
- Not a reply: `{ request, recent_chat: [ { from, text, self? } ... ], record }`. The record's bot message appears where it actually sat in `recent_chat`, not as a reply target. The request is never presented as addressed to that message.

**Question** (same in both cases): `relevant`, `noul`: "`request` asks about, refers to, or continues the work described in `record`."

**Verdict.** Inject the records with `relevant ≥ inject_threshold` (default 0.6), highest first, at most `max_injected` (default 2). A reply's own record below threshold is not injected: the model judged that the reply does not need it ("find another one, of something else").

**Fallback** on any failure or point off: the 6.1 rule.

**Capacity.** One trigger can make up to `candidates + 1` decision requests at once (records plus routing). The decision models' rate-limit groups need `max_in_flight` above that (today the per-model default is 2), and so does the gateway lane in front of them. These are deployment settings; the spec requires only that they are sized for it.

## 7. Resume

**Off by default** once records ship (`[agent.sessions.resume].enabled` false in `00-defaults.toml`). The code stays.

The principled way back, for genuinely iterative work, is the session **declaring itself resumable**. That would be an automated end-of-session prompt rather than an implicit flag on the last `send_message`, so the decision is made with full context and never conflicts with record injection later. Models tend to treat every agentic session as resumable, so the prompt would need to explain the trade-off well. Not part of this work: records cover most of it, and asking every session would cost a turn that is rarely needed.

The continuation point of DECISION-MODEL §5.2 is **removed** (`[decisions.continuation]`, `tryContinuation`, `offerUntriggeredContinuation`, the `decided` gate mode). `tryReplyResume` returns to exactly its pre-continuation form for deployments that keep resume on.

## 8. Visibility

Every decision-model decision is recorded and inspectable. This applies to all points, not only this one, and replaces "logged only" (ARCHITECTURE.md §8h step 5).

- New table `decision_evaluations(id, ts, point, agent, timeline_key, agent_session_id?, trigger_event_id?, candidate_session_id?, source, reason?, verdict_json, answers_json /* with probabilities */, served_model, served_version, latency_ms, input_tokens, cost_usd)`. One row per evaluation request.
- Console, session view: a **Decisions** card listing the evaluations that shaped the session:
  - routing: the task with its confidence, why it fell back, the skills preloaded;
  - records: each candidate with its probability, whether it was injected;
  - the synthetic calls they produced, marked as harness-made in the transcript.
- Console, room view: the evaluations not bound to a session.
- Console, session view: the session's record (if any), and the records it was given.

## 9. Not in scope here

- **Untriggered messages.** Judging messages that do not `@` the bot is general model-driven triggering (presence, DECISION-MODEL §5.3). It makes sense only if done consistently, not limited to resuming sessions.
- **Trigger edits, the hold, folding, interjection.** A separate revision, because it is the same family of "which unit of work does this message belong to?" on short time scales. Owner direction for it, recorded here:
  - **Edits.** An edit of a trigger message is the strongest, least ambiguous correction: the original trigger was wrong. Appending a correction can confuse the model or be pointless. The right response is to **redo** the session with the corrected trigger.
  - **Redo.** A new concept: interrupt the running LLM request and rerun it with the corrected context. It applies to edits and also to late additions (follow-up folding) that should have been part of the trigger.
  - **Interjection as fallback.** It applies only once the session has called a tool that is not on a redo whitelist. `send_message` is not on it: sending is irreversible, and correcting with a new message after seeing the interjection is natural.
  - **Cost.** A redo wastes the cancelled request. Cache writes are the big cost and likely stay hot for the redo; making sure they do is a primary concern.
  - **Console.** It must make redone sessions understandable.
  - **Decision model.** Not required for edits (an unambiguous signal), but useful: a typo fix that would not confuse a model needs no redo; the next session sees the edited text anyway.

## 10. Configuration (sketch)

```toml
[session_records]
enabled = false          # write records for work-gated sessions
max_tokens = 1500
inject_on_reply = true   # the 6.1 default rule
inject_wait_ms = 15000   # wait on an in-flight record before giving up injecting it

[decisions.records]      # the 6.2 point; needs [decisions] enabled
enabled = false
candidates = 3
inject_threshold = 0.6
max_injected = 2
```

## 11. Risks and open points

- **Distillation classifiers** (owner concern). A provider may flag prompts that extract a model's reasoning. Mitigation: the record prompt asks for a handoff note (what, where, one-line why), never for reasoning. Verify with real sessions through the relay before enabling.
- **Records that miss what is later asked.** The prompt's purpose statement and the message anchoring are the defence, and `read_session_transcript` is the backstop.
- **Cost.** One extra turn per work-gated session: a cache read of the rollout plus a capped output. Small next to the session itself, but unconditional for those sessions.
- **Bias in the non-reply state** (§6.2): the shaping above is the best guess; the evaluations table makes it checkable.
