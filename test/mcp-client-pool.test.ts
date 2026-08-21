import assert from "node:assert/strict";
import test from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import {
  McpClientPool,
  isSessionTerminatedError,
  startupRetryDelayMs,
  type McpClientPoolOptions,
  type McpServerConfig,
  type McpServerEntry,
} from "../src/mcp/client-pool.js";
import type { Logger } from "../src/observability/logger.js";

function createMockLogger(): Logger & { errors: { message: string; fields?: Record<string, unknown> }[] } {
  const errors: { message: string; fields?: Record<string, unknown> }[] = [];
  const noop = () => {};
  const logger: Logger & { errors: typeof errors } = {
    errors,
    debug: noop,
    info: noop,
    warn: noop,
    error: (message: string, fields?: Record<string, unknown>) => {
      errors.push({ message, fields });
    },
    child: () => logger,
  };
  return logger;
}

test("McpClientPool rejects server keys with underscores", async () => {
  const logger = createMockLogger();
  const pool = new McpClientPool({
    servers: {
      "my_server": { url: "http://localhost:8080" },
    },
    logger,
  });
  await pool.start();

  assert.equal(pool.getEntries().length, 0, "should not connect to server with underscore key");
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].message, "mcp_server_invalid_key");
  assert.equal(logger.errors[0].fields?.server, "my_server");
});

test("McpClientPool rejects server keys starting with digit", async () => {
  const logger = createMockLogger();
  const pool = new McpClientPool({
    servers: {
      "1server": { url: "http://localhost:8080" },
    },
    logger,
  });
  await pool.start();

  assert.equal(pool.getEntries().length, 0, "should not connect to server with digit-leading key");
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].message, "mcp_server_invalid_key");
});

test("McpClientPool rejects server keys with uppercase letters", async () => {
  const logger = createMockLogger();
  const pool = new McpClientPool({
    servers: {
      "MyServer": { url: "http://localhost:8080" },
    },
    logger,
  });
  await pool.start();

  assert.equal(pool.getEntries().length, 0, "should not connect to server with uppercase key");
  assert.equal(logger.errors.length, 1);
  assert.equal(logger.errors[0].message, "mcp_server_invalid_key");
});

test("McpClientPool accepts valid server keys with lowercase and hyphens", async () => {
  const logger = createMockLogger();
  const pool = new McpClientPool({
    servers: {
      // This will fail to connect since there's no real server,
      // but it should pass key validation first
      "my-server": { url: "http://localhost:9999" },
    },
    logger,
  });
  await pool.start();

  // Key validation should pass, so the error should be a connection failure, not an invalid key
  const invalidKeyErrors = logger.errors.filter(
    (e) => e.message === "mcp_server_invalid_key",
  );
  assert.equal(invalidKeyErrors.length, 0, "valid key should not trigger key validation error");

  // Connection will fail, but that's expected
  const connectErrors = logger.errors.filter(
    (e) => e.message === "mcp_server_connect_failed",
  );
  assert.equal(connectErrors.length, 1, "should attempt connection for valid key");
  // Cancel the background startup retry the failed connect scheduled.
  await pool.stop();
});

test("reconnect rejects for an unknown / never-connected server", async () => {
  const logger = createMockLogger();
  const pool = new McpClientPool({ servers: {}, logger });
  await pool.start();

  await assert.rejects(
    () => pool.reconnect("ghost"),
    /unknown MCP server: ghost/,
  );
  assert.equal(pool.getClient("ghost"), undefined);
});

test("isSessionTerminatedError matches lost-session signals", () => {
  // HTTP 404: server no longer recognizes the session id.
  assert.equal(
    isSessionTerminatedError(new StreamableHTTPError(404, "Error POSTing to endpoint: Not Found")),
    true,
  );
  // HTTP 400 with the canonical "Server not initialized" body.
  assert.equal(
    isSessionTerminatedError(
      new StreamableHTTPError(400, "Error POSTing to endpoint: Bad Request: Server not initialized"),
    ),
    true,
  );
  // Plain-string fallback (e.g. SSE transport or a wrapped error).
  assert.equal(isSessionTerminatedError(new Error("Server not initialized")), true);
  assert.equal(isSessionTerminatedError(new Error("Session has been terminated")), true);
});

