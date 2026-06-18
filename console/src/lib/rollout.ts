import type { ContextMessageWire, ImageRef } from '$lib/schemas';

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
