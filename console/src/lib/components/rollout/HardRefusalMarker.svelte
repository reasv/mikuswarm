<script lang="ts">
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import type { RefusalEvent } from '$lib/schemas';

	// A hard refusal on a request (spec REFUSAL-HANDLING §5.1, §12.2): the stop
	// reason, the provider category, what happened (chain fallover, a rule redo
	// and its target model, exhaustion) and the provider's explanation.
	let { event }: { event: RefusalEvent } = $props();

	const what = $derived.by(() => {
		switch (event.outcome) {
			case 'fallover':
				return 'retry on fallback model';
			case 'redo':
				return event.toModel === event.servedModel
					? `retry same request on ${event.toModel} (rule ${event.ruleName ?? '?'})`
					: `retry request on ${event.toModel ?? '?'} (rule ${event.ruleName ?? '?'})`;
			case 'failed':
				return 'request failed';
			case 'exhausted_withheld':
				return 'retry limit exhausted · reply withheld';
			case 'exhausted_no_output':
				return 'retry limit exhausted · no output';
			default:
				return event.outcome.replaceAll('_', ' ') + (event.ruleName ? ` (rule ${event.ruleName})` : '');
		}
	});
</script>

<div
	data-testid="hard-refusal"
	class="my-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1 text-xs"
	title={event.explanation ?? undefined}
>
	<OctagonAlertIcon class="size-3.5 shrink-0 text-red-500" />
	<span class="text-[10px] font-semibold tracking-wide text-red-600 uppercase dark:text-red-400">hard refusal</span>
	{#if event.servedModel}<span class="font-mono text-[10px]">{event.servedModel}</span>{/if}
	<span class="font-mono text-[10px] text-muted-foreground"
		>stop {event.rawStopReason ?? '?'}{event.category ? ` · ${event.category}` : ''}</span
	>
	<span class="font-mono text-[10px] text-muted-foreground">{event.checkCode} ({event.reason})</span>
	<span class="rounded bg-red-500/15 px-1 py-0.5 text-[10px] text-red-600 dark:text-red-400">{what}</span>
</div>
