<script lang="ts">
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import {
		getBackfetchJobs,
		startBackfetchJob,
		pauseBackfetchJob,
		resumeBackfetchJob,
		cancelBackfetchJob,
		promoteBackfetchCaptions
	} from '$lib/api/backfetch.remote';
	import { fresh } from '$lib/query/client';
	import { keys } from '$lib/query/keys';
	import { cn } from '$lib/utils';
	import RoomPicker from '$lib/components/RoomPicker.svelte';

	// Message-only history backfetch (ARCHITECTURE.md §7d): operator-triggered jobs
	// that page a room's history BELOW its context floor into the SEARCH-ONLY region
	// — indexed + enriched for search/recap/stats, never summarized/journaled/
	// rendered, and the room's perceived beginning-of-history never moves. Polled.
	const queryClient = useQueryClient();
	const jobsQuery = createQuery(() => ({
		queryKey: keys.backfetchJobs(),
		queryFn: () => fresh(getBackfetchJobs()),
		refetchInterval: 3000
	}));

	const jobs = $derived(jobsQuery.data?.jobs ?? []);
	const enabled = $derived(jobsQuery.data?.enabled ?? false);

	const STATUS_CLASSES: Record<string, string> = {
		queued: 'text-sky-500',
		running: 'text-blue-500',
		paused: 'text-amber-500',
		completed: 'text-emerald-500',
		failed: 'text-red-500',
		cancelled: 'text-muted-foreground'
	};

	// --- start form state ---
	let timelineKey = $state('');
	let targetKind = $state<'beginning' | 'date' | 'oldest_decryptable' | 'count'>('beginning');
	let targetValue = $state('');
	let captionAfter = $state(false);
	let safetyCap = $state('');
	let timeoutMin = $state('');
	let starting = $state(false);

	const needsValue = $derived(targetKind === 'date' || targetKind === 'count');

	function invalidate() {
		queryClient.invalidateQueries({ queryKey: keys.backfetchJobs() });
	}

	async function start() {
		if (starting) return;
		if (!timelineKey.trim()) {
			toast.error('Enter a base room/dm timeline key');
			return;
		}
		starting = true;
		try {
			await startBackfetchJob({
				timelineKey: timelineKey.trim(),
				targetKind,
				targetValue: needsValue ? targetValue.trim() || null : null,
				captionAfter,
				safetyCap: safetyCap ? Number(safetyCap) : undefined,
				timeoutMs: timeoutMin ? Number(timeoutMin) * 60_000 : undefined
			});
			toast.success('Backfetch job started');
			timelineKey = '';
			targetValue = '';
		} catch (err) {
			toast.error('Could not start job', { description: messageOf(err) });
		} finally {
			starting = false;
			invalidate();
		}
	}

	async function act(
		label: string,
		fn: () => Promise<unknown>,
		ok: string
	): Promise<void> {
		try {
			await fn();
			toast.success(ok);
		} catch (err) {
			toast.error(`${label} failed`, { description: messageOf(err) });
		} finally {
			invalidate();
		}
	}

	async function promote(key: string): Promise<void> {
		try {
			const res = (await promoteBackfetchCaptions({ timelineKey: key })) as { promoted: number };
			toast.success(`Promoted ${res.promoted} caption${res.promoted === 1 ? '' : 's'}`);
		} catch (err) {
			toast.error('Caption promote failed', { description: messageOf(err) });
		}
	}

	function messageOf(err: unknown): string {
		const m = (err as { body?: { message?: string }; message?: string })?.body?.message;
		return m ?? (err as { message?: string })?.message ?? 'unknown error';
	}

	function fmtTime(ts: number | null): string {
		return ts ? new Date(ts).toLocaleString() : '—';
	}

	function targetLabel(kind: string, value: string | null): string {
		if (kind === 'date') return `date < ${value ?? '?'}`;
		if (kind === 'count') return `${value ?? '?'} messages`;
		if (kind === 'oldest_decryptable') return 'oldest decryptable';
		return 'beginning';
	}
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
		{#if !enabled}
			<div class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600">
				Message backfetch is <strong>disabled</strong> (<code>[backfetch] enabled = false</code>).
				Jobs can be listed but not started until it is enabled in config.
			</div>
		{/if}

		<!-- Start a new job -->
		<section class="space-y-2 rounded-md border p-3">
			<h2 class="text-sm font-medium">Start a backfetch</h2>
			<p class="text-xs text-muted-foreground">
				Pages history below the room's oldest stored message into the search-only region.
				Single-flight: one active job per room.
			</p>
			<div class="flex flex-wrap items-end gap-2 text-xs">
				<label class="flex flex-col gap-1">
					<span class="text-muted-foreground">base room</span>
					<RoomPicker bind:value={timelineKey} placeholder="select or type a room" />
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-muted-foreground">target</span>
					<select bind:value={targetKind} class="rounded border bg-background px-2 py-1">
						<option value="beginning">beginning</option>
						<option value="date">date</option>
						<option value="oldest_decryptable">oldest decryptable</option>
						<option value="count">count</option>
					</select>
				</label>
				{#if needsValue}
					<label class="flex flex-col gap-1">
						<span class="text-muted-foreground">{targetKind === 'date' ? 'ISO date' : 'count'}</span>
						<input
							bind:value={targetValue}
							placeholder={targetKind === 'date' ? '2025-01-01' : '5000'}
							class="w-40 rounded border bg-background px-2 py-1 font-mono"
						/>
					</label>
				{/if}
				<label class="flex flex-col gap-1">
					<span class="text-muted-foreground" title="0/blank = config default">safety cap</span>
					<input bind:value={safetyCap} placeholder="unlimited" class="w-24 rounded border bg-background px-2 py-1 font-mono" />
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-muted-foreground" title="0/blank = none">timeout (min)</span>
					<input bind:value={timeoutMin} placeholder="0" class="w-20 rounded border bg-background px-2 py-1 font-mono" />
				</label>
				<label class="flex items-center gap-1 py-1" title="promote this room's deferred backfetched media to captioning on completion">
					<input type="checkbox" bind:checked={captionAfter} />
					<span class="text-muted-foreground">caption after</span>
				</label>
				<button
					onclick={start}
					disabled={starting || !enabled}
					class="rounded bg-primary px-3 py-1 font-medium text-primary-foreground disabled:opacity-50"
				>
					{starting ? 'starting…' : 'Start'}
				</button>
			</div>
		</section>

		<!-- Jobs list -->
		{#if jobsQuery.isPending}
			<div class="text-sm text-muted-foreground">loading…</div>
		{:else if jobs.length === 0}
			<div class="text-sm text-muted-foreground">No backfetch jobs yet.</div>
		{:else}
			<table class="w-full text-sm">
				<thead class="text-left text-xs text-muted-foreground">
					<tr class="border-b">
						<th class="py-1 pr-3 font-medium">room</th>
						<th class="py-1 pr-3 font-medium">target</th>
						<th class="py-1 pr-3 font-medium">status</th>
						<th class="py-1 pr-3 text-right font-medium" title="newly-stored rows">stored</th>
						<th class="py-1 pr-3 text-right font-medium" title="summaries seen">fetched</th>
						<th class="py-1 pr-3 font-medium">oldest reached</th>
						<th class="py-1 pr-3 font-medium">stop</th>
						<th class="py-1 font-medium">actions</th>
					</tr>
				</thead>
				<tbody>
					{#each jobs as job (job.id)}
						<tr class="border-b border-border/50 align-top">
							<td class="py-1 pr-3 font-mono text-[11px]" title={job.timelineKey}>
								{job.roomId}
								<span class="text-muted-foreground">({job.accountId})</span>
							</td>
							<td class="py-1 pr-3">{targetLabel(job.targetKind, job.targetValue)}</td>
							<td class={cn('py-1 pr-3 font-medium', STATUS_CLASSES[job.status] ?? '')}>
								{job.status}
								{#if job.error}
									<div class="text-[10px] text-red-400" title={job.error}>{job.error}</div>
								{/if}
							</td>
							<td class="py-1 pr-3 text-right font-mono">{job.stored}</td>
							<td class="py-1 pr-3 text-right font-mono">{job.fetched}</td>
							<td class="py-1 pr-3 text-[11px] text-muted-foreground">{fmtTime(job.oldestReachedTs)}</td>
							<td class="py-1 pr-3 text-[11px]">
								{#if job.stopReason}
									<span class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{job.stopReason}</span>
								{:else}
									—
								{/if}
							</td>
							<td class="py-1">
								<div class="flex flex-wrap gap-1 text-[11px]">
									{#if job.status === 'running' || job.status === 'queued'}
										<button class="rounded border px-1.5 py-0.5 hover:bg-muted" onclick={() => act('Pause', () => pauseBackfetchJob(job.id), 'Paused')}>pause</button>
									{/if}
									{#if job.status === 'paused'}
										<button class="rounded border px-1.5 py-0.5 hover:bg-muted" onclick={() => act('Resume', () => resumeBackfetchJob(job.id), 'Resumed')}>resume</button>
									{/if}
									{#if job.status === 'running' || job.status === 'queued' || job.status === 'paused'}
										<button class="rounded border border-red-500/40 px-1.5 py-0.5 text-red-500 hover:bg-red-500/10" onclick={() => act('Cancel', () => cancelBackfetchJob(job.id), 'Cancelled')}>cancel</button>
									{/if}
									<button class="rounded border px-1.5 py-0.5 hover:bg-muted" title="promote this room's deferred backfetched media to captioning" onclick={() => promote(job.timelineKey)}>caption</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
