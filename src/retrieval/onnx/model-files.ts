/**
 * Local model files for the in-process ONNX providers (ARCHITECTURE.md §9d
 * "Re-rank stages"): a configured directory, or a Hugging Face repo downloaded
 * once into the cache root. Downloads write to a temp file and rename, so a
 * crash never leaves a truncated file that later looks complete; files that
 * exist are never fetched again.
 *
 * Pinning: `revision` (a commit) downloads that commit into its own cache
 * directory (`<slug>@<commit prefix>`), so an upstream push never changes the
 * files under a running index; `sha256` (per file) refuses a download, a
 * cached file or a `modelDir` file whose digest does not match. Concurrent
 * resolves of the same file share one download.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fetch, ProxyAgent, type Dispatcher } from "undici";

export const DEFAULT_HF_BASE_URL = "https://huggingface.co";

/** Fetched when present; a missing one is not an error. */
const OPTIONAL_FILES = ["config.json", "tokenizer_config.json", "special_tokens_map.json"];

export interface ResolveModelFilesOptions {
  /** Hugging Face repo id (`org/name`), used when `modelDir` is unset. */
  model?: string;
  /** A local directory holding the files; nothing is downloaded. */
  modelDir?: string;
  /** The ONNX file, relative to the model root (e.g. `onnx/model.onnx`). */
  onnxFile: string;
  /** Downloads go to `<cacheRoot>/<repo slug>/`. */
  cacheRoot: string;
  httpProxyUrl?: string;
  /** Hub base URL (default https://huggingface.co); files at `<base>/<repo>/resolve/<revision>/<file>`. */
  baseUrl?: string;
  /** Pinned commit (default: `main`, unpinned). */
  revision?: string;
  /** Expected sha256 per file (relative path → hex digest). */
  sha256?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ModelFiles {
  dir: string;
  onnxPath: string;
  tokenizerPath: string;
  /** config.json when present. */
  configPath?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Cache directory name for a repo id: `org/name` → `org--name`. */
export function repoSlug(repo: string): string {
  return repo
    .trim()
    .replace(/[\\/]+/g, "--")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

function assertRelative(file: string): void {
  if (file.startsWith("/") || file.split(/[\\/]/).includes("..")) {
    throw new Error(`model file path must be relative to the model root: ${file}`);
  }
}

class NotFoundError extends Error {}

/** In-flight downloads by destination: concurrent resolves share one. */
const inflight = new Map<string, Promise<void>>();
/** Files whose digest matched, by path and size/mtime (hashed once per process). */
const verified = new Map<string, string>();

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Throw unless `path` has the expected digest (cached per path, size and mtime). */
async function verifyFile(path: string, expected: string | undefined, label: string): Promise<void> {
  if (!expected) return;
  const st = await stat(path);
  const stamp = `${st.size}:${st.mtimeMs}:${expected}`;
  if (verified.get(path) === stamp) return;
  const actual = await sha256File(path);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`model file checksum mismatch: ${label}: expected ${expected}, got ${actual}`);
  }
  verified.set(path, stamp);
}

async function download(
  url: string,
  dest: string,
  dispatcher: Dispatcher | undefined,
  signal: AbortSignal | undefined,
  expectedSha256?: string,
): Promise<void> {
  const res = await fetch(url, { dispatcher, signal, redirect: "follow" });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    throw new NotFoundError(`not found: ${url}`);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`download failed (HTTP ${res.status}): ${url}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(tmp), { signal });
    await verifyFile(tmp, expectedSha256, url);
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Resolve (and if needed download) a local model's files. With `modelDir` the
 * directory must already hold `tokenizer.json` and the ONNX file. Otherwise
 * `tokenizer.json` and the ONNX file are required downloads; config.json,
 * tokenizer_config.json, special_tokens_map.json and the ONNX external-data
 * file (`<onnxFile>_data`, for models over 2 GB) are fetched when present.
 */
export async function resolveModelFiles(opts: ResolveModelFilesOptions): Promise<ModelFiles> {
  assertRelative(opts.onnxFile);
  const expected = (file: string): string | undefined => opts.sha256?.[file];
  if (opts.modelDir) {
    const dir = resolve(opts.modelDir);
    const files = layout(dir, opts.onnxFile);
    for (const path of [files.onnxPath, files.tokenizerPath]) {
      if (!(await exists(path))) throw new Error(`model directory is missing ${path.slice(dir.length + 1)}: ${dir}`);
    }
    for (const [file, digest] of Object.entries(opts.sha256 ?? {})) {
      assertRelative(file);
      await verifyFile(join(dir, ...file.split("/")), digest, `${dir}/${file}`);
    }
    return withConfig(files);
  }
  const repo = opts.model?.trim();
  if (!repo) throw new Error("a local model needs a Hugging Face repo id or a model directory");
  const revision = opts.revision?.trim() || undefined;
  const dir = join(resolve(opts.cacheRoot), revision ? `${repoSlug(repo)}@${revision.slice(0, 12)}` : repoSlug(repo));
  const base = (opts.baseUrl ?? DEFAULT_HF_BASE_URL).replace(/\/+$/, "");
  const repoPath = repo.split("/").map(encodeURIComponent).join("/");
  const ref = encodeURIComponent(revision ?? "main");
  const dispatcher = opts.httpProxyUrl ? new ProxyAgent(opts.httpProxyUrl) : undefined;
  const fetchFile = async (file: string, required: boolean): Promise<void> => {
    const dest = join(dir, ...file.split("/"));
    if (!dest.startsWith(dir + sep)) throw new Error(`model file escapes the cache: ${file}`);
    // Registered before the first await, so a concurrent resolve joins this one.
    let task = inflight.get(dest);
    if (!task) {
      const url = `${base}/${repoPath}/resolve/${ref}/${file.split("/").map(encodeURIComponent).join("/")}`;
      const own: Promise<void> = (async () => {
        if (await exists(dest)) await verifyFile(dest, expected(file), dest);
        else await download(url, dest, dispatcher, opts.signal, expected(file));
      })().finally(() => {
        if (inflight.get(dest) === own) inflight.delete(dest);
      });
      inflight.set(dest, own);
      task = own;
    }
    try {
      await task;
    } catch (error) {
      if (!required && error instanceof NotFoundError) return;
      throw error;
    }
  };
  try {
    await fetchFile("tokenizer.json", true);
    for (const file of OPTIONAL_FILES) await fetchFile(file, false);
    await fetchFile(opts.onnxFile, true);
    await fetchFile(`${opts.onnxFile}_data`, false);
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
  return withConfig(layout(dir, opts.onnxFile));
}

function layout(dir: string, onnxFile: string): ModelFiles {
  return { dir, onnxPath: join(dir, ...onnxFile.split("/")), tokenizerPath: join(dir, "tokenizer.json") };
}

async function withConfig(files: ModelFiles): Promise<ModelFiles> {
  const configPath = join(files.dir, "config.json");
  try {
    if ((await stat(configPath)).isFile()) return { ...files, configPath };
  } catch {
    // no config.json
  }
  return files;
}
