import { setTimeout as sleep } from "node:timers/promises";
import { ExaClient } from "./client.js";
import { ExaError } from "./errors.js";
import { canReadExa, type ExaOwner } from "./content-store.js";
import type { ChannelVisibilityResolver } from "../visibility/index.js";
import type { ExaResearchJob, ExaResearchOrigin, ExaResearchCost, Storage, UsageEventInput } from "../storage/database.js";
import type { ExaRun, ExaResearchRequest } from "./types.js";
const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
export interface ExaResearchCaller extends ExaOwner { requesterId: string | null; operator?: boolean }
interface ResearchStorage extends Pick<Storage, "createExaResearchIntent" | "getExaResearchJob" | "listExaResearchJobs" | "updateExaResearchJob" | "finalizeExaResearchJob"> {}
export interface ExaResearchOptions {
  client: ExaClient; storage: ResearchStorage; visibility?: ChannelVisibilityResolver;
  onCommitted?: (event: UsageEventInput, job: ExaResearchJob) => void;
  now?: () => number;
}
/** Durable research with one polling collector per job; chat waits are independent. */
export class ExaResearchService {
  private collectors = new Map<string, Promise<ExaResearchJob>>();
  private creating = new Map<string, Promise<ExaResearchJob>>();
  private accepted = new Map<string, ExaRun>();
  private pendingIntents = 0;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  constructor(private readonly options: ExaResearchOptions) { this.now = options.now ?? Date.now; }
  get client() { return this.options.client; }
  async start(): Promise<void> {
    for (const job of this.options.storage.listExaResearchJobs()) {
      if (job.state === "submitting" && !job.remoteId) await this.options.storage.updateExaResearchJob(job.id, { state: "submission_unknown", lastError: "Process stopped during submission; remote acceptance cannot be safely determined. Operator investigation is required." });
    }
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), Math.max(1000, this.client.config.research.poll_interval_ms)); this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.controller.abort();
    await Promise.allSettled([...this.collectors.values(), ...this.creating.values()]);
  }
  private reconcile() {
    if (this.controller.signal.aborted) return;
    for (const job of this.options.storage.listExaResearchJobs()) if ((job.remoteId || this.accepted.has(job.id)) && (!terminal(job.state) || !job.accounted)) this.collect(job.id);
  }
  private visible(job: ExaResearchJob, caller: ExaResearchCaller): boolean {
    return canReadExa({ agent: job.origin.agent, timeline: job.origin.timelineKey }, caller, this.options.visibility);
  }
  readable(id: string, caller: ExaResearchCaller): ExaResearchJob {
    const job = this.options.storage.getExaResearchJob(id);
    if (!job || !this.visible(job, caller)) throw new Error("Research job is unknown or outside this agent/channel visibility. Use exa_research_list to find permitted local job IDs.");
    return job;
  }
  list(caller: ExaResearchCaller, args: { status?: string; query?: string; cursor?: string; limit?: number } = {}) {
    const jobs = this.options.storage.listExaResearchJobs().filter((job) => this.visible(job, caller) && (!args.status || job.state === args.status) && (!args.query || job.request.query.toLowerCase().includes(args.query.toLowerCase()))).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    let offset = 0;
    if (args.cursor) { const found = jobs.findIndex((job) => job.id === args.cursor); if (found < 0) throw new Error("Research cursor is unavailable; call exa_research_list without cursor."); offset = found + 1; }
    const limit = args.limit ?? 10; const page = jobs.slice(offset, offset + limit);
    return { jobs: page, nextCursor: offset + page.length < jobs.length ? page.at(-1)?.id : undefined };
  }
  async create(origin: ExaResearchOrigin, request: ExaResearchRequest, caller: ExaResearchCaller, signal?: AbortSignal, previousJobId?: string, checkBudget?: () => string | undefined): Promise<ExaResearchJob> {
    if (origin.agent !== caller.agent || origin.timelineKey !== caller.timeline || origin.requesterId !== caller.requesterId) throw new Error("Research origin does not match this session.");
    signal?.throwIfAborted();
    const key = JSON.stringify([origin.sessionId, origin.toolCallId]);
    let invocation = this.creating.get(key);
    if (!invocation) {
      invocation = this.createInvocation(origin, request, caller, previousJobId, checkBudget)
        .finally(() => this.creating.delete(key));
      this.creating.set(key, invocation);
      void invocation.catch(() => {});
    }
    try { return await this.waitPromise(invocation, signal, this.client.config.research.wait_timeout_ms); }
    catch (cause) {
      if (!signal?.aborted && !(cause instanceof Error && cause.message === "Wait deadline")) throw cause;
      const job = this.options.storage.listExaResearchJobs().find((j) => j.origin.sessionId === origin.sessionId && j.origin.toolCallId === origin.toolCallId);
      throw new Error(`Research wait ${signal?.aborted ? "aborted" : "timed out"}; remote work is preserved.${job ? ` Call exa_research_result(job_id: "${job.id}", wait: true) to recover.` : " Use exa_research_list to find this invocation after its intent is persisted."}`);
    }
  }
  private async createInvocation(origin: ExaResearchOrigin, request: ExaResearchRequest, caller: ExaResearchCaller, previousJobId?: string, checkBudget?: () => string | undefined): Promise<ExaResearchJob> {
    const existing = this.options.storage.listExaResearchJobs().find((job) => job.origin.sessionId === origin.sessionId && job.origin.toolCallId === origin.toolCallId);
    if (existing) return this.result(existing.id, caller, true, this.controller.signal);
    if (previousJobId) { const previous = this.readable(previousJobId, caller); if (previous.state !== "completed" || !previous.remoteId) throw new Error("Continuation requires a completed job. Call exa_research_result first."); request = { ...request, previousRunId: previous.remoteId }; }
    const reason = checkBudget?.(); if (reason) throw new Error(reason);
    // Intents count immediately. Replay joined the invocation before reaching this cap.
    const active = this.options.storage.listExaResearchJobs().filter((job) => !terminal(job.state)).length;
    if (active + this.pendingIntents >= this.client.config.research.max_in_flight) throw new Error("Research active-job limit reached. Use exa_research_list and collect or cancel existing jobs before starting another.");
    this.pendingIntents++;
    let created: Awaited<ReturnType<ResearchStorage["createExaResearchIntent"]>>;
    try { created = await this.options.storage.createExaResearchIntent({ origin, request, previousJobId }); } finally { this.pendingIntents--; }
    if (!created.created) return this.result(created.job.id, caller, true, this.controller.signal);
    let remote: ExaRun;
    try { remote = await this.client.createRun(request, this.controller.signal); }
    catch (cause) {
      const unknown = cause instanceof ExaError && cause.submissionUncertain;
      try { await this.options.storage.updateExaResearchJob(created.job.id, { state: unknown ? "submission_unknown" : "failed", lastError: cause instanceof ExaError ? `${cause.code}: ${cause.message}` : "Research submission failed before a confirmed run ID." }); } catch { /* persisted submitting is recovered as unknown on restart */ }
      throw new Error(`Research ${unknown ? "submission is uncertain; do not resubmit; operator investigation is required" : "submission failed"}. Local job: ${created.job.id}. Use exa_research_result(job_id: "${created.job.id}", wait: false).`);
    }
    // Acceptance is known: subsequent storage/accounting errors are recovery errors,
    // never submission failures. Retain the identity in memory until durably attached.
    this.accepted.set(created.job.id, remote);
    try {
      await this.options.storage.updateExaResearchJob(created.job.id, { remoteId: remote.id });
      if (terminal(remote.status)) {
        const job = await this.finalize(created.job.id, remote); this.accepted.delete(created.job.id); return job;
      }
      await this.options.storage.updateExaResearchJob(created.job.id, { state: remote.status, remote });
      this.accepted.delete(created.job.id);
    } catch {
      // Retry via the same collector, using the already accepted remote ID/run.
      this.collect(created.job.id);
      throw new Error(`Research was accepted but local persistence/accounting needs recovery; do not resubmit. Local job: ${created.job.id}. Call exa_research_result(job_id: "${created.job.id}", wait: true).`);
    }
    return this.result(created.job.id, caller, true, this.controller.signal);
  }
  async result(id: string, caller: ExaResearchCaller, wait = true, signal?: AbortSignal): Promise<ExaResearchJob> {
    const job = this.readable(id, caller);
    if (!wait || (terminal(job.state) && (job.accounted || !job.remoteId)) || (!job.remoteId && !this.accepted.has(id))) return job;
    const promise = this.collect(id);
    try { return await this.waitPromise(promise, signal, this.client.config.research.wait_timeout_ms); }
    catch (cause) { throw new Error(`Research wait ${signal?.aborted ? "aborted" : "timed out"}; remote work is preserved. Call exa_research_result(job_id: "${id}", wait: true) to recover.${this.controller.signal.aborted ? " Service is stopping." : ""}`); }
  }
  async cancel(id: string, caller: ExaResearchCaller, signal?: AbortSignal): Promise<ExaResearchJob> {
    const job = this.readable(id, caller);
    if (!caller.operator && (!caller.requesterId || caller.requesterId !== job.origin.requesterId)) throw new Error("Only the originating requester or a trusted operator can cancel this research job.");
    if (terminal(job.state)) return job;
    if (!job.remoteId) throw new Error("Remote run ID is unavailable; cancellation cannot be safely issued. submission_unknown requires operator investigation.");
    const remote = await this.client.cancelRun(job.remoteId, signal);
    if (terminal(remote.status)) return this.finalize(id, remote);
    return this.options.storage.updateExaResearchJob(id, { remote, state: remote.status });
  }
  private collect(id: string): Promise<ExaResearchJob> {
    const existing = this.collectors.get(id); if (existing) return existing;
    const promise = this.poll(id).finally(() => this.collectors.delete(id));
    this.collectors.set(id, promise); void promise.catch(() => {}); return promise;
  }
  private async poll(id: string): Promise<ExaResearchJob> {
    for (;;) {
      this.controller.signal.throwIfAborted(); const job = this.options.storage.getExaResearchJob(id)!;
      if (terminal(job.state) && job.accounted) return job;
      const accepted = this.accepted.get(id);
      if (!job.remoteId && !accepted) return job;
      let delay = this.client.config.research.poll_interval_ms;
      try {
        if (!job.remoteId && accepted) await this.options.storage.updateExaResearchJob(id, { remoteId: accepted.id });
        const remote = accepted && terminal(accepted.status) ? accepted : await this.client.getRun(job.remoteId ?? accepted!.id, this.controller.signal);
        if (terminal(remote.status)) {
          const finalized = await this.finalize(id, remote); this.accepted.delete(id); return finalized;
        }
        await this.options.storage.updateExaResearchJob(id, { state: remote.status, remote, lastError: null });
        this.accepted.delete(id);
      } catch (cause) {
        if (this.controller.signal.aborted) throw cause;
        try { await this.options.storage.updateExaResearchJob(id, { lastError: cause instanceof ExaError ? `${cause.code}: ${cause.message}` : "Research status collection failed; retrying." }); } catch { /* retain accepted identity and retry after transient storage failure */ }
        delay = Math.max(delay, cause instanceof ExaError && cause.retryAt ? Math.min(300000, cause.retryAt - this.now()) : 5000);
      }
      await sleep(delay, undefined, { signal: this.controller.signal });
    }
  }
  private async finalize(id: string, remote: ExaRun): Promise<ExaResearchJob> {
    const job = this.options.storage.getExaResearchJob(id)!;
    const rates = { minimal: 0.012, low: 0.025, medium: 0.10, high: 0.50, xhigh: 1 };
    const cost: ExaResearchCost = remote.costDollars ? { usd: remote.costDollars.total, provenance: "reported" } : { usd: rates[job.request.effort], provenance: "estimated", estimateVersion: "exa-pricing-2026-10-06" };
    const finalized = await this.options.storage.finalizeExaResearchJob(id, remote, cost);
    if (finalized.newlyAccounted && finalized.event) this.options.onCommitted?.(finalized.event, finalized.job);
    return finalized.job;
  }
  private waitPromise<T>(promise: Promise<T>, signal?: AbortSignal, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Wait aborted")); };
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (timeout) timer = setTimeout(() => { cleanup(); reject(new Error("Wait deadline")); }, timeout);
      void promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
  }
}
