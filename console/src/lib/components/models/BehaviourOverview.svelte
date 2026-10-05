<script lang="ts">
	import type { BehaviourOverviewMetric, BehaviourRateDefinition } from '$lib/schemas';
	import { formatRate } from '$lib/model-behaviour-view';
	import { cn } from '$lib/utils';

	// Overview (the default chart): every headline rate over the window, all
	// groups combined, as small multiples. A rate with nothing recorded says so
	// ("none: 0 of 412 requests"; "no sessions" when there is no denominator)
	// instead of disappearing. Clicking one plots it per group below.
	let {
		rates,
		metrics,
		since,
		until,
		bucketMs,
		onPick
	}: {
		rates: readonly BehaviourRateDefinition[];
		metrics: readonly BehaviourOverviewMetric[];
		since: number;
		until: number;
		bucketMs: number;
		onPick: (metric: string) => void;
	} = $props();

	const W = 160;
	const H = 36;
	const byId = $derived(new Map(metrics.map((m) => [m.id, m])));
	const first = $derived(Math.floor(since / Math.max(1, bucketMs)) * bucketMs);
	const span = $derived(Math.max(1, until - first));

	function path(m: BehaviourOverviewMetric): string {
		const pts = m.points.filter((p) => p.rate != null);
		const max = Math.max(...pts.map((p) => p.rate ?? 0), 0);
		return pts
			.map((p) => {
				const x = ((p.bucket + bucketMs / 2 - first) / span) * W;
				const y = H - 2 - (max > 0 ? ((p.rate ?? 0) / max) * (H - 4) : 0);
				return `${Math.max(0, Math.min(W, x)).toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	}
</script>

<div class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4" data-testid="behaviour-overview">
	{#each rates as r (r.id)}
		{@const m = byId.get(r.id)}
		{@const empty = !m || m.count === 0}
		<button
			type="button"
			class={cn('flex flex-col items-stretch rounded-lg border p-2 text-left hover:bg-muted/50', empty && 'border-dashed')}
			data-testid={`overview-${r.id}`}
			onclick={() => onPick(r.id)}
		>
			<span class="text-[10px] tracking-wide text-muted-foreground uppercase">{r.label}</span>
			{#if !m || m.denominator === 0}
				<span class="mt-1 text-[11px] text-muted-foreground italic">no {r.denominator.replace(/_/g, ' ')} in this window</span>
			{:else if m.count === 0}
				<span class="mt-1 font-mono text-xs">{formatRate(0, r)}</span>
				<span class="text-[10px] text-muted-foreground italic">none recorded: 0 of {m.denominator} {r.denominator.replace(/_/g, ' ')}</span>
			{:else}
				<span class="mt-1 font-mono text-xs">
					{formatRate(m.rate, r)}
					<span class="text-[10px] text-muted-foreground">{m.count} / {m.denominator}</span>
				</span>
				<svg viewBox={`0 0 ${W} ${H}`} class="mt-1 h-9 w-full" aria-hidden="true">
					<polyline fill="none" stroke="#6366f1" stroke-width="1.5" points={path(m)} />
				</svg>
			{/if}
		</button>
	{/each}
</div>
