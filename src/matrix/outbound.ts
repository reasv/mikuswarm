import type { DeliveryReceipt, OutboundMessage, OutboundTarget } from "../types.js";
import type { MatrixProvider } from "./provider.js";

export async function sendMatrixMessage(
  provider: MatrixProvider,
  target: OutboundTarget,
  message: OutboundMessage,
): Promise<DeliveryReceipt> {
  return provider.send(target, message);
}

