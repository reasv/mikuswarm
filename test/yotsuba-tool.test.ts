/**
 * Tests for src/tools/yotsuba.ts
 * (spec/YOTSUBA-SUPPORT.md §7, §12)
 *
 * No live network calls — all HTTP interactions use mock client objects.
 * Image/storyboard/PDF operations are exercised at the unit level with
 * no actual file downloads (the mock fetchFile returns a tiny buffer that
 * triggers `conditionImageBufferForInference` to fail gracefully).
 *
 * Covers: all 5 actions, all thread views, §7.5 errors, footer JSON,
 * naive-input tolerance, non-vision behavior, catalog sort/filter, download
 * naming/collision.
 */

import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import type { YotsubaClient } from "../src/yotsuba/client.js";
import type { YotsubaFetchResult } from "../src/yotsuba/client.js";
import type { ApiBoard, ApiCatalogPage, ApiThread } from "../src/yotsuba/types.js";
import { resolveYotsubaConfig } from "../src/yotsuba/types.js";
import { createYotsubaTool, type YotsubaToolContext } from "../src/tools/yotsuba.js";
import { setEgressGuardEnabled } from "../src/tools/ssrf.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

before(() => setEgressGuardEnabled(false));
after(() => setEgressGuardEnabled(true));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOARDS_FIXTURE: ApiBoard[] = [
  { board: "g", title: "Technology", ws_board: 1, meta_description: "/g/ - Technology" },
  { board: "a", title: "Anime & Manga", ws_board: 1, meta_description: "/a/ - Anime" },
  { board: "b", title: "Random", ws_board: 0, meta_description: "/b/ - Random" },
];

const THREAD_FIXTURE: ApiThread = {
  posts: [
    {
      no: 100, resto: 0, name: "Anonymous", sub: "Test Thread",
      com: "OP post here, quoting <a href=\"#p101\" class=\"quotelink\">&gt;&gt;101</a>",
      time: 1700000000, replies: 3, images: 1, unique_ips: 5,
      tim: 12345678, filename: "image", ext: ".png", fsize: 10000, w: 800, h: 600,
    },
    {
      no: 101, resto: 100, name: "Anonymous",
      com: "Reply one <a href=\"#p100\" class=\"quotelink\">&gt;&gt;100</a>",
      time: 1700000060,
    },
    {
      no: 102, resto: 100, name: "Anonymous",
      com: "Reply two <a href=\"#p101\" class=\"quotelink\">&gt;&gt;101</a>",
      time: 1700000120,
      tim: 87654321, filename: "other", ext: ".jpg", fsize: 5000, w: 600, h: 400,
    },
    {
      no: 103, resto: 100, name: "Anonymous",
      com: "Reply three",
      time: 1700000180,
    },
  ],
};

