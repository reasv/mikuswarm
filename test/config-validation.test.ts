import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { assertFollowupConfigValid, validateModelFallbackChains } from "../src/app.ts";

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
input_modalities = ["text"]
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

// Like withConfigDir but writes several files; loadConfig merges them in ascending
// filename order (00 → 90 → …).
async function withConfigDirs(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-config-"));
  try {
    for (const [name, toml] of Object.entries(files)) {
      await writeFile(path.join(dir, name), toml, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("config: layers deep-merge — local overrides a field and inherits omitted siblings", async () => {
  // 90 redefines [agent.sessions] with only ONE field. Under the old shallow
  // top-level merge the whole `agent` subtree was replaced, dropping the sibling
  // session knobs (the resume/followup silent-drop foot-gun). Deep merge keeps them.
  const override = `
[agent.sessions]
max_concurrent = 5
`;
  await withConfigDirs(
    { "00-base.toml": BASE_CONFIG, "90-over.toml": override },
    async (dir) => {
      const config = await loadConfig(dir, { env: false });
      assert.equal(config.agent.sessions.max_concurrent, 5); // override wins
      assert.equal(config.agent.sessions.max_concurrent_dm, 1); // inherited from base
      assert.equal(config.agent.sessions.forced_completion_retries, 0); // inherited from base
    },
  );
});

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

// Mirrors the [agent.tools.dynamic] block 00-defaults.toml ships (spec
// DYNAMIC-TOOL-LOADING). Must pass validation and round-trip its values.
const DYNAMIC_TOOLS_DEFAULTS_BLOCK = `
[agent.tools.dynamic]
enabled = true
immediate = [
  "send_message",
  "react",
  "read_messages",
  "search_messages",
  "web_fetch",
  "web_search",
  "str_replace_based_edit_tool",
  "search_files",
  "recall_memory",
  "search_memory",
  "read_memory",
  "write_memory",
]
index = "orphans"
`;

test("config: shipped [agent.tools.dynamic] defaults pass schema validation", async () => {
  await withConfigDir(`${BASE_CONFIG}${DYNAMIC_TOOLS_DEFAULTS_BLOCK}`, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agent.tools?.dynamic?.enabled, true);
    assert.equal(config.agent.tools?.dynamic?.index, "orphans");
    assert.ok(config.agent.tools?.dynamic?.immediate?.includes("send_message"));
  });
});

test("config: [agent.tools.dynamic] rejects an unknown index mode", async () => {
  await withConfigDir(
    `${BASE_CONFIG}\n[agent.tools.dynamic]\nindex = "everything"\n`,
    async (dir) => {
      await assert.rejects(() => loadConfig(dir, { env: false }));
    },
  );
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
snapshot_max_frames = 10
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
snapshot_max_frames = 10
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
  { name: "snapshot_max_frames above ceiling (256)", find: "snapshot_max_frames = 10", replace: "snapshot_max_frames = 257" },
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

// --- #9: shipped [agent.sessions.followup] defaults pass schema + cross-field validation ---

// Mirrors the values config/00-defaults.toml ships in its [agent.sessions.followup]
// block (spec FOLLOWUP-FOLDING §9): media 10s/30s, text 7s/15s, mention 5s/12s, all
// enabled. Every lever must pass TypeBox validation AND `assertFollowupConfigValid`
// (the app-wiring cross-field guard, which rejects wall_clock_ms < user_gap_ms and a
// user_gap_ms with no wall_clock_ms). A future defaults drift — e.g. dropping a
// `wall_clock_ms` — must fail THIS test, not only fail at boot.
const FOLLOWUP_DEFAULTS_BLOCK = `
[agent.sessions.followup.media]
enabled = true
user_gap_ms = 10000
wall_clock_ms = 30000

[agent.sessions.followup.text]
enabled = true
user_gap_ms = 7000
wall_clock_ms = 15000

[agent.sessions.followup.mention]
enabled = true
user_gap_ms = 5000
wall_clock_ms = 12000
`;

test("config: shipped-shape [agent.sessions.followup] defaults pass schema validation (issue #9)", async () => {
  await withConfigDir(`${BASE_CONFIG}${FOLLOWUP_DEFAULTS_BLOCK}`, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    const followup = config.agent.sessions.followup;
    assert.ok(followup, "the [agent.sessions.followup] block is present");
    // Exact spec-§9 values, all three levers.
    assert.deepEqual(followup?.media, { enabled: true, user_gap_ms: 10_000, wall_clock_ms: 30_000 });
    assert.deepEqual(followup?.text, { enabled: true, user_gap_ms: 7_000, wall_clock_ms: 15_000 });
    assert.deepEqual(followup?.mention, { enabled: true, user_gap_ms: 5_000, wall_clock_ms: 12_000 });
    // The shipped block must also clear the app-wiring cross-field guard.
    assert.doesNotThrow(() => assertFollowupConfigValid(followup));
  });
});

// Each case fat-fingers ONE followup lever so `assertFollowupConfigValid` rejects it,
// guarding the cross-field invariants the schema alone can't (wall_clock vs user_gap,
// and the dead-lever partial). The schema accepts these (both are Type.Optional
// non-negative integers); the app-wiring guard is what must reject them.
const FOLLOWUP_INVALID_CASES: Array<{ name: string; find: string; replace: string; error: RegExp }> = [
  {
    name: "media wall_clock_ms below its user_gap_ms",
    find: "user_gap_ms = 10000\nwall_clock_ms = 30000",
    replace: "user_gap_ms = 10000\nwall_clock_ms = 5000",
    error: /wall_clock_ms \(5000\) must be >= user_gap_ms \(10000\)/,
  },
  {
    name: "text user_gap_ms with wall_clock_ms dropped (dead lever)",
    find: "user_gap_ms = 7000\nwall_clock_ms = 15000",
    replace: "user_gap_ms = 7000",
    error: /user_gap_ms is set but wall_clock_ms is missing/,
  },
];

for (const { name, find, replace, error } of FOLLOWUP_INVALID_CASES) {
  test(`config: invalid [agent.sessions.followup] rejected by cross-field guard — ${name} (issue #9)`, async () => {
    const block = FOLLOWUP_DEFAULTS_BLOCK.replace(find, replace);
    assert.ok(block.includes(replace), "precondition: the bad value was substituted in");
    await withConfigDir(`${BASE_CONFIG}${block}`, async (dir) => {
      // The schema admits the partial/inverted block; the cross-field guard rejects it.
      const config = await loadConfig(dir, { env: false });
      assert.throws(() => assertFollowupConfigValid(config.agent.sessions.followup), error);
    });
  });
}

test("config: [reactions] block parses and exposes its knobs", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
enabled = true
show_aggregates = false
show_discrete = true
discrete_assistant_only = false
discrete_horizon_messages = 5
discrete_other_horizon_messages = 8
discrete_split_messages = 4
discrete_split_minutes = 20
discrete_name_cap = 12
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.reactions?.enabled, true);
    assert.equal(config.reactions?.show_aggregates, false);
    assert.equal(config.reactions?.discrete_assistant_only, false);
    assert.equal(config.reactions?.discrete_horizon_messages, 5);
    assert.equal(config.reactions?.discrete_other_horizon_messages, 8);
    assert.equal(config.reactions?.discrete_split_messages, 4);
    assert.equal(config.reactions?.discrete_split_minutes, 20);
    assert.equal(config.reactions?.discrete_name_cap, 12);
  });
});

