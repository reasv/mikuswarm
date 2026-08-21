import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import { registerSecret } from "../config/redaction.js";
import type { Logger } from "../observability/logger.js";

export interface McpServerConfig {
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: McpToolDef[];
}

/**
 * Startup-retry tuning for servers whose initial connection fails. Resolved
 * from the `[mcp]` config keys `startup_retry_max_attempts`,
 * `startup_retry_initial_delay_ms`, and `startup_retry_max_delay_ms`; every
 * field is optional and falls back to {@link DEFAULT_STARTUP_RETRY}.
 */
export interface McpStartupRetryOptions {
  /** Background retry attempts after the initial startup failure; 0 disables. */
  maxAttempts?: number;
  /** Delay before the first retry; doubles on each subsequent attempt. */
  initialDelayMs?: number;
  /** Upper bound on the between-attempt delay. */
  maxDelayMs?: number;
}

export const DEFAULT_STARTUP_RETRY = {
  maxAttempts: 5,
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
} as const;

/**
 * Exponential backoff for startup retries: `initial * 2^(attempt - 1)`, capped
 * at `max`. `attempt` is 1-based — the first background retry is attempt 1.
 */
export function startupRetryDelayMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  return Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

export interface McpClientPoolOptions {
  servers: Record<string, McpServerConfig>;
  logger: Logger;
  /** Startup-retry tuning; absent fields fall back to {@link DEFAULT_STARTUP_RETRY}. */
  retry?: McpStartupRetryOptions;
  /**
   * Fired when a server that failed at startup connects on a background retry.
   * The app wires this to adapt + register the server's tools, so sessions
   * created after the late connect can call them (sessions already running
   * keep the tool set they started with).
   */
  onLateConnect?: (entry: McpServerEntry) => void;
}

/**
 * Classify an error thrown by `client.callTool()` as a "the server has lost our
 * session" condition — the symptom of a server restart, session timeout, or a
 * non-sticky load balancer routing to a replica that never saw our `initialize`.
 *
 * Streamable HTTP sessions are stateful (an `Mcp-Session-Id` minted during
 * `initialize` and replayed on every request); the SDK never re-initializes on
 * its own, so a stale session is fatal until we reconnect. We only match these
 * narrow signals — a transient network blip leaves the session valid on the
 * server, so reconnecting (minting a *new* session) there would be wrong.
 */
export function isSessionTerminatedError(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    // 404: the server does not recognize our session id (terminated/expired).
    if (error.code === 404) return true;
    // 400: "Bad Request: Server not initialized" — a request arrived on a
    // session the server considers uninitialized.
    if (error.code === 400 && /not initialized|session/i.test(error.message)) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return /server not initialized|session (?:not found|has been terminated|terminated|expired)|mcp-session-id/i.test(
    message,
  );
}

export class McpClientPool {
  private static readonly VALID_KEY = /^[a-z][a-z0-9-]*$/;

  private readonly entries = new Map<string, McpServerEntry>();
  /** Coalesces concurrent reconnect attempts for the same server to one. */
  private readonly reconnecting = new Map<string, Promise<void>>();
  /** Pending startup-retry timers, keyed by server name. */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retry: Required<McpStartupRetryOptions>;
  private readonly logger: Logger;
  private stopped = false;

  constructor(private readonly options: McpClientPoolOptions) {
    this.logger = options.logger;
    this.retry = {
      maxAttempts: options.retry?.maxAttempts ?? DEFAULT_STARTUP_RETRY.maxAttempts,
      initialDelayMs: options.retry?.initialDelayMs ?? DEFAULT_STARTUP_RETRY.initialDelayMs,
      maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_STARTUP_RETRY.maxDelayMs,
    };
  }

