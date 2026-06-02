<script lang="ts">
	import { toggleMode } from 'mode-watcher';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import { Button } from '$lib/components/ui/button';
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
</script>

<header class="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
	<span class="font-semibold">miku console</span>
	<span class="text-muted-foreground">/</span>
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

	<div class="flex-1"></div>

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

	<Button variant="ghost" size="icon" onclick={toggleMode} aria-label="Toggle theme">
		<SunIcon class="size-4 dark:hidden" />
		<MoonIcon class="hidden size-4 dark:block" />
	</Button>
</header>
