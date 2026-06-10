<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import { sessionQuery } from '$lib/query/sessions';
	import { keys } from '$lib/query/keys';
	import { selection } from '$lib/stores/selection.svelte';
	import { contextSummary } from '$lib/stores/context-summary.svelte';
	import { coerceContextMessage } from '$lib/rollout';
	import { abortSession, resumeSession } from '$lib/api/admin.remote';
	import { Button } from '$lib/components/ui/button';
	import VerbatimContext from '$lib/components/verbatim/VerbatimContext.svelte';
	import Rollout from '$lib/components/rollout/Rollout.svelte';
	import LiveRollout from '$lib/components/rollout/LiveRollout.svelte';

	// Reusable across both areas (ARCHITECTURE.md §11): the Conversations Col2
	// renders it bound to `selection.sessionId`; the Pipelines Col3 embeds it with an
	// explicit `sessionId` (a summarize/condense/diary run). When `embedded`, it does
	// NOT publish to the conversations top-bar `contextSummary` nor invalidate the
	// room-session list; the parent passes `onMutated` to refresh pipeline queries.
	let {
		sessionId: sessionIdProp = null,
		embedded = false,
		onMutated
	}: { sessionId?: string | null; embedded?: boolean; onMutated?: () => void } = $props();

	const activeId = $derived(sessionIdProp ?? selection.sessionId);

	const queryClient = useQueryClient();
	const session = sessionQuery(() => activeId);

	let stopping = $state(false);
	let resuming = $state(false);

	/** Invalidate the affected caches after a stop / stream-end. */
	function refreshAfterMutation(id: string) {
		queryClient.invalidateQueries({ queryKey: keys.session(id) });
		if (!embedded && selection.roomKey)
			queryClient.invalidateQueries({ queryKey: keys.roomSessions(selection.roomKey) });
		onMutated?.();
	}

	// Stop button → POST abort. A 409 means the run already settled between render
	// and click (benign — it's no longer in flight), so treat it as success. Either
	// way, refetch so the view flips to the persisted terminal record; the live SSE
	// stream's own `agent_end` → `onStreamEnd` covers the happy path too.
	async function handleStop() {
		const id = activeId;
		if (!id || stopping) return;
		stopping = true;
		try {
			// The 200 contract is `{ sessionId, status: "interrupted" }` (spec §13). Consume
			// the decoded status rather than assuming success: confirm the run was actually
			// interrupted before claiming so, and surface any other status explicitly instead
			// of mislabeling it (e.g. if the backend 200 contract ever drifts).
			const { status } = await abortSession(id);
			if (status === 'interrupted') {
				toast.success('Session stopped');
			} else {
				toast.warning('Session stop returned an unexpected status', { description: status });
			}
		} catch (err) {
			const status = (err as { status?: number })?.status;
			if (status === 409) {
				toast.info('Session was already finished');
			} else {
				toast.error('Failed to stop session', {
					description: (err as { body?: { message?: string } })?.body?.message
				});
			}
		} finally {
			stopping = false;
			refreshAfterMutation(id);
		}
	}

	// Resume button → POST resume (spec CONCURRENCY-AND-RATE-LIMITING §6.2): the
	// agent re-creates the parked (`failed-resumable`) or `interrupted` run from
	// its persisted snapshot + transcript and redoes the failed request,
	// long-polling until the resumed run settles. A 409 means the resume failed
	// again (re-parked), the session is no longer resumable, the session is a
	// synthetic worker-pool one (summarize/condense/diary), a resume is already
	// in flight, the timeline is busy, or there is nothing to redo.
	async function handleResume() {
		const id = activeId;
		if (!id || resuming) return;
		resuming = true;
		toast.info('Resuming session…', { description: 'Redoing the failed request.' });
		try {
			const { status } = await resumeSession(id);
			if (status === 'completed') {
				toast.success('Session resumed and completed');
			} else {
				toast.warning('Session resume returned an unexpected status', { description: status });
			}
		} catch (err) {
			toast.error('Resume failed', {
				description: (err as { body?: { message?: string } })?.body?.message
			});
		} finally {
			resuming = false;
			refreshAfterMutation(id);
		}
	}

	// Verbatim input = frozen snapshot prefix + the transcript's head final user turn
	// (spec §3 / §10a). Rollout = the rest of the transcript (spec §10b).
	const inputMessages = $derived.by(() => {
		const d = session.data;
		if (!d) return [];
		const head = d.transcript.slice(0, d.rolloutStartIndex).map(coerceContextMessage);
		return [...d.contextSnapshot, ...head];
	});
	const rolloutMessages = $derived.by(() => {
		const d = session.data;
		return d ? d.transcript.slice(d.rolloutStartIndex) : [];
	});
	const isRunning = $derived(session.data?.session.status === 'running');
	// Resumable statuses (spec CONCURRENCY-AND-RATE-LIMITING §6.2 / Decision D):
	// `failed-resumable` (parked by Layer-2 exhaustion) and `interrupted` (healed
	// after a crash/stop) both carry the snapshot + transcript a resume needs; the
	// agent 409s when the transcript has nothing to redo. Synthetic worker-pool
	// sessions (summarize/condense/diary — ARCHITECTURE.md §9b/§9c) are never
	// chat-resumable: the agent 409s them outright (the pools own their own
	// retries), so don't offer the button at all. Mirrors SYNTHETIC_SESSION_TYPES
	// in src/agent/recovery.ts.
	const SYNTHETIC_SESSION_TYPES = new Set(['summarize', 'condense', 'diary']);
	const isResumable = $derived(
		(session.data?.session.status === 'failed-resumable' ||
			session.data?.session.status === 'interrupted') &&
			!SYNTHETIC_SESSION_TYPES.has(session.data?.session.sessionType ?? '')
	);

	$effect(() => {
		const d = session.data;
		// The conversations top-bar summary belongs to the Conversations area only;
		// an embedded (pipelines Col3) session must not hijack it.
		if (d && !embedded) {
			contextSummary.set({
				tokenEstimate: d.session.tokenEstimate,
				compactTokens: null,
				richTokens: null,
				cacheBoundaries: [],
				live: d.session.status === 'running'
			});
		}
	});

	// When the live stream ends, the persisted record is now authoritative: refetch
	// the session (→ terminal status → persisted rollout) and the room's list badge.
	function onStreamEnd() {
		const id = activeId;
		if (!id) return;
		refreshAfterMutation(id);
	}
