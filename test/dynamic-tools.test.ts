import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  DynamicToolRegistry,
  matchesToolPattern,
  matchToolPatterns,
  renderDeferredToolsIndex,
  wrapEditorWithSkillActivation,
} from "../src/agent/dynamic-tools.js";
import { createLoadSkillTool } from "../src/tools/load-skill.js";
import { createToolSearchTool } from "../src/tools/tool-search.js";
import { scanSkills, parseFrontmatter, frontmatterToolPatterns } from "../src/workspace/skills.js";
import { loadWorkspace } from "../src/workspace/loader.js";
import { renderSystemPrompt, renderSystemPromptWithSegments } from "../src/workspace/prompt.js";
import type { SkillMeta, WorkspaceContent } from "../src/workspace/types.js";

function makeTool(name: string, description = `${name} description`): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: `${name} ran` }] }),
  } as AgentTool;
}

function skillMeta(overrides: Partial<SkillMeta> & { name: string }): SkillMeta {
  return {
    description: `${overrides.name} skill`,
    path: `skills/${overrides.name}/SKILL.md`,
    alwaysLoaded: false,
    ...overrides,
  };
}

describe("matchToolPatterns", () => {
  it("matches exact names and trailing-* globs", () => {
    assert.equal(matchesToolPattern("danbooru", "danbooru"), true);
    assert.equal(matchesToolPattern("danbooru", "danboor"), false);
    assert.equal(matchesToolPattern("mcp_medialib_play", "mcp_medialib_*"), true);
    assert.equal(matchesToolPattern("mcp_other_play", "mcp_medialib_*"), false);
    assert.equal(matchesToolPattern("anything", "*"), true);
  });

  it("preserves catalog order and deduplicates", () => {
    const names = ["b", "a", "mcp_x_one", "mcp_x_two"];
    assert.deepEqual(matchToolPatterns(names, ["mcp_x_*", "a", "mcp_x_one"]), [
      "a",
      "mcp_x_one",
      "mcp_x_two",
    ]);
    assert.deepEqual(matchToolPatterns(names, []), []);
  });
});

describe("DynamicToolRegistry", () => {
  const catalog = [makeTool("send_message"), makeTool("danbooru"), makeTool("mcp_x_play")];

  it("starts with the immediate set; load moves tools and fires onChange", () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    assert.deepEqual(registry.current.map((t) => t.name), ["send_message"]);
    assert.deepEqual(registry.deferredTools().map((t) => t.name), ["danbooru", "mcp_x_play"]);

    let observed: string[] | undefined;
    registry.onChange = (added) => {
      observed = added.map((t) => t.name);
    };
    const result = registry.load(["danbooru", "send_message", "nope"]);
    assert.deepEqual(result.added.map((t) => t.name), ["danbooru"]);
    assert.deepEqual(result.alreadyLoaded, ["send_message"]);
    assert.deepEqual(result.unknown, ["nope"]);
    assert.deepEqual(observed, ["danbooru"]);
    // Catalog order, not load order.
    assert.deepEqual(registry.current.map((t) => t.name), ["send_message", "danbooru"]);
  });

  it("does not fire onChange when nothing was added", () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    let fired = 0;
    registry.onChange = () => fired++;
    registry.load(["send_message", "unknown"]);
    assert.equal(fired, 0);
  });

  it("ignores immediate names not in the catalog", () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message", "ghost"]);
    assert.deepEqual(registry.current.map((t) => t.name), ["send_message"]);
    assert.equal(registry.inCatalog("ghost"), false);
  });

  it("seedFromTranscript recomputes the loaded set silently from addedToolNames", () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    let fired = 0;
    registry.onChange = () => fired++;
    const transcript = [
      { role: "user", content: [], timestamp: 1 },
      { role: "toolResult", toolCallId: "t1", toolName: "load_skill", content: [], isError: false, timestamp: 2, addedToolNames: ["danbooru", "not_in_catalog"] },
      { role: "assistant", content: [], timestamp: 3 },
    ] as unknown as AgentMessage[];
    const added = registry.seedFromTranscript(transcript);
    assert.deepEqual(added, ["danbooru"]);
    assert.equal(fired, 0);
    assert.deepEqual(registry.current.map((t) => t.name), ["send_message", "danbooru"]);
  });
});

