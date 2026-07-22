# Feasibility: >1 Shared Pool per `[[user_limits]]` Rule

**Status**: IMPLEMENTED (Option A) — superseded by ARCHITECTURE.md §8f
(`usage_event_partitions`, schema v4) / §8g; retained for review. The general
overlapping-pool feature was built: the normalizer's one-shared-pool fatal is relaxed
to `MAX_SHARED_POOLS_PER_RULE = 8`; overflow memberships spill to a `without rowid`
child table reseeded via a scalar+child UNION (no back-fill); `resolve()` returns a
key *set* (`ledgerPartitionKeys`), the recorder stamps the model-aware subset for both
lanes via `UserLimitEngine.sharedPoolKeys`. The scalar `budget_partition` fast-path is
retained, so per-user-only and single-pool configs write nothing extra. The
model-disjoint §2 sugar was NOT separately built — it is subsumed (overlapping is a
superset of disjoint). This study is retained as the design baseline; the study text
below (options, perf analysis, recommendation) describes the pre-implementation
reasoning.

**Date**: 2026-07-22 (study against HEAD `a0976bd`, schema v3; implemented same day, schema v4)

**Reading order followed**: `spec/PER-USER-LIMITS.md` (esp. §3.5/§7/§8.3),
`src/budget/normalize-user-limits.ts`, `src/budget/user-limits.ts`,
`usage_events` DDL + `recordUsageEvent`/`insertUsageEvent` + `usageCostClauses` in
`src/storage/database.ts`, the stamp site in `src/agent/factory.ts` (~820–885), and
the fan-in in `src/app.ts` (~1058–1131).

---

## 1. The constraint mechanism, restated from the code

A `[[user_limits]]` rule carries a `models` preference list and a `limits[]`
constraint set. Each constraint has a `partition` template (default `"{user_id}"`).
The engine (`UserLimitEngine`, `src/budget/user-limits.ts`) meters spend against
per-`(constraint, rendered-partition-key)` counters that live **in memory** and
**re-seed from the `usage_events` ledger**.

Two distinct notions must not be conflated — the study hinges on the difference:

- A **partition VALUE** — the rendered string a constraint's `partition` template
  produces (`"staff"`, `"room:!abc:hs"`, `"@alice:hs"`). This is the *meter-family
  denominator*: constraints that render the same value share one counter's spend
  basis.
- A **pool** — one metered counter. A pool is identified by a `meterKey` that
  encodes `(isUserPartition, partitionKey, modelScope, window, roomScope,
  spaceScope)` (`resolveConstraint`, user-limits.ts:476). So **several distinct
  pools can share one partition VALUE**, separated by their `modelScope`/window.

### 1.1 What is actually forbidden today

`normalize-user-limits.ts:236–245` collects the set of *distinct non-`{user_id}`
`partition` template strings* in a rule and **fatals when that set has size > 1**:

```
const sharedTemplates = new Set(constraints.filter(c => c.shared).map(c => c.partition));
if (sharedTemplates.size > 1) fatal.push("… at most one shared pool …");
```

So the real rule is **"at most one distinct *shared partition value* per rule,"**
*not* "at most one shared pool." The `test/user-limits.test.ts` cases prove this:

- `partition: "staff"` + `partition: "public"` → **fatal** (two values). (test ~158)
- `partition: "staff"` + `partition: "staff"` → **allowed** (one value; only a
  *divergent-caps warning* when caps differ). (test ~180)

And §8.1's canonical rule 5 deliberately puts two constraints on the **same**
`"public"` value — a pool total + a model-scoped pool sub-cap — which is explicitly
in-bounds. `resolve()` then denormalizes exactly one value onto the row:
`ledgerPartitionKey = constraints.find(c => !c.isUserPartition)?.partitionKey`
(user-limits.ts:437) — the **first** shared constraint's key, **model-blind**.

### 1.2 Why one value per row is required (the storage reason)

