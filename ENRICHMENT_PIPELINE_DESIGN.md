# Enrichment Pipeline Redesign — Implementation Plan

This document specifies the redesign of the message enrichment pipeline. It replaces the current approach where enrichment (attachment downloads, link preview fetching, reply resolution, captioning) happens inside the Matrix layer before persistence, with a post-persistence, provider-agnostic enrichment system driven by workers that process timeline messages.

## Motivation

The current system has several problems:

1. Enrichment happens in the Matrix inbound processing path, **before** the message is persisted to the timeline. If enrichment fails or the app crashes mid-enrichment, the message may be lost or stored incomplete.
2. All enrichment logic is tightly coupled to the Matrix provider. Adding a new chat provider means duplicating all this work.
3. Captioning is not functional — the current "basic captioner" only extracts sharp metadata, never calls an LLM.
4. Link preview images are not fetched (`includeImages: false`).
5. Reply link previews are not resolved at all.
6. Attachment paths are absolute filesystem paths rather than workspace-relative paths the agent can use directly.
7. The matrix layer makes decisions about which images get captioned / become image blocks. These decisions belong in the provider-agnostic agent layer.

## Architecture Overview

```
Matrix sync → normalizeMatrixInboundEvent (NO I/O, field mapping only)
  → emit bare CanonicalChatEvent (attachment stubs, replyToId only, no link previews)
  → timeline persist immediately (enrichment_status = 'pending' or 'skipped')
  → trigger hold (unchanged)
  → trigger fires → resolve trigger group (hold + lookback) → persist trigger_group_id

Enrichment workers (configurable concurrency, e.g. 3):
  Continuously poll DB for enrichment_status='pending', most recent first
  → claim event (status → 'processing')
  → execute enrichment job (all fetching/downloading for one message):
      1. Download attachments via provider callback → save to workspace msg-attach/
      2. Resolve reply context via provider callback (messageSummary)
      3. Download reply attachments via provider callback → save to workspace
      4. Fetch link previews for message body (via provider or generic HTTP)
      5. Fetch link previews for reply body
      6. Download all preview media → save to workspace
      7. Extract and download linked media from body and reply body → save to workspace
      8. Detect character cards on all image assets (unconditional, no LLM)
  → set caption_status on each media asset: 'pending' if eligible (image with successful
    download), 'skipped' otherwise (non-image, failed download)
  → atomic write: all results to enrichment tables + flip enrichment_status → 'complete'
  → emit 'enrichment:complete:{eventId}' in-process notification
  If error → enrichment_status → 'failed', record error + attempt count
  NOTE: enrichment workers NEVER do captioning/inference.

Caption workers (configurable concurrency, e.g. 2):
  Continuously poll DB for media_assets with:
    caption_status = 'pending' AND download_status = 'complete' AND media_type = 'image'
    AND (event is in a trigger group OR config says caption_all)
  → prioritize trigger-group media over non-trigger-group media
  → within same priority, most-recent-first
  → claim asset (caption_status → 'processing')
  → resize image ephemerally for inference
  → call captioning model via concurrency-limited inference client
  → update media_asset row: caption, caption_model, caption_status → 'complete' or 'failed'
  → emit 'caption:complete:{eventId}' in-process notification
  If error → caption_status → 'failed', record error

Trigger path:
  → trigger fires → resolve trigger group, persist trigger_group_id on all group events
  → (caption workers now see those events' media assets as eligible)
  → await enrichment_status = 'complete' for all group events (or timeout)
  → await caption_status != 'pending' for all group image assets (or timeout)
  → launch agent session

Agent session / context build:
  → query timeline events
  → for each event, load enrichment data from media_assets + link_previews + reply_contexts
  → hydrate into enriched event objects for rendering
  → renderer works as before (renderRichMessage / renderCompactMessage)
  → image block selection reads from media_assets for trigger group events
```

## Detailed Changes by Module

### 1. Schema Changes (`src/storage/database.ts`)

#### Modified `timeline_events` table

Add two columns:

```sql
ALTER TABLE timeline_events ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';
-- Values: 'pending' | 'processing' | 'complete' | 'failed' | 'skipped'

ALTER TABLE timeline_events ADD COLUMN trigger_group_id TEXT;
-- NULL = not in any trigger group
-- Otherwise = event ID of the trigger message that owns this group
```

Add index for enrichment worker polling:

```sql
CREATE INDEX IF NOT EXISTS idx_timeline_events_enrichment
  ON timeline_events(enrichment_status, timestamp DESC)
  WHERE enrichment_status IN ('pending', 'processing');
```

Add index for trigger group queries:

```sql
CREATE INDEX IF NOT EXISTS idx_timeline_events_trigger_group
  ON timeline_events(trigger_group_id)
  WHERE trigger_group_id IS NOT NULL;
```

#### New `reply_contexts` table

Stores the resolved snapshot of the message being replied to. One per event (at most). The replied-to message's media and link previews are stored in `media_assets` and `link_previews` with `role='reply_*'` / `context='reply'`, keyed by the same `event_id` (the parent message, not the reply).

```sql
CREATE TABLE IF NOT EXISTS reply_contexts (
  event_id TEXT PRIMARY KEY,
  reply_external_id TEXT,
  sender_id TEXT,
  sender_display_name TEXT,
  sender_username TEXT,
  body TEXT,
  html_body TEXT,
  timestamp INTEGER,
  created_at INTEGER NOT NULL
);
```

#### New `media_assets` table

Tracks every downloaded media file: message attachments, reply attachments, link preview media, linked media.

