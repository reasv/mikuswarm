# Refusal handling, output checks and session redo

**Status**: IMPLEMENTED (2026-10-05) — superseded by ARCHITECTURE.md §8j (output checks, refusal handling and redo), §8k (model behaviour statistics) and §9i (offline audit worker), with the touched sections §4, §7, §8, §8a, §8h, §8i, §10 and §11; retained for review. Was: PROPOSAL, revision 3 (2026-10-05), ready for implementation. Revision 1 was the owner's direction of the same day; revision 2 folded in a review pass, the owner's answers to it, and the send-contract diagnostics and console design added by the owner; revision 3 settles the pre-implementation questions (§3 decisions 21–27, §16). What remains in §15 is calibration done during implementation.
**Implementation deviations** (the ARCHITECTURE.md sections above are authoritative): `forced_completion_redo` lives under `[agent.sessions]` beside `forced_completion_retries`; a refusal at a send does not abort the run, `shouldStopAfterTurn` lets sibling tool calls finish before the redo; pattern hits act past the deadline, late judged answers only record; a judged call's own timeout defaults to twice its checkpoint deadline; rule entries take `tries` and `@same` (decision 28) and tries count per refusal point; `media` is redo-safe and not a posting tool; `self_talk` comes only from the offline audit, whose clean-session sample defaults to 1 (every session) and whose check verdicts are stored as `checks` decision rows with an `audit:` group prefix; the statistics rollups are keyed by the session's creation hour and maintained by dirty-hour triggers plus recompute; the session record is judged through the background checks (its rows are not re-anchored after a rerun); branch nesting is derived from chronology (`parent_branch_no` is always 0).
**Builds on**: the shipped `refusal` error class (ARCHITECTURE.md §8a "Refusals"): hard refusals are recognized from the provider's stop reason, are never a health strike, are never retried on the member that refused, fall over to the next chain member, and log `llm_refusal`. The session-record turn opts out of that implicit fallover.
**Supersedes**:
- the "Refusal handling" direction in spec/SESSION-RECORDS.md §9, which this document expands;
- DECISION-MODEL §5.9 (style gate): the gate, its catalogue, its bounds and its override are specified here (§6);
- the refusal audit and the send-contract audit of DECISION-MODEL §5.8: their questions, storage and console are specified here (§7, §10, §12). The §5.8 audit worker remains the offline runner, used for history backfill and for diagnostics that need no live action.

**Amends DECISION-MODEL**:
- constraint 4 ("the decision model never hard-gates the agent"): outgoing messages are held until judged (with a fail-open deadline), and a refusal verdict discards the turn;
- constraint 5 ("no de-escalation of normal chat") and §8 ("no model switching mid-session"): a refusal redo switches the session to the rule's model for the rest of the session (§8.3). Style checks never switch models.

**Related**: SESSION-RECORDS (record turn §3.2, the redo concept of §9), DECISION-MODEL (decision points, judge-shaped state §3.8, audit worker §5.8, dedup §5.4), MODEL-FALLBACK, LLM-FAILURE-HANDLING, OPENAI-PREFILL (the `analysis` argument), MODEL-PROMPTS.

### What changed in revision 3

