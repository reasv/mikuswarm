export { ChatSearchIndexer, type ChatSearchIndexerOptions } from "./indexer.js";
export { projectChatEvent } from "./project.js";
export {
  sanitizeFtsMatch,
  buildSnippet,
  resolveRooms,
  decodeCursor,
  encodeCursor,
  queryTerms,
  runChatSearch,
  type SearchScope,
  type RunChatSearchResult,
} from "./query.js";
export {
  parseDuration,
  parseInstant,
  isDateOnly,
  resolveTimeWindow,
  type TimeWindowArgs,
  type ResolvedTimeWindow,
} from "./time.js";
export {
  detectAbsence,
  resolveAbsence,
  ABSENCE_GAP_DEFAULT_MS,
  ABSENCE_LOOKBACK_DEFAULT_MS,
  type AbsenceResult,
  type ResolveAbsenceOptions,
} from "./absence.js";
export {
  selectFineCover,
  selectDigest,
  type DigestSelection,
} from "./coverage.js";
