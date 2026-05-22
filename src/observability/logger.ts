import { redactValue } from "../config/redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogRecord {
  level: LogLevel;
  component: string;
  message: string;
  time: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(component: string, fields?: Record<string, unknown>): Logger;
}

export function createLogger(
  component: string,
  minimumLevel: LogLevel = "info",
  baseFields: Record<string, unknown> = {},
): Logger {
  function emit(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < LEVELS[minimumLevel]) return;
    const record: LogRecord = {
      ...baseFields,
      ...fields,
      time: new Date().toISOString(),
      level,
      component,
      message,
    };
    const redacted = redactValue(record);
    const line = JSON.stringify(redacted);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childComponent, fields = {}) =>
      createLogger(`${component}.${childComponent}`, minimumLevel, {
        ...baseFields,
        ...fields,
      }),
  };
}