```sql
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  -- 'attachment'           direct attachment on this message
  -- 'reply_attachment'     attachment on the replied-to message
  -- 'preview_media'        media from a link preview on this message (OG image, tweet photos, video thumbnails)
  -- 'reply_preview_media'  media from a link preview on the replied-to message
  -- 'linked_media'         media URL found directly in message body text (not from OG tags)
  -- 'reply_linked_media'   same, from the replied-to message body
  source_index INTEGER,
  -- Ordering within this role for this event (attachment 0, 1, ...; preview_media 0, 1, ...)
  link_preview_id TEXT,
  -- FK to link_previews.id. Set for preview_media / reply_preview_media roles.
  -- NULL for attachments and linked_media.
  local_path TEXT,
  -- Workspace-relative path: 'msg-attach/ABCDEF.jpg'
  -- NULL if download failed or not yet attempted.
  mime_type TEXT,
  media_type TEXT NOT NULL,
  -- 'image' | 'video' | 'audio' | 'file'
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  -- For video/audio. NULL for images/files.
  original_filename TEXT,
  detected_content TEXT,
  -- 'character_card' or NULL. Non-inference detection results.
  detected_metadata_json TEXT,
  -- JSON blob for detection details: { "cardName": "..." } etc.
  caption TEXT,
  caption_model TEXT,
  caption_status TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'processing' | 'complete' | 'failed' | 'skipped'
  -- 'pending': eligible for captioning, waiting for a caption worker to pick it up.
  --   Set by enrichment worker for images with successful downloads.
  -- 'processing': claimed by a caption worker, inference in progress.
  -- 'complete': captioning succeeded, caption text is populated.
  -- 'failed': captioning was attempted but failed.
  -- 'skipped': not eligible (non-image, failed download, etc.).
  -- Set at enrichment completion time. Updated later by caption workers.
  download_status TEXT NOT NULL DEFAULT 'pending',
  -- 'complete' | 'failed'
  -- Written at enrichment completion time.
  download_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_assets_event
  ON media_assets(event_id, role, source_index);

CREATE INDEX IF NOT EXISTS idx_media_assets_preview
  ON media_assets(link_preview_id)
  WHERE link_preview_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_assets_caption_eligible
  ON media_assets(caption_status, download_status, media_type)
  WHERE caption_status IN ('pending', 'processing');
```

#### New `link_previews` table

Stores fetched link preview metadata. The link preview's media (OG images, tweet photos, etc.) are in `media_assets` with `link_preview_id` pointing back here.

```sql
CREATE TABLE IF NOT EXISTS link_previews (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  context TEXT NOT NULL,
  -- 'message' = link in the message body
  -- 'reply'   = link in the replied-to message body
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  site_name TEXT,
  source_kind TEXT,
  -- 'synapse' | 'fxtwitter' | 'generic'
  -- Records which resolution method produced this preview.
  preview_index INTEGER NOT NULL,
  -- Ordering within context (0, 1, 2). Max 3 per context.
  fetched_at INTEGER,
  fetch_status TEXT NOT NULL,
  -- 'complete' | 'failed'
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_previews_event
  ON link_previews(event_id, context, preview_index);
```

### 2. Matrix Inbound Processing (`src/matrix/inbound.ts`)

#### What changes

Remove `processMatrixInboundEvent()` entirely. Only `normalizeMatrixInboundEvent()` survives, and it becomes the sole entry point.

Remove the three resolution functions:
- `resolveAttachments()` — moved to enrichment worker
- `resolveReplyContext()` — moved to enrichment worker
- `resolveLinkPreviews()` — moved to enrichment worker

And the helpers they use:
- `downloadAttachment()` — replaced by provider capability interface
- `resolveReplyAttachments()` — replaced by enrichment worker logic

#### What the normalized event looks like

The `CanonicalChatEvent` produced by normalization contains:

- `body`, `htmlBody`: message text, always available (no I/O)
- `sender`: mapped from the native event (no I/O)
- `attachments`: stubs with `id`, `filename`, `mimeType`, `mediaType`, `sizeBytes` from `MatrixInboundEvent.media`. NO `localPath`. `processing.downloaded = false`.
- `replyTo`: `{ externalId: event.replyToId }` only. No body, sender, timestamp, or attachments. Just the reference.
- `linkPreviews`: `undefined` (not yet fetched)
- `mentions`, `trigger`, `timestamp`, etc.: unchanged (no I/O)

The attachment stubs carry enough metadata for the enrichment worker to know what to download (the `event.externalId` + roomId derived from timeline key provide the provider-specific download reference).

#### What stays

- `normalizeMatrixInboundEvent()` — pure field mapping, no I/O
- `detectTrigger()` — no I/O
- `isMentioningSelf()` — no I/O
- `timelineKeyForMatrixEvent()` — no I/O
- `mediaTypeForMsgtype()` — utility, still useful for enrichment worker

#### Pre-check heuristic for enrichment_status

After normalization, before persisting, determine if enrichment is needed:

```typescript
function needsEnrichment(event: CanonicalChatEvent): boolean {
  if (event.attachments && event.attachments.length > 0) return true;
  if (event.replyTo?.externalId) return true;
  if (event.body.includes("http")) return true;
  return false;
}
```

If `needsEnrichment` returns false, the event is persisted with `enrichment_status = 'skipped'`. Otherwise `enrichment_status = 'pending'`.

### 3. Matrix Provider (`src/matrix/provider.ts`)

#### Changes to the poll loop

The poll handler calls `normalizeMatrixInboundEvent()` (synchronous, no I/O) instead of `processMatrixInboundEvent()` (async, did all enrichment). The `await` is removed.

```typescript
// Before:
const inbound = await processMatrixInboundEvent(nativeEvent.event, { ... });
this.emitWithTriggerHold(inbound);

// After:
const inbound = normalizeMatrixInboundEvent(nativeEvent.event, { ... });
this.emitWithTriggerHold(inbound);
```

This makes the poll loop synchronous per event — it can process all events in a batch without awaiting, then reschedule.

#### Provider capabilities for enrichment

The `MatrixProvider` exposes a capabilities object that the enrichment worker uses:

```typescript
interface EnrichmentCapabilities {
  downloadMedia(params: { roomId: string; eventId: string }): Promise<{
    data: Buffer;
    contentType?: string;
    filename?: string;
    kind: string;
  }>;

  messageSummary(params: { roomId: string; eventId: string }): Promise<{
    eventId: string;
    sender: string;
    senderName?: string;
    body: string;
    msgtype?: string;
    timestamp: string;
  } | null>;

  resolveLinkPreviews(params: {
    bodyText: string;
    includeImages: boolean;
    maxBytes: number;
  }): Promise<{
    textBlocks: string[];
    media: Array<{
      sourceUrl: string;
      filename?: string;
      contentType?: string;
      dataBase64: string;
    }>;
    sources: Array<{
      url: string;
      sourceKind: string;
      siteName?: string;
      title?: string;
      description?: string;
    }>;
  }>;

  memberInfo(params: { roomId: string; userId: string }): Promise<{
    displayName?: string;
  }>;
}
```

These wrap the native client methods but return `Promise`s instead of blocking synchronously. The native NAPI bindings for `downloadMedia()`, `messageSummary()`, and `resolveLinkPreviews()` **must be converted from synchronous to async NAPI** — the Rust side already uses Tokio async; the bindings currently use `block_on()` which blocks the Node.js event loop. Converting them to return `JsPromise` backed by Tokio tasks is a napi-rs change in the Rust binding layer.

The `MatrixProvider` provides enrichment capabilities keyed by account:

