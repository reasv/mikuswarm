<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { pipelineItemsQuery, pipelinesQuery } from '$lib/query/pipelines';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';
	import { pipelinesHref } from '$lib/nav';
	import { retryFailedPipelineItems } from '$lib/api/admin.remote';
	import { keys } from '$lib/query/keys';
	import type { PipelineId } from '$lib/schemas';
	import PipelineStatusBadge from '$lib/components/col1/PipelineStatusBadge.svelte';
	import RetryButton from '$lib/components/RetryButton.svelte';
	import { Button } from '$lib/components/ui/button';
	import { relativeTime } from '$lib/utils';
	import { cn } from '$lib/utils';

	// Status filter chips per pool. `pending`/`retrying` are backed by the same
	// pseudo-filter the dashboard buckets use; the rest are raw statuses.
	const STATUS_CHIPS: Record<PipelineId, string[]> = {
		enrichment: ['processing', 'pending', 'retrying', 'complete', 'failed', 'skipped'],
		captioning: ['processing', 'pending', 'retrying', 'complete', 'failed', 'skipped'],
		summarization: ['processing', 'pending', 'retrying', 'complete', 'failed'],
		diary: ['processing', 'pending', 'retrying', 'done', 'skipped', 'failed']
	};

	const queryClient = useQueryClient();
	const items = pipelineItemsQuery(
		() => pipelineSelection.pool,
		() => ({ status: pipelineSelection.status, room: pipelineSelection.room })
	);
	// De-dupe by id when flattening pages: the 5s `refetchInterval` refetches every loaded
	// page with its originally-captured keyset cursor, so a boundary item whose `updatedAt`
	// changes between cursors can satisfy two adjacent page windows at once and surface
	// twice. Svelte's keyed `{#each … (item.id)}` throws on a duplicate key. Pages are
	// reverse-chron, so the first occurrence is the fresher position — keep it.
	const allItems = $derived.by(() => {
		const seen = new Set<string>();
		return (items.data?.pages.flatMap((p) => p.items) ?? []).filter(
			(i) => !seen.has(i.id) && seen.add(i.id)
		);
	});

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

	<!-- Status filter chips. URL-driven (ARCHITECTURE.md §11): each chip is a link that
	     toggles `status` (re-clicking the active chip clears it) and drops `item` (it may no
	     longer be in the filtered list), preserving the pool + room filter. -->
	{#if pipelineSelection.pool}
		<div class="flex flex-wrap gap-1 border-b px-3 pb-2" data-sveltekit-noscroll data-sveltekit-keepfocus>
			{#each STATUS_CHIPS[pipelineSelection.pool] as chip (chip)}
				<a
					href={pipelinesHref({
						pool: pipelineSelection.pool,
						status: pipelineSelection.status === chip ? null : chip,
						room: pipelineSelection.room,
						item: null
					})}
					aria-current={pipelineSelection.status === chip ? 'true' : undefined}
					class={cn(
						'rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase transition-colors',
						pipelineSelection.status === chip
							? 'border-foreground/30 bg-accent text-foreground'
							: 'border-transparent text-muted-foreground hover:bg-accent/50'
					)}
				>
					{chip}
				</a>
			{/each}
		</div>
	{/if}

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
		{:else if allItems.length === 0}
			<div class="p-3 text-sm text-muted-foreground">No items.</div>
		{:else}
			<!-- URL-driven selection (ARCHITECTURE.md §11): an item link carries the current
			     pool + status/room filter so it is deep-linkable / new-tab-able. The inline
			     RetryButton is a sibling (not nested in the link). -->
			<ul data-sveltekit-noscroll data-sveltekit-keepfocus>
				{#each allItems as item (item.id)}
					<li class="relative">
						<a
							href={pipelinesHref({
								pool: pipelineSelection.pool,
								status: pipelineSelection.status,
								room: pipelineSelection.room,
								item: item.id
							})}
							aria-current={pipelineSelection.itemId === item.id ? 'true' : undefined}
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
						</a>
						<!-- Inline retry on failed rows (a sibling, not nested in the row button). -->
						{#if item.status === 'failed'}
							<div class="absolute right-2 bottom-2">
								<RetryButton pool={item.pool} id={item.id} status={item.status} />
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if items.hasNextPage}
				<div class="p-2 text-center">
					<Button
						variant="ghost"
						size="sm"
						class="h-7 text-[11px]"
						disabled={items.isFetchingNextPage}
						onclick={() => items.fetchNextPage()}
					>
						{items.isFetchingNextPage ? 'Loading…' : 'Load older'}
					</Button>
				</div>
			{/if}
		{/if}
	</div>
</div>