test("config: [reactions] discrete_split_messages below 1 is rejected", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
discrete_split_messages = 0
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /Invalid config|minimum/i);
  });
});

test("config: [reactions] discrete_split_minutes below 1 is rejected", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
discrete_split_minutes = 0
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /Invalid config|minimum/i);
  });
});

test("config: [reactions] discrete_split_messages above the maximum is rejected", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
discrete_split_messages = 100001
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /Invalid config|maximum/i);
  });
});

test("config: [reactions] negative discrete_other_horizon_messages is rejected", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
discrete_other_horizon_messages = -1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /Invalid config|minimum/i);
  });
});

test("config: [reactions] discrete_name_cap below 4 is rejected", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
discrete_name_cap = 2
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /Invalid config|minimum/i,
      "name cap below the shown-name count (4) must fail-fast",
    );
  });
});

test("config: [reactions] negative discrete_horizon_messages is rejected", async () => {
  const toml = `${BASE_CONFIG}
[reactions]
discrete_horizon_messages = -1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /Invalid config|minimum/i);
  });
});

// --- #29 (decision E): strict validation — unknown config keys fail-fast ---

// Temporarily set env vars (restoring on exit) so shipped TOMLs that reference
// `${...}` placeholders can be loaded without a .env file.
async function withEnv(
  vars: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("config: unknown TOP-LEVEL section is rejected with a path-naming error (issue #29)", async () => {
  const toml = `${BASE_CONFIG}
[nonsense]
foo = 1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /nonsense is not a recognized config key/,
      "an unknown top-level table must fail-fast, naming the offending path",
    );
  });
});

