declare module "png-chunks-extract" {
  type PngChunk = {
    name: string;
    data: Uint8Array;
  };

  export default function extractPngChunks(data: Uint8Array): PngChunk[];
}

declare module "png-chunks-encode" {
  type PngChunk = {
    name: string;
    data: Uint8Array;
  };

  export default function encodePngChunks(chunks: PngChunk[]): Uint8Array;
}

declare module "png-chunk-text" {
  export function encode(keyword: string, text: string): { name: "tEXt"; data: Uint8Array };
  export function decode(data: Uint8Array): { keyword: string; text: string };

  const pngTextChunk: {
    encode: typeof encode;
    decode: typeof decode;
  };

  export default pngTextChunk;
}
