<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { pipelineItemQuery } from '$lib/query/pipelines';
	import { keys } from '$lib/query/keys';
	import { pipelineSelection } from '$lib/stores/pipeline-selection.svelte';
	import PipelineStatusBadge from '$lib/components/col1/PipelineStatusBadge.svelte';
	import SessionView from '$lib/components/col2/SessionView.svelte';
	import RetryButton from '$lib/components/RetryButton.svelte';
	import { relativeTime } from '$lib/utils';

	const queryClient = useQueryClient();
	const detail = pipelineItemQuery(
		() => pipelineSelection.pool,
		() => pipelineSelection.itemId
	);

	// After a stop on an embedded session, refresh this item + the dashboard counts.
	function onSessionMutated() {
		const pool = pipelineSelection.pool;
		const id = pipelineSelection.itemId;
		if (pool && id) queryClient.invalidateQueries({ queryKey: keys.pipelineItem(pool, id) });
		queryClient.invalidateQueries({ queryKey: keys.pipelines() });
	}

	// Loosely-typed views over the permissive (Schema.Unknown) detail fields.
	const linkPreviews = $derived(
		(detail.data?.linkPreviews ?? []) as Array<{ url?: string; title?: string }>
	);
	const replyContext = $derived(detail.data?.replyContext as { body?: string } | null | undefined);
	const summary = $derived(
		detail.data?.summary as { content?: string; eventCount?: number } | null | undefined
	);
</script>

