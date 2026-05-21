import type { MatrixNativeDiagnostics, MatrixNativeEvent, MatrixSendResult } from "./native-types.js";

export function decodeNativeEvents(payload: string): MatrixNativeEvent[] {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((event) => decodeNativeEvent(event));
}

export function decodeNativeDiagnostics(payload: string): MatrixNativeDiagnostics {
  return JSON.parse(payload) as MatrixNativeDiagnostics;
}

export function decodeSendResult(payload: string): MatrixSendResult {
  return JSON.parse(payload) as MatrixSendResult;
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

