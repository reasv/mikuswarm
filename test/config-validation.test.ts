import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";

// A complete, env-free config so loadConfig reaches structural + cross-field
// validation without tripping the "missing env var" guard. The
// `[observability.server]` block is appended per-test to exercise issue #5.
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
multimodal = false
max_tokens = 1024

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[workspace]
root_dir = "./workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"

[summarization]
enabled = false
`;

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-config-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: observability server enabled with blank auth_token is rejected (issue #5)", async () => {
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
auth_token = ""
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /auth_token|minLength|Invalid config/i,
      "empty auth_token must fail-fast when the server is enabled",
    );
  });
});

test("config: observability server enabled with whitespace-only auth_token is rejected (issue #5)", async () => {
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
auth_token = "   "
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /auth_token/i,
      "whitespace-only auth_token must fail-fast when the server is enabled",
    );
  });
});

test("config: observability server enabled with ABSENT auth_token is accepted (issue #5)", async () => {
  // Key absent = auth intentionally disabled (localhost-operator default).
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.observability?.server?.enabled, true);
    assert.equal(config.observability?.server?.auth_token, undefined);
  });
});

test("config: observability server enabled with a real auth_token is accepted (issue #5)", async () => {
  const toml = `${BASE_CONFIG}
[observability.server]
enabled = true
bind = "127.0.0.1"
port = 8799
auth_token = "sekret-token"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.observability?.server?.auth_token, "sekret-token");
  });
});

const SANDBOX_BLOCK = (mount: string) => `
[sandbox]
enabled = true
image = "mikuswarm-sandbox:24.04"
container_name = "mikuswarm-sandbox"
network = "mikuswarm-sandbox"
workspace_mount = "${mount}"
exec_timeout_ms = 120000
max_output_bytes = 1048576
`;

test("config: absent [sandbox] section is accepted", async () => {
  await withConfigDir(BASE_CONFIG, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.sandbox, undefined);
  });
});

test("config: valid enabled [sandbox] with absolute workspace_mount is accepted", async () => {
  await withConfigDir(`${BASE_CONFIG}${SANDBOX_BLOCK("/workspace")}`, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.sandbox?.enabled, true);
    assert.equal(config.sandbox?.workspace_mount, "/workspace");
  });
});

test("config: enabled [sandbox] with a relative workspace_mount is rejected", async () => {
  await withConfigDir(`${BASE_CONFIG}${SANDBOX_BLOCK("workspace")}`, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /workspace_mount must be an absolute path/,
    );
  });
});

// --- #10: numeric [retrieval] knobs are bounded in the schema ---

// Mirrors the values 00-defaults.toml ships. Every one must pass TypeBox validation,
// so the bounds added for issue #10 don't reject the shipped defaults.
const RETRIEVAL_DEFAULTS_BLOCK = `
[retrieval]
enabled = true
auto_retrieval = true

[retrieval.index]
worker_count = 1
max_retries = 3
embed_batch_size = 32
max_chunk_tokens = 512
fallback_chunk_tokens = 400
fallback_chunk_overlap = 80

[retrieval.query]
max_results = 6
min_score = 0.35
vector_weight = 0.7
text_weight = 0.3
candidate_multiplier = 4
mmr_enabled = false
mmr_lambda = 0.7
temporal_decay_enabled = true
temporal_decay_half_life_days = 45

[retrieval.auto]
max_results = 3
min_score = 0.45
max_tokens = 600
dedup_against_recency = true

[retrieval.embedding]
provider = "local"

[retrieval.embedding.local]
model = "bge-small-en-v1.5"
dim = 384
`;

test("config: shipped [retrieval] defaults pass schema validation (issue #10)", async () => {
  await withConfigDir(`${BASE_CONFIG}${RETRIEVAL_DEFAULTS_BLOCK}`, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.retrieval?.enabled, true);
    assert.equal(config.retrieval?.query?.candidate_multiplier, 4);
  });
});

// Each case fat-fingers ONE knob out of its bound; the schema must reject the load.
const OUT_OF_BOUNDS_CASES: Array<{ name: string; block: string }> = [
  { name: "candidate_multiplier above max", block: `[retrieval.query]\ncandidate_multiplier = 9999\n` },
  { name: "candidate_multiplier below min", block: `[retrieval.query]\ncandidate_multiplier = 0\n` },
  { name: "query max_results above max", block: `[retrieval.query]\nmax_results = 100000\n` },
  { name: "vector_weight above 1", block: `[retrieval.query]\nvector_weight = 5\n` },
  { name: "mmr_lambda above 1", block: `[retrieval.query]\nmmr_lambda = 2\n` },
  { name: "min_score above 1", block: `[retrieval.query]\nmin_score = 1.5\n` },
  { name: "temporal_decay_half_life_days below min", block: `[retrieval.query]\ntemporal_decay_half_life_days = 0\n` },
  { name: "worker_count above max", block: `[retrieval.index]\nworker_count = 100000\n` },
  { name: "embed_batch_size below min", block: `[retrieval.index]\nembed_batch_size = 0\n` },
  { name: "max_chunk_tokens below floor", block: `[retrieval.index]\nmax_chunk_tokens = 1\n` },
  { name: "auto max_tokens below min", block: `[retrieval.auto]\nmax_tokens = 0\n` },
];

