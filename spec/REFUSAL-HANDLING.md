# Refusal handling, output checks and session redo

**Status**: PROPOSAL, revision 2 (2026-10-05). Revision 1 was the owner's direction of the same day; revision 2 folds in a review pass, the owner's answers to it, and the send-contract diagnostics and console design added by the owner. Remaining open questions are in §15.
**Builds on**: the shipped `refusal` error class (ARCHITECTURE.md §8a "Refusals"): hard refusals are recognized from the provider's stop reason, are never a health strike, are never retried on the member that refused, fall over to the next chain member, and log `llm_refusal`. The session-record turn opts out of that implicit fallover.
**Supersedes**:
- the "Refusal handling" direction in spec/SESSION-RECORDS.md §9, which this document expands;
- DECISION-MODEL §5.9 (style gate): the gate, its catalogue, its bounds and its override are specified here (§6);
- the refusal audit and the send-contract audit of DECISION-MODEL §5.8: their questions, storage and console are specified here (§7, §10, §12). The §5.8 audit worker remains the offline runner, used for history backfill and for diagnostics that need no live action.

**Amends DECISION-MODEL**:
- constraint 4 ("the decision model never hard-gates the agent"): outgoing messages are held until judged (with a fail-open deadline), and a refusal verdict discards the turn;
- constraint 5 ("no de-escalation of normal chat") and §8 ("no model switching mid-session"): a refusal redo switches the session to the rule's model for the rest of the session (§8.3). Style checks never switch models.

**Related**: SESSION-RECORDS (record turn §3.2, the redo concept of §9), DECISION-MODEL (decision points, judge-shaped state §3.8, audit worker §5.8, dedup §5.4), MODEL-FALLBACK, LLM-FAILURE-HANDLING, OPENAI-PREFILL (the `analysis` argument), MODEL-PROMPTS.

### What changed in revision 2

- One **check catalogue** (§4) covers refusal reasons, style issues and send-contract diagnostics, with three detection methods (API signals, patterns, decision-model questions) and three remedies (redo, revise, observe).
- **Owner decisions** recorded (§3): sticky redo, fork point, configurable exhaustion, max-probability verdicts, observe-only checks never hold a send, custom API-signal mappings, rules may match any reason including safety categories, a generic any-reason fallback.
- **Session endings without a send are checkpoints** (§5.4): `no_reply` (always judged) and forced-completion exhaustion, judged from the analysis argument, the text block and the thinking block.
- **Send-contract diagnostics** (§7): mechanical per-model statistics of forced completion, per-attempt failure types, decision-model diagnosis of what happened to the message, and one same-model redo after the nudges run out.
- **Branches** (§9) and the **console** (§12): rollouts stop being append-only; discarded branches are preserved and browsable with a branch switcher.
- Verified provider fields (§5.1), gated tool list (§6.1), redo mechanics (§8.4).

## 1. Problem

Two classes of output failure share one remedy.

**Refusals.** A model can decline work in two ways:

- **Hard refusals.** The API ends the request with a refusal stop reason (Anthropic `refusal`, a content filter, a provider guardrail). There is no usable output. The shipped `refusal` class handles these generically: every hard refusal is treated alike.
- **Soft refusals.** The model answers, but the answer declines, deflects or quietly does less than asked. Nothing in the API marks it. Some models (local ones, for example) never report a refusal stop reason at all.

Refusals differ by **reason**, and the right reaction depends on it. A refusal over distillation (reasoning extraction) is a property of the model and its vendor's policy, not of the request's legitimacy: another model can do the same work. Policies also differ between models of the same vendor; a provider may itself route a request refused by one of its models to another.

**Send-contract failures.** The most common agent failure is not a refusal: the agent writes its reply in its text block, or ends its turn with neither `send_message` nor `no_reply`. The runner then injects a corrective user turn (forced completion, ARCHITECTURE.md §8) up to `forced_completion_retries` times (default 3) and otherwise settles the session as `NO_REPLY`. Today this exists only in logs. Nobody can tell which models do it, how often, whether they recover, or what happens to the message when they do.

Today the code cannot tell refusal reasons apart, cannot see soft refusals, keeps no statistics beyond log lines, and its only recoveries are "next member of the same chain" (hard refusals, per request) and "nudge again" (send contract).

## 2. Goals

1. **Detection of many refusal types**, hard and soft, each classified by reason, with the taxonomy extensible by config.
2. **Statistics, always**: every detected refusal, every check verdict and every send-contract failure is recorded per model, reason or type, site and detection method, whether or not any remedy is configured.
3. **Rule-driven refusal fallback across the board**: chat-lane reply sessions, proactive sessions, the session-record turn, summarization/condense, diary, captioning.
4. **A correct redo**: discard output, fork the context from an earlier state, continue, and keep the discarded branch for inspection.
5. **Style enforcement** on outgoing messages, revised in place by the same agent and model.
6. **Send-contract diagnostics**, purely observational except for one same-model redo after the nudges run out (§7.5).
7. **A console** that shows branches, checks, verdicts and their consequences where they happened, plus per-model aggregates.
8. **No rule matches and no check enabled → today's behaviour.**

