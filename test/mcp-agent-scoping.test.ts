/**
 * Per-agent MCP server scoping tests (spec PER-AGENT-MCP-SCOPING).
 *
 * Covers:
 *   - filterMcpToolsByAllowlist: keeps/drops correctly across all cases
 *     (absent list, present list, empty list, non-MCP tools, underscore keys)
 *   - Composition with the session-type tool allowlist (filterTools)
 *   - Config cross-field validation: unknown server key → startup error;
 *     valid configs (including [] and absent) load without error
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { validateAgentConfig } from "../src/app.ts";
import { filterMcpToolsByAllowlist, filterTools } from "../src/agent/factory.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SessionTypeConfig } from "../src/workspace/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `Tool ${name}`,
    schema: { type: "object" as const, properties: {} },
    execute: async () => ({ content: [] }),
  } as unknown as AgentTool;
}

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-mcp-scope-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Common non-agent config fields shared across all validation tests.
 * Does NOT include matrix accounts or [agents] blocks — those are appended
 * per-test to avoid TOML table-redefinition errors.
 */
const BASE_CONFIG = `
[app]
name = "mikuswarm"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug/context"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "test-model"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[matrix]
enabled = false
trigger_hold_ms = 0

[summarization]
enabled = false
`;

/**
 * Two-agent accounts snippet appended to BASE_CONFIG. Does NOT define
 * [agents.*] blocks so tests can add them with whichever keys they need.
 */
const ACCOUNTS_SUFFIX = `
[matrix.accounts.alice]
homeserver = "http://localhost"
user_id = "@alice:localhost"
store_path = "./var/alice"
agent = "alice"

[matrix.accounts.bob]
homeserver = "http://localhost"
user_id = "@bob:localhost"
store_path = "./var/bob"
agent = "bob"
`;

/** Minimal agents blocks to satisfy agents-mode invariants (no mcp_servers). */
const AGENTS_BLOCKS = `
[agents.alice]
workspace_root = "./workspaces/alice"

[agents.bob]
workspace_root = "./workspaces/bob"
`;

// ---------------------------------------------------------------------------
// filterMcpToolsByAllowlist — unit tests
// ---------------------------------------------------------------------------

// Exact tool-name → server-name map (mirrors what adaptMcpTools builds at runtime).
const MCP_TOOL_SERVER_MAP = new Map<string, string>([
  ["mcp_exa_web_search", "exa"],
  ["mcp_exa_web_fetch", "exa"],
  ["mcp_medialib_list", "medialib"],
  ["mcp_foo_bar_action", "foo_bar"],
]);

const TOOLS = [
  makeTool("mcp_exa_web_search"),
  makeTool("mcp_exa_web_fetch"),
  makeTool("mcp_medialib_list"),
  makeTool("mcp_foo_bar_action"),
  makeTool("send_message"),
  makeTool("recall_memory"),
];

test("filterMcpToolsByAllowlist: absent list keeps all tools unchanged", () => {
  const result = filterMcpToolsByAllowlist(TOOLS, undefined, MCP_TOOL_SERVER_MAP);
  assert.deepEqual(
    result.map((t) => t.name),
    TOOLS.map((t) => t.name),
  );
});

test("filterMcpToolsByAllowlist: allowlist with one server keeps only that server's MCP tools + non-MCP", () => {
  const result = filterMcpToolsByAllowlist(TOOLS, ["exa"], MCP_TOOL_SERVER_MAP);
  assert.deepEqual(result.map((t) => t.name), [
    "mcp_exa_web_search",
    "mcp_exa_web_fetch",
    "send_message",
    "recall_memory",
  ]);
});

test("filterMcpToolsByAllowlist: allowlist with multiple servers keeps all listed servers' tools", () => {
  const result = filterMcpToolsByAllowlist(TOOLS, ["exa", "medialib"], MCP_TOOL_SERVER_MAP);
  assert.deepEqual(result.map((t) => t.name), [
    "mcp_exa_web_search",
    "mcp_exa_web_fetch",
    "mcp_medialib_list",
    "send_message",
    "recall_memory",
  ]);
});

