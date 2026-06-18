import type { RawTokenUsage } from "../agent/usage.js";

export type MediaModality = "image" | "video" | "audio";

export interface CaptionModelConfig {
  id: string;
  endpoint: string;
  api_key: string;
  /** pi-ai provider label, recorded on caption usage_events rows (accounting only). */
  provider?: string | null;
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
  /** Shutdown abort seam (#6): aborts an in-flight caption fetch at shutdown. */
  signal?: AbortSignal;
}

export interface DescribeMediaResult {
  text: string;
  model: string;
  /**
   * Provider-reported token usage (spec AUXILIARY-USAGE-TRACKING §6.1), or null
   * when the gateway omits the `usage` block ("unknown", never zero). The caller
   * computes cost from config rates and persists it (§8.1).
   */
  usage: RawTokenUsage | null;
}

/** Shape of the OpenAI/OpenRouter `usage` block we read (all fields optional). */
interface OpenAiUsageBlock {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Map an OpenAI/OpenRouter `/chat/completions` `usage` block → {@link RawTokenUsage}
 * (spec §6.1). `input` is uncached prompt tokens (prompt minus cached); cached
 * tokens land in `cacheRead`; there is no cache-write notion on this transport.
 * Returns null when no usage block is present.
 */
export function parseOpenAiUsage(usage: OpenAiUsageBlock | undefined | null): RawTokenUsage | null {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cached),
    output: usage.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  };
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
  // Compose the external shutdown signal (#6) with the per-call timeout so a
  // SIGTERM aborts an in-flight caption fetch without waiting the full timeout.
  const onSignal = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onSignal, { once: true });
  }

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
      // "status NNN" phrasing is load-bearing: the scheduler's unconditional
      // 429/503 backoff parses it via extractStatus (src/agent/request-retry.ts).
      throw new Error(`Caption API returned status ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
      model?: string;
      usage?: OpenAiUsageBlock;
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

    return { text: text.trim(), model: result.model ?? options.model.id, usage: parseOpenAiUsage(result.usage) };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (options.signal) options.signal.removeEventListener("abort", onSignal);
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
