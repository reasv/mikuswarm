import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./workspace.js";
import {
  buildProxyDispatcher,
  type FetchClient,
} from "../enrichment/fetch-client.js";
import { guardedFetch } from "./ssrf.js";
import type { Dispatcher } from "undici";
import {
  conditionImageBufferForInference,
  type ImageProcessingOptions,
} from "../media/index.js";
import { parseRetryAfterMs, type LlmScheduler } from "../agent/scheduler.js";
import {
  runFetchWithFallback,
  type ModelChainEntry,
  type FetchChainMember,
} from "../agent/model-fallback.js";
import { computeUsageCost, type CostRates, type RawTokenUsage } from "../agent/usage.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reference images (edit mode) per call. Pro accepts ~11, Flash ~14; we cap
 *  conservatively — more than a handful rarely improves an edit and bloats the
 *  request. */
const MAX_INPUT_IMAGES = 6;
const DEFAULT_OUTPUT_SUBDIR = "generated-images";
/** Pro "thinking" runs ~18s for a single image; 4K is slower. 120s is roomy. */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * 🔑 Gemini emits the generated image AS output tokens (a 1K image ≈ 1290 tok;
 * Pro adds ~50 "thinking" tok). Some gateways default this cap very low
 * (~15 tokens), which silently truncates BEFORE any image is produced — HTTP 200,
 * `finishReason:"MAX_TOKENS"`, no image part. Setting this high is mandatory.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
/** Hard cap on the JSON response body (a 4K base64 image is several MB). */
const RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Per-reference byte budget for edit inputs. Reference images are billed as
 * input tokens and inflate the request, so we bound them — but generously,
 * since these are the source material for an edit and re-encoding degrades
 * quality. A reference under this budget is sent as its ORIGINAL bytes
 * (no conversion); only an over-budget reference is run through
 * `conditionImageBufferForInference` (resize + JPEG) to bring it down. 6 MiB
 * comfortably holds a high-quality multi-megapixel JPEG/PNG/WebP while still
 * capping worst-case token/memory cost across up to MAX_INPUT_IMAGES refs.
 */
const REFERENCE_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const USER_AGENT = "MikuAgent/0.1 (mikuswarm image_generate)";
/** All-zero rates: usage captured, cost "untracked" (spec §7.2 unset case). */
const ZERO_COST_RATES: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Per-model cost rates (incl. flat per_image) from a resolved `[models.*]` block (spec MODEL-FALLBACK §2.3). */
function costRatesOf(config: ModelChainEntry["config"]): CostRates {
  return config.cost
    ? {
        input: config.cost.input,
        output: config.cost.output,
        cacheRead: config.cost.cache_read,
        cacheWrite: config.cost.cache_write,
        perImage: config.cost.per_image,
      }
    : ZERO_COST_RATES;
}

const ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
const IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;
const MODEL_ALIASES = ["pro", "flash"] as const;

type AspectRatio = (typeof ASPECT_RATIOS)[number];
type ImageSize = (typeof IMAGE_SIZES)[number];
type ModelAlias = (typeof MODEL_ALIASES)[number];

/** A reference image as the Gemini API wants it: base64 + declared MIME. */
type ReferenceImage = { mimeType: string; data: string };

type ImageGenParams = {
  prompt?: string;
  images?: string[];
  model?: ModelAlias;
  aspect_ratio?: AspectRatio;
  image_size?: ImageSize;
  filename?: string;
};

// Minimal shape of the Gemini `:generateContent` response we read from.
type GeminiInlineData = { mimeType?: string; mime_type?: string; data?: string };
type GeminiPart = { text?: string; inlineData?: GeminiInlineData; inline_data?: GeminiInlineData };
// Provider-reported usage (spec AUXILIARY-USAGE-TRACKING §6.2). `candidatesTokenCount`
// is the generated image billed AS output tokens (different $/tok scale than the
// agent loop — hence the separate lane, §4).
type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
};
type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: GeminiPart[] };
  }>;
  usageMetadata?: GeminiUsageMetadata;
};

