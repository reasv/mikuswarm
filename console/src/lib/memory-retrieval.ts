import type { MemoryFilterHit, MemoryRetrieval, MemoryStatsWindow } from '$lib/schemas';

/**
 * Readers for the judged memory retrieval rows (spec MEMORY-RETRIEVAL §7.4, §9;
 * ARCHITECTURE.md §9d "Observability"): a `memory_retrievals` row's
 * `reportJson` (the pipeline's `RetrievalReport`, src/retrieval/auto/types.ts),
 * the `memory_filter_hits` audit rows, and the follow-up / source-mix stats.
 *
 * Every reader is defensive: malformed JSON or a missing field degrades to
 * null / empty / a skipped item, never a throw, so one odd row cannot break
 * the session view or the memory page.
 */

export const ITEM_STAGES = [
	'kept',
	'dropped',
	'hidden',
	'recency',
	'cut_late',
	'cut_rerank',
	'not_judged',
	'not_selected',
	'budget',
	'aborted'
] as const;
export type ItemStage = (typeof ITEM_STAGES)[number];

export interface HiddenBy {
	key: string;
	kind: string;
	/** The matched keyword or pattern. */
	detail?: string;
	probability?: number;
	/** Hidden by the `pending = "hide"` policy, not a verdict. */
	pending?: boolean;
}

export interface ReportItem {
	contentHash: string;
	citation: string;
	lanes: string[];
	hybrid: number | null;
	/** null = no vectors; undefined = the stage did not run. */
	late?: number | null;
	rerank?: number | null;
	relevant: number | null;
	aboutParticipant: number | null;
	presence: boolean;
	/** One of ITEM_STAGES, or an unknown stage from a newer backend, kept verbatim. */
	stage: string;
	hiddenBy?: HiddenBy;
	/** True when the memory point answered for this passage; false when it did not (absent on older reports). */
	judged?: boolean;
	/** A kept item's chooser: `judge`, `fallback` (the decision chain did not answer for it) or `unjudged` (no decision model). */
	selectedBy?: string;
}

export interface LateStage {
	status: string;
	backend: string | null;
	ms: number | null;
	windowSize: number | null;
	missing: number | null;
	queryModel: string | null;
}

export interface RerankStage {
	status: string;
	provider: string | null;
	ms: number | null;
}

export interface RetrievalReport {
	source: string;
	reason?: string;
	candidates: number;
	judged: number;
	/** Passages that got no model verdict (they went through the fallback rule). */
	unjudged?: number;
	/** Shown items the fallback rule chose. */
	fellBack?: number;
	/** The plan was aborted before the build used it: nothing was shown. */
	aborted?: boolean;
	kept: number;
	hidden: number;
	tokens: number;
	ms: number;
	decisionGroup?: string;
	stages: {
		recallMs: number | null;
		vectorIndex?: string;
		late?: LateStage;
		rerank?: RerankStage;
		judgeMs?: number;
	};
	items: ReportItem[];
}

