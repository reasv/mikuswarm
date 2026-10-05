<script lang="ts">
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { contentText, type RolloutMsg } from '$lib/rollout';
	import { consequenceLabel, isAuditEvaluation, overrideCodes, type GateEvaluation } from '$lib/checks';
	import { decisionElementId } from '$lib/decisions';
	import type { RefusalEvent } from '$lib/schemas';
	import { cn } from '$lib/utils';

	// The check card attached to a judged output (spec REFUSAL-HANDLING §12.2).
	// `gate` (a send): each check's questions with probability and threshold, which
	// fired, latency, the served decision member, and the consequence: sent, sent
	// unjudged, revise (with the tool error the agent saw), overridden (codes),
	// redo (link to the redone branch), observed. `ending` (a `no_reply` or text
	// ending): the sources judged and the verdicts. Clean evaluations collapse to
	// one line.
	let {
		evaluation,
		variant = 'gate',
		events = [],
		result,
		args,
		onShowRedo
	}: {
		evaluation: GateEvaluation;
		variant?: 'gate' | 'ending';
		/** Refusal events written for this evaluation (rule, outcome, target). */
		events?: RefusalEvent[];
		/** The tool result the agent saw (the revise error). */
		result?: RolloutMsg;
		/** The judged call's arguments (override codes). */
		args?: unknown;
		/** Redo: switch the view to the branch that redid this output. */
		onShowRedo?: () => void;
	} = $props();

	let expanded = $state(false);

	const pct = (p: number | null) => (p == null ? '—' : `${Math.round(p * 100)}%`);
	const overrides = $derived(overrideCodes(args));
	const sources = $derived([
		...new Set(evaluation.checks.flatMap((c) => c.questions.map((q) => q.source)).concat(
			evaluation.checks.filter((c) => c.method === 'pattern' && c.source).map((c) => c.source as string)
		))
	]);
	const tone = $derived(
		evaluation.fired.some((c) => c.kind === 'refusal')
			? 'refusal'
			: evaluation.fired.length > 0 || evaluation.unjudged
				? 'flag'
				: 'clean'
	);
	const revisedError = $derived(
		evaluation.consequence === 'revise' && result?.isError === true ? contentText(result.content) : null
	);
	const label = $derived(variant === 'ending' ? 'Ending' : 'Checks');
	// Choice verdicts (e.g. `no_reply_intent`: intended, abandoned, unclear), fired or not.
	const choices = $derived(
		evaluation.checks.flatMap((c) =>
			c.questions.filter((q) => q.choice !== undefined).map((q) => ({ code: c.code, choice: q.choice! }))
		)
	);
</script>

<div
	id={decisionElementId(evaluation.decisionGroup)}
	data-testid="gate-card"
	class={cn(
		'my-1 scroll-mt-10 overflow-hidden rounded-md border text-xs',
		tone === 'refusal' && 'border-red-500/40 bg-red-500/5',
		tone === 'flag' && 'border-amber-500/40 bg-amber-500/5',
		tone === 'clean' && 'border-emerald-500/20 bg-emerald-500/5'
	)}
