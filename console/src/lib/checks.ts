import type { CheckInfo, ContractAttempt, DecisionEvaluation, RefusalEvent, SessionAudit } from '$lib/schemas';
import { assistantBlocks, contentText, type RolloutMsg } from '$lib/rollout';

/**
 * Readers for the output gate's records (spec REFUSAL-HANDLING §9, §12.2).
 * `checks` decision rows hold exactly what the agent's evaluator writes
 * (src/checks/evaluator.ts, src/decisions/points/checks.ts):
 *
 * - a judged call: `verdictJson` = `{ fired: [codes], results: [{ id, p, t,
 *   fired?, choice? }] }` (question id `<code>__<source>`, `_2`… on repeats),
 *   `answersJson` keyed by question id, `servedModel`, `latencyMs`;
 * - a pattern hit: `source: 'pattern'`, `verdictJson` = `{ fired: [code],
 *   source, matched }`, no model fields;
 * - a skipped or failed call: `verdictJson` = `{ unjudged: true }`, `reason`.
 *
 * Rows of one evaluation share `decisionGroup` and the anchor (checkpoint,
 * branch, judged tool call or ending attempt, consequence). Every reader is
 * defensive: a malformed row degrades, never throws.
 */

export interface QuestionVerdict {
	id: string;
	source: string;
	probability: number;
	threshold: number;
	fired: boolean;
	choice?: string;
}

export interface CheckVerdict {
	code: string;
	kind: string;
	description: string | null;
	fired: boolean;
	method: 'pattern' | 'judged' | null;
	/** Pattern hit: the text that matched. */
	matched?: string;
	/** The strongest fired question's (or a pattern's, 1) probability; else the highest asked. */
	probability: number | null;
	threshold: number | null;
	source: string | null;
	questions: QuestionVerdict[];
}

export interface GateEvaluation {
	decisionGroup: string;
	checkpoint: string | null;
	branchNo: number;
	toolCallId: string | null;
	attemptNo: number | null;
	consequence: string | null;
	ts: number;
	rows: DecisionEvaluation[];
	/** Every check that took part, fired first. */
	checks: CheckVerdict[];
	fired: CheckVerdict[];
	/** Some judged question got no verdict (deadline, budget, fallback). */
	unjudged: boolean;
	unjudgedReasons: string[];
	/** The slowest call (the wait); null when no call was made. */
	latencyMs: number | null;
	/** Served decision members (`model · version`). */
	members: string[];
	questionCount: number;
	/** Nothing fired and the verdict did nothing: collapses to one line. */
	clean: boolean;
}

function parse(json: string | null | undefined): unknown {
	if (!json) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}
const isObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `<code>__<source>` (`_2`… on repeats) → code and source. */
export function splitQuestionId(id: string): { code: string; source: string } {
	const sep = id.lastIndexOf('__');
	if (sep <= 0) return { code: id, source: '?' };
	return { code: id.slice(0, sep), source: id.slice(sep + 2).replace(/_\d+$/, '') };
}

/** A check's kind: the catalogue's, else guessed from the built-in code families. */
export function checkKind(code: string, info?: CheckInfo): string {
	if (info) return info.kind;
	if (code.startsWith('refusal_')) return 'refusal';
	if (code.startsWith('style_')) return 'style';
	if (code.startsWith('no_reply_')) return 'contract';
	return 'check';
}

const CLEAN_CONSEQUENCES = new Set(['sent', 'observed']);

