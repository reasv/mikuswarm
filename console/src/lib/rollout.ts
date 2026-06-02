import type { ContextMessageWire } from '$lib/schemas';

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
		imageRefs: Array.isArray(o.imageBlocks)
			? (o.imageBlocks as unknown[])
			: Array.isArray(o.imageRefs)
				? (o.imageRefs as unknown[])
				: undefined
	};
}
