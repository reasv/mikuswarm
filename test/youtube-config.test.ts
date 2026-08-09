/**
 * Tests for src/youtube/config.ts — config resolution and defaults.
 * Also covers the cross-field validation wired in src/app.ts for [youtube].
 * (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §9; Phase 1 §10)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveYouTubeConfig } from "../src/youtube/config.js";

// ---------------------------------------------------------------------------
// Default resolution (no raw config)
// ---------------------------------------------------------------------------

test("resolveYouTubeConfig: all defaults when raw is undefined", () => {
  const cfg = resolveYouTubeConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.ytDlpPath, "yt-dlp");
  assert.equal(cfg.maxDownloadBytes, 209_715_200);
  assert.equal(cfg.concurrency, 2);
  assert.equal(cfg.timeoutMs, 120_000);
  assert.equal(cfg.cookiesFile, undefined);

  assert.equal(cfg.enrichment.enabled, true);
  assert.equal(cfg.enrichment.enrichAll, false);
  assert.equal(cfg.enrichment.transcriptHeadChars, 1000);
  assert.equal(cfg.enrichment.thumbnail, true);

  assert.equal(cfg.tool.maxTotalChars, 32_768);
  assert.equal(cfg.tool.defaultMaxChars, 4_000);
  assert.equal(cfg.tool.maxCharsLimit, 16_000);
  assert.equal(cfg.tool.downloadMaxHeight, 720);
});

test("resolveYouTubeConfig: all defaults when raw is empty object", () => {
  const cfg = resolveYouTubeConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.ytDlpPath, "yt-dlp");
  assert.equal(cfg.enrichment.enabled, true);
  assert.equal(cfg.tool.maxTotalChars, 32_768);
});

// ---------------------------------------------------------------------------
// Top-level overrides
// ---------------------------------------------------------------------------

test("resolveYouTubeConfig: respects enabled = false", () => {
  const cfg = resolveYouTubeConfig({ enabled: false });
  assert.equal(cfg.enabled, false);
});

test("resolveYouTubeConfig: respects custom yt_dlp_path", () => {
  const cfg = resolveYouTubeConfig({ yt_dlp_path: "/usr/local/bin/yt-dlp" });
  assert.equal(cfg.ytDlpPath, "/usr/local/bin/yt-dlp");
});

test("resolveYouTubeConfig: respects custom concurrency", () => {
  const cfg = resolveYouTubeConfig({ concurrency: 5 });
  assert.equal(cfg.concurrency, 5);
});

test("resolveYouTubeConfig: respects cookies_file", () => {
  const cfg = resolveYouTubeConfig({ cookies_file: "/data/cookies.txt" });
  assert.equal(cfg.cookiesFile, "/data/cookies.txt");
});

// ---------------------------------------------------------------------------
// Enrichment sub-section overrides
// ---------------------------------------------------------------------------

test("resolveYouTubeConfig: enrichment.enabled = false respected", () => {
  const cfg = resolveYouTubeConfig({ enrichment: { enabled: false } });
  assert.equal(cfg.enrichment.enabled, false);
  // Other enrichment defaults still apply.
  assert.equal(cfg.enrichment.enrichAll, false);
  assert.equal(cfg.enrichment.thumbnail, true);
});

test("resolveYouTubeConfig: enrichment.enrich_all = true respected", () => {
  const cfg = resolveYouTubeConfig({ enrichment: { enrich_all: true } });
  assert.equal(cfg.enrichment.enrichAll, true);
});

test("resolveYouTubeConfig: enrichment.transcript_head_chars custom value", () => {
  const cfg = resolveYouTubeConfig({ enrichment: { transcript_head_chars: 500 } });
  assert.equal(cfg.enrichment.transcriptHeadChars, 500);
});

test("resolveYouTubeConfig: enrichment.thumbnail = false respected", () => {
  const cfg = resolveYouTubeConfig({ enrichment: { thumbnail: false } });
  assert.equal(cfg.enrichment.thumbnail, false);
});

// ---------------------------------------------------------------------------
// Tool sub-section overrides
// ---------------------------------------------------------------------------

test("resolveYouTubeConfig: tool.max_total_chars custom value", () => {
  const cfg = resolveYouTubeConfig({ tool: { max_total_chars: 65536 } });
  assert.equal(cfg.tool.maxTotalChars, 65536);
});

test("resolveYouTubeConfig: tool.default_max_chars custom value", () => {
  const cfg = resolveYouTubeConfig({ tool: { default_max_chars: 2000 } });
  assert.equal(cfg.tool.defaultMaxChars, 2000);
});

test("resolveYouTubeConfig: tool.max_chars_limit custom value", () => {
  const cfg = resolveYouTubeConfig({ tool: { max_chars_limit: 8000 } });
  assert.equal(cfg.tool.maxCharsLimit, 8000);
});

test("resolveYouTubeConfig: tool.download_max_height custom value", () => {
  const cfg = resolveYouTubeConfig({ tool: { download_max_height: 1080 } });
  assert.equal(cfg.tool.downloadMaxHeight, 1080);
});

// ---------------------------------------------------------------------------
// Cross-field validation (mirrors app.ts wiring)
//
// These tests replicate the checks in app.ts so that the validation logic is
// exercised in isolation without needing to spin up the full application.
// ---------------------------------------------------------------------------

/**
 * Run the same cross-field checks that app.ts performs after resolveYouTubeConfig.
 * Returns the error message thrown, or null if validation passes.
 */
