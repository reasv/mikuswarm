/**
 * Phase 4 multi-agent support tests (spec MULTI-AGENT-SUPPORT §10 / §10a).
 *
 * Covers:
 *   - Config validation: global browser.profile_name + [agents] → error (§10a)
 *   - Config validation: per-agent browser profile_names not pairwise distinct → error (§10a)
 *   - Config validation: strict sandbox container_name not unique → error (§10)
 *   - Config validation: strict sandbox workspace_mount not unique → error (§10)
 *   - Config validation: strict agent workspace root under shared common parent → error (§10)
 *   - Config validation: valid configs (strict-only, shared-only, mixed) → no error
 *   - computeCommonAncestor: empty, single, common-prefix, root-only cases
 *   - createSharedExecBackend: cwd routing (no cwd, ".", "./", relative) (§10)
 *   - Browser routing: per-agent profile_name validated at config level (§10a)
 *   - Legacy passthrough: validateAgentConfig on a config without [agents] → no error
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { validateAgentConfig } from "../src/app.ts";
import { computeCommonAncestor, createSharedExecBackend } from "../src/sandbox/shared-exec.js";
import type { ExecBackend, ExecOptions, ExecResult } from "../src/sandbox/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { SandboxBlockConfig } from "../src/config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal AppConfig skeleton that only populates what validateAgentConfig reads.
 * Cast to AppConfig — the function's access is dynamic enough that missing
 * outer fields don't cause runtime errors.
 */
function minimalConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    discord: undefined,
    agents: undefined,
    workspace: undefined,
    sandbox: undefined,
    browser: undefined,
    ...overrides,
  } as unknown as AppConfig;
}

/**
 * Minimal SandboxBlockConfig for strict-mode agent tests.
 * container_name and workspace_mount are intentionally caller-controlled.
 */
function sandboxBlock(overrides: Partial<SandboxBlockConfig> = {}): SandboxBlockConfig {
  return {
    enabled: true,
    image: "mikuswarm-sandbox:24.04",
    container_name: "miku-sbx-default",
    network: "mikuswarm-sandbox",
    workspace_mount: "/workspace",
    exec_timeout_ms: 30_000,
    max_output_bytes: 1_048_576,
    ...overrides,
  };
}

/** Mock ExecBackend that records the last call. */
function mockBackend(): {
  backend: ExecBackend;
  calls: Array<{ command: string; options?: ExecOptions }>;
} {
  const calls: Array<{ command: string; options?: ExecOptions }> = [];
  const backend: ExecBackend = {
    exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      calls.push({ command, options });
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
      });
    },
  };
  return { backend, calls };
}

// ---------------------------------------------------------------------------
// §10a: browser validation
// ---------------------------------------------------------------------------

test("validateAgentConfig §10a: global browser.profile_name with [agents] is a startup error", () => {
  const config = minimalConfig({
    agents: { miku: { workspace_root: "/workspaces/miku" } },
    browser: { profile_name: "miku", manager_url: "http://localhost:3000", auth_token: "tok" } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /profile_name.*agents|agents.*profile_name/i,
    "global browser.profile_name must be rejected when [agents] is present",
  );
});

test("validateAgentConfig §10a: per-agent browser profile_names must be pairwise distinct", () => {
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin", browser: { profile_name: "shared-profile" } },
      miku: { workspace_root: "/workspaces/miku", browser: { profile_name: "shared-profile" } },
    },
  });
  assert.throws(
    () => validateAgentConfig(config),
    /profile_name.*shared-profile|shared-profile.*profile_name/i,
    "duplicate per-agent browser profile_name must be rejected",
  );
});

test("validateAgentConfig §10a: distinct per-agent browser profile_names are valid", () => {
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin", browser: { profile_name: "profile-rin" } },
      miku: { workspace_root: "/workspaces/miku", browser: { profile_name: "profile-miku" } },
    },
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "distinct per-agent browser profile_names must be accepted",
  );
});

test("validateAgentConfig §10a: only some agents having a browser block is valid", () => {
  // Agents without a browser block simply have no browser tools — not an error.
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin", browser: { profile_name: "profile-rin" } },
      miku: { workspace_root: "/workspaces/miku" }, // no browser block
    },
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "an agent with no browser block must not cause a validation error",
  );
});

// ---------------------------------------------------------------------------
// §10: strict sandbox validation
// ---------------------------------------------------------------------------

