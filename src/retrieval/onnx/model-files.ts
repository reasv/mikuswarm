/**
 * Local model files for the in-process ONNX providers (ARCHITECTURE.md §9d
 * "Re-rank stages"): a configured directory, or a Hugging Face repo downloaded
 * once into the cache root. Downloads write to a temp file and rename, so a
 * crash never leaves a truncated file that later looks complete; files that
 * exist are never fetched again.
 */
import { createWriteStream } from "node:fs";
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
  /** Hub base URL (default https://huggingface.co); files at `<base>/<repo>/resolve/main/<file>`. */
  baseUrl?: string;
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

async function download(
  url: string,
  dest: string,
  dispatcher: Dispatcher | undefined,
  signal: AbortSignal | undefined,
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
  if (opts.modelDir) {
    const dir = resolve(opts.modelDir);
    const files = layout(dir, opts.onnxFile);
    for (const path of [files.onnxPath, files.tokenizerPath]) {
      if (!(await exists(path))) throw new Error(`model directory is missing ${path.slice(dir.length + 1)}: ${dir}`);
    }
    return withConfig(files);
  }
  const repo = opts.model?.trim();
  if (!repo) throw new Error("a local model needs a Hugging Face repo id or a model directory");
  const dir = join(resolve(opts.cacheRoot), repoSlug(repo));
  const base = (opts.baseUrl ?? DEFAULT_HF_BASE_URL).replace(/\/+$/, "");
  const repoPath = repo.split("/").map(encodeURIComponent).join("/");
  const dispatcher = opts.httpProxyUrl ? new ProxyAgent(opts.httpProxyUrl) : undefined;
  const fetchFile = async (file: string, required: boolean): Promise<void> => {
    const dest = join(dir, ...file.split("/"));
    if (!dest.startsWith(dir + sep)) throw new Error(`model file escapes the cache: ${file}`);
    if (await exists(dest)) return;
    const url = `${base}/${repoPath}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
    try {
      await download(url, dest, dispatcher, opts.signal);
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
