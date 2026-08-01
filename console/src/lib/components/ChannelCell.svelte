<script lang="ts">
	// Table cell for a channel: shows the human room label (`Name (Space)`, resolved by
	// the agent's RoomLabelCache and joined in by the usage queries) and, on click, a
	// popover with the raw timeline key + a copy-to-clipboard button. Used by the
	// usage-cost recent-sessions and recent-paid-calls tables so a channel is readable
	// without losing access to its exact id.
	//
	// Agent mode (spec CONSOLE-MULTI-AGENT §3/§4): when `agentLookup` is provided the
	// caller is operating under the global gate and the old `showAccount` path is
	// replaced by a row-level agent chip (§3.2 grammar). `agentEntries` is the agents
	// array from the wire payload — needed for `needsAccountId` to decide when to
	// append the `accountId` disambiguator.
	import { Popover } from 'bits-ui';
	import { toast } from 'svelte-sonner';
	import { cn } from '$lib/utils';
	import { timelineAccount } from '$lib/timeline-key';
	import { agentFor, needsAccountId, agentAccent } from '$lib/agents';
	import type { AgentLookup } from '$lib/agents';
	import type { AgentEntry } from '$lib/schemas';

	let {
		label,
		id,
		showAccount = false,
		agentLookup = undefined as AgentLookup | undefined,
		agentEntries = undefined as readonly AgentEntry[] | undefined,
		class: className = ''
	}: {
		label: string;
		id: string;
		showAccount?: boolean;
		/** When provided (agents mode, global gate passed), shows an agent chip instead of
		 *  the legacy account tag. Pass when `distinctAgents(rows) > 1`. */
		agentLookup?: AgentLookup;
		/** Full AgentEntry array from the /api/agents payload — needed for needsAccountId. */
		agentEntries?: readonly AgentEntry[];
		class?: string;
	} = $props();

	// Row account parsed from the timeline key (provider + accountId for chip grammar §3.2).
	const rowAcc = $derived(timelineAccount(id));

	// Resolved agent — only when the caller passed a lookup (agents mode).
	const resolved = $derived(agentLookup ? agentFor(id, agentLookup) : undefined);

	// Full AgentEntry for the resolved agent — needed for needsAccountId (§3.2).
	const agentEntry = $derived(
		resolved && agentEntries ? agentEntries.find((e) => e.name === resolved.agentName) : undefined
	);

	// Whether to append accountId to the chip label (§3.2: only when the agent has >1
	// account on this row's provider — per-provider disambiguation, not per-agent).
	const showAccountId = $derived(
		agentEntry && rowAcc ? needsAccountId(agentEntry, rowAcc.provider) : false
	);

	// Deterministic accent color for this agent (§3.4).
	const accent = $derived(resolved ? agentAccent(resolved.agentIndex) : undefined);

	// Unresolvable: agentLookup present but key not in the map (§4.3 — stored rows may
	// reference accounts no longer in config). Fall back to raw tag, muted/unassigned.
	const unresolvable = $derived(agentLookup != null && resolved == null);

	// Legacy (gate absent): old accountId PROVIDER tag, gated on the caller's showAccount.
	const legacyAccount = $derived(!agentLookup && showAccount ? rowAcc : undefined);

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
		{#if resolved && rowAcc}
			<!-- Agent chip: accent dot + name + provider [+ accountId if needed] (§3.2 row-level). -->
			<span class="inline-flex shrink-0 items-baseline gap-0.5 text-[9px]">
				<span
					class="relative top-px inline-block size-1.5 shrink-0 self-center rounded-full"
					style="background:{accent}"
				></span>
				<span style="color:{accent}">
					{resolved.agentName}
					<span class="uppercase tracking-wide">{rowAcc.provider}</span>{#if showAccountId}&nbsp;{rowAcc.accountId}{/if}
				</span>
			</span>
		{:else if unresolvable && rowAcc}
			<!-- Unresolvable account: raw tag, muted "unassigned" treatment (§4.3). -->
			<span class="shrink-0 text-[9px] text-muted-foreground/50">
				{rowAcc.accountId}
				<span class="uppercase tracking-wide">{rowAcc.provider}</span>
			</span>
		{:else if legacyAccount}
			<!-- Legacy path: accountId PROVIDER tag when showAccount is true and no lookup. -->
			<span class="shrink-0 text-[9px] text-muted-foreground">
				{legacyAccount.accountId}
				<span class="uppercase tracking-wide">{legacyAccount.provider}</span>
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