  async start(): Promise<void> {
    for (const [name, config] of Object.entries(this.options.servers)) {
      if (!McpClientPool.VALID_KEY.test(name)) {
        this.logger.error("mcp_server_invalid_key", {
          server: name,
          error:
            "Server key must match /^[a-z][a-z0-9-]*$/ (lowercase, no underscores)",
        });
        continue;
      }

      if (config.headers) {
        for (const value of Object.values(config.headers)) {
          registerSecret(value);
        }
      }

      try {
        const { client, tools } = await this.connectServer(config);
        this.entries.set(name, { name, config, client, tools });
        this.logger.info("mcp_server_connected", {
          server: name,
          url: config.url,
          transport: config.transport ?? "streamable-http",
          toolCount: tools.length,
          tools: tools.map((t) => t.name),
        });
      } catch (error) {
        this.logger.error("mcp_server_connect_failed", {
          server: name,
          url: config.url,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleStartupRetry(name, config, 1);
      }
    }
  }

  /**
   * Schedule background retry `attempt` (1-based) for a server whose startup
   * connection failed. Startup failures are often boot-order artifacts — the
   * process comes up before its network egress or DNS is ready — so a bounded
   * retry keeps a transient failure from disabling the server's tools for the
   * whole process lifetime. Backoff doubles from `initialDelayMs` up to
   * `maxDelayMs`; after `maxAttempts` failed retries the pool gives up
   * (`mcp_server_startup_retries_exhausted`) and only a process restart brings
   * the server back.
   */
  private scheduleStartupRetry(
    name: string,
    config: McpServerConfig,
    attempt: number,
  ): void {
    if (this.stopped || this.retry.maxAttempts <= 0) return;
    if (attempt > this.retry.maxAttempts) {
      this.logger.error("mcp_server_startup_retries_exhausted", {
        server: name,
        url: config.url,
        attempts: this.retry.maxAttempts,
      });
      return;
    }
    const delayMs = startupRetryDelayMs(
      attempt,
      this.retry.initialDelayMs,
      this.retry.maxDelayMs,
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.attemptStartupRetry(name, config, attempt);
    }, delayMs);
    // Never hold the process open for a retry: shutdown must not wait on us.
    timer.unref?.();
    this.retryTimers.set(name, timer);
    this.logger.debug("mcp_server_retry_scheduled", {
      server: name,
      attempt,
      maxAttempts: this.retry.maxAttempts,
      delayMs,
    });
  }

  private async attemptStartupRetry(
    name: string,
    config: McpServerConfig,
    attempt: number,
  ): Promise<void> {
    if (this.stopped) return;
    let connected: { client: Client; tools: McpToolDef[] };
    try {
      connected = await this.connectServer(config);
    } catch (error) {
      this.logger.warn("mcp_server_retry_failed", {
        server: name,
        url: config.url,
        attempt,
        maxAttempts: this.retry.maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleStartupRetry(name, config, attempt + 1);
      return;
    }
    if (this.stopped) {
      // stop() ran while the handshake was in flight — don't register into a
      // stopped pool; close the fresh client best-effort instead.
      try {
        await connected.client.close();
      } catch {
        // Best-effort close of a client we never used.
      }
      return;
    }
    const entry: McpServerEntry = { name, config, ...connected };
    this.entries.set(name, entry);
    this.logger.info("mcp_server_connected", {
      server: name,
      url: config.url,
      transport: config.transport ?? "streamable-http",
      toolCount: entry.tools.length,
      tools: entry.tools.map((t) => t.name),
      retryAttempt: attempt,
    });
    try {
      this.options.onLateConnect?.(entry);
    } catch (error) {
      this.logger.error("mcp_late_connect_hook_failed", {
        server: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Establish a fresh client + transport and run the `initialize` handshake.
   * Protected so tests can stub the network handshake.
   */
  protected async connectServer(
    config: McpServerConfig,
  ): Promise<{ client: Client; tools: McpToolDef[] }> {
    const client = new Client({ name: "mikuswarm", version: "1.0.0" });
    const url = new URL(config.url);
    const requestInit: RequestInit = config.headers
      ? { headers: config.headers }
      : {};

    const transport =
      config.transport === "sse"
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit });

    await client.connect(transport);
    const { tools } = await client.listTools();
    return { client, tools };
  }

  /**
   * The live client for a connected server, or `undefined` if the server never
   * connected at startup. Always read through this at call time rather than
   * caching the reference — `reconnect()` swaps in a new client on session loss.
   */
  getClient(name: string): Client | undefined {
    return this.entries.get(name)?.client;
  }

  /**
   * Tear down the (likely dead) client for a server and re-establish it,
   * re-running `initialize` and re-discovering tools. Concurrent callers share
   * one in-flight attempt. Rejects (and leaves the entry's stale client in
   * place) if the server is still unreachable, so the next call retries.
   *
   * No-op rejection for an unknown server: a server that failed to connect at
   * startup has no entry (and thus no registered tools to invoke), so there is
   * nothing to reconnect.
   */
  async reconnect(name: string): Promise<void> {
    const inflight = this.reconnecting.get(name);
    if (inflight) return inflight;

    const attempt = this.doReconnect(name).finally(() => {
      this.reconnecting.delete(name);
    });
    this.reconnecting.set(name, attempt);
    return attempt;
  }

  private async doReconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Cannot reconnect unknown MCP server: ${name}`);
    }

    // The old session is already dead on the server; close best-effort to free
    // the local transport before standing up a replacement.
    try {
      await entry.client.close();
    } catch (error) {
      this.logger.debug("mcp_server_close_failed", {
        server: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let next: { client: Client; tools: McpToolDef[] };
    try {
      next = await this.connectServer(entry.config);
    } catch (error) {
      this.logger.error("mcp_server_reconnect_failed", {
        server: name,
        url: entry.config.url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const before = entry.tools.map((t) => t.name);
    const after = next.tools.map((t) => t.name);
    entry.client = next.client;
    entry.tools = next.tools;

    const toolsChanged =
      before.length !== after.length ||
      before.some((n, i) => n !== after[i]);
    this.logger.info("mcp_server_reconnected", {
      server: name,
      url: entry.config.url,
      toolCount: next.tools.length,
      ...(toolsChanged ? { toolsChanged: true, tools: after } : {}),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const [name, entry] of this.entries) {
      try {
        await entry.client.close();
        this.logger.debug("mcp_server_disconnected", { server: name });
      } catch (error) {
        this.logger.error("mcp_server_close_failed", {
          server: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.entries.clear();
  }

  getEntries(): McpServerEntry[] {
    return [...this.entries.values()];
  }
}
