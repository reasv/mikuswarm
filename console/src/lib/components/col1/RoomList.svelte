<script lang="ts">
	import { roomsQuery } from '$lib/query/rooms';
	import { selection } from '$lib/stores/selection.svelte';
	import { conversationsHref } from '$lib/nav';
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';
	import type { Room } from '$lib/schemas';

	const rooms = roomsQuery();

	// One entry per (provider, account) pair present in the room list, insertion-ordered
	// (the list is reverse-chron, so the most recently active account leads). Rooms with
	// an unparseable key (provider/accountId null) never form a tab — they stay visible
	// under "All".
	interface AccountTab {
		key: string;
		provider: string;
		accountId: string;
		count: number;
	}
	const accounts = $derived.by((): AccountTab[] => {
		const map = new Map<string, AccountTab>();
		for (const room of rooms.data?.rooms ?? []) {
			if (!room.provider || !room.accountId) continue;
			const key = `${room.provider}:${room.accountId}`;
			const entry = map.get(key);
			if (entry) entry.count += 1;
			else map.set(key, { key, provider: room.provider, accountId: room.accountId, count: 1 });
		}
		return [...map.values()];
	});

	// Account sub-tabs appear only when rooms span MORE than one account; with a single
	// account the tab row would be pure noise. `null` = the "All" tab.
	let accountTab = $state<string | null>(null);
	const showTabs = $derived(accounts.length > 1);
	// A stale selection (its account's rooms all aged out of the list) falls back to All.
	const activeTab = $derived(
		showTabs && accountTab !== null && accounts.some((a) => a.key === accountTab)
			? accountTab
			: null
	);
	const visibleRooms = $derived.by((): Room[] => {
		const all = rooms.data?.rooms ?? [];
		if (activeTab === null) return [...all];
		return all.filter((r) => r.provider && r.accountId && `${r.provider}:${r.accountId}` === activeTab);
	});
</script>

<div class="flex h-full flex-col">
	<div class="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Rooms
	</div>
	{#if showTabs}
		<!-- Per-account sub-tabs (shown only with 2+ accounts): each tab names the account
		     and its provider (discord vs matrix), so same-named rooms on different
		     accounts are tellable apart. -->
		<div class="flex flex-wrap items-center gap-1 px-2 pb-2 text-xs">
			<button
				class={cn(
					'rounded px-2 py-0.5 transition-colors',
					activeTab === null
						? 'bg-muted font-medium text-foreground'
						: 'text-muted-foreground hover:text-foreground'
				)}
				onclick={() => (accountTab = null)}
			>
				All
			</button>
			{#each accounts as a (a.key)}
				<button
					class={cn(
						'rounded px-2 py-0.5 transition-colors',
						activeTab === a.key
							? 'bg-muted font-medium text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					title={`${a.provider} account "${a.accountId}" — ${a.count} room${a.count === 1 ? '' : 's'}`}
					onclick={() => (accountTab = a.key)}
				>
					{a.accountId}
					<span class="ml-0.5 text-[10px] uppercase tracking-wide opacity-70">{a.provider}</span>
				</button>
			{/each}
		</div>
	{/if}
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if rooms.isPending}
			<div class="space-y-2 p-3">
				{#each Array(4) as _, i (i)}
					<div class="h-8 animate-pulse rounded bg-muted"></div>
				{/each}
			</div>
		{:else if rooms.isError}
			<div class="p-3 text-sm text-destructive">{rooms.error.message}</div>
		{:else if rooms.data.rooms.length === 0}
			<div class="p-3 text-sm text-muted-foreground">No rooms.</div>
		{:else}
			<!-- Selection is URL-driven (ARCHITECTURE.md §11): each row is a real link, so
			     deep-link/refresh/new-tab all work. A room link omits `session`, so clicking a
			     room returns to room view even while a session is open. noscroll/keepfocus keep
			     the list steady across the client-side nav. -->
			<ul data-sveltekit-noscroll data-sveltekit-keepfocus>
				{#each visibleRooms as room (room.timelineKey)}
					<li>
						<a
							href={conversationsHref({ room: room.timelineKey })}
							aria-current={selection.roomKey === room.timelineKey ? 'true' : undefined}
							class={cn(
								'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
								selection.roomKey === room.timelineKey && 'bg-accent'
							)}
						>
							<span class="min-w-0 flex-1 truncate" title={room.timelineKey}>
								{room.displayName ?? room.timelineKey}
							</span>
							{#if room.timelineState}
								<Badge class="shrink-0 font-mono text-[10px]" variant="outline">
									{room.timelineState}
								</Badge>
							{/if}
							<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
								{room.sessionCount}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
