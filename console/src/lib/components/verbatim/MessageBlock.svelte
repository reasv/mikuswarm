<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { ContextMessageWire } from '$lib/schemas';
	import { tierMeta } from '$lib/tiers';
	import { cn } from '$lib/utils';
	import XmlHighlight from './XmlHighlight.svelte';

	let {
		msg,
		collapsible = false,
		open = $bindable(!collapsible)
	}: { msg: ContextMessageWire; collapsible?: boolean; open?: boolean } = $props();

	const meta = $derived(tierMeta(msg.tier));
	const imageRefs = $derived(
		(msg.imageRefs ?? []) as { attachmentId?: string; sizeBytes?: number; mimeType?: string }[]
	);
</script>

<div class={cn('border-l-2 pl-2', meta.accent)}>
	<div class="flex items-center gap-2 py-1 text-[10px] tracking-wide uppercase">
		{#if collapsible}
			<button
				type="button"
				class="flex items-center gap-1 hover:text-foreground"
				onclick={() => (open = !open)}
			>
				<ChevronRightIcon class={cn('size-3 transition-transform', open && 'rotate-90')} />
				<span class="font-semibold">{meta.label}</span>
			</button>
		{:else}
			<span class="font-semibold">{meta.label}</span>
		{/if}
		<span class="text-muted-foreground">{msg.role}</span>
		<span class="text-muted-foreground/60">{msg.type}</span>
		<div class="flex-1"></div>
		{#if imageRefs.length > 0}
			<span class="text-muted-foreground">{imageRefs.length} img</span>
		{/if}
		<span class="text-muted-foreground tabular-nums"
			>{msg.tokenEstimate === null ? '—' : msg.tokenEstimate} tok</span
		>
	</div>

	{#if open}
		<div class="overflow-x-auto pb-2">
			<XmlHighlight code={msg.content} />
			{#if imageRefs.length > 0}
				<div class="mt-2 flex flex-wrap gap-2">
					{#each imageRefs as ref, i (ref.attachmentId ?? i)}
						{#if ref.attachmentId}
							<img
								src={`/api/media/${encodeURIComponent(ref.attachmentId)}`}
								alt="attachment"
								class="max-h-40 rounded border"
							/>
						{:else}
							<span class="rounded border px-2 py-1 text-xs text-muted-foreground">
								[image {ref.mimeType ?? ''} {ref.sizeBytes ?? '?'}B]
							</span>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
