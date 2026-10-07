<script lang="ts">
	import type { BehaviourChartOption, BehaviourMarker, BehaviourRateDefinition, BehaviourSeriesPoint } from '$lib/schemas';
	import { buildBehaviourChart, chartX, type BehaviourChartPoint, emptyChartReason, formatCount, formatRate } from '$lib/model-behaviour-view';
	import { niceTicks } from '$lib/spend-chart';
	import { cn } from '$lib/utils';

	// Over time (spec REFUSAL-HANDLING §12.3 §2, §12.4): the selected metric, one
	// line per group (a rate) or per key (a keyed family's counts, e.g. failure
	// types), with change markers (a deploy's changes collapse into one marker;
	// hovering lists them). Inline SVG with a real y axis, like the usage page's
	// spend chart; no charting dependency. An empty metric says why it is empty.
	//
	// Readability rules: drawn at the container's pixel width (text never scales);
	// a line never bridges a bucket without data; a bucket below the rate's
	// minSample is a hollow dot (the scorecard greys the same cells); the selected
	// or legend-hovered group is drawn in color over grey context lines; change
	// markers are ticks in a band above the plot, not full-height rules; hovering
	// the plot reads every group's value and sample at that bucket.
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
	const nameOf = (g: string) => (isCount ? g : labelOf(g));

	/** Categorical slots (validated light and dark, see the style block); past 8 a group is grey. */
	const SLOTS = 8;
	const HEIGHT = 240;
	const BAND = 14; // the change-marker band above the plot
	const PAD = { top: BAND + 6, right: 16, bottom: 24, left: 52 };

	let width = $state(760);
	const plotW = $derived(Math.max(100, width - PAD.left - PAD.right));
	const plotH = HEIGHT - PAD.top - PAD.bottom;

	const model = $derived(buildBehaviourChart(points, since, until, bucketMs, markers, isCount ? 0 : (rate?.minSample ?? 0)));
	// Color slots go to the groups with the most volume (denominator, or count for a
	// keyed family) in the window; the tail past the eighth slot is grey. The
	// legend lists groups in the same order.
	const byVolume = $derived(
		[...model.lines].sort(
			(a, b) =>
				b.points.reduce((n, p) => n + (isCount ? p.rate : p.denominator), 0) -
				a.points.reduce((n, p) => n + (isCount ? p.rate : p.denominator), 0)
		)
	);
	const colorOf = $derived(new Map(byVolume.map((l, i) => [l.group, i < SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)'])));

	let hidden = $state<ReadonlySet<string>>(new Set());
	let legendHover = $state<string | null>(null);
	let hoveredMarker = $state<number | null>(null);
	let hoverBucket = $state<number | null>(null);

	const visible = $derived(model.lines.filter((l) => !hidden.has(l.group)));
	const focus = $derived(legendHover ?? (!isCount && selected && model.lines.some((l) => l.group === selected) ? selected : null));
	// Context lines first, the focused one last (on top).
	const drawOrder = $derived([...visible].sort((a, b) => Number(a.group === focus) - Number(b.group === focus)));
	const axis = $derived(niceTicks(Math.max(0, ...visible.flatMap((l) => l.points.map((p) => p.rate))), 4));
	const hasLow = $derived(visible.some((l) => l.points.some((p) => p.low)));

	const x = (t: number) => PAD.left + chartX(model, t, bucketMs) * plotW;
	const y = (v: number) => PAD.top + plotH - (axis.niceMax > 0 ? (v / axis.niceMax) * plotH : 0);
	const mid = (bucket: number) => x(bucket + bucketMs / 2);
	// Day and week buckets are UTC days on the server; label them as such.
	const daily = $derived(bucketMs >= 86_400_000);
	const bucketWord = $derived(daily ? (bucketMs > 86_400_000 ? 'week' : 'UTC day') : 'hour');
	function label(bucket: number): string {
		const d = new Date(bucket);
		return daily
			? d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
			: d.toLocaleTimeString([], { hour: '2-digit' });
	}
	function longLabel(bucket: number): string {
		const d = new Date(bucket);
		return daily
			? `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}${bucketMs > 86_400_000 ? ' (week)' : ''} UTC`
			: d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
	const every = $derived(Math.max(1, Math.ceil(model.buckets.length / Math.max(2, Math.floor(plotW / 72)))));
	const marker = $derived(hoveredMarker != null ? model.markers[hoveredMarker] : undefined);

	const strokeOf = (g: string) => (focus && focus !== g ? 'var(--series-context)' : colorOf.get(g));
	const path = (run: readonly { bucket: number; rate: number }[]) =>
		run.map((p, i) => `${i === 0 ? 'M' : 'L'}${mid(p.bucket).toFixed(1)},${y(p.rate).toFixed(1)}`).join('');
	/** A run cut into stretches of equal confidence: a segment touching a small-sample point is weak (drawn dashed). */
	function stretches(run: readonly BehaviourChartPoint[]): Array<{ pts: BehaviourChartPoint[]; weak: boolean }> {
		const out: Array<{ pts: BehaviourChartPoint[]; weak: boolean }> = [];
		for (let i = 1; i < run.length; i++) {
			const a = run[i - 1]!;
			const b = run[i]!;
			const weak = a.low || b.low;
			const last = out.at(-1);
			if (last && last.weak === weak) last.pts.push(b);
			else out.push({ pts: [a, b], weak });
		}
		return out;
	}

	// The crosshair readout: every visible group's value at the hovered bucket.
	const readout = $derived.by(() => {
		if (hoverBucket == null) return [];
		return visible
			.flatMap((l) => {
				const p = l.points.find((q) => q.bucket === hoverBucket);
				return p ? [{ group: l.group, p }] : [];
			})
			.sort((a, b) => b.p.rate - a.p.rate);
	});

	function onPlotMove(e: PointerEvent) {
		const svg = (e.currentTarget as SVGElement).ownerSVGElement;
		if (!svg || model.buckets.length === 0) return;
		const px = e.clientX - svg.getBoundingClientRect().left;
		const i = Math.floor(((px - PAD.left) / plotW) * model.buckets.length);
		hoverBucket = model.buckets[Math.max(0, Math.min(model.buckets.length - 1, i))] ?? null;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		const i = hoverBucket == null ? model.buckets.length - 1 : model.buckets.indexOf(hoverBucket) + (e.key === 'ArrowLeft' ? -1 : 1);
		hoverBucket = model.buckets[Math.max(0, Math.min(model.buckets.length - 1, i))] ?? null;
	}
	function toggle(group: string) {
		const next = new Set(hidden);
		if (!next.delete(group)) next.add(group);
		hidden = next;
	}
	// The focused group's last value, labelled at the line's end (the one direct label).
	const endLabel = $derived.by(() => {
		const l = focus ? visible.find((v) => v.group === focus) : visible.length === 1 ? visible[0] : undefined;
		const p = l?.points.at(-1);
		return l && p ? { group: l.group, p } : undefined;
	});
	const tipLeft = $derived(hoverBucket == null ? 0 : (mid(hoverBucket) / width) * 100);
</script>

{#if model.lines.length === 0}
	<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="chart-empty">
		<span class="font-medium text-foreground">{title}</span>{#if scope}<span> · {scope}</span>{/if}:
		{emptyChartReason(option, denominatorName)}
		{#if model.markers.length > 0}({model.markers.length} change {model.markers.length === 1 ? 'marker' : 'markers'}){/if}
	</div>
{:else}
	<div class="viz rounded-lg border p-3">
		<div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
			<span class="font-semibold text-foreground">{title}</span>
			{#if scope}<span class="text-muted-foreground">{scope}</span>{/if}
			{#if option && option.kind === 'rate' && option.count === 0}
				<span class="text-muted-foreground italic" data-testid="chart-none-recorded">{emptyChartReason(option, denominatorName)}</span>
			{/if}
			<span class="text-[10px] text-muted-foreground">
				{[
					`per ${bucketWord}`,
					hasLow ? `hollow dot, dashed line = fewer than ${rate?.minSample} ${denominatorName} in the ${bucketWord}` : null,
					model.markers.length > 0 ? '▾ = a change (hover it)' : null
				]
					.filter(Boolean)
					.join(' · ')}
			</span>
		</div>
		<div class="mb-1 flex flex-wrap gap-1 text-[11px]" role="group" aria-label="series">
			{#each byVolume as l (l.group)}
				<button
					type="button"
					class={cn(
						'flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono hover:bg-muted',
						hidden.has(l.group) && 'line-through opacity-40',
						focus && focus !== l.group && !hidden.has(l.group) && 'text-muted-foreground'
					)}
					aria-pressed={!hidden.has(l.group)}
					title="hover to highlight, click to hide or show"
					onpointerenter={() => (legendHover = l.group)}
					onpointerleave={() => (legendHover = null)}
					onfocus={() => (legendHover = l.group)}
					onblur={() => (legendHover = null)}
					onclick={() => toggle(l.group)}
				>
					<span class="inline-block h-0.5 w-3 rounded-full" style={`background:${colorOf.get(l.group)}`}></span>{nameOf(l.group)}
				</button>
			{/each}
		</div>
		<!-- Focusable so the arrow keys read the same per-bucket table hover shows. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="relative outline-none focus-visible:ring-2 focus-visible:ring-ring"
			bind:clientWidth={width}
			tabindex="0"
			role="figure"
			aria-label={`${title} over time; arrow keys read each bucket`}
			onkeydown={onKey}
			onblur={() => (hoverBucket = null)}
		>
			<svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} class="block" role="img" aria-label="Behaviour over time" data-testid="behaviour-chart">
				{#each axis.ticks as t (t)}
					<line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} class={t === 0 ? 'stroke-muted-foreground/40' : 'stroke-border'} stroke-width="1" />
					<text x={PAD.left - 8} y={y(t) + 3.5} text-anchor="end" class="fill-muted-foreground tabular-nums" font-size="11">{fmt(t)}</text>
				{/each}
				{#each model.buckets as b, i (b)}
					{#if i % every === 0}
						<text x={mid(b)} y={HEIGHT - 6} text-anchor="middle" class="fill-muted-foreground" font-size="11">{label(b)}</text>
					{/if}
				{/each}

				{#each model.markers as m, i (m.ts)}
					<line
						x1={x(m.ts)}
						x2={x(m.ts)}
						y1={PAD.top}
						y2={PAD.top + plotH}
						class="stroke-muted-foreground"
						stroke-width="1"
						opacity={hoveredMarker === i ? 0.6 : 0.12}
					/>
					<path
						d={`M${x(m.ts) - 4},${BAND - 8}L${x(m.ts) + 4},${BAND - 8}L${x(m.ts)},${BAND - 1}Z`}
						class={hoveredMarker === i ? 'fill-foreground' : 'fill-muted-foreground'}
						data-testid="change-marker"
					/>
				{/each}

				{#if hoverBucket != null}
					<line x1={mid(hoverBucket)} x2={mid(hoverBucket)} y1={PAD.top} y2={PAD.top + plotH} class="stroke-muted-foreground/60" stroke-width="1" />
				{/if}

				{#each drawOrder as l (l.group)}
					{@const stroke = strokeOf(l.group)}
					{@const emphasized = focus === l.group}
					<g data-testid="series" data-group={l.group}>
						{#each l.runs.flatMap(stretches) as st, si (si)}
							<path
								d={path(st.pts)}
								fill="none"
								{stroke}
								stroke-width={emphasized ? 2.5 : focus ? 1.25 : st.weak ? 1.5 : 2}
								stroke-dasharray={st.weak ? '4 4' : undefined}
								opacity={st.weak ? 0.7 : 1}
								stroke-linejoin="round"
								stroke-linecap="round"
								data-testid="series-line"
							/>
						{/each}
						{#each l.points as p (p.bucket)}
							<circle
								cx={mid(p.bucket)}
								cy={y(p.rate)}
								r={hoverBucket === p.bucket ? 4.5 : focus && !emphasized ? 2.5 : 3.5}
								fill={p.low ? 'var(--background)' : stroke}
								stroke={p.low ? stroke : 'var(--background)'}
								stroke-width={p.low ? 1.5 : 2}
							/>
						{/each}
					</g>
				{/each}

				{#if endLabel}
					{@const ex = mid(endLabel.p.bucket)}
					<text
						x={ex > PAD.left + plotW - 40 ? ex - 8 : ex + 8}
						y={y(endLabel.p.rate) - 8}
						text-anchor={ex > PAD.left + plotW - 40 ? 'end' : 'start'}
						class="fill-foreground font-medium tabular-nums"
						font-size="11"
						paint-order="stroke"
						stroke="var(--background)"
						stroke-width="3">{fmt(endLabel.p.rate)}</text
					>
				{/if}

				<!-- Crosshair hit area (the plot), then the marker band's hit areas on top of it. -->
				<rect
					x={PAD.left}
					y={PAD.top}
					width={plotW}
					height={plotH}
					fill="transparent"
					aria-hidden="true"
					onpointermove={onPlotMove}
					onpointerleave={() => (hoverBucket = null)}
				/>
				{#each model.markers as m, i (m.ts)}
					<rect
						x={x(m.ts) - 7}
						y="0"
						width="14"
						height={BAND + 2}
						fill="transparent"
						role="presentation"
						onpointerenter={() => (hoveredMarker = i)}
						onpointerleave={() => (hoveredMarker = null)}
					/>
				{/each}
			</svg>

			{#if marker}
				<div
					class="pointer-events-none absolute top-4 z-20 w-max max-w-[24rem] -translate-x-1/2 rounded-md border bg-background/95 p-2 text-[11px] shadow-md"
					style={`left:${Math.min(80, Math.max(20, (x(marker.ts) / width) * 100))}%`}
					data-testid="marker-tooltip"
				>
					<div class="mb-1 font-medium text-muted-foreground">{new Date(marker.ts).toLocaleString()}</div>
					{#each marker.events as e (e.id)}
						<div><span class="font-mono text-[10px] text-sky-600 dark:text-sky-400">{e.kind}</span> {e.sentence}</div>
					{/each}
				</div>
			{:else if hoverBucket != null}
				<div
					class={cn(
						'pointer-events-none absolute z-10 w-max max-w-[22rem] rounded-md border bg-background/95 p-2 text-[11px] shadow-md',
						tipLeft > 55 ? '-translate-x-full -ml-3' : 'ml-3'
					)}
					style={`left:${tipLeft}%; top:${PAD.top}px`}
					data-testid="chart-tooltip"
				>
					<div class="mb-1 font-medium text-muted-foreground">{longLabel(hoverBucket)}</div>
					{#if readout.length === 0}
						<div class="text-muted-foreground italic">no data in this bucket</div>
					{:else}
						<table class="tabular-nums">
							<tbody>
								{#each readout as r (r.group)}
									<tr class={cn(focus && focus !== r.group && 'text-muted-foreground')}>
										<td class="pr-2"><span class="inline-block h-0.5 w-3 rounded-full align-middle" style={`background:${colorOf.get(r.group)}`}></span></td>
										<td class="pr-3 font-mono">{nameOf(r.group)}</td>
										<td class="pr-2 text-right font-medium">{fmt(r.p.rate)}</td>
										{#if !isCount}
											<td class={cn('text-right text-muted-foreground', r.p.low && 'italic')}>
												{formatCount(r.p.count)} / {formatCount(r.p.denominator)}{r.p.low ? ' · small sample' : ''}
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Categorical slots: the dataviz reference palette, validated on this
	   console's surfaces (light #fff, dark zinc-950): adjacent CVD ΔE ≥ 8.4,
	   normal-vision ΔE ≥ 19.3. Light slots 3–5 are under 3:1 contrast, so
	   values stay readable through the hover table and the scorecard. */
	.viz {
		--series-1: #2a78d6;
		--series-2: #eb6834;
		--series-3: #1baf7a;
		--series-4: #eda100;
		--series-5: #e87ba4;
		--series-6: #008300;
		--series-7: #4a3aa7;
		--series-8: #e34948;
		--series-other: #8a8a93;
		--series-context: #c4c4cc;
	}
	:global(.dark) .viz {
		--series-1: #3987e5;
		--series-2: #d95926;
		--series-3: #199e70;
		--series-4: #c98500;
		--series-5: #d55181;
		--series-6: #008300;
		--series-7: #9085e9;
		--series-8: #e66767;
		--series-other: #71717a;
		--series-context: #3f3f46;
	}
</style>
