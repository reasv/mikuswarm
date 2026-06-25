import assert from "node:assert/strict";
import test from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { adaptMcpTool } from "../src/mcp/tool-adapter.js";
import type { McpClientPool } from "../src/mcp/client-pool.js";
import type { Logger } from "../src/observability/logger.js";

function noopLogger(): Logger {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const TOOL_DEF = {
  name: "browse_library",
  description: "Browse the library",
  inputSchema: { type: "object" as const, properties: {} },
};

/** A fake client whose callTool runs a caller-supplied behavior per invocation. */
function fakeClient(behavior: () => Promise<CallToolResult>) {
  return { callTool: async () => behavior() };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

test("adapter reconnects once and retries on a lost session", async () => {
  let reconnects = 0;
  let index = 0;
  const clients = [
    fakeClient(async () => {
      throw new StreamableHTTPError(400, "Error POSTing to endpoint: Bad Request: Server not initialized");
    }),
    fakeClient(async () => textResult("ok")),
  ];
  const pool = {
    getClient: () => clients[index],
    reconnect: async () => {
      reconnects += 1;
      index += 1;
    },
  } as unknown as McpClientPool;

  const tool = adaptMcpTool("mikuplex", TOOL_DEF, pool, noopLogger());
  const result = await tool.execute("call-1", {}, undefined as never);

  assert.equal(reconnects, 1, "should reconnect exactly once");
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
});

test("adapter surfaces the original session error if reconnect fails", async () => {
  let reconnects = 0;
  const client = fakeClient(async () => {
    throw new StreamableHTTPError(404, "Error POSTing to endpoint: Not Found");
  });
  const pool = {
    getClient: () => client,
    reconnect: async () => {
      reconnects += 1;
      throw new Error("server still down");
    },
  } as unknown as McpClientPool;

  const tool = adaptMcpTool("mikuplex", TOOL_DEF, pool, noopLogger());
  await assert.rejects(
    () => tool.execute("call-2", {}, undefined as never),
    /Server not initialized|Not Found|Streamable HTTP error/,
  );
  assert.equal(reconnects, 1, "should attempt reconnect once, then give up");
});

test("adapter does NOT reconnect on an ordinary tool error", async () => {
  let reconnects = 0;
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    return { isError: true, content: [{ type: "text", text: "bad argument" }] };
  });
  const pool = {
    getClient: () => client,
    reconnect: async () => {
      reconnects += 1;
    },
  } as unknown as McpClientPool;

  const tool = adaptMcpTool("mikuplex", TOOL_DEF, pool, noopLogger());
  await assert.rejects(() => tool.execute("call-3", {}, undefined as never), /bad argument/);
  assert.equal(reconnects, 0, "isError results are not session failures");
  assert.equal(calls, 1, "should not retry a genuine tool error");
});

test("adapter does NOT reconnect when the call is aborted", async () => {
  let reconnects = 0;
  const controller = new AbortController();
  const client = fakeClient(async () => {
    controller.abort();
    throw new StreamableHTTPError(400, "Error POSTing to endpoint: Bad Request: Server not initialized");
  });
  const pool = {
    getClient: () => client,
    reconnect: async () => {
      reconnects += 1;
    },
  } as unknown as McpClientPool;

  const tool = adaptMcpTool("mikuplex", TOOL_DEF, pool, noopLogger());
  await assert.rejects(() => tool.execute("call-4", {}, controller.signal as never));
  assert.equal(reconnects, 0, "an aborted call must not trigger a reconnect");
});