function parse(json: string | null | undefined): unknown {
	if (!json) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

export function parseHiddenBy(v: unknown): HiddenBy | undefined {
	if (!isObject(v) || typeof v.key !== 'string') return undefined;
	const detail = str(v.detail);
	const probability = num(v.probability);
	return {
		key: v.key,
		kind: str(v.kind) ?? '?',
		...(detail !== null ? { detail } : {}),
		...(probability !== null ? { probability } : {}),
		...(v.pending === true ? { pending: true } : {})
	};
}

function parseItem(v: unknown): ReportItem | null {
	if (!isObject(v) || typeof v.stage !== 'string') return null;
	const citation = str(v.citation);
	const contentHash = str(v.contentHash);
	if (citation === null && contentHash === null) return null;
	const hiddenBy = parseHiddenBy(v.hiddenBy);
	return {
		contentHash: contentHash ?? '',
		citation: citation ?? (contentHash as string).slice(0, 12),
		lanes: strings(v.lanes),
		hybrid: num(v.hybrid),
		...(v.late === null ? { late: null } : num(v.late) !== null ? { late: num(v.late) } : {}),
		...(num(v.rerank) !== null ? { rerank: num(v.rerank) } : {}),
		relevant: num(v.relevant),
		aboutParticipant: num(v.aboutParticipant),
		presence: v.presence === true,
		stage: v.stage,
		...(hiddenBy ? { hiddenBy } : {}),
		...(typeof v.judged === 'boolean' ? { judged: v.judged } : {}),
		...(typeof v.selectedBy === 'string' ? { selectedBy: v.selectedBy } : {})
	};
}

function parseLate(v: unknown): LateStage | undefined {
	if (!isObject(v) || typeof v.status !== 'string') return undefined;
	return {
		status: v.status,
		backend: str(v.backend),
		ms: num(v.ms),
		windowSize: num(v.windowSize),
		missing: num(v.missing),
		queryModel: str(v.queryModel)
	};
}

function parseRerank(v: unknown): RerankStage | undefined {
	if (!isObject(v) || typeof v.status !== 'string') return undefined;
	return { status: v.status, provider: str(v.provider), ms: num(v.ms) };
}

/** A `memory_retrievals.report_json` value, or null when absent or malformed. */
export function parseRetrievalReport(json: string | null | undefined): RetrievalReport | null {
	const v = parse(json);
	if (!isObject(v)) return null;
	const stages = isObject(v.stages) ? v.stages : {};
	const items = Array.isArray(v.items)
		? v.items.map(parseItem).filter((i): i is ReportItem => i !== null)
		: [];
	const late = parseLate(stages.late);
	const rerank = parseRerank(stages.rerank);
	const vectorIndex = str(stages.vectorIndex);
	const judgeMs = num(stages.judgeMs);
	const reason = str(v.reason);
	const decisionGroup = str(v.decisionGroup);
	const unjudged = num(v.unjudged);
	const fellBack = num(v.fellBack);
	return {
		source: str(v.source) ?? '?',
		...(reason !== null ? { reason } : {}),
		candidates: num(v.candidates) ?? 0,
		judged: num(v.judged) ?? 0,
		...(unjudged !== null ? { unjudged } : {}),
		...(fellBack !== null ? { fellBack } : {}),
		...(v.aborted === true ? { aborted: true } : {}),
		kept: num(v.kept) ?? 0,
		hidden: num(v.hidden) ?? 0,
		tokens: num(v.tokens) ?? 0,
		ms: num(v.ms) ?? 0,
		...(decisionGroup !== null ? { decisionGroup } : {}),
		stages: {
			recallMs: num(stages.recallMs),
			...(vectorIndex !== null ? { vectorIndex } : {}),
			...(late ? { late } : {}),
			...(rerank ? { rerank } : {}),
			...(judgeMs !== null ? { judgeMs } : {})
		},
		items
	};
}

/** The card's four item groups. `cut` holds every stage that is not kept, dropped or hidden. */
export interface ReportGroups {
	kept: ReportItem[];
	dropped: ReportItem[];
	hidden: ReportItem[];
	cut: ReportItem[];
}

const byRelevance = (a: ReportItem, b: ReportItem) => (b.relevant ?? -1) - (a.relevant ?? -1);
const stageOrder = (s: string): number => {
	const i = (ITEM_STAGES as readonly string[]).indexOf(s);
	return i < 0 ? ITEM_STAGES.length : i;
};

/** Group a report's items: kept and dropped by relevance (highest first), cut by stage. */
export function groupReportItems(items: readonly ReportItem[]): ReportGroups {
	const out: ReportGroups = { kept: [], dropped: [], hidden: [], cut: [] };
	for (const item of items) {
		if (item.stage === 'kept') out.kept.push(item);
		else if (item.stage === 'dropped') out.dropped.push(item);
		else if (item.stage === 'hidden') out.hidden.push(item);
		else out.cut.push(item);
	}
	out.kept.sort(byRelevance);
	out.dropped.sort(byRelevance);
	// Stable sort: report order within one stage.
	out.cut.sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage));
	return out;
}

