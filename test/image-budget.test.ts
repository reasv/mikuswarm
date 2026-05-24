import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, unlink } from "node:fs/promises";
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
