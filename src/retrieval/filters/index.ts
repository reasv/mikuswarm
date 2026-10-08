export {
  filterBoundTs,
  filtersFor,
  isValidFilterBound,
  mergeFilterTables,
  resolveMemoryFilters,
  validateMemoryFilters,
  type FilterKind,
  type FilterPending,
  type ResolvedMemoryFilter,
  type ResolvedMemoryFilters,
} from "./config.js";
export {
  MemoryFilterService,
  toQuestion,
  warnFiltersWithoutDecisions,
  type BlockFilterState,
  type EnforceContext,
  type FilterBlock,
  type FilterSurface,
  type HiddenBy,
  type MemoryFilterServiceOptions,
} from "./service.js";
export { removeBlocks, splitFileBlocks, type FileBlock } from "./blocks.js";

import type { MemoryFilterService, EnforceContext } from "./service.js";
import { removeBlocks, splitFileBlocks } from "./blocks.js";

/**
 * A memory file's text with the blocks hidden by the agent's filters removed
 * (recency layer, diary writer window). Unchanged when no filter is active.
 */
export async function filterMemoryFileText(
  service: MemoryFilterService | undefined,
  agent: string | null,
  relPath: string,
  text: string,
  ctx: EnforceContext,
): Promise<string> {
  if (!service || !service.hasFilters(agent)) return text;
  const blocks = splitFileBlocks(relPath, text);
  const states = await service.enforce(agent, blocks, ctx);
  return removeBlocks(text, blocks.filter((b) => states.get(b.contentHash)?.hidden));
}
