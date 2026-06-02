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
				if (Array.isArray(evt.messages)) messages = evt.messages as RolloutMsg[];
				streaming = null;
				break;
		}
	}

	// Consume the live stream for the current session. Breaking the `for await` on
	// teardown calls the iterator's `return()`, which aborts the upstream fetch so the
	// agent releases its subscription (spec §3.3).
	$effect(() => {
		const id = sessionId;
		messages = [];
		streaming = null;
		contextSummary.set({ live: true });
		let stop = false;
		const live = streamSession(id);
		(async () => {
			try {
				for await (const evt of live) {
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
			contextSummary.set({ live: false });
		};
	});

	const rows = $derived(streaming ? [...messages, streaming] : messages);
</script>

<Rollout messages={rows} />
