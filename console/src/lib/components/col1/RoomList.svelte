<script lang="ts">
	import { page } from '$app/state';
	import { roomsQuery } from '$lib/query/rooms';
	import { agentsQuery } from '$lib/query/agents';
	import { selection } from '$lib/stores/selection.svelte';
	import { conversationsHref } from '$lib/nav';
	import { buildAgentLookup, agentFor, needsAccountId, agentAccent, platformOf } from '$lib/agents';
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';
	import type { Room } from '$lib/schemas';

	const rooms = roomsQuery();
	const agentsQ = agentsQuery();

	// ── Global gate (spec §3.1) ──────────────────────────────────────────────────
	// Agent chrome appears only in agents mode with more than one agent. While the
	// payload is loading we treat the gate as closed (no flash of wrong state).
	const agentsData = $derived(agentsQ.data);
	const globalGate = $derived(
		agentsData?.mode === 'agents' && (agentsData.agents.length ?? 0) > 1
	);
	const agentList = $derived(globalGate ? (agentsData?.agents ?? []) : []);
	const lookup = $derived(agentsData && globalGate ? buildAgentLookup(agentsData) : new Map());

	// ── Agent tab selection (§3.5) ───────────────────────────────────────────────
	// Under the global gate the tab is a URL param (`?agent=<name>`) so filtered
	// views are deep-linkable and survive reload. An unknown or absent name → All.
	const agentNames = $derived(new Set(agentList.map((a) => a.name)));
	function activeAgentName(): string | null {
		if (!globalGate) return null;
		const param = page.url.searchParams.get('agent');
		return param && agentNames.has(param) ? param : null;
	}

	// ── Legacy per-account tabs (shown only below the global gate) ───────────────
	interface AccountTab {
		key: string;
		provider: string;
		accountId: string;
		count: number;
	}
	const accounts = $derived.by((): AccountTab[] => {
		if (globalGate) return [];
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

	// Legacy tab local state (only used below the gate, unchanged behavior).
	let accountTab = $state<string | null>(null);
	const showLegacyTabs = $derived(!globalGate && accounts.length > 1);
	const activeLegacyTab = $derived(
		showLegacyTabs && accountTab !== null && accounts.some((a) => a.key === accountTab)
			? accountTab
			: null
	);

	// ── Visible rooms ─────────────────────────────────────────────────────────────
	const visibleRooms = $derived.by((): Room[] => {
		const all = rooms.data?.rooms ?? [];
		if (globalGate) {
			const name = activeAgentName();
			if (name === null) return [...all]; // All tab
			return all.filter((r) => agentFor(r.timelineKey, lookup)?.agentName === name);
		}
		// Legacy: filter by account tab
		if (activeLegacyTab === null) return [...all];
		return all.filter(
			(r) => r.provider && r.accountId && `${r.provider}:${r.accountId}` === activeLegacyTab
		);
	});

	// Per-agent room counts (for agent tab badges).
	const agentRoomCounts = $derived.by((): Map<string, number> => {
		const m = new Map<string, number>();
		if (!globalGate) return m;
		for (const room of rooms.data?.rooms ?? []) {
			const entry = agentFor(room.timelineKey, lookup);
			if (entry) m.set(entry.agentName, (m.get(entry.agentName) ?? 0) + 1);
		}
		return m;
	});

	// Build the href for an agent tab link. Includes the current room/session so
	// switching tabs doesn't lose the open selection.
	function agentTabHref(agentName: string | null): string {
		return conversationsHref({
			agent: agentName,
			room: selection.roomKey,
			session: selection.sessionId
		});
	}

	// Row-level chip helpers for agent mode.
	function rowAgentEntry(timelineKey: string) {
		return agentFor(timelineKey, lookup);
	}
	function rowNeedsAccountId(timelineKey: string): boolean {
		const entry = rowAgentEntry(timelineKey);
		if (!entry) return false;
		const fullEntry = agentList.find((a) => a.name === entry.agentName);
		if (!fullEntry) return false;
		const c1 = timelineKey.indexOf(':');
		const c2 = c1 >= 0 ? timelineKey.indexOf(':', c1 + 1) : -1;
		if (c1 < 0 || c2 < 0) return false;
		const provider = timelineKey.slice(0, c1);
		return needsAccountId(fullEntry, provider);
	}
	function rowProvider(timelineKey: string): string {
		const c1 = timelineKey.indexOf(':');
		return c1 > 0 ? timelineKey.slice(0, c1) : '';
	}
	function rowAccountId(timelineKey: string): string {
		const c1 = timelineKey.indexOf(':');
		const c2 = c1 >= 0 ? timelineKey.indexOf(':', c1 + 1) : -1;
		return c1 >= 0 && c2 >= 0 ? timelineKey.slice(c1 + 1, c2) : '';
	}
</script>

<div class="flex h-full flex-col">
	<div class="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Rooms
	</div>

	{#if globalGate}
		<!-- Agent tabs (spec §3.2 agent-level grammar): All / one per agent, config order. -->
		<div class="flex flex-wrap items-center gap-1 px-2 pb-2 text-xs" data-sveltekit-noscroll data-sveltekit-keepfocus>
			<a
				href={agentTabHref(null)}
				class={cn(
					'rounded px-2 py-0.5 transition-colors',
					activeAgentName() === null
						? 'bg-muted font-medium text-foreground'
						: 'text-muted-foreground hover:text-foreground'
				)}
			>
				All
			</a>
			{#each agentList as agent, i (agent.name)}
				{@const platform = platformOf(agent)}
				{@const count = agentRoomCounts.get(agent.name) ?? 0}
				{@const accent = agentAccent(i)}
				<a
					href={agentTabHref(agent.name)}
					title={`${agent.name} · ${platform.toUpperCase()} · ${count} room${count === 1 ? '' : 's'}`}
					class={cn(
						'flex items-baseline gap-1 rounded px-2 py-0.5 transition-colors',
						activeAgentName() === agent.name
							? 'bg-muted font-medium text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
				>
					<!-- Accent dot (§3.4) — small left-border substitute using an inline dot -->
					<span
						class="relative top-px inline-block size-1.5 shrink-0 rounded-full"
						style="background:{accent}"
					></span>
					{agent.name}
					<span class="text-[10px] uppercase tracking-wide opacity-70">{platform}</span>
				</a>
			{/each}
		</div>
	{:else if showLegacyTabs}
		<!-- Legacy per-account sub-tabs (unchanged behavior below the global gate). -->
		<div class="flex flex-wrap items-center gap-1 px-2 pb-2 text-xs">
			<button
				class={cn(
					'rounded px-2 py-0.5 transition-colors',
					activeLegacyTab === null
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
						activeLegacyTab === a.key
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
			<!-- Selection is URL-driven (ARCHITECTURE.md §11): each row is a real link. -->
			<ul data-sveltekit-noscroll data-sveltekit-keepfocus>
				{#each visibleRooms as room (room.timelineKey)}
					{@const agentEntry = globalGate ? rowAgentEntry(room.timelineKey) : undefined}
					{@const isUnresolvable = globalGate && agentEntry == null}
					{@const activeTab = activeAgentName()}
					{@const inAgentTab = activeTab !== null}
					{@const showRowAccId = globalGate && agentEntry != null && inAgentTab && rowNeedsAccountId(room.timelineKey)}
					{@const showAllChip = globalGate && !inAgentTab}
					<li>
						<a
							href={conversationsHref({ agent: activeTab, room: room.timelineKey })}
							aria-current={selection.roomKey === room.timelineKey ? 'true' : undefined}
							class={cn(
								'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
								selection.roomKey === room.timelineKey && 'bg-accent'
							)}
						>
							<span class="min-w-0 flex-1 truncate" title={room.timelineKey}>
								{room.displayName ?? room.timelineKey}
							</span>
							{#if globalGate}
								<span class="flex shrink-0 items-center gap-1">
									{#if showAllChip && agentEntry}
										<!-- All-tab row chip: agent name + provider (+ accountId if needed). -->
										{@const accent = agentAccent(agentEntry.agentIndex)}
										<span class="inline-flex items-baseline gap-0.5 text-[9px]">
											<span class="relative top-px inline-block size-1.5 rounded-full" style="background:{accent}"></span>
											<span style="color:{accent}">
												{agentEntry.agentName}
												<span class="uppercase tracking-wide">{rowProvider(room.timelineKey)}</span>{#if rowNeedsAccountId(room.timelineKey)}&nbsp;{rowAccountId(room.timelineKey)}{/if}
											</span>
										</span>
									{:else if isUnresolvable}
										<!-- Unresolvable: raw account tag, muted (§4.3). Visible in All only. -->
										{@const prov = rowProvider(room.timelineKey)}
										{@const accId = rowAccountId(room.timelineKey)}
										{#if prov && accId}
											<span class="text-[9px] text-muted-foreground/50">
												{accId} <span class="uppercase tracking-wide">{prov}</span>
											</span>
										{/if}
									{:else if showRowAccId}
										<!-- In-agent-tab disambiguator: accountId when needsAccountId (§3.2). -->
										<span class="text-[9px] text-muted-foreground">{rowAccountId(room.timelineKey)}</span>
									{/if}
									{#if room.timelineState}
										<Badge class="font-mono text-[10px]" variant="outline">
											{room.timelineState}
										</Badge>
									{/if}
									<span class="text-xs text-muted-foreground tabular-nums">
										{room.sessionCount}
									</span>
								</span>
							{:else}
								{#if room.timelineState}
									<Badge class="shrink-0 font-mono text-[10px]" variant="outline">
										{room.timelineState}
									</Badge>
								{/if}
								<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
									{room.sessionCount}
								</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
