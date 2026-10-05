<script lang="ts">
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import BehaviourScorecard from '$lib/components/models/BehaviourScorecard.svelte';
	import BehaviourChart from '$lib/components/models/BehaviourChart.svelte';
	import BehaviourBreakdown from '$lib/components/models/BehaviourBreakdown.svelte';
	import BehaviourMix from '$lib/components/models/BehaviourMix.svelte';
	import BehaviourOverview from '$lib/components/models/BehaviourOverview.svelte';
	import IncidentLog from '$lib/components/models/IncidentLog.svelte';
	import { getModelBehaviour, getModelBehaviourIncidents } from '$lib/api/models.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { modelsHref } from '$lib/nav';
	import {
		BEHAVIOUR_GROUP_BYS,
		BEHAVIOUR_WINDOWS,
		MODEL_LABELS,
		behaviourFiltersToParams,
		behaviourQueryArg,
		isMixMetric,
		modelLabel,
		nextSort,
		parseBehaviourFilters,
		rateFamily,
		type BehaviourFilters
	} from '$lib/model-behaviour-view';
	import type { BehaviourIncidentRow, BehaviourScorecardRow } from '$lib/schemas';
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
	const metric = $derived(data ? data.metric : filters.metric);
	const rate = $derived(data?.rates.find((r) => r.id === metric));
	const chartOption = $derived(data?.charts?.find((c) => c.id === metric));

	// Model naming (group by model): config key, wire model id, or both. Families
	// and the other dimensions are shown as they are; a family's hover lists its
	// members under the same naming.
	const byModel = $derived(filters.groupBy === 'model');
	const nameOf = (m: string) => modelLabel(m, data?.models, filters.label);
	const labelOf = $derived((g: string) => (byModel && !filters.family ? nameOf(g) : g || '(unknown)'));
	const titleOf = (row: BehaviourScorecardRow) =>
		row.members.length > 0 ? row.members.map(nameOf).join(', ') : byModel ? (data?.models?.[row.group]?.id ?? undefined) : undefined;
	const audit = $derived(data?.audit ?? null);
	const ago = (ts: number) => {
		const min = Math.max(0, Math.round((Date.now() - ts) / 60_000));
		return min < 1 ? 'just now' : `${min} min ago`;
	};
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
				<label
					class="flex items-center gap-1 text-muted-foreground"
					title="group config entries by their [models.*].family, else by the wire model id they serve"
				>
					<input type="checkbox" checked={filters.family} onchange={(e) => setFilters({ family: e.currentTarget.checked, selected: null })} />
					by family
				</label>
				<div class="flex items-center gap-1 rounded-md bg-muted p-0.5" role="group" aria-label="model names">
					<span class="px-1 text-[10px] text-muted-foreground uppercase">name</span>
					{#each MODEL_LABELS as l (l)}
						<button
							type="button"
							aria-pressed={filters.label === l}
							class={cn('rounded px-2 py-0.5', filters.label === l ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground')}
							onclick={() => setFilters({ label: l })}>{l === 'key' ? 'config key' : l === 'id' ? 'model id' : 'both'}</button
						>
					{/each}
				</div>
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
					selected: <span class="font-mono">{labelOf(filters.selected)}</span> ✕
				</button>
			{/if}
			{#if data && data.pendingHours > 0}
				<span class="text-[10px] text-muted-foreground italic">{data.pendingHours} hours still being counted</span>
			{/if}
		</div>
		{#if audit}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="audit-progress">
				<span class="font-medium text-foreground">Offline audit backlog</span>
				{#each audit.stages as st (st.id)}
					<span class={cn(audit.current === st.id && 'text-foreground')} title={st.label}>
						{st.label}: {st.done} audited · {st.remaining} to go{audit.current === st.id ? ' (now)' : ''}
					</span>
				{/each}
				<span class="text-[10px] italic">{audit.sessions} sessions, counted {ago(audit.countedAt)}</span>
			</div>
		{/if}

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
					sort={filters.sort}
					dir={filters.dir}
					{labelOf}
					{titleOf}
					onSelect={(group, m) => setFilters({ selected: group, metric: m })}
					onSort={(column) => setFilters(nextSort(filters, column))}
				/>
			</section>
			<section>
				<div class="mb-2 flex flex-wrap items-center gap-2">
					<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Over time</h2>
					<select
						class="rounded border bg-background px-1 py-0.5 text-xs"
						aria-label="chart metric"
						data-testid="chart-metric"
						value={metric ?? ''}
						onchange={(e) => setFilters({ metric: e.currentTarget.value || null })}
					>
						<option value="">Overview: every rate</option>
						<optgroup label="Rates (one line per group)">
							{#each (data.charts ?? []).filter((c) => c.kind === 'rate') as c (c.id)}
								<option value={c.id}>{c.label} ({c.count}{c.count === 0 ? ', none recorded' : ''})</option>
							{/each}
						</optgroup>
						<optgroup label="Mix over time (one line per kind)">
							{#each (data.charts ?? []).filter((c) => c.kind === 'count') as c (c.id)}
								<option value={c.id}>{c.label} ({c.count}{c.count === 0 ? ', none recorded' : ''})</option>
							{/each}
						</optgroup>
					</select>
				</div>
				{#if metric === null || !data.overview}
					{#if data.overview}
						<BehaviourOverview
							rates={data.rates}
							metrics={data.overview.metrics}
							since={data.since}
							until={data.until}
							bucketMs={data.overview.bucketMs}
							onPick={(m) => setFilters({ metric: m })}
						/>
					{/if}
				{:else}
					<BehaviourChart
						points={data.series.points}
						{rate}
						option={chartOption}
						kind={data.series.kind ?? 'rate'}
						since={data.since}
						until={data.until}
						bucketMs={data.series.bucketMs}
						markers={data.markers}
						selected={filters.selected}
						{labelOf}
						scope={isMixMetric(metric) ? (filters.selected ? labelOf(filters.selected) : 'all groups') : undefined}
					/>
				{/if}
			</section>
			{#if data.mix}
				<section>
					<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
						Mix per {filters.family ? 'family' : filters.groupBy}
					</h2>
					<BehaviourMix tables={data.mix} selected={filters.selected} {labelOf} onChart={(f) => setFilters({ metric: `mix:${f}` })} />
				</section>
			{/if}
			<section>
				<h2 class="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Breakdown</h2>
				<BehaviourBreakdown
					breakdown={data.breakdown}
					family={rateFamily(metric)}
					selected={filters.selected ? labelOf(filters.selected) : null}
				/>
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
					labelOf={nameOf}
				/>
			</section>
		{/if}
	</div>
</div>
