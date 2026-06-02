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
	system: { label: 'system', accent: 'border-l-zinc-400 text-zinc-500' },
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
