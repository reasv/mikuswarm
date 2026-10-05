import type { ContextMessageWire, DecisionEvaluation, ImageRef } from '$lib/schemas';
import { groupDecisions } from '$lib/decisions';

/**
 * Helpers for the rollout renderer (spec §10b). The persisted transcript holds
 * pi-ai messages (`AssistantMessage` with text/thinking/toolCall blocks,
 * `ToolResultMessage`, and user-role interjections). These are decoded as opaque
 * objects at the BFF (the shapes are `any`-typed upstream), so we narrow defensively
 * here rather than trusting a strict schema.
 */

export interface TextBlock {
	type: 'text';
	text: string;
}
export interface ThinkingBlock {
	type: 'thinking';
	thinking: string;
	redacted?: boolean;
}
export interface ToolCallBlock {
	type: 'toolCall';
	id: string;
	name: string;
	arguments: unknown;
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface RolloutMsg {
	role?: string;
	type?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	[k: string]: unknown;
}

/** Treat an opaque transcript element as a rollout message. */
export function asMsg(m: unknown): RolloutMsg {
	return (m ?? {}) as RolloutMsg;
}

/** Per-request usage attached to an assistant message (spec TOKEN-USAGE-TRACKING §7.3). */
export interface RolloutUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Context size reached at this point in the rollout (the request's totalTokens). */
	totalTokens: number;
	cost: number;
}

/**
 * Extract the per-request usage from an assistant message's `usage` field (the
 * verbatim pi-ai `Usage` shape — `cost` is a nested object whose `.total` we
 * surface). Returns null for messages without real usage (user turns, tool
 * results, legacy transcripts, and synthesized error turns whose stub usage is
 * all zeros → `totalTokens === 0`), which the rollout renders as nothing (§7.3).
 */
export function messageUsage(m: RolloutMsg): RolloutUsage | null {
	const u = m.usage;
	if (!u || typeof u !== 'object') return null;
	const o = u as Record<string, unknown>;
	const num = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0);
	const total = num('totalTokens');
	if (total <= 0) return null;
	const costObj = o.cost;
	const cost =
		costObj && typeof costObj === 'object' && typeof (costObj as { total?: unknown }).total === 'number'
			? ((costObj as { total: number }).total)
			: typeof costObj === 'number'
				? costObj
				: 0;
	return {
		input: num('input'),
		output: num('output'),
		cacheRead: num('cacheRead'),
		cacheWrite: num('cacheWrite'),
		totalTokens: total,
		cost
	};
}

/**
 * Whether a rollout message is an injected user turn (spec §10b) — rendered as a
 * distinct InterjectionCard rather than the raw-JSON fallback. Covers two shapes:
 * interjections, which carry NO `role` (just `{ type:'interjection', content }`,
 * src/agent/messages.ts), and forced-completion prompts, which arrive as plain
 * `role:'user'` messages (src/agent/runner.ts). The leading final user turn is rendered
 * by the verbatim input view (§10a) and excluded from the rollout upstream
 * (rolloutStartIndex), so it never reaches here.
 */
export function isInjectedUserTurn(m: RolloutMsg): boolean {
	return m.type === 'interjection' || m.role === 'user';
}

/** Content signature of an injected user turn for dedup (role/type + flattened text). */
function injectedTurnSignature(m: RolloutMsg): string {
	return `${m.role ?? ''}|${m.type ?? ''}|${contentText(m.content)}`;
}

/**
 * Whether `m` (an injected user turn) duplicates one already present in
 * `messages`. The live rollout uses this to drop a `message_start` that
 * re-delivers a turn the seed already carried: `Agent.subscribe` is future-only
 * but a turn committed to `agent.state.messages` *just* before the console
 * attaches can land in the seed AND fire a subsequent `message_start`, rendering
 * twice (the "printed twice, fixed on refresh" symptom). Compares role/type +
 * the flattened text rather than object identity, because the seed copy and the
 * message_start copy are distinct objects. The caller gates this to the brief
 * post-seed window so legitimate repeat interjections are never suppressed.
 */
