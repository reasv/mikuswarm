<script lang="ts">
	// Test fixture (browser test only): the real SessionView under a fresh
	// QueryClient, so a test exercises its queries' creation and polling wiring.
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { createQueryClient } from '$lib/query/client';
	import SessionView from './SessionView.svelte';

	let { sessionId }: { sessionId: string } = $props();
	const client = createQueryClient();
</script>

<QueryClientProvider {client}>
	<SessionView {sessionId} />
</QueryClientProvider>
