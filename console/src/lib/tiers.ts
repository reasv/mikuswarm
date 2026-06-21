/**
 * Tier presentation metadata for the verbatim renderer's gutter (spec §10a).
 * Colors label the summary → compact → rich progression plus the trigger/system
 * framing. Presentation only — content bytes are never altered.
 */
export type Tier = string | null;

export interface TierMeta {
	label: string;
	/** Tailwind classes for the gutter accent (left border + text). */
	accent: string;
}

const TIERS: Record<string, TierMeta> = {
	tools: { label: 'tools', accent: 'border-l-fuchsia-400 text-fuchsia-500' },
	system: { label: 'system', accent: 'border-l-zinc-400 text-zinc-500' },
	diary: { label: 'diary', accent: 'border-l-teal-400 text-teal-500' },
	summary: { label: 'summary', accent: 'border-l-violet-400 text-violet-500' },
	compact: { label: 'compact', accent: 'border-l-sky-400 text-sky-500' },
	rich: { label: 'rich', accent: 'border-l-emerald-400 text-emerald-500' },
	mixed: { label: 'mixed', accent: 'border-l-amber-400 text-amber-500' },
	runtime: { label: 'runtime', accent: 'border-l-orange-400 text-orange-500' },
	trigger: { label: 'trigger', accent: 'border-l-rose-400 text-rose-500' }
};

const FALLBACK: TierMeta = { label: '—', accent: 'border-l-zinc-300 text-zinc-400' };

export function tierMeta(tier: Tier): TierMeta {
	return (tier && TIERS[tier]) || FALLBACK;
}

/** A message's collapse-relevant shape (subset of `ContextMessageWire`). */
export interface CollapsibleMessage {
	type?: string | null;
	tier?: Tier;
}

/**
 * The earlier-context tiers that collapse by default. The summary → compact → rich
 * progression (plus `mixed`) folds away so the captured prefix doesn't bury the live
 * trigger turn / rollout below it. `diary` is handled separately in `isCollapsible`
 * (it collapses regardless of tier name). Applied **uniformly** across both verbatim
 * views — the live room-context preview and the session-input view: the room view
 * used to leave these tiers expanded, but the two are now aligned.
 */
const COLLAPSED_TIERS = new Set(['summary', 'compact', 'rich', 'mixed']);

/**
 * Whether a verbatim message renders with a collapse toggle. The tool-definition
 * block, the system prompt, the `<system>` satellite block, and the diary layer
 * always get the affordance — each is a large static blob, not part of the
 * conversation — and the earlier summary/compact/rich/mixed tiers fold too so the
 * captured prefix can be tucked away. The final user turn / trigger carries none of
 * these tiers, so it stays expanded.
 */
export function isCollapsible(msg: CollapsibleMessage): boolean {
	if (msg.type === 'tools' || msg.type === 'system' || msg.type === 'satellite' || msg.tier === 'diary')
		return true;
	return COLLAPSED_TIERS.has(msg.tier ?? '');
}

/**
 * Default `open` state for a collapsible verbatim message. Every collapsible message
 * (system/satellite/diary + the earlier tiers) starts collapsed; the final user turn
 * / trigger and any non-collapsible message stay open.
 */
export function defaultOpen(msg: CollapsibleMessage): boolean {
	return !isCollapsible(msg);
}
