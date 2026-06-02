<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import { sessionQuery } from '$lib/query/sessions';
	import { keys } from '$lib/query/keys';
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import { coerceContextMessage } from '$lib/rollout';
	import { abortSession } from '$lib/api/admin.remote';
	import { Button } from '$lib/components/ui/button';
	import VerbatimContext from '$lib/components/verbatim/VerbatimContext.svelte';
	import Rollout from '$lib/components/rollout/Rollout.svelte';
	import LiveRollout from '$lib/components/rollout/LiveRollout.svelte';

	const queryClient = useQueryClient();
	const session = sessionQuery(() => selection.sessionId);

	let stopping = $state(false);

	// Stop button → POST abort. A 409 means the run already settled between render
	// and click (benign — it's no longer in flight), so treat it as success. Either
	// way, refetch so the view flips to the persisted terminal record; the live SSE
	// stream's own `agent_end` → `onStreamEnd` covers the happy path too.
	async function handleStop() {
		const id = selection.sessionId;
		if (!id || stopping) return;
		stopping = true;
		try {
			await abortSession(id);
			toast.success('Session stopped');
		} catch (err) {
			const status = (err as { status?: number })?.status;
			if (status === 409) {
				toast.info('Session was already finished');
			} else {
				toast.error('Failed to stop session', {
					description: (err as { body?: { message?: string } })?.body?.message
				});
			}
		} finally {
			stopping = false;
			queryClient.invalidateQueries({ queryKey: keys.session(id) });
			if (selection.roomKey)
				queryClient.invalidateQueries({ queryKey: keys.roomSessions(selection.roomKey) });
		}
	}

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
			class="sticky top-0 flex items-center justify-between border-y bg-background/80 px-3 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur"
		>
			<span>Rollout</span>
			{#if isRunning}
				<Button
					variant="destructive"
					size="sm"
					class="h-6 px-2 text-[10px]"
					disabled={stopping}
					onclick={handleStop}
				>
					<OctagonXIcon class="size-3" />
					{stopping ? 'Stopping…' : 'Stop'}
				</Button>
			{/if}
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
