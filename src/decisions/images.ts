/**
 * Images for the vision decision chain (DECISION-MODEL §3.5, ARCHITECTURE.md
 * §8h "Vision decision chain"): the subject-image reference a point declares,
 * the loaded image the client sends, the wire shapes, and the loader adapter
 * over the inference image conditioning `read_image` uses (`src/media/image.ts`).
 */

import { readFile } from "node:fs/promises";
import type { AttachmentMeta, CanonicalChatEvent } from "../types.js";
import { conditionImageBufferForInference } from "../media/image.js";
import { senderName } from "./transcript.js";

/** One subject image of an evaluation, as a point declares it. */
export interface DecisionImageRef {
  /** Stable key within the evaluation (the attachment id). */
  id: string;
  /** External id of the message the image is attached to (as the agent sees it). */
  messageId: string;
  /** Display name of the message's sender. */
  from: string;
  /** The image's caption, when one already exists. */
  caption?: string;
  /** Local file of the downloaded image; without one the image cannot be loaded. */
  localPath?: string;
  mimeType?: string;
}

/** Conditioning limits of one load. */
export interface DecisionImageLimits {
  maxPixels: number;
  maxBytes: number;
}

/** A conditioned image: JPEG bytes as base64. */
export interface LoadedDecisionImage {
  mimeType: "image/jpeg";
  base64: string;
  bytes: number;
}

/** Loads and conditions one subject image; undefined when it cannot be loaded within the limits. */
export type DecisionImageLoader = (
  ref: DecisionImageRef,
  limits: DecisionImageLimits,
) => Promise<LoadedDecisionImage | undefined>;

/** An image as the client sends it: loaded, labelled ("image 1"), newest first. */
export interface DecisionImage extends LoadedDecisionImage {
  ref: DecisionImageRef;
  /** "image 1" — what the state's attachments and the instructions refer to. */
  label: string;
}

/** The label line sent before an image part: `image 1: attached to message $abc by Alice`. */
export function imageLabelLine(image: DecisionImage): string {
  return `${image.label}: attached to message ${image.ref.messageId} by ${image.ref.from}`;
}

/** `data:image/jpeg;base64,…` */
export function imageDataUrl(image: LoadedDecisionImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

export type ImageTransport = "state_parts" | "images_field";

/**
 * The wire form of a vision request (DECISION-MODEL §3.5):
 * - `state_parts` (default): the state serialised into one leading `text`
 *   part, then per image one `text` label part and one `image_url` part;
 * - `images_field`: the plain state (an object state gains `image_labels`, the
 *   label lines in the order of the array) plus a top-level `images` array of
 *   data URLs.
 * `logged` is the same state with every image replaced by a short marker, for
 * the evaluation row. With no images the state passes through unchanged.
 */
export function wireImageState(
  state: unknown,
  images: readonly DecisionImage[],
  transport: ImageTransport,
): { state: unknown; images?: string[]; logged: unknown } {
  if (images.length === 0) return { state, logged: state };
  const marker = (image: DecisionImage) => `[${image.label}: ${image.mimeType}, ${image.bytes} bytes]`;
  if (transport === "images_field") {
    const labelled =
      state && typeof state === "object" && !Array.isArray(state)
        ? { ...(state as Record<string, unknown>), image_labels: images.map(imageLabelLine) }
        : state;
    return { state: labelled, images: images.map(imageDataUrl), logged: { state: labelled, images: images.map(marker) } };
  }
  const head = { type: "text", text: typeof state === "string" ? state : JSON.stringify(state) };
  const parts: unknown[] = [head];
  const logged: unknown[] = [head];
  for (const image of images) {
    const label = { type: "text", text: imageLabelLine(image) };
    parts.push(label, { type: "image_url", image_url: { url: imageDataUrl(image) } });
    logged.push(label, { type: "image_url", image_url: { url: marker(image) } });
  }
  return { state: parts, logged };
}

/** The image attachments of an event (attachments, then linked media). */
export function imageAttachmentsOf(event: CanonicalChatEvent): AttachmentMeta[] {
  return [...(event.attachments ?? []), ...(event.linkedMedia ?? [])].filter(
    (attachment) => attachment.mediaType === "image",
  );
}

/** Subject-image refs for an event's image attachments (hydrated: `localPath`, `caption`). */
export function imageRefsOf(event: CanonicalChatEvent): DecisionImageRef[] {
  return imageAttachmentsOf(event).map((attachment) => ({
    id: attachment.id,
    messageId: event.externalId ?? event.id,
    from: senderName(event.sender),
    ...(attachment.caption ? { caption: attachment.caption } : {}),
    ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  }));
}

/**
 * The engine's image loader over the inference conditioning path: read the
 * downloaded file, downscale to `maxPixels`, re-encode JPEG under `maxBytes`.
 * Undefined when the image has no local file, cannot be decoded, or does not
 * fit `maxBytes` even after the conditioning's last resort.
 */
export function createDecisionImageLoader(options: { mozjpeg?: boolean } = {}): DecisionImageLoader {
  return async (ref, limits) => {
    if (!ref.localPath) return undefined;
    try {
      const input = await readFile(ref.localPath);
      const conditioned = await conditionImageBufferForInference(input, {
        maxTotalPixels: limits.maxPixels,
        maxTotalPixelsHard: limits.maxPixels,
        minShortestSide: 0,
        maxBytes: limits.maxBytes,
        mozjpeg: options.mozjpeg ?? true,
      });
      if (conditioned.sizeBytes > limits.maxBytes) return undefined;
      return { mimeType: "image/jpeg", base64: conditioned.buffer.toString("base64"), bytes: conditioned.sizeBytes };
    } catch {
      return undefined;
    }
  };
}
