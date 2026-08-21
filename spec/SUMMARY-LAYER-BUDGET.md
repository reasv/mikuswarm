# Summary-Layer Token Budget — absorption-based eager condensation

**Status**: PROPOSED.

**Author**: design session 2026-08-21. Revision 2 (same day, owner review):
absorb-and-regenerate replaces partial-fanout parents as the primary
mechanism; split target/max trigger added.

**Owner constraints (2026-08-21)**: the in-context summary layer must remain
self-sufficient — the design must NOT rely on the agent calling
`expand_summary` to recover routine precision ("it's just not going to be, most
of the time"). Coverage must never be elided or replaced with pointers; the
budget may only move the coarsening boundary. Ladder shape knobs
(`condense_fanout`, `leaf_target_tokens`, `condense_target_tokens`,
`summary_max_overage_factor`) are explicitly NOT changed by this spec.

Target ARCHITECTURE.md home once implemented: §9b (summarization — new
"Budget-driven eager condensation" subsection), §4/§10a context assembly note
(tier table gains the knobs), §13 config schema.

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
  eligible job exists (see guards), the layer may exceed it. Coverage is never
  sacrificed to hit a number.
- **Partial-fanout parents as the primary mechanism** (revision 1 of this
  spec): rejected on owner review. The live-edge guard keeps L1 condensation
  at full fanout, but every rung above degenerates under sustained pressure:
  a level's run never grows past `min_children` before eager consumes it, so
  the ladder above L1 becomes a fanout-2 ladder. Covering a given span then
  takes ~log₂ passes instead of ~log₅, each pass paraphrasing the previous
  paraphrase — compounding drift — while level numbers inflate and job count
  roughly doubles. Partial condensation survives only as the bootstrap
  fallback (§4) for a run with no absorbable parent.

## 3. Design

Two knobs, two job shapes, zero selection changes.

**Split trigger/goal** (`[context.tiers]`, mirroring the rich/compact tier
pair): `summary_max_tokens` is the trigger, `summary_target_tokens` the goal.
When the rendered layer exceeds max, the timeline enters a **condensation
episode** that enqueues eager jobs (one per reconcile pass, as ever) until the
layer is at or under target, then quiesces. `summary_target_tokens = 0`
disables the feature entirely (byte-identical behavior);
`summary_max_tokens = 0` means "same as target" (no hysteresis band).

**Primary shape — absorb-and-regenerate.** To eliminate a short level-n run,
do not mint a new half-empty parent: **extend an adjacent existing parent**.
The job's inputs are the parent P's original declared children (level n,
already superseded) *plus* the run's members; its output is a replacement
parent P′ at the same level as P, covering P's span plus the run's. P′
supersedes both P and the absorbed run members. The defining property: **every
parent is always a single-pass summary of real level-n material** — the
regeneration re-reads the original children, never P's prose, so there is no
paraphrase-of-paraphrase compounding at all, and per-pass quality equals the
natural ladder's (with more context per pass). Absorption never increases
ladder depth, and it can absorb even a single block, giving finer budget
control than any minimum-run rule allows.

**Fallback shape — bootstrap partial parent.** When the run has no adjacent
level-(n+1) parent with capacity (§5), mint one the revision-1 way: an
ordinary condense job over the run (at least `eager_condense_min_children`,
at most `fanout` members, oldest-first). The new parent then becomes the
absorption target for subsequent runs, so partial merges are a once-per-parent
bootstrap event, not the steady-state regime.

Below max, behavior is byte-identical to today's lazy ladder. Everything the
agent sees remains a genuine summary; precision degrades exactly as it already
does — one rung coarser, earlier — and the freshest band is never touched
(live-edge guard, §5).

### Why the split trigger (implications)

- **Batching**: growth accumulates across the hysteresis band before an
  episode fires, so absorption sweeps runs of 3–4 blocks per regeneration
  instead of pairs. Since absorption's marginal cost is re-summarizing the
  parent's existing children, halving the number of regenerations roughly
  halves that overhead; bootstrap partials also get more children when they
  do happen.
- **Churn**: every eager job changes the summary layer and thus invalidates
  the next session's frozen prefix. A single target fires one job per new
  leaf's overage — a permanent trickle of rebuilds. Episodes concentrate the
  rebuilds into short bursts separated by quiet stretches at cache-friendly
  steady state.
- **Sizing**: the layer oscillates between target and max, so the average
  resident cost is roughly the midpoint — set the pair accordingly (e.g.
  8000/12000 averages ~10k).
- **State**: the episode latch is in-memory in the indexer (per-timeline
  serialized reconciler owns it). On restart between target and max the latch
  is lost and the layer simply waits for the next max-crossing — benign.

## 4. Mechanism

Hook: `SummarizationIndexer.reconcileTimelineInner` (per-timeline serialized
FIFO; already recomputes `selectSummaryCoverage` and already skips mirrored
timelines, disabled state, and failed ranges). After the existing level-1
threshold logic:

1. If `summary_target_tokens` is 0 → done (byte-identical current behavior).
2. Compute the layer's rendered cost: the current selection's blocks, each
   estimated with the same primitives the builder uses (`estimateTokens` over
   the rendered block; the primary tokenizer). Approximation is fine — the
   thresholds are soft.
3. Latch: if not in an episode and cost > max, enter one; if in an episode
   and cost ≤ target, leave it. Not in an episode → done.
4. Otherwise pick **one** job (per reconcile pass, mirroring the level-1
   rule): find the lowest-level eligible run (oldest within a level — a level
   can hold several disjoint runs, since contiguity breaks at failed ranges,
   at spans excluded by an active condense job, and at gaps left by
   already-condensed children). If an adjacent parent with capacity exists →
   **absorb**; else → **bootstrap** (if the run passes its guards). The
   worker pool's completion callback re-reconciles, so an episode converges
   stepwise — no thundering burst, natural backpressure through the single
   worker.

**Absorption job shape.** Eligible when a level-(n+1) summary P temporally
adjacent to the run exists with capacity (P's child count + run length ≤
`eager_absorb_max_children`); when both neighbors qualify, prefer the older
one. If capacity truncates the run, absorb the oldest members. Declared child
list = P's children ∪ absorbed members — all level n, contiguous, and the
combined span must not intersect a failed range or an active job (inherited
evaluator rules). The job is condense-shaped: same session type, same worker
pool, same explicit-child-list input integrity (P3), same lineage writes —
P′'s children are the level-n rows, so `expand_summary` on P′ drills exactly
as it would on a natural parent.

**Same-level supersession** (the one new storage semantic): landing P′ must
atomically mark P and the absorbed run members superseded, excluding all of
them from selection, from eager-run candidacy (P4 idempotency), and from the
summary-content search corpus, exactly as condensed children are excluded
today. P becomes a bypassed row: no longer anyone's child, still expandable by
id, still holding its own lineage. The single-writer queue makes the atomic
swap trivial.

**Ordering — lowest level first, oldest within a level.** Savings live at the
bottom: the over-budget mass is the recent fine band (§1), where runs are long
and blocks numerous. With absorption, low-level jobs are also the least
consequential per token saved — extending an L3 by a few L2s moves a
day-scale boundary, extending an L5 a month-scale one — so level-ascending
order takes the highest-saving, smallest-blast-radius jobs first and touches
coarse material only when the budget cannot be met below. Within a level,
oldest run first (age decides among equals). A regenerated parent stays
contiguous with its same-level neighbors; if such a run reaches `fanout`, the
ordinary lazy trigger takes it — eager and lazy condensation cascade
together.

## 5. Guards

- **Live-edge guard** (no knob): a run containing the timeline's newest
  summary is never eagerly absorbed or condensed. The most recent band always
  stays at its current finest level; only fanout-triggered condensation
  (unchanged) ever coarsens it.
- **Capacity cap**: `[summarization] eager_absorb_max_children` (default
  `2 × condense_fanout`) bounds a parent's total child count. A full parent
  stops absorbing; the next run bootstraps a fresh parent beside it. Keeps
  regeneration input bounded (~cap × condense_target tokens) and bounds how
  many times any child's content is ever re-read (§6 Cost).
- **Top-level guard** (no knob, bootstrap only): a bootstrap job never mints
  a new abstraction level — only runs strictly below the timeline's current
  maximum summary level are eligible. Absorption structurally cannot mint a
  level, and the maximum level has no parent to absorb into, so the top of
  the ladder is eagerly untouchable: a new top rung (e.g. an L6 spanning
  months) can only come from the fanout trigger deciding the history has
  genuinely earned it.
- **Minimum run** (bootstrap only): `[summarization]
  eager_condense_min_children` (default 2, schema-bounded
  2..`condense_fanout`). A 1-child "condensation" is a paraphrase, not a
  reduction. Absorption is exempt — absorbing a single block into a
  regenerated parent is a genuine reduction with no paraphrase chain.
- **Guaranteed-saving guard**: absorption requires
  `rendered(P) + Σ rendered(run) − condense_target_tokens ≥
  condense_target_tokens`; bootstrap requires
  `Σ rendered(run) ≥ 2 × condense_target_tokens`. Every enqueued job strictly
  shrinks the layer by at least one block's worth — which is also the
  termination argument: every pass either reduces cost or finds no eligible
  run and the episode stalls.
- **Soft thresholds**: when no run passes the guards, the layer stays over
  budget. No truncation, no elision, no placeholder.

## 6. Interactions

- **Selection / rendering / builder**: untouched. `selectSummaryCoverage`,
  the `<conversation_summary>` envelope, SUMMARY_LAYER_NOTE, cutoff-based
  generation builds, `condenseInputs` builds — all byte-identical. P′ simply
  wins the greedy highest-level selection over the rows it superseded.
- **recap / expand_summary / summary search**: superseded rows are excluded
  from search and selection exactly as condensed children are today, and
  remain in storage, expandable by id. P′'s lineage points at real level-n
  children, so expansion and recap's lowest-level digest see a normal tree.
- **Mirrored timelines (§10b)**: inherited skip — the eager path lives inside
  `reconcileTimelineInner`/the evaluator machinery, both already gated.
- **Failed ranges**: inherited — a failed range interrupts runs and absorption
  spans alike; a failure marker is never erased by an eager parent.
- **Diary**: bootstrap jobs are ordinary condensations and keep the ride-along
  unchanged. Absorption jobs skip it — their span already rode the diary
  queue when the material was first condensed; regenerating a parent is not a
  new event.
- **Cost**: eager jobs run on the condense session type (cheap background
  model) and are metered by the budget engine like any condense. Absorption's
  overhead is re-reading the parent's existing children: with the capacity
  cap at 2×fanout and hysteresis batching runs of ~3–4, a given child's
  content is processed at most ~3 times over its parent's lifetime (once at
  its own condensation, then one regeneration or two) — a bounded constant
  factor. Once a timeline is under target, spend stops until the next
  max-crossing.
