export type MediaModality = "image" | "video" | "audio";

export interface CaptionModelConfig {
  id: string;
  endpoint: string;
  api_key: string;
}

export interface DescribeMediaOptions {
  modality: MediaModality;
  data: Buffer;
  mimeType: string;
  prompt: string;
  model: CaptionModelConfig;
  maxChars: number;
  maxTokens: number;
  timeoutMs?: number;
}

export interface DescribeMediaResult {
  text: string;
  model: string;
}

export async function describeMedia(options: DescribeMediaOptions): Promise<DescribeMediaResult> {
  const promptWithLimit = `${options.prompt} Respond in at most ${options.maxChars} characters.`;
  const contentBlocks: unknown[] = [{ type: "text", text: promptWithLimit }];

  if (options.modality === "image") {
    contentBlocks.push({
      type: "image_url",
      image_url: { url: `data:${options.mimeType};base64,${options.data.toString("base64")}` },
    });
  } else if (options.modality === "video") {
    contentBlocks.push({
      type: "video_url",
      video_url: { url: `data:${options.mimeType};base64,${options.data.toString("base64")}` },
    });
  } else {
    const format = audioFormatFromMime(options.mimeType);
    contentBlocks.push({
      type: "input_audio",
      input_audio: { data: options.data.toString("base64"), format },
    });
  }

  const body = {
    model: options.model.id,
    messages: [{ role: "user", content: contentBlocks }],
    max_tokens: options.maxTokens,
  };

  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;

  try {
    const response = await fetch(`${options.model.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.model.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Caption API returned ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
      model?: string;
    };

    const choice = result.choices?.[0]?.message?.content;
    let text: string;
    if (typeof choice === "string") {
      text = choice;
    } else if (Array.isArray(choice)) {
      text = choice
        .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
    } else {
      throw new Error("Caption inference returned empty response");
    }

    if (!text.trim()) throw new Error("Caption inference returned empty response");

    return { text: text.trim(), model: result.model ?? options.model.id };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function audioFormatFromMime(mimeType: string): string {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mp3": "mp3",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/aiff": "aiff",
    "audio/x-aiff": "aiff",
    "audio/webm": "webm",
    "audio/opus": "opus",
  };
  return map[mime] ?? "wav";
}