- **Deadlines are timeouts, not targets** (§6.3, §13): 5 s for an outgoing message, 15 s for an ending without a send. The design minimizes the actual delay; the deadline only decides when to stop waiting.
- Style checks skip messages under **40** characters (§6.3).
- **Sibling tool calls on a redo** (§8.4): the redo forks into a branch where the gated call is removed and the sibling calls stay with their results; the new model continues from those results.
- **One decision call per message by default** (§6.2): split only when a member's fits require it.
- **Starter style catalogue** (§4.5), drawn from the workspace template's style rules and common LLM-isms.
- **Phasing** (§16.1): deployed phase by phase; the unbuilt DECISION-MODEL and SESSION-RECORDS pieces are built inside the phase that first needs them.
- `on_exhausted = "withhold"` settles as `NO_REPLY` with no notice (§8.2).
- Defaults for the remaining implementer choices (§16.2).
- **Model prompts on every switch** (§8.3, owner decision 27): rule models' preambles and tails are resolved for the session, not only its heads' chains.

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
20. **Proactive sessions always carry a built-in `proactive` task** (DECISION-MODEL §5.1a), so rules and statistics can select them by task as well as by site.
21. **Deadlines are timeouts, not targets**: 5 s for an outgoing message. The LLM itself is allowed far longer, so a strict judge timeout buys nothing; the design goal is the smallest *actual* added delay, and when to stop waiting and send unjudged is a separate question (§6.3, §13).
22. **Style checks skip messages under 40 characters** (§6.3).
23. **A redo keeps sibling tool calls**: when the gated call shares its assistant message with other tool calls, the redo forks into a branch where the gated call is removed and the other calls remain with their results. A tool result is a natural continuation point for any model (§8.4).
24. **Phases are deployed as they land**, each in a working state (§16).
25. **Prerequisites are built inside the phase that first needs them**, not as separate work first: the tool side-effect list in phase 1, judge-shaped state in phase 3, multi-label tasks before the rules' `tasks` condition is enabled, the audit worker in phase 6 (§16).
26. **The starter style catalogue** starts from the not-X-but-Y contrast, em-dashes, "I hope this helps" sign-offs, sycophantic openers and "delve"-style vocabulary, plus the workspace template's existing style rules (§4.5).
27. **Every model switch uses the serving model's own model prompts**: a refusal redo, a later rule entry, the sticky pin and its fallback get the preamble and tail configured for that model, exactly like chain fallover (§8.3).
28. **Same-model retries for refusals**: a refusal can be a random over-refusal, so a rule can retry the model that refused, and any rule entry can be tried several times (`tries`). The same model may also appear several times in a rule's list (§8.1).

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

### 4.5 Starter style catalogue

Upstream ships these as built-in style checks, **all disabled** (§11): an operator enables the ones that match their persona and may override any field. Two sources, so each check enforces something the prompt already asks for or a well-known LLM-ism:

- the style rules the workspace template already gives the agent (`templates/workspace/AGENTS.md` and `TAIL.md`: no assistant filler, no "I'm just an AI" disclaimers, custom emoji or kaomoji over standard emoji, short messages unless length is warranted);
- common LLM-isms (owner decision 26).

| code | catches | detection | agent-facing explanation (shown with the code) |
|---|---|---|---|
| `style_em_dash` | an em-dash (`—`) | pattern only | Contains an em-dash. Use a comma, period, colon or parentheses instead. |
| `style_not_x_but_y` | rhetorical contrast: "it's not X, it's Y", "not just X, but Y", "less X, more Y", litotes used for effect | question | Uses a rhetorical "not X, but Y" contrast. State the point directly. |
| `style_parallel_construction` | rhetorical parallelism: triads for rhythm, anaphora, mirrored clauses | question | Uses a rhetorical parallel construction (a rhythmic triad or repeated sentence frame). Say it plainly, once. |
| `style_sycophantic_opener` | praise or agreement as an opener: "Great question!", "You're absolutely right", "What a fascinating idea" | patterns (common phrasings) + question (paraphrases) | Opens by praising or agreeing with the user. Start with the substance. |
| `style_assistant_sign_off` | service sign-offs and offers: "I hope this helps", "Let me know if you need anything else", "Feel free to ask", "How can I help?", "I'd be happy to" | patterns + question | Ends with (or contains) an assistant-style offer or sign-off. Drop it. |
| `style_llm_vocabulary` | overused LLM vocabulary: delve, tapestry, testament to, multifaceted, navigate the complexities, in the realm of, it's worth noting, underscores, boasts | patterns over a configurable word list (word boundaries, case-insensitive) | Uses stock LLM vocabulary ("{matched}"). Use a plain word. |
| `style_ai_disclaimer` | "as an AI", "I'm just a language model", disclaimers about being an AI | patterns + question | Contains an AI disclaimer. Stay in character and drop it. |
| `style_essay_formatting` | headings, section labels, bulleted or numbered structure in a conversational message that did not call for it | pattern (markdown headings) + question | Formats a chat message like an essay (headings, bullet structure). Write it as a normal chat message unless a list was asked for. |
| `style_moralizing` | unprompted ethical commentary, warnings or caveats the user did not ask for | question | Adds moral commentary or caveats nobody asked for. Remove them. |
| `style_unicode_emoji` | standard Unicode emoji in the message body | pattern (emoji code-point ranges) | Contains standard Unicode emoji. Use a custom `:shortcode:` emoji or a kaomoji instead. |
| `style_wall_of_text` | far longer than the exchange calls for, when nobody asked for research, an explanation or exact quoted material | question | Much longer than this exchange calls for. Cut it to what matters. |