- **Prefix caching**: each eager job changes the layer and forces the next
  session's prefix rebuild — same in kind as lazy condensation today. The
  hysteresis band concentrates rebuilds into episodes (§3) instead of a
  per-leaf trickle.

## 7. Config

```toml
[context.tiers]
summary_target_tokens = 0     # episode goal; 0 = feature disabled (unbounded)
summary_max_tokens = 0        # episode trigger; 0 = same as target

[summarization]
eager_condense_min_children = 2   # bootstrap only; min run length
eager_absorb_max_children = 0     # parent child-count cap; 0 = 2 * condense_fanout
```

Schema: `summary_target_tokens` 0 | 2000–200000 (a tiny positive value would
thrash pointlessly — fail fast); `summary_max_tokens` 0 or within the same
range and ≥ `summary_target_tokens`; `eager_condense_min_children`
2–`condense_fanout`; `eager_absorb_max_children` 0 (auto) or
`condense_fanout`–`4 × condense_fanout` (relative bounds validated at load,
mirroring existing cross-knob checks). Shipped defaults keep the feature
**off** — existing deployments see byte-identical behavior.

## 8. Observability

- `summary_budget_episode` (info): `{timelineKey, phase: "start" | "end",
  layerTokens, targetTokens, maxTokens}` — one per latch transition.
