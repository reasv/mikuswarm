/**
 * Tests for src/youtube/ytdlp.ts — yt-dlp wrapper.
 * (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §2; Phase 1 §10)
 *
 * All tests mock the subprocess layer — no real yt-dlp is invoked.
 *
 * Strategy: configureYtDlp accepts any ytDlpPath; we point it at a small
 * Node.js script (inline shebang via node -e) that echoes a fixture stdout,
 * exits with a given code, or writes to a temp directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureYtDlp,
  resetYtDlpConfig,
  probe,
  transcript,
  download,
  probeYtDlpBinary,
  foldJson3Transcript,
  type YouTubeProbeMetadata,
} from "../src/youtube/ytdlp.js";

// ---------------------------------------------------------------------------
// Helpers: tiny fake yt-dlp scripts written into a temp dir per test
// ---------------------------------------------------------------------------

async function makeFakeYtDlp(tmpDir: string, script: string): Promise<string> {
  const scriptPath = join(tmpDir, "yt-dlp");
  // Write a Node.js shebang script.
  const src = `#!/usr/bin/env node\n${script}\n`;
  await writeFile(scriptPath, src, { mode: 0o755 });
  return scriptPath;
}

// Build a JSON fixture that mimics yt-dlp --dump-json output.
function buildDumpJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    id: "dQw4w9WgXcY",
    title: "Never Gonna Give You Up",
    channel: "Rick Astley",
    channel_id: "UCuAXFkgsw1L7xaCfnd5JJOw",
    duration: 213,
    upload_date: "20091024",
    view_count: 1_500_000_000,
    like_count: 15_000_000,
    description: "The official video for Never Gonna Give You Up by Rick Astley.",
    chapters: [
      { title: "Intro", start_time: 0, end_time: 18 },
      { title: "Verse 1", start_time: 18, end_time: 90 },
    ],
    subtitles: { en: [{ ext: "json3" }] },
    automatic_captions: { "en-orig": [{ ext: "json3" }], ja: [{ ext: "json3" }] },
    is_live: false,
    live_status: "not_live",
    age_limit: 0,
    thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcY/maxresdefault.jpg",
  };
  return JSON.stringify({ ...base, ...overrides });
}

// Minimal json3 fixture.
const JSON3_FIXTURE = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "Never gonna give you up" }] },
    { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: " Never gonna let you down" }] },
    { tStartMs: 31000, dDurationMs: 3000, segs: [{ utf8: "Never gonna run around" }] },
    { tStartMs: 62000, dDurationMs: 3000, segs: [{ utf8: "and desert you" }] },
  ],
});

// ---------------------------------------------------------------------------
// foldJson3Transcript (pure function — no subprocess)
// ---------------------------------------------------------------------------

test("foldJson3Transcript: empty events returns empty string", () => {
  assert.equal(foldJson3Transcript({ events: [] }), "");
  assert.equal(foldJson3Transcript({}), "");
});

test("foldJson3Transcript: inserts [0:00] marker at start", () => {
  const text = foldJson3Transcript({
    events: [{ tStartMs: 0, segs: [{ utf8: "Hello world" }] }],
  });
  assert.ok(text.includes("[0:00]"), `expected [0:00] in: ${text}`);
  assert.ok(text.includes("Hello world"));
});

test("foldJson3Transcript: inserts timestamp markers every ~30s", () => {
  const text = foldJson3Transcript(JSON.parse(JSON3_FIXTURE));
  assert.ok(text.includes("[0:00]"), "start marker");
  assert.ok(text.includes("[0:31]"), "30s marker");
  assert.ok(text.includes("[1:02]"), "60s marker");
  assert.ok(text.includes("Never gonna give you up"), "text present");
});

test("foldJson3Transcript: skips events with no text segments", () => {
  const text = foldJson3Transcript({
    events: [
      { tStartMs: 0, segs: [{ utf8: "" }] },
      { tStartMs: 1000, segs: [{ utf8: "hello" }] },
    ],
  });
  assert.ok(text.includes("hello"));
  // Should have exactly one [0:00] marker (the blank event is skipped, but
  // hello shares the same <30s window so no second marker).
  const markers = text.match(/\[\d+:\d{2}\]/g) ?? [];
  assert.equal(markers.length, 1);
});

test("foldJson3Transcript: normalizes newlines in segment text", () => {
  const text = foldJson3Transcript({
    events: [{ tStartMs: 0, segs: [{ utf8: "line one\nline two" }] }],
  });
  assert.ok(!text.includes("\n\n"));
  assert.ok(text.includes("line one line two"));
});

test("foldJson3Transcript: mm:ss padding — 1:05 not 1:5", () => {
  const text = foldJson3Transcript({
    events: [
      { tStartMs: 0, segs: [{ utf8: "A" }] },
      { tStartMs: 65000, segs: [{ utf8: "B" }] },
    ],
  });
  assert.ok(text.includes("[1:05]"), `got: ${text}`);
});

// ---------------------------------------------------------------------------
// probe() — argument construction + response parsing
// ---------------------------------------------------------------------------

test("probe: passes --dump-json --skip-download --no-playlist and the video URL", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    // Capture the args to a temp file, then echo dump-json fixture.
    const argsFile = join(tmpDir, "args.json");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(buildDumpJson())});
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    const meta = await probe("dQw4w9WgXcY");
    assert.equal(meta.id, "dQw4w9WgXcY");
    assert.equal(meta.title, "Never Gonna Give You Up");
    assert.equal(meta.channel, "Rick Astley");
    assert.equal(meta.duration, 213);
    assert.equal(meta.chapters.length, 2);
    assert.equal(meta.chapters[0].title, "Intro");

    // Verify subtitle track list.
    const manuals = meta.subtitleTracks.filter((t) => !t.auto);
    const autos = meta.subtitleTracks.filter((t) => t.auto);
    assert.ok(manuals.some((t) => t.lang === "en"), "en manual track present");
    assert.ok(autos.some((t) => t.lang === "ja"), "ja auto track present");

    // Verify args.
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    assert.ok(args.includes("--dump-json"), "has --dump-json");
    assert.ok(args.includes("--skip-download"), "has --skip-download");
    assert.ok(args.includes("--no-playlist"), "has --no-playlist");
    assert.ok(
      args.includes("https://www.youtube.com/watch?v=dQw4w9WgXcY"),
      "has video URL",
    );
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("probe: proxy flag passed when httpProxyUrl is set", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(buildDumpJson())});
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({
      ytDlpPath: bin,
      timeoutMs: 5000,
      httpProxyUrl: "http://proxy.example:3128",
    });

    await probe("dQw4w9WgXcY");

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    const proxyIdx = args.indexOf("--proxy");
    assert.ok(proxyIdx >= 0, "--proxy flag present");
    assert.equal(args[proxyIdx + 1], "http://proxy.example:3128");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("probe: cookies flag passed when cookiesFile is set", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(buildDumpJson())});
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000, cookiesFile: "/tmp/cookies.txt" });

    await probe("dQw4w9WgXcY");

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    const idx = args.indexOf("--cookies");
    assert.ok(idx >= 0, "--cookies flag present");
    assert.equal(args[idx + 1], "/tmp/cookies.txt");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("probe: throws on non-zero exit and includes bounded stderr", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const script = `
process.stderr.write("ERROR: Video unavailable: This video is private.");
process.exit(1);
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    await assert.rejects(
      () => probe("privateVideo11"),
      (err: Error) => {
        assert.ok(err.message.includes("Video unavailable"), `unexpected: ${err.message}`);
        return true;
      },
    );
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("probe: throws on timeout and includes timeout message", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    // Script that sleeps forever.
    const script = `setTimeout(() => {}, 60000);`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 200 }); // 200ms timeout

    await assert.rejects(
      () => probe("dQw4w9WgXcY"),
      (err: Error) => {
        assert.ok(err.message.includes("timed out"), `unexpected: ${err.message}`);
        return true;
      },
    );
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("probe: tolerates missing optional fields", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const minimal = JSON.stringify({ id: "dQw4w9WgXcY" });
    const script = `process.stdout.write(${JSON.stringify(minimal)});`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    const meta = await probe("dQw4w9WgXcY");
    assert.equal(meta.id, "dQw4w9WgXcY");
    assert.equal(meta.title, undefined);
    assert.deepEqual(meta.chapters, []);
    assert.deepEqual(meta.subtitleTracks, []);
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// download() — argument construction
// ---------------------------------------------------------------------------

test("download: video download args (no segment, no maxHeight)", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const outPath = join(tmpDir, "out.mp4");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
// Create a fake output file so download() can resolve.
fs.writeFileSync(${JSON.stringify(outPath)}, "fake");
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000, maxDownloadBytes: 50_000_000 });

    await download("dQw4w9WgXcY", { outPath });

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    assert.ok(args.includes("--no-playlist"), "no-playlist");
    assert.ok(args.includes("--max-filesize"), "--max-filesize present");
    assert.equal(args[args.indexOf("--max-filesize") + 1], "50000000");
    assert.ok(args.includes("-o"), "-o present");
    assert.equal(args[args.indexOf("-o") + 1], outPath);
    assert.ok(
      args.includes("https://www.youtube.com/watch?v=dQw4w9WgXcY"),
      "video URL",
    );
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("download: audioOnly uses ba format + m4a conversion", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const outPath = join(tmpDir, "out.m4a");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(outPath)}, "fake");
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    await download("dQw4w9WgXcY", { audioOnly: true, outPath });

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    assert.ok(args.includes("-f"), "-f present");
    assert.equal(args[args.indexOf("-f") + 1], "ba");
    assert.ok(args.includes("-x"), "-x present");
    assert.ok(args.includes("--audio-format"), "--audio-format present");
    assert.equal(args[args.indexOf("--audio-format") + 1], "m4a");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("download: maxHeight sets format selection with height constraint", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const outPath = join(tmpDir, "out.mp4");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(outPath)}, "fake");
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    await download("dQw4w9WgXcY", { maxHeight: 480, outPath });

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    const fIdx = args.indexOf("-f");
    assert.ok(fIdx >= 0);
    assert.ok(args[fIdx + 1].includes("480"), "height 480 in format string");
    assert.ok(args.includes("--merge-output-format"), "--merge-output-format present");
    assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("download: startSec+durationSec uses --download-sections", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const outPath = join(tmpDir, "out.mp4");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(outPath)}, "fake");
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    await download("dQw4w9WgXcY", { startSec: 30, durationSec: 120, outPath });

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    const dsIdx = args.indexOf("--download-sections");
    assert.ok(dsIdx >= 0, "--download-sections present");
    assert.equal(args[dsIdx + 1], "*30-150");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("download: startSec without duration uses open-ended section", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    const outPath = join(tmpDir, "out.mp4");
    const script = `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(outPath)}, "fake");
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    await download("dQw4w9WgXcY", { startSec: 60, outPath });

    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    const dsIdx = args.indexOf("--download-sections");
    assert.ok(dsIdx >= 0, "--download-sections present");
    assert.equal(args[dsIdx + 1], "*60-inf");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// transcript() — track selection and json3 parsing
// ---------------------------------------------------------------------------

test("transcript: returns none when no subtitle tracks available", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    // Probe returns metadata with no subtitle tracks.
    const metaWithNoSubs: YouTubeProbeMetadata = {
      id: "dQw4w9WgXcY",
      chapters: [],
      subtitleTracks: [],
    };

    // We pass meta directly to transcript() so no subprocess is needed.
    const result = await transcript("dQw4w9WgXcY", undefined, metaWithNoSubs);
    assert.equal(result.kind, "none");
    assert.equal(result.text, "");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("transcript: prefers manual track over auto-generated", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const argsFile = join(tmpDir, "args.json");
    // Script that writes a json3 file and captures args.
    const script = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
// Find -o arg to get output dir.
const oIdx = args.indexOf('-o');
if (oIdx >= 0) {
  const tmpl = args[oIdx + 1]; // e.g. /tmp/.../%(id)s.%(ext)s
  const outDir = path.dirname(tmpl);
  // Write a fake json3 subtitle file (manual, 'en' lang).
  fs.writeFileSync(path.join(outDir, 'dQw4w9WgXcY.en.json3'), ${JSON.stringify(JSON3_FIXTURE)});
}
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    const metaWithBoth: YouTubeProbeMetadata = {
      id: "dQw4w9WgXcY",
      chapters: [],
      subtitleTracks: [
        { lang: "en", auto: false },
        { lang: "en", auto: true },
      ],
    };

    const result = await transcript("dQw4w9WgXcY", undefined, metaWithBoth);
    assert.equal(result.kind, "manual");
    assert.equal(result.lang, "en");
    assert.ok(result.text.includes("Never gonna give you up"));

    // Verify --sub-langs was set to the selected track's lang.
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    const subLangsIdx = args.indexOf("--sub-langs");
    assert.ok(subLangsIdx >= 0, "--sub-langs present");
    assert.equal(args[subLangsIdx + 1], "en");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("transcript: falls back to auto when no manual track", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const script = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const oIdx = args.indexOf('-o');
if (oIdx >= 0) {
  const tmpl = args[oIdx + 1];
  const outDir = path.dirname(tmpl);
  fs.writeFileSync(path.join(outDir, 'dQw4w9WgXcY.en.json3'), ${JSON.stringify(JSON3_FIXTURE)});
}
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    const metaAutoOnly: YouTubeProbeMetadata = {
      id: "dQw4w9WgXcY",
      chapters: [],
      subtitleTracks: [{ lang: "en", auto: true }],
    };

    const result = await transcript("dQw4w9WgXcY", undefined, metaAutoOnly);
    assert.equal(result.kind, "auto");
    assert.equal(result.lang, "en");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("transcript: returns none when yt-dlp fails to write subtitle file", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    // Script exits 0 but does not write any json3 file.
    const script = `/* no-op */`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });

    const metaWithSub: YouTubeProbeMetadata = {
      id: "dQw4w9WgXcY",
      chapters: [],
      subtitleTracks: [{ lang: "en", auto: false }],
    };

    const result = await transcript("dQw4w9WgXcY", undefined, metaWithSub);
    assert.equal(result.kind, "none");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Semaphore — concurrency cap
// ---------------------------------------------------------------------------

test("semaphore: limits concurrent yt-dlp subprocesses", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    // Script that takes 200ms.
    const script = `
