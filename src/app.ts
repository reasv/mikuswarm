import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config/index.js";
import { createLogger, createObservabilityServer, PipelineActivityBus, type ConsoleServer } from "./observability/index.js";
import { MatrixProvider, RoomLabelCache, ingestReactionEvent } from "./matrix/index.js";
import { Storage, MemoryFileWriter } from "./storage/index.js";
import {
  ActivationCoordinator,
  applyEditToCanonical,
  AssistantEchoResolver,
  editStatus,
  needsEnrichment,
  roomIdFromTimelineKey,
  TimelineRouter,
  TimelineStore,
  TriggerCoordinator,
} from "./timeline/index.js";
import { AgentSessionFactory, SessionManager, SessionRunner } from "./agent/index.js";
import { attachSessionCapture, type SessionCaptureHandle } from "./agent/session-capture.js";
import { ContextBuilder, renderRichMessage } from "./context/index.js";
import type { ContextMessage } from "./context/builder.js";
import {
  createBrowserTool,
  createChannelInfoTool,
  createCreatePollTool,
  createDanbooruTool,
  createDeleteMessageTool,
  createDelegateToSessionTool,
  createEditMessageTool,
  createEmojiListTool,
  createListReactionsTool,
  createReadMessagesTool,
  createSearchMessagesTool,
  createExpandSummaryTool,
  createRecapTool,
  createUserActivityTool,
  createMediaTool,
  createMemberInfoTool,
  createPinsTool,
  createPollVoteTool,
  createReactTool,
  createBashTool,
  createReadImageTool,
  createSearchMemoryTool,
  createRecallMemoryTool,
  createSearchFilesTool,
  createSendMessageTool,
  createSetProfileTool,
  createSillyTavernCardCreateTool,
  createSillyTavernCardEditTool,
  createSillyTavernCardReadTool,
  createTextEditorTool,
  createUserProfileEditTool,
  createUserProfileReadTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteMemoryTool,
} from "./tools/index.js";
import type { InboundChatEvent } from "./types.js";
import { EnrichmentWorkerPool, ConcurrencyLimitedFetchClient } from "./enrichment/index.js";
import { CaptionWorkerPool, ConcurrencyLimitedInferenceClient, type MediaModality } from "./captioning/index.js";
import { buildInferenceImageOptions } from "./media/index.js";
import { McpClientPool, adaptMcpTools } from "./mcp/index.js";
import { SummarizationWorkerPool } from "./summarization/index.js";
import { DiaryWorkerPool } from "./diary/index.js";
import { createRetrievalSubsystem, resolveRetrievalConfig, type RetrievalSubsystem } from "./retrieval/index.js";
import {
  ChatSearchIndexer,
  ABSENCE_GAP_DEFAULT_MS,
  ABSENCE_LOOKBACK_DEFAULT_MS,
} from "./search/index.js";
import { performInitialBackfill } from "./backfill/index.js";
import { RedecryptionSweeper, resolveMultiAccountRetry } from "./redecryption/index.js";
import { SandboxManager } from "./sandbox/index.js";
import { BrowserSession } from "./browser/index.js";
import { getConfiguredTimezone } from "./time/index.js";

export interface MikuAgentRuntime {
  stop(): Promise<void>;
}

