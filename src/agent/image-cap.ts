/**
 * Per-model image cap (config `[models.<name>] max_images`).
 *
 * Some serving stacks reject a request that carries more than a fixed number of
 * images ("At most N image(s) may be provided in one prompt"), however large the
 * context window. Without a cap, a session that accumulates images (attachments,
 * read_image / browser screenshots, tool results) fails on such a member the
 * moment it crosses the limit, and every later request in the run fails the same
 * way.
 *
 * For a member with `max_images`, each request keeps only the newest N image
 * blocks across the whole history; older ones are replaced in place by a short
 * text placeholder so the message shape (and an image-bearing turn's leading
 * text part) is preserved. The persisted transcript is never touched: this only
 * shapes one request, per serving member, so a fallover to a member without the
 * cap still sees every image.
 *
 * Trade-off: once a session exceeds the cap, each new image moves the cut, which
 * changes an earlier message and so busts the member's prompt-cache prefix from
 * that point.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const OMITTED_IMAGE_TEXT = "[image omitted: this model accepts only a limited number of images per request]";

/**
 * Return `messages` with all but the newest `maxImages` image blocks replaced by
 * a text placeholder. Returns the input array itself when nothing had to change;
 * untouched messages keep their identity.
 */
export function capImages(messages: Message[], maxImages: number): Message[] {
  let keep = Math.max(0, Math.floor(maxImages));
  // Walk newest → oldest, spending the budget on the newest images first.
  const dropFrom = new Map<number, Set<number>>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant" || typeof message.content === "string") continue;
    const content = message.content as (TextContent | ImageContent)[];
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j]!.type !== "image") continue;
      if (keep > 0) {
        keep--;
        continue;
      }
      let blocks = dropFrom.get(i);
      if (!blocks) dropFrom.set(i, (blocks = new Set()));
      blocks.add(j);
    }
  }
  if (dropFrom.size === 0) return messages;
  return messages.map((message, i) => {
    const blocks = dropFrom.get(i);
    if (!blocks) return message;
    const content = (message.content as (TextContent | ImageContent)[]).map((block, j) =>
      blocks.has(j) ? ({ type: "text", text: OMITTED_IMAGE_TEXT } satisfies TextContent) : block,
    );
    return { ...message, content } as Message;
  });
}

/** Wrap a member's base StreamFn so its requests carry at most `maxImages` images. */
export function withImageCap(base: StreamFn, maxImages: number): StreamFn {
  return (model, context, options) => {
    const messages = capImages(context.messages, maxImages);
    return base(model, messages === context.messages ? context : { ...context, messages }, options);
  };
}
