import type { BranchCause, SessionInterjection } from '$lib/schemas';
import { contentText, type RolloutMsg } from '$lib/rollout';

/**
 * Console vocabulary for late input (ARCHITECTURE.md §8 "Late input", §11): the
 * branch reasons the switcher names, the interjection kinds the rollout labels,
 * the irreversibility hold recorded on a tool result, and the `estimated` usage flag.
 */

const BRANCH_REASON_LABELS: Record<string, string> = {
	refusal_redo: 'Refusal redo',
	contract_redo: 'Send-contract redo',
	edit_redo: 'Redone after edit',
	addition_redo: 'Redone after addition',
	revival: 'Revived',
	turn_aborted: 'Turn aborted for interjection'
};

/** Human label of a branch reason; unknown reasons read as their words. */
export function branchReasonLabel(reason: string | null | undefined): string {
	if (!reason) return 'Redo';
	return BRANCH_REASON_LABELS[reason] ?? reason.replaceAll('_', ' ');
}

/** What the discarded span was, for the switcher's explanation line. */
export function branchReasonDetail(reason: string | null | undefined): string | null {
	switch (reason) {
		case 'edit_redo':
			return 'the trigger was edited; the whole rollout was discarded and redone from scratch';
		case 'addition_redo':
			return 'a late addition joined the request; the whole rollout was redone from scratch';
		case 'revival':
			return 'a message revived the settled session; its record turn was discarded';
		case 'turn_aborted':
			return 'the in-flight generation was aborted to deliver an interjection';
		default:
			return null;
	}
}

/** Sender label of a cause message (display name, else the id). */
export function causeSender(cause: BranchCause): string {
	return cause.senderName || cause.senderId;
}

const INTERJECTION_KIND_LABELS: Record<string, string> = {
	reply: 'reply',
	'co-reply': 'co-reply',
	'follow-up': 'follow-up',
	edit: 'trigger edited',
	revival: 'revival',
	addition: 'late addition'
};

/** Human label of an interjection kind (`session_interjections.kind` or the tag reason). */
export function interjectionKindLabel(kind: string): string {
	if (INTERJECTION_KIND_LABELS[kind]) return INTERJECTION_KIND_LABELS[kind]!;
	// The steered follow-up forms tag themselves `follow-up-media` / `-mention` / `-text`.
	if (kind.startsWith('follow-up-')) return `follow-up (${kind.slice('follow-up-'.length)})`;
	return kind.replaceAll('_', ' ');
}

/** The `reason` of a leading `<interjection reason="…">` tag in the content, if any. */
export function interjectionTagReason(text: string): string | null {
	const m = /^\s*<interjection\s+reason="([^"]+)"/.exec(text);
	return m ? m[1]! : null;
}

/**
 * The kind of an interjection message: the session's interjection row whose body
 * the message carries (the row's body is the raw inbound text the message wraps),
 * else the content's own tag reason. null for a forced-completion prompt or an
 * untagged interjection with no matching row.
 */
export function interjectionKindOf(msg: RolloutMsg, rows: readonly SessionInterjection[]): string | null {
	if (msg.type !== 'interjection') return null;
	const text = contentText(msg.content);
	const row = rows.find((r) => r.body.trim().length > 0 && text.includes(r.body.trim()));
	return row?.kind ?? interjectionTagReason(text);
}

export interface LateInputHold {
	heldMs: number;
	reason: string;
}

/** The irreversibility hold recorded on a tool result (`lateInputHold`), when present. */
export function holdOf(result: RolloutMsg | undefined): LateInputHold | null {
	const h = result?.lateInputHold;
	if (!h || typeof h !== 'object') return null;
	const { heldMs, reason } = h as { heldMs?: unknown; reason?: unknown };
	if (typeof heldMs !== 'number' || !Number.isFinite(heldMs)) return null;
	return { heldMs, reason: typeof reason === 'string' ? reason : 'hold_deadline' };
}

/** "held 3.2 s, waiting for corrections" (the hold reason in words). */
export function holdLabel(hold: LateInputHold): string {
	const secs = hold.heldMs < 1000 ? `${Math.round(hold.heldMs)} ms` : `${(hold.heldMs / 1000).toFixed(1)} s`;
	const why =
		hold.reason === 'hold_deadline'
			? 'waiting for corrections'
			: hold.reason === 'verdict_pending'
				? 'waiting for a late-addition verdict'
				: hold.reason === 'correction'
					? 'a correction arrived'
					: hold.reason.replaceAll('_', ' ');
	return `held ${secs}, ${why}`;
}

/** The `estimated` usage flag (1 / true): tokens estimated after an aborted stream. */
export function isEstimated(value: unknown): boolean {
	return value === true || value === 1;
}
