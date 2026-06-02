<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import { cn } from '$lib/utils';

	let { thinking, redacted = false }: { thinking: string; redacted?: boolean } = $props();
	// Thinking blocks are collapsed by default (spec §10b).
	let open = $state(false);
</script>

<div class="rounded-md border border-dashed bg-muted/30 text-sm">
	<button
		type="button"
		class="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
		onclick={() => (open = !open)}
	>
		<ChevronRightIcon class={cn('size-3 transition-transform', open && 'rotate-90')} />
		<BrainIcon class="size-3" />
		<span>thinking{redacted ? ' (redacted)' : ''}</span>
	</button>
	{#if open}
		<div class="px-3 pb-2 text-sm whitespace-pre-wrap text-muted-foreground">{thinking}</div>
	{/if}
</div>
