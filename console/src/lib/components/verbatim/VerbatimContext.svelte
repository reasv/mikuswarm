<script lang="ts">
	import type { ContextMessageWire } from '$lib/schemas';
	import { tierMeta } from '$lib/tiers';
	import { cn } from '$lib/utils';
	import MessageBlock from './MessageBlock.svelte';
	import PreviewBanner from './PreviewBanner.svelte';

	let { messages }: { messages: readonly ContextMessageWire[] } = $props();

	// Per-tier token subtotals for the legend strip (spec §10a).
	const tierTotals = $derived.by(() => {
		const totals = new Map<string, number>();
		for (const m of messages) {
			const key = m.tier ?? '—';
			totals.set(key, (totals.get(key) ?? 0) + m.tokenEstimate);
		}
		return [...totals.entries()];
	});

	// System prompt + satellite blocks collapse by default (spec §10a).
	const isCollapsible = (m: ContextMessageWire) => m.type === 'system' || m.type === 'satellite';
	// Index of the first preview (synthetic-trigger) message, if any (spec §9).
	const firstPreview = $derived(messages.findIndex((m) => m.preview === true));
</script>

<div class="flex flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[10px]">
		{#each tierTotals as [tier, total] (tier)}
			<span class={cn('border-l-2 pl-1 uppercase', tierMeta(tier).accent)}>
				{tier}
				<span class="text-muted-foreground tabular-nums">{total}</span>
			</span>
		{/each}
	</div>

	<div class="space-y-1 px-3 py-2">
		{#each messages as msg, i (i)}
			{#if i === firstPreview && firstPreview >= 0}
				<PreviewBanner />
			{/if}
			<MessageBlock {msg} collapsible={isCollapsible(msg)} />
		{/each}
	</div>
</div>
