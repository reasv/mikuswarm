import { ExaError } from "./errors.js";
import type { ExaScope } from "./types.js";
interface Circuit { state: "unverified" | "healthy" | "open"; reason?: string; retryAt: number; failures: number[]; openings: number; probing: boolean; generation: number; lastObserved?: number }
const fresh = (): Circuit => ({ state: "unverified", retryAt: 0, failures: [], openings: 0, probing: false, generation: 0 });
/** App-scoped account health plus endpoint circuits. No unsolicited probes. */
export class ExaHealth {
  private account = fresh();
  private cooldownUntil = 0;
  private circuits = new Map<ExaScope, Circuit>();
  constructor(private readonly now: () => number = Date.now) {}
  private circuit(scope: ExaScope): Circuit { let c = this.circuits.get(scope); if (!c) this.circuits.set(scope, c = fresh()); return c; }
  snapshot() {
    return { account: { ...this.account, failures: undefined }, cooldownUntil: this.cooldownUntil,
      endpoints: Object.fromEntries([...this.circuits].map(([scope, c]) => [scope, { ...c, failures: undefined }])) };
  }
  available(scope: ExaScope): boolean {
    const now = this.now(), c = this.circuit(scope);
    return this.cooldownUntil <= now && (this.account.state !== "open" || (!this.account.probing && this.account.retryAt <= now)) && (c.state !== "open" || (!c.probing && c.retryAt <= now));
  }
  /** Atomically claim half-open probes; finish must run for every admitted request. */
  enter(scope: ExaScope): { success(): void; failure(error: ExaError): void; finish(): void } {
    const now = this.now(), c = this.circuit(scope);
    for (const state of [this.account, c]) {
      if (state.state === "open" && (state.probing || now < state.retryAt)) throw new ExaError("exa_unavailable", `Exa unavailable: ${state.reason ?? "temporary upstream outage"}. Retry after the indicated cooldown.`, scope, undefined, Math.max(state.retryAt, now + (state.probing ? 1000 : 0)));
    }
    if (now < this.cooldownUntil) throw new ExaError("exa_unavailable", "Exa rate-limit cooldown is active. Retry after the indicated time.", scope, undefined, this.cooldownUntil);
    const probes = [this.account, c].filter((state) => state.state === "open");
    for (const state of probes) { state.probing = true; state.generation++; }
    const accountGeneration = this.account.generation, endpointGeneration = c.generation;
    const current = (state: Circuit, generation: number) => state.generation === generation;
    return {
      success: () => this.success(scope, accountGeneration, endpointGeneration),
      failure: (error) => this.failure(scope, error, accountGeneration, endpointGeneration),
      finish: () => {
        for (const state of probes) {
          const generation = state === this.account ? accountGeneration : endpointGeneration;
          if (current(state, generation)) state.probing = false;
        }
      },
    };
  }
  private success(scope: ExaScope, accountGeneration: number, endpointGeneration: number): void {
    const observed = this.now();
    if (this.account.generation === accountGeneration) this.recover(this.account, observed);
    const c = this.circuit(scope);
    if (c.generation === endpointGeneration) this.recover(c, observed);
  }
  private recover(c: Circuit, observed: number): void {
    const generation = c.generation + (c.state === "open" ? 1 : 0);
    Object.assign(c, fresh(), { state: "healthy", generation, lastObserved: observed });
  }
  private failure(scope: ExaScope, error: ExaError, accountGeneration: number, endpointGeneration: number): void {
    const now = this.now(), c = this.circuit(scope);
    if (error.code === "auth_failed" || error.code === "credit_exhausted") {
      if (this.account.generation !== accountGeneration) return;
      this.account.generation++; this.account.probing = false; this.account.state = "open"; this.account.reason = error.code; this.account.retryAt = now + 300000; this.account.lastObserved = now; return;
    }
    // An owning account probe that cannot verify recovery must wait again.
    // Caller aborts and invalid input/response remain neutral: they say nothing
    // about account recovery. Endpoint failures still update their own circuit.
    if (this.account.generation === accountGeneration && this.account.state === "open" &&
        this.account.probing && ["transport_failed", "upstream_failed", "timeout", "rate_limited"].includes(error.code)) {
      this.account.generation++; this.account.probing = false;
      this.account.retryAt = now + 300000; this.account.lastObserved = now;
    }
    if (error.code === "rate_limited") { this.cooldownUntil = Math.max(this.cooldownUntil, error.retryAt ?? now + 30000); return; }
    if (c.generation !== endpointGeneration) return;
    if (!["transport_failed", "upstream_failed", "timeout"].includes(error.code)) return;
    c.failures = c.failures.filter((time) => time >= now - 60000); c.failures.push(now); c.lastObserved = now;
    if (c.state === "open" || c.failures.length >= 3) {
      c.generation++; c.probing = false; c.state = "open"; c.reason = error.code; c.retryAt = now + Math.min(300000, 30000 * 2 ** Math.min(c.openings++, 4));
    }
  }
}
