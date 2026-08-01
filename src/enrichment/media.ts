import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, copyFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { hashFile } from "../media/cache.js";
import type { AttachmentStore } from "./attachment-store.js";

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
  const hex = await hashFile(filePath);
  return Buffer.from(hex, "hex");
}

export async function saveMediaToWorkspace(params: {
  data: Buffer;
  workspaceRoot: string;
  originalFilename?: string;
  contentType?: string;
  /**
   * Account-scoped subdirectory inside `msg-attach/` (spec MULTI-AGENT-SUPPORT
   * §7.4). When provided the file lands in `msg-attach/<attachSubdir>/filename`
   * and `localPath` reflects the subdir. Absent = legacy flat layout
   * (`msg-attach/filename`), byte-identical to pre-Phase-3 behaviour.
   */
  attachSubdir?: string;
  /**
   * Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / Phase 5d).
   * When provided and ready, the file is inserted into the store and a hardlink
   * is created at the workspace destination. Absent or not-ready = legacy
   * behaviour (direct write to workspace), byte-identical to pre-Phase-5d.
   */
  store?: AttachmentStore;
}): Promise<{ localPath: string; absolutePath: string; contentHash: string }> {
  // Compute sha256 once — used for both the filename prefix and the store key.
  const hashBuf = createHash("sha256").update(params.data).digest();
  const contentHash = hashBuf.toString("hex");
  const filename = generateMediaFilenameFromHash(
    hashBuf.subarray(0, 8),
    params.originalFilename,
    params.contentType,
  );
  const relDir = params.attachSubdir ? `msg-attach/${params.attachSubdir}` : "msg-attach";
  const dir = path.join(params.workspaceRoot, relDir);

  let absolutePath: string;
  if (params.store?.isReady()) {
    absolutePath = await params.store.integrateBuffer({
      data: params.data,
      hash: contentHash,
      destDir: dir,
      filename,
    });
  } else {
    await mkdir(dir, { recursive: true });
    absolutePath = path.join(dir, filename);
    if (!existsSync(absolutePath)) {
      await writeFile(absolutePath, params.data);
    }
  }

  const localPath = `${relDir}/${filename}`;
  return { localPath, absolutePath, contentHash };
}

export async function moveFileToWorkspace(params: {
  sourcePath: string;
  workspaceRoot: string;
  originalFilename?: string;
  contentType?: string;
  /**
   * Account-scoped subdirectory inside `msg-attach/` (spec MULTI-AGENT-SUPPORT
   * §7.4). When provided the file lands in `msg-attach/<attachSubdir>/filename`
   * and `localPath` reflects the subdir. Absent = legacy flat layout
   * (`msg-attach/filename`), byte-identical to pre-Phase-3 behaviour.
   */
  attachSubdir?: string;
  /**
   * Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / Phase 5d).
   * When provided and ready, the file is inserted into the store and a hardlink
   * is created at the workspace destination. Absent or not-ready = legacy
   * behaviour (rename + EXDEV fallback), byte-identical to pre-Phase-5d.
   */
  store?: AttachmentStore;
}): Promise<{ localPath: string; absolutePath: string; contentHash: string }> {
  const hashBuf = await hashFileForMedia(params.sourcePath);
  const contentHash = hashBuf.toString("hex"); // full sha256 hex for store key
  const filename = generateMediaFilenameFromHash(hashBuf.subarray(0, 8), params.originalFilename, params.contentType);
  const relDir = params.attachSubdir ? `msg-attach/${params.attachSubdir}` : "msg-attach";
  const dir = path.join(params.workspaceRoot, relDir);

  let absolutePath: string;
  if (params.store?.isReady()) {
    absolutePath = await params.store.integrateDownload({
      sourcePath: params.sourcePath,
      destDir: dir,
      filename,
      hash: contentHash,
    });
  } else {
    await mkdir(dir, { recursive: true });
    absolutePath = path.join(dir, filename);
    if (existsSync(absolutePath)) {
      await unlink(params.sourcePath).catch(() => {});
    } else {
      try {
        await rename(params.sourcePath, absolutePath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          await copyFile(params.sourcePath, absolutePath);
          await unlink(params.sourcePath).catch(() => {});
        } else {
          throw err;
        }
      }
    }
  }

  const localPath = `${relDir}/${filename}`;
  return { localPath, absolutePath, contentHash };
}

export function generateTempDownloadPath(workspaceRoot: string): string {
  // Temp files live in the msg-attach root (not in any account subdir) so the
  // rename-into-subdir stays on the same filesystem mount — EXDEV never fires
  // for within-workspace moves, and the startup orphan-cleanup finds them at
  // msg-attach/.tmp-* regardless of which subdir the final file lands in.
  return path.join(workspaceRoot, "msg-attach", `.tmp-${randomBytes(8).toString("hex")}`);
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