## 3. Owner decisions (2026-10-05)

1. **Redo is sticky.** After a refusal redo (soft, or a hard refusal handled by a rule) the rest of the session stays on the redo model. The next session starts on its normal model.
2. **Fork point**: the later of the last delivered message and the last irreversible tool effect (§8.4). Read-only work after it is discarded and redone by the new model.
3. **All rule entries exhausted in chat**: configurable; default send the last attempt (§8.2).
4. **Several questions per check**: the check's verdict is the **highest probability** among its questions, each compared against its own threshold.
5. **Observe-only checks never hold a send.** A check with no remedy configured runs alongside the send (§6.3).
6. **Custom API-signal mappings are allowed**, by matching raw stop-reason and category strings (§4.2).
7. **Rules may match any reason**, including safety categories (`cyber`, `bio`). Asking another permitted model, with the request unchanged, is not a bypass (§14); vendors already do this between their own models. A rule with no reason list is a **generic fallback for any refusal**.
8. **`no_reply` is not automatically a refusal**, but the text around it is judged (§5.4). It is rare enough to judge every time.
9. **Send-contract diagnostics are diagnostic**, with one behaviour change: after the nudges run out, one same-model redo with its own nudge budget, then give up (§7.5).
10. **Branches are preserved** and shown like conversation branches in chat interfaces: latest branch by default, a switcher at each fork point (§12).
11. **Endings without a send are judged in every session type**, proactive included: proactive sessions are where agents most often reason "I should say this" and then end with `NO_REPLY` (§5.4).
12. **Refusal rules can match on the session's routed task** (§8.1), as model routing already does.
13. **Send-contract give-up settles as `NO_REPLY`**, with no failure notice: unlike a quota, it is not actionable and not caused by the user's input (§7.5).
14. **One send-contract redo per failure point**, so per message, not per session: the bound exists to stop an endless loop, and a redo that succeeded once suggests the model will manage the next message of the same session (§7.5).
15. **The statistics page measures model behaviour** (performance in the machine-learning sense: refusals, the send contract, style), not provider reliability or speed. Gate latency and fail-open counts are operational and stay out of it (§12.3).
16. **"A model" is the config entry** by default, with a toggle to group by underlying model (§12.3).
17. **Change markers** on the trend charts: wanted (§12.4).
18. **The page is passive**: no alerts or notifications for now.
19. **Tasks are multi-label** (DECISION-MODEL §5.1a): a request may select several tasks, and some tasks exist only as labels.

## 4. Checks

A **check** is the unit of detection. Refusal reasons, style issues and send-contract diagnostics are all checks, defined in one catalogue, judged by the same machinery, recorded in the same statistics.

### 4.1 Definition

Each check has:

- a **unique code**: recorded in statistics, matched by rules, shown to the agent as the override value for revisable checks;
- a **description** (operators, console);
- its **kind**: `refusal`, `style`, or `contract`;
- its **remedy** (the default follows the kind; config may lower it to `observe`):
  - `redo`: discard and redo on another model through the refusal rules (§8). Refusal checks.
  - `revise`: block the action and return a tool error naming the check; the same agent revises (§6.4). Style checks and the `no_reply` contradiction check (§5.4).
  - `observe`: record only; never holds or blocks anything.
- for revisable checks, an **agent-facing explanation**, shown in the tool error next to the code;
- for refusal checks, its **reason** (built-in or operator-defined, §5.3);
- the **checkpoints** it applies to (§5): outgoing messages, endings without a send, artifacts, failed rollouts;
- its **detection metadata**, any combination of:
  - **API signals** (hard refusals): provider stop reasons and categories mapped to this code;
  - **patterns**: regular expressions over the judged text, free and synchronous, working when the decision chain is down (the regex layer of DECISION-MODEL §5.8);
  - **decision-model questions**: one or more `noul` questions.

### 4.2 Detection metadata

**API signals.** Every refusal signal the supported providers document is a built-in check with a built-in code (stop reasons, filter results, guardrail outcomes, refusal categories, §5.1). Config may add **custom mappings** by raw string match on `(api, stop_reason, category)`, because categories change faster than releases. An unknown category on a known refusal stop reason maps to a built-in uncategorized code and records the raw value.

**Several questions per check.** A check may carry several questions describing the same issue differently, or reading different sources (§5.5). All map to the same code. The verdict is the highest `noul` probability among them, each question compared against its own `threshold` (owner decision 4). A source that is often misleading (thinking, §5.4) gets a higher threshold.

**Patterns before questions.** A pattern hit decides the check without a model call; the check's questions are then not asked.

### 4.3 Built-in vs operator checks

Upstream ships the built-in API-signal catalogue, a built-in refusal taxonomy with questions, the send-contract diagnostics (§7), and a starter set of style checks. Operators add their own checks of any kind with their own codes, descriptions, explanations, patterns and questions, override a built-in's thresholds or remedy, and disable built-ins. Per-agent overrides follow the existing `[agents.<name>.…]` pattern.

### 4.4 Config sketch

