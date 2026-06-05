// Distinct, actionable error codes for the browser backend (spec §6.1). Each
// maps to a tool-error string the model can reason about, rather than an opaque
// crash. The `browser` tool catches BrowserError and surfaces code + message.

export type BrowserErrorCode =
  | "backend_unavailable" // Manager unreachable / down (graceful degradation, §3.4)
  | "auth_failed" // Manager rejected the bearer token (401)
  | "profile_launch_failed" // create/launch of the persistent profile failed
  | "connect_failed" // connectOverCDP failed (cold start, CDP proxy, etc.)
  | "nav_timeout" // navigation exceeded nav_timeout_ms
  | "act_timeout" // an action exceeded act_timeout_ms
  | "ref_expired" // a [ref=eN] went stale (take a fresh snapshot, §5.3)
  | "bad_url" // scheme/host rejected at the tool layer (§5.5)
  | "evaluate_disabled" // act:evaluate used while evaluate_enabled=false
  | "evaluate_failed" // act:evaluate ran but the page expression threw
  | "screenshot_failed" // a non-timeout screenshot capture failure
  | "upload_failed" // act:upload chooser arm/set failed (non-timeout, non-stale-ref)
  | "clear_failed" // act:clear_site_data CDP Storage.clearDataForOrigin failed
  | "no_active_page" // no tab/page resolved for the session
  | "bad_request"; // malformed action/params

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  /** The originating HTTP status, when the error came from a Manager response. */
  readonly httpStatus?: number;

  constructor(
    code: BrowserErrorCode,
    message: string,
    options?: { cause?: unknown; httpStatus?: number },
  ) {
    super(message, options);
    this.name = "BrowserError";
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}

export function isBrowserError(value: unknown): value is BrowserError {
  return value instanceof BrowserError;
}
