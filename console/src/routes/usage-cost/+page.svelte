<script lang="ts">
	import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import SpendSummaryCard from '$lib/components/SpendSummaryCard.svelte';
	import ChannelCell from '$lib/components/ChannelCell.svelte';
	import {
		getUsageSummary,
		getUsageTimeseries,
		getUsageSessions,
		getUsageToolCalls,
		getUsageLeaderboard,
		getUsageBudgets
	} from '$lib/api/usage.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { cn } from '$lib/utils';
	import { fmtUsd, fmtInt, fmtPct } from '$lib/usage-format';
	import { buildSpendChart, isSpendChartEmpty, niceTicks } from '$lib/spend-chart';
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
		{ id: 'month', label: 'This month', utc: true },
		{ id: 'all', label: 'All time', utc: false }
	] as const;

	// URL is the source of truth (ARCHITECTURE.md §11): the window, the class/model breakdown,
	// and the active detail tab all live in query params, so the view is deep-linkable,
	// refreshable, and shareable. Reads are reactive getters over `page.url`; writes go through
	// `setParam` (replaceState — a filter/tab toggle shouldn't pile up browser history). Unknown
	// or hand-edited values coerce to a safe default so a bad URL never breaks a query or the
	// selector highlight.
	const WINDOW_IDS = WINDOWS.map((w) => w.id) as readonly string[];
	const TABS = [
		{ id: 'sessions', label: 'Recent sessions' },
		{ id: 'paid', label: 'Recent paid calls' },
		{ id: 'leaderboard', label: 'User leaderboard' }
	] as const;
	const TAB_IDS = TABS.map((t) => t.id) as readonly string[];

	function coerce(value: string | null, allowed: readonly string[], fallback: string): string {
		return value != null && allowed.includes(value) ? value : fallback;
	}
	const window = $derived(coerce(page.url.searchParams.get('window'), WINDOW_IDS, '24h'));
	const groupBy = $derived(
		coerce(page.url.searchParams.get('group'), ['class', 'model'], 'class') as 'class' | 'model'
	);
	const tab = $derived(coerce(page.url.searchParams.get('tab'), TAB_IDS, 'sessions'));

	function setParam(key: string, value: string): void {
		const url = new URL(page.url);
		url.searchParams.set(key, value);
		void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

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
	// The three tab-bound feeds only poll while their tab is visible (`enabled`), so the page
	// isn't fetching all three at once; switching to a tab fetches the newly-shown one.
	const sessions = createQuery(() => ({
		queryKey: keys.usageSessions(),
		queryFn: () => fresh(getUsageSessions()),
		enabled: tab === 'sessions',
		refetchInterval: 8000
	}));
	const toolCalls = createQuery(() => ({
		queryKey: keys.usageToolCalls(),
		queryFn: () => fresh(getUsageToolCalls()),
		enabled: tab === 'paid',
		refetchInterval: 8000
	}));
	// Per-user leaderboard — `window` folds into the key (cards + table both scope to the
	// selected period); `keepPreviousData` keeps the prior window on screen while a new one
	// loads, like the cards/chart above.
	const leaderboard = createQuery(() => ({
		queryKey: keys.usageLeaderboard(window),
		queryFn: () => fresh(getUsageLeaderboard({ window })),
		enabled: tab === 'leaderboard',
		placeholderData: keepPreviousData,
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

	// User-leaderboard pagination (client-side). The backend returns the full non-zero
	// human ranking, so we page through it locally down to the lowest spender. The page
	// resets to 0 whenever the window or active tab changes (a new ranking).
	const USER_PAGE_SIZE = 25;
	let userPage = $state(0);
	$effect(() => {
		void window;
		void tab;
		userPage = 0;
	});
	const lbUsers = $derived(leaderboard.data?.users ?? []);
	const userPageCount = $derived(Math.max(1, Math.ceil(lbUsers.length / USER_PAGE_SIZE)));
	const userPageSafe = $derived(Math.min(userPage, userPageCount - 1));
	const pagedUsers = $derived(
		lbUsers.slice(userPageSafe * USER_PAGE_SIZE, userPageSafe * USER_PAGE_SIZE + USER_PAGE_SIZE)
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
	// X-axis tick label, scaled to the bucket width: hour for sub-day, day for day/week,
	// month+year for monthly, year alone for yearly — so an all-time chart that buckets by
	// month/year doesn't repeat bare "Jan 1" labels with no year.
	function fmtBucket(bucket: number, bucketMs: number): string {
		const d = new Date(bucket);
		if (bucketMs < 86_400_000) return d.toLocaleTimeString([], { hour: '2-digit' });
		if (bucketMs >= 360 * 86_400_000) return String(d.getFullYear());
		if (bucketMs >= 28 * 86_400_000)
			return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
	// Full bucket span for the hover tooltip header (the column's x-axis position).
	function fmtBucketRange(bucket: number, bucketMs: number): string {
		const start = new Date(bucket);
		if (bucketMs < 86_400_000) {
			const end = new Date(bucket + bucketMs);
			const hm = { hour: '2-digit', minute: '2-digit' } as const;
			return `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], hm)}–${end.toLocaleTimeString([], hm)}`;
		}
		if (bucketMs >= 360 * 86_400_000) return String(start.getFullYear());
		if (bucketMs >= 28 * 86_400_000)
			return start.toLocaleDateString([], { month: 'long', year: 'numeric' });
		// Day / week buckets: show the inclusive span (a single day reads as one date).
		const last = new Date(bucket + bucketMs - 86_400_000);
		const opts = { month: 'short', day: 'numeric' } as const;
		const startStr = start.toLocaleDateString([], opts);
		return bucketMs <= 86_400_000
			? start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
			: `${startStr} – ${last.toLocaleDateString([], opts)}`;
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
						onclick={() => setParam('window', w.id)}
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
						onclick={() => setParam('group', g)}
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
			<SpendSummaryCard
				label="Total spend"
				total={total}
				firstTs={summary.data?.firstTs ?? null}
				now={summary.data?.now ?? Date.now()}
				series={timeseries.data?.series ?? []}
				bucketMs={timeseries.data?.bucketMs ?? 3_600_000}
				windowId={window}
			/>
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
					{#each byModel.slice(0, 7) as m (m.model)}
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

		<!-- 5. Detail tabs — Recent sessions / Recent paid calls / User leaderboard. Limits stays
		     above as its own always-visible section; these three switch via ?tab=. -->
		<section>
			<div class="mb-3 border-b">
				<nav class="-mb-px flex flex-wrap gap-4 text-sm" aria-label="Usage detail">
					{#each TABS as t (t.id)}
						<button
							class={cn(
								'border-b-2 px-0.5 py-2 transition-colors',
								tab === t.id
									? 'border-foreground font-medium text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground'
							)}
							aria-current={tab === t.id ? 'page' : undefined}
							onclick={() => setParam('tab', t.id)}
						>
							{t.label}
						</button>
					{/each}
				</nav>
			</div>

			{#if tab === 'sessions'}
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
							<th class="py-1 pr-3 font-medium">status</th>
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
								<td class="py-1 pr-3 text-[10px] text-muted-foreground">{s.status}</td>
								<td class="py-1 pr-3 text-[10px]">
									<ChannelCell label={s.channelLabel} id={s.timelineKey} />
								</td>
								<td class="py-1 text-[11px]">{s.triggerSender ?? 'N/A'}</td>
							</tr>
						{:else}
							<tr><td colspan="15" class="py-2 text-xs text-muted-foreground">no sessions</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			{:else if tab === 'paid'}
			<!-- Recent paid tool/caption/embedding calls -->
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
								<td class="py-1 text-[10px]">
									{#if t.timeline_key}
										<ChannelCell label={t.channel_label ?? t.timeline_key} id={t.timeline_key} />
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</td>
							</tr>
						{:else}
							<tr><td colspan="11" class="py-2 text-xs text-muted-foreground">no paid calls</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			{:else if tab === 'leaderboard'}
				{@const lb = leaderboard.data}
				{#if !lb}
					<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
						Loading…
					</div>
				{:else if lb.users.length === 0 && lb.systemActors.length === 0}
					<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
						No spend in this window.
					</div>
				{:else}
					<!-- Users — humans only, ranked 1..N. Top-10 cards (per-user equivalent of the
					     Total-spend card; auto-fill grid wraps to the viewport) over a paginated full
					     ranking that reaches the lowest non-zero spender. -->
					{#if lb.users.length > 0}
						<div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
							{#each lb.users.slice(0, 10) as u (u.senderId)}
								<SpendSummaryCard
									label={u.displayName ?? u.senderId}
									titleAttr={u.senderId}
									total={u.total}
									firstTs={u.firstTs}
									now={lb.now}
									series={u.series}
									bucketMs={lb.bucketMs}
									windowId={window}
									rank={u.rank}
									shareOfTotal={lb.grandTotal > 0 ? u.total / lb.grandTotal : null}
									events={u.events}
									sessions={u.sessions}
								/>
							{/each}
						</div>

						<!-- Full user ranking, paginated client-side. -->
						{@const pageStart = userPageSafe * USER_PAGE_SIZE}
						<div class="mt-4 overflow-x-auto">
							<table class="w-full text-sm">
								<thead class="text-left text-xs text-muted-foreground">
									<tr class="border-b">
										<th class="py-1 pr-3 text-right font-medium">#</th>
										<th class="py-1 pr-3 font-medium">user</th>
										<th class="py-1 pr-3 text-right font-medium">spend</th>
										<th class="py-1 pr-3 text-right font-medium" title="share of total spend in this window">
											share
										</th>
										<th class="py-1 pr-3 text-right font-medium">events</th>
										<th class="py-1 pr-3 text-right font-medium">sessions</th>
										<th class="py-1 pr-3 font-medium">first seen</th>
										<th class="py-1 font-medium">last seen</th>
									</tr>
								</thead>
								<tbody>
									{#each pagedUsers as u (u.senderId)}
										<tr class="border-b border-border/50">
											<td class="py-1 pr-3 text-right font-mono text-[11px] text-muted-foreground">
												{u.rank}
											</td>
											<td class="max-w-[20rem] truncate py-1 pr-3" title={u.senderId}>
												{u.displayName ?? u.senderId}
											</td>
											<td class="py-1 pr-3 text-right font-mono text-[11px] font-semibold">
												{fmtUsd(u.total)}
											</td>
											<td class="py-1 pr-3 text-right font-mono text-[11px] text-muted-foreground">
												{lb.grandTotal > 0 ? fmtPct(u.total / lb.grandTotal) : '—'}
											</td>
											<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(u.events)}</td>
											<td class="py-1 pr-3 text-right font-mono text-[11px]">{fmtInt(u.sessions)}</td>
											<td class="py-1 pr-3 text-[10px] text-muted-foreground">{fmtTime(u.firstTs)}</td>
											<td class="py-1 text-[10px] text-muted-foreground">{fmtTime(u.lastTs)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
							<div class="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
								<span>
									Showing {pageStart + 1}–{pageStart + pagedUsers.length} of {lbUsers.length} user{lbUsers.length === 1 ? '' : 's'} with spend
								</span>
								{#if userPageCount > 1}
									<div class="flex items-center gap-1">
										<button
											class="rounded border px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
											disabled={userPageSafe === 0}
											onclick={() => (userPage = userPageSafe - 1)}
										>
											Prev
										</button>
										<span class="tabular-nums">Page {userPageSafe + 1} / {userPageCount}</span>
										<button
											class="rounded border px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
											disabled={userPageSafe >= userPageCount - 1}
											onclick={() => (userPage = userPageSafe + 1)}
										>
											Next
										</button>
									</div>
								{/if}
							</div>
							<div class="mt-1.5 text-[10px] text-muted-foreground">
								Users by spend over the selected window, attributed by trigger sender. Zero-spend
								users are omitted; per-user shares sum to ≤ 100% of total (system / self and
								background spend are not users).
							</div>
						</div>
					{:else}
						<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
							No human-user spend in this window.
						</div>
					{/if}

					<!-- System & self: non-human/self actors kept OUT of the user ranking, plus
					     average/median reference cards so each can be compared to a typical user. -->
					<section class="mt-6">
						<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							System &amp; self
						</h2>
						<div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]">
							<!-- Reference stat cards (no sparkline) over the non-zero human users. -->
							<div class="rounded-lg border border-dashed p-3">
								<div class="text-xs text-muted-foreground">Average user</div>
								<div class="mt-1 font-mono text-2xl font-semibold">
									{lb.userStats.count > 0 ? fmtUsd(lb.userStats.average) : '—'}
								</div>
								<div class="mt-0.5 text-[10px] text-muted-foreground">
									over {fmtInt(lb.userStats.count)} user{lb.userStats.count === 1 ? '' : 's'} with spend
								</div>
							</div>
							<div class="rounded-lg border border-dashed p-3">
								<div class="text-xs text-muted-foreground">Median user</div>
								<div class="mt-1 font-mono text-2xl font-semibold">
									{lb.userStats.count > 0 ? fmtUsd(lb.userStats.median) : '—'}
								</div>
								<div class="mt-0.5 text-[10px] text-muted-foreground">
									over {fmtInt(lb.userStats.count)} user{lb.userStats.count === 1 ? '' : 's'} with spend
								</div>
							</div>
							<!-- One card per system/self actor, marked + carrying its comparison rank. -->
							{#each lb.systemActors as a (a.senderId)}
								<SpendSummaryCard
									label={a.displayName ?? a.senderId}
									total={a.total}
									firstTs={a.firstTs}
									now={lb.now}
									series={a.series}
									bucketMs={lb.bucketMs}
									windowId={window}
									rank={a.comparisonRank}
									shareOfTotal={lb.grandTotal > 0 ? a.total / lb.grandTotal : null}
									events={a.events}
									sessions={a.sessions}
									system={true}
								/>
							{/each}
						</div>
						{#if lb.systemActors.length === 0}
							<div class="mt-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
								No system / self spend in this window.
							</div>
						{/if}
						<div class="mt-1.5 text-[10px] text-muted-foreground">
							Summarization &amp; Diary are background maintenance; Proactive is Miku’s
							self-initiated posts. Each card’s rank shows where it would place among users;
							average / median are over users who spent &gt; 0 this period. Background caption /
							embedding has no actor and is excluded here but still counted in the total.
						</div>
					</section>
				{/if}
			{/if}
		</section>
	</div>
</div>