export async function startMikuAgent(config: AppConfig): Promise<MikuAgentRuntime> {
  const logger = createLogger("mikuswarm", config.app.log_level);
  const storage = await Storage.open({
    databasePath: config.storage.database_path,
    logger: logger.child("storage"),
  });
  const timeline = new TimelineStore(storage);
  const router = new TimelineRouter(timeline);
  const triggerCoordinator = new TriggerCoordinator(config.agent.sessions);
  const sessions = new SessionManager({ storage, logger });
  const workspaceRoot = config.workspace.root_dir;
  await mkdir(workspaceRoot, { recursive: true });

  // Single-writer FIFO for all memory/*.md mutations (ARCHITECTURE.md §9b): the
  // diary worker's appends and `write_memory`'s edits serialize through it so a
  // concurrent read-modify-write can't corrupt a day file.
  const memoryWriter = new MemoryFileWriter(workspaceRoot);

  // Memory retrieval (ARCHITECTURE.md §9d): a hybrid lexical+semantic index over
  // `memory/*.md`. When enabled, the indexer reconciles the corpus on startup and
  // after each memory write (hooked below), the embedding worker populates the vector
  // index in the background, and the search engine backs the `recall_memory` tool and
  // auto-retrieval. Degrades to lexical-only (FTS5/BM25) if embeddings are unavailable.
  const retrievalConfig = resolveRetrievalConfig(config.retrieval);
  let retrieval: RetrievalSubsystem | undefined;
  if (retrievalConfig.enabled) {
    retrieval = await createRetrievalSubsystem({
      storage,
      workspaceRoot,
      dataDir: config.app.data_dir,
      config: retrievalConfig,
      httpProxyUrl: config.network?.http_proxy_url,
      logger: logger.child("retrieval"),
    });
    // Reconcile the touched file after every memory mutation (diary append /
    // write_memory edit), so new entries become searchable promptly (§7).
    memoryWriter.onAfterWrite = (absPath) => retrieval!.onMemoryWrite(absPath);
  }

  // Chat-history search index (ARCHITECTURE.md §9e): a denormalized FTS5 + metadata
  // projection of the timeline, backing the `search_messages` / `recap` /
  // `user_activity` tools. Unlike memory retrieval this is plain bundled SQLite (no
  // embeddings), so it is always on. The indexer backfills/repairs on the startup
  // sweep below, picks up late captions/previews via the enrichment + caption
  // completion hooks (wired into the pools below), and the tools lazily catch up new
  // events before each query.
  const chatSearchIndexer = new ChatSearchIndexer({
    storage,
    logger: logger.child("chat-search"),
  });
  // Resolved defaults for the search_messages / recap tools (§9e). Sourced from
  // [search] config with fail-fast fallbacks to the shared constants; set explicitly
  // in deployment config per project convention.
  const chatSearchDefaults = {
    absence: {
      gapThresholdMs: config.search?.absence_gap_ms ?? ABSENCE_GAP_DEFAULT_MS,
      defaultLookbackMs: config.search?.default_lookback_ms ?? ABSENCE_LOOKBACK_DEFAULT_MS,
    },
    recapBudgetTokens: config.search?.recap_budget_tokens ?? 6000,
    expand: {
      tokenCap: config.search?.summaries?.expand_token_cap ?? 4000,
      maxDepth: config.search?.summaries?.expand_max_depth ?? 3,
    },
  };

  // Docker sandbox (ARCHITECTURE.md §11a). When enabled, ensure the container is
  // up before anything else connects — a failure here aborts startup (fail-fast).
  // The sandbox handle is closed over by the per-session tools builder below.
  let sandbox: SandboxManager | undefined;
  if (config.sandbox?.enabled) {
    sandbox = await SandboxManager.ensure({
      image: config.sandbox.image,
      containerName: config.sandbox.container_name,
      network: config.sandbox.network,
      workspaceHostDir: path.resolve(workspaceRoot),
      workspaceMount: config.sandbox.workspace_mount,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      memory: config.sandbox.memory,
      cpus: config.sandbox.cpus,
      pidsLimit: config.sandbox.pids_limit,
      readOnlyRoot: config.sandbox.read_only_root,
      // Inject the agent's timezone so in-container `date`/`ls -l` reflect the
      // configured zone, not the image/host zone (leak prevention). A config
      // value can still override TZ explicitly if ever needed.
      env: { TZ: getConfiguredTimezone(), ...config.sandbox.env },
      binds: config.sandbox.binds,
      execTimeoutMs: config.sandbox.exec_timeout_ms,
      maxOutputBytes: config.sandbox.max_output_bytes,
      logger: logger.child("sandbox"),
    });
  }

  // Browser-use backend (spec/BROWSER-USE.md). Unlike the sandbox, this does NOT
  // connect or fail-fast at startup: the CloakBrowser-Manager is an operator-run
  // service the harness only reaches lazily on first browser-tool use, degrading
  // gracefully if it is down (§3.4). Constructing the manager here just holds
  // config + the per-session tab map; no I/O happens until a tool runs.
  let browserSession: BrowserSession | undefined;
  if (config.browser?.enabled) {
    browserSession = new BrowserSession({
      config: config.browser,
      agentTimezone: getConfiguredTimezone(),
      workspaceRoot,
      logger: logger.child("browser"),
    });
  }

  const echo = new AssistantEchoResolver(timeline);
  const contextBuilder = new ContextBuilder(
    timeline,
    config,
    storage,
    logger,
    // Auto-retrieval (§8c): only when retrieval is enabled AND auto_retrieval is on.
    retrieval && retrievalConfig.autoRetrieval
      ? { search: retrieval.search, config: retrievalConfig }
      : undefined,
  );

  const downloadSizeLimit = config.media?.download_size_limit ?? 1_073_741_824;
  const mediaCachePath = path.join(config.app.data_dir, "media-cache");

  const fetchClient = new ConcurrencyLimitedFetchClient({
    maxConcurrency: config.enrichment?.fetch_concurrency ?? 6,
    timeoutMs: config.enrichment?.fetch_timeout_ms ?? 10_000,
    maxResponseBytes: downloadSizeLimit,
    httpProxyUrl: config.network?.http_proxy_url,
  });

  const captioningConfig = config.captioning ?? {};
  const sharedModel = {
    id: captioningConfig.model?.id ?? "google/gemini-3.5-flash",
    endpoint: captioningConfig.model?.endpoint ?? config.models.default.endpoint,
    api_key: captioningConfig.model?.api_key ?? config.models.default.api_key,
  };

  function resolveModalityModel(modalityConfig?: { model?: { id?: string; endpoint?: string; api_key?: string } }) {
    return {
      id: modalityConfig?.model?.id ?? sharedModel.id,
      endpoint: modalityConfig?.model?.endpoint ?? sharedModel.endpoint,
      api_key: modalityConfig?.model?.api_key ?? sharedModel.api_key,
    };
  }

  const imageConfig = captioningConfig.image ?? {};
  const videoConfig = captioningConfig.video ?? {};
  const audioConfig = captioningConfig.audio ?? {};
  const mediaImageConfig = config.media?.image ?? {};
  const mediaVideoConfig = config.media?.video ?? {};
  const mediaAudioConfig = config.media?.audio ?? {};

  // Shared inference-image conditioning options. Single source of truth via
  // buildInferenceImageOptions — also consumed by ContextBuilder's
  // selectImageBlocks so the captioning pool, danbooru preview, and trigger
  // image-block path all use the same defaults.
  const inferenceImageOptions = buildInferenceImageOptions(mediaImageConfig);

  const captionClients = new Map<MediaModality, ConcurrencyLimitedInferenceClient>([
    ["image", new ConcurrencyLimitedInferenceClient({
      modality: "image",
      model: resolveModalityModel(imageConfig),
      prompt: imageConfig.prompt ?? "Describe the image.",
      maxChars: imageConfig.max_chars ?? 500,
      maxTokens: imageConfig.max_tokens ?? 2048,
      maxConcurrency: imageConfig.concurrency,
      imageProcessing: inferenceImageOptions,
    })],
    ["video", new ConcurrencyLimitedInferenceClient({
      modality: "video",
      model: resolveModalityModel(videoConfig),
      prompt: videoConfig.prompt ?? "Describe the video.",
      maxChars: videoConfig.max_chars ?? 500,
      maxTokens: videoConfig.max_tokens ?? 2048,
      maxConcurrency: videoConfig.concurrency,
      timeoutMs: videoConfig.timeout_ms,
      videoProcessing: {
        maxResolution: mediaVideoConfig.max_resolution ?? 480,
        maxBytes: mediaVideoConfig.max_bytes ?? 52_428_800,
        maxDurationSeconds: mediaVideoConfig.max_duration_seconds ?? 120,
        gpuAcceleration: mediaVideoConfig.gpu_acceleration ?? false,
        x264Preset: mediaVideoConfig.x264_preset ?? "veryfast",
        cachePath: mediaCachePath,
        cacheMaxBytes: mediaVideoConfig.cache_max_bytes ?? 21_474_836_480,
        cacheTargetBytes: mediaVideoConfig.cache_target_bytes ?? 16_106_127_360,
      },
    })],
    ["audio", new ConcurrencyLimitedInferenceClient({
      modality: "audio",
      model: resolveModalityModel(audioConfig),
      prompt: audioConfig.prompt ?? "Transcribe and describe the audio.",
      maxChars: audioConfig.max_chars ?? 2000,
      maxTokens: audioConfig.max_tokens ?? 4096,
      maxConcurrency: audioConfig.concurrency,
      timeoutMs: audioConfig.timeout_ms,
      audioProcessing: {
        maxBytes: mediaAudioConfig.max_bytes ?? 20_971_520,
        maxDurationSeconds: mediaAudioConfig.max_duration_seconds ?? 300,
      },
    })],
  ]);

  const defaultPrompts = new Map<MediaModality, string>([
    ["image", imageConfig.prompt ?? "Describe the image."],
    ["video", videoConfig.prompt ?? "Describe the video."],
    ["audio", audioConfig.prompt ?? "Transcribe and describe the audio."],
  ]);

  const enrichmentEmitter = new EventEmitter();
  const captionEmitter = new EventEmitter();

  // Pipeline monitor activity bus (ARCHITECTURE.md §11). One shared in-process bus
  // the four pools publish transitions to; the observability server subscribes and
  // fans out to `/api/pipelines/stream` SSE clients.
  const pipelineActivityBus = new PipelineActivityBus();

  const enrichmentPool = new EnrichmentWorkerPool({
    storage,
    timeline,
    providerCapabilities: new Map(),
    fetchClient,
    workspaceRoot,
    downloadSizeLimit,
    config: config.enrichment ?? {},
    onComplete: (eventId) => {
      enrichmentEmitter.emit(`complete:${eventId}`);
      // Re-project now that attachments, link previews and the reply sender are
      // resolved (§9e) — promotes the body-only index row to its full form.
      chatSearchIndexer.enqueueReconcileEvent(eventId);
    },
    onError: (eventId, error) =>
      logger.error("enrichment_failed", { eventId, error: error instanceof Error ? error.message : String(error) }),
    activityBus: pipelineActivityBus,
    logger,
  });

  const captionPool = new CaptionWorkerPool({
    storage,
    clients: captionClients,
    workspaceRoot,
    config: config.captioning ?? {},
    onComplete: (eventId) => {
      captionEmitter.emit(`complete:${eventId}`);
      // Re-project so the freshly generated caption text lands in the event's
      // searchable aux_text column (§9e).
      chatSearchIndexer.enqueueReconcileEvent(eventId);
    },
    onError: (assetId, error) =>
      logger.error("caption_failed", { assetId, error: error instanceof Error ? error.message : String(error) }),
    activityBus: pipelineActivityBus,
    logger,
  });

  const provider = new MatrixProvider({
    onError: (error, context) =>
      logger.error("matrix_provider_error", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      }),
    onNativeEvent: (event, context) =>
      logger.info("matrix_native_event", {
        ...context,
        type: event.type,
        state: "state" in event ? event.state : undefined,
        stage: "stage" in event ? event.stage : undefined,
      }),
    // Passive reaction surfacing (ARCHITECTURE.md §9f): persist to the reaction
    // store only — never wake a session. Writes are fire-and-forget through the
    // single-writer queue; a failure is logged but must not stall the poll loop.
    onReaction: (event, context) => {
      // Master switch: when reactions are disabled, don't even persist (the views
      // are gated independently in the context builder).
      if (config.reactions?.enabled === false) return;
      void ingestReactionEvent(storage, context.accountId, event, Date.now())
        .then((outcome) => {
          if (outcome.action === "skipped") {
            logger.warn("reaction_add_incomplete", {
              ...context,
              reactionEventId: event.reactionEventId,
              reason: outcome.reason,
            });
          }
        })
        .catch((error) =>
          logger.error("reaction_ingest_failed", {
            ...context,
            reactionEventId: event.reactionEventId,
            action: event.action,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    onDiagnostics: (diagnostics, context) =>
      logger.info("matrix_diagnostics", {
        ...context,
        verificationState: diagnostics.verificationState,
        keyBackupState: diagnostics.keyBackupState,
        syncState: diagnostics.syncState,
        lastSuccessfulSyncAt: diagnostics.lastSuccessfulSyncAt,
        lastSuccessfulDecryptionAt: diagnostics.lastSuccessfulDecryptionAt,
      }),
  });
  const activeRuns = new Set<Promise<void>>();
  let draining = false;
  let stopPromise: Promise<void> | undefined;
  const factory = new AgentSessionFactory({
    config,
    contextBuilder,
    getActiveSessions: (timelineKey) => sessions.activeForTimeline(timelineKey),
    storage,
    logger,
  });

  // Fail-fast: a misconfigured summarizer must not silently fall back to the
  // default chat agent or model. Both this check and pool instantiation use
  // the same predicate so validation always runs when the pool would start.
  const summarizationEnabled = config.summarization?.enabled !== false;
  if (summarizationEnabled) {
    for (const typeName of ["summarize", "condense"] as const) {
      const sessionType = factory.resolveSessionType(typeName);
      if (!sessionType) {
        throw new Error(`summarization enabled but session type "${typeName}" is not configured (and no "default" fallback exists)`);
      }
      const modelKey = sessionType.model ?? "default";
      if (!config.models[modelKey]) {
        throw new Error(
          `summarization session type "${typeName}" references model "${modelKey}" which is not in config.models`,
        );
      }
      // A summarization session with a `tools` allowlist that omits `summary_tool`
      // spawns with no editor: every job exhausts its retries to `failed` silently
      // (a slow, invisible failure). An absent allowlist (`tools` undefined) permits
      // all tools, so only a *present* allowlist missing the editor is misconfigured.
      // (Symmetric with the diary `diary_tool` check below.)
      if (sessionType.tools && !sessionType.tools.includes("summary_tool")) {
        throw new Error(
          `summarization session type "${typeName}" has a tools allowlist that does not include "summary_tool" (the summarization editor); summarization sessions would spawn with no editor and fail every job`,
        );
      }
    }
  }

  const summarizationPool = summarizationEnabled
    ? new SummarizationWorkerPool({
        storage,
        factory,
        config: config.summarization ?? {},
        onComplete: (jobId, summaryId) => {
          logger.info("summarization_job_complete", { jobId, summaryId });
          summarizationPool!.notifyNewWork();
          // A completed level-1 summary just queued a diary job (diary_status =
          // 'pending'); wake the diary pool so it doesn't wait for its next poll.
          diaryPool?.notifyNewWork();
        },
        onError: (jobId, error) => logger.error("summarization_failed", { jobId, error: error.message }),
        activityBus: pipelineActivityBus,
        logger: logger.child("summarization"),
      })
    : null;

  if (summarizationPool) {
    contextBuilder.onJobEnqueued = () => summarizationPool.notifyNewWork();
  }

  // Diary worker pool (ARCHITECTURE.md §9c). Same fail-fast validation as
  // summarization: a misconfigured diary session type must not silently fall back.
  const diaryEnabled = config.diary?.enabled !== false;
  if (diaryEnabled) {
    const sessionType = factory.resolveSessionType("diary");
    if (!sessionType) {
      throw new Error(`diary enabled but session type "diary" is not configured (and no "default" fallback exists)`);
    }
    const modelKey = sessionType.model ?? "default";
    if (!config.models[modelKey]) {
      throw new Error(`diary session type "diary" references model "${modelKey}" which is not in config.models`);
    }
    // A diary session with a `tools` allowlist that omits `diary_tool` spawns with
    // no editor: every job exhausts its retries to `failed` silently (a slow,
    // invisible failure). An absent allowlist (`tools` undefined) permits all tools
    // and is fine — only a present allowlist missing the editor is misconfigured.
    if (sessionType.tools && !sessionType.tools.includes("diary_tool")) {
      throw new Error(
        `diary session type "diary" has a tools allowlist that does not include "diary_tool" (the diary editor); diary sessions would spawn with no editor and fail every job`,
      );
    }
  }

  // Map a (per-room) timeline key to its account + room id and ask that account's
  // Matrix client for a human room label. Shared by the diary header and the
  // RoomLabelCache (which feeds the observability console room list). Rejects on a
  // malformed key; both callers retry and fall back to the room id, so a failure
  // never blocks a job.
  const resolveChannelLabel = (timelineKey: string): Promise<string> => {
    const accountId = timelineKey.split(":")[1];
    const roomId = roomIdFromTimelineKey(timelineKey);
    if (!roomId) throw new Error(`cannot resolve room id from timeline key "${timelineKey}"`);
    const client = provider.getClient({ provider: "matrix", timelineKey, accountId });
    return client.channelLabel({ roomId });
  };

  const diaryPool = diaryEnabled
    ? new DiaryWorkerPool({
        storage,
        factory,
        memoryWriter,
        config: config.diary ?? {},
        workspaceRoot,
        // The diary header needs a human room label. The worker retries this and
        // falls back to the room id, so it never blocks a job.
        resolveChannelLabel,
        onComplete: (summaryId) => logger.info("diary_job_complete", { summaryId }),
        onError: (summaryId, error) => logger.error("diary_failed", { summaryId, error: error.message }),
        activityBus: pipelineActivityBus,
        logger: logger.child("diary"),
      })
    : null;

  const disabledTools = new Set(config.agent.disabled_tools ?? []);

  const mcpPool = new McpClientPool({
    servers: config.mcp?.servers ?? {},
    logger: logger.child("mcp"),
  });
  await mcpPool.start();
  const mcpTools = mcpPool.getEntries().flatMap((entry) =>
    adaptMcpTools(entry.name, entry.tools, entry.client, logger.child("mcp")),
  );

  // Caches resolved human room labels in `room_metadata` so the observability
  // console shows real room names instead of raw room ids. Populated lazily on
  // inbound activity (ensureLabel below) plus a throttled startup backfill.
  const roomLabels = new RoomLabelCache({
    store: storage,
    resolve: resolveChannelLabel,
    logger: logger.child("room-labels"),
  });

  provider.subscribe((inbound) => {
    void handleInbound(inbound).catch((error) => {
      logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handleInbound(inbound: InboundChatEvent): Promise<void> {
    if (draining) return;

    // An `m.replace` edit is applied to its target message in place (issue #17),
    // mirroring a normal client — never appended as a standalone row and never a
    // trigger. The replacement body/attachments live on `inbound.event`. Routed
    // before echo/activation so it's handled uniformly for any sender and any
    // timeline state (inactive targets stay 'inactive' via editStatus gating).
    if (inbound.edit) {
      await applyEdit(inbound);
      return;
    }

    // Lazily cache a human room label for the console room list. Cheap and
    // fire-and-forget: a synchronous freshness check, then a background resolve
    // only when due. Covers every non-edit inbound event (including self-echo).
    roomLabels.ensureLabel(inbound.event.timelineKey);

    if (inbound.event.role === "assistant" && inbound.event.sender.isSelf) {
      await echo.ingestOwnEcho(inbound.event);
      if (needsEnrichment(inbound.event)) {
        const resolvedEvent = (inbound.event.externalId != null ? timeline.getByExternalId(inbound.provider, inbound.event.externalId, inbound.timelineKey) : undefined) ?? inbound.event;
        await timeline.setEnrichmentStatus(resolvedEvent.id, "pending");
        enrichmentPool.notifyNewEvent(resolvedEvent.id);
      }
      return;
    }

    // Channel lifecycle gating (§2–§4): inactive timelines store cheaply until
    // the first trigger; activating timelines buffer triggers; only active/
    // backfilling timelines fall through to the normal path below. Delegated to
    // ActivationCoordinator (src/timeline/activation.ts).
    if ((await activationCoordinator.gateInbound(inbound)) === "handled") return;

    const enrichmentStatus = needsEnrichment(inbound.event) ? "pending" : "skipped";
    const routed = await router.route(inbound, enrichmentStatus);
    if (steerReplyToActiveSession(inbound)) return;

    if (enrichmentStatus === "pending") {
      enrichmentPool.notifyNewEvent(inbound.event.id);
    }

    if (!inbound.trigger) return;

    await resolveTriggerGroup(inbound);
    captionPool.notifyNewWork();

    const decision = triggerCoordinator.accept(inbound);
    if (decision.action !== "spawn") {
      logger.info("trigger_not_spawned", {
        timelineKey: inbound.timelineKey,
        action: decision.action,
        reason: decision.reason,
        queueLength: decision.queueLength,
      });
      return;
    }

    await awaitTriggerReadiness(inbound);
    await launchSession(inbound, routed.duplicate);
  }

  /**
   * Apply a Matrix edit (`m.replace`) to its target message in place (issue #17).
   * The replacement body/attachments are carried on `inbound.event`;
   * `inbound.edit.targetExternalId` identifies the message being edited. We locate
   * the target by `(provider, externalId, timelineKey)` (issue #3) and update it
   * via the store's single-writer primitive. If the target isn't stored yet (edit
   * arrived before its target — e.g. out-of-order sync or backfill), the resolved
   * replacement is parked in `pending_edits` and the append path replays it once
   * the target lands (issue #12); the edit is never inserted as a standalone
   * message and never silently dropped. Enrichment/captions are
   * re-armed only when the recomputed status warrants it and the target's timeline
   * isn't inactive — mirroring the live append and re-decryption gating.
   */
  async function applyEdit(inbound: InboundChatEvent): Promise<void> {
    const targetExternalId = inbound.edit!.targetExternalId;
    const replacement = {
      body: inbound.event.body,
      attachments: inbound.event.attachments ?? [],
    };
    const result = await timeline.applyEdit(
      inbound.provider,
      targetExternalId,
      inbound.timelineKey,
      replacement,
      inbound.event.timestamp,
      (target) => applyEditToCanonical(target, replacement),
      editStatus,
    );

    if (!result.applied) {
      // The target isn't stored yet (out-of-order sync / backfill). The edit was
      // parked in pending_edits and the append path will replay it once the
      // target lands (issue #12) — it is not dropped.
      logger.info("edit_target_missing_parked", {
        timelineKey: inbound.timelineKey,
        targetExternalId,
        editEventId: inbound.event.externalId,
      });
      return;
    }

    // Re-project the edited event into the chat-search index (§9e). The edit rewrote
    // the body in place on an already-indexed (below-watermark) row, which lazy
    // catch-up never revisits, so without this nudge the stale pre-edit body keeps
    // surfacing in search until the next restart's full sweep. This is unconditional —
    // NOT gated on enrichment status: a plain-text edit yields status 'skipped', so the
    // enrichment/caption onComplete hooks never fire for it. The content_sig set-diff in
    // upsertChatIndexRows makes this a no-op when nothing actually changed.
    chatSearchIndexer.enqueueReconcileEvent(result.event.id);

    // Re-arm work consistently with the STORED status (inactive timelines defer to
    // the activation bulk-flip; active timelines nudge enrichment when 'pending'
    // and captions only when the edited target carries attachments).
    const hasMedia = (result.event.attachments?.length ?? 0) > 0;
    if (result.status === "pending") {
      enrichmentPool.notifyNewEvent(result.event.id);
    }
    if (result.status !== "inactive" && hasMedia) {
      captionPool.notifyNewWork();
    }
    logger.info("edit_applied", {
      timelineKey: result.event.timelineKey,
      targetExternalId,
      editEventId: inbound.event.externalId,
      enrichmentStatus: result.status,
      hasMedia,
    });
  }

  async function runInitialBackfill(inbound: InboundChatEvent): Promise<void> {
    const maxMessages = config.timeline?.initial_backfill_messages ?? 200;
    const target = inbound.outboundTarget;
    if (maxMessages <= 0 || !target?.roomId) return;

    const accountId = target.accountId ?? inbound.timelineKey.split(":")[1];
    const selfUserId = config.matrix.accounts[accountId]?.user_id;
    if (!selfUserId) {
      logger.warn("initial_backfill_skipped", { timelineKey: inbound.timelineKey, reason: "unknown_self_user", accountId });
      return;
    }

    try {
      const result = await performInitialBackfill({
        client: provider.getClient(target),
        store: timeline,
        storage,
        timelineKey: inbound.timelineKey,
        roomId: target.roomId,
        accountId,
        selfUserId,
        maxMessages,
        windowMs: config.timeline?.initial_backfill_window_ms ?? 3_600_000,
        // Anchor the backfill window to the activation moment: the trigger
        // event's timestamp (falls back to now inside performInitialBackfill).
        anchorTimestamp: inbound.event.timestamp,
        timeoutMs: config.timeline?.initial_backfill_timeout_ms ?? 30_000,
        pageSize: config.timeline?.initial_backfill_page_size ?? 100,
        utdHaltThreshold: config.timeline?.initial_backfill_utd_halt_threshold ?? 50,
        logger,
      });
      logger.info("initial_backfill", { timelineKey: inbound.timelineKey, ...result });
    } catch (error) {
      // Backfill is best-effort and must not abort activation.
      logger.error("initial_backfill_failed", {
        timelineKey: inbound.timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function resolveTriggerGroup(inbound: InboundChatEvent): Promise<void> {
    const triggerEventId = inbound.event.id;
    const groupIds = new Set(inbound.trigger?.groupedEventIds ?? []);
    groupIds.add(triggerEventId);

    const lookbackMs = config.matrix.trigger_group_lookback_ms ?? 20_000;
    const lookback = timeline.query({
      timelineKey: inbound.timelineKey,
      toTimestamp: inbound.event.timestamp,
      fromTimestamp: inbound.event.timestamp - lookbackMs,
      limit: 50,
    });

    let attachmentEventIndex = -1;
    for (let i = lookback.length - 1; i >= 0; i--) {
      const event = lookback[i];
      if (event.id === triggerEventId) continue;
      if (event.sender.id !== inbound.event.sender.id) continue;
      if (event.attachments?.length) {
        attachmentEventIndex = i;
        break;
      }
    }

    if (attachmentEventIndex >= 0) {
      for (let i = attachmentEventIndex; i < lookback.length; i++) {
        const event = lookback[i];
        if (event.id === triggerEventId) continue;
        if (event.sender.id !== inbound.event.sender.id) continue;
        groupIds.add(event.id);
      }
    }

    const allIds = [...groupIds];
    inbound.trigger = { ...inbound.trigger!, groupedEventIds: allIds };
    inbound.event.trigger = inbound.trigger;
    await timeline.setTriggerGroup(triggerEventId, allIds);
  }

  async function awaitTriggerReadiness(inbound: InboundChatEvent): Promise<void> {
    const eventIds = inbound.trigger?.groupedEventIds ?? [inbound.event.id];
    const enrichmentTimeoutMs = config.enrichment?.trigger_wait_timeout_ms ?? 30_000;
    const captionTimeoutMs = config.captioning?.trigger_wait_timeout_ms ?? 45_000;

    await Promise.all(
      eventIds.map((eventId) => awaitEnrichmentComplete(eventId, enrichmentTimeoutMs)),
    );
    await awaitCaptionsComplete(eventIds, captionTimeoutMs);
  }

  function awaitEnrichmentComplete(eventId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const event = storage.getTimelineEventById(eventId);
      if (!event) { resolve(); return; }
      const row = storage.read((db) =>
        db.prepare(`select enrichment_status from timeline_events where id = ?`).get(eventId) as { enrichment_status: string } | undefined,
      );
      if (row && row.enrichment_status !== "pending" && row.enrichment_status !== "processing") {
        resolve();
        return;
      }
      const onComplete = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        enrichmentEmitter.removeListener(`complete:${eventId}`, onComplete);
        logger.warn("enrichment_timeout", { eventId, timeoutMs });
        resolve();
      }, timeoutMs);
      enrichmentEmitter.once(`complete:${eventId}`, onComplete);
    });
  }

  async function awaitCaptionsComplete(eventIds: string[], timeoutMs: number): Promise<void> {
    const remaining = storage.countPendingCaptions(eventIds);
    if (remaining === 0) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        logger.warn("caption_timeout", { eventIds, timeoutMs });
        resolve();
      }, timeoutMs);

      const check = () => {
        const left = storage.countPendingCaptions(eventIds);
        if (left === 0) {
          cleanup();
          resolve();
        }
      };

      const listeners: Array<{ event: string; fn: () => void }> = [];
      for (const eventId of eventIds) {
        const event = `complete:${eventId}`;
        const fn = () => check();
        captionEmitter.on(event, fn);
        listeners.push({ event, fn });
      }

      function cleanup() {
        clearTimeout(timer);
        for (const { event, fn } of listeners) {
          captionEmitter.removeListener(event, fn);
        }
      }
    });
  }

  function steerReplyToActiveSession(inbound: InboundChatEvent): boolean {
    const replyExternalId = inbound.event.replyTo?.externalId;
    if (!replyExternalId) return false;
    const activeIds = new Set(sessions.activeForTimeline(inbound.timelineKey).map((session) => session.id));
    if (activeIds.size === 0) return false;
    const target = timeline.getByExternalId(inbound.provider, replyExternalId, inbound.timelineKey);
    if (target?.timelineKey !== inbound.timelineKey) return false;
    if (!target?.agentSessionId || !activeIds.has(target.agentSessionId)) return false;
    const ok = sessions.steer(target.agentSessionId, {
      type: "interjection",
      content: renderRichMessage(inbound.event),
    });
    if (ok) {
      logger.info("reply_steered", {
        sessionId: target.agentSessionId,
        timelineKey: inbound.timelineKey,
        eventId: inbound.event.id,
      });
    }
    return ok;
  }

  async function launchSession(inbound: InboundChatEvent, duplicate: boolean): Promise<void> {
    const session = sessions.createPlaceholder(inbound);
    sessions.markRunning(session.id);
    logger.info("session_started", { sessionId: session.id, timelineKey: session.timelineKey });
    const target = inbound.outboundTarget;
    if (!target) {
      sessions.markDiscarded(session.id);
      logger.error("session_missing_outbound_target", {
        sessionId: session.id,
        timelineKey: session.timelineKey,
        provider: inbound.provider,
      });
      const next = triggerCoordinator.complete(session.timelineKey);
      if (next && !draining) void launchSession(next, true).catch((error) => {
        logger.error("queued_session_launch_failed", {
          timelineKey: next.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Release the per-timeline slot so future triggers aren't permanently blocked
        triggerCoordinator.complete(next.timelineKey);
      });
      return;
    }
    const roomId = target.roomId;
    const tools = [
      createSendMessageTool({
        provider,
        target,
        timeline,
        agentSessionId: session.id,
        workspaceRoot,
        mediaMaxBytes: downloadSizeLimit,
      }),
      createDelegateToSessionTool({
        currentEvent: inbound.event,
        steerSession: (sessionId, content) =>
          sessions.steer(sessionId, {
            type: "interjection",
            content,
          }),
      }),
      ...(roomId ? [
        createEmojiListTool({ client: provider.getClient(target), roomId }),
        createReactTool({ client: provider.getClient(target), roomId }),
        createEditMessageTool({ client: provider.getClient(target), roomId }),
        createDeleteMessageTool({ client: provider.getClient(target), roomId }),
        createPinsTool({ client: provider.getClient(target), roomId }),
        createListReactionsTool({ client: provider.getClient(target), roomId }),
        createReadMessagesTool({ client: provider.getClient(target), roomId }),
        createMemberInfoTool({ client: provider.getClient(target), roomId }),
        createChannelInfoTool({ client: provider.getClient(target), roomId }),
        createCreatePollTool({ client: provider.getClient(target), roomId }),
        createPollVoteTool({ client: provider.getClient(target), roomId }),
      ] : []),
      // Chat-history search + recap (§9e) — DB-backed, not tied to the live room
      // client, so available regardless of roomId and able to span all rooms.
      createSearchMessagesTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: session.timelineKey,
        absenceDefaults: chatSearchDefaults.absence,
      }),
      // Summary drill-down (§9e). DB-backed (lineage tables + shared renderer), so like
      // search/recap it's available regardless of roomId and is single-id (room implicit).
      createExpandSummaryTool({ storage, defaults: chatSearchDefaults.expand }),
      createRecapTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: session.timelineKey,
        askerId: (inbound.trigger?.triggeredBy ?? inbound.event.sender).id,
        defaults: {
          budgetTokens: chatSearchDefaults.recapBudgetTokens,
          gapThresholdMs: chatSearchDefaults.absence.gapThresholdMs,
          defaultLookbackMs: chatSearchDefaults.absence.defaultLookbackMs,
        },
      }),
      createUserActivityTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: session.timelineKey,
        // Membership source for include_silent / never-posted users (§9e). Maps a
        // timeline_key (`matrix:<account>:room:<roomId>[:thread:...]`) to the account's
        // client and asks the native layer for the room's current joined members. A
        // Matrix room id contains a colon (`!opaque:server`), so capture everything
        // between `room:` and an optional `:thread:` suffix rather than splitting on `:`.
        roomMembers: async (timelineKey) => {
          const m = /^matrix:[^:]+:room:(.+?)(?::thread:.*)?$/.exec(timelineKey);
          if (!m) return [];
          const client = provider.getClient({ provider: "matrix", timelineKey });
          const members = await client.roomMembers({ roomId: m[1] });
          return members.map((mem) => ({ userId: mem.userId, displayName: mem.displayName }));
        },
      }),
      createSetProfileTool({ client: provider.getClient(target), workspaceRoot }),
      createWebFetchTool(),
      createWebSearchTool(),
      ...(browserSession && config.browser
        ? [createBrowserTool({
            session: browserSession,
            agentSessionId: session.id,
            config: config.browser,
            // Same shared per-model base64 cap read_image uses, so inline
            // screenshots respect the model's per-image budget (issue #2).
            maxImageBytes: resolveReadImageMaxBytes(config),
            // Upload paths resolve within (and are confined to) the workspace (§6).
            workspaceRoot,
          })]
        : []),
      // Adaptive paging uses the default model's context window — non-default models (e.g. captioning) reuse the same budget.
      // Clamps in resolveMaxCharacters (50KB–512KB) bound the impact, so a mismatch only shifts the cap within those limits.
      createTextEditorTool({ workspaceRoot, contextWindowTokens: config.models.default.context_window }),
      createSearchFilesTool({ workspaceRoot, sandbox }),
      ...(sandbox ? [createBashTool({ sandbox, defaultTimeoutMs: config.sandbox?.exec_timeout_ms })] : []),
      createMediaTool({
        workspaceRoot,
        clients: captionClients,
        defaultPrompts,
        modelHasVision: config.models.default.multimodal,
        maxFetchBytes: downloadSizeLimit,
        fetchClient,
      }),
      ...(config.models.default.multimodal ? [createReadImageTool({ workspaceRoot, maxImageBytes: resolveReadImageMaxBytes(config) })] : []),
      createSearchMemoryTool({ workspaceRoot }),
      ...(retrieval
        ? [
            createRecallMemoryTool({
              search: retrieval.search,
              defaults: {
                maxResults: retrievalConfig.query.maxResults,
                minScore: retrievalConfig.query.minScore,
              },
            }),
          ]
        : []),
      createWriteMemoryTool({ workspaceRoot, memoryWriter }),
      createDanbooruTool({
        workspaceRoot,
        downloadSizeLimit,
        inlineImageMaxBytes: resolveReadImageMaxBytes(config),
        inferenceImageOptions,
        fetchClient,
        httpProxyUrl: config.network?.http_proxy_url,
        config: config.danbooru,
      }),
      createUserProfileReadTool({
        workspaceRoot,
        provider: inbound.provider,
        senderId: (inbound.trigger?.triggeredBy ?? inbound.event.sender).id,
        senderDisplayName: (inbound.trigger?.triggeredBy ?? inbound.event.sender).displayName,
        config: config.user_profiles,
      }),
      createUserProfileEditTool({
        workspaceRoot,
        provider: inbound.provider,
        senderId: (inbound.trigger?.triggeredBy ?? inbound.event.sender).id,
        senderDisplayName: (inbound.trigger?.triggeredBy ?? inbound.event.sender).displayName,
        config: config.user_profiles,
      }),
      createSillyTavernCardCreateTool({ workspaceRoot, fetchClient, downloadSizeLimit, config: config.sillytavern }),
      createSillyTavernCardReadTool({ workspaceRoot, fetchClient, downloadSizeLimit, config: config.sillytavern }),
      createSillyTavernCardEditTool({ workspaceRoot, fetchClient, downloadSizeLimit, config: config.sillytavern }),
      ...mcpTools,
    ].filter((t) => !disabledTools.has(t.name));
    let agent;
    let kickoff;
    let snapshot: ContextMessage[] | undefined;
    let tokenEstimate: number | undefined;
    try {
      ({ agent, finalTurn: kickoff, snapshot, tokenEstimate } = await factory.create(session, tools));
      // Chat builds always emit a final trigger turn; absence indicates a build bug.
      if (!kickoff) throw new Error("context build produced no final user turn");
    } catch (error) {
      sessions.markDiscarded(session.id);
      logger.error("session_factory_failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      const next = triggerCoordinator.complete(session.timelineKey);
      if (next && !draining) void launchSession(next, true).catch((error) => {
        logger.error("queued_session_launch_failed", {
          timelineKey: next.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Release the per-timeline slot so future triggers aren't permanently blocked
        triggerCoordinator.complete(next.timelineKey);
      });
      return;
    }
    sessions.attachAgent(session.id, agent);

    // Attach snapshot + transcript capture (spec §5). Detached in the run
    // promise's .finally() below (the agent_end transcript flush already happens
    // during the run; detach only unsubscribes). Only reached on the success
    // path — the kickoff-missing / factory-failed early returns above never get
    // here.
    const captureHandle = attachSessionCapture(agent, {
      storage,
      sessionId: session.id,
      snapshot,
      tokenEstimate,
      logger,
    });
    const runner = new SessionRunner({ provider, target });

    const run = runner
      .run(agent, session, config.agent.sessions.forced_completion_retries, kickoff, sessions.runLifecycle(session.id))
      .then((result) => {
        sessions.markCompleted(session.id, { noReply: result.noReply });
        logger.info("session_completed", {
          sessionId: session.id,
          noReply: result.noReply,
          duplicate,
        });
      })
      .catch(async (error) => {
        // Best-effort transcript flush before marking the session discarded
        // (issue #1): if the run rejected before any turn_end, the only durable
        // copy of the kickoff turn (+ any partial assistant message) is the live
        // state. flushNow() never throws, but wrap it so it can never mask the
        // original run error.
        try {
          await captureHandle.flushNow();
        } catch (flushErr) {
          logger.error("session capture: error-path flush failed", {
            sessionId: session.id,
            error: flushErr instanceof Error ? flushErr.message : String(flushErr),
          });
        }
        sessions.markDiscarded(session.id, {
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error("session_failed", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
        });
      })
      .finally(() => {
        captureHandle.detach();
        activeRuns.delete(run);
        // Close this session's browser tab(s) when the run settles (the idle
        // sweeper is only a backstop). Fire-and-forget; never block completion.
        if (browserSession) {
          void browserSession.closeSession(session.id).catch((error) => {
            logger.warn("browser_session_close_failed", {
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (draining) return;
        const next = triggerCoordinator.complete(session.timelineKey);
        if (next) void launchSession(next, true).catch((error) => {
          logger.error("queued_session_launch_failed", {
            timelineKey: next.timelineKey,
            error: error instanceof Error ? error.message : String(error),
          });
          // Release the per-timeline slot so future triggers aren't permanently blocked
          triggerCoordinator.complete(next.timelineKey);
        });
      });
    activeRuns.add(run);
  }

  // Channel-lifecycle gating + first-trigger activation (§2–§4). Closures above
  // are hoisted, so the heavy operations (backfill, readiness, session launch)
  // are injected by reference; `dispatch` re-enters handleInbound for replayed
  // held triggers.
  const activationCoordinator = new ActivationCoordinator({
    storage,
    router,
    triggerCoordinator,
    setEnrichmentStatus: (eventId, status) => timeline.setEnrichmentStatus(eventId, status),
    notifyEnrichment: (eventId) => enrichmentPool.notifyNewEvent(eventId),
    notifyCaptions: () => captionPool.notifyNewWork(),
    runInitialBackfill,
    resolveTriggerGroup,
    awaitTriggerReadiness,
    launchSession,
    dispatch: (inbound) => {
      void handleInbound(inbound).catch((error) => {
        logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
      });
    },
    isDraining: () => draining,
    logger,
  });

  // Re-decryption sweeper (issue #11): periodically retries stored UTD events to
  // see if room keys have since arrived, replacing placeholders with the real
  // decrypted content. Uses the native `messageSummary` primitive per account
  // (resolved from the event's timeline key). Started after the provider so its
  // clients are running; stopped before the provider during drain.
  const redecryptionSweeper = new RedecryptionSweeper({
    store: timeline,
    retry: ({ roomId, eventId }) =>
      // The accountId is the second segment of the timeline key, but the sweeper
      // only hands us roomId/eventId. A room can be shared by multiple bot accounts
      // (separate agents / workspaces); a megolm key the first-tried account lacks
      // may be known to another, so we try ALL accounts and prefer a decrypted
      // result (issue #3). `resolveMultiAccountRetry` applies the outcome
      // precedence and the throw-vs-null contract the sweeper depends on (#9).
      resolveMultiAccountRetry(Object.keys(config.matrix.accounts), (accountId) => {
        const client = provider.getClient({ provider: "matrix", timelineKey: `matrix:${accountId}`, accountId });
        return client.messageSummary({ roomId, eventId });
      }),
    notifyEnrichment: (eventId) => enrichmentPool.notifyNewEvent(eventId),
    notifyCaptions: () => captionPool.notifyNewWork(),
    notifyChatIndex: (eventId) => chatSearchIndexer.enqueueReconcileEvent(eventId),
    intervalMs: config.timeline?.redecryption_sweep_interval_ms ?? 60_000,
    batchSize: config.timeline?.redecryption_sweep_batch ?? 50,
    isDraining: () => draining,
    logger: logger.child("redecryption"),
  });

  // Inactive-event retention cleanup (spec §3, Phase 8). When
  // `inactive_event_retention_days > 0`, periodically delete events from inactive
  // timelines older than the retention window so never-activated rooms don't grow
  // unbounded. Runs once on startup and then daily; gated on the knob being > 0.
  const retentionDays = config.timeline?.inactive_event_retention_days ?? 0;
  const RETENTION_SWEEP_INTERVAL_MS = 86_400_000; // daily (spec §3)
  let retentionTimer: ReturnType<typeof setInterval> | undefined;

  function runInactiveRetention(): Promise<void> {
    return runRetentionSweep({
      retentionDays,
      // Read `draining` lazily so the re-check inside runRetentionSweep observes
      // its CURRENT value, not a snapshot from when the callback fired (#6).
      isDraining: () => draining,
      now: () => Date.now(),
      prune: (cutoff) => storage.pruneInactiveTimelineEvents(cutoff),
      logger,
    });
  }

  // Recover timelines stranded mid-activation by a prior crash before the
  // provider begins delivering inbound events.
  const resetActivations = await storage.resetStaleActivations();
  if (resetActivations > 0) {
    logger.info("stale_activations_reset", { count: resetActivations });
  }
  // Heal sessions left mid-run by a prior crash (running/created -> interrupted),
  // before the provider delivers events. No auto-resume (spec §4).
  const resetSessions = await storage.resetStaleSessions();
  if (resetSessions > 0) {
    logger.info("stale_sessions_reset", { count: resetSessions });
  }

  // Backfill/repair the chat-search index (§9e). Enqueued BEFORE provider.start() so
  // this cross-restart repair sweep is guaranteed to sit ahead of any inbound-triggered
  // query's lazy catch-up on the indexer's shared FIFO tail (#14). Fire-and-forget: the
  // projection sweep is plain SQLite and the tools' lazy catch-up covers correctness, so
  // don't block boot on it. Its only deps — the open storage and the constructed indexer —
  // exist well above this point; nothing between here and provider.start() feeds it.
  // Backfills existing events on first run after the v11 migration.
  void chatSearchIndexer.reconcileAll().catch((error) =>
    logger.warn("chat_index_sweep_failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  // Backfill the summary-content search index (§9e). Insert/delete triggers keep
  // `summaries_fts` live and the v13->v14 migration rebuilds it for pre-existing rows,
  // so this is the belt-and-suspenders convergence net for any trigger gap (mirrors the
  // chat-index sweep above). Issues the FTS5 'rebuild' command (an external-content
  // anti-join can't detect un-indexed rowids); cheap because summaries are few.
  // Fire-and-forget — summary search degrades to "miss a not-yet-indexed summary" at
  // worst, never incorrectness.
  void storage.reconcileSummariesFts().catch((error) =>
    logger.warn("summaries_fts_sweep_failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  await provider.start(config.matrix);

  // Resolve room labels for already-known (possibly idle) rooms so the console
  // shows real names without waiting for each room's next message. Throttled and
  // fire-and-forget so it never delays startup.
  void roomLabels.backfillAll().catch((error) => {
    logger.warn("room_label_backfill_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  for (const accountId of Object.keys(config.matrix.accounts)) {
    enrichmentPool.options.providerCapabilities.set(
      `matrix:${accountId}`,
      provider.getEnrichmentCapabilities(accountId),
    );
  }

  await enrichmentPool.start();
  await captionPool.start();
  if (summarizationPool) await summarizationPool.start();
  if (diaryPool) await diaryPool.start();
  if (retrieval) await retrieval.start();
  redecryptionSweeper.start();

  if (retentionDays > 0) {
    void runInactiveRetention();
    retentionTimer = setInterval(() => {
      void runInactiveRetention();
    }, RETENTION_SWEEP_INTERVAL_MS);
    // Don't keep the process alive solely for the retention sweep.
    retentionTimer.unref?.();
  }

  // Observability console (ARCHITECTURE.md §11). Read-only HTTP + SSE
  // over the live storage/factory/session state; gated by config, off by default.
  let consoleServer: ConsoleServer | undefined;
  if (config.observability?.server?.enabled) {
    consoleServer = createObservabilityServer({
      config: config.observability.server,
      storage,
      factory,
      sessions,
      // Pipeline monitor stat seam (ARCHITECTURE.md §11). `stats()` returns objects
      // whose `inFlight()` closes over the live pool, so this is captured once.
      // Summarization/diary are null when disabled by config.
      pipelines: {
        enrichment: enrichmentPool.stats(),
        captioning: captionPool.stats(),
        summarization: summarizationPool?.stats() ?? null,
        diary: diaryPool?.stats() ?? null,
      },
      activityBus: pipelineActivityBus,
      workspaceRoot,
      logger: logger.child("console"),
    });
    await consoleServer.start();
  }

  logger.info("runtime_started", { matrixEnabled: config.matrix.enabled });
  return {
    async stop() {
      stopPromise ??= (async () => {
        draining = true;
        // Stop the console first: it stops accepting requests and tears down any
        // open SSE streams before the live state it reads begins shutting down.
        if (consoleServer) await consoleServer.stop();
        if (retentionTimer) clearInterval(retentionTimer);
        await redecryptionSweeper.stop();
        await provider.stop();
        triggerCoordinator.clear();
        await captionPool.stop();
        if (retrieval) await retrieval.stop();
        if (diaryPool) await diaryPool.stop();
        if (summarizationPool) await summarizationPool.stop();
        await enrichmentPool.stop();
        // Drain the chat-search indexer: refuse new reconciles and await the
        // in-flight FIFO tail so the last projection commits before storage.close()
        // (§9e). Ordered after the pools whose onComplete hooks enqueue into it, so
        // no enqueue can arrive after the indexer has stopped accepting work.
        await chatSearchIndexer.stop();
        await mcpPool.stop();
        fetchClient.stop();
        for (const client of captionClients.values()) client.stop();
        await waitForRuns(activeRuns);
        // After in-flight runs drain, disconnect the browser (closes our CDP link
        // and any lingering tabs; does NOT stop the operator-run Manager).
        if (browserSession) await browserSession.shutdown();
        // After in-flight runs (and their bash execs) drain, release the sandbox.
        if (sandbox) await sandbox.shutdown({ stop: config.sandbox?.stop_on_shutdown ?? false });
        await storage.waitForIdle();
        storage.close();
        logger.info("runtime_stopped");
      })();
      return stopPromise;
    },
  };
}

async function waitForRuns(runs: Set<Promise<void>>): Promise<void> {
  if (runs.size === 0) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  await Promise.race([Promise.allSettled([...runs]), timeout]);
}

const MILLIS_PER_DAY = 86_400_000;

/**
 * Pure decision for the inactive-event retention sweep: should it run, and if so
 * what cutoff timestamp should be pruned below? The sweep is skipped entirely
 * when retention is disabled (`retentionDays <= 0`) or the runtime is draining;
 * otherwise events in inactive timelines older than `now − retentionDays days`
 * are eligible for pruning. Extracted as a pure function so the cutoff math and
 * the skip gate are unit-testable without standing up a runtime.
 */
/**
 * Run one inactive-event retention sweep, re-checking `draining` immediately
 * before the (awaited) prune (#6). The daily `setInterval` callback computes the
 * decision synchronously, but `stop()` may flip `draining=true` between the
 * decision and the prune; this re-check (via the lazy `isDraining()` getter)
 * ensures a sweep does NOT START once drain has begun. A sweep already in flight
 * still completes — `stop()` awaits `storage.waitForIdle()` before `close()` —
 * this just avoids kicking off a new one during drain. Injectable so the
 * decision + re-check + prune sequencing is unit-testable without a runtime.
 */
export async function runRetentionSweep(deps: {
  retentionDays: number;
  isDraining: () => boolean;
  now: () => number;
  prune: (cutoff: number) => Promise<number>;
  logger: { info: (e: string, f?: Record<string, unknown>) => void; error: (e: string, f?: Record<string, unknown>) => void };
}): Promise<void> {
  const { retentionDays, isDraining, now, prune, logger } = deps;
  const decision = decideRetentionSweep({ retentionDays, draining: isDraining(), now: now() });
  if (decision.skip) return;
  const { cutoff } = decision;
  // Re-check draining immediately before starting the prune (#6).
  if (isDraining()) return;
  try {
    const pruned = await prune(cutoff);
    if (pruned > 0) {
      logger.info("inactive_retention_pruned", { pruned, retentionDays, cutoff });
    }
  } catch (error) {
    logger.error("inactive_retention_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function decideRetentionSweep(params: {
  retentionDays: number;
  draining: boolean;
  now: number;
}): { skip: true } | { skip: false; cutoff: number } {
  const { retentionDays, draining, now } = params;
  if (draining || retentionDays <= 0) return { skip: true };
  return { skip: false, cutoff: now - retentionDays * MILLIS_PER_DAY };
}

/**
 * Resolve the effective max image byte limit for the `read_image` tool from
 * the per-model `image_input_bytes` setting. The cap is measured against the
 * base64-encoded payload (what actually ships to the provider), not the raw
 * file size — raw bytes inflate ~4/3 in base64 (formula `4 * ceil(rawBytes /
 * 3)`), and providers (Anthropic, OpenAI, etc.) enforce their per-image
 * budget against the encoded payload. Default 5 MB base64 ≈ 3.75 MB raw,
 * safely under Anthropic's per-image cap. Bounded by `media.download_size_limit`
 * as a sanity ceiling. `media.image.max_bytes` is intentionally NOT consulted
 * here — that setting is the captioning pipeline's re-encode target (~1 MB),
 * not an upper bound on images delivered to the model.
 */
function resolveReadImageMaxBytes(config: AppConfig): number {
  const DEFAULT_PER_MODEL = 5_242_880; // 5 MB base64 (≈ 3.75 MB raw before encoding).
  const perModel = config.models.default.image_input_bytes ?? DEFAULT_PER_MODEL;
  const candidates = [
    perModel,
    config.media?.download_size_limit,
  ].filter((v): v is number => typeof v === "number");
  return Math.min(...candidates);
}
