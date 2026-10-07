<script lang="ts">
	import type { SessionCheckChips } from '$lib/schemas';
	import { cn } from '$lib/utils';

	// Session-list chips (spec REFUSAL-HANDLING §12.2): refused, redone (n),
	// nudged (n), revised (n), unjudged (n). Nothing renders for a session with
	// none of them (or a pre-feature backend). `redoCount` adds the late-input
	// redos from scratch (an edited trigger, a late addition; ARCHITECTURE.md §8).
	let {
		chips,
		redoCount = 0
	}: { chips: SessionCheckChips | null | undefined; redoCount?: number | null } = $props();

	const items = $derived([
		...(redoCount
			? [{ key: 'restarted', label: `restarted ${redoCount}`, n: redoCount, title: 'redone from scratch after an edit or a late addition', tone: 'amber' }]
			: []),
		...(chips
			? [
					{ key: 'refused', label: 'refused', n: chips.refused, title: `${chips.refused} refusal events`, tone: 'red' },
					{ key: 'redone', label: `redone ${chips.redone}`, n: chips.redone, title: 'rule and send-contract redos', tone: 'red' },
					{ key: 'nudged', label: `nudged ${chips.nudged}`, n: chips.nudged, title: 'send-contract nudges', tone: 'amber' },
					{ key: 'revised', label: `revised ${chips.revised}`, n: chips.revised, title: 'messages sent back for revision', tone: 'amber' },
					{ key: 'unjudged', label: `unjudged ${chips.unjudged}`, n: chips.unjudged, title: 'outputs sent without a verdict (deadline)', tone: 'muted' }
				].filter((c) => c.n > 0)
			: [])
	]);
</script>

{#if items.length > 0}
	<span class="flex flex-wrap gap-1" data-testid="session-chips">
		{#each items as c (c.key)}
			<span
				title={c.title}
				class={cn(
					'rounded px-1 py-px font-mono text-[9px] leading-tight',
					c.tone === 'red' && 'bg-red-500/15 text-red-600 dark:text-red-400',
					c.tone === 'amber' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
					c.tone === 'muted' && 'bg-muted text-muted-foreground'
				)}>{c.label}</span
			>
		{/each}
	</span>
{/if}
