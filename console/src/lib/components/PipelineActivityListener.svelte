<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { streamPipelineActivity } from '$lib/api/live';
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

	// The upstream is explicitly long-lived ("never self-terminates"), but it can still
	// drop (agent restart, proxy timeout, network blip): the generator returns or throws.
	// We reconnect in a loop with a short backoff so live patching survives the page's
	// lifetime — without the loop a single drop silently downgrades us to the 5s poll
	// forever. The stream is a direct SSE fetch ($lib/api/live.ts), not a query.live —
	// live queries keep only the latest pending value under backpressure, so a burst of
	// activity events would drop invalidations. The try/catch mirrors LiveRollout: an
	// upstream error (or abort on teardown) becomes a backoff retry rather than an
	// unhandled promise rejection.
	const RECONNECT_MS = 3000;

	$effect(() => {
		let stop = false;
		// Tracks the in-flight attempt's controller so teardown can abort mid-await,
		// tearing down the SSE fetch + agent bus subscription immediately rather than
		// waiting for the next event.
		let controller: AbortController | null = null;
		(async () => {
			while (!stop) {
				controller = new AbortController();
				try {
					for await (const event of streamPipelineActivity(controller.signal)) {
						if (stop) break;
						dirtyPools.add(event.pool);
						scheduleFlush();
						if (pipelineSelection.pool === event.pool && pipelineSelection.itemId === event.id) {
							queryClient.invalidateQueries({ queryKey: keys.pipelineItem(event.pool, event.id) });
						}
					}
				} catch {
					/* upstream/abort error — fall through to backoff */
				}
				if (!stop) await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
			}
		})();
		return () => {
			stop = true;
			// Abort the in-flight fetch so the SSE + agent subscription tears down now,
			// without waiting for the next event.
			controller?.abort();
			controller = null;
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
		};
	});
</script>