```typescript
class MatrixProvider {
  getEnrichmentCapabilities(accountId: string): EnrichmentCapabilities { ... }
}
```

The enrichment worker resolves the account from the event's timeline key (format: `matrix:{accountId}:...`).

### 4. Trigger Group Resolution (`src/timeline/` or `src/app.ts`)

#### Unifying hold + lookback

Currently, trigger hold messages are accumulated in `TriggerInfo.groupedEventIds` by the matrix provider, and lookback is done later in `selectImageAttachments()` in the context builder.

Both are now unified into a single "trigger group" resolved when the trigger fires and persisted immediately.

When `flushPendingTrigger()` fires in the provider:
1. The hold-grouped event IDs are already in `TriggerInfo.groupedEventIds`
2. After the trigger event is emitted, the `handleInbound` path performs a lookback query: find same-sender messages within `max(5000ms, trigger_hold_ms * 2)` that have media attachments, working backwards from the trigger message's timestamp
3. Those lookback event IDs are added to `groupedEventIds`
4. All events in the group get their `trigger_group_id` column updated in the DB (including the trigger event itself)

The trigger group update happens as a single DB write. This is done in `app.ts` `handleInbound` after the trigger event has been routed to the timeline (so all events are already persisted):

```typescript
async function resolveTriggerGroup(inbound: InboundChatEvent): Promise<void> {
  const triggerEventId = inbound.event.id;

  // Start with hold-grouped IDs
  const groupIds = new Set(inbound.trigger?.groupedEventIds ?? []);
  groupIds.add(triggerEventId);

  // Lookback: same sender, recent, has media stubs
  const lookback = timeline.query({
    timelineKey: inbound.timelineKey,
    toTimestamp: inbound.event.timestamp,
    fromTimestamp: inbound.event.timestamp - Math.max(5_000, config.matrix.trigger_hold_ms * 2),
    limit: 50,
  });
  for (const event of lookback.reverse()) {
    if (event.id === triggerEventId) continue;
    if (event.sender.id !== inbound.event.sender.id) continue;
    if (!event.attachments?.length) continue;
    // Found a same-sender media message in the lookback window
    groupIds.add(event.id);
    break; // Only the most recent one (same as current behavior)
  }

  // Persist trigger group membership
  inbound.trigger = { ...inbound.trigger!, groupedEventIds: [...groupIds] };
  inbound.event.trigger = inbound.trigger;
  await timeline.setTriggerGroup(triggerEventId, [...groupIds]);
}
```

`timeline.setTriggerGroup(triggerEventId, eventIds)` updates all events in one transaction:

```sql
UPDATE timeline_events SET trigger_group_id = ? WHERE id IN (?, ?, ...);
```

### 5. New: Enrichment System (`src/enrichment/`)

This is a new module. It contains:

```
src/enrichment/
  index.ts           — exports
  worker-pool.ts     — EnrichmentWorkerPool: manages N workers, polls DB
  worker.ts          — EnrichmentWorker: processes one message (NO inference)
  fetch-client.ts    — ConcurrencyLimitedFetchClient: shared HTTP fetcher
  media.ts           — file saving, filename generation
  linked-media.ts    — extracting media URLs from message body text
  card-detect.ts     — character card detection (non-inference, reads PNG metadata/EXIF)
  types.ts           — EnrichmentResult, MediaAssetRow, LinkPreviewRow, etc.

src/captioning/
  index.ts           — exports
  worker-pool.ts     — CaptionWorkerPool: manages N workers, polls media_assets in DB
  worker.ts          — CaptionWorker: captions one media asset
  inference-client.ts — ConcurrencyLimitedInferenceClient: shared captioning client
  image-resize.ts    — ephemeral image resizing for inference (sharp-based)
```

#### 5.1 EnrichmentWorkerPool (`worker-pool.ts`)

```typescript
interface EnrichmentWorkerPoolOptions {
  storage: Storage;
  timeline: TimelineStore;
  providerCapabilities: Map<string, EnrichmentCapabilities>;
  fetchClient: ConcurrencyLimitedFetchClient;
  workspaceRoot: string;
  config: EnrichmentConfig;
  onComplete?: (eventId: string) => void;
  onError?: (eventId: string, error: unknown) => void;
  logger: Logger;
}

class EnrichmentWorkerPool {
  private running = false;
  private activeWorkers = new Set<Promise<void>>();

  start(): void;
  // Begins the polling loop. At each tick:
  // 1. Query DB for events with enrichment_status='pending', ordered by timestamp DESC, limit = workerCount
  // 2. Claim each by setting status='processing' (compare-and-swap in a transaction)
  // 3. Spawn an EnrichmentWorker for each claimed event
  // 4. When a worker completes, check for more work
  // Poll interval: 100ms when there was work, 1000ms when idle.

  stop(): Promise<void>;
  // Set running=false, await all active workers

  notifyNewEvent(eventId: string): void;
  // Called when a new event is persisted. Can wake the poll loop immediately
  // instead of waiting for the next tick. Optimization, not required for correctness.
}
```

The pool also handles stale `processing` claims. On startup, any events with `enrichment_status='processing'` are reset to `'pending'` (they were in-flight when the app crashed). This query runs once at startup:

```sql
UPDATE timeline_events SET enrichment_status = 'pending'
  WHERE enrichment_status = 'processing';
```

#### 5.2 EnrichmentWorker (`worker.ts`)

Processes a single event. All work runs asynchronously. At the end, writes all results atomically. **The enrichment worker never does captioning/inference** — that is handled by the separate caption worker pool (section 5.8).

```typescript
class EnrichmentWorker {
  async process(event: CanonicalChatEvent): Promise<void> {
    const capabilities = this.resolveCapabilities(event);
    const result: EnrichmentResult = {
      mediaAssets: [],
      linkPreviews: [],
      replyContext: null,
    };

    // --- Phase 1: Downloads and fetches (uses fetchClient for HTTP, capabilities for provider media) ---

    // 1a. Download message attachments
    await this.downloadAttachments(event, capabilities, result);

    // 1b. Resolve reply context
    await this.resolveReplyContext(event, capabilities, result);

    // 1c. Fetch link previews for message body
    await this.fetchLinkPreviews(event.body, 'message', event, capabilities, result);

    // 1d. Fetch link previews for reply body (if reply was resolved)
    if (result.replyContext?.body) {
      await this.fetchLinkPreviews(result.replyContext.body, 'reply', event, capabilities, result);
    }

    // 1e. Extract and download linked media from message body
    await this.extractLinkedMedia(event.body, 'linked_media', event, result);

    // 1f. Extract and download linked media from reply body
    if (result.replyContext?.body) {
      await this.extractLinkedMedia(result.replyContext.body, 'reply_linked_media', event, result);
    }

    // --- Phase 2: Non-inference analysis (unconditional) ---

    // 2a. Character card detection on all image assets
    for (const asset of result.mediaAssets) {
      if (asset.media_type === 'image' && asset.local_path && asset.download_status === 'complete') {
        await this.detectCharacterCard(asset);
      }
    }

    // --- Phase 3: Set caption eligibility on media assets ---

    for (const asset of result.mediaAssets) {
      if (asset.media_type === 'image' && asset.download_status === 'complete') {
        // Eligible for captioning — leave as 'pending'.
        // Caption workers will pick these up based on trigger group membership.
        asset.caption_status = 'pending';
      } else {
        // Non-image or failed download — skip captioning entirely.
        asset.caption_status = 'skipped';
      }
    }

    // --- Phase 4: Atomic write ---
    await this.persistResults(event.id, result);
  }
}
```

