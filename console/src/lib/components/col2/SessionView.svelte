<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { sessionQuery } from '$lib/query/sessions';
	import { keys } from '$lib/query/keys';
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import { coerceContextMessage } from '$lib/rollout';
	import VerbatimContext from '$lib/components/verbatim/VerbatimContext.svelte';
	import Rollout from '$lib/components/rollout/Rollout.svelte';
	import LiveRollout from '$lib/components/rollout/LiveRollout.svelte';

	const queryClient = useQueryClient();
	const session = sessionQuery(() => selection.sessionId);

	// Verbatim input = frozen snapshot prefix + the transcript's head final user turn
	// (spec §3 / §10a). Rollout = the rest of the transcript (spec §10b).
	const inputMessages = $derived.by(() => {
		const d = session.data;
		if (!d) return [];
		const head = d.transcript.slice(0, d.rolloutStartIndex).map(coerceContextMessage);
		return [...d.contextSnapshot, ...head];
	});
	const rolloutMessages = $derived.by(() => {
		const d = session.data;
		return d ? d.transcript.slice(d.rolloutStartIndex) : [];
	});
	const isRunning = $derived(session.data?.session.status === 'running');

	$effect(() => {
		const d = session.data;
		if (d) {
			contextSummary.set({
				tokenEstimate: d.session.tokenEstimate,
				compactTokens: null,
				richTokens: null,
				cacheBoundaries: [],
				live: d.session.status === 'running'
			});
		}
	});

	// When the live stream ends, the persisted record is now authoritative: refetch
	// the session (→ terminal status → persisted rollout) and the room's list badge.
	function onStreamEnd() {
		const id = selection.sessionId;
		if (!id) return;
		queryClient.invalidateQueries({ queryKey: keys.session(id) });
		if (selection.roomKey)
			queryClient.invalidateQueries({ queryKey: keys.roomSessions(selection.roomKey) });
	}
</script>

<div class="h-full overflow-y-auto">
	{#if session.isPending}
		<div class="space-y-2 p-4">
			{#each Array(6) as _, i (i)}
				<div class="h-12 animate-pulse rounded bg-muted"></div>
			{/each}
		</div>
	{:else if session.isError}
		<div class="p-4 text-sm text-destructive">{session.error.message}</div>
	{:else}
		<VerbatimContext messages={inputMessages} mode="session" />
		<div
			class="sticky top-0 border-y bg-background/80 px-3 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur"
		>
			Rollout
		</div>
		{#if isRunning && selection.sessionId}
			{#key selection.sessionId}
				<LiveRollout sessionId={selection.sessionId} onEnd={onStreamEnd} />
			{/key}
		{:else}
			<Rollout messages={rolloutMessages} />
		{/if}
	{/if}
</div>
