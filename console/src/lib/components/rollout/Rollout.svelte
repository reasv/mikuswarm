<script lang="ts">
	import {
		asMsg,
		assistantBlocks,
		collectToolResults,
		contentText,
		isInjectedUserTurn,
		messageUsage,
		type RolloutMsg
	} from '$lib/rollout';
	import { formatTokens, formatUsd } from '$lib/format';
	import AssistantTextCard from './AssistantTextCard.svelte';
	import ThinkingCard from './ThinkingCard.svelte';
	import ToolCallCard from './ToolCallCard.svelte';
	import InterjectionCard from './InterjectionCard.svelte';
	import type { ToolInvocation } from '$lib/schemas';

	// `toolUsage` maps a tool-call id → its auxiliary usage ledger row (spec
	// AUXILIARY-USAGE-TRACKING §10.3) so a tool-call block can be annotated with its
	// own spend (today image_generate). Empty for live rollouts (ledger is durable).
	let {
		messages,
		toolUsage
	}: { messages: readonly unknown[]; toolUsage?: Map<string, ToolInvocation> } = $props();

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
						usage={toolUsage?.get(block.id)}
					/>
				{/if}
			{/each}
			<!-- Per-request usage (spec TOKEN-USAGE-TRACKING §7.3): attached once at the
			     assistant-message group level, since the usage belongs to the request that
			     produced the whole message. `ctx` is that request's totalTokens (the context
			     size reached at this point). Messages without real usage render nothing. -->
			{@const u = messageUsage(msg)}
			{#if u}
				<div
					class="px-1 font-mono text-[10px] tabular-nums text-muted-foreground"
					title={`context ${u.totalTokens} tokens · input ${u.input} · output ${u.output} · cache read ${u.cacheRead} · cache write ${u.cacheWrite} · cost ${u.cost}`}
				>
					ctx {formatTokens(u.totalTokens)} · in {formatTokens(u.input)} · out {formatTokens(
						u.output
					)} · cr {formatTokens(u.cacheRead)} · cw {formatTokens(u.cacheWrite)}{#if u.cost > 0}
						· {formatUsd(u.cost)}{/if}
				</div>
			{/if}
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