/** Group `checks` rows into one evaluation per decision group, in first-row order. */
export function gateEvaluations(
	rows: readonly DecisionEvaluation[],
	checks: readonly CheckInfo[] = []
): GateEvaluation[] {
	const info = new Map(checks.map((c) => [c.code, c]));
	const groups = new Map<string, DecisionEvaluation[]>();
	for (const row of rows) {
		if (row.point !== 'checks') continue;
		const arr = groups.get(row.decisionGroup);
		if (arr) arr.push(row);
		else groups.set(row.decisionGroup, [row]);
	}
	const out: GateEvaluation[] = [];
	for (const [decisionGroup, group] of groups) {
		const byCode = new Map<string, CheckVerdict>();
		const verdictFor = (code: string): CheckVerdict => {
			let v = byCode.get(code);
			if (!v) {
				v = {
					code,
					kind: checkKind(code, info.get(code)),
					description: info.get(code)?.description ?? null,
					fired: false,
					method: null,
					probability: null,
					threshold: null,
					source: null,
					questions: []
				};
				byCode.set(code, v);
			}
			return v;
		};
		const reasons = new Set<string>();
		let unjudged = false;
		let latency: number | null = null;
		const members = new Set<string>();
		for (const row of group) {
			const v = parse(row.verdictJson);
			if (row.source === 'pattern' && isObject(v)) {
				const fired = Array.isArray(v.fired) ? v.fired.filter((c): c is string => typeof c === 'string') : [];
				for (const code of fired) {
					const c = verdictFor(code);
					c.fired = true;
					c.method = 'pattern';
					c.probability = 1;
					c.source = typeof v.source === 'string' ? v.source : null;
					if (typeof v.matched === 'string') c.matched = v.matched;
				}
				continue;
			}
			if (isObject(v) && v.unjudged === true) {
				unjudged = true;
				if (row.reason) reasons.add(row.reason);
			}
			if (row.servedModel) members.add(row.servedVersion ? `${row.servedModel} · ${row.servedVersion}` : row.servedModel);
			if (row.source === 'model' && row.latencyMs != null) latency = Math.max(latency ?? 0, row.latencyMs);
			if (!isObject(v) || !Array.isArray(v.results)) continue;
			for (const r of v.results) {
				if (!isObject(r) || typeof r.id !== 'string') continue;
				const { code, source } = splitQuestionId(r.id);
				const q: QuestionVerdict = {
					id: r.id,
					source,
					probability: num(r.p) ?? 0,
					threshold: num(r.t) ?? 0,
					fired: r.fired === true,
					...(typeof r.choice === 'string' ? { choice: r.choice } : {})
				};
				const c = verdictFor(code);
				c.questions.push(q);
				if (c.method === 'pattern') continue;
				if (q.fired) {
					c.method = 'judged';
					if (!c.fired || (c.probability ?? 0) < q.probability) {
						c.probability = q.probability;
						c.threshold = q.threshold;
						c.source = q.source;
					}
					c.fired = true;
				} else if (!c.fired && (c.probability === null || q.probability > c.probability)) {
					c.probability = q.probability;
					c.threshold = q.threshold;
					c.source = q.source;
				}
			}
		}
		const all = [...byCode.values()].sort((a, b) => Number(b.fired) - Number(a.fired));
		const fired = all.filter((c) => c.fired);
		const first = group[0]!;
		const consequence = group.find((r) => r.consequence)?.consequence ?? null;
		out.push({
			decisionGroup,
			checkpoint: first.checkpoint ?? null,
			branchNo: first.branchNo ?? 0,
			toolCallId: first.toolCallId ?? null,
			attemptNo: first.attemptNo ?? null,
			consequence,
			ts: Math.min(...group.map((r) => r.ts)),
			rows: group,
			checks: all,
			fired,
			unjudged: unjudged || consequence === 'sent_unjudged',
			unjudgedReasons: [...reasons],
			latencyMs: latency,
			members: [...members],
			questionCount: all.reduce((n, c) => n + c.questions.length, 0),
			clean: fired.length === 0 && (consequence === null || CLEAN_CONSEQUENCES.has(consequence)) && !unjudged
		});
	}
	return out;
}

/**
 * The evaluations of one judged tool call, shown in node `branchNo`: rows
 * anchored to that branch when there are any (re-anchored after a fork), else
 * every evaluation of the call.
 */
export function evaluationsForCall(
	evaluations: readonly GateEvaluation[],
	toolCallId: string,
	branchNo: number
): GateEvaluation[] {
	const forCall = evaluations.filter((e) => e.toolCallId === toolCallId);
	const exact = forCall.filter((e) => e.branchNo === branchNo);
	return exact.length > 0 ? exact : forCall;
}