The phases within a single enrichment job run their internal HTTP/provider requests concurrently where possible. For example, step 1a downloads all attachments in parallel (each through the concurrency-limited fetch/provider client). Steps 1b and 1c can run in parallel with 1a. The worker uses `Promise.all` / `Promise.allSettled` internally.

However, 1d/1e/1f depend on 1b (reply context must be resolved first to get the reply body). So the dependency graph within one job is:

```
                 ┌─ 1a. download attachments ─┐
    start ───────┤                             ├──── 1e. linked media (body) ───┐
                 ├─ 1b. resolve reply ─────────┤                               │
                 │        │                    ├──── 1f. linked media (reply) ──┼─ 2. card detect ─ 3. set caption status ─ 4. write
                 │        └─ 1d. reply         │                               │
                 │            link previews ────┘                               │
                 └─ 1c. message link previews ─────────────────────────────────┘
```

Individual download/fetch failures within a phase do NOT fail the whole job. Each media asset and link preview has its own status. The overall job succeeds if the orchestration completes (even if individual items failed). The job fails only on unexpected errors (DB errors, etc.).

#### 5.3 ConcurrencyLimitedFetchClient (`fetch-client.ts`)

A shared HTTP client that internally limits concurrency. Used for:
- Downloading linked media from HTTP URLs
- Generic link preview fetching (future, when we add non-provider preview resolution)
- Any other HTTP fetch the enrichment worker needs

```typescript
interface FetchClientOptions {
  maxConcurrency: number;   // e.g. 6
  timeoutMs: number;        // e.g. 10_000
  maxResponseBytes: number; // e.g. 50_000_000 (50MB)
}

class ConcurrencyLimitedFetchClient {
  fetch(url: string, options?: { maxBytes?: number }): Promise<{
    data: Buffer;
    contentType?: string;
    finalUrl: string;
    statusCode: number;
  }>;
  // Internally queues requests. The caller awaits a Promise.
  // If maxConcurrency slots are occupied, the request waits in a FIFO queue.
}
```

#### 5.4 Note on Inference

The enrichment worker pool does **not** contain or use an inference client. All captioning/inference work is handled by the separate caption worker pool (section 5.8), which has its own `ConcurrencyLimitedInferenceClient` in `src/captioning/`.

#### 5.5 Media File Handling (`media.ts`)

```typescript
// Filename generation
function generateMediaFilename(data: Buffer, originalFilename?: string, contentType?: string): string {
  // 1. Compute SHA-256 hash of file contents
  // 2. Take first 8 bytes of hash
  // 3. Encode as base32 uppercase (13 characters)
  // 4. Append extension from originalFilename or contentType
  // Result: 'ABCDEFGHIJKLM.jpg' (short, deduplicates naturally)
  // Example: 'X7QK4R2TBMVNE.png'
}

// Saving
async function saveMediaToWorkspace(params: {
  data: Buffer;
  workspaceRoot: string;
  originalFilename?: string;
  contentType?: string;
}): Promise<{ localPath: string; absolutePath: string }> {
  // 1. Generate filename from content hash
  // 2. Ensure msg-attach/ directory exists
  // 3. Write file (skip if already exists — content-addressed)
  // 4. Return workspace-relative path: 'msg-attach/X7QK4R2TBMVNE.png'
  //    and absolute path for internal use
}
```

The base32 prefix length (8 bytes → 13 chars) keeps filenames short for context tokens while providing adequate collision resistance (2^64 space).

Note: image resizing for inference lives in `src/captioning/image-resize.ts` (section 5.8), not here. Downloaded media is always stored as the exact original — resizing is always ephemeral.

#### 5.6 Linked Media Extraction (`linked-media.ts`)

Extracts URLs from message body text that point directly to media files (images, videos, etc.) — distinct from URLs that appear in link preview OG tags.

```typescript
function extractLinkedMediaUrls(bodyText: string): string[] {
  // 1. Extract all HTTP(S) URLs from text (same regex as link preview extraction)
  // 2. Filter to those whose path ends in a known media extension:
  //    .jpg, .jpeg, .png, .gif, .webp, .bmp, .svg, .mp4, .webm, .mov, .mp3, .ogg, .wav, .flac
  //    OR whose URL is to a known image hosting pattern (e.g., i.imgur.com/*, pbs.twimg.com/*)
  // 3. Exclude URLs that were already resolved as link previews (to avoid double-downloading)
  // 4. Return deduplicated URL list
}
```

Each linked media URL is downloaded via the fetch client and saved as a media asset with `role='linked_media'` or `role='reply_linked_media'`.

#### 5.7 Character Card Detection (`card-detect.ts`)

Non-inference detection. Reads PNG metadata/EXIF to detect SillyTavern character cards embedded in image files.

```typescript
async function detectCharacterCard(absolutePath: string): Promise<{
  detected: string;
  cardName?: string;
} | null> {
  // Read file, check PNG tEXt chunks for 'chara' key (base64-encoded JSON)
  // or check EXIF UserComment field
  // Returns detection result or null
}
```

This runs unconditionally on all image assets since it's purely local I/O with no cost.

### 5.8 Caption System (`src/captioning/`)

Captioning is a **separate, symmetric DB-driven worker pool** that runs independently from enrichment. It uses the same pattern as the enrichment worker pool — polling the DB for eligible work — but operates on individual `media_assets` rows rather than `timeline_events`.

#### CaptionWorkerPool (`src/captioning/worker-pool.ts`)

