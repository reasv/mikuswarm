import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchMemoryTool, createWriteMemoryTool } from "../src/tools/memory.js";
import { runRipgrep, runTextEditorCommand } from "../src/tools/file.js";

test("text editor tool views, replaces, inserts, and creates within workspace", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "notes/example.md",
      file_text: "alpha\nbeta\n",
    });

    const view = await runTextEditorCommand(workspace, {
      command: "view",
      path: "notes/example.md",
      view_range: [1, -1],
    });
    assert.equal(view.text, "1: alpha\n2: beta\n3: ");

    await runTextEditorCommand(workspace, {
      command: "str_replace",
      path: "notes/example.md",
      old_str: "beta",
      new_str: "gamma",
    });
    await runTextEditorCommand(workspace, {
      command: "insert",
      path: "notes/example.md",
      insert_line: 1,
      insert_text: "inserted",
    });

    assert.equal(await readFile(path.join(workspace, "notes/example.md"), "utf8"), "alpha\ninserted\ngamma\n");
  });
});

test("text editor rejects ambiguous replacements and workspace escapes", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "ambiguous.txt",
      file_text: "same\nsame\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "ambiguous.txt",
          old_str: "same",
          new_str: "different",
        }),
      /more than once/,
    );
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "view",
          path: "../outside.txt",
        }),
      /escapes workspace/,
    );
  });
});

test("ripgrep search is scoped to the workspace", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "src/a.txt",
      file_text: "needle\n",
    });
    const result = await runRipgrep(workspace, {
      pattern: "needle",
      path: ".",
      max_results: 10,
    });

    assert.match(result.text, /src\/a\.txt:1:needle/);
    await assert.rejects(
      () =>
        runRipgrep(workspace, {
          pattern: "needle",
          path: "..",
        }),
      /escapes workspace/,
    );
  });
});

test("daily memory editor is forced to memory/YYYY-MM-DD.md and memory search uses ripgrep", async () => {
  await withWorkspace(async (workspace) => {
    const editor = createWriteMemoryTool({
      workspaceRoot: workspace,
      now: new Date("2026-05-22T12:00:00.000Z"),
    });
    assert.equal(editor.name, "write_memory");
    await editor.execute("tool-1", {
      command: "insert",
      insert_line: 1,
      insert_text: "- remembered fact",
    });

    const memoryPath = path.join(workspace, "memory/2026-05-22.md");
    assert.equal(await readFile(memoryPath, "utf8"), "# 2026-05-22 Daily Memory\n- remembered fact\n");

    const search = createSearchMemoryTool({ workspaceRoot: workspace });
    const result = await search.execute("tool-2", {
      pattern: "remembered",
    });
    assert.match(result.content[0]?.text ?? "", /memory\/2026-05-22\.md:2:- remembered fact/);
  });
});

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-workspace-"));
  try {
    await writeFile(path.join(workspace, ".keep"), "", "utf8");
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
