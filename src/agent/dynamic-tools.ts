import { readFile } from "node:fs/promises";
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Logger } from "../observability/logger.js";
import type { SkillMeta } from "../workspace/types.js";
import { frontmatterToolPatterns, parseFrontmatter } from "../workspace/skills.js";
import { resolveWorkspacePath } from "../tools/workspace.js";
import { renderToolBlock } from "../context/tool-block.js";

/**
 * Dynamic session-time tool loading (spec DYNAMIC-TOOL-LOADING).
 *
 * This module is the PURE core: pattern matching, the per-session registry, the
 * deferred-tools index renderer, and the text-editor skill-activation wrapper.
 * It knows nothing about config loading or the session factory — the factory
 * composes these pieces in `create()`.
 *
 * The transport is pi-ai's `addedToolNames` contract: the registry only decides
 * WHICH tools are in `Context.tools` at any moment; a loading tool's result
 * carries `addedToolNames`, pi-agent-core stamps it onto the transcript
 * message, and each pi-ai driver serializes the load point in the most
 * cache-friendly way its wire API allows. No per-provider logic exists here.
 */

/**
 * Does `name` match `pattern`? A pattern is an exact tool name or a
 * trailing-`*` glob (`mcp_medialib_*`). `*` alone matches everything. No other
 * glob syntax is supported.
 */
export function matchesToolPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * All of `names` matched by at least one of `patterns`, in `names` order
 * (catalog/declaration order), deduplicated.
 */