```typescript
interface CaptionWorkerPoolOptions {
  storage: Storage;
  inferenceClient: ConcurrencyLimitedInferenceClient;
  workspaceRoot: string;
  config: CaptionConfig;
  onComplete?: (eventId: string) => void;
  onError?: (assetId: string, error: unknown) => void;
  logger: Logger;
}

class CaptionWorkerPool {
  private running = false;
  private activeWorkers = new Set<Promise<void>>();

  start(): void;
  // Begins the polling loop. At each tick:
  // 1. Query DB for eligible uncaptioned media assets (see SQL below)
  // 2. Claim each by setting caption_status='processing' (compare-and-swap)
  // 3. Spawn a CaptionWorker for each claimed asset
  // 4. When a worker completes, check for more work
  // Poll interval: 500ms when there was work, 2000ms when idle.
  // (Caption work is less latency-sensitive than enrichment.)

  stop(): Promise<void>;
  // Set running=false, await all active workers

  notifyNewWork(): void;
  // Called when trigger_group_id is assigned to events, making their
  // media assets newly eligible. Wakes the poll loop immediately.
}
```

**Eligibility query:**

The caption worker pool polls for media assets that are eligible for captioning. An asset is eligible when:
1. `caption_status = 'pending'` (enrichment marked it as eligible)
2. `download_status = 'complete'` (the file is on disk)
3. `media_type = 'image'` (only images are captioned)
4. The event is in a trigger group **OR** config `caption_all` is true

Trigger-group media is prioritized over non-trigger-group media. Within the same priority tier, most-recent-first.

```sql
SELECT ma.id, ma.event_id, ma.local_path, ma.mime_type, ma.original_filename,
       te.trigger_group_id
FROM media_assets ma
JOIN timeline_events te ON ma.event_id = te.id
WHERE ma.caption_status = 'pending'
  AND ma.download_status = 'complete'
  AND ma.media_type = 'image'
  AND (te.trigger_group_id IS NOT NULL OR :caption_all = 1)
ORDER BY
  CASE WHEN te.trigger_group_id IS NOT NULL THEN 0 ELSE 1 END,
  te.timestamp DESC
LIMIT :worker_count
```

Add index for this query:

```sql
CREATE INDEX IF NOT EXISTS idx_media_assets_caption_eligible
  ON media_assets(caption_status, download_status, media_type)
  WHERE caption_status IN ('pending', 'processing');
```

**Stale claim recovery:** On startup, reset any assets stuck in `caption_status = 'processing'`:

```sql
UPDATE media_assets SET caption_status = 'pending'
  WHERE caption_status = 'processing';
```

#### CaptionWorker (`src/captioning/worker.ts`)

Processes a single media asset. Reads the image, resizes it ephemerally for inference, sends to the captioning model, and updates the DB row.

```typescript
class CaptionWorker {
  async process(asset: MediaAssetRow): Promise<void> {
    const absolutePath = path.join(this.workspaceRoot, asset.local_path);

    // 1. Resize image ephemerally for inference
    const resized = await resizeImageForInference({
      inputPath: absolutePath,
      maxWidth: this.config.image_resize.max_width,
      maxHeight: this.config.image_resize.max_height,
      maxBytes: this.config.image_resize.max_bytes,
    });

    // 2. Call captioning model
    const result = await this.inferenceClient.caption({
      imageData: resized.data,
      mediaType: resized.mediaType,
      filename: asset.original_filename ?? path.basename(asset.local_path),
    });

    // 3. Update media_asset row
    await this.storage.write((db) => {
      db.prepare(`
        UPDATE media_assets
        SET caption = ?, caption_model = ?, caption_status = 'complete'
        WHERE id = ?
      `).run(result.caption, result.model, asset.id);
    });

    // 4. Emit completion notification (for trigger path awaiting)
    this.onComplete?.(asset.event_id);
  }
}
```

On error, the asset's `caption_status` is set to `'failed'` with the error recorded. The asset is not retried automatically — failed captions are treated as absent during context build.

#### ConcurrencyLimitedInferenceClient (`src/captioning/inference-client.ts`)

A shared client for inference tasks (currently: image captioning). Limits concurrency to control cost and API load.

```typescript
interface InferenceClientOptions {
  maxConcurrency: number;  // e.g. 2
  captionModel: ModelConfig; // which model to use, endpoint, API key
}

class ConcurrencyLimitedInferenceClient {
  caption(params: {
    imageData: Buffer;    // already-resized image data (ephemeral)
    mediaType: string;    // mime type of the resized image
    filename: string;     // for context in the captioning prompt
  }): Promise<{
    caption: string;
    model: string;
  }>;
  // Sends the pre-resized image to the captioning model and returns
  // the caption text. Internally limits concurrency via FIFO queue.
}
```

#### Image Resizing for Inference (`src/captioning/image-resize.ts`)

```typescript
async function resizeImageForInference(params: {
  inputPath: string;  // absolute path to original stored file
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
}): Promise<{ data: Buffer; mediaType: string }> {
  // Same algorithm as current encodeImageForContext():
  // - Read from disk
  // - Resize to fit within maxWidth x maxHeight
  // - Encode as JPEG with mozjpeg, iterating quality [82, 72, 62, 52, 42, 35]
  // - Scale down further if needed
  // - Returns buffer + 'image/jpeg'
  // The file on disk is NOT modified.
}
```

This is also used by the context builder for image block preparation (section 8). The same function, potentially with different config values (caption resize settings vs. context image settings).

### 6. Atomic Persistence (`worker.ts`)

The enrichment worker writes all results in a single DB transaction:

```typescript
async persistResults(eventId: string, result: EnrichmentResult): Promise<void> {
  await this.storage.readAndWrite((db) => {
    // 1. Insert reply_context (if any)
    if (result.replyContext) {
      db.prepare(`INSERT INTO reply_contexts (...) VALUES (...)`).run({ ... });
    }

    // 2. Insert all link_previews
    for (const preview of result.linkPreviews) {
      db.prepare(`INSERT INTO link_previews (...) VALUES (...)`).run({ ... });
    }

    // 3. Insert all media_assets
    for (const asset of result.mediaAssets) {
      db.prepare(`INSERT INTO media_assets (...) VALUES (...)`).run({ ... });
    }

    // 4. Flip enrichment status
    db.prepare(`UPDATE timeline_events SET enrichment_status = 'complete', updated_at = ? WHERE id = ?`)
      .run(Date.now(), eventId);
  });
}
```

If the transaction fails, the status remains `'processing'`. On restart, it gets reset to `'pending'` and retried.

### 7. Trigger Path Changes (`src/app.ts`)

#### Before

