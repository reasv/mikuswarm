<script lang="ts">
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
</script>

<!--
  Separator heading for the record-turn section (spec SESSION-RECORDS §3.2).
  Appears in the rollout when harness.kind = 'record_turn' is encountered; the
  model's session_record_tool calls follow as normal tool-call cards.
-->
<div class="mt-3 mb-1 flex items-center gap-2 border-t border-dashed border-muted/50 pt-2">
	<BookmarkIcon class="size-3.5 text-muted-foreground/60" />
	<span class="text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
		Session record
	</span>
</div>
