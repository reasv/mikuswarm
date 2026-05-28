import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { processImageForInference } from "../src/media/index.js";

test("image processing honors configured pixel budget and byte limit", async () => {
  const width = 1024;
  const height = 1024;
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) {
    raw[index] = (index * 31 + Math.floor(index / 7)) % 256;
  }
  const input = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const tmpPath = join(tmpdir(), "image-budget-test.png");
  await writeFile(tmpPath, input);

  try {
    const result = await processImageForInference(tmpPath, {
      maxTotalPixels: 921_600,
      maxTotalPixelsHard: 1_843_200,
      minShortestSide: 480,
      maxBytes: 75_000,
    });

    const metadata = await sharp(result.path).metadata();
    assert.equal(result.sizeBytes <= 75_000, true, `sizeBytes ${result.sizeBytes} should be <= 75000`);
    assert.equal(metadata.format, "jpeg");
    assert.equal(result.mimeType, "image/jpeg");
    await unlink(result.path).catch(() => {});
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
});

test("captioning image pipeline does not load sibling files referenced by an SVG (msg-attach exfil regression)", async () => {
  // Regression for: when sharp received an SVG by file path, librsvg used the
  // SVG's directory as a base URI and the sibling rule allowed
  // <image xlink:href="other.png"/> to load another attachment in the same
  // msg-attach/ directory. The fix is to read the file into a buffer and pass
  // the buffer to sharp (no base URI → librsvg refuses every scheme except
  // data:). This test mirrors the `msg-attach/` layout and asserts the sibling
  // pixels do NOT appear in the processed JPEG.
  const attachDir = await mkdtemp(join(tmpdir(), "miku-msg-attach-"));
  try {
    // Build a 50x50 pure-red PNG as the victim's "other attachment".
    const victimPng = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
    const victimPath = join(attachDir, "victim.png");
    await writeFile(victimPath, victimPng);

    // Attacker SVG: pure-blue background with a 50x50 red region IF the
    // sibling load succeeds. Two reference styles, mirroring the read_image
    // regression test (xlink:href and plain href).
    const svgs = [
      `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="rgb(0,0,255)"/>
  <image x="0" y="0" width="50" height="50" xlink:href="victim.png"/>
</svg>`,
      `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" fill="rgb(0,0,255)"/>
  <image x="0" y="0" width="50" height="50" href="victim.png"/>
</svg>`,
    ];

    for (let idx = 0; idx < svgs.length; idx++) {
      const svgPath = join(attachDir, `attacker-${idx}.svg`);
      await writeFile(svgPath, svgs[idx], "utf8");

      const processed = await processImageForInference(svgPath, {
        maxTotalPixels: 921_600,
        maxTotalPixelsHard: 1_843_200,
        minShortestSide: 480,
        maxBytes: 75_000,
        mozjpeg: false,
      });

      try {
        // Decode the produced JPEG back to raw pixels and count near-red ones.
        // JPEG is lossy so we tolerate a small per-channel deviation; we look
        // for pixels that are red-dominant (R high, G low, B low).
        const raw = await sharp(processed.path).raw().toBuffer({ resolveWithObject: true });
        const { data, info } = raw;
        let redLeak = 0;
        for (let i = 0; i < data.length; i += info.channels) {
          if (data[i] >= 200 && data[i + 1] <= 60 && data[i + 2] <= 60) redLeak++;
        }
        assert.equal(
          redLeak,
          0,
          `SVG #${idx} leaked ${redLeak} near-red pixels into the captioning raster — sibling-file exfiltration has regressed; processImageForInference must use buffer-mode sharp`,
        );
      } finally {
        await unlink(processed.path).catch(() => {});
      }
    }
  } finally {
    await rm(attachDir, { recursive: true, force: true });
  }
});
