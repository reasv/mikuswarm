import { GlmTokenizer } from "./glm.js";
import { GptTokenizer } from "./gpt.js";
import type { Tokenizer, TokenizerKind } from "./types.js";

/**
 * Process-wide tokenizer registry (spec/TOKENIZER-SWAP.md §5.1). Holds the two
 * config-selected singletons:
 *
 * - the **primary** (chat/context/summarization) tokenizer — what bounds every
 *   token-denominated budget that gates what we send the chat model; and
 * - the **retrieval** (embedder-matched) tokenizer — what the memory chunker
 *   measures against, kept independent so switching the chat tokenizer does NOT
 *   perturb chunk boundaries/hashes/embeddings (§5.3).
 *
 * `initTokenizers` binds both once during `app.ts` startup, before the first
 * context build. Outside the booted app (unit tests, standalone tools) the getters
 * lazily fall back to `gpt-tokenizer` — the shipped default — so call sites that
 * never boot the app keep working; only the native `glm` path mandates explicit
 * init (it must load `tokenizer.json`).
 */

let primaryTokenizer: Tokenizer | null = null;
let retrievalTokenizer: Tokenizer | null = null;

/** Resolved tokenizer selection (from the `[tokenizer]` config block). */
export interface TokenizerSelection {
  primary?: TokenizerKind;
  retrieval?: TokenizerKind;
  /** Path to the GLM `tokenizer.json`; required when either selection is `glm`. */
  glmTokenizerPath?: string;
}

function createTokenizer(kind: TokenizerKind, glmTokenizerPath?: string): Tokenizer {
  switch (kind) {
    case "gpt-tokenizer":
      return new GptTokenizer();
    case "glm":
      if (!glmTokenizerPath) {
        // Defense in depth — app.ts also cross-field-validates this with a friendlier
        // message before init (§5.4). Reaching here means a non-app caller selected
        // glm without a path.
        throw new Error(
          "[tokenizer]: 'glm' selected but glm_tokenizer_path is not set — point it at the GLM tokenizer.json",
        );
      }
      return GlmTokenizer.fromFile(glmTokenizerPath);
    default: {
      const exhaustive: never = kind;
      throw new Error(`[tokenizer]: unknown tokenizer '${String(exhaustive)}'`);
    }
  }
}

/**
 * Construct and bind the primary + retrieval tokenizers from config. Idempotent
 * per process: call once at startup. Async to match the spec's startup contract
 * (and to leave room for a future non-blocking asset load); the native load is
 * currently synchronous. A single backend instance is shared when both selections
 * name it (the default → one shared `gpt-tokenizer`; or both `glm` from one path).
 */
export async function initTokenizers(selection: TokenizerSelection): Promise<void> {
  const primaryKind = selection.primary ?? "gpt-tokenizer";
  const retrievalKind = selection.retrieval ?? "gpt-tokenizer";
  const cache = new Map<TokenizerKind, Tokenizer>();
  const build = (kind: TokenizerKind): Tokenizer => {
    let existing = cache.get(kind);
    if (!existing) {
      existing = createTokenizer(kind, selection.glmTokenizerPath);
      cache.set(kind, existing);
    }
    return existing;
  };
  primaryTokenizer = build(primaryKind);
  retrievalTokenizer = build(retrievalKind);
}

/**
 * The chat/context/summarization tokenizer. Backs the module-level `estimateTokens`
 * family in `src/context/tokens.ts`. Lazily defaults to `gpt-tokenizer` when
 * `initTokenizers` was never called (tests/tools); the native path can never be
 * reached this way because only `initTokenizers` loads it, and `app.ts` awaits init
 * before any context build.
 */
export function getPrimaryTokenizer(): Tokenizer {
  if (!primaryTokenizer) primaryTokenizer = new GptTokenizer();
  return primaryTokenizer;
}

/** The embedder-matched tokenizer injected into the retrieval chunker (§5.3). */
export function getRetrievalTokenizer(): Tokenizer {
  if (!retrievalTokenizer) retrievalTokenizer = new GptTokenizer();
  return retrievalTokenizer;
}

/** Test-only: clear the singletons so a test can re-`initTokenizers` from scratch. */
export function resetTokenizersForTest(): void {
  primaryTokenizer = null;
  retrievalTokenizer = null;
}