Notes:

- A pattern hit decides its check without a model call (§4.2), so the pattern-only checks cost nothing and work without a decision model. A check with both decides on a pattern hit and otherwise asks its question, which catches paraphrases.
- `{matched}` is filled with the matched text so the agent knows exactly what to change.
- Deliberate uses (quoting someone, explaining what an em-dash is) are what the override is for (§6.4); the error text says so.
- Each question carries explicit `false` criteria naming the near-misses (a factual correction is not a rhetorical contrast; a list the user asked for is not essay formatting), because decision models read instructions literally.
- `style_moralizing` and `style_wall_of_text` are persona-dependent by nature; they ship like the others (disabled) and are the most likely candidates for operator-tuned questions.

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

`no_reply` is judged **every time** in every session type (rare enough, owner decision 8), **proactive sessions included** (owner decision 11): not replying is a normal proactive outcome, but proactive sessions are also where agents most often reason "I should say this" and then end with `NO_REPLY`, so their endings are exactly the ones worth judging. Holding it costs no visible latency (no message is coming), so its deadline is looser than a send's (default 15 s).

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

The gate is one logical evaluation per message, carrying every enabled check: refusal reasons, style, operator conditions, and the duplicate guard (DECISION-MODEL §5.4) when its mechanical precondition holds.

**One call by default.** All questions go in one request over one state (request, recent chat, message, `analysis`, `text`). A member that bills the state once per request answers every question for the price of one, and one call has one latency. Style questions point at the `message` field.

**Split only when the fits require it.** When the serving member cannot take the whole evaluation in one request (its `max_questions`, a `state_budget_tokens` below the full state, a judge-only `{input, output}` shape, or per-question billing that makes a large shared state expensive), the evaluation is split into parallel calls grouped by state shape: style over the message alone, refusal and operator checks over the full state, dedup over its own state when triggered. The wait is then the slowest call. The fits (DECISION-MODEL §3.6) make this choice per member, so it follows the chain: a fallback member with tighter limits gets the split form.

Ordering inside the tool: claim guard → evaluation → send.

### 6.3 Latency

- The evaluation **starts when the tool call's arguments are complete** (`toolcall_end` in the stream), before the tool executes, concurrently with the claim guard.
- **Observe-only checks never hold the send**: when no check in a message's evaluation has a `redo` or `revise` remedy, the evaluation runs alongside the send and only records (owner decision 5).
- **Deadline** (default 5 s, owner decision 21): past it, the message is sent unjudged and the miss is counted. The evaluation still completes and is recorded. The deadline is a **timeout, not a target**: the LLM that wrote the message is allowed far longer, so a tight judge timeout only trades judged messages for nothing. What keeps the gate fast is the design (early start, one call, observe-only checks never holding, fast members), and the statistics measure the actual added delay per checkpoint (§13); the deadline only bounds the rare slow evaluation.
- **Hold only when a verdict could act**: a message is held only when some check in its evaluation could block it in this session: a `revise` check, or a `redo` check for which a rule can match this session's site, agent, tasks and serving model. Otherwise the evaluation runs alongside the send as observe-only.
- Style checks skip messages shorter than `min_chars` (default 40, owner decision 22). Refusal checks have no length floor ("nah, can't do that" is short). Pattern-only checks are free and synchronous, so they ignore `min_chars`.

