<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { streamPipelineActivity } from '$lib/api/pipelines.remote';
	import { keys } from '$lib/query/keys';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';

	// Renders nothing — it consumes the SSE activity firehose and invalidates the
	// affected TanStack queries so the dashboard + lists feel live on top of the 5s
	// poll (ARCHITECTURE.md §11). Mounted once by the Pipelines shell.
	const queryClient = useQueryClient();

	// Count-invalidations are throttled: a burst of activity coalesces into one
	// dashboard + per-pool list refetch per window, so the firehose can't trigger a
	// refetch storm. The open item detail is refreshed immediately (it's a single
	// query and the operator is watching it).
	const FLUSH_MS = 600;
	const dirtyPools = new Set<string>();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleFlush() {
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			queryClient.invalidateQueries({ queryKey: keys.pipelines() });
			for (const pool of dirtyPools) {
				// Prefix match: refreshes every filtered list for the pool.
				queryClient.invalidateQueries({ queryKey: ['pipelines', pool, 'items'] });
			}
			dirtyPools.clear();
		}, FLUSH_MS);
	}

	$effect(() => {
		let stop = false;
		const iter = streamPipelineActivity()[Symbol.asyncIterator]();
		(async () => {
			for (;;) {
				const { value, done } = await iter.next();
				if (done || stop) break;
				const event = value;
				dirtyPools.add(event.pool);
				scheduleFlush();
				if (pipelineSelection.pool === event.pool && pipelineSelection.itemId === event.id) {
					queryClient.invalidateQueries({ queryKey: keys.pipelineItem(event.pool, event.id) });
				}
			}
		})();
		return () => {
			stop = true;
			void iter.return?.();
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
		};
	});
</script>
