import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExaConfig } from "./config.js";
import type { ExaHealth } from "./health.js";
export const SHIPPED_EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,web_fetch_exa";
export interface ToolAvailability { initialLoading?: "immediate" | "deferred"; availabilityNotice?: string }
/** Exact shipped-default migration; customized MCP infrastructure stays explicit. */
export function selectExaMcpServers<T extends { url: string; enabled?: boolean }>(servers: Record<string, T>, config: ExaConfig): Record<string, T> {
  return Object.fromEntries(Object.entries(servers).filter(([name, server]) => server.enabled !== false && !(config.enabled && name === "exa" && server.url === SHIPPED_EXA_MCP_URL)));
}
export function selectExaRetrievalCatalog(tools: AgentTool[], config: ExaConfig, health: ExaHealth, allowed?: readonly string[]): AgentTool[] {
  if (allowed) tools = tools.filter((tool) => allowed.includes(tool.name));
  if (!config.enabled) {
    const names = new Set(tools.map((tool) => tool.name));
    return tools.map((tool) => Object.assign({ ...tool }, {
      ...(tool.name === "web_search" && names.has("mcp_exa_web_search_exa") || tool.name === "web_fetch" && names.has("mcp_exa_web_fetch_exa") ? { initialLoading: "deferred" as const } : {}),
    }));
  }
  const allowedSet = allowed ? new Set(allowed) : undefined;
  const catalog = tools.filter((t) => (!allowedSet || allowedSet.has(t.name)) && !(t.name === "web_search" && config.search.enabled && config.fallback.search === "none" && tools.some((t) => t.name === "exa_search")) && !(t.name === "web_fetch" && config.fetch.enabled && config.fallback.fetch === "none" && tools.some((t) => t.name === "exa_fetch")));
  const names = new Set(catalog.map((t) => t.name));
  return catalog.map((tool) => {
    let initialLoading: ToolAvailability["initialLoading"];
    let availabilityNotice: string | undefined;
    for (const [scope, exa, native, enabled, fallback] of [
      ["search", "exa_search", "web_search", config.search.enabled, config.fallback.search],
      ["contents", "exa_fetch", "web_fetch", config.fetch.enabled, config.fallback.fetch],
    ] as const) {
      const preferred = enabled && names.has(exa);
      const healthy = health.available(scope);
      if (tool.name === exa) { initialLoading = healthy ? "immediate" : "deferred";
        if (!healthy) availabilityNotice = `Exa ${scope} is temporarily unavailable.${fallback === "native" && names.has(native) ? ` ${native} is available for basic fallback.` : " No permitted basic fallback is available."} Exa calls check live health and may recover.`;
      }
      if (tool.name === native && preferred) initialLoading = fallback === "native" && !healthy ? "immediate" : "deferred";
    }
    return Object.assign({ ...tool }, { initialLoading, availabilityNotice });
  });
}