```typescript
async function prepareTriggerMedia(inbound: InboundChatEvent): Promise<void> {
  const prepared = await background.prepareTriggerEvent(inbound.event);
  inbound.event = prepared;
  // ...caption grouped events too...
}
```

#### After

The trigger path is now pure awaiting on DB state — it doesn't do any enrichment or captioning work itself. It just waits for the worker pools to finish processing the trigger group's events and media.

```typescript
async function awaitTriggerReadiness(inbound: InboundChatEvent): Promise<void> {
  const eventIds = inbound.trigger?.groupedEventIds ?? [inbound.event.id];
  const enrichmentTimeoutMs = config.enrichment?.trigger_wait_timeout_ms ?? 30_000;
  const captionTimeoutMs = config.captioning?.trigger_wait_timeout_ms ?? 45_000;

  // Step 1: Await enrichment completion for all trigger group events.
  // Enrichment must complete first because caption workers need the
  // downloaded media assets that enrichment produces.
  await Promise.all(
    eventIds.map((eventId) => awaitEnrichmentComplete(eventId, enrichmentTimeoutMs))
  );

  // Step 2: Await caption completion for all trigger group image assets.
  // After enrichment, media_assets rows exist with caption_status='pending'.
  // The caption workers are already processing them (they became eligible
  // when trigger_group_id was set). We just need to wait for them to finish.
  await awaitCaptionsComplete(eventIds, captionTimeoutMs);
}

function awaitEnrichmentComplete(eventId: string, timeoutMs: number): Promise<void> {
  // 1. Check DB: if enrichment_status is 'complete', 'failed', or 'skipped', return immediately
  // 2. Otherwise, subscribe to enrichmentEmitter.once(`complete:${eventId}`)
  // 3. Race against setTimeout(timeoutMs)
  // 4. If timeout: log warning, proceed anyway (agent gets unenriched data for that event)
}

async function awaitCaptionsComplete(eventIds: string[], timeoutMs: number): Promise<void> {
  // 1. Query: are there any media_assets for these events with
  //    caption_status = 'pending' or caption_status = 'processing'?
  //
  //    SELECT COUNT(*) as remaining FROM media_assets
  //    WHERE event_id IN (?, ?, ...)
  //      AND caption_status IN ('pending', 'processing')
  //      AND media_type = 'image'
  //
  // 2. If remaining = 0, return immediately (all done or none exist)
  // 3. Otherwise, subscribe to captionEmitter events and re-check after each
  // 4. Race against setTimeout(timeoutMs)
  // 5. If timeout: log warning, proceed anyway (agent gets uncaptioned images,
  //    which is fine — captions are supplementary, not required)
}
```

The flow from the trigger firing through to session launch:

```
Trigger fires
  → resolve trigger group (hold + lookback), persist trigger_group_id on all group events
  → (caption workers now see those events' media assets as eligible, start processing)
  → notify caption worker pool of new work
  → await enrichment_status = 'complete' for all group events (or timeout)
  → await caption_status != 'pending' for all group image assets (or timeout)
  → launch agent session
```

The `BackgroundProcessor` class is removed entirely. Its functionality is replaced by the enrichment and caption worker pools.

### 8. Context Builder Changes (`src/context/builder.ts`)

#### Hydrating events with enrichment data

The context builder currently reads `CanonicalChatEvent` objects from the timeline and passes them directly to the renderer. Now it needs to hydrate them with enrichment data first.

New method on `TimelineStore` (or a new `EnrichmentStore`):

```typescript
interface HydratedEvent {
  event: CanonicalChatEvent;
  replyContext: ReplyContextRow | null;
  mediaAssets: MediaAssetRow[];
  linkPreviews: LinkPreviewRow[];
}

function hydrateForRendering(events: CanonicalChatEvent[]): HydratedEvent[] {
  // Batch query: load all enrichment data for the given event IDs
  // JOIN across reply_contexts, media_assets, link_previews
  // Return HydratedEvent[] in same order
}
```

Then, before rendering, merge the hydrated data into the event shape the renderer expects:

```typescript
function mergeEnrichmentIntoEvent(hydrated: HydratedEvent): CanonicalChatEvent {
  const event = { ...hydrated.event };

  // Merge attachments: replace stubs with enriched data from media_assets (role='attachment')
  event.attachments = hydrated.mediaAssets
    .filter(a => a.role === 'attachment')
    .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0))
    .map(toAttachmentMeta);

  // Merge reply context
  if (hydrated.replyContext) {
    event.replyTo = {
      externalId: hydrated.replyContext.reply_external_id,
      sender: {
        id: hydrated.replyContext.sender_id,
        displayName: hydrated.replyContext.sender_display_name,
        username: hydrated.replyContext.sender_username,
      },
      body: hydrated.replyContext.body,
      htmlBody: hydrated.replyContext.html_body,
      timestamp: hydrated.replyContext.timestamp,
      attachments: hydrated.mediaAssets
        .filter(a => a.role === 'reply_attachment')
        .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0))
        .map(toAttachmentMeta),
      linkPreviews: hydrated.linkPreviews
        .filter(lp => lp.context === 'reply')
        .sort((a, b) => a.preview_index - b.preview_index)
        .map(toLinkPreviewMeta),
    };
  }

  // Merge link previews for the message itself
  event.linkPreviews = hydrated.linkPreviews
    .filter(lp => lp.context === 'message')
    .sort((a, b) => a.preview_index - b.preview_index)
    .map(lp => toLinkPreviewMeta(lp, hydrated.mediaAssets));

  return event;
}
```

The renderer (`renderRichMessage`, `renderCompactMessage`) works unchanged — it receives `CanonicalChatEvent` objects with populated fields.

#### Image block selection

`selectImageAttachments()` changes to use the trigger group from the DB instead of doing its own lookback:

```typescript
private selectImageAttachments(trigger: CanonicalChatEvent): Array<{ eventId: string; attachment: AttachmentMeta }> {
  // 1. Query media_assets for all events in the trigger group:
  //    SELECT * FROM media_assets
  //    WHERE event_id IN (SELECT id FROM timeline_events WHERE trigger_group_id = :triggerEventId)
  //      AND media_type = 'image'
  //      AND download_status = 'complete'
  //    ORDER BY ...

  // 2. Apply priority cascade within the group:
  //    a. Trigger message's own attachments (role='attachment')
  //    b. Trigger message's reply attachments (role='reply_attachment')
  //    c. Trigger message's preview/linked media
  //    d. Grouped event attachments (from other events in trigger group)
  //    e. Grouped event reply/preview/linked media

  // 3. Return at most one event's images (first non-empty tier)
}
```

