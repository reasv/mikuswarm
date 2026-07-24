<script lang="ts">
	import * as Resizable from '$lib/components/ui/resizable';
	import TopBar from './TopBar.svelte';
	import RoomList from '$lib/components/col1/RoomList.svelte';
	import SessionList from '$lib/components/col1/SessionList.svelte';
	import Col2 from '$lib/components/layout/Col2.svelte';
	import DetailPanel from '$lib/components/detail/DetailPanel.svelte';
</script>

<div class="flex h-screen flex-col">
	<TopBar />
	<Resizable.PaneGroup direction="horizontal" autoSaveId="mikuswarm-console-h" class="min-h-0 flex-1">
		<!-- Col 1: rooms (top) + sessions (bottom), each scrollable -->
		<Resizable.Pane defaultSize={20} minSize={14} class="min-w-0">
			<Resizable.PaneGroup direction="vertical" autoSaveId="mikuswarm-console-col1">
				<Resizable.Pane defaultSize={50} minSize={20}>
					<RoomList />
				</Resizable.Pane>
				<Resizable.Handle />
				<Resizable.Pane defaultSize={50} minSize={20}>
					<SessionList />
				</Resizable.Pane>
			</Resizable.PaneGroup>
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<!-- Col 2: room context OR session input + rollout -->
		<Resizable.Pane defaultSize={55} minSize={30} class="min-w-0">
			<Col2 />
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<!-- Col 3: session inspector — raw record behind the selected session (spec §12) -->
		<Resizable.Pane defaultSize={25} minSize={0} class="min-w-0">
			<DetailPanel />
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
