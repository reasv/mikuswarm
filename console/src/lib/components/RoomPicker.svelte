<script lang="ts">
	// Filterable room picker for the backfetch start form. Replaces the raw
	// timeline-key text box: a popover-backed combobox that lists known rooms by
	// their human label (`Name (Space)`, already resolved into room_metadata and
	// surfaced as `displayName` on GET /api/rooms) with the exact timeline key
	// shown small underneath. Typing filters on both the label and the key, and a
	// free-text key can still be used for rooms not in the list (e.g. DMs the bot
	// has never labelled).
	//
	// Agent mode (spec CONSOLE-MULTI-AGENT §4): under the global gate rooms are
	// grouped under agent headers (config order; unresolvable rooms under an
	// "Unassigned" group last). The text filter also matches agent names.
	import { Popover } from 'bits-ui';
	import { roomsQuery } from '$lib/query/rooms';
	import { agentsQuery } from '$lib/query/agents';
	import { buildAgentLookup, agentFor, agentAccent } from '$lib/agents';
	import { cn } from '$lib/utils';
	import type { Room } from '$lib/schemas';

	let {
		value = $bindable(''),
		placeholder = 'select or type a room',
		class: className = ''
	}: { value?: string; placeholder?: string; class?: string } = $props();

	const rooms = roomsQuery();
	const agentsQ = agentsQuery();

	// ── Global gate ──────────────────────────────────────────────────────────────
	const agentsData = $derived(agentsQ.data);
	const globalGate = $derived(
		agentsData?.mode === 'agents' && (agentsData.agents.length ?? 0) > 1
	);
	const agentList = $derived(globalGate ? (agentsData?.agents ?? []) : []);
	const agentLookup = $derived(
		agentsData && globalGate ? buildAgentLookup(agentsData) : new Map()
	);

	let open = $state(false);
	let filter = $state('');
	let highlight = $state(0);
	let searchEl = $state<HTMLInputElement | null>(null);

	const allRooms = $derived(rooms.data?.rooms ?? []);

	const selected = $derived(allRooms.find((r) => r.timelineKey === value) ?? null);

	// Agent name for a room (used in filter matching).
	function agentNameOf(room: Room): string | null {
		if (!globalGate) return null;
		const entry = agentFor(room.timelineKey, agentLookup);
		return entry?.agentName ?? null;
	}

	const matches = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return allRooms;
		return allRooms.filter(
			(r) =>
				(r.displayName ?? '').toLowerCase().includes(q) ||
				r.timelineKey.toLowerCase().includes(q) ||
				// Agent mode: filter also matches agent name (§4).
				(globalGate && (agentNameOf(r) ?? '').toLowerCase().includes(q))
		);
	});

	// Flat list of matched rooms for keyboard navigation (grouping is visual only).
	// Agent mode builds groups; flat list is the same rooms, just reordered.
	interface AgentGroup {
		agentName: string;
		agentIndex: number;
		rooms: Room[];
	}
	const agentGroups = $derived.by((): AgentGroup[] => {
		if (!globalGate) return [];
		const groups: AgentGroup[] = agentList.map((a, i) => ({
			agentName: a.name,
			agentIndex: i,
			rooms: []
		}));
		for (const room of matches) {
			const entry = agentFor(room.timelineKey, agentLookup);
			if (entry) {
				const g = groups.find((g) => g.agentName === entry.agentName);
				if (g) g.rooms.push(room);
			}
		}
		return groups.filter((g) => g.rooms.length > 0);
	});
	const unassignedRooms = $derived(
		globalGate ? matches.filter((r) => agentFor(r.timelineKey, agentLookup) == null) : []
	);
	// Flat ordered list for keyboard navigation: agent groups in config order, then unassigned.
	const matchesOrdered = $derived(
		globalGate
			? [...agentGroups.flatMap((g) => g.rooms), ...unassignedRooms]
			: matches
	);

	// Offer the typed text as a raw key when it doesn't exactly match a known room.
	const rawOption = $derived.by(() => {
		const q = filter.trim();
		if (!q) return null;
		if (allRooms.some((r) => r.timelineKey === q)) return null;
		return q;
	});

	// Keep the highlighted index in range as the filtered set changes.
	$effect(() => {
		const max = matchesOrdered.length + (rawOption ? 1 : 0);
		if (highlight >= max) highlight = Math.max(0, max - 1);
	});

	// Focus the search box and reset the filter each time the popover opens.
	$effect(() => {
		if (open) {
			filter = '';
			highlight = 0;
			queueMicrotask(() => searchEl?.focus());
		}
	});

	function pick(key: string): void {
		value = key;
		open = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		const total = matchesOrdered.length + (rawOption ? 1 : 0);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlight = total === 0 ? 0 : (highlight + 1) % total;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = total === 0 ? 0 : (highlight - 1 + total) % total;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (highlight < matchesOrdered.length) {
				const r = matchesOrdered[highlight];
				if (r) pick(r.timelineKey);
			} else if (rawOption) {
				pick(rawOption);
			}
		}
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		title={selected?.displayName ?? value}
		class={cn(
			'flex w-80 flex-col items-start gap-0.5 rounded border bg-background px-2 py-1 text-left',
			className
		)}
	>
		{#if selected}
			<span class="w-full truncate">{selected.displayName ?? selected.timelineKey}</span>
			<span class="w-full truncate font-mono text-[10px] text-muted-foreground">
				{selected.timelineKey}
			</span>
		{:else if value}
			<span class="w-full truncate font-mono">{value}</span>
			<span class="text-[10px] text-muted-foreground">raw key (not in room list)</span>
		{:else}
			<span class="text-muted-foreground">{placeholder}</span>
		{/if}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={4}
			align="start"
			class="z-50 w-80 rounded-md border bg-background text-xs shadow-md outline-none"
		>
			<div class="border-b p-1.5">
				<input
					bind:this={searchEl}
					bind:value={filter}
					onkeydown={onKeydown}
					placeholder={globalGate
						? 'filter by name, key, or agent…'
						: 'filter by name or key…'}
					class="w-full rounded border bg-background px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
				/>
			</div>
			<div class="max-h-72 overflow-y-auto p-1">
				{#if rooms.isPending}
					<div class="px-2 py-3 text-center text-muted-foreground">loading rooms…</div>
				{:else if matchesOrdered.length === 0 && !rawOption}
					<div class="px-2 py-3 text-center text-muted-foreground">no matching rooms</div>
				{:else if globalGate}
					<!-- Agent-grouped view (§4): groups in config order, unassigned last. -->
					{#each agentGroups as group (group.agentName)}
						{@const accent = agentAccent(group.agentIndex)}
						<!-- Group header with accent dot. -->
						<div class="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wide text-muted-foreground">
							<span class="inline-block size-1.5 rounded-full" style="background:{accent}"></span>
							<span style="color:{accent}">{group.agentName}</span>
						</div>
						{#each group.rooms as room (room.timelineKey)}
							{@const idx = matchesOrdered.indexOf(room)}
							<button
								type="button"
								onclick={() => pick(room.timelineKey)}
								onmouseenter={() => (highlight = idx)}
								class={cn(
									'flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left',
									highlight === idx ? 'bg-muted' : 'hover:bg-muted/60',
									room.timelineKey === value && 'ring-1 ring-inset ring-primary/40'
								)}
							>
								<span class="w-full truncate">{room.displayName ?? room.timelineKey}</span>
								<span class="w-full truncate font-mono text-[10px] text-muted-foreground">
									{room.timelineKey}
								</span>
							</button>
						{/each}
					{/each}
					{#if unassignedRooms.length > 0}
						<div class="px-2 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wide text-muted-foreground/50">
							Unassigned
						</div>
						{#each unassignedRooms as room (room.timelineKey)}
							{@const idx = matchesOrdered.indexOf(room)}
							<button
								type="button"
								onclick={() => pick(room.timelineKey)}
								onmouseenter={() => (highlight = idx)}
								class={cn(
									'flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left',
									highlight === idx ? 'bg-muted' : 'hover:bg-muted/60',
									room.timelineKey === value && 'ring-1 ring-inset ring-primary/40'
								)}
							>
								<span class="w-full truncate text-muted-foreground/70">
									{room.displayName ?? room.timelineKey}
								</span>
								<span class="w-full truncate font-mono text-[10px] text-muted-foreground/50">
									{room.timelineKey}
								</span>
							</button>
						{/each}
					{/if}
				{:else}
					<!-- Legacy flat list (unchanged below the gate). -->
					{#each matches as room, i (room.timelineKey)}
						<button
							type="button"
							onclick={() => pick(room.timelineKey)}
							onmouseenter={() => (highlight = i)}
							class={cn(
								'flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left',
								highlight === i ? 'bg-muted' : 'hover:bg-muted/60',
								room.timelineKey === value && 'ring-1 ring-inset ring-primary/40'
							)}
						>
							<span class="w-full truncate">{room.displayName ?? room.timelineKey}</span>
							<span class="w-full truncate font-mono text-[10px] text-muted-foreground">
								{room.timelineKey}
							</span>
						</button>
					{/each}
				{/if}
				{#if rawOption}
					<button
						type="button"
						onclick={() => pick(rawOption)}
						onmouseenter={() => (highlight = matchesOrdered.length)}
						class={cn(
							'mt-1 flex w-full flex-col items-start gap-0.5 rounded border-t px-2 py-1.5 text-left',
							highlight === matchesOrdered.length ? 'bg-muted' : 'hover:bg-muted/60'
						)}
					>
						<span class="text-muted-foreground">use raw key</span>
						<span class="w-full truncate font-mono text-[10px]">{rawOption}</span>
					</button>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
