# Refusal handling: detection, statistics, rule-driven fallback and redo

**Status**: PROPOSAL (2026-10-05). Direction from the owner; most mechanisms below are still open design questions (§8), to be settled in a planning pass before implementation.
**Builds on**: the shipped `refusal` error class (ARCHITECTURE.md §8a "Refusals"): hard refusals are recognized from the provider's stop reason, are never a health strike, are never retried on the member that refused, fall over to the next chain member, and log `llm_refusal`. The session-record turn opts out of fallover.
**Supersedes**: the "Refusal handling" direction recorded in spec/SESSION-RECORDS.md §9, which this document expands.
**Related**: SESSION-RECORDS (record turn, §3.2), DECISION-MODEL (decision points, Jev), MODEL-FALLBACK, LLM-FAILURE-HANDLING, the "redo" concept of SESSION-RECORDS §9.

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
4. **A correct "redo".** Recovering from a refusal that produced output means discarding that output and re-running the task from just before it, on another model (§5).
5. **No rule matches → today's behaviour** (the shipped class: next member of the ordinary chain for hard refusals; nothing for soft ones beyond the statistic).

## 3. Detection

### 3.1 Hard refusals (structured)

- Provider stop reasons, as today (`refusal`, `sensitive`, `content_filter`, Responses `incomplete.content_filter`, Bedrock and Google equivalents).
- **Provider-supplied categories.** Some providers say why. Claude Code surfaces Anthropic refusals with a category (observed: `[reasoning_extraction]`), which suggests the API's `stop_details` carries one beyond `explanation`. pi-ai currently keeps only `stop_details.explanation` (`anthropic-messages.js` `mapStopReason`), so carrying the category through needs a pi-ai patch (the repo already patches pi-ai under `patches/`). Verify the field names against the API before designing on them. A structured category maps directly to a refusal reason with no judgement call.

### 3.2 Soft refusals (judged)

- A decision-model point (DECISION-MODEL machinery; Jev) judges an output against the request: did the model decline, deflect, or do less than asked, and for which reason (from the reason taxonomy, including operator-defined reasons).
- Open: which outputs are judged (every assistant turn, only the final reply, only outputs over some size, only some session types), the cost of judging, and the point's state (request + output, with how much context).
- For chat sessions, the natural checkpoint is the reply itself: the `send_message` (or `no_reply`) call, before it executes. Judging there means a refused reply can be stopped before it reaches the chat (see §5.2).

### 3.3 Reasons

- A built-in taxonomy: distillation/reasoning extraction, safety/harm policy, privacy, copyright, persona/roleplay, capability ("can't do that"), unclear.
- **Operator-defined reasons**: like routing's task categories, the config can define extra reasons. In effect each is an operator-written decision-model question; rules can match on them.
- Every detection records how it was detected (`stop_reason`, `provider_category`, `judged`) and its confidence.

## 4. Statistics

- A durable record per detected refusal (a table such as `refusal_events`: time, session, request site / session type, model and served member, reason, detection method, confidence, provider explanation, whether a rule fired and its outcome). Written through the single-writer queue.
- Console: per-model refusal rates by reason and site, and the refusals inline in a session's rollout (like decision cards), so a false positive can be seen and judged.
- Collected whether or not any fallback rule is configured or enabled.

## 5. Recovery: rules and redo

### 5.1 Rules

- `[[refusal_fallback]]`-style rules (shape to be designed): match on site / session type (chat rollout, record turn, summarize, condense, diary, caption…), on reason (built-in or operator-defined), optionally on agent; name the models to try (a preference list, like routing cascades), a maximum number of redos, and whether a soft refusal of that reason triggers a redo or only a statistic.
- A model named by a rule still goes through the usual gates (health, budget, per-user limits, context fits, capability).
- If the fallback model also refuses, the next rule entry applies; when all are exhausted the task ends as it would today (no output for mechanical jobs; park for chat sessions on a hard refusal; the soft-refused output stands for chat, or is withheld; to decide).

### 5.2 Redo semantics (the hard part)

How to "redo" depends on where the refusal surfaced:

- **Hard refusal of one request** (no output): re-issue the same request on another model. This is the shipped fallover, generalized to rule-chosen models. Nothing to discard.
- **Soft refusal** (output exists): discard the refused output and **fork the context from just before it**, then continue on the new model:
  - The fork point is the last state before the refusing turn(s): drop the refused assistant turn and anything after it from the live transcript, keep the earlier rollout.
  - Cache is irrelevant: the new model has no cache for this context anyway. Thinking/reasoning blocks of the old model are dropped on replay to a different model as they are today.
  - The discarded branch is kept for inspection (the transcript records the fork; the console shows the redone turn, like the "redo" concept of SESSION-RECORDS §9).
- **Irreversible effects.** A refused turn may already have acted: sent a chat message, posted, edited a file. Options to decide between: judge before irreversible tools run (the reply checkpoint of §3.2), only redo when the refused turn had no irreversible effects, or redo and then correct (edit/delete the sent message). Mechanical jobs (summary, caption) have no external effects, so for them a redo is always just "discard and rerun".
- **What a redo is billed to** and how it appears in the usage ledger (the refused attempt and the redo are separate requests; refused attempts' spend must be recorded, which today's terminal-error path does not do).

### 5.3 Per-site notes

- **Chat-lane reply sessions**: the main new case. Needs the reply checkpoint and the fork/redo machinery in the session runner; interacts with steering, interjections and the forced-completion loop.
- **Session-record turn**: a refused record turn can be redone on another model (spec SESSION-RECORDS §3.2 anticipated this). The other model reads the whole rollout uncached; the record turn's own budget and timeout apply.
- **Summarization / condense / diary / captioning**: discard and rerun; never write a refusal into a summary, caption or diary; no repeated tool nudges against a refusing model.

## 6. Upstream vs deployment

- Upstream (generic, default-off): detection, the reason taxonomy and operator-defined reasons, statistics, the rule engine, the redo machinery, console views. No rule ships enabled; statistics collection is on by default.
- Deployment: which rules exist and which models they name. The first deployment intends to configure rules only for the distillation/reasoning-extraction reason, across every site, and nothing else at first.

## 7. Non-goals

- Bypassing safety systems. Recovery only ever means asking another model that is permitted to do the task; nothing rewrites or disguises a request to get past a refusal.

## 8. Open questions (to settle before implementation)

1. Exact provider fields for refusal categories (Anthropic `stop_details`, others), and the pi-ai patch to carry them.
2. Soft-refusal judging: which outputs, when, at what cost; the decision point's state and questions; thresholds and calibration per model.
3. Rule schema, matching precedence, and how rules compose with the ordinary fallback chain and per-user limits.
4. Fork/redo mechanics in the session runner: fork point, transcript representation of the discarded branch, steering/interjection interplay, irreversible effects policy.
5. Statistics storage and the console views.
6. Ledger: recording refused attempts' spend.
