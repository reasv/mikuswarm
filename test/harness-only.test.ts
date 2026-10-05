/**
 * Tests for the harnessOnly enforcement (spec SESSION-RECORDS, CONTRACT §2):
 *   - filterHarnessOnlyFromIndex excludes harness-only tools from the deferred index.
 *   - tool_search (keyword + select modes) excludes / treats as unknown harness-only tools.
 *   - load_skill patterns do not claim harness-only tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  DynamicToolRegistry,
  filterHarnessOnlyFromIndex,
  renderDeferredToolsIndex,
  type DeferredToolLike,
} from "../src/agent/dynamic-tools.ts";
import { createToolSearchTool } from "../src/tools/tool-search.ts";
import { createLoadSkillTool } from "../src/tools/load-skill.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTool(name: string, opts?: { harnessOnly?: boolean; description?: string }): AgentTool {
  const tool = {
    name,
    label: name,
    description: opts?.description ?? `A tool named ${name}.`,
    parameters: {} as never,
    execute: async () => ({ content: [], details: null }),
  } as AgentTool;
  if (opts?.harnessOnly) {
    (tool as AgentTool & { harnessOnly: boolean }).harnessOnly = true;
  }
  return tool;
}

function makeDeferredLike(name: string, harnessOnly = false): DeferredToolLike {
  const item: DeferredToolLike & { harnessOnly?: boolean } = { name, description: `desc of ${name}` };
  if (harnessOnly) item.harnessOnly = true;
  return item;
}

// ── filterHarnessOnlyFromIndex ────────────────────────────────────────────────

test("filterHarnessOnlyFromIndex: keeps normal tools, drops harness-only", () => {
  const deferred: DeferredToolLike[] = [
    makeDeferredLike("normal_a"),
    makeDeferredLike("harness_tool", true),
    makeDeferredLike("normal_b"),
  ];
  const filtered = filterHarnessOnlyFromIndex(deferred);
  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ["normal_a", "normal_b"],
  );
});

test("filterHarnessOnlyFromIndex: empty list stays empty", () => {
  assert.deepEqual(filterHarnessOnlyFromIndex([]), []);
});

test("filterHarnessOnlyFromIndex: all harness-only → empty result", () => {
  const deferred = [makeDeferredLike("a", true), makeDeferredLike("b", true)];
  assert.deepEqual(filterHarnessOnlyFromIndex(deferred), []);
});

test("filterHarnessOnlyFromIndex: all normal → all kept", () => {
  const deferred = [makeDeferredLike("a"), makeDeferredLike("b")];
  const filtered = filterHarnessOnlyFromIndex(deferred);
  assert.equal(filtered.length, 2);
});

// ── renderDeferredToolsIndex: harness-only tools absent after filter ──────────

test("renderDeferredToolsIndex: harness-only tool is absent when filtered before call", () => {
  const deferred: DeferredToolLike[] = [
    makeDeferredLike("visible_tool"),
    makeDeferredLike("session_record_tool", true),
  ];
  const filtered = filterHarnessOnlyFromIndex(deferred);
  const result = renderDeferredToolsIndex(filtered, [], "names");
  assert.ok(result !== undefined, "should render something with visible_tool");
  assert.ok(result.includes("visible_tool"), "visible_tool should appear");
  assert.ok(!result.includes("session_record_tool"), "session_record_tool must not appear");
});

// ── tool_search keyword mode excludes harness-only ────────────────────────────

function makeRegistry(tools: AgentTool[], immediateNames: string[] = []): DynamicToolRegistry {
  return new DynamicToolRegistry(tools, immediateNames);
}

test("tool_search keyword: harness-only tool is not returned in search results", async () => {
  const normalTool = makeTool("useful_search_tool", { description: "search the database for records" });
  const harnessOnlyTool = makeTool("session_record_tool", {
    description: "write session record — harness-only",
    harnessOnly: true,
  });

  let reg: DynamicToolRegistry | undefined;
  const tool = createToolSearchTool({
    getRegistry: () => reg,
    sessionId: "test-session",
  });
  reg = makeRegistry([normalTool, harnessOnlyTool]);

  const result = await tool.execute("tc1", { query: "record" }, undefined as never);
  assert.ok(!result.isError);
  const text = result.content[0].type === "text" ? (result.content[0] as { text: string }).text : "";
  // session_record_tool matched "record" in its description, but must be excluded.
  assert.ok(!text.includes("session_record_tool"), `should not mention session_record_tool: ${text}`);
});

test("tool_search keyword: normal tool with matching keyword IS returned", async () => {
  const normalTool = makeTool("read_notes", { description: "search for notes in the database" });
  let reg: DynamicToolRegistry | undefined;
  const tool = createToolSearchTool({ getRegistry: () => reg, sessionId: "s" });
  reg = makeRegistry([normalTool]);

  const result = await tool.execute("tc1", { query: "notes" }, undefined as never);
  assert.ok(!result.isError);
  const text = result.content[0].type === "text" ? (result.content[0] as { text: string }).text : "";
  assert.ok(text.includes("read_notes"), `should mention read_notes: ${text}`);
});

// ── tool_search select mode: harness-only treated as unknown ─────────────────

test("tool_search select: harness-only tool is reported as unknown", async () => {
  const harnessOnlyTool = makeTool("session_record_tool", { harnessOnly: true });
  let reg: DynamicToolRegistry | undefined;
  const tool = createToolSearchTool({ getRegistry: () => reg, sessionId: "s" });
  reg = makeRegistry([harnessOnlyTool]);

  const result = await tool.execute("tc1", { query: "select:session_record_tool" }, undefined as never);
  assert.ok(!result.isError);
  const text = result.content[0].type === "text" ? (result.content[0] as { text: string }).text : "";
  // Should say "not in catalog" or equivalent (treated as unknown).
  assert.ok(
    text.toLowerCase().includes("not in") || text.toLowerCase().includes("catalog"),
    `select of harness-only should say not-in-catalog: ${text}`,
  );
  // The tool must NOT have been loaded.
  assert.equal(reg.isLoaded("session_record_tool"), false);
});

test("tool_search select: normal tool IS loadable via select", async () => {
  const normalTool = makeTool("my_tool");
  let reg: DynamicToolRegistry | undefined;
  const tool = createToolSearchTool({ getRegistry: () => reg, sessionId: "s" });
  reg = makeRegistry([normalTool]);

  const result = await tool.execute("tc1", { query: "select:my_tool" }, undefined as never);
  assert.ok(!result.isError);
  assert.equal(reg.isLoaded("my_tool"), true);
});

// ── load_skill patterns: harness-only tools not claimed ──────────────────────

test("load_skill: skill pattern does not load harness-only tools", async () => {
  const normalTool = makeTool("normal_skill_tool");
  const harnessOnlyTool = makeTool("session_record_tool", { harnessOnly: true });
  let reg: DynamicToolRegistry | undefined;

  const tool = createLoadSkillTool({
    workspaceRoot: "/tmp",
    skills: {
      // Skill claims both "normal_skill_tool" and "session_record_tool".
      listed: [
        {
          name: "my_skill",
          path: "skills/my_skill/SKILL.md",
          tools: ["normal_skill_tool", "session_record_tool"],
          content: undefined,
        },
      ],
      inlined: [],
    },
    getRegistry: () => reg,
    sessionId: "s",
  });
  reg = makeRegistry([normalTool, harnessOnlyTool]);

  // Stub fs read to fail → falls through to meta.content (undefined) → throws.
  // We need the skill body to be present. We'll exercise via readFile path.
  // Since readFile will fail for "/tmp/skills/my_skill/SKILL.md", it catches
  // and uses meta.content — which is undefined → throws.
  // Instead set content directly:
  (tool as unknown as { execute: Function }).execute; // suppress unused

  // Re-create with content set in meta so the skill body fallback works.
  let reg2: DynamicToolRegistry | undefined;
  const tool2 = createLoadSkillTool({
    workspaceRoot: "/tmp",
    skills: {
      listed: [
        {
          name: "test_skill",
          path: "does/not/exist.md",
          tools: ["normal_skill_tool", "session_record_tool"],
          content: "# Test skill\nDoes stuff.",
        },
      ],
      inlined: [],
    },
    getRegistry: () => reg2,
    sessionId: "s2",
  });
  reg2 = makeRegistry([normalTool, harnessOnlyTool]);

  const result = await tool2.execute("tc1", { name: "test_skill" }, undefined as never);
  assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);

  // normal_skill_tool was loaded; session_record_tool was not.
  assert.equal(reg2.isLoaded("normal_skill_tool"), true);
  assert.equal(reg2.isLoaded("session_record_tool"), false);
});
