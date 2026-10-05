<script lang="ts">
	import type { BehaviourRateDefinition, BehaviourScorecardRow } from '$lib/schemas';
	import { formatChange, formatRate } from '$lib/model-behaviour-view';
	import { cn } from '$lib/utils';

	// Scorecard (spec REFUSAL-HANDLING §12.3 §1): one row per group, one column per
	// headline rate, each with its raw count, the change against the previous
	// window, greyed when the sample is too small. Clicking a cell selects that
	// group and metric for the chart, breakdown and incident log.
	let {
		rates,
		rows,
		selected,
		metric,
		onSelect
	}: {
		rates: readonly BehaviourRateDefinition[];
		rows: readonly BehaviourScorecardRow[];
		selected: string | null;
		metric: string;
		onSelect: (group: string, metric: string) => void;
	} = $props();
</script>

{#if rows.length === 0}
	<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="scorecard-empty">
		No model activity in this window.
	</div>
{:else}
	<div class="overflow-x-auto rounded-lg border">
		<table class="w-full text-xs" data-testid="scorecard">
			<thead>
				<tr class="border-b bg-muted/40 text-left text-[10px] tracking-wide text-muted-foreground uppercase">
					<th class="px-2 py-1.5 font-medium">group</th>
					<th class="px-2 py-1.5 text-right font-medium" title="requests · sessions">volume</th>
					{#each rates as r (r.id)}
						<th
							class={cn('px-2 py-1.5 text-right font-medium', r.id === metric && 'text-foreground')}
							title={`${r.numerator.join(' + ')} / ${r.denominator}${r.scale !== 1 ? ` × ${r.scale}` : ''}; greyed under ${r.minSample}`}
						>
							{r.label}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.group)}
					<tr class={cn('border-b last:border-0', row.group === selected && 'bg-sky-500/10')}>
						<td class="px-2 py-1 font-mono" title={row.members.length > 0 ? row.members.join(', ') : undefined}>
							{row.group || '(unknown)'}
							{#if row.members.length > 1}<span class="text-[10px] text-muted-foreground"> ×{row.members.length}</span>{/if}
						</td>
						<td class="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
							{row.volume.requests} req · {row.volume.sessions} ses
						</td>
						{#each rates as r (r.id)}
							{@const cell = row.cells[r.id]}
							{@const change = cell ? formatChange(cell, r) : null}
							<td class="p-0 text-right">
								<button
									type="button"
									data-testid={`cell-${row.group}-${r.id}`}
									class={cn(
										'flex w-full flex-col items-end px-2 py-1 hover:bg-muted/60',
										row.group === selected && r.id === metric && 'ring-1 ring-sky-500 ring-inset',
										cell?.lowSample && 'opacity-40'
									)}
									title={cell
										? `${cell.count} / ${cell.denominator}${cell.lowSample ? ` (fewer than ${r.minSample}: low sample)` : ''}${cell.previousRate != null ? `; previous ${formatRate(cell.previousRate, r)}` : ''}`
										: undefined}
									onclick={() => onSelect(row.group, r.id)}
								>
									<span class="font-mono tabular-nums">{cell ? formatRate(cell.rate, r) : '—'}</span>
									<span class="flex gap-1 font-mono text-[9px] text-muted-foreground tabular-nums">
										<span>{cell?.count ?? 0}</span>
										{#if change && change.direction !== 'none'}
											<span
												class={cn(
													change.direction === 'up' && 'text-red-500',
													change.direction === 'down' && 'text-emerald-500'
												)}>{change.text}</span
											>
										{/if}
									</span>
								</button>
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