- `summary_budget_condense_enqueued` (info): `{timelineKey, shape: "absorb" |
  "bootstrap", level, runLength, parentId?, childCount, layerTokens, jobId}` —
  one per eager enqueue.
- Existing `summarization_job_enqueued` / completion events cover the rest of
  the lifecycle unchanged. The context dump already exposes the layer's size;
  before/after comparison needs no new machinery.

## 9. Testing

- Evaluator refactor: fanout behavior unchanged when the feature is off
  (regression: existing evaluator tests pass verbatim).
- Latch: episode starts only above max, ends at ≤ target, survives
  intermediate reconciles; max=0 degenerates to single-threshold.
- Shape choice: run with adjacent under-capacity parent → absorb, declared
  children = parent's children ∪ run; full parent → bootstrap beside it;
  no parent → bootstrap.
- Same-level supersession: after P′ lands, P and absorbed members are excluded
  from selection, eager candidacy, and summary search — atomically.
- Ordering: with eligible runs at several levels, the lowest level wins;
  oldest first within a level; capacity-truncated absorption takes the run's
  oldest members.
- Live-edge guard: newest-summary run never selected even when it is the only
  candidate.
- Top-level guard: no bootstrap at the timeline's maximum level — no eager
  job ever creates a previously nonexistent level.
- Guaranteed-saving guards: absorption and bootstrap formulas; soft-threshold
  outcome (over budget, no eligible run → no job, no loop).
- Convergence: repeated reconcile passes with a stubbed worker drive an
  over-max layer monotonically to ≤ target, then quiesce until max is crossed
  again.
- Mirrored timeline: no eager jobs.
- Config validation bounds, including the relative `min_children ≤ fanout`,
  `max ≥ target`, and absorb-cap checks.

## 10. Rollout

First enablement on a long-lived room converges its backlog stepwise through
the single worker — an hours-scale trickle of cheap background inference per
room. On the measured room, two absorptions do most of the work: the four-L2
run folds into the newest L3 (nine children, one pass), then the L3 band folds
into the newest L4 — landing the ~16.8k layer around ~8k without any partial
parent being minted and without touching the L5. Rooms converge
independently. Rolling back to `0` stops eager work immediately; regenerated
parents remain (they are ordinary summaries) and the layer regrows
fine-grained material at the live edge as usual.
