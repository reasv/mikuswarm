<script lang="ts">
	import { pipelineItemsQuery } from '$lib/query/pipelines';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';
	import PipelineStatusBadge from '$lib/components/col1/PipelineStatusBadge.svelte';
	import { relativeTime } from '$lib/utils';
	import { cn } from '$lib/utils';

	const items = pipelineItemsQuery(
		() => pipelineSelection.pool,
		() => ({ status: pipelineSelection.status, room: pipelineSelection.room })
	);
</script>

<div class="flex h-full flex-col">
	<div
		class="flex items-center justify-between px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
	>
		<span>{pipelineSelection.pool ?? 'Items'}</span>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if pipelineSelection.pool == null}
			<div class="p-3 text-sm text-muted-foreground">Select a pipeline.</div>
		{:else if items.isPending}
			<div class="space-y-2 p-3">
				{#each Array(6) as _, i (i)}
					<div class="h-12 animate-pulse rounded bg-muted"></div>
				{/each}
			</div>
		{:else if items.isError}
			<div class="p-3 text-sm text-destructive">{items.error.message}</div>
		{:else if items.data.items.length === 0}
			<div class="p-3 text-sm text-muted-foreground">No items.</div>
		{:else}
			<ul>
				{#each items.data.items as item (item.id)}
					<li>
						<button
							type="button"
							onclick={() => pipelineSelection.selectItem(item.id)}
							class={cn(
								'flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent',
								pipelineSelection.itemId === item.id && 'bg-accent'
							)}
						>
							<div class="flex items-center justify-between gap-2">
								<PipelineStatusBadge status={item.status} retrying={item.retrying} />
								<div class="flex items-center gap-2 text-[10px] text-muted-foreground">
									{#if item.attempts > 0}
										<span class="font-mono tabular-nums" title="attempts / max retries">
											{item.attempts}/{item.maxRetries}
										</span>
									{/if}
									<span class="tabular-nums" title={new Date(item.updatedAt).toLocaleString()}>
										{relativeTime(item.updatedAt)}
									</span>
								</div>
							</div>
							<span class="truncate text-xs text-foreground">{item.inputSummary}</span>
							{#if item.outputSummary}
								<span class="truncate text-[11px] text-muted-foreground">→ {item.outputSummary}</span>
							{/if}
							{#if item.error}
								<span class="truncate text-[11px] text-red-600 dark:text-red-400" title={item.error}>
									⚠ {item.error}
								</span>
							{/if}
						</button>
					</li>
				{/each}
				{#if items.data.nextCursor}
					<li class="px-3 py-2 text-center text-[10px] text-muted-foreground">
						more items below (load-more arrives with infinite scroll)
					</li>
				{/if}
			</ul>
		{/if}
	</div>
</div>
