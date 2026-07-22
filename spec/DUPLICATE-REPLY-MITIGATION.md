# Spec: Duplicate-Reply Mitigation — Session Claims, Co-Target Coalescing, and a Reply Guard

**Status**: IMPLEMENTED 2026-06-14 — superseded by ARCHITECTURE.md §8 "Duplicate-reply mitigation" (claim registry `SessionClaims` + co-target coalescing + `spawn_session`) and §"Satellite block and final user turn" (the `<handled_by_session>` marker + the code-owned `<coordination>` line); retained for review. Shipped the "ship first" simple coordination gate (≥1 other active session, §4.2) and only the `coalesce_window_ms` knob (no kill-switch — §9.4 left open). Do NOT delete (retained as the review baseline per CLAUDE.md).

**Post-review follow-up (2026-06-14).** A review of the initial commit found the first cut **skipped un-attributed claims** in all three consumers, contradicting §3.1's queued-deterrence intent and leaving the headline Case B race open during the owner's accept→launch window. Three fixes landed: (1) **deferred coalescing** — co-target coalescing now defers a co-reply whose owner is not yet steerable and steers it in on attach (spec DEFERRED-COALESCING; closes Case B for replies/URLs); (2) the marker + guard now **surface un-attributed claims as "pending"** (review #4), realizing §3.1 and open-question #3 as originally intended (un-attributed → `pending="true"` marker, generic guard text); (3) **claim-release-on-pre-attribution-failure** plus a co-reply settle-race fix (review #2/#3). See ARCHITECTURE.md §8 for the shipped behavior.

---

## 1. Problem

The agent runs **multiple sessions in parallel per timeline** (§8 "Parallel sessions") — a foundational design choice. Two distinct duplicate-reply failure modes fall out of it. Both were observed live on 2026-06-13.

### Case A — cross-reply to a message another session owns

Two users triggered the bot ~10s apart; two sessions spawned (`s-zwFhIVvp5s`, `s-TQBfXQVCYQ`). Vix's message `> plagueis` (`$n3m7…`) was the **trigger** for `s-TQBfXQVCYQ`. It also appears mid-context in `s-zwFhIVvp5s`'s frozen transcript, and `s-zwFhIVvp5s` **also answered it** — so `> plagueis` got two replies.

This is *not* intrinsically wrong: the bot is allowed (and encouraged) to comment on other in-context messages, and we deliberately do not mark the trigger message as special. The problem is narrow: it answered a message that was **already claimed by another running session**.

Both sessions' `<active_sessions>` blocks listed both sessions — so the awareness was technically present — but:
- The block identifies the sibling only by a **160-char body preview** (`triggered_by="&gt; plagueis"`), forcing a fuzzy text-match back to a message in context.
- The rendered `<message external_id="$n3m7…">` carried **no marker** that it was claimed.
- Nothing instructed the model not to answer a claimed message.

### Case B — duplicate response to the same beat

Two different users **both replied to the same prior Miku message** (`$8ArP…`, a spider post) 7s apart — "wait what the fuck is that legit?" and "How truly horrifying, thank you" — spawning `s-CXT90JoyTq` and `s-qD-GMrokIu`, which produced two basically-equivalent answers.

The existing reply-steer path (§8 "Message steering", `steerReplyToActiveSession`, [app.ts](../src/app.ts)) did **not** coalesce them: it only steers when the reply-target belongs to a *still-running* session, and `$8ArP…`'s session had already completed. So two replies to the same conversational beat became two independent twins.

This differs from what delegation was built for (a message that intrinsically belongs to an in-flight rollout). Here the two triggers are co-equal reactions to the same beat.

---

## 2. Unifying concept: a session *claims* its trigger message(s)

Both fixes reduce to one idea: **a running (or queued) session claims the message(s) that triggered it.** The two solutions are the write-side and read-side of that claim.

- **Write-side (Case B):** a near-simultaneous trigger that *shares a reply-target* with an existing claim is **coalesced** into the claimer (steered as a self-explaining interjection) instead of spawning a twin.
- **Read-side (Case A):** claimed messages are **marked "hands off"** in every *other* session's context, and a **live `send_message` reply guard** refuses to reply to a claimed message.

The two read-side pieces (marker + guard) are **complementary, not redundant** — they cover different time windows (see §6).

Coalescing is the stronger fix because it prevents the twin session from ever existing, which also sidesteps Case A for that beat. The marker + guard mop up the residual: two genuinely-independent sessions where one wanders into the other's lane.

---

## 3. The claim registry

A new per-timeline, in-memory registry mapping a **claimed message external-id → owning session/trigger**. It is the single source of truth for both "is this message claimed by someone else" queries.

### 3.1 What is claimed

For each session that is **accepted and not yet settled** (status in the running/queued lifecycle, i.e. from `triggerCoordinator.accept → spawn|queued` until the run settles and evicts), the registry holds the **external-id of its trigger event** (`InboundChatEvent.event.externalId`, the raw `$…` Matrix id — the same form `send_message`'s `reply_to_id` carries and the renderer prints as `external_id`).

- **Scope: running *and* queued.** Queued triggers are claimed too — they will run, and a co-target trigger arriving while one is queued should still coalesce / be deterred. (Maintainer-confirmed.)
- **Trigger event only, for v1.** Not the whole trigger *group* (the lookback can pull in same-sender attachment messages, §"Trigger group resolution"). The trigger event is the message users actually react to; expanding to the group is a possible follow-up but adds false positives (marking older grouped messages).
- The **owning session does not claim against itself** — a session may always reply to its own trigger; the guard/marker only consider *other* sessions' claims.

### 3.2 Why a separate registry instead of reusing `sessions.activeForTimeline`

The session placeholder is created in `launchSession` ([app.ts:1778](../src/app.ts)), which runs **after** `await awaitTriggerReadiness(inbound)` ([app.ts:955](../src/app.ts)). Between `triggerCoordinator.accept` (§ [trigger.ts:23](../src/timeline/trigger.ts)) and that placeholder there is an **async gap**. A second trigger's coalescing/guard check that consulted `activeForTimeline` could miss the first session whose placeholder hasn't been created yet. (`<active_sessions>` listed both siblings only because *build* time — later still — is past both placeholders; the *decision* point is earlier.)

The registry therefore must be written **synchronously at accept time**, before any `await`, so a concurrent inbound handler observes the claim. This is the fix for the residual race the maintainer flagged.

### 3.3 Lifecycle

- **Add**: synchronously, the instant a trigger is accepted for spawn-or-queue. Concretely, in `handleInbound` immediately after `triggerCoordinator.accept(inbound)` returns `spawn` **or** `queued` (both claim; `ignored` does not), keyed by `inbound.event.externalId`, with no intervening `await`. Store `{ sessionId? , triggerId, externalId, createdAt }` — `sessionId` is backfilled when the placeholder is created (or we key the claim by the trigger/inbound id and associate the session later; either works as long as the *insert* is synchronous-at-accept).
- **Remove**: when the session settles and is evicted (the existing settle/evict seam in `SessionManager`, and the `triggerCoordinator.complete` path). Removal on evict mirrors how `activeForTimeline` empties, so a completed session stops deterring others — which is exactly the existing "once a session completes, the next session sees its replies and is deterred by content" behavior, now made explicit for the in-flight window.
- **Queued → spawned**: no registry change needed — the claim already exists from accept time and simply persists across the queued→running transition.
- A claim whose session never spawns (queue dropped, drain) is removed on the same settle/teardown path; if a queued trigger is discarded without a session, remove its claim explicitly.

### 3.4 Surface

A small holder (e.g. `SessionClaims`, `src/agent/` or `src/timeline/`) exposing:

- `claim(timelineKey, externalId, ref)` — synchronous insert.
- `release(timelineKey, externalId | sessionId)` — on settle.
- `claimantOf(timelineKey, externalId): { sessionId } | undefined` — live lookup, **excluding** a caller-supplied "self" session id (so a session never sees its own claim). Used by the guard and the coalescing check.
- `coTargetSession(timelineKey, replyTargetExternalId): { sessionId } | undefined` — returns a running session whose **trigger's own reply-target** equals `replyTargetExternalId` (Case B). This requires the registry to also index, per claim, the trigger's `replyTo.externalId` (the *target the trigger replied to*), not just the trigger's own id.

So each claim entry carries **two** ids: the trigger's own `externalId` (for the marker/guard) and the trigger's `replyTo?.externalId` (for co-target coalescing).

---

## 4. Read-side piece 1 — the `<handled_by_session>` render marker (Case A)

At context-build time, any timeline event whose `externalId` is claimed by **another** active/queued session is rendered with a child marker:

```xml
<message sender="@vix:example.com" ... external_id="$n3m7…">
  <handled_by_session id="s-TQBfXQVCYQ"/>
  > plagueis
</message>
```

### 4.1 Where

`renderRichMessage` ([renderer.ts:56](../src/context/renderer.ts)) gains an optional input — the set of claimed external-ids (or a `claimedBy(externalId): sessionId | undefined` predicate) — threaded through `RenderRichOptions`. The builder passes a closure bound to the current session's id (so self-claims are excluded) and the claim registry snapshot taken at build time.

The render path for timeline events is `compactTimelineEvents(compactionInput, renderRichMessage, renderCompactMessage, …)` ([builder.ts:399](../src/context/builder.ts)). The two renderer callbacks must be replaced with claim-aware closures, OR `compactTimelineEvents` must forward a per-event claim predicate. The marker is **rich-tier only** — see §4.3.

### 4.2 The explanation line — code-owned, conditional, co-located with `<active_sessions>` (NOT TAIL.md)

The tag needs one line of explanation. That line is a **harness-owned coordination instruction**, rendered by code, **not** a TAIL.md edit. Decided 2026-06-14 (maintainer):

> Messages tagged `<handled_by_session>` are already being answered by another running session. Don't reply to or address them — you may still use them as context.

The final clause is load-bearing: it preserves the wanted behavior (commenting on / referencing other in-context messages) and forbids only re-answering a claimed one.

**Why not TAIL.md.** The dedup rule is a *system invariant*, not persona/style. TAIL.md is workspace-owned (miku-ws repo) operator/persona content. Putting the line there would (a) let an agent silently opt out of a coordination invariant by omitting/rewording it, (b) emit it *unconditionally* — every session in every timeline, even with zero other sessions and zero `<handled_by_session>` tags in context — as standing noise for a rare condition, and (c) split ownership of one feature, since the other three model-facing surfaces (the tag, the coalescing interjection §5.3, the `send_message` guard error §6.2) are already code-rendered. Moving it into code makes the whole feature harness-owned and consistent; TAIL.md stays purely persona/style. A per-agent override is the wrong tool for this; the only intended knob is the optional config kill-switch (§8), never TAIL.

**Where.** Inside `<runtime_state>`, as a child block of `<active_sessions>`, rendered by `renderRuntimeState` ([prompt.ts:188](../src/workspace/prompt.ts)) — the same code-generated, already-conditional, volatile-per-build region that carries the timestamp + session list (so it is never part of the cached prefix; a conditional line there costs nothing cache-wise, unlike a conditional line in stable TAIL). Co-location is also semantically right: `<handled_by_session id="s-X"/>` references a session id, and `<active_sessions>` lists those same ids, so the explanation sits exactly where the model resolves tag ↔ session:

```xml
<active_sessions>
  <session id="s-TQBfXQVCYQ" started="..." triggered_by="&gt; plagueis"/>
  <session id="s-zwFhIVvp5s" started="..." triggered_by="..."/>
  <coordination>Messages tagged &lt;handled_by_session&gt; are already being answered by another running session. Don't reply to or address them — you may still use them as context.</coordination>
</active_sessions>
```

**When to show it.** Gate on the signal, not always-on:
- **Simple (ship first):** render `<coordination>` whenever there is **≥1 other active session** (the only condition under which a marker could appear). Phrase as "any message tagged…", so it's a harmless no-op if no tag is in the visible window. Note `<active_sessions>` lists *all* sessions including self, so the gate is "≥1 entry other than the current session id," not merely "block non-empty."
- **Tight (refinement):** render only when **≥1 `<handled_by_session>` marker was actually emitted** this build — zero noise when no claimed message is visible. Needs the builder to thread a "marker emitted" boolean from transcript rendering ([builder.ts:399](../src/context/builder.ts)) into the satellite render ([builder.ts:454](../src/context/builder.ts)); the ordering (transcript compacted before satellite assembled) supports it.

Prompt additions stay minimal: a self-describing tag plus one conditional code-owned line — **not** three separate mechanisms, and **nothing** in the workspace repo for this feature.

### 4.3 Determinism / cache interaction

The deterministic-rendering invariant (§9 "Deterministic rendering invariant") keeps the compact (frozen) prefix byte-stable so the LLM cache prefix holds. Claims are **inherently recent** — an active session's trigger is within the active window, near the tail — so a `<handled_by_session>` marker lands in the **rich, cache-volatile tail region**, never the compact prefix. The marker therefore does not disturb the cached prefix. (If a claimed event were ever old enough to render at the compact tier, the compact renderer omits the marker — compact tier already strips reactions etc. for exactly this byte-stability reason.) This must be verified, not assumed, in implementation: the marker must not be emitted by `renderCompactMessage`.

### 4.4 Build-time snapshot limitation (motivates the guard)

The marker is frozen into the built context. It can only reflect claims that existed **at this session's build time**. A sibling that starts *after* this session's context is built claims a message that was unclaimed (hence unmarked) when this session rendered it. The marker structurally cannot cover that later-claim race — the live guard (§6) does.

---

## 5. Write-side piece — co-target coalescing + self-explaining interjection (Case B)

### 5.1 Trigger condition: shared reply-target

A new inbound trigger that **is a reply** (`inbound.event.replyTo?.externalId` present), whose reply-target equals a currently-running session's **trigger's** reply-target (`coTargetSession` hit), is **steered into that session as an interjection instead of spawning**.

This generalizes the existing steer rule (§8 "Message steering"): today's `steerReplyToActiveSession` is the special case where the reply-target *is* the running session's own authored message. The new condition adds: the reply-target is the *same message a running session itself replied to*. Use **shared reply-target**, not bare temporal proximity — proximity alone would wrongly merge the independent questions of Case A. A coalesce window (config, see §8) bounds it so two replies hours apart don't coalesce.

Order of checks in `handleInbound`, after persistence/enrichment-nudge and before spawn:
1. Existing `steerReplyToActiveSession(inbound)` (reply targets a running session's *own* message) — unchanged.
2. **New**: co-target coalescing — reply targets the same message a running session's trigger replied to, within the window → steer + return.
3. Else fall through to `triggerCoordinator.accept` + spawn (and claim, §3.3).

### 5.2 Fallback when steer fails

If `sessions.steer(...)` returns `false` (the target session is already settling / no longer accepts steering), **fall back to spawning a normal session** (current behavior). This is safe: a session spawned after the sibling settles is built fresh, so the sibling's already-sent replies to the shared target are in its context — the same content-level deterrent that prevents redundancy once any session completes. (Maintainer-confirmed; race conditions notwithstanding.)

### 5.3 Self-explaining interjection wrapper

A coalesced interjection is unsolicited, so it must explain itself. The injected content (analogous to the existing `<interjection>` wrap in `steerReplyToActiveSession`, [app.ts:1237](../src/app.ts)) carries a reason and the framed choice. The decision axis is **same session vs. its own session** — NOT "one message vs. fold into one reply" (the bot may send a second message within this session if that's the natural response):

```xml
<interjection reason="co-reply">
disposablehero replied to the same message you're answering: "How truly horrifying, thank you".
Handle it as part of this session if it fits here (sending a second message is fine) —
or, if it warrants being worked independently, call spawn_session to give it its own session.
</interjection>
```

The interjected event must still be **hydrated** for rendering exactly as `steerReplyToActiveSession` does today (the steer path bypasses enrichment-readiness + `hydrateEvents`, so the raw `replyTo` carries only `externalId`; reuse the existing hydrate-and-fill logic at [app.ts:1221-1235](../src/app.ts) so the injected turn quotes the shared target correctly).

### 5.4 `spawn_session` — the inverse of `delegate_to_session`

A new tool (mirror of [delegate.ts](../src/tools/delegate.ts)) that lets a session **push a coalesced (interjected) request back out into its own fresh session** when it judges it warrants independent handling (e.g. two genuinely different requests — "edit this image blue" vs. "what's the source" — or two heavy tool-using tasks that shouldn't serialize behind one another).

- **Input**: enough to identify which interjected message to spin off (the interjected event id / the inbound it carried). The original `InboundChatEvent` for the coalesced trigger must be **retained on the interjection** so `spawn_session` can re-dispatch it.
- **Effect**: re-dispatch that inbound through the normal spawn path (`triggerCoordinator.accept` + `launchSession` + claim), then the current session **ignores** that interjected request (continues its own work). Unlike `delegate_to_session`, the calling session does **not** terminate — it spun *off* a sibling, it didn't hand over its own work.
- **Failure**: if a slot can't be acquired (concurrency cap / queue), it queues like any trigger, or — if that's undesirable for a spun-off request — returns an explanatory error and the session handles it inline after all. (Open question §9.)

This is the pressure-valve that keeps the parallelism principle intact *when the model judges it necessary*, rather than forcing every co-target beat to serialize into one session.

---

## 6. Read-side piece 2 — the live `send_message` reply guard (Case A backstop)

`send_message` ([send-message.ts](../src/tools/send-message.ts)) takes `is_reply: boolean` + `reply_to_id?: string` (the raw `$…` event id). When `is_reply` is true and `reply_to_id` matches a message **claimed by another session** (live `claimantOf` lookup at send time, excluding self), the tool returns a **non-terminating error** (the existing error-return pattern at [send-message.ts:191](../src/tools/send-message.ts) gives the agent another turn — it does not set `terminate`).

### 6.1 Why it is NOT redundant with the marker

They cover **different time windows**:
- The **marker** (§4) reflects claims at *build* time. Semantic + general (catches addressing-without-a-reply, because it's visible to the model's reasoning). Cannot see claims that arise after build.
- The **guard** is **live** — it queries the registry at send time, so it catches the case the frozen marker structurally cannot: a sibling that started **after** this session's build, claiming a message that was unmarked when this session rendered it. That later-claim race is the residual flagged twice by the maintainer; the guard is what closes it.

So: marker = "claimed before my build, addressed any which way"; guard = "claimed after my build, at the reply chokepoint."

### 6.2 Scope it narrowly + redirect, don't wall

To avoid hamstringing the model (there are legitimate reasons to set a reply without *answering* — e.g. surfacing a past message to bring it to attention):

- **Only `reply_to_id`.** Do not attempt to mechanically detect inline addressing of a claimed message (e.g. "@vix lol plagueis" with no reply marker) — that's the job of the marker + `<coordination>` line (§4). The guard fires on exactly one mechanical signal. Narrow surface ⇒ near-zero false positives. For a *claimed* (recent, actively-handled) message, "wants to reply-to it" and "is answering it" overlap almost totally; the surfacing use-case applies to arbitrary *old* messages, not ones a live session is working.
- **Error is a redirect, not a refusal** — name the correct alternative so the model doesn't just re-send with the reply marker stripped (or flail):

  > error: `$n3m7…` is currently being handled by another session (s-TQBfXQVCYQ). Don't reply to it — that session has it. If you only meant to surface or quote it, send without `is_reply`. If it needs independent handling, that's already covered.

### 6.3 Wiring

The guard needs a **live** lookup, not a build-time snapshot, so the tool is constructed with a closure `isClaimedByOther(externalId): { sessionId } | undefined` bound to the registry + this session's id. `createSendMessageTool` ([send-message.ts](../src/tools/send-message.ts), built in `buildSessionTools` [app.ts:1258](../src/app.ts)) gains this dependency. Same pattern as the `delegate`/`steerSession` closure already injected there.

---

## 7. Call-site summary

| Piece | Files / sites |
|---|---|
| Claim registry | New `SessionClaims` holder; insert synchronously in `handleInbound` right after `triggerCoordinator.accept` ([app.ts:944](../src/app.ts)); release on session evict (`SessionManager` settle seam) and on queued-trigger discard. |
| Co-target coalescing | New check in `handleInbound` between `steerReplyToActiveSession` ([app.ts:937](../src/app.ts)) and `triggerCoordinator.accept` ([app.ts:944](../src/app.ts)); reuse hydrate-and-fill from [app.ts:1221-1235](../src/app.ts). |
| Interjection wrapper | New `reason="co-reply"` wrap; retain original `InboundChatEvent` on the interjection for `spawn_session`. |
| `spawn_session` tool | New `src/tools/spawn-session.ts` (mirror of [delegate.ts](../src/tools/delegate.ts)); register in [tools/index.ts](../src/tools/index.ts) and `buildSessionTools` ([app.ts:1258](../src/app.ts)). |
| Render marker | `renderRichMessage` + `RenderRichOptions` ([renderer.ts:46-80](../src/context/renderer.ts)); thread claim predicate through `compactTimelineEvents` call ([builder.ts:399](../src/context/builder.ts)); never emit in `renderCompactMessage`. |
| `<coordination>` explanation line | Code-owned, NOT TAIL.md. Rendered as a conditional child of `<active_sessions>` in `renderRuntimeState` ([prompt.ts:188](../src/workspace/prompt.ts)); gated on ≥1 other active session (or marker-emitted, §4.2). Nothing lands in the workspace repo for this feature. |
| `send_message` guard | `createSendMessageTool` ([send-message.ts](../src/tools/send-message.ts)) + new `isClaimedByOther` dep wired in `buildSessionTools` ([app.ts:1258](../src/app.ts)). |
| Config | New keys under `[agent.sessions]` (coalesce window) — see §8. |

---

## 8. Configuration

| Key | Default (proposed) | Meaning |
|---|---|---|
| `agent.sessions.coalesce_window_ms` | 60000 | Max age difference between a new co-target reply and a running session's trigger for §5 coalescing to fire. Short by chat standards (a minute) so only near-simultaneous reactions to the same beat merge. |

Per the "explicit deployment config" convention, ship the default in `config/00-defaults.toml` and set it explicitly in local config; fail-fast on missing/invalid.

The marker, guard, and claim registry have no knobs — they are always-on correctness mechanisms (the registry is just in-memory bookkeeping). If a kill-switch is wanted for rollout, a single `agent.sessions.duplicate_reply_mitigation = true|false` gating all of §4–§6 could be added; default on.

---

## 9. Open questions

1. **`spawn_session` under concurrency pressure.** If the spun-off request can't get a slot (cap reached / queue), should it (a) queue like any trigger, (b) error back so the session handles it inline, or (c) queue but tell the model it's queued? Leaning (a) — a spun-off request is a real trigger and queuing is the normal backpressure — but (b) avoids a spun-off request stalling behind the very session it was spun from. Decide at implementation.
2. **Claim granularity.** v1 claims only the trigger *event*. Should it claim the resolved trigger *group* (same-sender lookback messages)? Group-claiming reduces a rarer cross-reply but risks marking older grouped messages as "handled" when only the latest was the real trigger. Default: trigger event only; revisit if Case A recurs on grouped messages.
3. **Marker visibility for queued (not-yet-running) claims.** We mark queued claims too (§3.1). Confirm the model reads `<handled_by_session>` sensibly when the owning session hasn't produced output yet — it should, since the instruction is "another session will answer this," not "another session already answered."
4. **Kill-switch granularity** — single flag for all of §4–§6, or independent? (§8.)

---

## 10. What this deliberately does NOT do

- **Does not hide unhandled/in-flight messages from context.** Rejected by the maintainer: sessions can take a long time to settle, and hiding messages risks context-consistency problems. Claimed messages stay fully visible; only re-answering is deterred.
- **Does not mark the trigger message as special to its own session.** We continue to place the trigger at the end of context without a "this is your trigger" flag (§"Frozen context"); the bot may still comment on any in-context message — except ones another live session has claimed.
- **Does not serialize all parallel work.** Coalescing fires only on the narrow shared-reply-target + window condition, and `spawn_session` restores full parallelism on demand. The parallel-sessions model is preserved.
- **Does not eliminate the fundamental race.** Two triggers whose accept-time claims interleave within the same microtask-free window are still theoretically possible; the synchronous-at-accept claim (§3.2) shrinks the window to essentially nil, and the live guard (§6) catches the after-build variant, but no scheme makes truly-simultaneous independent triggers impossible. This is accepted (inherent to the parallel model).