test("validateAgentConfig §10: strict sandbox container_name must be unique across agents", () => {
  const config = minimalConfig({
    agents: {
      rin: {
        workspace_root: "/workspaces/rin",
        sandbox: sandboxBlock({ container_name: "miku-sbx", workspace_mount: "/workspace-rin" }),
      },
      miku: {
        workspace_root: "/workspaces/miku",
        sandbox: sandboxBlock({ container_name: "miku-sbx", workspace_mount: "/workspace-miku" }),
      },
    },
  });
  assert.throws(
    () => validateAgentConfig(config),
    /container_name.*miku-sbx|miku-sbx.*container_name/i,
    "duplicate sandbox container_name must be rejected",
  );
});

test("validateAgentConfig §10: strict agent container_name matching global [sandbox].container_name is rejected", () => {
  // A strict agent and the shared [sandbox] using the same container_name would cause two
  // SandboxManagers to race over the same Docker container with different mount configurations.
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin" }, // shared-mode
      strict: {
        workspace_root: "/isolated/strict",
        // container_name deliberately matches the global [sandbox].container_name below
        sandbox: sandboxBlock({ container_name: "miku-shared-sbx", workspace_mount: "/workspace" }),
      },
    },
    sandbox: {
      enabled: true,
      image: "mikuswarm-sandbox:24.04",
      container_name: "miku-shared-sbx",
      network: "mikuswarm-sandbox",
      workspace_mount: "/workspace",
      exec_timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /container_name.*miku-shared-sbx|miku-shared-sbx.*container_name/i,
    "strict agent container_name matching global [sandbox].container_name must be rejected",
  );
});

test("validateAgentConfig §10: strict agents sharing workspace_mount but with distinct container_names are valid", () => {
  // workspace_mount is a CONTAINER-SIDE path. Two strict agents in separate containers
  // can both use "/workspace" — they are isolated by having distinct container_names,
  // not by having distinct mount paths inside their respective containers.
  const config = minimalConfig({
    agents: {
      rin: {
        workspace_root: "/workspaces/rin",
        sandbox: sandboxBlock({ container_name: "sbx-rin", workspace_mount: "/workspace" }),
      },
      miku: {
        workspace_root: "/workspaces/miku",
        sandbox: sandboxBlock({ container_name: "sbx-miku", workspace_mount: "/workspace" }),
      },
    },
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "strict agents with identical workspace_mount but distinct container_names must be accepted",
  );
});

test("validateAgentConfig §10: valid strict-only config (distinct container_name + workspace_mount) is accepted", () => {
  const config = minimalConfig({
    agents: {
      rin: {
        workspace_root: "/workspaces/rin",
        sandbox: sandboxBlock({ container_name: "sbx-rin", workspace_mount: "/workspace-rin" }),
      },
      miku: {
        workspace_root: "/workspaces/miku",
        sandbox: sandboxBlock({ container_name: "sbx-miku", workspace_mount: "/workspace-miku" }),
      },
    },
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "distinct strict-mode sandbox configs must be accepted",
  );
});

test("validateAgentConfig §10: strict agent workspace root under shared common parent is rejected", () => {
  // Shared agents: /workspaces/rin and /workspaces/miku → common ancestor /workspaces
  // Strict agent: /workspaces/strict → lies under /workspaces → must error
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin" }, // shared-mode (no sandbox block)
      miku: { workspace_root: "/workspaces/miku" }, // shared-mode
      strict: {
        workspace_root: "/workspaces/strict", // strict-mode root IS UNDER /workspaces
        sandbox: sandboxBlock({ container_name: "sbx-strict", workspace_mount: "/workspace-strict" }),
      },
    },
    sandbox: {
      enabled: true,
      image: "mikuswarm-sandbox:24.04",
      container_name: "miku-shared-sbx",
      network: "mikuswarm-sandbox",
      workspace_mount: "/workspace",
      exec_timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /strict.*common parent|common parent.*strict|workspace.*expose/i,
    "strict agent root under shared common parent must be rejected",
  );
});

test("validateAgentConfig §10: strict agent workspace root OUTSIDE shared common parent is accepted", () => {
  // Shared agents: /workspaces/rin and /workspaces/miku → common ancestor /workspaces
  // Strict agent: /isolated/strict → OUTSIDE /workspaces → must pass
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin" },
      miku: { workspace_root: "/workspaces/miku" },
      strict: {
        workspace_root: "/isolated/strict",
        sandbox: sandboxBlock({ container_name: "sbx-strict", workspace_mount: "/workspace-strict" }),
      },
    },
    sandbox: {
      enabled: true,
      image: "mikuswarm-sandbox:24.04",
      container_name: "miku-shared-sbx",
      network: "mikuswarm-sandbox",
      workspace_mount: "/workspace",
      exec_timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "strict agent root outside shared common parent must be accepted",
  );
});

