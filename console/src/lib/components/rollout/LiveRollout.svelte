<script lang="ts">
	import { streamSessionEvents } from '$lib/api/live';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import type { RolloutMsg } from '$lib/rollout';
	import Rollout from './Rollout.svelte';

	let { sessionId, onEnd }: { sessionId: string; onEnd?: () => void } = $props();

	let messages = $state<RolloutMsg[]>([]);
	let streaming = $state<RolloutMsg | null>(null);
	// Tentative tokens (spec LLM-FAILURE-HANDLING §4.2): Layer-0 buffers each LLM
	// attempt to its terminal event, so tokens stream live ONLY via the tap's
	// `tentative_event`s — not yet committed. An `attempt_discarded` clears them
	// and shows a retry notice; authoritative events always win over tentative.
	let tentative = $state<RolloutMsg | null>(null);
	let retryNotice = $state<string | null>(null);

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
				// Deliberately ignore `evt.messages` (the whole `agent.state.messages`, which
				// still carries the leading final user turn). Replacing `messages` wholesale
				// here would briefly render that trigger turn as raw JSON before the
				// persisted-fallback switch. Instead we keep the folded rollout as-is; `onEnd`
				// refetches the persisted record, which SessionView then renders via the
				// non-live `Rollout` (transcript.slice(rolloutStartIndex)) — identical to this
				// view with no flicker (spec §10b: "on completion it is identical to the
				// persisted record").
				streaming = null;
				tentative = null;
				break;
		}
	}

	// Consume the live SSE stream for the current session ($lib/api/live.ts — a real
	// event-log byte stream, NOT a query.live: live queries keep only the latest
	// pending value under backpressure, which dropped burst-committed events like
	// `turn_end` and left this view empty). Teardown aborts the controller, which
	// kills the fetch end-to-end so the agent releases its `Agent.subscribe`
	// listener immediately — independent of whether another event ever arrives (a
	// quiet running session would otherwise leak the SSE connection until
	// `agent_end`; spec §3.3 / §14).
	$effect(() => {
		const id = sessionId;
		messages = [];
		streaming = null;
		tentative = null;
		retryNotice = null;
		contextSummary.set({ live: true });
		let stop = false;
		const controller = new AbortController();
		(async () => {
			try {
				for await (const evt of streamSessionEvents(id, controller.signal)) {
					if (stop) break;
					fold(evt);
				}
			} catch {
				/* aborted on teardown / disconnect — ignore */
			}
			if (!stop) {
				contextSummary.set({ live: false });
				onEnd?.();
			}
		})();
		return () => {
			stop = true;
			// Abort the fetch so the SSE + agent subscription tears down now, without
			// waiting for the next event.
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
