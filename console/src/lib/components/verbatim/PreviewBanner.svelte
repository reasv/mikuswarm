<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
</script>

<!-- spec §9: the final user turn in room mode is built from a synthetic trigger. -->
<div
	class="flex items-center gap-2 border-y border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
>
	<TriangleAlertIcon class="size-3.5 shrink-0" />
	<span>preview (synthetic trigger) — this final turn is hypothetical, not a captured context</span>
</div>