for (const { name, block } of OUT_OF_BOUNDS_CASES) {
  test(`config: out-of-bounds [retrieval] knob rejected — ${name} (issue #10)`, async () => {
    const toml = `${BASE_CONFIG}
[retrieval]
enabled = true

${block}`;
    await withConfigDir(toml, async (dir) => {
      await assert.rejects(
        () => loadConfig(dir, { env: false }),
        /Invalid config|minimum|maximum/i,
        `${name} must fail TypeBox validation at load`,
      );
    });
  });
}

// --- #7: numeric [search] knobs are bounded in the schema ---

// Mirrors the values 00-defaults.toml ships for [search]. All must pass so the maxima
// added for issue #7 don't reject the shipped defaults.
const SEARCH_DEFAULTS_BLOCK = `
[search]
absence_gap_ms = 10800000
default_lookback_ms = 86400000
recap_budget_tokens = 6000
`;

test("config: shipped [search] defaults pass schema validation (issue #7)", async () => {
  await withConfigDir(`${BASE_CONFIG}${SEARCH_DEFAULTS_BLOCK}`, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.search?.absence_gap_ms, 10_800_000);
    assert.equal(config.search?.recap_budget_tokens, 6000);
  });
});

// Each case fat-fingers ONE [search] knob out of its bound; the schema must reject it.
// 2_592_000_000 = SEARCH_HORIZON_MS (30 days); 100_000 = recap_budget_tokens max.
const SEARCH_OUT_OF_BOUNDS_CASES: Array<{ name: string; block: string }> = [
  { name: "absence_gap_ms below min", block: `[search]\nabsence_gap_ms = 1\n` },
  { name: "absence_gap_ms above horizon", block: `[search]\nabsence_gap_ms = 2592000001\n` },
  { name: "default_lookback_ms below min", block: `[search]\ndefault_lookback_ms = 0\n` },
  { name: "default_lookback_ms above horizon", block: `[search]\ndefault_lookback_ms = 2592000001\n` },
  { name: "recap_budget_tokens below min", block: `[search]\nrecap_budget_tokens = 100\n` },
  { name: "recap_budget_tokens above max", block: `[search]\nrecap_budget_tokens = 100001\n` },
];

for (const { name, block } of SEARCH_OUT_OF_BOUNDS_CASES) {
  test(`config: out-of-bounds [search] knob rejected — ${name} (issue #7)`, async () => {
    const toml = `${BASE_CONFIG}
${block}`;
    await withConfigDir(toml, async (dir) => {
      await assert.rejects(
        () => loadConfig(dir, { env: false }),
        /Invalid config|minimum|maximum/i,
        `${name} must fail TypeBox validation at load`,
      );
    });
  });
}

// --- #18: [browser] fail-fast validation (parity with the observability guard) ---

// A structurally-complete enabled [browser] block. `auth_token` and
// `manager_url` are interpolated so each test can exercise the present-but-blank
// / absent-token guard and the manager_url scheme guard (loader.ts validateConfig).
const BROWSER_BLOCK = (opts: { authTokenLine: string; managerUrl: string }) => `
[browser]
enabled = true
manager_url = "${opts.managerUrl}"
${opts.authTokenLine}
profile_name = "miku"
platform = "windows"
humanize = true
evaluate_enabled = false
geoip = false
dialog_policy = "dismiss"
snapshot_max_chars = 20000
nav_timeout_ms = 30000
act_timeout_ms = 15000
connect_timeout_ms = 20000
session_page_idle_ms = 600000
`;

const VALID_MANAGER_URL = "http://127.0.0.1:8080";

test("config: browser enabled with blank auth_token is rejected (issue #18)", async () => {
  const toml = `${BASE_CONFIG}${BROWSER_BLOCK({ authTokenLine: `auth_token = ""`, managerUrl: VALID_MANAGER_URL })}`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /auth_token|minLength|Invalid config/i,
      "empty auth_token must fail-fast when the browser is enabled",
    );
  });
});

test("config: browser enabled with whitespace-only auth_token is rejected (issue #18)", async () => {
  const toml = `${BASE_CONFIG}${BROWSER_BLOCK({ authTokenLine: `auth_token = "  "`, managerUrl: VALID_MANAGER_URL })}`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /auth_token/i,
      "whitespace-only auth_token must fail-fast when the browser is enabled",
    );
  });
});

test("config: browser enabled with ABSENT auth_token is accepted (token-less Manager) (issue #18)", async () => {
  // Key absent = the Manager runs token-less (localhost isolation) — allowed.
  const toml = `${BASE_CONFIG}${BROWSER_BLOCK({ authTokenLine: "", managerUrl: VALID_MANAGER_URL })}`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.browser?.enabled, true);
    assert.equal(config.browser?.auth_token, undefined);
  });
});