// Nested unknown keys — including exactly the stale knobs that motivated the
// issue (enrichment.fetch_concurrency, summarization.summary_wait_timeout_ms)
// and the removed captioning per-modality `concurrency` alias.
const UNKNOWN_KEY_CASES: Array<{ name: string; block: string; path: string }> = [
  { name: "stale enrichment.fetch_concurrency", block: `[enrichment]\nfetch_concurrency = 6\n`, path: "enrichment\\.fetch_concurrency" },
  { name: "removed captioning image concurrency alias", block: `[captioning.image]\nconcurrency = 2\n`, path: "captioning\\.image\\.concurrency" },
  { name: "removed captioning audio concurrency alias", block: `[captioning.audio]\nconcurrency = 1\n`, path: "captioning\\.audio\\.concurrency" },
  { name: "typo in [observability.server]", block: `[observability.server]\nenabled = false\nbind = "127.0.0.1"\nport = 8799\nporrt = 8800\n`, path: "observability\\.server\\.porrt" },
  { name: "deeply nested typo in [retrieval.query]", block: `[retrieval.query]\nmax_resuts = 6\n`, path: "retrieval\\.query\\.max_resuts" },
];

// The removed summarization knob needs its key INSIDE the [summarization] table
// BASE_CONFIG already defines (TOML forbids redefining a table).
test("config: unknown nested key rejected — stale summarization.summary_wait_timeout_ms (issue #29)", async () => {
  const toml = BASE_CONFIG.replace(
    "[summarization]\nenabled = false",
    "[summarization]\nenabled = false\nsummary_wait_timeout_ms = 1000",
  );
  assert.ok(toml.includes("summary_wait_timeout_ms"), "precondition: the stale knob was injected");
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /summarization\.summary_wait_timeout_ms is not a recognized config key/,
    );
  });
});

for (const { name, block, path: keyPath } of UNKNOWN_KEY_CASES) {
  test(`config: unknown nested key rejected — ${name} (issue #29)`, async () => {
    const toml = `${BASE_CONFIG}
${block}`;
    await withConfigDir(toml, async (dir) => {
      await assert.rejects(
        () => loadConfig(dir, { env: false }),
        new RegExp(`${keyPath} is not a recognized config key`),
        `${name} must fail-fast with an error naming the offending path`,
      );
    });
  });
}

// Unknown keys inside a DICTIONARY-valued section's VALUE: the dictionary level
// accepts arbitrary names (model names, session-type names, rate-limit group
// names, matrix account names), but each value object is still strict.
const DICT_VALUE_UNKNOWN_KEY_CASES: Array<{ name: string; block: string; path: string }> = [
  { name: "[rate_limits.llm.<group>] max_rpm (deliberately unsupported)", block: `[rate_limits.llm.openrouter]\nmax_in_flight = 16\nmax_rpm = 60\n`, path: "rate_limits\\.llm\\.openrouter\\.max_rpm" },
  { name: "[agent.session_types.<type>] bogus knob", block: `[agent.session_types.custom]\nmodel = "default"\nbogus_knob = 1\n`, path: "agent\\.session_types\\.custom\\.bogus_knob" },
  { name: "[models.<name>] bogus knob", block: `[models.alt]\nid = "m"\nprovider = "test"\nendpoint = "http://localhost"\napi_key = "k"\ninput_modalities = ["text"]\nmax_tokens = 1024\nbogus = true\n`, path: "models\\.alt\\.bogus" },
  { name: "[matrix.accounts.<name>] bogus knob", block: `[matrix.accounts.second]\nhomeserver = "http://localhost"\nuser_id = "@x:localhost"\nstore_path = "./var/x"\nbogus = "y"\n`, path: "matrix\\.accounts\\.second\\.bogus" },
];

for (const { name, block, path: keyPath } of DICT_VALUE_UNKNOWN_KEY_CASES) {
  test(`config: unknown key inside a dictionary VALUE rejected — ${name} (issue #29)`, async () => {
    const toml = `${BASE_CONFIG}
${block}`;
    await withConfigDir(toml, async (dir) => {
      await assert.rejects(
        () => loadConfig(dir, { env: false }),
        new RegExp(`${keyPath} is not a recognized config key`),
        `${name} must fail-fast with an error naming the offending path`,
      );
    });
  });
}