export function matchToolPatterns(
  names: readonly string[],
  patterns: readonly string[],
): string[] {
  if (patterns.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    if (patterns.some((pattern) => matchesToolPattern(name, pattern))) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Result of a {@link DynamicToolRegistry.load} call. */
export interface LoadResult {
  /** Tools newly moved to the loaded set, in catalog order. */
  added: AgentTool[];
  /** Requested names that were already loaded. */
  alreadyLoaded: string[];
  /** Requested names not present in the session catalog at all. */
  unknown: string[];
}

/**
 * The per-session dynamic tool registry (spec §3/§7): the session's full
 * catalog split into *loaded* (in `Context.tools` now) and *deferred*
 * (withheld, loadable). One instance per created agent; the loaded set only
 * ever grows within a session.
 */
export class DynamicToolRegistry {
  private readonly loadedNames = new Set<string>();
  private readonly byName = new Map<string, AgentTool>();
  private currentArr: AgentTool[];
  /**
   * Fired after each load event that actually added tools (never during
   * {@link seedFromTranscript}). The factory uses it to reassert
   * `agent.state.tools` for between-run pickup and to charge the running
   * context counter (spec §9).
   */
  onChange?: (added: AgentTool[]) => void;

  constructor(
    private readonly catalog: readonly AgentTool[],
    immediateNames: Iterable<string>,
  ) {
    for (const tool of catalog) this.byName.set(tool.name, tool);
    for (const name of immediateNames) {
      if (this.byName.has(name)) this.loadedNames.add(name);
    }
    this.currentArr = this.computeCurrent();
  }

  private computeCurrent(): AgentTool[] {
    return this.catalog.filter((tool) => this.loadedNames.has(tool.name));
  }

  /** The currently loaded tool array (catalog order). Stable until a load event. */
  get current(): AgentTool[] {
    return this.currentArr;
  }

  /** Tools still deferred, in catalog order. */
  deferredTools(): AgentTool[] {
    return this.catalog.filter((tool) => !this.loadedNames.has(tool.name));
  }

  /** All catalog tool names, in catalog order. */
  catalogNames(): string[] {
    return this.catalog.map((tool) => tool.name);
  }

  isLoaded(name: string): boolean {
    return this.loadedNames.has(name);
  }

  inCatalog(name: string): boolean {
    return this.byName.has(name);
  }

  /** Catalog names matching any of `patterns` (loaded or not), catalog order. */
  matchCatalog(patterns: readonly string[]): string[] {
    return matchToolPatterns(this.catalogNames(), patterns);
  }

  /**
   * Move `names` to the loaded set. Unknown names are reported, never thrown —
   * a skill may legitimately declare tools this session's catalog lacks.
   * Fires {@link onChange} when at least one tool was actually added.
   */
  load(names: readonly string[]): LoadResult {
    const added: AgentTool[] = [];
    const alreadyLoaded: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const tool = this.byName.get(name);
      if (!tool) {
        unknown.push(name);
      } else if (this.loadedNames.has(name)) {
        alreadyLoaded.push(name);
      } else {
        this.loadedNames.add(name);
        added.push(tool);
      }
    }
    if (added.length > 0) {
      this.currentArr = this.computeCurrent();
      this.onChange?.(added);
    }
    return { added, alreadyLoaded, unknown };
  }

  /**
   * Recompute the loaded set from a persisted transcript (spec §7): the loaded
   * set is definitionally (immediate ∪ every `addedToolNames` on any tool
   * result) — the same rule pi-ai's `splitDeferredTools` derives from the same
   * messages. Silent: no {@link onChange} (the agent doesn't exist yet, and the
   * resumed usage actuals already cover the accounting). Returns the names
   * added from the transcript.
   */
  seedFromTranscript(messages: readonly AgentMessage[]): string[] {
    const added: string[] = [];
    for (const message of messages) {
      const candidate = message as { role?: unknown; addedToolNames?: unknown };
      if (candidate.role !== "toolResult" || !Array.isArray(candidate.addedToolNames)) continue;
      for (const name of candidate.addedToolNames) {
        if (typeof name !== "string") continue;
        if (this.byName.has(name) && !this.loadedNames.has(name)) {
          this.loadedNames.add(name);
          added.push(name);
        }
      }
    }
    if (added.length > 0) this.currentArr = this.computeCurrent();
    return added;
  }
}

/** Minimal structural view of a deferred tool for index rendering. */
export interface DeferredToolLike {
  name: string;
  description: string;
}

export type DeferredIndexMode = "orphans" | "names" | "descriptions" | "none";

/** Truncation width for "descriptions" mode (spec §8). */
const INDEX_DESCRIPTION_MAX_CHARS = 80;

function truncateDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  // Code-point iteration: a UTF-16 slice could split a surrogate pair.
  const chars = Array.from(oneLine);
  if (chars.length <= INDEX_DESCRIPTION_MAX_CHARS) return oneLine;
  return `${chars.slice(0, INDEX_DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

/**
 * Render the `<deferred_tools>` system-prompt block (spec §8), or undefined to
 * omit it (mode "none", or nothing to list). Deterministic: a pure function of
 * the deferred set (catalog order), the skills scan (skills sorted by name; a
 * tool matched by several skills lists under the first, alphabetically), and
 * the mode — byte-identical across sessions of the same config/workspace state.
 */
export function renderDeferredToolsIndex(
  deferred: readonly DeferredToolLike[],
  skills: readonly SkillMeta[],
  mode: DeferredIndexMode,
): string | undefined {
  if (mode === "none" || deferred.length === 0) return undefined;

  const deferredNames = deferred.map((tool) => tool.name);
  const byName = new Map(deferred.map((tool) => [tool.name, tool]));
  const claimed = new Set<string>();
  const groups: { skill: string; tools: DeferredToolLike[] }[] = [];
  const skillsSorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  for (const skill of skillsSorted) {
    if (!skill.tools || skill.tools.length === 0) continue;
    const matched = matchToolPatterns(deferredNames, skill.tools).filter(
      (name) => !claimed.has(name),
    );
    if (matched.length === 0) continue;
    for (const name of matched) claimed.add(name);
    groups.push({ skill: skill.name, tools: matched.map((name) => byName.get(name)!) });
  }
  const orphans = deferred.filter((tool) => !claimed.has(tool.name));

  const lines: string[] = [];
  if (mode === "orphans") {
    if (orphans.length === 0) return undefined;
    lines.push(
      "More tools exist but are not loaded. Load them with tool_search (or load_skill when a skill covers them):",
    );
    lines.push(orphans.map((tool) => tool.name).join(", "));
  } else {
    lines.push("Deferred tools — not yet callable; load via load_skill (per skill) or tool_search:");
    for (const group of groups) {
      if (mode === "descriptions") {
        lines.push(`${group.skill}:`);
        for (const tool of group.tools) {
          lines.push(`  ${tool.name} — ${truncateDescription(tool.description)}`);
        }
      } else {
        lines.push(`${group.skill}: ${group.tools.map((tool) => tool.name).join(", ")}`);
      }
    }
    if (orphans.length > 0) {
      if (mode === "descriptions") {
        lines.push("(unskilled):");
        for (const tool of orphans) {
          lines.push(`  ${tool.name} — ${truncateDescription(tool.description)}`);
        }
      } else {
        lines.push(`(unskilled): ${orphans.map((tool) => tool.name).join(", ")}`);
      }
    }
  }

  return `<deferred_tools>\n${lines.join("\n")}\n</deferred_tools>`;
}

/** Options for {@link wrapEditorWithSkillActivation}. */
export interface EditorSkillActivationOptions {
  workspaceRoot: string;
  getRegistry: () => DynamicToolRegistry | undefined;
  logger?: Logger;
  sessionId: string;
}

/**
 * Wrap the text-editor tool with the skill-activation backstop (spec §5, D2):
 * after a successful `view` of any markdown file whose YAML frontmatter carries
 * a `tools` key, the same load path as `load_skill` runs — newly matched
 * cataloged tools are loaded and the view result is stamped with
 * `addedToolNames` plus an appended note. Keyed on CONTENT, not path, so a
 * skill the agent authored mid-session activates when it proofreads it.
 *
 * Best-effort by design: any failure in the hook (unreadable file, parse
 * miss) returns the original view result unchanged — the hook must never turn
 * a working view into an error.
 */
export function wrapEditorWithSkillActivation(
  tool: AgentTool,
  options: EditorSkillActivationOptions,
): AgentTool {
  const originalExecute = tool.execute as (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<AgentToolResult<unknown>>;

  const execute = async (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<AgentToolResult<unknown>> => {
    const result = await originalExecute(toolCallId, params, signal, onUpdate);
    const args = params as { command?: unknown; path?: unknown };
    if (args?.command !== "view" || typeof args.path !== "string" || !args.path.endsWith(".md")) {
      return result;
    }
    const registry = options.getRegistry();
    if (!registry) return result;
    try {
      const absolute = resolveWorkspacePath(options.workspaceRoot, args.path);
      const raw = await readFile(absolute, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) return result;
      const patterns = frontmatterToolPatterns(parsed.frontmatter);
      if (!patterns) return result;
      const { added } = registry.load(registry.matchCatalog(patterns));
      if (added.length === 0) return result;
      const names = added.map((addedTool) => addedTool.name);
      options.logger?.info("tools_loaded", {
        sessionId: options.sessionId,
        source: "editor_view",
        path: args.path,
        names,
        tokenEstimate: renderToolBlock(added).tokenEstimate,
      });
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text: `[This file declares tools; they are now loaded and directly callable: ${names.join(", ")}]`,
          },
        ],
        addedToolNames: names,
      };
    } catch {
      return result;
    }
  };

  return { ...tool, execute } as unknown as AgentTool;
}
