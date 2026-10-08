import type { DecisionEvaluation } from '$lib/schemas';

/**
 * Readers for `decision_evaluations` rows (spec SESSION-RECORDS §8). The JSON
 * columns hold exactly what the engine writes (src/decisions/registry.ts):
 *
 * - `verdictJson`: the point's `describe(verdict)`. Routing:
 *   `{ task, tasks?, difficulty?, models?, thinkingLevel?, skills?, tailFiles? }`
 *   (`tasks` = every selected task, multi-label; `task` = the first of them).
 *   Records: `{ inject, relevance, candidateSessionId }`.
 *   Memory (one row per passage): `{ citation, contentHash, keep, relevant,
 *   aboutParticipant, hiddenBy?, scores }`, or for a filter-only call (the
 *   recency layer, the search tools) `{ citation, contentHash, surface, filters }`.
 * - `answersJson`: the parsed answer map keyed by question name, e.g.
 *   routing's `{ task__<key>: { type: 'noul', noul }, skill__<name>: …,
 *   difficulty: { type: 'score', … } }` (older rows: one `task` choice) or
 *   `{ relevant: { type: 'noul', noul } }`. Null when no member answered.
 *
 * Every reader is defensive: a malformed or missing column degrades to null /
 * empty, never throws, so one odd row cannot break the session view.
 */

export type DecisionAnswer =
	| { type: 'noul'; noul: number }
	| { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

export interface RoutingVerdict {
	task: string;
	/** Every selected task (multi-label); `[task]` for rows written before multi-label routing. */
	tasks: string[];
	difficulty?: number;
	models: string[];
	thinkingLevel?: string;
	skills: string[];
	tailFiles: string[];
}

export interface RecordsVerdict {
	inject: boolean;
	relevance: number;
	candidateSessionId: string | null;
}

/** A `memory` row judging one passage for auto-retrieval. */
export interface MemoryRelevanceVerdict {
	kind: 'relevance';
	citation: string;
	contentHash: string;
	keep: boolean;
	/** Null on the fallback (not judged). */
	relevant: number | null;
	aboutParticipant: number | null;
	/** Keys of the judged filters that hid the passage. */
	hiddenBy: string[];
	scores: Record<string, number | null>;
}

/** A `memory` row judging one block against judged filters only. */
export interface MemoryFilterVerdict {
	kind: 'filter';
	citation: string;
	contentHash: string;
	surface: string;
	/** Per filter key; null when not judged (fallback). */
	filters: Record<string, { probability: number; hidden: boolean }> | null;
}

export type MemoryVerdict = MemoryRelevanceVerdict | MemoryFilterVerdict;

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
const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

function probabilities(v: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isObject(v)) return out;
	for (const [k, p] of Object.entries(v)) if (num(p) !== null) out[k] = p as number;
	return out;
}

/** The answer map, keyed by question name; malformed entries are skipped. */
export function parseAnswers(json: string | null | undefined): Record<string, DecisionAnswer> {
	const raw = parse(json);
	const out: Record<string, DecisionAnswer> = {};
	if (!isObject(raw)) return out;
	for (const [name, a] of Object.entries(raw)) {
		if (!isObject(a)) continue;
		if (a.type === 'noul' && num(a.noul) !== null) {
			out[name] = { type: 'noul', noul: a.noul as number };
		} else if (a.type === 'choice' && typeof a.choice === 'string' && num(a.confidence) !== null) {
			out[name] = {
				type: 'choice',
				choice: a.choice,
				probabilities: probabilities(a.probabilities),
				confidence: a.confidence as number
			};
		} else if (a.type === 'score' && num(a.score) !== null && num(a.confidence) !== null) {
			out[name] = {
				type: 'score',
				score: a.score as number,
				probabilities: probabilities(a.probabilities),
				confidence: a.confidence as number
			};
		}
	}
	return out;
}

/**
 * The confidence an answer carries: a `noul`'s probability (it has no separate
 * confidence), or a choice/score answer's own `confidence`.
 */
