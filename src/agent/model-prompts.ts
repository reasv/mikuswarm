import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { MODEL_PROMPT_NONE, type AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import { escapeAttr } from "../context/xml.js";
import { resolveWorkspacePath } from "../tools/workspace.js";
import type { SessionTypeConfig } from "../workspace/types.js";

// =============================================================================
// Model prompts (ARCHITECTURE.md §8 "Model prompts").
//
// A named profile gives a model its own system-prompt PREAMBLE (the first bytes
// of the context) and/or its own TAIL (appended to the satellite's tail
// instructions). Both are applied per attempt, for the chain member actually
// serving it, by a per-member stream wrapper — the session's stored system
// prompt, snapshot and transcript stay model-neutral.
//
// The tail position travels BESIDE the satellite message, never inside its
// text: the builder records `modelTailAt` on the message, `convertToLlm` copies
// it onto the wire Message under MODEL_TAIL_AT, and `withModelPrompt` splices
// the member's tail in at that offset. A member without a tail sends content
// byte-identical to the feature-off rendering.
// =============================================================================

/**
 * Where the model tail goes in a satellite-bearing message's text: the character
 * offset, and which side the satellite's `\n\n` part separator belongs on
 * (`before` = parts precede the slot, `after` = only parts follow it, `none` =
 * the satellite is otherwise empty).
 */
export interface ModelTailAt {
  offset: number;
  join: "before" | "after" | "none";
}

/** Wire-Message key carrying the {@link ModelTailAt} (never serialized: symbol-keyed). */
export const MODEL_TAIL_AT: unique symbol = Symbol("mikuswarm.modelTailAt");

/** Which configuration rung picked the profile (observability). */
export type ModelPromptRung = "session_type" | "session_type_wildcard" | "model";

/** A member's model prompt, resolved and read for one session. */
export interface ResolvedModelPrompt {
  profile: string;
  rung: ModelPromptRung;
  /** Preamble text (trimmed), absent when the profile has none or it read empty. */
  preamble?: string;
  /** The rendered `<tail_instructions>` block, absent when the profile has no tail text. */
  tail?: string;
  /** Short hash of exactly the preamble + tail bytes this member sends. */
  hash: string;
  /** Token estimate of the added text (preamble + tail block + separators). */
  tokens: number;
}

/**
 * Resolve the profile name for a session type + serving member: the session
 * type's exact-model override, its "*" override, then the model's own default.
 * Returns undefined for no model prompt (unset everywhere, or "none").
 */
export function resolveModelPromptProfile(
  config: AppConfig,
  sessionType: SessionTypeConfig | undefined,
  logicalId: string,
): { profile: string; rung: ModelPromptRung } | undefined {
  const overrides = sessionType?.model_prompts;
  let picked: { profile: string; rung: ModelPromptRung } | undefined;
  if (overrides && overrides[logicalId] !== undefined) {
    picked = { profile: overrides[logicalId]!, rung: "session_type" };
  } else if (overrides && overrides["*"] !== undefined) {
    picked = { profile: overrides["*"]!, rung: "session_type_wildcard" };
  } else {
    const own = config.models[logicalId]?.model_prompt;
    if (own !== undefined) picked = { profile: own, rung: "model" };
  }
  if (!picked || picked.profile === MODEL_PROMPT_NONE) return undefined;
  return picked;
}

type ModelPromptSource = NonNullable<NonNullable<AppConfig["model_prompts"]>[string]["preamble"]>;

/**
 * Resolve and read the model prompts of a session's reachable members. Files are
 * read once per (profile) and held for the session's lifetime — the next session
 * reads the current files. An empty (or whitespace-only) source, or a workspace file
 * that does not exist, omits that position silently; any other unreadable source
 * omits it with a `model_prompt_source_missing` warning. Members resolving to no
 * text are absent.
 */
export async function loadModelPrompts(params: {
  config: AppConfig;
  sessionType: SessionTypeConfig | undefined;
  sessionTypeName: string;
  logicalIds: Iterable<string>;
  workspaceRoot: string;
  estimateTokens: (text: string) => number;
  logger?: Logger;
  sessionId?: string;
}): Promise<Map<string, ResolvedModelPrompt>> {
  const { config, logger, sessionId } = params;
  const out = new Map<string, ResolvedModelPrompt>();
  const byProfile = new Map<string, Promise<{ preamble?: string; tail?: string; sources: string[] }>>();
  const readSource = async (profile: string, position: string, source: ModelPromptSource): Promise<string | undefined> => {
    let text: string | undefined;
    let where: string | undefined;
    try {
      if (source.text !== undefined) {
        text = source.text;
      } else if (source.file !== undefined) {
        where = source.file;
        text = await readFile(source.file, "utf-8");
      } else if (source.workspace_file !== undefined) {
        where = source.workspace_file;
        text = await readFile(resolveWorkspacePath(params.workspaceRoot, source.workspace_file), "utf-8");
      }
    } catch (error) {
      // A workspace file that does not exist is how an agent goes without this
      // position (workspaces are per agent), so it is not worth a warning. Any other
      // failure (a vanished config-dir file, an unreadable or escaping path) is.
      const absent =
        source.workspace_file !== undefined && (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      (absent ? logger?.debug : logger?.warn)?.call(logger, "model_prompt_source_missing", {
        sessionId,
        profile,
        position,
        source: where,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    // Empty or whitespace-only = not set: the position is omitted silently, and since
    // the profile was still the one resolved, a lower rung is not consulted (exactly
    // like overriding it with "none"). Lets an operator keep placeholder files.
    const trimmed = text?.trim();
    if (!trimmed) return undefined;
    return trimmed;
  };
  const loadProfile = (profile: string) => {
    let pending = byProfile.get(profile);
    if (!pending) {
      pending = (async () => {
        const def = config.model_prompts?.[profile];
        const sources: string[] = [];
        if (!def) return { sources };
        const preamble = def.preamble ? await readSource(profile, "preamble", def.preamble) : undefined;
        const tailText = def.tail ? await readSource(profile, "tail", def.tail) : undefined;
        for (const source of [def.preamble, def.tail]) {
          if (source?.file !== undefined) sources.push(source.file);
          if (source?.workspace_file !== undefined) sources.push(`workspace:${source.workspace_file}`);
        }
        return {
          ...(preamble ? { preamble } : {}),
          ...(tailText ? { tail: renderModelTail(tailText, def.tail?.workspace_file) } : {}),
          sources,
        };
      })();
      byProfile.set(profile, pending);
    }
    return pending;
  };
  for (const logicalId of new Set(params.logicalIds)) {
    const picked = resolveModelPromptProfile(config, params.sessionType, logicalId);
    if (!picked) continue;
    const loaded = await loadProfile(picked.profile);
    if (!loaded.preamble && !loaded.tail) continue;
    const resolved: ResolvedModelPrompt = {
      profile: picked.profile,
      rung: picked.rung,
      ...(loaded.preamble ? { preamble: loaded.preamble } : {}),
      ...(loaded.tail ? { tail: loaded.tail } : {}),
      hash: modelPromptHash(loaded.preamble, loaded.tail),
      tokens:
        (loaded.preamble ? params.estimateTokens(`${loaded.preamble}\n\n`) : 0) +
        (loaded.tail ? params.estimateTokens(`\n\n${loaded.tail}`) : 0),
    };
    out.set(logicalId, resolved);
    logger?.info("model_prompt_resolved", {
      sessionId,
      sessionType: params.sessionTypeName,
      member: logicalId,
      profile: resolved.profile,
      rung: resolved.rung,
      preamble: resolved.preamble !== undefined,
      tail: resolved.tail !== undefined,
      sources: loaded.sources,
      hash: resolved.hash,
    });
  }
  return out;
}

/** The tail block as inserted into the satellite. Config-dir/inline text shows no source path. */
export function renderModelTail(text: string, workspaceFile?: string): string {
  const attr = workspaceFile !== undefined ? ` source="${escapeAttr(workspaceFile)}"` : "";
  return `<tail_instructions${attr}>\n${text}\n</tail_instructions>`;
}

/** Short content hash of the exact preamble + tail bytes a member sends. */
export function modelPromptHash(preamble: string | undefined, tail: string | undefined): string {
  return createHash("sha256")
    .update(preamble ?? "")
    .update("\0")
    .update(tail ?? "")
    .digest("hex")
    .slice(0, 12);
}

/** Insert a tail block into text at a recorded slot, with the satellite's part separator. */
export function spliceModelTail(text: string, at: ModelTailAt, block: string): string {
  if (!Number.isInteger(at.offset) || at.offset < 0 || at.offset > text.length) return text;
  const insert = at.join === "before" ? `\n\n${block}` : at.join === "after" ? `${block}\n\n` : block;
  return text.slice(0, at.offset) + insert + text.slice(at.offset);
}

/** Prepend a preamble to a system prompt (nothing precedes it). */
export function prependPreamble(systemPrompt: string | undefined, preamble: string): string {
  return systemPrompt ? `${preamble}\n\n${systemPrompt}` : preamble;
}

/**
 * Apply a member's model prompt to one request's context: preamble in front of
 * the system prompt, tail spliced into every satellite-bearing message at its
 * recorded slot. Messages without a slot keep their identity (other per-member
 * wrappers key state on message objects).
 */
export function applyModelPrompt<C extends { systemPrompt?: string; messages: Message[] }>(
  context: C,
  prompt: Pick<ResolvedModelPrompt, "preamble" | "tail">,
): C {
  const next: C = { ...context };
  if (prompt.preamble) next.systemPrompt = prependPreamble(context.systemPrompt, prompt.preamble);
  const tail = prompt.tail;
  if (tail) {
    let changed = false;
    const messages = context.messages.map((message) => {
      const at = (message as { [MODEL_TAIL_AT]?: ModelTailAt })[MODEL_TAIL_AT];
      if (!at || message.role !== "user") return message;
      changed = true;
      if (typeof message.content === "string") {
        return { ...message, content: spliceModelTail(message.content, at, tail) };
      }
      // Image-bearing turn: the text is the first part (convertToLlm's contentWithImages).
      const [first, ...rest] = message.content;
      if (!first || first.type !== "text") return message;
      return { ...message, content: [{ ...first, text: spliceModelTail(first.text, at, tail) }, ...rest] };
    });
    if (changed) next.messages = messages as Message[];
  }
  return next;
}

/** Per-member stream wrapper: every request through `base` carries the member's model prompt. */
export function withModelPrompt(base: StreamFn, prompt: ResolvedModelPrompt): StreamFn {
  return (model, context, options) => base(model, applyModelPrompt(context, prompt), options);
}
