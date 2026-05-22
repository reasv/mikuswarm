import { mkdir } from "node:fs/promises";
import type { AppConfig } from "./config/index.js";
import { createLogger } from "./observability/index.js";
import { MatrixProvider } from "./matrix/index.js";
import { Storage } from "./storage/index.js";
import {
  AssistantEchoResolver,
  BackgroundProcessor,
  TimelineRouter,
  TimelineStore,
  TriggerCoordinator,
} from "./timeline/index.js";
import { AgentSessionFactory, SessionManager, SessionRunner } from "./agent/index.js";
import { ContextBuilder, renderRichMessage } from "./context/index.js";
import {
  createDanbooruTool,
  createDelegateToSessionTool,
  createDescribeMediaTool,
  createSearchMemoryTool,
  createSearchFilesTool,
  createSendMessageTool,
  createTextEditorTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteMemoryTool,
} from "./tools/index.js";
import type { CaptionResult, CanonicalChatEvent, InboundChatEvent } from "./types.js";

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
  const background = new BackgroundProcessor(timeline, {
    captioner: createBasicCaptioner(),
    onError: (error, context) =>
      logger.warn("background_processing_error", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  const echo = new AssistantEchoResolver(timeline);
  const contextBuilder = new ContextBuilder(timeline, config);
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
  });
  const activeRuns = new Set<Promise<void>>();
  let draining = false;
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
      return;
    }
    const routed = await router.route(inbound);
    if (steerReplyToActiveSession(inbound)) return;
    if (!inbound.trigger) {
      background.processNonTriggerEvent(inbound.event);
      return;
    }
    await prepareTriggerMedia(inbound);
    const decision = triggerCoordinator.accept(inbound);
    if (decision.action !== "spawn") {
      logger.info("trigger_queued", { timelineKey: inbound.timelineKey, action: decision.action });
      return;
    }
    launchSession(inbound, routed.duplicate);
  }

  async function prepareTriggerMedia(inbound: InboundChatEvent): Promise<void> {
    const prepared = await background.prepareTriggerEvent(inbound.event);
    inbound.event = prepared;
    inbound.trigger = prepared.trigger ?? inbound.trigger;

    for (const eventId of inbound.trigger?.groupedEventIds ?? []) {
      if (eventId === inbound.event.id) continue;
      const grouped = timeline.getById(eventId);
      if (grouped) await background.prepareTriggerEvent(grouped);
    }
  }

  function steerReplyToActiveSession(inbound: InboundChatEvent): boolean {
    const replyExternalId = inbound.event.replyTo?.externalId;
    if (!replyExternalId) return false;
    const activeIds = new Set(sessions.activeForTimeline(inbound.timelineKey).map((session) => session.id));
    if (activeIds.size === 0) return false;
    const target = timeline
      .query({ timelineKey: inbound.timelineKey, limit: 200 })
      .reverse()
      .find(
        (event) =>
          event.externalId === replyExternalId &&
          event.agentSessionId &&
          activeIds.has(event.agentSessionId),
      );
    if (!target?.agentSessionId) return false;
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

  function launchSession(inbound: InboundChatEvent, duplicate: boolean): void {
    const session = sessions.createPlaceholder(inbound);
    sessions.markRunning(session.id);
    logger.info("session_started", { sessionId: session.id, timelineKey: session.timelineKey });
    const target = inbound.outboundTarget ?? outboundTargetFromTimeline(inbound.timelineKey);
    const sentMessages: string[] = [];
    const tools = [
      createSendMessageTool({
        provider,
        target,
        timeline,
        agentSessionId: session.id,
        recordSentMessage: (message) => sentMessages.push(message),
      }),
      createDelegateToSessionTool({
        currentEvent: inbound.event,
        steerSession: (sessionId, content) =>
          sessions.steer(sessionId, {
            type: "interjection",
            content,
          }),
      }),
      createWebFetchTool(),
      createWebSearchTool(),
      createTextEditorTool({ workspaceRoot }),
      createSearchFilesTool({ workspaceRoot }),
      createDescribeMediaTool({ workspaceRoot }),
      createSearchMemoryTool({ workspaceRoot }),
      createWriteMemoryTool({ workspaceRoot }),
      createDanbooruTool({ workspaceRoot }),
    ];
    const agent = factory.create(session, tools);
    sessions.attachAgent(session.id, agent);
    const runner = new SessionRunner(timeline, { provider, target, sentMessages });

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
        });
      })
      .finally(() => {
        activeRuns.delete(run);
        if (draining) return;
        const next = triggerCoordinator.complete(session.timelineKey);
        if (next) launchSession(next, true);
      });
    activeRuns.add(run);
  }

  await provider.start(config.matrix);
  logger.info("runtime_started", { matrixEnabled: config.matrix.enabled });
  return {
    async stop() {
      draining = true;
      await provider.stop();
      triggerCoordinator.clear();
      await waitForRuns(activeRuns, 5_000);
      await storage.waitForIdle();
      storage.close();
      logger.info("runtime_stopped");
    },
  };
}

async function waitForRuns(runs: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  if (runs.size === 0) return;
  await Promise.race([
    Promise.allSettled([...runs]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function createBasicCaptioner() {
  return async (event: CanonicalChatEvent): Promise<CaptionResult[]> => {
    const sharp = (await import("sharp")).default;
    const results: CaptionResult[] = [];
    for (const attachment of event.attachments ?? []) {
      if (!attachment.localPath || attachment.mediaType !== "image") continue;
      try {
        const metadata = await sharp(attachment.localPath).metadata();
        results.push({
          attachmentId: attachment.id,
          text: `Image file ${attachment.filename ?? attachment.id}; format ${metadata.format ?? "unknown"}, ${metadata.width ?? "?"}x${metadata.height ?? "?"}.`,
          model: "sharp-metadata",
          generatedAt: Date.now(),
          status: "complete",
        });
      } catch (error) {
        results.push({
          attachmentId: attachment.id,
          text: "",
          model: "sharp-metadata",
          generatedAt: Date.now(),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  };
}

export function outboundTargetFromTimeline(timelineKey: string) {
  const parts = timelineKey.split(":");
  const accountId = parts[1];
  const roomIndex = parts.indexOf("room");
  const dmIndex = parts.indexOf("dm");
  const threadIndex = parts.indexOf("thread");
  const roomEnd = threadIndex >= 0 ? threadIndex : parts.length;
  const roomId = roomIndex >= 0 ? parts.slice(roomIndex + 1, roomEnd).join(":") : undefined;
  const userId = dmIndex >= 0 ? parts.slice(dmIndex + 1).join(":") : undefined;
  const threadId = threadIndex >= 0 ? parts.slice(threadIndex + 1).join(":") : undefined;
  return {
    provider: "matrix",
    timelineKey,
    accountId,
    roomId: roomId || userId,
    threadId,
  };
}