describe("renderDeferredToolsIndex", () => {
  const deferred = [
    makeTool("mcp_medialib_play", "Play media"),
    makeTool("mcp_medialib_queue", "Queue media"),
    makeTool("danbooru", "Search anime images with a long description that should be truncated at some point because it just keeps going and going"),
    makeTool("find_source", "Reverse image search"),
  ];
  const skills = [
    skillMeta({ name: "medialib", tools: ["mcp_medialib_*"] }),
    skillMeta({ name: "gallery", tools: ["danbooru"] }),
    skillMeta({ name: "no-tools-skill" }),
  ];

  it("orphans mode lists only tools no skill covers; empty ⇒ undefined", () => {
    const text = renderDeferredToolsIndex(deferred, skills, "orphans");
    assert.ok(text);
    assert.match(text!, /find_source/);
    assert.doesNotMatch(text!, /danbooru/);
    assert.doesNotMatch(text!, /mcp_medialib_play/);

    const covered = deferred.filter((t) => t.name !== "find_source");
    assert.equal(renderDeferredToolsIndex(covered, skills, "orphans"), undefined);
  });

  it("names mode groups by skill (alphabetical) with unskilled tail", () => {
    const text = renderDeferredToolsIndex(deferred, skills, "names")!;
    const lines = text.split("\n");
    assert.equal(lines[0], "<deferred_tools>");
    // gallery sorts before medialib
    assert.ok(lines.findIndex((l) => l.startsWith("gallery:")) < lines.findIndex((l) => l.startsWith("medialib:")));
    assert.match(text, /gallery: danbooru/);
    assert.match(text, /medialib: mcp_medialib_play, mcp_medialib_queue/);
    assert.match(text, /\(unskilled\): find_source/);
  });

  it("descriptions mode truncates long descriptions", () => {
    const text = renderDeferredToolsIndex(deferred, skills, "descriptions")!;
    assert.match(text, /danbooru — Search anime images/);
    assert.match(text, /…/);
  });

  it("none mode and empty deferred set render nothing", () => {
    assert.equal(renderDeferredToolsIndex(deferred, skills, "none"), undefined);
    assert.equal(renderDeferredToolsIndex([], skills, "names"), undefined);
  });

  it("is deterministic", () => {
    const a = renderDeferredToolsIndex(deferred, skills, "names");
    const b = renderDeferredToolsIndex([...deferred], [...skills].reverse(), "names");
    assert.equal(a, b);
  });
});

describe("skills frontmatter tools parsing", () => {
  it("parses block sequences, inline flow lists, and scalars", () => {
    const block = parseFrontmatter(`---\nname: x\ndescription: d\ntools:\n  - a\n  - "b_*"\n---\nBody`);
    assert.deepEqual(frontmatterToolPatterns(block!.frontmatter), ["a", "b_*"]);

    const inline = parseFrontmatter(`---\nname: x\ndescription: d\ntools: [a, 'b']\n---\nBody`);
    assert.deepEqual(frontmatterToolPatterns(inline!.frontmatter), ["a", "b"]);

    const scalar = parseFrontmatter(`---\nname: x\ndescription: d\ntools: single_tool\n---\nBody`);
    assert.deepEqual(frontmatterToolPatterns(scalar!.frontmatter), ["single_tool"]);

    const none = parseFrontmatter(`---\nname: x\ndescription: d\n---\nBody`);
    assert.equal(frontmatterToolPatterns(none!.frontmatter), undefined);
  });

  it("keeps scalar key parsing intact around block sequences", () => {
    const parsed = parseFrontmatter(
      `---\nname: x\ntools:\n  - a\nalways_loaded: true\ndescription: after-list\n---\nBody`,
    );
    assert.equal(parsed!.frontmatter.name, "x");
    assert.equal(parsed!.frontmatter.always_loaded, true);
    assert.equal(parsed!.frontmatter.description, "after-list");
    assert.deepEqual(parsed!.frontmatter.tools, ["a"]);
    assert.equal(parsed!.body, "Body");
  });
});