export function isDuplicateInjectedTurn(messages: readonly RolloutMsg[], m: RolloutMsg): boolean {
	const sig = injectedTurnSignature(m);
	for (const existing of messages) {
		if (isInjectedUserTurn(existing) && injectedTurnSignature(existing) === sig) return true;
	}
	return false;
}

/** Assistant content blocks (text / thinking / toolCall), normalized to an array. */
export function assistantBlocks(content: unknown): AssistantBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(b): b is AssistantBlock =>
			!!b && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string'
	);
}

/** Flatten a message's content (string or content-block array) to plain text. */
export function contentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (b && typeof b === 'object' && 'text' in b) return String((b as { text: unknown }).text);
				return '';
			})
			.join('');
	}
	return '';
}

/** Map toolCallId → ToolResultMessage so a tool-call card can show its result. */
export function collectToolResults(msgs: readonly unknown[]): Map<string, RolloutMsg> {
	const out = new Map<string, RolloutMsg>();
	for (const raw of msgs) {
		const m = asMsg(raw);
		if (m.role === 'toolResult' && typeof m.toolCallId === 'string') out.set(m.toolCallId, m);
	}
	return out;
}

/** base64 byte length (mirrors src/agent/session-capture.ts `base64ByteLength`). */
function base64ByteLength(b64: string): number {
	const len = b64.length;
	if (len === 0) return 0;
	const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
	return Math.floor((len * 3) / 4) - padding;
}

/**
 * Normalize a transcript-head image entry into the wire `ImageRef` shape the
 * renderer expects (`{ attachmentId?, mimeType?, sizeBytes }`). The persisted head
 * (`mapBuiltMessages`, src/agent/factory.ts) keeps RAW context `imageBlocks`
 * (`{ eventId, attachmentId, mediaType, dataBase64 }`), so map `mediaType`→`mimeType`
 * and derive `sizeBytes` from the base64; an already-externalized `ImageRef`
 * (handler path) passes through unchanged. Raw `dataBase64` is intentionally
 * dropped — the renderer only reads attachmentId/mimeType/sizeBytes.
 */
function toImageRef(raw: unknown): ImageRef | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.sizeBytes === 'number') {
		return {
			__imageRef: o.__imageRef === true ? true : undefined,
			eventId: typeof o.eventId === 'string' ? o.eventId : undefined,
			attachmentId: typeof o.attachmentId === 'string' ? o.attachmentId : undefined,
			mimeType: typeof o.mimeType === 'string' ? o.mimeType : undefined,
			sizeBytes: o.sizeBytes
		};
	}
	const dataBase64 = typeof o.dataBase64 === 'string' ? o.dataBase64 : '';
	return {
		__imageRef: true,
		eventId: typeof o.eventId === 'string' ? o.eventId : undefined,
		attachmentId: typeof o.attachmentId === 'string' ? o.attachmentId : undefined,
		mimeType: typeof o.mediaType === 'string' ? o.mediaType : undefined,
		sizeBytes: base64ByteLength(dataBase64)
	};
}

function coerceImageRefs(o: RolloutMsg): readonly ImageRef[] | undefined {
	const src = Array.isArray(o.imageBlocks)
		? o.imageBlocks
		: Array.isArray(o.imageRefs)
			? o.imageRefs
			: undefined;
	if (!src) return undefined;
	const refs = src.map(toImageRef).filter((r): r is ImageRef => r !== null);
	return refs.length > 0 ? refs : undefined;
}

// ── Session-records harness helpers (spec SESSION-RECORDS §4, §8) ─────────────

/**
 * The `harness` marker carried by every harness-made transcript message
 * (CONTRACT.md decision 5). Persisted in the transcript; pi ignores unknown fields.
 */
