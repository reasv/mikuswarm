import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { BrowserSession, type DownloadRecord } from "../src/browser/index.js";
import { createBrowserTool } from "../src/tools/browser.js";
import type { BrowserConfig } from "../src/config/index.js";
import type { Logger } from "../src/observability/logger.js";

// Integration smoke test for the whole browser stack: a real CloakBrowser-Manager
// container + a real playwright-core connectOverCDP through its CDP-WS proxy
// (with auth) + AI snapshot + screenshot. Auto-skips when Docker or the image is
// absent (CLAUDE.md test:docker). Mirrors test/sandbox-bash.docker.test.ts.

const PORT = Number(process.env.MIKUSWARM_BROWSER_TEST_PORT ?? 8089);
const AUTH_TOKEN = "docker-test-secret";
const CONTAINER = "mikuswarm-cloakbrowser-manager-test";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function imageAvailable(image: string): boolean {
  return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
}

/** Resolve the Manager image: explicit env, our pinned build, or the upstream image. */
function resolveImage(): string | undefined {
  const candidates = [
    process.env.MIKUSWARM_BROWSER_IMAGE,
    "mikuswarm-cloakbrowser-manager:pinned",
    "cloakhq/cloakbrowser-manager:latest",
  ].filter((v): v is string => Boolean(v));
  return candidates.find((img) => imageAvailable(img));
}

const noDocker = !dockerAvailable();
const image = noDocker ? undefined : resolveImage();
const skip = noDocker
  ? "docker unavailable"
  : !image
    ? "no CloakBrowser-Manager image (build docker/build-browser.sh or pull cloakhq/cloakbrowser-manager)"
    : false;

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};

