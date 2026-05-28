import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import encodePngChunks from "png-chunks-encode";
import extractPngChunks from "png-chunks-extract";
import pngTextChunk from "png-chunk-text";
import {
  createSillyTavernCardCreateTool,
  createSillyTavernCardEditTool,
  createSillyTavernCardReadTool,
  type SillyTavernCardToolContext,
} from "../src/tools/sillytavern-card.js";
import { ConcurrencyLimitedFetchClient } from "../src/enrichment/fetch-client.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-sillytavern-"));
  try {
    await writeFile(path.join(workspace, ".keep"), "", "utf8");
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function buildContext(workspaceRoot: string): SillyTavernCardToolContext {
  return {
    workspaceRoot,
    // The fetch client is unused in path-based tests; we still construct one
    // for completeness so the tool factories receive a real instance.
    fetchClient: new ConcurrencyLimitedFetchClient({
      maxConcurrency: 1,
      timeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
    }),
    downloadSizeLimit: 1_000_000,
  };
}

async function buildBaseCardPng(workspaceRoot: string, relativePath = "base.png"): Promise<string> {
  // A minimum-viable card PNG: build a tiny PNG with sharp, then have the
  // create tool produce a real card PNG by reading it from the workspace.
  const seedPath = path.join(workspaceRoot, "seed.png");
  const seedBuffer = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await writeFile(seedPath, seedBuffer);

  const create = createSillyTavernCardCreateTool(buildContext(workspaceRoot));
  await create.execute("t-base", {
    imagePath: "seed.png",
    card: { name: "Base", description: "base card" },
    outputPath: relativePath,
    overwrite: true,
  });
  return path.join(workspaceRoot, relativePath);
}

// ---------------------------------------------------------------------------
// Issue #1 — resolveReadablePath traversal guard
// ---------------------------------------------------------------------------

test("sillytavern_card_read rejects absolute paths (workspace traversal guard)", async () => {
  await withWorkspace(async (workspace) => {
    const read = createSillyTavernCardReadTool(buildContext(workspace));
    await assert.rejects(
      () => read.execute("t1", { path: "/etc/passwd" }),
      /Output paths must be safe workspace-relative paths|Refusing to write outside the workspace/,
    );
  });
});

test("sillytavern_card_read rejects `..` traversal", async () => {
  await withWorkspace(async (workspace) => {
    const read = createSillyTavernCardReadTool(buildContext(workspace));
    await assert.rejects(
      () => read.execute("t1", { path: "../../etc/passwd" }),
      /Output paths must be safe workspace-relative paths|Refusing to write outside the workspace/,
    );
  });
});

test("sillytavern_card_read accepts normal workspace-relative paths", async () => {
  await withWorkspace(async (workspace) => {
    await buildBaseCardPng(workspace, "cards/base.png");
    const read = createSillyTavernCardReadTool(buildContext(workspace));
    const result = await read.execute("t1", { path: "cards/base.png" });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /SillyTavern Card Summary/);
  });
});

