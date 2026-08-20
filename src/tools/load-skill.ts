import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import { frontmatterToolPatterns, parseFrontmatter } from "../workspace/skills.js";
import type { SkillIndex } from "../workspace/types.js";
import type { DynamicToolRegistry } from "../agent/dynamic-tools.js";
import type { Logger } from "../observability/logger.js";
import { renderToolBlock } from "../context/tool-block.js";

/**
 * `load_skill` (spec DYNAMIC-TOOL-LOADING §5): THE sanctioned way to use a
 * skill. Returns the skill's full instructions and enables the tools its
 * frontmatter declares — the result carries `addedToolNames`, which pi-ai
 * serializes as the provider-appropriate load point.
 *
 * The skill INDEX (which skills exist) is the session-creation scan; the skill
 * BODY (and its tools list) is read live from disk at call time — the same
 * semantics the text-editor read path has always had (spec §7, invariant 10
 * amendment).
 */

const LOAD_SKILL_NAME = "load_skill";
const LOAD_SKILL_DESCRIPTION =
  "Load a skill by name: returns its full instructions and enables the tools it declares, " +
  "which become directly callable. Skills are listed in <available_skills> and are not usable until loaded.";
const LOAD_SKILL_PARAMETERS = Type.Object({
  name: Type.String({ description: "Skill name exactly as listed in <available_skills>." }),
});

/** Static wire definition, for the console inspector's initial-tool-block recompute. */
export function loadSkillToolDefinition() {
  return { name: LOAD_SKILL_NAME, description: LOAD_SKILL_DESCRIPTION, parameters: LOAD_SKILL_PARAMETERS };
}

export interface LoadSkillContext {
  workspaceRoot: string;
  /** The session-creation skills scan (listed + inlined = the loadable universe). */
  skills: SkillIndex;
  /** Late-bound: the registry is constructed after the tool (it wraps the tool's own catalog). */
  getRegistry: () => DynamicToolRegistry | undefined;
  logger?: Logger;
  sessionId: string;
}

export function createLoadSkillTool(context: LoadSkillContext): AgentTool {
  return {
    name: LOAD_SKILL_NAME,
    label: "Load skill",
    description: LOAD_SKILL_DESCRIPTION,
    parameters: LOAD_SKILL_PARAMETERS,
    execute: async (_toolCallId, params) => {
      const { name } = params as { name: string };
      const registry = context.getRegistry();
      if (!registry) throw new Error("Dynamic tool loading is not active for this session.");

      // Listed skills only (spec §5): inlined (always_loaded) skills are already
      // in the system prompt with their tools promoted — offering them here would
      // only invite pointless re-loads.
      const meta = context.skills.listed.find((skill) => skill.name === name);
      if (!meta) {
        const available = context.skills.listed.map((skill) => skill.name).sort().join(", ") || "(none)";
        const inlinedNote = context.skills.inlined.some((skill) => skill.name === name)
          ? ` ("${name}" is an always-loaded skill — its instructions and tools are already active.)`
          : "";
        throw new Error(`Unknown skill "${name}". Available skills: ${available}.${inlinedNote}`);
      }

      // Body + tools list read LIVE from disk (freshest content; matches the
      // editor-hook's content-keyed behavior). Fall back to the scan-time
      // metadata when the live read/parse fails (file deleted mid-session).
      let body: string | undefined;
      let patterns = meta.tools ?? [];
      try {
        const absolute = resolveWorkspacePath(context.workspaceRoot, meta.path);
        const raw = await readFile(absolute, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (parsed) {
          body = parsed.body;
          patterns = frontmatterToolPatterns(parsed.frontmatter) ?? [];
        } else {
          body = raw;
        }
      } catch {
        body = meta.content; // populated for inlined skills only
      }
      if (body === undefined) {
        throw new Error(`Skill "${name}" could not be read from ${meta.path}.`);
      }

      const { added, alreadyLoaded, unknown } = registry.load(registry.matchCatalog(patterns));
      const addedNames = added.map((tool) => tool.name);

      context.logger?.info("skill_loaded", {
        sessionId: context.sessionId,
        skill: name,
        tools: addedNames,
        alreadyLoaded,
        unmatched: unknown,
      });
      if (addedNames.length > 0) {
        context.logger?.info("tools_loaded", {
          sessionId: context.sessionId,
          source: "load_skill",
          skill: name,
          names: addedNames,
          tokenEstimate: renderToolBlock(added).tokenEstimate,
        });
      }

      const parts: string[] = [`<skill name="${name}">\n${body}\n</skill>`];
      if (addedNames.length > 0) {
        parts.push(`Tools enabled by this skill (now directly callable): ${addedNames.join(", ")}.`);
      }
      if (alreadyLoaded.length > 0) {
        parts.push(`Already loaded: ${alreadyLoaded.join(", ")}.`);
      }
      if (patterns.length === 0) {
        parts.push("This skill declares no tools (instructions only).");
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        ...(addedNames.length > 0 ? { addedToolNames: addedNames } : {}),
        details: { skill: name, added: addedNames, alreadyLoaded },
      };
    },
  };
}