/**
 * One auxiliary tool-call usage record (spec AUXILIARY-USAGE-TRACKING §8.2),
 * handed to {@link ImageGenToolContext.recordToolUsage} for durable ledger
 * insertion. Attributed to the ambient session; NEVER folded into the §8b
 * session counters (§4 invariant). `usage.images` carries the generated-image
 * count so the flat `per_image` charge can be re-derived if needed.
 */
export interface ToolUsageRecord {
  agentSessionId: string | null;
  toolName: string;
  /** pi-agent-core tool-call id, for matching this row to a rollout block (§10.3). */
  toolCallId: string | null;
  modelId: string;
  /**
   * Logical model id (config block name; spec MODEL-FALLBACK §2.2) — the budget/
   * grouping dimension. Defaults to `modelId` when omitted (no virtual model).
   */
  logicalModelId?: string;
  provider: string;
  usage: RawTokenUsage;
  /** USD total from `computeUsageCost(...).total`. */
  cost: number;
  /** Output image workspace path (nullable). */
  ref?: string | null;
}

export interface ImageGenToolContext {
  workspaceRoot: string;
  /** Used to download `images` reference inputs given as http(s) URLs. */
  fetchClient: FetchClient;
  /** Hard fetch ceiling for reference-image downloads. */
  downloadSizeLimit: number;
  /**
   * Per-image base64 byte cap for the inline preview returned to the model.
   * The generated bytes are conditioned (resize + re-encode) to fit under this
   * before being emitted as an inline image block — same pattern as the
   * danbooru `preview` action and `read_image`.
   */
  inlineImageMaxBytes: number;
  /** Sharp resize/encode options shared with captioning + the inline paths. */
  inferenceImageOptions: ImageProcessingOptions;
  /** Optional http(s) proxy applied to the generation POST. */
  httpProxyUrl?: string;
  /**
   * LLM request scheduler (spec CONCURRENCY-AND-RATE-LIMITING §5.6). Image-gen
   * shares the scarce `default` budget (the gateway routes Gemini and the main
   * provider through ONE rate-limited account), so the generation POST must be
   * admitted like any agent request. pi-agent-core hands tools no caller
   * context, so the class cannot be inherited at runtime — image-gen admits at
   * a fixed `default`@`interactive`, which matches every real caller (its only
   * session types are user-facing). Optional so tests construct the tool bare.
   */
  scheduler?: LlmScheduler;
  /**
   * Wall-clock bound on the scheduler-admission wait (#14), in ms. During an
   * image-model outage a queued admission is otherwise released only once per
   * half-open probe window (capped backoff, §4.1), outside the session's
   * own budget. Composed with the agent's abort signal so the tool call gives up
   * within the interactive budget instead of stalling the chat turn. Defaults to
   * 120_000 when unset (matches `llm_request_max_wait_ms`'s shipped default).
   */
  maxWaitMs?: number;
  /**
   * Ambient agent session this tool was built for (spec §8.2). Tools are built
   * per-session (`buildSessionTools`), so the factory closes over the id; it is
   * recorded on each `tool_invocations` ledger row for per-session rollups.
   */
  agentSessionId?: string | null;
  /**
   * Durable usage-ledger sink (spec §8.2). When set, every billable
   * `image_generate` call records one row (auxiliary lane — never the §8b
   * counters). Optional so tests/callers without storage construct the tool bare.
   */
  recordToolUsage?: (record: ToolUsageRecord) => void;
  /**
   * Period-budget gate (spec USAGE-COST-LIMITS §6.3). Called with a member's
   * LOGICAL id; returns an agent-facing error message when a covering period rule
   * is over budget. With fallback the call is refused only when EVERY chain member
   * of the chosen tier is over budget. Absent = no period budgeting.
   */
  checkBudget?: (logicalModelId: string) => string | undefined;
  /**
   * Budget availability by logical id (spec §3/§7) — skips an over-cap member.
   */
  isModelAvailable?: (logicalId: string) => boolean;
  /**
   * Per-tier resolved model chains (spec MODEL-FALLBACK §2.3): each alias points
   * at a `[models.*]` head plus its `fallback` members (connection + cost +
   * per-model probe cap live on the block). Replaces the old inline base_url /
   * api_key / models / costs.
   */
  chains: Record<ModelAlias, ModelChainEntry[]>;
  config?: {
    timeout_ms?: number;
    max_output_tokens?: number;
    output_subdir?: string;
  };
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ImageGenSchema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      description:
        "What to draw. For generation, describe the scene narratively (subject, setting, lighting, style). " +
        "When 'images' are provided this is the EDIT instruction (what to change / preserve).",
    }),
    images: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_INPUT_IMAGES,
        description:
          "Reference images to EDIT or compose from (1–6). Each is a workspace-relative path or an http(s) URL. " +
          "Providing any reference image switches the tool to edit mode.",
      }),
    ),
    model: Type.Optional(
      Type.Unsafe<ModelAlias>({
        type: "string",
        enum: [...MODEL_ALIASES],
        description:
          "Which model to use. 'pro' (nano banana pro — best quality, text rendering; default) or 'flash' (faster/cheaper).",
      }),
    ),
    aspect_ratio: Type.Optional(
      Type.Unsafe<AspectRatio>({
        type: "string",
        enum: [...ASPECT_RATIOS],
        description: "Output aspect ratio. Omit for the model default (1:1).",
      }),
    ),
    image_size: Type.Optional(
      Type.Unsafe<ImageSize>({
        type: "string",
        enum: [...IMAGE_SIZES],
        description:
          "Output resolution hint (longer edge). '1K'/'2K'/'4K'; '512' is flash-only. Loosely honored — treat as a quality hint.",
      }),
    ),
    filename: Type.Optional(
      Type.String({
        description:
          "Optional output basename hint (no extension needed). A collision-safe name is used if omitted.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createImageGenTool(context: ImageGenToolContext): AgentTool {
  for (const alias of MODEL_ALIASES) {
    if (!context.chains[alias]?.length) {
      throw new Error(`image_gen.models.${alias} must reference a configured [models.*] block.`);
    }
  }
  // A member's wire id is interpolated into the request URL path; reject anything
  // that could alter the path (slashes, dot-segments, etc.). Fail fast at construction.
  const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
  for (const alias of MODEL_ALIASES) {
    for (const member of context.chains[alias]!) {
      if (!MODEL_ID_PATTERN.test(member.config.id)) {
        throw new Error(
          `image_gen model "${member.logicalId}".id must match ${MODEL_ID_PATTERN}, got "${member.config.id}".`,
        );
      }
    }
  }
  const timeoutMs = context.config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = context.config?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const outputSubdir = normalizeSubdir(context.config?.output_subdir);
  const dispatcher = buildProxyDispatcher(context.httpProxyUrl);
  // Wall-clock bound on the scheduler-admission wait (#14). Default mirrors the
  // shipped `llm_request_max_wait_ms` so an image-model outage can't park the
  // chat turn at a queued admission for a full probe window.
  const admissionMaxWaitMs = context.maxWaitMs ?? 120_000;

  return {
    name: "image_generate",
    label: "Generate image",
    description:
      "Generate or edit an image with Google's Gemini \"nano banana\" models. " +
      "Provide a 'prompt' to generate from text. To EDIT, also pass 'images' (1–6 workspace paths or URLs) — " +
      "the prompt becomes the edit instruction. Defaults to the high-quality 'pro' model; pass model:'flash' for " +
      "faster/cheaper results. Optional 'aspect_ratio' and 'image_size'. The image is saved into the workspace and " +
      "returned to you as an inline preview; to post it to the chat you MUST call send_message with 'media' set to " +
      "the returned path.",
    parameters: ImageGenSchema,
    execute: async (toolCallId, rawParams, agentSignal) => {
      const params = rawParams as ImageGenParams;
      const prompt = params.prompt?.trim();
      if (!prompt) {
        return textError("image_generate requires a non-empty 'prompt'.");
      }
      const alias: ModelAlias = params.model ?? "pro";
      const chain = context.chains[alias]!;
      const tierLabel = chain[0]!.logicalId; // labels messages/logs; member chosen per attempt
      if (params.image_size === "512" && alias !== "flash") {
        return textError(
          "image_size '512' is only supported by the flash model. Use model:'flash', or choose 1K/2K/4K.",
        );
      }

      // Period-budget gate (spec USAGE-COST-LIMITS §6.3): refuse the paid call as
      // a tool error only when EVERY chain member of the chosen tier is over
      // budget — a model-scoped cap on the head just falls to the next member (§7).
      if (context.checkBudget) {
        const available = chain.some((m) => !context.checkBudget!(m.logicalId));
        if (!available) {
          const msg = context.checkBudget(chain[0]!.logicalId);
          if (msg) return textError(msg);
        }
      }

      // Edit mode: load reference images as inlineData parts.
      let refs: ReferenceImage[] = [];
      if (params.images && params.images.length > 0) {
        try {
          refs = await loadReferenceImages(params.images, context, dispatcher);
        } catch (error) {
          return textError(`Failed to load reference image: ${errMessage(error)}`);
        }
      }

      const body = buildRequestBody({ prompt, refs, aspectRatio: params.aspect_ratio, imageSize: params.image_size, maxOutputTokens });

      // Bound the admission wait (#14): compose a per-call wall-clock timeout with
      // the agent's abort signal so an image-model outage gives up within the
      // interactive budget instead of parking the chat turn until the next probe
      // window. `runFetchWithFallback` (spec MODEL-FALLBACK §6) owns admission
      // (fixed `default`@`interactive` per member), both-axes health feeding, and
      // transparent fallover across the tier's chain.
      const admitCtrl = new AbortController();
      const onAgentAbort = () => admitCtrl.abort();
      const admitTimer = setTimeout(() => admitCtrl.abort(), admissionMaxWaitMs);
      if (agentSignal) {
        if (agentSignal.aborted) admitCtrl.abort();
        else agentSignal.addEventListener("abort", onAgentAbort, { once: true });
      }
      let result: GeminiResponse;
      let billed: FetchChainMember | undefined;
      // Capture the member alongside its HTTP error so provenance stays exact
      // (review issue #9): on whole-chain failure where the FINAL attempt threw a
      // non-HTTP error, the surfaced `lastHttpError` belongs to an EARLIER member —
      // folding the member's logical id into the message prevents misattributing
      // that status to the model that actually failed last.
      let lastHttpError: { member: string; result: ToolTextResult } | undefined;
      try {
        result = await runFetchWithFallback<GeminiResponse>(
          chain,
          {
            consumer: `image_generate:${alias}`,
            priority: "interactive",
            scheduler: context.scheduler,
            isModelAvailable: context.isModelAvailable,
            probeBackoffMaxMs: (cfg) => cfg.llm_probe_backoff_max_ms,
            signal: admitCtrl.signal,
          },
          async (member) => {
            billed = member;
            const url = `${member.config.endpoint.replace(/\/+$/, "")}/v1beta/models/${member.config.id}:generateContent`;
            const r = await postGenerate({ url, apiKey: member.config.api_key, body, dispatcher, timeoutMs, signal: admitCtrl.signal });
            if ("httpError" in r) {
              lastHttpError = { member: member.logicalId, result: r.httpError };
              // A 400/413/422 is THIS request's content (deterministic on replay)
              // and never falls over (§9); other statuses are environmental.
              const kind = r.status === 400 || r.status === 413 || r.status === 422 ? "content" : "environmental";
              return { ok: false, kind, status: r.status, retryAfterMs: r.retryAfterMs, error: new Error(`image generation HTTP ${r.status}`) };
            }
            return { ok: true, value: r };
          },
        );
      } catch (error) {
        // All members failed (or a content failure short-circuited): surface the
        // last formatted HTTP error result if we have one, else a generic message.
        // An agent-signal abort / admission timeout also lands here and degrades to
        // a text error (image_generate's established contract; #14) — the in-flight
        // POST abort #7 fixes is that `admitCtrl.signal` now actually CANCELS the
        // generation fetch, so we stop billing the run rather than waiting out
        // `timeout_ms`. `runFetchWithFallback` already skipped the health feed +
        // fall over for the neutral AbortError (spec MODEL-FALLBACK §9).
        // Fold the failing member's logical id into the HTTP error so provenance
        // is unambiguous (#9): when the LAST attempt threw a non-HTTP error,
        // `lastHttpError` names an EARLIER member, so we must say which one rather
        // than letting the bare status read as the final model's failure.
        if (lastHttpError) {
          return textError(
            `Image generation failed (model ${tierLabel}, member ${lastHttpError.member}): ` +
              `${lastHttpError.result.details.error}`,
          );
        }
        return textError(`Image generation request failed (model ${tierLabel}): ${errMessage(error)}`);
      } finally {
        clearTimeout(admitTimer);
        if (agentSignal) agentSignal.removeEventListener("abort", onAgentAbort);
      }

      const extracted = extractImage(result);
      if (!extracted.image) {
        const reason = extracted.finishReason ?? "unknown";
        const hint =
          reason === "MAX_TOKENS"
            ? "Output was truncated before any image was produced (max_output_tokens too low or prompt too long)."
            : "The model produced no image — try rephrasing the prompt.";
        const said = extracted.text ? ` Model said: ${extracted.text.slice(0, 200)}` : "";
        return textError(`No image returned (finishReason=${reason}). ${hint}${said}`);
      }

      const rawBuffer = Buffer.from(extracted.image.data, "base64");
      const ext = mimeToExtension(extracted.image.mimeType);
      let relPath: string;
      try {
        const outDir = resolveWorkspacePath(context.workspaceRoot, outputSubdir);
        await fs.mkdir(outDir, { recursive: true });
        const savedPath = await writeOutputImage(outDir, params.filename, ext, rawBuffer);
        relPath = toWorkspaceRelative(context.workspaceRoot, savedPath);
      } catch (error) {
        return textError(`Generated the image but failed to save it: ${errMessage(error)}`);
      }

      // Auxiliary usage ledger (spec §8.2): one row per billable call, attributed
      // to the ambient session. Captured AFTER the save so `ref` points at the
      // durable artifact and `images: 1` reflects what was actually produced.
      // Usage may be null (gateway omitted usageMetadata) — then nothing is
      // recorded (the call left no measurable spend). Never touches the §8b
      // session counters (§4 invariant).
      const usage = parseGeminiUsage(result.usageMetadata, 1);
      if (usage && context.recordToolUsage && billed) {
        // Attributed to the member actually billed (spec MODEL-FALLBACK §2.2/§6.1).
        const cost = computeUsageCost(costRatesOf(billed.config), usage).total;
        try {
          context.recordToolUsage({
            agentSessionId: context.agentSessionId ?? null,
            toolName: "image_generate",
            toolCallId: toolCallId ?? null,
            modelId: billed.config.id,
            logicalModelId: billed.logicalId,
            provider: "gemini",
            usage,
            cost,
            ref: relPath,
          });
        } catch {
          /* the ledger is observability — a sink failure must never fail the tool */
        }
      }

      // Inline preview so the model sees what it made. Conditioning failure is
      // non-fatal — the file is already saved and deliverable by path.
      let inline: { buffer: Buffer; mimeType: string } | undefined;
      let inlineError: string | undefined;
      try {
        const rawByteBudget = Math.floor((context.inlineImageMaxBytes * 3) / 4);
        const conditioned = await conditionImageBufferForInference(rawBuffer, {
          ...context.inferenceImageOptions,
          maxBytes: rawByteBudget,
        });
        inline = { buffer: conditioned.buffer, mimeType: conditioned.mimeType };
      } catch (error) {
        // Non-fatal: the file is already saved and deliverable by path. Tools
        // in this codebase receive no logger (cf. danbooru), so surface the
        // diagnostic in the returned text rather than swallowing it silently —
        // this is how a genuine inlineImageMaxBytes misconfiguration becomes
        // visible instead of looking like the model just declined a preview.
        inline = undefined;
        inlineError = errMessage(error);
      }

      const isEdit = refs.length > 0;
      const text = [
        `## Image ${isEdit ? "edit" : "generation"}`,
        "",
        `Saved to \`${relPath}\` using \`${billed?.config.id ?? tierLabel}\` (${alias}).`,
        ...(params.aspect_ratio ? [`- aspect ratio: ${params.aspect_ratio}`] : []),
        ...(params.image_size ? [`- size hint: ${params.image_size}`] : []),
        ...(isEdit ? [`- edited from ${refs.length} reference image(s)`] : []),
        ...(inlineError ? [`- (inline preview unavailable: ${inlineError})`] : []),
        ...(extracted.text ? ["", `Model note: ${extracted.text.slice(0, 500)}`] : []),
        "",
        `To post this image to the chat, call \`send_message\` with \`media: "${relPath}"\`.`,
        "All Gemini images carry an invisible SynthID watermark.",
      ].join("\n");

      return {
        content: [
          { type: "text" as const, text },
          ...(inline
            ? [{ type: "image" as const, data: inline.buffer.toString("base64"), mimeType: inline.mimeType }]
            : []),
        ],
        details: {
          path: relPath,
          model: billed?.config.id ?? tierLabel,
          modelAlias: alias,
          isEdit,
          mimeType: extracted.image.mimeType,
          aspectRatio: params.aspect_ratio ?? null,
          imageSize: params.image_size ?? null,
          referenceImages: refs.length,
          caption: extracted.text ?? null,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Request building & HTTP
// ---------------------------------------------------------------------------

export function buildRequestBody(input: {
  prompt: string;
  refs: ReferenceImage[];
  aspectRatio?: AspectRatio;
  imageSize?: ImageSize;
  maxOutputTokens: number;
}): Record<string, unknown> {
  // Reference images first, then the text instruction (matches the API's
  // edit examples). Generation is the same shape with no inlineData parts.
  const parts: Array<Record<string, unknown>> = input.refs.map((ref) => ({
    inlineData: { mimeType: ref.mimeType, data: ref.data },
  }));
  parts.push({ text: input.prompt });

  const imageConfig: Record<string, string> = {};
  if (input.aspectRatio) imageConfig.aspectRatio = input.aspectRatio;
  if (input.imageSize) imageConfig.imageSize = input.imageSize;

  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      // 🔑 Mandatory — see DEFAULT_MAX_OUTPUT_TOKENS note above.
      maxOutputTokens: input.maxOutputTokens,
      ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
    },
  };
}

type ToolTextResult = ReturnType<typeof textError>;

async function postGenerate(input: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  dispatcher: Dispatcher | undefined;
  timeoutMs: number;
  /**
   * Agent-abort / admission-timeout signal (spec MODEL-FALLBACK §10; #7). Composed
   * with the per-call `timeoutMs` controller so EITHER an agent cancel / admission
   * timeout OR the wall-clock timeout aborts the in-flight generation POST —
   * without this an admitted generation bills until `timeoutMs` even after the
   * turn is cancelled. Mirrors x_search's `postGrok`.
   */
  signal?: AbortSignal;
}): Promise<GeminiResponse | { httpError: ToolTextResult; status: number; retryAfterMs?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  // Compose the agent/admission abort with the wall-clock timeout so a cancelled
  // turn or admission timeout aborts the request promptly, not just a slow upstream.
  const onAgentAbort = () => controller.abort();
  if (input.signal) {
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onAgentAbort, { once: true });
  }
  let response: Response;
  try {
    // Route through the shared egress chokepoint: SSRF guard + per-host admission
    // and the unconditional 429/503 backoff (spec Design D). Since image-gen shares
    // the Gemini gateway host with no other heavy traffic, the per-host limiter is
    // effectively just the backoff safety net here.
    response = await guardedFetch(input.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
        // The Gemini endpoint authenticates with the API key as a bearer token.
        // (When an operator gateway fronts Google, it injects real Google creds
        // downstream; Google's native x-goog-api-key header is not used here.)
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(input.body),
      // undici accepts `dispatcher` at runtime; routes through the proxy when set.
      dispatcher: input.dispatcher,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (input.signal) input.signal.removeEventListener("abort", onAgentAbort);
    if ((error as { name?: string })?.name === "AbortError") {
      // Agent cancel / admission timeout (the composed signal fired) is a NEUTRAL
      // teardown — rethrow an AbortError so `runFetchWithFallback` classifies it
      // neutral (no health signal, no fall-over). A bare wall-clock timeout (the
      // signal never fired) stays environmental and falls over to the next member.
      if (input.signal?.aborted) throw abortError();
      throw new Error(`timed out after ${input.timeoutMs}ms`);
    }
    throw error;
  }
  try {
    if (!response.ok) {
      const snippet = await safeReadText(response);
      // Tagged error object so the caller can return it as a tool result; the
      // status (and any Retry-After, since we hold the response here) rides
      // along so the caller can feed the scheduler's backoff (§8a).
      return {
        httpError: textError(
          `Image generation failed: HTTP ${response.status}${snippet ? ` (${snippet})` : ""}.`,
        ),
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers),
      };
    }
    try {
      return (await readJsonCapped(response, controller)) as GeminiResponse;
    } catch (error) {
      // A timeout/abort that fires mid-stream aborts `reader.read()` with an
      // AbortError; surface the same classification as the fetch-level abort (an
      // agent cancel / admission timeout is neutral, a bare wall-clock timeout is
      // environmental). The cap-exceeded guard throws a plain Error (not
      // AbortError) with its own explicit message, so it is not clobbered here.
      if ((error as { name?: string })?.name === "AbortError") {
        if (input.signal?.aborted) throw abortError();
        throw new Error(`timed out after ${input.timeoutMs}ms`);
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    if (input.signal) input.signal.removeEventListener("abort", onAgentAbort);
  }
}

/** A neutral abort error whose `name` `runFetchWithFallback` keys on (spec §9). */
function abortError(): Error {
  const err = new Error("image generation aborted");
  err.name = "AbortError";
  return err;
}

/** Stream the JSON body with a running byte cap so a runaway response (or a
 *  proxy that lies about content-length) can't exhaust memory. */
async function readJsonCapped(response: Response, controller: AbortController): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
    // Settle the unread body so the per-host limiter slot is freed promptly.
    await response.body?.cancel().catch(() => {});
    throw new Error(`response too large: declared content-length ${declared} > ${RESPONSE_MAX_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return response.json();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > RESPONSE_MAX_BYTES) {
      controller.abort();
      throw new Error(`response exceeded ${RESPONSE_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return JSON.parse(combined.toString("utf8"));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 300) : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Reference image loading (edit mode)
// ---------------------------------------------------------------------------

async function loadReferenceImages(
  refs: string[],
  context: ImageGenToolContext,
  dispatcher: Dispatcher | undefined,
): Promise<ReferenceImage[]> {
  void dispatcher; // URL downloads route through fetchClient, which holds its own proxy.
  const out: ReferenceImage[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    if (/^https?:\/\//i.test(ref)) {
      // The shared fetch client applies the egress guard (private/metadata block +
      // per-hop redirect revalidation) when enabled, so a public URL can't 302 to
      // a private/metadata host.
      const fetched = await context.fetchClient.fetch(ref, {
        maxBytes: context.downloadSizeLimit,
      });
      let buffer: Buffer;
      try {
        if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
          throw new Error(`HTTP ${fetched.statusCode} fetching ${ref}`);
        }
        buffer = await fs.readFile(fetched.path);
      } finally {
        await fs.unlink(fetched.path).catch(() => {});
      }
      const mime =
        imageMimeFromContentType(fetched.contentType) ?? imageMimeFromExtension(ref) ?? "image/png";
      out.push(await boundReferenceImage(buffer, mime, context));
    } else {
      const abs = resolveWorkspacePath(context.workspaceRoot, ref);
      const buffer = await fs.readFile(abs);
      const mime = imageMimeFromExtension(ref) ?? "image/png";
      out.push(await boundReferenceImage(buffer, mime, context));
    }
  }
  if (out.length === 0) {
    throw new Error("no usable reference images were provided");
  }
  return out;
}

/**
 * Bound a single reference image to {@link REFERENCE_IMAGE_MAX_BYTES}. When the
 * raw bytes are already under budget they are sent untouched (original MIME) to
 * preserve editing quality. Only an over-budget reference is conditioned
 * (resize + JPEG re-encode) via `conditionImageBufferForInference`, which caps
 * tokens and memory at the cost of one lossy pass on an image that was too big
 * to send as-is anyway.
 */
async function boundReferenceImage(
  buffer: Buffer,
  mimeType: string,
  context: ImageGenToolContext,
): Promise<ReferenceImage> {
  if (buffer.byteLength <= REFERENCE_IMAGE_MAX_BYTES) {
    return { mimeType, data: buffer.toString("base64") };
  }
  const conditioned = await conditionImageBufferForInference(buffer, {
    ...context.inferenceImageOptions,
    maxBytes: REFERENCE_IMAGE_MAX_BYTES,
  });
  return { mimeType: conditioned.mimeType, data: conditioned.buffer.toString("base64") };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function extractImage(payload: GeminiResponse): {
  image?: { mimeType: string; data: string };
  text?: string;
  finishReason?: string;
} {
  const candidate = payload?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const parts = candidate?.content?.parts ?? [];
  let image: { mimeType: string; data: string } | undefined;
  let text: string | undefined;
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data && !image) {
      image = {
        mimeType: inline.mimeType ?? inline.mime_type ?? "image/png",
        data: inline.data,
      };
    } else if (typeof part.text === "string" && part.text.trim() && !text) {
      text = part.text.trim();
    }
  }
  return { image, text, finishReason };
}

/**
 * Map a Gemini `usageMetadata` block → {@link RawTokenUsage} (spec §6.2). `input`
 * is uncached prompt tokens (prompt minus cached, incl. reference-image tokens);
 * `output` is `candidatesTokenCount` (the generated image billed as tokens);
 * cached tokens land in `cacheRead`. `images` is the count of images actually
 * saved (drives the flat per-image charge). Returns null when usageMetadata is
 * absent ("unknown", not zero).
 */
export function parseGeminiUsage(
  meta: GeminiUsageMetadata | undefined | null,
  images: number,
): RawTokenUsage | null {
  if (!meta) return null;
  const prompt = meta.promptTokenCount ?? 0;
  const cached = meta.cachedContentTokenCount ?? 0;
  return {
    input: Math.max(0, prompt - cached),
    output: meta.candidatesTokenCount ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    images,
  };
}

// ---------------------------------------------------------------------------
// Output file writing
// ---------------------------------------------------------------------------

const OUTPUT_COLLISION_RETRY_CAP = 100;

async function writeOutputImage(
  dir: string,
  fileNameHint: string | undefined,
  ext: string,
  buffer: Buffer,
): Promise<string> {
  const base = sanitizeFileBaseName(fileNameHint) ?? `image-${randomBytes(6).toString("hex")}`;
  // Exclusive create (`wx`) so concurrent calls into the same dir can't pick
  // the same suffix between an existence check and the write.
  let suffix = 0;
  for (let attempt = 0; attempt <= OUTPUT_COLLISION_RETRY_CAP; attempt++) {
    const candidate =
      suffix === 0 ? path.join(dir, `${base}.${ext}`) : path.join(dir, `${base}-${suffix}.${ext}`);
    try {
      const handle = await fs.open(candidate, "wx");
      try {
        await handle.writeFile(buffer);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      suffix += 1;
    }
  }
  const fallback = path.join(dir, `${base}-${randomBytes(6).toString("hex")}.${ext}`);
  const handle = await fs.open(fallback, "wx");
  try {
    await handle.writeFile(buffer);
  } finally {
    await handle.close();
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeSubdir(value: string | undefined): string {
  const raw = (value ?? DEFAULT_OUTPUT_SUBDIR).trim();
  const portable = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!portable || portable === "." || portable === ".." || portable.startsWith("/") || portable.includes("../")) {
    throw new Error("image_gen.output_subdir must be a safe workspace-relative subdirectory.");
  }
  return portable;
}

function mimeToExtension(mimeType: string): string {
  const m = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (m) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      // Allow-list only — mirror danbooru's inferExtension hardening. The MIME
      // comes from the trusted Gemini response, but pinning the on-disk
      // extension to a vetted set keeps an unexpected subtype from dictating it.
      return "png";
  }
}

function imageMimeFromContentType(contentType: string | undefined): string | undefined {
  const raw = contentType?.split(";")[0]?.trim().toLowerCase();
  return raw?.startsWith("image/") ? raw : undefined;
}

function imageMimeFromExtension(ref: string): string | undefined {
  const ext = path.extname(ref).replace(/^\./, "").toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function sanitizeFileBaseName(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const base = path.basename(raw, path.extname(raw));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.startsWith("..") ? absolutePath : `./${relative.replace(/\\/g, "/")}`;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textError(message: string) {
  return {
    content: [{ type: "text" as const, text: `error: ${message}` }],
    details: { error: message },
  };
}
