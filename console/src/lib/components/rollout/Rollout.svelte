<script lang="ts">
	import {
		asMsg,
		assistantBlocks,
		buildRolloutPlan,
		coerceContextMessage,
		collectToolResults,
		contentText,
		getHarness,
		isInjectedUserTurn,
		messageUsage,
		type RolloutMsg
	} from '$lib/rollout';
	import { isCollapsible as collapsibleFor, defaultOpen } from '$lib/tiers';
	import { decisionElementId } from '$lib/decisions';
	import { formatTokens, formatUsd } from '$lib/format';
	import AssistantTextCard from './AssistantTextCard.svelte';
	import ThinkingCard from './ThinkingCard.svelte';
	import ToolCallCard from './ToolCallCard.svelte';
	import HarnessCallRow from './HarnessCallRow.svelte';
	import DecisionCard from './DecisionCard.svelte';
	import RecordTurnSection from './RecordTurnSection.svelte';
	import InterjectionCard from './InterjectionCard.svelte';
	import MessageBlock from '$lib/components/verbatim/MessageBlock.svelte';
	import type { DecisionEvaluation, ToolInvocation } from '$lib/schemas';

	// `toolUsage` maps a tool-call id → its auxiliary usage ledger row (spec
	// AUXILIARY-USAGE-TRACKING §10.3) so a tool-call block can be annotated with its
	// own spend (today image_generate). Empty for live rollouts (ledger is durable).
	// `decisionEvaluations` — all decision_evaluations rows for the session; the
	// render plan interleaves decision cards at the right positions (spec §8).
	let {
		messages,
		toolUsage,
		decisionEvaluations
	}: {
		messages: readonly unknown[];
		toolUsage?: Map<string, ToolInvocation>;
		decisionEvaluations?: DecisionEvaluation[];
	} = $props();

	const toolResults = $derived(collectToolResults(messages));
	const rows = $derived(messages.map(asMsg));

	// Build the flat render plan: messages interleaved with decision cards.
	const plan = $derived(buildRolloutPlan(rows, decisionEvaluations ?? []));
</script>

<div class="space-y-2 p-3">
	{#each plan as item (item.type === 'decision' ? 'decision:' + item.decisionGroup : item.index)}
		{#if item.type === 'decision'}
			<DecisionCard
				evaluations={item.evaluations}
				injected={item.injected}
				elementId={decisionElementId(item.decisionGroup)}
			/>
		{:else}
			{@const msg = item.msg}
			{@const harness = getHarness(msg)}

			{#if harness?.kind === 'record_turn'}
				<!-- The harness record-turn user prompt: a section header, with the prompt
				     itself collapsed and marked harness-made. -->
				<RecordTurnSection prompt={contentText(msg.content)} />
			{:else if msg.role === 'assistant' && harness?.kind === 'injection'}
				<!-- Harness injection: assistant side — render each toolCall as a harness card. -->
				{#each assistantBlocks(msg.content) as block, b (b)}
					{#if block.type === 'toolCall'}
						<HarnessCallRow
							name={block.name}
							args={block.arguments}
							result={toolResults.get(block.id)}
							kind="injection"
						/>
					{/if}
				{/each}
			{:else if msg.role === 'toolResult' && harness?.kind === 'injection'}
				<!-- Harness injection: tool-result side — rendered inside HarnessCallRow above. -->
			{:else if msg.role === 'assistant' && harness?.kind === 'record_load'}
				<!-- Harness record_load: the synthetic tool load before the record turn. -->
				{#each assistantBlocks(msg.content) as block, b (b)}
					{#if block.type === 'toolCall'}
						<HarnessCallRow
							name={block.name}
							args={block.arguments}
							result={toolResults.get(block.id)}
							kind="record_load"
						/>
					{/if}
				{/each}
			{:else if msg.role === 'toolResult' && harness?.kind === 'record_load'}
				<!-- Already rendered inside HarnessCallRow above. -->
			{:else if msg.role === 'assistant'}
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
			{:else if msg.type === 'triggerGroup' || msg.type === 'satellite'}
				<!-- A final user turn (`triggerGroup`/`satellite`, `isFinalTurnMessage` in
				     src/agent/factory.ts) that lands INSIDE the rollout slice. This happens on
				     a resumed session: `buildResumeTurn` (src/context/builder.ts) appends a
				     fresh `triggerGroup` after the completed transcript, and `rolloutStartIndex`
				     (src/observability/server/handlers.ts) skips only the LEADING head run — so
				     the resume turn is a rollout message, not a head turn. Render it with the
				     verbatim MessageBlock (same tier gutter + XML highlight as the kickoff turn
				     shown in the input view above), never the raw-JSON fallback below. -->
				{@const kickoff = coerceContextMessage(msg)}
				<MessageBlock
					msg={kickoff}
					collapsible={collapsibleFor(kickoff)}
					open={defaultOpen(kickoff)}
				/>
			{:else if isInjectedUserTurn(msg)}
				<!-- Injected user turns: interjections carry no `role` (just
				     `{ type:'interjection', content }`, see src/agent/messages.ts), while
				     forced-completion prompts arrive as `role:'user'` (src/agent/runner.ts).
				     Both render as distinct user-role injections (spec §10b). The record-turn
				     user prompt is filtered above (harness.kind === 'record_turn'). -->
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
		{/if}
	{/each}
	{#if rows.length === 0}
		<div class="text-sm text-muted-foreground">No rollout yet.</div>
	{/if}
</div>