A shared meter re-seeds by scanning `usage_events` rows tagged with its key:
`budget_partition IN (…)` (`usageCostClauses`, database.ts:3729; filter type
database.ts:1072). `budget_partition` is a **single denormalized column**, one value
per row (DDL database.ts:7520; written at `insertUsageEvent` database.ts:3664; the
value comes from `resolution.ledgerPartitionKey` stamped at factory.ts:845–847 and
backfilled for the tool lane at app.ts:1114). If a row belonged to **two distinct
partition values**, the schema could store only one; the second pool's `IN (…)`
reseed would silently omit that row and its cap would drift across every re-sum
(every 60 s tick and every restart). Per-user `{user_id}` pools are exempt: they
reseed off the intrinsic `trigger_sender_id` column (database.ts:3728), never
`budget_partition`, so they never contend for the single slot.

So the task's characterisation is **correct**, with one refinement: the limit is
one *partition value* per row, and the config-level fatal is one *shared partition
value* per rule. Multiple pools per value already work (they differ only by
`modelScope`/window, which the reseed re-applies via `requestedModelIds` and the
window bounds — not via `budget_partition`).

---

## 2. The key question — resolved: the disjoint case needs NO change

> For the model-DISJOINT case, does a single spend event ever need two partition
> keys?

**No — and more than that: case #1 is already expressible today, with zero code
change.** The reasoning, verified end-to-end against the billing path:

### 2.1 One event is billed on exactly one requested model

Selection is resolved **per Layer-0 attempt** (`resolveUserSelection`,
factory.ts:712). Each request dispatches exactly one `requestedMember.logicalId`
(factory.ts:754), and the commit hook stamps that single id as `requestedModelId`
(factory.ts:844: `requestedModelId = userSelectionActive ? requestedMember.logicalId
: null`). The in-memory `record()` credits a model-scoped constraint **only when
`requestedModelId ∈ modelScope`** (user-limits.ts:716–719); the ledger reseed
mirrors this with the `requested_model_id` filter (database.ts:3732–3750).

So the recorder **does** hold the actual requested/billed logical model at stamp
time — model-scope matching there is not only possible, it already happens for
sub-caps. (Note: the *served* model can differ from the requested head under
per-attempt fallback — that is exactly why `logical_model_id` (served) and
`requested_model_id` (requested) are separate columns, §7 of PER-USER-LIMITS. Pool
scoping keys on the **requested** id, which is unambiguous per attempt.)

### 2.2 Model-disjoint pools can share one partition value

Because pools are separated by `modelScope`, two model-disjoint shared pools can be
written with the **same** partition string and remain fully distinct meters:

```toml
[[user_limits]]
user   = "*"
models = ["sol", "default"]              # sol = OpenAI 5.6 reply-only; default = GLM
limits = [
  { max_usd = 5,  window = { type = "rolling", duration = "24h" } },                          # per-user total
  { max_usd = 300, window = { type = "rolling", duration = "24h" }, partition = "reply-fleet", models = ["sol"] },      # Sol aggregate
  { max_usd = 200, window = { type = "rolling", duration = "24h" }, partition = "reply-fleet", models = ["default"] },  # GLM aggregate
]
```

- `normalize`: `sharedTemplates = {"reply-fleet"}` → size 1 → **not fatal**. The
  divergent-caps warning does **not** fire (its static-group key folds in
  `modelScope`, so `reply-fleet#sol#…` ≠ `reply-fleet#default#…`; normalize:224).
- `resolve()`: two `ResolvedConstraint`s, both `partitionKey = "reply-fleet"`,
  distinct `meterKey` (modelScope differs). `ledgerPartitionKey = "reply-fleet"`.
- Every row is stamped `budget_partition = "reply-fleet"`; the Sol pool reseeds with
  `partitionKeys:["reply-fleet"], requestedModelIds:["sol"]` and the GLM pool with
  `requestedModelIds:["default"]`. A `sol` event feeds only the Sol meter
  (`record` coverage), a `default` event only the GLM meter. **Correct, disjoint,
  restart-durable — one column suffices** because the model, not a second partition
  value, selects the pool.

This is the *same* single-column-plus-`requested_model_id` idiom that rule 5's
"`public` total + `public` premium sub-cap" already relies on, generalised to two
model-scoped pools with no unscoped total among them.

### 2.3 The model-blind `.find()` is harmless in the disjoint idiom

