<script lang="ts">
	// Spend card body shared by the Usage & Cost page's **Total spend** card and each
	// per-user **leaderboard** card (spec USAGE-COST-LIMITS §7.1). A leaderboard card is
	// the per-user equivalent of the Total card: same big total + range note + sub-period
	// averages table, computed identically via `buildSpendAverages`. Passing `rank` flips
	// on the leaderboard chrome (rank badge, prominent name, share-of-total chip,
	// events/sessions in the subnote); without it the card renders exactly as the Total
	// card always did. The repeated averaging-basis footnote shows only on the Total card
	// (it explains the whole page once — repeating it under 10 user cards is noise).
	import { buildSpendAverages } from '$lib/spend-averages';
	import { fmtUsd, fmtUsdAvg, fmtInt, fmtElapsed, fmtPct } from '$lib/usage-format';
	import { cn } from '$lib/utils';
	import BotIcon from '@lucide/svelte/icons/bot';

	type SeriesPoint = { bucket: number; cost: number };

	let {
		label,
		total,
		firstTs,
		now,
		series,
		bucketMs,
		windowId,
		rank = undefined,
		shareOfTotal = undefined,
		events = undefined,
		sessions = undefined,
		titleAttr = undefined,
		system = false
	}: {
		/** Card heading — `Total spend`, or the user's display name. */
		label: string;
		total: number;
		/** Earliest event in the window for this scope (null = no spend) — the averaging anchor. */
		firstTs: number | null;
		/** Server `now` the window was computed against (averaging upper bound). */
		now: number;
		/** Per-bucket spend totals for this scope; re-binned into sub-periods for the averages. */
		series: readonly SeriesPoint[];
		bucketMs: number;
		windowId: string;
		/** 1-based leaderboard rank; presence switches the card into leaderboard mode. */
		rank?: number;
		/** Share of grand-total spend (0..1); rendered as a chip in leaderboard mode. */
		shareOfTotal?: number | null;
		events?: number;
		sessions?: number;
		/** Full-text tooltip for the (possibly truncated) label, e.g. the raw sender id. */
		titleAttr?: string;
		/**
		 * Non-human/self actor (Summarization / Diary / Proactive): renders a bot icon +
		 * muted violet accent so it's unmistakable, and reads `rank` as a *comparison* rank
		 * ("would be #N among users") rather than a leaderboard position.
		 */
		system?: boolean;
	} = $props();

	const isLeaderboard = $derived(rank != null);

	// Same per-sub-period averaging as the Total card. `buildSpendAverages` sums the
	// series by bucket (group-independent), so a constant `grp` is fine here.
	const averages = $derived(
		buildSpendAverages({
			total,
			firstTs,
			now,
			series: series.map((p) => ({ bucket: p.bucket, grp: '', cost: p.cost })),
			bucketMs,
			window: windowId
		})
	);

	const rangeNote = $derived(
		firstTs == null ? 'no spend in window' : `over ${fmtElapsed(now - firstTs)} of data`
	);

	// Subtle medal accents for the top three; the rest use the neutral muted chip.
	// System actors never get a medal — they use a distinct violet chip.
	function medalClass(r: number): string {
		if (system) return 'bg-violet-500/20 text-violet-600 dark:text-violet-300';
		if (r === 1) return 'bg-amber-500/20 text-amber-600 dark:text-amber-400';
		if (r === 2) return 'bg-slate-400/25 text-slate-600 dark:text-slate-300';
		if (r === 3) return 'bg-orange-700/20 text-orange-700 dark:text-orange-400';
		return 'bg-muted text-muted-foreground';
	}
</script>

<div class={cn('flex flex-col rounded-lg border p-3', system && 'border-violet-500/40 bg-violet-500/[0.03]')}>
	<div class="flex items-start justify-between gap-2">
		{#if isLeaderboard}
			<div class="flex min-w-0 items-center gap-1.5">
				<span
					class={cn(
						'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded px-1 font-mono text-[10px] font-semibold tabular-nums',
						medalClass(rank ?? 0)
					)}
					title={system ? `would rank #${rank} among users` : undefined}
				>
					{#if system}#{/if}{rank}
				</span>
				{#if system}
					<BotIcon class="size-3.5 shrink-0 text-violet-500" aria-label="system actor" />
				{/if}
				<span class="truncate text-sm font-medium text-foreground" title={titleAttr ?? label}>
					{label}
				</span>
			</div>
			{#if shareOfTotal != null}
				<span
					class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
					title="share of total spend in this window"
				>
					{fmtPct(shareOfTotal)}
				</span>
			{/if}
		{:else}
			<div class="text-xs text-muted-foreground">{label}</div>
		{/if}
	</div>

	<div class="mt-1 font-mono text-2xl font-semibold">{fmtUsd(total)}</div>
	<div
		class="mt-0.5 text-[10px] text-muted-foreground"
		title="averages divide by this elapsed range, not the nominal window"
	>
		{rangeNote}{#if events != null} · {fmtInt(events)} events{/if}{#if sessions != null} · {fmtInt(
				sessions
			)} sessions{/if}
	</div>

	<!-- Sub-period averages (spec §7.1 cards): per hour/day/week, with the min/max/σ spread
	     across full periods. Denominator = actual elapsed data range. -->
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
							<td class="py-0.5 pl-2 text-right font-semibold text-foreground">{fmtUsdAvg(s.avg)}</td>
							<td class="py-0.5 pl-2 text-right">{s.min == null ? '—' : fmtUsdAvg(s.min)}</td>
							<td class="py-0.5 pl-2 text-right">{s.max == null ? '—' : fmtUsdAvg(s.max)}</td>
							<td class="py-0.5 pl-2 text-right">{s.stdev == null ? '—' : fmtUsdAvg(s.stdev)}</td>
							<td class="py-0.5 pl-2 text-right text-muted-foreground">{s.n}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if !isLeaderboard}
				<div class="mt-1 text-[9px] leading-tight text-muted-foreground">
					avg = spend ÷ elapsed periods over the actual data range; min/max/σ across full periods
				</div>
			{/if}
		</div>
	{/if}
</div>