<div class="flex h-full flex-col border-l">
	<div class="px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
		Detail
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if pipelineSelection.itemId == null}
			<div class="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
				Select an item to inspect what went in and what came out.
			</div>
		{:else if detail.isPending}
			<div class="space-y-2 p-4">
				{#each Array(5) as _, i (i)}
					<div class="h-10 animate-pulse rounded bg-muted"></div>
				{/each}
			</div>
		{:else if detail.isError}
			<div class="p-4 text-sm text-destructive">{detail.error.message}</div>
		{:else}
			{@const item = detail.data.item}
			<!-- Shared item header -->
			<div class="space-y-2 border-b p-3">
				<div class="flex items-center justify-between gap-2">
					<PipelineStatusBadge status={item.status} retrying={item.retrying} />
					<div class="flex items-center gap-2 text-[10px] text-muted-foreground">
						{#if item.attempts > 0}
							<span class="font-mono tabular-nums">{item.attempts}/{item.maxRetries}</span>
						{/if}
						<span title={new Date(item.updatedAt).toLocaleString()}>{relativeTime(item.updatedAt)}</span>
						<RetryButton pool={item.pool} id={item.id} status={item.status} />
					</div>
				</div>
				<div class="text-xs text-foreground">{item.inputSummary}</div>
				{#if item.room}
					<div class="truncate font-mono text-[10px] text-muted-foreground">{item.room}</div>
				{/if}
				{#if item.error}
					<div class="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
						{item.error}
					</div>
				{/if}
			</div>

			<!-- Pool-specific body -->
			{#if detail.data.pool === 'enrichment'}
				<div class="space-y-3 p-3 text-xs">
					{#if replyContext?.body}
						<div>
							<div class="mb-1 font-semibold text-muted-foreground">Reply context</div>
							<div class="rounded bg-muted/50 px-2 py-1">{replyContext.body}</div>
						</div>
					{/if}
					{#if linkPreviews.length > 0}
						<div>
							<div class="mb-1 font-semibold text-muted-foreground">Link previews</div>
							<ul class="space-y-1">
								{#each linkPreviews as lp, i (i)}
									<li class="truncate">
										<span class="text-foreground">{lp.title ?? '(untitled)'}</span>
										<span class="text-muted-foreground"> — {lp.url}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if (detail.data.mediaAssets ?? []).length > 0}
						<div>
							<div class="mb-1 font-semibold text-muted-foreground">Media assets</div>
							<ul class="space-y-2">
								{#each detail.data.mediaAssets ?? [] as m (m.ref)}
									<li class="space-y-1">
										<div class="flex items-center justify-between gap-2">
											<span class="truncate">{m.filename ?? m.ref}</span>
											<div class="flex items-center gap-2">
												<span class="font-mono text-[10px] text-muted-foreground">{m.mediaType}</span>
												<!-- Cross-pipeline drill: jump to this asset's captioning item. -->
												{#if ['image', 'video', 'audio'].includes(m.mediaType)}
													<button
														type="button"
														class="rounded border px-1 text-[10px] text-muted-foreground hover:bg-accent"
														title="View in the captioning pipeline"
														onclick={() => {
															pipelineSelection.selectPool('captioning');
															pipelineSelection.selectItem(m.ref);
														}}
													>
														caption →
													</button>
												{/if}
											</div>
										</div>
										{#if m.hasBytes && m.mediaType === 'image'}
											<img
												src={`/api/media/${encodeURIComponent(m.ref)}`}
												alt={m.filename ?? m.ref}
												class="max-h-40 rounded border"
											/>
										{/if}
										{#if m.caption}
											<div class="text-muted-foreground">{m.caption}</div>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if !replyContext?.body && linkPreviews.length === 0 && (detail.data.mediaAssets ?? []).length === 0}
						<div class="text-muted-foreground">No derived rows for this event.</div>
					{/if}
				</div>
			{:else if detail.data.pool === 'captioning'}
				<div class="space-y-3 p-3 text-xs">
					{#if detail.data.media}
						{@const m = detail.data.media}
						{#if m.hasBytes && m.mediaType === 'image'}
							<img
								src={`/api/media/${encodeURIComponent(m.ref)}`}
								alt={m.filename ?? m.ref}
								class="max-h-64 rounded border"
							/>
						{:else if m.hasBytes && m.mediaType === 'video'}
							<!-- svelte-ignore a11y_media_has_caption -->
							<video src={`/api/media/${encodeURIComponent(m.ref)}`} controls class="max-h-64 rounded border"
							></video>
						{:else if m.hasBytes && m.mediaType === 'audio'}
							<audio src={`/api/media/${encodeURIComponent(m.ref)}`} controls class="w-full"></audio>
						{/if}
						<div class="font-mono text-[10px] text-muted-foreground">
							{m.mediaType}{m.captionModel ? ` · ${m.captionModel}` : ''}
						</div>
						{#if m.caption}
							<div class="rounded bg-muted/50 px-2 py-1">{m.caption}</div>
						{:else}
							<div class="text-muted-foreground">No caption/transcript yet.</div>
						{/if}
					{:else}
						<div class="text-muted-foreground">Media asset not found.</div>
					{/if}
				</div>
			{:else}
				<!-- summarization / diary: show the source summary + embed the session -->
				<div class="space-y-3 p-3 text-xs">
					{#if detail.data.bestEffortDraft}
						<div>
							<div class="mb-1 font-semibold text-amber-600 dark:text-amber-400">Best-effort draft</div>
							<div class="rounded bg-muted/50 px-2 py-1 whitespace-pre-wrap">
								{detail.data.bestEffortDraft}
							</div>
						</div>
					{/if}
					{#if summary?.content}
						<div>
							<div class="mb-1 font-semibold text-muted-foreground">
								{detail.data.pool === 'diary' ? 'Source range (neutral record)' : 'Summary'}
							</div>
							<div class="rounded bg-muted/50 px-2 py-1 whitespace-pre-wrap">{summary.content}</div>
						</div>
					{/if}
				</div>
				{#if detail.data.sessionId}
					<div
						class="border-y px-3 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
					>
						Session
					</div>
					{#key detail.data.sessionId}
						<SessionView sessionId={detail.data.sessionId} embedded onMutated={onSessionMutated} />
					{/key}
				{:else}
					<div class="p-3 text-xs text-muted-foreground">No session recorded for this item.</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>
