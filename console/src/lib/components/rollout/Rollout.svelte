<script lang="ts">
	import {
		asMsg,
		assistantBlocks,
		collectToolResults,
		contentText,
		isInjectedUserTurn,
		type RolloutMsg
	} from '$lib/rollout';
	import AssistantTextCard from './AssistantTextCard.svelte';
	import ThinkingCard from './ThinkingCard.svelte';
	import ToolCallCard from './ToolCallCard.svelte';
	import InterjectionCard from './InterjectionCard.svelte';

	let { messages }: { messages: readonly unknown[] } = $props();

	const toolResults = $derived(collectToolResults(messages));
	const rows = $derived(messages.map(asMsg));
</script>

<div class="space-y-2 p-3">
	{#each rows as msg, i (i)}
		{#if msg.role === 'assistant'}
			{#each assistantBlocks(msg.content) as block, b (b)}
				{#if block.type === 'text'}
					<AssistantTextCard text={block.text} />
				{:else if block.type === 'thinking'}
					<ThinkingCard thinking={block.thinking} redacted={block.redacted} />
				{:else if block.type === 'toolCall'}
					<ToolCallCard
						name={block.name}
						args={block.arguments}
						result={toolResults.get(block.id)}
					/>
				{/if}
			{/each}
		{:else if isInjectedUserTurn(msg)}
			<!-- Injected user turns: interjections carry no `role` (just
			     `{ type:'interjection', content }`, see src/agent/messages.ts), while
			     forced-completion prompts arrive as `role:'user'` (src/agent/runner.ts).
			     Both render as distinct user-role injections (spec §10b). -->
			<InterjectionCard text={contentText(msg.content)} />
		{:else if msg.role === 'toolResult'}
			<!-- rendered inside its tool-call card; skip standalone -->
		{:else}
			<pre class="overflow-x-auto rounded border bg-muted/30 p-2 text-xs">{JSON.stringify(
					msg satisfies RolloutMsg,
					null,
					2
				)}</pre>
		{/if}
	{/each}
	{#if rows.length === 0}
		<div class="text-sm text-muted-foreground">No rollout yet.</div>
	{/if}
</div>
