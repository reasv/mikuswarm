// Thin REST client for the CloakBrowser-Manager (spec §2). The Manager is an
// operator-run sibling service; this client only *connects* over HTTP and never
// manages its container (§3.4). All failures to reach it map to a
// `backend_unavailable` BrowserError so the tool can degrade gracefully.

import type { Logger } from "../observability/logger.js";
import { BrowserError } from "./errors.js";

// Subset of the Manager's ProfileResponse (backend/models.py) that we consume.
export interface ManagerProfile {
  id: string;
  name: string;
  fingerprint_seed: number;
  status: string; // "running" | "stopped"
  cdp_url: string | null; // e.g. "/api/profiles/{id}/cdp"
}

// Subset of ProfileStatusResponse.
export interface ManagerProfileStatus {
  status: string; // "running" | "stopped"
  cdp_url: string | null;
  display?: string | null;
  vnc_ws_port?: number | null;
}

// Fields we set on profile creation (spec §4). Names match ProfileCreate; we
// only send what we manage and let the Manager default the rest.
export interface ProfileCreateInput {
  name: string;
  platform: "windows" | "macos" | "linux";
  fingerprint_seed?: number;
  timezone?: string;
  locale?: string;
  proxy?: string;
  humanize: boolean;
  geoip: boolean;
  auto_launch: boolean;
  screen_width?: number;
  screen_height?: number;
}

export class ManagerClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(opts: {
    baseUrl: string;
    authToken?: string;
    timeoutMs: number;
    logger: Logger;
  }) {
    // Normalize to no trailing slash so path concatenation is predictable.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authToken = opts.authToken;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger;
  }

  /** Absolute base URL (no trailing slash) — used to build the CDP endpoint. */
  get base(): string {
    return this.baseUrl;
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserError(
        "backend_unavailable",
        `CloakBrowser-Manager unreachable at ${this.baseUrl} (${message}). ` +
          `Is the operator service up? (docker compose -f docker/docker-compose.browser.yml up -d)`,
        { cause: error },
      );
    }

    if (response.status === 401) {
      throw new BrowserError(
        "auth_failed",
        `CloakBrowser-Manager rejected the auth token (401). Check that [browser].auth_token matches the Manager's AUTH_TOKEN.`,
      );
    }
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new BrowserError(
        "backend_unavailable",
        `CloakBrowser-Manager ${method} ${path} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    // Some endpoints (stop) return {"ok": true}; tolerate empty/non-JSON bodies.
    const text = await safeReadText(response);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new BrowserError(
        "backend_unavailable",
        `CloakBrowser-Manager ${method} ${path} returned non-JSON body`,
        { cause: error },
      );
    }
  }

  listProfiles(): Promise<ManagerProfile[]> {
    return this.request<ManagerProfile[]>("GET", "/api/profiles");
  }

  createProfile(input: ProfileCreateInput): Promise<ManagerProfile> {
    return this.request<ManagerProfile>("POST", "/api/profiles", input);
  }

  getStatus(profileId: string): Promise<ManagerProfileStatus> {
    return this.request<ManagerProfileStatus>(
      "GET",
      `/api/profiles/${encodeURIComponent(profileId)}/status`,
    );
  }

  /**
   * Launch a profile. The Manager returns 409 if it is already running — we treat
   * that as success (idempotent ensure-launched), since our goal is "running".
   */
  async launch(profileId: string): Promise<void> {
    try {
      await this.request("POST", `/api/profiles/${encodeURIComponent(profileId)}/launch`);
    } catch (error) {
      if (error instanceof BrowserError && /HTTP 409/.test(error.message)) {
        this.logger.debug("profile_already_running", { profileId });
        return;
      }
      if (error instanceof BrowserError && error.code === "backend_unavailable") {
        // Distinguish a launch failure from a transport failure where possible.
        throw new BrowserError(
          "profile_launch_failed",
          `Failed to launch browser profile: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