test("sillytavern_card_edit set_field_from_file rejects path traversal", async () => {
  await withWorkspace(async (workspace) => {
    await buildBaseCardPng(workspace, "base.png");
    const edit = createSillyTavernCardEditTool(buildContext(workspace));
    await assert.rejects(
      () =>
        edit.execute("t1", {
          path: "base.png",
          overwrite: true,
          operations: [
            {
              op: "set_field_from_file",
              field: "description",
              sourcePath: "/etc/passwd",
            },
          ],
        }),
      /Output paths must be safe workspace-relative paths|Refusing to write outside the workspace/,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #2 — imageUrl SSRF guard
// ---------------------------------------------------------------------------

test("sillytavern_card_create rejects SSRF-style imageUrl before fetch", async () => {
  await withWorkspace(async (workspace) => {
    const create = createSillyTavernCardCreateTool(buildContext(workspace));
    await assert.rejects(
      () =>
        create.execute("t1", {
          imageUrl: "http://127.0.0.1:80/avatar.png",
          card: { name: "Bad" },
          overwrite: true,
        }),
      /Local or private address is blocked|Local addresses are blocked/,
    );
  });
});

test("sillytavern_card_edit replace_image rejects SSRF-style URLs", async () => {
  await withWorkspace(async (workspace) => {
    await buildBaseCardPng(workspace, "base.png");
    const edit = createSillyTavernCardEditTool(buildContext(workspace));
    await assert.rejects(
      () =>
        edit.execute("t1", {
          path: "base.png",
          overwrite: true,
          operations: [
            {
              op: "replace_image",
              imageUrl: "http://169.254.169.254/latest/meta-data/",
            },
          ],
        }),
      /Local or private address is blocked/,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #3 — limitInputPixels on sharp() call
// ---------------------------------------------------------------------------

test("sillytavern_card_create rejects oversized SVG via imagePath (limitInputPixels enforced)", async () => {
  await withWorkspace(async (workspace) => {
    // Mirror the pattern used in workspace-tools.test.ts:845. A 20000x20000
    // SVG would rasterize past the 25 MP SVG_MAX_INPUT_PIXELS cap.
    const svg =
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 20000" width="20000" height="20000"><rect width="20000" height="20000" fill="red"/></svg>';
    await writeFile(path.join(workspace, "huge.svg"), svg, "utf8");
    const create = createSillyTavernCardCreateTool(buildContext(workspace));
    await assert.rejects(
      () =>
        create.execute("t1", {
          imagePath: "huge.svg",
          card: { name: "Huge" },
          overwrite: true,
        }),
      // sharp throws an "Input image exceeds pixel limit" style error.
      /pixel|exceed/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #4 — PNG chunk validator rejects oversized declared lengths
// ---------------------------------------------------------------------------

test("sillytavern_card_read rejects hostile PNG with 4 GiB declared chunk length", async () => {
  await withWorkspace(async (workspace) => {
    // Hand-craft a PNG: signature + a single chunk declaring length 0xFFFFFFFF.
    // png-chunks-extract would allocate 4 GiB for this; our validator must
    // refuse it before that happens.
    const hostile = Buffer.alloc(PNG_SIGNATURE.length + 12);
    PNG_SIGNATURE.copy(hostile, 0);
    // 4-byte length: 0xFFFFFFFF
    hostile.writeUInt32BE(0xffffffff, PNG_SIGNATURE.length);
    // 4-byte chunk name: "IHDR"
    hostile.write("IHDR", PNG_SIGNATURE.length + 4, "ascii");
    // Fake CRC (will never be reached because the validator rejects first).
    hostile.writeUInt32BE(0, PNG_SIGNATURE.length + 8);
    await writeFile(path.join(workspace, "hostile.png"), hostile);

    const read = createSillyTavernCardReadTool(buildContext(workspace));
    await assert.rejects(
      () => read.execute("t1", { path: "hostile.png" }),
      /Refusing to parse PNG with oversized chunk declaration/,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #12 — PNG decode tolerates malformed non-chara tEXt chunks
// ---------------------------------------------------------------------------

test("sillytavern_card_read tolerates malformed non-chara tEXt chunks", async () => {
  await withWorkspace(async (workspace) => {
    // Build a real card PNG, then splice an extra malformed tEXt chunk in
    // front of the `chara` chunk. Specifically: a tEXt chunk whose payload is
    // a single null byte (no keyword terminator + a stray null) — this will
    // cause png-chunk-text.decode to throw "Invalid NULL character found".
    const cardPngPath = await buildBaseCardPng(workspace, "base.png");
    const buffer = await import("node:fs/promises").then((m) => m.readFile(cardPngPath));
    const chunks = extractPngChunks(new Uint8Array(buffer));

    // Construct a malformed tEXt chunk. png-chunk-text.decode throws on a
    // 0x00 in the text portion; here we provide "name\0bad\0extra" which is
    // valid up to "name\0bad" but trips the "Invalid NULL character" path.
    const malformedData = Buffer.concat([
      Buffer.from("malformed", "ascii"),
      Buffer.from([0x00]),
      Buffer.from("body", "ascii"),
      Buffer.from([0x00]), // illegal extra null in the text section
      Buffer.from("trailing", "ascii"),
    ]);
    const malformedChunk = { name: "tEXt", data: new Uint8Array(malformedData) };

    // Sanity: confirm the decoder would actually reject our crafted chunk.
    assert.throws(() => pngTextChunk.decode(Buffer.from(malformedChunk.data)), /Invalid NULL character/);

    // Insert the malformed chunk just after IHDR so the file remains a valid
    // PNG structurally but contains an undecodable tEXt sibling.
    chunks.splice(1, 0, malformedChunk);
    const rebuilt = Buffer.from(encodePngChunks(chunks));
    await writeFile(path.join(workspace, "polluted.png"), rebuilt);

    const read = createSillyTavernCardReadTool(buildContext(workspace));
    const result = await read.execute("t1", { path: "polluted.png" });
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /SillyTavern Card Summary/);
    // Card "Base" has 4-char name and 9-char description ("base card"). If the
    // malformed sibling chunk had blocked the chara decode, the read would
    // have thrown instead of returning a summary.
    assert.match(text, /name: chars=4/);
    assert.match(text, /description: chars=9/);
    assert.equal(
      (result as { details: { summary: { fieldStats: { name: { present: boolean } } } } }).details.summary.fieldStats.name
        .present,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #13 — readTextInputFile size cap
// ---------------------------------------------------------------------------

test("sillytavern_card_edit set_field_from_file rejects files > 1 MiB", async () => {
  await withWorkspace(async (workspace) => {
    await buildBaseCardPng(workspace, "base.png");
    // 1 MiB + 1 byte; the implementation rejects anything over 1 MiB.
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
    await writeFile(path.join(workspace, "big.txt"), oversized);

    const edit = createSillyTavernCardEditTool(buildContext(workspace));
    await assert.rejects(
      () =>
        edit.execute("t1", {
          path: "base.png",
          overwrite: true,
          operations: [
            {
              op: "set_field_from_file",
              field: "description",
              sourcePath: "big.txt",
            },
          ],
        }),
      /exceeding the .*byte limit/,
    );
  });
});
