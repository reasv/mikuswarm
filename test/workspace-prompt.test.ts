import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadWorkspace } from "../src/workspace/loader.js";
import { renderSystemPrompt, renderSatelliteBlock } from "../src/workspace/prompt.js";
import { scanSkills } from "../src/workspace/skills.js";
import type { WorkspaceContent, SatelliteRuntimeInput, SessionTypeConfig } from "../src/workspace/types.js";
import type { CanonicalChatEvent } from "../src/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "miku-workspace-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeTrigger(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "evt-1",
    externalId: "$evt1",
    timelineKey: "matrix:miku:room:!test:server.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:server.org", displayName: "Alice", isSelf: false },
    body: "hello miku",
    timestamp: Date.parse("2026-05-26T14:00:00.000Z"),
    receivedAt: Date.now(),
    ...overrides,
  };
}

function makeRuntimeInput(overrides: Partial<SatelliteRuntimeInput> = {}): SatelliteRuntimeInput {
  return {
    timelineKey: "matrix:miku:room:!test:server.org",
    trigger: makeTrigger(),
    activeSessions: [],
    ...overrides,
  };
}

describe("workspace loader", () => {
  it("loads default workspace files that exist, skips missing ones", async () => {
    await writeFile(path.join(tmpDir, "AGENTS.md"), "# Main instructions");
    await writeFile(path.join(tmpDir, "SOUL.md"), "# Personality");
    // TOOLS.md intentionally missing

    const result = await loadWorkspace(tmpDir);
    assert.equal(result.files.size, 2);
    assert.equal(result.files.get("AGENTS.md"), "# Main instructions");
    assert.equal(result.files.get("SOUL.md"), "# Personality");
    assert.equal(result.files.has("TOOLS.md"), false);
    assert.equal(result.tailContent, null);
  });

  it("loads TAIL.md separately from workspace files", async () => {
    await writeFile(path.join(tmpDir, "AGENTS.md"), "instructions");
    await writeFile(path.join(tmpDir, "TAIL.md"), "Remember to be concise.");

    const result = await loadWorkspace(tmpDir);
    assert.equal(result.files.has("TAIL.md"), false, "TAIL.md should not be in workspace files");
    assert.equal(result.tailContent, "Remember to be concise.");
  });

  it("respects session type workspace_files filter", async () => {
    await writeFile(path.join(tmpDir, "AGENTS.md"), "instructions");
    await writeFile(path.join(tmpDir, "SOUL.md"), "personality");
    await writeFile(path.join(tmpDir, "TOOLS.md"), "tools");

    const result = await loadWorkspace(tmpDir, { workspaceFiles: ["AGENTS.md"] });
    assert.equal(result.files.size, 1);
    assert.equal(result.files.has("AGENTS.md"), true);
    assert.equal(result.files.has("SOUL.md"), false);
  });

  it("suppresses tail when session type sets tail_file to null", async () => {
    await writeFile(path.join(tmpDir, "TAIL.md"), "tail content");

    const result = await loadWorkspace(tmpDir, { tailFile: null });
    assert.equal(result.tailContent, null);
  });

  it("loads alternate tail file when session type overrides tail_file", async () => {
    await writeFile(path.join(tmpDir, "TAIL.md"), "default tail");
    await writeFile(path.join(tmpDir, "TAIL_SUMMARIZE.md"), "summarize tail");

    const result = await loadWorkspace(tmpDir, { tailFile: "TAIL_SUMMARIZE.md" });
    assert.equal(result.tailContent, "summarize tail");
  });

  it("returns empty workspace for nonexistent directory", async () => {
    const result = await loadWorkspace(path.join(tmpDir, "nonexistent"));
    assert.equal(result.files.size, 0);
    assert.equal(result.tailContent, null);
    assert.equal(result.skills.listed.length, 0);
    assert.equal(result.skills.inlined.length, 0);
  });
});

