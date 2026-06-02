<script lang="ts">
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import { Badge } from '$lib/components/ui/badge';
	import { contentText, type RolloutMsg } from '$lib/rollout';

	let {
		name,
		args,
		result
	}: { name: string; args: unknown; result: RolloutMsg | undefined } = $props();

	const argsPretty = $derived.by(() => {
		try {
			return JSON.stringify(args, null, 2);
		} catch {
			return String(args);
		}
	});
	const resultText = $derived(result ? contentText(result.content) : null);
	const isError = $derived(result?.isError === true);
	// Some tools carry a terminate signal on the result (top-level or in details).
	const terminate = $derived(
		result
			? (result['terminate'] ?? (result.details as { terminate?: unknown } | undefined)?.terminate) ===
					true
			: false
	);
</script>

<div class="overflow-hidden rounded-md border bg-card text-sm">
	<div class="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
		<WrenchIcon class="size-3.5" />
		<span class="font-mono font-semibold">{name}</span>
		<div class="flex-1"></div>
		{#if terminate}<Badge variant="outline" class="text-[10px]">terminate</Badge>{/if}
		{#if isError}
			<Badge class="bg-red-500/15 text-[10px] text-red-600 dark:text-red-400">error</Badge>
		{/if}
	</div>
	<div class="px-3 py-2">
		<div class="text-[10px] tracking-wide text-muted-foreground uppercase">args</div>
		<pre class="overflow-x-auto text-xs whitespace-pre-wrap">{argsPretty}</pre>
		{#if resultText !== null}
			<div class="mt-2 text-[10px] tracking-wide text-muted-foreground uppercase">result</div>
			<pre class="overflow-x-auto text-xs whitespace-pre-wrap">{resultText}</pre>
		{:else}
			<div class="mt-2 text-xs text-muted-foreground italic">awaiting result…</div>
		{/if}
	</div>
</div>