const STAGE_LABELS: Record<string, string> = {
	kept: 'kept',
	dropped: 'dropped',
	hidden: 'hidden',
	recency: 'in recency layer',
	cut_late: 'cut at late stage',
	cut_rerank: 'cut at rerank',
	not_judged: 'not judged',
	not_selected: 'not selected',
	budget: 'over token budget',
	aborted: 'plan aborted, not shown'
};

/**
 * The badge of a kept item chosen without a model verdict: "fallback" (the
 * decision chain did not answer for it, or it was over `max_judged`) or
 * "unjudged" (no decision model); null for a judge's pick.
 */
export function selectionLabel(item: Pick<ReportItem, 'stage' | 'selectedBy'>): string | null {
	if (item.stage !== 'kept') return null;
	if (item.selectedBy === 'fallback') return 'fallback';
	if (item.selectedBy === 'unjudged') return 'unjudged';
	return null;
}

export function stageLabel(stage: string): string {
	return STAGE_LABELS[stage] ?? stage;
}

const p2 = (p: number) => p.toFixed(2);

/** "hidden by old_bit (keyword "some phrase")", "hidden by habit (judged p=0.91)". */
export function hiddenByLabel(h: HiddenBy): string {
	let how: string;
	if (h.pending) how = `${h.kind}, pending`;
	else if (h.detail !== undefined) how = `${h.kind} "${h.detail}"`;
	else if (h.probability !== undefined) how = `${h.kind} p=${p2(h.probability)}`;
	else how = h.kind;
	return `hidden by ${h.key} (${how})`;
}

/** The item's ranking scores on one line: "hybrid 0.62 · late 0.71 · rerank 0.44". */
export function scoresLabel(item: ReportItem): string {
	const parts: string[] = [];
	if (item.hybrid !== null) parts.push(`hybrid ${p2(item.hybrid)}`);
	if (item.late === null) parts.push('late n/a');
	else if (item.late !== undefined) parts.push(`late ${p2(item.late)}`);
	if (item.rerank != null) parts.push(`rerank ${p2(item.rerank)}`);
	return parts.join(' · ');
}

