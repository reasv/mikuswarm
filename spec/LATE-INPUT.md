# Late input: trigger edits, late additions, redo and revival

**Status**: PROPOSAL, revision 1 (2026-10-07, from the owner design discussion of the same day). Not implemented.
**Realizes**: spec/SESSION-RECORDS.md §9 "Trigger edits, the hold, folding, interjection" (the owner direction recorded there).
**Supersedes**: the settled branch of follow-up folding as shipped by SESSION-RECORDS §7 (`foldAfterSettle`: a fresh session with the owner's record). See §5.5.
**Amends**: spec/FOLLOWUP-FOLDING.md (delivery while running, §5.2), the trigger hold (ARCHITECTURE.md §6, §7), the tool side-effect list (`src/tools/side-effects.ts`, REFUSAL-HANDLING §8.4), the branch reasons of REFUSAL-HANDLING §9.
**Adds**: a decision point, `implicit_reply` (§6).
**Target ARCHITECTURE.md home once implemented**: §8 (a new "Late input" subsection beside "Follow-up folding" and "Message steering"), §8j "Redo and branches", §8i "Resume and folding", §6/§7 "Trigger hold", §8h (the new point), §10 "Output-gated tools", §11 (console).
**Related**: SESSION-RECORDS, FOLLOWUP-FOLDING, REFUSAL-HANDLING, DECISION-MODEL, RESUMABLE-SESSIONS, DUPLICATE-REPLY-MITIGATION.

## 1. Problem

A user's request does not always arrive as one finished message. People fix a typo in the message that triggered the bot, send the picture after the question, add "in Celsius please" a few seconds later, or answer the bot's reply without using the reply button. Today:

- **An edit of a trigger message never reaches the session.** `handleInbound` applies the edit to the stored row and returns (ARCHITECTURE.md §7 "Message edits"). A running session answers the uncorrected text; the next session sees the corrected one.
- **A late addition reaches a running session only as an interjection**, delivered at the next turn boundary, and only within the quick fold windows (FOLLOWUP-FOLDING §4). By then the model may already be writing the answer to the incomplete request, and `send_message` is irreversible.
- **The trigger hold** (2 s by default on Matrix) is the only mechanism that lets a request be completed *before* the model sees it. It must stay short because it delays every trigger while the bot does nothing.
- **A follow-up that arrives after the session settled** starts a fresh session with the owner's record (`foldAfterSettle`), even when the user sent it before they could have seen the reply. A new session for something that was casually part of the current one is the wrong unit of work.
- **A message that answers the bot's reply without an explicit reply or mention** is inert in a group.

## 2. Principles (owner decisions, 2026-10-07)

1. **Causality decides which unit of work a message belongs to**, not arrival time. A message the sender wrote *before they could see the bot's response* is part of the request it followed. A message written *after* is a reaction to the response.
2. **An edit of a trigger-group message is an unambiguous correction.** No decision model judges it.
3. **Redo from scratch when nothing irreversible has happened yet; otherwise interject.** A redo discards the session's work and runs it again with the corrected input, re-running routing (task classification, skill preloads, model) and record selection. Once an irreversible effect exists, the session continues with an interjection.
4. **Wait at the first irreversible tool call, not before launch.** The session starts work at once; its first irreversible call (a send included) is held until a deadline measured from the trigger's arrival. The wait runs in parallel with the model's work (speculative execution) and is usually already over when the call is made.
5. **After an irreversible effect, abort the in-flight generation and deliver the interjection immediately**, rather than at the next turn boundary.
6. **Revival is a delivery fix.** A settled session is revived by a message only when that message would have reached it as an interjection had it arrived instantly. Revival reverses the record turn, which is never irreversible.
7. **A later trigger never resumes a session.** Records (SESSION-RECORDS) carry work across sessions; reply-to-continue stays off by default.
8. **An edit made after the reply does nothing** beyond updating the stored message. A new session for it would be excessive.
9. **A message that replies to a specific recent bot message without an explicit reply** is its own decision point (§6), anchored to that message, open to any human sender, default off. It is not presence (DECISION-MODEL §5.3).
10. **Effect classes**: the side-effect list gains *repeatable* and *undoable* beside *redo-safe* and *irreversible* (§4.1).

## 3. Measurements

Measured on a production deployment over 30 days (about 5,800 completed triggered chat sessions; Matrix and Discord; content-free aggregates). They size the windows and justify the cost model; another deployment should measure its own before tuning.

| quantity | p10 | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|
| launch delay (session start − trigger send time; includes the 2 s hold) | 0.3 s | 3.3 s | 4.2 s | 5.3 s | 7.7 s |
| first irreversible call issued (≈ first delivery − 0.7 s for sends) | ≈ 9 s | ≈ 11.5 s | ≈ 15 s | ≈ 21 s | ≈ 35 s |
| first delivered bot message | 10.0 s | 12.2 s | 16.0 s | 23.7 s | 41.6 s |
| run end | 10.5 s | 12.7 s | 16.8 s | 26.2 s | 65 s |
| trigger-group edit, delay after the trigger | 3.7 s | 7.7 s | 11.7 s | 23.2 s | 117 s |
| arrival lag (received − sent), all user messages | | | 1.6 s | | 4.1 s (p99 93 s) |

- **Session shape**: 76% of sessions make exactly one real tool call, a posting call; 69% make one LLM request. The first irreversible call is a post in 88% of sessions.
- **Trigger-group edits**: 1.1% of sessions. 48 of 66 landed before the first irreversible call (redo possible without any hold), 3 between it and the run end, 15 after the run end.
- **Same-sender messages sent while the session ran**: about 4% of sessions. In groups, bare text sent before the first delivery (235 in 30 days) mostly falls *outside* today's 7 s text fold window (177 at a gap of 10 s or more), so the session never sees it.
- **Revival cases** (sent before the run end, arrived after it): 36 in 30 days, about 0.6% of sessions.
- **Implicit-reply pre-gate volume** (§6: group messages within three messages and 120 s after a bot message, with no reply, mention or trigger of their own): about 100 per day (max 237), against about 180 bot messages per day in groups.

**Cache probes** (Anthropic Messages and OpenAI Responses on Bedrock with explicit breakpoints, through a gateway; a 47k-token synthetic prefix, breakpoints in the shape of ARCHITECTURE.md "Cache control"):

| case | redo request |
|---|---|
| first request completed, redo with an edited final turn | reads the whole prefix up to breakpoint (c) (45.7k of 46.9k on Anthropic, 26.5k of 27.3k on Bedrock) |
| first request aborted right after its first stream event (`message_start` / `response.created`) | same: the cache entry was written |
| first request aborted 0.3 s after sending, before any byte | **no hit**: the redo writes the whole prefix again |
| redo with one extra history item before the final turn | reads the prefix (Anthropic lookback) |

The gateway logged the 0.3 s abort as "usage still recorded": the aborted request is billed, but the redo was sent before its prefill finished. Hence the abort rule of §4.3.

## 4. Primitives

### 4.1 Effect classes

`toolEffect(name, args)` returns one of four classes:

| class | meaning | redo-from-scratch | examples |
|---|---|---|---|
| `redo_safe` | no external effect | allowed; result may be replayed (§4.3) | reads, searches, fetches, `load_skill`, `no_reply` |
| `repeatable` | no effect anyone else sees, but repeating it costs money or time | allowed; result replayed when the same call recurs | `image_generate`, starting `exa_research` |
| `undoable` | visible, with a compensating action | allowed after the compensation succeeds | `react` (remove the reaction), `pins` pin/unpin |
| `irreversible` | anything else | not allowed | posts and edits of messages, deletes, workspace and memory writes, `bash`, browser actions, session spawning and delegation |

The fork point of REFUSAL-HANDLING §8.4 treats `repeatable` and `undoable` as irreversible unless it compensates (its sibling-edit logic is unchanged); the classes matter to the redo-from-scratch and the hold.

**Audit** (part of the work). Every tool factory is reviewed and `test/side-effects.test.ts` keeps the list complete. Known corrections:

- `str_replace_based_edit_tool` with `command = "view"` is `redo_safe` (args-refined, like `pins` with `action = "list"`).
- `browser` is classified per action: navigation, snapshots, screenshots and reads are `redo_safe`; clicks, typing, form submission, uploads and downloads are `irreversible`.
- **MCP tools** honour the server's tool annotations (MCP `ToolAnnotations`): `readOnlyHint: true` → `redo_safe`; `idempotentHint: true` with `destructiveHint: false` → `repeatable`; anything else, or no annotations, → `irreversible`. A per-server override in config (`[mcp.servers.<name>].effects = { <tool> = "redo_safe" }`) lets an operator correct a server that does not annotate. The MCP client must keep the annotations from `tools/list`; today it drops them.

A more precise list moves the first irreversible call later, which gives the hold (§4.2) more time and makes a redo from scratch possible more often.

### 4.2 The irreversibility hold

The first `irreversible` call of a chat-lane session (or an `undoable` one, whose compensation is avoided by holding it) is held until the **hold deadline**: `trigger received_at + hold_ms`, extended by `extend_ms` each time a correction (§5) arrives, bounded at `received_at + max_hold_ms`.

- Measured from the trigger's *arrival* (the harness clock), so no cross-server clock is involved.
- A call made after the deadline is not held. Only calls made before it wait, and only for the remainder: with the measured distribution and `hold_ms = 8000`, fewer than one session in ten waits at all, and those wait a few seconds at most.
- A correction arriving while a call is held cancels the held call and redoes (§4.3).
- It composes with the output gate (REFUSAL-HANDLING §6): both waits run in parallel; the call proceeds when both have cleared.
- The user sees the typing indicator during the wait, as during generation.
- Proactive and synthetic sessions are never held. A session whose trigger has no human sender (a bot-chain trigger) is never held.

**The trigger hold** (ARCHITECTURE.md §6) becomes a cost optimization only: with redo in place, a part that arrives after launch is no longer lost or answered half, it costs one redo. Whether to reduce it, and to what, is an owner decision (§11). Measured (§3 deployment, 30 days): the 2 s Matrix hold grouped parts into 53 of 5,905 sessions (0.9%); of the 70 grouped parts, 45 arrived within 250 ms of the trigger, 49 within 500 ms, 56 within 1 s, 66 within 2 s. A 250–500 ms hold would still group most of them; the rest, about 20 a month, would each cost a redo, against the hold's delay on every trigger.

### 4.3 Redo from scratch

A redo replaces the session's rollout with a fresh one built from the corrected trigger group:

1. **Abort** the in-flight request and any running `redo_safe` tool. **Abort rule**: if the in-flight request has not yet produced its first stream event, the redo's first request is not sent until that event arrives or the request fails (bounded by `first_event_wait_ms`). A request aborted before its first event has not written its prompt to the cache, and is billed anyway on transports that do not propagate the cancellation (§3). Undoable effects are compensated.
2. **Branch**: the discarded span becomes an `agent_session_branches` row with `reason = "edit_redo"` or `"addition_redo"`, forked at index 0 (the whole rollout, including the harness injections of the old kickoff). The session id, claim, payee and typing indicator are unchanged.
3. **Rebuild** the context against the **original build's timeline cutoff** with the correction applied: the edited body replaces the old one; a late addition joins the trigger group. Messages from other senders that arrived meanwhile are not pulled in; they reach the session as they would any running session. This keeps the prefix byte-identical to the first build up to breakpoint (c), which the cost model depends on. The runtime state (current time, active sessions) is recomputed; it lives in the final user turn, after the cached prefix.
4. **Re-run routing and record planning** on the corrected trigger: the task may change, so may skill preloads, tail files and the routed model. A changed model loses the cache; that cost is accepted.
5. **Replay**: a `redo_safe` or `repeatable` call whose name and canonical arguments match a call in any discarded span of the same session (whatever discarded it: an edit or addition redo, a refusal or contract redo, a revival fork) returns the stored result without executing, within `replay_max_age_ms`. A redo that issues the same search pays nothing for it. Calls on the live branch are never replayed: their results are already in context, and answering a repeated live call from a stored result would be duplicate-call dedup, a different feature.
6. The hold deadline is extended (§4.2), and the run continues.

**Cost.** With the cache rule above, a redo costs about one extra request: a cache read of the prefix, a cache write of the last timeline batch and the final user turn, and the output the aborted request produced before the abort (thinking tokens included).

**Bounds.** At most `max_redos` (default 3) per session; further corrections become interjections. A redo is never done after an irreversible effect.

### 4.4 Abort and interject

When a correction cannot redo (an irreversible effect exists) and the session is running:

- If a generation is in flight, abort it and deliver the interjection as the next user turn at once. The strongest reason is that the in-flight request may be writing the answer to the uncorrected request, ending in a `send_message` that cannot be taken back. The aborted output is lost; the prefix is a strict extension of the session's own last request, so the cache is warm.
- If a tool is executing, let it finish (a `redo_safe` one's result is still a fact) and deliver the interjection after it, aborting nothing.
- The interjection is appended; the session does not fork back to its last irreversible effect. Read results gathered since then stay.
- The interjection text names the correction (§5.1, §5.2).

The abort is a new runner primitive beside `interrupt`: `abortTurnAndSteer(message)` aborts the current LLM call without ending the run, discards the partial assistant message (it is recorded as an aborted attempt for statistics), and continues with the steered message. It follows the same first-event rule as §4.3.

### 4.5 Revival

A session's life after it starts: **running → run ended → record turn → record written → closed**. "Settled" for this spec means *run ended*: the last assistant turn with no pending calls, before the record turn.

A message revives a settled session when:

- it would have been delivered to the session as an interjection (a fold, a reply-steer or an edit interjection under §5) had it arrived while the session was running; and
- its **send time precedes the run end**. On Matrix and Discord the send time is the server timestamp; transports without one (IRC without `server-time`) never revive. A tolerance `skew_tolerance_ms` (default 0) absorbs federation clock skew; a skew error only means the agent receives an interjection it then judges.
- the run ended no more than `revive_max_ms` ago (a staleness bound, sized from the arrival-lag tail).

Mechanics:

- **Record turn in flight**: abort it; fork at its start (branch reason `revival`).
- **Record written**: fork at the record turn's start; the record row is superseded when the next record is written (rows are already replaced per generation, SESSION-RECORDS §3.4). A session that read the old record meanwhile keeps a valid snapshot.
- **Agent evicted**: rehydrate from the persisted transcript with the resume machinery (`loadCompletedSessionMaterial`, `resumeContinuation`), without the work gate (FOLLOWUP-FOLDING §5.3's reasoning), and with the generation CAS for single consumption.
- The interjection is delivered as a new turn and the run continues; the record turn runs again at its new end.
- Interjection text says why it arrived late: *"{sender} sent this before your reply reached them."* The agent sends an addendum or a correction, or calls `no_reply`.
- A trigger-bearing message that revives (a re-`@` sent before the reply) does not also start its own session.

## 5. Inputs

### 5.1 Trigger edits

The edited message is the trigger or any message of its trigger group, edited by its own sender (edits by anyone else are content updates only).

| when the edit arrives | action |
|---|---|
| before launch (during the trigger hold) | none needed: the build reads the stored, edited body |
| running, no irreversible effect | redo from scratch (§4.3) |
| running, after an irreversible effect | abort and interject (§4.4): *"{sender} edited the message you are answering. Before: … After: …"* |
| run ended, edit sent before the run end | revival with the same interjection |
| edit sent after the run end | nothing (the stored message is updated, as today) |

A **no-op filter** skips the redo when the normalized text and attachments are unchanged (formatting-only or mention-only edits). No decision model.

### 5.2 Late additions

A late addition is a same-sender message that the follow-up fold accepts (FOLLOWUP-FOLDING §4: the media, text and mention levers). While running, before any irreversible effect, it **redoes** with the addition joined to the trigger group, instead of being steered. After an irreversible effect it is interjected (§4.4), with the fold's interjection texts. After the run end it revives (§4.5) when sent before the run end.

The quick fold windows remain the mechanical rule. Same-sender bare messages sent while the session runs but outside the windows are common (§3); whether they belong to the request is ambiguous, unlike an edit. Open question 1 (§11) is whether a decision model judges them. If it does, it is asked **when the message arrives**, in parallel with the model's work, so its latency hides inside the hold window; the held call waits for the verdict only if it is still pending at the deadline.

### 5.3 After the reply

Messages sent after the run end are reactions to the response:

- an edit: nothing (§2.8);
- a trigger (`@`, explicit reply, DM): a fresh session, with records injected as today;
- a bare group message: the implicit-reply point (§6), or inert when it is off.

### 5.4 Precedence

A message reaches exactly one destination: trigger hold grouping, then redo, then interjection, then revival, then native fate. A message consumed by a redo or a revival is marked in `steeredEventIds`, so its post-hold twin is suppressed as today. When a newer session from the same sender exists, a revival-eligible message still revives the older session (causality, §2.1).

### 5.5 What changes for follow-up folding

- `foldAfterSettle` is removed. A follow-up whose owner has settled either revives it (sent before the run end) or takes its native fate.
- Steering while running is replaced by redo when no irreversible effect exists, and by abort-and-interject otherwise.
- Parking (owner not yet live) is unchanged: the parked message is drained into the first build as part of the trigger group, which needs no redo.

## 6. Decision point: `implicit_reply`

**Purpose.** Decide whether a group message *replies to a specific recent bot message M* without using the reply function or a mention. A "yes" turns it into what an explicit reply to M would have been.

**Mechanical pre-gate** (no call otherwise):

- group timeline; the message is from a human (never another agent, so the bot-chain cap cannot be bypassed), carries no reply, mention or trigger of its own, and is not consumed by §5;
- it was sent after M and within `max_messages_after` (default 3) messages and `max_age_ms` (default 120 s) of it, with no later bot message in between;
- M belongs to this agent;
- any sender, not only M's requester (the classifier decides).

**State**: the records point's non-reply framing (ARCHITECTURE.md §8h "Records"): recent chat as a continuous suffix with M marked `bot_message: true`, ages precomputed, then the candidate. Nothing implies a relationship that is not known. When several bot messages are in range, one request per candidate, like the records point.

**Question**: `replies`, `noul`: "`message` responds to `bot_message`: it answers it, reacts to it, or asks about it."

**Verdict**: `replies ≥ threshold` (default high, 0.8) synthesizes a `reply` trigger with M as the reply target. Everything downstream is the normal reply path: claims, a fresh session, M's session record injected by the default rule or the records point, billing to the sender. Below threshold, or on any failure: inert, as today. No heuristic rung.

**Model chain**: its own `[decisions.implicit_reply].model`; reply-to detection benefits from a member strong at it, which need not be the routing head.

**Config**: `[decisions.implicit_reply]` with `enabled = false`, `threshold`, `max_messages_after`, `max_age_ms`, per-agent overrides as for every point.

## 7. Storage, console, logs

- Branch reasons gain `edit_redo`, `addition_redo` and `revival`; the console branch switcher (REFUSAL-HANDLING §12.1) shows them with the correcting message.
- `agent_sessions` gains `redo_count`; `session_interjections.kind` gains `edit` and `revival`.
- Held calls are recorded on the tool call (held ms, reason) and shown on its card; aborted turns are recorded like other discarded attempts.
- The implicit-reply point writes `decision_evaluations` rows like every point.
- Logs: `late_input_redo`, `late_input_interjected`, `late_input_revived`, `late_input_ignored {reason}`, `irreversible_hold {ms}`, `turn_aborted_for_interjection`, `redo_replayed_call`, `implicit_reply_evaluated`.

## 8. Configuration (sketch)

```toml
[agent.sessions.late_input]
enabled = true
hold_ms = 8000             # hold the first irreversible call until trigger arrival + this
extend_ms = 4000           # each correction extends the deadline
max_hold_ms = 20000        # absolute bound from trigger arrival
max_redos = 3
first_event_wait_ms = 10000
replay_max_age_ms = 300000
revive_max_ms = 300000
skew_tolerance_ms = 0

[decisions.implicit_reply]
enabled = false
threshold = 0.8
max_messages_after = 3
max_age_ms = 120000
```

## 9. Testing

- **Cache, the primary risk**: a test that builds the first and the redo context for an edited trigger and asserts byte-identity of the serialized payload up to breakpoint (c) on each wire API; a live probe script (like §3) that checks `cache_read` on the redo for each configured provider, including the abort-before-first-event rule.
- Redo: edit before the first irreversible call → one branch, routing re-run, the trigger body corrected, the hold extended; replayed calls are not executed.
- Hold: a call before the deadline waits for the remainder only; after it, no wait; a correction during the wait cancels the call and redoes.
- Abort and interject: in-flight generation aborted, interjection next, cache prefix intact; executing tool not aborted.
- Revival: record turn in flight / written / agent evicted; sent before vs after the run end; skew tolerance; single consumption against a racing trigger.
- Effect classes: every tool factory classified; MCP annotations mapping and the per-server override.
- Implicit reply: pre-gate bounds; reply framing never implied; a yes behaves exactly like an explicit reply.

## 10. Phasing

1. **Effect classes and the audit** (§4.1), MCP annotations. Standalone; improves the refusal fork point too.
2. **Edits**: redo from scratch with the rebuild-at-cutoff and the abort rule (§4.3), edit interjections (§4.4), the cache tests.
3. **The irreversibility hold** (§4.2), then the trigger-hold change if the owner decides one (§11).
4. **Late additions as redo** (§5.2) and abort-and-interject for folds.
5. **Revival** (§4.5), removing `foldAfterSettle`.
6. **`implicit_reply`** (§6).

## 11. Open questions

1. **Same-sender messages outside the quick fold windows.** A bare message from the trigger's sender, sent while the session runs and before its first delivery but outside the fold's user-gap windows (text 7 s, media 10 s, mention 5 s), is ignored today: inert in a group, never seen by the session. Example: `@bot weather in Paris`, then 15 s later `for tomorrow`. These are common (§3: most such group texts come 10–60 s after the trigger). Causality says they cannot be reactions to the reply, but not that they belong to the request; the sender may be talking to someone else. What decides membership: the fixed windows (today), mechanically wider windows (for example any same-sender message until the first delivery), or a decision model asked the moment the message arrives, in parallel with the model's work?
2. **The trigger hold**: keep 2 s, reduce it (the data in §4.2 suggests 250–500 ms keeps most grouping), or remove it.
3. `hold_ms`, `extend_ms`, `revive_max_ms` defaults beyond the first measurement (§3).
