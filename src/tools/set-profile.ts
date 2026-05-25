import { readFile, stat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";
import { assertPublicHttpUrl } from "./ssrf.js";

export interface SetProfileToolContext {
  client: MatrixNativeClient;
}

const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

export function createSetProfileTool(context: SetProfileToolContext): AgentTool {
  return {
    name: "set_profile",
    label: "Set profile",
    description: "Change the bot's display name and/or avatar. Avatar can be an mxc:// URI, an HTTP URL, or a local file path.",
    parameters: Type.Object({
      display_name: Type.Optional(Type.String({ description: "New display name. Empty string clears it." })),
      avatar: Type.Optional(Type.String({ description: "Avatar source: mxc:// URI, HTTP(S) URL, or local file path. Max 10 MB." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { display_name?: string; avatar?: string };

      if (args.display_name == null && !args.avatar?.trim()) {
        return {
          content: [{ type: "text", text: "error: at least one of display_name or avatar is required." }],
          details: null,
        };
      }

      try {
        let avatarDataBase64: string | undefined;
        let avatarContentType: string | undefined;
        let avatarUrl: string | undefined;

        if (args.avatar?.trim()) {
          const source = args.avatar.trim();
          if (source.startsWith("mxc://")) {
            avatarUrl = source;
          } else if (/^https?:\/\//i.test(source)) {
            try {
              await assertPublicHttpUrl(source);
            } catch (ssrfErr) {
              const msg = ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr);
              return {
                content: [{ type: "text", text: `error: avatar URL blocked: ${msg}` }],
                details: null,
              };
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30_000);
            let response: Response;
            try {
              response = await globalThis.fetch(source, {
                headers: { "User-Agent": "MikuAgent/1.0" },
                redirect: "follow",
                signal: controller.signal,
              });
            } catch (fetchErr) {
              clearTimeout(timeout);
              const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              return {
                content: [{ type: "text", text: `error: avatar download failed: ${msg}` }],
                details: null,
              };
            }
            if (!response.ok) {
              clearTimeout(timeout);
              return {
                content: [{ type: "text", text: `error: avatar download failed: HTTP ${response.status}` }],
                details: null,
              };
            }

            const declaredLength = Number(response.headers.get("content-length"));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
              clearTimeout(timeout);
              return {
                content: [{ type: "text", text: `error: avatar exceeds 10 MB limit (${declaredLength} bytes)` }],
                details: null,
              };
            }

            let buf: Buffer;
            try {
              buf = Buffer.from(await response.arrayBuffer());
            } finally {
              clearTimeout(timeout);
            }
            if (buf.byteLength > MAX_AVATAR_BYTES) {
              return {
                content: [{ type: "text", text: `error: avatar exceeds 10 MB limit (${buf.byteLength} bytes)` }],
                details: null,
              };
            }
            avatarDataBase64 = buf.toString("base64");
            avatarContentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/png";
          } else {
            const stats = await stat(source);
            if (stats.size > MAX_AVATAR_BYTES) {
              return {
                content: [{ type: "text", text: `error: avatar exceeds 10 MB limit (${stats.size} bytes)` }],
                details: null,
              };
            }
            const buf = await readFile(source);
            avatarDataBase64 = buf.toString("base64");
            avatarContentType = guessImageType(source);
          }
        }

        const result = await context.client.setProfile({
          displayName: args.display_name,
          avatarUrl,
          avatarDataBase64,
          avatarContentType,
        });

        const parts: string[] = [];
        if (result.displayName != null) parts.push(`display name: ${result.displayName}`);
        if (result.avatarUrl != null) parts.push(`avatar: ${result.avatarUrl}`);
        return {
          content: [{ type: "text", text: parts.length > 0 ? `profile updated: ${parts.join(", ")}` : "profile updated" }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: set profile failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}

function guessImageType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
  };
  return map[ext ?? ""] ?? "image/png";
}
