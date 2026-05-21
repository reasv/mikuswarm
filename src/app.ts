import sharp from "sharp";
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
  createReadFileTool,
  createSearchMemoryTool,
  createSendMessageTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
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
  const workspaceRoot = process.cwd();
  const background = new BackgroundProcessor(timeline, { captioner: createBasicCaptioner() });
  const echo = new AssistantEchoResolver(timeline);
  const contextBuilder = new ContextBuilder(timeline, config);
  const provider = new MatrixProvider();
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
    if (inbound.event.role === "assistant" && inbound.event.sender.isSelf) {
      await echo.ingestOwnEcho(inbound.event);
      return;
    }
    const routed = await router.route(inbound);
    if (steerReplyToActiveSession(inbound)) return;
    background.processNonTriggerEvent(inbound.event);
    if (!inbound.trigger) return;
    const prepared = await background.prepareTriggerEvent(inbound.event);
    inbound.event = prepared;
    const decision = triggerCoordinator.accept(inbound);
    if (decision.action !== "spawn") {
      logger.info("trigger_queued", { timelineKey: inbound.timelineKey, action: decision.action });
      return;
    }
    launchSession(inbound, routed.duplicate);
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
    const target = outboundTargetFromTimeline(inbound.timelineKey);
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
      createReadFileTool({ workspaceRoot }),
      createWriteFileTool({ workspaceRoot }),
      createDescribeMediaTool({ workspaceRoot }),
      createSearchMemoryTool({ workspaceRoot, timeline, timelineKey: inbound.timelineKey }),
      createWriteMemoryTool({ workspaceRoot, timeline, timelineKey: inbound.timelineKey }),
      createDanbooruTool({ workspaceRoot }),
    ];
    const agent = factory.create(session, tools);
    sessions.attachAgent(session.id, agent);
    const runner = new SessionRunner(timeline, { provider, target, sentMessages });

    void runner
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
        const next = triggerCoordinator.complete(session.timelineKey);
        if (next) launchSession(next, true);
      });
  }

  await provider.start(config.matrix);
  logger.info("runtime_started", { matrixEnabled: config.matrix.enabled });
  return {
    async stop() {
      await provider.stop();
      storage.close();
      logger.info("runtime_stopped");
    },
  };
}

function createBasicCaptioner() {
  return async (event: CanonicalChatEvent): Promise<CaptionResult[]> => {
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

function outboundTargetFromTimeline(timelineKey: string) {
  const parts = timelineKey.split(":");
  const accountId = parts[1];
  const roomIndex = parts.indexOf("room");
  const dmIndex = parts.indexOf("dm");
  const roomId = roomIndex >= 0 ? parts.slice(roomIndex + 1).join(":") : undefined;
  const userId = dmIndex >= 0 ? parts.slice(dmIndex + 1).join(":") : undefined;
  return {
    provider: "matrix",
    timelineKey,
    accountId,
    roomId: roomId || userId,
  };
}
