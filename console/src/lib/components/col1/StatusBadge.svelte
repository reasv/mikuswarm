<script lang="ts" module>
	// Map a session status (spec §4 status model) to a badge variant + tone class.
	const TONE: Record<string, string> = {
		running: 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400',
		completed: 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
		discarded: 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400',
		interrupted: 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400',
		suspended: 'border-transparent bg-violet-500/15 text-violet-600 dark:text-violet-400',
		created: 'border-transparent bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
		resuming: 'border-transparent bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
		'failed-resumable': 'border-transparent bg-orange-500/15 text-orange-600 dark:text-orange-400'
	};
</script>

<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';

	let { status, pulse = false }: { status: string; pulse?: boolean } = $props();
</script>

<Badge class={cn('gap-1 font-mono text-[10px] uppercase', TONE[status] ?? TONE.created)}>
	{#if pulse}
		<span class="relative flex size-1.5">
			<span
				class="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75"
			></span>
			<span class="relative inline-flex size-1.5 rounded-full bg-current"></span>
		</span>
	{/if}
	{status}
</Badge>
