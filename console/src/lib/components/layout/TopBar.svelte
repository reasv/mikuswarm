<script lang="ts">
	import { page } from '$app/state';
	import { toggleMode } from 'mode-watcher';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import { Button } from '$lib/components/ui/button';
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';
	import { pipelineSummary } from '$lib/stores/pipeline-summary.svelte';
	import { agentsQuery } from '$lib/query/agents';
	import { buildAgentLookup, agentFor, agentAccent, needsAccountId } from '$lib/agents';
	import { timelineAccount } from '$lib/timeline-key';
	import { cn } from '$lib/utils';

	// Active area from the URL so deep-links + back/forward reflect the right view.
	const area = $derived(
		page.url.pathname.startsWith('/pipelines')
			? 'pipelines'
			: page.url.pathname.startsWith('/scheduler')
				? 'scheduler'
				: page.url.pathname.startsWith('/gap-backfetch')
					? 'gap-backfetch'
					: page.url.pathname.startsWith('/backfetch')
						? 'backfetch'
						: page.url.pathname.startsWith('/usage-cost')
							? 'usage-cost'
							: 'conversations'
	);

	// ── Agent chip in the conversations breadcrumb (spec CONSOLE-MULTI-AGENT §4) ──
	// Under the global gate, prefix an accent-colored agent chip before the raw
	// timeline key so the operator can read "which agent / which provider / which room"
	// at a glance. Raw key stays; chip is presentation only.
	const agentsQ = agentsQuery();
	const agentsData = $derived(agentsQ.data);
	const globalGate = $derived(
		agentsData?.mode === 'agents' && (agentsData.agents.length ?? 0) > 1
	);
	const agentLookup = $derived(
		agentsData && globalGate ? buildAgentLookup(agentsData) : new Map()
	);
	// Resolve agent for the currently-selected room key.
	const roomEntry = $derived(
		globalGate && selection.roomKey ? agentFor(selection.roomKey, agentLookup) : undefined
	);
	// Provider from the room's timeline key (for the row-level grammar §3.2).
	const roomProvider = $derived(
		selection.roomKey ? (timelineAccount(selection.roomKey)?.provider ?? null) : null
	);
	const roomAccentColor = $derived(roomEntry ? agentAccent(roomEntry.agentIndex) : undefined);
	const fullRoomAgent = $derived(
		roomEntry && agentsData
			? (agentsData.agents.find((a) => a.name === roomEntry.agentName) ?? null)
			: null
	);
	const roomAccountId = $derived(
		selection.roomKey ? (timelineAccount(selection.roomKey)?.accountId ?? null) : null
	);
	const showRoomAccId = $derived(
		fullRoomAgent != null && roomProvider != null
			? needsAccountId(fullRoomAgent, roomProvider)
			: false
	);
</script>

