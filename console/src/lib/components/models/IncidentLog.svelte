<script lang="ts">
	import type { BehaviourIncidentRow } from '$lib/schemas';
	import { INCIDENT_TYPES, INCIDENT_TYPE_LABELS, incidentHref } from '$lib/model-behaviour-view';
	import { cn } from '$lib/utils';

	// Incident log (spec REFUSAL-HANDLING §12.3 §4): newest first, one row per
	// session (its refusals, nudges, redos, revisions and judged endings grouped),
	// each linking to the session at the branch and tool call where it happened.
	// Filterable by type (the buttons are worded like the chips they select on; the
	// server narrows its session walk to that type); cursor-paginated ("load more"
	// appends the next page, also after a page that found nothing yet).
	let {
		rows,
		hasMore,
		loadingMore = false,
		type,
		onType,
		onLoadMore,
		labelOf = (m: string) => m
	}: {
		rows: readonly BehaviourIncidentRow[];
		hasMore: boolean;
		loadingMore?: boolean;
		type: string | null;
		onType: (type: string | null) => void;
		onLoadMore: () => void;
		/** A model's display name (the label switch). */
		labelOf?: (model: string) => string;
	} = $props();
	const CHIP_OF_TYPE: Record<string, Array<keyof BehaviourIncidentRow['chips']>> = {
		refusal: ['refused'],
		nudge: ['nudged'],
		redo: ['redone'],
		revision: ['revised', 'overridden'],
		ending: ['endings']
	};

	const CHIP_LABELS: Array<[keyof BehaviourIncidentRow['chips'], string]> = [
		['refused', 'refused'],
		['redone', 'redone'],
		['nudged', 'nudged'],
		['revised', 'revised'],
		['overridden', 'overridden'],
		['endings', 'endings']
	];
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-center gap-1 text-[11px]" role="group" aria-label="incident type">
		<button
			type="button"
			class={cn('rounded px-2 py-0.5', type === null ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
			onclick={() => onType(null)}>all</button
		>
		{#each INCIDENT_TYPES as t (t)}
			<button
				type="button"
				aria-pressed={type === t}
				data-testid={`incident-type-${t}`}
				class={cn('rounded px-2 py-0.5', type === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
				onclick={() => onType(type === t ? null : t)}>{INCIDENT_TYPE_LABELS[t]}</button
			>
		{/each}
	</div>
	{#if rows.length === 0}
		<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="incidents-empty">
			{#if type}
				No {INCIDENT_TYPE_LABELS[type as keyof typeof INCIDENT_TYPE_LABELS] ?? type} incidents {hasMore ? 'among the sessions looked at so far' : 'in this window'}.
			{:else}
				No incidents {hasMore ? 'among the sessions looked at so far' : 'in this window'}.
			{/if}
		</div>
		{#if hasMore}
			<button
				type="button"
				class="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
				disabled={loadingMore}
				onclick={onLoadMore}>{loadingMore ? 'Loading…' : 'Look further back'}</button
			>
		{/if}
	{:else}
		<div class="overflow-x-auto rounded-lg border">
			<table class="w-full text-xs" data-testid="incidents">
				<thead>
					<tr class="border-b bg-muted/40 text-left text-[10px] tracking-wide text-muted-foreground uppercase">
						<th class="px-2 py-1.5 font-medium">time</th>
						<th class="px-2 py-1.5 font-medium">agent</th>
						<th class="px-2 py-1.5 font-medium">room</th>
						<th class="px-2 py-1.5 font-medium">site</th>
						<th class="px-2 py-1.5 font-medium">model</th>
						<th class="px-2 py-1.5 font-medium"></th>
						<th class="px-2 py-1.5 font-medium">outcome</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.sessionId)}
						<tr class="border-b align-top last:border-0">
							<td class="px-2 py-1 font-mono text-[10px] whitespace-nowrap text-muted-foreground">
								<a class="text-sky-600 hover:underline dark:text-sky-400" href={incidentHref(row)}>
									{new Date(row.ts).toLocaleString()}
								</a>
							</td>
							<td class="px-2 py-1 font-mono text-[10px]">{row.agent ?? '—'}</td>
							<td class="max-w-[12rem] truncate px-2 py-1" title={row.timelineKey}>{row.roomLabel}</td>
							<td class="px-2 py-1 font-mono text-[10px]">{row.site}</td>
							<td class="px-2 py-1 font-mono text-[10px]">{row.models.map(labelOf).join(', ') || '—'}</td>
							<td class="px-2 py-1">
								<span class="flex flex-wrap gap-1">
									{#each CHIP_LABELS as [key, label] (key)}
										{#if row.chips[key] > 0}
											<span
												class={cn(
													'rounded bg-muted px-1 font-mono text-[9px]',
													type && CHIP_OF_TYPE[type]?.includes(key) && 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
												)}>{label} {row.chips[key]}</span
											>
										{/if}
									{/each}
								</span>
							</td>
							<td class="px-2 py-1 text-[11px]">{row.outcome}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if hasMore}
			<button
				type="button"
				class="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
				disabled={loadingMore}
				onclick={onLoadMore}>{loadingMore ? 'Loading…' : 'Load more'}</button
			>
		{/if}
	{/if}
</div>
