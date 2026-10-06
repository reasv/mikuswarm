import type { AppConfig } from "../config/schema.js";
import { EXA_EFFORTS, type ExaEffort, type ExaSearchMode } from "./types.js";
export interface ExaConfig {
  enabled: boolean; api_key: string; request_timeout_ms: number; max_in_flight: number; requests_per_second: number;
  search: { enabled: boolean; default_results: number; max_results: number; highlight_chars: number; allowed_modes: ExaSearchMode[]; advanced_timeout_ms: number };
  fetch: { enabled: boolean; max_urls: number; display_chars: number; extraction_chars: number; max_extraction_chars: number; content_ttl_hours: number; content_store_max_bytes: number };
  research: { enabled: boolean; default_effort: ExaEffort; max_effort: ExaEffort; allowed_data_sources: string[]; max_in_flight: number; poll_interval_ms: number; wait_timeout_ms: number };
  fallback: { search: "native" | "none"; fetch: "native" | "none" };
}
export function resolveExaConfig(raw: AppConfig["exa"]): ExaConfig {
  const config: ExaConfig = {
    enabled: raw?.enabled ?? false, api_key: raw?.api_key ?? "", request_timeout_ms: raw?.request_timeout_ms ?? 30000,
    max_in_flight: raw?.max_in_flight ?? 3, requests_per_second: raw?.requests_per_second ?? 3,
    search: { enabled: true, default_results: 10, max_results: 20, highlight_chars: 1500, allowed_modes: ["auto", "fast", "instant", "deep", "deep-reasoning"], advanced_timeout_ms: 90000, ...raw?.search },
    fetch: { enabled: true, max_urls: 20, display_chars: 8000, extraction_chars: 50000, max_extraction_chars: 200000, content_ttl_hours: 24, content_store_max_bytes: 104857600, ...raw?.fetch },
    research: { enabled: false, default_effort: "low", max_effort: "medium", allowed_data_sources: [], max_in_flight: 2, poll_interval_ms: 3000, wait_timeout_ms: 900000, ...raw?.research },
    fallback: { search: "native", fetch: "native", ...raw?.fallback },
  };
  if (config.enabled && !config.api_key.trim()) throw new Error("Invalid config: exa.enabled requires a nonblank exa.api_key.");
  if (config.search.default_results > config.search.max_results) throw new Error("Invalid config: exa.search.default_results exceeds max_results.");
  if (config.search.enabled && !config.search.allowed_modes.includes("auto")) throw new Error("Invalid config: exa.search.allowed_modes must include auto for basic search.");
  if (config.fetch.extraction_chars > config.fetch.max_extraction_chars || config.fetch.display_chars > config.fetch.extraction_chars) throw new Error("Invalid config: exa.fetch requires display_chars <= extraction_chars <= max_extraction_chars.");
  if (EXA_EFFORTS.indexOf(config.research.default_effort) > EXA_EFFORTS.indexOf(config.research.max_effort)) throw new Error("Invalid config: exa.research.default_effort exceeds max_effort.");
  if (config.research.poll_interval_ms > config.research.wait_timeout_ms) throw new Error("Invalid config: exa.research.poll_interval_ms exceeds wait_timeout_ms.");
  return config;
}
