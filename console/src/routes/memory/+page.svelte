<script lang="ts">
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import { FILTER_HITS_LIMIT, memoryFilterHitsQuery, memoryStatsQuery } from '$lib/query/memory';
	import {
		formatRate,
		groupFilterHits,
		hitCitation,
		hitMatchLabel,
		sourceMix
	} from '$lib/memory-retrieval';

	// Memory page (spec MEMORY-RETRIEVAL §7.4, §9): the follow-up rate and the
	// source mix of recent auto-retrieval builds, and the filters audit (every
	// block a memory filter has hidden, from `memory_filter_hits`). The console
	// reads what the tables hold, not the config: a filter that never hid
	// anything does not appear. Empty on an older backend.
	const stats = memoryStatsQuery();
	const hitsQ = memoryFilterHitsQuery();

	const windows = $derived(stats.data?.windows ?? []);
	const hits = $derived(hitsQ.data?.hits ?? []);
	const groups = $derived(groupFilterHits(hits));

	const SOURCE_CLASSES: Record<string, string> = {
		model: 'bg-sky-500',
		fallback: 'bg-amber-500',
		unjudged: 'bg-amber-300',
		none: 'bg-muted-foreground/40'
	};

	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleString();
	}
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
		<section class="space-y-2">
			<h2 class="text-sm font-semibold">Follow-up rate</h2>
			<p class="text-xs text-muted-foreground">
				Sessions shown at least one memory that then opened a cited entry or searched memory.
			</p>
			{#if stats.isPending}
				<div class="text-sm text-muted-foreground">loading…</div>
			{:else if windows.length === 0}
				<div class="text-sm text-muted-foreground">No retrieval data.</div>
			{:else}
				<div class="grid gap-3 sm:grid-cols-2" data-testid="memory-stats">
					{#each windows as w (w.days)}
						{@const mix = sourceMix(w)}
						<div class="space-y-2 rounded-md border p-3">
							<div class="flex items-baseline justify-between">
								<span class="text-xs text-muted-foreground">last {w.days} days</span>
								<span class="font-mono text-lg font-semibold tabular-nums">{formatRate(w.rate)}</span>
							</div>
							<div class="font-mono text-[11px] text-muted-foreground tabular-nums">
								{w.followedUp} of {w.sessionsWithBlock} sessions · {w.builds} builds
							</div>
							<div>
								<div class="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">Source mix</div>
								{#if w.builds > 0}
									<div class="flex h-2 overflow-hidden rounded bg-muted">
										{#each mix as m (m.source)}
											{#if m.count > 0}
												<div
													class={SOURCE_CLASSES[m.source] ?? 'bg-violet-400'}
													style="width: {((m.share ?? 0) * 100).toFixed(2)}%"
													title={`${m.source} ${m.count}`}
												></div>
											{/if}
										{/each}
									</div>
								{/if}
								<div class="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] tabular-nums">
									{#each mix as m (m.source)}
										<span class="flex items-center gap-1">
											<span class="inline-block size-2 rounded-sm {SOURCE_CLASSES[m.source] ?? 'bg-violet-400'}"></span>
											{m.source}
											<span class="text-muted-foreground">{m.count}{m.share != null ? ` (${formatRate(m.share)})` : ''}</span>
										</span>
									{/each}
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<section class="space-y-2">
			<h2 class="text-sm font-semibold">Filters</h2>
			<p class="text-xs text-muted-foreground">
				Blocks each memory filter has hidden. Filters that never hid anything are not listed.
			</p>
			{#if hitsQ.isPending}
				<div class="text-sm text-muted-foreground">loading…</div>
			{:else if groups.length === 0}
				<div class="text-sm text-muted-foreground">No filter has hidden anything.</div>
			{:else}
				{#if hits.length >= FILTER_HITS_LIMIT}
					<div class="text-xs text-muted-foreground">Showing the {FILTER_HITS_LIMIT} most recent hits.</div>
				{/if}
				{#each groups as g (g.filterKey)}
					<details open class="rounded-md border" data-testid="memory-filter">
						<summary class="flex cursor-pointer flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-sm">
							<span class="font-mono font-medium">{g.filterKey}</span>
							<span class="text-xs text-muted-foreground">{g.kinds.join(', ')}</span>
							<span class="font-mono text-xs text-muted-foreground tabular-nums"
								>{g.blocks} {g.blocks === 1 ? 'block' : 'blocks'} · hidden {g.hides}×</span
							>
							{#if g.versions > 1}
								<span class="text-xs text-muted-foreground" title="the filter was edited">{g.versions} versions</span>
							{/if}
							<span class="text-xs text-muted-foreground">last {fmtTime(g.lastHiddenAt)}</span>
						</summary>
						<div class="overflow-x-auto border-t">
							<table class="w-full text-xs">
								<thead class="text-left text-muted-foreground">
									<tr class="border-b">
										<th class="px-3 py-1 font-medium">citation</th>
										<th class="px-3 py-1 font-medium">match</th>
										<th class="px-3 py-1 font-medium">surface</th>
										<th class="px-3 py-1 font-medium">agent</th>
										<th class="px-3 py-1 font-medium">first hidden</th>
										<th class="px-3 py-1 font-medium">last hidden</th>
										<th class="px-3 py-1 text-right font-medium">count</th>
									</tr>
								</thead>
								<tbody>
									{#each g.hits as h (`${h.agent}:${h.contentHash}`)}
										<tr class="border-b last:border-b-0">
											<td class="px-3 py-1 font-mono">{hitCitation(h)}</td>
											<td class="px-3 py-1 font-mono">
												<span class="text-muted-foreground">{h.kind}</span>
												{hitMatchLabel(h)}
											</td>
											<td class="px-3 py-1">{h.surface}</td>
											<td class="px-3 py-1 text-muted-foreground">{h.agent || '—'}</td>
											<td class="px-3 py-1 text-muted-foreground">{fmtTime(h.firstHiddenAt)}</td>
											<td class="px-3 py-1 text-muted-foreground">{fmtTime(h.lastHiddenAt)}</td>
											<td class="px-3 py-1 text-right font-mono tabular-nums">{h.hideCount}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</details>
				{/each}
			{/if}
		</section>
	</div>
</div>
