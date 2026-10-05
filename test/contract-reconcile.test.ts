/**
 * Send-contract persistence and the history reconciliation (spec
 * REFUSAL-HANDLING §7.1, DECISION-MODEL §5.8 "mandatory backfill"): the
 * replace-on-write storage method, which sessions the pass visits, its
 * resumability, and a version bump re-running everything.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_DERIVATION_VERSION, FORCED_COMPLETION_PROMPTS } from "../src/agent/contract.js";
import { ContractReconciler, persistSessionContract } from "../src/agent/contract-store.js";
import { Storage } from "../src/storage/index.js";

const kick = { type: "triggerGroup", content: "hi", timestamp: 1 };
const textMsg = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", model: "wire-a", timestamp: 2 });
const sendMsg = { role: "assistant", content: [{ type: "toolCall", id: "s1", name: "send_message", arguments: { final: true } }], stopReason: "toolUse", model: "wire-a", timestamp: 3 };
const sendOk = { role: "toolResult", toolCallId: "s1", toolName: "send_message", content: [], isError: false, timestamp: 4 };
// History: an untagged corrective prompt in an older wording.
const legacyNudge = { role: "user", content: FORCED_COMPLETION_PROMPTS.historical[1]!.text, timestamp: 5 };

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

async function addSession(
  storage: Storage,
  id: string,
  opts: { type?: string; status?: "completed" | "running" | "interrupted"; transcript?: unknown[] | string } = {},
): Promise<void> {
  await storage.insertAgentSession({
    id, timelineKey: "matrix:a:room:!r:x", sessionType: opts.type ?? "default", status: opts.status ?? "completed", createdAt: 1, updatedAt: 1,
  });
  if (opts.transcript !== undefined) {
    const json = typeof opts.transcript === "string" ? opts.transcript : JSON.stringify(opts.transcript);
    await storage.saveAgentSessionTranscript(id, json);
  }
}

const RECOVERED = [kick, textMsg("reply as text"), legacyNudge, sendMsg, sendOk];

test("replaceSessionContract replaces the session's rows; onlyIfStale never overwrites a newer write", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "a");
    const attempt = (n: number) => ({ attemptNo: n, variant: "original" as const, failureTypes: ["text_only"], primaryType: "text_only" });
    assert.equal(await storage.replaceSessionContract("a", { attempts: [attempt(0), attempt(1), attempt(2)], outcome: "exhausted", nudges: 2, version: 1 }), true);
    assert.equal(await storage.replaceSessionContract("a", { attempts: [attempt(0)], outcome: "clean", nudges: 0, version: 1 }), true);
    assert.equal(storage.listContractAttempts("a").length, 1, "stale rows are gone");
    assert.equal(
      await storage.replaceSessionContract("a", { attempts: [], outcome: null, nudges: 0, version: 1 }, { onlyIfStale: true }),
      false,
    );
    assert.equal(storage.getAgentSession("a")!.contract_outcome, "clean");
    assert.equal(await storage.replaceSessionContract("missing", { attempts: [], outcome: null, nudges: 0, version: 1 }), false);
  });
});

test("persistSessionContract derives from the live messages and stamps the version", async () => {
  await withStorage(async (storage) => {
    await addSession(storage, "a");
    await persistSessionContract({ storage, sessionId: "a", messages: RECOVERED });
    const row = storage.getAgentSession("a")!;
    assert.equal(row.contract_outcome, "recovered");
    assert.equal(row.contract_nudges, 1);
    assert.equal(row.contract_version, CONTRACT_DERIVATION_VERSION);
    assert.deepEqual(storage.listContractAttempts("a").map((r) => [r.attempt_no, r.variant, r.primary_type, r.wire_model]), [
      [0, "original", "text_only", "wire-a"],
      [1, "not_sent", null, "wire-a"],
    ]);
  });
});

async function seedHistory(storage: Storage): Promise<void> {
  await addSession(storage, "h1", { transcript: RECOVERED });
  await addSession(storage, "h2", { transcript: [kick, sendMsg, sendOk] });
  await addSession(storage, "h3", { status: "interrupted", transcript: [kick, textMsg("x")] });
  await addSession(storage, "syn", { type: "summarize", transcript: [kick, textMsg("summary")] });
  await addSession(storage, "live", { status: "running", transcript: [kick] });
  await addSession(storage, "bad", { transcript: "{not json" });
  await addSession(storage, "nopayload");
  // A session the live path already wrote at the current version.
  await addSession(storage, "done", { transcript: [kick, textMsg("t")] });
  await storage.replaceSessionContract("done", { attempts: [], outcome: "clean", nudges: 0, version: CONTRACT_DERIVATION_VERSION });
  // A session with a contract-redo branch.
  await addSession(storage, "br", { transcript: [kick, sendMsg, sendOk] });
  await storage.insertSessionBranch({
    sessionId: "br",
    forkIndex: 1,
    reason: "contract_redo",
    messagesJson: JSON.stringify([textMsg("a"), legacyNudge, textMsg("b")]),
  });
}

test("reconciliation: visits every finished non-synthetic session with a transcript, once", async () => {
  await withStorage(async (storage) => {
    await seedHistory(storage);
    assert.equal(storage.countContractReconcilePending(CONTRACT_DERIVATION_VERSION, ["summarize", "condense", "diary"]), 5);
    const logs: string[] = [];
    const logger = { info: (m: string) => logs.push(m), warn: () => {}, error: () => {}, debug: () => {}, child: () => logger } as never;
    await new ContractReconciler({ storage, logger, batchSize: 2 }).start();
    const get = (id: string) => storage.getAgentSession(id)!;
    assert.equal(get("h1").contract_outcome, "recovered");
    assert.equal(get("h2").contract_outcome, "clean");
    assert.equal(get("h3").contract_outcome, null, "an operator Stop is no verdict");
    assert.equal(storage.listContractAttempts("h3").length, 1, "its attempts are still recorded");
    assert.equal(get("bad").contract_version, CONTRACT_DERIVATION_VERSION);
    assert.equal(get("bad").contract_outcome, null, "unreadable: stamped with no verdict, never retried");
    assert.equal(get("syn").contract_version, null, "synthetic generation sessions are excluded");
    assert.equal(get("live").contract_version, null, "mid-run sessions are left to the live path");
    assert.equal(get("nopayload").contract_version, null);
    assert.equal(get("br").contract_outcome, "redo_recovered");
    assert.deepEqual(storage.listContractAttempts("br").map((r) => [r.branch_no, r.redo_no, r.attempt_no]), [
      [0, 1, 0],
      [1, 0, 0],
      [1, 0, 1],
    ]);
    assert.equal(storage.countContractReconcilePending(CONTRACT_DERIVATION_VERSION, ["summarize", "condense", "diary"]), 0);
    assert.ok(logs.includes("contract_reconcile_started") && logs.includes("contract_reconcile_done"));
    // Nothing pending: a second start is a no-op (no log line).
    logs.length = 0;
    await new ContractReconciler({ storage, logger }).start();
    assert.deepEqual(logs, []);
  });
});

test("reconciliation is resumable: a stopped pass leaves the rest for the next start", async () => {
  await withStorage(async (storage) => {
    await seedHistory(storage);
    let reconciler!: ContractReconciler;
    let batches = 0;
    const wrapped = Object.create(storage) as Storage;
    wrapped.listContractReconcileBatch = (opts) => {
      batches += 1;
      if (batches === 1) void reconciler.stop();
      return storage.listContractReconcileBatch(opts);
    };
    reconciler = new ContractReconciler({ storage: wrapped, batchSize: 2 });
    await reconciler.start();
    const exclude = ["summarize", "condense", "diary"];
    assert.equal(storage.countContractReconcilePending(CONTRACT_DERIVATION_VERSION, exclude), 3, "one batch of two was written");
    await new ContractReconciler({ storage, batchSize: 2 }).start();
    assert.equal(storage.countContractReconcilePending(CONTRACT_DERIVATION_VERSION, exclude), 0);
  });
});

test("a derivation version bump re-runs every session, the live-written ones included", async () => {
  await withStorage(async (storage) => {
    await seedHistory(storage);
    await new ContractReconciler({ storage }).start();
    const next = CONTRACT_DERIVATION_VERSION + 1;
    assert.equal(storage.countContractReconcilePending(next, ["summarize", "condense", "diary"]), 6);
    await new ContractReconciler({ storage, version: next }).start();
    assert.equal(storage.getAgentSession("done")!.contract_version, next);
    assert.equal(storage.getAgentSession("done")!.contract_outcome, "exhausted", "re-derived from its transcript");
    assert.equal(storage.countContractReconcilePending(next, ["summarize", "condense", "diary"]), 0);
  });
});
