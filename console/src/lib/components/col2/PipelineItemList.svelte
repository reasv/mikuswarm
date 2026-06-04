<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { pipelineItemsQuery, pipelinesQuery } from '$lib/query/pipelines';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';
	import { retryFailedPipelineItems } from '$lib/api/admin.remote';
	import { keys } from '$lib/query/keys';
	import PipelineStatusBadge from '$lib/components/col1/PipelineStatusBadge.svelte';
	import RetryButton from '$lib/components/RetryButton.svelte';
	import { Button } from '$lib/components/ui/button';
	import { relativeTime } from '$lib/utils';
	import { cn } from '$lib/utils';

	const queryClient = useQueryClient();
	const items = pipelineItemsQuery(
		() => pipelineSelection.pool,
		() => ({ status: pipelineSelection.status, room: pipelineSelection.room })
	);

	// Reuse the (cached) dashboard feed for the selected pool's failed count → the
	// bulk "retry all failed" affordance.
	const pipelines = pipelinesQuery();
	const failedCount = $derived(
		pipelines.data?.pipelines.find((p) => p.pool === pipelineSelection.pool)?.counts.failed ?? 0
	);

	let bulkBusy = $state(false);
	async function handleRetryFailed() {
		const pool = pipelineSelection.pool;
		if (!pool || bulkBusy) return;
		bulkBusy = true;
		try {
			const { retried } = await retryFailedPipelineItems(pool);
			toast.success(`Re-enqueued ${retried} failed item${retried === 1 ? '' : 's'}`);
		} catch (err) {
			toast.error('Bulk retry failed', {
				description: (err as { body?: { message?: string } })?.body?.message
			});
		} finally {
			bulkBusy = false;
			queryClient.invalidateQueries({ queryKey: ['pipelines', pool, 'items'] });
			queryClient.invalidateQueries({ queryKey: keys.pipelines() });
		}
	}
</script>

<div class="flex h-full flex-col">
	<div
		class="flex items-center justify-between px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
	>
		<span>{pipelineSelection.pool ?? 'Items'}</span>
		{#if pipelineSelection.pool && failedCount > 0}
			<Button
				variant="outline"
				size="sm"
				class="h-6 gap-1 px-2 text-[10px] normal-case"
				disabled={bulkBusy}
				onclick={handleRetryFailed}
			>
				{bulkBusy ? 'Retrying…' : `Retry ${failedCount} failed`}
			</Button>
		{/if}
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
					<li class="relative">
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
						<!-- Inline retry on failed rows (a sibling, not nested in the row button). -->
						{#if item.status === 'failed'}
							<div class="absolute right-2 bottom-2">
								<RetryButton pool={item.pool} id={item.id} status={item.status} />
							</div>
						{/if}
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
