<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import { retryPipelineItem } from '$lib/api/admin.remote';
	import { keys } from '$lib/query/keys';
	import { isRetryable } from '$lib/pipelines';
	import type { PipelineId } from '$lib/schemas';

	// Mirrors the SessionView Stop-button pattern: a `command` mutation, a toast on
	// resolve, and a TanStack invalidation of the affected item + pool counts. Only
	// renders for a retryable status; a stale click (status changed since render)
	// gets a benign 409 → neutral warning. `stopPropagation` so clicking it inside a
	// selectable list row doesn't also select the row.
	let {
		pool,
		id,
		status
	}: { pool: PipelineId; id: string; status: string } = $props();

	const queryClient = useQueryClient();
	let busy = $state(false);
	const enabled = $derived(isRetryable(pool, status));

	async function handleRetry(e: MouseEvent) {
		e.stopPropagation();
		if (!enabled || busy) return;
		busy = true;
		try {
			await retryPipelineItem({ pool, id });
			toast.success('Re-enqueued');
		} catch (err) {
			const httpStatus = (err as { status?: number })?.status;
			if (httpStatus === 409) {
				toast.info('No longer retryable', { description: 'The item may have changed state.' });
			} else {
				toast.error('Retry failed', {
					description: (err as { body?: { message?: string } })?.body?.message
				});
			}
		} finally {
			busy = false;
			queryClient.invalidateQueries({ queryKey: keys.pipelineItem(pool, id) });
			queryClient.invalidateQueries({ queryKey: ['pipelines', pool, 'items'] });
			queryClient.invalidateQueries({ queryKey: keys.pipelines() });
		}
	}
</script>

{#if enabled}
	<Button
		variant="outline"
		size="sm"
		class="h-6 gap-1 px-2 text-[10px]"
		disabled={busy}
		onclick={handleRetry}
	>
		<RefreshCwIcon class="size-3" />
		{busy ? '…' : 'Retry'}
	</Button>
{/if}
