<script lang="ts">
	import { consumeSessionStream } from '$lib/api/live';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import { isDuplicateInjectedTurn, isInjectedUserTurn, type RolloutMsg } from '$lib/rollout';
	import Rollout from './Rollout.svelte';

	// `onHead` surfaces the seed's sliced-off leading final-turn messages (the
	// trigger turn) to the parent. They belong to the verbatim input view, not the
	// rollout, but the persisted transcript head isn't flushed until the first
	// turn_end and the session query isn't refetched mid-run — so without this the
	// trigger turn is missing from the verbatim view until the run completes.
	let {
		sessionId,
		onEnd,
		onHead
	}: { sessionId: string; onEnd?: () => void; onHead?: (head: RolloutMsg[]) => void } = $props();

	let messages = $state<RolloutMsg[]>([]);
	let streaming = $state<RolloutMsg | null>(null);
	// Tentative tokens (spec LLM-FAILURE-HANDLING §4.2): Layer-0 buffers each LLM
	// attempt to its terminal event, so tokens stream live ONLY via the tap's
	// `tentative_event`s — not yet committed. An `attempt_discarded` clears them
	// and shows a retry notice; authoritative events always win over tentative.
	let tentative = $state<RolloutMsg | null>(null);
	let retryNotice = $state<string | null>(null);
	// Post-seed dedup window (not reactive — control state only). A turn committed
	// to `agent.state.messages` just before we attach can appear in the seed AND
	// fire a later `message_start`, rendering twice (the "printed twice, fixed on
	// refresh" symptom). True from a `rollout_seed` until the first `turn_end`;
	// while true, a `message_start` that duplicates a seeded turn is dropped.
	let recentlySeeded = false;

	// Fold a live AgentEvent into the accumulating message list (spec §10b). The
	// per-event payloads are `any` upstream, so we narrow defensively.
	function fold(evt: { type: string; [k: string]: unknown }) {
		switch (evt.type) {
			case 'rollout_seed': {
				// The handler's mid-run catch-up: the canonical accumulated state at
				// stream-open (`agent.state.messages`), sent before any live event
				// (Agent.subscribe is future-only, so without this an attach mid-run
				// rendered empty until the next turn). Wholesale replace; the head
				// final-turn messages belong to the verbatim input view, so slice at
				// the server-computed rolloutStartIndex (same contract as getSession).
				const msgs = Array.isArray(evt.messages) ? (evt.messages as RolloutMsg[]) : [];
				const start = typeof evt.rolloutStartIndex === 'number' ? evt.rolloutStartIndex : 0;
				messages = msgs.slice(start);
				// A seed is a fresh canonical snapshot: drop any in-flight ephemeral left
				// over from a prior (dropped) connection, else a stale `streaming`/
				// `tentative` partial would render on top of the now-committed message
				// after a reconnect re-seeds.
				streaming = null;
				tentative = null;
				retryNotice = null;
				// Hand the leading final-turn messages (trigger turn) to the parent for
				// the verbatim input view; the rollout itself begins at `start`.
				onHead?.(msgs.slice(0, start));
				// Open the dedup window: until the first turn_end, a message_start that
				// re-delivers a turn already in this seed is a duplicate (see below).
				recentlySeeded = true;
				break;
			}
			case 'tentative_event': {
				const inner = evt.event as { type?: string; partial?: RolloutMsg } | undefined;
				if (!inner) break;
				if (inner.type === 'done' || inner.type === 'error') {
					// Terminal: a clean done commits (authoritative events follow at
					// once); an error either retries (an attempt_discarded follows) or
					// surfaces through the authoritative stream. Clear the partial.
					tentative = null;
				} else if (inner.partial) {
					tentative = inner.partial;
					retryNotice = null;
				}
				break;
			}
			case 'attempt_discarded': {
				tentative = null;
				const reason = typeof evt.reason === 'string' ? evt.reason : 'request failed';
				retryNotice = `attempt ${evt.attempt} failed (${reason.slice(0, 200)}) — retrying`;
				break;
			}
			case 'turn_end': {
				if (evt.message) messages.push(evt.message as RolloutMsg);
				for (const tr of (evt.toolResults as RolloutMsg[]) ?? []) messages.push(tr);
				streaming = null;
				tentative = null;
				retryNotice = null;
				// A turn committed: the seed/message_start race window is closed, so
				// stop deduping (legitimate repeat interjections must fold normally).
				recentlySeeded = false;
				break;
			}
			case 'message_start': {
				// Injected user turns (interjections — `{type:'interjection'}` — and
				// forced-completion prompts — `{role:'user'}`) are committed mid-run:
				// pi-agent-core emits message_start/message_end carrying the message
				// before pushing it to state, but the following `turn_end` carries the
				// *assistant* reply, not this user turn. So without folding it here it
				// would be missing from the live rollout until the run completes and the
				// persisted record refetches. Assistant messages also fire message_start
				// (streamed via message_update → turn_end) — `isInjectedUserTurn` filters
				// them out. Exclude the leading trigger turn (`triggerGroup`/`satellite`,
				// also `role:'user'`): it belongs to the verbatim input view (`onHead`),
				// not the rollout, and an early attach can surface its message_start here.
				const m = evt.message as RolloutMsg | undefined;
				if (m && isInjectedUserTurn(m) && m.type !== 'triggerGroup' && m.type !== 'satellite') {
					// Drop a message_start that merely re-delivers a turn the seed already
					// carried (only in the post-seed window, so steady-state repeats fold
					// normally) — otherwise the injected turn renders twice.
					if (recentlySeeded && isDuplicateInjectedTurn(messages, m)) break;
					messages.push(m);
				}
				break;
			}
			case 'message_update':
				streaming = (evt.message as RolloutMsg) ?? null;
				tentative = null;
				break;
			case 'message_end':
				streaming = null;
				break;
			case 'agent_end':
				// A turn boundary, NOT the end of the stream: a run emits one `agent_end`
				// per agent-loop invocation (kickoff + each forced-completion prompt), and
				// the server keeps the stream open across all of them, closing only on run
				// settlement (ARCHITECTURE.md §11). So just clear the per-turn ephemeral
				// state and keep folding — the next turn's injected user turn / assistant
				// reply still arrive on this same stream. `evt.messages` (the whole
				// `agent.state.messages`, still carrying the leading trigger turn) is
				// deliberately ignored: replacing `messages` wholesale would briefly render
				// that trigger turn as raw JSON. When the stream finally closes, `onEnd`
				// refetches the persisted record, which SessionView renders via the non-live
				// `Rollout` (transcript.slice(rolloutStartIndex)) — identical to this view
				// with no flicker (spec §10b: "on completion it is identical to the
				// persisted record").
				streaming = null;
				tentative = null;
				recentlySeeded = false;
				break;
		}
	}

	// Consume the live SSE stream for the current session ($lib/api/live.ts — a real
	// event-log byte stream, NOT a query.live: live queries keep only the latest
	// pending value under backpressure, which dropped burst-committed events like
	// `turn_end` and left this view empty). `consumeSessionStream` adds reconnect +
	// re-attach: it survives a dropped connection (proxy idle-timeout / network blip
	// / agent restart) instead of freezing until a manual refresh, and re-checks on
	// a clean settlement so a resumed run (resume / follow-up-fold reuse the same id)
	// is picked up seamlessly. It resolves ONLY when the session is definitively
	// terminal (`not_live`) or we abort. Teardown aborts the controller, which kills
	// the in-flight fetch end-to-end so the agent releases its `Agent.subscribe`
	// listener immediately (spec §3.3 / §14).
	$effect(() => {
		const id = sessionId;
		messages = [];
		streaming = null;
		tentative = null;
		retryNotice = null;
		recentlySeeded = false;
		contextSummary.set({ live: true });
		const controller = new AbortController();
		void consumeSessionStream(id, {
			signal: controller.signal,
			onEvent: (evt) => fold(evt)
		}).finally(() => {
			// Resolved without an abort = the session is definitively terminal: the
			// persisted record is now authoritative, so flip the live indicator and let
			// SessionView refetch it. On teardown (aborted) we leave that to the next mount.
			if (!controller.signal.aborted) {
				contextSummary.set({ live: false });
				onEnd?.();
			}
		});
		return () => {
			// Abort the fetch so the SSE + agent subscription tears down now, without
			// waiting for the next event (and so any pending reconnect backoff exits).
			controller.abort();
			contextSummary.set({ live: false });
		};
	});

	// Authoritative streaming wins; a tentative partial renders only while no
	// committed update is in flight (visually dimmed below).
	const rows = $derived(streaming ? [...messages, streaming] : messages);
</script>

<Rollout messages={rows} />
{#if !streaming && tentative}
	<div class="px-3 opacity-60" title="Tentative — this attempt has not committed yet">
		<div
			class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
		>
			Tentative (streaming, uncommitted)
		</div>
		<Rollout messages={[tentative]} />
	</div>
{/if}
{#if retryNotice}
	<div class="px-3 py-1 text-xs text-amber-600 dark:text-amber-400">{retryNotice}</div>
{/if}
