<script lang="ts">
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import {
		getUsageSummary,
		getUsageTimeseries,
		getUsageSessions,
		getUsageToolCalls,
		getUsageBudgets
	} from '$lib/api/usage.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { cn } from '$lib/utils';
	import { buildSpendChart, isSpendChartEmpty, niceTicks } from '$lib/spend-chart';
	import { buildSpendAverages } from '$lib/spend-averages';
	import { presentRule } from '$lib/rule-status';

	// Usage & Cost page (spec USAGE-COST-LIMITS §7): cards + a stacked spend chart,
	// the always-shown Limits section (every configured rule + headroom), and the
	// recent-sessions / recent-paid-calls tables. All over the unified usage_events
	// ledger + the live BudgetEngine. Polled — the aggregates are cheap.
	// `today`/`month` align to the UTC calendar boundary (server-side, handlers.ts);
	// this can disagree with a tz'd calendar [[limits]] rule shown in Limits, so the
	// UTC basis is surfaced in the UI (issue #9). `utc:true` marks those controls.
	const UTC_HINT = 'Window is UTC-aligned — may differ from a rule’s configured timezone';
	const WINDOWS = [
		{ id: 'today', label: 'Today', utc: true },
		{ id: '24h', label: '24h', utc: false },
		{ id: '7d', label: '7d', utc: false },
		{ id: '30d', label: '30d', utc: false },
		{ id: 'month', label: 'This month', utc: true }
	] as const;

	let window = $state<string>('24h');
	let groupBy = $state<'class' | 'model'>('class');

	// `window`/`groupBy` fold into these query keys, so switching them is a new cache
	// entry. `keepPreviousData` keeps the prior window's cards/chart on screen while
	// the new window loads — without it the entry has no data and the UI blank-flashes
	// to "$0 / no spend" for one frame before refilling. Background polls (same key)
	// already retain data in place, so they update silently with no indicator.
	const summary = createQuery(() => ({
		queryKey: keys.usageSummary(window),
		queryFn: () => fresh(getUsageSummary({ window })),
		placeholderData: keepPreviousData,
		refetchInterval: 5000
	}));
	const timeseries = createQuery(() => ({
		queryKey: keys.usageTimeseries(window, groupBy),
		queryFn: () => fresh(getUsageTimeseries({ window, groupBy })),
		placeholderData: keepPreviousData,
		refetchInterval: 5000
	}));
	const sessions = createQuery(() => ({
		queryKey: keys.usageSessions(),
		queryFn: () => fresh(getUsageSessions()),
		refetchInterval: 8000
	}));
	const toolCalls = createQuery(() => ({
		queryKey: keys.usageToolCalls(),
		queryFn: () => fresh(getUsageToolCalls()),
		refetchInterval: 8000
	}));
	const budgets = createQuery(() => ({
		queryKey: keys.usageBudgets(),
		queryFn: () => fresh(getUsageBudgets()),
		refetchInterval: 5000
	}));

	const total = $derived(summary.data?.total ?? 0);
	const byClass = $derived(summary.data?.byClass ?? []);
	const byModel = $derived(summary.data?.byModel ?? []);

	// Per-sub-period spend averages for the Total card. Denominator is the *actual*
	// elapsed data range (`now - firstTs`), never the nominal window — see
	// `$lib/spend-averages`. Fed by the same timeseries the chart uses (per-bucket
	// totals are group-independent, so the class⇄model toggle doesn't move them).
	const averages = $derived(
		buildSpendAverages({
			total,
			firstTs: summary.data?.firstTs ?? null,
			now: summary.data?.now ?? Date.now(),
			series: timeseries.data?.series ?? [],
			bucketMs: timeseries.data?.bucketMs ?? 3_600_000,
			window
		})
	);
	// Sub-label under the total spelling out the averaging basis.
	const rangeNote = $derived(
		summary.data?.firstTs == null
			? 'no spend in window'
			: `over ${fmtElapsed((summary.data?.now ?? Date.now()) - summary.data.firstTs)} of data`
	);
	const rules = $derived(
		// Blocked first, then near, then ok; ties by fill fraction (spec §7.1 #3).
		[...(budgets.data?.rules ?? [])].sort((a, b) => {
			const rank = (s: string) => (s === 'blocked' ? 0 : s === 'near' ? 1 : 2);
			return rank(a.state) - rank(b.state) || b.fraction - a.fraction;
		})
	);

	// Stable color per group. Known classes get fixed hues; models cycle a palette.
	const CLASS_COLORS: Record<string, string> = {
		agent_loop: '#6366f1', // indigo
		tool: '#10b981', // emerald
		caption: '#f59e0b', // amber
		embedding: '#ec4899' // pink
	};
	const PALETTE = [
		'#6366f1',
		'#10b981',
		'#f59e0b',
		'#ec4899',
		'#0ea5e9',
		'#a855f7',
		'#ef4444',
		'#14b8a6',
		'#eab308',
		'#8b5cf6'
	];
	function colorFor(group: string, index: number): string {
		return CLASS_COLORS[group] ?? PALETTE[index % PALETTE.length];
	}

	function fmtUsd(n: number): string {
		if (n === 0) return '$0';
		if (n < 0.01) return '<$0.01';
		return `$${n.toFixed(n < 1 ? 4 : 2)}`;
	}
	function fmtInt(n: number | null): string {
		return n == null ? '—' : n.toLocaleString();
	}
	function fmtTime(ts: number | null): string {
		return ts == null ? '—' : new Date(ts).toLocaleString();
	}
	function fmtResetsIn(resetsAt: number): string {
		const ms = resetsAt - Date.now();
		if (ms <= 0) return 'now';
		const mins = Math.round(ms / 60000);
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 48) return `${hrs}h ${mins % 60}m`;
		return `${Math.floor(hrs / 24)}d`;
	}
	function windowLabel(w: {
		type: string;
		period?: string;
		duration?: string;
		tz?: string;
	}): string {
		if (w.type === 'rolling') return `rolling · ${w.duration ?? '?'}`;
		return `calendar · ${w.period ?? '?'}${w.tz ? ` · ${w.tz}` : ''}`;
	}
	function scopeLabel(scope: {
		classes?: readonly string[];
		sessionTypes?: readonly string[];
		tools?: readonly string[];
		models?: readonly string[];
	}): string {
		const parts: string[] = [];
		if (scope.classes?.length) parts.push(`class: ${scope.classes.join(', ')}`);
		if (scope.sessionTypes?.length) parts.push(`type: ${scope.sessionTypes.join(', ')}`);
		if (scope.tools?.length) parts.push(`tool: ${scope.tools.join(', ')}`);
		if (scope.models?.length) parts.push(`model: ${scope.models.join(', ')}`);
		return parts.length ? parts.join(' · ') : 'everything';
	}

	// Build a stacked-bar chart model from the (bucket, group, cost) series. Inline
	// SVG (no charting dependency): one column per time bucket, segments stacked per
	// group, height scaled to the busiest bucket. Logic lives in `$lib/spend-chart`
	// (pure + unit-tested).
	const chart = $derived(
		buildSpendChart(
			timeseries.data?.series ?? [],
			timeseries.data?.bucketMs ?? 3_600_000,
			colorFor
		)
	);
	// Empty = no buckets, or buckets exist but no positive spend (zero-cost-only
	// window → `max === 0`): show the "No spend" panel rather than an empty frame
	// with dangling legend swatches (issue #8).
	const chartEmpty = $derived(isSpendChartEmpty(chart));

	// --- Stacked spend chart geometry. Inline SVG with a real y-axis (rounded USD
	// ticks + gridlines) and per-column hover; the model build stays pure in
	// `$lib/spend-chart`. A left gutter holds the y labels, a bottom gutter the x labels.
	const VIEW_W = 760;
	const VIEW_H = 220;
	const PAD = { top: 8, right: 12, bottom: 22, left: 52 };
	const plotW = VIEW_W - PAD.left - PAD.right;
	const plotH = VIEW_H - PAD.top - PAD.bottom;
	// Bars scale to a rounded ceiling so the tallest sits just under a labelled gridline.
	const axis = $derived(niceTicks(chart.max, 4));
	function yFor(v: number): number {
		return PAD.top + plotH - (axis.niceMax > 0 ? (v / axis.niceMax) * plotH : 0);
	}
	function bandX(i: number, count: number): number {
		return PAD.left + (count > 0 ? (i / count) * plotW : 0);
	}
	function bandW(count: number): number {
		return count > 0 ? plotW / count : plotW;
	}
	function barW(count: number): number {
		return Math.max(2, Math.min(40, bandW(count) - 2));
	}
	function xLabelEvery(count: number): number {
		return Math.max(1, Math.ceil(count / 8));
	}

	// Hovered column → a floating breakdown tooltip (per-group values + total + the
	// bucket's time span), so the chart reads in absolute terms, not by colour alone.
	let hovered = $state<number | null>(null);
	const hoverCol = $derived(hovered != null ? chart.columns[hovered] : undefined);
	function tipLeftPct(i: number): number {
		const n = chart.columns.length;
		const cx = bandX(i, n) + bandW(n) / 2;
		return Math.min(82, Math.max(18, (cx / VIEW_W) * 100)); // clamp so the tooltip stays in frame
	}

	function axisDecimals(step: number): number {
		return step >= 1 ? 0 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
	}
	function fmtAxisUsd(v: number, step: number): string {
		return v === 0 ? '$0' : `$${v.toFixed(axisDecimals(step))}`;
	}
	function fmtBucket(bucket: number, bucketMs: number): string {
		const d = new Date(bucket);
		return bucketMs < 86_400_000
			? d.toLocaleTimeString([], { hour: '2-digit' })
			: d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
	// Full bucket span for the hover tooltip header (the column's x-axis position).
	function fmtBucketRange(bucket: number, bucketMs: number): string {
		const start = new Date(bucket);
		if (bucketMs < 86_400_000) {
			const end = new Date(bucket + bucketMs);
			const hm = { hour: '2-digit', minute: '2-digit' } as const;
			return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], hm)}–${end.toLocaleTimeString([], hm)}`;
		}
		return start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
	}
	// Elapsed actual-data range under the total — the basis for the per-period averages.
	function fmtElapsed(ms: number): string {
		if (ms <= 0) return '0m';
		const mins = Math.round(ms / 60000);
		if (mins < 60) return `${mins}m`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 48) return `${hrs}h ${mins % 60}m`;
		const days = ms / 86_400_000;
		return `${days.toFixed(days < 10 ? 1 : 0)}d`;
	}

	const STATE_BADGE: Record<string, string> = {
		ok: 'bg-emerald-500/15 text-emerald-500',
		near: 'bg-amber-500/15 text-amber-500',
		blocked: 'bg-red-500/15 text-red-400'
	};
	function barColor(state: string): string {
		return state === 'blocked' ? 'bg-red-500' : state === 'near' ? 'bg-amber-500' : 'bg-emerald-500';
	}
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
		<!-- 1. Window selector + breakdown toggle -->
		<div class="flex flex-wrap items-center gap-3">
			<div class="flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs">
				{#each WINDOWS as w (w.id)}
					<button
						class={cn(
							'rounded px-2 py-0.5 transition-colors',
							window === w.id
								? 'bg-background font-medium text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'
						)}
						title={w.utc ? UTC_HINT : undefined}
						onclick={() => (window = w.id)}
					>
						{w.label}{#if w.utc}<span class="ml-0.5 text-[8px] uppercase opacity-60">utc</span>{/if}
					</button>
				{/each}
			</div>
			<div class="flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-xs">
				{#each ['class', 'model'] as g (g)}
					<button
						class={cn(
							'rounded px-2 py-0.5 capitalize transition-colors',
							groupBy === g
								? 'bg-background font-medium text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground'
						)}
						onclick={() => (groupBy = g as 'class' | 'model')}
					>
						by {g}
					</button>
				{/each}
			</div>
			<span class="text-[10px] text-muted-foreground" title={UTC_HINT}>
				Today / This month windows are UTC-aligned
			</span>
		</div>

		<!-- 2. Cards -->
		<!-- items-start so the taller Total card (it carries the averages breakdown) doesn't
		     stretch the by-class / top-models cards into a column of empty space. -->
		<div class="grid grid-cols-1 items-start gap-3 md:grid-cols-3">
			<div class="rounded-lg border p-3">
				<div class="text-xs text-muted-foreground">Total spend</div>
				<div class="mt-1 font-mono text-2xl font-semibold">{fmtUsd(total)}</div>
				<div class="mt-0.5 text-[10px] text-muted-foreground" title="averages divide by this elapsed range, not the nominal window">
					{rangeNote}
				</div>
				<!-- Sub-period averages (spec §7.1 cards): how much per hour/day/week, with the
				     min/max/σ spread across full periods. Denominator = actual elapsed data range. -->
				{#if averages.stats.length}
					<div class="mt-2 border-t pt-2">
						<table class="w-full text-[11px]">
							<thead>
								<tr class="text-[9px] uppercase tracking-wide text-muted-foreground">
									<th class="text-left font-medium"></th>
									<th class="pl-2 text-right font-medium">avg</th>
									<th class="pl-2 text-right font-medium">min</th>
									<th class="pl-2 text-right font-medium">max</th>
									<th class="pl-2 text-right font-medium">σ</th>
									<th class="pl-2 text-right font-medium" title="full periods the spread is over">n</th>
								</tr>
							</thead>
							<tbody class="font-mono tabular-nums">
								{#each averages.stats as s (s.label)}
									<tr>
										<td class="py-0.5 pr-2 text-left text-muted-foreground">{s.label}</td>
										<td class="py-0.5 pl-2 text-right font-semibold text-foreground">{fmtUsd(s.avg)}</td>
										<td class="py-0.5 pl-2 text-right">{s.min == null ? '—' : fmtUsd(s.min)}</td>
										<td class="py-0.5 pl-2 text-right">{s.max == null ? '—' : fmtUsd(s.max)}</td>
										<td class="py-0.5 pl-2 text-right">{s.stdev == null ? '—' : fmtUsd(s.stdev)}</td>
										<td class="py-0.5 pl-2 text-right text-muted-foreground">{s.n}</td>
									</tr>
								{/each}
							</tbody>
						</table>
						<div class="mt-1 text-[9px] leading-tight text-muted-foreground">
							avg = spend ÷ elapsed periods over the actual data range; min/max/σ across full periods
						</div>
					</div>
				{/if}
			</div>
			<div class="rounded-lg border p-3">
				<div class="text-xs text-muted-foreground">By class</div>
				<div class="mt-1 space-y-1">
					{#each byClass as c (c.class)}
						<div class="flex items-center justify-between gap-2 text-xs">
							<span class="flex items-center gap-1.5">
								<span
									class="inline-block size-2 rounded-sm"
									style={`background:${CLASS_COLORS[c.class] ?? '#888'}`}
								></span>
								{c.class}
							</span>
							<span class="font-mono">{fmtUsd(c.cost)}</span>
						</div>
					{:else}
						<div class="text-xs text-muted-foreground">no spend</div>
					{/each}
				</div>
			</div>
			<div class="rounded-lg border p-3">
				<div class="text-xs text-muted-foreground">Top models</div>
				<div class="mt-1 space-y-1">
					{#each byModel.slice(0, 5) as m (m.model)}
						<div class="flex items-center justify-between gap-2 text-xs">
							<span class="max-w-[12rem] truncate font-mono text-[11px]" title={m.model}>{m.model}</span>
							<span class="font-mono">{fmtUsd(m.cost)}</span>
						</div>
					{:else}
						<div class="text-xs text-muted-foreground">no spend</div>
					{/each}
				</div>
			</div>
		</div>

		<!-- 3. Stacked spend-over-time chart — real y-axis + per-column hover breakdown.
		     Sits ABOVE Limits: the time series is the primary read, Limits the reference. -->
		<section>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Spend over time
			</h2>
			{#if chartEmpty}
				<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
					No spend in this window.
				</div>
			{:else}
				<div class="rounded-lg border p-3">
					<div class="mb-2 flex flex-wrap gap-3 text-[10px]">
						{#each chart.groups as g (g)}
							<span class="flex items-center gap-1.5">
								<span
									class="inline-block size-2 rounded-sm"
									style={`background:${chart.groupColor.get(g)}`}
								></span>
								<span class="max-w-[10rem] truncate font-mono" title={g}>{g}</span>
							</span>
						{/each}
					</div>
					<!-- relative wrapper anchors the absolutely-positioned hover tooltip -->
					<div class="relative">
						<svg
							viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
							class="w-full"
							role="img"
							aria-label="Stacked spend over time"
							onpointerleave={() => (hovered = null)}
						>
							<!-- y-axis: gridlines + USD tick labels (so bars have an absolute scale) -->
							{#each axis.ticks as t (t)}
								<line
									x1={PAD.left}
									x2={VIEW_W - PAD.right}
									y1={yFor(t)}
									y2={yFor(t)}
									class="stroke-border"
									stroke-width="1"
								/>
								<text
									x={PAD.left - 6}
									y={yFor(t) + 3}
									text-anchor="end"
									class="fill-muted-foreground"
									font-size="9"
								>
									{fmtAxisUsd(t, axis.step)}
								</text>
							{/each}
							<!-- highlight the hovered column band -->
							{#if hovered != null}
								<rect
									x={bandX(hovered, chart.columns.length)}
									y={PAD.top}
									width={bandW(chart.columns.length)}
									height={plotH}
									class="fill-muted"
									opacity="0.5"
								/>
							{/if}
							<!-- stacked bars -->
							{#each chart.columns as col, i (col.bucket)}
								{@const n = chart.columns.length}
								{@const bw = barW(n)}
								{@const x = bandX(i, n) + (bandW(n) - bw) / 2}
								{#each col.segments as seg, si (seg.group)}
									{@const prior = col.segments.slice(0, si).reduce((s, p) => s + p.cost, 0)}
									{@const yTop = yFor(prior + seg.cost)}
									<rect {x} y={yTop} width={bw} height={Math.max(0, yFor(prior) - yTop)} fill={seg.color} />
								{/each}
								{#if i % xLabelEvery(n) === 0}
									<text
										x={bandX(i, n) + bandW(n) / 2}
										y={VIEW_H - 6}
										text-anchor="middle"
										class="fill-muted-foreground"
										font-size="9"
									>
										{fmtBucket(col.bucket, chart.bucketMs)}
									</text>
								{/if}
							{/each}
							<!-- x baseline -->
							<line
								x1={PAD.left}
								x2={VIEW_W - PAD.right}
								y1={PAD.top + plotH}
								y2={PAD.top + plotH}
								class="stroke-border"
								stroke-width="1"
							/>
							<!-- transparent full-height hit targets so hovering anywhere in a column counts -->
							{#each chart.columns as col, i (col.bucket)}
								<rect
									x={bandX(i, chart.columns.length)}
									y={PAD.top}
									width={bandW(chart.columns.length)}
									height={plotH}
									fill="transparent"
									role="presentation"
									onpointerenter={() => (hovered = i)}
								/>
							{/each}
						</svg>
						{#if hoverCol}
							<div
								class="pointer-events-none absolute top-1 z-10 w-max max-w-[15rem] -translate-x-1/2 rounded-md border bg-background/95 p-2 text-[11px] shadow-md backdrop-blur"
								style={`left:${tipLeftPct(hovered ?? 0)}%`}
							>
								<div class="mb-1 font-medium text-muted-foreground">
									{fmtBucketRange(hoverCol.bucket, chart.bucketMs)}
								</div>
								{#each [...hoverCol.segments].sort((a, b) => b.cost - a.cost) as seg (seg.group)}
									<div class="flex items-center justify-between gap-3">
										<span class="flex items-center gap-1.5">
											<span class="inline-block size-2 rounded-sm" style={`background:${seg.color}`}></span>
											<span class="max-w-[8rem] truncate font-mono" title={seg.group}>{seg.group}</span>
										</span>
										<span class="font-mono tabular-nums">
											{fmtUsd(seg.cost)}<span class="ml-1 text-muted-foreground"
												>{hoverCol.sum > 0 ? `${Math.round((seg.cost / hoverCol.sum) * 100)}%` : ''}</span
											>
										</span>
									</div>
								{/each}
								<div class="mt-1 flex items-center justify-between gap-3 border-t pt-1 font-mono font-semibold">
									<span>total</span>
									<span class="tabular-nums">{fmtUsd(hoverCol.sum)}</span>
								</div>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</section>

		<!-- 4. Limits — always show every configured rule (spec §7.1 #3) -->
		<section>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Limits
			</h2>
			{#if rules.length === 0}
				<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
					No period cost limits configured. Add <code>[[limits]]</code> rules to enforce budgets.
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
					{#each rules as rule (rule.name)}
						{@const pres = presentRule(rule)}
						<div class="rounded-lg border p-3">
							<div class="flex items-center justify-between gap-2">
								<span class="font-mono text-sm font-semibold">{rule.name}</span>
								<span
									class={cn(
										'rounded px-1.5 py-0.5 text-[10px] font-medium capitalize',
										STATE_BADGE[rule.state] ?? ''
									)}
								>
									{rule.state}
								</span>
							</div>
							{#if pres.kind === 'disabled'}
								<!-- Cap-0 rule: paid spend disabled for the scope. Render distinctly,
								     not as a maxed-out bar — no money was spent (issue #10b). -->
								<div class="mt-2 rounded bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
									{pres.label}
								</div>
							{:else}
								<div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
									<div
										class={cn('h-full rounded-full', barColor(rule.state))}
										style={`width:${pres.fillPct.toFixed(1)}%`}
									></div>
								</div>
								<div class="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
									<span class="font-mono text-foreground">
										{fmtUsd(rule.spentUsd)} / {fmtUsd(rule.capUsd)}
									</span>
									<span>{pres.percentLabel}</span>
								</div>
							{/if}
							<div class="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
								<span title={scopeLabel(rule.scope)} class="max-w-[60%] truncate">
									{scopeLabel(rule.scope)}
								</span>
								<span title={fmtTime(rule.resetsAt)}>
									{windowLabel(rule.window)} · resets {fmtResetsIn(rule.resetsAt)}
								</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<!-- 5. Recent sessions -->
		<section>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Recent sessions
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-muted-foreground">
						<tr class="border-b">
							<th class="py-1 pr-3 font-medium">session</th>
							<th class="py-1 pr-3 font-medium">type</th>
							<th class="py-1 pr-3 font-medium">model</th>
							<th class="py-1 pr-3 text-right font-medium">in</th>
							<th class="py-1 pr-3 text-right font-medium">out</th>
							<th class="py-1 pr-3 text-right font-medium" title="cache read">cr</th>
							<th class="py-1 pr-3 text-right font-medium" title="cache write">cw</th>
							<th class="py-1 pr-3 text-right font-medium">req</th>
							<th class="py-1 pr-3 text-right font-medium" title="tool calls">tools</th>
							<th class="py-1 pr-3 text-right font-medium" title="agent-LLM cost">llm $</th>
							<th class="py-1 pr-3 text-right font-medium" title="tool-call cost">tool $</th>
							<th class="py-1 pr-3 text-right font-medium">total $</th>
							<th class="py-1 pr-3 font-medium">channel</th>
							<th class="py-1 font-medium">trigger</th>
						</tr>
					</thead>
					<tbody>
						{#each sessions.data?.sessions ?? [] as s (s.sessionId)}
							<tr class="border-b border-border/50">
								<td class="py-1 pr-3 font-mono text-[10px]" title={s.sessionId}>
									<a href={`/?session=${s.sessionId}`} class="hover:underline">
										{s.sessionId.slice(0, 10)}
									</a>
								</td>
								<td class="py-1 pr-3 text-[11px]">{s.sessionType}</td>
								<td class="py-1 pr-3 font-mono text-[10px]" title={s.modelId ?? ''}>
									{s.modelId ?? '—'}
								</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(s.inputTokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(s.outputTokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(s.cacheReadTokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(s.cacheWriteTokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{s.requests}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{s.toolCalls}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtUsd(s.agentCost)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtUsd(s.toolCost)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px] font-semibold">
									{fmtUsd(s.agentCost + s.toolCost)}
								</td>
								<td class="py-1 pr-3 max-w-[12rem] truncate text-[10px]" title={s.timelineKey}>
									{s.timelineKey}
								</td>
								<td class="py-1 text-[11px]">{s.triggerSender ?? 'N/A'}</td>
							</tr>
						{:else}
							<tr><td colspan="14" class="py-2 text-xs text-muted-foreground">no sessions</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<!-- 6. Recent paid tool/caption/embedding calls -->
		<section>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Recent paid calls
			</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-muted-foreground">
						<tr class="border-b">
							<th class="py-1 pr-3 font-medium">when</th>
							<th class="py-1 pr-3 font-medium">class</th>
							<th class="py-1 pr-3 font-medium">tool</th>
							<th class="py-1 pr-3 font-medium">model</th>
							<th class="py-1 pr-3 font-medium">provider</th>
							<th class="py-1 pr-3 text-right font-medium">in</th>
							<th class="py-1 pr-3 text-right font-medium">out</th>
							<th class="py-1 pr-3 text-right font-medium" title="cache read">cr</th>
							<th class="py-1 pr-3 text-right font-medium" title="generated images — image-gen tool calls only; blank for token-priced calls">img</th>
							<th class="py-1 pr-3 text-right font-medium">cost</th>
							<th class="py-1 font-medium">channel</th>
						</tr>
					</thead>
					<tbody>
						{#each toolCalls.data?.toolCalls ?? [] as t (t.id)}
							<tr class="border-b border-border/50">
								<td class="py-1 pr-3 text-[10px] text-muted-foreground">{fmtTime(t.ts)}</td>
								<td class="py-1 pr-3 text-[11px]">{t.class}</td>
								<td class="py-1 pr-3 text-[11px]">{t.tool_name ?? '—'}</td>
								<td class="py-1 pr-3 font-mono text-[10px]" title={t.model_id}>{t.model_id}</td>
								<td class="py-1 pr-3 text-[10px]">{t.provider ?? '—'}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(t.input_tokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(t.output_tokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(t.cache_read_tokens)}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{t.images ? fmtInt(t.images) : '—'}</td>
								<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtUsd(t.cost_usd)}</td>
								<td class="py-1 max-w-[12rem] truncate text-[10px]" title={t.timeline_key ?? ''}>
									{t.timeline_key ?? '—'}
								</td>
							</tr>
						{:else}
							<tr><td colspan="11" class="py-2 text-xs text-muted-foreground">no paid calls</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</div>
</div>
