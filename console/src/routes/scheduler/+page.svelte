<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import { getSchedulerSnapshot, getLlmRequests } from '$lib/api/scheduler.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { cn } from '$lib/utils';
	import { formatTokens, formatUsd } from '$lib/format';

	// Scheduler view (spec LLM-FAILURE-HANDLING §9.1): "who is waiting on what,
	// and which model is down" — group budget cards beside model health badges,
	// above a unified waiters table and the recent Layer-0 attempt ring (§9.2).
	// Polling is sufficient per the spec; 2s keeps countdowns lively.
	const snapshot = createQuery(() => ({
		queryKey: keys.scheduler(),
		queryFn: () => fresh(getSchedulerSnapshot()),
		refetchInterval: 2000
	}));
	const requests = createQuery(() => ({
		queryKey: keys.llmRequests(),
		queryFn: () => fresh(getLlmRequests()),
		refetchInterval: 5000
	}));

	function fmtMs(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		// Floor both components: rounding the minutes would render 95.3s as
		// "2m35s" (should be "1m35s"), and rounding the seconds would render
		// 119.6s as "1m60s".
		return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
	}
	function fmtCountdown(epochMs: number): string {
		const delta = epochMs - Date.now();
		return delta <= 0 ? 'now' : fmtMs(delta);
	}
	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleTimeString();
	}

	const PRIORITY_CLASSES: Record<string, string> = {
		interactive: 'text-emerald-500',
		proactive: 'text-sky-500',
		background: 'text-muted-foreground',
		background_low: 'text-muted-foreground/60'
	};

	/** All waiters across groups, for the unified table. */
	const allWaiters = $derived(
		(snapshot.data?.groups ?? []).flatMap((g) =>
			g.queue.map((q) => ({ group: g.name, ...q }))
		)
	);
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
		{#if snapshot.isPending}
			<div class="h-24 animate-pulse rounded bg-muted"></div>
		{:else if snapshot.isError}
			<div class="text-sm text-destructive">{snapshot.error.message}</div>
		{:else if snapshot.data}
			<!-- Group cards (budget axis) + model health badges (failure domain) -->
			<div class="flex flex-wrap items-start gap-3">
				{#each snapshot.data.groups as group (group.name)}
					<div class="min-w-56 rounded-lg border p-3">
						<div class="flex items-baseline justify-between gap-3">
							<span class="font-mono text-sm font-semibold">{group.name}</span>
							<span class="font-mono text-xs text-muted-foreground" title="active / max_in_flight">
								{group.active.length}/{group.maxInFlight}
							</span>
						</div>
						{#if group.backoffUntil > 0}
							<div class="mt-1 text-xs text-amber-500" title="throttle backoff (429/503)">
								throttled — resumes in {fmtCountdown(group.backoffUntil)}
							</div>
						{/if}
						{#if group.queue.length > 0}
							<div class="mt-1 text-xs text-muted-foreground">{group.queue.length} queued</div>
						{/if}
						{#each group.active as entry, i (i)}
							<div class="mt-1 flex items-center gap-2 font-mono text-[11px]">
								<span class="size-1.5 rounded-full bg-blue-500"></span>
								<span class="truncate">{entry.sessionId ?? entry.sessionType ?? '—'}</span>
								<span class={cn(PRIORITY_CLASSES[entry.priority] ?? '')}>{entry.priority}</span>
								<span class="text-muted-foreground">{fmtMs(entry.heldMs)}</span>
							</div>
						{/each}
						{#if group.stickyEscalations.length > 0}
							<div class="mt-2 text-[10px] tracking-wide text-muted-foreground uppercase">
								sticky escalations
							</div>
							{#each group.stickyEscalations as esc (esc.key)}
								<div class="font-mono text-[11px]">
									{esc.key} → <span class={cn(PRIORITY_CLASSES[esc.priority] ?? '')}>{esc.priority}</span>
								</div>
							{/each}
						{/if}
					</div>
				{/each}

				{#each snapshot.data.models as model (model.key)}
					<div
						class={cn(
							'min-w-56 rounded-lg border p-3',
							model.health === 'unhealthy' ? 'border-red-500/50 bg-red-500/5' : ''
						)}
					>
						<div class="flex items-center gap-2">
							<span
								class={cn(
									'size-2 rounded-full',
									model.health === 'unhealthy' ? 'bg-red-500' : 'bg-emerald-500'
								)}
							></span>
							<span class="truncate font-mono text-xs" title={model.key}>{model.key}</span>
						</div>
						<div class="mt-1 flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
							<span title="consecutive environmental failures">streak {model.consecutiveFailures}</span>
							<span title="queued waiters on this model">waiters {model.waiters}</span>
						</div>
						{#if model.health === 'unhealthy'}
							<div class="mt-1 text-xs text-red-400">
								{#if model.probeInFlight}
									probe in flight…
								{:else}
									next probe {fmtCountdown(model.nextProbeAt)}
								{/if}
							</div>
						{/if}
						{#if model.lastFailure}
							<div class="mt-1 truncate text-[11px] text-muted-foreground" title="last failure">
								{fmtTime(model.lastFailure.ts)} · {model.lastFailure.status ?? '—'} · {model.lastFailure.class}
							</div>
						{/if}
					</div>
				{/each}

				{#if snapshot.data.models.length === 0}
					<div class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
						no model failures observed
					</div>
				{/if}
			</div>

			<!-- Unified waiters table -->
			<div>
				<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
					Waiters
				</div>
				{#if allWaiters.length === 0}
					<div class="text-xs text-muted-foreground">queue empty</div>
				{:else}
					<table class="w-full text-left font-mono text-[11px]">
						<thead class="text-muted-foreground">
							<tr>
								<th class="py-0.5 pr-3 font-normal">session</th>
								<th class="pr-3 font-normal">type</th>
								<th class="pr-3 font-normal">group</th>
								<th class="pr-3 font-normal">model</th>
								<th class="pr-3 font-normal">class</th>
								<th class="pr-3 font-normal">key</th>
								<th class="font-normal">waiting</th>
							</tr>
						</thead>
						<tbody>
							{#each allWaiters as waiter, i (i)}
								<tr class="border-t border-border/50">
									<td class="py-0.5 pr-3">
										{#if waiter.sessionId}
											<a class="underline-offset-2 hover:underline" href={`/?session=${waiter.sessionId}`}>
												{waiter.sessionId}
											</a>
										{:else}—{/if}
									</td>
									<td class="pr-3">{waiter.sessionType ?? '—'}</td>
									<td class="pr-3">{waiter.group}</td>
									<td class="max-w-48 truncate pr-3" title={waiter.model ?? undefined}>{waiter.model ?? '—'}</td>
									<td class={cn('pr-3', PRIORITY_CLASSES[waiter.priority] ?? '')}>{waiter.priority}</td>
									<td class="pr-3">{waiter.key ?? '—'}</td>
									<td>{fmtMs(waiter.waitingMs)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/if}

		<!-- Recent Layer-0 attempts (the in-memory ring, §9.2) -->
		<div>
			<div class="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
				Recent LLM requests
			</div>
			{#if requests.isPending}
				<div class="h-16 animate-pulse rounded bg-muted"></div>
			{:else if requests.isError}
				<div class="text-xs text-destructive">{requests.error.message}</div>
			{:else if (requests.data?.requests.length ?? 0) === 0}
				<div class="text-xs text-muted-foreground">no requests recorded yet</div>
			{:else}
				<table class="w-full text-left font-mono text-[11px]">
					<thead class="text-muted-foreground">
						<tr>
							<th class="py-0.5 pr-3 font-normal">time</th>
							<th class="pr-3 font-normal">session</th>
							<th class="pr-3 font-normal">type</th>
							<th class="pr-3 font-normal">model</th>
							<th class="pr-3 font-normal">class</th>
							<th class="pr-3 font-normal">att</th>
							<th class="pr-3 font-normal">queue</th>
							<th class="pr-3 font-normal">total</th>
							<th class="pr-3 font-normal">ctx</th>
							<th class="pr-3 font-normal">tok</th>
							<th class="pr-3 font-normal">cost</th>
							<th class="font-normal">outcome</th>
						</tr>
					</thead>
					<tbody>
						{#each requests.data!.requests as request, i (i)}
							<tr class="border-t border-border/50">
								<td class="py-0.5 pr-3 whitespace-nowrap">{fmtTime(request.ts)}</td>
								<td class="pr-3">{request.sessionId ?? '—'}</td>
								<td class="pr-3">{request.sessionType ?? '—'}</td>
								<td class="max-w-40 truncate pr-3" title={request.model}>{request.model}</td>
								<td class={cn('pr-3', PRIORITY_CLASSES[request.priority ?? ''] ?? '')}>
									{request.priority ?? '—'}
								</td>
								<td class="pr-3">{request.attempt}</td>
								<td class="pr-3">{request.admissionWaitMs != null ? fmtMs(request.admissionWaitMs) : '—'}</td>
								<td class="pr-3">{fmtMs(request.durationMs)}</td>
								<!-- Usage columns (spec TOKEN-USAGE-TRACKING §7.4): committed (done)
								     rows only; ctx = context size, tok = in/out summary, cost = USD. -->
								<td class="pr-3 tabular-nums">{request.usage ? formatTokens(request.usage.totalTokens) : '—'}</td>
								<td
									class="pr-3 tabular-nums"
									title={request.usage
										? `input ${request.usage.input} · output ${request.usage.output} · cache read ${request.usage.cacheRead} · cache write ${request.usage.cacheWrite}`
										: undefined}
								>
									{request.usage
										? `${formatTokens(request.usage.input)}/${formatTokens(request.usage.output)}`
										: '—'}
								</td>
								<td class="pr-3 tabular-nums">{request.usage ? formatUsd(request.usage.cost) : '—'}</td>
								<td
									class={cn(
										request.outcome === 'done'
											? 'text-emerald-500'
											: request.outcome === 'aborted'
												? 'text-muted-foreground'
												: 'text-red-400'
									)}
									title={request.errorMessage}
								>
									{request.outcome}{request.status ? ` ${request.status}` : ''}{request.class && request.outcome !== 'done' ? ` (${request.class})` : ''}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</div>
</div>