</script>

<div class="h-full overflow-y-auto">
	{#if session.isPending}
		<div class="space-y-2 p-4">
			{#each Array(6) as _, i (i)}
				<div class="h-12 animate-pulse rounded bg-muted"></div>
			{/each}
		</div>
	{:else if session.isError}
		<div class="p-4 text-sm text-destructive">{session.error.message}</div>
	{:else}
		<VerbatimContext messages={inputMessages} mode="session" />
		<div
			class="sticky top-0 flex items-center justify-between border-y bg-background/80 px-3 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur"
		>
			<span>Rollout</span>
			{#if isRunning}
				<Button
					variant="destructive"
					size="sm"
					class="h-6 px-2 text-[10px]"
					disabled={stopping}
					onclick={handleStop}
				>
					<OctagonXIcon class="size-3" />
					{stopping ? 'Stopping…' : 'Stop'}
				</Button>
			{:else if isResumable}
				<Button
					variant="outline"
					size="sm"
					class="h-6 px-2 text-[10px]"
					disabled={resuming}
					onclick={handleResume}
				>
					<RotateCcwIcon class="size-3" />
					{resuming ? 'Resuming…' : 'Resume'}
				</Button>
			{/if}
		</div>
		{#if isRunning && activeId}
			{#key activeId}
				<LiveRollout sessionId={activeId} onEnd={onStreamEnd} />
			{/key}
		{:else}
			<Rollout messages={rolloutMessages} />
		{/if}
	{/if}
</div>
