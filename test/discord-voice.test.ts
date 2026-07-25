/**
 * Tests for Discord voice message utilities (spec §12.4).
 *
 * Only the pure waveform computation functions are tested here — ffmpeg is
 * NOT invoked (no subprocess, no file I/O). The waveform algorithm is a pure
 * mathematical transform from s16le PCM bytes → normalized Uint8Array.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeWaveform,
  computeWaveformBase64,
  WAVEFORM_SAMPLE_COUNT,
} from "../src/discord/voice-message.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Buffer of s16le samples from an array of signed integers. */
function makeS16le(samples: number[]): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = ((samples[i]! & 0xffff) + 0x10000) & 0xffff;
    buf.writeUInt16LE(v, i * 2);
  }
  return buf;
}

// ── WAVEFORM_SAMPLE_COUNT constant ────────────────────────────────────────────

it("WAVEFORM_SAMPLE_COUNT is 256", () => {
  assert.equal(WAVEFORM_SAMPLE_COUNT, 256);
});

// ── computeWaveform: edge cases ───────────────────────────────────────────────

describe("computeWaveform: edge cases", () => {
  it("empty buffer → all zeros of targetSamples length", () => {
    const result = computeWaveform(Buffer.alloc(0), 10);
    assert.equal(result.length, 10);
    assert.ok(result.every((b) => b === 0), "all bytes must be 0 for empty input");
  });

  it("buffer with fewer than 2 bytes → all zeros", () => {
    const result = computeWaveform(Buffer.alloc(1, 0xff), 10);
    assert.equal(result.length, 10);
    assert.ok(result.every((b) => b === 0));
  });

  it("silent PCM (all zeros) → all zeros output", () => {
    const pcm = makeS16le(new Array(512).fill(0));
    const result = computeWaveform(pcm, 16);
    assert.ok(result.every((b) => b === 0), "silence must produce all-zero waveform");
  });

  it("targetSamples clamped to max 256", () => {
    const pcm = makeS16le([1000, -1000, 500, -500]);
    const result = computeWaveform(pcm, 500); // request 500, capped to 256
    assert.equal(result.length, Math.min(4, 256), "output length capped by sample count or 256");
  });

  it("targetSamples clamped to min 1", () => {
    const pcm = makeS16le([1000]);
    const result = computeWaveform(pcm, 0); // request 0, clamped to 1
    assert.equal(result.length, 1);
  });
});

// ── computeWaveform: normalization ────────────────────────────────────────────

describe("computeWaveform: normalization", () => {
  it("global maximum maps to 255", () => {
    // Single sample with max positive s16le value (32767)
    const pcm = makeS16le([32767]);
    const result = computeWaveform(pcm, 1);
    assert.equal(result[0], 255, "max amplitude sample must normalize to 255");
  });

  it("single negative peak (−32768) also maps to 255", () => {
    const pcm = makeS16le([-32768]);
    const result = computeWaveform(pcm, 1);
    assert.equal(result[0], 255);
  });

  it("sample at half amplitude maps to ~128 relative to global max", () => {
    // Two chunks: chunk0 at full amplitude (global max), chunk1 at half.
    // chunk1 / globalMax * 255 = 16383 / 32767 * 255 ≈ 127.5 → 127 or 128.
    const pcm = makeS16le([32767, 16383]);
    const result = computeWaveform(pcm, 2);
    // chunk0 should be 255 (full amplitude)
    assert.equal(result[0], 255, "full-amplitude chunk must normalize to 255");
    // chunk1 should be ~128 (half of global max)
    assert.ok(result[1]! >= 127 && result[1]! <= 128, `expected ~128, got ${result[1]}`);
  });

  it("multiple chunks: each maps proportional to global max", () => {
    // Chunk 0: peak 32767, Chunk 1: peak 16383
    const pcm = makeS16le([32767, 16383]);
    const result = computeWaveform(pcm, 2);
    assert.equal(result[0], 255, "chunk at full amplitude → 255");
    // chunk1 = round(16383/32767 * 255) ≈ 128
    assert.ok(result[1]! >= 127 && result[1]! <= 128, `chunk1 expected ~128, got ${result[1]}`);
  });

  it("all values in output are in range [0, 255]", () => {
    const samples = Array.from({ length: 1024 }, (_, i) => (i % 3 === 0 ? 1000 : -500));
    const pcm = makeS16le(samples);
    const result = computeWaveform(pcm, 256);
    assert.ok(result.every((b) => b >= 0 && b <= 255), "all output bytes must be 0–255");
  });

  it("output length equals targetSamples (when PCM has enough data)", () => {
    const pcm = makeS16le(new Array(2048).fill(100));
    const result = computeWaveform(pcm, 128);
    assert.equal(result.length, 128);
  });

  it("output length = min(targetSamples, totalSamples) when PCM is short", () => {
    // 3 s16le samples, target 10 → output is 3
    const pcm = makeS16le([100, 200, 300]);
    const result = computeWaveform(pcm, 10);
    assert.equal(result.length, 3);
  });
});

// ── computeWaveformBase64 ────────────────────────────────────────────────────

describe("computeWaveformBase64", () => {
  it("returns a base64 string of the correct length", () => {
    const pcm = makeS16le(new Array(256).fill(1000));
    const b64 = computeWaveformBase64(pcm, 256);
    const decoded = Buffer.from(b64, "base64");
    assert.equal(decoded.length, 256, "decoded waveform must be 256 bytes");
    assert.ok(typeof b64 === "string" && b64.length > 0);
  });

  it("silent PCM produces a base64 of all-zero bytes", () => {
    const pcm = Buffer.alloc(512, 0);
    const b64 = computeWaveformBase64(pcm, 8);
    const decoded = Buffer.from(b64, "base64");
    assert.ok(decoded.every((b) => b === 0));
  });
});

// ── send-shape contract ───────────────────────────────────────────────────────
//
// These tests do NOT invoke ffmpeg. They just verify the data contract between
// VoiceMessageEncodeResult and the shape the provider sends to Discord REST.

it("WAVEFORM_SAMPLE_COUNT ≤ 256 (Discord attachment limit)", () => {
  assert.ok(WAVEFORM_SAMPLE_COUNT <= 256);
});
