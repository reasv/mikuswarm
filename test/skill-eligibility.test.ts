import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { scanSkills, eligibleSkillIndex, skillRequirementsMet } from "../src/workspace/skills.js";
import { DynamicToolRegistry, wrapEditorWithSkillActivation } from "../src/agent/dynamic-tools.js";
import { createLoadSkillTool } from "../src/tools/load-skill.js";
const tool = (name: string): AgentTool => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "viewed" }], details: {} }) });
test("generic requirements gate listed and inline skills against the configured whole catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-requirements-"));
  try {
    for (const [name, extra] of [["web", ""], ["inline", "always_loaded: true\n"]]) {
      await mkdir(path.join(root, "skills", name), { recursive: true });
      await writeFile(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: evidence\n${extra}requires_any_tools: [exa_*, x_search]\ntools: [exa_search]\n---\nInstructions`);
    }
    const scan = await scanSkills(root);
    assert.deepEqual(scan.listed[0]?.requiresAnyTools, ["exa_*", "x_search"]);
    assert.deepEqual(eligibleSkillIndex(scan, []).listed, []);
    assert.deepEqual(eligibleSkillIndex(scan, []).inlined, []);
    assert.equal(eligibleSkillIndex(scan, ["x_search"]).listed.length, 1);
    assert.equal(eligibleSkillIndex(scan, ["exa_search"]).inlined.length, 1);
    assert.equal(skillRequirementsMet(undefined, []), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("live changed requirements prevent explicit/synthetic load and editor activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-requirements-"));
  try {
    const dir = path.join(root, "skills", "web"); await mkdir(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    await writeFile(file, "---\nname: web\ndescription: evidence\nrequires_any_tools: [exa_search]\ntools: [exa_search]\n---\nInstructions");
    const registry = new DynamicToolRegistry([tool("exa_search")], new Set());
    const skills = await scanSkills(root);
    const loader = createLoadSkillTool({ workspaceRoot: root, skills, getRegistry: () => registry, sessionId: "test" });
    await writeFile(file, "---\nname: web\ndescription: evidence\nrequires_any_tools: [missing]\ntools: [exa_search]\n---\nInstructions");
    await assert.rejects(loader.execute("synthetic", { name: "web" }), /unavailable/);
    const editor = wrapEditorWithSkillActivation(tool("editor"), { workspaceRoot: root, getRegistry: () => registry, sessionId: "test" });
    const viewed = await editor.execute("view", { command: "view", path: "skills/web/SKILL.md" });
    assert.equal(viewed.addedToolNames, undefined);
    assert.equal(registry.isLoaded("exa_search"), false);
    const unavailable = new DynamicToolRegistry([tool("other")], new Set());
    const denied = createLoadSkillTool({ workspaceRoot: root, skills, getRegistry: () => unavailable, sessionId: "test" });
    await assert.rejects(denied.execute("load", { name: "web" }), /unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
