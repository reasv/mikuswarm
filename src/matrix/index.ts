export { MatrixProvider } from "./provider.js";
export { MatrixNativeClient } from "./native-client.js";
export {
  normalizeMatrixInboundEvent,
  timelineKeyForMatrixEvent,
  type MatrixInboundContext,
} from "./inbound.js";
export type * from "./native-types.js";
export { sendMatrixMessage } from "./outbound.js";