test("config: dictionary sections still accept arbitrary names at the dictionary level (issue #29)", async () => {
  const toml = `${BASE_CONFIG}
[models.fancy_alt_model]
id = "alt"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text"]
max_tokens = 512

[agent.session_types.totally_custom_type]
model = "fancy_alt_model"
priority = "background"

[rate_limits.llm.openrouter]
max_in_flight = 16

[matrix.accounts.second]
homeserver = "http://localhost"
user_id = "@second:localhost"
store_path = "./var/second"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal((config.models as Record<string, { id: string }>).fancy_alt_model.id, "alt");
    assert.equal(config.agent.session_types?.totally_custom_type?.priority, "background");
    assert.equal(config.rate_limits?.llm?.openrouter?.max_in_flight, 16);
    assert.equal(config.matrix.accounts.second?.user_id, "@second:localhost");
  });
});

// The env vars the shipped TOMLs reference via ${...} placeholders.
const SHIPPED_TOML_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: "http://localhost/anthropic",
  OPENROUTER_BASE_URL: "http://localhost/openrouter",
  GEMINI_BASE_URL: "http://localhost/google",
  LLM_API_KEY: "test-key",
  MATRIX_HOMESERVER: "http://localhost",
  MATRIX_ACCESS_TOKEN: "tok",
  MATRIX_PASSWORD: "pw",
  MATRIX_RECOVERY_KEY: "rk",
  MATRIX_USER_ID: "@miku:localhost",
  MATRIX_DEVICE_ID: "DEV",
  MIKUSWARM_CONSOLE_TOKEN: "console-token",
};

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("config: shipped config/00-defaults.toml validates under strict unknown-key checking (issue #29)", async () => {
  // Copy ONLY the shipped defaults into a temp dir: loading the repo's
  // config/ directory directly would lexicographically merge any git-ignored
  // local deployment overlay (e.g. config/90-local.toml) into the load,
  // coupling this test to the developer's machine.
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-config-defaults-"));
  try {
    await copyFile(path.join(REPO_ROOT, "config", "00-defaults.toml"), path.join(dir, "00-defaults.toml"));
    await withEnv(SHIPPED_TOML_ENV, async () => {
      const config = await loadConfig(dir, { env: false });
      assert.equal(config.app.name, "mikuswarm");
      assert.equal(config.captioning?.worker_count, 2);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config: REAL config/00-defaults.toml ships the exact §9 follow-up defaults (issue #9)", async () => {
  // Loads the ACTUAL shipped file (not a hand-mirrored block) and asserts the
  // [agent.sessions.followup] defaults are present, exactly spec-§9, and clear the
  // cross-field guard. This is the test that catches a drift in the file itself — a
  // dropped `wall_clock_ms` (silently inert lever) or an inverted window would fail
  // here rather than only at boot. Copy ONLY the defaults so a git-ignored local
  // overlay (config/90-local.toml) can't perturb the load (same rationale as #29).
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-config-followup-"));
  try {
    await copyFile(path.join(REPO_ROOT, "config", "00-defaults.toml"), path.join(dir, "00-defaults.toml"));
    await withEnv(SHIPPED_TOML_ENV, async () => {
      const config = await loadConfig(dir, { env: false });
      const followup = config.agent.sessions.followup;
      assert.ok(followup, "the shipped defaults include [agent.sessions.followup]");
      assert.deepEqual(followup?.media, { enabled: true, user_gap_ms: 10_000, wall_clock_ms: 30_000 });
      assert.deepEqual(followup?.text, { enabled: true, user_gap_ms: 7_000, wall_clock_ms: 15_000 });
      assert.deepEqual(followup?.mention, { enabled: true, user_gap_ms: 5_000, wall_clock_ms: 12_000 });
      // The shipped block must clear the app-wiring cross-field guard (the boot check).
      assert.doesNotThrow(() => assertFollowupConfigValid(followup));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config: shipped docker/95-docker.toml overlay validates under strict unknown-key checking (issue #29)", async () => {
  // The overlay is merged on top of the defaults exactly as the agent image
  // does (lexicographic order: 00-defaults.toml < 95-docker.toml).
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-config-docker-"));
  try {
    await copyFile(path.join(REPO_ROOT, "config", "00-defaults.toml"), path.join(dir, "00-defaults.toml"));
    await copyFile(path.join(REPO_ROOT, "docker", "95-docker.toml"), path.join(dir, "95-docker.toml"));
    await withEnv(SHIPPED_TOML_ENV, async () => {
      const config = await loadConfig(dir, { env: false });
      assert.equal(config.sandbox?.enabled, true);
      assert.equal(config.network?.ssrf_guard, false);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config: models thinking_level accepts a valid level", async () => {
  const toml = `${BASE_CONFIG}
[models.thinky]
id = "test-model-2"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
reasoning = true
thinking_level = "medium"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.models.thinky.thinking_level, "medium");
    // Unset stays unset (= off) on the base model.
    assert.equal(config.models.default.thinking_level, undefined);
  });
});

