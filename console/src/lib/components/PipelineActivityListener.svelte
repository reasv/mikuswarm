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

	// The upstream is explicitly long-lived ("never self-terminates"), but it can still
	// drop (agent restart, proxy timeout, network blip): the generator returns `done` or
	// throws. We re-acquire the iterator in a reconnect loop with a short backoff so live
	// patching survives the page's lifetime — without the loop a single drop silently
	// downgrades us to the 5s poll forever. The try/catch mirrors LiveRollout: an upstream
	// error (BFF `throw error(...)` or abort on teardown) becomes a backoff retry rather
	// than an unhandled promise rejection. `iter.return?.()` in `finally` aborts the
	// upstream fetch so the agent releases its bus subscription immediately.
	const RECONNECT_MS = 3000;

	$effect(() => {
		let stop = false;
		// Tracks the live iterator so teardown can close it mid-`next()`, aborting the
		// upstream fetch immediately rather than waiting for the next event.
		let activeIter: AsyncIterator<unknown> | null = null;
		(async () => {
			while (!stop) {
				const iter = streamPipelineActivity()[Symbol.asyncIterator]();
				activeIter = iter;
				try {
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
				} catch {
					/* upstream/abort error — fall through to backoff */
				} finally {
					if (activeIter === iter) activeIter = null;
					void iter.return?.();
				}
				if (!stop) await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
			}
		})();
		return () => {
			stop = true;
			// Close the in-flight iterator so the upstream SSE + agent subscription tears
			// down now (the generator's `finally` runs), without waiting for the next event.
			void activeIter?.return?.();
			activeIter = null;
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
		};
	});
</script>