export function answerConfidence(a: DecisionAnswer): number {
	return a.type === 'noul' ? a.noul : a.confidence;
}

/** The answer itself, as a short label. */
export function answerLabel(a: DecisionAnswer): string {
	if (a.type === 'noul') return `p=${a.noul.toFixed(2)}`;
	if (a.type === 'choice') return a.choice;
	return `level ${a.score}`;
}

export function parseRoutingVerdict(json: string | null | undefined): RoutingVerdict | null {
	const v = parse(json);
	if (!isObject(v) || typeof v.task !== 'string') return null;
	const tasks = strings(v.tasks);
	return {
		task: v.task,
		tasks: tasks.length > 0 ? tasks : [v.task],
		...(num(v.difficulty) !== null ? { difficulty: v.difficulty as number } : {}),
		models: strings(v.models),
		...(typeof v.thinkingLevel === 'string' ? { thinkingLevel: v.thinkingLevel } : {}),
		skills: strings(v.skills),
		tailFiles: strings(v.tailFiles)
	};
}

/** One routing question's answer: a task or skill key, its probability, whether the verdict selected it. */
export interface RoutingLabelAnswer {
	key: string;
	probability: number;
	selected: boolean;
}

/**
 * The routing point's per-label answers (one `noul` per task, `task__<key>`, and
 * per preloadable skill, `skill__<name>`), highest probability first, each
 * marked when the row's verdict selected it. Empty for older single-choice rows.
 */
export function routingLabelAnswers(row: DecisionEvaluation): { tasks: RoutingLabelAnswer[]; skills: RoutingLabelAnswer[] } {
	const verdict = parseRoutingVerdict(row.verdictJson);
	const tasks: RoutingLabelAnswer[] = [];
	const skills: RoutingLabelAnswer[] = [];
	for (const [name, a] of Object.entries(parseAnswers(row.answersJson))) {
		if (a.type !== 'noul') continue;
		if (name.startsWith('task__')) {
			const key = name.slice('task__'.length);
			tasks.push({ key, probability: a.noul, selected: verdict?.tasks.includes(key) ?? false });
		} else if (name.startsWith('skill__')) {
			const key = name.slice('skill__'.length);
			skills.push({ key, probability: a.noul, selected: verdict?.skills.includes(key) ?? false });
		}
	}
	const byP = (x: RoutingLabelAnswer, y: RoutingLabelAnswer) => y.probability - x.probability;
	return { tasks: tasks.sort(byP), skills: skills.sort(byP) };
}

export function parseRecordsVerdict(json: string | null | undefined): RecordsVerdict | null {
	const v = parse(json);
	if (!isObject(v) || typeof v.inject !== 'boolean') return null;
	return {
		inject: v.inject,
		relevance: num(v.relevance) ?? 0,
		candidateSessionId: typeof v.candidateSessionId === 'string' ? v.candidateSessionId : null
	};
}

function memoryScores(v: unknown): Record<string, number | null> {
	const out: Record<string, number | null> = {};
	if (!isObject(v)) return out;
	for (const [k, s] of Object.entries(v)) {
		if (s === null) out[k] = null;
		else if (num(s) !== null) out[k] = s as number;
	}
	return out;
}

/** A `memory` row's verdict (relevance or filter-only), or null when malformed. */
export function parseMemoryVerdict(json: string | null | undefined): MemoryVerdict | null {
	const v = parse(json);
	if (!isObject(v)) return null;
	const citation = typeof v.citation === 'string' ? v.citation : null;
	const contentHash = typeof v.contentHash === 'string' ? v.contentHash : '';
	if (typeof v.keep === 'boolean') {
		return {
			kind: 'relevance',
			citation: citation ?? contentHash.slice(0, 12),
			contentHash,
			keep: v.keep,
			relevant: num(v.relevant),
			aboutParticipant: num(v.aboutParticipant),
			hiddenBy: strings(v.hiddenBy),
			scores: memoryScores(v.scores)
		};
	}
	if ('filters' in v) {
		let filters: MemoryFilterVerdict['filters'] = null;
		if (isObject(v.filters)) {
			filters = {};
			for (const [k, f] of Object.entries(v.filters)) {
				if (isObject(f) && num(f.probability) !== null) {
					filters[k] = { probability: f.probability as number, hidden: f.hidden === true };
				}
			}
		}
		return {
			kind: 'filter',
			citation: citation ?? contentHash.slice(0, 12),
			contentHash,
			surface: typeof v.surface === 'string' ? v.surface : '?',
			filters
		};
	}
	return null;
}

