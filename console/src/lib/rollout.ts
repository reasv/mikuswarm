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
 */
export function coerceContextMessage(raw: unknown): ContextMessageWire {
	const o = asMsg(raw);
	return {
		type: typeof o.type === 'string' ? o.type : 'triggerGroup',
		role: typeof o.role === 'string' ? o.role : 'user',
		content: contentText(o.content),
		tier: typeof o.tier === 'string' ? o.tier : 'trigger',
		tokenEstimate: typeof o.tokenEstimate === 'number' ? o.tokenEstimate : 0,
		timestamp: typeof o.timestamp === 'number' ? o.timestamp : null,
		imageRefs: coerceImageRefs(o)
	};
}
