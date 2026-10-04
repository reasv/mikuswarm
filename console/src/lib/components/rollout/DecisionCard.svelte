<script lang="ts">
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { formatUsd } from '$lib/format';
	import type { DecisionEvaluation } from '$lib/schemas';

	let {
		decisionGroup,
		evaluations,
		/** If provided, the card renders with this element id for scroll-jump targets. */
		elementId
	}: {
		decisionGroup: string;
		evaluations: DecisionEvaluation[];
		elementId?: string;
	} = $props();

	let expanded = $state(false);

	// Derive summary fields from the first (or only) evaluation.
	const first = $derived(evaluations[0]);
	const point = $derived(first?.point ?? '—');
	const source = $derived(first?.source ?? '—');

	/** Parse a JSON string defensively; returns null on error. */
	function tryParse(s: string | null | undefined): unknown {
		if (!s) return null;
		try { return JSON.parse(s); } catch { return null; }
	}

	/** Pretty-print a JSON string for display; returns the raw string on error. */
	function prettyJson(s: string | null | undefined): string {
		if (!s) return '—';
		const parsed = tryParse(s);
		if (parsed === null) return s;
		try { return JSON.stringify(parsed, null, 2); } catch { return s; }
	}

	/**
	 * Extract the top probability/confidence from answersJson.
	 * The answers array is `[{ label, probability }, ...]`.
	 */
	function topProbability(answersJson: string | null | undefined): number | null {
		const arr = tryParse(answersJson);
		if (!Array.isArray(arr) || arr.length === 0) return null;
		let max = -Infinity;
		for (const item of arr) {
			if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).probability === 'number') {
				max = Math.max(max, (item as { probability: number }).probability);
			}
		}
		return max > -Infinity ? max : null;
	}

	/**
	 * Extract the verdict label from verdictJson for the collapsed summary.
	 * Returns a short human-readable string.
	 */
	function verdictLabel(verdictJson: string | null | undefined): string | null {
		const v = tryParse(verdictJson);
		if (!v || typeof v !== 'object') return null;
		const obj = v as Record<string, unknown>;
		// records point: { inject: true/false }
		if ('inject' in obj) return obj.inject ? 'inject' : 'skip';
		// routing point: { model: '...' }
		if ('model' in obj && typeof obj.model === 'string') return obj.model;
		return null;
	}

	// Collapsed summary from the group.
	const topProb = $derived(topProbability(first?.answersJson));
	const verdict = $derived(verdictLabel(first?.answersJson ? null : first?.verdictJson) ?? verdictLabel(first?.verdictJson));
	const fallbackReason = $derived(first?.reason);

	// For the records point, show one row per candidate (candidateSessionId).
	const isRecords = $derived(point === 'records');
</script>

<!-- Inline decision card (spec SESSION-RECORDS §8) -->
<div
	id={elementId}
	class="my-1 overflow-hidden rounded-md border border-violet-500/30 bg-violet-500/5 text-sm"
>
	<button
		type="button"
		class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-violet-500/10"
		onclick={() => (expanded = !expanded)}
	>
		<GaugeIcon class="size-3.5 shrink-0 text-violet-400" />
		<span class="font-semibold text-violet-300 uppercase tracking-wide text-[10px]">Decision</span>
		<span class="font-mono text-violet-200">{point}</span>
		{#if source === 'heuristic'}
			<span class="rounded bg-amber-500/20 px-1 py-0.5 text-[10px] text-amber-300">heuristic</span>
		{/if}
		{#if verdict}
			<span class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{verdict}</span>
		{/if}
		{#if topProb != null}
			<span class="font-mono text-[10px] text-muted-foreground">{(topProb * 100).toFixed(0)}%</span>
		{/if}
		{#if fallbackReason}
			<span class="text-[10px] text-amber-400 italic">{fallbackReason}</span>
		{/if}
		<span class="flex-1"></span>
		{#if expanded}
			<ChevronDownIcon class="size-3.5 text-muted-foreground" />
		{:else}
			<ChevronRightIcon class="size-3.5 text-muted-foreground" />
		{/if}
	</button>

	{#if expanded}
		<div class="border-t border-violet-500/20 px-3 py-2 space-y-3 text-xs">
			{#each evaluations as row (row.id)}
				<div class="space-y-1.5">
					{#if isRecords && row.candidateSessionId}
						<div class="font-mono text-[10px] text-muted-foreground">
							candidate: <span class="text-foreground">{row.candidateSessionId}</span>
						</div>
					{/if}

					<!-- Verdict + answers -->
					{#if row.verdictJson}
						<div>
							<div class="text-[10px] tracking-wide text-muted-foreground uppercase">Verdict</div>
							<pre class="overflow-x-auto text-[11px]">{prettyJson(row.verdictJson)}</pre>
						</div>
					{/if}
					{#if row.answersJson}
						<div>
							<div class="text-[10px] tracking-wide text-muted-foreground uppercase">Answers</div>
							<pre class="overflow-x-auto text-[11px]">{prettyJson(row.answersJson)}</pre>
						</div>
					{/if}

					<!-- State (capped 64 KiB) — scrollable -->
					{#if row.stateJson}
						<div>
							<div class="text-[10px] tracking-wide text-muted-foreground uppercase">State sent</div>
							<pre class="max-h-48 overflow-auto rounded bg-muted/30 p-1.5 text-[10px]">{prettyJson(row.stateJson)}</pre>
						</div>
					{/if}

					<!-- Questions (capped 16 KiB) -->
					{#if row.questionsJson}
						<div>
							<div class="text-[10px] tracking-wide text-muted-foreground uppercase">Questions</div>
							<pre class="overflow-x-auto text-[11px]">{prettyJson(row.questionsJson)}</pre>
						</div>
					{/if}

					<!-- Meta: model, latency, cost -->
					<div class="flex flex-wrap gap-x-3 font-mono text-[10px] text-muted-foreground">
						{#if row.servedModel}<span>model: {row.servedModel}{row.servedVersion ? ` · ${row.servedVersion}` : ''}</span>{/if}
						{#if row.latencyMs != null}<span>latency: {row.latencyMs}ms</span>{/if}
						{#if row.inputTokens != null}<span>in: {row.inputTokens}</span>{/if}
						{#if row.costUsd != null}<span>cost: {formatUsd(row.costUsd)}</span>{/if}
					</div>

					{#if evaluations.length > 1}
						<hr class="border-violet-500/20" />
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
