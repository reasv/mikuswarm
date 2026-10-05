<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import { CONTINUATION, forkPosition, stepFork } from '$lib/branches';
	import type { ForkInfo } from '$lib/branch-plan';
	import type { CheckInfo } from '$lib/schemas';
	import { formatUsd } from '$lib/format';

	// A fork point in the rollout (spec REFUSAL-HANDLING §12.1): a `‹ x/y ›`
	// switcher between the branches forked here (oldest first) and the
	// continuation (the newest, shown by default), and why the fork happened:
	// the check code and description with the probability that fired, or the
	// nudges without a send, from-model → to-model, the discarded branch's cost.
	let {
		info,
		checks = [],
		maxNudges = null,
		onSelect
	}: {
		info: ForkInfo;
		checks?: readonly CheckInfo[];
		maxNudges?: number | null;
		onSelect: (key: string, option: number) => void;
	} = $props();

	const position = $derived(forkPosition(info.fork));
	const subject = $derived(info.subject);
	const viewing = $derived(
		info.fork.selected === CONTINUATION ? 'redo' : `discarded branch #${info.fork.selected}`
	);
	const check = $derived(subject?.checkCode ? checks.find((c) => c.code === subject.checkCode) : undefined);
	const why = $derived.by(() => {
		if (!subject) return 'forked';
		if (subject.reason === 'contract_redo') {
			const n = info.nudges || maxNudges || 0;
			return `${n} ${n === 1 ? 'nudge' : 'nudges'} without a send`;
		}
		const parts = [subject.checkCode ?? 'refusal'];
		if (check?.description) parts.push(check.description);
		return parts.join(': ');
	});
	const probability = $derived(info.refusal?.probability ?? null);
</script>

<div
	data-testid="fork-marker"
	class="my-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-dashed border-sky-500/40 bg-sky-500/5 px-2 py-1 text-xs"
>
	<GitForkIcon class="size-3.5 shrink-0 text-sky-500" />
	<span class="inline-flex items-center rounded border bg-background">
		<button
			type="button"
			class="px-1 py-0.5 disabled:opacity-30"
			aria-label="previous branch"
			disabled={position.index <= 1}
			onclick={() => onSelect(info.fork.key, stepFork(info.fork, -1))}
		>
			<ChevronLeftIcon class="size-3" />
		</button>
		<span class="px-1 font-mono text-[10px] tabular-nums" data-testid="fork-position"
			>{position.index}/{position.count}</span
		>
		<button
			type="button"
			class="px-1 py-0.5 disabled:opacity-30"
			aria-label="next branch"
			disabled={position.index >= position.count}
			onclick={() => onSelect(info.fork.key, stepFork(info.fork, 1))}
		>
			<ChevronRightIcon class="size-3" />
		</button>
	</span>
	<span class="text-[10px] font-semibold tracking-wide text-sky-600 uppercase dark:text-sky-400">
		{(subject?.reason ?? 'redo').replaceAll('_', ' ')}
	</span>
	<span class="text-foreground">{why}</span>
	{#if probability != null}
		<span class="font-mono text-[10px] text-muted-foreground">p {Math.round(probability * 100)}%</span>
	{/if}
	{#if subject?.fromModel || subject?.toModel}
		<span class="font-mono text-[10px] text-muted-foreground"
			>{subject?.fromModel ?? '?'} → {subject?.toModel ?? '?'}</span
		>
	{/if}
	{#if subject?.costUsd}
		<span class="font-mono text-[10px] text-muted-foreground" title="cost of the discarded branch"
			>discarded {formatUsd(subject.costUsd)}</span
		>
	{/if}
	<span class="flex-1"></span>
	<span class="text-[10px] text-muted-foreground italic">viewing {viewing}</span>
</div>