```toml
[checks.refusal_distillation]
kind = "refusal"
reason = "distillation"
description = "Declined because the request looks like extracting the model's reasoning"
api_signals = [ { api = "anthropic-messages", stop_reason = "refusal", category = "reasoning_extraction" } ]

  [[checks.refusal_distillation.questions]]
  source = "message"          # message | analysis | text | thinking | artifact | rollout
  instructions = "The assistant declines to do what `request` asks because it would reveal or reproduce its own reasoning."
  criteria = { true = "...", false = "..." }
  threshold = 0.8

[checks.style_not_x_but_y]
kind = "style"
description = "Rhetorical 'not X, but Y' construction"
agent_explanation = "Uses a rhetorical 'not X, but Y' contrast. State the point directly."
patterns = []
  [[checks.style_not_x_but_y.questions]]
  source = "message"
  instructions = "The message uses this construction: a rhetorical contrast of the form 'not X, but Y'."
  criteria = { true = "<positive example>", false = "<a plain factual correction>" }
  threshold = 0.85
```

## 5. Detection and checkpoints

### 5.1 Hard refusals (structured)

- Provider stop reasons, as shipped: `refusal`, `sensitive`, `content_filter`, Responses `incomplete.content_filter`, Bedrock `content_filtered` / `guardrail_intervened`, Google `SAFETY` / `PROHIBITED_CONTENT` / `BLOCKLIST` / `SPII`.
- **Anthropic categories** (verified against `@anthropic-ai/sdk` 0.91.1): `stop_reason: "refusal"` comes with `stop_details: { type: "refusal", category: "cyber" | "bio" | null, explanation: string | null }`. `explanation` is documented as unstable and is never matched. Values outside the typed union are observed in practice (`reasoning_extraction`), so `category` is an open string.
- pi-ai's `mapStopReason` receives `stop_details` but keeps only `explanation`. The existing pi-ai patch (`patches/`) is extended to carry `category` onto the assistant message (beside `rawStopReason`) and to keep the request's `usage` on the refusal error, so refused attempts get a ledger row (§10.3).
- Each gateway or relay path in front of a provider must be verified to pass `stop_details` through; a path that drops it degrades to the uncategorized code.
- API signals are trusted positives only. Their absence proves nothing, so the judged checks run whether or not a signal fired.

### 5.2 Judged checks

Decision-model questions (DECISION-MODEL machinery) judge outputs at the checkpoints below. Each checkpoint has its own state builder (§5.5), deadline and evaluation row.

1. **Outgoing messages** (§6): every message-posting tool call, held until judged.
2. **Endings without a send** (§5.4): `no_reply`, a literal `NO_REPLY` text ending, forced-completion exhaustion.
3. **Internal tasks' artifacts**: the task's output judged against its instruction: a caption's text, a summary or diary draft at finalize, the session record.
4. **Internal tasks' failed rollouts**: today a summarization run with no summary takes the semantic path and is re-run from scratch, up to `max_retries` (ARCHITECTURE.md §9b). That redo becomes gated by a refusal check over the failed rollout: a judged refusal goes to the refusal rules (another model) instead of re-running the same model; no refusal keeps today's redo.

Artifact and rollout checks judge **declining and deflecting only**. "Did less than asked" cannot be judged for a summary without its source, which does not fit a decision model's state. Rollout checks send only the assistant-authored text of the last turns, never the source material.

### 5.3 Reasons

- Built-in taxonomy: distillation/reasoning extraction, safety/harm policy (with the provider categories as sub-reasons), privacy, copyright, persona/roleplay, capability ("can't do that"), unclear.
- **Operator-defined reasons**: refusal checks with an operator reason name. Rules match on them like built-ins.
- Every detection records its method (`stop_reason`, `provider_category`, `pattern`, `judged`), its probability where judged, and the source that fired.

### 5.4 Endings without a send

`no_reply` is not a refusal by itself, but a model can decline by staying silent, and the outgoing-message gate never sees it. So every ending without a send is a checkpoint:

- a `no_reply` call, or a literal `NO_REPLY` text ending;
- forced-completion exhaustion (the model wrote text and never called a send tool, §7).

`no_reply` is judged **every time** in every session type (rare enough, owner decision 8), **proactive sessions included** (owner decision 11): not replying is a normal proactive outcome, but proactive sessions are also where agents most often reason "I should say this" and then end with `NO_REPLY`, so their endings are exactly the ones worth judging. Holding it costs no visible latency (no message is coming), so its deadline is looser than a send's.

**Sources.** Three texts around the action, each its own state field so a question can point at one:

- **`analysis`**: the `analysis` argument of the call, on members with the OpenAI prefill (OPENAI-PREFILL). Closest to the action, usually states the intent; lowest threshold.
- **`text`**: the text block before the call. Middle threshold.
- **`thinking`**: the thinking block, when the provider exposes it (open models usually do, proprietary ones usually do not or summarize it). Models contradict their own thinking ("I should respond", then `no_reply`), and models often consider refusing and then answer fully, so thinking carries the highest threshold. Only its tail is sent (the decision is at the end; long irrelevant text lowers accuracy).