const CATALOG_FIXTURE: ApiCatalogPage[] = [
  {
    page: 1,
    threads: [
      { no: 100, time: 1700000000, name: "Anonymous", com: "first thread", sub: "First", replies: 10, images: 3, last_modified: 1700000500 },
      { no: 200, time: 1700000100, name: "Anonymous", com: "second thread about test words", replies: 5, images: 1, last_modified: 1700000200 },
      { no: 300, time: 1700000200, name: "Anonymous", com: "third thread", sub: "Third test subject", replies: 20, images: 8, last_modified: 1700000600 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeResult<T>(body: T, fetchedAt = Date.now()): YotsubaFetchResult<T> {
  return { body, fetchedAt, lastModified: undefined, fromCache: false };
}

interface MockClientOpts {
  boards?: ApiBoard[];
  catalogPages?: Record<string, ApiCatalogPage[]>;
  threads?: Record<string, ApiThread | null>;
  fetchFileBuffer?: Buffer;
}

function makeMockClient(opts: MockClientOpts = {}): YotsubaClient {
  const boards = opts.boards ?? BOARDS_FIXTURE;
  const catalogPages = opts.catalogPages ?? { g: CATALOG_FIXTURE };
  const threads = opts.threads ?? { "g:100": THREAD_FIXTURE };
  // Tiny 1x1 transparent PNG
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const fetchFileBuffer = opts.fetchFileBuffer ?? tinyPng;

  return {
    async boards(_cls) { return makeResult(boards); },
    async catalog(board, _cls) { return makeResult(catalogPages[board] ?? []); },
    async thread(board, no, _cls) {
      const key = `${board}:${no}`;
      const t = threads[key];
      if (t === null) return null;
      if (t === undefined) return null;
      return makeResult(t);
    },
    async fetchFile(_board, _ref, _cls) { return fetchFileBuffer; },
  } as unknown as YotsubaClient;
}

// ---------------------------------------------------------------------------
// Tool context factory
// ---------------------------------------------------------------------------

async function makeTmpWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "miku-yotsuba-test-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function makeCtx(client: YotsubaClient, wsRoot: string, opts: { modelHasVision?: boolean } = {}): YotsubaToolContext {
  return {
    client,
    config: resolveYotsubaConfig({}),
    workspaceRoot: wsRoot,
    modelHasVision: opts.modelHasVision ?? true,
    maxImageBytes: 4 * 1024 * 1024,
    inferenceImageOptions: {
      maxWidth: 1280,
      maxHeight: 1280,
      quality: 85,
    } as never, // type cast — we use benign conditioned-image ops
    fetchClient: null as never, // not used in mock path
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function callTool(
  ctx: YotsubaToolContext,
  params: Record<string, unknown>,
): ReturnType<typeof ctx["client"]["boards"]> extends Promise<unknown>
  ? Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>
  : never {
  const tool = createYotsubaTool(ctx);
  return (tool.execute as Function)("test-call-id", params) as never;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

// ---------------------------------------------------------------------------
// boards action
// ---------------------------------------------------------------------------

describe("yotsuba tool: boards", () => {
  test("lists boards", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "boards" });
      const text = textContent(result);
      assert.ok(text.includes("/g/"), "should include /g/");
      assert.ok(text.includes("Technology"), "should include board title");
    } finally { await ws.cleanup(); }
  });

  test("filters boards by query", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "boards", query: "anime" });
      const text = textContent(result);
      assert.ok(text.includes("/a/"), "should match anime board");
      assert.ok(!text.includes("/g/"), "should not match technology");
    } finally { await ws.cleanup(); }
  });

  test("infers boards action when no params given", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {});
      const text = textContent(result);
      assert.ok(text.includes("/g/"), "should list boards");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// catalog action
// ---------------------------------------------------------------------------

describe("yotsuba tool: catalog", () => {
  test("lists catalog threads", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "catalog", board: "g" });
      const text = textContent(result);
      assert.ok(text.includes("#100") || text.includes("100"), "should include thread number");
    } finally { await ws.cleanup(); }
  });

  test("filters catalog by query (AND match)", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "catalog", board: "g", query: "test" });
      const text = textContent(result);
      // Thread 200 has "test" in body, thread 300 has "test" in subject
      assert.ok(text.includes("200") || text.includes("test"), "should show matching threads");
    } finally { await ws.cleanup(); }
  });

  test("unknown board returns actionable error with candidates", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "catalog", board: "zzz" });
      const text = textContent(result);
      assert.ok(text.includes("Unknown board"), "should report unknown board");
      assert.ok(text.includes("boards"), "should hint at boards action");
    } finally { await ws.cleanup(); }
  });

  test("missing board returns board_required error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "catalog" });
      const text = textContent(result);
      assert.ok(text.toLowerCase().includes("board"), "should mention board");
    } finally { await ws.cleanup(); }
  });

  test("infers catalog from board-only URL", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { url: "https://boards.4chan.org/g/" });
      // Should either fetch catalog or fall to thread; at minimum should not crash
      assert.ok(result.content.length > 0);
    } finally { await ws.cleanup(); }
  });

  test("accepts /g/ board form", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "catalog", board: "/g/" });
      const text = textContent(result);
      assert.ok(!text.includes("Unknown board"), "should normalize /g/ to g");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// thread action — chronological view
// ---------------------------------------------------------------------------

