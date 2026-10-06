<script lang="ts">
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
	import BotIcon from '@lucide/svelte/icons/bot';

	/** The record-turn prompt the harness sent (shown collapsed). */
	let { prompt, outcome }: { prompt?: string; outcome?: string } = $props();
</script>

<!--
  Separator heading for the record-turn section (spec SESSION-RECORDS §3.2).
  Appears in the rollout when harness.kind = 'record_turn' is encountered; the
  harness prompt sits collapsed under it, and the model's session_record_tool
  calls follow as normal tool-call cards.
-->
<div class="mt-3 mb-1 border-t border-dashed border-muted/50 pt-2">
	<div class="flex items-center gap-2">
		<BookmarkIcon class="size-3.5 text-muted-foreground/60" />
		<span class="text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
			Session record
		</span>
		{#if outcome}<span class="text-xs text-muted-foreground" data-testid="record-outcome">{outcome}</span>{/if}
	</div>
	{#if prompt}
		<details class="mt-1">
			<summary
				class="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-foreground"
			>
				<BotIcon class="size-3" />
				<span class="font-semibold tracking-wide uppercase">harness prompt</span>
			</summary>
			<pre
				class="mt-1 max-h-64 overflow-auto rounded border border-dashed bg-muted/30 p-2 text-[11px] whitespace-pre-wrap">{prompt}</pre>
		</details>
	{/if}
</div>
