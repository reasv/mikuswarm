# GLM-5.1 tokenizer asset

`tokenizer.json` here is the **GLM-5.1** tokenizer (BPE, 154 820 vocab / 321 649
merges) — what `[tokenizer].primary = "glm"` / `[tokenizer].retrieval = "glm"`
load via `glm_tokenizer_path` (defaulted to `native/assets/glm-5.1/tokenizer.json`).

**It is fetched on build, not committed.** At 20 MB it is kept out of git history
(`.gitignore`); `scripts/fetch-glm-tokenizer.mjs` downloads it from the upstream HF
repo and **verifies its sha256**, so the asset is reproducible without bloating the
repo and a changed upstream can never silently swap the tokenizer the budgets are
calibrated against. The fetch runs as part of `pnpm build` and the Docker builder
stage; it is idempotent (a present, matching file is left untouched).

- Source: [`zai-org/GLM-5.1`](https://huggingface.co/zai-org/GLM-5.1) `@ main`, file `tokenizer.json`
- sha256: `19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d`
- License: **MIT** (`LICENSE` in this dir, retained per the MIT notice requirement)

Fetch manually with `pnpm fetch:tokenizer` (or `node scripts/fetch-glm-tokenizer.mjs`).
To pin a mirror/offline copy set `GLM_TOKENIZER_URL` — the checksum is still enforced.

Calibration against this exact file (GLM-5.1 ≈ gpt-4o, ~1.02×) is in
`spec/TOKENIZER-CALIBRATION.md`.