They are taken from the assistant message containing the call; when it has none, from the previous assistant message since the last inbound message.

**Questions at this checkpoint:**

- the refusal checks, one question per available source, with an explicit `false` criterion naming the harmless reasons ("judged that no reply was needed: not addressed to it, already answered, nothing to add"), because the model reads instructions literally;
- `no_reply_contradiction` (kind `style`-like, remedy `revise`, **off by default**): "the reasoning concludes that the assistant should reply" or "a reply for the users was written but never sent". On a hit, `no_reply` returns a tool error: *"Your reasoning concluded you should reply, or you wrote a reply without sending it. Send it with send_message, or call no_reply again with override `no_reply_contradiction` if not replying is intended."* It uses the override and the limits of §6.4. It works only where `analysis`, text or thinking is visible;
- after one or more forced-completion nudges, `no_reply_intent` (observe, §7.4): did the model originally intend not to reply, or did it give up after writing its reply as text?

### 5.5 State shapes

The judge-shaped state of DECISION-MODEL §3.8, extended with the reasoning sources:

```json
{ "request": [ { "from": "...", "text": "..." } ],
  "recent":  [ ... a few messages ... ],
  "action":  "send_message | no_reply | ...",
  "message": "the text being sent, if any",
  "analysis": "...",
  "text": "...",
  "thinking": "... tail ..." }
```

Members that accept only `{input, output}` judge state receive `request` as input and `message` (or `analysis` + `text` for an ending without a send) as output; questions over other sources skip them through the fits check.

For outgoing messages the message is the primary source; `analysis` and `text` are added (short, and good at catching "quietly did less than asked"). Thinking is not used at send checkpoints by default, because deliberation that ends in a full answer reads as a refusal.

## 6. The outgoing-message gate

Every outgoing message written by the model is **held** and sent only after its checks are evaluated, or at the gate's deadline (fail-open). Replies are not special: proactive posts, cross-channel sends and bot-to-bot messages take the same gate. The gate is what makes chat refusals recoverable: a refused message is caught before it reaches the chat.

### 6.1 Gated tools

`send_message`, `send_dm`, `send_to_channel`, `edit_message` (the new text), `create_poll` (question and options), and any posting tool that carries model-written text (media posts with a caption). Messages the harness itself writes (`sendViaProvider` in `app.ts`: failure notices, budget and admission refusals) are fixed text, never judged.

### 6.2 One evaluation, possibly several calls

The gate is one logical evaluation per message, carrying every enabled check: refusal reasons, style, operator conditions, and the duplicate guard (DECISION-MODEL §5.4) when its mechanical precondition holds. It may be split into **parallel calls grouped by state shape**:

- style checks: the message alone (style is a property of the message; short state suits judge routes that degrade above ~0.5–2k tokens);
- refusal and operator checks: request, recent chat, message, `analysis`, `text`;
- dedup: its own state, only when triggered.

The wait is the slowest call. On per-request-billed members the cost is about the same as one call; per-question-billed members are accounted for by the fits (DECISION-MODEL §3.6). Ordering inside the tool: claim guard → evaluation → send.

### 6.3 Latency

- The evaluation **starts when the tool call's arguments are complete** (`toolcall_end` in the stream), before the tool executes, concurrently with the claim guard.
- **Observe-only checks never hold the send**: when no check in a message's evaluation has a `redo` or `revise` remedy, the evaluation runs alongside the send and only records (owner decision 5).
- **Deadline**: past it, the message is sent unjudged and the miss is counted. The evaluation still completes and is recorded.
- Style checks skip messages shorter than `min_chars` (default 80: one-liners rarely carry these constructions, and that is where added latency is most visible). Refusal checks have no length floor ("nah, can't do that" is short).

### 6.4 Verdicts

- **Redo** (a refusal check fired with remedy `redo` and a rule matches): the message is not sent; the turn is discarded and redone on the rule's model (§8). Refusal wins over any style flag in the same evaluation.
- **Revise** (one or more `revise` checks fired): the send is stopped and the tool returns an error listing each fired check's code and agent-facing explanation, and how to override; the same agent and model revise and call again. Nothing is discarded.
- **Pass**: sent.

**Bounds on revise** (an unnoticed, unbounded token spend is worse than a style issue):

- a limit on consecutive rejections of one message (rejected sends since the last delivered message), after which the message goes through regardless of revisable checks;
- a per-session limit on total rejections, after which revisable checks stop blocking for the rest of the session (they keep recording);
- the counters persist across a refusal redo.

**Override.** The posting tools take an optional argument naming check codes to skip for this call. Only codes fired in the immediately preceding rejection are honoured; refusal checks can never be overridden. The tool error tells the agent to use it when a flag is a clear false positive or the message deliberately shows the pattern (a quotation, an example). Overrides are recorded.

## 7. Send-contract diagnostics

Already decided in DECISION-MODEL §5.8 (send-contract audit, mechanical counters, mandatory backfill); extended here. Purely diagnostic except §7.5.

### 7.1 Mechanical statistics (no decision model)

Objective facts, recorded live and derived for history:

- per session: number of nudges, outcome (`clean`, `recovered` after k nudges, `gave_up_no_reply` after nudges, `redo_recovered`, `exhausted`);
- per **attempt** (the original turn ending and every ending after a nudge): time, served member and wire model (fallback can change the model between attempts), nudge variant (`not_sent`, or `sent_not_final` when a `final: false` send was not followed up), and the mechanical failure types of §7.2.

Aggregated per model and over time this gives the error rate (provider-side regressions and quality drops show as a rate change on one served member), the recovery rate, and the distribution of attempts needed to recover. Models that fail tend to keep failing; the per-attempt rows show it.

**Corrective prompts are tagged** going forward (`harness: { kind: "forced_completion", attempt, variant }`, the same marker mechanism as `record_turn` and `injection`), and their texts are exported constants (`FORCED_COMPLETION_PROMPTS`) with every historical wording, so history is derived by the same pure function (`deriveContractEvents(transcript)`) over `transcript_json`. A one-time, resumable backfill computes it for every session with a payload.

### 7.2 Failure types per attempt

Computed by a pure function over the assistant messages of the attempt. Several may apply; a precedence picks the primary one.

| type | meaning | detection |
|---|---|---|
| `empty` | no text, no tool call | mechanical |
| `text_only` | the reply written as plain text | mechanical |
| `textual_tool_call` | tried to call the tool, but wrote the call as text (function syntax, JSON or XML tool-call markup, the tool's name with arguments), so the provider never parsed it | patterns; decision model when ambiguous |
| `context_mimicry` | reproduced the rich-message markup of its own context (`<message …>`, `<reply_to>`, `<attachment>`, `<handled_by_session>`…) instead of calling a tool, working like a text-completion engine | patterns over the renderer's tag vocabulary, exported as a constant so the detector follows the renderer |
| `invalid_tool_call` | a native send call that failed validation, then stopped without retrying | mechanical |
| `self_talk` | only reasoning or narration, nothing written for the users | decision model (`had_user_message`) |
| `sent_not_final` | sent with `final: false`, then stopped | mechanical |

Different attempts of one session can have different types; each attempt is recorded.

### 7.3 What happened to the message

When a nudged session recovers, the message actually sent is compared with the message it first tried to deliver (the text of the first failed attempt, or the text argument extracted from a textual tool call):

- **mechanical**, always: normalized equality, an edit-similarity ratio, a length ratio;
- **decision model**, `choice` over: `same`, `minor_rewording`, `parts_removed`, `rewritten_same_substance`, `different_substance`, `switched_to_no_reply`, `nothing` (exhausted).

The console shows the two texts as a diff (§12.2).

### 7.4 `no_reply` after a nudge

When a session needed a nudge and then called `no_reply`: did the model originally intend not to reply, or did it use `no_reply` to give up after writing its reply as text? `no_reply_intent`, a `choice` over `intended_no_reply`, `abandoned_written_reply`, `unclear`, over the pre-nudge attempt's text and the `no_reply` sources of §5.4. It is asked inline at the `no_reply` checkpoint (always judged, §5.4), so live sessions need no offline pass. If `no_reply_contradiction` is enabled, an abandoned written reply is exactly what it catches.

### 7.5 Redo after the nudges run out

After `forced_completion_retries` consecutive nudges (default 3) without a valid ending, the model has probably poisoned its own context and will keep reinforcing its own bad output. Instead of giving up:

1. discard back to the fork point (§8.4), dropping the failed attempts and the nudges;
2. continue on the **same model** (this failure is nearly always random; a session already moved to a refusal-redo model stays on it). The prefix is unchanged, so the redo reads from cache;
3. the redo gets its own nudge budget;
4. if that runs out too, give up: the session settles as `NO_REPLY`, as today. No failure notice is sent: the failure is not actionable by the user and not caused by their input (owner decision 13). The statistics record it as `exhausted`.

**Budget: one redo per failure point** (owner decision 14). A failure point is the span since the last delivered message, so the bound is one redo per message, not per session. A session that delivers message 1, needs a redo for message 2 and succeeds, and later fails on message 3, gets a redo for message 3 too: a redo that worked once suggests the model can recover again in the same session, and the bound only exists to stop an endless loop. A second exhaustion inside the same span (the redo's own nudges ran out) gives up.

### 7.6 When the decision-model diagnosis runs

Everything in §7.2–§7.3 that needs a decision model is diagnostic and nothing waits on it, so it runs in the offline audit worker after the session completes (DECISION-MODEL §5.8 worker, `audit` ledger class, never payee-billed), live and over the history backlog. Only the `no_reply` questions (§7.4) run inline.

## 8. Recovery: rules and redo

### 8.1 Rules

```toml
[[refusal_fallback]]
name = "distillation"
sites = ["default", "proactive", "record_turn", "summarize", "condense", "diary", "caption"]  # omitted = every site
reasons = ["distillation"]        # omitted = any reason (a generic refusal fallback)
from_models = ["model_a"]         # optional: only refusals by these models
agents = ["agent_a"]              # optional
tasks = ["coding", "other"]       # optional: the session's routed task (DECISION-MODEL §5.1 routing keys, plus "other")
models = ["open_model_x", "open_model_y"]   # tried in order
soft = "redo"                     # "redo" | "observe": whether a judged (soft) refusal of this reason triggers a redo
on_exhausted = "send_last"        # chat sites: "send_last" (default) | "withhold" | "park"
```

- **Sites** are session-type names plus the internal sites (`record_turn`, `summarize`, `condense`, `diary`, `caption`).
- **Tasks**: the task keys the routing point gave the session (`[decisions.routing.tasks.<key>]`, operator-defined, or `other`), the same classification that already picks the session's model cascade. Tasks are multi-label (DECISION-MODEL §5.1a); the condition matches when any of the session's tasks is listed. A refused request of a given kind can so be sent to a model suited to that kind. A session without a routing verdict (routing off, routing fell back, internal sites) has no task, and a rule with `tasks` never matches it. Startup validation: every listed key exists in the routing tasks of each agent the rule applies to (agents may replace their task list, DECISION-MODEL §4). A redo keeps the session's routed skills and tail files; only the model changes.
- **Precedence**: the first matching rule in file order (authored order, like PER-USER-LIMITS).
- **Composition**: a matching rule **replaces** the implicit chain fallover for that refusal. With no matching rule, a hard refusal keeps today's implicit fallover and a soft refusal is recorded only.
- **Gates**: a rule's model passes the usual gates (health, budget, per-user limits, context fits, capability). An entry that fails them is skipped. The redo is billed to the session's payee and counts on the redo model's caps.
- **Record turn**: its opt-out disables only the implicit chain fallover. A rule naming `record_turn` applies (SESSION-RECORDS §3.2 anticipated this). The redo model reads the whole rollout uncached; the record turn's own budget and timeout apply.
- If a rule's model also refuses, the next entry applies.

### 8.2 Exhaustion

When every entry of the rule has refused:

- **chat sites**: `on_exhausted` (owner decision 3): `send_last` (default: send the last attempt; withholding makes the bot look dead), `withhold` (send nothing), `park` (today's hard-refusal outcome, `failed-resumable`). For a hard refusal there is no text to send, so `send_last` parks as today;
- **mechanical jobs**: no output (never a refusal written into a summary, caption or diary), no repeated tool nudges against a refusing model.

### 8.3 Stickiness

After a redo the session stays on the redo model for the rest of the session (owner decision 1), for hard refusals handled by a rule too. Today the `refused` set lasts one request, so the next request returns to the model that refused. A sticky refusal pins the session's chain to the rule entry that succeeded (with that entry's own chain fallback as usual). The redo request resolves the new model's per-model preamble and tail (MODEL-PROMPTS) like any request on that model.

### 8.4 Redo mechanics

- **Hard refusal of one request** (no output): re-issue the same request on the rule's model. The shipped fallover, generalized. Nothing to discard.
- **Discard and fork** (a soft refusal caught at the gate, a refusal at an ending without a send, send-contract exhaustion):
  - **Fork point**: the later of the last delivered message and the last irreversible tool effect (owner decision 2). Everything after it is discarded from the live context; read-only work in that span is redone by the new run.
  - **Tool side effects**: each tool declares whether it is redo-safe (read-only or idempotent) or irreversible. This is the same list as the redo whitelist of SESSION-RECORDS §9 (edits), defined once.
  - **Mechanism**: a tool cannot rewind from inside the agent loop. The gating tool returns a redo sentinel and aborts the run; the runner truncates `agent.state.messages` to the fork point, applies the model pin, and continues. Sibling tool calls in the same assistant message that already ran irreversibly move the fork point after them.
  - **Interjections** delivered inside the discarded span are redelivered into the new branch (the `steer_unread_redelivered` path).
  - **Forced completion**: the nudge counter resets on a refusal redo; a send-contract redo starts its own budget (§7.5).
  - **Thinking** blocks of the old model are dropped on replay to a different model, as today.
  - The discarded span is persisted as a branch (§9).
- **Mechanical jobs** have no external effects; their redo is always "discard and rerun on the rule's model".

## 9. Branches

Rollouts stop being append-only. A redo forks the session; the discarded span is kept.

- `transcript_json` stays **the live branch** (what the agent actually has), so resume, the record turn and `buildsOnFromTranscript` are unaffected.
- A new table `agent_session_branches`: `(session_id, branch_no, parent_branch_no, fork_index, reason, check_code, decision_evaluation_id, from_model, to_model, messages_json, cost_usd, created_at)`: one row per discarded span, `fork_index` being the message index in the parent branch where it diverges. A redo branch can itself be redone, so branches form a tree. `reason` is `refusal_redo` or `contract_redo` (and later `edit_redo`, SESSION-RECORDS §9).
- Per-message usage is already embedded in the transcript's assistant messages, so a branch's cost is computed from its messages; the ledger needs no branch column.
- `decision_evaluations` gains an **anchor**: `branch_no` and the `tool_call_id` of the judged call (or the attempt number for endings), and its verdict records the **consequence** (`sent`, `sent_unjudged` at the deadline, `revise`, `overridden`, `redo` → branch, `observed`).
- The live session stream emits a `branch_forked` event so the live rollout re-seeds onto the new branch.

## 10. Statistics

### 10.1 Records

- **Check verdicts**: the `decision_evaluations` rows (anchored, §9), plus pattern hits written to the same table with a `pattern` method and no model call.
- **`refusal_events`**: one row per detected refusal, hard or judged: time, session, branch, site, agent, model and served member, reason, check code, method, probability, raw stop reason and category, provider explanation, rule fired and outcome. Hard refusals have no decision row; judged ones link to theirs.
- **`contract_attempts`**: one row per send-contract attempt (§7.1), plus the per-session outcome on `agent_sessions`, and the offline diagnosis (§7.2–§7.3) in the audit rows of DECISION-MODEL §5.8.
- Gate latency per evaluation and fail-open misses.

All written through the single-writer queue; collected whether or not any remedy is configured. Without a decision model only the mechanical records (hard refusals, patterns, send-contract counters) exist.

### 10.2 Backfill

The offline audit worker runs the refusal and send-contract checks over history (DECISION-MODEL §5.8, mandatory backfill), so per-model rates exist from day one rather than from the deploy.

### 10.3 Ledger

Refused attempts' spend is recorded: the pi-ai patch keeps `usage` on the refusal error (§5.1), and the terminal-error path writes it. A discarded branch's requests are ordinary ledger rows of the session.

## 11. Upstream vs deployment

- **Upstream** (generic, default-off): checks and the built-in catalogue, detection, the gate, send-contract diagnostics, rules, redo and branches, statistics, console. No rule and no blocking check ships enabled. Mechanical statistics are on by default; judged statistics need a configured decision model.
- **Deployment**: which rules exist and which models they name, which checks block. A deployment may begin with distillation rules only, and observe everything else.

## 12. Console

### 12.1 Branches in the rollout

Like conversation branches in chat interfaces:

- the session view shows the **latest branch** by default;
- at each fork point, a switcher `‹ 2/2 ›` moves between the branches forked there; selecting a discarded branch renders its span, and its own nested forks have their own switchers;
- the fork marker states why: the check code and description with the probability that fired (or "3 nudges without a send"), from-model → to-model, and the discarded branch's cost;
- the live rollout follows `branch_forked` and switches to the new branch.

### 12.2 Checks and decisions where they happened

- **Gate card** attached to the judged tool call: each check's questions with probability and threshold, which fired, latency, served decision member, and the consequence: sent, sent unjudged (deadline), revise (with the tool error the agent saw), overridden (codes), redo (link to the branch), observed. Clean evaluations collapse to one line.
- **Hard refusals** marked on the request: stop reason, category, fallover or rule, target model.
- **Nudge cards**: "nudge 2/3" with the attempt's failure-type chips; the offline diagnosis chips appear when the audit has run; a recovered session shows the first attempted message and the sent message as a diff with the `after_correction` verdict.
- **Ending card** at `no_reply`: the sources that were judged and the verdicts (`no_reply_intent`, refusal, contradiction).
- **Session list chips**: refused, redone (n), nudged (n), revised (n), unjudged (n).

### 12.3 Model behaviour page

A new console page (`/models`) for **model behaviour**: how often each model refuses, breaks the send contract, and produces style issues, and what happens next. Provider reliability and speed (error classes, stalls, time to first token, cache hits) are out of scope (owner decision 15); so are the gate's own latency and fail-open counts, which describe the decision model, not the chat model, and stay in logs and the session view.

**Filters** (all in the URL, like the other pages, ARCHITECTURE.md §11): time window (the usage page's set: today, 24h, 7d, 30d, this month, all), agent, site (session type or internal job), task (multi-label, DECISION-MODEL §5.1a), and a group-by (model, agent, site, task). Every section follows them.

**What counts as a model** (owner decision 16): the config entry (`[models.<key>]`) by default, so the same underlying model served by two providers is two rows. A toggle groups by underlying model through an optional `[models.<key>].family` field (entries without one stay separate). Every event is attributed to the model that served that specific request or attempt, not to the session's head: fallback and sticky redo can change the model within a session.

**Sections:**

1. **Scorecard**: one row per model, one column per headline rate, each with its raw count and its change against the previous window of the same length. Rates over too few samples are greyed (a minimum count per metric). Clicking a cell selects that model and metric for the sections below. Headline rates and their denominators:
   - refusals per request, split hard / judged;
   - sessions with at least one nudge, per session;
   - recovered after nudges, per nudged session;
   - send-contract redos and exhaustions, per session;
   - style hits per 1k message tokens, and share of messages with a hit (both denominators, DECISION-MODEL §5.8 owner decision);
   - refusal redos, per session.
2. **Over time**: the selected metric, one line per model, hourly buckets at 24h, daily at 7d/30d, weekly beyond, with change markers (§12.4).
3. **Breakdown** for the selected family:
   - refusals: by reason, site and detection method; rule outcomes; cost of discarded branches;
   - send contract: nudges until recovery (1, 2, 3, after redo, gave up), failure-type mix, what happened to the message (`after_correction`), `no_reply` intent after a nudge;
   - style: hits per check; revisions and overrides per check.
4. **Incident log**: newest first, one row per session (its refusals, nudges, redos, revisions and judged endings grouped), with time, agent, room, model, chips and a one-line outcome. Each row links to the session in the conversation view at the branch and tool call where it happened. Filterable by incident type; cursor-paginated.

**Passive** (owner decision 18): the page flags nothing and sends no notifications.

**Storage.** Rates are read from an hourly rollup table maintained at write time through the single-writer queue (the pattern of the pipelines page's materialized counts): counters keyed by hour, agent, site, model and metric, including the denominators (requests, sessions, messages sent, message tokens). Task is a separate rollup dimension, one row per task label, because labels overlap. The raw tables (§10.1) are read only by the incident log and click-through. The history backfill (§10.2) rebuilds the rollups.

### 12.4 Change markers

Rates move when something about the model's situation changes, so the trend charts mark those changes. Two sources, both turned into typed, explainable events:

**1. Behaviour-config snapshots at startup.** Config only changes on a restart, so at boot the app builds a **resolved behaviour snapshot**: the effective, merged, per-agent result of the config (after file merge, `${VAR}` templating and `[agents.<name>.…]` overrides), restricted to what shapes model behaviour, and never containing credentials:

- per agent and site: the model chain (head and fallbacks), thinking level, and the per-user preference lists;
- routing tasks and what each maps to;
- refusal rules, enabled checks with their remedies and thresholds, the gate's decision chains;
- the code version (package version plus a build revision baked into the image).

The snapshot is stored with its hash (`behaviour_snapshots`); when the hash differs from the previous one, the two **structured** snapshots are diffed field by field, and each difference becomes a typed event in `behaviour_changes` from a fixed vocabulary with a sentence template and the models, agents and sites it touches:

| event | example sentence |
|---|---|
| `head_model_changed` | agent A, chat: head model B → C |
| `chain_changed` | agent A, chat: fallbacks now C, D (was C) |
| `preference_changed` | agent A: user preference list changed (B moved to first) |
| `thinking_changed` | agent A, chat on B: thinking medium → high |
| `routing_task_changed` | task `coding`: models now B, C |
| `rule_changed` / `check_changed` | rule `distillation`: added; check `style_x`: threshold 0.8 → 0.85 |
| `code_changed` | deploy: 1.4.0+abc123 → 1.4.0+def456 |

A difference outside the vocabulary becomes a generic `config_changed` event naming the resolved path and the old and new values, so nothing is silently missed; frequent generic paths are candidates for a typed event later. Diffing the resolved structure rather than the TOML is what makes the events explainable: a model moved between files, renamed variables or a reordered table produce no event, and a one-line change in a shared block produces one event per agent and site it actually affects.

**2. Observed prompt changes.** The system prompt and the per-model prompts change without a restart when workspace files are edited. `usage_events` already carries `model_prompt_hash` per request; a matching `system_prompt_hash` (the frozen system prompt's hash) is added. A change in either hash for a served member, between consecutive requests, is recorded as `prompt_changed` (which prompt, which agent and model; the hash only, never the text).

**On the chart**, markers are filtered to the models, agents and sites displayed; changes within a few minutes of each other (one deploy) collapse into one marker that lists them on hover. Traffic shifts that are not changes (a budget cap moving traffic to a fallback, a health fallover) are not markers; they show in the volume counts.

## 13. Latency

Every checkpoint adds work to a task's path. **End-to-end task latency must not suffer**, as a design requirement for each piece:

- measured per checkpoint and site, with its share of the task's end-to-end time;
- overlapped where possible: evaluation starts at `toolcall_end` (§6.3), runs parallel calls (§6.2), observe-only checks never hold, internal artifacts are judged off the interactive path when nothing waits on them;
- bounded: every checkpoint has a deadline, past it the output proceeds unjudged and the miss is counted;
- decision models and state sizes chosen for latency as well as quality (DECISION-MODEL §3.6–§3.7);
- a redo is slower than a success by construction; the rules decide when it is worth it and the statistics show what it costs.

## 14. Non-goals

- Bypassing safety systems. Recovery only ever means asking another model, permitted to do the task under its own policy, with the request unchanged. Nothing rewrites or disguises a request to get past a refusal.
- Rewriting messages in the harness. Revisions are always the agent's own.

## 15. Open questions

1. Default thresholds, deadlines and `min_chars` per checkpoint, and the decision chains for each (judge route for style, general route for refusal); calibration against the head decision member.
2. The starter catalogue: built-in refusal questions per reason and source, starter style checks, the textual-tool-call patterns.
3. Latency budgets per checkpoint and how end-to-end latency is measured (§13).
4. Phasing: proposed order is (1) hard-refusal categories, statistics, rules and redo for hard refusals and mechanical jobs; (2) send-contract mechanics, backfill and the nudge redo; (3) the gate with observe-only checks; (4) blocking refusal checks, chat redo and branches in the console; (5) style revise; (6) offline diagnosis.
