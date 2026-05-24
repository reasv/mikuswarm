import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, copyFile } from "node:fs/promises";
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
