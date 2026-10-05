<script lang="ts">
	import type { BehaviourChartOption, BehaviourMarker, BehaviourRateDefinition, BehaviourSeriesPoint } from '$lib/schemas';
	import { buildBehaviourChart, chartX, emptyChartReason, formatCount, formatRate } from '$lib/model-behaviour-view';
	import { niceTicks } from '$lib/spend-chart';
	import { cn } from '$lib/utils';

	// Over time (spec REFUSAL-HANDLING §12.3 §2, §12.4): the selected metric, one
	// line per group (a rate) or per key (a keyed family's counts, e.g. failure
	// types), with change markers (a deploy's changes collapse into one marker;
	// hovering lists them). Inline SVG with a real y axis, like the usage page's
	// spend chart; no charting dependency. An empty metric says why it is empty.
	let {
		points,
		rate,
		option,
		kind = 'rate',
		since,
		until,
		bucketMs,
		markers,
		selected,
		labelOf = (g: string) => g || '(unknown)',
		scope
	}: {
		points: readonly BehaviourSeriesPoint[];
		rate: BehaviourRateDefinition | undefined;
		/** The metric's totals in the window (the empty-state wording). */
		option?: BehaviourChartOption;
		kind?: string;
		since: number;
		until: number;
		bucketMs: number;
		markers: readonly BehaviourMarker[];
		selected: string | null;
		labelOf?: (group: string) => string;
		/** What a family chart covers ("model_b", "all groups"). */
		scope?: string;
	} = $props();

	const isCount = $derived(kind === 'count');
	const fmt = (v: number) => (isCount ? formatCount(v) : rate ? formatRate(v, rate) : String(v));
	const title = $derived(option?.label ?? rate?.label ?? '');
	const denominatorName = $derived(rate?.denominator.replace(/_/g, ' '));

	const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#0ea5e9', '#a855f7', '#ef4444', '#14b8a6', '#84cc16', '#d946ef'];
	const VIEW_W = 760;
	const VIEW_H = 220;
	const PAD = { top: 10, right: 12, bottom: 22, left: 52 };
	const plotW = VIEW_W - PAD.left - PAD.right;
	const plotH = VIEW_H - PAD.top - PAD.bottom;

	const model = $derived(buildBehaviourChart(points, since, until, bucketMs, markers));
	const axis = $derived(niceTicks(model.max, 4));
	const colorOf = $derived(new Map(model.lines.map((l, i) => [l.group, PALETTE[i % PALETTE.length]!])));
	let hoveredMarker = $state<number | null>(null);

	const x = (t: number) => PAD.left + chartX(model, t, bucketMs) * plotW;
	const y = (v: number) => PAD.top + plotH - (axis.niceMax > 0 ? (v / axis.niceMax) * plotH : 0);
	const mid = (bucket: number) => x(bucket + bucketMs / 2);
	function label(bucket: number): string {
		const d = new Date(bucket);
		return bucketMs < 86_400_000
			? d.toLocaleTimeString([], { hour: '2-digit' })
			: d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
	const every = $derived(Math.max(1, Math.ceil(model.buckets.length / 8)));
	const marker = $derived(hoveredMarker != null ? model.markers[hoveredMarker] : undefined);
</script>

{#if model.lines.length === 0}
	<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="chart-empty">
		<span class="font-medium text-foreground">{title}</span>{#if scope}<span> · {scope}</span>{/if}:
		{emptyChartReason(option, denominatorName)}
		{#if model.markers.length > 0}({model.markers.length} change {model.markers.length === 1 ? 'marker' : 'markers'}){/if}
	</div>
{:else}
	<div class="rounded-lg border p-3">
		<div class="mb-2 flex flex-wrap gap-2 text-[10px]">
			<span class="font-semibold text-foreground">{title}</span>
			{#if scope}<span class="text-muted-foreground">{scope}</span>{/if}
			{#if option && option.kind === 'rate' && option.count === 0}
				<span class="text-muted-foreground italic" data-testid="chart-none-recorded">{emptyChartReason(option, denominatorName)}</span>
			{/if}
			{#each model.lines as l (l.group)}
				<span class={cn('flex items-center gap-1 font-mono', !isCount && selected && selected !== l.group && 'opacity-50')}>
					<span class="inline-block size-2 rounded-sm" style={`background:${colorOf.get(l.group)}`}></span>{isCount ? l.group : labelOf(l.group)}
				</span>
			{/each}
		</div>
		<div class="relative">
			<svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} class="w-full" role="img" aria-label="Behaviour over time" data-testid="behaviour-chart">
				{#each axis.ticks as t (t)}
					<line x1={PAD.left} x2={VIEW_W - PAD.right} y1={y(t)} y2={y(t)} class="stroke-border" stroke-width="1" />
					<text x={PAD.left - 6} y={y(t) + 3} text-anchor="end" class="fill-muted-foreground" font-size="9">
						{fmt(t)}
					</text>
				{/each}
				{#each model.buckets as b, i (b)}
					{#if i % every === 0}
						<text x={mid(b)} y={VIEW_H - 6} text-anchor="middle" class="fill-muted-foreground" font-size="9">{label(b)}</text>
					{/if}
				{/each}
				{#each model.lines as l (l.group)}
					<polyline
						fill="none"
						stroke={colorOf.get(l.group)}
						stroke-width={!isCount && selected === l.group ? 2.5 : 1.5}
						opacity={!isCount && selected && selected !== l.group ? 0.35 : 1}
						points={l.points.map((p) => `${mid(p.bucket)},${y(p.rate)}`).join(' ')}
					/>
					{#each l.points as p (p.bucket)}
						<circle cx={mid(p.bucket)} cy={y(p.rate)} r="2" fill={colorOf.get(l.group)}>
							<title>{isCount ? l.group : labelOf(l.group)}: {fmt(p.rate)}</title>
						</circle>
					{/each}
				{/each}
				{#each model.markers as m, i (m.ts)}
					<line
						x1={x(m.ts)}
						x2={x(m.ts)}
						y1={PAD.top}
						y2={PAD.top + plotH}
						stroke="#0ea5e9"
						stroke-dasharray="3 3"
						stroke-width={hoveredMarker === i ? 2 : 1}
						data-testid="change-marker"
					/>
					<rect
						x={x(m.ts) - 5}
						y={PAD.top}
						width="10"
						height={plotH}
						fill="transparent"
						role="presentation"
						onpointerenter={() => (hoveredMarker = i)}
						onpointerleave={() => (hoveredMarker = null)}
					/>
				{/each}
			</svg>
			{#if marker}
				<div
					class="pointer-events-none absolute top-1 z-10 w-max max-w-[24rem] -translate-x-1/2 rounded-md border bg-background/95 p-2 text-[11px] shadow-md"
					style={`left:${Math.min(80, Math.max(20, (x(marker.ts) / VIEW_W) * 100))}%`}
					data-testid="marker-tooltip"
				>
					<div class="mb-1 font-medium text-muted-foreground">{new Date(marker.ts).toLocaleString()}</div>
					{#each marker.events as e (e.id)}
						<div><span class="font-mono text-[10px] text-sky-600 dark:text-sky-400">{e.kind}</span> {e.sentence}</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
