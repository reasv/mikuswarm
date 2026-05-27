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

    const result = await loadWorkspace(tmpDir, { workspace_files: ["AGENTS.md"] });
    assert.equal(result.files.size, 1);
    assert.equal(result.files.has("AGENTS.md"), true);
    assert.equal(result.files.has("SOUL.md"), false);
  });

  it("suppresses tail when session type sets tail_file to null", async () => {
    await writeFile(path.join(tmpDir, "TAIL.md"), "tail content");

    const result = await loadWorkspace(tmpDir, { tail_file: null });
    assert.equal(result.tailContent, null);
  });

  it("loads alternate tail file when session type overrides tail_file", async () => {
    await writeFile(path.join(tmpDir, "TAIL.md"), "default tail");
    await writeFile(path.join(tmpDir, "TAIL_SUMMARIZE.md"), "summarize tail");

    const result = await loadWorkspace(tmpDir, { tail_file: "TAIL_SUMMARIZE.md" });
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
      session_instruction: "Summarize the messages above.",
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
      session_instruction: "Session task here.",
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
      tail_file: "TAIL_CUSTOM.md",
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
      session_instruction: "Reply to the user.",
    };

    const satellite = renderSatelliteBlock(makeRuntimeInput(), workspace, sessionType);
    assert.ok(satellite.includes("<runtime_state>"));
    assert.ok(satellite.includes("Always check skills first."));
    assert.ok(satellite.includes("Reply to the user."));
  });
});

// =============================================================================
// T1: Empty AGENTS.md file on disk with fallback prompt
// =============================================================================

describe("workspace loader — empty AGENTS.md fallback", () => {
  it("uses fallback prompt when AGENTS.md exists but is empty", async () => {
    await writeFile(path.join(tmpDir, "AGENTS.md"), "");
    await writeFile(path.join(tmpDir, "SOUL.md"), "personality");

    const workspace = await loadWorkspace(tmpDir);
    // Empty string is loaded into files map
    assert.equal(workspace.files.get("AGENTS.md"), "");

    // renderSystemPrompt should use fallback because empty string is falsy
    const prompt = renderSystemPrompt(workspace, "Fallback instructions for empty file");
    assert.ok(prompt.includes("Fallback instructions for empty file"),
      "fallback should be used when AGENTS.md is empty string");
    assert.ok(prompt.includes('source="AGENTS.md"'),
      "tag should still attribute source to AGENTS.md");
  });
});

// =============================================================================
// T2: SKILL.md with Windows \r\n line endings
// =============================================================================

describe("skills scanner — Windows line endings", () => {
  it("parses SKILL.md with \\r\\n line endings correctly", async () => {
    const skillDir = path.join(tmpDir, "skills", "crlf-skill");
    await mkdir(skillDir, { recursive: true });
    // Build content with \r\n line endings throughout
    const content = "---\r\nname: crlf-skill\r\ndescription: A skill with CRLF\r\n---\r\n\r\nBody with CRLF line endings.\r\nSecond line.";
    await writeFile(path.join(skillDir, "SKILL.md"), content);

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 1);
    const skill = index.listed[0];
    // Name should not have trailing \r
    assert.equal(skill.name, "crlf-skill");
    assert.ok(!skill.name.includes("\r"), "name should not contain \\r");
    // Description should not have trailing \r
    assert.equal(skill.description, "A skill with CRLF");
    assert.ok(!skill.description.includes("\r"), "description should not contain \\r");
    assert.equal(skill.path, "skills/crlf-skill/SKILL.md");
  });

  it("inlines always_loaded skill with \\r\\n line endings", async () => {
    const skillDir = path.join(tmpDir, "skills", "crlf-inlined");
    await mkdir(skillDir, { recursive: true });
    const content = "---\r\nname: crlf-inlined\r\ndescription: Inlined CRLF skill\r\nalways_loaded: true\r\n---\r\n\r\nInlined body content.";
    await writeFile(path.join(skillDir, "SKILL.md"), content);

    const index = await scanSkills(tmpDir);
    assert.equal(index.inlined.length, 1);
    const skill = index.inlined[0];
    assert.equal(skill.name, "crlf-inlined");
    assert.equal(skill.description, "Inlined CRLF skill");
    assert.ok(skill.content !== undefined, "content should be populated");
    // Content should not have leading \r\n artifacts
    assert.ok(!skill.content!.startsWith("\r"), "body should not start with \\r");
  });
});