function config(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    enabled: true,
    manager_url: `http://127.0.0.1:${PORT}`,
    auth_token: AUTH_TOKEN,
    profile_name: "miku-test",
    platform: "windows",
    fingerprint_seed: 4242,
    humanize: false,
    evaluate_enabled: true,
    proxy: "",
    geoip: false,
    dialog_policy: "dismiss",
    snapshot_max_chars: 20000,
    snapshot_max_frames: 10,
    nav_timeout_ms: 45000,
    act_timeout_ms: 20000,
    connect_timeout_ms: 30000,
    session_page_idle_ms: 600000,
    ...overrides,
  };
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/status`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error("Manager did not become healthy in time");
}

test("browser docker: end-to-end navigate + snapshot + screenshot through the Manager", { skip, timeout: 180_000 }, async () => {
  // Remove any stale container, then start a fresh one bound to loopback.
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  execFileSync("docker", [
    "run", "-d", "--name", CONTAINER,
    "-p", `127.0.0.1:${PORT}:8080`,
    "-e", `AUTH_TOKEN=${AUTH_TOKEN}`,
    "--shm-size=1g",
    image!,
  ], { stdio: "ignore" });

  const ws = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-docker-"));
  let session: BrowserSession | undefined;
  try {
    await waitForHealth(90_000);

    const cfg = config();
    session = new BrowserSession({ config: cfg, agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger });
    const tool = createBrowserTool({ session, agentSessionId: "docker-s1", config: cfg, maxImageBytes: 5_242_880, workspaceRoot: ws });

    // Navigate (lazily bootstraps + launches the profile + connects with auth).
    const nav = await tool.execute("c1", { action: "navigate", url: "https://example.com" }) as {
      content: Array<{ type: string; text?: string }>;
      details: { refCount: number };
    };
    const navText = nav.content.map((c) => c.text ?? "").join("\n");
    assert.match(navText, /example\.com/);
    assert.match(navText, /\[ref=e\d+\]/, "snapshot should carry [ref=eN] handles");
    assert.ok(nav.details.refCount > 0);

    // Screenshot → inline PNG.
    const shot = await tool.execute("c1", { action: "screenshot" }) as {
      content: Array<{ type: string; mimeType?: string; data?: string }>;
    };
    const image2 = shot.content.find((c) => c.type === "image");
    assert.ok(image2 && image2.mimeType === "image/png" && (image2.data?.length ?? 0) > 100);

    // evaluate round-trips through the real page.
    const evalRes = await tool.execute("c1", { action: "act", kind: "evaluate", text: "1 + 41" }) as {
      content: Array<{ type: string; text?: string }>;
    };
    assert.match(evalRes.content.map((c) => c.text ?? "").join(""), /42/);
  } finally {
    if (session) await session.shutdown();
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    await rm(ws, { recursive: true, force: true });
  }
});

test("browser docker: feature additions (rich-wait, element shot, modifiers, upload, clear, drag, dialog, pdf, console)", { skip, timeout: 240_000 }, async () => {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  execFileSync("docker", [
    "run", "-d", "--name", CONTAINER,
    "-p", `127.0.0.1:${PORT}:8080`,
    "-e", `AUTH_TOKEN=${AUTH_TOKEN}`,
    "--shm-size=1g",
    image!,
  ], { stdio: "ignore" });

  const ws = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-feat-"));
  let session: BrowserSession | undefined;
  try {
    await waitForHealth(90_000);
    const cfg = config();
    session = new BrowserSession({ config: cfg, agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger });
    const tool = createBrowserTool({ session, agentSessionId: "docker-feat", config: cfg, maxImageBytes: 5_242_880, workspaceRoot: ws });

    type ToolResult = { content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>; details?: Record<string, unknown> };
    const exec = (args: Record<string, unknown>) => tool.execute("c1", args) as Promise<ToolResult>;
    const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
    const setBody = (html: string) => exec({ action: "act", kind: "evaluate", text: `document.body.innerHTML = ${JSON.stringify(html)}; 'ok'` });
    const snapshot = async () => textOf(await exec({ action: "snapshot" }));
    const evalText = async (expr: string) => textOf(await exec({ action: "act", kind: "evaluate", text: expr }));
    const refByName = (snap: string, name: string) => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = snap.match(new RegExp(`"${esc}"[^\\n]*\\[ref=(e\\d+)\\]`));
      if (!m) throw new Error(`no ref for "${name}" in snapshot:\n${snap}`);
      return m[1];
    };
    const firstRef = (snap: string) => {
      const m = snap.match(/\[ref=(e\d+)\]/);
      if (!m) throw new Error(`no refs in snapshot:\n${snap}`);
      return m[1];
    };

    await exec({ action: "navigate", url: "https://example.com/" });

    // ── rich wait: wait_selector resolves once a deferred element appears ──────
    await setBody(`<div id="host"></div>`);
    await evalText(`setTimeout(() => { document.getElementById('host').innerHTML = '<span class="ready">R</span>'; }, 600); 'scheduled'`);
    const waited = await exec({ action: "act", kind: "wait", wait_selector: ".ready" });
    assert.match(textOf(waited), /waited for selector \.ready/);

    // ── rich wait: a never-satisfied condition times out as act_timeout ───────
    const fastCfg = { ...config(), act_timeout_ms: 3000 };
    const fastTool = createBrowserTool({ session, agentSessionId: "docker-feat", config: fastCfg, maxImageBytes: 5_242_880, workspaceRoot: ws });
    await assert.rejects(
      () => fastTool.execute("c1", { action: "act", kind: "wait", wait_selector: ".never-ever" }),
      /browser:act_timeout/,
    );

    // ── element screenshot is smaller than full-page; jpeg mimeType honored ───
    await setBody(`<div style="height:3000px;background:linear-gradient(#fff,#000)">tall</div><button id="b" style="width:40px;height:20px">Snap</button>`);
    const snapA = await snapshot();
    const bRef = refByName(snapA, "Snap");
    const fullShot = await exec({ action: "screenshot", full_page: true });
    const elemShot = await exec({ action: "screenshot", ref: bRef, format: "jpeg" });
    const elemImg = elemShot.content.find((c) => c.type === "image");
    assert.ok(elemImg && elemImg.mimeType === "image/jpeg", "element shot is jpeg");
    assert.ok(
      (elemShot.details?.base64Bytes as number) < (fullShot.details?.base64Bytes as number),
      "element capture is smaller than the full page",
    );

    // ── click modifiers: double-click and right-click fire their handlers ─────
    await setBody(`<button id="hit" ondblclick="window.__dbl=true" oncontextmenu="window.__ctx=true;return false;">Hit</button>`);
    const snapB = await snapshot();
    const hitRef = refByName(snapB, "Hit");
    await exec({ action: "act", kind: "click", ref: hitRef, double: true });
    assert.match(await evalText(`window.__dbl === true`), /true/);
    await exec({ action: "act", kind: "click", ref: hitRef, button: "right" });
    assert.match(await evalText(`window.__ctx === true`), /true/);

    // ── upload: direct <input type=file> and a button-armed chooser ───────────
    await writeFile(path.join(ws, "upload-me.txt"), "hello upload");
    await setBody(`<input type="file" id="up" aria-label="picker">`);
    const upRef = firstRef(await snapshot());
    await exec({ action: "act", kind: "upload", ref: upRef, paths: ["upload-me.txt"] });
    assert.match(await evalText(`document.getElementById('up').files[0]?.name || ''`), /upload-me\.txt/);

    await setBody(`<button id="pick">Pick</button><input type="file" id="up2" style="display:none">`);
    await evalText(`document.getElementById('pick').addEventListener('click', () => document.getElementById('up2').click()); 'wired'`);
    const pickRef = refByName(await snapshot(), "Pick");
    await exec({ action: "act", kind: "upload", ref: pickRef, paths: ["upload-me.txt"] });
    assert.match(await evalText(`document.getElementById('up2').files[0]?.name || ''`), /upload-me\.txt/);

    // ── clear_site_data: cookie + localStorage gone for the origin ────────────
    await evalText(`document.cookie = 'k=v; path=/'; localStorage.setItem('lk', 'lv'); 'set'`);
    assert.match(await evalText(`(document.cookie.includes('k=v') && localStorage.getItem('lk') === 'lv')`), /true/);
    await exec({ action: "act", kind: "clear_site_data" });
    // Reload so the live page reflects the cleared storage (spec §3.6 caveat).
    await exec({ action: "navigate", url: "https://example.com/" });
    assert.match(await evalText(`localStorage.getItem('lk') === null`), /true/);
    assert.match(await evalText(`!document.cookie.includes('k=v')`), /true/);

    // ── drag: dragging source → target runs the mouse sequence end-to-end ─────
    await setBody(`<button id="src">Src</button><button id="dst">Dst</button>`);
    await evalText(`window.__dropped=false; document.getElementById('dst').addEventListener('mouseup', () => { window.__dropped = true; }); 'wired'`);
    const snapD = await snapshot();
    await exec({ action: "act", kind: "drag", ref: refByName(snapD, "Src"), to_ref: refByName(snapD, "Dst") });
    assert.match(await evalText(`window.__dropped === true`), /true/);

    // ── dialog: a one-shot override answers a confirm() armed before the click ─
    await setBody(`<button id="cf" onclick="window.__ok = confirm('sure?')">Confirm</button>`);
    const cfRef = refByName(await snapshot(), "Confirm");
    await exec({ action: "act", kind: "dialog", accept: true });
    await exec({ action: "act", kind: "click", ref: cfRef });
    assert.match(await evalText(`window.__ok === true`), /true/, "armed accept answered the confirm()");
    // A prompt() answered with specific text.
    await setBody(`<button id="pr" onclick="window.__ans = prompt('name?')">Prompt</button>`);
    const prRef = refByName(await snapshot(), "Prompt");
    await exec({ action: "act", kind: "dialog", accept: true, prompt_text: "Miku" });
    await exec({ action: "act", kind: "click", ref: prRef });
    assert.match(await evalText(`window.__ans`), /Miku/, "armed prompt_text answered the prompt()");

    // ── pdf: export the current page to the workspace; file has the PDF magic ──
    await exec({ action: "navigate", url: "https://example.com/" });
    const pdfRes = await exec({ action: "pdf" });
    const pdfPath = (pdfRes.details?.path as string) ?? "";
    assert.match(pdfPath, /browser-downloads\/.*\/page-1\.pdf$/, "pdf saved under the download dir");
    const pdfBytes = await readFile(path.join(ws, pdfPath));
    assert.ok(pdfBytes.byteLength > 0, "pdf is non-empty");
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-", "pdf has the magic header");

    // ── console: console.log + an uncaught page error are buffered + drained ──
    await exec({ action: "navigate", url: "https://example.com/" });
    await evalText(`console.log('hello-from-page'); setTimeout(() => { throw new Error('console-test-error'); }, 0); 'logged'`);
    await exec({ action: "act", kind: "wait", ms: 300 });
    const consoleText = textOf(await exec({ action: "console" }));
    assert.match(consoleText, /hello-from-page/, "console.log captured");
    assert.match(consoleText, /console-test-error/, "uncaught page error captured");
    // Drained: a second read has nothing new from before.
    assert.match(textOf(await exec({ action: "console" })), /no console messages/, "buffer drained on read");
  } finally {
    if (session) await session.shutdown();
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    await rm(ws, { recursive: true, force: true });
  }
});

test("browser docker: downloads cross the container boundary via the shared staging volume", { skip, timeout: 240_000 }, async () => {
  // The §2.7 verification point: a REAL root-run Chromium writes the staging
  // guid (asserting the 0644 world-readable assumption — the agent-side copy
  // fails with EACCES otherwise), the agent copies it into the workspace
  // uid-owned, unlinks the guid, and the record surfaces via drainDownloads.
  const root = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-browser-dl-docker-"));
  const ws = path.join(root, "workspace");
  const staging = path.join(root, "staging");
  await mkdir(ws, { recursive: true });
  await mkdir(staging, { recursive: true });

  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  execFileSync("docker", [
    "run", "-d", "--name", CONTAINER,
    "-p", `127.0.0.1:${PORT}:8080`,
    "-e", `AUTH_TOKEN=${AUTH_TOKEN}`,
    "--shm-size=1g",
    // The shared staging volume: the browser sees it at /downloads (the
    // downloads_dir sent over CDP), this process sees it at `staging`.
    "-v", `${staging}:/downloads`,
    image!,
  ], { stdio: "ignore" });

  let session: BrowserSession | undefined;
  try {
    await waitForHealth(90_000);
    const cfg = config({ downloads_dir: "/downloads", downloads_local_dir: staging });
    session = new BrowserSession({ config: cfg, agentTimezone: "UTC", workspaceRoot: ws, logger: silentLogger });
    const tool = createBrowserTool({ session, agentSessionId: "docker-dl", config: cfg, maxImageBytes: 5_242_880, workspaceRoot: ws });

    type ToolResult = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
    const exec = (args: Record<string, unknown>) => tool.execute("c1", args) as Promise<ToolResult>;

    // about:blank, not example.com (#25): the blob download is entirely local, so
    // depending on an external site only adds a network flake the test doesn't need.
    await exec({ action: "navigate", url: "about:blank" });

    // Trigger a real download with no network dependency: an a[download] blob link.
    const clickRes = await exec({
      action: "act", kind: "evaluate",
      text: `const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob(['hello download'], { type: 'application/octet-stream' }));
