<script lang="ts" module>
	// Map a pipeline item's status to a badge tone. The vocabulary differs from the
	// session status model (StatusBadge): pending/processing/complete/done/truncated/
	// failed/skipped, plus the derived `retrying` (a pending row with attempts > 0)
	// and `deferred` (captioning: pending the pool would never claim under the current
	// config — distinct from `skipped`, which is terminal).
	const TONE: Record<string, string> = {
		pending: 'border-transparent bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
		processing: 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400',
		retrying: 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400',
		complete: 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
		done: 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
		truncated: 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400',
		failed: 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400',
		skipped: 'border-transparent bg-zinc-500/10 text-zinc-500 dark:text-zinc-500',
		deferred: 'border-transparent bg-violet-500/10 text-violet-600 dark:text-violet-400'
	};
</script>

<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';

	let { status, retrying = false }: { status: string; retrying?: boolean } = $props();

	// A pending row with prior attempts reads as "retrying" — its own tone/label.
	const label = $derived(retrying ? 'retrying' : status);
	const pulse = $derived(status === 'processing');
</script>

<Badge class={cn('gap-1 font-mono text-[10px] uppercase', TONE[label] ?? TONE.pending)}>
	{#if pulse}
		<span class="relative flex size-1.5">
			<span
				class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75"
			></span>
			<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
		</span>
	{/if}
	{label}
</Badge>
