import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSearchMemoryTool, createWriteMemoryTool } from "../src/tools/memory.js";
import { runRipgrep, runTextEditorCommand } from "../src/tools/file.js";
import { createReadImageTool } from "../src/tools/read-image.js";

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

test("workspace guard rejects symlink traversal outside workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(workspace, "linked-outside"), "dir");
      await mkdir(path.join(workspace, "safe"), { recursive: true });

      await assert.rejects(
        () =>
          runTextEditorCommand(workspace, {
            command: "view",
            path: "linked-outside/secret.txt",
          }),
        /escapes workspace/,
      );
      await assert.rejects(
        () =>
          runTextEditorCommand(workspace, {
            command: "create",
            path: "linked-outside/new.txt",
            file_text: "nope",
          }),
        /escapes workspace/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

test("str_replace includes file contents in mismatch error", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "hint.txt",
      file_text: "actual content here\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "hint.txt",
          old_str: "nonexistent text",
          new_str: "replacement",
        }),
      (err: Error) => {
        assert.match(err.message, /old_str was not found in hint\.txt/);
        assert.match(err.message, /actual content here/);
        return true;
      },
    );
  });
});

test("batch edits apply multiple replacements in one call", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "batch.txt",
      file_text: "alpha\nbeta\ngamma\n",
    });
    const result = await runTextEditorCommand(workspace, {
      command: "str_replace",
      path: "batch.txt",
      edits: [
        { old_str: "alpha", new_str: "one" },
        { old_str: "beta", new_str: "two" },
        { old_str: "gamma", new_str: "three" },
      ],
    });
    assert.equal(result.details.replacements, 3);
    assert.equal(await readFile(path.join(workspace, "batch.txt"), "utf8"), "one\ntwo\nthree\n");
  });
});

test("batch edits fail on first mismatch with edit index", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "batch-fail.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "batch-fail.txt",
          edits: [
            { old_str: "alpha", new_str: "one" },
            { old_str: "missing", new_str: "two" },
          ],
        }),
      /edit 2\/2/,
    );
    // First edit should not have been persisted since we fail atomically
    assert.equal(await readFile(path.join(workspace, "batch-fail.txt"), "utf8"), "alpha\nbeta\n");
  });
});

test("adaptive paging truncates large files with continuation hint", async () => {
  await withWorkspace(async (workspace) => {
    const bigContent = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "big.txt",
      file_text: bigContent,
    });
    // contextWindowTokens=10000 → budget = 10000*4*0.2 = 8000, clamped to min 50000
    const result = await runTextEditorCommand(
      workspace,
      { command: "view", path: "big.txt" },
      { contextWindowTokens: 10000 },
    );
    assert.match(result.text, /Use view_range to continue/);
    assert.equal(result.details.truncated, true);
  });
});

test("adaptive paging does not affect explicit view_range", async () => {
  await withWorkspace(async (workspace) => {
    const bigContent = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "big2.txt",
      file_text: bigContent,
    });
    const result = await runTextEditorCommand(
      workspace,
      { command: "view", path: "big2.txt", view_range: [1, 5] },
      { contextWindowTokens: 10000 },
    );
    assert.ok(!result.text.includes("Use view_range to continue"));
    assert.equal(result.details.truncated, false);
  });
});

test("read_image returns image content block for valid image", async () => {
  await withWorkspace(async (workspace) => {
    // 1x1 red PNG
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(workspace, "test.png"), pngData);

    const tool = createReadImageTool({ workspaceRoot: workspace });
    const result = await tool.execute("t1", { path: "test.png" });

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /image\/png/);
    assert.equal(result.content[1].type, "image");
    const img = result.content[1] as { type: "image"; data: string; mimeType: string };
    assert.equal(img.mimeType, "image/png");
    assert.ok(img.data.length > 0);
  });
});

test("read_image rejects non-image files", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "notes.txt"), "hello", "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace });
    await assert.rejects(
      () => tool.execute("t1", { path: "notes.txt" }),
      /Unsupported image format/,
    );
  });
});

test("read_image rejects workspace escape", async () => {
  await withWorkspace(async (workspace) => {
    const tool = createReadImageTool({ workspaceRoot: workspace });
    await assert.rejects(
      () => tool.execute("t1", { path: "../outside.png" }),
      /escapes workspace/,
    );
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
