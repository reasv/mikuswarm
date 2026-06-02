<script lang="ts">
	import './layout.css';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner';
	import { createQueryClient } from '$lib/query/client';

	let { children } = $props();
	const queryClient = createQueryClient();
</script>

<svelte:head><title>miku console</title></svelte:head>

<ModeWatcher />
<Toaster />
<QueryClientProvider client={queryClient}>
	{@render children()}
</QueryClientProvider>
