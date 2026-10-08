/**
 * Provider chain with health and fallover (ARCHITECTURE.md §9d "Re-rank
 * stages"), the same semantics as the chat and decision chains: members are
 * tried in order; a failure or a timeout is a health strike and falls over to
 * the next member; an unhealthy member is skipped until its backoff elapses,
 * then probed by the next call (a success restores it). A member that is not
 * ready yet (a local model still loading) is skipped without a strike, and a
 * disabled member (`enabled = false`) is never tried. The caller's abort is
 * neutral (no strike) and ends the call.
 */
import type { Logger } from "../../observability/logger.js";
import { ProviderNotReadyError, type ProviderBase } from "./types.js";

export interface ChainMember<P extends ProviderBase> {
  provider: P;
  enabled: boolean;
  /** Per-member deadline of one call. */
  timeoutMs: number;
}

export interface MemberHealth {
  name: string;
  state: "healthy" | "unhealthy";
  failures: number;
  /** When an unhealthy member is next probed (epoch ms). */
  retryAt: number | null;
  lastError: string | null;
}

export class ChainUnavailableError extends Error {
  constructor(
    readonly stage: string,
    readonly attempts: Array<{ name: string; outcome: string }>,
  ) {
    super(`${stage}: no provider could serve (${attempts.map((a) => `${a.name}: ${a.outcome}`).join("; ") || "none usable"})`);
    this.name = "ChainUnavailableError";
  }
}

export interface ProviderChainOptions {
  logger?: Logger;
  now?: () => number;
  /** First backoff after a strike; doubles per consecutive strike. Default 30 s. */
  baseBackoffMs?: number;
  /** Backoff ceiling. Default 10 min. */
  maxBackoffMs?: number;
}

interface HealthState {
  failures: number;
  retryAt: number | null;
  lastError: string | null;
}

export class ProviderChain<P extends ProviderBase> {
  private readonly health = new Map<string, HealthState>();

  constructor(
    readonly stage: string,
    readonly members: ChainMember<P>[],
    private readonly options: ProviderChainOptions = {},
  ) {
    for (const m of members) this.health.set(m.provider.name, { failures: 0, retryAt: null, lastError: null });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** True when some enabled member is healthy or due a probe. */
  usable(): boolean {
    const now = this.now();
    return this.members.some((m) => {
      if (!m.enabled) return false;
      const h = this.health.get(m.provider.name)!;
      return h.retryAt === null || h.retryAt <= now;
    });
  }

  healthSnapshot(): MemberHealth[] {
    return this.members.map((m) => {
      const h = this.health.get(m.provider.name)!;
      return {
        name: m.provider.name,
        state: h.retryAt === null ? "healthy" : "unhealthy",
        failures: h.failures,
        retryAt: h.retryAt,
        lastError: h.lastError,
      };
    });
  }

  /** Warm every member in the background (local models load off the hot path). */
  warmAll(): void {
    for (const m of this.members) {
      if (!m.enabled || !m.provider.warm) continue;
      void m.provider.warm().catch((error) =>
        this.options.logger?.warn("retrieval_provider_warm_failed", {
          stage: this.stage,
          provider: m.provider.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.members.map((m) => m.provider.close().catch(() => {})));
  }

  private strike(name: string, error: string): void {
    const h = this.health.get(name)!;
    h.failures += 1;
    h.lastError = error.slice(0, 300);
    const base = this.options.baseBackoffMs ?? 30_000;
    const max = this.options.maxBackoffMs ?? 600_000;
    h.retryAt = this.now() + Math.min(max, base * 2 ** Math.min(20, h.failures - 1));
    this.options.logger?.warn("retrieval_provider_failed", {
      stage: this.stage,
      provider: name,
      failures: h.failures,
      error: h.lastError,
    });
  }

  private recover(name: string): void {
    const h = this.health.get(name)!;
    if (h.retryAt !== null) this.options.logger?.info("retrieval_provider_recovered", { stage: this.stage, provider: name });
    h.failures = 0;
    h.retryAt = null;
    h.lastError = null;
  }

  /**
   * Run `fn` on the first member that serves. Each member gets its own
   * deadline (composed with the caller's signal). Throws
   * {@link ChainUnavailableError} when no member served, or the caller's
   * AbortError when it aborted.
   */
  async run<R>(
    fn: (provider: P, signal: AbortSignal) => Promise<R>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ value: R; provider: P; ms: number }> {
    const attempts: Array<{ name: string; outcome: string }> = [];
    for (const member of this.members) {
      const name = member.provider.name;
      if (!member.enabled) continue;
      if (opts.signal?.aborted) throw abortError();
      const h = this.health.get(name)!;
      if (h.retryAt !== null && h.retryAt > this.now()) {
        attempts.push({ name, outcome: "unhealthy" });
        continue;
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, member.timeoutMs);
      const started = this.now();
      try {
        const value = await Promise.race([
          fn(member.provider, controller.signal),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener("abort", () => reject(abortError()), { once: true }),
          ),
        ]);
        this.recover(name);
        return { value, provider: member.provider, ms: this.now() - started };
      } catch (error) {
        if (opts.signal?.aborted && !timedOut) throw abortError();
        if (error instanceof ProviderNotReadyError) {
          attempts.push({ name, outcome: "not_ready" });
          continue;
        }
        const message = timedOut ? `timeout after ${member.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
        this.strike(name, message);
        attempts.push({ name, outcome: timedOut ? "timeout" : "error" });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new ChainUnavailableError(this.stage, attempts);
  }
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
