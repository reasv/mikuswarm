# Per-User Cost Limits & Model Selection

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §8g/§8f; retained for review. Shipped end-to-end across both slices: `user`+`room`+`space` matching with OR-list / any-ancestor dimensions, the per-field cascade, the constraint-set budget + multi-window partitioned counters, the partition template (per-user + shared group/room/homeserver/**space** pools) with the `budget_partition` + `requested_model_id` + `room_id` + `space_id` ledger columns (schema **v32**) and seed indexes, per-attempt dynamic selection (affordable ∧ healthy ∧ fits) with **exact cache-aware estimation** + output-cap degradation + the **§5.4 re-drive** (a budget-truncated turn is re-issued on the next-cheaper model, not delivered), Gate A + Gate B + the dynamic §8d ceiling applied uniformly to fresh launch / reply-resume / follow-up-resume / manual recovery, the storage filters, the richer refusal templating, and the console surface (meters **and** the currently-selected model per active user). `space` matching (§11) extends `matrix-core` with `parent_space_ids` (all legitimate parents, best-first) via NAPI, resolved + frozen at admission only when a rule references space. **Deferred:** user model choice (§4.3 — designed-for, no UI). Per §16, the maintainer chose: `viable_min` = **256, configurable** (`agent.user_limit_min_output_tokens`); room scoping via a **derived `room_id` column**; `{display_name}` from the **inbound sender name**; transitive nesting starts **direct parents only**.
**Date**: 2026-06-22 (reconciled against shipped MODEL-FALLBACK, commit `1bba587`, schema v30); implemented 2026-06-26 (schema v32)

> **Sequencing note (post-MODEL-FALLBACK).** This spec was originally drafted while
> MODEL-FALLBACK was still a proposal, and hedged on which feature would land first.
> MODEL-FALLBACK has now **shipped first** (schema **v30**, resolver
> `src/agent/model-fallback.ts`, `BudgetEngine.checkAdmissionChain`). That resolves
> the open sequencing question the *opposite* way several sections assumed, with
> concrete consequences folded into §4.2, §6.1, §6.2, §7, §8.3, and §15: the
> `usage_events.logical_model_id` column already exists and records the **served**
> member; per-user `models` reference the unified registry where **fallback chains
> already exist**, so requested ≠ served is possible on day one; and
> `requested_model_id` can no longer ride MODEL-FALLBACK's (already-shipped) v30
> migration — it needs its own migration in this feature's PR, in the **first slice**.

---

## 1. Motivation & scope

The harness already has three cost-control layers:

- **§8d** — a per-*session* USD ceiling (agent-loop + tool lanes, combined in memory), static, resolved from `agent.max_session_cost_usd` with a per-session-type override. A coarse "max cost per session" safety brake.
- **§8e** — period `[[limits]]`: an unordered set of **aggregate** caps, each counting *all* spend in its scope, ANDed together, gating every lane including background work (summary/diary/caption/embed).
- **§8f** — the unified `usage_events` ledger that both of the above read, recording per-event **actual** cost, `trigger_sender_id`, `timeline_key`, and `logical_model_id` (shipped with MODEL-FALLBACK, schema v30 — the **served** chain member actually billed, backfilled `= model_id` for legacy rows).

This spec adds, for the **human-triggered agent loop only**, two intertwined things:

1. **Per-user spending bounds** — every distinct user separately bounded (default cap, or user/room/space-specific cap, exemption, or ban). Money is **fungible**: the natural bound is a *total* over all models, optionally refined by per-model-class sub-caps. The same machinery generalizes — via a **partition template** (§3.5) — to **shared pools** (per-group / per-room / per-space) that bound *total* human-loop spend across a set of users at once, giving the operator a way to cap aggregate cost **without** denying any individual user. Per-user is just the default partition (`{user_id}`); a shared pool is any partition that renders to a value common to several users.
2. **Per-user model selection** — different users get different models. Two flagship uses:
   - **Upgrade** — an admin, or a specific channel, gets a frontier model while the public gets a cheaper one.
   - **Graceful degradation** — a user who exhausts a premium allowance keeps interacting on a cheaper model instead of being denied outright.

These are not two systems bolted together. Model selection is the general operation ("which model does this trigger get?"); the cost bound is what *drives descent* through the user's model set. Upgrade is the zero-descent case (one preferred model, never falls); degradation is the multi-model case; a hard deny is "fell off the end." They unify into **three orthogonal layers** (§2).

This is a **separate mechanism** from §8e `[[limits]]` — partitioned counters, a per-user cascade, a selection/degradation action, and a narrower enforcement surface (human loop only). The two never merge into one rule list.

### Non-goals (explicitly out of scope)

- **Background-inclusive** total-per-room / per-space caps (sum of *everyone's* spend *including background work* — summary/captioning/embedding). That version must gate background lanes and interacts with the §8e dependency cascade, so it is a new **selector dimension on the aggregate `[[limits]]`** (§8e), *not* this list. See §13. **The human-loop cousin is in scope:** per-group / per-room / per-space pools that count only *triggered agent-loop* spend are expressed here as a partition template (§3.5); only the background-inclusive total is excluded.
- **Per-room model upgrade/downgrade** for background work (diary/summaries run on room timelines and could take a per-room model). The unified model registry (MODEL-FALLBACK §2.3) makes it possible; out of scope here.
- **Merging outage-fallback and per-user selection into one config axis.** They stay distinct (chain authored on the model; preference authored on the user) and compose hierarchically at runtime — preference-outer, chain-inner (§4). They touch in exactly one controlled spot: a *fully exhausted* inner chain lets the outer loop advance as a last resort (§4.2/§7). That is composition, not merging.
- Changing §8d or §8e behavior except where §9 makes the §8d ceiling dynamic.

---

## 2. The three layers

The design separates three concerns that an earlier draft conflated into a single "tiered cap." Keeping them orthogonal is what makes both degradation *and* (future) user-chosen models fall out of one structure.

| Layer | Question it answers | Assumes order? |
|---|---|---|
| **Budget** (§3) | How much may this user spend, on which model-classes, in which windows? | **No** — a constraint *set*, ANDed |
| **Estimation** (§5) | Can model `m` complete a turn for this user within the remaining budget *right now*? | n/a |
| **Selection** (§4) | Among the models this user can currently afford, which one do we use? | **Only here** — a preference order (degradation), swappable for user choice |

The budget layer is fungible and order-free (you can spend a total any way you like). The *only* place an order lives is selection, and it is deliberately isolated so that swapping automated degradation (a preference order) for **user model choice** (let the user pick any affordable model) is a change to the picker alone — the budget and estimation layers are untouched. Designing it this way is what avoids a redesign if user choice is added later.

Degradation is then just **automated selection over the affordable set**: try the preferred model; if it is no longer affordable, the next preference inherits the turn — *provided the budget reserved headroom for it* (§3.3).

---

## 3. Budget layer — a partitioned constraint set

### 3.1 Constraints, not thresholds

A user's budget is a **set of constraints**, each `{ models?, window, max_usd }`, **ANDed** (a request is allowed only if it fits under *every* covering constraint), and **partitioned per user** (one running counter per `(constraint, user)`). This is precisely §8e's aggregate-AND model, partitioned per user — *not* a sequence of tiers. (Per-user is the *default* partition; §3.5 generalizes the counter key to a rendered template, of which `{user_id}` is the degenerate case.)

- A constraint with **no `models`** is the **fungible total**: "≤ $5/day on anything." This is the primary, default, common case.
- A constraint **scoped to `models = [...]`** is a **sub-cap** *within* the total. Because constraints intersect headroom, a sub-cap can never *raise* exposure — the total is always the ceiling. Sub-caps only *carve* the fungible total.

This directly answers the fungibility objection: limiting individual models for their own sake is a narrow, questionable case; the **total** is the natural bound. Sub-caps exist for exactly one purpose — **to reserve headroom for cheaper continuation** (§3.3) — not to police models.

### 3.2 Multiple windows are first-class

Because the budget is a constraint set with a per-constraint `window`, "daily **and** monthly" is just two constraints — exactly how §8e already expresses it, a capability the scalar-`max_usd` draft lacked. The `window` sub-schema is reused verbatim from §8e's `LimitWindowSchema` (`{ type = "rolling", duration }` or `{ type = "calendar", period, tz? }`). Counters are keyed per `(constraint, user)`; constraints sharing a window still hold independent per-user counters because their `models` scope differs.

> **A and B were the same all along.** An earlier draft weighed "per-tier caps" (A) vs "cumulative thresholds on one counter" (B). For a *shared* window they are the same caps in different coordinates — cumulative boundary `b_i = Σ_{j≤i} c_j` (prefix sum of incremental caps). They diverge only with *per-window* distinctions, which is the multi-window capability above. So there is no A-vs-B choice; there is only "how many windows," and the constraint set handles any number.

### 3.3 Degradation requires a sub-cap (and that is the justification for per-model caps)

With *only* a fungible total, a preference order `[premium, cheap]` burns the entire total on premium, then `cheap` is also unaffordable (the total is gone) → deny. All-or-nothing. **To degrade, premium must be sub-capped below the total**, so the difference is reserved for `cheap`:

```
total:        ≤ $5/day  (all models)
premium cap:  ≤ $2/day  (models = ["opus-premium"])
→ premium may use $2 of the $5; the remaining $3 is guaranteed for cheaper continuation.
```

So the per-model sub-cap is not "limit model X"; it is "premium may use at most $X *of the user's $Y total*." A deployment that wants no degradation simply writes no sub-cap — a hard total is a legitimate config, not a degenerate one.

### 3.4 Deny, exempt, and the `max_usd` shorthand

- **Exempt / unlimited** — no constraints cover the user → everything is affordable → the preference head is always used.
- **Hard deny / ban** — a covering total constraint with `max_usd = 0` (nothing is ever affordable), or an empty model set.
- **Shorthand** — a top-level `max_usd` + `window` on a rule is sugar the normalizer expands into a single fungible-total constraint, preserving the simple "just a cap on the default model" case. The old sign-state semantics survive as sugar: `max_usd = 5` → one $5 total; `max_usd = 0` → ban; `max_usd < 0` → exempt (no constraint emitted).

### 3.5 Partitioned counters: the partition template

§3.1 keys each counter per `(constraint, user)` — the per-user partition is the **default, not the only option**. Generalize it: every constraint carries a **`partition`** field, a **template string rendered from the trigger context** (§10), and its counter is keyed per `(constraint, rendered-key)`. The two axes are now fully orthogonal: **the matcher (§8.1) scopes *whose* spend the constraint counts; the partition template scopes *what meter* that spend shares.**

| `partition` | meter granularity |
|---|---|
| `"{user_id}"` *(default)* | per user — §3.1's behavior, now just the degenerate template |
| `""` *(constant)* | one global human-loop meter (the §8e-aggregate analogue, human loop only) |
| `"staff"` *(any literal)* | one named shared pool |
| `"room:{room_id}"` | one pool per room |
| `"space:{space_id}"` | one pool per space (Phase 2 — §11) |
| `"hs:{homeserver}"` | one pool per homeserver |

A **group budget** — the operator's "bound *total* spend without shutting everyone off" — is simply a constraint whose partition renders to a value **shared across users**. Because that constraint is ANDed with the user's own per-user constraints (§3.1), a request must fit under *both*: personal headroom **and** the shared pool. When the shared pool is the binding constraint, every member fails the affordability predicate (§4.2 (1)) on the premium model **at once** and **degrades together** to the next preference — the rollout continues on the cheaper model instead of the agent being denied for the whole group. A shared-pool premium **sub-cap** (`models = [...]` with a shared partition) reserves group headroom for that cheaper continuation, exactly as §3.3 does per user.

This is why a separate `[[budget_groups]]` table is **not** introduced: group membership is the set of triggers whose cascade (§8.1) resolves to a rule carrying the shared-pool constraint, and the meter key is computed from the same `ctx` the matcher already built. A static name-table could express named pools but **not dynamic ones** (`room:{room_id}` spawns a meter family from one rule); a template is strictly more expressive and lives naturally on the constraint. Members spanning *different selection rules* simply repeat the shared-pool constraint on each rule — the caps are per-constraint and ANDed against the one shared counter (below), so this is coherent, not contradictory.

**Template variables** are the fields resolved at Gate A from `inbound` (§10): `{user_id}`, `{room_id}`, and `{homeserver}` (the suffix after the first `:` of the user id). `{space_id}` requires the §11 native resolution and is **Phase 2** — a `{space_id}` template before then is a normalizer fatal (same gate as the `space` *match* field).

**Caps belong to the constraint, not the meter.** Two constraints may render the same key and share its counter; each independently ANDs *its own* cap against that shared spend (the affordability `min` of §5.3 already does this), so divergent caps on one key are well-defined — a request satisfies every covering constraint. The normalizer **warns** when two constraints share a *fully-static* key with different caps (a likely mistake); for dynamic suffixes the author owns the keyspace via the literal prefix (`"premium-room:{room_id}"` and `"room:{room_id}"` are distinct meters by construction). Counter cardinality is ≤ the per-user case already paid for (one meter per active room/space ≤ one per active user), so no new scaling concern.

> **Where this sits relative to §8e / §13.** This is the **human-loop** pooled budget — per-group / per-room / per-space caps that count only triggered agent-loop spend, reusing *all* of this spec's machinery (cascade, affordability, degradation, windows, templated refusals). The §8e aggregate family remains the home for the **background-inclusive** total — one that also gates summary/diary/caption/embed and rides the §8e dependency cascade (§13). Same arithmetic, different lanes: a partition template here never touches background work.

---

## 4. Selection layer — per-user model set & preference order

### 4.1 Selection lives in `[[user_limits]]`, NOT in fallback chains

A rule names the user's **ordered model set** via `models = [...]`, referencing `[models.*]` registry blocks **by name** — virtual or real, and freely including models *better* than the session-type default. Different users get entirely different sets. Omitting `models` defaults the set to `[<session-type default model>]` (today's behavior: a cap on the default model, no selection).

This is deliberately **not** the MODEL-FALLBACK chain:

- The fallback chain maps one model → physical alternates for **outages**. Per-user selection maps a **user** → the models they may use, often *upgrades*, per-user-distinct by design.
- Encoding selection as fallback would force a bespoke virtual model per user-set **and** push the sub-caps (§3.1) onto *physical* model names, destroying the `"opus-premium"` abstraction sub-caps depend on.

The two are orthogonal axes that **compose hierarchically** at request time (§6.2): the per-user preference order is the **outer** loop (which logical model), each model's MODEL-FALLBACK chain is the **inner** loop (which physical endpoint for that model). The outer loop only advances when an inner chain is fully exhausted (§4.2).

### 4.2 The preference order *is* the degradation order — resolved per attempt

`models = ["opus-premium", "glm-cheap"]` is read most-preferred-first. Selection runs **per Layer-0 attempt**, layered *outside* the seam MODEL-FALLBACK already resolves on (so it re-evaluates between requests, *including across tool calls* — each tool round-trip is a fresh request).

**Build structure (concrete, post-MODEL-FALLBACK).** `buildModelFallback` (`src/agent/model-fallback.ts`) builds **one** chain with its capability pre-filter and min-over-chain context ceiling **resolved once at build time** — it is not structured to switch *which logical model's chain* mid-rollout. So per-user selection does **not** reuse a single built fallback; instead, **build one `BuiltModelFallback` per preferred model at session create** (the preference set is small and known at create — §6.1). The per-attempt outer selector then picks *which* pre-built fallback to dispatch; that model's own (already-resolved) ceiling and capability filter govern the attempt. This keeps MODEL-FALLBACK's "ceiling resolved once" invariant intact per chain while letting the *outer* logical-model choice vary per attempt.

A preferred model is **selectable** only if its chain survives MODEL-FALLBACK's **capability pre-filter** (e.g. an image session requires a multimodal member — derived from raw session inputs at create time, §3 #1 amendment in MODEL-FALLBACK); a model whose whole chain lacks the needed capability is simply absent from the set, like an unhealthy one. Among the selectable models, the chosen one is the **first that satisfies all three predicates**:

1. **Affordable** — the §5 per-user estimate yields `max_output > viable_min` against the live partitioned counter. (This is the *outer*, per-user budget. MODEL-FALLBACK's chain still applies its own *inner* §8e `isModelAvailable` per member — `chooseChainMember` already folds it into member viability — so both budgets compose: per-user outer, §8e-aggregate inner.)
2. **Healthy** — the model has *some* up member in its own outage chain (the inner loop). Concretely: dispatching the model's pre-built fallback does **not** yield `chooseChainMember` `reason: "all-unhealthy"` (the resolver routes to the head and reports that reason when no member is up — there is no separate "is any member up" API to add; read the reason). A model whose whole chain is down is unavailable, and the outer loop advances.
3. **Fits** — `context_window ≥ current rendered context` (the cheap per-model check of §6.2 — compared against the selected model's pre-built min-over-chain ceiling; a target that cannot hold the accumulated context is skipped, exactly like an unhealthy or unaffordable one).

When nothing in the set satisfies all three → terminal (deny if the cause is budget; park/fail if the cause is outage — §6.2).

This single per-attempt resolution yields **both** kinds of degradation transparently, mid-rollout, with no rebuild:

- **Budget degradation** — `opus-premium`'s sub-cap exhausts at request 6 → it fails predicate (1) → `glm-cheap` inherits request 6 onward and *the rollout finishes on cheap* instead of being guillotined. This matters because sessions are one-shot (no "next turn" to catch an across-session degrade — most sessions are a single rollout).
- **Cross-axis outage fallthrough (last resort)** — `opus-premium`'s whole chain is down → it fails predicate (2) → `glm-cheap` inherits. The outer loop advances *only* after the inner chain is exhausted, so an outage's *first* response is still a same-tier alternate within the chain (§7); dropping a quality tier is the last move before dying, not the first.

### 4.3 User model choice (future — designed for, not built)

Because selection is isolated from budget/estimation, adding user choice is a swap of the picker: instead of "first affordable in preference order," choose "the user's requested model, if affordable; else fall through / refuse." Enforcement (the constraint set + affordability estimate) is identical. There is presently **no interface** for a user to express a choice; the point is only that the budget design does not preclude it.

---

## 5. Estimation layer — what actually bounds overshoot

### 5.1 Why post-hoc is not enough

The shipped §8d/§8e pre-flight (`checkCostBudget`, `factory.ts`) compares **already-observed** combined cost against the ceiling *before* each request, and explicitly **never blocks the first request** (cost is 0 before any commit). For a coarse per-session brake this is fine. For a per-user budget it is not: a single frontier-model request with a large context can cost **dollars** (≈$5 for 200k in + 32k out at Opus-class pricing), so "overshoot ≤ one request" is no real bound, and the *first* request of a fresh large-context session — typically the most expensive — is entirely ungated. **Forward estimation is therefore load-bearing, not optional**, and it is the only thing that bounds per-user overshoot.

### 5.2 What is estimable (and what isn't)

Overshoot is bounded *tightly* because almost everything is known, not guessed:

- **Output is bounded by capping, not by prediction.** Set the request's `max_tokens` to what the remaining headroom can pay for. No need to predict output length.
- **Tool-call count is irrelevant.** Each tool round-trip is its own LLM request that re-enters this same gate; cost cannot accumulate unbudgeted between gates.
- **Prior context is measured, not estimated.** §8b records each request's actual token usage. Request N's input = (measured input of N−1) + (measured output of N−1) + (tool results, held locally and tokenized with the calibrated §9 tokenizer) + framing. The **only** estimation error is the tokenizer delta on the *incremental* new material — small and bounded, never the whole context.

### 5.3 The per-request computation

Before each request (and at admission for the first, §6.1):

```
remaining   = min over the user's covering constraints of (cap − this-user counter)   [§3]
input_cost  = (measured prior ctx tokens + tokenize(new output + tool results + framing)) × input_price(model)
max_output  = floor((remaining − input_cost) / output_price(model))
if max_output ≤ viable_min  → model m cannot complete a turn within budget → m is UNAFFORDABLE
else issue with max_tokens = min(model_default_max, max_output)
```

`input_price` / `output_price` are the **requested virtual model's face cost** (§7). Optional caching refinement: if the time since the session's last request is within the prompt-cache TTL (~5 min), price the prior-context portion at cache-read and only the new material at cache-write; otherwise assume cache-write throughout (conservative — slightly under-utilizes, never under-charges).

### 5.4 An output-capped response is a *failed* turn

If a request stops because it hit the budget-derived `max_tokens` (`stop_reason` = max-tokens/length), the turn is treated as **failed**, not delivered. In a tool-call-driven loop the raw output is never user-facing — it feeds the next tool/turn — so a truncated one is unusable anyway, and valid turns are frequently tiny (single-digit output tokens are common). This makes the output cap do double duty:

- **It bounds overshoot** (the request cannot cost more than its capped output allows).
- **It is the precise degradation trigger** — not "spend crossed a threshold," but "the remaining budget can no longer buy a *complete turn* at this model," which is exactly the right question.

A budget-capped result **triggers re-selection** (§4.2): the current model failed predicate (1), so the per-attempt resolver moves to the next affordable preference and the rollout continues there. It becomes a true `content`-class terminal (no retry burn) only when *no* preference is affordable — the bottom of the order. So the output cap is the degradation *trigger*, not a session-killer; it kills only at the floor.

---

## 6. Enforcement

Per-user limits gate **only the human-triggered agent loop and its tools** — never background work (summary/diary/caption/embed/proactive). Proactive sessions have no triggering user and skip every gate.

### 6.1 Gate A — admission & initial selection (`launchSession`)

Beside the existing §8e admission gate, resolve the per-user rule for `ctx = { userId, roomId, spaceId? }` (built from `inbound` exactly as §10), then run the §4.2 per-attempt resolver for the **first** request. Build the per-preferred-model `BuiltModelFallback` set here (§4.2), one per entry in `models`.

The §8e gate is now `engine.checkAdmissionChain(sessionType, modelId, chainLogicalIds)` (MODEL-FALLBACK §6.1 — `checkAdmission` is retained but gates the *head* only and is documented "Prefer `checkAdmissionChain`"). This composes naturally: each per-user preferred model is itself a chain, so the per-user admission passes the **selected** model's chain logical ids — a model-scoped cap on its primary won't refuse a session an in-budget fallback member could serve.

1. Among `models` (preference order), pick the first that satisfies affordable ∧ healthy ∧ fits (§4.2 — and surviving the capability pre-filter) for the first request's estimate against the live partitioned counters.
2. This is the session's **initial** model (overriding the session-type default). It is *not* frozen — the resolver re-runs each subsequent attempt (§6.2). Starting an already-over-budget user on cheap from request 1 is also the cheapest place to be on a smaller model (context is smallest at the start and only grows).
3. If *no* model qualifies (or a covering total is `max_usd = 0`): do **not** spawn — mark discarded, drain the next queued trigger (identical to the §8e refusal path), and post the templated `trigger_rejection_message` if one resolves (proactive silent).

`spaceId` (and the resolved rule) *are* frozen on the session — the room never changes — but the model choice is live. `userId = inbound.trigger?.triggeredBy?.id ?? inbound.event.sender?.id` (the value `recordUsageEvent` already uses).

### 6.2 Gate B — per-attempt selection & pre-flight (`checkCostBudget`, `factory.ts`)

The hook already runs before every request — the request-layer seam exists; only the computation changes. **Selection is dynamic per attempt**, not frozen: each request re-runs the §4.2 resolver, so budget and outage degradation both happen transparently mid-rollout (the rollout finishes on the degraded model rather than being guillotined — essential given one-shot sessions). Beside the §8d ceiling and §8e `engine.check`:

1. Re-resolve the preferred model via §4.2 (affordable ∧ healthy ∧ fits).
2. For the chosen model, set the request's `max_tokens` to its `max_output` (§5.3) and proceed.
3. If no model qualifies → `content`-class terminal (no retry burn) — a deny if the floor cause is budget, a park/fail if it is outage.

This is also the cross-session concurrency backstop: Gate A's headroom is an admission snapshot, but two concurrent sessions from one user could each be admitted; the per-attempt check reads the **live partitioned counter** (incremented across all the user's sessions via `record()`, §8), so combined overspend is caught mid-flight.

**Context handling is the simple option, no special path.** Read/output budgets are sized to the **current selection's own outage chain** — i.e. the min-over-chain ceiling of *that model's* pre-built `BuiltModelFallback` (§4.2), each already resolved once at create time exactly as MODEL-FALLBACK does (the preference order never widens any single chain's ceiling). A degradation target is consulted only at selection, via the `fits` predicate (§4.2): if the accumulated context exceeds its `context_window`, it is skipped like any other unavailable model — fall to the next preference, terminal if none fits. This needs no min-over-reachable ceiling and no dynamic recompute. In practice it rarely bites: degradation targets are cheap models, and cheap-model windows are now 128k/200k/1M-class — usually ≥ the premium window, so a context that fit premium fits the target too. A huge-context session that crosses budget and *cannot* fit any cheaper model simply terminates — acceptable (it is out of budget at any model that can hold the conversation).

### 6.3 Dynamic §8d ceiling (`resolveSessionCostCeiling`, `factory.ts`)

Make the per-session ceiling dynamic so the existing §8d soft-warn interjection (`cost_warn_fraction`) and hard pre-flight automatically reflect the user's *remaining* headroom:

```
effectiveCeiling = min( staticCeiling ?? ∞ , userTotalHeadroom ?? ∞ )
```

where `userTotalHeadroom` is the remaining headroom of the user's binding **total** constraint (the min over covering constraints). Threaded through session creation, resume start, and `launchSession`. An exempt user contributes ∞ (no change to today). The usage-warning interjection needs none of the estimation machinery — it reads the live counter at the rollout layer.

---

## 7. Cost identity under fallback — gate on virtual, count actual, estimate on face

Selection (§4) and outage-fallback (MODEL-FALLBACK) compose, so a request has up to three identities: the **requested virtual model** (selection's choice), the **served logical model** (the fallback member actually used), and the **physical** `(endpoint, id)` (health + the cost factors that produced the actual bill). The three rules:

- **Gating / scoping → requested virtual model name.** A sub-cap scoped to `opus-premium` owns all spend the user incurs under that assignment, *independent of fallback status*. The partition key is the virtual name.
- **Counting → actual cost of the actual served model.** This is already what `usage_events` records (actual tokens × served-model cost). The per-user counter sums actual dollars; only the partition key is virtual.
- **Estimation → requested virtual model's face cost.** At estimate time fallback has not yet resolved, so estimate on the head's cost. The gap self-corrects (counting uses actual cost), and since chains are authored non-increasing in cost, estimating on the head is conservative (never under-charges). Fallback is the outage exception, not the steady state.

**Recording the requested model resolves the attribution split — no functional restriction.** Under active fallback the served `logical_model_id` differs from the requested virtual model, which would otherwise split a sub-cap's counter (the backup member's spend escaping the `opus-premium` sub-cap). The fix is to record the **selection's chosen model** as its own ledger identity, `requested_model_id`, and scope the per-user counters on *it* — so `opus-premium`'s outage backup still counts toward the `opus-premium` sub-cap, exactly matching "gate on the virtual name, ignoring fallback status." **Per-user-assigned models keep their own outage chains; nothing is restricted.**

Two non-options make clear why the column is the answer:

- **`logical_model_id` cannot be reused** — MODEL-FALLBACK deliberately defines it as the *served* member (so each logical model is independently budgetable in §8e). That is the opposite attribution direction from what a per-user sub-cap needs (the *requested* head).
- **The per-user preference order must not be the outage fallback's *first* response** — the two axes degrade in different directions. An outage of `opus-premium` should first fail over to a *same-tier* alternate within its own chain (different endpoint/provider, comparable quality), not immediately drop the user to the budget-cheap model. The preference order only catches an outage as a **last resort, after the inner chain is fully exhausted** (§4.2, predicate 2) — survival beats dying, but it is the floor, not the reflex. This is exactly why the two stay separate config axes (chain on the model, preference on the user) rather than one merged list.

**Sequencing — resolved (MODEL-FALLBACK landed first).** This column is needed exactly when per-user models can carry fallback chains. The original draft hedged: "if per-user limits land first, there are no chains yet, so requested == served and the counter scopes on `logical_model_id` in the interim." **That interim no longer exists.** MODEL-FALLBACK shipped first (schema **v30**), so per-user `models` reference the unified registry where fallback chains *already exist*, and `usage_events.logical_model_id` already records the **served** member (ARCHITECTURE.md §8f: the agent loop "stamps the chain member actually billed"). Therefore requested ≠ served is possible from the first day per-user limits ship, and a sub-cap scoped to `opus-premium` would silently **undercount** whenever its chain falls back. Two consequences:

- **`requested_model_id` is part of the FIRST slice, not "Later."** It cannot ride MODEL-FALLBACK's `logical_model_id` migration — that migration (v29→v30) has already shipped and added only `logical_model_id`. `requested_model_id` needs its **own** migration (the next version after v30) authored in this feature's PR, and the per-user counters scope on it from day one. (In steady state — no active outage — requested == served, so the column is redundant *then*; but the chains exist, so it is not optional.)
- The alternative — restricting first-slice per-user `models` to chainless registry blocks and scoping on `logical_model_id` — is **rejected**: it would forbid exactly the premium-with-outage-chain upgrade case (§4.1) that motivates per-user model assignment, and would need a normalizer guard that bans a legitimate, already-supported registry shape.

---

## 8. Matching, the per-field cascade, and the engine

### 8.1 Match dimensions & cascade (which rule applies)

A rule may constrain `user` (full provider id, globs most useful on the homeserver suffix), `room` (internal room id), and `space` (Phase 2 — §11). Each present dimension accepts a **single glob or a list of globs**, matching if **any** entry matches (OR *within* a dimension — this is the granular-membership primitive: list exact user ids for a precise group); multiple present dimensions are **ANDed** across. At least one is required; an omitted match dimension is a wildcard (`*`). Glob syntax is a minimal anchored fnmatch (`*` = any run including empty; case-sensitive; translated to SQL `LIKE` for ledger seeds, with literal `%`/`_` escaped).

For a trigger `(user, room, space)`, collect every matching rule **in file order** and resolve each **value field** from the first matching rule that specifies it (CSS-style cascade). Precedence is **authored order**, never computed specificity — the human orders the list; the engine never guesses. Two field roles:

- **Match fields** (`user`/`room`/`space`) — omit = wildcard (broaden *which* triggers match).
- **Value fields** — omit = cascade (look to the next matching rule for that field's value).

The value fields are:

- **The model-budget block** (`models` + `limits`) — cascades **atomically as one unit**, because the sub-caps inside `limits` reference names in `models`; they are coupled and must come from the same rule. (Normalizer coherence: every `limits[*].models` ⊆ the rule's resolved `models`.)
- **`trigger_rejection_message`** — cascades **independently** as a scalar, so the flagship "override just the refusal message for one user, leave their budget alone" still works.

```toml
# 1) universal default refusal message, nothing else
[[user_limits]]
user = "*"
trigger_rejection_message = "Sorry {display_name}, you're out of budget — resets in {resets_in}."

# 2) override the MESSAGE for one user (budget cascades past to the global default, rule 5)
[[user_limits]]
user = "@special:hs.org"
trigger_rejection_message = "Easy there, {display_name} — back at {resets_at}."

# 3) ban a user (message cascades to rule 1)
[[user_limits]]
user = "@spammer:bad.hs"
max_usd = 0

# 4) operator + special users: frontier model, generous shared pool of their own.
#    Placed ABOVE rule 5 so it wins the cascade for these users — which is exactly
#    what keeps them OUT of rule 5's public pool (disjoint by authored order).
[[user_limits]]
user = ["@admin:hs.org", "@ops:hs.org", "*:trusted.hs"]   # OR-list membership
models = ["opus-premium"]
limits = [
  { max_usd = 50, window = { type = "rolling", duration = "24h" }, partition = "staff" },  # shared staff pool
]

# 5) the global default: premium-with-cap degrading to cheap, plus a shared public pool
[[user_limits]]
user = "*"
models = ["opus-premium", "glm-cheap"]
limits = [
  { max_usd = 5,   window = { type = "rolling", duration = "24h" } },                 # per-user fungible total
  { max_usd = 2,   window = { type = "rolling", duration = "24h" }, models = ["opus-premium"] },  # per-user premium sub-cap
  { max_usd = 100, window = { type = "rolling", duration = "24h" }, partition = "public" },        # shared public pool → degrade together
  { max_usd = 40,  window = { type = "rolling", duration = "24h" }, models = ["opus-premium"], partition = "public" },  # public premium sub-cap
]
```

### 8.2 `UserLimitEngine` (`src/budget/user-limits.ts`)

A sibling to `BudgetEngine`, holding the normalized ordered rules and **partitioned** counters keyed per `(constraint, partition-key)`, where the partition key is the constraint's `partition` template (§3.5) rendered from the trigger `ctx` (default `{user_id}`):

- State: `Map<constraintId, Map<partitionKey, { spent, windowStart, resetsAt }>>`, lazily materialized, seeded from the ledger (§8.3). Calendar roll / rolling recompute reuse the §8e window math per entry.
- `resolve(ctx) → { models, constraints, messageTemplate }` — the per-field cascade; cacheable per `(userId, roomId, spaceId)`. Each resolved constraint carries its partition key rendered for `ctx`.
- `affordable(ctx, model, estimate) → { ok, maxOutput }` — the §5.3 estimate against the live counters (the `min` ranges over **every** covering constraint, per-user and shared-pool alike); zero-cost-model bypass identical to §8e (`zeroCostModelIds`).
- `selectModel(ctx, firstRequestEstimateFn) → modelId | deny` — first affordable model in preference order (Gate A).
- `record(event)` — walks the session's frozen resolved constraints; for each the event **covers** (no `models`, or the *served* model ∈ its `models`), increments the counter keyed by *that constraint's rendered partition key*. One event thus updates several counters (per-user total, per-user sub-cap, shared pool, pool sub-cap); the rendered keys are frozen at `resolve` time (templates read only `ctx`, never the model — the model only toggles which sub-caps are covered). No-op for exempt rules. Fed from the existing `recordUsageEvent` fan-in beside `engine.record(event)`.
- `accurateResetsAt(ctx, constraint)` — `min(contributing ts) + duration` for rolling, off the hot path, for the refusal message (§12).

### 8.3 Storage filter additions (`src/storage/database.ts`)

`UsageCostFilter` (used by `sumUsageCost` / `minUsageTs`) gains:

- `partitionKeys?: string[]` → `budget_partition IN (…)`, the seed/recompute filter for a **shared-pool** meter. The shared pool's *rendered* key (§3.5) is denormalized onto each contributing event at record time, because pool membership is a **cascade outcome** and cannot be reconstructed from the event's intrinsic columns afterward (a literal like `public` has no intrinsic column at all; even a `room:{room_id}` pool on a homeserver-scoped rule is membership-narrowed, so `timeline_key`-derivation would over-count). Combined with `requestedModelIds` it seeds both a pool total *and* its premium sub-cap from the same stored key.
- `triggerSenderIds?: string[]` → `trigger_sender_id IN (…)` — the **per-user** seed. The default `{user_id}` key equals `trigger_sender_id`, so per-user counters reseed directly off this existing column with no denormalization (the minor caveat: a room/space-*narrowed* rule slightly over-counts here, an accepted simplification carried over from §8e).
- `requestedModelIds?: string[]` → a sub-cap's model scope, matched on the **requested** virtual model (§7) — `requested_model_id IN (…)`. This column is added in the first slice (§7, §15); there is no `logical_model_id` interim, because MODEL-FALLBACK shipped first and chains already exist (requested ≠ served is live from day one).
- `timelineKeys?: string[]` / `roomLike?: string` → exact / glob room scoping (the `timeline_key` room-id wrinkle below).
- (Phase 2) `spaceIds?: string[]` → the denormalized `space_id` column (§11).

Add `idx_usage_events_sender_ts on usage_events(trigger_sender_id, ts)` and `idx_usage_events_partition_ts on usage_events(budget_partition, ts)`. The **two schema additions** (first slice) are nullable `budget_partition` and `requested_model_id` columns:

- `budget_partition` — written at `recordUsageEvent` with the **rendered shared-pool key** (null when the event belongs to no shared pool — e.g. an exempt admin). The per-user counters do *not* use it (they seed off `trigger_sender_id`); old rows are null (acceptable, they pre-date the meter).
- `requested_model_id` — the **requested** virtual model the per-user selector chose (§7), distinct from `logical_model_id` (the served member) under active fallback. Old rows are null; the sub-cap filter falls back to `logical_model_id` only for those pre-feature rows.

Both ride one migration (the next version after the shipped v30). The remaining columns are pre-existing — `trigger_sender_id`, `timeline_key`, and `logical_model_id` all already exist (`logical_model_id` from MODEL-FALLBACK, schema v30, recording the served member).

> **A single `budget_partition` column assumes ≤ 1 shared pool per event.** A request fans out to several counters — its per-user total, any per-user sub-cap, the shared pool, the shared pool's sub-cap — but the per-user keys are intrinsic (`trigger_sender_id`) and the sub-caps re-use their parent's key under a `requested_model_id` filter, so the only thing needing storage is *the* shared-pool key. **Phase 1 normalizer rule: at most one distinct non-`{user_id}` partition value per rule** (the §8.1 example obeys this — rule 5's two `public` constraints share one value), which keeps the scalar column correct. True nesting (one rule feeding several independent pools) is deferred; it would replace the column with a `usage_event_partitions(event_id, partition_key)` child table and is out of scope for the first slice.

> `timeline_key` is `matrix:{accountId}:{dm|room}:{roomId}[:thread:…]`, not the bare room id, so a room match compares against the embedded room-id component (exact → `…:room:!id:hs%` covering thread sub-keys). User-only rules (the common case) use clean `trigger_sender_id` equality and avoid this entirely.

---

## 9. Configuration

```toml
[[user_limits]]
user   = "@alice:hs.org"        # glob/exact, or a list of globs (any matches); omit = any user
room   = "!room:hs.org"         # glob/exact, or a list; omit = any room
space  = "!space:hs.org"        # Phase 2; glob/exact, or a list; omit = any space

models = ["opus-premium", "glm-cheap"]   # ordered preference set (registry names); omit = [session-type default]

limits = [                               # constraint set, ANDed; each counter keyed by `partition` (§3.5)
  { max_usd = 5, window = { type = "rolling", duration = "24h" } },           # no models = fungible total; default partition {user_id}
  { max_usd = 2, window = { type = "calendar", period = "month", tz = "UTC" }, models = ["opus-premium"] },
  { max_usd = 100, window = { type = "rolling", duration = "24h" }, partition = "room:{room_id}" },  # shared per-room pool
]

# shorthand, normalized into a single fungible-total constraint:
# max_usd = 5
# window  = { type = "rolling", duration = "24h" }

trigger_rejection_message = "…"  # templated (§12); cascades independently
```

- Default-disabled: an absent/empty `[[user_limits]]` array = feature off, zero behavior change (the explicit-deployment-config convention).
- TypeBox (`UserLimitRuleSchema`, `src/config/schema.ts`) covers shape only; `LimitWindowSchema` is reused verbatim from §8e. `max_usd` is `Type.Number()` (no `minimum`, unlike §8e — negatives are the exempt shorthand). Match dimensions and `partition` accept a single string or `string[]` / string respectively; `partition` defaults to `"{user_id}"`.
- Cross-field semantics live in `normalizeUserLimits` (`src/budget/normalize-user-limits.ts`), invoked from `app.ts` (the cross-field-validation-in-app convention), mirroring `normalizeLimits`. It enforces: ≥1 match dimension per rule; every `limits[*].models` ⊆ the rule's `models`; every referenced model name exists in `[models.*]`; parseable duration / valid IANA tz; **partition templates reference only known variables** (`{user_id}` / `{room_id}` / `{homeserver}`; a `{space_id}` template is a Phase-2 fatal until §11 lands, same as the `space` match field); warns on a rule with a positive sub-cap but no covering total (degradation with no reserved headroom never fires — §3.3); warns when two constraints share a **fully-static** partition key with divergent caps (§3.5); and (Phase 1) **fatals on more than one distinct non-`{user_id}` partition value within a single rule** — the single `budget_partition` column assumes ≤ 1 shared pool per event (§8.3); multi-pool nesting is deferred.

---

## 10. Building the trigger context & coalescing

`ctx` is built once at Gate A from `inbound`: `userId` as in §6.1, `roomId` from `inbound.timelineKey`, `spaceId` (Phase 2) resolved via the native call (§11) and frozen on the session. These same fields feed the §3.5 partition templates — `{user_id}` / `{room_id}` / `{space_id}` map directly, and `{homeserver}` is derived as the suffix after the first `:` of `userId`. Partition keys are rendered at resolve time and, for shared pools, frozen on the session alongside the rule.

> **Coalescing footnote.** When several users' messages coalesce into one session, the **trigger owner** (the `userId` above — the sender whose message caused the session) owns selection *and* cost. This reuses the id §6.1 already picks and the `trigger_sender_id` cost already attributes to, so a premium user "hosts" a richer session that sweeps in others' messages, spending from their own allowance — an intuitive, intended consequence, not an ambiguity. (Most-restrictive-wins is the alternative; trigger-owner is chosen for consistency with existing attribution.)

---

## 11. Space matching

Space matching touches one more layer than user/room — the room→space mapping must be surfaced and a column added to count by it — but every touch is ordinary in-tree work.

**What exists today** (`native/crates/matrix-core/src/client/mod.rs` ~1201): `resolve_parent_space_name(room)` calls matrix-sdk's `room.parent_spaces()`, filters to spec-legitimate parents (`Reciprocal` > `WithPowerlevel`), and returns the single best parent's **display name** via `MatrixChannelInfo.parent_space_name`. There is no space **id**, and only one parent.

**What space matching adds:**

1. **Surface parent space id(s)** (`matrix-core`): extend `MatrixChannelInfo` with `parent_space_ids: Vec<String>` — all legitimate parents (a room can belong to several; matching is "any ancestor matches"). The `parent_spaces()` stream is already iterated; small change plus the NAPI type and TS binding.
2. **Resolution timing**: resolve the triggering room's space id(s) **once at admission** (Gate A) and **freeze on the session** — never re-runs on the per-request hot path.
3. **Counting denormalization**: add a nullable `space_id` column to `usage_events`, written at `recordUsageEvent` time from the frozen resolution (mirroring `timeline_key`). Per-user-per-space counting becomes a simple `space_id = ?` filter — cleaner than the room case. Routine migration (column + `idx_usage_events_space_ts`; old rows get null, acceptable).
4. **Multi-space match**: a `space` predicate matches if **any** resolved ancestor space id matches. (Nesting depth: what `parent_spaces()` cheaply yields; deeper transitivity is a later extension.)

Until space matching lands (§15), a `space` key is a normalizer **fatal error** ("space matching not yet supported"), so no rule silently no-ops.

---

## 12. Refusal message templating

§8e templates only `{resets_at}`. Per-user refusals get a richer set, resolved against the trigger + the binding constraint:

| Token | Source |
|---|---|
| `{display_name}` | trigger sender's display name (untrusted; only ever in the outbound refusal, never a context/prompt) |
| `{user_id}` | full provider id |
| `{limit}` | the binding constraint's `max_usd`, formatted USD |
| `{window}` | human-readable window (`24h rolling`, `this month (UTC)`) |
| `{resets_at}` | absolute reset instant |
| `{resets_in}` | relative duration to reset (`3h 12m`) |

`{resets_at}` / `{resets_in}` are "if applicable" — a `max_usd == 0` deny has no reset and they render empty (the author omits them). The reset instant reuses the §8e `accurateResetsAt` path (rolling = oldest-contributing-`ts` + duration) with the filters carrying `triggerSenderIds:[userId]` (+ scope), so the ETA reflects *this user's* oldest contributing spend. When several constraints bind, the message reports the soonest-resetting binding constraint. Off the hot path.

---

## 13. Relationship to a future total-per-room cap (not built)

A **total-per-room** (or per-space) aggregate cap — "this room collectively spends ≤ $X, counting *everyone* plus background work" — is a separate feature, out of scope here. (Its **human-loop-only** cousin — pooling only *triggered agent-loop* spend per room / space / group — *is* in scope, expressed as a partition template (§3.5); what remains out of scope is specifically the **background-inclusive** total described next.) It must gate summary/diary/caption/embed (via the §8e claim gates) and participates in the dependency cascade. When desired it slots into the **existing §8e aggregate model** as a new `rooms`/`spaces` selector on `[[limits]]` — *not* this per-user list. The two precedence models (partitioned-cascade-plus-selection vs aggregate-AND) must never merge into one lattice; they answer different questions. (An embedding-row `timeline_key` audit would be a prerequisite.)

---

## 14. Console (§11 / §7.1)

- Surface per-user rule status alongside the §8e Limits section: resolved rules, each user's `(spent / cap, resetsAt)` per binding constraint, and the **currently-selected model** for active users (a `userLimits.statuses()` analogous to `ruleStatuses()`). The leaderboard already groups by `trigger_sender_id`, so wiring is incremental.
- A refused human trigger emits the `usage_limit_blocked` structured log with a `gate: "user_admission" | "user_preflight"` discriminator, the resolved rule, and the binding constraint.
- A budget-capped (output-truncated) turn emits a structured line distinguishing it from an organic completion, so degradation is visible.

---

## 15. Phasing

One feature; phasing only splits the PRs, not the difficulty.

- **First slice**: `user` + `room` matching with **OR-list dimensions** (§8.1); cascade resolution; the constraint-set budget + multi-window partitioned counters; the **partition template** (§3.5 — per-user default `{user_id}` plus shared group / per-room / per-`{homeserver}` pools) with the `budget_partition` ledger column + `idx_usage_events_partition_ts`; **per-attempt dynamic selection** (preference-order degradation, affordable ∧ healthy ∧ fits, with the cheap per-model `fits` check and current-chain read sizing — §6.2); the estimation layer (forward estimate + output cap → re-select); Gate A + Gate B + dynamic §8d ceiling; storage filters + `idx_usage_events_sender_ts`; templating; console. Covers the common case end-to-end (default per-user cap, overrides, bans, exemptions, premium upgrade, **mid-rollout** budget degradation, **operator-vs-public shared pools** that degrade together, cross-axis outage fallthrough) with two additive columns (`budget_partition` + `requested_model_id`) in one migration. Per-user sub-caps scope on `requested_model_id` from day one — MODEL-FALLBACK shipped first, so per-user models can already carry outage chains and requested ≠ served is live (§7); there is no `logical_model_id` interim.
- **Second slice**: `space` matching (§11) — parent-space-id in `matrix-core` + NAPI, `space_id` ledger column + index + record-time write, admission-time resolution & freeze; this also enables the `{space_id}` partition template (§3.5) for per-space pools.
- **Later**: user model choice (§4.3). (The `requested_model_id` ledger column has moved into the **first slice** — see §7 — because MODEL-FALLBACK shipped first and per-user models can already carry outage chains; it can no longer ride MODEL-FALLBACK's already-shipped v30 migration.)

---

## 16. Open questions for the maintainer

1. **`viable_min` output floor** (§5.3): what minimum affordable output makes a turn "worth issuing"? A few tokens (since valid turns can be single-digit), or a larger floor to avoid near-useless premium turns just before degradation re-selects?
2. **Room-id extraction from `timeline_key`** (§8.3): `LIKE` over the embedded room id, or a derived bare `room_id` column? `LIKE` avoids a Phase-1 migration; a column is sturdier.
3. **Phase 2 transitive nesting** (§11): direct/legitimate parents only, or transitive ancestors? Start direct.
4. **Display-name source for `{display_name}`** (§12): inbound `senderName` (freshest, no lookup) vs `agent_sessions.trigger_sender_display_name`.
