# Follow-up folding (quick same-sender follow-ups)

**Status**: IMPLEMENTED — superseded by ARCHITECTURE.md §8 "Follow-up folding" (+ §8 "Message steering" for the §3 interjection pixels, §6 "Trigger hold" note, §4 config shape); retained for review. Shipped 2026-06-18: `FollowUpWatch` registry + pure form/gate helpers (`src/agent/follow-up-watch.ts`), `foldFollowUp` + steer/park/resume/native-fate orchestration (`app.ts`), `evaluateFollowUpResumeGate`, shared `runResumeSession` (reply-resume + follow-up-resume), `InterjectionMessage.imageBlocks` + `convert.ts`, `ContextBuilder.conditionEventImages` + `buildResumeTurn` preamble, `[agent.sessions.followup]` schema/defaults/validation, `test/follow-up-folding.test.ts`.
**Target ARCHITECTURE.md home once implemented**: §8 "Agent Sessions" — a new subsection ("Follow-up folding") next to "Message steering (interjections)", "Duplicate-reply mitigation", and "Resumable sessions"; the §4 config schema section for the `[agent.sessions.followup]` knobs; a one-line note in §6 "Trigger hold" describing how the short hold and this mechanism partition the timeline.
**Author/Date**: planning session, 2026-06-17.
**Related**: DUPLICATE-REPLY-MITIGATION, DEFERRED-COALESCING, RESUMABLE-SESSIONS, CLAIM-VISIBILITY-SERIALIZATION.

---

## 1. Problem

Matrix cannot send text and media in one message — they arrive as two events. A user who wants the bot to look at a picture sends them as a pair, in either order:

- **text → media**: `@miku look at this` (triggers), then the image (separate event).
- **media → text**: the image (a reply to the bot, or any DM message — triggers), then the question `what do you think?` (separate event, no `@`).

