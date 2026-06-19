<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { ContextMessageWire } from '$lib/schemas';
	import { tierMeta } from '$lib/tiers';
	import { cn } from '$lib/utils';
	import XmlHighlight from './XmlHighlight.svelte';
	import ToolRow from './ToolRow.svelte';

	let {
		msg,
		collapsible = false,
		open = $bindable(!collapsible)
	}: { msg: ContextMessageWire; collapsible?: boolean; open?: boolean } = $props();

	const meta = $derived(tierMeta(msg.tier));
	const imageRefs = $derived(
		(msg.imageRefs ?? []) as { attachmentId?: string; sizeBytes?: number; mimeType?: string }[]
	);

	// Per-file/skill system-prompt breakdown (live preview only). Sorted by
	// contribution, largest first, so the heaviest segment reads at a glance. The
	// `\n\n` joiners and BPE boundary effects are not attributed to any segment, so
	// the subtotal sits a few tokens under the block's whole-string estimate above —
	// surfaced explicitly rather than silently fudged.
	const segments = $derived(
		msg.segments ? [...msg.segments].sort((a, b) => b.tokenEstimate - a.tokenEstimate) : []
	);
	const segmentsTotal = $derived(segments.reduce((sum, s) => sum + s.tokenEstimate, 0));

	// The tool-definition block (synthetic `tools` message) renders hierarchically:
	// one collapsible row per tool, heaviest first, each holding its own schema.
	// Mutually exclusive with the flat system-prompt `segments` table / content body.
	const tools = $derived(
		msg.tools ? [...msg.tools].sort((a, b) => b.tokenEstimate - a.tokenEstimate) : []
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
		{#if tools.length > 0}
			<div class="mb-2 text-[10px] tabular-nums">
				{#each tools as tool (tool.name)}
					<ToolRow {tool} />
				{/each}
			</div>
		{:else}
			{#if segments.length > 0}
				<table class="mb-2 w-full text-[10px] tabular-nums">
					<tbody>
						{#each segments as seg (seg.tag + ':' + (seg.source ?? seg.label))}
							<tr class="border-b border-border/40">
								<td class="py-0.5 pr-2 font-medium">{seg.label}</td>
								<td class="py-0.5 pr-2 text-muted-foreground/60">{seg.source ?? ''}</td>
								<td class="py-0.5 text-right text-muted-foreground">{seg.tokenEstimate}</td>
							</tr>
						{/each}
						<tr>
							<td class="py-0.5 pr-2 text-muted-foreground uppercase">segments Σ</td>
							<td></td>
							<td class="py-0.5 text-right text-muted-foreground tabular-nums">{segmentsTotal}</td>
						</tr>
					</tbody>
				</table>
			{/if}
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
	{/if}
</div>