describe("skills scanner", () => {
  it("discovers skills with valid frontmatter", async () => {
    const skillDir = path.join(tmpDir, "skills", "character-cards");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: character-cards
description: Create and manage character cards
---

# Character Cards

Full instructions here.`,
    );

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 1);
    assert.equal(index.inlined.length, 0);
    assert.equal(index.listed[0].name, "character-cards");
    assert.equal(index.listed[0].description, "Create and manage character cards");
    assert.equal(index.listed[0].path, "skills/character-cards/SKILL.md");
    assert.equal(index.listed[0].alwaysLoaded, false);
  });

  it("inlines always_loaded skills with their content", async () => {
    const skillDir = path.join(tmpDir, "skills", "core-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: core-skill
description: Always present skill
always_loaded: true
---

Always loaded content.`,
    );

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 0);
    assert.equal(index.inlined.length, 1);
    assert.equal(index.inlined[0].name, "core-skill");
    assert.equal(index.inlined[0].content, "Always loaded content.");
  });

  it("filters skills by name list", async () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const dir = path.join(tmpDir, "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n\nContent.`,
      );
    }

    const index = await scanSkills(tmpDir, ["alpha", "gamma"]);
    assert.equal(index.listed.length, 2);
    const names = index.listed.map((s) => s.name);
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("gamma"));
    assert.ok(!names.includes("beta"));
  });

  it("returns empty index for skills=none", async () => {
    const skillDir = path.join(tmpDir, "skills", "test");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: test\ndescription: test\n---\nContent.`,
    );

    const index = await scanSkills(tmpDir, "none");
    assert.equal(index.listed.length, 0);
    assert.equal(index.inlined.length, 0);
  });

  it("skips skills with missing required frontmatter", async () => {
    const skillDir = path.join(tmpDir, "skills", "broken");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: broken\n---\nNo description field.`,
    );

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 0);
  });

  it("skips directories without SKILL.md", async () => {
    const dir = path.join(tmpDir, "skills", "empty-dir");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "README.md"), "Not a skill.");

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 0);
  });
});

describe("system prompt rendering", () => {
  it("renders workspace files in canonical order with XML tags", () => {
    const workspace: WorkspaceContent = {
      files: new Map([
        ["SOUL.md", "I am Miku."],
        ["AGENTS.md", "Main instructions here."],
        ["TOOLS.md", "Tool notes."],
      ]),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace);

    // Check order: AGENTS.md first, then SOUL.md, then TOOLS.md
    const agentsIdx = prompt.indexOf("<agent_instructions");
    const soulIdx = prompt.indexOf("<soul");
    const toolsIdx = prompt.indexOf("<tools_guide");
    assert.ok(agentsIdx < soulIdx, "agent_instructions should come before soul");
    assert.ok(soulIdx < toolsIdx, "soul should come before tools_guide");

    // Check content
    assert.ok(prompt.includes('source="AGENTS.md"'));
    assert.ok(prompt.includes("Main instructions here."));
    assert.ok(prompt.includes('source="SOUL.md"'));
    assert.ok(prompt.includes("I am Miku."));
    assert.ok(prompt.includes('source="TOOLS.md"'));
    assert.ok(prompt.includes("Tool notes."));
  });

  it("uses fallback prompt when AGENTS.md is missing", () => {
    const workspace: WorkspaceContent = {
      files: new Map([["SOUL.md", "personality"]]),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace, "Fallback instructions");
    assert.ok(prompt.includes("Fallback instructions"));
    assert.ok(prompt.includes('source="AGENTS.md"'));
  });

  it("renders available skills index", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: {
        listed: [
          { name: "danbooru", description: "Search images", path: "skills/danbooru/SKILL.md", alwaysLoaded: false },
        ],
        inlined: [],
      },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes("<available_skills>"));
    assert.ok(prompt.includes('name="danbooru"'));
    assert.ok(prompt.includes('path="skills/danbooru/SKILL.md"'));
    assert.ok(prompt.includes("Search images"));
  });

  it("renders inlined skills before listed skills", () => {
    const workspace: WorkspaceContent = {
      files: new Map([["AGENTS.md", "instructions"]]),
      tailContent: null,
      skills: {
        listed: [
          { name: "listed-skill", description: "A listed skill", path: "skills/listed/SKILL.md", alwaysLoaded: false },
        ],
        inlined: [
          { name: "inlined-skill", description: "Always present", path: "skills/inlined/SKILL.md", alwaysLoaded: true, content: "Inlined content" },
        ],
      },
    };

    const prompt = renderSystemPrompt(workspace);
    const inlinedIdx = prompt.indexOf("<skill_instructions");
    const listedIdx = prompt.indexOf("<available_skills>");
    assert.ok(inlinedIdx > 0);
    assert.ok(listedIdx > 0);
    assert.ok(inlinedIdx < listedIdx, "inlined skills should come before available_skills");
    assert.ok(prompt.includes("Inlined content"));
  });

  it("returns empty string when no workspace files and no fallback", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.equal(prompt, "");
  });
});

