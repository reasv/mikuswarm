import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { CallToolResultSchema, type CallToolResult, type Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../observability/logger.js";
import { isSessionTerminatedError, type McpClientPool } from "./client-pool.js";

export function adaptMcpTool(
  serverName: string,
  toolDef: McpToolDef,
  pool: McpClientPool,
  logger: Logger,
): AgentTool {
  const name = `mcp_${serverName}_${toolDef.name}`;
  const parameters = Type.Unsafe(
    toolDef.inputSchema ?? { type: "object", properties: {} },
  );

  return {
    name,
    label: `MCP: ${serverName}/${toolDef.name}`,
    description: toolDef.description ?? `MCP tool ${toolDef.name} from ${serverName}`,
    parameters,
    execute: async (
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<unknown>> => {
      const args = (params ?? {}) as Record<string, unknown>;
      // Resolve the live client per call: reconnect() swaps in a fresh client on
      // session loss, so a reference captured at adapter-build time would go stale.
      const invoke = async (): Promise<CallToolResult> => {
        const client = pool.getClient(serverName);
        if (!client) {
          throw new Error(`MCP server "${serverName}" is not connected`);
        }
        // CallToolResultSchema validates at runtime, so the cast is safe
        return (await client.callTool(
          { name: toolDef.name, arguments: args },
          CallToolResultSchema,
          { signal },
        )) as CallToolResult;
      };

      try {
        let result: CallToolResult;
        try {
          result = await invoke();
        } catch (error) {
          // A dead Streamable HTTP session (server restart / timeout / LB
          // re-route) is recoverable: re-initialize once and retry. Don't
          // recover a caller-driven abort or a genuine tool error.
          if (signal?.aborted || !isSessionTerminatedError(error)) {
            throw error;
          }
          logger.warn("mcp_session_reconnect", {
            server: serverName,
            tool: toolDef.name,
            error: error instanceof Error ? error.message : String(error),
          });
          try {
            await pool.reconnect(serverName);
          } catch {
            // Reconnect failed (server still down) — surface the original,
            // more informative session error rather than the reconnect error.
            throw error;
          }
          result = await invoke();
        }

        if (result.isError) {
          const errorText = result.content
            .filter((c) => c.type === "text" && "text" in c)
            .map((c) => (c as { text: string }).text)
            .join("\n") || "MCP tool returned an error";
          throw new Error(errorText);
        }

        const content = result.content.map(
          (block) => {
            if (block.type === "text") {
              return { type: "text" as const, text: block.text ?? "" };
            }
            if (block.type === "image") {
              return {
                type: "image" as const,
                data: block.data ?? "",
                mimeType: block.mimeType ?? "application/octet-stream",
              };
            }
            return { type: "text" as const, text: JSON.stringify(block) };
          },
        );

        return {
          content: content.length > 0
            ? content
            : [{ type: "text", text: "(empty result)" }],
          details: { server: serverName, tool: toolDef.name },
        };
      } catch (error) {
        logger.warn("mcp_tool_error", {
          server: serverName,
          tool: toolDef.name,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export function adaptMcpTools(
  serverName: string,
  tools: McpToolDef[],
  pool: McpClientPool,
  logger: Logger,
): AgentTool[] {
  return tools.map((toolDef) =>
    adaptMcpTool(serverName, toolDef, pool, logger),
  );
}
