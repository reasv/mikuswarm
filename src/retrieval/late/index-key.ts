/**
 * The key of the late-interaction vector index (`memory_late_vectors.model`,
 * ARCHITECTURE.md §9d "Late interaction"): the index model plus a digest of
 * every document-side setting that shapes the stored vectors (per document
 * chain member: the model, a local model's pinned revision, ONNX file and file
 * digests, and the document prefix and token limit). Changing any of them
 * starts a new index, which the indexer fills while the old one is pruned,
 * so vectors of two spaces never mix. Query-side settings are not part of it.
 */
import { createHash } from "node:crypto";
import type { ResolvedRetrievalConfig } from "../config.js";

export function lateIndexKey(config: ResolvedRetrievalConfig["late"]): string {
  const parts = new Set<string>();
  for (const name of config.chain) {
    const p = config.providers[name];
    if (!p) continue;
    parts.add(
      JSON.stringify(
        p.kind === "local"
          ? {
              kind: "local",
              model: p.model ?? null,
              dir: p.model ? null : (p.modelDir ?? null),
              revision: p.revision ?? null,
              onnx: p.onnxFile,
              sha256: p.sha256 ? Object.entries(p.sha256).sort() : null,
              prefix: p.documentPrefix,
              maxTokens: p.maxTokens,
            }
          : { kind: "remote", model: p.model ?? null, prefix: p.documentPrefix, maxTokens: p.maxTokens },
      ),
    );
  }
  const digest = createHash("sha256").update([...parts].sort().join("\n")).digest("hex").slice(0, 12);
  return `${config.model}#${digest}`;
}