export type HarnessMarker =
	| { kind: 'injection'; decisionGroup?: string }
	| { kind: 'record_turn' }
	| { kind: 'record_load' }
	// A send-contract nudge (spec REFUSAL-HANDLING §7, src/agent/contract.ts).
	| { kind: 'forced_completion'; attempt?: number; variant?: string }
	// The stand-in turn of a withheld refusal (`on_exhausted = "withhold"`, §8.2):
	// nothing was sent, the run settled as NO_REPLY.
	| { kind: 'refusal_withheld' };

/**
 * Extract the harness marker from a transcript message, or null when the message
 * was made by the model (no `harness` field).
 */
export function getHarness(m: RolloutMsg): HarnessMarker | null {
	const h = m.harness;
	if (!h || typeof h !== 'object') return null;
	const kind = (h as { kind?: unknown }).kind;
	if (kind === 'injection') {
		const dg = (h as { decisionGroup?: unknown }).decisionGroup;
		return { kind: 'injection', decisionGroup: typeof dg === 'string' ? dg : undefined };
	}
	if (kind === 'record_turn') return { kind: 'record_turn' };
	if (kind === 'record_load') return { kind: 'record_load' };
	if (kind === 'refusal_withheld') return { kind: 'refusal_withheld' };
	if (kind === 'forced_completion') {
		const attempt = (h as { attempt?: unknown }).attempt;
		const variant = (h as { variant?: unknown }).variant;
		return {
			kind: 'forced_completion',
			...(typeof attempt === 'number' ? { attempt } : {}),
			...(typeof variant === 'string' ? { variant } : {})
		};
	}
	return null;
}

/** Whether a message was made by the harness (has any harness marker). */
export function isHarnessMessage(m: RolloutMsg): boolean {
	return getHarness(m) !== null;
}

/**
 * One item in the flat render plan built by `buildRolloutPlan`. Either a normal
 * rollout message (by index into the original array) or a decision-group card to
 * insert inline. `injected` (records point) is what the rollout shows was
 * injected for the group; undefined when the rollout has no messages yet.
 */
export type RenderItem =
	| { type: 'message'; index: number; msg: RolloutMsg }
	| {
			type: 'decision';
			decisionGroup: string;
			evaluations: DecisionEvaluation[];
			injected?: string[];
	  };

/** One harness `read_session_record` injection whose result was not an error. */
interface RecordInjection {
	sessionId: string;
	decisionGroup?: string;
	text: string;
}

function recordInjections(msgs: readonly RolloutMsg[]): RecordInjection[] {
	const results = collectToolResults(msgs);
	const out: RecordInjection[] = [];
	for (const m of msgs) {
		const h = getHarness(m);
		if (h?.kind !== 'injection' || m.role !== 'assistant') continue;
		for (const block of assistantBlocks(m.content)) {
			if (block.type !== 'toolCall' || block.name !== 'read_session_record') continue;
			const args = block.arguments as Record<string, unknown> | null | undefined;
			const sessionId = args && typeof args.session_id === 'string' ? args.session_id : null;
			const result = results.get(block.id);
			// A failed injection (the record vanished, the session was not visible)
			// gave the session nothing: it is not a record given.
			if (!sessionId || !result || result.isError === true) continue;
			out.push({ sessionId, decisionGroup: h.decisionGroup, text: contentText(result.content) });
		}
	}
	return out;
}

/**
 * Per decision group, the session ids the transcript shows were injected for it
 * (successful harness `read_session_record` calls carrying that group).
 */
export function injectedByDecisionGroup(messages: readonly unknown[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const inj of recordInjections(messages.map(asMsg))) {
		if (!inj.decisionGroup) continue;
		out.set(inj.decisionGroup, [...(out.get(inj.decisionGroup) ?? []), inj.sessionId]);
	}
	return out;
}

