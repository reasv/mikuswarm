<script lang="ts">
	import { selection } from '$lib/stores/selection.svelte';
	import { sessionQuery } from '$lib/query/sessions';
	import { sessionRecordQuery, sessionDecisionsQuery } from '$lib/query/session-record';
	import { agentsQuery } from '$lib/query/agents';
	import { formatTokens, formatUsd } from '$lib/format';
	import { cn } from '$lib/utils';
	import { buildAgentLookup, agentFor, agentAccent } from '$lib/agents';
	import { extractRecordsGiven } from '$lib/rollout';

	// Col 3 — the session inspector (ARCHITECTURE.md §11). Driven by the same
	// `?session=` selection as Col 2, it surfaces the raw record behind the rendered
	// rollout: identifiers, timing, the full token + cost breakdown across both lanes,
	// the auxiliary tool-invocation ledger, the context-dump path, and a raw-JSON view.
	// Everything comes from the `getSession` payload the SessionView already loads
	// (TanStack dedupes the shared query key), so this adds no extra fetch. Nothing is
	// selected → a neutral prompt, not a promise.
	const activeId = $derived(selection.sessionId);
	const session = sessionQuery(() => activeId);
	const meta = $derived(session.data?.session);
	const invocations = $derived(session.data?.toolInvocations ?? []);

	// Session-records sections (spec SESSION-RECORDS §8, "Details pane"):
	// - sessionRecord: this session's own record row (null if none exists yet)
	// - decisionsQ: all decision evaluations for this session, grouped by decisionGroup
	// - recordsGiven: sessions whose records were injected into this session (parsed
	//   from the transcript by extractRecordsGiven)
	const sessionRecord = sessionRecordQuery(() => activeId);
	const decisionsQ = sessionDecisionsQuery(() => activeId);
	const decisionGroups = $derived(() => {
		const evs = decisionsQ.data?.evaluations ?? [];
		const map = new Map<string, (typeof evs)[number][]>();
		for (const ev of evs) {
			map.set(ev.decisionGroup, [...(map.get(ev.decisionGroup) ?? []), ev]);
		}
		return map;
	});
	const recordsGiven = $derived(
		session.data?.transcript ? extractRecordsGiven(session.data.transcript) : []
	);

	let rawOpen = $state(false);

	// ── Agent row in Identifiers (spec CONSOLE-MULTI-AGENT §4) ──────────────────
	// Under the global gate, add an `agent` row derived from meta.timelineKey.
	const agentsQ = agentsQuery();
	const agentsData = $derived(agentsQ.data);
	const globalGate = $derived(
		agentsData?.mode === 'agents' && (agentsData.agents.length ?? 0) > 1
	);
	const agentLookup = $derived(
		agentsData && globalGate ? buildAgentLookup(agentsData) : new Map()
	);
	// Resolved only when gate is open and meta is available.
	const resolvedAgent = $derived(
		globalGate && meta?.timelineKey ? agentFor(meta.timelineKey, agentLookup) : undefined
	);
	const agentAccentColor = $derived(resolvedAgent ? agentAccent(resolvedAgent.agentIndex) : undefined);

	function fmtTime(ts: number | null | undefined): string {
		return ts == null ? '—' : new Date(ts).toLocaleString();
	}
	function fmtDuration(a: number | null | undefined, b: number | null | undefined): string {
		if (a == null || b == null || b < a) return '—';
		const s = Math.round((b - a) / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
	}
	const STATE_BADGE: Record<string, string> = {
		completed: 'bg-emerald-500/15 text-emerald-500',
		running: 'bg-blue-500/15 text-blue-500',
		'failed-resumable': 'bg-amber-500/15 text-amber-500',
		interrupted: 'bg-amber-500/15 text-amber-500',
		failed: 'bg-red-500/15 text-red-400'
	};
</script>

<div class="flex h-full flex-col border-l">
	<div class="shrink-0 px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Detail
	</div>

	{#if !activeId}
		<div class="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
			Select a session to inspect its record.
		</div>
	{:else if session.isPending}
		<div class="space-y-2 p-3">
			{#each Array(5) as _, i (i)}
				<div class="h-8 animate-pulse rounded bg-muted"></div>
			{/each}
		</div>
	{:else if session.isError}
		<div class="p-4 text-sm text-destructive">{session.error.message}</div>
	{:else if meta}
		<div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-4 text-xs">
			<!-- Status + type -->
			<div class="flex flex-wrap items-center gap-1.5">
				<span class={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', STATE_BADGE[meta.status] ?? 'bg-muted text-muted-foreground')}>
					{meta.status}
				</span>
				<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{meta.sessionType}</span>
				{#if meta.noReply}
					<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">no reply</span>
				{/if}
			</div>

			{#if meta.error}
				<div class="rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-400">
					{meta.error}
				</div>
			{/if}

			<!-- Identifiers section — modified to include the agent row when gate is open. -->
			<div>
				<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Identifiers</div>
				<div class="space-y-1 font-mono text-[11px]">
					{@render kv('session', meta.id)}
					{@render kv('model', meta.modelId ?? '—')}
					{#if globalGate}
						<!-- Agent row (§4): accent-colored chip when resolvable, muted "unassigned"
						     when the key is not in the current config (§4.3). -->
						<div class="flex items-baseline justify-between gap-2">
							<span class="text-muted-foreground">agent</span>
							{#if resolvedAgent}
								<span class="inline-flex items-baseline gap-0.5 text-right">
									<span
										class="relative top-px inline-block size-1.5 rounded-full"
										style="background:{agentAccentColor}"
									></span>
									<span style="color:{agentAccentColor}">{resolvedAgent.agentName}</span>
								</span>
							{:else}
								<span class="text-right text-muted-foreground/50">unassigned</span>
							{/if}
						</div>
					{/if}
					{@render kv('timeline', meta.timelineKey)}
					{@render kv('trigger event', meta.triggerEventId ?? '—')}
					{@render kv('external id', meta.triggerExternalId ?? '—')}
				</div>
			</div>

			{@render section('Timing', [
				['created', fmtTime(meta.createdAt)],
				['started', fmtTime(meta.startedAt)],
				['completed', fmtTime(meta.completedAt)],
				['duration', fmtDuration(meta.startedAt, meta.completedAt)]
			])}

			<!-- Agent-loop actuals (spec TOKEN-USAGE-TRACKING §7.2) -->
			<div>
				<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Agent-loop usage</div>
				<div class="space-y-1 font-mono text-[11px]">
					{@render kv('requests', String(meta.llmRequests ?? 0))}
					{@render kv('context', meta.contextTokens != null ? `${formatTokens(meta.contextTokens)}${meta.maxContextTokens ? ` / ${formatTokens(meta.maxContextTokens)}` : ''}` : '—')}
					{#if meta.usage}
						{@render kv('input', formatTokens(meta.usage.input))}
						{@render kv('output', formatTokens(meta.usage.output))}
						{@render kv('cache read', formatTokens(meta.usage.cacheRead))}
						{@render kv('cache write', formatTokens(meta.usage.cacheWrite))}
						{@render kv('cost', formatUsd(meta.usage.cost))}
					{:else}
						<div class="text-[11px] text-muted-foreground">no committed request yet</div>
					{/if}
				</div>
			</div>

			<!-- Auxiliary tool-spend lane (spec §10.3), kept separate from the loop figures -->
			{#if meta.toolUsage && meta.toolUsage.calls > 0}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Tool spend (separate lane)</div>
					<div class="space-y-1 font-mono text-[11px]">
						{@render kv('calls', String(meta.toolUsage.calls))}
						{@render kv('input', formatTokens(meta.toolUsage.inputTokens))}
						{@render kv('output', formatTokens(meta.toolUsage.outputTokens))}
						{@render kv('cost', formatUsd(meta.toolUsage.cost))}
					</div>
				</div>
			{/if}

			{#if meta.maxSessionCostUsd != null}
				<div class="font-mono text-[11px]">
					{@render kv('session ceiling', formatUsd(meta.maxSessionCostUsd))}
				</div>
			{/if}

			<!-- Auxiliary tool-invocation ledger (spec §10.3): the per-call rows behind the
			     rollout's tool cards — image-gen and other paid tool calls. -->
			{#if invocations.length > 0}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
						Tool invocations ({invocations.length})
					</div>
					<div class="space-y-1.5">
						{#each invocations as inv (inv.id)}
							<div class="rounded border bg-card px-2 py-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="font-mono text-[11px] font-semibold">{inv.toolName}</span>
									{#if inv.cost != null}<span class="font-mono text-[10px] text-muted-foreground">{formatUsd(inv.cost)}</span>{/if}
								</div>
								<div class="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted-foreground">
									{#if inv.modelId}<span>{inv.modelId}</span>{/if}
									{#if inv.images != null}<span>· img {inv.images}</span>{/if}
									{#if inv.input != null}<span>· in {formatTokens(inv.input)}</span>{/if}
									{#if inv.output != null}<span>· out {formatTokens(inv.output)}</span>{/if}
									{#if inv.ref}<span>· {inv.ref}</span>{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Model prompts (per-model preamble/tail) the served members sent. -->
			{#if session.data?.modelPrompts && session.data.modelPrompts.length > 0}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Model prompts</div>
					<div class="space-y-1 font-mono text-[11px]">
						{#each session.data.modelPrompts as mp (mp.member + ':' + mp.profile + ':' + (mp.hash ?? ''))}
							{@render kv(mp.member, `${mp.profile}${mp.hash ? ` #${mp.hash}` : ''} · ${mp.requests} req`)}
						{/each}
					</div>
				</div>
			{/if}

			<!-- Decisions (spec SESSION-RECORDS §8): one row per decision group with a
			     scroll-jump link to the inline card in the rollout. -->
			{#if decisionsQ.data && decisionsQ.data.evaluations.length > 0}
				{@const groups = decisionGroups()}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Decisions ({groups.size})</div>
					<div class="space-y-1">
						{#each [...groups.entries()] as [dg, evs] (dg)}
							{@const first = evs[0]}
							<div class="flex items-center justify-between gap-2 font-mono text-[11px]">
								<div class="min-w-0 flex-1">
									<span class="text-muted-foreground">{first?.point ?? '?'}</span>
									{#if first?.source === 'heuristic'}
										<span class="ml-1 rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">heuristic</span>
									{/if}
								</div>
								<a
									href={'#decision-' + dg}
									class="shrink-0 text-[10px] text-violet-400 hover:text-violet-300"
									title={dg}
								>↗ rollout</a>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Session record (spec SESSION-RECORDS §3): the record written at the end
			     of this session's work; null when the session produced no record yet. -->
			{#if sessionRecord.data?.sessionRecord}
				{@const rec = sessionRecord.data.sessionRecord}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Session record</div>
					<div class="space-y-1 font-mono text-[11px]">
						{@render kv('tokens', String(rec.tokenCount))}
						{#if rec.modelId}{@render kv('model', rec.modelId)}{/if}
						{#if rec.buildsOn.length > 0}
							<div class="flex items-baseline justify-between gap-2">
								<span class="text-muted-foreground">builds on</span>
								<div class="flex flex-col items-end gap-0.5">
									{#each rec.buildsOn as bid (bid)}
										<a
											href={'?session=' + encodeURIComponent(bid)}
											class="break-all text-right text-violet-400 hover:text-violet-300"
										>{bid}</a>
									{/each}
								</div>
							</div>
						{/if}
					</div>
					<details class="mt-1">
						<summary class="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">record text</summary>
						<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[10px] leading-relaxed">{rec.text}</pre>
					</details>
				</div>
			{/if}

			<!-- Records given (spec SESSION-RECORDS §4): session records that were
			     injected into this session's context (derived from the transcript). -->
			{#if recordsGiven.length > 0}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Records given ({recordsGiven.length})</div>
					<div class="space-y-1">
						{#each recordsGiven as r (r.sessionId)}
							<div class="font-mono text-[11px]">
								<a
									href={'?session=' + encodeURIComponent(r.sessionId)}
									class="text-violet-400 hover:text-violet-300"
								>{r.sessionId}</a>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if session.data?.contextDumpPath}
				<div>
					<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Context dump</div>
					<code class="block break-all rounded bg-muted px-2 py-1 font-mono text-[10px]">{session.data.contextDumpPath}</code>
				</div>
			{/if}

			<!-- Raw record (collapsed) — the decoded session meta, for when the shaped view
			     isn't enough. -->
			<div>
				<button
					type="button"
					class="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
					onclick={() => (rawOpen = !rawOpen)}
				>
					{rawOpen ? '▾' : '▸'} Raw record
				</button>
				{#if rawOpen}
					<pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-[10px] leading-relaxed">{JSON.stringify(meta, null, 2)}</pre>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#snippet kv(label: string, value: string)}
	<div class="flex items-baseline justify-between gap-2">
		<span class="text-muted-foreground">{label}</span>
		<span class="text-right break-all text-foreground">{value}</span>
	</div>
{/snippet}

{#snippet section(title: string, rows: [string, string][])}
	<div>
		<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
		<div class="space-y-1 font-mono text-[11px]">
			{#each rows as [label, value] (label)}
				{@render kv(label, value)}
			{/each}
		</div>
	</div>
{/snippet}