/** "keep p=0.82", "drop p=0.10", "hidden by k", "not judged"; filter rows: "hidden by k", "shown", "unjudged". */
export function memoryVerdictLabel(v: MemoryVerdict): string {
	if (v.kind === 'relevance') {
		if (v.hiddenBy.length > 0) return `hidden by ${v.hiddenBy.join(', ')}`;
		if (v.relevant === null) return 'not judged';
		return `${v.keep ? 'keep' : 'drop'} p=${v.relevant.toFixed(2)}`;
	}
	if (v.filters === null) return 'unjudged';
	const hidden = Object.entries(v.filters)
		.filter(([, f]) => f.hidden)
		.map(([k]) => k);
	return hidden.length > 0 ? `hidden by ${hidden.join(', ')}` : 'shown';
}

/** One routing verdict as a short label: tasks, difficulty, models, skills. */
export function routingLabel(v: RoutingVerdict): string {
	const parts = [v.tasks.join(' + ')];
	if (v.difficulty !== undefined) parts.push(`difficulty ${v.difficulty}`);
	if (v.models.length > 0) parts.push(v.models.join(' → '));
	if (v.thinkingLevel) parts.push(`thinking ${v.thinkingLevel}`);
	if (v.skills.length > 0) parts.push(`+${v.skills.join(', +')}`);
	if (v.tailFiles.length > 0) parts.push(`tail ${v.tailFiles.join(', ')}`);
	return parts.join(' · ');
}

/** One row's verdict as a short label. */
export function rowVerdictLabel(row: DecisionEvaluation): string | null {
	if (row.point === 'routing') {
		const v = parseRoutingVerdict(row.verdictJson);
		return v ? routingLabel(v) : null;
	}
	if (row.point === 'records') {
		const v = parseRecordsVerdict(row.verdictJson);
		return v ? (v.inject ? 'inject' : 'skip') : null;
	}
	if (row.point === 'memory') {
		const v = parseMemoryVerdict(row.verdictJson);
		return v ? memoryVerdictLabel(v) : null;
	}
	if (row.point === 'checks') {
		// Output gate rows (spec REFUSAL-HANDLING §9): the fired codes, else clean.
		const v = parse(row.verdictJson);
		if (!isObject(v)) return null;
		if (v.unjudged === true) return 'unjudged';
		const fired = strings(v.fired);
		return fired.length > 0 ? `fired ${fired.join(', ')}` : 'clean';
	}
	return null;
}

/** The highest confidence over a row's answers, or null when nothing answered. */
export function rowTopConfidence(row: DecisionEvaluation): number | null {
	let top: number | null = null;
	for (const a of Object.values(parseAnswers(row.answersJson))) {
		const c = answerConfidence(a);
		if (top === null || c > top) top = c;
	}
	return top;
}

/** The collapsed summary of one decision (all rows of one `decisionGroup`). */
export interface DecisionGroupSummary {
	point: string;
	/** Routing: the routing label. Records: which candidates were injected. */
	verdict: string;
	topConfidence: number | null;
	/** How many rows the model answered and how many fell back to the heuristic. */
	sources: { model: number; heuristic: number };
	/** Each distinct fallback reason with its count, e.g. `{ reason: 'timeout', count: 2 }`. */
	fallbackReasons: Array<{ reason: string; count: number }>;
	/** Records only: the injected candidate session ids, in injection order. */
	injected?: string[];
	/** Records and memory: how many candidates were judged. */
	candidates?: number;
}

/**
 * Summarize a decision group. `injected` is what the transcript shows was
 * actually injected for this group (its harness `read_session_record` calls);
 * pass undefined when the transcript is not available yet, and the summary
 * falls back to the rows' own `inject` verdicts, highest relevance first.
 */