const { execSync } = require('child_process');
process.stdout.write(${JSON.stringify(buildDumpJson())});
// Simulate work by blocking event loop briefly.
const start = Date.now();
while (Date.now() - start < 80) {}
`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    // Set concurrency = 2 so at most 2 can run simultaneously.
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000, concurrency: 2 });

    const start = Date.now();
    // Launch 4 probes simultaneously.
    await Promise.all([
      probe("aaaaaaaaaaa"),
      probe("bbbbbbbbbbb"),
      probe("ccccccccccc"),
      probe("ddddddddddd"),
    ]);
    const elapsed = Date.now() - start;
    // With concurrency=2 and ~80ms each, 4 calls should take >= 2 batches
    // (i.e. at least ~160ms). We use a loose bound.
    assert.ok(elapsed >= 100, `expected >= 100ms but got ${elapsed}ms`);

    // Post-burst: all 4 calls completed, so both semaphore slots must be free.
    // A 5th probe must complete promptly.  If the semaphore double-decremented
    // during the burst its internal counter goes negative and this hangs forever.
    const postStart = Date.now();
    await Promise.race([
      probe("eeeeeeeeeee"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("5th probe timed out — semaphore slots exhausted")),
          1500,
        ),
      ),
    ]);
    const postElapsed = Date.now() - postStart;
    assert.ok(postElapsed < 1500, `5th probe took too long: ${postElapsed}ms`);
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// probeYtDlpBinary()
// ---------------------------------------------------------------------------

test("probeYtDlpBinary: returns version string from a working binary", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "miku-yttest-"));
  try {
    const script = `process.stdout.write("2024.11.04\\n");`;
    const bin = await makeFakeYtDlp(tmpDir, script);
    configureYtDlp({ ytDlpPath: bin, timeoutMs: 5000 });
    const version = await probeYtDlpBinary();
    assert.equal(version, "2024.11.04");
  } finally {
    resetYtDlpConfig();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("probeYtDlpBinary: throws when binary is absent", async () => {
  configureYtDlp({ ytDlpPath: "/nonexistent/yt-dlp", timeoutMs: 3000 });
  await assert.rejects(() => probeYtDlpBinary());
  resetYtDlpConfig();
});