describe("dynamic prompt rendering + tools scan", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-dynamic-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSkill(name: string, frontmatterExtra = "", body = "Do the thing."): Promise<void> {
    const dir = path.join(tmpDir, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} things\n${frontmatterExtra}---\n\n# ${name}\n\n${body}\n`,
    );
  }

  it("scanSkills surfaces frontmatter tools patterns", async () => {
    await writeSkill("medialib", "tools:\n  - mcp_medialib_*\n");
    const skills = await scanSkills(tmpDir);
    assert.equal(skills.listed.length, 1);
    assert.deepEqual(skills.listed[0].tools, ["mcp_medialib_*"]);
  });

  it("legacy rendering (no dynamicTools) is unchanged: paths visible, no loader instruction", async () => {
    await writeSkill("medialib", "tools:\n  - mcp_medialib_*\n");
    const workspace = await loadWorkspace(tmpDir);
    const prompt = renderSystemPrompt(workspace);
    assert.match(prompt, /path="skills\/medialib\/SKILL\.md"/);
    assert.doesNotMatch(prompt, /load_skill/);
    assert.doesNotMatch(prompt, /<deferred_tools>/);
  });

  it("dynamic rendering hides paths, instructs load_skill, appends the index", async () => {
    await writeSkill("medialib", "tools:\n  - mcp_medialib_*\n");
    const workspace = await loadWorkspace(tmpDir);
    workspace.dynamicTools = {
      indexText: "<deferred_tools>\nx\n</deferred_tools>",
    };
    const { text, segments } = renderSystemPromptWithSegments(workspace);
    assert.doesNotMatch(text, /path="skills/);
    assert.match(text, /Load a skill with the load_skill tool/);
    assert.match(text, /<skill name="medialib">medialib things<\/skill>/);
    assert.match(text, /To author a NEW skill/);
    assert.match(text, /<deferred_tools>\nx\n<\/deferred_tools>/);
    assert.ok(segments.some((s) => s.tag === "deferred_tools"));
  });

  it("load_skill loads the skill's tools and stamps addedToolNames", async () => {
    await writeSkill("medialib", "tools:\n  - mcp_medialib_*\n");
    const workspace = await loadWorkspace(tmpDir);
    const catalog = [makeTool("send_message"), makeTool("mcp_medialib_play"), makeTool("mcp_medialib_queue")];
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    const tool = createLoadSkillTool({
      workspaceRoot: tmpDir,
      skills: workspace.skills,
      getRegistry: () => registry,
      sessionId: "s1",
    });

    const result = await tool.execute("t1", { name: "medialib" });
    assert.deepEqual(result.addedToolNames, ["mcp_medialib_play", "mcp_medialib_queue"]);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /<skill name="medialib">/);
    assert.match(text, /Do the thing\./);
    assert.match(text, /mcp_medialib_play, mcp_medialib_queue/);
    assert.deepEqual(registry.current.map((t) => t.name), [
      "send_message",
      "mcp_medialib_play",
      "mcp_medialib_queue",
    ]);

    // Idempotent: second load returns the body again, adds nothing.
    const again = await tool.execute("t2", { name: "medialib" });
    assert.equal(again.addedToolNames, undefined);
    assert.match((again.content[0] as { type: "text"; text: string }).text, /Already loaded/);
  });

  it("load_skill rejects unknown skills with the available list", async () => {
    await writeSkill("medialib");
    const workspace = await loadWorkspace(tmpDir);
    const registry = new DynamicToolRegistry([makeTool("send_message")], ["send_message"]);
    const tool = createLoadSkillTool({
      workspaceRoot: tmpDir,
      skills: workspace.skills,
      getRegistry: () => registry,
      sessionId: "s1",
    });
    await assert.rejects(
      () => tool.execute("t1", { name: "nope" }),
      /Unknown skill "nope"\. Available skills: medialib/,
    );
  });

  it("editor view of a tools-declaring markdown file activates its tools", async () => {
    const skillDir = path.join(tmpDir, "notes");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "custom.md"),
      `---\nname: custom\ndescription: custom\ntools: [danbooru]\n---\n\nCustom instructions.\n`,
    );
    await writeFile(path.join(tmpDir, "plain.md"), "no frontmatter here\n");

    const catalog = [makeTool("danbooru")];
    const registry = new DynamicToolRegistry(catalog, []);
    const editor: AgentTool = {
      name: "str_replace_based_edit_tool",
      label: "editor",
      description: "editor",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "1\tfile contents" }] }),
    } as AgentTool;
    const wrapped = wrapEditorWithSkillActivation(editor, {
      workspaceRoot: tmpDir,
      getRegistry: () => registry,
      sessionId: "s1",
    });

    const plain = await wrapped.execute("t0", { command: "view", path: "plain.md" });
    assert.equal(plain.addedToolNames, undefined);
    assert.equal(registry.current.length, 0);

    const result = await wrapped.execute("t1", { command: "view", path: "notes/custom.md" });
    assert.deepEqual(result.addedToolNames, ["danbooru"]);
    assert.match(
      (result.content.at(-1) as { type: "text"; text: string }).text,
      /now loaded and directly callable: danbooru/,
    );

    // Second view: already loaded, no re-stamp.
    const again = await wrapped.execute("t2", { command: "view", path: "notes/custom.md" });
    assert.equal(again.addedToolNames, undefined);

    // Non-view commands pass through untouched.
    const edit = await wrapped.execute("t3", { command: "str_replace", path: "notes/custom.md" });
    assert.equal(edit.addedToolNames, undefined);
  });
});