export function summarizeDecisionGroup(
	evaluations: readonly DecisionEvaluation[],
	injected?: readonly string[]
): DecisionGroupSummary {
	const point = evaluations[0]?.point ?? '?';
	const sources = { model: 0, heuristic: 0 };
	const reasons = new Map<string, number>();
	let topConfidence: number | null = null;
	for (const row of evaluations) {
		if (row.source === 'model') sources.model += 1;
		else sources.heuristic += 1;
		if (row.reason) reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
		const c = rowTopConfidence(row);
		if (c !== null && (topConfidence === null || c > topConfidence)) topConfidence = c;
	}
	const fallbackReasons = [...reasons].map(([reason, count]) => ({ reason, count }));

	if (point === 'records') {
		const ids =
			injected !== undefined
				? [...injected]
				: evaluations
						.map((row) => ({ row, v: parseRecordsVerdict(row.verdictJson) }))
						.filter(({ v }) => v?.inject)
						.sort((a, b) => b.v!.relevance - a.v!.relevance)
						.map(({ row, v }) => v!.candidateSessionId ?? row.candidateSessionId ?? '?');
		return {
			point,
			verdict: ids.length > 0 ? `injected ${ids.join(', ')}` : 'nothing injected',
			topConfidence,
			sources,
			fallbackReasons,
			injected: ids,
			candidates: evaluations.length
		};
	}

	if (point === 'memory') {
		return { point, verdict: memoryGroupVerdict(evaluations), topConfidence, sources, fallbackReasons, candidates: evaluations.length };
	}

	const verdict =
		evaluations.length === 1
			? (rowVerdictLabel(evaluations[0]!) ?? '—')
			: evaluations.map((row) => rowVerdictLabel(row) ?? '—').join(' | ');
	return { point, verdict, topConfidence, sources, fallbackReasons };
}

/**
 * A memory group in one phrase: "kept 2 of 9, 1 hidden" for a retrieval's
 * passages; "hid 1 of 3" / "nothing hidden" for filter-only rows.
 */
function memoryGroupVerdict(evaluations: readonly DecisionEvaluation[]): string {
	let relevance = 0;
	let kept = 0;
	let hidden = 0;
	let filterRows = 0;
	for (const row of evaluations) {
		const v = parseMemoryVerdict(row.verdictJson);
		if (!v) continue;
		if (v.kind === 'relevance') {
			relevance += 1;
			if (v.hiddenBy.length > 0) hidden += 1;
			else if (v.keep) kept += 1;
		} else {
			filterRows += 1;
			if (v.filters && Object.values(v.filters).some((f) => f.hidden)) hidden += 1;
		}
	}
	if (relevance > 0) {
		const base = `kept ${kept} of ${relevance}`;
		return hidden > 0 ? `${base}, ${hidden} hidden` : base;
	}
	if (filterRows > 0) return hidden > 0 ? `hid ${hidden} of ${filterRows}` : 'nothing hidden';
	return '—';
}

/** "timeout", "error ×2, timeout": the fallback reasons, for one line. */
export function fallbackReasonsLabel(s: DecisionGroupSummary): string | null {
	if (s.fallbackReasons.length === 0) return null;
	return s.fallbackReasons.map(({ reason, count }) => (count > 1 ? `${reason} ×${count}` : reason)).join(', ');
}

/** Group rows by `decisionGroup`, in first-seen (ts) order. */
export function groupDecisions(
	evaluations: readonly DecisionEvaluation[]
): Map<string, DecisionEvaluation[]> {
	const map = new Map<string, DecisionEvaluation[]>();
	for (const ev of evaluations) {
		const arr = map.get(ev.decisionGroup);
		if (arr) arr.push(ev);
		else map.set(ev.decisionGroup, [ev]);
	}
	return map;
}

/** The inline card's element id, shared by the card and the details-pane jump link. */
export function decisionElementId(decisionGroup: string): string {
	return `decision-${decisionGroup}`;
}