a.download = 'dl-test.txt';
document.body.appendChild(a);
a.click();
'clicked'`,
    });

    // Collect the record: the triggering act's own drain may already carry it,
    // otherwise poll the session (completion is async relative to the click).
    const records: DownloadRecord[] = [...((clickRes.details?.downloads as DownloadRecord[] | undefined) ?? [])];
    const deadline = Date.now() + 30_000;
    while (records.length === 0 && Date.now() < deadline) {
      await sleep(250);
      records.push(...session.drainDownloads("docker-dl"));
    }

    assert.equal(records.length, 1, "exactly one download record surfaced");
    const record = records[0]!;
    assert.ok(!record.failed, `download must not be a failure record (${record.url})`);
    assert.equal(record.filename, "dl-test.txt");
    assert.match(record.path, /^browser-downloads\/docker-dl\/dl-test\.txt$/);
    // readFile succeeding from the agent process IS the permission assertion:
    // the workspace copy is owned by this uid (not the container's root).
    const bytes = await readFile(path.join(ws, record.path));
    assert.equal(bytes.toString(), "hello download", "payload crossed the container boundary intact");
    // Staging hygiene: the guid staging file was unlinked after the copy. Assert
    // no guid-named staging file remains rather than a strictly empty dir (#25) —
    // Chromium can briefly leave a non-guid sidecar that would flake a deepEqual([]).
    const stagingEntries = await readdir(staging);
    const guidLike = stagingEntries.filter((name) => /^[0-9a-f-]{36}(\.crdownload)?$/i.test(name));
    assert.deepEqual(guidLike, [], `no guid-named staging file remains after finalization (saw: ${stagingEntries.join(", ")})`);
  } finally {
    if (session) await session.shutdown();
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    await rm(root, { recursive: true, force: true });
  }
});