Image blocks are resized ephemerally at context-build time using the same `resizeImageForInference()` with context-specific config (from `config.context.images`). The stored file is always the original.

### 9. Renderer Changes (`src/context/renderer.ts`)

#### Reply context rendering

Currently `renderReply()` uses `reply.sender.displayName ?? reply.sender.id` for the sender. Change to use the same `senderLabel()` logic as messages (showing `Name (username)` format):

```typescript
function renderReply(reply: ReplyContext): string {
  const sender = reply.sender
    ? (reply.sender.displayName && reply.sender.username && reply.sender.displayName !== reply.sender.username
        ? `${reply.sender.displayName} (${reply.sender.username})`
        : reply.sender.displayName ?? reply.sender.id)
    : "unknown";
  // ... rest unchanged
}
```

#### Reply link previews

The `ReplyContext` type gains a `linkPreviews` field. `renderReply()` renders them:

```typescript
function renderReply(reply: ReplyContext): string {
  const attachments = (reply.attachments ?? []).map(renderAttachment).join("\n\n");
  const previews = (reply.linkPreviews ?? []).map(renderLinkPreview).join("\n\n");
  return `<reply_to ${attrs...}>\n${escapeXml(reply.body ?? "")}${attachments ? `\n\n${attachments}` : ""}${previews ? `\n\n${previews}` : ""}\n</reply_to>`;
}
```

#### Link preview images

When a link preview has associated media (OG image, tweet photos), the renderer includes them:

```typescript
function renderLinkPreview(preview: LinkPreviewMeta): string {
  const attrs = [
    ["url", preview.url],
    preview.title ? ["title", preview.title] : undefined,
  ].filter(Boolean) as string[][];

  // Preview media rendered as nested attachments
  const mediaBlocks = (preview.media ?? []).map(renderAttachment).join("\n\n");

  return `<link_preview ${attrs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ")}>\n${escapeXml(preview.description ?? "")}${mediaBlocks ? `\n\n${mediaBlocks}` : ""}\n</link_preview>`;
}
```

### 10. Type Changes (`src/types.ts`)

#### ReplyContext gains linkPreviews

```typescript
export interface ReplyContext {
  externalId?: string;
  sender?: SenderInfo;
  body?: string;
  htmlBody?: string;
  timestamp?: number;
  attachments?: AttachmentMeta[];
  linkPreviews?: LinkPreviewMeta[];  // NEW
}
```

#### SenderInfo gains username

```typescript
export interface SenderInfo {
  id: string;
  displayName?: string;
  username?: string;  // already exists but ensure it's populated
  isSelf?: boolean;
}
```

#### LinkPreviewMeta gains media

```typescript
export interface LinkPreviewMeta {
  url: string;
  title?: string;
  description?: string;
  imagePath?: string;      // kept for simple cases
  media?: AttachmentMeta[]; // NEW: all media from this preview
  sourceKind?: string;      // NEW: 'synapse' | 'fxtwitter' | 'generic'
  fetchedAt?: number;
}
```

### 11. Config Changes (`src/config/schema.ts`)

Add enrichment and captioning configuration as **separate** config sections (reflecting their architectural independence):

```typescript
const EnrichmentSchema = Type.Object({
  worker_count: Type.Optional(Type.Number({ minimum: 1 })),         // default: 3
  fetch_concurrency: Type.Optional(Type.Number({ minimum: 1 })),    // default: 6
  fetch_timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),  // default: 10_000
  trigger_wait_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })), // default: 30_000
  max_download_bytes: Type.Optional(Type.Number({ minimum: 0 })),   // default: 50_000_000 (50MB)
  max_previews_per_message: Type.Optional(Type.Number({ minimum: 0 })), // default: 3
});

const CaptioningSchema = Type.Object({
  worker_count: Type.Optional(Type.Number({ minimum: 1 })),         // default: 2
  inference_concurrency: Type.Optional(Type.Number({ minimum: 1 })),// default: 2
  caption_all: Type.Optional(Type.Boolean()),                       // default: false
  // When false (default): only caption media from events in a trigger group.
  // When true: caption all eligible image media, regardless of trigger group membership.
  caption_model: Type.Optional(Type.String()),                      // model key from models config
  trigger_wait_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })), // default: 45_000
  image_resize: Type.Optional(Type.Object({
    // Settings for resizing images for inference (captioning).
    // Stored files are ALWAYS the original, unmodified. Resizing is ephemeral.
    max_width: Type.Optional(Type.Number({ minimum: 1 })),          // default: 1280
    max_height: Type.Optional(Type.Number({ minimum: 1 })),         // default: 720
    max_bytes: Type.Optional(Type.Number({ minimum: 1 })),          // default: 1_048_576 (1MB)
  })),
});
```

Add to AppConfigSchema:
```typescript
enrichment: Type.Optional(EnrichmentSchema),
captioning: Type.Optional(CaptioningSchema),
```

Note: image resizing for context-build (agent image blocks) remains under the existing `context.images` config. The `captioning.image_resize` controls the separate resize parameters for inference/captioning. These may differ — for example, captioning might use larger images for better descriptions while context images are more aggressively compressed for token savings.

### 12. Application Lifecycle Changes (`src/app.ts`)

#### Startup

Add enrichment and captioning system initialization after timeline store creation:

```typescript
// Create shared clients
const fetchClient = new ConcurrencyLimitedFetchClient({
  maxConcurrency: config.enrichment?.fetch_concurrency ?? 6,
  timeoutMs: config.enrichment?.fetch_timeout_ms ?? 10_000,
  maxResponseBytes: config.enrichment?.max_download_bytes ?? 50_000_000,
});

const inferenceClient = new ConcurrencyLimitedInferenceClient({
  maxConcurrency: config.captioning?.inference_concurrency ?? 2,
  captionModel: config.models[config.captioning?.caption_model ?? 'default'],
});

// Event emitters for trigger path awaiting
const enrichmentEmitter = new EventEmitter();
const captionEmitter = new EventEmitter();

// Enrichment worker pool — downloads, link previews, reply resolution
const enrichmentPool = new EnrichmentWorkerPool({
  storage,
  timeline,
  providerCapabilities: new Map(), // populated after provider.start()
  fetchClient,
  workspaceRoot,
  config: config.enrichment ?? {},
  onComplete: (eventId) => enrichmentEmitter.emit(`complete:${eventId}`),
  onError: (eventId, error) => logger.error('enrichment_failed', { eventId, error: String(error) }),
  logger,
});

