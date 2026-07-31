<script lang="ts">
	// Table cell for a channel: shows the human room label (`Name (Space)`, resolved by
	// the agent's RoomLabelCache and joined in by the usage queries) and, on click, a
	// popover with the raw timeline key + a copy-to-clipboard button. Used by the
	// usage-cost recent-sessions and recent-paid-calls tables so a channel is readable
	// without losing access to its exact id.
	import { Popover } from 'bits-ui';
	import { toast } from 'svelte-sonner';
	import { cn } from '$lib/utils';
	import { timelineAccount } from '$lib/timeline-key';

	let {
		label,
		id,
		showAccount = false,
		class: className = ''
	}: { label: string; id: string; showAccount?: boolean; class?: string } = $props();

	// Account tag (`accountId PROVIDER`), shown only when the caller opted in —
	// the tables enable it when their rows span more than one account, mirroring
	// the Conversations room list's tabs-only-when-plural behavior.
	const account = $derived(showAccount ? timelineAccount(id) : undefined);

	async function copyId(): Promise<void> {
		try {
			await navigator.clipboard.writeText(id);
			toast.success('Channel ID copied');
		} catch {
			toast.error('Copy failed', { description: 'Clipboard access was denied.' });
		}
	}
</script>

<Popover.Root>
	<Popover.Trigger
		title={label}
		class={cn(
			'inline-flex max-w-[14rem] items-baseline gap-1 align-bottom text-left',
			className
		)}
	>
		<span class="min-w-0 truncate hover:underline">{label}</span>
		{#if account}
			<span class="shrink-0 text-[9px] text-muted-foreground">
				{account.accountId} <span class="uppercase tracking-wide">{account.provider}</span>
			</span>
		{/if}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			sideOffset={4}
			class="z-50 w-max max-w-[24rem] rounded-md border bg-background p-2 text-xs shadow-md outline-none"
		>
			<div class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Channel ID</div>
			<div class="flex items-center gap-2">
				<code class="break-all font-mono text-[11px] text-foreground">{id}</code>
				<button
					onclick={copyId}
					class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					Copy
				</button>
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