/**
 * Build the flat render plan for a rollout: interleave decision cards at the right
 * positions (spec SESSION-RECORDS §8 "Inline in the rollout"):
 *
 * - A group whose `decisionGroup` matches a harness injection message's
 *   `harness.decisionGroup` is inserted RIGHT BEFORE that first matching message.
 * - A group with no matching injections (nothing injected, or a heuristic fallback)
 *   is inserted before turn 1 — the first message that is not a harness injection
 *   (spec: "all current points happen before turn 1").
 *
 * Decision groups that have already been placed are not repeated.
 */
export function buildRolloutPlan(
	messages: readonly RolloutMsg[],
	evaluations: readonly DecisionEvaluation[]
): RenderItem[] {
	const groupMap = groupDecisions(evaluations);
	const injectedByGroup = injectedByDecisionGroup(messages);
	const card = (dg: string, evs: DecisionEvaluation[]): RenderItem => ({
		type: 'decision',
		decisionGroup: dg,
		evaluations: evs,
		...(messages.length > 0 ? { injected: injectedByGroup.get(dg) ?? [] } : {})
	});

	const matched = new Set<string>();
	for (const m of messages) {
		const h = getHarness(m);
		if (h?.kind === 'injection' && h.decisionGroup) matched.add(h.decisionGroup);
	}

	const placed = new Set<string>();
	const plan: RenderItem[] = [];

	// Groups with no matching injection come first, before turn 1.
	for (const [dg, evs] of groupMap) {
		if (matched.has(dg)) continue;
		plan.push(card(dg, evs));
		placed.add(dg);
	}

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const h = getHarness(msg);
		// A matched group's card goes right before its first injection.
		if (h?.kind === 'injection' && h.decisionGroup && !placed.has(h.decisionGroup)) {
			const evs = groupMap.get(h.decisionGroup);
			if (evs) {
				plan.push(card(h.decisionGroup, evs));
				placed.add(h.decisionGroup);
			}
		}
		plan.push({ type: 'message', index: i, msg });
	}

	return plan;
}

/**
 * The records given to a session (spec SESSION-RECORDS §8): its harness
 * `read_session_record` injections that succeeded, with the text the session
 * saw. Failed injections are left out.
 */
export function extractRecordsGiven(
	transcript: readonly unknown[]
): Array<{ sessionId: string; text: string }> {
	return recordInjections(transcript.map(asMsg)).map(({ sessionId, text }) => ({ sessionId, text }));
}

/** Whether the transcript holds the record turn's harness prompt. */
export function hasRecordTurn(transcript: readonly unknown[]): boolean {
	return transcript.some((m) => getHarness(asMsg(m))?.kind === 'record_turn');
}

/**
 * Coerce a transcript head element (the kickoff final user turn — `triggerGroup` /
 * `satellite`, spec §2b) into the verbatim renderer's ContextMessage shape so the
 * verbatim-input view can render it alongside the frozen snapshot prefix.
 *
 * The producer now persists the real per-message `tier`/`tokenEstimate` onto the
 * head turn (`mapBuiltMessages`, src/agent/factory.ts, issue #9), so prefer those.
 * Fall back to `null` (rendered as an em-dash, NOT a misleading 0/`trigger`) only
 * for genuinely-legacy records captured before that change. Image normalization
 * now also happens server-side (externalizeImages, issue #4); `coerceImageRefs`
 * stays as a legacy fallback for raw context `imageBlocks` in old records.
 */
export function coerceContextMessage(raw: unknown): ContextMessageWire {
	const o = asMsg(raw);
	return {
		type: typeof o.type === 'string' ? o.type : 'triggerGroup',
		role: typeof o.role === 'string' ? o.role : 'user',
		content: contentText(o.content),
		tier: typeof o.tier === 'string' ? o.tier : null,
		tokenEstimate: typeof o.tokenEstimate === 'number' ? o.tokenEstimate : null,
		timestamp: typeof o.timestamp === 'number' ? o.timestamp : null,
		imageRefs: coerceImageRefs(o)
	};
}