test("validateAgentConfig §10: shared-only agents (no sandbox block) with global sandbox is valid", () => {
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin" },
      miku: { workspace_root: "/workspaces/miku" },
    },
    sandbox: {
      enabled: true,
      image: "mikuswarm-sandbox:24.04",
      container_name: "miku-shared-sbx",
      network: "mikuswarm-sandbox",
      workspace_mount: "/workspace",
      exec_timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "shared-only agents with global sandbox is valid",
  );
});

test("validateAgentConfig §10: single shared agent + strict agent in a sibling dir validates fine", () => {
  // Before the single-path fix, computeCommonAncestor(["/workspaces/rin"]) returned
  // "/workspaces" (the parent), causing a false-positive rejection of any strict agent
  // under "/workspaces/*". After the fix it returns "/workspaces/rin" itself, so only
  // paths under "/workspaces/rin/" are blocked — the sibling "/workspaces/strict" is fine.
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin" }, // single shared-mode agent
      strict: {
        workspace_root: "/workspaces/strict", // sibling — must NOT be rejected
        sandbox: sandboxBlock({ container_name: "sbx-strict", workspace_mount: "/workspace" }),
      },
    },
    sandbox: {
      enabled: true,
      image: "mikuswarm-sandbox:24.04",
      container_name: "miku-shared-sbx",
      network: "mikuswarm-sandbox",
      workspace_mount: "/workspace",
      exec_timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "strict agent in a sibling dir to a single shared agent must be accepted",
  );
});

// ---------------------------------------------------------------------------
// computeCommonAncestor (src/sandbox/shared-exec.ts)
// ---------------------------------------------------------------------------

test("computeCommonAncestor: empty input returns path.sep", () => {
  const result = computeCommonAncestor([]);
  assert.equal(result, path.sep, "empty input should return the filesystem root");
});

test("computeCommonAncestor: single path returns the path itself", () => {
  // The common ancestor of one path is the path itself — binding the parent would
  // expose sibling directories in the container and produce false-positive rejections
  // of strict agents in sibling directories (the shared-under-strict guard).
  const result = computeCommonAncestor(["/workspaces/rin"]);
  assert.equal(result, "/workspaces/rin", "single path should return the path itself");
});

test("computeCommonAncestor: two paths sharing a common directory", () => {
  const result = computeCommonAncestor(["/workspaces/rin", "/workspaces/miku"]);
  assert.equal(result, "/workspaces", "two sibling paths should share their parent");
});

test("computeCommonAncestor: three paths with nested common parent", () => {
  const result = computeCommonAncestor(["/a/b/c", "/a/b/d", "/a/b/e"]);
  assert.equal(result, "/a/b");
});

test("computeCommonAncestor: paths sharing only the root", () => {
  const result = computeCommonAncestor(["/alpha/x", "/beta/y"]);
  assert.equal(result, path.sep, "paths sharing only root should return path.sep");
});

test("computeCommonAncestor: identical paths return that path (not its parent)", () => {
  // Two identical paths: common ancestor = that path (all components match)
  const result = computeCommonAncestor(["/workspaces/rin", "/workspaces/rin"]);
  assert.equal(result, "/workspaces/rin", "identical paths share themselves as common prefix");
});

test("computeCommonAncestor: deeply nested paths with partial overlap", () => {
  const result = computeCommonAncestor(["/home/users/alice/work", "/home/users/bob/work"]);
  assert.equal(result, "/home/users");
});

// ---------------------------------------------------------------------------
// createSharedExecBackend (src/sandbox/shared-exec.ts)
// ---------------------------------------------------------------------------

test("createSharedExecBackend: no caller cwd → uses agentSubdir as cwd", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "rin");

  await wrapped.exec("ls");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options?.cwd, "rin", "exec with no cwd should use agentSubdir");
});

test("createSharedExecBackend: caller cwd '.' → uses agentSubdir as cwd", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "rin");

  await wrapped.exec("ls", { cwd: "." });

  assert.equal(calls[0]!.options?.cwd, "rin");
});

test("createSharedExecBackend: caller cwd './' → uses agentSubdir as cwd", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "rin");

  await wrapped.exec("ls", { cwd: "./" });

  assert.equal(calls[0]!.options?.cwd, "rin");
});

