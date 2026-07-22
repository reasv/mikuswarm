# Spec: Claim Visibility & Serialization — a triggered session must be claimed and visible-as-running *before* it waits on anything

**Status**: IMPLEMENTED 2026-06-16 — superseded by ARCHITECTURE.md §8 "Parallel sessions" / "Duplicate-reply mitigation" + §7a "Trigger path integration"; retained for review. Extends the `SessionClaims` + `<handled_by_session>` + `<active_sessions>` machinery shipped under DUPLICATE-REPLY-MITIGATION. Follow-up to spec/DUPLICATE-REPLY-MITIGATION.md and spec/DEFERRED-COALESCING.md.

**Shipped** (per §4.1–§4.4 core; §4.4 "optional hardening" deferred as recommended): `awaitTriggerReadiness` relocated into `launchSession` (post-`createPlaceholder`/`markRunning`/attach, post-budget, pre-`factory.create`) and into `runReplyResumeSession`; removed from `handleInbound`/`redispatchCoReply`; activation path now `addClaim`s its trigger (`ActivationCoordinatorOptions.addClaim`/`releaseClaim`); advisory `claim_out_of_order` guard in `SessionClaims.claim` (logger injected); pre-claim ordering invariant documented at the `handleInbound` critical section. Tests: `test/claim-visibility-serialization.test.ts` (incident regression + pre-fix contrast + readiness-before-build + ordering guard) and the activation-claim cases in `test/activation-flow.test.ts`. The abort-aware readiness wait (§6 "Shutdown drain", optional) and §4.4 structural lock / synchronous-at-accept placeholder remain deferred.

---

## 1. Problem — incident

Session `s-woRaQf8Neu` was triggered by a message that arrived **after** the message that triggered `s-KNH6Qqi7uE`. `s-KNH6Qqi7uE`'s trigger carried media, so its launch blocked in `awaitTriggerReadiness` waiting on captioning. During that wait `s-woRaQf8Neu` (no media → no wait) launched, built its context, and ran — **without seeing `s-KNH6Qqi7uE` in the list of currently running sessions**, and so without being deterred from redundantly addressing the same content.

The maintainer's diagnosis is the governing requirement for this spec:

> Waiting for something before a session starts cannot compromise this mechanism — a session needs to claim a trigger message as soon as that message comes in, and the claims must be serialized for sequential messages in the timeline to ensure a session from a later message does not see a previous message unclaimed, nor should it fail to see the previous message's session as running, even if it hasn't actually started yet.

## 2. Root cause — the "is this being handled" signal is split across two registries with different lifetimes

The dedup machinery (DUPLICATE-REPLY-MITIGATION §3–§5) actually has **two** sources of truth, and a new session's context build reads both:

| Signal | Backed by | First exists at | Covers the pre-start gap? |
|---|---|---|---|
| Per-message `<handled_by_session>` marker | `SessionClaims` registry | **trigger-accept**, synchronously, before any `await` — [app.ts `addClaim`](../src/app.ts) at the accept seam | ✅ yes — un-attributed claims render `pending="true"` ([renderer.ts](../src/context/renderer.ts), [builder.ts](../src/context/builder.ts) `snapshotForBuild`) |
| `<active_sessions>` list **and** the code-owned `<coordination>` instruction that gives the marker its meaning | `SessionManager.activeForTimeline` (`status ∈ {created, running}`) | **`createPlaceholder`** inside `launchSession`, which today runs **after** `awaitTriggerReadiness` | ❌ no — empty until the session actually reaches its placeholder |

The `<coordination>` line — the prose that tells the model "messages tagged `<handled_by_session>` are already being answered by another running session; don't reply to them" — is emitted **only when `≥1` other session is in `activeForTimeline`** ([workspace/prompt.ts](../src/workspace/prompt.ts) `renderRuntimeState`, `otherSessionCount > 0`). The proactive scheduler's eligibility gate ([proactive/scheduler.ts](../src/proactive/scheduler.ts)) also reads `activeForTimeline`.

So while `s-KNH6Qqi7uE` is parked in `awaitTriggerReadiness` it **has claimed** (its message *can* render a `pending` marker) but is **absent from `activeForTimeline`**. The concurrent build of `s-woRaQf8Neu` therefore sees, at worst, a bare `<handled_by_session>` marker with **no `<coordination>` line to explain it and an empty `<active_sessions>` list** — exactly "not even seeing it in the list of currently running sessions." The marker without its instruction does not deter. (The live `send_message` guard, which *is* claims-backed, is the only backstop — but it fires at send time, after a full redundant reply has already been generated.)

### 2a. Why `awaitTriggerReadiness` sits before visibility today

The ordering in [`handleInbound`](../src/app.ts) is:

```
accept → addClaim                     (synchronous, await-free critical section)
await resolveTriggerGroup             (fast; persists the trigger group)
await awaitTriggerReadiness           (enrichment + captions — the long wait)   ← BEFORE launch
await launchSession
      tryReplyResume? (await)          (resume fork — adopts an existing session)
      createPlaceholder → markRunning  (← session first appears in activeForTimeline HERE)
      attachSession (claim attributed)
      …budget gate…
      factory.create (context build)   (needs enrichment + captions done)
      run
```

The build is placed **after** the readiness wait precisely because `factory.create` must render an enriched, captioned trigger group. But pulling the wait out in front of `launchSession` means the **placeholder — the thing that makes the session visible as running — is gated behind the wait.**

### 2b. Secondary findings (same root, surfaced while tracing)

`awaitTriggerReadiness` has only **two** call sites today: [`handleInbound`](../src/app.ts) and [`redispatchCoReply`](../src/app.ts). It is therefore **absent** from:

- **the queued-trigger drain** (`triggerCoordinator.complete → launchSession(next, true)`): a queued trigger returns from `handleInbound` *before* the readiness wait (the `decision.action !== "spawn"` early return precedes it), and the drain calls `launchSession` directly, which contains no readiness wait. Drained triggers build with **no guaranteed readiness** (usually a no-op because enrichment finished during the queue wait — but not guaranteed).
- **the reply-resume path** (`runReplyResumeSession`): a resume triggered by a reply that itself carries fresh media builds its resume turn with no guaranteed caption readiness.
- **the activation path** awaits readiness in its *prelude* ([timeline/activation.ts](../src/timeline/activation.ts) `activateTimeline`), and also **never claims** the activating trigger (`accept → launchSession` with no `addClaim`), so the first session's trigger message gets no `<handled_by_session>` marker.

The wait is scattered, duplicated in one place, and missing in three. Consolidating it (below) fixes the incident **and** these gaps at once.

## 3. Invariant (the target)

For any trigger on a timeline:

1. **Claim-at-recognition.** The claim is inserted at the earliest point the event is known to be a fresh spawn/queue — synchronously, in an `await`-free critical section — and nothing that *waits* (enrichment, captions, trigger-group resolution, resume-eligibility I/O) may precede it. *(Already true for the active path; must be extended to the activation path.)*
2. **Visible-as-running before any wait.** From the moment a triggered session is going to run, it is present in `activeForTimeline` (and hence in `<active_sessions>` + the `<coordination>` gate + the proactive gate) **before** it blocks on enrichment/captions — "even if it hasn't actually started yet."
3. **Serialized in arrival order.** For two trigger messages M₁ (earlier) then M₂ (later) on the same timeline, M₁'s claim is inserted, and M₁'s session becomes visible, before M₂ reads either signal. A later message never observes an earlier one as unclaimed or not-running.

## 4. Design

### 4.1 Consolidate the readiness wait into the session-startup seam (core change)

Move `awaitTriggerReadiness` **out of** `handleInbound`/`redispatchCoReply` and **into** the session startup, positioned **after** `createPlaceholder` + `markRunning` + claim-attach (and after the fail-open budget admission gate, so a refused session never waits) and **before** `factory.create`:

```
launchSession (fresh):
      tryReplyResume? (await)
      createPlaceholder → markRunning           ← visible in activeForTimeline NOW
      attachSession (claim attributed) + onSettle(release)
      …budget admission gate (may markDiscarded + drain)…
      await awaitTriggerReadiness(inbound)        ← MOVED HERE: session already visible/running
      factory.create (context build)              ← still sees completed enrichment + captions
      run
```

Effect against the invariant:
- **(2) Visible-before-wait.** `createPlaceholder` sets `status: "created"` and adds the id to `byTimeline`, so `activeForTimeline` (which counts `created` and `running`) includes the session **immediately**, before the captioning wait. `markRunning` + `attachSession` run right after, so during the wait the session is `running` and its claim is **attributed** (the marker renders `id="…"`, not just `pending`). The `<active_sessions>` entry, the `<coordination>` line, and the proactive gate all now reflect it.
- **Build correctness preserved.** The wait still completes before `factory.create`, so the context build renders an enriched, captioned trigger group exactly as today.
- **Secondary gaps closed for free.** Because `launchSession` is the single funnel for fresh spawns, queued drains, **and** the activation launch, every one of those now awaits readiness exactly once, before its build. Add the same wait to `runReplyResumeSession` (after its `adopt → markRunning → attachSession`, before `buildResumeTurn`). Remove the now-redundant waits from `handleInbound` and `redispatchCoReply`.

