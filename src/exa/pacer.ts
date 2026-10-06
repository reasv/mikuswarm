/** FIFO admission and paced starts. Queued cancellations never consume a slot. */
export class ExaPacer {
  private active = 0;
  private nextStart = 0;
  private wakeup?: ReturnType<typeof setTimeout>;
  private queue: Array<{ resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(private readonly maxInFlight: number, private readonly intervalMs: number) {}
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: () => { const index = this.queue.indexOf(entry); if (index >= 0) { this.queue.splice(index, 1); reject(signal?.reason); this.drain(); } } };
      this.queue.push(entry); signal?.addEventListener("abort", entry.abort, { once: true }); this.drain();
    });
    try { signal?.throwIfAborted(); return await fn(); } finally { this.active--; this.drain(); }
  }
  private drain(): void {
    if (!this.queue.length || this.active >= this.maxInFlight) {
      if (this.wakeup) clearTimeout(this.wakeup);
      this.wakeup = undefined; return;
    }
    const now = Date.now();
    if (now < this.nextStart) {
      this.wakeup ??= setTimeout(() => { this.wakeup = undefined; this.drain(); }, this.nextStart - now);
      return;
    }
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = undefined;
    const entry = this.queue.shift()!; entry.signal?.removeEventListener("abort", entry.abort);
    this.active++; this.nextStart = now + this.intervalMs; entry.resolve(); this.drain();
  }
}
