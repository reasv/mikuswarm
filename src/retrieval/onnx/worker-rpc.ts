/**
 * A small request/response layer over a forked child process, shared by the
 * retrieval workers that keep native ONNX work off the event loop (the exact
 * MaxSim scorer, the local cross-encoder and late encoders; ARCHITECTURE.md
 * §9d "Re-rank stages").
 *
 * Why processes, not worker threads: onnxruntime-node's binding (1.21) is not
 * context-aware. Each environment that loads it re-initialises process-wide
 * state, after which a forward pass in any other environment (another worker,
 * or the main thread, where the built-in embedder runs) aborts the process.
 * A child process has its own copy of the binding, so every model gets an
 * isolated runtime and the main thread's embedder is untouched.
 *
 * - The child reports `ready` (with an info payload) or `initError` once.
 * - Requests are handled one at a time, in arrival order. Aborting a request
 *   rejects it at once with an AbortError and tells the child, which skips it
 *   if not started and otherwise discards the result (a handler may also poll
 *   `cancelled()` between its own steps).
 * - Messages use the `advanced` (structured clone) serialization, so typed
 *   arrays cross as copies.
 * - The child is unref'd while idle, so it never keeps the process alive, and
 *   exits when the parent disconnects.
 */
import { fork, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../observability/logger.js";

type Ready = { type: "ready"; info: unknown } | { type: "initError"; message: string };
type Request = { id: number; op: string; payload: unknown } | { cancel: number } | { init: unknown };
type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; message: string; cancelled?: boolean };

/** Environment variable naming the worker module a child must serve. */
const CHILD_ENV = "MIKUSWARM_RETRIEVAL_WORKER";

/**
 * The URL of a worker module next to `moduleUrl` (pass `import.meta.url`),
 * with that module's own extension: `.ts` under tsx, `.js` when compiled.
 */
