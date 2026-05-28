import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import type { ImageProcessingOptions, ProcessedMedia } from "./types.js";

/**
 * Cap on pixels sharp will materialize for any single decode. 25 MP is large
 * enough for any reasonable photo/screenshot/diagram but small enough to keep
 * worst-case allocation bounded across the iterative compression loop.
 *
 * Specifically relevant for SVG input: librsvg honors `limitInputPixels`, so a
 * crafted `<viewBox="0 0 16000 16000">` does not balloon into a ~1 GP raster.
 * Sharp's own default (`Math.pow(0x3FFF, 2)` ≈ 268 MP) only catches truly
 * extreme inputs.
 *
 * Shared with `src/tools/read-image.ts` so the SVG rasterization budget is
 * uniform across captioning and the `read_image` tool.
 */
export const SVG_MAX_INPUT_PIXELS = 25_000_000;

/**
 * Cap on bytes we'll string-convert from a buffer for SVG embed scanning. SVG
 * source files are XML — anything past a few hundred KB is either a payload
 * vector itself (e.g. an SVG bomb with millions of nested elements) or carrying
 * a giant inline data: blob. Either way, we don't need to scan past the cap to
 * make a refusal decision — at this size, the SVG is unfit for rasterization
 * regardless.
 */
const SVG_SCAN_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Scan an SVG source for `<image>` references that embed a raster via a
 * `data:image/...;base64,...` URI. librsvg/Cairo decode those rasters against
 * their own dimensions, not the outer SVG viewBox — so `SVG_MAX_INPUT_PIXELS`
 * (which gates the outer canvas) does not bound them. A ~10 KB SVG can carry a
 * gigapixel raster this way. Conservative refusal: any `data:image/...`
 * reference is rejected regardless of declared size — agents rarely need SVGs
 * with embedded rasters, and the operator agreed this is the safe call.
 *
 * The regex is tolerant of: case, single/double-quoted attribute values, the
 * `xlink:` namespace prefix, whitespace around `=`, and arbitrary attribute
 * order on the `<image>` element.
 */
