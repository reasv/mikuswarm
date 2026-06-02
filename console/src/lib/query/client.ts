import { QueryClient } from '@tanstack/svelte-query';

/**
 * The browser QueryClient. TanStack Query is the single client-side cache and
 * invalidation authority (spec plan §5); remote functions are used purely as
 * typed fetchers underneath. `refetchOnWindowFocus` is off — the operator console
 * drives freshness via explicit list `refetchInterval` + post-stream invalidation.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 2_000,
				refetchOnWindowFocus: false,
				retry: 1
			}
		}
	});
}

/**
 * Force a server round-trip through a SvelteKit remote query and return its fresh
 * value. Using `refresh()` (rather than awaiting the remote query's own cached
 * promise) is what lets TanStack's refetch/invalidate actually re-hit the agent —
 * keeping TanStack as the single cache authority rather than fighting SvelteKit's
 * built-in remote-query cache.
 */
export async function fresh<T>(
	rq: Promise<T> & { refresh(): Promise<void>; readonly current: T | undefined }
): Promise<T> {
	await rq.refresh();
	return rq.current as T;
}
