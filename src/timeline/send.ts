import type { IChatProvider, OutboundTarget, OutboundMessage } from "../types.js";
import type { Logger } from "../observability/logger.js";

/**
 * Fire-and-forget outbound send dispatched through the provider registry.
 *
 * The previous call pattern `void providers.get(target.provider)?.send(...).catch(...)`
 * silently dropped the message AND skipped the `.catch` when the provider id
 * was absent from the registry. This helper fixes that gap: a missing provider
 * emits a structured `outbound_send_dropped_missing_provider` warning instead of
 * silently discarding the send.
 *
 * When the provider IS found, the send is fire-and-forget; `onFailure` is
 * called if the send promise rejects, preserving each call site's existing
 * log event name and session-id field exactly.
 *
 * @param providers  The live provider registry (Map keyed by provider id).
 * @param target     Outbound target; `target.provider` is the registry key.
 * @param message    The outbound message payload.
 * @param logger     Structured logger for the dropped-provider warning.
 * @param site       Short label identifying the call site, included in the
 *                   `outbound_send_dropped_missing_provider` warn fields.
 * @param onFailure  Called when the send promise rejects; use it to emit the
 *                   per-site failure log with the site-specific event name and
 *                   session context.
 */
export function sendViaProvider(
  providers: Map<string, IChatProvider>,
  target: OutboundTarget,
  message: OutboundMessage,
  logger: Logger,
  site: string,
  onFailure: (error: unknown) => void,
): void {
  const provider = providers.get(target.provider);
  if (!provider) {
    logger.warn("outbound_send_dropped_missing_provider", {
      site,
      targetProvider: target.provider,
      timelineKey: target.timelineKey,
    });
    return;
  }
  void provider.send(target, message).catch(onFailure);
}
