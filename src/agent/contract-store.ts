/**
 * Persistence of the send-contract derivation (spec REFUSAL-HANDLING §7.1,
 * DECISION-MODEL §5.8 "mandatory backfill").
 *
 * - {@link persistSessionContract}: the live path, at chat/proactive session
 *   completion (an interrupted run keeps its attempts, with no outcome). Derives from the in-memory transcript (snapshotted
 *   synchronously, before the record turn appends to it) and the session's
 *   stored branches, and replaces the session's `contract_attempts` + outcome.
 * - {@link ContractReconciler}: the one-time history pass. At startup, in the
 *   background, it derives every session with a persisted transcript whose
 *   `contract_version` is missing or older than {@link CONTRACT_DERIVATION_VERSION}.
 *   Resumable by construction: each session is stamped as it is written, so a
 *   restart picks up the remainder; a later version bump re-runs everything.
 */

import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import {
  CONTRACT_DERIVATION_VERSION,
  deriveContractEvents,
  type ContractBranchInput,
  type ContractDerivation,
} from "./contract.js";
import { SYNTHETIC_SESSION_TYPES } from "./recovery.js";

type ContractStorage = Pick<Storage, "listSessionBranches" | "replaceSessionContract">;

/** The session's stored branches, parsed for {@link deriveContractEvents} (unreadable rows skipped). */
export function contractBranchesOf(storage: Pick<Storage, "listSessionBranches">, sessionId: string): ContractBranchInput[] {
  const out: ContractBranchInput[] = [];
  for (const row of storage.listSessionBranches(sessionId)) {
    try {
      const messages = JSON.parse(row.messages_json) as unknown;
      if (!Array.isArray(messages)) continue;
      out.push({ branchNo: row.branch_no, forkIndex: row.fork_index, reason: row.reason, messages });
    } catch {
      /* a corrupt branch row only loses its own attempts */
    }
  }
  return out;
}

function toRows(derived: ContractDerivation) {
  return derived.attempts.map((a) => ({
    branchNo: a.branchNo,
    redoNo: a.redoNo,
    attemptNo: a.attemptNo,
    ts: a.ts,
    servedModel: a.servedModel,
    wireModel: a.wireModel,
    variant: a.variant,
    failureTypes: [...a.failureTypes],
    primaryType: a.primaryType,
  }));
}

/**
 * Derive and store a completed session's send-contract record. The derivation
 * runs synchronously over a copy of `messages`; only the write is deferred.
 * Never throws (failures are logged).
 */
export function persistSessionContract(params: {
  storage: ContractStorage;
  sessionId: string;
  messages: readonly unknown[];
  /** An operator Stop ended the run: its attempts are kept, the outcome is null. */
  interrupted?: boolean;
  logger?: Logger;
}): Promise<void> {
  const { storage, sessionId, logger } = params;
  let derived: ContractDerivation;
  try {
    derived = deriveContractEvents(params.messages.slice(), { branches: contractBranchesOf(storage, sessionId) });
    if (params.interrupted) derived.outcome = null;
  } catch (error) {
    logger?.warn("contract_derive_failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Promise.resolve();
  }
  return storage
    .replaceSessionContract(sessionId, {
      attempts: toRows(derived),
      outcome: derived.outcome,
      nudges: derived.nudges,
      version: CONTRACT_DERIVATION_VERSION,
    })
    .then(
      () => undefined,
      (error: unknown) => {
        logger?.warn("contract_persist_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
}

export interface ContractReconcilerOptions {
  storage: Pick<
    Storage,
    "listSessionBranches" | "replaceSessionContract" | "listContractReconcileBatch" | "countContractReconcilePending"
  >;
  logger?: Logger;
  /** Sessions per batch (one read, then one queued write each). */
  batchSize?: number;
  /** Progress log every this many sessions. */
  logEvery?: number;
  /** Derivation version to bring every session to (tests). */
  version?: number;
}

/**
 * The one-time history pass (DECISION-MODEL §5.8): never blocks startup (the
 * caller fires it and forgets), yields to the event loop between batches, and
 * writes through the single-writer queue. `stop()` lets the in-flight batch
 * finish and ends the pass; the next start resumes from the unstamped rows.
 */
export class ContractReconciler {
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(private readonly opts: ContractReconcilerOptions) {}

  start(): Promise<void> {
    this.running ??= this.run();
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    const { storage, logger } = this.opts;
    const version = this.opts.version ?? CONTRACT_DERIVATION_VERSION;
    const batchSize = this.opts.batchSize ?? 100;
    const logEvery = this.opts.logEvery ?? 1000;
    const exclude = [...SYNTHETIC_SESSION_TYPES];
    // Off the startup path: the first read happens after boot continues.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.stopped) return;
    const pending = storage.countContractReconcilePending(version, exclude);
    if (pending === 0) return;
    const started = Date.now();
    logger?.info("contract_reconcile_started", { pending, version });
    let afterRowid = 0;
    let done = 0;
    let failed = 0;
    let nextLog = logEvery;
    while (!this.stopped) {
      const batch = storage.listContractReconcileBatch({ version, afterRowid, limit: batchSize, excludeSessionTypes: exclude });
      if (batch.length === 0) break;
      afterRowid = batch[batch.length - 1]!.rowid;
      const writes: Promise<unknown>[] = [];
      for (const row of batch) {
        let derived: ContractDerivation = { attempts: [], outcome: null, nudges: 0, redos: 0 };
        try {
          const transcript = JSON.parse(row.transcript_json) as unknown;
          derived = deriveContractEvents(Array.isArray(transcript) ? transcript : [], {
            branches: contractBranchesOf(storage, row.id),
          });
          // An operator Stop is not a send-contract verdict.
          if (row.status === "interrupted") derived.outcome = null;
        } catch {
          // An unreadable transcript is stamped with no verdict, never retried.
          failed += 1;
        }
        writes.push(
          storage
            .replaceSessionContract(
              row.id,
              { attempts: toRows(derived), outcome: derived.outcome, nudges: derived.nudges, version },
              { onlyIfStale: true },
            )
            .catch(() => {
              failed += 1;
            }),
        );
      }
      await Promise.all(writes);
      done += batch.length;
      if (done >= nextLog) {
        logger?.info("contract_reconcile_progress", { done, pending });
        nextLog += logEvery;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    logger?.info(this.stopped ? "contract_reconcile_stopped" : "contract_reconcile_done", {
      sessions: done,
      failed,
      ms: Date.now() - started,
    });
  }
}
