import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
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

test("mid-batch mismatch snippet shows original on-disk content, not post-edit state", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "batch-snippet.txt",
      file_text: "alpha\nbeta\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "batch-snippet.txt",
          edits: [
            { old_str: "alpha", new_str: "one" },
            { old_str: "missing", new_str: "two" },
          ],
        }),
      (err: Error) => {
        // The snippet must reflect the ORIGINAL file (still contains "alpha"),
        // not the in-memory state after edit 1 applied (which would contain "one").
        assert.match(err.message, /alpha/);
        assert.ok(!err.message.includes("one\nbeta"), "snippet should not contain post-edit-1 state");
        return true;
      },
    );
  });
});

test("mismatch snippet is replaced with a hint for large files", async () => {
  await withWorkspace(async (workspace) => {
    // Build a file well over the 800-char MISMATCH_HINT_LIMIT.
    const big = "x".repeat(2000);
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "big-mismatch.txt",
      file_text: big,
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "big-mismatch.txt",
          old_str: "nope",
          new_str: "replacement",
        }),
      (err: Error) => {
        assert.match(err.message, /\[file is 2000 chars; call view to inspect\]/);
        // Must not include an 800-char dump of the file.
        assert.ok(!err.message.includes("x".repeat(800)), "should not include a positional dump");
        return true;
      },
    );
  });
});

test("str_replace rejects passing both edits and old_str", async () => {
  await withWorkspace(async (workspace) => {
    await runTextEditorCommand(workspace, {
      command: "create",
      path: "both.txt",
      file_text: "alpha\n",
    });
    await assert.rejects(
      () =>
        runTextEditorCommand(workspace, {
          command: "str_replace",
          path: "both.txt",
          old_str: "alpha",
          new_str: "beta",
          edits: [{ old_str: "alpha", new_str: "gamma" }],
        }),
      /Pass either edits or old_str\/new_str, not both/,
    );
    // File must be unchanged.
    assert.equal(await readFile(path.join(workspace, "both.txt"), "utf8"), "alpha\n");
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

    // The hint must declare an exact line range. Numbered lines look like
    // "<n>: line <n>"; the budget is 50000 chars at the min clamp. We require:
    //   1. The hint references "Showing lines 1-<endLine>".
    //   2. <endLine> equals details.endLine (set to the last fully-visible line).
    //   3. <endLine> is strictly less than the file's line count (i.e. the
    //      hint does not overstate progress as the old off-by-one bug did).
    const hintMatch = result.text.match(/Showing lines (\d+)-(\d+)\. Use view_range to continue/);
    assert.ok(hintMatch, "expected exact line range in continuation hint");
    const hintStart = Number(hintMatch[1]);
    const hintEnd = Number(hintMatch[2]);
    assert.equal(hintStart, 1);
    assert.equal(hintEnd, result.details.endLine, "details.endLine must match hint last line");
    assert.ok(hintEnd < 5000, "hint must not claim to have shown the whole file");

    // The last visible line in the output must be exactly hintEnd — i.e. all
    // numbered lines through hintEnd appear in full, and hintEnd+1 does not.
    const expectedLastLine = `${hintEnd}: line ${hintEnd}`;
    assert.ok(result.text.includes(expectedLastLine), `expected last fully-visible line ${expectedLastLine}`);
    const overshootLine = `${hintEnd + 1}: line ${hintEnd + 1}`;
    assert.ok(!result.text.includes(overshootLine), `line ${hintEnd + 1} should not be fully visible`);
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

const TEST_MAX_IMAGE_BYTES = 3_932_160;

test("read_image returns image content block for valid image", async () => {
  await withWorkspace(async (workspace) => {
    // 1x1 red PNG
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(workspace, "test.png"), pngData);

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
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
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "notes.txt" }),
      /Unsupported image format/,
    );
  });
});

test("read_image rejects workspace escape", async () => {
  await withWorkspace(async (workspace) => {
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "../outside.png" }),
      /escapes workspace/,
    );
  });
});

test("read_image rejects files exceeding the configured size limit", async () => {
  await withWorkspace(async (workspace) => {
    // Use a small limit so the test stays fast and doesn't depend on the default value.
    const limit = 4096;
    const filePath = path.join(workspace, "huge.png");
    // Write a file one byte over the limit. The bytes don't need to be a valid PNG —
    // the size check runs before any decode.
    await writeFile(filePath, Buffer.alloc(limit + 1));

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: limit });
    await assert.rejects(
      () => tool.execute("t1", { path: "huge.png" }),
      /Image too large/,
    );
  });
});

test("read_image rejects non-regular files (e.g. directories)", async () => {
  await withWorkspace(async (workspace) => {
    // A directory named like an image file should be rejected by the isFile() check,
    // not read as if it were a regular file.
    await mkdir(path.join(workspace, "weird.png"));
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "weird.png" }),
      /Not a regular file/,
    );
  });
});