/** Consequence → label, as the gate card states it. */
export function consequenceLabel(consequence: string | null): string {
	switch (consequence) {
		case 'sent':
			return 'sent';
		case 'sent_unjudged':
			return 'sent unjudged (deadline)';
		case 'revise':
			return 'revise';
		case 'overridden':
			return 'overridden';
		case 'redo':
			return 'redo';
		case 'observed':
			return 'observed';
		case 'withheld':
			return 'withheld';
		default:
			return consequence ?? 'recorded';
	}
}

/** Override codes a posting call carried (the gated tools' optional override argument). */
export function overrideCodes(args: unknown): string[] {
	if (!isObject(args)) return [];
	for (const key of ['override_checks', 'override']) {
		const v = args[key];
		if (Array.isArray(v)) return v.filter((c): c is string => typeof c === 'string');
		if (typeof v === 'string' && v) return [v];
	}
	return [];
}

/** Refusal events written for an evaluation (linked through its decision rows). */
export function eventsForEvaluation(
	events: readonly RefusalEvent[],
	evaluation: GateEvaluation
): RefusalEvent[] {
	const ids = new Set(evaluation.rows.map((r) => r.id));
	return events.filter((e) => e.decisionEvaluationId != null && ids.has(e.decisionEvaluationId));
}

// ── Nudges (send contract, spec §7, §12.2) ───────────────────────────────────

/** The runner's corrective prompts, by opening (current and historical wordings). */
const NUDGE_OPENINGS: Array<{ prefix: string; variant: string }> = [
	{ prefix: 'Your turn ended without sending a message', variant: 'not_sent' },
	{ prefix: 'Your previous turn ended without visible text', variant: 'not_sent' },
	{ prefix: 'You already sent a message but your turn did not end cleanly', variant: 'sent_not_final' }
];

/**
 * A forced-completion nudge: the harness marker (`{ kind: 'forced_completion',
 * attempt, variant }`), else a user turn whose text is one of the runner's
 * prompts (history before the marker existed).
 */
export function nudgeOf(m: RolloutMsg): { attempt: number | null; variant: string } | null {
	const h = m.harness;
	if (isObject(h)) {
		if (h.kind !== 'forced_completion') return null;
		return { attempt: num(h.attempt), variant: typeof h.variant === 'string' ? h.variant : 'not_sent' };
	}
	if (m.role !== 'user') return null;
	const text = contentText(m.content).trim();
	const hit = NUDGE_OPENINGS.find((o) => text.startsWith(o.prefix));
	return hit ? { attempt: null, variant: hit.variant } : null;
}

/**
 * The attempt a nudge closed (attempt n-1 before nudge n) in branch `branchNo`:
 * the latest one at or before the nudge, by time when the rows carry it.
 */
export function attemptBeforeNudge(
	attempts: readonly ContractAttempt[],
	branchNo: number,
	nudge: number,
	ts: number | undefined
): ContractAttempt | undefined {
	const candidates = attempts.filter((a) => a.branchNo === branchNo && a.attemptNo === nudge - 1);
	if (candidates.length <= 1 || ts === undefined) return candidates[0];
	const before = candidates.filter((a) => a.ts == null || a.ts <= ts);
	const pool = before.length > 0 ? before : candidates;
	return pool.reduce((best, a) => ((a.ts ?? 0) >= (best.ts ?? 0) ? a : best));
}

/** The text an assistant message wrote (NO_REPLY counts as none). */
export function assistantTextOf(m: RolloutMsg): string {
	const text = assistantBlocks(m.content)
		.filter((b) => b.type === 'text')
		.map((b) => (b as { text: string }).text)
		.join('')
		.trim();
	return text === 'NO_REPLY' ? '' : text;
}

/** The message a posting call sent (`send_message`-style `message`, else `text`). */
export function postedTextOf(args: unknown): string | null {
	if (!isObject(args)) return null;
	if (typeof args.message === 'string') return args.message;
	if (typeof args.text === 'string') return args.text;
	return null;
}

