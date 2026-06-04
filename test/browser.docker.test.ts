import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { BrowserSession } from "../src/browser/index.js";
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

function config(): BrowserConfig {
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
    nav_timeout_ms: 45000,
    act_timeout_ms: 20000,
    connect_timeout_ms: 30000,
    session_page_idle_ms: 600000,
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
    const tool = createBrowserTool({ session, agentSessionId: "docker-s1", config: cfg });

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
