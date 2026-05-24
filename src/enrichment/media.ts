import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export function generateMediaFilename(data: Buffer, originalFilename?: string, contentType?: string): string {
  const hash = createHash("sha256").update(data).digest();
  const prefix = encodeBase32(hash.subarray(0, 8));
  const ext = extensionFromFilename(originalFilename) || extensionFromMime(contentType) || "";
  return `${prefix}${ext}`;
}

export function generateMediaFilenameFromHash(hashPrefix: Buffer, originalFilename?: string, contentType?: string): string {
  const prefix = encodeBase32(hashPrefix);
  const ext = extensionFromFilename(originalFilename) || extensionFromMime(contentType) || "";
  return `${prefix}${ext}`;
}

export async function hashFileForMedia(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest()));
    stream.on("error", reject);
  });
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

export async function moveFileToWorkspace(params: {
  sourcePath: string;
  workspaceRoot: string;
  originalFilename?: string;
  contentType?: string;
}): Promise<{ localPath: string; absolutePath: string }> {
  const hashBuf = await hashFileForMedia(params.sourcePath);
  const filename = generateMediaFilenameFromHash(hashBuf.subarray(0, 8), params.originalFilename, params.contentType);
  const dir = path.join(params.workspaceRoot, "msg-attach");
  await mkdir(dir, { recursive: true });
  const absolutePath = path.join(dir, filename);
  if (existsSync(absolutePath)) {
    await unlink(params.sourcePath).catch(() => {});
  } else {
    await rename(params.sourcePath, absolutePath);
  }
  const localPath = `msg-attach/${filename}`;
  return { localPath, absolutePath };
}

export function generateTempDownloadPath(workspaceRoot: string): string {
  const hash = createHash("sha256").update(String(Date.now()) + String(Math.random())).digest("hex").slice(0, 16);
  return path.join(workspaceRoot, "msg-attach", `.tmp-${hash}`);
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