test("isSessionTerminatedError ignores transient / unrelated errors", () => {
  // A generic 400 that is not about session state must NOT trigger a reconnect.
  assert.equal(
    isSessionTerminatedError(new StreamableHTTPError(400, "Error POSTing to endpoint: invalid params")),
    false,
  );
  // 500s, network blips, and ordinary tool failures leave the session valid.
  assert.equal(isSessionTerminatedError(new StreamableHTTPError(500, "Internal Server Error")), false);
  assert.equal(isSessionTerminatedError(new Error("ECONNRESET")), false);
  assert.equal(isSessionTerminatedError(new Error("tool failed: bad argument")), false);
});

// ---------------------------------------------------------------------------
// Startup retry: a server that fails its initial connection is retried in the
// background with bounded exponential backoff, and registers late on success.
// ---------------------------------------------------------------------------

interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

function createRecordingLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const record =
    (level: LogEvent["level"]) =>
    (message: string, fields?: Record<string, unknown>) => {
      events.push({ level, message, fields });
    };
  const logger: Logger & { events: LogEvent[] } = {
    events,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
  };
  return logger;
}

function fakeConnection(toolNames: string[], onClose?: () => void): { client: Client; tools: McpToolDef[] } {
  const client = {
    close: async () => {
      onClose?.();
    },
  } as unknown as Client;
  const tools = toolNames.map(
    (name) => ({ name, inputSchema: { type: "object" } }) as McpToolDef,
  );
  return { client, tools };
}

