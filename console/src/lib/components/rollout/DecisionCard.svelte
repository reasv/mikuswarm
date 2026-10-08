<script lang="ts">
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { formatUsd } from '$lib/format';
	import {
		answerConfidence,
		answerLabel,
		fallbackReasonsLabel,
		parseAnswers,
		parseMemoryVerdict,
		parseRecordsVerdict,
		routingLabelAnswers,
		rowVerdictLabel,
		summarizeDecisionGroup
	} from '$lib/decisions';
	import type { DecisionEvaluation } from '$lib/schemas';

	// Inline decision card (spec SESSION-RECORDS §8). Collapsed: the point, the
	// verdict over the whole group (records: which candidates were injected, or
	// "nothing injected"), the top confidence, how many rows fell back and why.
	// Expanded: one block per row with its answers and probabilities, the state
	// and questions sent, the served model and version, latency and cost.
	let {
		evaluations,
		/** Records: what the rollout shows was injected for this group (undefined = unknown). */
		injected,
		/** If provided, the card renders with this element id for scroll-jump targets. */
		elementId
	}: {
		evaluations: DecisionEvaluation[];
		injected?: string[];
		elementId?: string;
	} = $props();

	let expanded = $state(false);

	const summary = $derived(summarizeDecisionGroup(evaluations, injected));
	const reasons = $derived(fallbackReasonsLabel(summary));
	const mixed = $derived(summary.sources.model > 0 && summary.sources.heuristic > 0);

	/** Pretty-print a JSON string for display; returns the raw string on error. */
	function prettyJson(s: string | null | undefined): string {
		if (!s) return '—';
		try {
			return JSON.stringify(JSON.parse(s), null, 2);
		} catch {
			return s;
		}
	}

	const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

	/** Probabilities of a choice/score answer, highest first. */
	function sortedProbabilities(p: Record<string, number>): Array<[string, number]> {
		return Object.entries(p).sort((a, b) => b[1] - a[1]);
	}
</script>

<div
	id={elementId}
	class="my-1 scroll-mt-10 overflow-hidden rounded-md border border-violet-500/30 bg-violet-500/5 text-sm"