Today only the **trigger hold** (§6, `emitWithTriggerHold`, default `trigger_hold_ms = 2000`) bridges the gap, and only for the first ordering, and only if the second event lands inside the 2s window. It rarely does: upload, federation, decryption, and (for the agent's view) captioning add lag the *user never sees*, so the second event routinely arrives after the hold has flushed and the session has launched. The hold can't simply be lengthened — it delays the first response to **every** trigger.

The result is one of three bad outcomes:

1. **Lost** — in a group, a bare follow-up (image-only, or text with no `@`) does not trigger at all, so the bot never incorporates it.
2. **Confused** — the session answers the half it has ("what image?" / answering a bare image with no question) because the other half hasn't arrived.
3. **Mis-bound** — the trigger group's backward lookback (`resolveTriggerGroup`, 20s) grabs a *stale* prior image and the bot comments on the wrong one. (This is a **separate** defect in the backward heuristic; see §11. It is out of scope here.)

A fourth failure mode has the same shape but a different trigger form: **fragmentation by re-trigger.** Every `@`-mention spawns its **own** session — there is no same-sender coalescing (co-target coalescing keys on a shared *reply-target*, not the sender; `coalesceCoTargetReply` returns false with no `replyTo`). So a user who knows the bot answers `@`s and fires a quick correction — `@miku weather in Paris` then `@miku actually London` — gets **two parallel sessions**: one answering the superseded Paris, one answering London. The re-`@` was meant to *amend* the first prompt, not start a second.

The symmetry matters: text→media, media→text, and `@`→`@` are all natural ways one intent gets split or amended across quick messages, so the fix must handle a late **media** follow-up, a late **text** follow-up, **and** a quick **re-`@`**. They are levers of one mechanism — *same-sender quick-succession folding*, the same-sender sibling of co-target coalescing — not a media feature with optional text.

## 2. Design overview

**A quick same-sender follow-up is folded into the session its immediately-prior triggering message produced**, instead of being lost, answered in isolation, or spawned as a twin/parallel.

- **Scope by form.** Three forms fold, because none is already owned by a reply-specific path:
  - **bare media** (image-only) — lost (group) or a twin (DM);
  - **bare text** (no `@`) — same;
  - **re-`@`** (a second mention) — a parallel session.
  Folding does **not** touch **replies**: a reply is an explicit per-message address already handled — reply-steer (running session), co-target coalescing (shared target), or reply-to-continue/resume (the bot's answer). The fold is the *same-sender* axis; those are the *reply-target* axis (a reply-after-reply sharing a target is already co-target-coalesced).
- **Quick** = a two-clock gate (§4): a tight user-perceived gap **and** a looser wall-clock lifetime. The gap is **per form**, because confidence-it's-a-continuation falls as the address gets more explicit: forced-split media (highest) > bare text > re-`@` (lowest — an `@` can legitimately be a new ask).
- **Same-sender, same-timeline.** Sender-keyed; the most recent session that sender triggered wins (posting order is causal). Different senders never fold into each other — that is co-target coalescing's job.
- **Three levers**, all on by default, separate windows: `media` (user-gap 10s), `text` (7s), `mention` (5s). Capture only *immediate* follow-ups; the tight `mention` window keeps genuinely-separate `@`s apart.

Delivery depends on the target session's state at the moment the follow-up is ready:

| Target session state | Delivery |
|---|---|
| running (agent live) | **steer** an `<interjection>` carrying the content (and real image blocks) |
| created / queued / pre-`attachAgent` | **park**, drain on go-live (steer); release to native fate if abandoned |
| settled (`completed`) | **resume** — append the follow-up as a new turn and continue the rollout |

This reuses two existing machineries almost wholesale: the interjection/steer path (DUPLICATE-REPLY-MITIGATION, made image-capable in §3) and the resumable-sessions path (RESUMABLE-SESSIONS), with a different gate set (§5.3).

**Why resume, not a fresh session, for the settled case.** The follow-up is part of one human intent spread across quick messages — a forced-split image, a trailing question, or an amending re-`@`. Resuming continues the same rollout and reinforces "this is one prompt," as a person would: answer, notice the thing that lands a beat later, react. A fresh session would discard that framing and (for the bare forms) often could not even be triggered. The agent can still `spawn_session` if the follow-up proves genuinely separate.

## 3. Interjections must carry image pixels

Today a steered interjection is delivered as a **string** (`convert.ts`: `{ role: "user", content: "<interjection>…</interjection>" }`). Image pixels reach the model only as `imageBlocks` on `triggerGroup`/`satellite`/`chatEvent` messages (`contentWithImages`). So a steered image currently degrades to its caption.

Fix — a one-field change, since `InterjectionMessage` sits beside the message types that already carry blocks:

- `src/agent/messages.ts`: add `imageBlocks?: ImageBlock[]` to `InterjectionMessage`.
- `src/agent/convert.ts`: in the `interjection` branch, build content via the existing `contentWithImages(message.content, message.imageBlocks)` helper instead of the bare string.

This also fixes a pre-existing latent bug: a **co-reply** that itself contains an image drops it to a caption today; after this change it carries pixels too.

## 4. Detection — the two-clock gate

Two independent clocks guard two independent failure modes:

- **User gap** — `|followup.origin_server_ts − trigger.origin_server_ts|`, the gap *as the user experienced it*. Tight, per form (media 10s, text 7s, re-`@` 5s). Guards **false-merges**: did the user actually send these close together. Tighter as the address gets more explicit (a re-`@` is likelier to be a fresh ask).
- **Wall-clock lifetime** — real time since the watch was armed. Looser (media 30s, text 15s, re-`@` 12s). Guards **staleness and registry lifetime**: absorbs upload/federation/decrypt/caption lag without resurrecting an ancient session.

A follow-up qualifies only if **both** pass. The decomposition is sound *because the scope is same-sender*: both events originate on that user's homeserver, so their `origin_server_ts` share one clock and the gap is reliable. (Cross-sender, federation skew would make the gap meaningless — one more reason same-sender is the right scope.) Text needs less wall-clock slack than media because text has no upload/caption lag; media's slack is mostly captioning + upload.

Both clock types already exist in the code: origin-ts diffing in the co-target coalesce window (`Math.abs(event.timestamp − triggerTimestamp)`), wall-clock in the trigger-hold timer. This composes them.

### 4.1 The watch registry (`FollowUpWatch`)

A per-timeline, in-memory map analogous to `SessionClaims`, but keyed and lifetimed differently:

- **Key**: `(timelineKey, senderId)`.
- **Value**: `{ sessionId?, triggerOriginTs, armedAtWallClock }`.
- **Armed/replaced** when a session is launched **or resumed** for that sender — most-recent overwrites (causal posting order).
- **`sessionId` is backfilled** at the *same seam the claim is attributed* (inside `launchSession`, after the resume-vs-fresh fork resolves — see §7), so it always names the session that actually handled the trigger, fresh or resumed.
- **Persists past settle** (unlike a claim, which releases on settle): the settled→resume path needs to find the just-completed session. The watch is GC'd when its wall-clock lifetime elapses (a single timer at the larger of the per-lever `wall_clock_ms`).
- **Liveness is resolved at follow-up time**, not stored: `SessionManager.get(sessionId)?.status` (running/created) vs. the durable row (`completed`) decides steer/park/resume.

Proactive and synthetic worker sessions (`summarize`/`condense`/`diary`) do **not** arm watches — there is no human follow-up to fold.

## 5. Delivery

### 5.1 Running → steer

Build the interjection content from the follow-up event and steer it into the live session (`SessionManager.steer` with a `session_interjections` `source`, exactly like reply-steer / co-reply):

- **Readiness**: the steer path bypasses `awaitTriggerReadiness`. For pixels, wait only on the follow-up event's **enrichment download + conditioning**, *not* captioning (the slow pool; irrelevant to pixels — the event is still captioned normally for history). Text follow-ups need no media wait.
- **Image blocks for one event** (the only genuinely new plumbing): the sole producer of `ImageBlock`s today is the builder's private `selectImageBlocks`, which is trigger-group-scoped. Either give the follow-up event a one-event trigger group and reuse it, or factor out a small `conditionEventImages(event) → ImageBlock[]` around the existing `processImageForInference` loop. **No-pixels branch**: if the image isn't downloaded in time or `processImageForInference` throws, steer the caption-only interjection rather than block.
- **Hydration**: render via `renderRichMessage` on a hydrated copy (reuse `buildReplyHydratedEvent`'s approach) so any reply context the follow-up itself carries renders normally.

### 5.2 Pre-running → park

If the watch names a session that is `created`/queued or in the `attachSession → attachAgent` gap, it is not yet steerable. Park the follow-up (keyed by the owner) and drain it in `launchSession` right after `attachAgent`, mirroring `drainPendingCoRepliesIntoSession`. **Abandonment fallback is form-dependent** (principle: a non-trigger never starts its own session; a real trigger must never be lost): a **trigger-bearing** follow-up (re-`@`, or any DM message) is **re-dispatched as its own trigger** (reuse `redispatchCoReply`'s tail) — the user explicitly addressed the bot, so it must get a response; a **bare group** follow-up (non-trigger) reverts to inert (= today, no loss). The same split governs a capability-gated settled-resume (§5.3).

### 5.3 Settled → resume (a sibling of reply-to-continue, not a caller of it)

Reuse the resume machinery — `acceptResumeGeneration` (CAS), `loadCompletedSessionMaterial`, `ContextBuilder.buildResumeTurn`, factory `resumeContinuation`, `runReplyResumeSession` — but with a **different gate set**, because reply-resume's gates encode a different intent:

- **Drop the work gate.** It exists to refuse resuming pure-chat rollouts (`src/agent/work-gate.ts`). Here the rationale is inverted: "this is part of the same prompt," so a toolless "look at this" session is *exactly* what we resume.
- **Own enablement**, separate from `[agent.sessions.resume].enabled` — follow-up folding switches independently of reply-to-continue.
- **Keep**: the **generation CAS** (single-consumption — one fold-resume per state; a racing second fold gets nothing), the **capability/context-ceiling gate** (an image is token-heavy; a resume that would instantly re-park is pointless — on failure, §6 native fallback), and **same-sender** (structural via the watch).

The follow-up event becomes the resume turn's trigger, so `buildResumeTurn` → `selectImageBlocks` delivers its image with real pixels (one-event group). A settled→resume fold **re-arms the watch** to the resumed session, so a subsequent follow-up chains to it (linear, like reply-resume).

## 6. Single-consumption

A follow-up event must reach exactly one destination. Precedence:

1. **Already in a pending trigger group (the hold).** Sequenced naturally by *arming time*: the watch is armed only **after** the prior trigger launches, so an event that arrives during the hold sees no watch and is grouped into turn 1 as today. A `not already in trigger_group_id` check is the belt-and-suspenders second clause.
2. **Steer** (running) / **park** (pre-live) / **resume** (settled) — the fold.
3. **Native fate** (nothing folded) — a trigger-bearing follow-up (re-`@` in any room, or any DM message) spawns its own session as today; a bare group non-trigger stays inert (= today, no loss).

A trigger-bearing follow-up (a DM image) reaches `handleInbound` twice (raw emit + post-hold emit, §6 trigger-hold double-delivery). Consume once and mark the event id, suppressing the second delivery — reuse/extend the existing `steeredEventIds` bounded-FIFO dedup.

The agent always retains `spawn_session` to break a folded follow-up out into its own session if it judges it doesn't belong (existing precedent; named in the interjection text, §10).

**Placement in `handleInbound`**: a `foldFollowUp(inbound)` fork immediately after `steerReplyToActiveSession` (a reply to a running session still interjects first) and before `maybeSynthesizeReplyTrigger` / the `if (!inbound.trigger) return` / `accept`. It runs before the `!inbound.trigger` return to catch group **non-triggering** bare follow-ups, **and** before `accept` to intercept **trigger-bearing** follow-ups (a re-`@`, or a DM message) that match a watch — suppressing the parallel session they would otherwise spawn. It **skips replies** (`inbound.event.replyTo` present), which keep their existing routing (reply-steer here; co-target coalescing / resume downstream). It is the same-sender-keyed analogue of `coalesceCoTargetReply`, placed earlier so it can also catch the non-triggering forms.

**CLAIM-VISIBILITY-SERIALIZATION relevance**: that work made a triggered session claimed and visible-as-running *before* it blocks on captions — precisely the window a fast follow-up lands in — so the watch reliably observes the owner as running and picks steer/park instead of mis-deciding settled/absent.

## 7. Resume-chain invariance

The mechanism must behave identically whether the prior trigger spawned fresh or **resumed** an existing session (RESUMABLE-SESSIONS). Because the watch backfills `sessionId` at the seam *after* the resume-vs-fresh fork (`tryReplyResume`) resolves — the same seam `sessionClaims.attachSession` uses — it always names the live session, resumed or fresh. No special logic; the requirement is simply to arm/backfill at that point and not earlier. A fold that itself resumes re-arms the watch (§5.3), so chains stay linear across mixed reply-resume and follow-up-resume steps.

## 8. Interaction with existing mechanisms

- **Trigger hold (§6)** stays; it owns the pre-launch regime (image inside 2s → turn 1, pixels, no premature reply). Follow-up folding owns the post-launch tail. With folding in place, the hold *could* be shortened (its only remaining value is suppressing the occasional premature first reply) — flagged, not changed here.
- **Backward lookback (§7 trigger group)** is unrelated (it handles media-then-text *ordering*, where the image is already in the past) and its stale-image mis-bind is a separate defect — out of scope.
- **Claims / duplicate-reply** unaffected: folding consumes the follow-up before `accept`, so no claim is created for it; the owner's own claim/marker/guard behavior is unchanged.
- **Enrichment / captioning / summarization / search / diary** unaffected: the follow-up is a normal persisted timeline event, enriched and indexed regardless of the fold. Folding is an *extra delivery*, not a substitute for ingestion.

## 9. Configuration

```toml
[agent.sessions.followup.media]
enabled = true
user_gap_ms = 10000     # max user-perceived gap (origin-ts diff) trigger→media
wall_clock_ms = 30000   # watch lifetime; absorbs upload/federation/decrypt/caption lag

[agent.sessions.followup.text]
enabled = true
user_gap_ms = 7000      # tighter — text could have carried the @ and didn't
wall_clock_ms = 15000   # text has no upload/caption lag

[agent.sessions.followup.mention]
enabled = true
user_gap_ms = 5000      # tightest — an explicit re-@ may be a new ask; keep separate @s apart
wall_clock_ms = 12000
```

Cross-field validation at app wiring (like the resume block). Shipped explicitly in `00-defaults.toml` per the explicit-config convention. Per-context (dm/group) split is a possible refinement — omitted in v1 because the windows are short enough that context matters little.

## 10. Agent-facing text (curt, explicit)

Steer (running) — media:
```
<interjection reason="follow-up-media">
{sender} sent this {n}s after the message you're handling, without addressing you again. Matrix sends images separately, so this is probably the image they meant — but it wasn't explicitly triggered. Use judgment: fold it into your reply if it fits, ignore it if it doesn't, or call spawn_session(message_id="{externalId}") to handle it on its own.

{rendered message + image block}
</interjection>
```

Steer — text:
```
<interjection reason="follow-up-text">
{sender} sent this {n}s after the message you're handling, without addressing you again — likely a continuation of the same thought. Use judgment: treat it as part of the request if it fits, ignore it if unrelated, or call spawn_session(message_id="{externalId}").

{rendered message}
</interjection>
```

Steer — re-`@`:
```
<interjection reason="follow-up-mention">
{sender} @'d you again {n}s after the message you're handling — probably amending or adding to it. Fold it into this reply if it continues the same request; if it's a genuinely separate ask, call spawn_session(message_id="{externalId}") to give it its own session.

{rendered message}
</interjection>
```

Resume (settled): the appended `buildResumeTurn` turn carries the same one-line preamble before the rendered follow-up, so the resumed rollout knows the new turn arrived as a quick follow-up (and, for a re-`@`, that it was explicitly re-addressed).

## 11. Out of scope

- The backward-lookback stale-image mis-bind (separate defect in `resolveTriggerGroup`).
- Whole-album block delivery (v1 accepts the `selectImageBlocks` one-tier cap: a separate-event album delivers one image as a block, the rest as captioned text refs the agent can open with `media`).
- Shortening/removing the 2s trigger hold.
- Folding follow-ups from a *different* sender (the co-reply path already covers different-sender replies to a shared target).

## 12. Open questions / chosen defaults

1. **Windows** — media 10s/30s, text 7s/15s, mention 5s/12s, all on. (Chosen; tune in config.)
2. **dm/group split** — none in v1. (Chosen; easy to add.)
3. **Capability-gate failure** (settled session too large to resume) — release to native fate (DM own-trigger / group inert), never a forced new session. (Chosen.)
4. **Conditioning** — reuse `selectImageBlocks` via a one-event group vs. a factored `conditionEventImages` helper. (Implementer's call; behavior identical.)
5. **Hold shortening** — left to a follow-up change once folding is observed in production.

## 13. Testing notes

- Two-clock gate: media/text arriving inside vs. outside each clock; same-sender origin-ts comparability.
- Each delivery regime: running (steer + pixels), pre-live (park → drain), settled (resume + generation CAS single-consumption).
- Bare-only scoping: a reply or `@` follow-up takes its existing path, not the fold.
- DM double-delivery dedup (raw + post-hold) consumes once and suppresses the twin.
- Resume-chain invariance: prior trigger that resumed → follow-up folds into the resumed session; fold-resume re-arms for the next follow-up.
- Native fallback: abandoned owner / capability-gated resume reverts correctly (group inert, DM own-trigger).
- Group non-trigger capture: bare text/image in a group with an armed watch folds; with no watch, stays inert.