Single readiness-wait policy after this change: **"a session waits for its own trigger group's enrichment + caption readiness once, immediately after it is registered (visible) and admitted, before it builds context."**

### 4.2 The reply-resume fork

`launchSession` calls `await tryReplyResume(inbound, duplicate)` first; on accept it `adopt`s the *existing* completed session (no `createPlaceholder`), `markRunning`s it (→ `running` → visible in `activeForTimeline`), and attaches the claim — see [`runReplyResumeSession`](../src/app.ts). The resume path therefore already makes the session visible at the same seam; it only needs the **readiness wait inserted** after `markRunning`/attach and before `buildResumeTurn`.

The resume *decision* requires `await`s (durable-row read, `loadCompletedSessionMaterial`, the `acceptResumeGeneration` CAS), so the placeholder/adopt cannot be made synchronous-at-accept without a discard-and-adopt dance (see §4.4, optional). This is acceptable: the resume-decision window contains **no enrichment/caption wait**, so it does not reintroduce the incident; and the trigger is already claimed (un-attributed) from the accept seam in `handleInbound`, so the per-message marker still deters during that short window.

### 4.3 Activation path: add the claim; keep the prelude wait

In [`activateTimeline`](../src/timeline/activation.ts), `addClaim` the activating trigger immediately before its `triggerCoordinator.accept`/`launchSession`, so the first session's trigger message renders a `<handled_by_session>` marker like every other (consistency with invariant 1). The activation **prelude's** `awaitTriggerReadiness` stays where it is — it is entangled with the state-machine ordering (the `inactive → pending` bulk flip must happen only after readiness, invariant #3 in `activation.ts`), and there is no concurrent-session hazard during activation (later triggers are **held** and replayed only after the activating session has launched and is visible). `launchSession`'s own (now-internal) readiness wait is a harmless no-op the second time through.

### 4.4 Serialization guarantee (invariant 3)

The claim is written in an **`await`-free critical section** ([app.ts](../src/app.ts): the span from `triggerCoordinator.accept` through `addClaim`, explicitly documented there as review #5's no-yield window). Synchronous code cannot interleave, so the *only* way two timelines' claims can land out of arrival order is an order-breaking `await` on the path **from event arrival to that critical section**. Today that path's awaits are both order-preserving:

- `gateInbound` for an **active** timeline takes no `await` before returning `"active"` (it only `await`s in the inactive/activating branches, which `return "handled"` and never reach the claim) — so it yields a single already-resolved microtask, preserving the synchronous invocation order in which the provider's `emit` loop dispatched the events.
- `router.route` resolves on the **single-writer queue**, which is strict FIFO in submission order; M₁ (invoked first) submits first and resolves first.
- `steerReplyToActiveSession`, `maybeSynthesizeReplyTrigger`, `coalesceCoTargetReply` are all **synchronous**.

So arrival-ordering holds **today**, but only as an emergent property of "no order-breaking await precedes the claim." This spec promotes it to a **stated, enforced invariant**:

- **Required:** no variable-latency / order-breaking `await` may be introduced on the path from `handleInbound` entry to the `accept → addClaim` critical section (active path). Document this at the critical section alongside the existing review-#5 comment.
- **Guard:** in `SessionClaims.claim`, when inserting a claim for a timeline that already has claims, log a `claim_out_of_order` warning if the new claim's `triggerTimestamp` is older than the newest existing claim's (advisory only — `origin_server_ts` can tie or skew under the trigger-hold; never reorder or drop on it). This surfaces a regression cheaply without a lock.
- **Optional hardening (deferred unless review wants it):** a per-timeline serialized tail around the **active-path** pre-claim span (entry → `addClaim`), so arrival-ordering is guaranteed structurally rather than argued. Must be scoped to exclude the activation prelude (already serialized by the activation guard + held-trigger buffer) to avoid a captioning-length lock hold. Likewise optional: make the **fresh-spawn** placeholder synchronous-at-accept (createPlaceholder in the critical section; the resume fork then `markDiscarded`s the fresh placeholder and adopts) — fuller fidelity to "claim as soon as it comes in," at the cost of a discarded row per resume. Recommended to start **without** these: §4.1 already removes the only long wait (captioning) from in front of visibility, which is what made the ordering observably fail.

## 5. Consumer review — all signals consistent after the fix

| Consumer | Source | After §4.1 |
|---|---|---|
| `<handled_by_session>` marker (rich build) | `SessionClaims.snapshotForBuild` | unchanged — already gap-covered; now also backed by a visible session |
| `<active_sessions>` list | `activeForTimeline` | now includes the captioning-blocked session (visible from `createPlaceholder`) |
| `<coordination>` instruction gate | `activeForTimeline` (`otherSessionCount`) | now fires whenever a sibling is mid-captioning → marker is always explained |
| live `send_message` guard | `SessionClaims.claimantOf` | unchanged (backstop) |
| co-target coalescing / deferral | `SessionClaims.coTargetClaim` + owner status via `coTargetOwnerSteerableSoon` | unchanged; the `created/running`-but-not-agent-live window simply now spans the captioning wait too (already a defined, handled state — defers the co-reply until the owner goes live) |
| proactive eligibility gate | `activeForTimeline` | now correctly blocks a proactive tick while a reply is mid-captioning |

## 6. Edge cases

- **Queued-then-drained trigger.** Now awaits readiness inside `launchSession` before building (previously skipped). Strictly more correct.
- **Budget admission refusal / missing outbound target.** These `markDiscarded` + drain paths run **before** the relocated wait, so a refused/aborted session never blocks on captioning. Order: `createPlaceholder → markRunning → attach → target check → budget gate → readiness → build`.
- **Co-reply steering during the wait.** A reply targeting the blocked session's own message, or its co-target, arrives while the owner is `running` but **agent-not-yet-live**. This is the existing `attachSession → attachAgent` window (`coTargetOwnerSteerableSoon` returns `true` for `created/running`) — the co-reply **defers** and is drained in on `attachAgent`. §4.1 only lengthens this already-handled window by the captioning duration; no new state.
- **Crash recovery.** A crash during the (now longer) `markRunning → snapshot-persisted` window leaves a `running` row with **no `context_snapshot_json`**. Startup healing flips `running → interrupted`; resume-material load returns `null` for a row without a snapshot ([recovery.ts](../src/agent/recovery.ts)), so it is treated as non-resumable and discarded — identical to today's behavior for a crash during `factory.create` (the same window already exists; §4.1 only lengthens it). No new recovery state; the orphaned trigger is re-answerable only by a new user message, same as today.
- **Shutdown drain.** `factory.create` already honors `drainAbort.signal`; relocating the readiness wait just ahead of it does not change drain behavior. (Optional: make the relocated `awaitTriggerReadiness` abort-aware so a session blocked on a stuck caption pool unblocks at drain instead of waiting out its timeout — minor.)
- **Readiness timeout semantics.** `awaitTriggerReadiness` already resolves (does not reject) on its enrichment/caption timeouts, logging `enrichment_timeout`/`caption_timeout`; the session then builds with whatever is ready. Unchanged.

## 7. Testing

- **Regression for the incident:** two triggers on one active timeline; the earlier one's trigger has a pending caption (caption pool stubbed to block). Assert that at the moment the later session's context is built, `activeForTimeline(timeline)` contains the earlier session and the rendered satellite contains both the `<handled_by_session>` marker **and** the `<coordination>` line. (Today: empty list, no coordination line.)
- **Readiness-before-build holds:** assert `factory.create` for a fresh launch still observes `countPendingCaptions == 0` for the trigger group (i.e., the relocated wait still gates the build).
- **Queued drain awaits readiness:** drive a queue, block captions for the queued trigger, assert the drained `launchSession` waits before building.
- **Resume awaits readiness:** reply-resume with a media-bearing reply; assert `buildResumeTurn` runs after caption readiness.
- **Activation claims:** first trigger on an inactive timeline; assert its message renders a `<handled_by_session>` marker once the session is live.
- **Ordering guard:** unit-test `SessionClaims.claim` emits `claim_out_of_order` only when a strictly-older `triggerTimestamp` follows a newer one.

## 8. Files touched (anticipated)

- [src/app.ts](../src/app.ts) — relocate `awaitTriggerReadiness` into `launchSession` (post-`markRunning`/attach, post-budget, pre-`factory.create`); add it to `runReplyResumeSession`; remove the calls in `handleInbound` and `redispatchCoReply`; document the pre-claim ordering invariant at the critical section.
- [src/timeline/activation.ts](../src/timeline/activation.ts) — `addClaim` the activating trigger before its `launchSession` (requires passing/closing over the claim helper into `ActivationCoordinatorOptions`).
- [src/agent/session-claims.ts](../src/agent/session-claims.ts) — optional `claim_out_of_order` advisory guard.
- ARCHITECTURE.md §8 — update the duplicate-reply / parallel-sessions narrative to state the single readiness-wait seam and the visible-before-wait invariant, in the implementing commit.
- [test/](../test) — cases in §7.

## 9. Out of scope / open questions

- The explicit per-timeline serialization lock and the synchronous-at-accept placeholder (§4.4 "optional hardening") are deferred pending review; §4.1 resolves the observed failure without them.
- No change to the trigger-hold, the co-target coalesce window, or the resume-eligibility gates.
