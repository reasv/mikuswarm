import { readFile } from "node:fs/promises";

export interface CardDetectionResult {
  detected: string;
  cardName?: string;
}

export async function detectCharacterCard(absolutePath: string): Promise<CardDetectionResult | null> {
  try {
    const data = await readFile(absolutePath);
    return detectFromPng(data) ?? detectFromJpegExif(data);
  } catch {
    return null;
  }
}

function detectFromPng(data: Buffer): CardDetectionResult | null {
  if (data.length < 8) return null;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(pngSignature)) return null;

  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");

    if (type === "tEXt" && offset + 8 + length <= data.length) {
      const chunkData = data.subarray(offset + 8, offset + 8 + length);
      const nullIndex = chunkData.indexOf(0);
      if (nullIndex >= 0) {
        const key = chunkData.subarray(0, nullIndex).toString("ascii");
        if (key === "chara") {
          const value = chunkData.subarray(nullIndex + 1).toString("ascii");
          return parseCharaPayload(value);
        }
      }
    }

    offset += 12 + length;
  }

  return null;
}

function detectFromJpegExif(data: Buffer): CardDetectionResult | null {
  if (data.length < 4) return null;
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const segLen = data.readUInt16BE(offset + 2);
    if (marker === 0xe1 && offset + 4 + segLen <= data.length) {
      const segData = data.subarray(offset + 4, offset + 2 + segLen);
      const exifHeader = "Exif\0\0";
      if (segData.length > exifHeader.length && segData.subarray(0, 6).toString("ascii") === exifHeader) {
        const result = findUserCommentChara(segData.subarray(6));
        if (result) return result;
      }
    }
    offset += 2 + segLen;
  }
  return null;
}

function findUserCommentChara(tiffData: Buffer): CardDetectionResult | null {
  const charaMarker = "chara";
  const idx = tiffData.indexOf(charaMarker);
  if (idx < 0) return null;

  let start = idx + charaMarker.length;
  while (start < tiffData.length && (tiffData[start] === 0 || tiffData[start] === 0x20)) start++;

  if (start >= tiffData.length) return null;

  let end = start;
  while (end < tiffData.length && tiffData[end] !== 0) end++;
  const payload = tiffData.subarray(start, end).toString("ascii").trim();
  if (payload.length === 0) return null;
  return parseCharaPayload(payload);
}

function parseCharaPayload(base64Value: string): CardDetectionResult | null {
  try {
    const json = Buffer.from(base64Value, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name
      : typeof parsed.char_name === "string" ? parsed.char_name
      : undefined;
    return { detected: "character_card", cardName: name };
  } catch {
    return { detected: "character_card" };
  }
}
