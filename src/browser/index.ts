export {
  BrowserSession,
  type BrowserSessionOptions,
  type ConsoleEntry,
  type DownloadRecord,
  CONSOLE_DRAIN_MAX_CHARS,
  CONSOLE_TRUNCATION_MARKER,
} from "./session.js";
export { BrowserError, isBrowserError, type BrowserErrorCode } from "./errors.js";
export { aiSnapshot, type SnapshotResult } from "./snapshot.js";
export {
  act,
  isTimeoutError,
  mapError,
  requireRefLocator,
  REF_RE,
  type ActKind,
  type ActParams,
  type UploadFile,
} from "./act.js";
export { assertBrowserUrl } from "./url-policy.js";
export { ManagerClient, type ManagerProfile, type ProfileCreateInput } from "./manager-client.js";