### 6.4 Verdicts

- **Redo** (a refusal check fired with remedy `redo` and a rule matches): the message is not sent; the turn is discarded and redone on the rule's model (§8). Refusal wins over any style flag in the same evaluation.
- **Revise** (one or more `revise` checks fired): the send is stopped and the tool returns an error listing each fired check's code and agent-facing explanation, and how to override; the same agent and model revise and call again. Nothing is discarded.
- **Pass**: sent.

**Bounds on revise** (an unnoticed, unbounded token spend is worse than a style issue):

- a limit on consecutive rejections of one message (rejected sends since the last delivered message; default 2), after which the message goes through regardless of revisable checks;
- a per-session limit on total rejections (default 6), after which revisable checks stop blocking for the rest of the session (they keep recording);
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
models = ["open_model_x", "open_model_y"]   # tried in order; an entry may be a table:
# models = [ { model = "@same", tries = 2 }, { model = "open_model_x", tries = 3 }, "open_model_y" ]
soft = "redo"                     # "redo" | "observe": whether a judged (soft) refusal of this reason triggers a redo
on_exhausted = "send_last"        # chat sites: "send_last" (default) | "withhold" | "park"
```

- **Sites** are session-type names plus the internal sites (`record_turn`, `summarize`, `condense`, `diary`, `caption`).
- **Tasks**: the task keys the routing point gave the session (`[decisions.routing.tasks.<key>]`, operator-defined, `other`, or the built-in `proactive`), the same classification that already picks the session's model cascade. Tasks are multi-label (DECISION-MODEL §5.1a); the condition matches when any of the session's tasks is listed. A refused request of a given kind can so be sent to a model suited to that kind. A session without a routing verdict and not proactive (routing off, routing fell back, bot-triggered, internal sites) has no task, and a rule with `tasks` never matches it. Startup validation: every listed key exists in the routing tasks of each agent the rule applies to (agents may replace their task list, DECISION-MODEL §4). A redo keeps the session's routed skills and tail files; only the model changes.
- **Precedence**: the first matching rule in file order (authored order, like PER-USER-LIMITS).
- **Composition**: a matching rule **replaces** the implicit chain fallover for that refusal. With no matching rule, a hard refusal keeps today's implicit fallover and a soft refusal is recorded only.
- **Gates**: a rule's model passes the usual gates (health, budget, per-user limits, context fits, capability). An entry that fails them is skipped. The redo is billed to the session's payee and counts on the redo model's caps.
- **Record turn**: its opt-out disables only the implicit chain fallover. A rule naming `record_turn` applies (SESSION-RECORDS §3.2 anticipated this). The redo model reads the whole rollout uncached; the record turn's own budget and timeout apply.
- If a rule's model also refuses, the next entry applies.
- **Tries and same-model retries** (owner decision 28). An entry is a model key or a table `{ model, tries }`; `tries` (default 1) is how many times that entry is attempted before the next entry applies. The reserved key `@same` means **the model that refused** (the member that served the refused request, so a session already moved by an earlier redo retries its current model); a rule may start with it to absorb random over-refusals before switching models. The same model key may appear in several entries. Every try is a full redo of its kind: a hard refusal re-issues the same request, a soft refusal discards and forks again (§8.4); the retried request gets a fresh sample. Explicit entries override the "never re-sent to the member that refused" rule of the implicit chain fallover, which still holds when no rule matches. Tries count per refusal point (the span since the last delivered message, like the send-contract redo budget, §7.5): a later refused message starts the rule from its first entry again, on the model the session is pinned to. `@same` and repeated entries change nothing about stickiness: the session stays on whatever entry last succeeded.

### 8.2 Exhaustion

When every entry of the rule has refused, every try included:

- **chat sites**: `on_exhausted` (owner decision 3): `send_last` (default: send the last attempt; withholding makes the bot look dead), `withhold` (send nothing), `park` (today's hard-refusal outcome, `failed-resumable`). For a hard refusal there is no text to send, so `send_last` parks as today. `withhold` settles the session as `NO_REPLY` with no failure notice, for hard and soft refusals alike;
- **mechanical jobs**: no output (never a refusal written into a summary, caption or diary), no repeated tool nudges against a refusing model.

### 8.3 Stickiness

After a redo the session stays on the redo model for the rest of the session (owner decision 1), for hard refusals handled by a rule too. Today the `refused` set lasts one request, so the next request returns to the model that refused. A sticky refusal pins the session's chain to the rule entry that succeeded (with that entry's own chain fallback as usual).

**Model prompts on every switch** (owner decision 27). Every request uses the per-model preamble and tail (MODEL-PROMPTS) of the member that actually serves it, whatever caused the switch: chain fallover, a rule entry, the next rule entry after another refusal, the sticky pin, the pinned entry's own fallback, and the record turn after a pin. Today a session resolves model prompts once, at start, only for the members reachable from its heads (`loadSessionModelPrompts`, `factory.ts`), and applies them per attempt through `wrapMember`. A rule's models are usually outside those chains, so they must join the resolved set: the session resolves the prompts of every model (and its chain) named by a rule that can match it (its site, agent and, from phase 4, tasks), alongside its heads. A member without a resolved prompt must never be served silently without its configured preamble; a missing source logs `model_prompt_source_missing` as today. The ledger row of a redo request carries the redo member's `model_prompt` and `model_prompt_hash`.

### 8.4 Redo mechanics

- **Hard refusal of one request** (no output): re-issue the same request on the rule's model. The shipped fallover, generalized. Nothing to discard.
- **Discard and fork** (a soft refusal caught at the gate, a refusal at an ending without a send, send-contract exhaustion):
  - **Fork point**: the later of the last delivered message and the last irreversible tool effect (owner decision 2). Everything after it is discarded from the live context; read-only work in that span is redone by the new run.
  - **Tool side effects**: each tool declares whether it is redo-safe (read-only or idempotent) or irreversible. This is the same list as the redo whitelist of SESSION-RECORDS §9 (edits), defined once.
  - **Mechanism**: a tool cannot rewind from inside the agent loop. The gating tool returns a redo sentinel and aborts the run; the runner truncates `agent.state.messages` to the fork point, applies the model pin, and continues.
  - **Sibling tool calls** (owner decision 23). Tool calls of one assistant message execute in parallel by default, so a held send can share its message with calls that run while it is judged. When a sibling had an irreversible effect, the fork point is that assistant message itself, and the new branch keeps it in edited form:
    - the gated call and its tool result are removed;
    - every sibling call stays, with its tool result;
    - the message's text and thinking blocks are dropped: they belong to the judged output (a soft refusal is often stated in the text), and thinking is dropped on a model switch anyway (§8.4 Thinking);
    - the new model continues from the sibling tool results. A tool result is a natural continuation point for any model, and the new model sees what was done without the refused message.
    The runner waits for siblings still executing to settle before forking, because their results belong to the kept message. Several sends in one message are siblings like any other: a send that passed its own gate and was delivered is irreversible and stays; the refused one is removed. When every sibling is redo-safe, the whole message is part of the discarded span and is redone, as for any read-only work after the fork point (owner decision 2).
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

- **Upstream** (generic, default-off): checks and the built-in catalogue, detection, the gate, send-contract diagnostics, rules, redo and branches, statistics, console. No rule and no blocking check ships enabled. Mechanical statistics are on by default. Judged checks need a configured decision model **and** an explicit enable: configuring a decision model for another point (routing, records) never starts paying for a call on every message.
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
- bounded: every checkpoint has a deadline, past it the output proceeds unjudged and the miss is counted. A deadline is a timeout, not a target (owner decision 21): the quantity to minimize is the actual added delay, measured above, and the deadline only bounds the slow tail;
- decision models and state sizes chosen for latency as well as quality (DECISION-MODEL §3.6–§3.7);
- a redo is slower than a success by construction; the rules decide when it is worth it and the statistics show what it costs.

## 14. Non-goals

- Bypassing safety systems. Recovery only ever means asking another model, permitted to do the task under its own policy, with the request unchanged. Nothing rewrites or disguises a request to get past a refusal.
- Rewriting messages in the harness. Revisions are always the agent's own.

## 15. Open questions

None that block implementation. Calibrated during implementation:

1. Per-question thresholds, calibrated against the head decision member on labelled examples (DECISION-MODEL §3.6), and the default decision chain per checkpoint. **Labels come from a model, and whoever runs the calibration never reads the messages.** An offline calibration tool samples history, sends each item to a labeller (any configured chat model; an operator picks one whose data policy already covers chat content), and asks it for a constrained verdict only: the check's label and a reason from a fixed enum, never free text, with an instruction not to reproduce any message content. The tool records the decision member's probability for the same item and reports only item ids, labels, probabilities and aggregates (precision and recall per candidate threshold, score histograms). Hard refusals with an API signal are known positives and anchor the refusal checks. The same tool re-runs after a threshold or question change.
2. The built-in refusal questions per reason and source, and the textual-tool-call and context-mimicry patterns (§7.2), written in phase 1–3 and checked against history by the backfill (§10.2).
3. The owner reviews the starter style catalogue (§4.5) before phase 5 ships it.

## 16. Implementation plan

### 16.1 Phasing

Each phase is deployed as it lands, in a working state (owner decision 24). Pieces of other specs that are not built yet are built inside the phase that first needs them (owner decision 25).

1. **Hard refusals end to end.** Provider categories (the pi-ai patch: `category` and `usage` on the refusal, §5.1), the built-in API-signal catalogue and custom mappings, `refusal_events`, `[[refusal_fallback]]` rules without the `tasks` condition, hard-refusal redo (re-issue on the rule's model), stickiness, `on_exhausted`, mechanical-job redo, the refused-attempt ledger rows, rule models' model prompts (§8.3, with a test that a redo to a model outside the session's chains is served with its preamble and tail). Builds the **tool side-effect list** (redo-safe vs irreversible, shared with SESSION-RECORDS §9).
2. **Send-contract mechanics.** Tagged corrective prompts, `deriveContractEvents`, `contract_attempts`, the history backfill, the nudge redo (§7.5). Builds the model-free part of DECISION-MODEL §5.8 (contract counters).
3. **The gate, observe-only.** Judged checks at every checkpoint, recording only; endings without a send; statistics. Builds **judge-shaped state** (DECISION-MODEL §3.8) with the reasoning sources (§5.5).
4. **Blocking refusal checks.** Soft-refusal redo with discard and fork, sibling handling (§8.4), branches, and the console's branch switcher and gate cards. Builds **multi-label tasks** and the built-in `proactive` task (DECISION-MODEL §5.1a) and enables the rules' `tasks` condition.
5. **Style revise.** The starter catalogue (§4.5), revise verdicts, bounds and override.
6. **Offline diagnosis.** The audit worker (DECISION-MODEL §5.8) for §7.2–§7.3 and the history backfill of judged checks; the model behaviour page (§12.3) with change markers (§12.4).

Until phase 4, a rule with `tasks` is a startup error naming the phase that adds it.

### 16.2 Defaults settled for implementation

| item | default |
|---|---|
| Deadline, outgoing message | 5 s (owner decision 21) |
| Deadline, ending without a send | 15 s |
| Deadline, artifacts and failed rollouts | 30 s (background; nothing user-visible waits) |
| `min_chars` for style checks | 40 (owner decision 22) |
| Revise bounds | 2 consecutive rejections per message, 6 per session |
| Judged checks | off unless a deployment enables them, even with a decision model configured (§11) |
| Holding a send | only when a verdict could act in this session (§6.3) |
| Record turn after a sticky redo | runs on the redo model, like the rest of the session (§8.3) |
| Gate call over the payee's budget | not made; the message is sent unjudged and the miss is counted, never refused for budget |
| Irreversible tools | every message-posting and editing tool, reactions, deletes and pins, workspace and memory writes, sandbox `bash`, browser actions; reads, searches and fetches are redo-safe |
