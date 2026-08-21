# Summary-Layer Token Budget — budget-driven eager condensation

**Status**: PROPOSED.

**Author**: design session 2026-08-21.

**Owner constraints (2026-08-21)**: the in-context summary layer must remain
self-sufficient — the design must NOT rely on the agent calling
`expand_summary` to recover routine precision ("it's just not going to be, most
of the time"). Coverage must never be elided or replaced with pointers; the
budget may only move the coarsening boundary. Ladder shape knobs
(`condense_fanout`, `leaf_target_tokens`, `condense_target_tokens`,
`summary_max_overage_factor`) are explicitly NOT changed by this spec.

Target ARCHITECTURE.md home once implemented: §9b (summarization — new
"Budget-driven eager condensation" subsection), §4/§10a context assembly note
(tier table gains the knob), §13 config schema.

---

## 1. Problem

The in-context summary layer is the only context segment with no size knob.
Rich and compact tiers have `[context.tiers]` targets; the diary window has
`[diary] recency_max_tokens`; the summary layer is *greedy highest-level
coverage of the room's entire history* — unbounded. In a busy room it is the
largest single segment of a session start (observed: ~18.7k tokens of a ~44k
build, and it grew ~5k over one active evening).

The distribution of that cost is structural, not historical. Measured on a
long-lived room (17 blocks, ~16.8k rendered):

- Deep past is already cheap: one L5 covering six weeks / 40k events ≈ 1.2k;
  the oldest ten weeks ≈ 3.7k total. Nothing to win there.
- ~73% of the layer is the **recent band**: the last ~9 days as four L3 + four
  L2 + four L1 resident blocks (~0.9–1.3k each).

The recent band is fat because condensation is **fanout-lazy**:
`evaluateCondensation` only enqueues a level+1 job when a contiguous run of
`condense_fanout` (default 5) same-level summaries exists. Until the fifth
sibling arrives, up to `fanout − 1` blocks sit resident at every level. With
three fine levels live at once, the steady-state floor is roughly
`3 × (fanout − 1) × actual_block_size` — ~12k at current settings — and the
layer oscillates above it. No selection-side logic can reduce this: the greedy
highest-level selection is already optimal *for the summaries that exist*; the
coarser parents simply do not exist yet.

## 2. Non-goals / rejected approaches

- **Render-time folding or elision** (recap's `selectDigest` pointed at the
  live layer): rejected. When an interior run has no parent yet there is
  nothing to fold into, so a render-time bound would have to truncate or stub —
  violating the owner constraint that the layer stays self-sufficient prose.
- **Relying on `expand_summary`** for routine precision recovery: rejected per
  owner constraint. Expansion remains what it is today — recovery for the
  specific moments that need verbatim detail — not a load-bearing part of the
  budget design.
- **Changing ladder shape defaults** (`fanout`, leaf/condense targets, overage
  factor): out of scope. They act only on new blocks, entangle summary quality
  with budget policy, and the owner has not signed off on changing them.
- **A hard cap**: the budget is a *target*, like `rich_target_tokens`. When no
  eligible condensation exists (see guards), the layer may exceed it. Coverage
  is never sacrificed to hit a number.

## 3. Design

One new knob, one new enqueue rule, zero selection changes.

**`[context.tiers] summary_target_tokens`** (default `0` = disabled). When the
rendered summary layer for a timeline exceeds the target, the summarization
subsystem **eagerly condenses short runs** — the same level+1 condense jobs the
fanout trigger produces, just allowed to fire on runs shorter than `fanout`,
lowest level first. The layer shrinks because real, LLM-written coarser
summaries replace their children in the (unchanged) greedy highest-level
selection.

Everything the agent sees remains a genuine summary. Precision degrades
exactly the way it already does — one rung coarser, one condensation earlier —
starting at the bottom of the ladder with the same merges the fanout trigger
would soon run anyway, and climbing to coarser rungs only when the budget
cannot be met below (§4). The freshest band is never touched (live-edge
guard, §5).

## 4. Mechanism

Hook: `SummarizationIndexer.reconcileTimelineInner` (per-timeline serialized
FIFO; already recomputes `selectSummaryCoverage` and already skips mirrored
timelines, disabled state, and failed ranges). After the existing level-1
threshold logic:

1. If `summary_target_tokens` is 0 → done (byte-identical current behavior).
2. Compute the layer's rendered cost: the current selection's blocks, each
   estimated with the same primitives the builder uses (`estimateTokens` over
   the rendered block; the primary tokenizer). Approximation is fine — the
   target is soft.
3. If cost ≤ target → done.
4. Otherwise find the **lowest-level eligible run** (oldest within a level)
   and enqueue **one** condense job for it (at most `fanout` members,
   oldest-first within the run). One job per reconcile pass, mirroring the
   level-1 rule; the worker pool's completion callback re-reconciles, so an
   over-budget layer converges stepwise — no thundering burst, natural
   backpressure through the single worker.

Run discovery reuses `evaluateCondensation`'s exact machinery — condensed-id
exclusion (P4 idempotency), contiguity, failed-range interruption at every
level ≤ N, active-job overlap — refactored to accept a `minChildren` parameter
instead of hardcoding `fanout`. An eager job is a normal condense job:
explicit declared child list (input-integrity P3), same session type, same
worker pool, same lineage writes, same diary queue ride-along. Nothing
downstream can tell the difference.

**Ordering — lowest level first, oldest within a level.** Destructiveness
grows with level: each rung multiplies a block's time span by ~`fanout`, so a
partial merge at L4/L5 collapses months of history into one block for a small
saving, while a partial merge at L1/L2 is the very merge the fanout trigger
would run within hours anyway — just a sibling or two early. Savings also
live at the bottom: the over-budget mass is the recent fine band (§1), where
runs are long and blocks numerous. Level-ascending order therefore takes the
lowest-information-loss, highest-saving jobs first, and escalates to coarser
merges only when the budget cannot be met below. Within a level, oldest run
first (equal destructiveness — age decides): a single level can hold several
disjoint runs, because contiguity breaks at failed ranges, at spans excluded
by an active condense job, and at gaps left by already-condensed children. A produced parent may later
become contiguous with same-level neighbors; once such a run reaches
`fanout`, the ordinary trigger takes it — eager and lazy condensation cascade
together.

## 5. Guards

- **Live-edge guard** (no knob): a run containing the timeline's newest
  summary is never eagerly condensed. The most recent band always stays at its
  current finest level; only fanout-triggered condensation (unchanged) ever
  coarsens it.
- **Top-level guard** (no knob): an eager job never mints a new abstraction
  level — only runs whose level is strictly below the timeline's current
  maximum summary level are eligible. A new top rung (e.g. an L6 spanning
  months) can only come from the fanout trigger deciding the history has
  genuinely earned it, never from budget pressure.
- **Minimum run**: `[summarization] eager_condense_min_children` (default 2,
  schema-bounded 2..`condense_fanout`). Runs of one are never condensed (a
  1-child "condensation" is a paraphrase, not a reduction).
- **Guaranteed-saving guard**: skip a run unless
  `sum(children rendered tokens) ≥ 2 × condense_target_tokens`. Prevents
  no-win jobs (condensing two small blocks into a parent of comparable size)
  and guarantees each eager job strictly shrinks the layer, which is also the
  termination argument: every pass either reduces cost or finds no eligible
  run and stops.
- **Soft target**: when no run passes the guards, the layer stays over budget.
  No truncation, no elision, no placeholder.

## 6. Interactions

- **Selection / rendering / builder**: untouched. `selectSummaryCoverage`,
  the `<conversation_summary>` envelope, SUMMARY_LAYER_NOTE, cutoff-based
  generation builds, `condenseInputs` builds — all byte-identical.
- **recap / expand_summary / summary search**: untouched. Finer children
  remain in storage and remain reachable (recap deliberately selects *lowest*-
  level coverage; expansion walks lineage; `corpus:"summaries"` searches all
  non-superseded rows). The budget changes what is *resident in context*, not
  what exists.
- **Mirrored timelines (§10b)**: inherited skip — the eager path lives inside
  `reconcileTimelineInner`/the evaluator machinery, both already gated.
  Mirror-target rooms get whatever the donor's tree provides.
- **Failed ranges**: inherited — failed ranges interrupt runs exactly as they
  do for fanout condensation, so a failure marker is never erased by an eager
  parent.
- **Cost**: eager jobs run on the condense session type (typically a cheap
  background model) and are metered by the budget engine like any condense.
  Steady-state extra spend is bounded: once a timeline is under target, eager
  jobs stop until growth pushes it over again. Partial-fanout parents may
  later share a level with new siblings and re-condense at the next rung —
  a bounded constant-factor overhead, accepted.
- **Prefix caching**: each eager condensation changes the summary layer, so
  the next session on that room rebuilds its frozen prefix — identical in kind
  to what fanout condensation already does today, somewhat more frequent while
  a room converges to target.

## 7. Config

```toml
[context.tiers]
summary_target_tokens = 0          # 0 = unbounded (current behavior). Soft target
                                   # for the rendered in-context summary layer.

[summarization]
eager_condense_min_children = 2    # min run length for a budget-driven condense
```

Schema: `summary_target_tokens` 0 | 2000–200000 (0 disables; a tiny positive
value would thrash pointlessly — fail fast). `eager_condense_min_children`
2–`condense_fanout` (validated relative bound at load, mirroring existing
cross-knob checks). Shipped defaults keep the feature **off** — existing
deployments see byte-identical behavior.

## 8. Observability

- `summary_budget_condense_enqueued` (info): `{timelineKey, level, runLength,
  layerTokens, targetTokens, jobId}` — one per eager enqueue.
- The existing `summarization_job_enqueued` / completion events cover the rest
  of the lifecycle unchanged.
- The context dump already exposes the layer's size; before/after comparison
  needs no new machinery.

## 9. Testing

- Evaluator refactor: fanout behavior unchanged when knob is 0 (regression:
  existing evaluator tests pass verbatim).
- Over-budget timeline with an interior short run → exactly one eager job,
  oldest run first, declared children correct.
- Ordering: with eligible runs at several levels, the lowest level wins;
  oldest first within a level.
- Live-edge guard: newest-summary run never selected even when it is the only
  candidate.
- Top-level guard: a run at the timeline's maximum level is never selected —
  no eager job creates a previously nonexistent level.
- Guaranteed-saving guard: small-run skip; soft-target outcome (over budget,
  no eligible run → no job, no loop).
- Convergence: repeated reconcile passes with a stubbed worker drive the layer
  monotonically to ≤ target, then quiesce.
- Mirrored timeline: no eager jobs.
- Config validation bounds, including the relative `min_children ≤ fanout`
  check.

## 10. Rollout

First enablement on a long-lived room condenses its backlog stepwise (one job
at a time through the single worker) — an hours-scale trickle of cheap
background inference per room, not a burst. Rooms converge independently.
Rolling back to `0` stops eager enqueueing immediately; already-produced
parents remain (they are ordinary summaries) and the layer regrows fine-grained
material at the live edge as usual.
