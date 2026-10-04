<script lang="ts">
	import BotIcon from '@lucide/svelte/icons/bot';
	import ToolCallCard from './ToolCallCard.svelte';
	import type { RolloutMsg } from '$lib/rollout';

	/** A harness-made tool call (injection or record-load), rendered with a marker badge. */
	let {
		name,
		args,
		result,
		/** 'injection' | 'record_load' */
		kind
	}: {
		name: string;
		args: unknown;
		result: RolloutMsg | undefined;
		kind: 'injection' | 'record_load';
	} = $props();
</script>

<div class="relative">
	<!-- Harness badge above the tool card -->
	<div class="mb-0.5 flex items-center gap-1.5">
		<BotIcon class="size-3 text-muted-foreground/60" />
		<span class="text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
			{kind === 'injection' ? 'harness injection' : 'harness load'}
		</span>
	</div>
	<div class="opacity-80">
		<ToolCallCard {name} {args} {result} />
	</div>
</div>