`ledgerPartitionKey` picks the first shared constraint model-blindly. In the shared-
value idiom that is fine: both pools share the value, so the single stamp is right
for both, and each reseed further filters by `requested_model_id`. Even a third
model outside both scopes (e.g. a `grok` event) that gets stamped `"reply-fleet"` is
harmless — both reseeds exclude it on the `requested_model_id` filter. The stray tag
would only matter if an **unscoped** `"reply-fleet"` total existed (it would then
count grok) — but an unscoped shared total is precisely the *overlapping* case (§4),
not the disjoint one.

### 2.4 The only thing the disjoint case cannot do today: name pools distinctly

The single limitation of the shared-value idiom is **cosmetic**: both pools must
carry the *same* partition string (`"reply-fleet"`), so the console shows two rows
under one `partitionKey`, differentiated by `modelScope`. If an operator wants
`"sol-pool"` and `"glm-pool"` as *distinct named* meters, that is fatal today.

Lifting *only* that costs almost nothing — the cheap model-aware path the task
hypothesised:

- **(a) relax normalize** to permit >1 distinct shared value *iff every shared
  constraint is model-scoped and the scopes are pairwise disjoint* (keep fatal when
  any shared constraint is unscoped, or scopes overlap — those are the true
  overlapping case). "Provably disjoint" = for every configured model in the rule's
  `models`, at most one shared constraint's `modelScope` contains it.
- **(b) make `ledgerPartitionKey` model-aware.** Today it is a frozen scalar on the
  resolution. Replace the single stamp with a per-request lookup at the commit hook
  (factory.ts:845): choose the shared constraint whose `modelScope` covers
  `requestedMember.logicalId`; stamp its `partitionKey` (or `null` if none covers).
  Every input needed is already in scope at that site.

Because (b) stamps the pool the event's model actually belongs to, **one
`budget_partition` value per row still suffices** for the disjoint case even with
distinct names — no schema change, no migration, no hot-path write amplification.

**Verdict on the key question:** the disjoint case needs **no schema work at all**.
It is already fully functional via the shared-value idiom; distinct pool *names* are
a ~30-line ergonomic sugar (a + b) if desired. The single `budget_partition` column
is only genuinely insufficient for **overlapping** pools.

---

## 3. What "overlapping" actually means

Case #2: a single event feeds **two pools with distinct partition values, both
covering it regardless of model.** The archetype:

```toml
[[user_limits]]
user   = "*"
limits = [
  { max_usd = 5,   window = ROLL24 },                                            # per-user total
  { max_usd = 200, window = ROLL24, partition = "space:{space_id}" },            # per-space pool
  { max_usd = 800, window = ROLL24, partition = "fleet" },                       # global fleet pool
]
```

One reply in space `!abc` simultaneously belongs to `"space:!abc"` **and**
`"fleet"`. Neither is model-scoped, so `requested_model_id` cannot disambiguate
them; they are genuinely two independent meter denominators. The row would need to
carry **both** values. This is the case the single column cannot express, and the
only one that justifies lifting the storage constraint.

Note the in-memory engine **already handles this correctly** — `record()` walks
*every* constraint and increments each covered meter (user-limits.ts:715–722), and
`affordable()` mins over *all* covering constraints (user-limits.ts:595). The
overlap failure is **purely a durability/reseed problem**: after a restart or the
60 s tick, one of the two pools re-sums from `budget_partition IN (…)` and misses
every row tagged with the *other* value. So the feature is "make the ledger reseed
survive an event belonging to N pools," nothing in the runtime metering.

---

## 4. Options for the general (overlapping) case

Both options share the same required config change: replace the Phase-1 fatal in
`normalize-user-limits.ts:236` with a bound (e.g. ≤ `MAX_SHARED_POOLS_PER_RULE`,
say 4) and, correspondingly, replace `resolution.ledgerPartitionKey?: string` with
`ledgerPartitionKeys: string[]` (the set of shared-pool keys the event joins). The
per-request model-aware narrowing of §2.3 still applies *within* that set for the
model-scoped members. The divergence is entirely in **how the row stores a set of
keys** and **how a pool reseeds.**

### Option A — membership side-table (recommended if built)

A child table, one row per `(event, pool)` membership, carrying enough columns to
reseed **without joining back** to `usage_events`:

