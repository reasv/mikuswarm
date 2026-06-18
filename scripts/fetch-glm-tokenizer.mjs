#!/usr/bin/env node
// Fetch-on-build for the GLM-5.1 tokenizer (spec/TOKENIZER-SWAP.md §5.2 /
// spec/TOKENIZER-CALIBRATION.md §6). The 20 MB tokenizer.json is NOT committed —
// it is downloaded here from the MIT-licensed zai-org/GLM-5.1 HF repo and
// checksum-verified, so the asset is reproducible without bloating git history.
//
// Run: `node scripts/fetch-glm-tokenizer.mjs` (wired into `pnpm build` and the
// Docker builder stage). Idempotent — a present, checksum-matching file is left
// untouched. Fails loudly on a checksum mismatch (supply-chain integrity): a
// changed upstream never silently swaps the tokenizer the budgets are calibrated
// against.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(REPO_ROOT, "native/assets/glm-5.1/tokenizer.json");
// Override only to point at a mirror / pre-staged copy; the checksum is still
// enforced, so a wrong file fails rather than silently replacing the tokenizer.
const URL =
  process.env.GLM_TOKENIZER_URL ??
  "https://huggingface.co/zai-org/GLM-5.1/resolve/main/tokenizer.json";
// sha256 of zai-org/GLM-5.1 tokenizer.json @ main (BPE, 154820 vocab). The
// calibration in spec/TOKENIZER-CALIBRATION.md was measured against exactly this.
const EXPECTED_SHA256 = "19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function readIfExists(p) {
  try {
    await stat(p);
    return await readFile(p);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function main() {
  const existing = await readIfExists(DEST);
  if (existing && sha256(existing) === EXPECTED_SHA256) {
    console.log(`glm tokenizer up to date (${DEST}, sha256 ok) — skipping fetch`);
    return;
  }
  if (existing) {
    console.log(`glm tokenizer at ${DEST} has an unexpected checksum — re-fetching`);
  }

  console.log(`fetching glm tokenizer: ${URL}`);
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`fetch failed: HTTP ${res.status} ${res.statusText} for ${URL}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== EXPECTED_SHA256) {
    throw new Error(
      `checksum mismatch for ${URL}\n  expected ${EXPECTED_SHA256}\n  got      ${got}\n` +
        `Refusing to write — the upstream tokenizer changed; update EXPECTED_SHA256 ` +
        `in scripts/fetch-glm-tokenizer.mjs and re-run calibration (spec/TOKENIZER-CALIBRATION.md) ` +
        `if this is intentional.`,
    );
  }

  await mkdir(path.dirname(DEST), { recursive: true });
  const tmp = `${DEST}.tmp-${process.pid}`;
  // Stage to a sibling temp file then atomically rename onto DEST, so DEST is
  // never observed half-written. If anything between the write and the rename
  // fails, unlink the temp so a kill/throw can't orphan a `tokenizer.json.tmp-<pid>`
  // (the next run keys idempotency on DEST, not on stray temps).
  try {
    await writeFile(tmp, buf);
    await rename(tmp, DEST); // atomic
  } catch (err) {
    await unlink(tmp).catch((cleanupErr) => {
      if (cleanupErr?.code !== "ENOENT") throw cleanupErr;
    });
    throw err;
  }
  console.log(`wrote ${DEST} (${(buf.length / 1e6).toFixed(1)} MB, sha256 ok)`);
}

main().catch((err) => {
  console.error(`fetch-glm-tokenizer failed: ${err.message}`);
  process.exit(1);
});
