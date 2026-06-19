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

/**
 * Verbatim renderer mode (spec §10):
 * - `room`   — §10a: the live `build()` output; only the system prompt, the
 *   `<system>` satellite block and the diary layer collapse by default.
 * - `session`— §10b: the captured input context above a session rollout; the final
 *   user turn / trigger stays expanded, while earlier tiers (summary/compact/rich)
 *   AND system/satellite collapse by default so the long prefix doesn't bury the
 *   rollout below the fold.
 */
export type VerbatimMode = 'room' | 'session';

/** A message's collapse-relevant shape (subset of `ContextMessageWire`). */
export interface CollapsibleMessage {
	type?: string | null;
	tier?: Tier;
}

/**
 * The earlier-context tiers that collapse by default in session mode (spec §10b).
 * `diary` is absent because it collapses in BOTH modes (handled in `isCollapsible`).
 */
const SESSION_COLLAPSED_TIERS = new Set(['summary', 'compact', 'rich', 'mixed']);

/**
 * Whether a verbatim message renders with a collapse toggle. The tool-definition
 * block, the system prompt, the `<system>` satellite block, and the diary layer
 * always get the affordance (both modes, spec §10a) — each is a large static blob,
 * not part of the conversation. In session mode the earlier summary/compact/rich
 * tiers also become collapsible so the captured prefix can be folded away (spec §10b).
 */
export function isCollapsible(msg: CollapsibleMessage, mode: VerbatimMode): boolean {
	if (msg.type === 'tools' || msg.type === 'system' || msg.type === 'satellite' || msg.tier === 'diary')
		return true;
	if (mode === 'session') return SESSION_COLLAPSED_TIERS.has(msg.tier ?? '');
	return false;
}

/**
 * Default `open` state for a collapsible verbatim message. System/satellite/diary start
 * collapsed in both modes; in session mode the earlier tiers also start collapsed,
 * while the final user turn / trigger stays expanded (spec §10a/§10b). Non-collapsible
 * messages are always open.
 */
export function defaultOpen(msg: CollapsibleMessage, mode: VerbatimMode): boolean {
	return !isCollapsible(msg, mode);
}
