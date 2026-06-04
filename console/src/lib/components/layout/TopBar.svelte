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
	import { cn } from '$lib/utils';

	// Active area from the URL so deep-links + back/forward reflect the right view.
	const area = $derived(page.url.pathname.startsWith('/pipelines') ? 'pipelines' : 'conversations');
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
	</nav>

	<span class="text-muted-foreground">/</span>

	{#if area === 'conversations'}
		<nav class="flex min-w-0 items-center gap-1 text-muted-foreground">
			{#if selection.roomKey}
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
	{:else if pipelineSummary.failing != null}
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