function runCrossFieldValidation(raw: Parameters<typeof resolveYouTubeConfig>[0]): string | null {
  const ytCfg = resolveYouTubeConfig(raw);
  if (ytCfg.tool.defaultMaxChars > ytCfg.tool.maxCharsLimit) {
    return `youtube.tool: default_max_chars (${ytCfg.tool.defaultMaxChars}) must be <= max_chars_limit (${ytCfg.tool.maxCharsLimit})`;
  }
  if (ytCfg.tool.maxCharsLimit > ytCfg.tool.maxTotalChars) {
    return `youtube.tool: max_chars_limit (${ytCfg.tool.maxCharsLimit}) must be <= max_total_chars (${ytCfg.tool.maxTotalChars})`;
  }
  if (ytCfg.enrichment.enabled && !ytCfg.enabled) {
    return "youtube.enrichment.enabled = true requires youtube.enabled = true";
  }
  return null;
}

test("cross-field: valid defaults pass validation", () => {
  assert.equal(runCrossFieldValidation(undefined), null);
});

test("cross-field: default_max_chars > max_chars_limit fails", () => {
  const err = runCrossFieldValidation({
    tool: {
      default_max_chars: 20_000, // exceeds the 16000 default max_chars_limit
    },
  });
  assert.ok(err != null, "expected validation error");
  assert.ok(
    err.includes("default_max_chars") && err.includes("max_chars_limit"),
    `unexpected message: ${err}`,
  );
});

test("cross-field: max_chars_limit > max_total_chars fails", () => {
  const err = runCrossFieldValidation({
    tool: {
      max_chars_limit: 50_000, // exceeds the 32768 default max_total_chars
    },
  });
  assert.ok(err != null, "expected validation error");
  assert.ok(
    err.includes("max_chars_limit") && err.includes("max_total_chars"),
    `unexpected message: ${err}`,
  );
});

test("cross-field: enrichment.enabled=true with youtube.enabled=false fails", () => {
  const err = runCrossFieldValidation({
    enabled: false,
    enrichment: { enabled: true },
  });
  assert.ok(err != null, "expected validation error");
  assert.ok(
    err.includes("enrichment.enabled") && err.includes("youtube.enabled"),
    `unexpected message: ${err}`,
  );
});

test("cross-field: enrichment.enabled=false with youtube.enabled=false is valid", () => {
  const err = runCrossFieldValidation({
    enabled: false,
    enrichment: { enabled: false },
  });
  assert.equal(err, null);
});

test("cross-field: custom values within bounds pass validation", () => {
  const err = runCrossFieldValidation({
    tool: {
      max_total_chars: 65536,
      max_chars_limit: 32768,
      default_max_chars: 8192,
    },
  });
  assert.equal(err, null);
});

test("cross-field: equal boundary values pass (default_max_chars == max_chars_limit)", () => {
  const err = runCrossFieldValidation({
    tool: {
      max_total_chars: 32768,
      max_chars_limit: 8000,
      default_max_chars: 8000, // exactly equal — must pass
    },
  });
  assert.equal(err, null);
});
