<script lang="ts">
	import BrainIcon from '@lucide/svelte/icons/brain';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import {
		formatMs,
		groupReportItems,
		hiddenByLabel,
		judgeLabel,
		parseRetrievalReport,
		retrievalCountsLabel,
		scoresLabel,
		selectionLabel,
		stageLabel,
		stageTimings,
		type ReportItem
	} from '$lib/memory-retrieval';
	import { formatTokens } from '$lib/format';
	import type { DecisionEvaluation, MemoryRetrieval } from '$lib/schemas';
	import DecisionCard from './DecisionCard.svelte';

	// Inline memory retrieval card (spec MEMORY-RETRIEVAL §7.4, §9): one
	// auto-retrieval build. Collapsed: the source and reason, kept/candidates,
	// hidden, tokens, time and the follow-up. Expanded: stage timings and the
	// candidates grouped as kept, dropped, hidden ("hidden by <filter>") and cut,
	// then the build's raw `memory` decision rows.
	let {
		retrieval,
		/** The `memory` decision rows of this build's decision group (may be empty). */
		evaluations = [],
		elementId
	}: {
		retrieval: MemoryRetrieval;
		evaluations?: DecisionEvaluation[];
		elementId?: string;
	} = $props();

	let expanded = $state(false);

	const report = $derived(parseRetrievalReport(retrieval.reportJson));
	const groups = $derived(report ? groupReportItems(report.items) : null);
	const timings = $derived(report ? stageTimings(report) : []);
	const reason = $derived(report?.reason ?? null);

	const SOURCE_CLASSES: Record<string, string> = {
		model: 'bg-sky-500/20 text-sky-700 dark:text-sky-200',
		fallback: 'bg-amber-500/20 text-amber-700 dark:text-amber-300',
		unjudged: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
		none: 'bg-muted text-muted-foreground'
	};

	const sections = $derived(
		groups
			? [
					{ name: 'Kept', items: groups.kept, testId: 'memory-kept' },
					{ name: 'Dropped', items: groups.dropped, testId: 'memory-dropped' },
					{ name: 'Hidden', items: groups.hidden, testId: 'memory-hidden' },
					{ name: 'Cut', items: groups.cut, testId: 'memory-cut' }
				]
			: []
	);

	function itemKey(item: ReportItem, i: number): string {
		return `${item.contentHash}:${i}`;
	}
</script>

<div
	id={elementId}
	data-testid="memory-retrieval-card"
	class="my-1 scroll-mt-10 overflow-hidden rounded-md border border-sky-500/30 bg-sky-500/5 text-sm"
>
	<button
		type="button"
		class="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-left text-xs hover:bg-sky-500/10"
		onclick={() => (expanded = !expanded)}
	>
		<BrainIcon class="size-3.5 shrink-0 text-sky-500" />
		<span class="text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-300">Memory</span>
		<span
			class="rounded px-1 py-0.5 font-mono text-[10px] {SOURCE_CLASSES[retrieval.source] ??
				'bg-muted text-muted-foreground'}"
			title="selection source">{retrieval.source}</span
		>
		{#if reason}
			<span class="text-[10px] text-amber-600 italic dark:text-amber-400">{reason}</span>
		{/if}
		{#if report?.fellBack}
			<span
				data-testid="memory-fell-back"
				class="rounded bg-amber-500/20 px-1 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300"
				title="shown items the fallback rule chose (the judge did not answer for them)">{report.fellBack} fell back</span
			>
		{/if}
		<span class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
			>{retrievalCountsLabel(retrieval)}</span
		>
		<span class="font-mono text-[10px] text-muted-foreground" title="tokens in the block"
			>{formatTokens(retrieval.tokens)} tok</span
		>
		<span class="font-mono text-[10px] text-muted-foreground" title="build time">{formatMs(retrieval.ms)}</span>
		{#if retrieval.followUpAt != null}
			<span
				class="rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300"
				title={`followed up ${new Date(retrieval.followUpAt).toLocaleString()}`}
				>followed up{retrieval.followUpKind ? `: ${retrieval.followUpKind}` : ''}</span
			>
		{/if}
		<span class="flex-1"></span>
		{#if expanded}
			<ChevronDownIcon class="size-3.5 text-muted-foreground" />
		{:else}
			<ChevronRightIcon class="size-3.5 text-muted-foreground" />
		{/if}
	</button>

	{#if expanded}
		<div class="space-y-2 border-t border-sky-500/20 px-3 py-2 text-xs">
			<div class="flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
				<span>{retrieval.candidates} candidates</span>
				<span>{retrieval.judged} judged</span>
				{#if report?.unjudged}
					<span title="passages without a model verdict (fallback rule)">{report.unjudged} unjudged</span>
				{/if}
				<span>{retrieval.kept} kept</span>
				<span>{retrieval.hidden} hidden</span>
				{#each timings as t (t)}
					<span>{t}</span>
				{/each}
			</div>
			{#if retrieval.followUpAt != null}
				<div class="text-[11px] text-muted-foreground">
					Follow-up: {retrieval.followUpKind ?? 'yes'} at {new Date(retrieval.followUpAt).toLocaleTimeString()}
				</div>
			{/if}

			{#if !report}
				<div class="text-[11px] text-muted-foreground italic">No candidate report stored.</div>
			{:else if report.items.length === 0}
				<div class="text-[11px] text-muted-foreground italic">No candidates.</div>
			{:else}
				{#each sections as section (section.name)}
					{#if section.items.length > 0}
						<div data-testid={section.testId}>
							<div class="text-[10px] tracking-wide text-muted-foreground uppercase">
								{section.name} ({section.items.length})
							</div>
							<ul class="space-y-0.5">
								{#each section.items as item, i (itemKey(item, i))}
									{@const judge = judgeLabel(item)}
									{@const selection = selectionLabel(item)}
									<li class="flex flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
										<span class="text-foreground">{item.citation}</span>
										{#if section.name === 'Cut'}
											<span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">{stageLabel(item.stage)}</span>
										{/if}
										{#if selection}
											<span
												data-testid="memory-selected-by"
												class="rounded bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-300"
												title="chosen without a model verdict">{selection}</span
											>
										{/if}
										{#if item.hiddenBy}
											<span class="text-[10px] text-amber-700 dark:text-amber-300">{hiddenByLabel(item.hiddenBy)}</span>
										{/if}
										{#if judge}
											<span class="text-[10px] text-sky-700 dark:text-sky-300">{judge}</span>
										{/if}
										<span class="text-[10px] text-muted-foreground">{scoresLabel(item)}</span>
										{#if item.lanes.length > 0}
											<span class="text-[10px] text-muted-foreground/70">{item.lanes.join(', ')}</span>
										{/if}
										{#if item.presence}
											<span class="text-[10px] text-muted-foreground/70" title="a conversation participant took part in this entry"
												>participant</span
											>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/each}
			{/if}

			{#if evaluations.length > 0}
				<div>
					<div class="text-[10px] tracking-wide text-muted-foreground uppercase">Decision rows</div>
					<DecisionCard {evaluations} />
				</div>
			{/if}
		</div>
	{/if}
</div>
