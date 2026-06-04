<script lang="ts">
	import { roomsQuery } from '$lib/query/rooms';
	import { selection } from '$lib/stores/selection.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';

	const rooms = roomsQuery();
</script>

<div class="flex h-full flex-col">
	<div class="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Rooms
	</div>
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
			<ul>
				{#each rooms.data.rooms as room (room.timelineKey)}
					<li>
						<button
							type="button"
							onclick={() => selection.selectRoom(room.timelineKey)}
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
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