test("filterMcpToolsByAllowlist: empty allowlist drops all MCP tools, keeps non-MCP", () => {
  const result = filterMcpToolsByAllowlist(TOOLS, [], MCP_TOOL_SERVER_MAP);
  assert.deepEqual(result.map((t) => t.name), ["send_message", "recall_memory"]);
});

test("filterMcpToolsByAllowlist: non-MCP tools are never dropped regardless of allowlist", () => {
  const nativesOnly = [makeTool("send_message"), makeTool("read_image"), makeTool("bash")];
  const result = filterMcpToolsByAllowlist(nativesOnly, [], MCP_TOOL_SERVER_MAP);
  assert.deepEqual(
    result.map((t) => t.name),
    ["send_message", "read_image", "bash"],
  );
});

test("filterMcpToolsByAllowlist: underscore-containing server key matched correctly", () => {
  // Server "foo_bar" owns "mcp_foo_bar_action" — must not be mis-attributed to a
  // hypothetical shorter key ("foo").
  const result = filterMcpToolsByAllowlist(TOOLS, ["foo_bar"], MCP_TOOL_SERVER_MAP);
  assert.deepEqual(result.map((t) => t.name), [
    "mcp_foo_bar_action",
    "send_message",
    "recall_memory",
  ]);
});

test("filterMcpToolsByAllowlist: tool absent from map is kept (not an MCP tool)", () => {
  // A tool not present in the attribution map is treated as a non-MCP tool → kept
  // even with an empty allowlist.
  const tools = [makeTool("mcp_unknown_tool"), makeTool("send_message")];
  const result = filterMcpToolsByAllowlist(tools, [], MCP_TOOL_SERVER_MAP);
  // "mcp_unknown_tool" is not in MCP_TOOL_SERVER_MAP → treated as non-MCP → kept.
  assert.deepEqual(result.map((t) => t.name), ["mcp_unknown_tool", "send_message"]);
});

// ---------------------------------------------------------------------------
// Regression: prefix-collision between servers "foo" and "foo_bar"
//
// Before the exact-map fix, Set iteration could attribute mcp_foo_bar_* to
// server "foo" (if "foo" appeared first), giving foo-only agents unwanted
// access to foo_bar's tools and denying foo_bar-only agents their own tools.
// ---------------------------------------------------------------------------

// Servers "foo" (tool "bar_something") and "foo_bar" (tool "action").
// Note: mcp_foo_bar_something belongs to server "foo"; mcp_foo_bar_action to "foo_bar".
const COLLISION_MAP = new Map<string, string>([
  ["mcp_foo_bar_something", "foo"],
  ["mcp_foo_bar_action", "foo_bar"],
]);
const COLLISION_TOOLS = [
  makeTool("mcp_foo_bar_something"),
  makeTool("mcp_foo_bar_action"),
  makeTool("send_message"),
];

test("filterMcpToolsByAllowlist: foo-only agent does not receive foo_bar's tools (collision regression)", () => {
  // An agent allowed only "foo" must NOT see mcp_foo_bar_action (owned by "foo_bar").
  const result = filterMcpToolsByAllowlist(COLLISION_TOOLS, ["foo"], COLLISION_MAP);
  assert.deepEqual(result.map((t) => t.name), ["mcp_foo_bar_something", "send_message"]);
});

test("filterMcpToolsByAllowlist: foo_bar-only agent receives its own tools and not foo's (collision regression)", () => {
  // An agent allowed only "foo_bar" must NOT see mcp_foo_bar_something (owned by "foo").
  const result = filterMcpToolsByAllowlist(COLLISION_TOOLS, ["foo_bar"], COLLISION_MAP);
  assert.deepEqual(result.map((t) => t.name), ["mcp_foo_bar_action", "send_message"]);
});

// ---------------------------------------------------------------------------
// Composition with filterTools (session-type allowlist)
// ---------------------------------------------------------------------------

test("filterMcpToolsByAllowlist composes with filterTools: intersection of both filters", () => {
  // Agent allows only "exa"; session type allows only "mcp_exa_web_search" and "send_message".
  // Result must be the intersection: only "mcp_exa_web_search" and "send_message".
  const afterMcp = filterMcpToolsByAllowlist(TOOLS, ["exa"], MCP_TOOL_SERVER_MAP);
  const sessionType: SessionTypeConfig = { tools: ["mcp_exa_web_search", "send_message"] };
  const result = filterTools(afterMcp, sessionType);
  assert.deepEqual(result.map((t) => t.name), ["mcp_exa_web_search", "send_message"]);
});

