<script lang="ts">
	import { roomSessionsQuery, roomSessionFacetsQuery } from '$lib/query/rooms';
	import { selection } from '$lib/stores/selection.svelte';
	import { sessionFilters } from '$lib/stores/sessionFilters.svelte';
	import { conversationsHref } from '$lib/nav';
	import StatusBadge from './StatusBadge.svelte';
	import SessionFilters from './SessionFilters.svelte';
	import { cn } from '$lib/utils';

	const sessions = roomSessionsQuery(
		() => selection.roomKey,
		() => ({
			q: sessionFilters.q,
			statuses: sessionFilters.statuses,
			types: sessionFilters.types
		})
	);
	const facets = roomSessionFacetsQuery(() => selection.roomKey);

	// Session types are room-specific, so drop a stale type selection when the room
	// changes (q + status filters are universal and persist). Tracks the previous key
	// rather than firing on first run.
	let prevRoom: string | null | undefined;
	$effect(() => {
		const room = selection.roomKey;
		if (prevRoom !== undefined && prevRoom !== room) {
			sessionFilters.types = [];
		}
		prevRoom = room;
	});
</script>

<div class="flex h-full flex-col border-t">
	<div class="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Sessions
	</div>
	{#if selection.roomKey != null}
		<SessionFilters types={facets.data?.types ?? []} />
	{/if}
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if selection.roomKey == null}
			<div class="p-3 text-sm text-muted-foreground">Select a room.</div>
		{:else if sessions.isPending}
			<div class="space-y-2 p-3">
				{#each Array(3) as _, i (i)}
					<div class="h-10 animate-pulse rounded bg-muted"></div>
				{/each}
			</div>
		{:else if sessions.isError}
			<div class="p-3 text-sm text-destructive">{sessions.error.message}</div>
		{:else if sessions.data.sessions.length === 0}
			<div class="p-3 text-sm text-muted-foreground">
				{sessionFilters.hasActive ? 'No sessions match the filter.' : 'No sessions.'}
			</div>
		{:else}
			<!-- URL-driven selection (ARCHITECTURE.md §11): a session link carries the current
			     room so the drill-down is fully deep-linkable / new-tab-able. -->
			<ul data-sveltekit-noscroll data-sveltekit-keepfocus>
				{#each sessions.data.sessions as session (session.id)}
					<li>
						<a
							href={conversationsHref({ room: selection.roomKey, session: session.id })}
							aria-current={selection.sessionId === session.id ? 'true' : undefined}
							class={cn(
								'flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent',
								selection.sessionId === session.id && 'bg-accent'
							)}
						>
							<div class="flex items-center justify-between gap-2">
								<StatusBadge status={session.status} pulse={session.status === 'running'} />
								<span class="font-mono text-[10px] text-muted-foreground">{session.sessionType}</span>
							</div>
							<span class="line-clamp-2 text-xs text-muted-foreground">
								{session.triggerBody ?? session.id}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
