<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import { getGapBackfetch } from '$lib/api/gap-backfetch.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { cn } from '$lib/utils';

	// Startup gap-backfetch panel (ARCHITECTURE.md §7c §11): per-room catch-up state
	// after a restart — which rooms are still frozen/filling, how much is buffered,
	// and any capped holes — so an operator can see the bot recovering offline
	// history and when each room is live again. Polled; the room set is small.
	const snapshot = createQuery(() => ({
		queryKey: keys.gapBackfetch(),
		queryFn: () => fresh(getGapBackfetch()),
		refetchInterval: 2000
	}));

	const rooms = $derived(snapshot.data ?? []);
	// Active = still catching up (frozen/filling/committing); these block sessions.
	const active = $derived(
		rooms.filter((r) => r.phase === 'frozen' || r.phase === 'filling' || r.phase === 'committing')
	);
	const done = $derived(rooms.filter((r) => r.phase === 'done'));
	const failed = $derived(rooms.filter((r) => r.phase === 'failed'));

	const PHASE_CLASSES: Record<string, string> = {
		frozen: 'text-sky-500',
		filling: 'text-blue-500',
		committing: 'text-amber-500',
		done: 'text-emerald-500',
		failed: 'text-red-500'
	};

	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleString();
	}
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
		{#if snapshot.isPending}
			<div class="text-sm text-muted-foreground">loading…</div>
		{:else if rooms.length === 0}
			<div class="text-sm text-muted-foreground">
				No gap backfetch in progress. (Either disabled, or every room's gap is already filled.)
			</div>
		{:else}
			<div class="flex items-center gap-4 text-xs text-muted-foreground">
				<span><span class="text-foreground">{rooms.length}</span> rooms</span>
				{#if active.length > 0}
					<span class="text-blue-500">{active.length} catching up</span>
				{/if}
				<span class="text-emerald-500">{done.length} done</span>
				{#if failed.length > 0}
					<span class="text-red-500">{failed.length} failed</span>
				{/if}
			</div>

			<table class="w-full text-sm">
				<thead class="text-left text-xs text-muted-foreground">
					<tr class="border-b">
						<th class="py-1 pr-3 font-medium">room</th>
						<th class="py-1 pr-3 font-medium">phase</th>
						<th class="py-1 pr-3 text-right font-medium" title="messages buffered from the backward descent">
							backfill buf
						</th>
						<th class="py-1 pr-3 text-right font-medium" title="live messages buffered during the freeze">
							live buf
						</th>
						<th class="py-1 pr-3 text-right font-medium" title="rows committed so far">committed</th>
						<th class="py-1 font-medium">capped hole</th>
					</tr>
				</thead>
				<tbody>
					{#each rooms as room (room.baseTimelineKey)}
						<tr class="border-b border-border/50">
							<td class="py-1 pr-3 font-mono text-[11px]" title={room.baseTimelineKey}>
								{room.roomId}
								<span class="text-muted-foreground">({room.accountId})</span>
							</td>
							<td class={cn('py-1 pr-3 font-medium', PHASE_CLASSES[room.phase] ?? '')}>{room.phase}</td>
							<td class="py-1 pr-3 text-right font-mono">{room.backfillBuffered}</td>
							<td class="py-1 pr-3 text-right font-mono">{room.liveBuffered}</td>
							<td class="py-1 pr-3 text-right font-mono">{room.committed}</td>
							<td class="py-1 text-[11px] text-red-400">
								{#if room.cappedHole}
									{fmtTime(room.cappedHole.fromTimestamp)} → {fmtTime(room.cappedHole.toTimestamp)}
								{:else}
									—
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
