import type {
	BehaviourIncidentRow,
	BehaviourMarker,
	BehaviourRateCell,
	BehaviourRateDefinition,
	BehaviourSeriesPoint
} from '$lib/schemas';
import { conversationsHref } from '$lib/nav';

/**
 * The `/models` page's view model (spec REFUSAL-HANDLING §12.3, §12.4): URL
 * filters (the source of truth, like every console page), rate formatting, the
 * over-time chart geometry and incident deep links. Pure, so the page stays a
 * thin renderer and the logic is unit-tested.
 */

export const BEHAVIOUR_WINDOWS = [
	{ id: 'today', label: 'Today' },
	{ id: '24h', label: '24h' },
	{ id: '7d', label: '7d' },
	{ id: '30d', label: '30d' },
	{ id: 'month', label: 'This month' },
	{ id: 'all', label: 'All time' }
] as const;
export const BEHAVIOUR_GROUP_BYS = ['model', 'agent', 'site', 'task'] as const;
export const INCIDENT_TYPES = ['refusal', 'nudge', 'redo', 'revision', 'ending'] as const;

export interface BehaviourFilters {
	window: string;
	groupBy: string;
	/** Group config entries by `[models.*].family` (only with group-by model). */
	family: boolean;
	agent: string | null;
	site: string | null;
	task: string | null;
	/** The clicked scorecard group (scopes the breakdown and the incident log). */
	selected: string | null;
	/** Headline rate id for the over-time chart; null = the API's default (first rate). */
	metric: string | null;
	/** Incident type filter. */
	type: string | null;
}

const WINDOW_IDS: readonly string[] = BEHAVIOUR_WINDOWS.map((w) => w.id);
const nonEmpty = (v: string | null): string | null => (v != null && v !== '' ? v : null);

/** Read the filters from the URL; unknown or hand-edited values fall back to defaults. */
export function parseBehaviourFilters(sp: URLSearchParams): BehaviourFilters {
	const window = sp.get('window');
	const groupBy = sp.get('group');
	const type = sp.get('type');
	const g = groupBy != null && (BEHAVIOUR_GROUP_BYS as readonly string[]).includes(groupBy) ? groupBy : 'model';
	return {
		window: window != null && WINDOW_IDS.includes(window) ? window : '24h',
		groupBy: g,
		family: g === 'model' && (sp.get('family') === '1' || sp.get('family') === 'true'),
		agent: nonEmpty(sp.get('agent')),
		site: nonEmpty(sp.get('site')),
		task: nonEmpty(sp.get('task')),
		selected: nonEmpty(sp.get('selected')),
		metric: nonEmpty(sp.get('metric')),
		type: type != null && (INCIDENT_TYPES as readonly string[]).includes(type) ? type : null
	};
}

/** The filters as URL params (defaults omitted, so the default view is a bare `/models`). */
export function behaviourFiltersToParams(f: BehaviourFilters): Record<string, string | null> {
	return {
		window: f.window === '24h' ? null : f.window,
		group: f.groupBy === 'model' ? null : f.groupBy,
		family: f.family && f.groupBy === 'model' ? '1' : null,
		agent: f.agent,
		site: f.site,
		task: f.task,
		selected: f.selected,
		metric: f.metric,
		type: f.type
	};
}

/** The remote query argument (`getModelBehaviour` / `getModelBehaviourIncidents`). */
export function behaviourQueryArg(f: BehaviourFilters): {
	window: string;
	groupBy: string;
	family?: boolean;
	agent?: string;
	site?: string;
	task?: string;
	selected?: string;
	metric?: string;
	type?: string;
} {
	return {
		window: f.window,
		groupBy: f.groupBy,
		...(f.family ? { family: true } : {}),
		...(f.agent ? { agent: f.agent } : {}),
		...(f.site ? { site: f.site } : {}),
		...(f.task ? { task: f.task } : {}),
		...(f.selected ? { selected: f.selected } : {}),
		...(f.metric ? { metric: f.metric } : {}),
		...(f.type ? { type: f.type } : {})
	};
}

