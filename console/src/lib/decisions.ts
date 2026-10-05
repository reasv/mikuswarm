import type { DecisionEvaluation } from '$lib/schemas';

/**
 * Readers for `decision_evaluations` rows (spec SESSION-RECORDS §8). The JSON
 * columns hold exactly what the engine writes (src/decisions/registry.ts):
 *
 * - `verdictJson`: the point's `describe(verdict)`. Routing:
 *   `{ task, difficulty?, models?, thinkingLevel?, skills?, tailFiles? }`.
 *   Records: `{ inject, relevance, candidateSessionId }`.
 * - `answersJson`: the parsed answer map keyed by question name, e.g.
 *   `{ task: { type: 'choice', choice, probabilities, confidence } }` or
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
	return {
		task: v.task,
		...(num(v.difficulty) !== null ? { difficulty: v.difficulty as number } : {}),
		models: strings(v.models),
		...(typeof v.thinkingLevel === 'string' ? { thinkingLevel: v.thinkingLevel } : {}),
		skills: strings(v.skills),
		tailFiles: strings(v.tailFiles)
	};
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

/** One routing verdict as a short label: task, difficulty, models, skills. */
export function routingLabel(v: RoutingVerdict): string {
	const parts = [v.task];
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
	/** Records only: how many candidates were judged. */
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

	const verdict =
		evaluations.length === 1
			? (rowVerdictLabel(evaluations[0]!) ?? '—')
			: evaluations.map((row) => rowVerdictLabel(row) ?? '—').join(' | ');
	return { point, verdict, topConfidence, sources, fallbackReasons };
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