```sql
create table usage_event_partitions (
  event_id           text not null,       -- FK → usage_events.id (informational; no ON DELETE)
  partition_key      text not null,       -- the rendered shared-pool value
  ts                 integer not null,     -- denormalized from usage_events.ts (window pruning)
  requested_model_id text,                -- denormalized (pool sub-cap scoping)
  cost_usd           real not null,        -- denormalized (SUM without a join)
  primary key (event_id, partition_key)
) without rowid;
create index idx_uep_partition_ts on usage_event_partitions(partition_key, ts);
```

- **Reseed query change.** `sumUsageCost`/`minUsageTs` gain a "pool mode": when
  `partitionKeys` is set, read from `usage_event_partitions` instead of
  `usage_events`:
  `select sum(cost_usd) from usage_event_partitions where partition_key = ? and ts >= ?`
  (+ `requested_model_id`-fallback clause for a pool sub-cap, identical shape to
  today's). This stays a **single indexed range scan** on
  `idx_uep_partition_ts` — same asymptotics as today's `idx_usage_events_partition_ts`
  scan. Per-user (`triggerSenderIds`) and all §8e aggregate reseeds are **untouched**
  — they still scan `usage_events`.
- **Insert (hot path) cost.** Per event: the existing `usage_events` INSERT
  (unchanged) **plus** `N` INSERTs into `usage_event_partitions`, where `N` = number
  of shared pools the event joins (0 for the common per-user-only case, 1 for
  today's single-pool config, 2–4 for the new nested case). All within the same
  single-writer `write()` transaction (extend `insertUsageEvent` to take
  `budgetPartitions: string[]`). Each child INSERT touches the `without rowid` PK
  b-tree + one secondary index → ~2 b-tree writes each.
- **Storage/index impact.** `without rowid` keeps the child compact (no rowid
  duplication). Rows ≈ `Σ pool-memberships`, i.e. `(pooled events) × (avg pools per
  event)`. For a single-pool deployment this equals the count of pooled events — a
  near-doubling of *pooled* rows only (per-user-only events add nothing). One
  secondary index.
- **`budget_partition` scalar.** Keep it as the **single-value fast path**: rules
  with ≤ 1 shared value never write the child table (write the scalar as today);
  only rules whose event joins ≥ 2 distinct values write child rows (and may leave
  the scalar null, or store the first for provenance). `resolve()` decides per
  session which mode applies. This preserves a **zero-cost path for every existing
  config** — see §6.
- **Engine change.** `seedFilterFor` (user-limits.ts:499) already emits
  `partitionKeys`; only the *storage* side chooses the child table when
  `partitionKeys` is present. `record()`/`affordable()` are unchanged (they never
  hit the DB). `resolve()` returns the key *set*; the recorder writes all of them.

### Option B — multi-value encoding on the row

Store the set on `usage_events` itself, either as a JSON array
(`budget_partitions text` holding `["space:!abc","fleet"]`) or bounded columns
(`budget_partition_0..k`).

- **Reseed query change (JSON).**
  `select sum(cost_usd) from usage_events, json_each(usage_events.budget_partitions)
   where json_each.value = ? and ts >= ?`. `json_each` is a table-valued function;
  SQLite **cannot use a plain b-tree index to answer "array contains ?"**, so this
  degrades to a **windowed full scan** of `usage_events` with a JSON parse per row.
  For a 24 h/30 d rolling window re-summed every 60 s this is O(rows-in-window) per
  pool per tick — the real regression. (An expression index over a *fixed* number of
  slots, or a shadow FTS, can partly recover this, at which point Option B is just a
  clumsier Option A.)
- **Reseed query change (bounded columns).** `where ? in (budget_partition_0,
  budget_partition_1, …)` — un-indexable as written; each slot needs its own index
  and the query becomes an `OR` across them. Fragile and caps N at compile time.
- **Insert cost.** No new rows — cheapest possible write (one wider column value).
  This is Option B's only advantage.
- **Storage.** No new table; the JSON string widens each pooled row. Minimal.
- **Verdict.** Option B trades the hot-path write for a **reseed regression** and
  loss of the partition index. Given reseed runs on a timer over potentially large
  windows and the insert is already heavy (see §5), that trade is backwards.

---

## 5. Performance regression analysis (the point of the study)

### 5.1 Runtime gate path — unaffected (verified)

The per-request affordability/admission checks (`affordable`, factory.ts:687/728;
Gate A/B) read **in-memory** `meter.spent` only (user-limits.ts:605–610). No DB
read is on the gate path. `meterFor` hits the DB **once**, lazily, at first
materialization of a meter (user-limits.ts:523 `sumUsageCost`), then serves from
memory. **Gate latency is independent of the storage choice** under both options —
confirmed by reading the hot path end to end.

### 5.2 Insert hot path — the cost centre

`recordUsageEvent` (app.ts:1058) fires on **every** LLM request commit
(factory.ts:824) and **every** tool spend, through the single-writer SQLite queue
(`storage.insertUsageEvent`, database.ts:3679 `this.write(...)`). Today each event is
**one** INSERT into `usage_events`, which maintains **11 indexes** (database.ts:7540–
7553: `ts, session, class_ts, model_ts, logical_model_ts, tool_ts, sender_ts,
partition_ts, requested_model_ts, room_ts, space_ts`) — i.e. the write is already
~12 b-tree touches. Added cost per option:

| | added writes per event | notes |
|---|---|---|
| Disjoint (§2, no schema) | **0** | model-aware stamp only; same single INSERT |
| Option A | `+N` child INSERTs, `N` = pools joined (0/1/2–4) | ×~2 b-tree touches each; per-user-only events add 0 |
| Option B (JSON) | **0** rows; slightly larger row payload | cheapest write |

Because the queue is a **single writer**, added write latency serialises against all
other DB work. Option A's `+N` is bounded by config (`MAX_SHARED_POOLS_PER_RULE`) and
is **0 for the per-user-only common case** and **0 for today's single-pool configs
under the fast-path** (§6). Only genuinely-nested (space+fleet) rules pay `+2`.

### 5.3 Re-seed path — where Option B regresses

A shared meter re-seeds:
1. **Lazily at first touch** (`meterFor` → `sumUsageCost`), once per meter per
   process.
2. **On the periodic tick** — `tick()` runs every `tickMs` (**default 60 000 ms**,
   user-limits.ts:373) and **re-SUMs every rolling meter** and reseeds calendar
   meters that rolled (user-limits.ts:549–563). Calendar meters otherwise roll in
   place with no SUM (`rollIfNeeded`).
3. **At startup** — same as (1), as meters materialize.

So a shared pool re-sums from the ledger **once a minute** for its whole lifetime.

- **Today / Option A:** each reseed is a single indexed range scan
  (`idx_..._partition_ts` / `idx_uep_partition_ts`): `WHERE partition_key=? AND
  ts>=?`. O(rows in that pool's window), index-ordered. No join (Option A
  denormalizes `ts`, `cost_usd`, `requested_model_id` into the child).
- **Option B (JSON):** loses the partition index → **windowed full scan +
  `json_each` per row**, O(all rows in the time window) per pool per minute. For a
  busy fleet with a 30 d calendar pool this is the dominant new cost. This is the
  decisive argument against B.

### 5.4 Storage growth & indexes

- Disjoint (§2): none.
- Option A: one child table + one index; `without rowid`. Row count ≈ pooled-events
  × avg-pools-per-event. A per-user-only deployment writes **zero** child rows.
- Option B: no table; wider rows on pooled events; possibly extra expression indexes
  to claw back reseed perf (eroding its write advantage).

---

## 6. Back-compat & migration

- **Schema version.** `LATEST_SCHEMA_VERSION` bumps `3 → 4`. The fresh DDL (`SCHEMA`)
  gains the child table + index behind `create table/index if not exists`
  (database.ts:7697+ region). A new `MIGRATIONS[3]` step (v3→v4) runs **before**
  `SCHEMA` (database.ts:8333), so it must itself `create table if not exists
  usage_event_partitions (...)` and then **back-fill** existing single-pool rows:
  `insert into usage_event_partitions(event_id, partition_key, ts, requested_model_id,
  cost_usd) select id, budget_partition, ts, requested_model_id, cost_usd from
  usage_events where budget_partition is not null`. This preserves every existing
  pool's history. (Idempotent via the PK / `insert or ignore`.)
- **Existing single-pool configs stay a zero-cost fast path.** Keep the
  `budget_partition` scalar and its index; a rule that resolves to ≤ 1 shared value
  writes only the scalar and reseeds via `idx_usage_events_partition_ts` exactly as
  today — the child table is written/read **only** for rules whose event joins ≥ 2
  distinct shared values. This is a per-session mode flag off `resolve()`
  (`ledgerPartitionKeys.length <= 1` ⇒ scalar path). No behaviour change, no added
  writes, and no reseed change for any deployment that does not adopt nested pools.
  (The back-fill above is only needed if the multi-value reseed is *unified* onto the
  child table; if the scalar fast-path is retained, back-fill is optional and can be
  skipped entirely — single-pool meters keep reading the scalar column.)
- **Disjoint sugar (§2 a+b)** needs **no** migration or version bump — it is a
  normalize relaxation + a stamp-site change, both against existing columns.

---

## 7. Test impact

- **`test/user-limits.test.ts`**
  - The `"at most one shared pool"` fatal test (~158–170) changes meaning: under the
    disjoint sugar it must assert the *overlapping* (unscoped, or overlapping-scope)
    case still fatals while a *disjoint model-scoped* pair is **accepted**. Under the
    general feature it asserts ≤ N distinct values accepted, > N fatal.
  - New: disjoint pools sharing one value already work — add a regression test that
    two model-scoped constraints on one partition value seed/record independently
    (locks in the §2 idiom so a future refactor can't break it).
  - New: `resolve()` returns `ledgerPartitionKeys` as a set; a nested space+fleet
    rule yields both keys; the model-aware narrowing picks the right key for a
    model-scoped member.
- **`test/usage-events-storage.test.ts`** (already exercises `partitionKeys`,
  `requestedModelIds`, room seeds — ~130–220): add multi-membership cases — an event
  in two pools contributes to **both** pool reseeds (Option A: via the child table);
  a single-pool event still reseeds via the scalar fast path unchanged.
- **`test/budget.test.ts` / cost-budget** — unaffected by the disjoint path; for the
  general feature, add an overlapping-pool affordability test proving `affordable()`
  mins over *both* pools (this already holds in-memory; the test guards the reseed
  round-trip through storage).
- **Migration test** — v3→v4 back-fill copies existing `budget_partition` rows into
  the child table (if unified) and is idempotent.

---

## 8. Recommendation

**Do not build the general overlapping feature on the strength of case #1 — case #1
does not need it.**

1. **Case #1 (model-disjoint: Sol-aggregate vs GLM-fleet) is already supported**,
   two ways over:
   - the **shared-value idiom** (§2.2) — one `partition` string, disjoint
     `models` scopes — works today with **no code change**; and
   - as the task itself notes, the specific **Sol/Terra switch also works as a plain
     §8e global `[[limits]]` model cap**, because the 5.6 family is reply-only, so a
     global model-scoped cap is reply-only in effect.
   The *only* gap is naming two disjoint pools distinctly, which is cosmetic. If that
   ergonomic win is wanted, ship the **§2 (a)+(b) sugar** — a normalize relaxation
   (disjoint-scope check) plus a model-aware stamp — with **no schema change, no
   migration, and no hot-path or reseed regression.** This is the cheap unlock the
   task hypothesised, and it is real.

2. **The general feature is justified only by case #2 (genuinely overlapping pools:
   nested `space:{space_id}` + `fleet`).** That is a legitimate operator want (cap a
   space's aggregate *and* the whole fleet at once, model-agnostically), and it is
   the *only* configuration the single `budget_partition` column cannot express.
   Whether to build it is a **product call about how likely nested space+fleet caps
   are**, not a technical blocker.

3. **If case #2 is wanted, build Option A** (membership side-table with denormalized
   `ts`/`cost_usd`/`requested_model_id`), keeping the `budget_partition` scalar as a
   **zero-cost fast path** for every existing and single-pool config. Reject Option B
   (JSON/`json_each`): it saves a bounded, config-capped hot-path write in exchange
   for turning the once-a-minute pool reseed into an unindexed windowed scan — the
   wrong trade for a meter that re-sums on a timer.

**Bottom line:** the constraint that motivated the study (case #1) is a paper tiger —
already solvable in config or with trivial sugar. Lifting the single-column
constraint is worth it **only** if nested, model-agnostic, overlapping pools
(space + fleet) are a real deployment requirement; in that case Option A is cheap on
every path except a bounded, opt-in insert increment, and existing configs pay
nothing.
