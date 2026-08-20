import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { DynamicToolRegistry } from "../agent/dynamic-tools.js";
import type { Logger } from "../observability/logger.js";
import { renderToolBlock } from "../context/tool-block.js";

/**
 * `tool_search` (spec DYNAMIC-TOOL-LOADING §6): the universal fallback for
 * loading deferred tools that no skill covers (or whose skill the model
 * doesn't want the full instructions of). Matches are LOADED, not just listed —
 * the result carries `addedToolNames` and the definitions enter the provider
 * tools channel from the next request on.
 */

const TOOL_SEARCH_NAME = "tool_search";
const TOOL_SEARCH_DESCRIPTION =
  'Search the catalog of not-yet-loaded tools and load the matches, making them directly callable. ' +
  'Query "select:name_a,name_b" loads exact tool names; any other query is keyword-matched ' +
  "against tool names and descriptions.";
const TOOL_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({
    description: 'Either "select:<name>[,<name>...]" for exact names, or free keywords.',
  }),
  max_results: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 20, description: "Keyword mode only. Default 5." }),
  ),
});

const DEFAULT_MAX_RESULTS = 5;
/** Result-text description clamp — full definitions travel via the tools channel. */
const RESULT_DESCRIPTION_MAX_CHARS = 160;

/** Static wire definition, for the console inspector's initial-tool-block recompute. */
export function toolSearchToolDefinition() {
  return { name: TOOL_SEARCH_NAME, description: TOOL_SEARCH_DESCRIPTION, parameters: TOOL_SEARCH_PARAMETERS };
}

export interface ToolSearchContext {
  /** Late-bound: the registry is constructed after the tool (it wraps the tool's own catalog). */
  getRegistry: () => DynamicToolRegistry | undefined;
  logger?: Logger;
  sessionId: string;
}

function clampDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  // Code-point iteration: a UTF-16 slice could split a surrogate pair.
  const chars = Array.from(oneLine);
  if (chars.length <= RESULT_DESCRIPTION_MAX_CHARS) return oneLine;
  return `${chars.slice(0, RESULT_DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

export function createToolSearchTool(context: ToolSearchContext): AgentTool {
  return {
    name: TOOL_SEARCH_NAME,
    label: "Tool search",
    description: TOOL_SEARCH_DESCRIPTION,
    parameters: TOOL_SEARCH_PARAMETERS,
    execute: async (_toolCallId, params) => {
      const args = params as { query: string; max_results?: number };
      const registry = context.getRegistry();
      if (!registry) throw new Error("Dynamic tool loading is not active for this session.");

      const query = args.query.trim();
      let toLoad: string[];
      let unknown: string[] = [];
      if (query.toLowerCase().startsWith("select:")) {
        const requested = query
          .slice("select:".length)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        toLoad = requested.filter((name) => registry.inCatalog(name));
        unknown = requested.filter((name) => !registry.inCatalog(name));
      } else {
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .filter((term) => term.length > 0);
        if (terms.length === 0) throw new Error("Empty tool_search query.");
        const maxResults = args.max_results ?? DEFAULT_MAX_RESULTS;
        const scored = registry
          .deferredTools()
          .map((tool) => {
            const name = tool.name.toLowerCase();
            const description = tool.description.toLowerCase();
            let score = 0;
            for (const term of terms) {
              if (name.includes(term)) score += 3;
              if (description.includes(term)) score += 1;
            }
            return { tool, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
          .slice(0, maxResults);
        toLoad = scored.map((entry) => entry.tool.name);
      }

      const { added, alreadyLoaded } = registry.load(toLoad);
      const addedNames = added.map((tool) => tool.name);

      if (addedNames.length > 0) {
        context.logger?.info("tools_loaded", {
          sessionId: context.sessionId,
          source: "tool_search",
          query,
          names: addedNames,
          tokenEstimate: renderToolBlock(added).tokenEstimate,
          alreadyLoaded,
          unknown,
        });
      }

      const parts: string[] = [];
      if (added.length > 0) {
        parts.push(
          `Loaded ${added.length} tool(s) — now directly callable:\n` +
            added.map((tool) => `- ${tool.name} — ${clampDescription(tool.description)}`).join("\n"),
        );
      }
      if (alreadyLoaded.length > 0) {
        parts.push(`Already loaded: ${alreadyLoaded.join(", ")}.`);
      }
      if (unknown.length > 0) {
        parts.push(`Not in this session's catalog: ${unknown.join(", ")}.`);
      }
      if (parts.length === 0) {
        const deferredNames = registry.deferredTools().map((tool) => tool.name);
        parts.push(
          deferredNames.length > 0
            ? `No deferred tools matched "${query}". Deferred catalog: ${deferredNames.join(", ")}. ` +
              "Check <available_skills> for a covering skill, or refine the query."
            : "No tools are deferred in this session — everything available is already loaded.",
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        ...(addedNames.length > 0 ? { addedToolNames: addedNames } : {}),
        details: { query, added: addedNames, alreadyLoaded, unknown },
      };
    },
  };
}
