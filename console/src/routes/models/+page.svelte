<script lang="ts">
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import BehaviourScorecard from '$lib/components/models/BehaviourScorecard.svelte';
	import BehaviourChart from '$lib/components/models/BehaviourChart.svelte';
	import BehaviourBreakdown from '$lib/components/models/BehaviourBreakdown.svelte';
	import IncidentLog from '$lib/components/models/IncidentLog.svelte';
	import { getModelBehaviour, getModelBehaviourIncidents } from '$lib/api/models.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { modelsHref } from '$lib/nav';
	import {
		BEHAVIOUR_GROUP_BYS,
		BEHAVIOUR_WINDOWS,
		behaviourFiltersToParams,
		behaviourQueryArg,
		parseBehaviourFilters,
		rateFamily,
		type BehaviourFilters
	} from '$lib/model-behaviour-view';
	import type { BehaviourIncidentRow } from '$lib/schemas';
	import { cn } from '$lib/utils';

	// Model behaviour (spec REFUSAL-HANDLING §12.3, §12.4): how often each model
	// refuses, breaks the send contract and produces style issues, and what happens
	// next. Every filter lives in the URL (deep-linkable, like the other pages).
	// Passive: the page flags nothing and notifies nobody.
	const filters = $derived(parseBehaviourFilters(page.url.searchParams));
	const arg = $derived(behaviourQueryArg(filters));

	function setFilters(patch: Partial<BehaviourFilters>): void {
		const next = { ...filters, ...patch };
		if (next.groupBy !== 'model') next.family = false;
		void goto(modelsHref(behaviourFiltersToParams(next)), { replaceState: true, keepFocus: true, noScroll: true });
	}

	const behaviour = createQuery(() => ({
		queryKey: keys.modelBehaviour(arg),
		queryFn: () => fresh(getModelBehaviour(arg)),
		placeholderData: keepPreviousData,
		refetchInterval: 30_000
	}));
	const data = $derived(behaviour.data);

	// Further incident pages (cursor pagination), appended below the first page the
	// main response carries; reset whenever the filters change.
	let extraRows = $state<BehaviourIncidentRow[]>([]);
	let extraCursor = $state<string | null | undefined>(undefined);
	let loadingMore = $state(false);
	let pagesFor = '';
	$effect(() => {
		const key = JSON.stringify(arg);
		if (key !== pagesFor) {
			pagesFor = key;
			extraRows = [];
			extraCursor = undefined;
		}
	});
	const incidentRows = $derived.by(() => {
		const first = data?.incidents.rows ?? [];
		const seen = new Set(first.map((r) => r.sessionId));
		return [...first, ...extraRows.filter((r) => !seen.has(r.sessionId))];
	});
	const nextCursor = $derived(extraCursor === undefined ? (data?.incidents.nextCursor ?? null) : extraCursor);
	async function loadMore(): Promise<void> {
		if (!nextCursor || loadingMore) return;
		loadingMore = true;
		try {
			const more = await fresh(getModelBehaviourIncidents({ ...arg, cursor: nextCursor }));
			extraRows = [...extraRows, ...more.rows];
			extraCursor = more.nextCursor;
		} finally {
			loadingMore = false;
		}
	}

	// Agent / site / task menus from the window's facets (a URL value outside them stays selectable).
	const facetSelects = $derived([
		{ key: 'agent' as const, values: [...(data?.facets.agents ?? [])] },
		{ key: 'site' as const, values: [...(data?.facets.sites ?? [])] },
		{ key: 'task' as const, values: [...(data?.facets.tasks ?? [])] }
	]);
	const metric = $derived(data?.metric ?? filters.metric ?? '');
	const rate = $derived(data?.rates.find((r) => r.id === metric));
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
		<!-- Filters (URL state): window, group-by (+ family), agent, site, task. -->
		<div class="flex flex-wrap items-center gap-2 text-xs" data-testid="behaviour-filters">
			<div class="flex rounded-md bg-muted p-0.5">
				{#each BEHAVIOUR_WINDOWS as w (w.id)}
					<button
						type="button"
						class={cn('rounded px-2 py-0.5', filters.window === w.id ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
						onclick={() => setFilters({ window: w.id })}>{w.label}</button
					>
				{/each}
			</div>
			<div class="flex items-center gap-1 rounded-md bg-muted p-0.5">
				<span class="px-1 text-[10px] text-muted-foreground uppercase">by</span>
				{#each BEHAVIOUR_GROUP_BYS as g (g)}
					<button
						type="button"
						class={cn('rounded px-2 py-0.5', filters.groupBy === g ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
						onclick={() => setFilters({ groupBy: g, selected: null })}>{g}</button
					>
				{/each}
			</div>
			{#if filters.groupBy === 'model'}
				<label class="flex items-center gap-1 text-muted-foreground" title="group config entries by their [models.*].family">
					<input type="checkbox" checked={filters.family} onchange={(e) => setFilters({ family: e.currentTarget.checked, selected: null })} />
					by family
				</label>
			{/if}
			{#each facetSelects as { key, values } (key)}
				<select
					class="rounded border bg-background px-1 py-0.5"
					aria-label={key}
					value={filters[key] ?? ''}
					onchange={(e) => setFilters({ [key]: e.currentTarget.value || null })}
				>
					<option value="">all {key}s</option>
					{#each values as v (v)}<option value={v}>{v}</option>{/each}
					{#if filters[key] && !values.includes(filters[key] ?? '')}
						<option value={filters[key]}>{filters[key]}</option>
					{/if}
				</select>
			{/each}
			{#if filters.selected}
				<button type="button" class="rounded border px-2 py-0.5" onclick={() => setFilters({ selected: null })}>
					selected: <span class="font-mono">{filters.selected}</span> ✕
				</button>
			{/if}
			{#if data && data.pendingHours > 0}
				<span class="text-[10px] text-muted-foreground italic">{data.pendingHours} hours still being counted</span>
			{/if}
		</div>

		{#if behaviour.isError}
			<div class="text-sm text-destructive">{behaviour.error.message}</div>
		{:else if !data}
			<div class="h-40 animate-pulse rounded bg-muted"></div>
		{:else}
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Scorecard</h2>
				<BehaviourScorecard
					rates={data.rates}
					rows={data.scorecard}
					selected={filters.selected}
					{metric}
					onSelect={(group, m) => setFilters({ selected: group, metric: m })}
				/>
			</section>
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Over time</h2>
				<BehaviourChart
					points={data.series.points}
					{rate}
					since={data.since}
					until={data.until}
					bucketMs={data.series.bucketMs}
					markers={data.markers}
					selected={filters.selected}
				/>
			</section>
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Breakdown</h2>
				<BehaviourBreakdown breakdown={data.breakdown} family={rateFamily(metric)} selected={filters.selected} />
			</section>
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Incidents</h2>
				<IncidentLog
					rows={incidentRows}
					hasMore={nextCursor != null}
					{loadingMore}
					type={filters.type}
					onType={(t) => setFilters({ type: t })}
					onLoadMore={loadMore}
				/>
			</section>
		{/if}
	</div>
</div>
