<script lang="ts">
	import type { BehaviourBreakdown } from '$lib/schemas';
	import { formatUsd } from '$lib/format';
	import { cn } from '$lib/utils';

	// Breakdown (spec REFUSAL-HANDLING §12.3 §3) over the filters and the selected
	// group: refusals (reason, site, detection method, rule outcomes, discarded
	// branch cost), send contract (nudges until recovery, failure types, what
	// happened to the message, `no_reply` intent after a nudge), style (per check).
	// The section of the selected metric's family is emphasized.
	let {
		breakdown,
		family,
		selected
	}: {
		breakdown: BehaviourBreakdown;
		family: 'refusals' | 'contract' | 'style' | null;
		selected: string | null;
	} = $props();

	const UNTIL_LABEL: Record<string, string> = {
		'1': '1 nudge',
		'2': '2 nudges',
		'3': '3+ nudges',
		after_redo: 'after redo',
		gave_up: 'gave up',
		exhausted: 'exhausted'
	};
</script>

{#snippet counts(title: string, items: readonly { key: string; count: number }[], labels?: Record<string, string>)}
	<div>
		<div class="text-[10px] tracking-wide text-muted-foreground uppercase">{title}</div>
		{#if items.length === 0 || items.every((i) => i.count === 0)}
			<div class="text-[11px] text-muted-foreground italic">none</div>
		{:else}
			{#each items as i (i.key)}
				<div class="flex justify-between gap-2 font-mono text-[11px]">
					<span>{labels?.[i.key] ?? i.key}</span><span class="tabular-nums">{i.count}</span>
				</div>
			{/each}
		{/if}
	</div>
{/snippet}

<div class="grid grid-cols-1 gap-2 lg:grid-cols-3" data-testid="breakdown">
	<section class={cn('space-y-2 rounded-lg border p-3', family === 'refusals' && 'border-sky-500/60')}>
		<h3 class="text-xs font-semibold">Refusals{selected ? ` · ${selected}` : ''}</h3>
		<div class="flex gap-3 font-mono text-[11px]">
			<span>hard {breakdown.refusals.hard}</span><span>judged {breakdown.refusals.judged}</span><span>redos {breakdown.refusals.redos}</span>
		</div>
		{@render counts('by reason', breakdown.refusals.byReason)}
		{@render counts('by site', breakdown.refusals.bySite)}
		{@render counts('by method', breakdown.refusals.byMethod)}
		{@render counts('outcomes', breakdown.refusals.outcomes)}
		<div class="font-mono text-[11px] text-muted-foreground">
			discarded branches {formatUsd(breakdown.refusals.discardedBranchCostUsd)}
		</div>
	</section>
	<section class={cn('space-y-2 rounded-lg border p-3', family === 'contract' && 'border-sky-500/60')}>
		<h3 class="text-xs font-semibold">Send contract{selected ? ` · ${selected}` : ''}</h3>
		<div class="flex gap-3 font-mono text-[11px]">
			<span>nudged {breakdown.contract.nudgedSessions}</span><span>failed attempts {breakdown.contract.failedAttempts}</span><span>redos {breakdown.contract.redos}</span>
		</div>
		{@render counts('until recovery', breakdown.contract.untilRecovery, UNTIL_LABEL)}
		{@render counts('failure types', breakdown.contract.failureTypes)}
		{@render counts('after correction', breakdown.contract.afterCorrection)}
		{@render counts('no_reply intent after a nudge', breakdown.contract.noReplyIntent)}
		<div class="font-mono text-[11px] text-muted-foreground">
			discarded branches {formatUsd(breakdown.contract.discardedBranchCostUsd)}
		</div>
	</section>
	<section class={cn('space-y-2 rounded-lg border p-3', family === 'style' && 'border-sky-500/60')}>
		<h3 class="text-xs font-semibold">Style{selected ? ` · ${selected}` : ''}</h3>
		<div class="flex gap-3 font-mono text-[11px]">
			<span>hits {breakdown.style.hits}</span><span>messages {breakdown.style.messagesWithHit}</span><span>revised {breakdown.style.revisions}</span><span>overridden {breakdown.style.overrides}</span>
		</div>
		<div>
			<div class="text-[10px] tracking-wide text-muted-foreground uppercase">per check (hits · revisions · overrides)</div>
			{#if breakdown.style.perCheck.length === 0}
				<div class="text-[11px] text-muted-foreground italic">none</div>
			{:else}
				{#each breakdown.style.perCheck as c (c.code)}
					<div class="flex justify-between gap-2 font-mono text-[11px]">
						<span>{c.code}</span><span class="tabular-nums">{c.hits} · {c.revisions} · {c.overrides}</span>
					</div>
				{/each}
			{/if}
		</div>
	</section>
</div>