test("config: models thinking_level rejects an unknown level", async () => {
  const toml = `${BASE_CONFIG}
[models.thinky]
id = "test-model-2"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
thinking_level = "maximum"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /thinking_level|Invalid config/i,
      "an out-of-enum thinking_level must fail schema validation",
    );
  });
});

// --- Model inheritance + fallback (spec MODEL-FALLBACK §2.1) ---

test("config: a virtual model inherits its parent's connection fields and overrides only its own", async () => {
  const toml = `${BASE_CONFIG}
[models.caption-cheap]
inherits = "default"
[models.caption-premium]
inherits = "default"
fallback = ["caption-cheap"]
context_window = 64000
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    const premium = config.models["caption-premium"]!;
    // Inherited from default:
    assert.equal(premium.id, "test-model");
    assert.equal(premium.endpoint, "http://localhost");
    assert.equal(premium.api_key, "test-key");
    // Own overrides:
    assert.equal(premium.context_window, 64000);
    assert.deepEqual(premium.fallback, ["caption-cheap"]);
    // `inherits` is stripped after resolution.
    assert.equal((premium as Record<string, unknown>).inherits, undefined);
  });
});

test("config: transitive inheritance resolves through a chain", async () => {
  const toml = `${BASE_CONFIG}
[models.mid]
inherits = "default"
max_tokens = 4096
[models.leaf]
inherits = "mid"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    const leaf = config.models["leaf"]!;
    assert.equal(leaf.id, "test-model"); // from default
    assert.equal(leaf.max_tokens, 4096); // from mid
  });
});

test("config: an inheritance cycle fails fast", async () => {
  const toml = `${BASE_CONFIG}
[models.a]
inherits = "b"
[models.b]
inherits = "a"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /inheritance cycle/i);
  });
});

test("config: inheriting an unknown model fails fast", async () => {
  const toml = `${BASE_CONFIG}
[models.orphan]
inherits = "nope"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(() => loadConfig(dir, { env: false }), /inherits unknown model "nope"/i);
  });
});

// ---------------------------------------------------------------------------
// Issue #1 (+ folds #8, + the dangling-at-load half of #17): a dangling
// `fallback` reference is NOT caught by loadConfig (schema/inheritance only
// validate `inherits`; `fallback` names are resolved later by
// `resolveModelChain`). Without an eager boot-time sweep the agent path resolves
// session-type chains LAZILY, so the typo would only surface on the first live
// trigger. `validateModelFallbackChains` sweeps the WHOLE registry at startup so
// EVERY chain — referenced or not — is validated (the #8 fold).
// ---------------------------------------------------------------------------

test("config: dangling fallback on [models.default] is rejected at wiring (issue #1)", async () => {
  const toml = `${BASE_CONFIG.replace(
    "[models.default]\nid = \"test-model\"",
    "[models.default]\nfallback = [\"typo\"]\nid = \"test-model\"",
  )}`;
  await withConfigDir(toml, async (dir) => {
    // loadConfig accepts it (a `fallback` array of strings is schema-valid)…
    const config = await loadConfig(dir, { env: false });
    // …the wiring-time chain sweep rejects it with a naming error.
    assert.throws(
      () => validateModelFallbackChains(config),
      /default.*fallback references unknown model "typo"/,
      "a dangling fallback on the default model must fail-fast at wiring",
    );
  });
});

test("config: dangling fallback on a session-type model is rejected at wiring (issue #1)", async () => {
  const toml = `${BASE_CONFIG}
[models.chat]
inherits = "default"
fallback = ["does-not-exist"]

[agent.session_types.default]
model = "chat"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.throws(
      () => validateModelFallbackChains(config),
      /chat.*fallback references unknown model "does-not-exist"/,
    );
  });
});