test("config: browser enabled with a real auth_token is accepted (issue #18)", async () => {
  const toml = `${BASE_CONFIG}${BROWSER_BLOCK({ authTokenLine: `auth_token = "sekret-token"`, managerUrl: VALID_MANAGER_URL })}`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.browser?.auth_token, "sekret-token");
  });
});

// manager_url must be an absolute http(s) URL the harness can connect to.
const BAD_MANAGER_URLS: Array<{ name: string; url: string }> = [
  { name: "bare host:port (no scheme)", url: "localhost:8080" },
  { name: "scheme-relative path", url: "/foo" },
  { name: "non-http(s) scheme", url: "ftp://x" },
];

for (const { name, url } of BAD_MANAGER_URLS) {
  test(`config: browser enabled with invalid manager_url rejected — ${name} (issue #18)`, async () => {
    const toml = `${BASE_CONFIG}${BROWSER_BLOCK({ authTokenLine: `auth_token = "t"`, managerUrl: url })}`;
    await withConfigDir(toml, async (dir) => {
      await assert.rejects(
        () => loadConfig(dir, { env: false }),
        /manager_url must be an absolute http\(s\) URL/i,
        `${name} must fail-fast when the browser is enabled`,
      );
    });
  });
}

test("config: browser enabled with a valid http manager_url is accepted (issue #18)", async () => {
  const toml = `${BASE_CONFIG}${BROWSER_BLOCK({ authTokenLine: `auth_token = "t"`, managerUrl: "http://127.0.0.1:8080" })}`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.browser?.manager_url, "http://127.0.0.1:8080");
  });
});

// --- #23: shipped [browser] defaults pass schema validation ---

// Mirrors the values config/00-defaults.toml ships in its [browser] block (with
// enabled flipped on + an auth_token so the fail-fast guard is satisfied). Every
// numeric knob must pass TypeBox validation, so the schema floors raised for the
// idle-sweeper hardening (session_page_idle_ms ≥ 30000, *_timeout_ms ≥ 1000) and
// snapshot_max_chars ≥ 1000 don't reject the defaults the project actually ships.
// If a default ever violates a `minimum:` bound this load fails loudly.
const BROWSER_DEFAULTS_BLOCK = `
[browser]
enabled = true
manager_url = "http://127.0.0.1:8080"
auth_token = "t"
profile_name = "miku"
platform = "windows"
fingerprint_seed = 0
humanize = true
evaluate_enabled = false
proxy = ""
geoip = false
dialog_policy = "dismiss"
snapshot_max_chars = 20000
nav_timeout_ms = 30000
act_timeout_ms = 15000
connect_timeout_ms = 20000
session_page_idle_ms = 600000
`;

test("config: shipped [browser] defaults pass schema validation (issue #23)", async () => {
  await withConfigDir(`${BASE_CONFIG}${BROWSER_DEFAULTS_BLOCK}`, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.browser?.enabled, true);
    // Spot-check the knobs guarded by the raised schema floors.
    assert.equal(config.browser?.session_page_idle_ms, 600000);
    assert.equal(config.browser?.nav_timeout_ms, 30000);
    assert.equal(config.browser?.act_timeout_ms, 15000);
    assert.equal(config.browser?.connect_timeout_ms, 20000);
    assert.equal(config.browser?.snapshot_max_chars, 20000);
  });
});

// Each case fat-fingers ONE [browser] knob below its schema floor; the load must
// be rejected. These directly guard the idle-sweeper schema floors. We rewrite
// the value in the otherwise-valid defaults block (no duplicate key) so only the
// schema bound — not a TOML parse error — can be the cause of rejection.
const BROWSER_OUT_OF_BOUNDS_CASES: Array<{ name: string; find: string; replace: string }> = [
  { name: "session_page_idle_ms below the sweep-interval floor (30000)", find: "session_page_idle_ms = 600000", replace: "session_page_idle_ms = 29999" },
  { name: "nav_timeout_ms below floor (1000)", find: "nav_timeout_ms = 30000", replace: "nav_timeout_ms = 999" },
  { name: "act_timeout_ms below floor (1000)", find: "act_timeout_ms = 15000", replace: "act_timeout_ms = 0" },
  { name: "connect_timeout_ms below floor (1000)", find: "connect_timeout_ms = 20000", replace: "connect_timeout_ms = 999" },
  { name: "snapshot_max_chars below floor (1000)", find: "snapshot_max_chars = 20000", replace: "snapshot_max_chars = 999" },
];

for (const { name, find, replace } of BROWSER_OUT_OF_BOUNDS_CASES) {
  test(`config: out-of-bounds [browser] knob rejected — ${name} (issue #23)`, async () => {
    const browserBlock = BROWSER_DEFAULTS_BLOCK.replace(find, replace);
    assert.ok(browserBlock.includes(replace), "precondition: the bad value was substituted in");
    const toml = `${BASE_CONFIG}${browserBlock}`;
    await withConfigDir(toml, async (dir) => {
      await assert.rejects(
        () => loadConfig(dir, { env: false }),
        /Invalid config|minimum|maximum/i,
        `${name} must fail TypeBox validation at load`,
      );
    });
  });
}