>
	<button
		type="button"
		class="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-left text-xs hover:bg-violet-500/10"
		onclick={() => (expanded = !expanded)}
	>
		<GaugeIcon class="size-3.5 shrink-0 text-violet-400" />
		<span class="text-[10px] font-semibold tracking-wide text-violet-300 uppercase">Decision</span>
		<span class="font-mono text-violet-200">{summary.point}</span>
		<span class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{summary.verdict}</span>
		{#if summary.candidates != null}
			<span class="font-mono text-[10px] text-muted-foreground"
				>{summary.candidates} {summary.candidates === 1 ? 'candidate' : 'candidates'}</span
			>
		{/if}
		{#if summary.topConfidence != null}
			<span class="font-mono text-[10px] text-muted-foreground" title="top confidence"
				>top {pct(summary.topConfidence)}</span
			>
		{/if}
		{#if summary.sources.heuristic > 0}
			<span class="rounded bg-amber-500/20 px-1 py-0.5 text-[10px] text-amber-300">
				{mixed ? `${summary.sources.heuristic} of ${evaluations.length} fell back` : 'heuristic'}
			</span>
		{/if}
		{#if reasons}
			<span class="text-[10px] text-amber-400 italic">{reasons}</span>
		{/if}
		<span class="flex-1"></span>
		{#if expanded}
			<ChevronDownIcon class="size-3.5 text-muted-foreground" />
		{:else}
			<ChevronRightIcon class="size-3.5 text-muted-foreground" />
		{/if}
	</button>

	{#if expanded}
		<div class="space-y-3 border-t border-violet-500/20 px-3 py-2 text-xs">
			{#each evaluations as row, i (row.id)}
				{@const answers = Object.entries(parseAnswers(row.answersJson))}
				{@const recordsVerdict = row.point === 'records' ? parseRecordsVerdict(row.verdictJson) : null}
				{@const labels = row.point === 'routing' ? routingLabelAnswers(row) : null}
				{@const memoryVerdict = row.point === 'memory' ? parseMemoryVerdict(row.verdictJson) : null}
				<div class="space-y-1.5">
					<div class="flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
						{#if row.candidateSessionId}
							<span class="text-muted-foreground">candidate</span>
							<span class="text-foreground">{row.candidateSessionId}</span>
						{/if}
						{#if memoryVerdict}
							<span class="text-foreground" data-testid="memory-citation">{memoryVerdict.citation}</span>
							{#if memoryVerdict.kind === 'filter'}
								<span class="text-[10px] text-muted-foreground">{memoryVerdict.surface}</span>
							{/if}
						{/if}
						<span class="rounded bg-muted px-1 text-[10px]">{rowVerdictLabel(row) ?? '—'}</span>
						{#if recordsVerdict}
							<span class="text-[10px] text-muted-foreground">relevance {pct(recordsVerdict.relevance)}</span>
						{/if}
						<span class="text-[10px] {row.source === 'heuristic' ? 'text-amber-300' : 'text-muted-foreground'}"
							>{row.source}{row.reason ? ` (${row.reason})` : ''}</span
						>
					</div>

					{#if labels && labels.tasks.length + labels.skills.length > 0}
						<div data-testid="routing-labels" class="space-y-0.5 text-[11px]">
							{#each [{ name: 'Tasks', list: labels.tasks }, { name: 'Skills', list: labels.skills }] as group (group.name)}
								{#if group.list.length > 0}
									<div class="flex flex-wrap items-center gap-1">
										<span class="text-[10px] tracking-wide text-muted-foreground uppercase">{group.name}</span>
										{#each group.list as l (l.key)}
											<span
												class="rounded px-1 font-mono text-[10px] {l.selected
													? 'bg-violet-500/25 text-violet-200'
													: 'bg-muted text-muted-foreground'}"
												title={l.selected ? 'selected' : 'not selected'}>{l.key} {pct(l.probability)}</span
											>
										{/each}
									</div>
								{/if}
							{/each}
						</div>
					{/if}

					{#if answers.length > 0}
						<div>
							<div class="text-[10px] tracking-wide text-muted-foreground uppercase">Answers</div>
							<div class="space-y-0.5 font-mono text-[11px]">
								{#each answers as [name, a] (name)}
									<div>
										<span class="text-muted-foreground">{name}</span>
										<span class="text-[10px] text-muted-foreground/70">{a.type}</span>
										<span class="text-foreground">{answerLabel(a)}</span>
										{#if a.type !== 'noul'}
											<span class="text-[10px] text-muted-foreground">confidence {pct(answerConfidence(a))}</span>
											<div class="flex flex-wrap gap-x-2 pl-3 text-[10px] text-muted-foreground">
												{#each sortedProbabilities(a.probabilities) as [option, p] (option)}
													<span>{option} {pct(p)}</span>
												{/each}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{:else if row.source === 'heuristic'}
						<div class="text-[10px] text-muted-foreground italic">
							No answer: the fallback verdict was used{row.reason ? ` (${row.reason})` : ''}.
						</div>
					{/if}

					{#if row.stateJson}
						<details>
							<summary class="cursor-pointer text-[10px] tracking-wide text-muted-foreground uppercase">State sent</summary>
							<pre class="max-h-48 overflow-auto rounded bg-muted/30 p-1.5 text-[10px]">{prettyJson(row.stateJson)}</pre>
						</details>
					{/if}
					{#if row.questionsJson}
						<details>
							<summary class="cursor-pointer text-[10px] tracking-wide text-muted-foreground uppercase">Questions sent</summary>
							<pre class="max-h-48 overflow-auto rounded bg-muted/30 p-1.5 text-[10px]">{prettyJson(row.questionsJson)}</pre>
						</details>
					{/if}

					<div class="flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
						{#if row.servedModel}<span>model: {row.servedModel}{row.servedVersion ? ` · ${row.servedVersion}` : ''}</span>{/if}
						{#if row.latencyMs != null}<span>latency: {row.latencyMs}ms</span>{/if}
						{#if row.inputTokens != null}<span>in: {row.inputTokens}</span>{/if}
						{#if row.costUsd != null}<span>cost: {formatUsd(row.costUsd)}</span>{/if}
					</div>

					{#if i < evaluations.length - 1}
						<hr class="border-violet-500/20" />
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