describe("satellite block rendering", () => {
  it("renders runtime state with time and timeline", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace);
    assert.ok(satellite.includes("<runtime_state>"));
    assert.ok(satellite.includes("Current time: 2026-05-26T14:00:00.000Z"));
    assert.ok(satellite.includes("Current timeline: matrix:miku:room:!test:server.org"));
    assert.ok(satellite.includes("Trigger event: evt-1"));
    assert.ok(satellite.includes("</runtime_state>"));
  });

  it("renders active sessions in runtime state", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const input = makeRuntimeInput({
      activeSessions: [{
        id: "s-abc",
        createdAt: Date.parse("2026-05-26T13:59:00.000Z"),
        trigger: { event: { body: "test message" } },
      }],
    });

    const satellite = renderSatelliteBlock(input, workspace);
    assert.ok(satellite.includes('id="s-abc"'));
    assert.ok(satellite.includes('triggered_by="test message"'));
  });

  it("includes tail instructions when TAIL.md content exists", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: "Be concise. Use emoji sparingly.",
      skills: { listed: [], inlined: [] },
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace);
    assert.ok(satellite.includes("<tail_instructions"));
    assert.ok(satellite.includes('source="TAIL.md"'));
    assert.ok(satellite.includes("Be concise. Use emoji sparingly."));
  });

  it("omits tail_instructions when tailContent is null", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace);
    assert.ok(!satellite.includes("<tail_instructions"), "should not have tail_instructions");
  });

  it("includes session_instruction when session type specifies one", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const sessionType: SessionTypeConfig = {
      sessionInstruction: "Summarize the messages above.",
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace, sessionType);
    assert.ok(satellite.includes("<session_instruction>"));
    assert.ok(satellite.includes("Summarize the messages above."));
  });

  it("renders all three parts in correct order", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: "Tail content here.",
      skills: { listed: [], inlined: [] },
    };

    const sessionType: SessionTypeConfig = {
      sessionInstruction: "Session task here.",
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace, sessionType);

    const runtimeIdx = satellite.indexOf("<runtime_state>");
    const tailIdx = satellite.indexOf("<tail_instructions");
    const sessionIdx = satellite.indexOf("<session_instruction>");

    assert.ok(runtimeIdx < tailIdx, "runtime_state should come before tail_instructions");
    assert.ok(tailIdx < sessionIdx, "tail_instructions should come before session_instruction");
  });

  it("uses overridden tail file source attribute", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: "Custom tail.",
      skills: { listed: [], inlined: [] },
    };

    const sessionType: SessionTypeConfig = {
      tailFile: "TAIL_CUSTOM.md",
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace, sessionType);
    assert.ok(satellite.includes('source="TAIL_CUSTOM.md"'));
  });
});

describe("full integration: load workspace and render", () => {
  it("loads workspace files and renders complete system prompt", async () => {
    await writeFile(path.join(tmpDir, "AGENTS.md"), "You are Miku.\nFollow these instructions.");
    await writeFile(path.join(tmpDir, "SOUL.md"), "Cheerful and helpful.");

    const skillDir = path.join(tmpDir, "skills", "test-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: A test skill\n---\n\nSkill body.`,
    );

    const workspace = await loadWorkspace(tmpDir);
    const prompt = renderSystemPrompt(workspace);

    assert.ok(prompt.includes("You are Miku."));
    assert.ok(prompt.includes("Cheerful and helpful."));
    assert.ok(prompt.includes("<available_skills>"));
    assert.ok(prompt.includes("test-skill"));
  });

  it("loads workspace and renders satellite with tail + session instruction", async () => {
    await writeFile(path.join(tmpDir, "TAIL.md"), "Always check skills first.");

    const workspace = await loadWorkspace(tmpDir);
    const sessionType: SessionTypeConfig = {
      sessionInstruction: "Reply to the user.",
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace, sessionType);
    assert.ok(satellite.includes("<runtime_state>"));
    assert.ok(satellite.includes("Always check skills first."));
    assert.ok(satellite.includes("Reply to the user."));
  });
});
