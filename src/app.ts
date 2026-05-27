import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config/index.js";
import { createLogger } from "./observability/index.js";
import { MatrixProvider } from "./matrix/index.js";
import { Storage } from "./storage/index.js";
import {
  AssistantEchoResolver,
  needsEnrichment,
  TimelineRouter,
  TimelineStore,
  TriggerCoordinator,
} from "./timeline/index.js";
import { AgentSessionFactory, SessionManager, SessionRunner } from "./agent/index.js";
import { ContextBuilder, renderRichMessage } from "./context/index.js";
import {
  createChannelInfoTool,
  createCreatePollTool,
  createDanbooruTool,
  createDeleteMessageTool,
  createDelegateToSessionTool,
  createEditMessageTool,
  createEmojiListTool,
  createListReactionsTool,
  createMediaTool,
  createMemberInfoTool,
  createPinsTool,
  createPollVoteTool,
  createReactTool,
  createSearchMemoryTool,
  createSearchFilesTool,
  createSendMessageTool,
  createSetProfileTool,
  createTextEditorTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteMemoryTool,
} from "./tools/index.js";
import type { CanonicalChatEvent, InboundChatEvent } from "./types.js";
import { EnrichmentWorkerPool, ConcurrencyLimitedFetchClient } from "./enrichment/index.js";
import { CaptionWorkerPool, ConcurrencyLimitedInferenceClient, type MediaModality } from "./captioning/index.js";

export interface MikuAgentRuntime {
  stop(): Promise<void>;
}

export async function startMikuAgent(config: AppConfig): Promise<MikuAgentRuntime> {
  const logger = createLogger("mikuswarm", config.app.log_level);
  const storage = await Storage.open({ databasePath: config.storage.database_path });
  const timeline = new TimelineStore(storage);
  const router = new TimelineRouter(timeline);
  const triggerCoordinator = new TriggerCoordinator(config.agent.sessions);
  const sessions = new SessionManager();
  const workspaceRoot = config.workspace.root_dir;
  await mkdir(workspaceRoot, { recursive: true });

  const echo = new AssistantEchoResolver(timeline);
  const contextBuilder = new ContextBuilder(timeline, config, storage);

  const downloadSizeLimit = config.media?.download_size_limit ?? 1_073_741_824;
  const mediaCachePath = path.join(config.app.data_dir, "media-cache");

  const fetchClient = new ConcurrencyLimitedFetchClient({
    maxConcurrency: config.enrichment?.fetch_concurrency ?? 6,
    timeoutMs: config.enrichment?.fetch_timeout_ms ?? 10_000,
    maxResponseBytes: downloadSizeLimit,
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

  const captionClients = new Map<MediaModality, ConcurrencyLimitedInferenceClient>([
    ["image", new ConcurrencyLimitedInferenceClient({
      modality: "image",
      model: resolveModalityModel(imageConfig),
      prompt: imageConfig.prompt ?? "Describe the image.",
      maxChars: imageConfig.max_chars ?? 500,
      maxTokens: imageConfig.max_tokens ?? 2048,
      maxConcurrency: imageConfig.concurrency,
      imageProcessing: {
        maxTotalPixels: mediaImageConfig.max_total_pixels ?? 921_600,
        maxTotalPixelsHard: mediaImageConfig.max_total_pixels_hard ?? 1_843_200,
        minShortestSide: mediaImageConfig.min_shortest_side ?? 480,
        maxBytes: mediaImageConfig.max_bytes ?? 1_048_576,
        mozjpeg: mediaImageConfig.mozjpeg ?? true,
      },
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

  const enrichmentPool = new EnrichmentWorkerPool({
    storage,
    timeline,
    providerCapabilities: new Map(),
    fetchClient,
    workspaceRoot,
    downloadSizeLimit,
    config: config.enrichment ?? {},
    onComplete: (eventId) => enrichmentEmitter.emit(`complete:${eventId}`),
    onError: (eventId, error) =>
      logger.error("enrichment_failed", { eventId, error: error instanceof Error ? error.message : String(error) }),
    logger,
  });

  const captionPool = new CaptionWorkerPool({
    storage,
    clients: captionClients,
    workspaceRoot,
    config: config.captioning ?? {},
    onComplete: (eventId) => captionEmitter.emit(`complete:${eventId}`),
    onError: (assetId, error) =>
      logger.error("caption_failed", { assetId, error: error instanceof Error ? error.message : String(error) }),
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
  });

  provider.subscribe((inbound) => {
    void handleInbound(inbound).catch((error) => {
      logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handleInbound(inbound: InboundChatEvent): Promise<void> {
    if (draining) return;
    if (inbound.event.role === "assistant" && inbound.event.sender.isSelf) {
      await echo.ingestOwnEcho(inbound.event);
      if (needsEnrichment(inbound.event)) {
        const resolvedEvent = (inbound.event.externalId != null ? timeline.getByExternalId(inbound.provider, inbound.event.externalId) : undefined) ?? inbound.event;
        await timeline.setEnrichmentStatus(resolvedEvent.id, "pending");
        enrichmentPool.notifyNewEvent(resolvedEvent.id);
      }
      return;
    }

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
    const target = timeline.getByExternalId(inbound.provider, replyExternalId);
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
        createMemberInfoTool({ client: provider.getClient(target), roomId }),
        createChannelInfoTool({ client: provider.getClient(target), roomId }),
        createCreatePollTool({ client: provider.getClient(target), roomId }),
        createPollVoteTool({ client: provider.getClient(target), roomId }),
      ] : []),
      createSetProfileTool({ client: provider.getClient(target), workspaceRoot }),
      createWebFetchTool(),
      createWebSearchTool(),
      createTextEditorTool({ workspaceRoot }),
      createSearchFilesTool({ workspaceRoot }),
      createMediaTool({
        workspaceRoot,
        clients: captionClients,
        defaultPrompts,
        modelHasVision: config.models.default.multimodal,
        maxFetchBytes: downloadSizeLimit,
        fetchClient,
      }),
      createSearchMemoryTool({ workspaceRoot }),
      createWriteMemoryTool({ workspaceRoot }),
      createDanbooruTool({ workspaceRoot, downloadSizeLimit, fetchClient }),
    ];
    let agent;
    try {
      agent = await factory.create(session, tools);
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
    const runner = new SessionRunner({ provider, target });

    const run = runner
      .run(agent, session, config.agent.sessions.forced_completion_retries)
      .then((result) => {
        sessions.markCompleted(session.id);
        logger.info("session_completed", {
          sessionId: session.id,
          noReply: result.noReply,
          duplicate,
        });
      })
      .catch((error) => {
        sessions.markDiscarded(session.id);
        logger.error("session_failed", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
        });
      })
      .finally(() => {
        activeRuns.delete(run);
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

  await provider.start(config.matrix);

  for (const accountId of Object.keys(config.matrix.accounts)) {
    enrichmentPool.options.providerCapabilities.set(
      `matrix:${accountId}`,
      provider.getEnrichmentCapabilities(accountId),
    );
  }

  await enrichmentPool.start();
  await captionPool.start();

  logger.info("runtime_started", { matrixEnabled: config.matrix.enabled });
  return {
    async stop() {
      stopPromise ??= (async () => {
        draining = true;
        await provider.stop();
        triggerCoordinator.clear();
        await captionPool.stop();
        await enrichmentPool.stop();
        fetchClient.stop();
        for (const client of captionClients.values()) client.stop();
        await waitForRuns(activeRuns);
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
