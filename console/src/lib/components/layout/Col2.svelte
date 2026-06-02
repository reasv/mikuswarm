<script lang="ts">
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import RoomView from '$lib/components/col2/RoomView.svelte';
	import SessionView from '$lib/components/col2/SessionView.svelte';

	// Clear the top-bar summary whenever nothing is selected.
	$effect(() => {
		if (selection.mode === 'empty') contextSummary.clear();
	});
</script>

<!--
  Col 2 mode switch (spec §11): room → verbatim context (§10a); session → verbatim
  input (§10a) + rollout (§10b, Phase 3.2).
-->
<div class="flex h-full flex-col">
	{#if selection.mode === 'empty'}
		<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
			Select a room to preview the context it would build.
		</div>
	{:else if selection.mode === 'room'}
		<RoomView />
	{:else}
		<SessionView />
	{/if}
</div>