export function containsEmbeddedRasterDataUri(svgSource: string): boolean {
  // Match any (xlink:)?href attribute on an <image> element whose value starts
  // with "data:image/" (case-insensitive). We scan for href= patterns inside
  // an <image ...> tag region rather than parsing XML — fast and sufficient.
  // Pattern explanation:
  //   <image\b           start of an <image> element
  //   [^>]*?             any attributes up to the href
  //   (xlink:)?href      href or xlink:href
  //   \s*=\s*            tolerate whitespace around =
  //   ['"]?              optional quote (some parsers accept unquoted)
  //   \s*data:image/     the embedded-raster data URI prefix
  const re = /<image\b[^>]*?(?:xlink:)?href\s*=\s*['"]?\s*data:image\//i;
  return re.test(svgSource);
}

/**
 * Read up to `SVG_SCAN_MAX_BYTES` of `buffer` as UTF-8 and check for an
 * embedded raster data URI. Buffers larger than the cap are still scanned for
 * the first chunk — if a payload exists, it almost certainly appears within
 * the first few MB (an embedded base64 raster pushes the SVG well past that
 * size). The cap exists to bound string allocation, not to defeat the check.
 */
function svgBufferContainsEmbeddedRasterDataUri(buffer: Buffer): boolean {
  const slice = buffer.byteLength > SVG_SCAN_MAX_BYTES ? buffer.subarray(0, SVG_SCAN_MAX_BYTES) : buffer;
  // Decode lossy: SVGs are XML so should be ASCII-clean in the attribute
  // region we care about; even if the file contains binary trailing junk
  // (rare), `toString("utf8")` will not throw.
  const source = slice.toString("utf8");
  return containsEmbeddedRasterDataUri(source);
}

export async function processImageForInference(
  inputPath: string,
  options: ImageProcessingOptions,
): Promise<ProcessedMedia> {
  // Read the file into a buffer up front and pass the buffer (not the path)
  // to every sharp call. This is intentional: when sharp receives a file path
  // for an SVG, librsvg uses the file's location as a base URI and the
  // sibling rule allows `<image xlink:href="other.png"/>` to load another
  // file in the same directory (e.g. another attachment in `msg-attach/`).
  // Buffer mode has no base URI, so librsvg blocks every scheme except
  // `data:`, closing that exfiltration channel. The single read also
  // replaces what was previously three independent reads of the same file.
  const buffer = await readFile(inputPath);
  const conditioned = await conditionImageBufferForInference(buffer, options);
  const tmpPath = join(tmpdir(), `miku-img-${randomBytes(8).toString("hex")}.jpg`);
  await writeFile(tmpPath, conditioned.buffer);
  return {
    path: tmpPath,
    mimeType: conditioned.mimeType,
    sizeBytes: conditioned.sizeBytes,
    truncated: conditioned.truncated,
  };
}

/**
 * In-memory variant of {@link processImageForInference}. Iteratively re-encodes
 * the input buffer (resizing as needed) until it fits under
 * `options.maxBytes`, returning the conditioned JPEG bytes plus metadata. Used
 * for paths that emit base64 inline (e.g. the danbooru `preview` action) so
 * the inline payload always lands under the per-image cap without a tmp-file
 * detour.
 */
export async function conditionImageBufferForInference(
  input: Buffer,
  options: ImageProcessingOptions,
): Promise<{ buffer: Buffer; mimeType: string; sizeBytes: number; truncated: boolean }> {
  const metadata = await sharp(input, { limitInputPixels: SVG_MAX_INPUT_PIXELS }).metadata();
  // SVG-specific gate: librsvg/Cairo decode `<image href="data:image/...">`
  // payloads against the inner raster's own dimensions, not the SVG canvas,
  // so SVG_MAX_INPUT_PIXELS does not bound them. Conservative refusal — see
  // `containsEmbeddedRasterDataUri` for rationale.
  if (metadata.format === "svg" && svgBufferContainsEmbeddedRasterDataUri(input)) {
    throw new Error(
      "Refusing to rasterize SVG containing embedded data: URI raster — strip the inline image and retry.",
    );
  }
  const origWidth = metadata.width ?? 1;
  const origHeight = metadata.height ?? 1;

  const { width, height } = computeTargetDimensions(origWidth, origHeight, options);

  const useMozjpeg = options.mozjpeg;
  const result = await compressToFit(input, width, height, options.maxBytes, useMozjpeg);
  if (result) {
    return {
      buffer: result,
      mimeType: "image/jpeg",
      sizeBytes: result.byteLength,
      truncated: false,
    };
  }

  const fallback = await sharp(input, { limitInputPixels: SVG_MAX_INPUT_PIXELS })
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 60, mozjpeg: useMozjpeg })
    .toBuffer();
  return {
    buffer: fallback,
    mimeType: "image/jpeg",
    sizeBytes: fallback.byteLength,
    truncated: false,
  };
}

export function computeTargetDimensions(
  origWidth: number,
  origHeight: number,
  options: ImageProcessingOptions,
): { width: number; height: number } {
  const origPixels = origWidth * origHeight;
  let width = origWidth;
  let height = origHeight;

  if (origPixels > options.maxTotalPixels) {
    const scale = Math.sqrt(options.maxTotalPixels / origPixels);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const shortestSide = Math.min(width, height);
  if (shortestSide < options.minShortestSide && Math.min(origWidth, origHeight) >= options.minShortestSide) {
    const boostScale = options.minShortestSide / shortestSide;
    width = Math.round(width * boostScale);
    height = Math.round(height * boostScale);

    if (width * height > options.maxTotalPixelsHard) {
      const clampScale = Math.sqrt(options.maxTotalPixelsHard / (width * height));
      width = Math.round(width * clampScale);
      height = Math.round(height * clampScale);
    }
  }

  return { width: Math.max(width, 1), height: Math.max(height, 1) };
}

async function compressToFit(
  input: Buffer,
  targetWidth: number,
  targetHeight: number,
  maxBytes: number,
  mozjpeg: boolean,
): Promise<Buffer | undefined> {
  let width = targetWidth;
  let height = targetHeight;

  for (;;) {
    for (const quality of [82, 72, 62, 52, 42, 35]) {
      const output = await sharp(input, { limitInputPixels: SVG_MAX_INPUT_PIXELS })
        .resize({
          width: Math.round(width),
          height: Math.round(height),
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg })
        .toBuffer();
      if (output.byteLength <= maxBytes) {
        return output;
      }
    }
    if (width <= 1 || height <= 1) break;
    width *= 0.75;
    height *= 0.75;
    width = Math.max(width, 1);
    height = Math.max(height, 1);
  }

  return undefined;
}

export async function cleanupProcessedImage(result: ProcessedMedia): Promise<void> {
  await unlink(result.path).catch(() => {});
}
