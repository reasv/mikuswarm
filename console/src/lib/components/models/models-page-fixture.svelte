<script lang="ts">
	// Test fixture (browser test only): the real /models route under a fresh QueryClient.
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { createQueryClient } from '$lib/query/client';
	import ModelsPage from '../../../routes/models/+page.svelte';

	const client = createQueryClient();
</script>

<QueryClientProvider {client}>
	<ModelsPage />
</QueryClientProvider>
