import { readFile } from "node:fs/promises";

export interface CardDetectionResult {
  detected: string;
  cardName?: string;
}

export async function detectCharacterCard(absolutePath: string): Promise<CardDetectionResult | null> {
  try {
    const data = await readFile(absolutePath);
    return detectFromPng(data);
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
