<script lang="ts">
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import { Badge } from '$lib/components/ui/badge';
	import { contentText, type RolloutMsg } from '$lib/rollout';
	import { formatTokens, formatUsd } from '$lib/format';
	import type { ToolInvocation } from '$lib/schemas';

	let {
		name,
		args,
		result,
		// Auxiliary usage ledger row for this tool call (spec AUXILIARY-USAGE-TRACKING
		// §10.3), matched by toolCallId — present for image_generate. A separate lane:
		// these tokens are NOT context-bearing and never feed the §8b figures (§4).
		usage,
		requestFailed = false
	}: { name: string; args: unknown; result: RolloutMsg | undefined; usage?: ToolInvocation; requestFailed?: boolean } =
		$props();

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
		{#if usage}
			<!-- Auxiliary tool spend (spec §10.1/§10.3): in · out · $cost, sourced from
			     the ledger row. Separate lane — not context-bearing. -->
			<span
				class="font-mono text-[10px] tabular-nums text-muted-foreground"
				title={`tool usage · input ${usage.input ?? '—'} · output ${usage.output ?? '—'} · cache read ${usage.cacheRead ?? '—'}${usage.images != null ? ` · images ${usage.images}` : ''} · cost ${usage.cost ?? '—'}`}
			>
				in {formatTokens(usage.input)} · out {formatTokens(usage.output)}{#if usage.cost}
					· {formatUsd(usage.cost)}{/if}
			</span>
		{/if}
		<div class="flex-1"></div>
		{#if terminate}<Badge variant="outline" class="text-[10px]">terminate</Badge>{/if}
		{#if isError}
			<Badge class="bg-red-500/15 text-[10px] text-red-600 dark:text-red-400">error</Badge>
		{/if}
	</div>
  {#if usage?.metadata}
    <div class="border-b px-3 py-2 text-xs text-muted-foreground" data-testid="tool-service-metadata">
      {usage.metadata.mode ? `${usage.metadata.mode} · ` : ''}{usage.metadata.latencyMs !== undefined ? `${usage.metadata.latencyMs}ms · ` : ''}
      provider cost {usage.metadata.reportedCost === null ? 'unknown' : formatUsd(usage.metadata.reportedCost)} · ledger {usage.cost === null ? 'unknown' : formatUsd(usage.cost)}{usage.metadata.costProvenance ? ` (${usage.metadata.costProvenance})` : ''}
      {#if usage.metadata.requestId}<span class="ml-2 font-mono">request {usage.metadata.requestId}</span>{/if}
      {#if usage.metadata.jobId}<span class="ml-2 font-mono">job {usage.metadata.jobId}</span>{/if}
    </div>
  {/if}

	<div class="px-3 py-2">
		<div class="text-[10px] tracking-wide text-muted-foreground uppercase">args</div>
		<pre class="overflow-x-auto text-xs whitespace-pre-wrap">{argsPretty}</pre>
		{#if resultText !== null}
			<div class="mt-2 text-[10px] tracking-wide text-muted-foreground uppercase">result</div>
			<pre class="overflow-x-auto text-xs whitespace-pre-wrap">{resultText}</pre>
		{:else if requestFailed}
			<div class="mt-2 text-xs text-muted-foreground italic">Not executed — request ended before completion.</div>
		{:else}
			<div class="mt-2 text-xs text-muted-foreground italic">awaiting result…</div>
		{/if}
	</div>
</div>