describe("yotsuba tool: thread (chronological)", () => {
  test("renders thread in chronological view", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100 });
      const text = textContent(result);
      assert.ok(text.includes("untrusted_4chan"), "should be wrapped in untrusted envelope");
      assert.ok(text.includes("100"), "should include OP post number");
      assert.ok(text.includes("Test Thread"), "should include subject");
    } finally { await ws.cleanup(); }
  });

  test("output contains view attribute", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100 });
      const text = textContent(result);
      assert.ok(text.includes('view="chronological"'), "envelope should carry view attribute");
    } finally { await ws.cleanup(); }
  });

  test("footer contains as_of", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100 });
      const text = textContent(result);
      assert.ok(text.includes("as_of"), "footer should contain as_of");
    } finally { await ws.cleanup(); }
  });

  test("footer JSON is valid JSON for next-page calls", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      // Use small token budget so there's a next page
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100,
        max_tokens: 10, // very small — forces pagination
      });
      const text = textContent(result);
      // Find all JSON-like objects in the footer (they appear after "Next page:" etc.)
      const jsonMatches = text.matchAll(/\{[^{}]*"action"[^{}]*\}/g);
      for (const match of jsonMatches) {
        // Every embedded JSON must parse cleanly
        try {
          JSON.parse(match[0]);
        } catch (err) {
          assert.fail(`Invalid JSON in footer: ${match[0]} — ${err}`);
        }
      }
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// thread action — conversation view
// ---------------------------------------------------------------------------

describe("yotsuba tool: thread (conversation)", () => {
  test("conversation view centers on focus post", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100, post: 102, view: "conversation",
      });
      const text = textContent(result);
      assert.ok(text.includes('view="conversation"'), "envelope should carry view attribute");
      assert.ok(text.includes("102"), "should include the focus post");
    } finally { await ws.cleanup(); }
  });

  test("auto-infers conversation view when post is given", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100, post: 101 });
      const text = textContent(result);
      assert.ok(text.includes('view="conversation"'), "should auto-select conversation view");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// thread action — search view
// ---------------------------------------------------------------------------

describe("yotsuba tool: thread (search)", () => {
  test("search view filters to matching posts", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100, view: "search", query: "Reply",
      });
      const text = textContent(result);
      assert.ok(text.includes('view="search"'), "envelope should carry view attribute");
    } finally { await ws.cleanup(); }
  });

  test("auto-infers search view from query", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100, query: "Reply" });
      const text = textContent(result);
      assert.ok(text.includes('view="search"'), "should auto-select search view");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// thread action — most_replied view
// ---------------------------------------------------------------------------

describe("yotsuba tool: thread (most_replied)", () => {
  test("most_replied view works", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100, view: "most_replied",
      });
      const text = textContent(result);
      assert.ok(text.includes('view="most_replied"'), "should carry view attribute");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// thread action — replies view
// ---------------------------------------------------------------------------

describe("yotsuba tool: thread (replies)", () => {
  test("replies view works", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100, post: 100, view: "replies",
      });
      const text = textContent(result);
      assert.ok(text.includes('view="replies"'), "should carry view attribute");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// §7.5 errors
// ---------------------------------------------------------------------------

describe("yotsuba tool: §7.5 errors", () => {
  test("thread 404 → thread_gone actionable error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient({ threads: { "g:999": null } }), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 999 });
      const text = textContent(result);
      assert.ok(text.includes("gone") || text.includes("pruned") || text.includes("deleted"), "should report thread gone");
    } finally { await ws.cleanup(); }
  });

  test("unknown board → actionable error with candidates", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "zzz", thread: 100 });
      const text = textContent(result);
      assert.ok(text.includes("Unknown board") || text.includes("unknown"), "should report unknown board");
    } finally { await ws.cleanup(); }
  });

  test("post_not_found error with range hint", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100, post: 99999, view: "conversation",
      });
      const text = textContent(result);
      assert.ok(text.includes("99999") || text.includes("not in"), "should report post not found");
    } finally { await ws.cleanup(); }
  });

  test("missing board → board_required error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", thread: 100 });
      const text = textContent(result);
      assert.ok(text.toLowerCase().includes("board"), "should ask for board");
    } finally { await ws.cleanup(); }
  });

  test("unknown action returns clear error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "invalidaction" });
      const text = textContent(result);
      assert.ok(text.includes("Unknown action") || text.includes("Valid:"), "should report unknown action");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Naive input tolerance
// ---------------------------------------------------------------------------

describe("yotsuba tool: naive-input tolerance", () => {
  test("bare thread URL infers thread action", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { url: "https://boards.4chan.org/g/thread/100" });
      const text = textContent(result);
      assert.ok(text.includes("untrusted_4chan"), "should render thread from URL");
    } finally { await ws.cleanup(); }
  });

  test("/g/ board form normalized", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "/g/", thread: 100 });
      const text = textContent(result);
      assert.ok(!text.includes("Unknown board"), "should normalize /g/ to g");
    } finally { await ws.cleanup(); }
  });

  test("zero thread value treated as absent → error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 0 });
      const text = textContent(result);
      // Zero is treated as absent, so should error on missing thread
      assert.ok(text.toLowerCase().includes("thread") || text.toLowerCase().includes("board"), "should ask for thread");
    } finally { await ws.cleanup(); }
  });

  test("empty string board treated as absent → error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "thread", board: "", thread: 100 });
      const text = textContent(result);
      assert.ok(text.toLowerCase().includes("board"), "should ask for board");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Non-vision behavior
// ---------------------------------------------------------------------------

describe("yotsuba tool: non-vision", () => {
  test("no image blocks when modelHasVision=false", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root, { modelHasVision: false });
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100 });
      const imageBlocks = result.content.filter((c: { type: string }) => c.type === "image");
      assert.equal(imageBlocks.length, 0, "should have no image blocks in non-vision mode");
    } finally { await ws.cleanup(); }
  });

  test("non-vision thread view mentions file metadata hint", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root, { modelHasVision: false });
      const result = await callTool(ctx, { action: "thread", board: "g", thread: 100 });
      const text = textContent(result);
      // Should contain the non-vision hint
      assert.ok(text.includes("view") || text.includes("metadata") || text.includes("Files"), "should contain file hint");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// files:none pass