// =============================================================================
// T3: Frontmatter description containing colons
// =============================================================================

describe("skills scanner — colons in description", () => {
  it("parses quoted description with colons correctly", async () => {
    const skillDir = path.join(tmpDir, "skills", "colon-quoted");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: colon-quoted\ndescription: "Value with: colons: inside"\n---\n\nBody.`,
    );

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 1);
    assert.equal(index.listed[0].description, "Value with: colons: inside");
  });

  it("parses unquoted description with colons correctly (first colon splits)", async () => {
    const skillDir = path.join(tmpDir, "skills", "colon-unquoted");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: colon-unquoted\ndescription: Value with: colons\n---\n\nBody.`,
    );

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 1);
    // First colon splits key from value; rest is part of value
    assert.equal(index.listed[0].description, "Value with: colons");
  });
});

// =============================================================================
// T4: Skill directory name differs from frontmatter name
// =============================================================================

describe("skills scanner — directory vs frontmatter name", () => {
  it("uses frontmatter name for skill name, directory name for path", async () => {
    const skillDir = path.join(tmpDir, "skills", "foo-dir");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: bar-skill\ndescription: Different name than directory\n---\n\nContent.`,
    );

    const index = await scanSkills(tmpDir);
    assert.equal(index.listed.length, 1);
    assert.equal(index.listed[0].name, "bar-skill");
    assert.equal(index.listed[0].path, "skills/foo-dir/SKILL.md");
  });
});

// =============================================================================
// T5: filenameToTag with unusual filenames (tested indirectly via renderSystemPrompt)
// =============================================================================

describe("system prompt rendering — filenameToTag edge cases", () => {
  it("converts custom filenames to valid XML tags", () => {
    const workspace: WorkspaceContent = {
      files: new Map([
        ["CUSTOM-NOTES.md", "Custom notes content."],
      ]),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes("<custom_notes"), "CUSTOM-NOTES.md should produce tag 'custom_notes'");
    assert.ok(prompt.includes("</custom_notes>"));
    assert.ok(prompt.includes('source="CUSTOM-NOTES.md"'));
    assert.ok(prompt.includes("Custom notes content."));
  });

  it("prefixes digit-leading filenames with ws_", () => {
    const workspace: WorkspaceContent = {
      files: new Map([
        ["404.md", "Not found content."],
      ]),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes("<ws_404"), "404.md should produce tag 'ws_404'");
    assert.ok(prompt.includes("</ws_404>"));
    assert.ok(prompt.includes('source="404.md"'));
  });

  it("uses ws_unknown for filenames that reduce to empty after stripping", () => {
    const workspace: WorkspaceContent = {
      files: new Map([
        ["__.md", "Underscores only content."],
      ]),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes("<ws_unknown"), "__.md should produce tag 'ws_unknown'");
    assert.ok(prompt.includes("</ws_unknown>"));
    assert.ok(prompt.includes('source="__.md"'));
  });
});

// =============================================================================
// T6: XML attribute escaping with special characters
// =============================================================================

describe("system prompt rendering — XML attribute escaping", () => {
  it("escapes special characters in workspace file source attributes", () => {
    const workspace: WorkspaceContent = {
      files: new Map([
        ['FILE"WITH<SPECIAL>&CHARS.md', "Content with special filename."],
      ]),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes('source="FILE&quot;WITH&lt;SPECIAL&gt;&amp;CHARS.md"'),
      "special chars in filename should be escaped in source attribute");
    assert.ok(prompt.includes("Content with special filename."));
  });

  it("escapes special characters in skill name and description attributes", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: {
        listed: [
          {
            name: 'skill"with<special>',
            description: "A skill with <tags> & \"quotes\"",
            path: "skills/test/SKILL.md",
            alwaysLoaded: false,
          },
        ],
        inlined: [],
      },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes('name="skill&quot;with&lt;special&gt;"'),
      "skill name with special chars should be escaped");
    // Description is element content — the shared escapeXml escapes all 5 XML
    // special characters including quotes, which is safe for element content too.
    assert.ok(prompt.includes("A skill with &lt;tags&gt; &amp; &quot;quotes&quot;"),
      "skill description should escape XML entities in element content");
  });

  it("escapes special characters in inlined skill attributes", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: {
        listed: [],
        inlined: [
          {
            name: 'inline"skill',
            description: "test",
            path: 'skills/a&b/SKILL.md',
            alwaysLoaded: true,
            content: "Inlined content.",
          },
        ],
      },
    };

    const prompt = renderSystemPrompt(workspace);
    assert.ok(prompt.includes('name="inline&quot;skill"'),
      "inlined skill name should be escaped");
    assert.ok(prompt.includes('source="skills/a&amp;b/SKILL.md"'),
      "inlined skill path should be escaped");
  });
});

// =============================================================================
// T7: Trigger body truncation at 160 characters
// =============================================================================

describe("satellite block rendering — trigger body truncation", () => {
  it("truncates trigger body to 160 characters in active sessions", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const longBody = "A".repeat(200);
    const input = makeRuntimeInput({
      activeSessions: [{
        id: "s-trunc",
        createdAt: Date.parse("2026-05-26T13:00:00.000Z"),
        trigger: { event: { body: longBody } },
      }],
    });

    const satellite = renderSatelliteBlock(input, workspace);
    assert.ok(satellite.includes('id="s-trunc"'));

    // The triggered_by attribute should contain at most 160 chars of the body
    const truncated = "A".repeat(160);
    assert.ok(satellite.includes(`triggered_by="${truncated}"`),
      "triggered_by should be truncated to 160 characters");
    // Should NOT contain the full 200-char body
    assert.ok(!satellite.includes(`triggered_by="${longBody}"`),
      "triggered_by should not contain the full 200-char body");
  });

  it("does not truncate trigger body at or under 160 characters", () => {
    const workspace: WorkspaceContent = {
      files: new Map(),
      tailContent: null,
      skills: { listed: [], inlined: [] },
    };

    const exactBody = "B".repeat(160);
    const input = makeRuntimeInput({
      activeSessions: [{
        id: "s-exact",
        createdAt: Date.parse("2026-05-26T13:00:00.000Z"),
        trigger: { event: { body: exactBody } },
      }],
    });

    const satellite = renderSatelliteBlock(input, workspace);
    assert.ok(satellite.includes(`triggered_by="${exactBody}"`),
      "160-char body should not be truncated");
  });
});

// =============================================================================
// T8: Path traversal attempt blocked in workspace_files
// =============================================================================

describe("workspace loader — path traversal protection", () => {
  it("blocks workspace_files with path traversal", async () => {
    await writeFile(path.join(tmpDir, "AGENTS.md"), "legit content");

    // Create a file at a path that traversal would reach
    const parentFile = path.join(tmpDir, "..", "traversal-target.md");
    let parentFileCreated = false;
    try {
      await writeFile(parentFile, "SECRET CONTENT");
      parentFileCreated = true;
    } catch {
      // If we can't write there, we still test that loadWorkspace doesn't error
    }

    try {
      const result = await loadWorkspace(tmpDir, {
        workspace_files: ["AGENTS.md", "../../traversal-target.md"],
      });

      // AGENTS.md should be loaded normally
      assert.ok(result.files.has("AGENTS.md"), "legitimate file should load");
      assert.equal(result.files.get("AGENTS.md"), "legit content");

      // Traversal path should NOT be loaded
      assert.ok(!result.files.has("../../traversal-target.md"),
        "traversal path should not be loaded");
      assert.ok(!result.files.has("traversal-target.md"),
        "traversal target should not appear under any key");

      // Verify no file content from the traversal target leaked
      for (const [, content] of result.files) {
        assert.ok(!content.includes("SECRET CONTENT"),
          "traversal target content should not appear in any loaded file");
      }
    } finally {
      // Clean up the parent file we created
      if (parentFileCreated) {
        await rm(parentFile, { force: true });
      }
    }
  });

  it("blocks tail_file with path traversal", async () => {
    const result = await loadWorkspace(tmpDir, {
      tail_file: "../../../etc/passwd",
    });
    assert.equal(result.tailContent, null,
      "tail content should be null when path traversal is blocked");
  });
});
