import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export function generateMediaFilename(data: Buffer, originalFilename?: string, contentType?: string): string {
  const hash = createHash("sha256").update(data).digest();
  const prefix = encodeBase32(hash.subarray(0, 8));
  const ext = extensionFromFilename(originalFilename) || extensionFromMime(contentType) || "";
  return `${prefix}${ext}`;
}

export async function saveMediaToWorkspace(params: {
  data: Buffer;
  workspaceRoot: string;
  originalFilename?: string;
  contentType?: string;
}): Promise<{ localPath: string; absolutePath: string }> {
  const filename = generateMediaFilename(params.data, params.originalFilename, params.contentType);
  const dir = path.join(params.workspaceRoot, "msg-attach");
  await mkdir(dir, { recursive: true });
  const absolutePath = path.join(dir, filename);
  if (!existsSync(absolutePath)) {
    await writeFile(absolutePath, params.data);
  }
  const localPath = `msg-attach/${filename}`;
  return { localPath, absolutePath };
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBase32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

function extensionFromFilename(filename?: string): string {
  if (!filename) return "";
  const ext = path.extname(filename);
  return ext || "";
}

function extensionFromMime(contentType?: string): string {
  if (!contentType) return "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/flac": ".flac",
    "application/octet-stream": "",
  };
  return map[mime] ?? "";
}
