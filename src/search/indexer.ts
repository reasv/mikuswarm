import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import { projectChatEvent } from "./project.js";

/** index_meta key: highest timeline_events.rowid the chat index has swept. */
const CHAT_MAX_ROWID_KEY = "chat_index_max_rowid";

export interface ChatSearchIndexerOptions {
  storage: Storage;
  logger?: Logger;
  /** Full-sweep / catch-up page size (events per projection batch). */
  batchSize?: number;
}

/**
 * Keeps the `chat_index` lexical/metadata projection in sync with `timeline_events`
 * and its enrichment side-tables (ARCHITECTURE.md §9e). Chat events are DB rows (not
 * files like the memory index), and their searchable text arrives in two waves —
 * `body` at persist, captions/link-preview text and the resolved reply sender later,
 * as enrichment/captioning settle. So indexing has three convergent entry points, all
 * idempotent against the content-signature set-diff in `Storage.upsertChatIndexRows`:
 *
 *  - **Incremental hook** (`enqueueReconcileEvent`): fired on persist and again when an
 *    event's caption/preview/edit settles — the precise, low-latency path.
 *  - **Startup full sweep** (`reconcileAll`): projects every event, repairs any drift a
 *    missed hook left behind, and prunes rows for deleted events. Backfills the index on
 *    first boot after the migration.
 *  - **Lazy catch-up** (`ensureFreshForQuery`): before a search, cheaply index any events
 *    newer than the swept high-water rowid (covers hook gaps for *new* rows without a
 *    full scan).
 */
export class ChatSearchIndexer {
  private readonly storage: Storage;
  private readonly logger?: Logger;
  private readonly batchSize: number;
  /** Strict-FIFO tail so reconciles never overlap (mirrors MemoryIndexer). */
  private tail: Promise<unknown> = Promise.resolve();
  /** Set by `stop()`: refuse new work and let the in-flight tail drain. */
  private stopped = false;

  constructor(opts: ChatSearchIndexerOptions) {
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.batchSize = opts.batchSize ?? 500;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Drain on shutdown: stop accepting new reconciles and await the in-flight FIFO
   * tail so the last enqueued projection commits before `storage.close()` (mirrors
   * how the other worker pools are drained in `app.stop()`). Idempotent. After this
   * resolves, all enqueue entry points are no-ops, so a late hook (e.g. an enrichment
   * `onComplete` firing mid-drain) can't attempt a write against a closing DB.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.tail;
  }

  /**
   * Fire-and-forget incremental reconcile of one event, hooked off persist and the
   * enrichment/caption terminal callbacks. Serialized on the tail; errors are logged,
   * never thrown back to the caller (indexing must not break the message pipeline).
   */
  enqueueReconcileEvent(eventId: string): void {
    if (this.stopped) return;
    void this.enqueue(() => this.reconcileEventInner(eventId)).catch((error) => {
      this.logger?.warn("chat_index_reconcile_failed", {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Reconcile every event and prune rows for events that no longer exist (§9e). */
  reconcileAll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(() => this.reconcileAllInner());
  }

  /**
   * Lazy pre-search freshness net: index any events with rowid past the swept
   * high-water mark. Cheap (only brand-new rows; near-free when none). Late
   * caption/edit updates to already-indexed rows ride the incremental hook + startup
   * sweep, not this path.
   */
  ensureFreshForQuery(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.enqueue(() => this.catchUpNewEventsInner());
  }

  private async reconcileEventInner(eventId: string): Promise<void> {
    const inputs = this.storage.getChatProjectionInputs({ eventId });
    if (inputs.length === 0) {
      // Event vanished (deleted) between hook and read → drop its index row.
      await this.storage.deleteChatIndexForEvent(eventId);
      return;
    }
    const result = await this.storage.upsertChatIndexRows([projectChatEvent(inputs[0])]);
    if (result.inserted || result.updated) {
      this.logger?.debug("chat_index_event_reconciled", {
        eventId,
        inserted: result.inserted,
        updated: result.updated,
      });
    }
  }

  private async reconcileAllInner(): Promise<void> {
    let afterRowid = 0;
    let inserted = 0;
    let updated = 0;
    let maxRowid = 0;
    for (;;) {
      const inputs = this.storage.getChatProjectionInputs({
        afterRowid,
        limit: this.batchSize,
      });
      if (inputs.length === 0) break;
      const result = await this.storage.upsertChatIndexRows(inputs.map(projectChatEvent));
      inserted += result.inserted;
      updated += result.updated;
      afterRowid = inputs[inputs.length - 1].srcRowid;
      maxRowid = Math.max(maxRowid, afterRowid);
      if (inputs.length < this.batchSize) break;
    }
    const pruned = await this.storage.pruneChatIndexOrphans();
    await this.storage.setIndexMeta(CHAT_MAX_ROWID_KEY, String(maxRowid));
    if (inserted || updated || pruned) {
      this.logger?.info("chat_index_swept", { inserted, updated, pruned, maxRowid });
    }
  }

  private async catchUpNewEventsInner(): Promise<void> {
    const stored = Number(this.storage.getIndexMeta(CHAT_MAX_ROWID_KEY) ?? "0");
    let afterRowid = Number.isFinite(stored) ? stored : 0;
    let maxRowid = afterRowid;
    let inserted = 0;
    let updated = 0;
    for (;;) {
      const inputs = this.storage.getChatProjectionInputs({
        afterRowid,
        limit: this.batchSize,
      });
      if (inputs.length === 0) break;
      const result = await this.storage.upsertChatIndexRows(inputs.map(projectChatEvent));
      inserted += result.inserted;
      updated += result.updated;
      afterRowid = inputs[inputs.length - 1].srcRowid;
      maxRowid = Math.max(maxRowid, afterRowid);
      if (inputs.length < this.batchSize) break;
    }
    if (maxRowid > stored) await this.storage.setIndexMeta(CHAT_MAX_ROWID_KEY, String(maxRowid));
    if (inserted || updated) {
      this.logger?.debug("chat_index_caught_up", { inserted, updated, maxRowid });
    }
  }
}