/** The judge's answers on one line: "relevant 0.82 · about participant 0.40". */
export function judgeLabel(item: ReportItem): string | null {
	const parts: string[] = [];
	if (item.relevant !== null) parts.push(`relevant ${p2(item.relevant)}`);
	if (item.aboutParticipant !== null) parts.push(`about participant ${p2(item.aboutParticipant)}`);
	return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatMs(ms: number | null | undefined): string {
	if (ms == null) return '?';
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** The stage timings and statuses, one short string each. */
export function stageTimings(report: RetrievalReport): string[] {
	const s = report.stages;
	const out: string[] = [];
	if (s.recallMs !== null) out.push(`recall ${formatMs(s.recallMs)}`);
	if (s.vectorIndex) out.push(`index ${s.vectorIndex}`);
	if (s.late) {
		const extra = [
			s.late.backend,
			s.late.windowSize !== null ? `window ${s.late.windowSize}` : null,
			s.late.missing ? `${s.late.missing} missing` : null
		].filter(Boolean);
		out.push(
			`late ${s.late.status}${s.late.ms !== null ? ` ${formatMs(s.late.ms)}` : ''}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`
		);
	}
	if (s.rerank) {
		out.push(
			`rerank ${s.rerank.status}${s.rerank.ms !== null ? ` ${formatMs(s.rerank.ms)}` : ''}${s.rerank.provider ? ` (${s.rerank.provider})` : ''}`
		);
	}
	if (s.judgeMs !== undefined) out.push(`judge ${formatMs(s.judgeMs)}`);
	return out;
}

/** "kept 3 of 41", plus the hidden count when any. From the row's own columns. */
export function retrievalCountsLabel(row: Pick<MemoryRetrieval, 'kept' | 'candidates' | 'hidden'>): string {
	const base = `kept ${row.kept} of ${row.candidates}`;
	return row.hidden > 0 ? `${base}, ${row.hidden} hidden` : base;
}

// ── Filters page (spec §7.4) ────────────────────────────────────────────────

/** The block's citation from a hit row: "memory/2026-05-10.md:12-30", else the path or hash. */
export function hitCitation(hit: Pick<MemoryFilterHit, 'path' | 'startLine' | 'endLine' | 'contentHash'>): string {
	if (!hit.path) return hit.contentHash.slice(0, 12);
	if (hit.startLine == null) return hit.path;
	return `${hit.path}:${hit.startLine}-${hit.endLine ?? hit.startLine}`;
}

/** What matched: the keyword/pattern for a mechanical filter, the probability for a judged one. */
export function hitMatchLabel(hit: Pick<MemoryFilterHit, 'kind' | 'detail' | 'probability'>): string {
	if (hit.detail) return hit.kind === 'judged' ? hit.detail : `"${hit.detail}"`;
	if (hit.probability != null) return `p=${p2(hit.probability)}`;
	return '—';
}

export interface FilterHitGroup {
	filterKey: string;
	/** Distinct kinds seen for this key (normally one). */
	kinds: string[];
	/** Distinct filter versions (an edited filter has a new hash). */
	versions: number;
	/** Hidden blocks. */
	blocks: number;
	/** Total hide events over the blocks. */
	hides: number;
	firstHiddenAt: number;
	lastHiddenAt: number;
	hits: MemoryFilterHit[];
}

/** Hits grouped per filter key, most recently active filter first; hits newest first. */
export function groupFilterHits(hits: readonly MemoryFilterHit[]): FilterHitGroup[] {
	const map = new Map<string, MemoryFilterHit[]>();
	for (const h of hits) {
		const arr = map.get(h.filterKey);
		if (arr) arr.push(h);
		else map.set(h.filterKey, [h]);
	}
	const groups: FilterHitGroup[] = [];
	for (const [filterKey, list] of map) {
		const sorted = [...list].sort((a, b) => b.lastHiddenAt - a.lastHiddenAt);
		groups.push({
			filterKey,
			kinds: [...new Set(sorted.map((h) => h.kind))],
			versions: new Set(sorted.map((h) => h.filterHash)).size,
			blocks: sorted.length,
			hides: sorted.reduce((n, h) => n + (Number.isFinite(h.hideCount) ? h.hideCount : 0), 0),
			firstHiddenAt: Math.min(...sorted.map((h) => h.firstHiddenAt)),
			lastHiddenAt: sorted[0]!.lastHiddenAt,
			hits: sorted
		});
	}
	return groups.sort((a, b) => b.lastHiddenAt - a.lastHiddenAt);
}

// ── Stats (spec §9 follow-up rate) ──────────────────────────────────────────

/**
 * Build sources in the mix. `model_fallback` is a `model` build that also
 * showed fallback-selected items (some passages got no verdict).
 */
export const RETRIEVAL_SOURCES = ['model', 'model_fallback', 'fallback', 'unjudged', 'none'] as const;

const SOURCE_LABELS: Record<string, string> = { model_fallback: 'model + fallback' };

export function sourceLabel(source: string): string {
	return SOURCE_LABELS[source] ?? source;
}

export function formatRate(rate: number | null | undefined): string {
	return rate == null || !Number.isFinite(rate) ? '—' : `${(rate * 100).toFixed(1)}%`;
}

/** The source mix of a window: the known sources first (zero when absent), then any others. */
export function sourceMix(window: Pick<MemoryStatsWindow, 'sources'>): Array<{ source: string; count: number; share: number | null }> {
	const counts = new Map<string, number>();
	for (const s of RETRIEVAL_SOURCES) counts.set(s, 0);
	for (const [s, n] of Object.entries(window.sources ?? {})) {
		if (typeof n === 'number' && Number.isFinite(n)) counts.set(s, n);
	}
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	return [...counts].map(([source, count]) => ({ source, count, share: total > 0 ? count / total : null }));
}
