<script lang="ts">
	import {
		assistantBlocks,
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
	import {
		CONTINUATION,
		LIVE_BRANCH,
		buildBranchTree,
		forkKey,
		nodeOfToolCall,
		selectionFor
	} from '$lib/branches';
	import { buildBranchPlan } from '$lib/branch-plan';
	import { evaluationsForCall, eventsForEvaluation, gateEvaluations } from '$lib/checks';
	import { interjectionKindOf, isEstimated } from '$lib/late-input';
	import AssistantTextCard from './AssistantTextCard.svelte';
	import ThinkingCard from './ThinkingCard.svelte';
	import ToolCallCard from './ToolCallCard.svelte';
	import HarnessCallRow from './HarnessCallRow.svelte';
	import DecisionCard from './DecisionCard.svelte';
	import RecordTurnSection from './RecordTurnSection.svelte';
	import InterjectionCard from './InterjectionCard.svelte';
	import GateCard from './GateCard.svelte';
	import ForkMarker from './ForkMarker.svelte';
	import NudgeCard from './NudgeCard.svelte';
	import HardRefusalMarker from './HardRefusalMarker.svelte';
	import MessageBlock from '$lib/components/verbatim/MessageBlock.svelte';
	import type {
		CheckInfo,
		DecisionEvaluation,
		RefusalEvent,
		SessionBranch,
		SessionAudit,
		SessionContract,
		SessionInterjection,
		ToolInvocation
	} from '$lib/schemas';

	// `toolUsage` maps a tool-call id → its auxiliary usage ledger row (spec
	// AUXILIARY-USAGE-TRACKING §10.3) so a tool-call block can be annotated with its
	// own spend (today image_generate). Empty for live rollouts (ledger is durable).
	// `decisionEvaluations` — all decision_evaluations rows for the session; the
	// render plan interleaves decision cards at the right positions (spec §8), and
	// the `checks` rows become gate / ending cards on the judged output.
	// Refusal handling (spec REFUSAL-HANDLING §12.1–§12.2): `messages` is the live
	// branch's rollout slice and `liveStart` its index in the live transcript;
	// `branches` the discarded spans, shown through `‹ x/y ›` switchers at their
	// fork points (the latest branch by default); `focus` deep-links a branch and
	// a tool call or ending attempt (the incident log's links).
	let {
		messages,
		toolUsage,
		decisionEvaluations,
		liveStart = 0,
		branches = [],
		refusalEvents = [],
		contract,
		checks = [],
		audits = [],
		interjections = [],
		focus
	}: {
		messages: readonly unknown[];
		toolUsage?: Map<string, ToolInvocation>;
		decisionEvaluations?: DecisionEvaluation[];
		liveStart?: number;
		branches?: readonly SessionBranch[];
		refusalEvents?: readonly RefusalEvent[];
		contract?: SessionContract;
		checks?: readonly CheckInfo[];
		/** The offline audit's rows (nudge cards' diagnosis chips and after-correction verdict). */
		audits?: readonly SessionAudit[];
		/** The session's interjection rows: the kind each interjection card is labelled with. */
		interjections?: readonly SessionInterjection[];
		focus?: { branchNo?: number | null; toolCallId?: string | null; attemptNo?: number | null } | null;
	} = $props();

	// Fork choices the operator made with the switchers (fork key → option).
	// Declared before every derived that reads it (initialization order).
	let chosen = $state<Record<string, number>>({});

	const tree = $derived(buildBranchTree(messages, liveStart, branches));
	const focusKey = $derived(
		focus ? `${focus.branchNo ?? ''}|${focus.toolCallId ?? ''}|${focus.attemptNo ?? ''}` : ''
	);
	// The branch a deep link points at: its branch number, else the branch holding the call.
	const focusBranch = $derived.by(() => {
		if (!focus) return undefined;
		if (focus.branchNo != null && tree.nodes.has(focus.branchNo)) return focus.branchNo;
		if (focus.toolCallId) return nodeOfToolCall(tree, focus.toolCallId);
		return undefined;
	});
	const selection = $derived.by(() => {
		const map =
			focusBranch !== undefined && focusBranch !== LIVE_BRANCH
				? selectionFor(tree, focusBranch)
				: new Map<string, number>();
		for (const [key, option] of Object.entries(chosen)) map.set(key, option);
		return map;
	});
	// A new deep link resets the operator's switcher choices.
	let lastFocusKey = '';
	$effect(() => {
		if (focusKey !== lastFocusKey) {
			lastFocusKey = focusKey;
			chosen = {};
		}
	});

	const gate = $derived(gateEvaluations(decisionEvaluations ?? [], checks));
	const plan = $derived(
		buildBranchPlan({
			tree,
			selection,
			evaluations: decisionEvaluations ?? [],
			gate,
			refusalEvents,
			contract,
			audits
		})
	);
	const shown = $derived(plan.flatMap((item) => (item.type === 'message' ? [item.msg] : [])));
	const toolResults = $derived(collectToolResults(shown));

	function recordOutcome(msg: RolloutMsg): string | undefined {
		const meta = msg.harness as { status?: string; reason?: string } | undefined;
		if (meta?.status) return `${meta.status}${meta.reason ? ` · ${meta.reason.replaceAll('_', ' ')}` : ''}`;
		// Older persisted sessions have no outcome marker. Their terminal response
		// still establishes that the record turn ended without completing.
		const index = shown.indexOf(msg);
		for (const next of shown.slice(index + 1)) {
			if (getHarness(next)?.kind === 'record_turn') break;
			if (next.role === 'assistant' && (next.stopReason === 'aborted' || next.stopReason === 'error'))
				return `failed · request ${next.stopReason}`;
		}
		return undefined;
	}

	function choose(key: string, option: number): void {
		chosen = { ...chosen, [key]: option };
	}

	/** From a discarded branch, show the alternative that redid it (the next option at its fork). */
	function showRedoOf(node: number): (() => void) | undefined {
		const anchor = tree.nodes.get(node)?.anchor;
		if (!anchor) return undefined;
		const key = forkKey(anchor.parent, anchor.offset);
		const options = [...(tree.forks.get(key) ?? []), CONTINUATION];
		const next = options[options.indexOf(node) + 1];
		return next === undefined ? undefined : () => choose(key, next);
	}

	// Scroll a deep-linked tool call (or ending attempt) into view once per link.
	let scrolledFor = '';
	$effect(() => {
		void plan;
		if (!focus || !focusKey || scrolledFor === focusKey) return;
		const id = focus.toolCallId
			? `toolcall-${focus.toolCallId}`
			: focus.attemptNo != null && focusBranch !== undefined
				? `attempt-${focusBranch}-${focus.attemptNo}`
				: null;
		if (!id || typeof document === 'undefined') return;
		const el = document.getElementById(id);
		if (!el) return;
		scrolledFor = focusKey;
		el.scrollIntoView?.({ block: 'center' });
	});
</script>

<div class="space-y-2 p-3">
	{#each plan as item (item.key)}
		{#if item.type === 'decision'}
			<DecisionCard
				evaluations={item.evaluations}
				injected={item.injected}
				elementId={decisionElementId(item.decisionGroup)}
			/>
		{:else if item.type === 'fork'}
			<ForkMarker info={item.info} {checks} maxNudges={contract?.maxNudges ?? null} onSelect={choose} />
		{:else if item.type === 'hard_refusal'}
			<HardRefusalMarker event={item.event} />
		{:else if item.type === 'ending'}
			<GateCard
				evaluation={item.evaluation}
				variant="ending"
				events={eventsForEvaluation(refusalEvents, item.evaluation)}
				onShowRedo={showRedoOf(item.node)}
			/>
		{:else}
			{@const msg = item.msg}
			{@const harness = getHarness(msg)}

			{#if item.nudge}
				<!-- A send-contract nudge (spec REFUSAL-HANDLING §12.2): its number, the
				     closed attempt's failure types, and for a recovered run the diff. -->
				<NudgeCard
					nudge={item.nudge}
					text={contentText(msg.content)}
					elementId={`attempt-${item.node}-${item.nudge.attempt?.attemptNo ?? item.nudge.index - 1}`}
				/>
			{:else if msg.role === 'assistant' && harness?.kind === 'refusal_withheld'}
				<!-- A withheld refusal (spec REFUSAL-HANDLING §8.2 on_exhausted = "withhold"):
				     every rule entry refused, nothing was sent, the run settled as NO_REPLY. -->
				<div
					data-testid="refusal-withheld"
					class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs"
				>
					<span class="text-[10px] font-semibold tracking-wide text-red-600 uppercase dark:text-red-400"
						>refusal withheld</span
					>
					<span class="text-muted-foreground">
						Every rule entry refused; nothing was sent and the run ended as NO_REPLY.</span
					>
				</div>
			{:else if harness?.kind === 'record_turn'}
				<!-- The harness record-turn user prompt: a section header, with the prompt
				     itself collapsed and marked harness-made. -->
				<RecordTurnSection prompt={contentText(msg.content)} outcome={recordOutcome(msg)} />
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
				{#if msg.stopReason === 'aborted' || msg.stopReason === 'error'}
					<div class="my-1 rounded border border-red-500/30 p-2 text-xs text-red-500" data-testid="request-failed">Request {msg.stopReason === 'aborted' ? 'aborted' : 'failed'} · partial response; unfinished tool calls were not executed.</div>
				{/if}
				{#each assistantBlocks(msg.content) as block, b (b)}
					{#if block.type === 'text'}
						<AssistantTextCard text={block.text} />
					{:else if block.type === 'thinking'}
						<ThinkingCard thinking={block.thinking} redacted={block.redacted} />
					{:else if block.type === 'toolCall'}
						<div
							id={`toolcall-${block.id}`}
							class="scroll-mt-10 rounded-md {focus?.toolCallId === block.id ? 'ring-2 ring-sky-500/60' : ''}"
						>
							<ToolCallCard
								name={block.name}
								args={block.arguments}
								result={toolResults.get(block.id)}
								usage={toolUsage?.get(block.id)}
								requestFailed={msg.stopReason === 'aborted' || msg.stopReason === 'error'}
								discarded={item.node !== LIVE_BRANCH}
							/>
						</div>
						<!-- The output gate's verdict on this call (spec REFUSAL-HANDLING §12.2). -->
						{#each evaluationsForCall(gate, block.id, item.node) as evaluation (evaluation.decisionGroup)}
							<GateCard
								{evaluation}
								variant={evaluation.checkpoint === 'ending' ? 'ending' : 'gate'}
								events={eventsForEvaluation(refusalEvents, evaluation)}
								result={toolResults.get(block.id)}
								args={block.arguments}
								onShowRedo={showRedoOf(item.node)}
							/>
						{/each}
					{/if}
				{/each}
				<!-- Per-request usage (spec TOKEN-USAGE-TRACKING §7.3): attached once at the
				     assistant-message group level, since the usage belongs to the request that
				     produced the whole message. `ctx` is that request's totalTokens (the context
				     size reached at this point). Messages without real usage render nothing. -->
				{@const u = messageUsage(msg)}
				{@const estimated = isEstimated((msg.usage as { estimated?: unknown } | undefined)?.estimated)}
				{#if u}
					<div
						class="px-1 font-mono text-[10px] tabular-nums text-muted-foreground"
						title={`context ${u.totalTokens} tokens · input ${u.input} · output ${u.output} · cache read ${u.cacheRead} · cache write ${u.cacheWrite} · cost ${u.cost}${estimated ? ' · estimated (aborted stream)' : ''}`}
					>
						{#if estimated}<span
								data-testid="usage-estimated"
								class="mr-1 rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-300">estimated</span
							>{/if}
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
				<InterjectionCard text={contentText(msg.content)} kind={interjectionKindOf(msg, interjections)} />
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
	{#if shown.length === 0}
		<div class="text-sm text-muted-foreground">No rollout yet.</div>
	{/if}
</div>