/** Pool whose network handshake is stubbed: fails until `failures` attempts have happened. */
class StubConnectPool extends McpClientPool {
  attempts = 0;
  constructor(
    options: McpClientPoolOptions,
    private readonly failures: number,
    private readonly toolNames: string[] = ["search"],
  ) {
    super(options);
  }
  protected override async connectServer(
    _config: McpServerConfig,
  ): Promise<{ client: Client; tools: McpToolDef[] }> {
    this.attempts++;
    if (this.attempts <= this.failures) throw new Error("fetch failed");
    return fakeConnection(this.toolNames);
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("startupRetryDelayMs doubles per attempt and caps at maxDelayMs", () => {
  assert.equal(startupRetryDelayMs(1, 5000, 60000), 5000);
  assert.equal(startupRetryDelayMs(2, 5000, 60000), 10000);
  assert.equal(startupRetryDelayMs(4, 5000, 60000), 40000);
  assert.equal(startupRetryDelayMs(5, 5000, 60000), 60000);
  assert.equal(startupRetryDelayMs(10, 5000, 60000), 60000);
});

test("startup-failed server connects on a background retry and registers late", async () => {
  const logger = createRecordingLogger();
  const lateEntries: McpServerEntry[] = [];
  // Initial connect + first retry fail; the second retry succeeds.
  const pool = new StubConnectPool(
    {
      servers: { flaky: { url: "http://flaky.invalid" } },
      retry: { maxAttempts: 5, initialDelayMs: 5, maxDelayMs: 20 },
      onLateConnect: (entry) => lateEntries.push(entry),
      logger,
    },
    2,
  );
  await pool.start();
  assert.equal(pool.getEntries().length, 0, "startup connect should have failed");
  assert.equal(pool.attempts, 1);

  await waitFor(() => pool.getEntries().length === 1);
  assert.equal(pool.attempts, 3, "one startup attempt + two background retries");
  assert.equal(lateEntries.length, 1);
  assert.equal(lateEntries[0].name, "flaky");
  assert.deepEqual(
    lateEntries[0].tools.map((t) => t.name),
    ["search"],
  );
  assert.ok(pool.getClient("flaky"), "client is resolvable after late connect");

  const connected = logger.events.find((e) => e.message === "mcp_server_connected");
  assert.equal(connected?.fields?.retryAttempt, 2);

  // A late-connected server has a real entry, so session recovery works too.
  await pool.reconnect("flaky");
  assert.equal(pool.attempts, 4);

  await pool.stop();
});

test("startup retries are bounded and exhaust with an error log", async () => {
  const logger = createRecordingLogger();
  const lateEntries: McpServerEntry[] = [];
  const pool = new StubConnectPool(
    {
      servers: { dead: { url: "http://dead.invalid" } },
      retry: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5 },
      onLateConnect: (entry) => lateEntries.push(entry),
      logger,
    },
    Infinity,
  );
  await pool.start();
  await waitFor(() =>
    logger.events.some((e) => e.message === "mcp_server_startup_retries_exhausted"),
  );
  assert.equal(pool.attempts, 3, "one startup attempt + maxAttempts retries");
  await sleep(30);
  assert.equal(pool.attempts, 3, "no attempts after exhaustion");
  assert.equal(pool.getEntries().length, 0);
  assert.equal(lateEntries.length, 0);
  const exhausted = logger.events.find(
    (e) => e.message === "mcp_server_startup_retries_exhausted",
  );
  assert.equal(exhausted?.level, "error");
  assert.equal(exhausted?.fields?.attempts, 2);
  const retryFailures = logger.events.filter((e) => e.message === "mcp_server_retry_failed");
  assert.equal(retryFailures.length, 2);
  assert.ok(retryFailures.every((e) => e.level === "warn"));
  await pool.stop();
});

test("startup_retry_max_attempts = 0 disables the background retry", async () => {
  const logger = createRecordingLogger();
  const pool = new StubConnectPool(
    {
      servers: { dead: { url: "http://dead.invalid" } },
      retry: { maxAttempts: 0, initialDelayMs: 1, maxDelayMs: 1 },
      logger,
    },
    Infinity,
  );
  await pool.start();
  await sleep(30);
  assert.equal(pool.attempts, 1, "only the startup attempt");
  assert.equal(
    logger.events.filter((e) => e.message === "mcp_server_startup_retries_exhausted").length,
    0,
    "disabled retry is not 'exhausted'",
  );
  await pool.stop();
});

test("stop() cancels pending startup retries", async () => {
  const logger = createRecordingLogger();
  const pool = new StubConnectPool(
    {
      servers: { dead: { url: "http://dead.invalid" } },
      retry: { maxAttempts: 5, initialDelayMs: 50, maxDelayMs: 50 },
      logger,
    },
    Infinity,
  );
  await pool.start();
  assert.equal(pool.attempts, 1);
  await pool.stop();
  await sleep(80);
  assert.equal(pool.attempts, 1, "no retry fires after stop()");
});

test("a retry that connects after stop() is discarded and closed", async () => {
  const logger = createRecordingLogger();
  const lateEntries: McpServerEntry[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let closed = false;

  class GatedPool extends McpClientPool {
    attempts = 0;
    protected override async connectServer(
      _config: McpServerConfig,
    ): Promise<{ client: Client; tools: McpToolDef[] }> {
      this.attempts++;
      if (this.attempts === 1) throw new Error("fetch failed");
      await gate;
      return fakeConnection([], () => {
        closed = true;
      });
    }
  }

  const pool = new GatedPool({
    servers: { slow: { url: "http://slow.invalid" } },
    retry: { maxAttempts: 5, initialDelayMs: 5, maxDelayMs: 5 },
    onLateConnect: (entry) => lateEntries.push(entry),
    logger,
  });
  await pool.start();
  // Wait for the first background retry to be mid-handshake, then stop.
  await waitFor(() => pool.attempts === 2);
  await pool.stop();
  release();
  await sleep(20);
  assert.equal(closed, true, "post-stop connection is closed, not registered");
  assert.equal(pool.getEntries().length, 0);
  assert.equal(lateEntries.length, 0);
});
