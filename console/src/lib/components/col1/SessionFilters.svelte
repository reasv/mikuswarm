<script lang="ts" module>
	// The fixed status domain (mirrors the `agent_sessions.status` CHECK / the BFF's
	// SESSION_STATUSES). Statuses are a closed enum the client knows, so — unlike the
	// open-ended session types — they are listed here rather than fetched as facets.
	const STATUSES = [
		'created',
		'running',
		'completed',
		'discarded',
		'interrupted',
		'suspended',
		'resuming',
		'failed-resumable'
	] as const;
</script>

<script lang="ts">
	import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '$lib/components/ui/collapsible';
	import { sessionFilters } from '$lib/stores/sessionFilters.svelte';
	import { cn } from '$lib/utils';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';

	let { types = [] }: { types?: readonly string[] } = $props();

	// Search debounce: the input binds to a local draft; the committed value lands in
	// the store (which keys the list query) ~250ms after typing stops, so we don't
	// refetch per keystroke. Initialized from the store so it survives collapse/expand.
	let draft = $state(sessionFilters.q);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function onInput(): void {
		clearTimeout(timer);
		timer = setTimeout(() => {
			sessionFilters.q = draft;
		}, 250);
	}

	function clearSearch(): void {
		clearTimeout(timer);
		draft = '';
		sessionFilters.q = '';
	}

	function clearAll(): void {
		clearTimeout(timer);
		draft = '';
		sessionFilters.clear();
	}

	const chipBase =
		'rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase transition-colors hover:bg-accent';
	const chipOn = 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90';
	const chipOff = 'border-border text-muted-foreground';
</script>

<div class="border-b">
	<Collapsible bind:open={sessionFilters.open}>
		<CollapsibleTrigger
			class="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent"
		>
			<ChevronRightIcon
				class={cn('size-3.5 transition-transform', sessionFilters.open && 'rotate-90')}
			/>
			<span>Filter &amp; search</span>
			{#if sessionFilters.activeCount > 0}
				<span
					class="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground"
				>
					{sessionFilters.activeCount}
				</span>
			{/if}
		</CollapsibleTrigger>
		<CollapsibleContent>
			<div class="space-y-3 px-3 pt-1 pb-3">
				<!-- Trigger-message search (FTS5 over agent_sessions.trigger_body) -->
				<div class="relative">
					<SearchIcon
						class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						type="search"
						bind:value={draft}
						oninput={onInput}
						placeholder="Search trigger messages…"
						class="h-8 w-full rounded-md border border-input bg-background pr-7 pl-7 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
					{#if draft.length > 0}
						<button
							type="button"
							onclick={clearSearch}
							aria-label="Clear search"
							class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
						>
							<XIcon class="size-3.5" />
						</button>
					{/if}
				</div>

				<!-- Status filter (fixed enum; OR within the category) -->
				<div class="space-y-1">
					<div class="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
						Status
					</div>
					<div class="flex flex-wrap gap-1">
						{#each STATUSES as status (status)}
							{@const on = sessionFilters.statuses.includes(status)}
							<button
								type="button"
								aria-pressed={on}
								onclick={() => sessionFilters.toggleStatus(status)}
								class={cn(chipBase, on ? chipOn : chipOff)}
							>
								{status}
							</button>
						{/each}
					</div>
				</div>

				<!-- Session-type filter (room facets; OR within the category) -->
				<div class="space-y-1">
					<div class="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
						Type
					</div>
					{#if types.length === 0}
						<div class="text-[10px] text-muted-foreground">No types in this room.</div>
					{:else}
						<div class="flex flex-wrap gap-1">
							{#each types as type (type)}
								{@const on = sessionFilters.types.includes(type)}
								<button
									type="button"
									aria-pressed={on}
									onclick={() => sessionFilters.toggleType(type)}
									class={cn(chipBase, on ? chipOn : chipOff)}
								>
									{type}
								</button>
							{/each}
						</div>
					{/if}
				</div>

				{#if sessionFilters.hasActive}
					<button
						type="button"
						onclick={clearAll}
						class="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						Clear all filters
					</button>
				{/if}
			</div>
		</CollapsibleContent>
	</Collapsible>
</div>
