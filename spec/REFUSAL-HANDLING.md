# Refusal handling: detection, statistics, rule-driven fallback and redo

**Status**: PROPOSAL (2026-10-05). Direction from the owner; most mechanisms below are still open design questions (§10), to be settled in a planning pass before implementation.
**Builds on**: the shipped `refusal` error class (ARCHITECTURE.md §8a "Refusals"): hard refusals are recognized from the provider's stop reason, are never a health strike, are never retried on the member that refused, fall over to the next chain member, and log `llm_refusal`. The session-record turn opts out of fallover.
**Supersedes**: the "Refusal handling" direction recorded in spec/SESSION-RECORDS.md §9, which this document expands.
**Related**: style / LLM-ism enforcement (designed jointly, §4), SESSION-RECORDS (record turn, §3.2), DECISION-MODEL (decision points, Jev), MODEL-FALLBACK, LLM-FAILURE-HANDLING, the "redo" concept of SESSION-RECORDS §9.

## 1. Problem

A model can decline work in two ways:

- **Hard refusals.** The API ends the request with a refusal stop reason (Anthropic `refusal`, a content filter, a provider guardrail). There is no usable output. This is what the shipped `refusal` class handles, and only generically: every hard refusal is treated alike.
- **Soft refusals.** The model answers, but the answer declines, deflects or quietly does less than asked. Nothing in the API marks it. Some models (local ones, for example) never report a refusal stop reason at all.

Refusals also differ by **reason**, and the right reaction depends on it. A refusal over distillation (reasoning extraction) is a property of the model and its vendor's policy, not of the request's legitimacy: another model, especially one without that policy, can do the same work. Other reasons may call for a different reaction, or none.

Today the code cannot tell reasons apart, cannot see soft refusals, keeps no statistics beyond a log line, and its only recovery is "next member of the same chain", applied to every hard refusal, at the request level.

## 2. Goals

1. **Detection of many refusal types**, hard and soft, each classified by reason, with the reason taxonomy designed to be extended (new provider signals, new operator-defined reasons) without code changes where possible.
2. **Statistics, always.** Every detected refusal is recorded per model, reason, task/session type and detection method, whether or not any fallback is configured, so the data exists before it is acted on and so false positives can be judged.
3. **Rule-driven fallback across the board.** Refusal fallback rules apply to every request site: chat-lane reply sessions, proactive sessions, the session-record turn, summarization/condense, diary, captioning, decision-adjacent calls. A rule matches on the task/session type and the refusal reason, and names what to do (which models to try, how many times).
4. **A correct "redo".** Recovering from a refusal that produced output means discarding that output and re-running the task from just before it, on another model (§6).
5. **No rule matches → today's behaviour** (the shipped class: next member of the ordinary chain for hard refusals; nothing for soft ones beyond the statistic).

## 3. Detection

### 3.1 Principle: trusted positives, never relied on for negatives

This is a false-positive vs false-negative trade-off:

- An **explicit API-mediated refusal or filter** (refusal stop reason, content filter, provider guardrail, a provider-supplied category) is 100% trustworthy **when it happens**: no false positives. It is recorded and acted on directly, with no judgement call.
- Its **absence proves nothing**: models refuse softly, some APIs never report refusals, and categories are not always present. So the judged checks of §3.3 run **whether or not** an API signal fired. They are what catches false negatives.

### 3.2 Hard refusals (structured)

- Provider stop reasons, as shipped (`refusal`, `sensitive`, `content_filter`, Responses `incomplete.content_filter`, Bedrock and Google equivalents).
- **Provider-supplied categories**, when present, classify the reason with no judgement call. Claude Code surfaces Anthropic refusals with a category (observed: `[reasoning_extraction]`), which suggests the API's `stop_details` carries one beyond `explanation`; pi-ai currently keeps only `stop_details.explanation` (`anthropic-messages.js` `mapStopReason`), so carrying it through needs a pi-ai patch (the repo already patches pi-ai under `patches/`). Verify the field names against the API first. A useful refinement, not a dependency: detection never relies on it (§3.1).

### 3.3 Judged checks (Jev), everywhere output exists

A decision-model point (DECISION-MODEL machinery; Jev) judges outputs for refusal (declined, deflected, did less than asked) and its reason. It runs at three kinds of checkpoint:

1. **Every outgoing message** (§4): a gate in the send path; the message is held until judged, before `send_message` (or any message-posting tool) takes effect.
2. **Internal tasks' artifacts**: the task's output judged against its instruction. The simplest case is a caption (the caption text itself); it applies equally to outputs built over several tool calls, such as a summary or a diary entry (the finished draft at finalize), and to the session record.
3. **Internal tasks' rollouts, when they appear to fail**: today a summarization run that produces no summary takes the semantic path and is re-run from scratch as a new attempt, up to `max_retries` (ARCHITECTURE.md §9b). That redo becomes gated by a refusal check over the failed rollout: a judged refusal goes to the refusal rules (another model, §5) instead of re-running the same model; no refusal keeps today's redo.

### 3.4 Reasons

- A built-in taxonomy: distillation/reasoning extraction, safety/harm policy, privacy, copyright, persona/roleplay, capability ("can't do that"), unclear.
- **Operator-defined reasons**: like routing's task categories, the config can define extra reasons. In effect each is an operator-written decision-model question; rules can match on them.
- Every detection records how it was detected (`stop_reason`, `provider_category`, `judged`) and its confidence.

## 4. The outgoing-message gate (shared with style enforcement)

Every outgoing message is **gated** on the decision model: it is held and sent only after Jev has evaluated it (or the gate's deadline has passed, below). This is a hard gate in the send path, not a check running beside it. Replies are not special: proactive posts, cross-channel sends and bot-to-bot messages take the same gate. The gate is what makes chat-session refusals recoverable: a refused message is caught before it reaches the chat, so a redo has no irreversible effect to undo (§6.2).

**Designed together with style enforcement.** The gate is the same feature as LLM-ism / style enforcement: one Jev call per outgoing message carries every per-message question (refusal and its reason, formatting and style, LLM-isms, other potential issues, arbitrary operator- or user-defined conditions on messages). Jev bills once per request (per context), not per question, and the context is the same for all of them, so adding questions costs little. Members billed per question (`billing = "per_question"`) change that arithmetic and must be accounted for. The two are specified and built as one gate; this document owns its refusal side.

- **Context**: the outgoing message, the request it answers, and enough recent chat to judge it; designed once and shared by all questions.
- **Two kinds of verdict, two recoveries:**
  - **Redo on another model** (refusal fallback, and any other check whose remedy is a different model): the message is not sent; the turn is discarded and redone on the rule's model (§6.2). Bounded by its fallback chain, explicit or implicit, so it needs no further limit.
  - **Revise in place** (style and similar checks, where a different, less preferred model would likely do worse): the send is stopped and the `send_message` call returns a tool error listing each flagged check with its unique identifier and an explanation for the agent; the agent revises and calls `send_message` again. The same agent and model continue; nothing is discarded.
- **Bounds on revise-in-place** (better a style issue than an unbounded, unnoticed token spend):
  - a limit on consecutive triggers for one message, after which the message goes through regardless of style flags;
  - a per-session limit on total style rejections, after which style checks stop blocking for the rest of the session;
  - both counted in the statistics.
- **Per-check override.** `send_message` takes an argument naming check identifiers to skip for this send. The tool error tells the agent to use it whenever a flagged check is a clear false positive, or the message deliberately shows the flagged pattern (an example, a quotation). Every check therefore has a stable unique identifier. An override is recorded with the statistics.
- **Fail-open**: when the decision model is slow or down, the message goes out at the gate's deadline, unjudged, and the miss is counted (§9). The gate never blocks a message indefinitely.

## 5. Statistics

- A durable record per detected refusal (a table such as `refusal_events`: time, session, request site / session type, model and served member, reason, detection method, confidence, provider explanation, whether a rule fired and its outcome). Written through the single-writer queue.
- Console: per-model refusal rates by reason and site, and the refusals inline in a session's rollout (like decision cards), so a false positive can be seen and judged.
- Collected whether or not any fallback rule is configured or enabled.

## 6. Recovery: rules and redo

### 6.1 Rules

- `[[refusal_fallback]]`-style rules (shape to be designed): match on site / session type (chat rollout, record turn, summarize, condense, diary, caption…), on reason (built-in or operator-defined), optionally on agent; name the models to try (a preference list, like routing cascades), a maximum number of redos, and whether a soft refusal of that reason triggers a redo or only a statistic.
- A model named by a rule still goes through the usual gates (health, budget, per-user limits, context fits, capability).
- If the fallback model also refuses, the next rule entry applies; when all are exhausted the task ends as it would today (no output for mechanical jobs; park for chat sessions on a hard refusal; the soft-refused output stands for chat, or is withheld; to decide).

### 6.2 Redo semantics (the hard part)

How to "redo" depends on where the refusal surfaced:

- **Hard refusal of one request** (no output): re-issue the same request on another model. This is the shipped fallover, generalized to rule-chosen models. Nothing to discard.
- **Soft refusal** (output exists): discard the refused output and **fork the context from just before it**, then continue on the new model:
  - The fork point is the last state before the refusing turn(s): drop the refused assistant turn and anything after it from the live transcript, keep the earlier rollout.
  - Cache is irrelevant: the new model has no cache for this context anyway. Thinking/reasoning blocks of the old model are dropped on replay to a different model as they are today.
  - The discarded branch is kept for inspection (the transcript records the fork; the console shows the redone turn, like the "redo" concept of SESSION-RECORDS §9).
- **Irreversible effects.** A refused turn may already have acted: sent a chat message, posted, edited a file. Options to decide between: judge before irreversible tools run (the outgoing-message gate of §4, the default for chat messages), only redo when the refused turn had no irreversible effects, or redo and then correct (edit/delete the sent message). Mechanical jobs (summary, caption) have no external effects, so for them a redo is always just "discard and rerun".
- **What a redo is billed to** and how it appears in the usage ledger (the refused attempt and the redo are separate requests; refused attempts' spend must be recorded, which today's terminal-error path does not do).

### 6.3 Per-site notes

- **Chat-lane reply sessions**: the main new case. The outgoing-message gate (§4) catches the refused message before it is sent; the fork/redo machinery in the session runner then continues on the rule's model. Interacts with steering, interjections and the forced-completion loop.
- **Session-record turn**: a refused record turn can be redone on another model (spec SESSION-RECORDS §3.2 anticipated this). The other model reads the whole rollout uncached; the record turn's own budget and timeout apply.
- **Summarization / condense / diary / captioning**: the artifact check (§3.3) catches a refused output; a failed rollout is checked before today's redo-from-scratch (§3.3). Discard and rerun on the rule's model; never write a refusal into a summary, caption or diary; no repeated tool nudges against a refusing model.

## 7. Upstream vs deployment

- Upstream (generic, default-off): detection, the reason taxonomy and operator-defined reasons, statistics, the rule engine, the redo machinery, console views. No rule ships enabled; statistics collection is on by default.
- Deployment: which rules exist and which models they name. The first deployment intends to configure rules only for the distillation/reasoning-extraction reason, across every site, and nothing else at first.

## 8. Non-goals

- Bypassing safety systems. Recovery only ever means asking another model that is permitted to do the task; nothing rewrites or disguises a request to get past a refusal.

## 9. Latency

Every change here adds work to the path of a task: a judgement before each outgoing message, artifact checks, rollout checks, redos on another model. **End-to-end task latency must not suffer**, and that is a design requirement for each piece, not an afterthought:

- Measure: the added latency per checkpoint and its share of the task's end-to-end time, per site, recorded alongside the statistics.
- Overlap where possible: run checks concurrently with work that does not depend on them (for example the per-message evaluation alongside other pre-send work), batch all per-message questions into the one evaluation (§4), and judge internal artifacts off the interactive path when nothing waits on them.
- Bound it: each checkpoint has a deadline; past it the output proceeds unjudged (fail-open) and the miss is counted.
- Choose decision models and state sizes for latency as well as quality (DECISION-MODEL fits; state budgets).
- A redo is slower than a success by construction; the rules decide when it is worth it, and the statistics show what it costs.

## 10. Open questions (to settle before implementation)

1. Exact provider fields for refusal categories (Anthropic `stop_details`, others), and the pi-ai patch to carry them.
2. Judged checks: the decision points' state and questions per checkpoint (§3.3); thresholds and calibration per model; precision/recall targets now that API signals are trusted positives only.
3. Rule schema, matching precedence, and how rules compose with the ordinary fallback chain and per-user limits.
4. Fork/redo mechanics in the session runner: fork point, transcript representation of the discarded branch, steering/interjection interplay, irreversible effects policy.
5. Statistics storage and the console views.
6. Ledger: recording refused attempts' spend.
7. The outgoing-message gate, designed jointly with style enforcement: shared context, the question families (refusal, style/LLM-isms, other issues, operator/user conditions), check identifiers, which checks redo vs revise, the consecutive and per-session limits, and the override argument.
8. Which internal tasks get artifact checks and rollout checks first, and where in each worker the check sits.
9. Latency budgets per checkpoint, fail-open deadlines, and how latency is measured end to end (§9).
