# Late input: trigger edits, late additions, redo and revival

**Status**: IMPLEMENTED 2026-10-07, superseded by ARCHITECTURE.md §8 "Late input" (with §8h, §8b, §8j, §10, §11); retained for review. Implementation notes: revival works within the in-memory window only (a session evicted by a restart is not rehydrated); Matrix message redactions are routed like Discord deletions (since 2026-10-08; only the sender's own redaction withdraws a request); an implicit-reply verdict is recorded as the reply context of the message. The 2026-10-08 adversarial review's findings were fixed (ARCHITECTURE.md §8 "Late input" describes the result).
**Realizes**: spec/SESSION-RECORDS.md §9 "Trigger edits, the hold, folding, interjection" (the owner direction recorded there).
**Supersedes**: the settled branch of follow-up folding as shipped by SESSION-RECORDS §7 (`foldAfterSettle`: a fresh session with the owner's record). See §5.5.
**Amends**: spec/FOLLOWUP-FOLDING.md (delivery while running, §5.2), the trigger hold (ARCHITECTURE.md §6, §7), the tool side-effect list (`src/tools/side-effects.ts`, REFUSAL-HANDLING §8.4), the branch reasons of REFUSAL-HANDLING §9.
**Adds**: two decision points, `late_addition` (§5.2) and `implicit_reply` (§6), and builds the vision decision chain of DECISION-MODEL §3.5 for the first of them.
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

`toolEffect(name, args)` returns one of four classes: `redo_safe` and `repeatable` behave the same for a redo from scratch and the hold; the distinction matters only to the refusal fork point (below), which must not discard a `repeatable` effect. A paid read (`web_search`, `x_search`) stays `redo_safe`: its cost is covered by replay.

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

**The trigger hold** (ARCHITECTURE.md §6) becomes a cost optimization only: with redo in place, a part that arrives after launch is no longer lost or answered half, it costs one redo. It is reduced to **at most 500 ms**, proposed default 250 ms (owner: 500 ms is already generous). Measured (§3 deployment, 30 days): the 2 s Matrix hold grouped parts into 53 of 5,905 sessions (0.9%); of the 70 grouped parts, 45 arrived within 250 ms of the trigger, 49 within 500 ms, 56 within 1 s, 66 within 2 s. A 250–500 ms hold would still group most of them; the rest, about 20 a month, would each cost a redo, against the hold's delay on every trigger.

### 4.3 Redo from scratch

A redo replaces the session's rollout with a fresh one built from the corrected trigger group:

1. **Abort** the in-flight request and any running `redo_safe` tool. **Abort rule**: if the in-flight request has not yet produced its first stream event, the redo's first request is not sent until that event arrives or the request fails (bounded by `first_event_wait_ms`). A request aborted before its first event has not written its prompt to the cache, and is billed anyway on transports that do not propagate the cancellation (§3). Undoable effects are compensated.
2. **Branch**: the discarded span becomes an `agent_session_branches` row with `reason = "edit_redo"` or `"addition_redo"`, forked at index 0 (the whole rollout, including the harness injections of the old kickoff). The session id, claim, payee and typing indicator are unchanged.
3. **Rebuild** the context against the **original build's timeline cutoff** with the correction applied: the edited body replaces the old one; a late addition joins the trigger group. Messages from other senders that arrived meanwhile are not pulled in; they reach the session as they would any running session. Interjections already delivered in the discarded span (another sender's fold or steer) are not lost with it: they are delivered again after the rebuild, as pending interjections. This keeps the prefix byte-identical to the first build up to breakpoint (c), which the cost model depends on. The runtime state (current time, active sessions) is recomputed; it lives in the final user turn, after the cached prefix.
4. **Re-run routing and record planning** on the corrected trigger: the task may change, so may skill preloads, tail files and the routed model. A changed model loses the cache; that cost is accepted.
5. **Replay**: the session keeps, per call key (tool name + canonical arguments), the latest result of every `redo_safe` or `repeatable` call it executed, on any branch. A call is served from this store only when **no call with the same key has been served earlier on the current lineage** (the live branch from the session start to this point); otherwise it executes fresh, because an agent that asks again within one line of work wants a new value. So only results from discarded spans are ever replayed (whatever discarded them: an edit or addition redo, a refusal or contract redo, a revival fork), and each at most once per lineage. A later fork that discards the call which consumed a replay frees the entry for the new branch.
   - An entry is never removed on use. It is replaced only when a fresh execution of the same key produces a newer value, and dropped when it is older than `replay_max_age_ms`. Removing it earlier could discard a result a later branch needs.
   - A redo that issues the same search pays nothing for it.
6. The hold deadline is extended (§4.2), and the run continues.

**Cost.** With the cache rule above, a redo costs about one extra request: a cache read of the prefix, a cache write of the last timeline batch and the final user turn, and the output the aborted request produced before the abort (thinking tokens included).

**Bounds.** At most `max_redos` (default 3) per session; further corrections become interjections. A redo is never done after an irreversible effect.

**Correction storms.** A redo builds from the latest stored state; corrections arriving while it waits for the aborted request's first event join it instead of starting another.

**Built but not running.** A session that has built its context but not yet sent its first request (waiting for scheduler admission) is rebuilt in place, with no branch: nothing was generated.

**Refusal pin.** A redo from scratch drops a refusal pin (REFUSAL-HANDLING §8.3): it re-runs routing anyway, and the refused content is what changed. Every other continuation (an interjection, a revival, a refusal or contract redo) keeps the session on its current model. Switching models mid-session after one model has done part of the work is never done for a correction, and a small edit is unlikely to avoid a refusal.

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

The edited message is the trigger or any message of its trigger group, edited by its own sender, who is a human (edits by anyone else, and every edit by another bot, are content updates only: bots that stream by editing would otherwise redo and interject on every edit).

| when the edit arrives | action |
|---|---|
| before launch (during the trigger hold) | none needed: the build reads the stored, edited body |
| running, no irreversible effect | redo from scratch (§4.3) |
| running, after an irreversible effect | abort and interject (§4.4): *"{sender} edited the message you are answering. Before: … After: …"* |
| run ended, edit sent before the run end | revival with the same interjection |
| edit sent after the run end | nothing (the stored message is updated, as today) |

A **no-op filter** skips the redo when the normalized text and attachments are unchanged (formatting-only edits). No decision model.

**Deletions and edits that change addressing.** A deletion (a Matrix redaction, a Discord delete) reaches `handleInbound` through the edit path as a tombstone, and must not be treated as an edit to an empty message. The action is keyed on the session's state, never on whether a message was already sent:

| | trigger deleted | mention of the bot removed from the trigger | grouped part deleted |
|---|---|---|---|
| running, no irreversible effect | cancel: abort, discard, no message, no notice | cancel | redo without it |
| running, after an irreversible effect (an intermediate message included) | interject "{sender} deleted the message you are answering" | interject the correction (before/after) | interject |
| run ended, sent before the run end | revival with the same interjection | revival with the interjection | revival with the interjection |
| sent after the run end | nothing | nothing | nothing |

An edit that **adds** a mention of the bot to a recent message triggers, as the original would have, within `candidate_window_ms` of the original send.

### 5.2 Late additions

A message cannot be folded into a request just because its sender wrote it soon after: it may be about anything, or addressed to someone else. The quick fold windows are a heuristic that catches only what is very likely a follow-up. This spec separates **eligibility** (which messages are considered at all) from **membership** (which of them belong to the request).

**Eligible** (owner direction): a message from the trigger's sender, in the trigger's timeline,

- sent after the trigger group closed and **before the session's first delivered message** (after that, messages are explicit or implicit replies, §5.3, a different mechanism and meaning);
- within `candidate_window_ms` of the trigger (time gate, default 60 s);
- that is not an explicit reply to someone else's message;
- up to `max_judged` candidates per session (default 8): a cost and noise bound on how many messages get a decision call at all.

At most `max_folded` messages (default 3) **join** the request per session, whatever admitted them (a judgement, the quick windows, or an explicit reply below); a rejected candidate does not use this budget. A decaying acceptance rule (accept fewer as time passes) was considered and is not adopted: the time gate and the hard limits already bound it.

**Explicit replies to the request always belong.** A reply from the trigger's sender to a message of the request (the trigger or a grouped part), sent while the session runs, is as unambiguous as an edit. It is the same case as replying to one of the session's own intermediate messages (reply-steer, ARCHITECTURE.md §8 "Message steering"). It skips eligibility and the decision model, with or without one: no time gate, no judgement. It redoes or is interjected like any late addition, counts toward `max_folded`, and never starts a parallel session. Today it matches no route (reply-steer resolves only bot messages, which carry the session id; the fold skips replies), so it is inert in a group and spawns a second session when it mentions the bot or is in a DM (§3: about one session in 300, median 107 s after the trigger).

Edits are not candidates (§5.1). A DM message or a re-`@` is eligible like any other; when it is judged not to belong, it takes its native fate (its own session).

**Membership** is judged by the `late_addition` decision point for every eligible message, **including those inside the quick fold windows** (no reason to exempt them). It is asked when the message arrives, in parallel with the model's work, so its latency hides inside the hold window (§4.2); the held call waits for a verdict still pending at the deadline, bounded by the point's timeout.

- **Where the signal is.** For a media candidate it is usually in the text around it, not in its contents: the request points at something it does not contain ("look at this", "what's this?", a question about a picture with none attached); whether the request already carries attachments; what others said in between and whether the conversation moved on; whether the sender was exchanging media with someone else just before the trigger; the gap. Attachment metadata alone (an image was posted) says nothing about what it relates to.
- **State**:
  ```json
  { "before":  [ { "from": "...", "text": "...", "age": "40s before" } ],          // ~5 messages before the trigger
    "request": { "from": "A", "text": "what breed is this?", "attachments": [] },
    "between": [ { "from": "B", "text": "...", "age": "6s after request" } ],
    "message": { "from": "A", "text": "", "attachments": [ { "kind": "image", "caption": null } ], "age": "12s after request" } }
  ```
  Attachments of the request and the candidate are listed with a caption only when one already exists: the judgement never waits for captioning. Nothing implies the candidate is addressed to the bot.
- **Question**: `belongs`, `noul`: "`message` supplies something `request` refers to or expects, or continues, corrects or adds to it, written by the same person for the same purpose."
- **Pixels.** A media candidate goes to the point's `vision_model` chain with its pixels when one is configured (DECISION-MODEL §3.5; decision members that read images, not one that answers from an image it cannot see), waiting only for the download, which the redo needs anyway. Without a vision member, the text-only state above is used; the case it cannot settle (a request complete on its own, followed by an image) leans to "no" through the threshold.
- **Verdict**: `belongs ≥ threshold` → a late addition. Below → not folded (inert in a group, native fate in a DM or for a re-`@`).
- **Fallback** (point off, no decision model, or a failed call): the quick fold windows of FOLLOWUP-FOLDING §4 decide, as today; the longer window only makes sense with a judgement.

**Readiness.** Only once a message is accepted and the session redoes does the rebuild wait for the accepted media's download and conditioning, bounded like the trigger's readiness wait, so the main model receives pixels; past the bound it proceeds with the attachment reference. No step waits for a caption.

A late addition redoes (§4.3) with the message joined to the trigger group when no irreversible effect exists; otherwise it is interjected (§4.4) with the fold's interjection texts. Sent before the run end but arrived after it, it revives the session (§4.5) when judged to belong.

### 5.3 After the reply

Messages sent after the run end are reactions to the response:

- an edit: nothing (§2.8);
- a trigger (`@`, explicit reply, DM): a fresh session, with records injected as today;
- a reply to a message of the request (the trigger or a grouped part): exactly a reply to the bot's message of that session. It always triggers, and the default record rule injects that session's record (the trigger message resolves to its session through `agent_sessions.trigger_external_id`);
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
- **Aborted requests are billed.** A stream aborted mid-way reports its input usage but not the output produced so far. The attempt is written to the ledger with output estimated from the streamed deltas (flagged `estimated`), and it counts against every applicable limit, per-user included.
- **Statistics.** Aborted turns and `edit_redo`/`addition_redo`/`revival` branches are their own outcome: excluded from send-contract failure rates (`deriveContractEvents`) and from model-behaviour misbehaviour counts (§8k rollups).
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

[decisions.late_addition]
enabled = false
threshold = 0.7
candidate_window_ms = 60000
max_judged = 8
max_folded = 3

[decisions.implicit_reply]
enabled = false
threshold = 0.8
max_messages_after = 3
max_age_ms = 120000
```

`[agent.sessions.late_input]` is global, like the rest of `[agent.sessions]` (which has no per-agent layer today); the two `[decisions.*]` points take per-agent overrides as every point does.

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
3. **The irreversibility hold** (§4.2) and the trigger-hold reduction, together (the hold only shrinks once redo and the irreversibility hold catch what it used to).
4. **Late additions**: the `late_addition` point with the vision decision chain (DECISION-MODEL §3.5: `vision_model`, per-point `vision` mode, image conditioning, labelled `image_url` parts in `state`, text-chain fallback; `late_addition` uses it for every media candidate, since none has a caption yet), redo and abort-and-interject for folds, explicit replies to the request.
5. **Revival** (§4.5), removing `foldAfterSettle`.
6. **`implicit_reply`** (§6).

## 11. Defaults to tune

Proposed, to be revisited with live data (§3): `hold_ms` 8 s, `extend_ms` 4 s, `max_hold_ms` 20 s, `revive_max_ms` 5 min, `candidate_window_ms` 60 s, `max_judged` 8, `max_folded` 3, `late_addition` threshold 0.7, `implicit_reply` threshold 0.8, trigger hold 250 ms (never above 500 ms), `max_redos` 3, `first_event_wait_ms` 10 s, `replay_max_age_ms` 5 min, `skew_tolerance_ms` 0. The hold, revival and trigger-hold values come from the measurements; the window, the limits and the thresholds are first guesses for calibration (DECISION-MODEL §3.6).
