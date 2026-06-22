<script lang="ts">
	// Test fixture (browser test only): mirrors LiveRollout's reactive shape — a
	// `$state` messages array, the `rows = streaming ? [...messages, streaming] :
	// messages` derived, and the real `Rollout` child — so a test can verify that a
	// `.push()` into `messages` (how the live fold appends turns) actually re-renders.
	// This reproduces the "live view stayed empty as messages rolled in" report:
	// the on-mount seed (a reassignment) renders, but if a push does not repaint,
	// live turns never appear. Buttons drive the mutations post-mount (like the fold).
	import Rollout from './Rollout.svelte';

	let messages = $state<Record<string, unknown>[]>([]);
	let streaming = $state<Record<string, unknown> | null>(null);
	const rows = $derived(streaming ? [...messages, streaming] : messages);
	let n = $state(0);

	function pushTurn() {
		messages.push({ role: 'assistant', content: [{ type: 'text', text: `turn-${n}` }] });
		n += 1;
	}
	function seed() {
		messages = [{ role: 'assistant', content: [{ type: 'text', text: 'seeded' }] }];
	}
</script>

<button onclick={pushTurn}>push</button>
<button onclick={seed}>seed</button>
<Rollout messages={rows} />