describe("tool_search", () => {
  const catalog = [
    makeTool("send_message", "Deliver a chat message"),
    makeTool("danbooru", "Search anime images on danbooru"),
    makeTool("find_source", "Reverse image search via SauceNAO"),
    makeTool("mcp_medialib_play", "Play media from the library"),
  ];

  function makeSearch(registry: DynamicToolRegistry) {
    return createToolSearchTool({ getRegistry: () => registry, sessionId: "s1" });
  }

  it("select: loads exact names and reports unknowns", async () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    const tool = makeSearch(registry);
    const result = await tool.execute("t1", { query: "select:danbooru, find_source, ghost" });
    assert.deepEqual(result.addedToolNames, ["danbooru", "find_source"]);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /Loaded 2 tool\(s\)/);
    assert.match(text, /Not in this session's catalog: ghost/);
  });

  it("keyword mode scores names over descriptions and loads matches", async () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    const tool = makeSearch(registry);
    const result = await tool.execute("t1", { query: "image search" });
    // Both danbooru and find_source mention image/search in descriptions.
    assert.ok(result.addedToolNames!.includes("find_source"));
    assert.ok(result.addedToolNames!.includes("danbooru"));
    assert.ok(!result.addedToolNames!.includes("mcp_medialib_play"));
  });

  it("no-match reports the deferred catalog", async () => {
    const registry = new DynamicToolRegistry(catalog, ["send_message"]);
    const tool = makeSearch(registry);
    const result = await tool.execute("t1", { query: "zzzznothing" });
    assert.equal(result.addedToolNames, undefined);
    assert.match(
      (result.content[0] as { type: "text"; text: string }).text,
      /No deferred tools matched/,
    );
  });
});
