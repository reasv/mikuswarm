<script lang="ts">
	import type { BehaviourMixTable } from '$lib/schemas';
	import { cn } from '$lib/utils';

	// Mix per group: each keyed family as a table, one row per scorecard group
	// (model, family, agent…), one column per key: how sends failed (failure types,
	// including the offline audit's self_talk and textual tool calls), what
	// happened to the message after a correction, why a nudged run ended with
	// no_reply, and why judged refusals refused (live gate and offline audit).
	// A cell shows the count and its share of the row; a family with nothing
	// recorded says so.
	let {
		tables,
		selected,
		labelOf = (g: string) => g || '(unknown)',
		onChart
	}: {
		tables: readonly BehaviourMixTable[];
		selected: string | null;
		labelOf?: (group: string) => string;
		/** Plot this family over time. */
		onChart?: (family: string) => void;
	} = $props();

	const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '');
</script>

<div class="grid grid-cols-1 gap-2 xl:grid-cols-2" data-testid="behaviour-mix">
	{#each tables as t (t.id)}
		{@const rows = t.rows.filter((r) => r.total > 0)}
		<section class="rounded-lg border p-2" data-testid={`mix-${t.id}`}>
			<div class="mb-1 flex items-center justify-between gap-2">
				<h3 class="text-xs font-semibold">{t.label}</h3>
				{#if onChart && t.keys.length > 0}
					<button type="button" class="text-[10px] text-sky-600 hover:underline dark:text-sky-400" onclick={() => onChart(t.id)}>
						over time
					</button>
				{/if}
			</div>
			{#if t.keys.length === 0}
				<div class="text-[11px] text-muted-foreground italic" data-testid="mix-empty">none recorded in this window</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-[11px]">
						<thead>
							<tr class="border-b text-left text-[10px] text-muted-foreground">
								<th class="px-1 py-1 font-medium">group</th>
								<th class="px-1 py-1 text-right font-medium">total</th>
								{#each t.keys as k (k)}<th class="px-1 py-1 text-right font-mono font-medium">{k}</th>{/each}
							</tr>
						</thead>
						<tbody>
							{#each rows as r (r.group)}
								<tr class={cn('border-b last:border-0', r.group === selected && 'bg-sky-500/10')}>
									<td class="px-1 py-0.5 font-mono">{labelOf(r.group)}</td>
									<td class="px-1 py-0.5 text-right font-mono tabular-nums">{r.total}</td>
									{#each t.keys as k (k)}
										{@const n = r.counts[k] ?? 0}
										<td class="px-1 py-0.5 text-right font-mono tabular-nums" title={`${n} of ${r.total}`}>
											{#if n > 0}{n} <span class="text-[9px] text-muted-foreground">{pct(n, r.total)}</span>{:else}<span class="text-muted-foreground">·</span>{/if}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/each}
</div>
