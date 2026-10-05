<script lang="ts">
	import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';
	import type { NudgeInfo } from '$lib/branch-plan';
	import { wordDiff } from '$lib/checks';
	import { cn } from '$lib/utils';

	// A send-contract nudge (spec REFUSAL-HANDLING §7, §12.2): "nudge 2/3" with the
	// failure types of the attempt it closed, the offline audit's findings when
	// the audit has run, and for a recovered run the first attempted message vs
	// the message finally sent, with the audit's `after_correction` verdict.
	let { nudge, text, elementId }: { nudge: NudgeInfo; text: string; elementId?: string } = $props();

	let showPrompt = $state(false);
	const diff = $derived(nudge.recovery ? wordDiff(nudge.recovery.first, nudge.recovery.sent) : []);
	const afterCorrection = $derived(nudge.audit.find((a) => a.afterCorrection)?.afterCorrection ?? null);
	const auditChips = $derived([...new Set(nudge.audit.flatMap((a) => a.chips))]);
</script>

<div
	id={elementId}
	data-testid="nudge-card"
	class="scroll-mt-10 rounded-md border-l-2 border-l-amber-400 bg-amber-500/5 px-3 py-2 text-sm"
>
	<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tracking-wide uppercase">
		<CornerDownRightIcon class="size-3 text-amber-500" />
		<span class="font-semibold text-amber-600 dark:text-amber-400"
			>nudge {nudge.index}{nudge.of != null ? `/${nudge.of}` : ''}</span
		>
		<span class="font-mono text-muted-foreground normal-case">{nudge.variant}</span>
		{#each nudge.attempt?.failureTypes ?? [] as t (t)}
			<span
				class={cn(
					'rounded px-1 py-0.5 font-mono normal-case',
					t === nudge.attempt?.primaryType ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-muted text-muted-foreground'
				)}>{t}</span
			>
		{/each}
		{#each auditChips as chip (chip)}
			<span class="rounded bg-violet-500/15 px-1 py-0.5 font-mono text-violet-600 normal-case dark:text-violet-300" title="offline audit"
				>{chip}</span
			>
		{/each}
		{#if nudge.attempt?.servedModel}
			<span class="font-mono text-muted-foreground normal-case">{nudge.attempt.servedModel}</span>
		{/if}
		<button type="button" class="text-muted-foreground normal-case underline" onclick={() => (showPrompt = !showPrompt)}>
			{showPrompt ? 'hide prompt' : 'prompt'}
		</button>
	</div>
	{#if showPrompt}
		<pre class="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">{text}</pre>
	{/if}
	{#if nudge.recovery}
		<div class="mt-1.5 space-y-0.5" data-testid="nudge-diff">
			<div class="flex flex-wrap items-center gap-2 text-[10px] tracking-wide text-muted-foreground uppercase">
				<span>first attempt → sent</span>
				{#if afterCorrection}
					<span class="rounded bg-violet-500/15 px-1 py-0.5 font-mono text-violet-600 normal-case dark:text-violet-300"
						>after correction: {afterCorrection}</span
					>
				{/if}
			</div>
			<p class="text-xs whitespace-pre-wrap">
				{#each diff as part, i (i)}
					{#if part.kind === 'same'}<span>{part.text}</span>{:else if part.kind === 'removed'}<del
							class="bg-red-500/15 text-red-700 dark:text-red-300">{part.text}</del
						>{:else}<ins class="bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300">{part.text}</ins>{/if}
				{/each}
			</p>
		</div>
	{/if}
</div>
