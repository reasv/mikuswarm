import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type CallToolResult, type Tool as McpToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../observability/logger.js";

export function adaptMcpTool(
  serverName: string,
  toolDef: McpToolDef,
  client: Client,
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
      try {
        // CallToolResultSchema validates at runtime, so the cast is safe
        const result = await client.callTool(
          { name: toolDef.name, arguments: (params ?? {}) as Record<string, unknown> },
          CallToolResultSchema,
          { signal },
        ) as CallToolResult;

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
  client: Client,
  logger: Logger,
): AgentTool[] {
  return tools.map((toolDef) =>
    adaptMcpTool(serverName, toolDef, client, logger),
  );
}
