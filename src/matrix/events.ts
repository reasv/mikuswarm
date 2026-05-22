import type { MatrixNativeDiagnostics, MatrixNativeEvent, MatrixSendResult } from "./native-types.js";

export function decodeNativeEvents(payload: string): MatrixNativeEvent[] {
  const parsed = JSON.parse(payload) as unknown;
  assertNoNativeError(parsed, "pollEvents");
  if (!Array.isArray(parsed)) throw new Error("Matrix native pollEvents returned non-array payload");
  return parsed.map((event) => decodeNativeEvent(event));
}

export function decodeNativeDiagnostics(payload: string): MatrixNativeDiagnostics {
  const parsed = JSON.parse(payload) as unknown;
  assertNoNativeError(parsed, "diagnostics");
  return parsed as MatrixNativeDiagnostics;
}

export function decodeSendResult(payload: string): MatrixSendResult {
  const parsed = JSON.parse(payload) as unknown;
  assertNoNativeError(parsed, "sendMessage");
  if (!isRecord(parsed) || typeof parsed.messageId !== "string") {
    throw new Error("Matrix native sendMessage returned invalid payload");
  }
  return parsed as MatrixSendResult;
}

function decodeNativeEvent(payload: unknown): MatrixNativeEvent {
  if (!isRecord(payload) || payload.type !== "outbound") {
    return payload as MatrixNativeEvent;
  }

  return {
    type: "outbound",
    roomId: readString(payload, "roomId") ?? readString(payload, "room_id") ?? "",
    messageId: readString(payload, "messageId") ?? readString(payload, "message_id") ?? "",
    threadId: readString(payload, "threadId") ?? readString(payload, "thread_id"),
    replyToId: readString(payload, "replyToId") ?? readString(payload, "reply_to_id"),
    at: readString(payload, "at") ?? "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function assertNoNativeError(value: unknown, operation: string): void {
  if (isRecord(value) && typeof value.error === "string") {
    throw new Error(`Matrix native ${operation} failed: ${value.error}`);
  }
}
