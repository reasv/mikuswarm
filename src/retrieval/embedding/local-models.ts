import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Logger } from "../../observability/logger.js";

/** The BGE English query instruction for short-query → passage retrieval (model card). */
const BGE_EN_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";
/** The BGE Chinese equivalent. */
const BGE_ZH_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

/**
 * Bumped when a fastembed upgrade changes where its built-in models come from or
 * how they are pooled, so models loaded through fastembed's own table re-embed.
 */
const FASTEMBED_SOURCE_EPOCH = "fastembed-3";

/** The files a fastembed custom model directory must hold besides the ONNX graph. */
const TOKENIZER_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
] as const;

/**
 * A model fetched from a pinned Hugging Face revision and loaded as a fastembed
 * custom model. Pinning the commit (and the graph's sha256) means an upstream
 * re-export can never change the vectors while the index's model id stays the same.
 */
export interface HfModelSource {
  repo: string;
  revision: string;
  onnxFile: string;
  onnxSha256: string;
  pooling: "cls" | "mean";
}

export interface LocalModelSpec {
  /** fastembed built-in model id, downloaded by fastembed itself. Unused when `hf` is set. */
  fastembedId: string;
  hf?: HfModelSource;
  /** Prepended to every query before embedding. */
  queryPrefix: string;
  /** Prepended to every document before embedding. */
  passagePrefix: string;
}

/**
 * Per-model prefixes and weight sources, keyed by the `[retrieval.embedding.local].model`
 * name. Prefixes follow each model's training: BGE takes an instruction on queries and
 * nothing on passages, e5 takes `query: `/`passage: `, MiniLM takes none.
 *
 * The BGE v1.5 English models load BAAI's own fp32 ONNX export. fastembed's built-in
 * source for them is an fp16 GPU-optimized export, which gives the same vectors but runs
 * several times slower on CPU, and query embeds run on the main thread.
 */
const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  "bge-small-en-v1.5": {
    fastembedId: "fast-bge-small-en-v1.5",
    hf: {
      repo: "BAAI/bge-small-en-v1.5",
      revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
      onnxFile: "onnx/model.onnx",
      onnxSha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
      pooling: "cls",
    },
    queryPrefix: BGE_EN_QUERY_INSTRUCTION,
    passagePrefix: "",
  },
  "bge-base-en-v1.5": {
    fastembedId: "fast-bge-base-en-v1.5",
    hf: {
      repo: "BAAI/bge-base-en-v1.5",
      revision: "a5beb1e3e68b9ab74eb54cfd186867f64f240e1a",
      onnxFile: "onnx/model.onnx",
      onnxSha256: "9bc579acdba21c253c62a9bf866891355a63ffa3442b52c8a37d75b2ccb91848",
      pooling: "cls",
    },
    queryPrefix: BGE_EN_QUERY_INSTRUCTION,
    passagePrefix: "",
  },
  "bge-small-en": {
    fastembedId: "fast-bge-small-en",
    queryPrefix: BGE_EN_QUERY_INSTRUCTION,
    passagePrefix: "",
  },
  "bge-base-en": {
    fastembedId: "fast-bge-base-en",
    queryPrefix: BGE_EN_QUERY_INSTRUCTION,
    passagePrefix: "",
  },
  "bge-small-zh-v1.5": {
    fastembedId: "fast-bge-small-zh-v1.5",
    queryPrefix: BGE_ZH_QUERY_INSTRUCTION,
    passagePrefix: "",
  },
  "all-MiniLM-L6-v2": {
    fastembedId: "fast-all-MiniLM-L6-v2",
    queryPrefix: "",
    passagePrefix: "",
  },
  "multilingual-e5-large": {
    fastembedId: "fast-multilingual-e5-large",
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
  },
};

export interface ResolvedLocalModel {
  /** The configured model name. */
  name: string;
  spec: LocalModelSpec;
  queryPrefix: string;
  passagePrefix: string;
  /**
   * The index's model id: `local:<name>#<hash>`, the hash covering the weight source
   * and both prefixes. Any change to them changes the vectors, so it changes this id
   * and the single-active-model switch re-embeds the corpus.
   */
  modelId: string;
}

export interface LocalModelOverrides {
  queryPrefix?: string;
  passagePrefix?: string;
}

/**
 * Resolve a configured local model name. A name may also be a fastembed model id
 * (`fast-bge-small-en-v1.5`). An unknown name is passed to fastembed unchanged with
 * no prefixes; the overrides supply them.
 */
export function resolveLocalModel(name: string, overrides: LocalModelOverrides = {}): ResolvedLocalModel {
  const spec =
    LOCAL_MODELS[name] ??
    Object.values(LOCAL_MODELS).find((s) => s.fastembedId === name) ?? {
      fastembedId: name,
      queryPrefix: "",
      passagePrefix: "",
    };
  const queryPrefix = overrides.queryPrefix ?? spec.queryPrefix;
  const passagePrefix = overrides.passagePrefix ?? spec.passagePrefix;
  const source = spec.hf
    ? { hf: spec.hf.repo, revision: spec.hf.revision, file: spec.hf.onnxFile, pooling: spec.hf.pooling }
    : { fastembed: spec.fastembedId, epoch: FASTEMBED_SOURCE_EPOCH };
  const hash = createHash("sha256")
    .update(JSON.stringify({ source, queryPrefix, passagePrefix }))
    .digest("hex")
    .slice(0, 12);
  return { name, spec, queryPrefix, passagePrefix, modelId: `local:${name}#${hash}` };
}

export interface EnsureHfModelOptions {
  /** Hub base URL. Defaults to `$HF_ENDPOINT`, else https://huggingface.co (the convention fastembed also follows). */
  endpoint?: string;
  logger?: Logger;
}

/**
 * Download a pinned Hugging Face model into `<cacheDir>/<owner>_<repo>@<revision>/`
 * and return that directory. Present files are skipped, so an interrupted download
 * resumes with the missing ones. Each file is written to `<file>.part` and renamed
 * into place only once complete; the ONNX graph is also checked against its pinned
 * sha256, so a corrupt or substituted file never loads.
 */
export async function ensureHfModel(
  cacheDir: string,
  source: HfModelSource,
  options: EnsureHfModelOptions = {},
): Promise<string> {
  const endpoint = (options.endpoint ?? process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "");
  const dir = path.join(cacheDir, `${source.repo.replace("/", "_")}@${source.revision.slice(0, 12)}`);
  for (const file of [...TOKENIZER_FILES, source.onnxFile]) {
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) continue;
    const url = `${endpoint}/${source.repo}/resolve/${source.revision}/${file}`;
    options.logger?.info("embedding_model_download", { repo: source.repo, file });
    await downloadFile(url, dest, file === source.onnxFile ? source.onnxSha256 : undefined);
  }
  return dir;
}

async function downloadFile(url: string, dest: string, expectedSha256: string | undefined): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`model download failed: ${url}: HTTP ${response.status}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  const hash = createHash("sha256");
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(partial),
    );
    if (expectedSha256) {
      const actual = hash.digest("hex");
      if (actual !== expectedSha256) {
        throw new Error(`model download checksum mismatch: ${url}: expected ${expectedSha256}, got ${actual}`);
      }
    }
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, dest);
}