test("read_image rasterizes SVG to PNG", async () => {
  await withWorkspace(async (workspace) => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="red" />
  <circle cx="50" cy="50" r="30" fill="blue" />
</svg>
`;
    await writeFile(path.join(workspace, "vector.svg"), svg, "utf8");

    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    const result = await tool.execute("t1", { path: "vector.svg" });

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, "text");
    assert.match((result.content[0] as { text: string }).text, /image\/png/);
    assert.equal(result.content[1].type, "image");
    const img = result.content[1] as { type: "image"; data: string; mimeType: string };
    // SVG must be substituted for PNG — providers reject image/svg+xml.
    assert.equal(img.mimeType, "image/png");
    // Decoded payload should be a valid PNG (starts with the PNG magic bytes).
    const decoded = Buffer.from(img.data, "base64");
    assert.deepEqual(decoded.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

test("read_image surfaces a clean error for malformed SVG", async () => {
  await withWorkspace(async (workspace) => {
    // Sniffs as SVG (starts with "<svg") but is structurally invalid XML —
    // forces the rasterizer to throw and exercise the catch path in
    // rasterizeSvgToPng.
    await writeFile(path.join(workspace, "broken.svg"), "<svg this is not valid xml", "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "broken.svg" }),
      /Failed to rasterize SVG/,
    );
  });
});

test("read_image rejects files whose magic bytes don't match the extension", async () => {
  await withWorkspace(async (workspace) => {
    // JPEG magic bytes in a file named .png — providers would reject with an
    // opaque error; the tool should catch this up front.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    await writeFile(path.join(workspace, "mislabeled.png"), jpegBytes);
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "mislabeled.png" }),
      /does not match extension/,
    );
  });
});

test("read_image rejects files whose bytes don't sniff as any supported format", async () => {
  await withWorkspace(async (workspace) => {
    // Plain text bytes in a file named .png — neither JPEG, PNG, GIF, WebP, nor SVG.
    await writeFile(path.join(workspace, "junk.png"), "hello world, not an image", "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "junk.png" }),
      /Could not determine image format/,
    );
  });
});

test("read_image rejects SVGs whose rasterization would exceed the pixel budget", async () => {
  await withWorkspace(async (workspace) => {
    // Crafted SVG with a huge viewBox. At density=144 this would rasterize to
    // ~40000x40000 (~1.6 GP) — far past the 25 MP limitInputPixels budget; at
    // density=48 it would still be ~13000x13000 (~169 MP). All four densities
    // should hit the pixel cap and the fallback resize should also be refused.
    const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 20000" width="20000" height="20000"><rect width="20000" height="20000" fill="red"/></svg>`;
    await writeFile(path.join(workspace, "huge.svg"), svg, "utf8");
    const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
    await assert.rejects(
      () => tool.execute("t1", { path: "huge.svg" }),
      /too complex to rasterize/,
    );
  });
});

test("read_image rejects symlinks that escape the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-outside-img-"));
    try {
      // A real PNG sitting outside the workspace.
      const pngData = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        "base64",
      );
      const realPng = path.join(outside, "secret.png");
      await writeFile(realPng, pngData);
      // Symlink inside the workspace pointing to the outside file.
      await symlink(realPng, path.join(workspace, "linked.png"), "file");

      const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
      await assert.rejects(
        () => tool.execute("t1", { path: "linked.png" }),
        /escapes workspace/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("read_image SVG rasterization does not follow file:// references (regression for librsvg sandbox)", async () => {
  // sharp + bundled librsvg should refuse to load external resources from
  // buffer-mode SVGs (no base URI → only data: URIs allowed). If a future
  // sharp/libvips upgrade regresses this behavior, this test catches it.
  // We construct an SVG that, IF the reference were followed, would paint a
  // 50x50 red square in the upper-left corner of the raster from the canary
  // PNG. We then assert the raster's top-left pixels are NOT pure red.
  await withWorkspace(async (workspace) => {
    const canaryDir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-svg-canary-"));
    try {
      // Build a 50x50 pure-red PNG using sharp directly.
      const canaryPng = await sharp({
        create: { width: 50, height: 50, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
      }).png().toBuffer();
      const canaryPath = path.join(canaryDir, "canary.png");
      await writeFile(canaryPath, canaryPng);

      // Two SVGs, both attempting to embed the canary via different reference
      // styles. The host background is pure blue (0,0,255) — if librsvg's
      // sandbox holds, the entire output is blue. If it leaks, the upper-left
      // 50x50 region becomes red.
      const svgs = [
        // file:// scheme with xlink:href (classic XXE-style image ref).
        `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="rgb(0,0,255)"/>
  <image x="0" y="0" width="50" height="50" xlink:href="file://${canaryPath}"/>
</svg>`,
        // file:// scheme with plain href (SVG 2 style).
        `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="rgb(0,0,255)"/>
  <image x="0" y="0" width="50" height="50" href="file://${canaryPath}"/>
</svg>`,
      ];

      for (let idx = 0; idx < svgs.length; idx++) {
        const svgPath = path.join(workspace, `exfil-${idx}.svg`);
        await writeFile(svgPath, svgs[idx], "utf8");

        const tool = createReadImageTool({ workspaceRoot: workspace, maxImageBytes: TEST_MAX_IMAGE_BYTES });
        const result = await tool.execute("t1", { path: `exfil-${idx}.svg` });
        const img = result.content[1] as { type: "image"; data: string; mimeType: string };
        assert.equal(img.mimeType, "image/png");

        // Decode the rendered PNG back to raw pixels and count pure-red ones.
        // Even a partial leak would produce a meaningful count; a fully-blocked
        // load produces zero.
        const png = Buffer.from(img.data, "base64");
        const raw = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        let redPixels = 0;
        const { data, info } = raw;
        for (let i = 0; i < data.length; i += info.channels) {
          if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0) redPixels++;
        }
        assert.equal(
          redPixels,
          0,
          `SVG #${idx} leaked ${redPixels} red pixels — librsvg sandbox may have regressed; review and lock down before shipping`,
        );
      }
    } finally {
      await rm(canaryDir, { recursive: true, force: true });
    }
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