export function siblingWorkerUrl(moduleUrl: string, basename: string): URL {
  const ext = new URL(moduleUrl).pathname.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./${basename}${ext}`, moduleUrl);
}

/** True in a child forked to serve the worker module `name`. */
export function isWorkerChild(name: string): boolean {
  return process.env[CHILD_ENV] === name && typeof process.send === "function";
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("aborted", "AbortError");
}

/**
 * The parent's loader flags only (`--import`/`--require`/`--loader`, e.g. tsx
 * in development), so a `.ts` worker loads under tsx while test-runner or
 * inspector flags are not inherited.
 */
function loaderExecArgv(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const argv = process.execArgv;
  const add = (flag: string, value: string): void => {
    const key = `${flag}=${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(flag, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^(--import|--require|--loader|--experimental-loader|-r)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const flag = m[1] === "-r" ? "--require" : m[1]!;
    const value = m[2] ?? argv[++i];
    if (value !== undefined) add(flag, value);
  }
  return out;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface StartOptions {
  /** Short name, for logs and errors. */
  label: string;
  logger?: Logger;
  /** Called once if the child dies unexpectedly (not on close). */
  onDead?: (error: Error) => void;
  /** OS niceness for the child (e.g. 10 for background work); best effort. */
  nice?: number;
}

export class WorkerRpc {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private deadError: Error | null = null;
  private closing = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly label: string,
    private readonly logger?: Logger,
    private readonly onDead?: (error: Error) => void,
  ) {
    child.on("message", (msg: Reply | Ready) => {
      if (!("id" in msg)) return;
      const p = this.pending.get(msg.id);
      if (!p) return; // abandoned (aborted) request
      this.settle(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    });
    child.on("error", (error: Error) => this.fail(error));
    child.on("exit", (code, signal) => this.fail(new Error(`${label} worker exited (${signal ?? `code ${code}`})`)));
  }

  /**
   * Fork a child serving the worker module at `url` (which must call
   * {@link serveWorker} when {@link isWorkerChild}(`name`)), send it `init`,
   * and wait for its `ready` (rejects on `initError` or an early exit).
   */
  static async start<Info>(url: URL, name: string, init: unknown, opts: StartOptions): Promise<{ rpc: WorkerRpc; info: Info }> {
    const child = fork(fileURLToPath(url), [], {
      execArgv: loaderExecArgv(),
      serialization: "advanced",
      env: { ...process.env, [CHILD_ENV]: name },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    if (opts.nice !== undefined && child.pid !== undefined) {
      try {
        setPriority(child.pid, opts.nice);
      } catch {
        // best effort
      }
    }
    let info: Info;
    try {
      info = await new Promise<Info>((resolve, reject) => {
        const cleanup = (): void => {
          child.off("message", onMessage);
          child.off("error", onError);
          child.off("exit", onExit);
        };
        const onMessage = (msg: Ready | Reply): void => {
          if (!("type" in msg)) return;
          cleanup();
          if (msg.type === "ready") resolve(msg.info as Info);
          else reject(new Error(`${opts.label} worker failed to start: ${msg.message}`));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onExit = (code: number | null, signal: string | null): void => {
          cleanup();
          reject(new Error(`${opts.label} worker exited during startup (${signal ?? `code ${code}`})`));
        };
        child.on("message", onMessage);
        child.on("error", onError);
        child.on("exit", onExit);
        child.send({ init } satisfies Request);
      });
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    const rpc = new WorkerRpc(child, opts.label, opts.logger, opts.onDead);
    rpc.idle();
    return { rpc, info };
  }

  get dead(): boolean {
    return this.deadError !== null;
  }

  call<T>(op: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (this.deadError) return Promise.reject(this.deadError);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.has(id)) return;
        this.settle(id);
        this.send({ cancel: id });
        reject(abortError(signal!));
      };
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.pending.size === 1) this.busy();
      this.send({ id, op, payload });
    });
  }

  /** Ask the child to release its resources (`close` op), then make sure it is gone. */
  async close(): Promise<void> {
    if (this.deadError) return;
    this.closing = true;
    try {
      await this.call("close", null);
    } catch {
      // killed below regardless
    }
    this.deadError ??= new Error(`${this.label} closed`);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 2000);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private send(msg: Request): void {
    try {
      this.child.send(msg);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private busy(): void {
    this.child.ref();
    (this.child.channel as { ref?: () => void } | null | undefined)?.ref?.();
  }

  private idle(): void {
    this.child.unref();
    (this.child.channel as { unref?: () => void } | null | undefined)?.unref?.();
  }

  private settle(id: number): void {
    this.pending.delete(id);
    if (this.pending.size === 0) this.idle();
  }

  private fail(error: Error): void {
    if (this.deadError) return;
    this.deadError = this.closing ? new Error(`${this.label} closed`) : error;
    if (!this.closing) {
      this.logger?.warn("retrieval_worker_failed", { worker: this.label, error: error.message });
      this.onDead?.(error);
    }
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(this.deadError);
  }
}

// ---- child side --------------------------------------------------------------

export interface HandlerContext {
  /** True once the caller aborted this request. */
  cancelled(): boolean;
}

export type Handler = (payload: never, ctx: HandlerContext) => unknown;

/**
 * Run the child side: waits for the parent's init message, builds the state
 * with `init` (its `info` is sent with `ready`), then dispatches requests to
 * `handlers` by op. A `close` op runs `onClose` and exits; so does losing the
 * parent.
 */
export function serveWorker<State, Init>(
  init: (data: Init) => Promise<{ state: State; info: unknown }>,
  handlers: (state: State) => Record<string, Handler>,
  onClose?: (state: State) => Promise<void> | void,
): void {
  const send = (msg: Ready | Reply, then?: () => void): void => {
    process.send?.(msg, undefined, undefined, then ? () => then() : undefined);
  };
  const exitAfter = (msg: Ready | Reply, code: number): void => send(msg, () => process.exit(code));
  process.on("disconnect", () => process.exit(0));
  let table: Record<string, Handler> | null = null;
  let state: State;
  const cancelled = new Set<number>();
  const cancelledReply = (id: number): Reply => ({ id, ok: false, message: "cancelled", cancelled: true });
  let chain: Promise<void> = Promise.resolve();
  process.on("message", (msg: Request) => {
    if ("init" in msg) {
      chain = chain.then(async () => {
        try {
          const built = await init(msg.init as Init);
          state = built.state;
          table = handlers(state);
          send({ type: "ready", info: built.info });
        } catch (error) {
          exitAfter({ type: "initError", message: (error as Error).message }, 1);
        }
      });
      return;
    }
    if ("cancel" in msg) {
      cancelled.add(msg.cancel);
      return;
    }
    const { id, op, payload } = msg;
    chain = chain.then(async () => {
      try {
        if (cancelled.has(id)) {
          send(cancelledReply(id));
          return;
        }
        if (op === "close") {
          await onClose?.(state);
          exitAfter({ id, ok: true, result: null }, 0);
          return;
        }
        const handler = table?.[op];
        if (!handler) throw new Error(`unknown op ${op}`);
        const result = await handler(payload as never, { cancelled: () => cancelled.has(id) });
        send(cancelled.has(id) ? cancelledReply(id) : { id, ok: true, result });
      } catch (error) {
        send({ id, ok: false, message: (error as Error).message });
      } finally {
        cancelled.delete(id);
      }
    });
  });
}
