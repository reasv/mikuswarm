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
import { ContextBuilder } from "./context/index.js";

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
  const background = new BackgroundProcessor(timeline);
  const echo = new AssistantEchoResolver(timeline);
  const contextBuilder = new ContextBuilder(timeline, config);
  const provider = new MatrixProvider();
  const factory = new AgentSessionFactory({
    config,
    contextBuilder,
    getActiveSessions: (timelineKey) => sessions.activeForTimeline(timelineKey),
  });

  provider.subscribe((inbound) => {
    void (async () => {
      if (inbound.event.role === "assistant" && inbound.event.sender.isSelf) {
        await echo.ingestOwnEcho(inbound.event);
        return;
      }
      const routed = await router.route(inbound);
      background.processNonTriggerEvent(inbound.event);
      if (!inbound.trigger) return;
      const prepared = await background.prepareTriggerEvent(inbound.event);
      inbound.event = prepared;
      const decision = triggerCoordinator.accept(inbound);
      if (decision.action !== "spawn") {
        logger.info("trigger_queued", { timelineKey: inbound.timelineKey, action: decision.action });
        return;
      }
      const session = sessions.createPlaceholder(inbound);
      sessions.markRunning(session.id);
      logger.info("session_started", { sessionId: session.id, timelineKey: session.timelineKey });
      const target = outboundTargetFromTimeline(inbound.timelineKey);
      const runner = new SessionRunner(timeline, { provider, target });
      const result = await runner.run(factory.create(session), session, config.agent.sessions.forced_completion_retries);
      sessions.markCompleted(session.id);
      triggerCoordinator.complete(session.timelineKey);
      logger.info("session_completed", {
        sessionId: session.id,
        noReply: result.noReply,
        duplicate: routed.duplicate,
      });
    })().catch((error) => {
      logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
    });
  });

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

