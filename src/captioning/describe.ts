import type { RawTokenUsage } from "../agent/usage.js";

export type MediaModality = "image" | "video" | "audio";

export interface CaptionModelConfig {
  id: string;
  endpoint: string;
  api_key: string;
  /** pi-ai provider label, recorded on caption usage_events rows (accounting only). */
  provider?: string | null;
  /** The selected model's transport; absent retains Chat Completions. */
  api?: string;
  /** Configured thinking level after the model's wire-level remapping. */
  reasoning_effort?: string;
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

interface ResponsesUsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** A caption cannot be used; retrying another model is not an outage recovery. */
export class CaptionContentError extends Error {}

interface ResponsesCaptionResult {
  status?: string;
  model?: string;
  error?: { message?: string };
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  usage?: ResponsesUsageBlock;
}

export function parseResponsesUsage(usage: ResponsesUsageBlock | undefined | null): RawTokenUsage | null {
  if (!usage) return null;
  return parseOpenAiUsage({
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    prompt_tokens_details: usage.input_tokens_details,
  });
}

function responsesCaption(result: ResponsesCaptionResult, modelId: string): DescribeMediaResult {
  if (result.status === "failed") {
    throw new Error(`Caption API failed: ${result.error?.message ?? "Responses request failed"}`);
  }
  if (result.status && result.status !== "completed") {
    throw new CaptionContentError(
      `Caption inference returned ${result.status} response: ${result.incomplete_details?.reason ?? "no complete caption"}`,
    );
  }
  const parts: string[] = [];
  for (const item of result.output ?? []) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    for (const block of item.content ?? []) {
      if (block.type === "refusal") {
        throw new CaptionContentError(`Caption inference was refused: ${(block.refusal ?? "").slice(0, 500)}`);
      }
      if (block.type === "output_text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  const text = parts.join("").trim();
  if (!text) throw new CaptionContentError("Caption inference returned empty response");
  return { text, model: result.model ?? modelId, usage: parseResponsesUsage(result.usage) };
}

export async function describeMedia(options: DescribeMediaOptions): Promise<DescribeMediaResult> {
  const responses = options.model.api === "openai-responses";
  if (responses && options.modality !== "image") {
    throw new CaptionContentError(
      `Responses captioning does not accept direct ${options.modality} input. ` +
        `Set [captioning.${options.modality}].model to a Chat Completions model that accepts ${options.modality}.`,
    );
  }

  const promptWithLimit = `${options.prompt} Respond in at most ${options.maxChars} characters.`;
  const encoded = options.data.toString("base64");
  const dataUrl = `data:${options.mimeType};base64,${encoded}`;
  const contentBlocks: unknown[] = [{ type: "text", text: promptWithLimit }];

  if (options.modality === "image") {
    contentBlocks.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  } else if (options.modality === "video") {
    contentBlocks.push({
      type: "video_url",
      video_url: { url: dataUrl },
    });
  } else {
    const format = audioFormatFromMime(options.mimeType);
    contentBlocks.push({
      type: "input_audio",
      input_audio: { data: encoded, format },
    });
  }

  const body = responses
    ? {
        model: options.model.id,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: promptWithLimit },
            { type: "input_image", image_url: dataUrl, detail: "auto" },
          ],
        }],
        max_output_tokens: options.maxTokens,
        store: false,
        ...(options.model.reasoning_effort ? { reasoning: { effort: options.model.reasoning_effort } } : {}),
      }
    : {
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
    const endpoint = options.model.endpoint.replace(/\/+$/, "");
    const response = await fetch(`${endpoint}/${responses ? "responses" : "chat/completions"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.model.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      ...(responses ? { redirect: "error" as const } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      // "status NNN" phrasing is load-bearing: the scheduler's unconditional
      // 429/503 backoff parses it via extractStatus (src/agent/request-retry.ts).
      throw new Error(`Caption API returned status ${response.status}: ${errorBody.slice(0, 500)}`);
    }

    if (responses) {
      return responsesCaption((await response.json()) as ResponsesCaptionResult, options.model.id);
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
      throw new CaptionContentError("Caption inference returned empty response");
    }

    if (!text.trim()) throw new CaptionContentError("Caption inference returned empty response");

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