const POSTING = new Set(['send_message', 'send_dm', 'send_to_channel', 'edit_message', 'create_poll']);
export const isPostingTool = (name: string): boolean => POSTING.has(name);

// ── Offline audit findings (spec §7.2–§7.3, DECISION-MODEL §5.8) ─────────────

/**
 * Findings of the offline audit for one send-contract attempt, read from the
 * session's `send_contract` audit row (src/audit/contract-audit.ts
 * `RunDiagnosis`): `verdict.runs[]`, each with its failed `attempts[]`
 * (`{ branchNo, redoNo, attemptNo, selfTalk?, textual? }`) and the run's
 * `afterCorrection` (`{ choice, source, picked? }`), which is attached to the
 * run's last failed attempt (the one the last nudge closed). Defensive: a
 * malformed row yields nothing.
 */
export interface AuditFinding {
	branchNo: number;
	redoNo: number;
	attemptNo: number;
	/** The §7.3 verdict on the run (last attempt only): a choice, `uncertain (picked)`, or a mechanical fact. */
	afterCorrection: string | null;
	chips: string[];
}

export function auditFindings(audits: readonly SessionAudit[]): AuditFinding[] {
	const out: AuditFinding[] = [];
	for (const row of audits) {
		if (row.audit !== 'send_contract' || row.status !== 'done' || !isObject(row.verdict)) continue;
		const runs = row.verdict.runs;
		if (!Array.isArray(runs)) continue;
		for (const run of runs) {
			if (!isObject(run) || !Array.isArray(run.attempts)) continue;
			const attempts = run.attempts.filter(isObject);
			attempts.forEach((a, i) => {
				const attemptNo = num(a.attemptNo);
				if (attemptNo === null) return;
				const chips: string[] = [];
				if (a.selfTalk === true) chips.push('self_talk');
				if (a.textual === true) chips.push('textual_tool_call');
				const last = i === attempts.length - 1;
				const after = last ? afterCorrectionLabel(run.afterCorrection) : null;
				if (chips.length === 0 && after === null) return;
				out.push({
					branchNo: num(a.branchNo) ?? 0,
					redoNo: num(a.redoNo) ?? 0,
					attemptNo,
					afterCorrection: after,
					chips
				});
			});
		}
	}
	return out;
}

function afterCorrectionLabel(v: unknown): string | null {
	if (!isObject(v) || typeof v.choice !== 'string') return null;
	if (v.choice === 'uncertain' && typeof v.picked === 'string') return `uncertain (${v.picked}?)`;
	return v.choice;
}

/** An evaluation the offline audit recorded (its decision group carries the `audit:` prefix). */
export const isAuditEvaluation = (evaluation: GateEvaluation): boolean =>
	evaluation.decisionGroup.startsWith('audit:');

// ── Word diff (first attempt vs sent message) ────────────────────────────────

export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string };

/**
 * A word-level diff (LCS over whitespace-separated tokens, whitespace kept with
 * the token before it). Long inputs fall back to removed-then-added, so a
 * pathological pair never costs more than a bounded table.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
	const tok = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];
	const a = tok(before);
	const b = tok(after);
	if (a.length * b.length > 250_000) {
		return [
			...(before ? [{ kind: 'removed' as const, text: before }] : []),
			...(after ? [{ kind: 'added' as const, text: after }] : [])
		];
	}
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = a[i]!.trim() === b[j]!.trim() ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const parts: DiffPart[] = [];
	const push = (kind: DiffPart['kind'], text: string) => {
		const last = parts.at(-1);
		if (last && last.kind === kind) last.text += text;
		else parts.push({ kind, text });
	};
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i]!.trim() === b[j]!.trim()) {
			push('same', b[j]!);
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push('removed', a[i++]!);
		else push('added', b[j++]!);
	}
	while (i < n) push('removed', a[i++]!);
	while (j < m) push('added', b[j++]!);
	return parts;
}