test("config: dangling fallback on an UNREFERENCED model is rejected at wiring (issue #1 / #8)", async () => {
  // `unused` is referenced by no session type / consumer — the whole-registry
  // sweep is what catches its dangling chain (the #8 fold).
  const toml = `${BASE_CONFIG}
[models.unused]
inherits = "default"
fallback = ["ghost"]
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.throws(
      () => validateModelFallbackChains(config),
      /unused.*fallback references unknown model "ghost"/,
    );
  });
});

test("config: a valid fallback chain passes the wiring sweep (issue #1)", async () => {
  const toml = `${BASE_CONFIG}
[models.cheap]
inherits = "default"

[models.premium]
inherits = "default"
fallback = ["cheap"]
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    // A real chain + the no-fallback models (default/cheap/premium) all resolve.
    assert.doesNotThrow(() => validateModelFallbackChains(config));
  });
});

// ---------------------------------------------------------------------------
// Issue #15: the unified-registry migration (spec MODEL-FALLBACK §2.3) made the
// reference fields point at a `[models.*]` block NAME and removed the old inline
// forms. An operator who left the OLD config in place must fail-fast, not run
// silently — each stale form below must be rejected by loadConfig.
// ---------------------------------------------------------------------------

test("config: old inline [captioning.model] TABLE form is rejected (issue #15)", async () => {
  // `model` is now a [models.*] block NAME (a string); the old inline table
  // (id/endpoint/api_key/...) is a type mismatch.
  const toml = `${BASE_CONFIG}
[captioning]
[captioning.model]
id = "google/gemini-3.5-flash"
endpoint = "http://localhost"
api_key = "k"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /captioning\/model|Expected string|Invalid config/i,
      "the old inline [captioning.model] table must fail-fast",
    );
  });
});

test("config: old [x_search.cost] table form is rejected (issue #15)", async () => {
  // Pricing moved onto the referenced [models.*] block; [x_search.cost] is gone.
  const toml = `${BASE_CONFIG}
[x_search]
model = "default"
[x_search.cost]
input = 1
output = 2
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /x_search\.cost|not a recognized config key/i,
      "the old [x_search.cost] table must fail-fast",
    );
  });
});

test("config: old [image_gen.costs.*] per-tier cost form is rejected (issue #15)", async () => {
  // Per-tier pricing moved onto each referenced [models.*] block; the old
  // [image_gen.costs.<tier>] keys are gone.
  const toml = `${BASE_CONFIG}
[image_gen]
[image_gen.models]
pro = "default"
[image_gen.costs.pro]
per_image = 0.01
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /image_gen\.costs|not a recognized config key/i,
      "the old [image_gen.costs.*] per-tier cost keys must fail-fast",
    );
  });
});

test("config: old retrieval.embedding.remote.cost_per_mtok form is rejected (issue #15)", async () => {
  // Pricing moved onto the referenced [models.*] block ([cost].input); the old
  // inline cost_per_mtok key is gone.
  const toml = `${BASE_CONFIG}
[retrieval.embedding.remote]
model = "default"
dim = 1536
cost_per_mtok = 0.1
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /cost_per_mtok|not a recognized config key/i,
      "the old retrieval.embedding.remote.cost_per_mtok key must fail-fast",
    );
  });
});

// spec MODEL-FALLBACK §3 (issue #3): `input_modalities` replaces the old
// `multimodal` boolean as the capability predicate. A multi-element set validates
// and round-trips; an unknown modality value, a non-array value, and a missing
// field are all rejected (the field is required, mirroring the explicit-config
// convention `multimodal` had).
test("config: input_modalities multi-element set validates and round-trips (issue #3)", async () => {
  const toml = `${BASE_CONFIG}
[models.caption_alt]
id = "cap"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text", "image", "video", "audio"]
max_tokens = 1024
context_window = 128000
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.deepEqual(config.models.caption_alt.input_modalities, ["text", "image", "video", "audio"]);
    // The default model from BASE_CONFIG stays text-only.
    assert.deepEqual(config.models.default.input_modalities, ["text"]);
  });
});

test("config: input_modalities rejects an unknown modality value (issue #3)", async () => {
  const toml = `${BASE_CONFIG}
[models.bad_modality]
id = "m"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text", "hologram"]
max_tokens = 1024
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /input_modalities|Invalid config/i,
      "an unknown modality literal must fail-fast",
    );
  });
});

test("config: input_modalities is required on a model block (issue #3)", async () => {
  const toml = `${BASE_CONFIG}
[models.no_modality]
id = "m"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
max_tokens = 1024
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /input_modalities|Invalid config/i,
      "a model block missing input_modalities must fail-fast",
    );
  });
});
