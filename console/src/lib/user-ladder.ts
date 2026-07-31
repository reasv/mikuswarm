/**
 * Per-user limits console model (spec PER-USER-LIMITS §14).
 *
 * The BFF returns a flat, preference-ordered list of materialized meters (one per
 * partition × cap). This folds them into one group per partition (a user, or a shared
 * pool), each carrying its caps in ladder (preference) order.
 *
 * Two bar shapes:
 *   • a SINGLE-model cap renders as one **health-colored** bar (green/amber/red by its
 *     own fill) — the red bar IS the exhausted cap.
 *   • a COMPOSITE cap (≥2 models, e.g. `sol + terra`) renders as a **segmented** bar so
 *     its composition (how much is sol vs terra) stays visible. Segments are colored from
 *     a NON-health palette (blues/purples/teals) so model identity never masquerades as
 *     health; the composite's own fill health shows via its percent label. Per-member
 *     spend comes from the sibling single-model caps in the same group.
 *
 * Caps order by `orderIndex` (the backend's PREFERENCE-order key): singles at their
 * model's preference position, a composite right after its last member — e.g. for a
 * `sol, terra, glm` preference the order is `sol, terra, sol + terra, glm`.
 */

import type { UserLimitStatus } from './schemas';

export type MeterState = 'ok' | 'near' | 'blocked';

/**
 * Composite segment colors, assigned by the segment's position WITHIN its composite (not a
 * global model index) so the members of any one bar always take the first, maximally-
 * contrasting entries. High-contrast, non-health hues (NEVER green/amber/red, so identity
 * can't masquerade as health): the common 2-member case gets blue vs magenta.
 */
const SEGMENT_PALETTE = [
	'#3b82f6', // blue
	'#ec4899', // magenta
	'#a855f7', // purple
	'#06b6d4', // cyan
	'#f472b6', // pink
	'#6366f1' // indigo
];

/** One member model's slice of a composite bar. */
export interface CapSegment {
	model: string;
	spentUsd: number;
	/** Slice width as a fraction of the composite cap, clamped to [0,1]. */
	widthFraction: number;
	color: string;
}

/** One cap's bar within a partition strip. */
export interface CapBar {
	meterKey: string;
	/** Model scope joined for display, or "all models" for a fungible total. */
	label: string;
	models: string[] | undefined;
	spentUsd: number;
	capUsd: number;
	/** Fill fraction; can exceed 1 when spend is over the cap (shown as e.g. 188%). */
	fraction: number;
	state: MeterState;
	orderIndex: number;
	/** True when this cap covers ≥2 models (rendered as a segmented bar). */
	isComposite: boolean;
	/** Per-member slices (composite only; empty for a single-model cap). */
	segments: CapSegment[];
	/** Composite spend not attributable to a member segment, as a fraction of the cap. */
	remainderFraction: number;
}

/** One partition's strip — a user, or a shared pool. */
export interface LadderGroup {
	partitionKey: string;
	isUserPartition: boolean;
	/** BFF-resolved display name for a user partition; null → render the raw key. */
	displayName: string | null;
	/** Discord unique username; null for Matrix users (their partitionKey IS the MXID). */
	username: string | null;
	/** Representative reset (earliest) — the group's caps share a window in practice. */
	resetsAt: number;
	/** Caps in preference (ladder) order. */
	caps: CapBar[];
}

export interface LadderModel {
	users: LadderGroup[];
	pools: LadderGroup[];
}

function asState(s: string): MeterState {
	return s === 'blocked' || s === 'near' ? s : 'ok';
}

/**
 * Build composite segments from per-member spend, colored by position (blue, magenta, …)
 * so members always take the first, maximally-contrasting hues. Shared by per-user
 * composite caps AND the multi-model global-limit bars so both look identical.
 */
export function buildSegments(
	members: readonly { model: string; spentUsd: number }[],
	capUsd: number
): CapSegment[] {
	return members.map((m, i) => ({
		model: m.model,
		spentUsd: m.spentUsd,
		widthFraction: capUsd > 0 ? Math.max(0, Math.min(1, m.spentUsd / capUsd)) : 0,
		color: SEGMENT_PALETTE[i % SEGMENT_PALETTE.length]
	}));
}

/**
 * Fold the flat meter list into partition strips. Pure. Group order follows the BFF's
 * insertion order (already hottest-first); caps within a group order by `orderIndex`.
 */
export function buildLadder(statuses: readonly UserLimitStatus[]): LadderModel {
	const groups = new Map<string, { g: LadderGroup; raw: UserLimitStatus[] }>();
	for (const s of statuses) {
		const gk = `${s.isUserPartition ? 'u' : 'p'} ${s.partitionKey}`;
		let entry = groups.get(gk);
		if (!entry) {
			entry = {
				g: {
					partitionKey: s.partitionKey,
					isUserPartition: s.isUserPartition,
					displayName: null,
					username: null,
					resetsAt: s.resetsAt,
					caps: []
				},
				raw: []
			};
			groups.set(gk, entry);
		}
		entry.g.resetsAt = Math.min(entry.g.resetsAt, s.resetsAt);
		// Labels ride on every meter of the partition identically; adopt the first seen.
		entry.g.displayName ??= s.displayName ?? null;
		entry.g.username ??= s.username ?? null;
		entry.raw.push(s);
	}

	for (const { g, raw } of groups.values()) {
		// Sibling single-model spend, for composing composite bars.
		const single = new Map<string, { spentUsd: number; orderIndex: number }>();
		for (const s of raw) {
			if (s.modelScope?.length === 1) {
				single.set(s.modelScope[0], { spentUsd: s.spentUsd, orderIndex: s.orderIndex ?? Number.MAX_SAFE_INTEGER });
			}
		}
		for (const s of raw) {
			const models = s.modelScope ? [...s.modelScope] : undefined;
			const isComposite = (models?.length ?? 0) >= 2;
			const segments: CapSegment[] = [];
			let segSpent = 0;
			if (isComposite && models) {
				// One slice per member that has its own single-model meter, ordered by that
				// member's preference position; members without a meter fall into remainder.
				const members = models
					.filter((m) => single.has(m))
					.sort((a, b) => single.get(a)!.orderIndex - single.get(b)!.orderIndex)
					.map((m) => ({ model: m, spentUsd: single.get(m)!.spentUsd }));
				segments.push(...buildSegments(members, s.capUsd));
				segSpent = members.reduce((n, m) => n + m.spentUsd, 0);
			}
			g.caps.push({
				meterKey: s.meterKey,
				label: models ? models.join(' + ') : 'all models',
				models,
				spentUsd: s.spentUsd,
				capUsd: s.capUsd,
				fraction: s.fraction,
				state: asState(s.state),
				orderIndex: s.orderIndex ?? Number.MAX_SAFE_INTEGER,
				isComposite,
				segments,
				remainderFraction:
					isComposite && s.capUsd > 0 ? Math.max(0, (s.spentUsd - segSpent) / s.capUsd) : 0
			});
		}
		g.caps.sort((a, b) => a.orderIndex - b.orderIndex || a.meterKey.localeCompare(b.meterKey));
	}

	const all = [...groups.values()].map((e) => e.g);
	return {
		users: all.filter((g) => g.isUserPartition),
		pools: all.filter((g) => !g.isUserPartition)
	};
}
