<script lang="ts">
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
  import TopBar from '$lib/components/layout/TopBar.svelte';
  import { getExaHealth, getExaJobs } from '$lib/api/exa.remote';
  import { fresh } from '$lib/query/client';
  import { conversationsHref } from '$lib/nav';
  let cursor = $state<string | undefined>(undefined);
  const health = createQuery(() => ({ queryKey: ['exa-health'], queryFn: () => fresh(getExaHealth()), refetchInterval: 5000 }));
  const jobs = createQuery(() => ({ queryKey: ['exa-jobs', cursor], queryFn: () => fresh(getExaJobs(cursor ? {cursor} : {})), placeholderData: keepPreviousData, refetchInterval: 5000 }));
  const when = (ts: number) => ts ? new Date(ts).toLocaleString() : '—';
</script>
<div class="flex h-screen flex-col">
  <TopBar />
  <main class="min-h-0 flex-1 space-y-4 overflow-auto p-4">
    <h1 class="text-lg font-semibold">Exa research</h1>
    <p class="text-sm text-muted-foreground">Research waits in its original tool call. Aborting a local wait preserves the remote job; completion sends no automatic message.</p>
    {#if health.isError}<p role="alert" class="text-sm text-red-500">Unable to load Exa health: {health.error.message}</p>{/if}
    {#if health.data}
      <div class="rounded border p-3 text-sm">
        <p>Native Exa: {health.data.enabled ? 'enabled' : 'disabled'} · Research: {health.data.researchEnabled ? 'enabled' : 'disabled'}</p>
        {#if health.data.health}
          <p>Account: {health.data.health.account.state}{health.data.health.account.reason ? ` · ${health.data.health.account.reason}` : ''}{health.data.health.account.probing ? ' · recovery probe in flight' : ''} · last observed {when(health.data.health.account.lastObserved ?? 0)}</p>
          {#if health.data.health.account.state === 'open'}<p>Account retry: {when(health.data.health.account.retryAt)}</p>{/if}
          {#if health.data.health.cooldownUntil > Date.now()}<p>Rate-limit cooldown until {when(health.data.health.cooldownUntil)}</p>{/if}
          <div class="mt-2 flex flex-wrap gap-3">
            {#each Object.entries(health.data.health.endpoints) as [scope, circuit]}
              <p>{scope}: {circuit.state}{circuit.reason ? ` · ${circuit.reason}` : ''}{circuit.probing ? ' · probing' : ''} · last observed {when(circuit.lastObserved ?? 0)}{circuit.state === 'open' ? ` · retry ${when(circuit.retryAt)}` : ''}</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <h2 class="font-medium">Research jobs{jobs.data ? ` (${jobs.data.total})` : ''}</h2>
    {#if jobs.isError}<p role="alert" class="text-sm text-red-500">Unable to load research jobs: {jobs.error.message}</p>{/if}
    {#if jobs.data}
      {#if !jobs.data.jobs.length}<p class="text-sm text-muted-foreground">No research jobs recorded.</p>{/if}
      <div class="space-y-3">
        {#each jobs.data.jobs as job (job.id)}
          <article class="space-y-1 rounded border p-3 text-sm">
            <div class="flex flex-wrap justify-between gap-2"><strong>{job.status}{job.stopReason ? ` · ${job.stopReason}` : ''}</strong><span>{job.cost === null ? 'Cost unknown' : `$${job.cost.toFixed(4)} · ${job.costProvenance}`} · {job.accounted ? 'accounted' : 'accounting pending'}</span></div>
            <p>{job.query}</p>
            <p class="text-xs text-muted-foreground">{job.agent ?? 'legacy agent'} · {job.effort} effort · {job.timelineKey} · requester {job.requesterId ?? 'unknown'}</p>
            <p class="text-xs text-muted-foreground">Created {when(job.createdAt)} · Updated {when(job.updatedAt)}</p>
            <a class="text-xs underline" href={conversationsHref({agent: job.agent, room:job.timelineKey, session:job.sessionId})}>Origin session</a>
            <span class="ml-2 font-mono text-xs">{job.id}</span>
            {#if job.lastError}<p class="text-xs text-amber-600">{job.lastError}</p>{/if}
          </article>
        {/each}
      </div>
      <div class="flex gap-3 text-sm">
        {#if cursor}<button class="underline" onclick={() => cursor = undefined}>Newest jobs</button>{/if}
        {#if jobs.data.nextCursor}<button class="underline" disabled={jobs.isFetching} onclick={() => cursor = jobs.data?.nextCursor ?? undefined}>Older jobs</button>{/if}
      </div>
    {:else if jobs.isPending}<p class="text-sm">Loading research jobs…</p>{/if}
  </main>
</div>