/** A rate as shown: a share (scale 1) as a percentage, per-1k rates as "n /1k". */
export function formatRate(rate: number | null, def: Pick<BehaviourRateDefinition, 'scale'>): string {
	if (rate == null) return '—';
	if (def.scale === 1) {
		const pct = rate * 100;
		return `${pct < 10 && pct !== 0 ? pct.toFixed(1) : Math.round(pct)}%`;
	}
	return `${rate < 10 ? rate.toFixed(2) : rate.toFixed(1)} /${def.scale === 1000 ? '1k' : def.scale}`;
}

/** The change against the previous window, in the rate's own unit (percentage points for shares). */
export function formatChange(
	cell: Pick<BehaviourRateCell, 'change'>,
	def: Pick<BehaviourRateDefinition, 'scale'>
): { text: string; direction: 'up' | 'down' | 'flat' | 'none' } {
	if (cell.change == null) return { text: '—', direction: 'none' };
	const value = def.scale === 1 ? cell.change * 100 : cell.change;
	if (Math.abs(value) < (def.scale === 1 ? 0.05 : 0.005)) return { text: '±0', direction: 'flat' };
	const abs = Math.abs(value);
	const digits = abs < 10 ? (def.scale === 1 ? 1 : 2) : 0;
	const unit = def.scale === 1 ? 'pp' : '';
	return { text: `${value > 0 ? '+' : '−'}${abs.toFixed(digits)}${unit}`, direction: value > 0 ? 'up' : 'down' };
}

// ── Over-time chart (inline SVG, the usage page's approach) ──────────────────

export interface BehaviourLine {
	group: string;
	points: Array<{ bucket: number; rate: number }>;
}

export interface BehaviourChartModel {
	lines: BehaviourLine[];
	/** Every bucket start in the window, ascending (the x axis). */
	buckets: number[];
	/** Largest rate plotted (0 = nothing to plot). */
	max: number;
	markers: BehaviourMarker[];
}

/**
 * Lines per group over the window's buckets. Buckets without a rate (no
 * denominator) break nothing: the line simply connects the buckets that have
 * one. Markers are kept as given (the API already filtered and collapsed them).
 */
export function buildBehaviourChart(
	points: readonly BehaviourSeriesPoint[],
	since: number,
	until: number,
	bucketMs: number,
	markers: readonly BehaviourMarker[]
): BehaviourChartModel {
	const byGroup = new Map<string, Array<{ bucket: number; rate: number }>>();
	let max = 0;
	for (const p of points) {
		if (p.rate == null) continue;
		const arr = byGroup.get(p.group) ?? [];
		arr.push({ bucket: p.bucket, rate: p.rate });
		byGroup.set(p.group, arr);
		if (p.rate > max) max = p.rate;
	}
	const lines = [...byGroup].map(([group, pts]) => ({ group, points: pts.sort((a, b) => a.bucket - b.bucket) }));
	const buckets: number[] = [];
	if (bucketMs > 0) {
		const first = Math.min(Math.floor(since / bucketMs) * bucketMs, ...points.map((p) => p.bucket));
		const last = Math.max(until, ...points.map((p) => p.bucket));
		for (let b = first; b <= last && buckets.length < 2000; b += bucketMs) buckets.push(b);
	}
	return { lines, buckets, max, markers: [...markers] };
}

/** x position (0..1) of a time on the chart's axis. */
export function chartX(model: Pick<BehaviourChartModel, 'buckets'>, t: number, bucketMs: number): number {
	const first = model.buckets[0];
	const last = model.buckets.at(-1);
	if (first === undefined || last === undefined) return 0;
	const span = last + bucketMs - first;
	return span > 0 ? Math.max(0, Math.min(1, (t - first) / span)) : 0;
}

/** The incident's deep link: the session in the conversation view at the branch and call. */
export function incidentHref(row: Pick<BehaviourIncidentRow, 'timelineKey' | 'link'>): string {
	return conversationsHref({
		room: row.timelineKey,
		session: row.link.sessionId,
		branch: row.link.branchNo,
		call: row.link.toolCallId,
		attempt: row.link.attemptNo
	});
}

/** The breakdown family a headline rate belongs to (which breakdown section to emphasize). */
export function rateFamily(metric: string | null): 'refusals' | 'contract' | 'style' | null {
	if (!metric) return null;
	if (metric.startsWith('refusal')) return 'refusals';
	if (metric.startsWith('style') || metric.startsWith('messages_with_style')) return 'style';
	return 'contract';
}