test("filterTools + filterMcpToolsByAllowlist: session allowlist naming an MCP-scoped-out tool is a no-op", () => {
  // Agent allows only "exa". Session type allowlists "mcp_medialib_list" (excluded by
  // agent scope). The tool is absent from the final set — same silent behavior as
  // allowlisting a tool from a server the deploy doesn't configure at all.
  const afterMcp = filterMcpToolsByAllowlist(TOOLS, ["exa"], MCP_TOOL_SERVER_MAP);
  const sessionType: SessionTypeConfig = { tools: ["mcp_medialib_list", "send_message"] };
  const result = filterTools(afterMcp, sessionType);
  assert.deepEqual(result.map((t) => t.name), ["send_message"]);
});

// ---------------------------------------------------------------------------
// Config cross-field validation
// ---------------------------------------------------------------------------

test("validateAgentConfig: mcp_servers with unknown server key throws a descriptive error", async () => {
  const toml = `${BASE_CONFIG}
[mcp.servers.exa]
url = "https://mcp.exa.ai/mcp"

[matrix.accounts.alice]
homeserver = "http://localhost"
user_id = "@alice:localhost"
store_path = "./var/alice"
agent = "alice"

[matrix.accounts.bob]
homeserver = "http://localhost"
user_id = "@bob:localhost"
store_path = "./var/bob"
agent = "bob"

[agents.alice]
workspace_root = "./workspaces/alice"
mcp_servers = ["exa", "nonexistent"]

[agents.bob]
workspace_root = "./workspaces/bob"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.throws(
      () => validateAgentConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("alice") && err.message.includes("nonexistent"),
          `error must name the agent and the bad key; got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

test("validateAgentConfig: mcp_servers with valid server keys is accepted", async () => {
  const toml = `${BASE_CONFIG}
[mcp.servers.exa]
url = "https://mcp.exa.ai/mcp"

[mcp.servers.medialib]
url = "http://localhost:9000/mcp"

${ACCOUNTS_SUFFIX}

[agents.alice]
workspace_root = "./workspaces/alice"
mcp_servers = ["exa"]

[agents.bob]
workspace_root = "./workspaces/bob"
mcp_servers = ["exa", "medialib"]
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.doesNotThrow(() => validateAgentConfig(config));
  });
});

test("validateAgentConfig: mcp_servers = [] (empty) is valid", async () => {
  const toml = `${BASE_CONFIG}
[matrix.accounts.alice]
homeserver = "http://localhost"
user_id = "@alice:localhost"
store_path = "./var/alice"
agent = "alice"

[matrix.accounts.bob]
homeserver = "http://localhost"
user_id = "@bob:localhost"
store_path = "./var/bob"
agent = "bob"

[agents.alice]
workspace_root = "./workspaces/alice"
mcp_servers = []

[agents.bob]
workspace_root = "./workspaces/bob"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.doesNotThrow(() => validateAgentConfig(config));
  });
});

test("validateAgentConfig: absent mcp_servers is valid (default behavior)", async () => {
  // No mcp_servers key at all — agents see all configured MCP servers.
  const toml = `${BASE_CONFIG}${ACCOUNTS_SUFFIX}${AGENTS_BLOCKS}`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.doesNotThrow(() => validateAgentConfig(config));
  });
});

test("config schema: mcp_servers array loads correctly", async () => {
  const toml = `${BASE_CONFIG}
[mcp.servers.exa]
url = "https://mcp.exa.ai/mcp"

[matrix.accounts.alice]
homeserver = "http://localhost"
user_id = "@alice:localhost"
store_path = "./var/alice"
agent = "alice"

[matrix.accounts.bob]
homeserver = "http://localhost"
user_id = "@bob:localhost"
store_path = "./var/bob"
agent = "bob"

[agents.alice]
workspace_root = "./workspaces/alice"
mcp_servers = ["exa"]

[agents.bob]
workspace_root = "./workspaces/bob"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.deepEqual(config.agents?.alice?.mcp_servers, ["exa"]);
  });
});