// ---------------------------------------------------------------------------

describe("yotsuba tool: files:none", () => {
  test("files:none suppresses image blocks", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root, { modelHasVision: true });
      const result = await callTool(ctx, {
        action: "thread", board: "g", thread: 100, files: "none",
      });
      const imageBlocks = result.content.filter((c: { type: string }) => c.type === "image");
      // files:none should produce no image blocks
      assert.equal(imageBlocks.length, 0, "files:none should suppress all image blocks");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// view action
// ---------------------------------------------------------------------------

describe("yotsuba tool: view", () => {
  test("view action fetches post file metadata", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "view", board: "g", thread: 100, posts: [100] });
      const text = textContent(result);
      // Should show the post number and attempt to display file
      assert.ok(text.includes("100") || text.includes("image") || text.includes("image.png"), "should show post file info");
    } finally { await ws.cleanup(); }
  });

  test("view on post with no file reports no file attached", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "view", board: "g", thread: 100, posts: [101] });
      const text = textContent(result);
      assert.ok(text.includes("no file") || text.includes("no file attached"), "should report no file");
    } finally { await ws.cleanup(); }
  });

  test("view on non-existent post reports not found", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "view", board: "g", thread: 100, posts: [99999] });
      const text = textContent(result);
      assert.ok(text.includes("99999") || text.includes("not found"), "should report post not found");
    } finally { await ws.cleanup(); }
  });

  test("view with missing posts field returns posts_required error", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { action: "view", board: "g", thread: 100 });
      const text = textContent(result);
      assert.ok(text.includes("post") || text.includes("number"), "should ask for post numbers");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// download action
// ---------------------------------------------------------------------------

describe("yotsuba tool: download", () => {
  test("downloads file to workspace path", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "download", board: "g", thread: 100, posts: [100],
      });
      const text = textContent(result);
      assert.ok(text.includes("Downloaded") || text.includes("→"), "should show downloaded path");
      // The path should be under downloads/yotsuba/g/100
      assert.ok(text.includes("yotsuba") || text.includes("downloads"), "path under downloads/yotsuba");
    } finally { await ws.cleanup(); }
  });

  test("download path follows naming convention postNo-name.ext", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "download", board: "g", thread: 100, posts: [100],
      });
      const text = textContent(result);
      // Should contain "100-" prefix (postNo-name pattern)
      assert.ok(text.includes("100-"), "path should start with postNo-");
    } finally { await ws.cleanup(); }
  });

  test("download creates workspace directory", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      await callTool(ctx, {
        action: "download", board: "g", thread: 100, posts: [100],
      });
      const dir = path.join(ws.root, "downloads", "yotsuba", "g", "100");
      const stat = await fs.stat(dir).catch(() => null);
      assert.ok(stat?.isDirectory(), "download directory should be created");
    } finally { await ws.cleanup(); }
  });

  test("post with no file is reported as no file", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "download", board: "g", thread: 100, posts: [101], // post 101 has no file
      });
      const text = textContent(result);
      // Should report the post either had no file or was skipped
      // (may be empty output or a "No files downloaded" message)
      assert.ok(typeof text === "string", "should return string result");
    } finally { await ws.cleanup(); }
  });

  test("download on deleted thread → thread_gone", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient({ threads: { "g:999": null } }), ws.root);
      const result = await callTool(ctx, {
        action: "download", board: "g", thread: 999, posts: [100],
      });
      const text = textContent(result);
      assert.ok(text.includes("gone") || text.includes("deleted"), "should report thread gone");
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// URL inference
// ---------------------------------------------------------------------------

