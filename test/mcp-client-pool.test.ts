import assert from "node:assert/strict";
import test from "node:test";
import { McpClientPool } from "../src/mcp/client-pool.js";
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
});
