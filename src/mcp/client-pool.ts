import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

export interface McpClientPoolOptions {
  servers: Record<string, McpServerConfig>;
  logger: Logger;
}

export class McpClientPool {
  private readonly entries = new Map<string, McpServerEntry>();
  private readonly logger: Logger;

  constructor(private readonly options: McpClientPoolOptions) {
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    for (const [name, config] of Object.entries(this.options.servers)) {
      if (config.headers) {
        for (const value of Object.values(config.headers)) {
          registerSecret(value);
        }
      }

      try {
        const client = new Client({ name: "mikuswarm", version: "1.0.0" });
        const url = new URL(config.url);
        const requestInit: RequestInit = config.headers
          ? { headers: config.headers }
          : {};

        const transport = config.transport === "sse"
          ? new SSEClientTransport(url, { requestInit })
          : new StreamableHTTPClientTransport(url, { requestInit });

        await client.connect(transport);
        const { tools } = await client.listTools();

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
      }
    }
  }

  async stop(): Promise<void> {
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