// Caption worker pool — image captioning via inference
const captionPool = new CaptionWorkerPool({
  storage,
  inferenceClient,
  workspaceRoot,
  config: config.captioning ?? {},
  onComplete: (eventId) => captionEmitter.emit(`complete:${eventId}`),
  onError: (assetId, error) => logger.error('caption_failed', { assetId, error: String(error) }),
  logger,
});

// After provider starts:
for (const [accountId, _] of Object.entries(config.matrix.accounts)) {
  enrichmentPool.providerCapabilities.set(
    `matrix:${accountId}`,
    provider.getEnrichmentCapabilities(accountId),
  );
}

enrichmentPool.start();
captionPool.start();
```

#### Shutdown

```typescript
captionPool.stop();     // await active caption workers
enrichmentPool.stop();  // await active enrichment workers
fetchClient.stop();     // reject queued fetch requests
inferenceClient.stop(); // reject queued inference requests
```

#### handleInbound changes

```typescript
async function handleInbound(inbound: InboundChatEvent): Promise<void> {
  if (draining) return;
  if (inbound.event.role === "assistant" && inbound.event.sender.isSelf) {
    await echo.ingestOwnEcho(inbound.event);
    return;
  }

  // Determine enrichment status before persisting
  inbound.event.enrichmentStatus = needsEnrichment(inbound.event) ? 'pending' : 'skipped';

  const routed = await router.route(inbound);
  if (steerReplyToActiveSession(inbound)) return;

  // Notify enrichment pool of new event (optimization: wakes polling immediately)
  if (inbound.event.enrichmentStatus === 'pending') {
    enrichmentPool.notifyNewEvent(inbound.event.id);
  }

  if (!inbound.trigger) return; // Non-trigger: enrichment runs in background, no session

  // Resolve trigger group (hold + lookback) and persist trigger_group_id
  // This makes the group's media assets visible to caption workers.
  await resolveTriggerGroup(inbound);

  // Notify caption pool that trigger group media is now eligible
  captionPool.notifyNewWork();

  const decision = triggerCoordinator.accept(inbound);
  if (decision.action !== "spawn") { /* log, return */ }

  // Await BOTH enrichment and captioning for all trigger group events
  await awaitTriggerReadiness(inbound);

  launchSession(inbound, routed.duplicate);
}
```

### 13. Modules Removed

- `src/timeline/background.ts` — `BackgroundProcessor` class. Replaced by enrichment worker pool.
- The `prepareTriggerEvent` / `processNonTriggerEvent` / `Captioner` type — all replaced.
- `createBasicCaptioner()` in `app.ts` — replaced by `CaptionWorkerPool` + `ConcurrencyLimitedInferenceClient`.

### 14. NAPI Changes Required (Rust native module)

The following NAPI bindings in `native/crates/matrix-core/` must be converted from synchronous to async:

1. **`download_media`** — currently blocks on network I/O (homeserver fetch + E2EE decryption). Must return `JsPromise` backed by Tokio task.
2. **`message_summary`** — may involve network I/O if the event isn't cached. Must return `JsPromise`.
3. **`resolve_link_previews`** — does network I/O (Synapse preview endpoint, FxTwitter API, optional image downloads). Must return `JsPromise`.
4. **`member_info`** — may involve network I/O. Must return `JsPromise`.

The conversion pattern in napi-rs:

```rust
// Before (synchronous, blocks event loop):
#[napi]
pub fn download_media(&self, request: MatrixDownloadMediaRequest) -> napi::Result<MatrixDownloadMediaResult> {
    let rt = self.runtime.clone();
    let result = rt.block_on(async { /* ... */ })?;
    Ok(result)
}

// After (async, returns Promise):
#[napi]
pub async fn download_media(&self, request: MatrixDownloadMediaRequest) -> napi::Result<MatrixDownloadMediaResult> {
    // napi-rs automatically wraps async fn return in a JsPromise
    // The async block runs on the Tokio runtime without blocking the Node.js event loop
    let result = /* ... async work ... */;
    Ok(result)
}
```

The TypeScript wrapper (`MatrixNativeClient`) must update its call sites to `await` these methods. Since the enrichment worker is async, this is natural. Any remaining synchronous call sites in the provider (e.g., `sendMessage` in the outbound path) should also be audited but are separate from this change.

### 15. Migration Path

This is a large change. Recommended implementation order:

**Phase A: Schema + Storage (no behavioral change)**
1. Add new columns to `timeline_events` (`enrichment_status`, `trigger_group_id`)
2. Create new tables (`reply_contexts`, `media_assets`, `link_previews`)
3. Add `caption_status` index on `media_assets` for caption worker polling
4. Add storage methods for reading/writing enrichment data
5. Add `hydrateForRendering()` query method
6. Set all existing events to `enrichment_status = 'skipped'` in migration

**Phase B: NAPI async conversion**
1. Convert `download_media`, `message_summary`, `resolve_link_previews`, `member_info` to async NAPI
2. Update `MatrixNativeClient` TypeScript wrapper
3. Update existing call sites to `await`
4. Verify nothing breaks (existing behavior preserved, just async now)

**Phase C: Enrichment system core**
1. Implement `ConcurrencyLimitedFetchClient`
2. Implement `EnrichmentWorker` with all enrichment logic (NO inference)
3. Implement `EnrichmentWorkerPool`
4. Implement media file handling (filename generation, saving)
5. Implement linked media extraction
6. Port character card detection from OpenClaw

**Phase D: Caption system**
1. Implement `ConcurrencyLimitedInferenceClient` (initially with sharp-only metadata, then LLM)
2. Implement `CaptionWorker`
3. Implement `CaptionWorkerPool`
4. Implement `resizeImageForInference()`
5. Wire into `app.ts` startup/shutdown

**Phase E: Integration**
1. Strip `processMatrixInboundEvent()` down to `normalizeMatrixInboundEvent()` only
2. Wire enrichment pool into `app.ts` startup
3. Change `handleInbound` to the new flow (persist bare event → trigger group resolution → notify caption pool → await enrichment + captions → launch session)
4. Remove `BackgroundProcessor`
5. Update context builder to hydrate events from enrichment tables
6. Update renderer for reply link previews and preview media
7. Update image block selection to use trigger group from DB

**Phase F: Config + polish**
1. Add enrichment config schema
2. Add captioning config schema (separate section)
3. Add config for image resizing (captioning vs context — separate parameters)
4. Wire config through
5. Add defaults to `00-defaults.toml`
6. Update ARCHITECTURE.md

Each phase can be tested independently. Phase B is the riskiest (Rust changes); everything else is TypeScript. Phases C and D can be developed in parallel since they are independent systems.
