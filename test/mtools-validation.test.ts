import assert from "node:assert/strict";
import test from "node:test";
import { createDanbooruTool } from "../src/tools/danbooru.js";
import {
  createUserProfileReadTool,
  createUserProfileEditTool,
} from "../src/tools/user-profile.js";
import {
  FetchClient,
  buildProxyDispatcher,
} from "../src/enrichment/fetch-client.js";
import {
  createCharacterCardCreateTool,
  type CharacterCardToolContext,
} from "../src/tools/character-card.js";

function makeFetchClient(): FetchClient {
  return new FetchClient({
    timeoutMs: 1_000,
    maxResponseBytes: 1_000,
  });
}

// ---------------------------------------------------------------------------
// Item 1 — Danbooru paired credentials
// ---------------------------------------------------------------------------

test("createDanbooruTool throws when login is set without api_key", () => {
  assert.throws(
    () =>
      createDanbooruTool({
        workspaceRoot: "/tmp",
        downloadSizeLimit: 1_000,
        fetchClient: makeFetchClient(),
        config: { login: "alice" },
      }),
    /danbooru\.login and danbooru\.api_key must be configured together\./,
  );
});

test("createDanbooruTool throws when api_key is set without login", () => {
  assert.throws(
    () =>
      createDanbooruTool({
        workspaceRoot: "/tmp",
        downloadSizeLimit: 1_000,
        fetchClient: makeFetchClient(),
        config: { api_key: "secret" },
      }),
    /danbooru\.login and danbooru\.api_key must be configured together\./,
  );
});

test("createDanbooruTool accepts both credentials together", () => {
  assert.doesNotThrow(() =>
    createDanbooruTool({
      workspaceRoot: "/tmp",
      downloadSizeLimit: 1_000,
      fetchClient: makeFetchClient(),
      config: { login: "alice", api_key: "secret" },
    }),
  );
});

test("createDanbooruTool accepts neither credential", () => {
  assert.doesNotThrow(() =>
    createDanbooruTool({
      workspaceRoot: "/tmp",
      downloadSizeLimit: 1_000,
      fetchClient: makeFetchClient(),
    }),
  );
});

// ---------------------------------------------------------------------------
// Item 3 — URL/scheme validation
// ---------------------------------------------------------------------------

test("createDanbooruTool rejects non-http(s) base_url", () => {
  assert.throws(
    () =>
      createDanbooruTool({
        workspaceRoot: "/tmp",
        downloadSizeLimit: 1_000,
        fetchClient: makeFetchClient(),
        config: { base_url: "ftp://example.com" },
      }),
    /danbooru\.base_url must use http or https\./,
  );
});

test("createDanbooruTool rejects malformed base_url", () => {
  assert.throws(
    () =>
      createDanbooruTool({
        workspaceRoot: "/tmp",
        downloadSizeLimit: 1_000,
        fetchClient: makeFetchClient(),
        config: { base_url: "not a url" },
      }),
    /danbooru\.base_url must be a valid URL\./,
  );
});

test("createDanbooruTool accepts an https base_url", () => {
  assert.doesNotThrow(() =>
    createDanbooruTool({
      workspaceRoot: "/tmp",
      downloadSizeLimit: 1_000,
      fetchClient: makeFetchClient(),
      config: { base_url: "https://danbooru.donmai.us/" },
    }),
  );
});

test("buildProxyDispatcher rejects non-http(s) proxy URL", () => {
  assert.throws(
    () => buildProxyDispatcher("ftp://proxy.example.com:8080"),
    /network\.http_proxy_url must use http or https\./,
  );
});

test("buildProxyDispatcher rejects malformed proxy URL", () => {
  assert.throws(
    () => buildProxyDispatcher("not a url"),
    /network\.http_proxy_url must be a valid URL\./,
  );
});

test("buildProxyDispatcher returns undefined for empty/missing URL", () => {
  assert.equal(buildProxyDispatcher(undefined), undefined);
  assert.equal(buildProxyDispatcher(""), undefined);
  assert.equal(buildProxyDispatcher("   "), undefined);
});

// ---------------------------------------------------------------------------
// Item 4 — Excerpt bounds
// ---------------------------------------------------------------------------

function makeCharacterCardContext(config: CharacterCardToolContext["config"]): CharacterCardToolContext {
  return {
    workspaceRoot: "/tmp",
    fetchClient: makeFetchClient(),
    downloadSizeLimit: 1_000,
    config,
  };
}

test("createCharacterCardCreateTool throws when max_excerpt_chars < default_excerpt_chars", () => {
  assert.throws(
    () =>
      createCharacterCardCreateTool(
        makeCharacterCardContext({
          default_excerpt_chars: 4000,
          max_excerpt_chars: 1000,
        }),
      ),
    /character_card\.max_excerpt_chars must be >= character_card\.default_excerpt_chars\./,
  );
});

test("createUserProfileReadTool throws when max_excerpt_chars < default_excerpt_chars", () => {
  assert.throws(
    () =>
      createUserProfileReadTool({
        workspaceRoot: "/tmp",
        provider: "matrix",
        senderId: "@user:example.com",
        config: {
          default_excerpt_chars: 4000,
          max_excerpt_chars: 1000,
        },
      }),
    /user_profiles\.max_excerpt_chars must be >= user_profiles\.default_excerpt_chars\./,
  );
});

test("createUserProfileEditTool throws when max_excerpt_chars < default_excerpt_chars", () => {
  assert.throws(
    () =>
      createUserProfileEditTool({
        workspaceRoot: "/tmp",
        provider: "matrix",
        senderId: "@user:example.com",
        config: {
          default_excerpt_chars: 4000,
          max_excerpt_chars: 1000,
        },
      }),
    /user_profiles\.max_excerpt_chars must be >= user_profiles\.default_excerpt_chars\./,
  );
});

test("createUserProfileReadTool accepts default bounds", () => {
  assert.doesNotThrow(() =>
    createUserProfileReadTool({
      workspaceRoot: "/tmp",
      provider: "matrix",
      senderId: "@user:example.com",
    }),
  );
});