>
	<button
		type="button"
		class="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 text-left hover:bg-muted/40"
		onclick={() => (expanded = !expanded)}
	>
		{#if tone === 'clean'}
			<ShieldCheckIcon class="size-3.5 shrink-0 text-emerald-500" />
		{:else}
			<ShieldAlertIcon class={cn('size-3.5 shrink-0', tone === 'refusal' ? 'text-red-500' : 'text-amber-500')} />
		{/if}
		<span class="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</span>
		{#if isAuditEvaluation(evaluation)}
			<span class="rounded bg-violet-500/15 px-1 py-0.5 text-[10px] text-violet-600 dark:text-violet-300" title="judged after the session by the offline audit"
				>offline audit</span
			>
		{/if}
		{#if evaluation.checkpoint && variant === 'ending'}
			<span class="font-mono text-[10px] text-muted-foreground">attempt {evaluation.attemptNo ?? 0}</span>
		{/if}
		{#if evaluation.fired.length === 0}
			<span class="font-mono text-[10px] text-muted-foreground">{evaluation.unjudged ? 'unjudged' : 'clean'}</span>
		{:else}
			{#each evaluation.fired as c (c.code)}
				<span
					class={cn(
						'rounded px-1 py-0.5 font-mono text-[10px]',
						c.kind === 'refusal' ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
					)}
					title={c.description ?? c.code}
				>
					{c.code} {c.method === 'pattern' ? 'pattern' : pct(c.probability)}
				</span>
			{/each}
		{/if}
		<span
			class={cn(
				'rounded px-1 py-0.5 text-[10px]',
				evaluation.consequence === 'redo' || evaluation.consequence === 'withheld'
					? 'bg-red-500/15 text-red-600 dark:text-red-400'
					: evaluation.consequence === 'revise' || evaluation.consequence === 'sent_unjudged'
						? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
						: 'bg-muted text-muted-foreground'
			)}
		>
			{consequenceLabel(evaluation.consequence)}
		</span>
		{#each choices as ch (ch.code)}
			<span class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{ch.code}: {ch.choice}</span>
		{/each}
		{#if evaluation.questionCount > 0}
			<span class="font-mono text-[10px] text-muted-foreground"
				>{evaluation.questionCount} {evaluation.questionCount === 1 ? 'question' : 'questions'}</span
			>
		{/if}
		{#if evaluation.latencyMs != null}
			<span class="font-mono text-[10px] text-muted-foreground">{evaluation.latencyMs} ms</span>
		{/if}
		{#if evaluation.members.length > 0}
			<span class="font-mono text-[10px] text-muted-foreground">{evaluation.members.join(', ')}</span>
		{/if}
		<span class="flex-1"></span>
		{#if expanded}
			<ChevronDownIcon class="size-3.5 text-muted-foreground" />
		{:else}
			<ChevronRightIcon class="size-3.5 text-muted-foreground" />
		{/if}
	</button>

	{#if evaluation.consequence === 'redo' && onShowRedo}
		<div class="flex items-center gap-2 border-t px-3 py-1 text-[11px]">
			<span class="text-muted-foreground">Not sent: the turn was discarded and redone.</span>
			<button type="button" class="text-sky-600 underline dark:text-sky-400" onclick={onShowRedo}>show the redo</button>
		</div>
	{/if}
	{#if events.length > 0}
		<div class="flex flex-wrap gap-x-3 border-t px-3 py-1 font-mono text-[10px] text-muted-foreground">
			{#each events as e (e.id)}
				<span>
					{e.checkCode}: {e.outcome}{e.ruleName ? ` · rule ${e.ruleName}` : ''}{e.toModel ? ` → ${e.toModel}` : ''}
				</span>
			{/each}
		</div>
	{/if}
	{#if revisedError}
		<div class="border-t px-3 py-1">
			<div class="text-[10px] tracking-wide text-muted-foreground uppercase">tool error the agent saw</div>
			<pre class="text-[11px] whitespace-pre-wrap">{revisedError}</pre>
		</div>
	{/if}
	{#if evaluation.consequence === 'overridden' || overrides.length > 0}
		<div class="border-t px-3 py-1 font-mono text-[10px] text-muted-foreground">
			overridden: {overrides.length > 0 ? overrides.join(', ') : 'codes not recorded on the call'}
		</div>
	{/if}

	{#if expanded}
		<div class="space-y-2 border-t px-3 py-2">
			{#if variant === 'ending' && sources.length > 0}
				<div class="font-mono text-[10px] text-muted-foreground">sources judged: {sources.join(', ')}</div>
			{/if}
			{#if evaluation.unjudgedReasons.length > 0}
				<div class="text-[10px] text-amber-600 italic dark:text-amber-400">
					unjudged: {evaluation.unjudgedReasons.join(', ')}
				</div>
			{/if}
			{#each evaluation.checks as c (c.code)}
				<div class="space-y-0.5">
					<div class="flex flex-wrap items-baseline gap-x-2">
						<span class={cn('font-mono', c.fired ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{c.code}</span>
						<span class="text-[10px] text-muted-foreground">{c.kind}</span>
						{#if c.fired}
							<span class="text-[10px] font-semibold text-red-600 dark:text-red-400">fired</span>
						{/if}
						{#if c.description}<span class="text-[10px] text-muted-foreground">{c.description}</span>{/if}
					</div>
					{#if c.method === 'pattern'}
						<div class="pl-3 font-mono text-[10px] text-muted-foreground">
							pattern on {c.source ?? '?'}{c.matched ? `: “${c.matched}”` : ''}
						</div>
					{/if}
					{#each c.questions as q (q.id)}
						<div class="flex gap-x-2 pl-3 font-mono text-[10px] {q.fired ? 'text-foreground' : 'text-muted-foreground'}">
							<span class="w-20 shrink-0">{q.source}</span>
							{#if q.choice}<span>{q.choice}</span>{/if}
							<span>p {pct(q.probability)}</span>
							<span>≥ {pct(q.threshold)}</span>
							{#if q.fired}<span class="font-semibold text-red-600 dark:text-red-400">fired</span>{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</div>