test("createSharedExecBackend: caller cwd is prepended with agentSubdir (POSIX join)", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "rin");

  await wrapped.exec("ls", { cwd: "src/tools" });

  assert.equal(calls[0]!.options?.cwd, "rin/src/tools");
});

test("createSharedExecBackend: nested agentSubdir + relative cwd join correctly", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "team/rin");

  await wrapped.exec("cat file.ts", { cwd: "src" });

  assert.equal(calls[0]!.options?.cwd, "team/rin/src");
});

test("createSharedExecBackend: extra ExecOptions are passed through unchanged", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "rin");

  await wrapped.exec("timeout-cmd", { cwd: "work", timeoutMs: 5000, env: { FOO: "bar" } });

  const opts = calls[0]!.options!;
  assert.equal(opts.timeoutMs, 5000, "timeoutMs should be passed through");
  assert.deepEqual(opts.env, { FOO: "bar" }, "env should be passed through");
  assert.equal(opts.cwd, "rin/work", "cwd should be prepended");
});

test("createSharedExecBackend: command string is forwarded unchanged", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "rin");

  await wrapped.exec("bash -c 'echo hello'");

  assert.equal(calls[0]!.command, "bash -c 'echo hello'");
});

test("createSharedExecBackend: empty agentSubdir (single shared agent) passes empty cwd to base backend", async () => {
  // When there is only one shared agent, computeCommonAncestor returns the agent's
  // own root, making agentSubdir="". The base backend receives cwd="" which
  // mapContainerCwd treats as falsy and maps to workspaceMount — correct behavior.
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "");

  await wrapped.exec("ls");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.options?.cwd,
    "",
    "empty agentSubdir with no caller cwd yields cwd='' (falsy → mapContainerCwd returns workspaceMount)",
  );
});

test("createSharedExecBackend: empty agentSubdir with caller cwd forwards the cwd unchanged", async () => {
  const { backend, calls } = mockBackend();
  const wrapped = createSharedExecBackend(backend, "");

  await wrapped.exec("ls", { cwd: "src/tools" });

  // path.posix.join("", "src/tools") === "src/tools"
  assert.equal(calls[0]!.options?.cwd, "src/tools");
});

// ---------------------------------------------------------------------------
// Routing wiring (§10 / §10a) — agent→backend dispatch does not cross-wire
// ---------------------------------------------------------------------------

test("routing §10: two strict agents wired to distinct backends are not mixed up", async () => {
  // Mirrors what app.ts does: each strict agent's SandboxManager is stored in
  // agentSandboxMap under the agent's name. resolveAgentSandbox(name) is a
  // Map.get(name) lookup — this test exercises the dispatch pattern.
  const { backend: backendA, calls: callsA } = mockBackend();
  const { backend: backendB, calls: callsB } = mockBackend();

  const routingMap = new Map<string, ExecBackend>([
    ["a", backendA],
    ["b", backendB],
  ]);

  await routingMap.get("a")!.exec("ls");
  assert.equal(callsA.length, 1, "exec for agent 'a' must land on backend A");
  assert.equal(callsB.length, 0, "exec for agent 'a' must NOT land on backend B");

  await routingMap.get("b")!.exec("pwd");
  assert.equal(callsA.length, 1, "exec for agent 'b' must NOT add to backend A");
  assert.equal(callsB.length, 1, "exec for agent 'b' must land on backend B");
});

test("routing §10: two shared-mode agents wired through distinct createSharedExecBackend wrappers are not mixed up", async () => {
  // Shared-mode agents share one SandboxManager but each has its own
  // createSharedExecBackend wrapper (different agentSubdir). This test ensures
  // the wrappers do not cross-contaminate — exec for agent 'rin' lands on the
  // underlying backend exactly once, and exec for agent 'miku' also lands on
  // the underlying backend exactly once (both use the same base, but the cwd
  // routing is per-wrapper and the call count accumulates on the shared base).
  const { backend: sharedBase, calls: baseCalls } = mockBackend();

  const rinBackend = createSharedExecBackend(sharedBase, "rin");
  const mikuBackend = createSharedExecBackend(sharedBase, "miku");

  const routingMap = new Map<string, ExecBackend>([
    ["rin", rinBackend],
    ["miku", mikuBackend],
  ]);

  await routingMap.get("rin")!.exec("ls");
  assert.equal(baseCalls.length, 1);
  assert.equal(baseCalls[0]!.options?.cwd, "rin", "rin's exec must use 'rin' as cwd prefix");

  await routingMap.get("miku")!.exec("pwd");
  assert.equal(baseCalls.length, 2);
  assert.equal(baseCalls[1]!.options?.cwd, "miku", "miku's exec must use 'miku' as cwd prefix");
});

