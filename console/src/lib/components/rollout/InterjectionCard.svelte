<script lang="ts">
	import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';

	// User-role injections inside the rollout (interjections / forced-completion
	// prompts / resume turns), shown distinctly from assistant output (spec §10b).
	let { text }: { text: string } = $props();
</script>

<div
	class="rounded-md border-l-2 border-l-rose-400 bg-rose-500/5 px-3 py-2 text-sm whitespace-pre-wrap"
>
	<div class="mb-1 flex items-center gap-1.5 text-[10px] tracking-wide text-rose-500 uppercase">
		<CornerDownRightIcon class="size-3" />
		injected user turn
	</div>
	{text}
</div>
