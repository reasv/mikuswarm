<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { ToolWire } from '$lib/schemas';
	import { cn } from '$lib/utils';

	// One tool within the tool-definition block: a collapsible row (collapsed by
	// default) showing the tool name + its token cost; expanding reveals the tool's
	// own wire definition. Local `open` state per row, so each tool toggles
	// independently (spec §10a hierarchical tool block).
	let { tool }: { tool: ToolWire } = $props();
	let open = $state(false);
</script>

<div class="border-b border-border/40 last:border-b-0">
	<button
		type="button"
		class="flex w-full items-center gap-2 py-0.5 text-left hover:text-foreground"
		onclick={() => (open = !open)}
	>
		<ChevronRightIcon class={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
		<span class="font-medium">{tool.name}</span>
		<div class="flex-1"></div>
		<span class="text-muted-foreground tabular-nums">{tool.tokenEstimate} tok</span>
	</button>
	{#if open}
		<pre class="mb-1 ml-5 overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">{tool.text}</pre>
	{/if}
</div>