<header class="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
	<span class="font-semibold">miku console</span>

	<!-- Conversations | Pipelines area switch (links, so the URL is the source of truth) -->
	<nav class="flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs">
		<a
			href="/"
			class={cn(
				'rounded px-2 py-0.5 transition-colors',
				area === 'conversations'
					? 'bg-background font-medium text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
		>
			Conversations
		</a>
		<a
			href="/pipelines"
			class={cn(
				'rounded px-2 py-0.5 transition-colors',
				area === 'pipelines'
					? 'bg-background font-medium text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
		>
			Pipelines
		</a>
		<a
			href="/scheduler"
			class={cn(
				'rounded px-2 py-0.5 transition-colors',
				area === 'scheduler'
					? 'bg-background font-medium text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
		>
			Scheduler
		</a>
		<a
			href="/gap-backfetch"
			class={cn(
				'rounded px-2 py-0.5 transition-colors',
				area === 'gap-backfetch'
					? 'bg-background font-medium text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
		>
			Gap
		</a>
		<a
			href="/backfetch"
			class={cn(
				'rounded px-2 py-0.5 transition-colors',
				area === 'backfetch'
					? 'bg-background font-medium text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
		>
			Backfetch
		</a>
		<a
			href="/usage-cost"
			class={cn(
				'rounded px-2 py-0.5 transition-colors',
				area === 'usage-cost'
					? 'bg-background font-medium text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			)}
		>
			Usage & Cost
		</a>
	</nav>

	<span class="text-muted-foreground">/</span>

	{#if area === 'scheduler'}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			<span>llm scheduler</span>
		</nav>
	{:else if area === 'gap-backfetch'}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			<span>startup gap backfetch</span>
		</nav>
	{:else if area === 'backfetch'}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			<span>history backfetch</span>
		</nav>
	{:else if area === 'usage-cost'}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			<span>usage &amp; cost</span>
		</nav>
	{:else if area === 'conversations'}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			{#if selection.roomKey}
				{#if globalGate && roomEntry && roomProvider}
					<!-- Agent chip prefix: accent dot + name + provider [+ accountId if needed] (§3.2 row-level grammar).
					     Raw timeline key follows unchanged (§3.3 — the key never disappears). -->
					<span class="inline-flex shrink-0 items-baseline gap-0.5 text-[10px]">
						<span
							class="relative top-px inline-block size-1.5 shrink-0 rounded-full"
							style="background:{roomAccentColor}"
						></span>
						<span style="color:{roomAccentColor}">
							{roomEntry.agentName}
							<span class="uppercase tracking-wide">{roomProvider}</span>{#if showRoomAccId && roomAccountId}&nbsp;{roomAccountId}{/if}
						</span>
					</span>
					<span>·</span>
				{/if}
				<span class="max-w-[20rem] truncate text-foreground">{selection.roomKey}</span>
			{:else}
				<span>no room</span>
			{/if}
			{#if selection.sessionId}
				<span>▸</span>
				<span class="max-w-[16rem] truncate font-mono text-foreground">{selection.sessionId}</span>
			{/if}
		</nav>
	{:else}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			{#if pipelineSelection.pool}
				<span class="text-foreground">{pipelineSelection.pool}</span>
			{:else}
				<span>all pipelines</span>
			{/if}
			{#if pipelineSelection.itemId}
				<span>▸</span>
				<span class="max-w-[16rem] truncate font-mono text-foreground">{pipelineSelection.itemId}</span>
			{/if}
		</nav>
	{/if}

	<div class="flex-1"></div>

	{#if area === 'conversations'}
		{#if contextSummary.tokenEstimate != null}
			<div class="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
				<span title="total token estimate">Σ {contextSummary.tokenEstimate}</span>
				<span class="text-sky-500" title="compact tier tokens">c {contextSummary.compactTokens}</span>
				<span class="text-emerald-500" title="rich tier tokens">r {contextSummary.richTokens}</span>
				{#if contextSummary.cacheBoundaries.length > 0}
					<span title="cache boundaries">⛓ {contextSummary.cacheBoundaries.length}</span>
				{/if}
			</div>
		{/if}
		{#if contextSummary.live}
			<span class="flex items-center gap-1 text-[10px] text-blue-500">
				<span class="relative flex size-1.5">
					<span
						class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75"
					></span>
					<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
				</span>
				live
			</span>
		{/if}
	{:else if area === 'pipelines' && pipelineSummary.failing != null}
		<div class="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
			{#if pipelineSummary.inFlight > 0}
				<span class="flex items-center gap-1 text-blue-500" title="in flight across pools">
					<span class="relative flex size-1.5">
						<span
							class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75"
						></span>
						<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
					</span>
					{pipelineSummary.inFlight}
				</span>
			{/if}
			{#if pipelineSummary.retrying > 0}
				<span class="text-amber-500" title="retrying across pools">↻ {pipelineSummary.retrying}</span>
			{/if}
			{#if pipelineSummary.failing > 0}
				<span class="text-red-500" title="failing across pools">✕ {pipelineSummary.failing}</span>
			{:else}
				<span class="text-emerald-500" title="no failures">✓</span>
			{/if}
		</div>
	{/if}

	<Button variant="ghost" size="icon" onclick={toggleMode} aria-label="Toggle theme">
		<SunIcon class="size-4 dark:hidden" />
		<MoonIcon class="hidden size-4 dark:block" />
	</Button>
</header>
