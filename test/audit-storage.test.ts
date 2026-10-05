/**
 * Offline audit storage and config (spec REFUSAL-HANDLING §7.6, §10.2;
 * DECISION-MODEL §5.8): `session_audits` in the v26→v27 slot (fresh and migrated
 * shapes equal, idempotent), its writes and the audit queue query, the
 * `[decisions.audit]` point, and the decision engine's `audit` ledger class.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { auditKnobs } from "../src/audit/config.js";
import { loadConfig } from "../src/config/index.js";
import {
  DecisionClient,
  DecisionEngine,
  anyDecisionPointEnabled,
  decisionsFor,
  pointSettings,
  validateDecisionsConfig,
} from "../src/decisions/index.js";
import { contractAuditPoint } from "../src/audit/contract-audit.js";
import { LATEST_SCHEMA_VERSION, Storage, type UsageEventInput } from "../src/storage/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-audit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function auditShape(s: Storage) {
  return s.read((db) => ({
    columns: db.prepare(`pragma table_info(session_audits)`).all(),
    indexes: (db.prepare(`pragma index_list(session_audits)`).all() as Array<{ name: string; unique: number }>)
      .map((i) => ({ name: i.name, unique: i.unique, columns: db.prepare(`pragma index_xinfo(${i.name})`).all() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    triggers: (db.prepare(`select name from sqlite_master where type = 'trigger' and tbl_name = 'session_audits' order by name`).all() as Array<{ name: string }>).map((t) => t.name),
  }));
}

async function addSession(storage: Storage, id: string, createdAt: number, opts: { completedAt?: number; type?: string; status?: string } = {}) {
  await storage.insertAgentSession({
    id, timelineKey: "matrix:a:room:!r:x", sessionType: opts.type ?? "default", status: (opts.status ?? "completed") as never,
    createdAt, updatedAt: createdAt,
  });
  if (opts.completedAt !== undefined) {
    await storage.updateAgentSessionStatus(id, (opts.status ?? "completed") as never, { completedAt: opts.completedAt, updatedAt: opts.completedAt });
  }
}

test("migration: a v26 database gains session_audits at the fresh shape; re-running is a no-op", async () => {
  await withTempDir(async (dir) => {
    const fresh = await Storage.open({ databasePath: ":memory:" });
    const freshShape = auditShape(fresh);
    fresh.close();
    assert.deepEqual(freshShape.triggers, ["mbr_sa_ad", "mbr_sa_ai", "mbr_sa_au"]);
    assert.ok((freshShape.columns as Array<{ name: string }>).some((c) => c.name === "event_id"));

    const dbPath = path.join(dir, "v26.db");
    {
      const s = await Storage.open({ databasePath: dbPath });
      await addSession(s, "s-old", 1);
      await s.write((db) => {
        db.exec(`drop table session_audits`);
        db.pragma("user_version = 26");
      });
      await s.waitForIdle();
      s.close();
    }
    const migrated = await Storage.open({ databasePath: dbPath });
    assert.equal(migrated.read((db) => Number(db.pragma("user_version", { simple: true }))), LATEST_SCHEMA_VERSION);
    assert.deepEqual(auditShape(migrated), freshShape);
    await migrated.writeSessionAudits([{ sessionId: "s-old", audit: "refusal", status: "done", version: 1, createdAt: 5 }]);
    await migrated.write((db) => db.pragma("user_version = 26"));
    await migrated.waitForIdle();
    migrated.close();
    const again = await Storage.open({ databasePath: dbPath });
    try {
      assert.deepEqual(auditShape(again), freshShape);
      assert.equal(again.listSessionAudits("s-old").length, 1, "rows survive a re-run");
    } finally {
      await again.waitForIdle();
      again.close();
    }
  });
});

test("writeSessionAudits: replaces by (session, audit, event), rewrites attempt types, cascades", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  await addSession(storage, "s1", 1);
  await storage.insertContractAttempts([
    { agentSessionId: "s1", attemptNo: 0, ts: 2, variant: "original", failureTypes: ["text_only"], primaryType: "text_only" },
  ]);
  await storage.writeSessionAudits([
    { sessionId: "s1", audit: "send_contract", status: "done", verdictJson: '{"runs":[]}', version: 1, createdAt: 10 },
    { sessionId: "s1", audit: "refusal", status: "skipped", version: 1, createdAt: 10 },
    { sessionId: "s1", audit: "refusal", eventId: "e1", status: "done", version: 1, createdAt: 10 },
  ]);
  await storage.writeSessionAudits(
    [{ sessionId: "s1", audit: "refusal", status: "done", costUsd: 0.01, modelId: "decider", version: 1, createdAt: 20 }],
    { attemptTypes: { sessionId: "s1", updates: [{ branchNo: 0, redoNo: 0, attemptNo: 0, failureTypes: ["self_talk", "text_only"], primaryType: "self_talk" }] } },
  );
  const rows = storage.listSessionAudits("s1");
  assert.deepEqual(rows.map((r) => [r.audit, r.event_id, r.status, r.created_at]), [
    ["send_contract", null, "done", 10],
    ["refusal", "e1", "done", 10],
    ["refusal", null, "done", 20],
  ]);
  assert.equal(rows[2]!.cost_usd, 0.01);
  assert.equal(storage.listContractAttempts("s1")[0]!.primary_type, "self_talk");
  await storage.write((db) => db.exec(`delete from agent_sessions where id = 's1'`));
  assert.deepEqual(storage.listSessionAudits("s1"), [], "rows cascade with the session");
});

test("listAuditCandidates: pending per audit since completion, contract gate, settle, types, keyset, order", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  await addSession(storage, "a", 100, { completedAt: 150 });
  await addSession(storage, "b", 200, { completedAt: 250 });
  await addSession(storage, "c", 200, { completedAt: 900 }); // not settled at 500
  await addSession(storage, "d", 300, { type: "diary", completedAt: 350 });
  await addSession(storage, "e", 400, { status: "running" });
  await storage.setAgentSessionContract("b", { outcome: "clean", nudges: 0, version: 1 });
  const base = { excludeSessionTypes: ["diary"], settledBefore: 500, limit: 10 };
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const both = [{ name: "send_contract", requiresContract: true }, { name: "refusal" }];
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: both, order: "asc" })), ["a", "b"]);
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: [both[0]!], order: "asc" })), ["b"], "contract audit waits for the record");
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: both, order: "desc" })), ["b", "a"]);
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: both, order: "asc", after: { createdAt: 100, id: "a" } })), ["b"]);
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: both, order: "asc", settledSince: 200 })), ["b"]);
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: both, order: "asc", minCreatedAt: 150 })), ["b"]);
  // Audited for refusal only: still pending for send_contract.
  await storage.writeSessionAudits([{ sessionId: "b", audit: "refusal", status: "done", version: 1, createdAt: 260 }]);
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: [{ name: "refusal" }], order: "asc" })), ["a"]);
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: both, order: "asc" })), ["a", "b"]);
  // A row written before the session's latest completion does not count (a resume).
  await storage.updateAgentSessionStatus("b", "completed", { completedAt: 300, updatedAt: 300 });
  assert.deepEqual(ids(storage.listAuditCandidates({ ...base, audits: [{ name: "refusal" }], order: "asc" })), ["a", "b"]);
  // A per-message row is not a whole-session audit.
  await storage.writeSessionAudits([{ sessionId: "a", audit: "refusal", eventId: "e1", status: "done", version: 1, createdAt: 600 }]);
  assert.ok(ids(storage.listAuditCandidates({ ...base, audits: [{ name: "refusal" }], order: "asc" })).includes("a"));
  assert.deepEqual(storage.listAuditCandidates({ ...base, audits: [], order: "asc" }), []);
});

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

[models.decider]
id = "vendor/decider"
provider = "openrouter"
api = "system-one"
endpoint = "https://gw.example/decisions"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1
context_window = 32000

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

async function load(extra: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-audit-config-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), BASE_CONFIG, "utf8");
    await writeFile(path.join(dir, "90-test.toml"), extra, "utf8");
    return await loadConfig(dir, { env: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("[decisions.audit]: loads, resolves as a point, knobs, validation", async () => {
  const config = await load(`
[decisions]
enabled = true
model = "decider"

[decisions.audit]
enabled = true
timeout_ms = 90000
audits = ["refusal"]
check_kinds = ["refusal", "style"]
sample_clean_sessions = 0.25
audit_backlog_max_age_ms = 86400000
workers = 2
backlog_pace_ms = 500
settle_ms = 1000
max_retries = 5
self_talk_threshold = 0.6
textual_tool_call_threshold = 0.9
`);
  assert.equal(anyDecisionPointEnabled(config), true);
  const settings = pointSettings(decisionsFor(config, null), "audit")!;
  assert.equal(settings.model, "decider");
  assert.equal(settings.timeoutMs, 90000);
  const knobs = auditKnobs(decisionsFor(config, null));
  assert.deepEqual(knobs, {
    audits: ["refusal"], checkKinds: ["refusal", "style"], sampleCleanSessions: 0.25, backlogMaxAgeMs: 86400000,
    workers: 2, backlogPaceMs: 500, settleMs: 1000, maxRetries: 5, selfTalkThreshold: 0.6, textualToolCallThreshold: 0.9,
  });
  validateDecisionsConfig(config);

  await assert.rejects(load(`[decisions.audit]\naudits = ["isms"]\n`), /audits/);
  await assert.rejects(load(`[decisions.audit]\nsample_clean_sessions = 2\n`), /sample_clean_sessions/);
  const noModel = await load(`[decisions]\nenabled = true\n[decisions.audit]\nenabled = true\n`);
  assert.throws(() => validateDecisionsConfig(noModel), /decisions\.audit is enabled but neither it nor decisions names a decision model/);
  const chatModel = await load(`[decisions]\nenabled = true\n[decisions.audit]\nenabled = true\nmodel = "default"\n`);
  assert.throws(() => validateDecisionsConfig(chatModel), /decisions\.audit\.model = "default" must name a model with api = "system-one"/);
  // Off unless both switches are on.
  const off = await load(`[decisions]\nmodel = "decider"\n[decisions.audit]\nenabled = true\n`);
  assert.equal(pointSettings(decisionsFor(off, null), "audit"), undefined);
});

test("DecisionEngine: usageClass audit bills and budgets the audit class, never decision", async () => {
  const config: any = {
    models: {
      decider: {
        id: "vendor/decider", provider: "openrouter", api: "system-one", endpoint: "https://gw.example/decisions",
        api_key: "k", input_modalities: ["text"], max_tokens: 1, context_window: 32000,
        cost: { input: 0.1, output: 0, cache_read: 0.1, cache_write: 0.1 },
      },
    },
    decisions: { enabled: true, model: "decider", audit: { enabled: true } },
  };
  const usage: UsageEventInput[] = [];
  const checks: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { choice: "same", confidence: 0.9, probabilities: {} };
    return new Response(JSON.stringify({ model: "vendor/decider", answers, usage: { input_tokens: 10, output_tokens: 1, cost: 0.002 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl }),
    record: (e) => usage.push(e),
    budget: () => ({ check: (d) => (checks.push(d), { allowed: true }) }),
  });
  const outcome = await engine.evaluate(
    contractAuditPoint,
    { request: [], nudges: 1, ending: "sent", attempts: [], firstAttempt: "a", sent: "b", askAfterCorrection: true },
    { agentName: null, attribution: { agentSessionId: "s1", timelineKey: "k" }, usageClass: "audit", priority: "background" },
  );
  assert.equal(outcome.source, "model");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.class, "audit");
  assert.equal(usage[0]!.toolName, "audit");
  assert.equal(usage[0]!.agentSessionId, "s1");
  assert.ok(checks.length > 0 && checks.every((c) => c.class === "audit" && c.tool === "audit"));
  assert.deepEqual(engine.usableMembers("audit", null, {}, "audit").map((m) => m.logicalId), ["decider"]);
  assert.equal(checks[checks.length - 1].class, "audit");
});
