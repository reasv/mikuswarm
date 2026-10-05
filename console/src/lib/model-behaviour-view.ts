import type {
	BehaviourIncidentRow,
	BehaviourMarker,
	BehaviourModelInfo,
	BehaviourRateCell,
	BehaviourRateDefinition,
	BehaviourScorecardRow,
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
/** Incident type buttons, worded like the row chips they select on. */
export const INCIDENT_TYPE_LABELS: Record<(typeof INCIDENT_TYPES)[number], string> = {
	refusal: 'refused',
	nudge: 'nudged',
	redo: 'redone',
	revision: 'revised / overridden',
	ending: 'judged ending fired'
};
/** How a config entry is named on the page: its config key, its wire model id, or both. */
export const MODEL_LABELS = ['key', 'id', 'both'] as const;
export type ModelLabelMode = (typeof MODEL_LABELS)[number];
export type SortDir = 'asc' | 'desc';

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
	/** What the over-time chart plots: a headline rate id or `mix:<family>`; null = the overview of every rate. */
	metric: string | null;
	/** Incident type filter. */
	type: string | null;
	/** Scorecard sort column (`group`, `volume` or a rate id); null = the API's order (by volume). */
	sort: string | null;
	dir: SortDir;
	/** Model naming (group by model): config key (default), wire id, or both. */
	label: ModelLabelMode;
}

const WINDOW_IDS: readonly string[] = BEHAVIOUR_WINDOWS.map((w) => w.id);
const nonEmpty = (v: string | null): string | null => (v != null && v !== '' ? v : null);

/** Read the filters from the URL; unknown or hand-edited values fall back to defaults. */
export function parseBehaviourFilters(sp: URLSearchParams): BehaviourFilters {
	const window = sp.get('window');
	const groupBy = sp.get('group');
	const type = sp.get('type');
	const label = sp.get('label');
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
		type: type != null && (INCIDENT_TYPES as readonly string[]).includes(type) ? type : null,
		sort: nonEmpty(sp.get('sort')),
		dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
		label: label != null && (MODEL_LABELS as readonly string[]).includes(label) ? (label as ModelLabelMode) : 'key'
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
		type: f.type,
		sort: f.sort,
		dir: f.sort && f.dir === 'asc' ? 'asc' : null,
		label: f.label === 'key' ? null : f.label
	};
}

/** The remote query argument (`getModelBehaviour` / `getModelBehaviourIncidents`); sort and labels are client-side. */
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
	if (metric.startsWith('refusal') || metric === 'mix:judged_refusal_reason') return 'refusals';
	if (metric.startsWith('style') || metric.startsWith('messages_with_style')) return 'style';
	return 'contract';
}

// ── Scorecard sorting and model labels ───────────────────────────────────────

/**
 * Click on a column header: a new column sorts descending first (largest rates
 * and volumes on top) except the group name, which starts ascending; the same
 * column toggles the direction.
 */
export function nextSort(current: { sort: string | null; dir: SortDir }, column: string): { sort: string; dir: SortDir } {
	if (current.sort === column) return { sort: column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
	return { sort: column, dir: column === 'group' ? 'asc' : 'desc' };
}

/**
 * Scorecard rows in the chosen order: by group label, by volume (requests, then
 * sessions) or by a rate. Rows without a rate (no denominator) always go last;
 * ties keep the API's order. Pure; null `sort` keeps the API's order.
 */
export function sortScorecard(
	rows: readonly BehaviourScorecardRow[],
	sort: string | null,
	dir: SortDir,
	labelOf: (group: string) => string = (g) => g
): BehaviourScorecardRow[] {
	const out = rows.map((row, i) => ({ row, i }));
	if (!sort) return out.map((x) => x.row);
	const sign = dir === 'asc' ? 1 : -1;
	out.sort((a, b) => {
		if (sort === 'group') {
			const la = labelOf(a.row.group);
			const lb = labelOf(b.row.group);
			return (la < lb ? -1 : la > lb ? 1 : 0) * sign || a.i - b.i;
		}
		if (sort === 'volume') {
			const d = a.row.volume.requests - b.row.volume.requests || a.row.volume.sessions - b.row.volume.sessions;
			return d * sign || a.i - b.i;
		}
		const ra = a.row.cells[sort]?.rate ?? null;
		const rb = b.row.cells[sort]?.rate ?? null;
		if (ra === null || rb === null) return ra === rb ? a.i - b.i : ra === null ? 1 : -1;
		return (ra - rb) * sign || a.i - b.i;
	});
	return out.map((x) => x.row);
}

/**
 * The display name of a model group: the config key, its wire model id, or
 * `key · id`. Only config entries have ids; other groups (agents, sites, tasks,
 * families) are shown as they are.
 */
export function modelLabel(
	group: string,
	models: Readonly<Record<string, BehaviourModelInfo>> | undefined,
	mode: ModelLabelMode
): string {
	if (group === '') return '(unknown)';
	const id = models?.[group]?.id;
	if (!id || mode === 'key') return group;
	if (mode === 'id') return id;
	return id === group ? group : `${group} · ${id}`;
}

// ── Chart metric choice ──────────────────────────────────────────────────────

/** A chart metric is a keyed family (`mix:<family>`, one line per key) rather than a rate. */
export const isMixMetric = (metric: string | null): boolean => metric?.startsWith('mix:') ?? false;

/** A count as shown on a family chart axis. */
export function formatCount(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * The chart's empty state, worded by why it is empty: a rate with a numerator of
 * 0 over a real denominator ("none recorded: 0 of 412 requests"), a rate with no
 * denominator (no activity), or a family with nothing recorded.
 */
export function emptyChartReason(option: { label: string; kind: string; count: number; denominator: number | null } | undefined, denominatorName?: string): string {
	if (!option) return 'Nothing to plot in this window.';
	if (option.kind === 'count') return `No ${option.label.toLowerCase()} recorded in this window.`;
	if ((option.denominator ?? 0) === 0) return `No ${denominatorName ?? 'activity'} in this window, so no ${option.label.toLowerCase()} to show.`;
	return `None recorded in this window: 0 of ${option.denominator} ${denominatorName ?? ''}`.trimEnd() + '.';
}