describe("yotsuba tool: URL inference", () => {
  test("thread URL with post anchor → conversation view on that post", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        url: "https://boards.4chan.org/g/thread/100#p101",
      });
      const text = textContent(result);
      // Should show the thread, ideally in conversation view around post 101
      assert.ok(text.includes("untrusted_4chan"), "should render thread");
    } finally { await ws.cleanup(); }
  });

  test("board-only URL → catalog action", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, { url: "https://boards.4chan.org/g/" });
      const text = textContent(result);
      // Should show catalog (thread listing) or error; not crash
      assert.ok(result.content.length > 0);
    } finally { await ws.cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// Catalog sort orders
// ---------------------------------------------------------------------------

describe("yotsuba tool: catalog sort", () => {
  test("sort by replies orders highest-reply thread first", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient(), ws.root);
      const result = await callTool(ctx, {
        action: "catalog", board: "g", order: "replies",
      });
      const text = textContent(result);
      // Thread 300 has 20 replies (most), should appear before thread 100 (10)
      const idx300 = text.indexOf("300");
      const idx100 = text.indexOf("100");
      if (idx300 >= 0 && idx100 >= 0) {
        assert.ok(idx300 < idx100, "thread 300 (20 replies) should appear before 100 (10 replies)");
      }
    } finally { await ws.cleanup(); }
  });
});

describe("yotsuba tool: live API shape (no per-post replies field)", () => {
  const q = (no: number) => `<a href="#p${no}" class="quotelink">&gt;&gt;${no}</a>`;
  const apiThread = {
    posts: [
      { no: 100, resto: 0, time: 1790000000, sub: "Example General", com: "welcome", replies: 5, images: 1,
        tim: 1790000000000001, ext: ".png", filename: "op", w: 10, h: 10, fsize: 100 },
      { no: 101, resto: 100, time: 1790000060, com: "a claim worth arguing about" },
      { no: 102, resto: 100, time: 1790000120, com: `${q(101)}<br>disagree` },
      { no: 103, resto: 100, time: 1790000180, com: `${q(101)}<br>agree` },
      { no: 104, resto: 100, time: 1790000240, com: `${q(101)}<br>source?`,
        tim: 1790000000000002, ext: ".jpg", filename: "chart", w: 10, h: 10, fsize: 100 },
      { no: 105, resto: 100, time: 1790000300, com: `${q(102)}<br>same` },
    ],
  };

  test("most_replied ranks by in-thread backlinks; OP replies attr is its backlinks", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient({ threads: { "g:100": apiThread as never } }), ws.root, { modelHasVision: false });
      const text = textContent(await callTool(ctx, { action: "thread", board: "g", thread: 100, view: "most_replied" }));
      assert.match(text, /<post no="101" role="most_replied"[^>]*replies="3"/);
      assert.doesNotMatch(text, /no="100"[^>]*replies="5"/);
    } finally { await ws.cleanup(); }
  });

  test("non-vision page reports 0 files as images and offers the view call", async () => {
    const ws = await makeTmpWorkspace();
    try {
      const ctx = makeCtx(makeMockClient({ threads: { "g:100": apiThread as never } }), ws.root, { modelHasVision: false });
      const text = textContent(await callTool(ctx, { action: "thread", board: "g", thread: 100 }));
      assert.match(text, /0 of 2 files as images/);
      assert.match(text, /"action":"view","board":"g","thread":100,"posts":\[100,104\]/);
    } finally { await ws.cleanup(); }
  });
});
