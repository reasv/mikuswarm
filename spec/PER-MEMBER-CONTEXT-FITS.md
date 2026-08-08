# Per-Member Context Fits — replacing the min-over-chain ceiling

**Status**: DRAFT — proposed, nothing implemented.
Target ARCHITECTURE.md home once implemented: §8a "Model fallback — transparent
composite models" (member selection + the ceiling paragraph), §8b "Context-size
limits" (enforcement + `resolveSessionContextCeiling`), and the PER-USER-LIMITS
Gate B notes (the §4.2 resolver's fits predicate).

**Owner sign-offs (2026-08-08)**:
- The min-over-chain composite ceiling is wrong and must be replaced with
  per-member fits ("picking based on the lowest context in the chain is
  logically absurd and has led to other surprising behaviour in the past").
- No new config knob: this is a behavioral fix, driven entirely by each
  model's existing `context_window`.

---

## 1. Problem

`buildModelFallback` fixes ONE `operativeContextWindow` per composite at build
time: `min(context_window)` over the capability-surviving chain, min'd with the
session-type override. Every consumer of "does this context fit" then compares
against that single number: the §8b `checkContextBudget` pre-flight, the pi-ai
model descriptor, the text-editor read budget, and — decisively — the per-user
Gate B resolver's `fits` predicate (spec PER-USER-LIMITS §4.2), which tests
`s.fallback.operativeContextWindow >= observed` per *selectable*.

Consequences, all stemming from the same inversion (the chain's weakest member
governs contexts the head could serve alone):

1. **Chain composition mutates the head's usable window.** A 256k-window head
   with a 128k-window fallback member serves at most 128k. Adding a fallback —
   a pure availability improvement — silently halves the head's capacity.
2. **Per-user selection routes large contexts to the floor.** Under Gate B,
   every selectable whose chain contains the small member fails `fits`
   simultaneously. The only selectable left is whichever preference has a chain
   *without* that member — in practice the terminal floor model, whose chain is
   itself alone. Preference order, affordability, and health of the better
   models are all bypassed by a context-size accident. Observed in production
   2026-08-08: one turn's tool results pushed the live context past 128k; the
   only "fitting" selectable was the floor model, which was mid-outage, and the
   session parked after burning its whole interactive wall-clock budget —
   while the healthy, affordable, 256k-window preferred model sat idle.
3. **Planning budgets shrink to the weakest member.** The text-editor read
   budget (`resolveSessionContextCeiling`) is sized off the same min, so a
   small fallback member shrinks every session's read pages even when it never
   serves a single request.

The invariant the min was defending — "never send a member a context larger
than its window" — is real. But it is a property of *which member serves an
attempt*, and the composite already chooses a member per attempt
(`chooseChainMember`). Enforcing it by pre-shrinking the whole composite
enforces the right rule at the wrong altitude.

## 2. Design

Fits becomes a **per-member, per-attempt viability predicate**, joining the two
that already exist (healthy ∧ in-budget). The invariant is preserved exactly —
no member is ever dispatched a context beyond its own operative window — but a
larger member is no longer punished for a smaller sibling.

### 2.1 Member viability (`chooseChainMember`)

`viable(m) = healthy(m) ∧ inBudget(m) ∧ fits(m)` where
`fits(m) = observedContextTokens <= memberWindow(m)` and
`memberWindow(m) = min(m.context_window, sessionType.max_context_tokens?)` —
each member's OWN operative window, resolved once at build (config is
immutable per process; only the comparison moves to attempt time).

`chooseChainMember` gains the observed size via its deps (an
`observedContextTokens?: number` input). The agent StreamFn path feeds the §5.3
running counter (the same number the Gate B resolver already reads); the
fetch-shaped consumers (captioning, image-gen, x_search, embedding) pass
`undefined` → fits is skipped, preserving their current behavior (their inputs
are small and self-bounded).

### 2.2 Canary gating

The canary branch (head unhealthy + probe due + in-budget) additionally
requires `fits(head)`: probing a model with a context it cannot serve wastes
the probe slot on a request that fails for an unrelated reason (a provider
overflow rejection is content-class — inconclusive for health, so the probe
buys nothing). No stranding: `nextProbeAt` only advances when a probe fires,
so the head is probe-due again the moment a fitting request arrives.

### 2.3 Composite window semantics

`BuiltModelFallback` stops exposing one number as *the* ceiling:

- **`memberWindows`** — per-surviving-member operative windows, for selection
  (§2.1) and for substituting each attempt's `Model` descriptor with the
  member's OWN window (`createModelFromConfig(cfg, memberWindow(m))`) instead
  of the shared min, so any window-keyed SDK mechanism sees the number that is
  true for the model actually serving.
- **`maxOperativeContextWindow`** — max over surviving members, for §8b
  enforcement: `checkContextBudget` terminates ("context token limit
  exceeded") only when the observed context fits NO member. Until then an
  oversized-for-the-head context degrades to a larger member if one exists
  (a previously impossible *upgrade* path — under per-user counting the
  requested model is still the one gated and billed, spec PER-USER-LIMITS §7,
  so this changes serving, not accounting).
- The **head's own window** becomes the planning number:
  `resolveSessionContextCeiling` returns `min(head.context_window, override)`
  with no chain min — sizing the text-editor read budget and the console's
  `maxContextTokens` display for the model that nominally serves the session.
  If growth later exceeds a smaller member's window, per-member fits simply
  skips that member — the same graceful degradation as any other growth.

### 2.4 The Gate B resolver (per-user §4.2)

The resolver's independent `fits` comparison is deleted; it delegates to
`chooseChainMember` with `observedContextTokens` set, which now owns all three
predicates uniformly. A selectable qualifies iff the chain yields a viable
member (or a canary). The `sawHealthyFit` bookkeeping that attributes the
terminal cause (budget vs outage-or-context) survives, extended to
distinguish "nothing fits" from "nothing healthy" in the terminal message —
the parked-session error should say which.

Single-member chains take the same path: the build-time single-member
shortcut (bare dispatch, no selection) keeps its fast path for *dispatch*, but
Gate B's viability test evaluates fits for it all the same — a single-member
selectable whose window is exceeded is skipped, not dispatched-to-fail.

## 3. Invariants: changed and preserved

- **CHANGED** — §8a "one conservative ceiling valid for whichever member
  serves" → "each member serves only contexts within its own window". The
  underlying guarantee (no member ever receives an oversized context) is
  unchanged; it is now enforced at member selection instead of by pre-shrinking
  every consumer to the weakest member.
- **PRESERVED** — capability pre-filter (orthogonal; still build-time), the
  resolved-once rule (member windows are fixed at build; only comparisons are
  per-attempt), budget gating on the requested model (PER-USER-LIMITS §7),
  Layer-0 retry semantics (each attempt re-resolves; a member skipped on fits
  this attempt is reconsidered next attempt if the estimate moved).
- **Estimator tolerance** — between commits `observed` is the §5.3 running
  estimate (actuals snap at each commit). A member skipped on a slightly-high
  estimate could in truth have fit; this is the same deliberate conservatism
  the affordability estimate already accepts.

## 4. Observability

- `model_fallback_resolved` gains reason `"context-fallback"` (head healthy
  and in-budget but the context exceeds its window), rate-limited like the
  existing reasons.
- `session_context_limit_exceeded` reports the max member window it compared
  against, and names the members skipped on fits.

## 5. Config

None. Behavior-only; every input already exists (`context_window`,
`session_type.max_context_tokens`).

## 6. Testing

- `chooseChainMember` unit: fits-skip ordering, canary-requires-fit, upgrade
  path (head too small, downstream larger member serves), all-skipped →
  `all-unhealthy`-equivalent terminal, `undefined` observed → fits skipped.
- Factory integration: Gate B resolver picks the first preference with any
  fitting member; terminal message distinguishes context vs budget vs outage.
- §8b enforcement: pre-flight terminates only past the max member window.
