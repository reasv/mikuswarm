<script lang="ts">
	import * as Resizable from '$lib/components/ui/resizable';
	import TopBar from './TopBar.svelte';
	import PipelineList from '$lib/components/col1/PipelineList.svelte';
	import PipelineItemList from '$lib/components/col2/PipelineItemList.svelte';
	import PipelineItemDetail from '$lib/components/detail/PipelineItemDetail.svelte';
	import PipelineActivityListener from '$lib/components/PipelineActivityListener.svelte';
</script>

<!-- Live SSE activity → query invalidation (renders nothing). -->
<PipelineActivityListener />

<!--
  Pipelines area (ARCHITECTURE.md §11): the same 3-column resizable idiom as the
  Conversations shell — Col1 pool health, Col2 work-item list, Col3 item detail —
  with its own autoSave id so the two areas keep independent pane sizes.
-->
<div class="flex h-screen flex-col">
	<TopBar />
	<Resizable.PaneGroup direction="horizontal" autoSaveId="miku-pipelines-h" class="min-h-0 flex-1">
		<Resizable.Pane defaultSize={20} minSize={14} class="min-w-0">
			<PipelineList />
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<Resizable.Pane defaultSize={40} minSize={25} class="min-w-0">
			<PipelineItemList />
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<Resizable.Pane defaultSize={40} minSize={0} class="min-w-0">
			<PipelineItemDetail />
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
