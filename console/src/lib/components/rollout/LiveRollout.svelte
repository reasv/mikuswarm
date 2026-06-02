<script lang="ts">
	import { streamSession } from '$lib/api/sessions.remote';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import type { RolloutMsg } from '$lib/rollout';
	import Rollout from './Rollout.svelte';

	let { sessionId, onEnd }: { sessionId: string; onEnd?: () => void } = $props();

	let messages = $state<RolloutMsg[]>([]);
	let streaming = $state<RolloutMsg | null>(null);

	// Fold a live AgentEvent into the accumulating message list (spec §10b). The
	// per-event payloads are `any` upstream, so we narrow defensively.
	function fold(evt: { type: string; [k: string]: unknown }) {
		switch (evt.type) {
			case 'turn_end': {
				if (evt.message) messages.push(evt.message as RolloutMsg);
				for (const tr of (evt.toolResults as RolloutMsg[]) ?? []) messages.push(tr);
				streaming = null;
				break;
			}
			case 'message_update':
				streaming = (evt.message as RolloutMsg) ?? null;
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
				break;
		}
	}

	// Consume the live stream for the current session. On teardown we acquire and close
	// the iterator explicitly (`iter.return()`), which aborts the upstream fetch so the
	// agent releases its subscription immediately — independent of whether another event
	// ever arrives (a quiet running session would otherwise leak the SSE connection and
	// the `Agent.subscribe` listener until `agent_end`; spec §3.3 / §14).
	$effect(() => {
		const id = sessionId;
		messages = [];
		streaming = null;
		contextSummary.set({ live: true });
		let stop = false;
		const iter = streamSession(id)[Symbol.asyncIterator]();
		(async () => {
			try {
				for (;;) {
					const { value, done } = await iter.next();
					if (done || stop) break;
					fold(value);
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
			// Close the iterator so the live generator's `finally` runs now, tearing down
			// the upstream SSE + agent subscription without waiting for the next event.
			void iter.return?.();
			contextSummary.set({ live: false });
		};
	});

	const rows = $derived(streaming ? [...messages, streaming] : messages);
</script>

<Rollout messages={rows} />
