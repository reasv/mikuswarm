import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, copyFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export class MediaCache {
  constructor(private readonly cacheDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
  }

  async get(hash: string): Promise<string | null> {
    const path = this.pathForHash(hash);
    try {
      await access(path);
      return path;
    } catch {
      return null;
    }
  }

  async put(hash: string, sourcePath: string): Promise<string> {
    const dest = this.pathForHash(hash);
    await copyFile(sourcePath, dest);
    return dest;
  }

  async evictIfNeeded(maxBytes: number, targetBytes: number): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.cacheDir);
    } catch {
      return;
    }
    const mp4Files = files.filter(f => f.endsWith(".mp4"));
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let totalSize = 0;
    for (const f of mp4Files) {
      const filePath = join(this.cacheDir, f);
      try {
        const s = await stat(filePath);
        entries.push({ path: filePath, size: s.size, mtimeMs: s.mtimeMs });
        totalSize += s.size;
      } catch {
        // file may have been removed concurrently
      }
    }
    if (totalSize <= maxBytes) return;

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (totalSize <= targetBytes) break;
      await unlink(entry.path).catch(() => {});
      totalSize -= entry.size;
    }
  }

  private pathForHash(hash: string): string {
    return join(this.cacheDir, `${hash}.mp4`);
  }
}

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
