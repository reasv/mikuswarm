<script lang="ts">
	import { roomContextQuery } from '$lib/query/rooms';
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import VerbatimContext from '$lib/components/verbatim/VerbatimContext.svelte';

	const ctx = roomContextQuery(() => selection.roomKey);

	// Publish tier token totals + cache boundaries to the top bar (spec §11).
	$effect(() => {
		if (ctx.data) {
			contextSummary.set({
				tokenEstimate: ctx.data.tokenEstimate,
				compactTokens: ctx.data.compactTokens,
				richTokens: ctx.data.richTokens,
				cacheBoundaries: ctx.data.cacheBoundaries,
				live: false
			});
		}
	});
</script>

<div class="h-full overflow-y-auto">
	{#if ctx.isPending}
		<div class="space-y-2 p-4">
			{#each Array(6) as _, i (i)}
				<div class="h-12 animate-pulse rounded bg-muted"></div>
			{/each}
		</div>
	{:else if ctx.isError}
		<div class="p-4 text-sm text-destructive">{ctx.error.message}</div>
	{:else}
		<VerbatimContext messages={ctx.data.messages} mode="room" />
	{/if}
</div>
