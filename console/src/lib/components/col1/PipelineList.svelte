<script lang="ts">
	import { pipelinesQuery, costOverviewQuery } from '$lib/query/pipelines';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';
	import { pipelineSummary } from '$lib/stores/pipeline-summary.svelte';
	import { pipelinesHref } from '$lib/nav';
	import type { PipelineHealth } from '$lib/schemas';
	import { cn } from '$lib/utils';
	import { formatTokens, formatUsd } from '$lib/format';

	const pipelines = pipelinesQuery();
	// Global spend across the three lanes (spec AUXILIARY-USAGE-TRACKING §10.4),
	// shown side-by-side in the footer — never summed into one headline (§9).
	const cost = costOverviewQuery();

	const POOL_LABELS: Record<string, string> = {
		enrichment: 'Enrichment',
		captioning: 'Captioning',
		summarization: 'Summarization',
		diary: 'Diary'
	};

	// Publish the aggregate health to the top-bar summary as the feed loads.
	$effect(() => {
		const rows = pipelines.data?.pipelines;
		if (!rows) return;
		pipelineSummary.set({
			failing: rows.reduce((n, p) => n + p.counts.failed, 0),
			retrying: rows.reduce((n, p) => n + p.counts.retrying, 0),
			inFlight: rows.reduce((n, p) => n + p.inFlight, 0)
		});
	});

	const totals = $derived.by(() => {
		const rows = pipelines.data?.pipelines ?? [];
		return {
			failed: rows.reduce((n, p) => n + p.counts.failed, 0),
			retrying: rows.reduce((n, p) => n + p.counts.retrying, 0),
			inFlight: rows.reduce((n, p) => n + p.inFlight, 0),
			pending: rows.reduce((n, p) => n + p.counts.pending, 0)
		};
	});

	function broken(p: PipelineHealth): boolean {
		return p.counts.failed > 0 || p.counts.retrying > 0;
	}
</script>

{#snippet countChip(label: string, n: number, tone: string, animate = false)}
	{#if n > 0}
		<span class={cn('inline-flex items-center gap-1 rounded px-1 font-mono text-[10px]', tone)}>
			{#if animate}
				<span class="relative flex size-1.5">
					<span
						class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75"
					></span>
					<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
				</span>
			{/if}
			{label}
			{n}
		</span>
	{/if}
{/snippet}

<div class="flex h-full flex-col">
	<div class="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Pipelines
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if pipelines.isPending}
			<div class="space-y-2 p-3">
				{#each Array(4) as _, i (i)}
					<div class="h-12 animate-pulse rounded bg-muted"></div>
				{/each}
			</div>
		{:else if pipelines.isError}
			<div class="p-3 text-sm text-destructive">{pipelines.error.message}</div>
		{:else}
			<!-- "All" aggregate summary row -->
			<div
				class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
			>
				<span class="font-semibold tracking-wide uppercase">All</span>
				<div class="flex flex-wrap items-center justify-end gap-1">
					{@render countChip(
						'⚙',
						totals.inFlight,
						'bg-blue-500/15 text-blue-600 dark:text-blue-400',
						true
					)}
					{@render countChip('↻', totals.retrying, 'bg-amber-500/15 text-amber-600 dark:text-amber-400')}
					{@render countChip('✕', totals.failed, 'bg-red-500/15 text-red-600 dark:text-red-400')}
					{#if totals.inFlight === 0 && totals.retrying === 0 && totals.failed === 0}
						<span class="text-[10px] text-emerald-600 dark:text-emerald-400">healthy</span>
					{/if}
				</div>
			</div>

			<!-- URL-driven selection (ARCHITECTURE.md §11): a pool link omits item/status/room
			     (a fresh drill-down), and is deep-linkable / new-tab-able. -->
			<ul data-sveltekit-noscroll data-sveltekit-keepfocus>
				{#each pipelines.data.pipelines as p (p.pool)}
					<li>
						<a
							href={pipelinesHref({ pool: p.pool })}
							aria-current={pipelineSelection.pool === p.pool ? 'true' : undefined}
							class={cn(
								'flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent',
								pipelineSelection.pool === p.pool && 'bg-accent'
							)}
						>
							<div class="flex items-center justify-between gap-2">
								<span class={cn('text-sm font-medium', broken(p) && 'text-red-600 dark:text-red-400')}>
									{POOL_LABELS[p.pool] ?? p.pool}
								</span>
								{#if !p.enabled}
									<span class="font-mono text-[10px] text-muted-foreground">off</span>
								{/if}
							</div>
							<div class="flex flex-wrap items-center gap-1">
								{@render countChip(
									'⚙',
									p.inFlight,
									'bg-blue-500/15 text-blue-600 dark:text-blue-400',
									true
								)}
								{@render countChip(
									'pend',
									p.counts.pending,
									'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400'
								)}
								<!-- Captioning `deferred` (pending the pool would never claim under
								     the current config); 0 elsewhere, so the chip self-hides. -->
								{@render countChip(
									'def',
									p.counts.deferred,
									'bg-violet-500/10 text-violet-600 dark:text-violet-400'
								)}
								{@render countChip(
									'↻',
									p.counts.retrying,
									'bg-amber-500/15 text-amber-600 dark:text-amber-400'
								)}
								{@render countChip(
									'✕',
									p.counts.failed,
									'bg-red-500/15 text-red-600 dark:text-red-400'
								)}
								{@render countChip(
									'done',
									p.counts.done,
									'bg-emerald-500/10 text-emerald-600/80 dark:text-emerald-400/80'
								)}
							</div>
							{#if p.usage && p.usage.captionedCount > 0}
								<!-- Captioning usage aggregate (spec AUXILIARY-USAGE-TRACKING §10.2):
								     tokens captioned + total spend. Cost hidden when 0 (no rates). -->
								<div class="font-mono text-[10px] tabular-nums text-muted-foreground">
									{p.usage.captionedCount} captioned · in {formatTokens(p.usage.totalInputTokens)} · out
									{formatTokens(p.usage.totalOutputTokens)}{#if p.usage.totalCost > 0}
										· {formatUsd(p.usage.totalCost)} spent{/if}
								</div>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	{#if cost.data && (cost.data.agentLoopCost > 0 || cost.data.toolCost > 0 || cost.data.captioningCost > 0)}
		<!-- Cost overview (spec AUXILIARY-USAGE-TRACKING §10.4): the three spend lanes
		     side-by-side. Lanes are kept distinct (different pricing scales; tool/image
		     tokens are not context-bearing — §9), so this is NOT a single total. -->
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t px-3 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground"
			title="Spend by lane — agent loop, tool calls, captioning (not summed; different pricing scales)"
		>
			<span class="font-semibold tracking-wide uppercase">Cost</span>
			<span>loop {formatUsd(cost.data.agentLoopCost)}</span>
			<span>· tools {formatUsd(cost.data.toolCost)}</span>
			<span>· caption {formatUsd(cost.data.captioningCost)}</span>
		</div>
	{/if}
</div>