test("routing §10: resolved backend for an unknown agent name is undefined", () => {
  // Agents with no sandbox backend simply have no bash/search_files tools.
  const routingMap = new Map<string, ExecBackend>();
  assert.equal(routingMap.get("no-sandbox-agent"), undefined);
});

// ---------------------------------------------------------------------------
// Browser routing (§10a) — config-level verification (no I/O)
// ---------------------------------------------------------------------------

test("validateAgentConfig §10a: global [browser] without profile_name alongside [agents] is valid", () => {
  // The [browser] block sets connection details (manager_url, auth_token) but
  // does NOT set profile_name — that lives in [agents.<name>.browser].
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin", browser: { profile_name: "profile-rin" } },
    },
    browser: { manager_url: "http://localhost:3000", auth_token: "tok" } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "global [browser] without profile_name alongside [agents] must be accepted",
  );
});

test("validateAgentConfig §10a: no browser blocks in agents mode is valid (browser tools simply absent)", () => {
  const config = minimalConfig({
    agents: {
      rin: { workspace_root: "/workspaces/rin" },
      miku: { workspace_root: "/workspaces/miku" },
    },
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "agents mode with no browser blocks must be accepted — agents just have no browser tools",
  );
});

// ---------------------------------------------------------------------------
// §10b: summaries_from validation (Phase 5c)
// ---------------------------------------------------------------------------

test("validateAgentConfig §10b: summaries_from self-reference is rejected", () => {
  const config = minimalConfig({
    agents: {
      miku: { workspace_root: "/workspaces/miku", summaries_from: "miku" } as any,
    },
  });
  assert.throws(
    () => validateAgentConfig(config),
    /self-reference/i,
    "agent that names itself as summaries_from must be rejected",
  );
});

test("validateAgentConfig §10b: summaries_from naming an undeclared donor is rejected", () => {
  const config = minimalConfig({
    agents: {
      miku: { workspace_root: "/workspaces/miku", summaries_from: "ghost" } as any,
    },
  });
  assert.throws(
    () => validateAgentConfig(config),
    /not declared|ghost/i,
    "undeclared donor in summaries_from must be rejected",
  );
});

test("validateAgentConfig §10b: summaries_from chain (donor itself mirrors) is rejected", () => {
  // donor has summaries_from so it is itself a secondary — a chain is forbidden.
  const config = minimalConfig({
    agents: {
      donor: { workspace_root: "/workspaces/donor", summaries_from: "root" } as any,
      root: { workspace_root: "/workspaces/root" } as any,
      miku: { workspace_root: "/workspaces/miku", summaries_from: "donor" } as any,
    },
  });
  assert.throws(
    () => validateAgentConfig(config),
    /chain/i,
    "chained summaries_from (donor itself mirrors) must be rejected",
  );
});

// ---------------------------------------------------------------------------
// Legacy passthrough (§4.2) — validateAgentConfig on configs without [agents]
// ---------------------------------------------------------------------------

test("validateAgentConfig legacy: config without [agents] passes without error", () => {
  const config = minimalConfig({
    workspace: { root_dir: "/workspaces/miku" } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "legacy config without [agents] must pass validateAgentConfig",
  );
});

test("validateAgentConfig legacy: global browser with profile_name and no [agents] is valid", () => {
  // In legacy mode, profile_name on [browser] is still the correct location.
  // validateAgentConfig should NOT reject it.
  const config = minimalConfig({
    workspace: { root_dir: "/workspaces/miku" } as any,
    browser: { profile_name: "miku", manager_url: "http://localhost:3000", auth_token: "tok" } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "global browser.profile_name in legacy mode must not be rejected",
  );
});

test("validateAgentConfig legacy: global sandbox config without [agents] is valid", () => {
  const config = minimalConfig({
    workspace: { root_dir: "/workspaces/miku" } as any,
    sandbox: {
      enabled: true,
      image: "mikuswarm-sandbox:24.04",
      container_name: "miku-sandbox",
      network: "mikuswarm-sandbox",
      workspace_mount: "/workspace",
      exec_timeout_ms: 30_000,
      max_output_bytes: 1_048_576,
    } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(config),
    "legacy config with global sandbox must be accepted",
  );
});
