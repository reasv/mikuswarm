import sharp from "sharp";

export interface ResizeOptions {
  inputPath: string;
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
}

export async function resizeImageForInference(options: ResizeOptions): Promise<{
  data: Buffer;
  mediaType: string;
}> {
  const input = await sharp(options.inputPath).toBuffer();
  const result = await resizeImageBuffer(input, {
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    maxBytes: options.maxBytes,
  });
  return result ?? { data: await fallbackResize(input), mediaType: "image/jpeg" };
}

export interface ResizeBufferOptions {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
}

export async function resizeImageBuffer(
  input: Buffer,
  options: ResizeBufferOptions,
): Promise<{ data: Buffer; mediaType: string } | undefined> {
  const metadata = await sharp(input).metadata();
  let width = Math.min(metadata.width ?? options.maxWidth, options.maxWidth);
  let height = Math.min(metadata.height ?? options.maxHeight, options.maxHeight);

  for (;;) {
    for (const quality of [82, 72, 62, 52, 42, 35]) {
      const output = await sharp(input)
        .resize({
          width: Math.round(width),
          height: Math.round(height),
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (output.byteLength <= options.maxBytes) {
        return { data: output, mediaType: "image/jpeg" };
      }
    }
    if (width <= 64 || height <= 64) break;
    width *= 0.75;
    height *= 0.75;
    width = Math.max(width, 64);
    height = Math.max(height, 64);
  }

  return undefined;
}

async function fallbackResize(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 35, mozjpeg: true })
    .toBuffer();
}
