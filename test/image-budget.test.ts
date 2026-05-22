import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { encodeImageForContext } from "../src/context/builder.js";

test("context image encoding honors configured byte budget", async () => {
  const width = 1024;
  const height = 1024;
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) {
    raw[index] = (index * 31 + Math.floor(index / 7)) % 256;
  }
  const input = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();

  const encoded = await encodeImageForContext(input, {
    maxWidth: 1280,
    maxHeight: 720,
    maxBytes: 75_000,
  });

  assert.ok(encoded);
  const metadata = await sharp(encoded).metadata();
  assert.equal(encoded.byteLength <= 75_000, true);
  assert.equal(metadata.format, "jpeg");
  assert.equal((metadata.width ?? 0) <= 1280, true);
  assert.equal((metadata.height ?? 0) <= 720, true);
});
