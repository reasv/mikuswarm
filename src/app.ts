import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config/index.js";
import { seedWorkspace, seedFeatureSkills } from "./bootstrap/seed.js";
import { createLogger, createObservabilityServer, PipelineActivityBus, SessionLiveEventBus, type ConsoleServer, type Logger } from "./observability/index.js";
import { MatrixProvider, RoomLabelCache, makeBackfillReadClient } from "./matrix/index.js";
import { DiscordProvider } from "./discord/index.js";
import { IrcProvider, type IrcProviderCallbacks } from "./irc/index.js";
import { ingestGenericReactionEvent } from "./timeline/index.js";
import type { MatrixNativeClient, MatrixNativeEvent } from "./matrix/index.js";
import { Storage, MemoryFileWriter, type AgentSessionRow } from "./storage/index.js";
import {
  ActivationCoordinator,
  applyEditToCanonical,
  AssistantEchoResolver,
  channelTypeOf,
  editStatus,
  needsEnrichment,
  roomIdFromTimelineKey,
  sendViaProvider,
  TimelineRouter,
  TimelineStore,
  TriggerCoordinator,
} from "./timeline/index.js";
import {
  AgentSessionFactory,
  LlmScheduler,
  resolveModelChain,
  LlmRequestRing,
  DEFAULT_LLM_REQUEST_RING_SIZE,
  SessionManager,
  SessionClaims,
  coTargetOwnerSteerableSoon,
  FollowUpWatch,
  classifyFollowUpForm,
  followUpGateDecision,
  followUpConfigActive,
  maxWallClockMs,
  resolveFollowUpRoute,
  hasImageAttachment,
  type FollowUpForm,
  type FollowUpConfig,
  type FollowUpLeverConfig,
  SessionRunner,
  isLlmRunFailure,
  createManualResumeSession,
  isResumableRunError,
  loadResumeMaterial,
  loadCompletedSessionMaterial,
  SYNTHETIC_SESSION_TYPES,
  filterTools,
  filterMcpToolsByAllowlist,
  additiveThinkingBudgetTokens,
  hasResumableWork,
  type ResumeMaterial,
  type ResumeWorkScope,
  type AgentSessionRecord,
  type ManualResumeResult,
} from "./agent/index.js";
import { attachSessionCapture, type SessionCaptureHandle } from "./agent/session-capture.js";
import { buildAgentModelOverrides } from "./agent/agent-model-overrides.js";
import { emptyUsageTotals } from "./agent/usage.js";
import { SessionUsageTracker, type CostRates, type SessionUsageTotals } from "./agent/usage.js";
import { makeCostWarnDecider, selectToolCostSeed } from "./agent/cost-budget.js";
import { ContextBuilder, renderRichMessage, type ImageBlock } from "./context/index.js";
import { initTokenizers } from "./context/tokenizer/index.js";
import { escapeAttr, escapeXml } from "./context/xml.js";
import { hydrateEvents } from "./context/hydrate.js";
import type { ContextMessage } from "./context/builder.js";
import {
  BUILTIN_RESUME_EXEMPT_TOOL_NAMES,
  createBrowserTool,
  createChannelInfoTool,
  createCreatePollTool,
  createDanbooruTool,
  createDeleteMessageTool,
  createDelegateToSessionTool,
  createSpawnSessionTool,
  type SpawnCoReplyResult,
  createEditMessageTool,
  createEmojiListTool,
  createImageGenTool,
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
  createCharacterCardCreateTool,
  createCharacterCardEditTool,
  createCharacterCardReadTool,
  createTextEditorTool,
  createUserProfileEditTool,
  createUserProfileReadTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteMemoryTool,
  createXFetchTool,
  createXSearchTool,
  createYoutubeFetchTool,
  GrokResultCache,
  createFindSourceTool,
  MATRIX_TERMINOLOGY,
  DISCORD_TERMINOLOGY,
  IRC_TERMINOLOGY,
  type ToolUsageRecord,
} from "./tools/index.js";
import { SauceNaoRateLimiter } from "./saucenao/rate-limiter.js";
import { setEgressGuardEnabled } from "./tools/ssrf.js";
import { configureHttpLimiter } from "./tools/http-limiter.js";
import type { CanonicalChatEvent, ChatProviderHost, IChatProvider, InboundChatEvent, TriggerInfo } from "./types.js";
import { EnrichmentWorkerPool, FetchClient } from "./enrichment/index.js";
import { AttachmentStore } from "./enrichment/attachment-store.js";
import { FxTwitterClient, resolveFxTwitterConfig } from "./fxtwitter/index.js";
import { resolveYouTubeConfig } from "./youtube/config.js";
import { CaptionWorkerPool, InferenceClient, type MediaModality } from "./captioning/index.js";
import { buildInferenceImageOptions } from "./media/index.js";
import { McpClientPool, adaptMcpTools } from "./mcp/index.js";
import { SummarizationIndexer, SummarizationWorkerPool, createEscalateSummary, MirrorWorker, buildMirrorTopology } from "./summarization/index.js";
import { DiaryWorkerPool } from "./diary/index.js";
import { ChannelVisibilityResolver, validateVisibilityChannels, type VisibilityConfig } from "./visibility/index.js";
import { ProactiveScheduler } from "./proactive/index.js";
import { parseTimelineKey, buildTimelineKey, timelineKindOf } from "./storage/timeline-key.js";
import { BudgetEngine, collectZeroCostModelIds, collectKnownModelIds, normalizeLimits, makeAgentLoopChainClaimGate, UserLimitEngine, normalizeUserLimits, type BudgetHooks, type SpendDescriptor, type AdmissionResult, type UserLimitContext, type UserLimitResolution, type ResolvedConstraint } from "./budget/index.js";
import type { UsageEventInput } from "./storage/database.js";
import { createRetrievalSubsystem, resolveRetrievalConfig, type RetrievalSubsystem } from "./retrieval/index.js";
import {
  ChatSearchIndexer,
  ABSENCE_GAP_DEFAULT_MS,
  ABSENCE_LOOKBACK_DEFAULT_MS,
} from "./search/index.js";
import { performInitialBackfill } from "./backfill/index.js";
import { GapBackfetchCoordinator, type GapBackfetchConfig } from "./backfill/coordinator.js";
import { MessageBackfetchCoordinator, type MessageBackfetchConfig } from "./backfill/message-backfetch.js";
import { RedecryptionSweeper, resolveMultiAccountRetry } from "./redecryption/index.js";
import { SandboxManager, type ExecBackend, createSharedExecBackend, computeCommonAncestor } from "./sandbox/index.js";
import { BrowserSession } from "./browser/index.js";
import { getConfiguredTimezone } from "./time/index.js";

export interface MikuAgentRuntime {
  stop(): Promise<void>;
}

/**
 * Options for {@link startMikuAgent}. All fields are optional.
 *
 * `providers` is a test seam: supply a pre-built `Map<providerId, IChatProvider>`
 * to bypass config-derived provider construction. The registry must still be
 * non-empty (zero providers is the fatal startup error even in tests). Use this
 * to inject a fake/stub provider when the test wants `[matrix] enabled = false`
 * without hitting the zero-provider guard (e.g. diary-failfast, browser-failfast,
 * and the new no-Matrix and dual-provider boot tests).
 */
export interface StartMikuAgentOptions {
  providers?: Map<string, IChatProvider>;
}

export async function startMikuAgent(config: AppConfig, opts?: StartMikuAgentOptions): Promise<MikuAgentRuntime> {
  const logger = createLogger("mikuswarm", config.app.log_level);

  // App-layer SSRF guard (defense-in-depth) for every caller-supplied outbound
  // fetch. Default ON for bare-metal `tsx` runs where nothing else blocks private
  // egress; set network.ssrf_guard=false where the container/network firewall
  // (docker/egress-rules.sh) is the boundary, to drop the per-request DNS +
  // redirect-revalidation overhead. See ARCHITECTURE.md "Network egress & SSRF".
  const egressGuardEnabled = config.network?.ssrf_guard ?? true;
  setEgressGuardEnabled(egressGuardEnabled);
  logger.info("egress_guard_configured", { enabled: egressGuardEnabled });

  // Per-host HTTP egress limiter (spec Design D), enforced at the guardedFetch
  // chokepoint: generous per-host admission + a high global backstop + unconditional
  // 429/503 backoff. Replaces the old cross-domain fetch-concurrency cap.
  const httpLimits = config.rate_limits?.http;
  configureHttpLimiter({
    defaultMaxInFlightPerHost: httpLimits?.default_max_in_flight_per_host,
    globalCeiling: httpLimits?.global_ceiling_max_in_flight,
    backoffBaseMs: httpLimits?.backoff_base_ms,
    backoffMaxMs: httpLimits?.backoff_max_ms,
    perHostMaxInFlight: httpLimits?.per_host_max_in_flight,
  });

  // LLM request scheduler (spec CONCURRENCY-AND-RATE-LIMITING §5 / Design A): one
  // process-wide admission gate, one priority queue per rate-limit group. Every
  // LLM request — agent sessions, captioning, the image-gen tool, remote
  // embedding — acquires a slot in its group before the HTTP call. Fail-fast
  // cross-field validation (§9.7, app wiring per project convention): a
  // `rate_limit_group` naming a group not declared in `[rate_limits.llm.*]` is a
  // typo; an UNSET group is fine (it means `default`), and `default` itself needs
  // no declaration (declaring it merely tunes it).
  const llmGroups = config.rate_limits?.llm ?? {};
  {
    const groupRefs: Array<{ group: string | undefined; source: string }> = [
      ...Object.entries(config.models).map(([key, model]) => ({
        group: model.rate_limit_group,
        source: `models.${key}`,
      })),
      // captioning + remote embedding reference `[models.*]` by name now (spec
      // MODEL-FALLBACK §2.3), so their rate_limit_group is validated via the models
      // loop above.
    ];
    for (const { group, source } of groupRefs) {
      if (group && group !== "default" && !llmGroups[group]) {
        throw new Error(
          `${source}.rate_limit_group = "${group}" does not name a group declared in [rate_limits.llm.*]; ` +
            `declare [rate_limits.llm.${group}] or remove the reference`,
        );
      }
    }
  }
  // Same fail-fast convention for the extended-thinking knob: a non-off
  // `thinking_level` on a model declared NOT thinking-capable (`reasoning =
  // false`) is a contradiction — the provider would reject or silently ignore
  // the thinking request — so it's a config typo, not a runtime concern.
  for (const [key, model] of Object.entries(config.models)) {
    if (model.thinking_level && model.thinking_level !== "off" && model.reasoning === false) {
      throw new Error(
        `models.${key}: thinking_level = "${model.thinking_level}" contradicts reasoning = false; ` +
          `set reasoning = true (thinking-capable) or thinking_level = "off"`,
      );
    }
  }
  // Context-token ceiling cross-field validation (spec TOKEN-USAGE-TRACKING
  // §6.1). Extracted to a pure function so it can be unit-tested directly
  // without booting the whole agent; the throw/message behavior is identical.
  validateContextTokenCeilings(config);
  // Model fallback-chain fail-fast (spec MODEL-FALLBACK §2.1/§6.1). The agent
  // path resolves a session type's chain LAZILY (per-session, in `factory.create`),
  // so without this a dangling `fallback` reference on `[models.default]` or an
  // `agent.session_types.*` model would only surface on the first live trigger —
  // not at boot. Sweep the whole registry so EVERY `[models.*]` chain (incl.
  // unreferenced ones) is validated here too. Pure `resolveModelChain` calls.
  validateModelFallbackChains(config);
  // [fxtwitter.tool] cross-field sanity (same fail-fast convention): the
  // per-window default must fit under the per-window hard cap, which must fit
  // under the assembled-document cap — anything else is a config typo that
  // would silently clamp at runtime.
  const fxTwitterConfig = resolveFxTwitterConfig(config.fxtwitter);
  if (fxTwitterConfig.tool.defaultMaxChars > fxTwitterConfig.tool.maxCharsLimit) {
    throw new Error(
      `fxtwitter.tool: default_max_chars (${fxTwitterConfig.tool.defaultMaxChars}) must be <= max_chars_limit (${fxTwitterConfig.tool.maxCharsLimit})`,
    );
  }
  if (fxTwitterConfig.tool.maxCharsLimit > fxTwitterConfig.tool.maxTotalChars) {
    throw new Error(
      `fxtwitter.tool: max_chars_limit (${fxTwitterConfig.tool.maxCharsLimit}) must be <= max_total_chars (${fxTwitterConfig.tool.maxTotalChars})`,
    );
  }
  // [youtube.tool] cross-field sanity — same fail-fast convention as [fxtwitter.tool].
  const ytCfg = resolveYouTubeConfig(config.youtube);
  if (ytCfg.tool.defaultMaxChars > ytCfg.tool.maxCharsLimit) {
    throw new Error(
      `youtube.tool: default_max_chars (${ytCfg.tool.defaultMaxChars}) must be <= max_chars_limit (${ytCfg.tool.maxCharsLimit})`,
    );
  }
  if (ytCfg.tool.maxCharsLimit > ytCfg.tool.maxTotalChars) {
    throw new Error(
      `youtube.tool: max_chars_limit (${ytCfg.tool.maxCharsLimit}) must be <= max_total_chars (${ytCfg.tool.maxTotalChars})`,
    );
  }
  // [youtube.enrichment].enabled requires [youtube].enabled.
  if (ytCfg.enrichment.enabled && !ytCfg.enabled) {
    throw new Error(
      "youtube.enrichment.enabled = true requires youtube.enabled = true",
    );
  }
  // [saucenao] graceful key-gated degrade (spec SAUCENAO-SOURCE-LOOKUP §3.2/§5;
  // app-wiring per the proactive-posting precedent). `enabled = true` is the shipped
  // default so a fresh public deploy advertises the capability, but SauceNAO needs a
  // per-account API key. The schema keeps `api_key` optional so a key-less deploy
  // needn't carry a `${SAUCENAO_API_KEY}` template that would fail startup when the
  // env var is unset. When enabled WITHOUT a key, we do NOT crash: we log one warning
  // and treat `find_source` as disabled (the tool is simply not registered below).
  // The operative gate is `sauceNaoEnabled` (enabled AND a non-empty key); with a key
  // present behaviour is identical to before.
  const sauceNaoConfig =
    config.saucenao?.enabled === true && (config.saucenao.api_key ?? "").trim().length > 0
      ? config.saucenao
      : undefined;
  const sauceNaoEnabled = sauceNaoConfig !== undefined;
  if (config.saucenao?.enabled === true && !sauceNaoEnabled) {
    logger.warn("saucenao_disabled_no_api_key", {
      message:
        "saucenao.enabled is true but no api_key is set — find_source is disabled. Set a SauceNAO API key (e.g. api_key = \"${SAUCENAO_API_KEY}\") to enable reverse-image source lookup.",
    });
  }
  // [tokenizer] cross-field validation + init (spec TOKENIZER-SWAP §5.4). Selecting
  // `glm` for either consumer requires a readable `glm_tokenizer_path` — TypeBox
  // can't express the dependency, so it's checked here (same fail-fast convention
  // as saucenao above). Tokenizers are bound NOW, before any subsystem reads the
  // registry (the retrieval subsystem below selects the retrieval tokenizer) and
  // long before the first context build.
  validateTokenizerConfig(config);
  await initTokenizers({
    primary: config.tokenizer?.primary,
    retrieval: config.tokenizer?.retrieval,
    glmTokenizerPath: config.tokenizer?.glm_tokenizer_path,
  });
  const llmScheduler = new LlmScheduler({
    groups: llmGroups,
    // Per-model health (spec LLM-FAILURE-HANDLING §5): global thresholds —
    // the failure-domain key is derived from endpoint+id, so there is no
    // natural per-model config block.
    health: {
      unhealthyThreshold: config.recovery?.llm_unhealthy_threshold,
      // Capped-backoff probe cadence (spec MODEL-FALLBACK §4.1). Per-model caps
      // ride the model config's `llm_probe_backoff_max_ms`, threaded through
      // admission — there is no natural per-model health config block here.
      probeBackoffBaseMs: config.recovery?.llm_probe_backoff_base_ms,
      probeBackoffMaxMs: config.recovery?.llm_probe_backoff_max_ms,
    },
    logger: logger.child("llm-scheduler"),
  });

  const storage = await Storage.open({
    databasePath: config.storage.database_path,
    logger: logger.child("storage"),
  });
  const timeline = new TimelineStore(storage);
  const router = new TimelineRouter(timeline);
  const triggerCoordinator = new TriggerCoordinator(config.agent.sessions);
  const sessions = new SessionManager({ storage, logger });
  // Per-timeline session-claim registry (spec DUPLICATE-REPLY-MITIGATION §3): the
  // single source of truth for "is this message being handled by another running/
  // queued session", backing the render marker, the send_message guard, and
  // co-target coalescing. Written synchronously at trigger-accept time (§3.2). The
  // logger backs the advisory `claim_out_of_order` serialization guard (spec
  // CLAIM-VISIBILITY-SERIALIZATION §4.4).
  const sessionClaims = new SessionClaims(logger.child("session-claims"));
  // Coalesced co-replies retained for `spawn_session` (spec §5.4): a co-reply that
  // was folded into a running session as an interjection is kept here, keyed by its
  // Matrix external id, so the session can later push it back out into its own
  // session. Scoped to the session it was coalesced into; cleaned up on that
  // session's settle (and on use).
  const coReplyInbounds = new Map<string, { inbound: InboundChatEvent; intoSessionId: string }>();
  // Deferred co-replies (spec DEFERRED-COALESCING): a co-target reply that arrives
  // while its owning session is not yet steerable (un-attributed accept→launch window,
  // queued, or the attachSession→attachAgent build window) is parked here keyed by the
  // OWNER trigger's external id, then steered in the moment that owner goes live
  // (`launchSession` post-attachAgent drain). If the owner is abandoned before going
  // live, the parked replies are re-dispatched as normal triggers (the owner's settle
  // listener / the pre-attribution catch) so they are never silently dropped.
  const pendingCoReplies = new Map<string, InboundChatEvent[]>();

  // Follow-up folding (spec FOLLOWUP-FOLDING). Resolve the three levers once; the
  // whole feature is inert unless at least one is enabled (the watch's GC lifetime
  // is 0 → `arm` no-ops, `get` returns nothing, so `foldFollowUp` always degrades to
  // the native path). 00-defaults.toml ships the full explicit block.
  const resolveFollowUpLever = (
    lever: { enabled?: boolean; user_gap_ms?: number; wall_clock_ms?: number } | undefined,
  ): FollowUpLeverConfig => ({
    enabled: lever?.enabled ?? false,
    userGapMs: lever?.user_gap_ms ?? 0,
    wallClockMs: lever?.wall_clock_ms ?? 0,
  });
  const followUpConfig: FollowUpConfig = {
    media: resolveFollowUpLever(config.agent.sessions.followup?.media),
    text: resolveFollowUpLever(config.agent.sessions.followup?.text),
    mention: resolveFollowUpLever(config.agent.sessions.followup?.mention),
  };
  const followUpActive = followUpConfigActive(followUpConfig);
  // Per-(timeline, sender) watch naming the most-recent session that sender
  // triggered (armed at the claim-attribution seam, §4.1/§7). GC'd at the widest
  // lever's wall_clock; inert (lifetime 0) when no lever is enabled.
  const followUpWatch = new FollowUpWatch(followUpActive ? maxWallClockMs(followUpConfig) : 0);
  // Follow-ups parked while their owner session is still pre-live (created / queued /
  // attachSession→attachAgent build window, §5.2), keyed by the OWNER session id.
  // Drained into the session the moment it goes live (`launchSession`/resume
  // post-attachAgent), or reverted to native fate if the owner is abandoned.
  const pendingFollowUps = new Map<string, FollowUpDelivery[]>();
  // ─── Workspace setup (spec MULTI-AGENT-SUPPORT §4.1/§4.2) ──────────────────
  //
  // Hard validation (§3 account key colons, §4.2 cross-field invariants) via the
  // exported pure helper so it's unit-testable. Advisory warnings (out-of-class
  // account key characters) follow, emitted with the logger.
  validateAgentConfig(config);

  for (const accountKey of Object.keys(config.matrix?.accounts ?? {})) {
    if (!AGENT_NAME_RE_EXPORTED.test(accountKey)) {
      logger.warn("account_key_out_of_class", {
        provider: "matrix",
        accountKey,
        message: "account key contains characters outside [a-z0-9-]; compliant keys are recommended",
      });
    }
  }
  for (const accountKey of Object.keys(config.discord?.accounts ?? {})) {
    if (!AGENT_NAME_RE_EXPORTED.test(accountKey)) {
      logger.warn("account_key_out_of_class", {
        provider: "discord",
        accountKey,
        message: "account key contains characters outside [a-z0-9-]; compliant keys are recommended",
      });
    }
  }
  for (const accountKey of Object.keys(config.irc?.accounts ?? {})) {
    if (!AGENT_NAME_RE_EXPORTED.test(accountKey)) {
      logger.warn("account_key_out_of_class", {
        provider: "irc",
        accountKey,
        message: "account key contains characters outside [a-z0-9-]; compliant keys are recommended",
      });
    }
  }

  // Per-agent workspace entry: workspace root path + its single-writer FIFO.
  interface AgentWorkspaceEntry {
    agentName: string;
    workspaceRoot: string;
    memoryWriter: MemoryFileWriter;
  }

  // Mutable map: "provider:accountKey" → AgentWorkspaceEntry.
  // Populated below; read by resolveWorkspaceForTimeline() (defined after).
  const agentWorkspaceMap = new Map<string, AgentWorkspaceEntry>();

  let workspaceRoot: string;
  let memoryWriter: MemoryFileWriter;

  // Per-agent workspace list for the retrieval subsystem (Phase 2, spec §7.1).
  // In agents mode: one entry per configured agent (name + absolute workspace root).
  // In legacy mode: empty (subsystem uses `workspaceRoot` directly with agentName=null).
  let agentWorkspaces: Array<{ agentName: string; workspaceRoot: string }> = [];

  // Reverse map: agentName → list of "provider:accountKey" prefixes that belong to
  // this agent (Phase 2 §7.2). Used to scope rooms:"all" in search_messages / recap.
  // In legacy mode this stays empty; all sessions get agentAccountPrefixes=undefined.
  const agentAccountPrefixesMap = new Map<string, string[]>();

  // Static snapshot for the observability console (spec CONSOLE-MULTI-AGENT §2).
  // Built alongside agentAccountPrefixesMap so both share one pass over accounts.
  let agentsSnapshot: import("./observability/server/types.js").AgentsSnapshot = {
    mode: "legacy",
    agents: [],
  };

  if (config.agents && Object.keys(config.agents).length > 0) {
    // ── Agents mode (spec §4.1/§4.2) ───────────────────────────────────────
    // validateAgentConfig() already threw on any §4.2 violation above;
    // here we only do the I/O (mkdir + seed) and build the resolver map.
    const agentRoots = Object.entries(config.agents).map(([name, block]) => ({
      name,
      resolved: path.resolve(block.workspace_root),
    }));
    // Build per-agent entries and seed each workspace independently.
    // Seeding is a no-op on an established workspace (never overwrites persona files).
    const agentEntries = new Map<string, AgentWorkspaceEntry>();
    for (const { name, resolved } of agentRoots) {
      await mkdir(resolved, { recursive: true });
      await seedWorkspace(resolved, logger);
      await seedFeatureSkills(resolved, enabledFeatureNames(config.features), logger);
      agentEntries.set(name, {
        agentName: name,
        workspaceRoot: resolved,
        memoryWriter: new MemoryFileWriter(resolved),
      });
    }
    // Build the resolver map: "provider:accountKey" → entry
    // Also populate agentAccountPrefixesMap (§7.2): agentName → "provider:accountKey" prefixes.
    for (const [accountKey, account] of Object.entries(config.matrix?.accounts ?? {})) {
      const agentName = (account as { agent?: string }).agent ?? accountKey;
      agentWorkspaceMap.set(`matrix:${accountKey}`, agentEntries.get(agentName)!);
      const prefix = `matrix:${accountKey}`;
      const prev = agentAccountPrefixesMap.get(agentName) ?? [];
      agentAccountPrefixesMap.set(agentName, [...prev, prefix]);
    }
    for (const [accountKey, account] of Object.entries(config.discord?.accounts ?? {})) {
      const agentName = account.agent ?? accountKey;
      agentWorkspaceMap.set(`discord:${accountKey}`, agentEntries.get(agentName)!);
      const prefix = `discord:${accountKey}`;
      const prev = agentAccountPrefixesMap.get(agentName) ?? [];
      agentAccountPrefixesMap.set(agentName, [...prev, prefix]);
    }
    for (const [accountKey, account] of Object.entries(config.irc?.accounts ?? {})) {
      const agentName = account.agent ?? accountKey;
      agentWorkspaceMap.set(`irc:${accountKey}`, agentEntries.get(agentName)!);
      const prefix = `irc:${accountKey}`;
      const prev = agentAccountPrefixesMap.get(agentName) ?? [];
      agentAccountPrefixesMap.set(agentName, [...prev, prefix]);
    }
    // Build the console agents snapshot (spec CONSOLE-MULTI-AGENT §2): one entry per
    // declared agent in config declaration order, with accounts in the same order as
    // agentAccountPrefixesMap (matrix first, then discord, within each agent).
    {
      const agentAccounts = new Map<string, Array<{ provider: string; accountId: string }>>();
      for (const agentName of Object.keys(config.agents!)) agentAccounts.set(agentName, []);
      for (const [accountKey, account] of Object.entries(config.matrix?.accounts ?? {})) {
        const agentName = (account as { agent?: string }).agent ?? accountKey;
        agentAccounts.get(agentName)?.push({ provider: "matrix", accountId: accountKey });
      }
      for (const [accountKey, account] of Object.entries(config.discord?.accounts ?? {})) {
        const agentName = account.agent ?? accountKey;
        agentAccounts.get(agentName)?.push({ provider: "discord", accountId: accountKey });
      }
      for (const [accountKey, account] of Object.entries(config.irc?.accounts ?? {})) {
        const agentName = account.agent ?? accountKey;
        agentAccounts.get(agentName)?.push({ provider: "irc", accountId: accountKey });
      }
      agentsSnapshot = {
        mode: "agents",
        agents: Array.from(agentAccounts.entries()).map(([name, accounts]) => ({ name, accounts })),
      };
    }
    // Build per-agent workspace list for the retrieval subsystem (§7.1).
    agentWorkspaces = Array.from(agentEntries.values()).map((e) => ({
      agentName: e.agentName,
      workspaceRoot: e.workspaceRoot,
    }));
    // Use the first agent's workspace as the legacy fallback root for subsystems
    // that don't yet resolve per-agent (browser/sandbox, Phase 4).
    const firstEntry = agentEntries.values().next().value!;
    workspaceRoot = firstEntry.workspaceRoot;
    memoryWriter = firstEntry.memoryWriter;
  } else {
    // ── Legacy mode (single implicit agent, behaviour-identical to pre-Phase-1) ─
    // validateAgentConfig() already threw on any account-level `agent` field; here
    // we only seed and build the legacy singleton map entry.
    // Canonicalize once at the source. `config.workspace?.root_dir` is commonly
    // configured as a relative path (e.g. "./workspaces/miku"); resolving it here
    // means every tool downstream receives an absolute, normalized root. That
    // keeps path-containment guards correct regardless of how they compare paths,
    // so a tool can't reintroduce the "absolute path never string-prefixes a
    // relative root" class of false-rejection bug. Idempotent for the sandbox,
    // which already calls path.resolve(workspaceRoot) for its bind mount below.
    workspaceRoot = path.resolve(config.workspace?.root_dir ?? "./workspaces/miku");
    await mkdir(workspaceRoot, { recursive: true });

    // First-run workspace seeding (ARCHITECTURE.md §4 "First-run seeding"). Runs
    // POST-config-load now that workspaceRoot is known. Copy-missing/never-overwrite:
    // seeds templates/workspace/ only when the workspace is empty (no AGENTS.md AND
    // no SOUL.md), then seeds skill files for every ON feature gate. A strict no-op
    // on an established workspace (the live case) — never clobbers SOUL.md et al.
    await seedWorkspace(workspaceRoot, logger);
    await seedFeatureSkills(workspaceRoot, enabledFeatureNames(config.features), logger);

    // Single-writer FIFO for all memory/*.md mutations (ARCHITECTURE.md §9b): the
    // diary worker's appends and `write_memory`'s edits serialize through it so a
    // concurrent read-modify-write can't corrupt a day file.
    memoryWriter = new MemoryFileWriter(workspaceRoot);

    // In legacy mode all accounts map to the single implicit workspace
    for (const accountKey of Object.keys(config.matrix?.accounts ?? {})) {
      agentWorkspaceMap.set(`matrix:${accountKey}`, { agentName: "__legacy__", workspaceRoot, memoryWriter });
    }
    for (const accountKey of Object.keys(config.discord?.accounts ?? {})) {
      agentWorkspaceMap.set(`discord:${accountKey}`, { agentName: "__legacy__", workspaceRoot, memoryWriter });
    }
    for (const accountKey of Object.keys(config.irc?.accounts ?? {})) {
      agentWorkspaceMap.set(`irc:${accountKey}`, { agentName: "__legacy__", workspaceRoot, memoryWriter });
    }
  }

  /**
   * Resolve the workspace entry (root + memoryWriter) for a timeline key
   * (spec MULTI-AGENT-SUPPORT §4.1/§4.3). Returns undefined when the account
   * is not in config (§4.3 rule: skip identity-dependent actions, warn).
   */
  function resolveWorkspaceForTimeline(timelineKey: string): AgentWorkspaceEntry | undefined {
    const parsed = parseTimelineKey(timelineKey);
    if (!parsed) return undefined;
    const entry = agentWorkspaceMap.get(`${parsed.provider}:${parsed.accountId}`);
    if (!entry) {
      logger.warn("agent_unresolvable_account", {
        provider: parsed.provider,
        accountKey: parsed.accountId,
        timelineKey,
        message:
          "timeline key maps to an account not in config — skipping identity-dependent action (§4.3)",
      });
      return undefined;
    }
    return entry;
  }

  /**
   * Resolve the ExecBackend for a session (spec MULTI-AGENT-SUPPORT §10).
   * Agents mode: returns the per-agent strict ExecBackend (direct SandboxManager)
   * or the shared-mode cwd-routing wrapper for this agent.
   * Legacy mode: returns the global `sandbox` SandboxManager (or undefined).
   */
  function resolveAgentSandbox(agentName: string | null): ExecBackend | undefined {
    if (!agentName || agentName === "__legacy__") return sandbox;
    return agentSandboxMap.get(agentName);
  }

  /**
   * Resolve the BrowserSession for a session (spec MULTI-AGENT-SUPPORT §10a).
   * Agents mode: returns the per-agent BrowserSession, or undefined if this
   * agent has no [browser] block.
   * Legacy mode: returns the global `browserSession` (or undefined).
   */
  function resolveAgentBrowserSession(agentName: string | null): BrowserSession | undefined {
    if (!agentName || agentName === "__legacy__") return browserSession;
    return agentBrowserMap.get(agentName);
  }

  // Memory retrieval (ARCHITECTURE.md §9d): a hybrid lexical+semantic index over
  // `memory/*.md`. When enabled, the indexer reconciles the corpus on startup and
  // after each memory write (hooked below), the embedding worker populates the vector
  // index in the background, and the search engine backs the `recall_memory` tool and
  // auto-retrieval. Degrades to lexical-only (FTS5/BM25) if embeddings are unavailable.
  // Period cost limits (spec USAGE-COST-LIMITS §6). A late-bound holder: the
  // BudgetEngine + the unified-ledger recorder are constructed below (after the
  // factory, which the engine resolves model ids through), but several consumers
  // wired before then close over this holder and read `engine`/`record` only at
  // call time — never capturing the fields at construction. The remote embedding
  // provider reads `record` inside its `onEmbeddingUsage` closure (§9 ledger row)
  // and resolves `engine` per call through its late-bound claim gate (§6 embed
  // pause); the caption pool likewise reads both at call time in its worker loop.
  // Filled exactly once, before any work runs.
  const budgetHooks: BudgetHooks = {};

  // Per-user cost limits & model selection (spec PER-USER-LIMITS). The engine is
  // constructed in the budget-wiring block below (after the factory exists);
  // `userLimitResolutions` holds each ACTIVE human session's frozen cascade
  // resolution so the single `recordUsageEvent` fan-in can attribute BOTH the
  // agent-loop AND tool lanes (§6) to its partitioned counters. Cleared on settle.
  let userLimitEngine: UserLimitEngine | undefined;
  // Hoisted out of the period-cost-limits init block so the user-limit gate (§6.3)
  // can see it: the dynamic §8d ceiling must not tighten to $0 for a zero-cost
  // initial model (issue #4). Assigned alongside the BudgetEngine build below.
  let zeroCostModelIds = new Set<string>();
  const userLimitResolutions = new Map<string, { resolution: UserLimitResolution; ctx: UserLimitContext }>();

  const retrievalConfig = resolveRetrievalConfig(config.retrieval);
  let retrieval: RetrievalSubsystem | undefined;
  if (retrievalConfig.enabled) {
    retrieval = await createRetrievalSubsystem({
      storage,
      workspaceRoot,
      dataDir: config.app.data_dir,
      config: retrievalConfig,
      httpProxyUrl: config.network?.http_proxy_url,
      scheduler: llmScheduler,
      budget: budgetHooks,
      // Unified registry (spec MODEL-FALLBACK §2.3): resolve the remote embedding
      // model ref to its [models.*] chain (head + fallback members).
      embeddingChain: retrievalConfig.embedding.remote
        ? resolveModelChain(retrievalConfig.embedding.remote.model, config.models)
        : undefined,
      isModelAvailable: (logicalId) => budgetHooks.engine?.isModelAvailable(logicalId) ?? true,
      // Per-agent workspaces (spec MULTI-AGENT-SUPPORT §7.1): in agents mode each
      // agent gets its own MemoryIndexer; in legacy mode this is empty and the
      // subsystem creates a single indexer with agentName=null.
      agentWorkspaces: agentWorkspaces.length > 0 ? agentWorkspaces : undefined,
      logger: logger.child("retrieval"),
    });
    // Wire each agent's memoryWriter to its own indexer (§7.1). In agents mode
    // there is one indexer per agent; in legacy mode there is exactly one.
    if (agentWorkspaces.length > 0) {
      // Agents mode: route each writer to the matching indexer.
      for (const [, entry] of agentWorkspaceMap) {
        const capturedName = entry.agentName;
        const capturedWriter = entry.memoryWriter;
        const capturedIndexer = retrieval.indexerForAgent(capturedName);
        if (capturedIndexer) {
          capturedWriter.onAfterWrite = (absPath) => capturedIndexer.enqueueReconcile(absPath);
        }
      }
    } else {
      // Legacy mode: single indexer (agentName=null).
      const legacyIndexer = retrieval.indexerForAgent(null);
      if (legacyIndexer) {
        memoryWriter.onAfterWrite = (absPath) => legacyIndexer.enqueueReconcile(absPath);
      }
    }
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
  //
  // Agents mode (§10): strict agents get their own SandboxManager; shared-mode
  // agents share one manager with per-exec cwd routing. Per-agent sandbox and
  // browser maps (populated in agents mode only; empty in legacy mode).
  const agentSandboxMap = new Map<string, ExecBackend>(); // agentName → exec backend
  const allSandboxManagers: Array<{ manager: SandboxManager; stopOnShutdown: boolean }> = [];
  const agentBrowserMap = new Map<string, BrowserSession>(); // agentName → browser session
  const allBrowserSessions: BrowserSession[] = [];

  let sandbox: SandboxManager | undefined; // legacy mode only; undefined in agents mode
  if (config.agents && Object.keys(config.agents).length > 0) {
    // ── Agents mode sandbox setup (§10) ─────────────────────────────────────
    // Strict agents: each with [agents.<name>.sandbox] gets its own container.
    for (const [agentName, block] of Object.entries(config.agents)) {
      if (!block.sandbox?.enabled) continue;
      const sb = block.sandbox;
      const manager = await SandboxManager.ensure({
        image: sb.image,
        containerName: sb.container_name,
        network: sb.network,
        dns: sb.dns,
        workspaceHostDir: path.resolve(block.workspace_root),
        workspaceBindSource: sb.workspace_bind_source,
        workspaceMount: sb.workspace_mount,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        memory: sb.memory,
        cpus: sb.cpus,
        pidsLimit: sb.pids_limit,
        readOnlyRoot: sb.read_only_root,
        env: { TZ: getConfiguredTimezone(), ...sb.env },
        binds: sb.binds,
        execTimeoutMs: sb.exec_timeout_ms,
        maxOutputBytes: sb.max_output_bytes,
        logger: logger.child(`sandbox:${agentName}`),
      });
      allSandboxManagers.push({ manager, stopOnShutdown: sb.stop_on_shutdown ?? false });
      agentSandboxMap.set(agentName, manager);
    }
    // Shared-mode agents: agents without a per-agent sandbox block share [sandbox].
    const sharedAgentEntries = Object.entries(config.agents).filter(([, b]) => !b.sandbox);
    if (sharedAgentEntries.length > 0 && config.sandbox?.enabled) {
      const sharedRoots = sharedAgentEntries.map(([, b]) => path.resolve(b.workspace_root));
      // Mount the common ancestor of all shared agents' workspace roots so the
      // container sees every participating workspace under one bind source.
      const commonAncestor = computeCommonAncestor(sharedRoots);
      const sharedManager = await SandboxManager.ensure({
        image: config.sandbox.image,
        containerName: config.sandbox.container_name,
        network: config.sandbox.network,
        dns: config.sandbox.dns,
        workspaceHostDir: commonAncestor,
        workspaceBindSource: config.sandbox.workspace_bind_source,
        workspaceMount: config.sandbox.workspace_mount,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        memory: config.sandbox.memory,
        cpus: config.sandbox.cpus,
        pidsLimit: config.sandbox.pids_limit,
        readOnlyRoot: config.sandbox.read_only_root,
        env: { TZ: getConfiguredTimezone(), ...config.sandbox.env },
        binds: config.sandbox.binds,
        execTimeoutMs: config.sandbox.exec_timeout_ms,
        maxOutputBytes: config.sandbox.max_output_bytes,
        logger: logger.child("sandbox"),
      });
      allSandboxManagers.push({ manager: sharedManager, stopOnShutdown: config.sandbox.stop_on_shutdown ?? false });
      // Wire each shared-mode agent with a cwd-routing wrapper that prefixes
      // the agent's subdir (relative to commonAncestor) onto every exec cwd.
      for (const [agentName, block] of sharedAgentEntries) {
        const agentRoot = path.resolve(block.workspace_root);
        // Use posix separators — the container is always Linux.
        const agentSubdir = agentRoot.slice(commonAncestor.length).replace(/\\/g, "/").replace(/^\//, "");
        agentSandboxMap.set(agentName, createSharedExecBackend(sharedManager, agentSubdir));
      }
    }
  } else if (config.sandbox?.enabled) {
    // ── Legacy mode sandbox setup (unchanged) ───────────────────────────────
    sandbox = await SandboxManager.ensure({
      image: config.sandbox.image,
      containerName: config.sandbox.container_name,
      network: config.sandbox.network,
      dns: config.sandbox.dns,
      workspaceHostDir: path.resolve(workspaceRoot),
      workspaceBindSource: config.sandbox.workspace_bind_source,
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

  // Shared media size cap — applied to automatic media downloads, tool fetches,
  // and browser downloads alike.
  const downloadSizeLimit = config.media?.download_size_limit ?? 1_073_741_824;

  // Browser-use backend (spec/BROWSER-USE.md). Unlike the sandbox, this does NOT
  // connect or fail-fast at startup: the CloakBrowser-Manager is an operator-run
  // service the harness only reaches lazily on first browser-tool use, degrading
  // gracefully if it is down (§3.4). Constructing the manager here just holds
  // config + the per-session tab map; no I/O happens until a tool runs.
  //
  // Agents mode (§10a): each agent with [agents.<name>.browser] gets its own
  // BrowserSession (own Manager profile). Connection settings come from [browser];
  // profile_name is supplied per-agent. Agents without a browser block get no
  // browser tools. Legacy mode: single global session, profile_name defaults to "miku".
  let browserSession: BrowserSession | undefined; // legacy mode only; undefined in agents mode

  /**
   * Validate browser downloads config (shared between legacy and per-agent setup).
   * Throws on a half-configured staging volume (exactly one of the two keys set).
   */
  async function validateAndProbeBrowserDownloads(): Promise<void> {
    if (!config.browser) return;
    const hasDownloadsDir = config.browser.downloads_dir !== undefined;
    const hasDownloadsLocalDir = config.browser.downloads_local_dir !== undefined;
    if (hasDownloadsDir !== hasDownloadsLocalDir) {
      throw new Error(
        "browser.downloads_dir and browser.downloads_local_dir must be set together — they are the " +
          "one shared download staging volume as seen by the browser container and by the agent " +
          `(got ${hasDownloadsDir ? "downloads_dir" : "downloads_local_dir"} alone); ` +
          "set both, or neither to disable browser downloads",
      );
    }
    // downloads_dir is the staging path AS SEEN BY THE BROWSER CONTAINER and is
    // sent verbatim over CDP in Browser.setDownloadBehavior (issue #13). A
    // relative value is resolved by Chromium against ITS OWN cwd in the manager
    // container, so the bytes land somewhere the agent never sees — surfacing as
    // confusing per-download copy failures for a statically detectable typo. The
    // browser container is always Linux in both topologies, so require an
    // absolute POSIX path (fail-fast here for a friendlier message than a schema
    // pattern, consistent with the cross-field check above).
    if (config.browser.downloads_dir !== undefined && !config.browser.downloads_dir.startsWith("/")) {
      throw new Error(
        `browser.downloads_dir = "${config.browser.downloads_dir}" must be an absolute path (begin with "/"): ` +
          "it is sent verbatim to the browser container over CDP, where Chromium resolves a relative path " +
          "against its own cwd and the downloaded bytes never reach the agent",
      );
    }
    // Create the agent-side staging dir up front and probe it for writability AND
    // deletability (issue #1). The download pipeline needs not just to copy OUT of
    // the staging dir but to UNLINK the root-owned 0644 guid files the Manager's
    // Chromium writes — which is governed by write permission on the DIRECTORY,
    // not the files. Under compose, `var/` is gitignored, so a fresh deploy has no
    // `./var/browser-downloads`; Docker then creates the bind source ROOT-OWNED
    // before the agent runs, and this in-container `mkdir -p` is a no-op against
    // the existing mount point that never fixes ownership. The copy still works
    // (read-only on a 0644 file), but every unlink fails with EACCES — silently
    // leaking every download permanently into the shared `./var` volume. The probe
    // converts that invisible leak into a loud startup error: create then unlink a
    // probe file; if either fails we cannot reap staging files, so fail fast.
    if (config.browser.downloads_local_dir !== undefined) {
      const stagingDir = path.resolve(config.browser.downloads_local_dir);
      await mkdir(stagingDir, { recursive: true });
      const probePath = path.join(stagingDir, `.write-probe-${process.pid}-${Date.now()}`);
      try {
        await writeFile(probePath, "");
        await unlink(probePath);
      } catch (error) {
        throw new Error(
          `browser.downloads_local_dir "${stagingDir}" is not writable+deletable by this process ` +
            `(${error instanceof Error ? error.message : String(error)}). The browser-download pipeline ` +
            "must create files in and unlink root-owned staging files from this directory; both are governed " +
            "by directory write permission. The likely cause under docker compose is that the host bind " +
            "source did not exist on a fresh deploy, so Docker created it ROOT-OWNED before the agent " +
            "started — pre-create it owned by the agent's uid (e.g. `mkdir -p var/browser-downloads && " +
            "chown $(id -u):$(id -g) var/browser-downloads`) and recreate the containers",
        );
      }
    }
  }

  if (config.browser?.enabled) {
    if (config.agents && Object.keys(config.agents).length > 0) {
      // ── Agents mode browser setup (§10a) ───────────────────────────────────
      // Downloads validation runs once — the staging volume is shared.
      await validateAndProbeBrowserDownloads();
      // Create a BrowserSession for each agent that has a [browser] block.
      // Connection settings come from [browser]; profile_name is per-agent.
      // workspace_root is resolved from the agent block (same as workspace setup above).
      for (const [agentName, block] of Object.entries(config.agents)) {
        if (!block.browser) continue;
        const agentBrowserConfig = { ...config.browser!, profile_name: block.browser.profile_name };
        const session = new BrowserSession({
          config: agentBrowserConfig,
          agentTimezone: getConfiguredTimezone(),
          workspaceRoot: path.resolve(block.workspace_root),
          downloadSizeLimit,
          logger: logger.child(`browser:${agentName}`),
        });
        agentBrowserMap.set(agentName, session);
        allBrowserSessions.push(session);
      }
    } else {
      // ── Legacy mode browser setup (unchanged, profile_name defaults to "miku") ─
      await validateAndProbeBrowserDownloads();
      browserSession = new BrowserSession({
        config: { ...config.browser!, profile_name: config.browser!.profile_name ?? "miku" },
        agentTimezone: getConfiguredTimezone(),
        workspaceRoot,
        // Browser downloads share the global media size cap; on breach the
        // in-flight download is canceled (§11b).
        downloadSizeLimit,
        logger: logger.child("browser"),
      });
    }
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
    // Claim registry for `<handled_by_session>` markers (DUPLICATE-REPLY-MITIGATION §4).
    sessionClaims,
  );
  // §6.3: inject provider self-identity resolution so the builder uses the live
  // provider identity rather than the static config.matrix.accounts read.
  contextBuilder.getSelfUserId = (provider, accountId) =>
    providers.get(provider)?.getSelf(accountId)?.id;
  // Per-session workspace root resolver (spec MULTI-AGENT-SUPPORT §4.1/§4.3):
  // the diary layer and image attachment loading resolve the workspace from the
  // build's timeline key rather than reading config.workspace.root_dir directly.
  contextBuilder.resolveWorkspaceRoot = (timelineKey) =>
    resolveWorkspaceForTimeline(timelineKey)?.workspaceRoot;
  // Per-session agent name resolver (spec MULTI-AGENT-SUPPORT §7.1): scopes
  // auto-retrieval to the calling session's agent corpus. Returns null in legacy mode.
  contextBuilder.resolveAgentName = (timelineKey) => {
    const entry = resolveWorkspaceForTimeline(timelineKey);
    if (!entry) return null;
    // Normalize the sentinel: "__legacy__" means "no scoping".
    return entry.agentName === "__legacy__" ? null : entry.agentName;
  };

  const mediaCachePath = path.join(config.app.data_dir, "media-cache");

  const fetchClient = new FetchClient({
    timeoutMs: config.enrichment?.fetch_timeout_ms ?? 10_000,
    maxResponseBytes: downloadSizeLimit,
    httpProxyUrl: config.network?.http_proxy_url,
  });

  // One FxTwitter API client shared by the enrichment X stage and the x_fetch
  // tool (ARCHITECTURE.md §7a/§10). Constructed unconditionally (it is just a
  // dispatcher handle): the enrichment partition must run even with
  // `fxtwitter.enabled = false` — a disabled stage means X URLs are NOT
  // previewed at all, never that they fall back to the Synapse og-card.
  const fxTwitterClient = new FxTwitterClient({
    apiBase: fxTwitterConfig.apiBase,
    timeoutMs: fxTwitterConfig.fetchTimeoutMs,
    httpProxyUrl: config.network?.http_proxy_url,
  });

  // YouTube subsystem wiring (ARCHITECTURE.md §7e / spec §2 graceful degradation).
  // Probe the yt-dlp binary once at startup. On success: configureYtDlp so the
  // module-level subprocess wrapper is ready. On failure (binary absent or broken):
  // log ONE structured warning and mark the subsystem unavailable; the enrichment
  // partition and future tool registrations consult this flag before doing anything.
  // enabled=false skips the probe entirely and marks the subsystem unavailable.
  const ytConfig = resolveYouTubeConfig(config.youtube);
  let youtubeSubsystemAvailable = false;
  if (ytConfig.enabled) {
    try {
      const { probeYtDlpBinary, configureYtDlp } = await import("./youtube/ytdlp.js");
      const version = await probeYtDlpBinary();
      configureYtDlp({
        ytDlpPath: ytConfig.ytDlpPath,
        timeoutMs: ytConfig.timeoutMs,
        concurrency: ytConfig.concurrency,
        httpProxyUrl: config.network?.http_proxy_url,
        cookiesFile: ytConfig.cookiesFile,
        maxDownloadBytes: ytConfig.maxDownloadBytes,
      });
      youtubeSubsystemAvailable = true;
      logger.info("youtube_subsystem_ready", { version, ytDlpPath: ytConfig.ytDlpPath });
    } catch (err) {
      logger.warn("youtube_subsystem_unavailable", {
        ytDlpPath: ytConfig.ytDlpPath,
        error: err instanceof Error ? err.message : String(err),
        message:
          "yt-dlp binary not found or not executable — YouTube enrichment and tools will be disabled. " +
          "Install yt-dlp into PATH or set [youtube].yt_dlp_path.",
      });
    }
  } else {
    logger.info("youtube_subsystem_disabled", { reason: "[youtube].enabled = false" });
  }

  // Shared, cross-session Grok-result cache for x_search: one
  // instance so a reactive and a proactive session hitting the same topic in a
  // busy channel dampen to a single Grok call. Only the expensive synthesis is
  // cached (pre-hydration); 0 minutes disables it.
  const xSearchCache = new GrokResultCache((config.x_search?.cache_ttl_minutes ?? 10) * 60_000);

  // Shared SauceNAO short-window quota guard (spec SAUCENAO-SOURCE-LOOKUP §4): the
  // SauceNAO free-tier limit is per-ACCOUNT (global), so a single limiter is
  // constructed here and injected into every session's `find_source` tool — a
  // per-session limiter would not bound the shared budget. Built only when the
  // tool is enabled.
  const sauceNaoRateLimiter =
    sauceNaoConfig
      ? new SauceNaoRateLimiter({
          shortWindowMax: sauceNaoConfig.rate_limit?.short_window_max ?? 6,
          shortWindowMs: sauceNaoConfig.rate_limit?.short_window_ms ?? 30_000,
        })
      : undefined;

  const captioningConfig = config.captioning ?? {};
  // Unified registry (spec MODEL-FALLBACK §2.3): captioning references `[models.*]`
  // by name. A modality's own `model` ref wins; else the top-level captioning
  // `model`; else the `default` model. Connection, pricing, rate-limit group, and
  // any `fallback` chain all live on the referenced block — the old shared-model /
  // per-modality cost-inheritance machinery is gone (pricing is on the model).
  function resolveModalityChain(modalityConfig?: { model?: string }) {
    const ref = modalityConfig?.model ?? captioningConfig.model ?? "default";
    return resolveModelChain(ref, config.models);
  }

  // Image-gen per-tier cost block (spec §7.2): snake_case config → CostRates,
  // carrying the optional flat per_image charge. Unset ⇒ undefined (untracked).
  function toImageCostRates(block?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    per_image?: number;
  }): CostRates | undefined {
    if (!block) return undefined;
    return {
      input: block.input,
      output: block.output,
      cacheRead: block.cache_read,
      cacheWrite: block.cache_write,
      ...(block.per_image != null ? { perImage: block.per_image } : {}),
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

  // Per-agent model override table (spec PER-AGENT-MODEL-OVERRIDES §8): built once
  // from config at startup; all four resolvers are pure O(1) lookups over the
  // precomputed per-agent map. Moved here (before the captionClients block) so the
  // captioning ladder resolvers are available during per-agent client construction;
  // still passed into the factory below for the chat-lane ladder (§4).
  const agentModelOverrides = buildAgentModelOverrides(config);

  // Per-modality processing options — extracted so they can be reused verbatim
  // when building per-agent InferenceClients (spec PER-AGENT-MODEL-OVERRIDES §3:
  // "only the model *reference* is overridable — never the surrounding behavioral
  // settings"). Prompt, maxChars, maxTokens, and media-processing options all
  // come from the GLOBAL captioning config; only the chain differs per agent.
  const captionVideoProcessing = {
    maxResolution: mediaVideoConfig.max_resolution ?? 480,
    maxBytes: mediaVideoConfig.max_bytes ?? 52_428_800,
    maxDurationSeconds: mediaVideoConfig.max_duration_seconds ?? 120,
    gpuAcceleration: mediaVideoConfig.gpu_acceleration ?? false,
    x264Preset: mediaVideoConfig.x264_preset ?? "veryfast",
    cachePath: mediaCachePath,
    cacheMaxBytes: mediaVideoConfig.cache_max_bytes ?? 21_474_836_480,
    cacheTargetBytes: mediaVideoConfig.cache_target_bytes ?? 16_106_127_360,
  };
  const captionAudioProcessing = {
    maxBytes: mediaAudioConfig.max_bytes ?? 20_971_520,
    maxDurationSeconds: mediaAudioConfig.max_duration_seconds ?? 300,
  };

  // Build an InferenceClient for the given modality and chain. All behavioral
  // options (prompt, maxChars, maxTokens, scheduler, media processing) come from
  // the global captioning config; only `chain` varies per-agent (§3).
  function buildCaptionClient(modality: MediaModality, chain: ReturnType<typeof resolveModalityChain>): InferenceClient {
    if (modality === "image") {
      return new InferenceClient({
        modality: "image",
        chain,
        prompt: imageConfig.prompt ?? "Describe the image.",
        maxChars: imageConfig.max_chars ?? 500,
        maxTokens: imageConfig.max_tokens ?? 2048,
        scheduler: llmScheduler,
        isModelAvailable: (logicalId) => budgetHooks.engine?.isModelAvailable(logicalId) ?? true,
        imageProcessing: inferenceImageOptions,
      });
    }
    if (modality === "video") {
      return new InferenceClient({
        modality: "video",
        chain,
        prompt: videoConfig.prompt ?? "Describe the video.",
        maxChars: videoConfig.max_chars ?? 500,
        maxTokens: videoConfig.max_tokens ?? 2048,
        scheduler: llmScheduler,
        isModelAvailable: (logicalId) => budgetHooks.engine?.isModelAvailable(logicalId) ?? true,
        timeoutMs: videoConfig.timeout_ms,
        videoProcessing: captionVideoProcessing,
      });
    }
    // audio
    return new InferenceClient({
      modality: "audio",
      chain,
      prompt: audioConfig.prompt ?? "Transcribe and describe the audio.",
      maxChars: audioConfig.max_chars ?? 2000,
      maxTokens: audioConfig.max_tokens ?? 4096,
      scheduler: llmScheduler,
      isModelAvailable: (logicalId) => budgetHooks.engine?.isModelAvailable(logicalId) ?? true,
      timeoutMs: audioConfig.timeout_ms,
      audioProcessing: captionAudioProcessing,
    });
  }

  // Baseline (global) per-modality clients — identical to today's construction.
  const captionClients = new Map<MediaModality, InferenceClient>([
    ["image", buildCaptionClient("image", resolveModalityChain(imageConfig))],
    ["video", buildCaptionClient("video", resolveModalityChain(videoConfig))],
    ["audio", buildCaptionClient("audio", resolveModalityChain(audioConfig))],
  ]);

  // All distinct InferenceClients for teardown (baseline + any per-agent).
  // Clients sharing a chain ref with the baseline reuse the SAME instance and
  // must not be stopped twice — this Set enforces exactly-once teardown.
  const allCaptionClients = new Set<InferenceClient>(captionClients.values());

  // Per-agent client map (spec PER-AGENT-MODEL-OVERRIDES Phase 2): built only for
  // agents that have a [agents.<name>.models.captioning] override AND whose
  // resolved model ref for at least one modality differs from the baseline.
  // Same ref → reuse the baseline client (no allocation, no duplicate teardown).
  // Agents with no captioning override section are not entered here; the resolver
  // below falls through to the baseline for them (correct — see §4 subtlety note).
  const perAgentCaptionClients = new Map<string, Map<MediaModality, InferenceClient>>();
  if (agentWorkspaces.length > 0 && config.agents) {
    const captionModalities: readonly MediaModality[] = ["image", "video", "audio"] as const;
    for (const agentName of Object.keys(config.agents)) {
      if (!config.agents[agentName]?.models?.captioning) continue;
      const agentMap = new Map<MediaModality, InferenceClient>();
      for (const modality of captionModalities) {
        const agentRef = agentModelOverrides.resolveCaptionModelRef(agentName, modality);
        const baselineRef = agentModelOverrides.resolveCaptionModelRef(null, modality);
        if (agentRef === baselineRef) continue; // same chain → reuse baseline
        const agentChain = resolveModelChain(agentRef, config.models);
        const agentClient = buildCaptionClient(modality, agentChain);
        agentMap.set(modality, agentClient);
        allCaptionClients.add(agentClient);
      }
      if (agentMap.size > 0) perAgentCaptionClients.set(agentName, agentMap);
    }
  }

  // Startup observability — per-agent model overrides (spec PER-AGENT-MODEL-OVERRIDES §9).
  // One info log per agent that has ANY model override, emitted once after the override
  // table and per-agent caption clients are fully built. `overrides` is a flat map of
  // role key → raw config value (not ladder result), so operators can see exactly what
  // they configured without having to trace through the resolution ladder.
  if (config.agents) {
    for (const [agentName, agentBlock] of Object.entries(config.agents)) {
      const m = agentBlock.models;
      if (!m) continue;
      const overrides: Record<string, string> = {};
      if (m.session_types) {
        for (const [k, v] of Object.entries(m.session_types)) {
          overrides[`session_types.${k}`] = v;
        }
      }
      if (m.captioning) {
        if (m.captioning.model !== undefined) overrides["captioning.model"] = m.captioning.model;
        for (const mod of ["image", "video", "audio"] as const) {
          if (m.captioning[mod] !== undefined) overrides[`captioning.${mod}`] = m.captioning[mod]!;
        }
      }
      if (m.image_gen) {
        if (m.image_gen.pro !== undefined) overrides["image_gen.pro"] = m.image_gen.pro;
        if (m.image_gen.flash !== undefined) overrides["image_gen.flash"] = m.image_gen.flash;
      }
      if (m.x_search) {
        if (m.x_search.model !== undefined) overrides["x_search.model"] = m.x_search.model;
        if (m.x_search.deep_model !== undefined) overrides["x_search.deep_model"] = m.x_search.deep_model;
      }
      if (Object.keys(overrides).length > 0) {
        logger.info("agent_model_overrides", { agent: agentName, overrides });
      }
    }
  }

  // Caption client resolver: returns the per-agent client when the agent has an
  // override that differs from the baseline chain; baseline otherwise.
  // null agentName → always baseline (legacy mode or unresolvable → treated as global).
  function resolveAgentCaptionClient(agentName: string | null, modality: MediaModality): InferenceClient {
    if (agentName !== null) {
      const agentClient = perAgentCaptionClients.get(agentName)?.get(modality);
      if (agentClient) return agentClient;
    }
    return captionClients.get(modality)!;
  }

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

  // Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / Phase 5d).
  // Default-off: only constructed when `[attachment_store] enabled = true`.
  // On success, `init()` runs the cross-device link() probe against all workspace
  // roots and sets `isReady()` true. On EXDEV the process exits with a clear message.
  let attachmentStore: AttachmentStore | undefined;
  if (config.attachment_store?.enabled) {
    const storePath = path.resolve(
      config.attachment_store.path ?? "./attachment-store",
    );
    attachmentStore = new AttachmentStore(storePath, logger);
    const allRoots =
      agentWorkspaces.length > 0
        ? agentWorkspaces.map((w) => w.workspaceRoot)
        : [workspaceRoot];
    // Throws on EXDEV (cross-device) or other filesystem errors — crash-fast is
    // correct here; a misconfigured store must not silently lose data.
    await attachmentStore.init(allRoots);
    // Background adoption sweep: run once at startup (delayed to let the process
    // stabilise) and then daily. Fire-and-forget: errors are logged inside the
    // sweep and never crash the process.
    setTimeout(() => void attachmentStore!.adoptSweep(allRoots), 30_000);
    setInterval(
      () => void attachmentStore!.adoptSweep(allRoots),
      24 * 60 * 60 * 1000,
    );
  }

  const enrichmentPool = new EnrichmentWorkerPool({
    storage,
    timeline,
    providerCapabilities: new Map(),
    fetchClient,
    workspaceRoot,
    // Per-event workspace resolver (spec MULTI-AGENT-SUPPORT §7.4): in agents
    // mode, enrichment downloads land in the owning agent's account-scoped
    // msg-attach subdir. Absent = legacy flat layout.
    resolveWorkspaceRoot: agentWorkspaces.length > 0
      ? (timelineKey) => resolveWorkspaceForTimeline(timelineKey)?.workspaceRoot
      : undefined,
    // All agent workspace roots for startup temp-file cleanup (Fix 3): in agents
    // mode temps are created under every agent's msg-attach/, so cleanup must
    // sweep all roots, not just the legacy singleton.
    agentWorkspaceRoots: agentWorkspaces.length > 0
      ? agentWorkspaces.map((w) => w.workspaceRoot)
      : undefined,
    downloadSizeLimit,
    fxtwitter: { client: fxTwitterClient, config: fxTwitterConfig },
    // YouTube enrichment partition (ARCHITECTURE.md §7e): only passed when the
    // subsystem is available AND [youtube.enrichment].enabled is true.
    youtube:
      youtubeSubsystemAvailable && ytConfig.enrichment.enabled
        ? {
            config: ytConfig.enrichment,
            captionAssistant:
              (config.captioning?.caption_all ?? false) ||
              (config.captioning?.caption_assistant_messages ?? false),
          }
        : undefined,
    store: attachmentStore,
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
    // Per-asset workspace resolver (spec MULTI-AGENT-SUPPORT §7.4): in agents
    // mode, the caption worker resolves the owning agent's root from the asset's
    // timeline_key so local_path is expanded against the correct workspace.
    resolveWorkspaceRoot: agentWorkspaces.length > 0
      ? (timelineKey) => resolveWorkspaceForTimeline(timelineKey)?.workspaceRoot
      : undefined,
    // Per-asset agent-name resolver (spec PER-AGENT-MODEL-OVERRIDES Phase 2):
    // companion to resolveWorkspaceRoot — provided in agents mode so the pool
    // can forward the agentName to resolveClient for per-agent client selection.
    resolveAgentName: agentWorkspaces.length > 0
      ? (timelineKey) => {
          const entry = resolveWorkspaceForTimeline(timelineKey);
          if (!entry) return null;
          return entry.agentName === "__legacy__" ? null : entry.agentName;
        }
      : undefined,
    // Per-asset caption client resolver (spec PER-AGENT-MODEL-OVERRIDES Phase 2):
    // only injected in agents mode so the pool picks the correct InferenceClient
    // per (agentName, modality). Absent in legacy mode → static clients map used.
    resolveClient: agentWorkspaces.length > 0
      ? resolveAgentCaptionClient
      : undefined,
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
    budget: budgetHooks,
    // Representative fallback chain (LOGICAL ids) for the pool's coarse claim gate
    // (spec §8e / MODEL-FALLBACK §6): the captioning model REF's chain (spec §2.3
    // unified registry). The gate parks only when EVERY member is over budget, so a
    // head-only cap still lets the per-attempt resolver serve from a fallback; the
    // per-attempt ledger records the exact billed member.
    captionModelIds: resolveModelChain(
      config.captioning?.model ??
        config.captioning?.image?.model ??
        config.captioning?.video?.model ??
        config.captioning?.audio?.model ??
        "default",
      config.models,
    ).map((m) => m.logicalId),
    logger,
  });

  // ── Provider registry (spec DISCORD-SUPPORT-DESIGN §3.2) ─────────────────────
  // Build the provider registry from config. Each entry is keyed by provider id
  // ("matrix", "discord", …). At least one enabled provider is required at boot.
  //
  // `opts.providers` is a test seam: supplying it bypasses config-derived
  // construction entirely (the caller owns the map; it must still be non-empty).
  //
  // Matrix-only subsystems (re-decryption, gap/message backfetch, Matrix backfill)
  // are gated on the "matrix" entry's presence — they are never instantiated when
  // no matrix provider is registered (spec §5 / §11.3).

  // Only construct MatrixProvider when the [matrix] block is enabled.
  const matrixProviderInstance: MatrixProvider | undefined =
    config.matrix.enabled !== false ? new MatrixProvider(config.matrix) : undefined;

  // Self-id containers populated eagerly from Matrix config and lazily from
  // Discord's READY event (via onSelfResolved). Declared before the providers
  // IIFE so that both the Discord callbacks (inside) and the budget/backfetch
  // coordinators (outside) share the SAME mutable Set/Map — the Discord
  // callback fires post-start() and adds ids to whichever objects these
  // variables refer to at that time (boot-ordering constraint, spec §6.3).
  const botSelfIdsForLimits = new Set<string>(
    Object.values(config.matrix?.accounts ?? {})
      .map((a) => (a as { user_id?: string }).user_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  // accountId → selfUserId for backfetch coordinators. Populated with Matrix
  // ids here; Discord ids added at READY via onSelfResolved.
  const gapBackfetchSelfIds = new Map<string, string>();
  for (const [accountId, account] of Object.entries(config.matrix?.accounts ?? {})) {
    const uid = (account as { user_id?: string }).user_id;
    if (uid) gapBackfetchSelfIds.set(accountId, uid);
  }

  const providers: Map<string, IChatProvider> = opts?.providers ?? (() => {
    const map = new Map<string, IChatProvider>();
    if (matrixProviderInstance) map.set("matrix", matrixProviderInstance);

    // Construct DiscordProvider when [discord] is enabled and has accounts.
    // Callbacks close over storage (already initialized above) to perform
    // late-embed merges and ingest-time embed writes without coupling the
    // provider to the storage module directly (spec §8.3 / §9.3).
    if (config.discord?.enabled && config.discord.accounts && Object.keys(config.discord.accounts).length > 0) {
      const discordProvider = new DiscordProvider(config.discord, {
        async mergeLateEmbeds(provider, externalId, timelineKey, previews) {
          // Find the canonical event id from the stored event, then upsert each embed preview.
          const event = storage.getTimelineEventByExternalId(provider, externalId, timelineKey);
          if (!event) return; // Not yet stored (race) — silently ignore
          for (let i = 0; i < previews.length; i++) {
            const preview = previews[i]!;
            await storage.insertLinkPreview({
              id: `${event.id}:late_embed:${i}`,
              event_id: event.id,
              context: "message",
              url: preview.url,
              title: preview.title ?? null,
              description: preview.description ?? null,
              source_kind: "discord_embed",
              preview_index: i,
              fetched_at: preview.fetchedAt ?? Date.now(),
              fetch_status: "complete",
              created_at: Date.now(),
            });
          }
        },
        async storeIngestEmbeds(eventId, previews) {
          for (let i = 0; i < previews.length; i++) {
            const preview = previews[i]!;
            await storage.insertLinkPreview({
              id: `${eventId}:embed:${i}`,
              event_id: eventId,
              context: "message",
              url: preview.url,
              title: preview.title ?? null,
              description: preview.description ?? null,
              source_kind: "discord_embed",
              preview_index: i,
              fetched_at: preview.fetchedAt ?? Date.now(),
              fetch_status: "complete",
              created_at: Date.now(),
            });
          }
        },
        async upsertUserIdentity(input) {
          await storage.upsertUserIdentity(input);
        },
        async setChannelMetadata(timelineKey, meta) {
          await storage.setChannelMetadata(timelineKey, meta);
        },
        onSelfResolved(accountId, selfId) {
          // Add Discord self-id to the budget engine's exclusion set and the
          // backfetch coordinators' accountId→selfUserId maps (spec §6.3).
          // These sets/maps are already wired into the coordinators and
          // UserLimitEngine by reference.
          botSelfIdsForLimits.add(selfId);
          gapBackfetchSelfIds.set(accountId, selfId);
        },
      });
      map.set("discord", discordProvider);
    }

    // Construct IrcProvider when [irc] is enabled and has accounts.
    if (config.irc?.enabled && config.irc.accounts && Object.keys(config.irc.accounts).length > 0) {
      const ircCallbacks: IrcProviderCallbacks = {
        async upsertUserIdentity(input) {
          await storage.upsertUserIdentity(input);
        },
        async setChannelMetadata(timelineKey, meta) {
          await storage.setChannelMetadata(timelineKey, meta);
        },
      };
      const ircProvider = new IrcProvider(config.irc, ircCallbacks);
      map.set("irc", ircProvider);
    }

    return map;
  })();

  if (providers.size === 0) {
    throw new Error(
      "no enabled chat provider: at least one provider must be enabled at startup " +
      "(set [matrix] enabled = true, add a [discord] block, or add an [irc] block). " +
      "Zero enabled providers is a fatal config error.",
    );
  }

  // Narrow to the concrete MatrixProvider for Matrix-only wiring below.
  // This is the single instanceof-narrowing site per spec §3.2.
  const matrixProvider: MatrixProvider | undefined = (() => {
    const p = providers.get("matrix");
    return p instanceof MatrixProvider ? p : undefined;
  })();

  // Inject sibling self-id set and reply mode into each provider so it can
  // suppress (never mode) or pass through (capped mode) sibling triggers
  // (spec MULTI-AGENT-SUPPORT §5.2 / §9).
  // The Set starts with Matrix self-ids and grows as Discord's READY fires via
  // onSelfResolved — providers hold it by reference so additions are live.
  const siblingRepliesMode = (config.siblings?.replies ?? "never") as "never" | "capped";
  if (matrixProvider) {
    matrixProvider.siblingUserIds = botSelfIdsForLimits;
    matrixProvider.siblingRepliesMode = siblingRepliesMode;
  }
  const _discordProviderRef = providers.get("discord");
  if (_discordProviderRef instanceof DiscordProvider) {
    _discordProviderRef.siblingUserIds = botSelfIdsForLimits;
    _discordProviderRef.siblingRepliesMode = siblingRepliesMode;
  }

  const activeRuns = new Set<Promise<void>>();
  let draining = false;
  // Drain cancellation for context builds (spec §7.2): a build waiting on a
  // summarization job has no wall clock — once the worker pool stops, nothing
  // can ever drive the waited job to terminal, so stop() aborts this signal
  // FIRST (before any pool teardown) and the waiting build rejects cleanly
  // (AbortError → launchSession's factory-failure path) instead of polling
  // until storage.close() makes it throw.
  const drainAbort = new AbortController();
  let stopPromise: Promise<void> | undefined;
  // Per-session tentative-event bus (spec LLM-FAILURE-HANDLING §4.2): Layer-0
  // buffers attempts to the terminal event, so live tokens reach the console
  // only through this tap → SSE merge. Observe-only; nothing is persisted.
  const liveEvents = new SessionLiveEventBus();

  // In-memory Layer-0 attempt ring (spec §9.2) — console attribution only;
  // the LLM gateway keeps the durable wire log upstream.
  const llmRequestRing = new LlmRequestRing(
    config.observability?.llm_request_ring_size ?? DEFAULT_LLM_REQUEST_RING_SIZE,
  );

  // Exact tool-name → server-name attribution map, populated after mcpPool.start()
  // below. Declared here so the resolveToolDefs closure (Fix 2) and the factory
  // options both reference the same Map object — by the time either consumer calls
  // into it at runtime, the map is fully populated.
  const mcpToolServerMap = new Map<string, string>();

  // Tool-definition resolver for the console inspector (ARCHITECTURE.md §10a). The
  // room-context preview and session-detail views show the tool-definition block
  // (its estimate + per-tool breakdown) above the system prompt. Tool definitions
  // are config-static within a process run, so we build the set ON DEMAND from the
  // real `buildSessionTools` (synthesizing the inbound from the timeline key) and
  // apply both the MCP server scoping filter (`filterMcpToolsByAllowlist`) and the
  // session type's allowlist (`filterTools`) so the displayed block matches the SAME
  // set `create()` froze the estimate from — then memoize per agent+type pair so
  // the build happens at most once per combination. A timeline that doesn't parse, an
  // account that isn't configured, or a construction failure → no block (graceful).
  const toolDefsByType = new Map<string, import("./context/index.js").ToolDefinitionLike[]>();
  function resolveToolDefs(
    timelineKey: string,
    sessionType: string,
  ): import("./context/index.js").ToolDefinitionLike[] | undefined {
    // Derive agent identity for per-agent MCP scoping. Null in legacy mode.
    const agentEntry = resolveWorkspaceForTimeline(timelineKey);
    const agentName =
      agentEntry?.agentName === "__legacy__" ? null : (agentEntry?.agentName ?? null);
    const agentMcpServers =
      agentName !== null ? config.agents?.[agentName]?.mcp_servers : undefined;
    // Memo key must include the agent name: two agents with different mcp_servers
    // but the same session type would otherwise share a wrong cached block.
    const memoKey = `${agentName ?? ""}:${sessionType}`;
    const cached = toolDefsByType.get(memoKey);
    if (cached) return cached;
    // Use the shared grammar parser (spec DISCORD-SUPPORT-DESIGN §4.2).
    const parsed = parseTimelineKey(timelineKey);
    if (!parsed) return undefined;
    // §6.3: use provider self identity; falls back to undefined when the provider
    // hasn't started yet (safe — the inspector synthetic inbound just gets no self).
    const selfUserId = providers.get(parsed.provider)?.getSelf(parsed.accountId)?.id;
    const inbound: InboundChatEvent = {
      provider: parsed.provider,
      timelineKey,
      event: {
        id: `inspector-${sessionType}`,
        timelineKey,
        provider: parsed.provider,
        role: "user",
        sender: { id: selfUserId ?? "inspector", isSelf: true },
        body: "",
        timestamp: 0,
        receivedAt: 0,
      },
      outboundTarget: {
        provider: parsed.provider,
        timelineKey,
        accountId: parsed.accountId,
        roomId: parsed.channelId,
        threadId: parsed.threadId,
      },
    };
    try {
      const full = buildSessionTools(
        inbound,
        `inspector-${sessionType}`,
        inbound.outboundTarget!,
        sessionType,
        new SessionUsageTracker(),
      );
      // Apply the same two-stage filter as create(): MCP scoping first, then
      // the session-type allowlist. Both compose as an intersection so the
      // displayed tool block matches exactly what the agent can call.
      // NOTE: returns the FULL post-filter catalog. Dynamic-tool-loading
      // consumers (factory.toolBlockFor, factory.buildPreview) apply the
      // immediate/deferred split themselves — they own the session-type gate.
      const mcpFiltered = filterMcpToolsByAllowlist(full, agentMcpServers, mcpToolServerMap);
      const filtered = filterTools(mcpFiltered, factory.resolveSessionType(sessionType));
      const defs = filtered.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      toolDefsByType.set(memoKey, defs);
      return defs;
    } catch (error) {
      logger.warn("tool_defs_inspector_build_failed", {
        sessionType,
        timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  const factory = new AgentSessionFactory({
    config,
    contextBuilder,
    getActiveSessions: (timelineKey) => sessions.activeForTimeline(timelineKey),
    storage,
    logger,
    scheduler: llmScheduler,
    liveEvents,
    requestRing: llmRequestRing,
    budget: budgetHooks,
    buildToolDefs: resolveToolDefs,
    // Per-session workspace root resolver (spec MULTI-AGENT-SUPPORT §4.1/§4.3).
    // Returns the owning agent's resolved workspace root for a timeline key.
    resolveWorkspaceRoot: (timelineKey) => resolveWorkspaceForTimeline(timelineKey)?.workspaceRoot,
    // Per-agent model override ladder (spec PER-AGENT-MODEL-OVERRIDES §4/§8).
    // Only active in agents mode (agentWorkspaces.length > 0); in legacy mode the
    // resolver is absent → factory falls back to the global-only path (§2).
    agentModelOverrides,
    // ONE resolver, two consumers: the model-override ladder above and the
    // per-agent MCP server allowlist (spec PER-AGENT-MCP-SCOPING). Both need the
    // same timeline-key → agent-name mapping, so they share it rather than
    // wiring two identical closures.
    resolveAgentName: agentWorkspaces.length > 0
      ? (timelineKey) => {
          const entry = resolveWorkspaceForTimeline(timelineKey);
          if (!entry) return null;
          // Normalize the sentinel exactly as the contextBuilder wiring (app.ts:~909):
          // "__legacy__" means "no agent scoping" → null → global ladder.
          return entry.agentName === "__legacy__" ? null : entry.agentName;
        }
      : undefined,
    // Exact tool-name → server-name attribution map. Populated after
    // mcpPool.start() below (same Map object reference — by the time create()
    // runs at runtime it is fully populated).
    mcpToolServerMap,
  });

  // ---------------------------------------------------------------------------
  // Period cost limits (spec USAGE-COST-LIMITS §5/§6): normalize + validate the
  // `[[limits]]` rules, build the BudgetEngine (seeded from `usage_events`), and
  // fill the late-bound holder with the engine + the unified-ledger recorder.
  // The recorder is the single fan-in for every billable event: it appends one
  // `usage_events` row (best-effort) and increments the engine in memory.
  // ---------------------------------------------------------------------------
  {
    const knownSessionTypes = new Set<string>([
      "default",
      ...Object.keys(config.agent.session_types ?? {}),
    ]);
    const knownTools = new Set<string>([
      "image_generate",
      "x_search",
    ]);
    // Every configured model id (zero-cost ∪ paid), assembled before normalize so a
    // `models` selector naming an unknown id earns a soft validation warning,
    // symmetric with the unknown-tool / unknown-session-type warnings (review #11).
    const knownModelIds = collectKnownModelIds(config);
    // All configured account prefixes ("provider:accountKey") for agent/account
    // matcher validation in normalizeLimits and normalizeUserLimits.
    const knownAccountPrefixes = new Set<string>([
      ...Object.keys(config.matrix?.accounts ?? {}).map((k) => `matrix:${k}`),
      ...Object.keys(config.discord?.accounts ?? {}).map((k) => `discord:${k}`),
      ...Object.keys(config.irc?.accounts ?? {}).map((k) => `irc:${k}`),
    ]);
    const isAgentsMode = !!(config.agents && Object.keys(config.agents).length > 0);
    const normalized = normalizeLimits(config.limits as never, {
      defaultTz: config.agent.timezone ?? "UTC",
      knownTools,
      knownSessionTypes,
      knownModelIds,
      isAgentsMode,
      agentAccountPrefixes: agentAccountPrefixesMap,
      knownAccountPrefixes,
    });
    if (normalized.fatal.length > 0) {
      throw new Error(`invalid [[limits]] config:\n  ${normalized.fatal.join("\n  ")}`);
    }
    for (const warning of normalized.warnings) logger.warn("usage_limit_config_warning", { warning });

    // Model ids whose configured cost rate is zero (spec §2.2): these bypass the
    // budget gates entirely (cost = rate × tokens; rate 0 ⇒ cost 0 ⇒ never moves
    // or is blocked by a rule). Collected across every config site that prices a
    // model — agent models, captioning, image-gen tiers, x_search, remote
    // embeddings — so a free model in any lane is recognized.
    zeroCostModelIds = collectZeroCostModelIds(config);

    // Structural dependency cascade (§2.1): triggered (default) + proactive
    // sessions cannot run if summarization cannot (they need fresh summaries for
    // context assembly). Diary depends on nothing. Encoded in code, not config.
    const proactiveType = config.proactive?.session_type ?? "proactive";
    const dependencies: Record<string, string[]> = {
      default: ["summarize", "condense"],
      [proactiveType]: ["summarize", "condense"],
    };

    const engine = new BudgetEngine({
      rules: normalized.rules,
      sumUsageCost: (filter) => storage.sumUsageCost(filter),
      // Off-hot-path earliest-contributing-ts lookup for the accurate rolling reset
      // ETA (console countdown + the refusal/defer message); never hit in check().
      minUsageTs: (filter) => storage.minUsageTs(filter),
      zeroCostModelIds,
      dependencies,
      // `timelineKey` is threaded through `checkAdmissionChain` so that per-agent
      // model overrides (spec PER-AGENT-MODEL-OVERRIDES §4) are visible when the
      // dependency cascade resolves a prerequisite's (e.g. summarize's) model for a
      // specific agent's session. Callers without per-session context (e.g.
      // `isClassAvailable`, worker claim gates) omit `timelineKey` → global ladder.
      resolveModelId: (sessionType, timelineKey) => {
        try {
          return factory.resolveModelId(sessionType, timelineKey);
        } catch {
          return undefined;
        }
      },
      // Logical id (chain-head config block name) for the session-level gates —
      // the dimension `[[limits]].models` matches (spec MODEL-FALLBACK §2.2).
      resolveLogicalModelId: (sessionType, timelineKey) => {
        try {
          return factory.resolveLogicalModelId(sessionType, timelineKey);
        } catch {
          return undefined;
        }
      },
      // Full fallback chain (logical ids, head-first) for the chain-aware dependency
      // cascade (spec MODEL-FALLBACK §6.1): a prerequisite (summarize/condense) is
      // judged unavailable only when EVERY member of its chain is over budget, so a
      // model-scoped cap on the prerequisite's head (e.g. GLM) does not refuse a
      // dependent reply the prerequisite could still produce on a fallback (DeepSeek).
      resolveModelChainLogicalIds: (sessionType, timelineKey) => {
        try {
          return factory.resolveModelChainLogicalIds(sessionType, timelineKey);
        } catch {
          return [];
        }
      },
      logger: logger.child("budget"),
    });

    // Per-user limits engine (spec PER-USER-LIMITS §8.2). A sibling to the
    // BudgetEngine, gating ONLY the human agent loop. Off (inert) when
    // `[[user_limits]]` is absent/empty. Cross-field validation fails fast here,
    // mirroring `normalizeLimits` (the explicit-deployment-config convention).
    {
      const normalizedUser = normalizeUserLimits(config.user_limits as never, {
        defaultTz: config.agent.timezone ?? "UTC",
        knownModelIds,
        // §6.4: warn when a partition var is used by no enabled provider.
        enabledProviders: [...providers.keys()],
        isAgentsMode,
        agentAccountPrefixes: agentAccountPrefixesMap,
        knownAccountPrefixes,
      });
      if (normalizedUser.fatal.length > 0) {
        throw new Error(`invalid [[user_limits]] config:\n  ${normalizedUser.fatal.join("\n  ")}`);
      }
      for (const warning of normalizedUser.warnings)
        logger.warn("user_limit_config_warning", { warning });
      const ul = new UserLimitEngine({
        rules: normalizedUser.rules,
        sumUsageCost: (filter) => storage.sumUsageCost(filter),
        minUsageTs: (filter) => storage.minUsageTs(filter),
        listUsageIdentities: (opts) => storage.listUsageIdentities(opts),
        // Face cost rates of the REQUESTED model (§7) — per-MTok, by logical id,
        // incl. the prompt-cache rates the §5.3 estimate prices prior context at.
        costRatesFor: (logicalId) => {
          const m = config.models[logicalId];
          if (!m) return undefined;
          return {
            inputPerMTok: m.cost?.input ?? 0,
            outputPerMTok: m.cost?.output ?? 0,
            cacheReadPerMTok: m.cost?.cache_read ?? 0,
            cacheWritePerMTok: m.cost?.cache_write ?? 0,
          };
        },
        maxTokensFor: (logicalId) => config.models[logicalId]?.max_tokens,
        zeroCostModelIds,
        viableMinOutputTokens: config.agent.user_limit_min_output_tokens ?? 256,
        // Spec §6.4 / Phase 0: dispatches to each registered provider's ownsUserId()
        // shape test. For Matrix-only configs, MatrixProvider.ownsUserId is
        // id.startsWith("@") — byte-identical to the pre-Phase-7 literal. For Discord,
        // DiscordProvider.ownsUserId is /^\d+$/.test(id) (numeric snowflake).
        // The composed predicate is: "id is owned by at least one registered provider."
        isUserIdentity: (id) => [...providers.values()].some((p) => p.ownsUserId(id)),
        // The bot's own user ids (one per account) — excluded (with synthetic system
        // senders) from the per-user console surface, since per-user limits don't
        // govern self/system/proactive spend (Gate A is skipped for those lanes).
        // Pre-seeded with Matrix ids from config; Discord ids are added to this same
        // mutable Set at READY time via the Discord provider's onSelfResolved callback,
        // which fires after provider.start() and before any live events arrive.
        // Because UserLimitEngine stores the options object by reference, mutations
        // to this Set are visible to isEnforceableUser() (spec §6.3).
        selfUserIds: botSelfIdsForLimits,
        logger: logger.child("user-limits"),
      });
      userLimitEngine = ul;
      if (ul.enabled) {
        // Seed meters from the ledger BEFORE start()/first use so a partition
        // partially consumed before this restart is visible immediately, not $0 until
        // a live turn re-materializes it (symmetric with BudgetEngine's ctor seed).
        ul.seedFromLedger();
        ul.start();
        logger.info("user_limits_active", { rules: normalizedUser.rules.length });
      }
    }

    const recordUsageEvent = (event: UsageEventInput): void => {
      // In-memory increment first (synchronous, hot-path authoritative), then the
      // durable append (queued, best-effort — a ledger failure must never fail
      // the underlying work or desync the engine, which re-seeds from the ledger
      // on the next rolling tick / restart).
      //
      // Ledger correctness invariants — the app-side mirror of `insertUsageEvent`'s
      // (see `src/storage/database.ts`):
      //   1. The synchronous `engine.record()` and the queued `insertUsageEvent`
      //      durable write below MUST both settle within ONE synchronous turn +
      //      microtask drain, BEFORE any engine `tick()` macrotask re-sums the
      //      ledger. Otherwise a tick could double-count an increment already in
      //      its SUM, or miss one not yet written (seed-then-increment consistency).
      //      Recording in-memory first, then enqueuing the write, preserves this:
      //      both are issued in this one synchronous call before control returns.
      //   2. Capture points are FIRE-ONCE. The ledger has no idempotency key (random
      //      PK, no dedup), so every caller of `recordUsageEvent` must invoke it at
      //      most once per logical event — a double-fire is counted twice by every
      //      covering rule.
      engine.record(event);
      // Per-user partitioned counters (spec PER-USER-LIMITS §8.2): increment every
      // covering meter for the triggering session's FROZEN resolution. Fires for BOTH
      // the agent loop and its tool lane (§6) — the single fan-in is the one place
      // that sees both. The agent loop keys coverage on the REQUESTED model (the
      // selector's choice, §7), so it counts the fungible total, shared pools, AND the
      // sub-caps that model is in. The tool lane has no requested model and passes
      // `undefined`, so `record` skips ALL model-scoped sub-caps and credits only the
      // model-agnostic total + pools (issue #14): a sub-cap reserves agent-loop
      // degradation headroom, NOT a bound on tools. Consequence (operator-decided):
      // once a user's sub-cap on model X is exhausted, the agent loop degrades off X
      // but tools hardwired to X (e.g. x_search→Grok) keep using X, bounded only by
      // the user's fungible total / pools — a sub-cap gates agent-loop MODEL SELECTION
      // only, never tool usage of the same upstream model. The ledger reseed mirrors
      // this via the agent-loop-gated null-fallback in `usageCostClauses`. Background/
      // proactive lanes have no resolution entry and are skipped.
      if (userLimitEngine && (event.class === "agent_loop" || event.class === "tool")) {
        const entry = event.agentSessionId ? userLimitResolutions.get(event.agentSessionId) : undefined;
        if (entry) {
          // For an agent_loop event with an `entry` (the only branch that reaches
          // here), `requestedModelId` is always set by the selector, so the
          // `?? logicalModelId ?? modelId` tail never decides coverage on this
          // per-user-active path — it only matters for events with no `entry`
          // (where `coverageModel` is unused). No null-`requestedModelId` per-user
          // agent-loop case exists; the tail is defensive, not a real fallback.
          const coverageModel =
            event.class === "tool"
              ? undefined
              : event.requestedModelId ?? event.logicalModelId ?? event.modelId;
          userLimitEngine.record(entry.resolution, coverageModel, event.costUsd);
          // Stamp the shared-pool key SET (spec MULTI-SHARED-POOL §4) from the frozen
          // resolution, model-aware via `sharedPoolKeys(coverageModel)`. This is the
          // single place both lanes pass through, so both the agent loop and the tool
          // lane get denormalized identically (without it a tool row would persist no
          // pool key and DROP OUT of every pool reseed). The set is model-narrowed:
          // the agent loop joins the model-agnostic total(s) + pools + any sub-cap its
          // requested model is in; the tool lane (`coverageModel === undefined`) joins
          // only the model-agnostic pools (never a sub-cap, issue #14) — exactly
          // mirroring the in-memory `record` above. `insertUsageEvent` denormalizes the
          // first key on `budget_partition` and spills the rest to
          // `usage_event_partitions`. Empty ⇒ no stamp (per-user-only / unpooled).
          const poolKeys = userLimitEngine.sharedPoolKeys(entry.resolution, coverageModel);
          if (poolKeys.length > 0) {
            event = { ...event, budgetPartitions: poolKeys };
          }
          // Stamp the canonical parent space (§11) from the frozen ctx — it cannot be
          // derived from intrinsic columns, so the recorder supplies it centrally.
          if (entry.ctx.spaceIds?.[0] && event.spaceId === undefined) {
            event = { ...event, spaceId: entry.ctx.spaceIds[0] };
          }
        }
      }
      void storage.insertUsageEvent(event).catch((error) => {
        logger.warn("usage_event_insert_failed", {
          class: event.class,
          model: event.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    budgetHooks.engine = engine;
    budgetHooks.record = recordUsageEvent;
    if (normalized.rules.length > 0) {
      engine.start();
      logger.info("usage_limits_active", {
        rules: normalized.rules.map((r) => r.name),
      });
    }
  }

  // Human-readable reset instant for the trigger-rejection reply (§5/§6.3),
  // rendered in the agent's configured time zone. Falls back to ISO on a bad tz.
  const formatResetsAt = (ms: number): string => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: config.agent.timezone ?? "UTC",
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toISOString();
    }
  };

  // Relative duration to a reset, compact ("3h 12m", "2d", "now") — the {resets_in}
  // token of a per-user refusal (spec PER-USER-LIMITS §12). Module-level + exported
  // for direct testing (issue #11).
  const formatDurationShort = formatRefusalDurationShort;

  // Render a per-user refusal template (spec PER-USER-LIMITS §12): the richer token
  // set resolved against the trigger + the binding constraint. `{resets_at}` /
  // `{resets_in}` render empty for a cap-0 ban (no meaningful reset).
  const renderUserLimitRefusal = (
    template: string,
    ctx: UserLimitContext,
    binding: ResolvedConstraint | undefined,
    displayName: string,
  ): string => {
    const resetsAt = binding ? userLimitEngine?.accurateResetsAt(binding) : undefined;
    const window = binding
      ? binding.window.type === "rolling"
        ? `${binding.window.duration} rolling`
        : `this ${binding.window.period} (${binding.window.tz})`
      : "";
    return template
      .replace(/\{display_name\}/g, displayName)
      .replace(/\{user_id\}/g, ctx.userId)
      .replace(/\{limit\}/g, binding ? `$${binding.cap.toFixed(2)}` : "")
      .replace(/\{window\}/g, window)
      .replace(/\{resets_at\}/g, resetsAt !== undefined ? formatResetsAt(resetsAt) : "")
      .replace(/\{resets_in\}/g, resetsAt !== undefined ? formatDurationShort(resetsAt - Date.now()) : "");
  };

  // Resolve server-scope ids (space ids for Matrix, guild id for Discord) for the
  // per-user-limits `{server_id}` / `{space_id}` partition vars and space matching
  // (spec §6.4 / PER-USER-LIMITS §11). Called ONLY when a rule references space/server.
  // Never rejects: a malformed key / lookup failure resolves to none.
  const serverIdsFor = async (timelineKey: string): Promise<string[]> => {
    const parsedKey = parseTimelineKey(timelineKey);
    if (!parsedKey) return [];

    if (parsedKey.provider === "matrix") {
      // Matrix: canonical parent space ids from channelInfo (unchanged from before §6.4).
      if (!matrixProvider) return [];
      try {
        const roomId = parsedKey.channelId;
        if (!roomId) return [];
        const client = matrixProvider.getClient({
          provider: "matrix",
          timelineKey,
          accountId: parsedKey.accountId,
        });
        const info = await client.channelInfo({ roomId });
        return info.parentSpaceIds ?? [];
      } catch (error) {
        logger.debug("server_ids_for_failed", {
          timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }

    if (parsedKey.provider === "discord") {
      // Discord: look up the guild id from room_metadata (set at ingest by the
      // Discord provider's setChannelMetadata callback, spec §6.6 / §6.4).
      const guildId = storage.getChannelServerId(timelineKey);
      return guildId ? [guildId] : [];
    }

    if (parsedKey.provider === "irc") {
      // IRC: the server-scope id is the network identity — the NETWORK ISUPPORT token
      // lowercased when advertised, else the configured host (spec IRC-SUPPORT-DESIGN §7.4).
      // Read from room_metadata (set by the IRC provider's setChannelMetadata callback
      // on first ingest, same pattern as Discord).
      const networkId = storage.getChannelServerId(timelineKey);
      return networkId ? [networkId] : [];
    }

    return [];
  };

  // Per-tool period-budget gate (spec USAGE-COST-LIMITS §6.3): returns an
  // agent-facing refusal message when the tool/model is over budget, else
  // undefined. Wired into the paid LLM-calling tools (image_generate, x_search).
  const makeToolBudgetCheck = (toolName: string) => (modelId: string): string | undefined => {
    const engine = budgetHooks.engine;
    if (!engine) return undefined;
    const descriptor = { class: "tool" as const, tool: toolName, modelId };
    const result = engine.check(descriptor);
    if (result.allowed) return undefined;
    engine.logBlocked("tool_call", result.blockingRules, descriptor, { toolName });
    // Surface the ACCURATE reset (rolling rules age out at oldest-spend + duration,
    // not the cheap now + duration the gate carries — §5 #5); fall back to the
    // gate's value if the rule can't be resolved.
    const resetsAt = result.primary
      ? (engine.accurateResetsAt(result.primary.name) ?? result.primary.resetsAt)
      : undefined;
    const when = resetsAt !== undefined ? formatResetsAt(resetsAt) : "later";
    return (
      `Over budget for ${toolName} (limit ${result.primary?.name ?? "unknown"}); ` +
      `resets ${when}. Try again after that.`
    );
  };

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

  // Shared agent-loop claim-gate builder for the summary/diary worker pools (spec
  // USAGE-COST-LIMITS §6.3/§6.4, review #2; MODEL-FALLBACK §6). Returns a `shouldPause`
  // closure that parks the pool while ANY of its `agent_loop` session types cannot make
  // progress — where a session type can progress iff ANY member of ITS OWN fallback
  // chain is in budget (chain-aware, mirroring the caption/embed pools). A model-scoped
  // cap on a type's HEAD (e.g. summarize on GLM=`default`) therefore degrades the pool
  // to the in-budget fallback (DeepSeek) instead of parking — the per-attempt resolver
  // would serve that member anyway. On pause it emits one rate-limited (≤1/min)
  // `usage_limit_blocked` log naming the stuck lane's head rules. Each lane's chain is
  // resolved via `factory.resolveModelChainLogicalIds` (logical ids the `[[limits]].models`
  // selector matches); the head's upstream id is carried for provenance (matching keys
  // on the logical id). An unresolvable session type contributes no lane and never parks.
  // `budgetHooks.engine` is set before pool construction, so it is always present here;
  // absent = no gate (no budgeting).
  const safeResolveLogicalModelId = (sessionType: string): string | undefined => {
    try {
      return factory.resolveLogicalModelId(sessionType);
    } catch {
      return undefined;
    }
  };
  // NOTE (spec PER-AGENT-MODEL-OVERRIDES FIX 8): the lanes below are deliberately
  // GLOBAL-model-based. The claim gate is a process-wide pause heuristic — it has no
  // per-session context at evaluation time, only a set of session-type names. With
  // per-agent model overrides, an agent whose override is within budget may still pause
  // while the global model is over budget: a conservative over-pause, not a correctness
  // problem. The per-session admission gates (which ARE agent-aware, threaded via
  // timelineKey through checkAdmission/checkAdmissionChain) remain the enforcement
  // point. Widening this gate would require threading the calling session's timeline key
  // here, but claim gates are registered at startup and re-evaluated without session
  // context — the tradeoff is intentional.
  const makeAgentLoopClaimGate = (sessionTypes: readonly string[]): (() => boolean) => {
    const engine = budgetHooks.engine;
    if (!engine) return () => false;
    return makeAgentLoopChainClaimGate({
      engine,
      lanes: () => {
        const lanes: SpendDescriptor[][] = [];
        for (const sessionType of sessionTypes) {
          let modelId: string | undefined;
          try {
            modelId = factory.resolveModelId(sessionType);
          } catch {
            modelId = undefined;
          }
          if (modelId === undefined) continue; // unresolvable → contribute no lane
          let chain: string[];
          try {
            chain = factory.resolveModelChainLogicalIds(sessionType);
          } catch {
            chain = [];
          }
          // Head-first logical ids the `[[limits]].models` selector matches; fall back
          // to the head-only logical id when the chain can't resolve (no-virtual case).
          const logicalIds: (string | undefined)[] =
            chain.length > 0 ? chain : [safeResolveLogicalModelId(sessionType)];
          lanes.push(
            logicalIds.map((logicalModelId) => ({
              class: "agent_loop" as const,
              sessionType,
              modelId,
              logicalModelId,
            })),
          );
        }
        return lanes;
      },
    });
  };

  // ── Summary mirroring (spec MULTI-AGENT-SUPPORT §10b, Phase 5c) ──────────
  // mirrorWorker is created AFTER the pool (which it hooks into), but the pool
  // needs isMirroredTimeline and onDonorComplete at construction time. We use a
  // mutable reference variable captured by the closures, set after mirrorWorker
  // is constructed. This avoids any `as any` casts and keeps the pool/indexer/
  // worker construction order straightforward.
  let mirrorWorkerRef: MirrorWorker | null = null;

  const summarizationPool = summarizationEnabled
    ? new SummarizationWorkerPool({
        storage,
        factory,
        config: config.summarization ?? {},
        // Budget claim gate (spec USAGE-COST-LIMITS §6.3): park while EITHER
        // summarization session type is over budget. Conservative — over-pausing
        // summarization only delays it (nothing dropped) and is the safe side of
        // the structural dependency that gates triggered/proactive sessions (§2.1).
        // The gate emits a rate-limited `usage_limit_blocked` log on pause (§6.4,
        // review #2) — summarization is the worst silent omission since its pause
        // transitively halts triggered/proactive sessions via the dependency cascade.
        shouldPause: makeAgentLoopClaimGate(["summarize", "condense"]),
        // §10b mirror check: evaluated lazily via the mutable ref so the pool
        // can be constructed before mirrorWorker exists.
        isMirroredTimeline: (tk) => mirrorWorkerRef?.isMirroredTimeline(tk) ?? false,
        onComplete: (jobId, summaryId) => {
          logger.info("summarization_job_complete", { jobId, summaryId });
          // The job is terminal — drop any sticky escalation pinned to it (§5.5).
          llmScheduler.clearEscalation(`sumjob:${jobId}`);
          summarizationPool!.notifyNewWork();
          // Re-reconcile the timeline (spec §7.3): the next chunk that crossed
          // threshold while this one was generating is enqueued immediately,
          // replacing the old implicit "the next build enqueues the next chunk".
          const job = storage.getSummarizationJobById(jobId);
          if (job) summarizationIndexer?.enqueueReconcileTimeline(job.timelineKey);
          // §10b mirror hook: propagate L1 completions to secondary timelines
          // immediately (sweep catches L2+; this keeps L1 latency low).
          void mirrorWorkerRef?.onDonorComplete(summaryId).catch((err) => {
            logger.warn("mirror_on_donor_complete_error", {
              summaryId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          // A completed level-1 summary just queued a diary job (diary_status =
          // 'pending'); wake the diary pool so it doesn't wait for its next poll.
          diaryPool?.notifyNewWork();
        },
        onError: (jobId, error) => {
          llmScheduler.clearEscalation(`sumjob:${jobId}`);
          logger.error("summarization_failed", { jobId, error: error.message });
        },
        activityBus: pipelineActivityBus,
        logger: logger.child("summarization"),
      })
    : null;

  // Build the mirror topology once from config. Non-empty only in agents mode
  // with at least one agent carrying summaries_from. In legacy mode the list is
  // empty and the mirror worker is never constructed.
  const mirrorEntries = buildMirrorTopology(config);
  const mirrorWorker = (summarizationPool && mirrorEntries.length > 0)
    ? new MirrorWorker({
        storage,
        store: timeline,
        config: config.summarization ?? {},
        tiers: config.context.tiers,
        mirrorEntries,
        indexer: null, // injected below via setIndexer
        notifyDiaryPool: () => diaryPool?.notifyNewWork(),
        logger: logger.child("mirror-worker"),
      })
    : null;
  // Populate the lazy reference immediately so pool closures resolve correctly.
  mirrorWorkerRef = mirrorWorker;

  // Eager level-1 summarization (spec §7.1/§7.3): a per-timeline reconciliation
  // indexer owns the generation-threshold evaluation, fired off the persist seam
  // and the pool's completion callback (plus a startup sweep below). The context
  // builder no longer creates jobs — ingestion writes them, builds consume them.
  const summarizationIndexer = summarizationPool
    ? new SummarizationIndexer({
        storage,
        store: timeline,
        config: config.summarization ?? {},
        tiers: config.context.tiers,
        onJobEnqueued: () => summarizationPool.notifyNewWork(),
        isMirroredTimeline: mirrorWorker
          ? (tk) => mirrorWorker.isMirroredTimeline(tk)
          : undefined,
        logger: logger.child("summarization-indexer"),
      })
    : null;

  // Inject the indexer into the mirrorWorker (breaks the circular dependency:
  // mirrorWorker must exist before indexer so its isMirroredTimeline callback can
  // be passed as an option, but the indexer must exist before mirrorWorker can
  // call reconcileTimeline for wait-or-omit escalation and liveness flip).
  if (mirrorWorker && summarizationIndexer) {
    mirrorWorker.setIndexer(summarizationIndexer);
  }

  if (summarizationPool) {
    // Priority inheritance (spec §5.5): one injected callback does all three
    // writes — job row, scheduler entry, pool wake — with the escalate-vs-
    // terminal race guard (a late scheduler escalation after clearEscalation
    // would otherwise leak a permanent sticky entry). See createEscalateSummary.
    contextBuilder.escalateSummary = createEscalateSummary({
      storage,
      escalateScheduled: (key, priority) => llmScheduler.escalate(key, priority),
      notifyPool: () => summarizationPool.notifyNewWork(),
      logger,
    });

    // Wait-or-omit's coverage re-check (spec §7.2/§7.3 / §10b): for ordinary
    // timelines, run ONE awaited indexer reconcile. For mirrored timelines,
    // reconcile the DONOR's timeline instead — interactive pressure crosses the
    // link so the donor produces the covering summary (spec §10b wait-or-omit).
    contextBuilder.reconcileSummaries = (timelineKey) => {
      // Determine which timeline to reconcile
      let reconcileKey = timelineKey;
      if (mirrorWorker?.isMirroredTimeline(timelineKey)) {
        const donorKey = mirrorWorker.resolveDonorTimeline(timelineKey);
        if (donorKey) reconcileKey = donorKey;
      }
      return summarizationIndexer!.reconcileTimeline(reconcileKey).catch((error) => {
        logger.error("summary_reconcile_for_build_failed", {
          timelineKey,
          reconcileKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
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

  // Proactive posting (ARCHITECTURE.md §9g). Same fail-fast validation as the
  // worker pools: when opted in (enabled + ≥1 channel), the configured session
  // type and its model must exist, so a misconfigured proactive run can't silently
  // fall back to the default chat agent.
  if (config.proactive?.enabled === true && (config.proactive.channels?.length ?? 0) > 0) {
    const typeName = config.proactive.session_type ?? "proactive";
    const sessionType = config.agent.session_types?.[typeName];
    if (!sessionType) {
      throw new Error(
        `proactive posting enabled but session type "${typeName}" is not configured under [agent.session_types]`,
      );
    }
    const modelKey = sessionType.model ?? "default";
    if (!config.models[modelKey]) {
      throw new Error(
        `proactive session type "${typeName}" references model "${modelKey}" which is not in config.models`,
      );
    }
  }

  // Resumable sessions (spec RESUMABLE-SESSIONS §14): cross-field checks the
  // TypeBox schema can't express (the scope enum is already schema-enforced).
  // Mirrors the proactive pattern — fail-fast on impossibilities, warn on
  // dead/inert config.
  {
    const resume = config.agent.sessions.resume;
    if (resume) {
      for (const ctx of ["dm", "group"] as const) {
        const gap = resume.gap?.[ctx];
        // Hard rule (§9.3): a context's gap budget is never BOTH unlimited — that
        // would let a single resume drag the entire room history into the rollout.
        if (gap && gap.max_messages === -1 && gap.max_tokens === -1) {
          throw new Error(
            `agent.sessions.resume.gap.${ctx}: max_messages and max_tokens cannot both be -1 (unlimited) — bound at least one`,
          );
        }
        // Inert-config warning: a gap configured to surface something for a context
        // where resume never runs is dead config (the default gap is 0/0, so this
        // only fires on a deliberate-but-stranded setting).
        const enabled = resume.enabled?.[ctx] === true;
        const gapActive = gap !== undefined && (gap.max_messages !== 0 || gap.max_tokens !== 0);
        if (!enabled && gapActive) {
          logger.warn("resume_config_inert_gap", {
            context: ctx,
            reason: `agent.sessions.resume.gap.${ctx} is configured but agent.sessions.resume.enabled.${ctx} is false — the gap will never be surfaced`,
          });
        }
      }
    }
  }

  // Follow-up folding (spec FOLLOWUP-FOLDING §9): cross-field checks the TypeBox
  // schema can't express. Same fail-fast convention as the resume block above.
  assertFollowupConfigValid(config.agent.sessions.followup);

  // Map a (per-room) timeline key to its account + room id and ask that account's
  // Human channel label — used by the diary header and the RoomLabelCache (which
  // feeds the observability console room list). Dispatches via the ChannelClient
  // abstraction so it works for any registered provider. Rejects on a malformed key
  // or absent provider; both callers retry and fall back to the room id, so a
  // failure never blocks a job.
  const resolveChannelLabel = async (timelineKey: string): Promise<string> => {
    const parsedKey = parseTimelineKey(timelineKey);
    const providerId = parsedKey?.provider;
    const accountId = parsedKey?.accountId;
    const roomId = parsedKey?.channelId;
    if (!roomId) throw new Error(`cannot resolve room id from timeline key "${timelineKey}"`);
    if (!providerId) throw new Error(`cannot resolve provider from timeline key "${timelineKey}"`);
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`cannot resolve channel label: provider "${providerId}" not registered`);
    const client = provider.channelClient({ provider: providerId, timelineKey, accountId });
    if (!client) throw new Error(`cannot resolve channel label: no channel client for "${timelineKey}"`);
    const info = await client.channelInfo();
    return info.label;
  };

  // Feed the context builder's <runtime_state> channel descriptor (label + DM
  // flag). Dispatches via the ChannelClient abstraction so it works for any
  // registered provider. Per the hook contract, never rejects: a malformed key,
  // absent provider, or lookup failure resolves to null and the Channel/Type lines
  // are simply omitted (the raw timeline key still identifies the channel).
  contextBuilder.resolveChannelContext = async (timelineKey) => {
    try {
      const parsedKey = parseTimelineKey(timelineKey);
      if (!parsedKey) return null;
      const provider = providers.get(parsedKey.provider);
      if (!provider) return null;
      const client = provider.channelClient({
        provider: parsedKey.provider,
        timelineKey,
        accountId: parsedKey.accountId,
      });
      if (!client) return null;
      const info = await client.channelInfo();
      return { label: info.label, isDirect: info.isDirect };
    } catch (error) {
      logger.debug("resolve_channel_context_failed", {
        timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  // Channel visibility resolver (ARCHITECTURE.md §9h). Fail-fast validation
  // is delegated to validateVisibilityChannels (defined in visibility/index.ts
  // so it's independently testable). Throws with a descriptive message on any
  // malformed key, :thread: suffix, or duplicate entry.
  const visibilityCfg = config.visibility as VisibilityConfig | undefined;
  validateVisibilityChannels(visibilityCfg);
  const visibilityResolver = new ChannelVisibilityResolver(visibilityCfg, logger.child("visibility"));

  const diaryPool = diaryEnabled
    ? new DiaryWorkerPool({
        storage,
        factory,
        memoryWriter,
        config: config.diary ?? {},
        workspaceRoot,
        // Per-job workspace resolver (spec MULTI-AGENT-SUPPORT §4.1/§4.3):
        // in agents mode each diary job resolves its own workspace root and
        // MemoryFileWriter from the summary's timeline_key, so diary entries
        // land in the correct agent's memory/ directory.
        resolveJobDeps: config.agents
          ? (timelineKey) => {
              const entry = resolveWorkspaceForTimeline(timelineKey);
              if (!entry) return undefined;
              return { workspaceRoot: entry.workspaceRoot, memoryWriter: entry.memoryWriter };
            }
          : undefined,
        // The diary header needs a human room label. The worker retries this and
        // falls back to the room id, so it never blocks a job.
        resolveChannelLabel,
        onComplete: (summaryId) => logger.info("diary_job_complete", { summaryId }),
        onError: (summaryId, error) => logger.error("diary_failed", { summaryId, error: error.message }),
        activityBus: pipelineActivityBus,
        // Budget claim gate (spec USAGE-COST-LIMITS §6.3): park while the diary
        // class is over budget. Diary depends on nothing, so this gates only diary.
        // Emits a rate-limited `usage_limit_blocked` log on pause (§6.4, review #2).
        shouldPause: makeAgentLoopClaimGate(["diary"]),
        // Channel visibility resolver (ARCHITECTURE.md §9h): terminalize jobs
        // for channels whose mode is not "shared" as `excluded`.
        visibilityResolver,
        logger: logger.child("diary"),
      })
    : null;

  // Tools made unavailable by EITHER mechanism: the explicit `agent.disabled_tools`
  // allowlist subtraction, or a capability feature gate (`[features]`) being off.
  // Both feed the single tool-set filter in buildSessionTools, so one code path owns
  // exclusion for every session type. Feature gates default OFF: with no `[features]`
  // table (or an absent key) the feature's tools are excluded here.
  const disabledTools = new Set(config.agent.disabled_tools ?? []);
  for (const tool of gatedOutFeatureTools(config.features)) {
    disabledTools.add(tool);
  }

  const mcpPool = new McpClientPool({
    servers: config.mcp?.servers ?? {},
    logger: logger.child("mcp"),
  });
  await mcpPool.start();
  // Build adapted tools and the exact tool-name → server-name attribution map
  // together so both are derived from the same source of truth. The map is
  // declared above (before the factory) so the factory and resolveToolDefs
  // closures both reference the same object and see it populated here.
  const mcpTools = [] as ReturnType<typeof adaptMcpTools>;
  for (const entry of mcpPool.getEntries()) {
    for (const tool of adaptMcpTools(entry.name, entry.tools, mcpPool, logger.child("mcp"))) {
      mcpTools.push(tool);
      mcpToolServerMap.set(tool.name, entry.name);
    }
  }
  // Per-agent MCP scoping observability (spec PER-AGENT-MCP-SCOPING §5):
  // one info log per agent with an explicit mcp_servers allowlist.
  if (config.agents) {
    for (const [agentName, block] of Object.entries(config.agents)) {
      if (block.mcp_servers !== undefined) {
        logger.info("mcp_agent_scoping", { agent: agentName, servers: block.mcp_servers });
      }
    }
  }

  // Caches resolved human room labels in `room_metadata` so the observability
  // console shows real room names instead of raw room ids. Populated lazily on
  // inbound activity (ensureLabel below) plus a throttled startup backfill.
  const roomLabels = new RoomLabelCache({
    store: storage,
    resolve: resolveChannelLabel,
    logger: logger.child("room-labels"),
  });

  // Startup gap backfetch (ARCHITECTURE.md §7c): recover room history missed while
  // offline. Constructed unconditionally — when disabled, `prepare()`/`run()` are
  // no-ops and `isFrozen()` is always false, so the wiring below adds no cost. The
  // `replayLiveInbound` closure re-enters the (hoisted) `handleInbound`, draining a
  // room's buffered live events through the normal pipeline once its gap is filled.
  const gapBackfetchConfig: GapBackfetchConfig = {
    enabled: config.timeline?.gap_backfetch_enabled ?? false,
    maxMessages: config.timeline?.gap_backfetch_max_messages ?? 0,
    windowMs: config.timeline?.gap_backfetch_window_ms ?? 0,
    timeoutMs: config.timeline?.gap_backfetch_timeout_ms ?? 0,
    pageSize: config.timeline?.gap_backfetch_page_size ?? 100,
    utdHaltThreshold: config.timeline?.gap_backfetch_utd_halt_threshold ?? 50,
    concurrency: config.timeline?.gap_backfetch_concurrency ?? 3,
  };
  // Gap backfetch self-ids: pre-seeded with Matrix ids (above, before providers IIFE)
  // and extended with Discord ids post-READY via onSelfResolved. The gapBackfetchSelfIds
  // Map is passed by reference to the coordinators below — mutations are live.
  const gapBackfetch = new GapBackfetchCoordinator({
    storage,
    timeline,
    config: gapBackfetchConfig,
    getClient: (accountId, roomId) => {
      if (!matrixProvider) throw new Error("gap backfetch requires a matrix provider");
      return makeBackfillReadClient(
        matrixProvider.getClient({ provider: "matrix", timelineKey: `matrix:${accountId}:`, accountId }),
        roomId,
      );
    },
    selfUserIds: gapBackfetchSelfIds,
    notifyEnrichment: (eventId) => enrichmentPool.notifyNewEvent(eventId),
    notifyCaptions: () => captionPool.notifyNewWork(),
    enqueueChatSearch: (eventId) => chatSearchIndexer.enqueueReconcileEvent(eventId),
    enqueueSummarization: (timelineKey) => summarizationIndexer?.enqueueReconcileTimeline(timelineKey),
    replayLiveInbound: (inbound) => {
      void handleInbound(inbound).catch((error) => {
        logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
      });
    },
    isDraining: () => draining,
    logger: logger.child("gap-backfetch"),
  });

  // Message-only history backfetch (ARCHITECTURE.md §7d): console-triggered jobs
  // that page history BELOW each room's context floor into the search-only region.
  // Shares the same per-account read client + self-id map as gap backfetch.
  const messageBackfetchConfig: MessageBackfetchConfig = {
    enabled: config.backfetch?.enabled ?? false,
    pageSize: config.backfetch?.page_size ?? 100,
    maxBacklog: config.backfetch?.max_backlog ?? 500,
    pageMinIntervalMs: config.backfetch?.page_min_interval_ms ?? 0,
    defaultSafetyCap: config.backfetch?.default_safety_cap ?? 0,
    defaultTimeoutMs: config.backfetch?.default_timeout_ms ?? 0,
    utdHaltThreshold: config.backfetch?.utd_halt_threshold ?? 50,
    captionBackfetched: config.backfetch?.caption_backfetched ?? false,
  };
  const messageBackfetch = new MessageBackfetchCoordinator({
    storage,
    timeline,
    config: messageBackfetchConfig,
    getClient: (accountId, roomId) => {
      if (!matrixProvider) throw new Error("message backfetch requires a matrix provider");
      return makeBackfillReadClient(
        matrixProvider.getClient({ provider: "matrix", timelineKey: `matrix:${accountId}:`, accountId }),
        roomId,
      );
    },
    selfUserIds: gapBackfetchSelfIds,
    notifyEnrichment: (eventId) => enrichmentPool.notifyNewEvent(eventId),
    notifyCaptions: () => captionPool.notifyNewWork(),
    enqueueChatSearch: (eventId) => chatSearchIndexer.enqueueReconcileEvent(eventId),
    isDraining: () => draining,
    logger: logger.child("message-backfetch"),
  });

  /**
   * Bot-chain cap gate (spec MULTI-AGENT-SUPPORT §9 "capped" mode, Phase 5b).
   *
   * Returns true (caller should return early — trigger suppressed) when:
   *  - the trigger sender is a sibling AND siblings.replies = "capped", AND the
   *    channel's bot-chain count has reached max_bot_chain; OR
   *  - the trigger sender is a genuine third-party Discord bot (isBot && !isWebhook)
   *    AND siblings.third_party_bots = "capped", AND the chain count is at the cap.
   *
   * Returns false in all other cases (trigger proceeds normally).
   *
   * Counting is knob-independent: the chain counter always counts self/sibling/
   * third-party-bot rows regardless of which knob is active. Webhook-authored
   * messages count as human and reset the window.
   *
   * Synchronous — uses storage.countBotChainLength (storage.read()) so it never
   * yields. Must remain no-await to preserve the serialization invariant before
   * triggerCoordinator.accept (CLAIM-VISIBILITY-SERIALIZATION §4.4).
   */
  function botChainCapGate(inbound: InboundChatEvent): boolean {
    const siblings = config.siblings;
    const repliesMode = siblings?.replies ?? "never";
    const thirdPartyMode = siblings?.third_party_bots ?? "unlimited";

    if (repliesMode !== "capped" && thirdPartyMode !== "capped") {
      return false; // neither capped knob active
    }

    const sender = inbound.trigger?.triggeredBy ?? inbound.event.sender;
    const isSibling = botSelfIdsForLimits.has(sender.id);
    const isThirdPartyBot = !isSibling && (sender.isBot === true) && (sender.isWebhook !== true);

    const needsChainCheck =
      (isSibling && repliesMode === "capped") ||
      (isThirdPartyBot && thirdPartyMode === "capped");

    if (!needsChainCheck) return false;

    const maxBotChain = siblings?.max_bot_chain ?? 4;
    // Scan limit: max_bot_chain + 1 gives us the worst-case row count we ever read.
    const chainLen = storage.countBotChainLength(
      inbound.timelineKey,
      botSelfIdsForLimits,
      maxBotChain + 1,
    );
    if (chainLen >= maxBotChain) {
      logger.info("bot_chain_cap_reached", {
        timelineKey: inbound.timelineKey,
        senderId: sender.id,
        isSibling,
        isThirdPartyBot,
        chainLen,
        maxBotChain,
      });
      return true; // suppress trigger — at cap
    }
    return false;
  }

  /**
   * True when the trigger sender is a sibling OR a third-party bot in "capped" mode.
   * Bot-triggered sessions skip Gate A (per-user limits) entirely — their spend is
   * attributed to deployment [[limits]] only, never to a per-user meter
   * (spec MULTI-AGENT-SUPPORT §9). Unlimited-mode third-party bots preserve today's
   * behaviour (Gate A runs, spend attributed). Factored out of the fresh-session and
   * reply-resume Gate A checks (both sites must agree).
   */
  function isBotTriggeredSender(inbound: InboundChatEvent): boolean {
    const triggerSender = inbound.trigger?.triggeredBy ?? inbound.event.sender;
    return (
      botSelfIdsForLimits.has(triggerSender.id) ||
      ((triggerSender.isBot === true) && (triggerSender.isWebhook !== true) &&
       (config.siblings?.third_party_bots ?? "unlimited") === "capped")
    );
  }

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

    // Startup gap backfetch freeze (ARCHITECTURE.md §7c §6.3): while a room's gap
    // is being filled, a normal live event is buffered (NOT persisted, enriched,
    // summarized, or evaluated for a trigger) and replayed through this same path
    // once the gap commits — upholding the §4 invariant that the committed
    // high-water never advances mid-fill. Placed after the edit/echo preamble:
    // edits apply in place / park in `pending_edits` (no high-water advance), and
    // self-echoes can't occur for a frozen room (its sessions are frozen too).
    if (gapBackfetch.isFrozen(inbound.timelineKey)) {
      gapBackfetch.bufferLive(inbound);
      return;
    }

    // Channel lifecycle gating (§2–§4): inactive timelines store cheaply until
    // the first trigger; activating timelines buffer triggers; only active/
    // backfilling timelines fall through to the normal path below. Delegated to
    // ActivationCoordinator (src/timeline/activation.ts).
    if ((await activationCoordinator.gateInbound(inbound)) === "handled") return;

    const enrichmentStatus = needsEnrichment(inbound.event) ? "pending" : "skipped";
    const routed = await router.route(inbound, enrichmentStatus);

    // Identity upsert (§6.5): data-presence-driven, no config knob. Only called
    // when the sender carries a `username` field — Discord does, Matrix never does.
    // With an empty `user_identities` table the Matrix path is GUARANTEED to be
    // byte-identical: this branch is dead for every Matrix event (no username set).
    // isSelf senders are included so operator-side bot renames are absorbed. Fires
    // for both new and duplicate events (a rename may happen between two copies of
    // the same external_id arriving on different gateways). Fire-and-forget through
    // the single-writer queue — a failure here must never stall the ingest path.
    if (inbound.event.sender.username) {
      void storage
        .upsertUserIdentity({
          provider: inbound.provider,
          userId: inbound.event.sender.id,
          username: inbound.event.sender.username,
          displayName: inbound.event.sender.displayName,
          observedAt: inbound.event.timestamp,
        })
        .catch((error) =>
          logger.warn("identity_upsert_failed", {
            provider: inbound.provider,
            userId: inbound.event.sender.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }

    // Eager summarization (spec §7.1): events just persisted — recompute the
    // timeline's un-summarized compact-tier size off the hot path and enqueue a
    // level-1 job the moment it crosses threshold. Fire-and-forget,
    // self-coalescing per timeline.
    summarizationIndexer?.enqueueReconcileTimeline(inbound.timelineKey);
    // Nudge enrichment BEFORE the steer check: a steered reply still returns
    // early below, but its persisted row needs resolving so a later context
    // rebuild / summarization renders the quoted message (not the placeholder).
    if (enrichmentStatus === "pending") {
      enrichmentPool.notifyNewEvent(inbound.event.id);
    }

    if (steerReplyToActiveSession(inbound)) return;

    // Follow-up folding (spec FOLLOWUP-FOLDING §6): a quick same-sender follow-up —
    // forced-split media, a trailing bare-text thought, or an amending re-`@` — is
    // folded into the session its immediately-prior triggering message produced
    // (steer / park / resume) instead of being lost, answered half-blind, or spawned
    // as a twin. Placed AFTER reply-steer (a reply to a running session still
    // interjects first; the fold skips replies entirely) and BEFORE the `!trigger`
    // return + accept, so it catches BOTH a group's non-triggering bare follow-up and
    // a trigger-bearing one (re-`@` / DM message) whose parallel spawn it suppresses.
    // Fully synchronous, so the accept→claim serialization invariant below is intact.
    if (foldFollowUp(inbound)) return;

    // Reply-to-bot as a trigger (spec RESUMABLE-SESSIONS §5) is resolved upstream in
    // the provider's trigger hold (`resolveReplyTrigger`), so a bare reply to one of
    // the bot's own completed messages already carries `inbound.trigger` here (with
    // the hold's debounce + same-sender grouping applied). The §7 fork in
    // launchSession then continues that session or gives a fresh response. Nothing
    // to synthesize at this point.
    if (!inbound.trigger) return;

    // Bot-chain cap gate (spec MULTI-AGENT-SUPPORT §9, Phase 5b).
    // Applied after trigger confirmation but before accept/claim so capped-out
    // triggers are dropped without claiming a coordinator slot.
    // Synchronous — uses storage.read() which never yields — so the no-await
    // invariant before triggerCoordinator.accept (SERIALIZATION INVARIANT §4.4)
    // is preserved.
    if (botChainCapGate(inbound)) return;

    // Co-target coalescing (spec DUPLICATE-REPLY-MITIGATION §5): a reply that
    // targets the SAME message a running session's trigger replied to is steered
    // into that session as a self-explaining co-reply interjection instead of
    // spawning a twin (Case B). Ordered after the existing reply-steer (which
    // handles a reply to a running session's OWN authored message) and before the
    // spawn decision (§5.1).
    if (coalesceCoTargetReply(inbound)) return;

    // Accept + claim run SYNCHRONOUSLY immediately after the coalesce check, with NO
    // `await` between them (review #5). The co-target coalesce decision above read
    // the registry keyed on `replyToExternalId` and found no owner; this is the point
    // that records THIS inbound as the co-target owner. Any event-loop yield in that
    // span would let a second, DISTINCT reply to the SAME target also pass coalesce
    // before either claims — both spawn, the bot replies twice (the send-time guard
    // keys on each trigger's OWN externalId, so it can't catch co-target siblings).
    // `resolveTriggerGroup` (the former yield) is therefore deferred to AFTER the
    // claim below; it mutates only `inbound.trigger.groupedEventIds` / persists the
    // group, which neither `accept` (truthiness of `inbound.trigger`, already held)
    // nor `addClaim`/`coalesceCoTargetReply` consume — only the later readiness wait
    // and launch do, all of which run after the claim.
    //
    // SERIALIZATION INVARIANT (spec CLAIM-VISIBILITY-SERIALIZATION §4.4, invariant
    // 3): for two trigger messages M₁ (earlier) then M₂ (later) on the SAME timeline,
    // M₁'s claim must land — and M₁'s session must become visible in
    // `activeForTimeline` — before M₂ reads either signal, so a later message never
    // sees an earlier one as unclaimed or not-running. This holds *only* because no
    // variable-latency / order-breaking `await` precedes the `accept → addClaim`
    // critical section on the active path: `gateInbound` returns "active" without
    // yielding, `router.route` resolves strictly FIFO on the single-writer queue, and
    // `steerReplyToActiveSession`/`coalesceCoTargetReply` are synchronous (reply-as-
    // trigger is resolved upstream in the provider's trigger hold, before handleInbound).
    // DO NOT introduce such an `await` between `handleInbound` entry and here — it
    // would let M₂ claim before M₁. `SessionClaims.claim` logs `claim_out_of_order`
    // as a cheap regression tripwire (advisory only). The *visible-before-wait* half
    // of the invariant is upheld downstream: `launchSession` reaches
    // `createPlaceholder`/`markRunning` (→ visible) BEFORE its own
    // `awaitTriggerReadiness` (§4.1), so a captioning-blocked session is still seen.
    const decision = triggerCoordinator.accept(inbound);
    // Claim the trigger SYNCHRONOUSLY here — immediately after accept, before any
    // `await` — so a concurrent inbound handler observes the claim even during the
    // accept→placeholder gap (spec §3.2/§3.3). Both spawn and queued claim; only
    // `ignored` (queue full) does not. The owning session id is backfilled in
    // launchSession, and the claim is released on settle.
    if (decision.action === "spawn" || decision.action === "queued") {
      addClaim(inbound);
    }

    // Resolve the trigger group and nudge captions AFTER the claim (was before
    // `accept` — moved per review #5 to close the coalesce→claim yield window). Still
    // runs for every accepted action (spawn / queued / ignored) before the early
    // return below, so a queued or ignored trigger gets its group persisted and its
    // grouped attachments captioned exactly as before; only the relative order of
    // these two `await`-free-span operations changed.
    await resolveTriggerGroup(inbound);
    captionPool.notifyNewWork();

    if (decision.action !== "spawn") {
      logger.info("trigger_not_spawned", {
        timelineKey: inbound.timelineKey,
        action: decision.action,
        reason: decision.reason,
        queueLength: decision.queueLength,
      });
      return;
    }

    try {
      // The readiness wait is NOT here any more — it was relocated INTO `launchSession`
      // (post-`createPlaceholder`/`markRunning`/claim-attach, post-budget, pre-build),
      // so the session is visible-as-running in `activeForTimeline` BEFORE it blocks on
      // enrichment/captions (spec CLAIM-VISIBILITY-SERIALIZATION §4.1). A sibling
      // session built during that wait now sees this one in `<active_sessions>` + the
      // `<coordination>` line, instead of a bare un-explained marker (the incident).
      await launchSession(inbound, routed.duplicate);
    } catch (error) {
      // Pre-attribution failure (review #2): release the just-added claim so it does
      // not leak un-attributed. A throw past attachSession already released via
      // settle, making this a no-op there.
      releaseClaimFor(inbound);
      // A throw BEFORE attachSession also means the settle-fallback was never
      // registered, so any co-replies parked on this trigger would be orphaned
      // (spec DEFERRED-COALESCING) — re-dispatch them here.
      if (inbound.event.externalId) redispatchPendingCoReplies(inbound.event.externalId);
      throw error;
    }
  }

  /**
   * Insert a session claim for an accepted trigger (spec DUPLICATE-REPLY-MITIGATION
   * §3.3). Synchronous and side-effect-free beyond the in-memory registry write, so
   * it can sit on the no-`await` path right after `triggerCoordinator.accept`. A
   * trigger with no external id (rare — synthetic/proactive) cannot be marked or
   * guarded, so it is not claimed. Carries the trigger's own external id (marker /
   * guard key) and its reply-target (co-target coalescing key).
   *
   * `opts.redispatch` is forwarded to {@link SessionClaims.claim} to suppress the
   * advisory `claim_out_of_order` warn on the designed re-dispatch path
   * (`redispatchCoReply` re-claims an older trigger after newer ones — review #4);
   * the active and activation `addClaim` callers must NOT pass it (they stay genuine
   * ordering points).
   */
  function addClaim(inbound: InboundChatEvent, opts?: { redispatch?: boolean }): void {
    const externalId = inbound.event.externalId;
    if (!externalId) return;
    sessionClaims.claim(
      inbound.timelineKey,
      {
        triggerId: inbound.event.id,
        externalId,
        replyToExternalId: inbound.event.replyTo?.externalId,
        triggerTimestamp: inbound.event.timestamp,
        createdAt: Date.now(),
      },
      opts,
    );
  }

  /**
   * Release the claim added by {@link addClaim} for a trigger that failed to reach
   * attribution (review #2). The claim is attributed + given its settle-release
   * inside `launchSession` (after `attachSession`); if anything throws in the
   * accept→attachSession span the claim would otherwise leak un-attributed until
   * shutdown — harmless before, but a permanent false-positive once un-attributed
   * claims deter (review #4). Idempotent — if the run already settled, its settle
   * listener released the claim; otherwise (a synchronous throw before the run
   * promise was constructed) this performs the release.
   */
  function releaseClaimFor(inbound: InboundChatEvent): void {
    const externalId = inbound.event.externalId;
    if (externalId) sessionClaims.releaseExternalId(inbound.timelineKey, externalId);
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
    // An edit changes the event's rendered size — re-evaluate the summarization
    // threshold too (spec §7.1).
    summarizationIndexer?.enqueueReconcileTimeline(result.event.timelineKey);

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

    const providerName = inbound.event.provider;
    const provider = providers.get(providerName);
    if (!provider) return;

    const accountId = target.accountId ?? parseTimelineKey(inbound.timelineKey)?.accountId;
    if (!accountId) return; // malformed key; can't proceed

    // §6.3: provider self identity. getSelf() is valid post-start(); for Discord
    // this is only populated after READY fires, so initial backfill runs after READY.
    const selfUserId = provider.getSelf(accountId)?.id;
    if (!selfUserId) {
      logger.warn("initial_backfill_skipped", { timelineKey: inbound.timelineKey, reason: "unknown_self_user", accountId });
      return;
    }

    // Build the BackfillReadClient: Matrix uses the channel client adaptor;
    // other providers (Discord) implement HistoryClient which is structurally
    // compatible with BackfillReadClient (same readMessages signature).
    let backfillClient: import("./backfill/paginate.js").BackfillReadClient | undefined;
    if (provider === matrixProvider && matrixProvider) {
      backfillClient = makeBackfillReadClient(matrixProvider.getClient(target), target.roomId);
    } else {
      // provider.history() returns a HistoryClient; for Discord this is also a
      // BackfillReadClient (DiscordHistoryClient implements both).
      backfillClient = provider.history?.(target) as import("./backfill/paginate.js").BackfillReadClient | undefined;
    }
    if (!backfillClient) return; // provider doesn't support paged history

    try {
      const result = await performInitialBackfill({
        client: backfillClient,
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
    // Attachment-event grouping is only meaningful on providers that enforce one
    // attachment per message (e.g. Matrix). Providers that allow multiple attachments
    // in a single send (e.g. Discord) don't need it — the user includes all
    // attachments in one message, so there's nothing to group across messages.
    if (!providers.get(inbound.event.provider)?.capabilities.singleAttachmentPerMessage) return;

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

  // A trigger-bearing reply reaches handleInbound TWICE: the provider's trigger
  // hold emits the event immediately with `trigger: undefined` (for ingestion)
  // and again after the hold window with the trigger populated (for the spawn
  // decision) — see `emitWithTriggerHold` / ARCHITECTURE.md §"Trigger hold". Both
  // deliveries carry the same `event.id` and both reach the steer check below, so
  // without dedup the interjection is injected into the live session twice (~2s
  // apart). A DM reply is *always* a trigger, so this fires on the common path.
  // Track recently-steered event ids (bounded FIFO) and steer at most once per
  // event; the second delivery still returns `true` to suppress the spawn path.
  const steeredEventIds = new Set<string>();
  const STEERED_EVENT_ID_CAP = 1024;
  function markSteered(eventId: string): void {
    steeredEventIds.add(eventId);
    if (steeredEventIds.size > STEERED_EVENT_ID_CAP) {
      // `Set` preserves insertion order — evict the oldest id.
      const oldest = steeredEventIds.values().next().value;
      if (oldest !== undefined) steeredEventIds.delete(oldest);
    }
  }

  function steerReplyToActiveSession(inbound: InboundChatEvent): boolean {
    const replyExternalId = inbound.event.replyTo?.externalId;
    if (!replyExternalId) return false;
    const activeIds = new Set(sessions.activeForTimeline(inbound.timelineKey).map((session) => session.id));
    if (activeIds.size === 0) return false;
    const target = timeline.getByExternalId(inbound.provider, replyExternalId, inbound.timelineKey);
    if (target?.timelineKey !== inbound.timelineKey) return false;
    if (!target?.agentSessionId || !activeIds.has(target.agentSessionId)) return false;

    // The trigger-hold re-delivery already steered this event on its immediate
    // emission. Suppress the spawn (return true) but do not re-inject.
    if (steeredEventIds.has(inbound.event.id)) return true;

    // The steered (injected) turn bypasses the trigger path's enrichment-readiness
    // wait + hydrateEvents, so `inbound.event.replyTo` carries only `externalId`.
    // Hydrate the resolved target and fill the reply context so the interjection
    // quotes the original message just like the normal trigger path would.
    const eventForRender = buildReplyHydratedEvent(inbound, target);

    const ok = sessions.steer(
      target.agentSessionId,
      {
        type: "interjection",
        content: renderRichMessage(eventForRender),
      },
      {
        eventId: inbound.event.id,
        externalId: inbound.event.externalId,
        senderId: inbound.event.sender.id,
        senderDisplayName: inbound.event.sender.displayName,
        kind: "reply",
        body: inbound.event.body ?? "",
      },
    );
    if (ok) {
      markSteered(inbound.event.id);
      logger.info("reply_steered", {
        sessionId: target.agentSessionId,
        timelineKey: inbound.timelineKey,
        eventId: inbound.event.id,
      });
    }
    return ok;
  }

  /**
   * Fill an inbound reply event's `replyTo` from its resolved (hydrated) target so
   * a steered interjection quotes the original message (captions/media included),
   * instead of rendering "[original message unavailable]". Shared by the existing
   * reply-steer and the new co-target coalescing path (spec
   * DUPLICATE-REPLY-MITIGATION §5.3). The steer paths bypass the trigger path's
   * enrichment-readiness wait + `hydrateEvents`, so the raw `replyTo` carries only
   * an `externalId`.
   *
   * `baseEvent` defaults to the raw `inbound.event`. The image co-reply steer passes
   * the HYDRATED stored event (`followUpHydratedEvent`) so the co-reply's OWN image
   * attachments carry `localPath` — needed to condition them into pixels AND to mark
   * them `image_block` on the very object that is rendered (review #1).
   */
  function buildReplyHydratedEvent(
    inbound: InboundChatEvent,
    target: CanonicalChatEvent,
    baseEvent: CanonicalChatEvent = inbound.event,
  ): CanonicalChatEvent {
    const [hydratedTarget] = hydrateEvents(storage, [target]);
    return {
      ...baseEvent,
      replyTo: {
        ...inbound.event.replyTo,
        externalId: inbound.event.replyTo?.externalId,
        sender: hydratedTarget.sender,
        body: hydratedTarget.body,
        htmlBody: hydratedTarget.htmlBody,
        timestamp: hydratedTarget.timestamp,
        attachments: hydratedTarget.attachments,
        linkedMedia: hydratedTarget.linkedMedia,
        linkPreviews: hydratedTarget.linkPreviews,
      },
    };
  }

  /**
   * Co-target coalescing (spec DUPLICATE-REPLY-MITIGATION §5). A new trigger that
   * is a reply, whose reply-target equals the reply-target of a currently-running
   * session's OWN trigger (a `coTargetSession` hit) and falls within the coalesce
   * window, is steered into that session as a self-explaining `co-reply`
   * interjection instead of spawning a twin (Case B). Returns true when it
   * coalesced (caller returns, no spawn); false to fall through to the normal spawn
   * path — including when the steer fails because the target session is already
   * settling (§5.2: a fresh session built after the sibling settles sees its
   * replies, so redundancy is still deterred at the content level).
   */
  function coalesceCoTargetReply(inbound: InboundChatEvent): boolean {
    const replyTarget = inbound.event.replyTo?.externalId;
    if (!replyTarget) return false; // not a reply — co-target N/A (no log: high volume)

    // Every OTHER exit logs why this reply did not fold into a sibling session, with
    // a `reason` discriminator. The silent false-returns here are exactly why the
    // duplicate-session incident couldn't be root-caused from logs (notably the
    // `disabled` case — co-target was off because `coalesce_window_ms` was dropped in
    // the config merge). Fires only for replies, so it stays low-volume.
    const noCoalesce = (reason: string, extra?: Record<string, unknown>): false => {
      logger.info("co_target_not_coalesced", {
        reason,
        timelineKey: inbound.timelineKey,
        eventId: inbound.event.id,
        replyTarget,
        ...extra,
      });
      return false;
    };

    const windowMs = config.agent.sessions.coalesce_window_ms;
    if (windowMs === undefined) return noCoalesce("disabled");

    // The match is the FIRST claim (any attribution) whose own trigger replied to the
    // same beat — including an un-attributed (queued / pre-launch) one (spec
    // DEFERRED-COALESCING).
    const match = sessionClaims.coTargetClaim(inbound.timelineKey, replyTarget);
    if (!match) return noCoalesce("no_sibling");
    // Only near-simultaneous reactions to the SAME beat merge — bare proximity
    // would wrongly fold the independent questions of Case A.
    const deltaMs = Math.abs(inbound.event.timestamp - match.triggerTimestamp);
    if (deltaMs > windowMs) {
      return noCoalesce("outside_window", { ownerSessionId: match.sessionId, deltaMs, windowMs });
    }

    // Trigger-hold re-delivery dedup (shared with reply-steer): inject at most once.
    if (steeredEventIds.has(inbound.event.id)) return true;

    // Owner already live → steer the co-reply in now (Case B, immediate).
    if (match.sessionId) {
      const ownerSessionId = match.sessionId;
      // An image-bearing co-reply into a LIVE owner carries real pixels (§3), which
      // needs async conditioning — commit synchronously (markSteered, suppress the
      // twin) and finish off the serialization path via `steerCoReplyWithPixels`,
      // mirroring the media follow-up steer. The text fast-path (the common case) stays
      // fully synchronous below. A pre-live owner with an image co-reply falls through
      // to `trySteerCoReply` → "not-live" → the defer/park path, and the parked image
      // is conditioned at drain time (`drainPendingCoRepliesIntoSession`).
      if (hasImageAttachment(inbound.event) && sessions.getAgent(ownerSessionId)) {
        const target = timeline.getByExternalId(inbound.provider, replyTarget, inbound.timelineKey);
        // Cannot hydrate the quote → spawn rather than inject a broken interjection.
        if (!target || target.timelineKey !== inbound.timelineKey) return false;
        markSteered(inbound.event.id);
        void steerCoReplyWithPixels(ownerSessionId, inbound, target).catch((error) => {
          logger.error("co_reply_image_steer_threw", {
            sessionId: ownerSessionId,
            eventId: inbound.event.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return true;
      }
      const outcome = trySteerCoReply(ownerSessionId, inbound);
      if (outcome === "steered") return true;
      // Cannot hydrate the quote → spawn rather than inject a broken interjection.
      if (outcome === "no-target") return noCoalesce("no_hydration_target", { ownerSessionId: match.sessionId });
      // outcome === "not-live": owner attributed but not steerable. Defer only if it
      // is still in its build window (will go live); a terminal/settling owner →
      // spawn (§5.2 — a fresh session built after it settles sees its replies).
      const ownerStatus = sessions.get(match.sessionId)?.status;
      if (!coTargetOwnerSteerableSoon(true, ownerStatus)) {
        return noCoalesce("owner_settling", { ownerSessionId: match.sessionId, ownerStatus });
      }
    } else {
      // Un-attributed owner (queued / accept→launch window): it WILL launch. Only
      // defer if the shared target exists so the interjection can hydrate at drain.
      const target = timeline.getByExternalId(inbound.provider, replyTarget, inbound.timelineKey);
      if (!target || target.timelineKey !== inbound.timelineKey) return noCoalesce("no_hydration_target");
    }

    // Defer: suppress the spawn now, park keyed by the OWNER trigger's external id,
    // and steer in when that owner goes live (or re-dispatch if it is abandoned).
    markSteered(inbound.event.id);
    const parked = pendingCoReplies.get(match.externalId) ?? [];
    parked.push(inbound);
    pendingCoReplies.set(match.externalId, parked);
    logger.info("co_reply_deferred", {
      ownerTriggerExternalId: match.externalId,
      ownerSessionId: match.sessionId,
      timelineKey: inbound.timelineKey,
      eventId: inbound.event.id,
      replyTarget,
    });
    return true;
  }

  /**
   * Build the self-explaining `co-reply` interjection body for a co-target reply
   * folded into a sibling session (spec §5.4 / DEFERRED-COALESCING).
   */
  function buildCoReplyInterjection(
    inbound: InboundChatEvent,
    target: NonNullable<ReturnType<TimelineStore["getByExternalId"]>>,
    // Optional prebuilt hydrated event to render. The image steer
    // (`steerCoReplyWithPixels`) builds it ONCE so the same object is conditioned,
    // marked (`markEventImageBlocks`), and rendered here — otherwise marking a
    // separately-built object would be a no-op (review #1). The synchronous text path
    // omits it and rebuilds internally (no pixels to mark).
    prebuiltEventForRender?: CanonicalChatEvent,
  ): string {
    const eventForRender = prebuiltEventForRender ?? buildReplyHydratedEvent(inbound, target);
    // §6.2: human-facing label uses `username ?? id` as the fallback.
    const senderName = inbound.event.sender.displayName ?? inbound.event.sender.username ?? inbound.event.sender.id;
    const externalId = inbound.event.externalId;
    return (
      `<interjection reason="co-reply">\n` +
      `${escapeXml(senderName)} replied to the same message you're answering:\n\n` +
      `${renderRichMessage(eventForRender)}\n\n` +
      `Handle it as part of this session if it fits here (sending a second message is fine) — ` +
      (externalId
        ? `or, if it warrants being worked independently, call spawn_session with message_id="${escapeAttr(externalId)}" to give it its own session.`
        : `or, if it warrants being worked independently, handle it separately.`) +
      `\n</interjection>`
    );
  }

  /**
   * Attempt to steer a co-reply into a live sibling session as an interjection.
   * Returns `"steered"` on success (and retains the inbound for `spawn_session`),
   * `"no-target"` when the shared reply-target is missing (cannot hydrate the quote),
   * or `"not-live"` when the session is not steerable (settling, or still pre-live).
   */
  function trySteerCoReply(
    coReplySessionId: string,
    inbound: InboundChatEvent,
  ): "steered" | "no-target" | "not-live" {
    const replyTarget = inbound.event.replyTo?.externalId;
    const target = replyTarget
      ? timeline.getByExternalId(inbound.provider, replyTarget, inbound.timelineKey)
      : undefined;
    if (!target || target.timelineKey !== inbound.timelineKey) return "no-target";

    const content = buildCoReplyInterjection(inbound, target);
    // Pass the interjection source so it is indexed for the timeline→session debug
    // path (master ef173b1).
    const steered = sessions.steer(
      coReplySessionId,
      { type: "interjection", content },
      {
        eventId: inbound.event.id,
        externalId: inbound.event.externalId,
        senderId: inbound.event.sender.id,
        senderDisplayName: inbound.event.sender.displayName,
        kind: "co-reply",
        body: inbound.event.body ?? "",
      },
    );
    if (!steered) return "not-live";

    markSteered(inbound.event.id);
    retainCoReplyForSpawn(inbound, coReplySessionId);
    logger.info("co_reply_coalesced", {
      sessionId: coReplySessionId,
      timelineKey: inbound.timelineKey,
      eventId: inbound.event.id,
      replyTarget,
    });
    return "steered";
  }

  /**
   * Retain a co-reply inbound so its sibling session can spin it off via
   * `spawn_session` (spec §5.4), cleaning up when that session settles. Shared by the
   * synchronous text steer (`trySteerCoReply`) and the async image steer
   * (`steerCoReplyWithPixels`).
   */
  function retainCoReplyForSpawn(inbound: InboundChatEvent, coReplySessionId: string): void {
    const externalId = inbound.event.externalId;
    if (!externalId) return;
    coReplyInbounds.set(externalId, { inbound, intoSessionId: coReplySessionId });
    sessions.onSettle(coReplySessionId, () => coReplyInbounds.delete(externalId));
    // Race guard: `onSettle` fires nothing if the session ALREADY settled (evicted)
    // between the steer and this registration — clean up the just-stored entry so it
    // can't linger until shutdown. The check is "record gone" (`!sessions.get`), NOT
    // `isAgentLive`: the success drain (DEFERRED-COALESCING) calls this right after
    // `attachAgent` but BEFORE `runner.run()`, where the steer succeeds yet
    // `agent.signal` is still undefined — `isAgentLive` would be false there and
    // wrongly drop the entry, silently breaking the `spawn_session` affordance the
    // interjection advertises. A still-present record (running, or interrupted-
    // pending-evict) fires `onSettle` later, so the entry is correctly retained.
    if (!sessions.get(coReplySessionId)) coReplyInbounds.delete(externalId);
  }

  /**
   * Steer an IMAGE-bearing co-reply into a live sibling session carrying real pixels
   * (spec FOLLOWUP-FOLDING §3). The synchronous `trySteerCoReply` cannot — it runs on
   * the accept→claim serialization path and pixel conditioning is async — so the image
   * case is committed synchronously (`markSteered`) by the caller and finished here off
   * the hot path, mirroring `steerFollowUp`: wait the co-reply's own image DOWNLOAD
   * (NOT captioning — the slow pool, irrelevant to pixels; the event is still captioned
   * normally for history), condition the pixels, then steer; on a conditioning miss
   * steer caption-only rather than block. If the owner settled before the inject lands,
   * re-dispatch the co-reply as its own session (the async analogue of the synchronous
   * "not-live → spawn" fallback).
   */
  async function steerCoReplyWithPixels(
    coReplySessionId: string,
    inbound: InboundChatEvent,
    target: CanonicalChatEvent,
  ): Promise<void> {
    await awaitEnrichmentComplete(inbound.event.id, config.enrichment?.trigger_wait_timeout_ms ?? 30_000);
    // Build the rendered event ONCE (off the hydrated stored event so the co-reply's
    // own image attachments carry `localPath`), then condition + mark + render the SAME
    // object — marking a separately-built copy would be a no-op (review #1). The
    // synchronous text path (`buildCoReplyInterjection` with no prebuilt event) rebuilds
    // its own; here pixels exist so the marked object must be the rendered one.
    const eventForRender = buildReplyHydratedEvent(inbound, target, followUpHydratedEvent(inbound));
    let imageBlocks: ImageBlock[] | undefined;
    try {
      const coReplySessionType = sessions.get(coReplySessionId)?.sessionType ?? "default";
      // Resolve the per-agent model's vision capability (spec PER-AGENT-MODEL-OVERRIDES
      // FIX 6): use inbound.timelineKey to pick the agent, then look up the model.
      const coReplyModelKey = factory.resolveLogicalModelId(coReplySessionType, inbound.timelineKey);
      const coReplySeesImages =
        (config.models[coReplyModelKey] ?? config.models.default)?.input_modalities?.includes("image") ?? false;
      const blocks = await contextBuilder.conditionEventImages(
        eventForRender,
        factory.resolveSessionType(coReplySessionType),
        coReplySeesImages,
      );
      if (blocks.length > 0) {
        imageBlocks = blocks;
        contextBuilder.markEventImageBlocks([eventForRender], blocks);
      }
    } catch (error) {
      // No-pixels branch (mirrors steerFollowUp): caption-only steer rather than block.
      logger.warn("co_reply_image_condition_failed", {
        coReplySessionId,
        eventId: inbound.event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const content = buildCoReplyInterjection(inbound, target, eventForRender);
    const steered = sessions.steer(
      coReplySessionId,
      { type: "interjection", content, ...(imageBlocks ? { imageBlocks } : {}) },
      {
        eventId: inbound.event.id,
        externalId: inbound.event.externalId,
        senderId: inbound.event.sender.id,
        senderDisplayName: inbound.event.sender.displayName,
        kind: "co-reply",
        body: inbound.event.body ?? "",
      },
    );
    if (!steered) {
      // Owner settled during the download wait → re-dispatch as its own session.
      void redispatchCoReply(inbound).catch((error) => {
        logger.error("co_reply_redispatch_failed", {
          timelineKey: inbound.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    retainCoReplyForSpawn(inbound, coReplySessionId);
    logger.info("co_reply_coalesced", {
      sessionId: coReplySessionId,
      timelineKey: inbound.timelineKey,
      eventId: inbound.event.id,
      replyTarget: inbound.event.replyTo?.externalId,
      pixels: imageBlocks !== undefined,
    });
  }

  /**
   * Steer every co-reply parked on an owner trigger into that owner's now-live
   * session (spec DEFERRED-COALESCING — the success drain, called from
   * `launchSession` after `attachAgent`). A co-reply that can no longer be steered
   * (e.g. its hydration target vanished) is re-dispatched as its own trigger rather
   * than dropped. Consumes the parked entries.
   */
  function drainPendingCoRepliesIntoSession(ownerTriggerExternalId: string, sessionId: string): void {
    const parked = pendingCoReplies.get(ownerTriggerExternalId);
    if (!parked) return;
    pendingCoReplies.delete(ownerTriggerExternalId);
    for (const inbound of parked) {
      // A parked IMAGE co-reply carries real pixels too (§3): condition + steer off the
      // hot path (the synchronous `trySteerCoReply` cannot await conditioning).
      // `steerCoReplyWithPixels` re-dispatches itself on a steer failure, so only its
      // own missing-hydration-target case needs the inline redispatch here.
      if (hasImageAttachment(inbound.event)) {
        const replyTarget = inbound.event.replyTo?.externalId;
        const target = replyTarget
          ? timeline.getByExternalId(inbound.provider, replyTarget, inbound.timelineKey)
          : undefined;
        if (target && target.timelineKey === inbound.timelineKey) {
          void steerCoReplyWithPixels(sessionId, inbound, target).catch((error) => {
            logger.error("co_reply_image_steer_threw", {
              sessionId,
              eventId: inbound.event.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          continue;
        }
        // No hydration target → re-dispatch as its own session (cannot render the quote).
        void redispatchCoReply(inbound).catch((error) => {
          logger.error("co_reply_redispatch_failed", {
            timelineKey: inbound.timelineKey,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        continue;
      }
      if (trySteerCoReply(sessionId, inbound) !== "steered") {
        void redispatchCoReply(inbound).catch((error) => {
          logger.error("co_reply_redispatch_failed", {
            timelineKey: inbound.timelineKey,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  /**
   * Re-dispatch every co-reply parked on an owner trigger as its own trigger (spec
   * DEFERRED-COALESCING — the fallback when the owner is abandoned before going live:
   * fired from the owner's settle listener and the pre-attribution catch). Never
   * drops a parked reply. Consumes the parked entries.
   */
  function redispatchPendingCoReplies(ownerTriggerExternalId: string): void {
    const parked = pendingCoReplies.get(ownerTriggerExternalId);
    if (!parked) return;
    pendingCoReplies.delete(ownerTriggerExternalId);
    for (const inbound of parked) {
      void redispatchCoReply(inbound).catch((error) => {
        logger.error("co_reply_redispatch_failed", {
          timelineKey: inbound.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Re-dispatch a coalesced co-reply into its own session (spec
   * DUPLICATE-REPLY-MITIGATION §5.4 — the `spawn_session` tool). Bound per session:
   * only a co-reply that was coalesced INTO `requestingSessionId` can be spun off.
   * Runs the spawn tail (trigger-group resolution, accept + claim, readiness wait,
   * launch); a concurrency miss queues like any trigger (open question §9.1(a)),
   * and a full queue returns an error so the session handles it inline.
   */
  async function spawnCoReplySession(
    messageId: string,
    requestingSessionId: string,
  ): Promise<SpawnCoReplyResult> {
    const entry = coReplyInbounds.get(messageId);
    if (!entry || entry.intoSessionId !== requestingSessionId) return { status: "not_found" };
    coReplyInbounds.delete(messageId);
    return redispatchCoReply(entry.inbound);
  }

  /**
   * Run the spawn tail for a co-reply inbound: trigger-group resolution, accept +
   * claim, readiness wait, fire-and-forget launch (spec §5.4 / DEFERRED-COALESCING).
   * Shared by `spawn_session` (a session spinning a coalesced reply off explicitly)
   * and the deferral fallback (an owner abandoned before it could absorb the parked
   * reply). A concurrency miss queues like any trigger; a full queue returns an error.
   */
  async function redispatchCoReply(inbound: InboundChatEvent): Promise<SpawnCoReplyResult> {
    try {
      await resolveTriggerGroup(inbound);
      captionPool.notifyNewWork();
      const decision = triggerCoordinator.accept(inbound);
      if (decision.action === "spawn" || decision.action === "queued") {
        // Re-dispatch re-claims this co-reply's ORIGINAL (older) trigger after newer
        // triggers have already claimed the timeline, so flag it to skip the advisory
        // `claim_out_of_order` warn — this is a designed out-of-order insert, not a
        // serialization regression (spec CLAIM-VISIBILITY-SERIALIZATION §4.4, review #4).
        addClaim(inbound, { redispatch: true });
      }
      if (decision.action === "queued") return { status: "queued" };
      if (decision.action !== "spawn") {
        return { status: "error", detail: decision.reason ?? "trigger not accepted" };
      }
      // No readiness wait here — it now lives inside `launchSession`, after the
      // session is registered (visible) + admitted and before its build (spec
      // CLAIM-VISIBILITY-SERIALIZATION §4.1). The calling session no longer blocks on
      // the spun-off co-reply's captioning; the co-reply's own run waits for it.
      // Fire-and-forget the run (the calling session continues its own work). On a
      // synchronous launch failure, release the slot + drain the next queued trigger
      // just like every other launch site.
      void launchSession(inbound, false).catch((error) => {
        // Pre-attribution launch failure (review #2): release the claim added above
        // so it cannot leak un-attributed (idempotent past attachSession).
        releaseClaimFor(inbound);
        logger.error("co_reply_spawn_launch_failed", {
          timelineKey: inbound.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        drainNextQueuedTrigger(inbound.timelineKey);
      });
      return { status: "spawned" };
    } catch (error) {
      // Pre-attribution failure (review #2): release the claim added after accept so
      // it does not leak un-attributed.
      releaseClaimFor(inbound);
      // A throw before attachSession orphans any co-replies parked on this trigger
      // (spec DEFERRED-COALESCING) — re-dispatch them.
      if (inbound.event.externalId) redispatchPendingCoReplies(inbound.event.externalId);
      return { status: "error", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // ─── Follow-up folding (spec FOLLOWUP-FOLDING) ─────────────────────────────
  // A quick same-sender follow-up — a forced-split image, a trailing bare-text
  // thought, or an amending re-`@` — is folded into the session its immediately-prior
  // triggering message produced: STEERED in if it is running, PARKED if it is still
  // building, or RESUMED if it just completed. The synchronous `foldFollowUp` fork
  // (in `handleInbound`, after reply-steer and before the `!trigger` return / accept)
  // makes the decision; the deliveries run async, never blocking the dispatch path.

  /** One folded follow-up's unit of work: the event, its lever, and the
   *  user-perceived gap (origin-ts diff) captured at fold time for the §10 text. */
  interface FollowUpDelivery {
    inbound: InboundChatEvent;
    form: FollowUpForm;
    gapMs: number;
  }

  /**
   * Arm (or replace) the follow-up watch so a sender's next quick follow-up folds
   * into `sessionId` (spec §4.1/§7). Called at the claim-attribution seam in BOTH
   * the fresh launch and the resume runner — after the resume-vs-fresh fork resolves
   * — so it always names the session that actually handled the trigger. Skips
   * proactive launches (caller-guarded) and any trigger without a human external id
   * (synthetic) — neither has a human follow-up to fold.
   *
   * This seam is *before* the missing-target / budget-admission gates that may
   * `markDiscarded` the just-launched session, so a watch can briefly name a session
   * that never goes live (up to the GC lifetime). That is harmless: a fold against a
   * discarded session finds the record gone and the durable row not `completed`, so
   * `resolveFollowUpRoute` yields `none` → native fate. Arming here (not after
   * `attachAgent`) is deliberate — it is the CLAIM-VISIBILITY window the fold targets.
   */
  function armFollowUpWatch(inbound: InboundChatEvent, sessionId: string): void {
    if (!followUpActive) return;
    const senderId = inbound.event.sender.id;
    if (!senderId || inbound.event.sender.isSelf || !inbound.event.externalId) return;
    followUpWatch.arm(inbound.timelineKey, senderId, {
      sessionId,
      triggerOriginTs: inbound.event.timestamp,
      armedAtWallClock: Date.now(),
    });
  }

  /**
   * The synchronous fold fork (spec §6). Returns true when the follow-up was consumed
   * (steered / parked / resume-dispatched, or its trigger-hold twin suppressed) — the
   * caller returns without spawning. Returns false to fall through to the normal path
   * (native fate): a reply, a non-matching event, the RAW delivery of a trigger-bearing
   * follow-up (folded later on its post-hold delivery), or a settled-but-unresumable
   * owner. Fully synchronous so it preserves the accept→claim serialization invariant;
   * the actual steer/resume work is fired as detached promises.
   */
  function foldFollowUp(inbound: InboundChatEvent): boolean {
    if (!followUpActive) return false;
    // The fold is the SAME-SENDER axis: replies keep their existing routing
    // (reply-steer above, co-target coalescing / reply-resume downstream).
    if (inbound.event.replyTo?.externalId) return false;
    if (inbound.event.sender.isSelf) return false;
    const senderId = inbound.event.sender.id;
    if (!senderId) return false;
    const watch = followUpWatch.get(inbound.timelineKey, senderId);
    if (!watch) return false;

    // Trigger-hold double-delivery dedup (shared with reply-steer / co-reply): a
    // trigger-bearing follow-up reaches handleInbound twice. We fold it on its
    // POST-HOLD delivery (which carries `inbound.trigger`, so native-fate reversion
    // has a real trigger to re-dispatch); the earlier RAW delivery (trigger stripped)
    // is skipped here and falls through to `!inbound.trigger → inert`. A bare GROUP
    // follow-up has only one (raw) delivery and is never trigger-bearing.
    const wouldTrigger =
      channelTypeOf(inbound) === "dm" || (inbound.event.mentions?.mentionedSelf ?? false);
    if (wouldTrigger && !inbound.trigger) return false;
    if (steeredEventIds.has(inbound.event.id)) return true;

    const form = classifyFollowUpForm(inbound.event);
    const passes = followUpGateDecision({
      form,
      config: followUpConfig,
      triggerOriginTs: watch.triggerOriginTs,
      followUpOriginTs: inbound.event.timestamp,
      armedAtWallClock: watch.armedAtWallClock,
      now: Date.now(),
    });
    if (!passes) return false;

    const gapMs = Math.abs(inbound.event.timestamp - watch.triggerOriginTs);
    const delivery: FollowUpDelivery = { inbound, form, gapMs };
    const record = sessions.get(watch.sessionId);

    // Belt-and-suspenders (§6 #1): if the live owner already grouped this event into
    // its trigger turn (the 2s hold), it is turn-1 content, not a follow-up — leave it.
    // Structurally impossible given arm-after-launch, but cheap to assert.
    if (record?.trigger.event.trigger?.groupedEventIds?.includes(inbound.event.id)) return false;

    // The owner's liveness at fold time picks the delivery route (spec §5 / §2 table),
    // extracted as a pure decision so the precedence is unit-testable. A live
    // `created`/`running` record steers (if its agent is attached) or parks; an owner
    // gone from memory resumes iff its durable row is `completed` (the only
    // fold-resumable state, §5.3/§7.2) — a discarded/interrupted/failed/pruned row, or
    // a never-launched one, yields `none`.
    //
    // Settle-window discrimination (review issue #3): `markCompleted` evicts the
    // in-memory record SYNCHRONOUSLY but enqueues the `completed` persist on the
    // single-writer queue. In that window a fold sees the record absent while the row
    // still reads `running`/`resuming` — the pure decision would demote a just-settled
    // session to native fate. `resolveFollowUpRoute` routes that case to **resume**;
    // `resumeFollowUp` then `waitForIdle`s so the queued `completed` write drains before
    // the gate + CAS read the row. Read the RAW row status once and pass it through.
    const route = resolveFollowUpRoute({
      recordPresent: !!record,
      recordStatus: record?.status,
      agentAttached: !!sessions.getAgent(watch.sessionId),
      rawRowStatus: storage.getAgentSession(watch.sessionId)?.status,
    });
    if (route === "none") {
      // Not foldable → native fate downstream: a trigger-bearing follow-up spawns its
      // own session, a bare group one goes inert via the `!inbound.trigger` return — no
      // explicit revert here.
      return false;
    }
    // Past the route decision the event is consumed exactly once (§6): mark it so the
    // trigger-hold twin (DM / re-`@`) is suppressed, then dispatch the chosen delivery.
    markSteered(inbound.event.id);
    if (route === "steer") {
      void steerFollowUp(watch.sessionId, delivery).catch((error) => {
        logger.error("follow_up_steer_threw", {
          sessionId: watch.sessionId,
          eventId: inbound.event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (route === "park") {
      // created / running-but-pre-attachAgent → park; drained when it goes live.
      parkFollowUp(watch.sessionId, delivery);
    } else {
      // settled `completed` → resume (append the follow-up as a new turn, §5.3).
      void resumeFollowUp(delivery, watch.sessionId).catch((error) => {
        logger.error("follow_up_resume_threw", {
          sessionId: watch.sessionId,
          eventId: inbound.event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return true;
  }

  /**
   * Read + hydrate the follow-up's stored event so its image attachments carry
   * `localPath`/captions (the in-memory inbound from the provider does not). Used to
   * both condition pixels and render the interjection quote. Falls back to the raw
   * inbound event if the row isn't stored yet (→ no pixels; caption-only steer).
   */
  function followUpHydratedEvent(inbound: InboundChatEvent): CanonicalChatEvent {
    const stored = storage.getTimelineEventById(inbound.event.id);
    const [hydrated] = hydrateEvents(storage, [stored ?? inbound.event]);
    return hydrated;
  }

  /**
   * Steer a folded follow-up into a live session as an `<interjection>` (spec §5.1).
   * A **media** follow-up first waits on its enrichment DOWNLOAD (NOT captioning — the
   * slow pool, irrelevant to pixels; the event is still captioned normally for
   * history) and conditions its image to real blocks; on any miss it steers
   * caption-only rather than block. If the owner settled before the inject lands, the
   * follow-up reverts to native fate.
   */
  async function steerFollowUp(sessionId: string, delivery: FollowUpDelivery): Promise<void> {
    const { inbound, form, gapMs } = delivery;
    // For a media follow-up, wait on the DOWNLOAD (enrichment) before hydrating, so the
    // hydrated event carries `localPath` for conditioning. `awaitEnrichmentComplete`
    // resolves on its own timeout (never rejects). NOT captioning — the slow pool,
    // irrelevant to pixels; the event is still captioned normally for history.
    if (form === "media") {
      await awaitEnrichmentComplete(inbound.event.id, config.enrichment?.trigger_wait_timeout_ms ?? 30_000);
    }
    const hydrated = followUpHydratedEvent(inbound);
    let imageBlocks: ImageBlock[] | undefined;
    if (form === "media") {
      try {
        const followUpSessionType = sessions.get(sessionId)?.sessionType ?? "default";
        // Resolve the per-agent model's vision capability (spec PER-AGENT-MODEL-OVERRIDES
        // FIX 6): use inbound.timelineKey to pick the agent, then look up the model.
        const followUpModelKey = factory.resolveLogicalModelId(followUpSessionType, inbound.timelineKey);
        const followUpSeesImages =
          (config.models[followUpModelKey] ?? config.models.default)?.input_modalities?.includes("image") ?? false;
        const blocks = await contextBuilder.conditionEventImages(
          hydrated,
          factory.resolveSessionType(followUpSessionType),
          followUpSeesImages,
        );
        if (blocks.length > 0) {
          imageBlocks = blocks;
          // Mark the same `hydrated` object the interjection renders so its
          // `<attachment>` gains `image_block="true"` — telling the model the loose
          // vision block and the rendered attachment are one image, matching the
          // live/resume builds (review #1). Without this the image rides only as a
          // loose block while the quote renders caption-only.
          contextBuilder.markEventImageBlocks([hydrated], blocks);
        }
      } catch (error) {
        // No-pixels branch (§5.1): caption-only steer rather than block.
        logger.warn("follow_up_image_condition_failed", {
          sessionId,
          eventId: inbound.event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const content = buildFollowUpInterjection(inbound, form, gapMs, hydrated);
    const steered = sessions.steer(
      sessionId,
      { type: "interjection", content, ...(imageBlocks ? { imageBlocks } : {}) },
      {
        eventId: inbound.event.id,
        externalId: inbound.event.externalId,
        senderId: inbound.event.sender.id,
        senderDisplayName: inbound.event.sender.displayName,
        kind: "follow-up",
        body: inbound.event.body ?? "",
      },
    );
    if (!steered) {
      // The owner settled between the fold decision and here — it completed during the
      // download wait above (uncommon: needs a slow download racing a fast owner, since
      // the wait is on the DOWNLOAD, not the slow caption pool). Prefer resuming the
      // just-settled owner — carrying the now-ready pixels (§5.3) — over dropping the
      // fold to native fate. `resumeFollowUp` self-guards (its gate resumes only a
      // `completed` row and otherwise reverts to native fate itself), so this is safe
      // even if the owner settled into a non-resumable state.
      await resumeFollowUp(delivery, sessionId);
      return;
    }
    retainFollowUpForSpawn(inbound, sessionId);
    logger.info("follow_up_steered", {
      sessionId,
      form,
      eventId: inbound.event.id,
      timelineKey: inbound.timelineKey,
      pixels: imageBlocks !== undefined,
    });
  }

  /**
   * Retain a steered follow-up so the session can spin it off via `spawn_session`
   * (named in the interjection, §10) — reusing the co-reply registry so the existing
   * tool works uniformly. Cleaned up on the session's settle (and on use), with the
   * same already-settled race guard as `trySteerCoReply`.
   */
  function retainFollowUpForSpawn(inbound: InboundChatEvent, sessionId: string): void {
    const externalId = inbound.event.externalId;
    if (!externalId) return;
    // A bare-GROUP follow-up has no trigger; synthesize one so `redispatchCoReply` can
    // spin it into a real session if the agent calls spawn_session (the trigger-bearing
    // forms already carry their post-hold trigger). Treated as a `mention` — the agent
    // explicitly judged it a separate ask the bot should now handle on its own.
    const spawnInbound: InboundChatEvent = inbound.trigger
      ? inbound
      : (() => {
          const trigger: TriggerInfo = {
            type: "mention",
            reason: "follow-up spun off via spawn_session",
            triggeredBy: inbound.event.sender,
            groupedEventIds: [inbound.event.id],
          };
          return { ...inbound, trigger, event: { ...inbound.event, trigger } };
        })();
    coReplyInbounds.set(externalId, { inbound: spawnInbound, intoSessionId: sessionId });
    sessions.onSettle(sessionId, () => coReplyInbounds.delete(externalId));
    if (!sessions.get(sessionId)) coReplyInbounds.delete(externalId);
  }

  /** Park a follow-up whose owner is still pre-live (spec §5.2), keyed by owner id. */
  function parkFollowUp(sessionId: string, delivery: FollowUpDelivery): void {
    const parked = pendingFollowUps.get(sessionId) ?? [];
    parked.push(delivery);
    pendingFollowUps.set(sessionId, parked);
    logger.info("follow_up_parked", {
      sessionId,
      form: delivery.form,
      eventId: delivery.inbound.event.id,
      timelineKey: delivery.inbound.timelineKey,
    });
  }

  /**
   * Steer every follow-up parked on a now-live session in (spec §5.2 — the success
   * drain, from `launchSession`/`runResumeSession` after `attachAgent`). Consumes the
   * parked entries; a steer that fails (owner already settling) reverts to native fate.
   */
  function drainPendingFollowUpsIntoSession(sessionId: string): void {
    const parked = pendingFollowUps.get(sessionId);
    if (!parked) return;
    pendingFollowUps.delete(sessionId);
    for (const delivery of parked) {
      void steerFollowUp(sessionId, delivery).catch((error) => {
        logger.error("follow_up_drain_steer_threw", {
          sessionId,
          eventId: delivery.inbound.event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Revert every follow-up parked on an abandoned owner to native fate (spec §5.2 —
   * the owner settled before going live: missing-target / budget / factory failure).
   * On the success path the post-attachAgent drain consumed them, so this fires on
   * nothing. Fired from the owner's settle listener.
   */
  function revertAbandonedFollowUps(sessionId: string): void {
    const parked = pendingFollowUps.get(sessionId);
    if (!parked) return;
    pendingFollowUps.delete(sessionId);
    for (const delivery of parked) revertFollowUpToNativeFate(delivery.inbound, "owner-abandoned");
  }

  /**
   * Release a consumed follow-up to native fate (spec §5.2/§6 #3, principle: a
   * non-trigger never starts its own session; a real trigger must never be lost). A
   * **trigger-bearing** follow-up (re-`@`, or any DM message — `inbound.trigger`
   * present, since we fold those on their post-hold delivery) is re-dispatched as its
   * own trigger (reusing `redispatchCoReply`'s spawn tail, which is marker-agnostic).
   * A **bare group** follow-up (no trigger) reverts to inert: it is already persisted
   * as a normal timeline event, so there is nothing to do (= today, no loss).
   */
  function revertFollowUpToNativeFate(inbound: InboundChatEvent, reason: string): void {
    if (inbound.trigger) {
      logger.info("follow_up_native_redispatch", {
        reason,
        eventId: inbound.event.id,
        timelineKey: inbound.timelineKey,
      });
      void redispatchCoReply(inbound).catch((error) => {
        logger.error("follow_up_native_redispatch_failed", {
          timelineKey: inbound.timelineKey,
          eventId: inbound.event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      logger.info("follow_up_native_inert", {
        reason,
        eventId: inbound.event.id,
        timelineKey: inbound.timelineKey,
      });
    }
  }

  /**
   * Resume a just-completed session because a quick same-sender follow-up arrived
   * (spec §5.3). Acquires a per-timeline slot without queuing (mirrors proactive — a
   * follow-up resume must not queue behind or race a concurrent session), runs the
   * follow-up resume gate (a SUBSET of reply-resume's: completed + non-synthetic +
   * capability ceiling + material viable; NO work gate, NO window, same-sender is
   * structural via the watch), performs the single-consumption CAS, and continues the
   * rollout via the shared `runResumeSession` with the §10 follow-up preamble. Any
   * gate/CAS/slot miss reverts to native fate. The settled→resume re-arms the watch to
   * the resumed session inside `runResumeSession` (§7), so chains stay linear.
   */
  async function resumeFollowUp(delivery: FollowUpDelivery, sessionId: string): Promise<void> {
    const { inbound, form, gapMs } = delivery;
    const target = inbound.outboundTarget;
    if (!target) {
      revertFollowUpToNativeFate(inbound, "resume-no-target");
      return;
    }
    // Single-flight with reply-resume: a concurrent reply to the same state sees this
    // and degrades to FRESH (and vice-versa), so only the CAS winner runs.
    if (resumeClaims.has(sessionId)) {
      revertFollowUpToNativeFate(inbound, "resume-inflight");
      return;
    }
    if (!triggerCoordinator.tryAcquire(inbound.timelineKey)) {
      // No free slot (a concurrent session holds the timeline) → native fate.
      revertFollowUpToNativeFate(inbound, "resume-no-slot");
      return;
    }
    resumeClaims.add(sessionId);
    try {
      // Settle-window drain (review issue #3): a fold that reached `resume` may have done
      // so while the owner's `completed` persist was still queued (the record was already
      // evicted, but `getAgentSession` read its pre-completion `running`/`resuming` status
      // — see `resolveFollowUpRoute`). Drain the single-writer queue so the gate below —
      // and the FIFO-ordered CAS at `acceptResumeGeneration` — observe the settled
      // `completed` row. Cheap when the queue is already empty; the common (truly-settled)
      // case adds nothing. If the row settled to a terminal non-completed status instead,
      // the gate fails → native fate (existing behaviour).
      await storage.waitForIdle();
      const verdict = await evaluateFollowUpResumeGate({
        sessionId,
        getSession: () => storage.getAgentSession(sessionId),
        // Thread timelineKey (supplied by the gate from row.timeline_key) for per-agent
        // model resolution (spec PER-AGENT-MODEL-OVERRIDES FIX 7).
        resolveCeiling: (sessionType, timelineKey) => factory.resolveSessionContextCeiling(sessionType, timelineKey),
        // Per-agent workspace (spec MULTI-AGENT-SUPPORT §4.1/§4.3): resolve from the
        // inbound timeline key so the follow-up resume reads the correct agent dir.
        // In agents mode an unresolvable account returns null → gate rejects (no resume).
        loadMaterial: (row) => {
          const wsEntry = resolveWorkspaceForTimeline(inbound.timelineKey);
          if (!wsEntry && config.agents) return Promise.resolve(null);
          return loadCompletedSessionMaterial(row, {
            media: storage,
            workspaceRoot: wsEntry?.workspaceRoot ?? workspaceRoot,
            logger,
          });
        },
        timelineKey: inbound.timelineKey,
        logger,
      });
      if (!verdict.resume) {
        drainNextQueuedTrigger(inbound.timelineKey); // release the slot we acquired
        revertFollowUpToNativeFate(inbound, "resume-gate-failed");
        return;
      }
      const { row, material } = verdict;
      // Single-consumption CAS (§5.3): completed → resuming. A racing fold/reply that
      // already consumed this state gets `undefined` → native fate.
      const generation = await storage.acceptResumeGeneration(sessionId);
      if (generation === undefined) {
        drainNextQueuedTrigger(inbound.timelineKey);
        revertFollowUpToNativeFate(inbound, "resume-cas-lost");
        return;
      }
      // Past the CAS we own the slot; `runResumeSession` releases it (its terminal
      // drain) on every path. A throw in its pre-run setup settles before that — evict
      // + drain so the timeline can't deadlock (mirrors `tryReplyResume`). The orphaned
      // generation bump is harmless (the row is no longer `completed` → FRESH after).
      try {
        await runResumeSession({
          inbound,
          duplicate: false,
          target,
          row,
          material,
          generation,
          continuation: {
            tail: config.agent.sessions.resume?.satellite?.tail ?? true,
            // A follow-up resume continues seconds later — there is no meaningful gap.
            gap: undefined,
            triggerPreamble: buildFollowUpResumePreamble(inbound, form, gapMs),
          },
          resumeLabel: "follow-up",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sessions.get(sessionId)) sessions.markDiscarded(sessionId, { error: message });
        logger.error("follow_up_resume_setup_threw", { sessionId, timelineKey: inbound.timelineKey, error: message });
        drainNextQueuedTrigger(inbound.timelineKey);
        // The resumed session never went live, yet the follow-up was already consumed
        // (`markSteered` in `foldFollowUp`, suppressing its trigger-hold twin). Revert it
        // to native fate (review issue #4) so a trigger-bearing follow-up (re-`@` / DM)
        // re-dispatches as its own session rather than vanishing; a bare-group one stays
        // inert. Safe from double-dispatch: the follow-up here is the resume *trigger*,
        // not a parked entry, so the discarded session's `revertAbandonedFollowUps` settle
        // listener (which drains `pendingFollowUps`) never touches it.
        revertFollowUpToNativeFate(inbound, "resume-setup-threw");
      }
    } finally {
      resumeClaims.delete(sessionId);
    }
  }

  /**
   * Build the steered follow-up interjection text (spec §10), per form. The content is
   * wrapped again by `convert.ts` in a generic `<interjection>` (same as co-reply); the
   * image, for a media follow-up, rides as a real content block (via `imageBlocks`),
   * not in this text. Names `spawn_session` so the agent can break it out if it judges
   * the follow-up doesn't belong.
   */
  function buildFollowUpInterjection(
    inbound: InboundChatEvent,
    form: FollowUpForm,
    gapMs: number,
    hydrated: CanonicalChatEvent,
  ): string {
    // §6.2: human-facing label uses `username ?? id` as the fallback.
    const senderName = escapeXml(inbound.event.sender.displayName ?? inbound.event.sender.username ?? inbound.event.sender.id);
    const n = Math.max(0, Math.round(gapMs / 1000));
    const externalId = inbound.event.externalId;
    const spawnHint = externalId
      ? `call spawn_session(message_id="${escapeAttr(externalId)}")`
      : `handle it separately`;
    const rendered = renderRichMessage(hydrated);
    if (form === "media") {
      return (
        `<interjection reason="follow-up-media">\n` +
        `${senderName} sent this ${n}s after the message you're handling, without addressing you again. ` +
        `Matrix sends images separately, so this is probably the image they meant — but it wasn't explicitly triggered. ` +
        `Use judgment: fold it into your reply if it fits, ignore it if it doesn't, or ${spawnHint} to handle it on its own.\n\n` +
        `${rendered}\n</interjection>`
      );
    }
    if (form === "mention") {
      return (
        `<interjection reason="follow-up-mention">\n` +
        `${senderName} @'d you again ${n}s after the message you're handling — probably amending or adding to it. ` +
        `Fold it into this reply if it continues the same request; if it's a genuinely separate ask, ${spawnHint} to give it its own session.\n\n` +
        `${rendered}\n</interjection>`
      );
    }
    return (
      `<interjection reason="follow-up-text">\n` +
      `${senderName} sent this ${n}s after the message you're handling, without addressing you again — likely a continuation of the same thought. ` +
      `Use judgment: treat it as part of the request if it fits, ignore it if unrelated, or ${spawnHint}.\n\n` +
      `${rendered}\n</interjection>`
    );
  }

  /**
   * The one-line preamble prepended to a settled-then-resume follow-up's appended turn
   * (spec §10). The follow-up IS the new turn (not an interjection to break out), so the
   * bare media/text forms carry no spawn_session affordance — just the framing that a
   * quick follow-up arrived. The mention form (a re-@, the likeliest genuinely-separate
   * ask) names spawn_session(message_id) so the resumed agent can fork it out (review
   * Q1): the resume turn's trigger is retained for spawn_session in runResumeSession (the
   * bare forms are not, matching this preamble).
   */
  function buildFollowUpResumePreamble(inbound: InboundChatEvent, form: FollowUpForm, gapMs: number): string {
    // §6.2: human-facing label uses `username ?? id` as the fallback.
    const senderName = escapeXml(inbound.event.sender.displayName ?? inbound.event.sender.username ?? inbound.event.sender.id);
    const n = Math.max(0, Math.round(gapMs / 1000));
    if (form === "media") {
      return (
        `<follow_up reason="media">${senderName} sent this ${n}s after your last reply, without addressing you again — ` +
        `Matrix splits images out, so it's probably the image they meant. Continue as part of the same exchange.</follow_up>`
      );
    }
    if (form === "mention") {
      const externalId = inbound.event.externalId;
      const spawnHint = externalId
        ? ` If it's a genuinely separate ask, call spawn_session(message_id="${escapeAttr(externalId)}") to give it its own session.`
        : ``;
      return (
        `<follow_up reason="mention">${senderName} @'d you again ${n}s after your last reply — ` +
        `probably amending or adding to it. Continue the same exchange.${spawnHint}</follow_up>`
      );
    }
    return (
      `<follow_up reason="text">${senderName} sent this ${n}s after your last reply, without addressing you again — ` +
      `likely a continuation of the same thought. Continue the same exchange.</follow_up>`
    );
  }

  /**
   * Assemble the full per-session tool set. Shared by the fresh-launch path
   * (`launchSession`) and resume-in-place (`resumeSessionRun`, spec
   * CONCURRENCY-AND-RATE-LIMITING §6.2), which must rebuild the SAME tool set
   * for a session reconstructed from its durable row.
   */
  function buildSessionTools(
    inbound: InboundChatEvent,
    sessionId: string,
    target: NonNullable<InboundChatEvent["outboundTarget"]>,
    sessionType: string,
    usage: SessionUsageTracker,
    // The session's `resume_generation` at run start (spec RESUMABLE-SESSIONS §6).
    // Threaded into send_message so every outbound event is tagged with it. 0 for
    // a fresh launch; the bumped value for a reply-resumed run.
    resumeGeneration: number = 0,
  ) {
    // Per-session workspace (spec MULTI-AGENT-SUPPORT §4.1): in agents mode each
    // session resolves to the workspace directory of its configured agent.
    // In legacy mode resolveWorkspaceForTimeline always returns the singleton entry
    // so sessionWsRoot/sessionMemWriter are identical to the outer-scope vars.
    const _sessionWsEntry = resolveWorkspaceForTimeline(inbound.timelineKey);
    // §4.3: in agents mode a missing entry means the account was removed from config
    // after the event was committed. resolveWorkspaceForTimeline already logged
    // agent_unresolvable_account; throw so the caller (launchSession's catch block or
    // resumeSessionRun's outcome path) can discard cleanly without guessing a root.
    if (!_sessionWsEntry && config.agents) {
      throw new Error(
        `§4.3: timeline "${inbound.timelineKey}" maps to an account not in config — ` +
        "workspace unresolvable in agents mode",
      );
    }
    const sessionWsRoot = _sessionWsEntry?.workspaceRoot ?? workspaceRoot;
    const sessionMemWriter = _sessionWsEntry?.memoryWriter ?? memoryWriter;
    // Agents mode: the real agent name (not the "__legacy__" sentinel) for §7.1/§7.2.
    const sessionAgentName =
      _sessionWsEntry && _sessionWsEntry.agentName !== "__legacy__"
        ? _sessionWsEntry.agentName
        : null;
    // Account prefixes for this session's agent (§7.2 rooms:"all" scoping).
    const sessionAgentAccountPrefixes =
      sessionAgentName !== null ? (agentAccountPrefixesMap.get(sessionAgentName) ?? []) : undefined;

    // Per-session sandbox and browser (§10/§10a): resolved from the per-agent maps
    // in agents mode, or from the global legacy variables in legacy mode.
    const sessionSandbox = resolveAgentSandbox(sessionAgentName);
    const sessionBrowserSession = resolveAgentBrowserSession(sessionAgentName);
    // The exec timeout to pass to createBashTool: per-agent sandbox config in strict
    // mode, or the global config in shared/legacy mode.
    const sessionSandboxTimeoutMs = (() => {
      if (sessionAgentName && config.agents?.[sessionAgentName]?.sandbox) {
        return config.agents[sessionAgentName]!.sandbox!.exec_timeout_ms;
      }
      return config.sandbox?.exec_timeout_ms;
    })();

    const roomId = target.roomId;
    // Operative per-session context ceiling (spec CONTEXT-LIMIT-UNIFICATION §2.4
    // consumer 3 / §2.5 ordering shape (a)): the text-editor read budget derives
    // from the SAME resolver call that feeds enforcement and the model descriptor,
    // never an independent `config.models.*.context_window` read — so a session
    // type's override (or a non-default model) shapes the tool budget too.
    // Thread inbound.timelineKey for per-agent model resolution (spec FIX 7).
    const contextCeiling = factory.resolveSessionContextCeiling(sessionType, inbound.timelineKey);

    // Whether THIS session's reply model — the per-agent resolved model (spec
    // PER-AGENT-MODEL-OVERRIDES §4 FIX 4), the one that actually serves the turn,
    // NOT `[models.default]` or the global session-type model — accepts image input
    // (spec MODEL-FALLBACK §3). Gates vision-dependent tool wiring below
    // (read_image inclusion, media/danbooru/find_source inline-vs-caption fallback)
    // on the serving model's own capability, never another model's.
    const replyModelConfig =
      config.models[factory.resolveLogicalModelId(sessionType, inbound.timelineKey)] ?? config.models.default;
    const replyModelSeesImages = replyModelConfig.input_modalities.includes("image");

    // Shared auxiliary usage-ledger sink for the LLM-calling tools (image_generate,
    // x_search, plus the media / danbooru tool-context caption lanes). Feeds the
    // per-session cost ceiling's combined-spend lane in-memory
    // (spec SESSION-COST-LIMITS §4) and appends one durable `tool_invocations` row
    // (spec AUXILIARY-USAGE-TRACKING §8.2). Both lanes are separate
    // from agent_sessions.usage_* (§8c §4); a sink failure never fails the tool.
    const recordToolUsage = (record: ToolUsageRecord) => {
      usage.recordToolCost(record.cost ?? 0);
      void storage
        .insertToolInvocation({
          agentSessionId: record.agentSessionId,
          toolName: record.toolName,
          toolCallId: record.toolCallId,
          modelId: record.modelId,
          provider: record.provider,
          inputTokens: record.usage.input,
          outputTokens: record.usage.output,
          cacheReadTokens: record.usage.cacheRead,
          cacheWriteTokens: record.usage.cacheWrite,
          images: record.usage.images ?? null,
          cost: record.cost,
          ref: record.ref,
        })
        .catch((error) => {
          logger.warn("tool_usage_ledger_insert_failed", {
            tool: record.toolName,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      // Unified ledger (spec USAGE-COST-LIMITS §3.1): the same tool spend, as a
      // class='tool' row, + the BudgetEngine increment. Additive to the
      // tool_invocations write above (which retains tool_call_id for transcript
      // annotation); never folded into agent_sessions.usage_* (§4 invariant).
      budgetHooks.record?.({
        class: "tool",
        agentSessionId: record.agentSessionId,
        sessionType,
        timelineKey: inbound.timelineKey,
        triggerSenderId: inbound.trigger?.triggeredBy?.id ?? inbound.event.sender?.id ?? null,
        toolName: record.toolName,
        modelId: record.modelId,
        // Logical id for budget scoping / grouping (spec MODEL-FALLBACK §2.2),
        // defaulting to the wire id when the tool has no virtual model.
        logicalModelId: record.logicalModelId ?? record.modelId,
        provider: record.provider,
        inputTokens: record.usage.input,
        outputTokens: record.usage.output,
        cacheReadTokens: record.usage.cacheRead,
        cacheWriteTokens: record.usage.cacheWrite,
        images: record.usage.images ?? null,
        costUsd: record.cost ?? 0,
        ref: record.ref,
      });
    };

    // Resolve the IChatProvider for this session's target by looking up the
    // provider registry. A missing provider is an impossible state once all
    // callers embed target.provider correctly — fail loudly rather than
    // silently routing through a wrong provider.
    const sessionProvider = providers.get(target.provider);
    if (!sessionProvider) {
      throw new Error(
        `session ${sessionId}: provider "${target.provider}" is not registered — cannot build send_message tool`,
      );
    }
    // Resolve the cross-provider ChannelClient for this session's target (spec
    // DISCORD-SUPPORT-DESIGN §7.1). The 11 channel-scoped tools (emoji, react,
    // edit, delete, pins, list_reactions, read_messages, member_info, channel_info,
    // create_poll, poll_vote) are gated on this being non-null — they silently
    // disappear when the target has no resolvable channel (e.g. a DM that didn't
    // parse correctly, or a provider that hasn't implemented channelClient yet).
    const channelClient = sessionProvider.channelClient(target);
    // Terminology bundle for provider-aware tool description strings (spec §7.1).
    // Matrix keeps its pre-Phase-4 strings byte-identical; Discord and IRC get their own bundles.
    const TERMINOLOGY_MAP: Record<string, import("./types.js").ProviderTerminology> = {
      discord: DISCORD_TERMINOLOGY,
      irc: IRC_TERMINOLOGY,
    };
    const terminology = TERMINOLOGY_MAP[target.provider] ?? MATRIX_TERMINOLOGY;
    // Per-provider capabilities — used for individual tool gates below (spec §7.1/§3.3).
    const caps = sessionProvider.capabilities;

    // Resolver for a specific channel by id: used by emoji_list and channel_info
    // tools when the caller passes an explicit room_id (M4/M5). Rebuilds a target
    // timeline key for the given channelId and delegates to the provider's
    // channelClient(). Only defined when the session target has an accountId so the
    // rebuilt key is well-formed; undefined otherwise (tools fall back to the
    // session channelClient).
    const channelClientFor = channelClient && target.accountId
      ? (channelId: string) =>
          sessionProvider.channelClient({
            provider: target.provider,
            timelineKey: buildTimelineKey({
              provider: target.provider,
              accountId: target.accountId!,
              kind: "room",
              channelId,
            }),
            accountId: target.accountId,
          })
      : undefined;

    // Per-session caption client map (spec PER-AGENT-MODEL-OVERRIDES Phase 2):
    // routes each modality to the session's agent's override client, or baseline.
    // In legacy mode (agentWorkspaces.length === 0), sessionAgentName is always null
    // and resolveAgentCaptionClient returns the baseline → use captionClients directly.
    const sessionCaptionClients = agentWorkspaces.length > 0
      ? new Map<MediaModality, InferenceClient>([
          ["image", resolveAgentCaptionClient(sessionAgentName, "image")],
          ["video", resolveAgentCaptionClient(sessionAgentName, "video")],
          ["audio", resolveAgentCaptionClient(sessionAgentName, "audio")],
        ] as Array<[MediaModality, InferenceClient]>)
      : captionClients;

    return [
      createSendMessageTool({
        provider: sessionProvider,
        target,
        timeline,
        agentSessionId: sessionId,
        agentSessionGeneration: resumeGeneration,
        workspaceRoot: sessionWsRoot,
        mediaMaxBytes: downloadSizeLimit,
        terminology,
        // Live reply guard (spec DUPLICATE-REPLY-MITIGATION §6): a LIVE registry
        // lookup at send time (excluding self), so it catches a sibling that
        // claimed the reply-target after this session's context was built — the
        // later-claim race the frozen marker structurally cannot cover.
        isClaimedByOther: (externalId) => {
          const claim = sessionClaims.claimantOf(inbound.timelineKey, externalId, sessionId);
          // Surfaces un-attributed (queued / pre-launch) claims too (review #4): the
          // marker is undefined for a pending owner, named once attributed.
          return claim ? { sessionId: claim.sessionId } : undefined;
        },
      }),
      createDelegateToSessionTool({
        currentEvent: inbound.event,
        steerSession: (sessionId, content) =>
          sessions.steer(sessionId, {
            type: "interjection",
            content,
          }),
      }),
      // spawn_session (spec DUPLICATE-REPLY-MITIGATION §5.4): push a coalesced
      // co-reply back out into its own session when this session judges it warrants
      // independent handling. Bound to this session so only co-replies coalesced
      // into it can be spun off.
      createSpawnSessionTool({
        spawnCoReply: (messageId) => spawnCoReplySession(messageId, sessionId),
        terminology,
      }),
      // Channel-scoped tools — outer gate: provider must return a ChannelClient for
      // the session target. Inner gates: per-capability flags (spec §7.1/§3.3).
      // Matrix has all capabilities = true → tool set is identical to pre-Phase-4.
      // channel_info and member_info are gated only on channelClient presence (no
      // per-capability flag); the reaction/edit/delete/pins/history/poll tools each
      // check their own capability flag.
      ...(channelClient ? [
        createChannelInfoTool({ channelClient, terminology, channelClientFor }),
        createMemberInfoTool({ channelClient, terminology }),
        ...(caps.reactions ? [
          createEmojiListTool({ channelClient, terminology, channelClientFor, customEmojiScoped: caps.customEmojiScoped }),
          createReactTool({ channelClient, terminology, reactionKinds: caps.reactionKinds }),
          createListReactionsTool({ channelClient, terminology }),
        ] : []),
        ...(caps.edits ? [createEditMessageTool({ channelClient, terminology })] : []),
        ...(caps.deletes ? [createDeleteMessageTool({ channelClient, terminology })] : []),
        ...(caps.pins ? [createPinsTool({ channelClient, terminology })] : []),
        ...(caps.history ? [createReadMessagesTool({ channelClient, terminology })] : []),
        ...(caps.pollCreate ? [createCreatePollTool({ channelClient, terminology })] : []),
        ...(caps.pollVote ? [createPollVoteTool({ channelClient, terminology })] : []),
      ] : []),
      // Chat-history search + recap (§9e) — DB-backed, not tied to the live room
      // client, so available regardless of roomId and able to span all rooms.
      createSearchMessagesTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: inbound.timelineKey,
        absenceDefaults: chatSearchDefaults.absence,
        agentAccountPrefixes: sessionAgentAccountPrefixes,
        visibilityResolver,
        logger: logger.child("search"),
      }),
      // Summary drill-down (§9e). DB-backed (lineage tables + shared renderer), so like
      // search/recap it's available regardless of roomId and is single-id (room implicit).
      createExpandSummaryTool({
        storage,
        defaults: chatSearchDefaults.expand,
        currentTimelineKey: inbound.timelineKey,
        visibilityResolver,
      }),
      createRecapTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: inbound.timelineKey,
        askerId: (inbound.trigger?.triggeredBy ?? inbound.event.sender).id,
        defaults: {
          budgetTokens: chatSearchDefaults.recapBudgetTokens,
          gapThresholdMs: chatSearchDefaults.absence.gapThresholdMs,
          defaultLookbackMs: chatSearchDefaults.absence.defaultLookbackMs,
        },
        agentAccountPrefixes: sessionAgentAccountPrefixes,
        visibilityResolver,
        logger: logger.child("search"),
      }),
      createUserActivityTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: inbound.timelineKey,
        // Membership source for include_silent / never-posted users (§9e). Resolves
        // members via the ChannelClient abstraction so it works for any provider.
        // Falls back to an empty list for DMs, thread keys, or when the provider's
        // channelClient doesn't expose members() (ProviderCapabilities.membershipRoster
        // = false — "roster unavailable on this channel").
        roomMembers: async (timelineKey) => {
          const parsedKey = parseTimelineKey(timelineKey);
          if (!parsedKey || parsedKey.kind !== "room") return [];
          const provider = providers.get(parsedKey.provider);
          if (!provider) return [];
          const client = provider.channelClient({ provider: parsedKey.provider, timelineKey, accountId: parsedKey.accountId });
          if (!client?.members) return [];
          const members = await client.members();
          return members.map((m) => ({ userId: m.id, displayName: m.displayName }));
        },
        visibilityResolver,
        logger: logger.child("search"),
      }),
      // set_profile is a provider-level capability (optional on IChatProvider).
      // Present only when the provider implements it and an accountId is available.
      ...(sessionProvider.setProfile && target.accountId
        ? [createSetProfileTool({ provider: sessionProvider, accountId: target.accountId, workspaceRoot: sessionWsRoot })]
        : []),
      createWebFetchTool(),
      createWebSearchTool(),
      // Per-session browser tool (§10a): use the per-agent session in agents mode
      // or the global legacy session. config.browser provides connection settings /
      // timeouts; profile_name is already baked into the session from construction.
      ...(sessionBrowserSession && config.browser
        ? [createBrowserTool({
            session: sessionBrowserSession,
            agentSessionId: sessionId,
            config: config.browser,
            // Same shared per-model base64 cap read_image uses, so inline
            // screenshots respect the model's per-image budget (issue #2).
            maxImageBytes: resolveReadImageMaxBytes(config, replyModelConfig.image_input_bytes),
            // Upload paths resolve within (and are confined to) the workspace (§6).
            workspaceRoot: sessionWsRoot,
          })]
        : []),
      // Adaptive paging uses the session's operative context ceiling
      // (`min(context_window, session_type.max_context_tokens)`), resolved once
      // above — so a single read is sized against the budget it will actually
      // consume, not the raw physical window. Clamps in resolveMaxCharacters
      // (50KB–512KB) bound the impact, so a mismatch only shifts the cap within
      // those limits.
      createTextEditorTool({ workspaceRoot: sessionWsRoot, contextWindowTokens: contextCeiling }),
      // Per-session sandbox (§10): strict agents get their own manager; shared-mode
      // agents get a cwd-routing wrapper; legacy mode gets the global manager.
      createSearchFilesTool({ workspaceRoot: sessionWsRoot, sandbox: sessionSandbox }),
      ...(sessionSandbox ? [createBashTool({ sandbox: sessionSandbox, defaultTimeoutMs: sessionSandboxTimeoutMs })] : []),
      createMediaTool({
        workspaceRoot: sessionWsRoot,
        // Per-session caption clients (spec PER-AGENT-MODEL-OVERRIDES Phase 2):
        // routes each modality to the session's agent's override, or baseline.
        clients: sessionCaptionClients,
        defaultPrompts,
        modelHasVision: replyModelSeesImages,
        maxFetchBytes: downloadSizeLimit,
        fetchClient,
        // Auxiliary usage ledger (spec AUXILIARY-USAGE-TRACKING §8.2): one
        // tool_invocations row per captioned item, feeding the §8d cost ceiling.
        agentSessionId: sessionId,
        recordToolUsage,
        // YouTube segment routing (spec YOUTUBE-VIDEO-UNDERSTANDING §7 T3):
        // when the subsystem is available, recognized YouTube URLs are downloaded
        // as segments instead of fetched via FetchClient.
        youtube: youtubeSubsystemAvailable
          ? {
              maxDownloadBytes: ytConfig.maxDownloadBytes,
              maxResolution: mediaVideoConfig.max_resolution ?? 480,
              maxDurationSeconds: mediaVideoConfig.max_duration_seconds ?? 120,
              cachePath: mediaCachePath,
              cacheMaxBytes: mediaVideoConfig.cache_max_bytes ?? 21_474_836_480,
              cacheTargetBytes: mediaVideoConfig.cache_target_bytes ?? 16_106_127_360,
            }
          : undefined,
      }),
      ...(replyModelSeesImages ? [createReadImageTool({ workspaceRoot: sessionWsRoot, maxImageBytes: resolveReadImageMaxBytes(config, replyModelConfig.image_input_bytes) })] : []),
      createSearchMemoryTool({ workspaceRoot: sessionWsRoot }),
      ...(retrieval
        ? [
            createRecallMemoryTool({
              search: retrieval.search,
              defaults: {
                maxResults: retrievalConfig.query.maxResults,
                minScore: retrievalConfig.query.minScore,
              },
              agentName: sessionAgentName,
            }),
          ]
        : []),
      createWriteMemoryTool({ workspaceRoot: sessionWsRoot, memoryWriter: sessionMemWriter }),
      createDanbooruTool({
        workspaceRoot: sessionWsRoot,
        downloadSizeLimit,
        inlineImageMaxBytes: resolveReadImageMaxBytes(config, replyModelConfig.image_input_bytes),
        inferenceImageOptions,
        // When the default model lacks vision, `preview` describes the asset via
        // the captioning model instead of emitting an unusable image block.
        modelHasVision: replyModelSeesImages,
        // Per-session caption client (spec PER-AGENT-MODEL-OVERRIDES Phase 2).
        imageCaptionClient: resolveAgentCaptionClient(sessionAgentName, "image"),
        // Auxiliary usage ledger (spec AUXILIARY-USAGE-TRACKING §8.2): one
        // tool_invocations row per non-vision preview caption, feeding the §8d
        // cost ceiling.
        agentSessionId: sessionId,
        recordToolUsage,
        fetchClient,
        httpProxyUrl: config.network?.http_proxy_url,
        config: config.danbooru,
      }),
      ...(fxTwitterConfig.tool.enabled
        ? [createXFetchTool({
            workspaceRoot: sessionWsRoot,
            fetchClient,
            client: fxTwitterClient,
            // Same shared per-model base64 cap + conditioning pipeline as
            // read_image / the danbooru preview path, so view_media blocks
            // respect the model's per-image budget.
            maxImageBytes: resolveReadImageMaxBytes(config, replyModelConfig.image_input_bytes),
            inferenceImageOptions,
            config: fxTwitterConfig.tool,
            statusHosts: fxTwitterConfig.statusHosts,
          })]
        : []),
      ...(config.image_gen
        ? [createImageGenTool({
            workspaceRoot: sessionWsRoot,
            fetchClient,
            downloadSizeLimit,
            inlineImageMaxBytes: resolveReadImageMaxBytes(config, replyModelConfig.image_input_bytes),
            inferenceImageOptions,
            httpProxyUrl: config.network?.http_proxy_url,
            scheduler: llmScheduler,
            // Bound the scheduler-admission wait by the interactive budget (#14).
            maxWaitMs: config.recovery?.llm_request_max_wait_ms,
            // Auxiliary usage ledger (spec AUXILIARY-USAGE-TRACKING §8.2): attribute
            // each billable generation to this session and append one durable row.
            // Separate lane — never touches agent_sessions.usage_* (§4).
            agentSessionId: sessionId,
            recordToolUsage,
            // Period-budget gate (spec USAGE-COST-LIMITS §6.3).
            checkBudget: makeToolBudgetCheck("image_generate"),
            isModelAvailable: (logicalId) => budgetHooks.engine?.isModelAvailable(logicalId) ?? true,
            // Unified registry (spec MODEL-FALLBACK §2.3): each tier resolves to a
            // [models.*] chain (head + fallback members); pricing lives on the model.
            // Per-agent ladder (spec PER-AGENT-MODEL-OVERRIDES Phase 3): the ref is
            // resolved via the override ladder before building the chain. null agent →
            // ladder returns the global ref → byte-identical to the pre-Phase-3 path.
            // resolveModelChain cannot throw here: Phase 0 validateAgentConfig already
            // validated every override ref, and the global refs were validated at startup.
            chains: {
              pro: resolveModelChain(agentModelOverrides.resolveImageGenRef(sessionAgentName, "pro"), config.models),
              flash: resolveModelChain(agentModelOverrides.resolveImageGenRef(sessionAgentName, "flash"), config.models),
            },
            config: config.image_gen,
          })]
        : []),
      // find_source (spec SAUCENAO-SOURCE-LOOKUP): reverse-image search via
      // SauceNAO — image → source URL + artist (inverse of `danbooru`). Gated on
      // `sauceNaoEnabled` (saucenao.enabled AND a non-empty api_key — enabled
      // without a key soft-disables the tool, see the warning above); shares the
      // process-wide per-account quota limiter.
      ...(sauceNaoConfig && sauceNaoRateLimiter
        ? [createFindSourceTool({
            workspaceRoot: sessionWsRoot,
            fetchClient,
            // Same shared per-model base64 cap + conditioning pipeline as
            // read_image / danbooru preview, for the view-thumbnail path.
            inlineImageMaxBytes: resolveReadImageMaxBytes(config, replyModelConfig.image_input_bytes),
            inferenceImageOptions,
            modelHasVision: replyModelSeesImages,
            rateLimiter: sauceNaoRateLimiter,
            maxWaitMs: sauceNaoConfig.rate_limit?.max_wait_ms,
            httpProxyUrl: config.network?.http_proxy_url,
            config: sauceNaoConfig,
          })]
        : []),
      // x_search: Grok-as-subagent X.com search, grounded by
      // miku's own FxTwitter hydration + inline captioning. The Grok call goes to
      // OpenRouter — a different provider lane than the agent loop — so it is NOT
      // admitted through llmScheduler (§8); only the inline captions ride the
      // caption client's own scheduler. Gated on x_search.enabled (default true).
      ...(config.x_search && (config.x_search.enabled ?? true)
        ? [createXSearchTool({
            config: config.x_search,
            // Unified registry (spec MODEL-FALLBACK §2.3): resolve the fast/deep
            // tiers to their `[models.*]` chains (head + fallback members).
            // Per-agent ladder (spec PER-AGENT-MODEL-OVERRIDES Phase 3): the deep→fast
            // fall-through is resolved INSIDE resolveXSearchRef (§4) so the call site
            // must NOT re-apply `?? config.x_search.model`. null agent → global refs.
            fastChain: resolveModelChain(agentModelOverrides.resolveXSearchRef(sessionAgentName, "fast"), config.models),
            deepChain: resolveModelChain(agentModelOverrides.resolveXSearchRef(sessionAgentName, "deep"), config.models),
            scheduler: llmScheduler,
            isModelAvailable: (logicalId) => budgetHooks.engine?.isModelAvailable(logicalId) ?? true,
            workspaceRoot: sessionWsRoot,
            fxTwitterClient,
            statusHosts: fxTwitterConfig.statusHosts,
            // Reuse the image caption model — the exact `media`-tool path (§5).
            // Per-session caption client (spec PER-AGENT-MODEL-OVERRIDES Phase 2).
            imageCaptionClient: resolveAgentCaptionClient(sessionAgentName, "image"),
            fetchClient,
            downloadSizeLimit,
            httpProxyUrl: config.network?.http_proxy_url,
            cache: xSearchCache,
            agentSessionId: sessionId,
            recordToolUsage,
            // Period-budget gate (spec USAGE-COST-LIMITS §6.3).
            checkBudget: makeToolBudgetCheck("x_search"),
          })]
        : []),
      // youtube_fetch: YouTube metadata + transcript + workspace download tool
      // (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §6/§6a; ARCHITECTURE.md §7e/§10).
      // Gated on the subsystem availability flag set at startup by the binary probe.
      ...(youtubeSubsystemAvailable && ytConfig.enabled
        ? [createYoutubeFetchTool({
            workspaceRoot: sessionWsRoot,
            config: ytConfig.tool,
          })]
        : []),
      createUserProfileReadTool({
        workspaceRoot: sessionWsRoot,
        provider: inbound.provider,
        senderId: (inbound.trigger?.triggeredBy ?? inbound.event.sender).id,
        senderUsername: (inbound.trigger?.triggeredBy ?? inbound.event.sender).username,
        senderDisplayName: (inbound.trigger?.triggeredBy ?? inbound.event.sender).displayName,
        terminology,
        config: config.user_profiles,
      }),
      createUserProfileEditTool({
        workspaceRoot: sessionWsRoot,
        provider: inbound.provider,
        senderId: (inbound.trigger?.triggeredBy ?? inbound.event.sender).id,
        senderUsername: (inbound.trigger?.triggeredBy ?? inbound.event.sender).username,
        senderDisplayName: (inbound.trigger?.triggeredBy ?? inbound.event.sender).displayName,
        terminology,
        config: config.user_profiles,
      }),
      createCharacterCardCreateTool({ workspaceRoot: sessionWsRoot, fetchClient, downloadSizeLimit, config: config.character_card }),
      createCharacterCardReadTool({ workspaceRoot: sessionWsRoot, fetchClient, downloadSizeLimit, config: config.character_card }),
      createCharacterCardEditTool({ workspaceRoot: sessionWsRoot, fetchClient, downloadSizeLimit, config: config.character_card }),
      ...mcpTools,
    ].filter((t) => !disabledTools.has(t.name));
  }

  /**
   * Wire the soft cost-budget interjection (spec SESSION-COST-LIMITS §2.1). When
   * the session's combined (agent-loop + tool) spend first crosses
   * `cost_warn_fraction × ceiling`, steer ONE agent-visible `<interjection>` so the
   * autonomous session can wind down before the hard cap (§2.2) blocks its next
   * request. One-shot per run (`warned` latch). No-op (returns a noop unsubscribe)
   * when the session has no resolved ceiling. Returns the `onBudgetChange`
   * unsubscribe; the caller tears it down alongside the capture handle.
   *
   * Thin wiring only: the one-shot latch/threshold decision lives in the pure
   * {@link makeCostWarnDecider} (testable without steer/log side effects); this
   * function performs the steer + log when it reports a crossing. The `ceiling`
   * is resolved ONCE by the caller (shared with the capture ctx's
   * `maxSessionCostUsd`); `undefined` = unlimited → no warner.
   */
  function wireCostBudgetWarner(
    sessionId: string,
    sessionType: string,
    usage: SessionUsageTracker,
    ceiling: number | undefined,
  ): () => void {
    if (ceiling === undefined) return () => {};
    // Must match the cost_warn_fraction default shipped in config/00-defaults.toml.
    // There is no config hot-reload, so this cannot drift at runtime; per the
    // explicit-deployment-config convention local config normally always provides
    // it, so this `?? 0.8` is a defensive backstop, not the live value.
    const fraction = config.agent.cost_warn_fraction ?? 0.8;
    const decider = makeCostWarnDecider(ceiling, fraction);
    return usage.onBudgetChange((combinedCost) => {
      if (!decider.shouldWarn(combinedCost)) return;
      const pct = Math.round((combinedCost / ceiling) * 100);
      const content =
        `You have spent $${combinedCost.toFixed(2)} of your $${ceiling.toFixed(2)} cost ` +
        `budget for this session (${pct}%). Wind down now: send your final message and ` +
        `avoid further tool calls or expensive actions. If you exceed the budget, your ` +
        `next request will be blocked.`;
      const steered = sessions.steer(sessionId, { type: "interjection", content });
      logger.info("session_cost_warn", {
        sessionId,
        sessionType,
        combinedCostUsd: combinedCost,
        ceilingUsd: ceiling,
        fraction,
        steered,
      });
    });
  }

  /**
   * The per-user limits gate decision for ONE human agent-loop session (spec
   * PER-USER-LIMITS §6.1), shared by the fresh launch AND every resume path — a
   * resume is the SAME logical event (same user/room/budget), it merely continues
   * an existing session, so the gate applies identically. Builds the trigger ctx,
   * resolves the per-field cascade, and either reports `denied` (banned / fully out
   * of budget) or returns the selection inputs to thread into `factory.create`. When
   * admitted it FREEZES the resolution on the recording map (+ a settle cleanup), so
   * the partitioned counter is incremented live for both the agent-loop and tool
   * lanes of every spending path — not just fresh launches. Posting the refusal and
   * the discard/return control flow stay with the caller (a user trigger refuses; a
   * proactive/background path never calls this at all).
   */
  interface UserLimitGate {
    active: boolean;
    denied: boolean;
    userLimit?: { engine: UserLimitEngine; resolution: UserLimitResolution; ctx: UserLimitContext };
    ceilingOverride?: number;
    /** The selected initial model (logical id) — the §8e admission chain (§6.1). */
    initialModel?: string;
    /** Populated only when `denied`, for the templated refusal (§12). */
    refusal?: { ctx: UserLimitContext; binding?: ResolvedConstraint; displayName: string; template?: string };
  }
  async function resolveUserLimitGate(
    inbound: InboundChatEvent,
    sessionId: string,
    sessionType: string,
  ): Promise<UserLimitGate> {
    if (!userLimitEngine?.enabled) return { active: false, denied: false };
    const userId = inbound.trigger?.triggeredBy?.id ?? inbound.event.sender?.id;
    if (!userId) return { active: false, denied: false };
    // Parent-space resolution (§11) — only when a rule references space (the call is a
    // per-room native lookup; skip it entirely for space-less deployments). Best-first
    // ancestor ids; any failure degrades to none (the room matches no space rule).
    let spaceIds: string[] | undefined;
    if (userLimitEngine.usesSpace) {
      spaceIds = await serverIdsFor(inbound.timelineKey);
    }
    const ctx: UserLimitContext = {
      userId,
      roomId: roomIdFromTimelineKey(inbound.timelineKey),
      spaceIds,
    };
    const resolution = userLimitEngine.resolve(ctx, inbound.timelineKey);
    if (!resolution.active) return { active: false, denied: false };
    // Coarse admission (§6.1): the first preferred model with headroom for a minimal
    // first turn (prior context ≈ 0). Undefined ⇒ banned / fully out of budget; the
    // precise estimate + degradation run per request at Gate B inside the factory.
    // The additive extended-thinking budget (#4) is reserved here too so Gate A's
    // initial pick matches Gate B's per-attempt selection — a model affordable only
    // because thinking was ignored must not be admitted as the initial model. The
    // thinking level is the session-type head's config (fixed for the rollout).
    // Thread `inbound.timelineKey` so the per-agent ladder resolves the correct
    // model for this agent's session (spec PER-AGENT-MODEL-OVERRIDES §4/§8).
    const preferred = resolution.models ?? [factory.resolveLogicalModelId(sessionType, inbound.timelineKey)];
    const sessionThinkingLevel =
      config.models[factory.resolveLogicalModelId(sessionType, inbound.timelineKey)]?.thinking_level ?? "off";
    const thinkingBudgetForModel = (m: string): number => {
      const mc = config.models[m];
      return mc ? additiveThinkingBudgetTokens(mc, sessionThinkingLevel) : 0;
    };
    const initialModel = resolution.banned
      ? undefined
      : preferred.find(
          (m) => userLimitEngine!.affordable(resolution, m, {}, thinkingBudgetForModel(m)).ok,
        );
    if (!initialModel) {
      // §6.2: human-facing label for the refusal message. Mirrors the pre-3a cross-sender
      // fall-through (triggeredBy first, then event.sender as backstop), extended with
      // username for providers that carry it (Discord). Final fallback is the raw userId.
      const displayName =
        inbound.trigger?.triggeredBy?.displayName ??
        inbound.trigger?.triggeredBy?.username ??
        inbound.event.sender?.displayName ??
        inbound.event.sender?.username ??
        userId;
      return {
        active: true,
        denied: true,
        refusal: {
          ctx,
          // §12: report the SOONEST-resetting over-cap binding (so {resets_at}/
          // {resets_in} quote the earliest unblock), not least-headroom (issue #5).
          binding: userLimitEngine.refusalBindingConstraint(resolution),
          displayName,
          template: resolution.messageTemplate,
        },
      };
    }
    userLimitResolutions.set(sessionId, { resolution, ctx });
    sessions.onSettle(sessionId, () => {
      userLimitResolutions.delete(sessionId);
      userLimitEngine?.clearSelection(sessionId); // drop the live console selection (§14)
    });
    // Dynamic §8d ceiling (§6.3): min(static, user total headroom-at-launch). An
    // exempt/uncapped user contributes ∞ → no change to the static ceiling.
    const staticCeiling = factory.resolveSessionCostCeiling(sessionType);
    // Zero-cost bypass (§5.3/§2.2): a free initial model must stay launchable even
    // when the fungible total is exactly at cap (`totalHeadroom === 0`). Letting
    // headroom tighten the §8d ceiling to `$0` would make the factory's hard
    // pre-flight deny the FIRST request of a session that costs nothing (issue #4),
    // and fire the soft-warn spuriously — both derive from this override. So treat
    // per-user headroom as ∞ for the ceiling when the admitted model is zero-cost.
    const headroom = zeroCostModelIds.has(initialModel)
      ? undefined
      : userLimitEngine.totalHeadroom(resolution);
    const effective = Math.min(staticCeiling ?? Infinity, headroom ?? Infinity);
    return {
      active: true,
      denied: false,
      userLimit: { engine: userLimitEngine, resolution, ctx },
      ceilingOverride: Number.isFinite(effective) ? effective : undefined,
      initialModel,
    };
  }

  /** Log + post a denied user trigger's templated refusal (spec §12/§14). */
  function postUserLimitRefusal(
    target: NonNullable<InboundChatEvent["outboundTarget"]>,
    sessionId: string,
    timelineKey: string,
    gate: UserLimitGate,
  ): void {
    const r = gate.refusal;
    if (!r) return;
    logger.warn("usage_limit_blocked", {
      gate: "user_admission",
      sessionId,
      timelineKey,
      userId: r.ctx.userId,
      binding: r.binding
        ? { partitionKey: r.binding.partitionKey, capUsd: r.binding.cap, models: r.binding.modelScope }
        : undefined,
    });
    if (r.template) {
      const body = renderUserLimitRefusal(r.template, r.ctx, r.binding, r.displayName);
      sendViaProvider(providers, target, { body, agentSessionId: sessionId }, logger, "user_limit_refusal", (error) => {
        logger.warn("user_limit_rejection_send_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Run one resume-in-place attempt for a session (spec
   * CONCURRENCY-AND-RATE-LIMITING §6.2): rebuild the tool set, re-create the
   * agent from the persisted snapshot + transcript (skipping the context build
   * entirely), and drive the runner in continue-mode so it re-issues the exact
   * request that failed. When the transcript never flushed (`fresh` material —
   * a hard crash before the first turn committed), there is nothing to replay:
   * the context is rebuilt from the durable trigger row and the session re-runs
   * like a launch instead. Shared by auto-resume (in the failed run's promise
   * chain, while the timeline slot is still held) and the manual console resume.
   */
  async function resumeSessionRun(
    record: AgentSessionRecord,
    inbound: InboundChatEvent,
    attempt: number,
  ): Promise<{ outcome: "completed" | "mechanical" | "content" | "fatal" | "unresumable"; error?: string }> {
    const row = storage.getAgentSession(record.id);
    if (!row) return { outcome: "unresumable", error: "session row missing" };
    // Image refs externalized at capture time are rehydrated through the media
    // store here (issue #13) — without this, an image-bearing snapshot would
    // re-issue malformed `{type:"image"}` blocks and 400 fatally.
    // Per-agent workspace (spec MULTI-AGENT-SUPPORT §4.1/§4.3): resolve from the
    // session's timeline key (identical to outer workspaceRoot in legacy mode).
    // In agents mode an unresolvable account is fatal — the session cannot resume
    // from an unknown workspace.
    const _resumeWsEntry = resolveWorkspaceForTimeline(inbound.timelineKey);
    if (!_resumeWsEntry && config.agents) {
      return { outcome: "fatal", error: `§4.3: timeline "${inbound.timelineKey}" maps to an account not in config — workspace unresolvable` };
    }
    const _resumeWsRoot = _resumeWsEntry?.workspaceRoot ?? workspaceRoot;
    const material = await loadResumeMaterial(row, { media: storage, workspaceRoot: _resumeWsRoot, logger });
    if (!material) return { outcome: "unresumable", error: "no resumable snapshot/transcript" };
    const target = inbound.outboundTarget;
    if (!target) return { outcome: "unresumable", error: "no outbound target" };

    // Per-user limits also gate the manual console recovery of a parked session
    // (spec PER-USER-LIMITS §6): it is still the user's spend, so it must degrade /
    // cap / count identically. Skip proactive sessions (no triggering user). A denied
    // (banned / out-of-budget) user blocks the recovery with a content-class outcome —
    // the console shows the budget reason — rather than spending unrestricted.
    const isProactiveResume = record.sessionType === (config.proactive?.session_type ?? "proactive");
    const recoveryGate = isProactiveResume
      ? undefined
      : await resolveUserLimitGate(inbound, record.id, record.sessionType);
    if (recoveryGate?.denied) {
      logger.warn("usage_limit_blocked", {
        gate: "user_resume",
        sessionId: record.id,
        timelineKey: record.timelineKey,
        userId: recoveryGate.refusal?.ctx.userId,
      });
      return { outcome: "content", error: "per-user budget exhausted — resume blocked" };
    }

    let agent;
    // Resume usage seed (spec TOKEN-USAGE-TRACKING §4.3, §6.2/D3 + SESSION-COST-LIMITS
    // §4). Chosen by mode, NOT once for both: only a continue-mode resume inherits
    // the row's persisted totals (so its consumption keeps accumulating). A
    // fresh-mode resume must start from an EMPTY seed (zeros with
    // `contextTokens: null`), because the row's usage columns can be populated even
    // though it classifies fresh: usage persists at the Layer-0 `done` commit,
    // enqueued BEFORE the turn's transcript flush, so a crash in that window leaves
    // usage written but `transcript_json` null (→ fresh). Seeding fresh from the row
    // would (1) double-count those requests on re-run and (2) seed a non-null
    // `contextTokens` that could trip the first-request `checkContextBudget` and
    // permanently park the session, violating D3 ("the first request is never
    // locally blocked"). The tool-cost lane seed follows the same rule: continue
    // inherits the persisted ledger sum (getSessionToolUsage), fresh starts at 0.
    // The tracker is built here so the SAME instance receives the tool-cost feed
    // (buildSessionTools) and the factory's agent-loop commits.
    const usage = new SessionUsageTracker(
      resumeUsageSeed(row, material.mode),
      selectToolCostSeed(material.mode, () => storage.getSessionToolUsage(record.id).cost),
    );
    // Tag this resumed run's sends with the row's CURRENT resume_generation
    // (spec RESUMABLE-SESSIONS §6), so a session that was reply-resumed (generation
    // bumped) then parked stays reply-resumable from its newest output after a
    // manual console resume — its sends carry the live generation, not 0.
    // §4.3: buildSessionTools throws in agents mode when the account is unresolvable.
    // Caught here and surfaced as a fatal outcome so the manual-resume handler can
    // re-park / discard without leaving the session stuck as "running".
    let tools: ReturnType<typeof buildSessionTools>;
    try {
      tools = buildSessionTools(inbound, record.id, target, record.sessionType, usage, row.resume_generation);
    } catch (wsErr) {
      return {
        outcome: "fatal",
        error: `workspace unresolvable (§4.3): ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`,
      };
    }
    // Fresh mode only: the rebuilt context's kickoff turn + persistence
    // snapshot — run and persisted exactly like a launch.
    let kickoff;
    let snapshot: ContextMessage[] | undefined;
    let tokenEstimate: number | undefined;
    if (material.mode === "fresh") {
      // The transcript never flushed (hard crash before the first turn_end —
      // e.g. a kill mid-first-request): no turn committed, so no side effect
      // can be duplicated. There is no transcript to replay, but the durable
      // row's trigger still points at the original timeline event — rebuild
      // the context fresh and re-run the session like a launch, reusing the
      // same row. The rebuild sees the timeline as of NOW (including messages
      // that arrived after the crash), which a launch would too.
      try {
        ({ agent, finalTurn: kickoff, snapshot, tokenEstimate } = await factory.create(record, tools, {
          proactive: isProactiveResume ? true : undefined,
          abortSignal: drainAbort.signal,
          usage,
          userLimit: recoveryGate?.userLimit,
          costCeilingOverride: recoveryGate?.ceilingOverride,
        }));
        if (!kickoff) throw new Error("context build produced no final user turn");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A build-wait timeout is environmental (an outage backing up summary
        // coverage) — mechanical, so the manual resume re-parks instead of
        // discarding; anything else thrown here is our own code → fatal.
        return error instanceof Error && error.name === "BuildWaitTimeoutError"
          ? { outcome: "mechanical", error: message }
          : { outcome: "fatal", error: `resume rebuild failed: ${message}` };
      }
    } else {
      try {
        // Continue mode inherits the row's persisted totals so the resumed
        // session keeps accumulating from where it left off (spec §4.3).
        ({ agent } = await factory.create(record, tools, {
          resume: material,
          usage,
          userLimit: recoveryGate?.userLimit,
          costCeilingOverride: recoveryGate?.ceilingOverride,
        }));
      } catch (error) {
        return {
          outcome: "fatal",
          error: `resume factory failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    sessions.markRunning(record.id);
    sessions.attachAgent(record.id, agent);
    // Continue-mode: snapshot omitted — the durable row already holds it
    // (written once at original creation); only the transcript keeps flushing.
    // Fresh mode: pass the REBUILT snapshot so the row reflects the context
    // this run actually used (overwriting the stale original).
    // Resolve the cost ceiling ONCE per run (spec SESSION-COST-LIMITS §3/§6) and
    // share it between the settle log (self-contained spend-vs-ceiling line) and
    // the soft-warn watcher, rather than resolving it twice. The per-user dynamic
    // ceiling (PER-USER-LIMITS §6.3) tightens it to the user's remaining headroom.
    const costCeiling = recoveryGate?.ceilingOverride ?? factory.resolveSessionCostCeiling(record.sessionType);
    const captureHandle = attachSessionCapture(agent, {
      storage,
      sessionId: record.id,
      snapshot,
      tokenEstimate,
      usage,
      timelineKey: record.timelineKey,
      sessionType: record.sessionType,
      // Thread `record.timelineKey` for per-agent model resolution (spec §4/§8).
      model: factory.resolveModelId(record.sessionType, record.timelineKey),
      maxSessionCostUsd: costCeiling,
      logger,
    });
    // Soft cost-budget interjection (spec SESSION-COST-LIMITS §2.1); the combined
    // spend is seeded from the row above, so a resumed session warns/blocks from
    // where it left off. Torn down with the capture handle in the finally.
    const costWarnUnsub = wireCostBudgetWarner(record.id, record.sessionType, usage, costCeiling);
    const runner = new SessionRunner({
      provider: providers.get(target.provider),
      target,
      suppressTyping: record.sessionType === (config.proactive?.session_type ?? "proactive"),
    });
    try {
      const result = await runner.run(
        agent,
        record,
        config.agent.sessions.forced_completion_retries,
        // Fresh mode prompts the rebuilt kickoff turn; continue-mode passes
        // undefined → agent.continue() redoes the failed request from the
        // transcript tail.
        kickoff,
        sessions.runLifecycle(record.id),
      );
      sessions.markCompleted(record.id, { noReply: result.noReply });
      logger.info("session_resumed_completed", {
        sessionId: record.id,
        attempt,
        mode: material.mode,
        noReply: result.noReply,
      });
      return { outcome: "completed" };
    } catch (error) {
      try {
        await captureHandle.flushNow();
      } catch {
        // flush is best-effort; the original error wins
      }
      const message = error instanceof Error ? error.message : String(error);
      // Three-way outcome (spec LLM-FAILURE-HANDLING §3/§8.2): environmental →
      // mechanical (retryable resume), other LLM-layer classes → content (park,
      // never discard — P5), untagged (our own code) → fatal.
      const outcome = isResumableRunError(error)
        ? "mechanical"
        : isLlmRunFailure(error)
          ? "content"
          : "fatal";
      return { outcome, error: message };
    } finally {
      captureHandle.detach();
      costWarnUnsub();
    }
  }

  /**
   * Manual console resume of a parked `failed-resumable` or `interrupted`
   * session (spec §6.2 / Decision D — the only operator action; there are no
   * chat commands). The whole policy — double-POST guard, status + viability
   * gates, per-timeline slot, sender reconstruction from the durable row, and
   * the park/discard outcome handling (issues #16–#20) — lives in
   * `createManualResumeSession` (src/agent/recovery.ts) where it is
   * unit-testable; this wiring injects the runtime deps.
   */
  const runManualResume = createManualResumeSession({
    isDraining: () => draining,
    getSessionRow: (id) => storage.getAgentSession(id),
    // Per-agent workspace (spec MULTI-AGENT-SUPPORT §4.1/§4.3): resolve from the row's
    // stored timeline key so a manual console resume lands in the correct agent dir.
    // In agents mode an unresolvable account returns null → createManualResumeSession
    // maps that to outcome "unresumable", which the console surfaces to the operator.
    loadMaterial: (row) => {
      const wsEntry = resolveWorkspaceForTimeline(row.timeline_key);
      if (!wsEntry && config.agents) return Promise.resolve(null);
      return loadResumeMaterial(row, {
        media: storage,
        workspaceRoot: wsEntry?.workspaceRoot ?? workspaceRoot,
        logger,
      });
    },
    hasLiveSession: (id) => sessions.get(id) !== undefined,
    adopt: (record) => sessions.adopt(record),
    tryAcquireTimelineSlot: (timelineKey) => triggerCoordinator.tryAcquire(timelineKey),
    // Mirror launchSession's `.finally`: release the slot AND drain the next
    // queued trigger (issue #17), via the shared helper so the drained trigger's
    // claim is released on a pre-attribution launch failure too (review #1). During
    // drain the coordinator is cleared by stop(), so the helper skips — same as
    // launchSession does.
    releaseTimelineSlot: (timelineKey) => drainNextQueuedTrigger(timelineKey),
    // §6.3: provider self identity for the resume-reattachment path. The resume runs
    // post-start so getSelf is available; falls back to undefined (same handling as
    // "unknown account") when the provider isn't registered.
    selfUserIdForAccount: (accountId) => matrixProvider?.getSelf(accountId)?.id,
    runAttempt: (record, inbound) => resumeSessionRun(record, inbound, 0),
    markFailedResumable: (id, error) => sessions.markFailedResumable(id, { error }),
    markDiscarded: (id, error) => sessions.markDiscarded(id, { error }),
    logger,
  });

  /**
   * The console-facing wrapper tracks the in-flight resume in `activeRuns`
   * (issue #20) so `stop()`'s `waitForRuns` awaits it before the scheduler and
   * storage tear down — mirroring `launchSession`'s run tracking.
   */
  async function manualResumeSession(sessionId: string): Promise<ManualResumeResult> {
    const run = runManualResume(sessionId);
    const tracked: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    activeRuns.add(tracked);
    try {
      return await run;
    } finally {
      activeRuns.delete(tracked);
    }
  }

  /**
   * Configurable user-facing failure notice (spec LLM-FAILURE-HANDLING §8.3):
   * when `recovery.failure_notice` is a non-empty phrase, it is sent verbatim
   * to the session's outbound target when a USER-TRIGGERED chat session stops
   * trying on its own — it parked `failed-resumable`, or its build timed out
   * waiting on summary coverage during an outage. Best-effort: a send failure
   * is logged and never affects the park/discard. The actual error is NEVER
   * included — the phrase is static. Callers suppress it for proactive
   * sessions (nobody asked them anything); synthetic sessions never reach
   * these paths (no room audience).
   */
  function sendFailureNotice(
    target: NonNullable<InboundChatEvent["outboundTarget"]> | undefined,
    sessionId: string,
  ): void {
    const phrase = config.recovery?.failure_notice;
    if (!phrase || phrase.length === 0 || !target) return;
    sendViaProvider(providers, target, { body: phrase, agentSessionId: sessionId }, logger, "failure_notice", (error) => {
      logger.warn("failure_notice_send_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ── Resumable sessions (spec RESUMABLE-SESSIONS) ────────────────────────────
  //
  // The trigger pipeline stays entirely resume-unaware (§4); the resume-vs-fresh
  // decision is a single fork made DOWNSTREAM, at session creation (the top of
  // launchSession). Everything the resume branch needs — snapshot, transcript,
  // adopt, the appended turn — is the existing failure-recovery machinery plus the
  // render pieces in builder/factory.

  /** Synchronous single-flight guard for the resume fork (§15 concurrent replies). */
  const resumeClaims = new Set<string>();
  /** One-line browser note for the resumed satellite's runtime_state (§11). */
  const RESUME_BROWSER_NOTE =
    "Your browser tab from the previous turn was closed when that run settled, but its " +
    "login/cookies persist on the shared identity — reopen the browser tool if you need it.";

  /**
   * DM vs group from the timeline key. Uses the shared grammar parser (spec
   * DISCORD-SUPPORT-DESIGN §4.2) so the kind segment is read positionally, not
   * by substring search — correct for Matrix and future provider keys alike.
   * Falls back to "group" for malformed or absent keys (same as before).
   *
   * Reused by the provider's `resolveReplyTrigger` callback (reply-as-trigger,
   * §5) and the resume fork; call sites that have a full `InboundChatEvent`
   * should prefer `inbound.channelType` (spec §4.3) via the `channelTypeOf`
   * helper before falling back to this key-based derivation.
   */
  function resumeContextFor(timelineKey: string): "dm" | "group" {
    return timelineKindOf(timelineKey) === "dm" ? "dm" : "group";
  }

  /**
   * The work gate's exempt tool-NAME set: the context-free built-in set (derived
   * once from the tool factories' static `resumeWorkExempt` flags, independent of
   * `roomId`/target — see {@link BUILTIN_RESUME_EXEMPT_TOOL_NAMES}) unioned with this
   * context's `extra_exempt_tools` (which may include `mcp__…` names, §7a knob 2).
   * Deriving the built-ins context-free avoids the old per-inbound `buildSessionTools`
   * probe, whose room-scoped exempt tools dropped out for a falsy `roomId`.
   */
  function resumeExemptToolNames(extra: readonly string[]): Set<string> {
    return new Set<string>([...BUILTIN_RESUME_EXEMPT_TOOL_NAMES, ...extra]);
  }

  /** Release this timeline's slot and launch the next queued trigger (mirrors the
   *  fresh run's `.finally`; no-op while draining). The single funnel for every
   *  queued-drain tail (active spawn, resume, co-reply, manual resume, proactive,
   *  and the immediate-discard gates) so the claim-release semantics below stay in
   *  one place (review #1). */
  function drainNextQueuedTrigger(timelineKey: string): void {
    if (draining) return;
    const next = triggerCoordinator.complete(timelineKey);
    if (!next) return;
    void launchSession(next, true).catch((error) => {
      // Pre-attribution launch failure (review #1): release the drained trigger's
      // accept-time claim so it cannot leak un-attributed (no settle was registered
      // — the throw is before `attachSession`; idempotent past it). Without this a
      // failed drain leaves a permanent false-positive `<handled_by_session>` marker
      // / guard entry for that message id until shutdown `clear()`.
      releaseClaimFor(next);
      logger.error("queued_session_launch_failed", {
        timelineKey: next.timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
      // Release the per-timeline slot so future triggers aren't permanently blocked.
      triggerCoordinator.complete(next.timelineKey);
    });
  }

  /**
   * The resume fork (spec RESUMABLE-SESSIONS §7). Returns true when a reply
   * continues a COMPLETED, resume-eligible session — the resumed run then owns this
   * trigger's timeline slot + claim lifecycle (released on settle). Returns false
   * (any gate fails / not a reply-to-bot) → the caller proceeds with a normal FRESH
   * launch, which owns the slot instead. Pure degrade: a wrong guess is FRESH,
   * never corruption or message loss.
   */
  async function tryReplyResume(inbound: InboundChatEvent, duplicate: boolean): Promise<boolean> {
    const target = inbound.outboundTarget;
    const replyExternalId = inbound.event.replyTo?.externalId;
    if (!target || !replyExternalId) return false;
    const ctx = channelTypeOf(inbound); // prefer channelType (spec §4.3)
    const resumeCfg = config.agent.sessions.resume;
    if (resumeCfg?.enabled?.[ctx] !== true) return false; // §7 step 0: enabled? else FRESH

    const targetEvent = timeline.getByExternalId(inbound.provider, replyExternalId, inbound.timelineKey);
    const sessionId = targetEvent?.agentSessionId;
    if (!targetEvent || targetEvent.timelineKey !== inbound.timelineKey || !sessionId) return false;
    // A live in-memory record (running/resuming) is the steer path's business (§7.1)
    // — steerReplyToActiveSession already ran for running sessions; either way this
    // is not a completed-session fork.
    if (sessions.get(sessionId)) return false;
    // Synchronous single-flight (§15): only the first reply resumes a given state.
    // A concurrent second reply degrades to FRESH; once the first markRunning's,
    // later replies steer via the running-session path instead.
    if (resumeClaims.has(sessionId)) return false;
    resumeClaims.add(sessionId);
    try {
      // ── Pre-CAS gate (§7 steps 2–8) ────────────────────────────────────────
      // Delegated to the throw-safe `evaluateResumeGate` (review issue #2): every
      // ineligible reply — and any UNEXPECTED throw inside the gate (DB read,
      // ceiling resolution, material load, work scan) — yields `{resume:false}`,
      // which we degrade to FRESH below. A throw must never escape here: it would
      // unwind through `launchSession` (no try/catch at the call site) → the
      // dispatch rethrow, dropping the user's message with no reply, violating the
      // never-drop invariant (§2/§7). Must precede the CAS — once
      // `acceptResumeGeneration` bumps the generation we own the slot and the
      // post-accept path (below) handles its own failures. The `row`/`material`
      // captured here are the ORIGINAL snapshot the spec reuses for the resumed run.
      const verdict = await evaluateResumeGate({
        sessionId,
        getSession: () => storage.getAgentSession(sessionId),
        targetEvent,
        inbound,
        ctx,
        resumeCfg,
        exemptToolNames: resumeExemptToolNames(resumeCfg.work_gate?.[ctx]?.extra_exempt_tools ?? []),
        // Thread timelineKey (supplied by the gate from row.timeline_key) for per-agent
        // model resolution (spec PER-AGENT-MODEL-OVERRIDES FIX 7).
        resolveCeiling: (sessionType, timelineKey) => factory.resolveSessionContextCeiling(sessionType, timelineKey),
        // Per-agent workspace (spec MULTI-AGENT-SUPPORT §4.1/§4.3): the row's stored
        // timeline key identifies the agent; resolve its workspace so images and
        // memory files are loaded from the correct per-agent directory.
        // In agents mode an unresolvable account returns null → gate rejects (no resume).
        loadMaterial: (row) => {
          const wsEntry = resolveWorkspaceForTimeline(row.timeline_key);
          if (!wsEntry && config.agents) return Promise.resolve(null);
          return loadCompletedSessionMaterial(row, {
            media: storage,
            workspaceRoot: wsEntry?.workspaceRoot ?? workspaceRoot,
            logger,
          });
        },
        logger,
      });
      if (!verdict.resume) return false;
      const { row, material } = verdict;

      // All gates pass → ACCEPT. Single-consumption CAS (§6): completed → resuming,
      // bump generation. A racing reply that already consumed this state gets
      // `undefined` here → FRESH.
      const generation = await storage.acceptResumeGeneration(sessionId);
      if (generation === undefined) return false;
      // Gap backfill (spec RESUMABLE-SESSIONS §9): active only when BOTH limits are
      // non-zero (0 = include none). Lower bound = the trigger group's latest member
      // the session ALREADY covers (§9.2): its persisted `chat_upper_bound_ts` —
      // its original trigger on creation, advanced to each accepted resume's trigger.
      // NULL only on a legacy (pre-v27) row's first resume → a one-time bounded
      // fallback to the replied-to message's timestamp. Read from the in-memory `row`
      // (read-old), before the write-new inside `runResumeSession` — no race.
      const gapCfg = resumeCfg.gap?.[ctx];
      const gapActive =
        !!gapCfg && (gapCfg.max_messages ?? 0) !== 0 && (gapCfg.max_tokens ?? 0) !== 0;
      const gap = gapActive
        ? {
            maxMessages: gapCfg!.max_messages ?? 0,
            maxTokens: gapCfg!.max_tokens ?? 0,
            lowerBoundTimestamp: row.chat_upper_bound_ts ?? targetEvent.timestamp,
          }
        : undefined;
      // Past the CAS we own the trigger's timeline slot (return true → no FRESH
      // launch). `runResumeSession` wires the run's `.finally` slot-drain, but a
      // throw in its pre-run setup (adopt/markRunning/tool build) would settle before
      // that — so guard it: evict any adopted record and drain the slot so the
      // timeline can't deadlock. The orphaned generation bump is harmless (the row is
      // no longer `completed` → future replies fork FRESH, §6).
      try {
        await runResumeSession({
          inbound,
          duplicate,
          target,
          row,
          material,
          generation,
          continuation: { tail: resumeCfg.satellite?.tail ?? true, gap },
          resumeLabel: "reply",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sessions.get(sessionId)) sessions.markDiscarded(sessionId, { error: message });
        logger.error("session_resume_setup_threw", { sessionId, timelineKey: inbound.timelineKey, error: message });
        drainNextQueuedTrigger(inbound.timelineKey);
        // The resumed session never went live, yet we returned `true` (took over this
        // trigger's slot) so the FRESH launch below never runs — the reply would get no
        // response. Re-dispatch it as its own trigger (review issue #4, symmetric with
        // `resumeFollowUp`) so the never-drop invariant holds. A reply reaching here is
        // always trigger-bearing (resolved upstream in the provider hold), so this always
        // re-dispatches. On the re-dispatched launch the row is no longer `completed`
        // (the CAS bumped it; `markDiscarded` set it `discarded`), so `tryReplyResume`
        // falls through to a FRESH session rather than looping. No double-dispatch: the
        // discarded session adopted no parked entries (a reply trigger is not parked).
        void redispatchCoReply(inbound).catch((redispatchError) => {
          logger.error("session_resume_setup_redispatch_failed", {
            sessionId,
            timelineKey: inbound.timelineKey,
            error: redispatchError instanceof Error ? redispatchError.message : String(redispatchError),
          });
        });
      }
      return true;
    } finally {
      resumeClaims.delete(sessionId);
    }
  }

  /**
   * Adopt the accepted session and run the resumed rollout (spec RESUMABLE-SESSIONS
   * §7/§9/§11; spec FOLLOWUP-FOLDING §5.3). Shared by reply-to-continue (a reply to
   * a completed bot message) and follow-up folding's settled→resume branch — the
   * caller resolves eligibility through its own gate, performs the single-consumption
   * CAS, and hands in the pre-computed `continuation` (satellite tail, gap budget,
   * and the optional follow-up trigger preamble). Mirrors the fresh run's lifecycle
   * tail (claim attribution, follow-up watch re-arm, capture, run/settle, slot drain,
   * browser close); the differences are: the row is ADOPTED (not created), usage seed
   * + generation come from the bumped row, the snapshot is reused (capture re-persists
   * only the growing transcript), and the kickoff is the freshly-built appended turn.
   */
  async function runResumeSession(args: {
    inbound: InboundChatEvent;
    duplicate: boolean;
    target: NonNullable<InboundChatEvent["outboundTarget"]>;
    row: ReturnType<typeof storage.getAgentSession> & object;
    material: NonNullable<Awaited<ReturnType<typeof loadCompletedSessionMaterial>>>;
    generation: number;
    /** Pre-computed appended-turn options (gap/tail resolved by the caller, §9/§5.3). */
    continuation: {
      tail: boolean;
      gap?: { maxMessages: number; maxTokens: number; lowerBoundTimestamp: number };
      triggerPreamble?: string;
    };
    /** Which resume path drove this — used only for log attribution. */
    resumeLabel: "reply" | "follow-up";
  }): Promise<void> {
    const { inbound, duplicate, target, row, material, generation, continuation, resumeLabel } = args;
    const record: AgentSessionRecord = {
      id: row.id,
      timelineKey: row.timeline_key,
      sessionType: row.session_type,
      status: "resuming",
      trigger: inbound,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
    };
    sessions.adopt(record);
    sessions.markRunning(record.id);
    // Claim attribution + release-on-settle, identical to a fresh launch.
    if (inbound.event.externalId) {
      sessionClaims.attachSession(record.timelineKey, inbound.event.externalId, record.id);
    }
    // Re-arm the follow-up watch to this resumed session (spec FOLLOWUP-FOLDING §7
    // resume-chain invariance): a subsequent bare follow-up folds into the resumed
    // session, so chains stay linear across mixed reply-resume / follow-up-resume
    // steps. Same seam as the claim attribution (post-fork), so it names the live
    // session; `inbound.event.timestamp` re-anchors the user-gap clock to this turn.
    // Unlike the fresh-launch arm, this call is not `!proactive`-guarded: a resumed
    // session is never proactive (proactive sessions never resume), and
    // `armFollowUpWatch` re-checks self/synthetic regardless.
    armFollowUpWatch(inbound, record.id);
    sessions.onSettle(record.id, () => sessionClaims.releaseSession(record.timelineKey, record.id));
    const ownerExternalId = inbound.event.externalId;
    if (ownerExternalId) {
      sessions.onSettle(record.id, () => redispatchPendingCoReplies(ownerExternalId));
    }
    // Abandonment fallback for any follow-ups parked on this resumed session before it
    // went live (spec FOLLOWUP-FOLDING §5.2): on the success path the post-attachAgent
    // drain consumes them, so this fires on nothing.
    sessions.onSettle(record.id, () => revertAbandonedFollowUps(record.id));
    logger.info("session_resume_started", {
      sessionId: record.id,
      timelineKey: record.timelineKey,
      generation,
      context: resumeContextFor(record.timelineKey),
      resumeLabel,
    });

    // Per-user limits — Gate A for a resume (spec PER-USER-LIMITS §6). A resume is the
    // SAME event as a fresh trigger from the per-user system's view (same replying
    // user, same room, same budget), so the identical gate runs: a banned / out-of-
    // budget user is refused (the reply gets the templated "out of budget" message and
    // the session stays completed), otherwise the resolution is frozen so per-request
    // selection / capping / live counter recording all apply to the continued rollout.
    //
    // Bot-triggered sessions skip Gate A here too — same rule as the fresh-session
    // path (spec MULTI-AGENT-SUPPORT §9): sibling and capped-third-party-bot spend
    // is never metered per-user. `isBotTriggeredSender` reads trigger.triggeredBy
    // first, which — after the resolveReplyTrigger fix — now carries isBot/isWebhook.
    let resumeGate: UserLimitGate | undefined;
    if (!isBotTriggeredSender(inbound)) {
      resumeGate = await resolveUserLimitGate(inbound, record.id, record.sessionType);
      if (resumeGate.denied) {
        postUserLimitRefusal(target, record.id, record.timelineKey, resumeGate);
        sessions.markDiscarded(record.id);
        drainNextQueuedTrigger(record.timelineKey);
        return;
      }
    }

    // Usage continues accumulating from the row (continue-mode seed).
    const usage = new SessionUsageTracker(
      resumeUsageSeed(row, "continue"),
      selectToolCostSeed("continue", () => storage.getSessionToolUsage(record.id).cost),
    );

    // Gap backfill (§9): the caller resolved the budget + lower bound (reply-resume
    // reads it from `[agent.sessions.resume.gap]`; a follow-up resume omits it — the
    // continuation arrives seconds later, so there is nothing meaningful to surface).
    const gap = continuation.gap;

    // Advance the gap lower bound to THIS resume's trigger group latest member
    // (== `inbound.event.timestamp`, the upper bound `renderResumeGap` walks back
    // from) so the NEXT resume's gap starts where this one ends (spec §9.2). Always
    // advanced on an accepted resume — independent of whether the gap is currently
    // enabled — so toggling the gap on mid-chain still computes from the right
    // bound. Fire-and-forget on the single-writer queue (the read above already
    // captured the old value into `gap`).
    void storage.setSessionChatUpperBound(record.id, inbound.event.timestamp);

    let agent;
    let kickoff;
    try {
      // §4.3: buildSessionTools throws in agents mode when the account is unresolvable.
      // Placed INSIDE the try block so the existing catch handles it identically to a
      // factory failure (markDiscarded + drain). Synchronous — no async ordering concern.
      const tools = buildSessionTools(inbound, record.id, target, record.sessionType, usage, generation);
      // Readiness wait (spec CLAIM-VISIBILITY-SERIALIZATION §4.1/§4.2): the resumed
      // session is already visible-as-running (`adopt`/`markRunning` above) and its
      // claim attributed, so wait for the reply trigger's enrichment + caption
      // readiness HERE — a reply that itself carries fresh media gets its appended
      // turn built with the caption ready, instead of skipping the wait as before.
      await awaitTriggerReadiness(inbound);
      // The trigger's enrichment download is now complete (readiness wait above), so
      // hydrate its event before the appended turn is built. `buildResumeTurn →
      // selectImageBlocks` needs the attachment's `localPath` to deliver a media
      // follow-up's image as REAL PIXELS (spec FOLLOWUP-FOLDING §5.3/§10), and the raw
      // provider event never carries it — only `hydrateEvents` (reading the media_assets
      // row) does. Without this the folded image silently degrades to its caption — the
      // exact loss the fold exists to prevent — because the folded event has no trigger
      // group either (it was consumed before `accept`/`setTriggerGroup`). This also
      // hydrates a reply-resume whose reply itself carried fresh media. Mirrors the
      // steer path's `followUpHydratedEvent`; falls back to the raw event (caption-only)
      // if the row is somehow not stored yet.
      record.trigger = { ...record.trigger, event: followUpHydratedEvent(record.trigger) };
      ({ agent, finalTurn: kickoff } = await factory.create(record, tools, {
        resume: material,
        resumeContinuation: {
          tail: continuation.tail,
          browserNote: resolveAgentBrowserSession(resolveWorkspaceForTimeline(record.timelineKey)?.agentName ?? null) ? RESUME_BROWSER_NOTE : undefined,
          gap,
          triggerPreamble: continuation.triggerPreamble,
        },
        usage,
        // Per-user selection + dynamic ceiling apply to a resume exactly as to a
        // fresh launch (spec PER-USER-LIMITS §6). Both are undefined when bot-triggered
        // (resumeGate is undefined — Gate A was skipped).
        userLimit: resumeGate?.userLimit,
        costCeilingOverride: resumeGate?.ceilingOverride,
        abortSignal: drainAbort.signal,
      }));
      if (!kickoff) throw new Error("resume continuation produced no appended turn");
    } catch (error) {
      const buildTimeout = error instanceof Error && error.name === "BuildWaitTimeoutError";
      sessions.markDiscarded(record.id, {
        error: error instanceof Error ? error.message : String(error),
      });
      const unresolvableAccount = error instanceof Error && error.message.startsWith("§4.3:");
      logger.error(
        buildTimeout
          ? "session_resume_build_wait_timeout"
          : unresolvableAccount
            ? "session_resume_skipped_unresolvable_account"
            : "session_resume_factory_failed",
        {
        sessionId: record.id,
        timelineKey: record.timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
      if (buildTimeout) sendFailureNotice(target, record.id);
      drainNextQueuedTrigger(record.timelineKey);
      return;
    }
    sessions.attachAgent(record.id, agent);
    if (ownerExternalId) drainPendingCoRepliesIntoSession(ownerExternalId, record.id);
    // Follow-ups parked while this resumed session was building (§5.2) — steer them in
    // now that it is live (a follow-up resume can itself accrue a parked follow-up).
    drainPendingFollowUpsIntoSession(record.id);
    // Resume-path `spawn_session` affordance for a re-`@` fold (review Q1): a mention-form
    // follow-up resume names `spawn_session(message_id=…)` in its preamble (the bare
    // media/text forms do not), but the tool resolves `message_id` ONLY from the in-memory
    // `coReplyInbounds` map — preamble text alone yields `not_found`. Retain the resume
    // turn's trigger so the call resolves; scoped to the **mention** form to match the
    // preamble and preserve the "media/text follow-up IS the new turn" framing. The
    // mention-form resume inbound is trigger-bearing, so the passthrough uses the real
    // trigger (no synthesis). Cleaned up on settle / on use, like every other retention.
    if (resumeLabel === "follow-up" && classifyFollowUpForm(record.trigger.event) === "mention") {
      retainFollowUpForSpawn(record.trigger, record.id);
    }

    // Effective ceiling reflects the user's remaining headroom (spec §6.3), as for a launch.
    // resumeGate is undefined for bot-triggered sessions (Gate A was skipped) — falls through
    // to the static session ceiling, which is the correct behaviour (no per-user headroom cap).
    const costCeiling = resumeGate?.ceilingOverride ?? factory.resolveSessionCostCeiling(record.sessionType);
    const captureHandle = attachSessionCapture(agent, {
      storage,
      sessionId: record.id,
      // The frozen prefix is unchanged on resume (the original snapshot stays
      // persisted); capture re-persists only the GROWING transcript.
      snapshot: undefined,
      tokenEstimate: undefined,
      usage,
      timelineKey: record.timelineKey,
      sessionType: record.sessionType,
      // Thread `record.timelineKey` for per-agent model resolution (spec §4/§8).
      model: factory.resolveModelId(record.sessionType, record.timelineKey),
      maxSessionCostUsd: costCeiling,
      logger,
    });
    const costWarnUnsub = wireCostBudgetWarner(record.id, record.sessionType, usage, costCeiling);
    const runner = new SessionRunner({ provider: providers.get(target.provider), target, suppressTyping: false });
    const run = runner
      .run(agent, record, config.agent.sessions.forced_completion_retries, kickoff, sessions.runLifecycle(record.id))
      .then((result) => {
        sessions.markCompleted(record.id, { noReply: result.noReply });
        logger.info("session_resumed_completed", {
          sessionId: record.id,
          generation,
          noReply: result.noReply,
          duplicate,
        });
      })
      .catch(async (error) => {
        try {
          await captureHandle.flushNow();
        } catch (flushErr) {
          logger.error("session capture: resume error-path flush failed", {
            sessionId: record.id,
            error: flushErr instanceof Error ? flushErr.message : String(flushErr),
          });
        }
        // Same park-never-discard policy as a fresh run: an LLM-layer failure parks
        // `failed-resumable` (the console can redo it). The bumped generation is
        // harmless — the session is no longer `completed`, so a reply to its prior
        // output now forks FRESH (spec §6 "failed resumes are safe").
        if (isLlmRunFailure(error)) {
          sessions.markFailedResumable(record.id, {
            error: error instanceof Error ? error.message : String(error),
          });
          logger.error("session_resume_parked_failed_resumable", {
            sessionId: record.id,
            timelineKey: record.timelineKey,
            error: error instanceof Error ? error.message : String(error),
          });
          sendFailureNotice(target, record.id);
          return;
        }
        sessions.markDiscarded(record.id, {
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error("session_resume_failed", {
          sessionId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        captureHandle.detach();
        costWarnUnsub();
        activeRuns.delete(run);
        // Per-session browser close (§10a): close this session's tab(s). Use the
        // per-agent session in agents mode, or the global legacy session.
        const recordBrowserSession = resolveAgentBrowserSession(
          resolveWorkspaceForTimeline(record.timelineKey)?.agentName ?? null,
        );
        if (recordBrowserSession) {
          void recordBrowserSession.closeSession(record.id).catch((error) => {
            logger.warn("browser_session_close_failed", {
              sessionId: record.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        drainNextQueuedTrigger(record.timelineKey);
      });
    activeRuns.add(run);
  }

  async function launchSession(
    inbound: InboundChatEvent,
    duplicate: boolean,
    opts?: { proactive?: boolean },
  ): Promise<void> {
    // Proactive sessions (ARCHITECTURE.md §9g) reuse this launcher verbatim; the
    // only branches are the session type (counted for budget), the proactive
    // context-build mode, and typing suppression. Everything else — tool assembly,
    // capture, slot release, queued-trigger drainage — is shared.
    const proactive = opts?.proactive === true;
    // Resume fork (spec RESUMABLE-SESSIONS §7): a reply that continues a completed,
    // eligible session takes over this trigger's slot and returns true. Any gate
    // failing (or a non-reply/proactive trigger) falls through to the FRESH launch
    // below. This is the ONLY new branch — the trigger pipeline above is unchanged.
    if (!proactive && (await tryReplyResume(inbound, duplicate))) return;
    const sessionType = proactive ? config.proactive?.session_type ?? "proactive" : "default";
    // Seed the durable row's model at creation (resolveModelId mirrors the diary/
    // summarize workers) so the model is present from the outset; the per-request
    // write-back rewrites it with the actually-billed model.
    //
    // The seed is the UPSTREAM wire id (head's resolved `id`), not the spec §6.1
    // "head's logical id". That is deliberate and correct: `agent_sessions` has no
    // logical-id column, the per-attempt budget gate keys on LOGICAL ids via
    // `resolveModelChainLogicalIds` (the chain-admission gate below), and the
    // per-request `usage_events` ledger stamps the exact billed logical id (§7).
    // The §6.1 "seed with the head's logical id" obligation is therefore discharged
    // by the chain gate + per-request ledger; `agent_sessions.model_id` stays the
    // upstream id as provisional provenance until the first request rewrites it.
    // Thread `inbound.timelineKey` for per-agent model resolution (spec §4/§8).
    const session = sessions.createPlaceholder(inbound, sessionType, factory.resolveModelId(sessionType, inbound.timelineKey));
    sessions.markRunning(session.id);
    // Attribute the claim added at accept time to this session and release it when
    // the run settles (spec DUPLICATE-REPLY-MITIGATION §3.3). Registered before the
    // outbound-target check below so even the immediate-discard paths fire the
    // release on evict. Proactive/synthetic triggers have no external id → no claim,
    // and `releaseSession` is a no-op for a session that never claimed.
    if (inbound.event.externalId) {
      sessionClaims.attachSession(session.timelineKey, inbound.event.externalId, session.id);
    }
    // Arm the follow-up watch for this sender (spec FOLLOWUP-FOLDING §4.1/§7): a quick
    // same-sender follow-up now folds into THIS session. Same seam as the claim
    // attribution (post resume-vs-fresh fork), so the watch names the session that
    // actually handled the trigger. Skipped for proactive launches (no human follow-up
    // to fold) and for synthetic triggers (no external id); guarded inside the helper.
    if (!proactive) armFollowUpWatch(inbound, session.id);
    sessions.onSettle(session.id, () => sessionClaims.releaseSession(session.timelineKey, session.id));
    // Deferred-coalescing fallback (spec DEFERRED-COALESCING): if this session is
    // abandoned before it goes live (the missing-target / factory-failed early
    // returns below both route through evict→fireSettle), re-dispatch any co-replies
    // still parked on its trigger so they are never dropped. On the success path the
    // post-attachAgent drain has already consumed them, so this fires on nothing.
    const ownerExternalId = inbound.event.externalId;
    if (ownerExternalId) {
      sessions.onSettle(session.id, () => redispatchPendingCoReplies(ownerExternalId));
    }
    // Follow-up abandonment fallback (spec FOLLOWUP-FOLDING §5.2): the same evict→
    // fireSettle paths revert any follow-ups parked on this session to native fate
    // (trigger-bearing → own trigger; bare group → inert). Consumed by the
    // post-attachAgent drain on the success path, so this then fires on nothing.
    sessions.onSettle(session.id, () => revertAbandonedFollowUps(session.id));
    logger.info("session_started", { sessionId: session.id, timelineKey: session.timelineKey, proactive });
    const target = inbound.outboundTarget;
    if (!target) {
      sessions.markDiscarded(session.id);
      logger.error("session_missing_outbound_target", {
        sessionId: session.id,
        timelineKey: session.timelineKey,
        provider: inbound.provider,
      });
      drainNextQueuedTrigger(session.timelineKey);
      return;
    }
    // Per-user limits — Gate A (spec PER-USER-LIMITS §6.1), resolved BEFORE the §8e
    // admission gate so the selected (possibly upgraded) model's chain — not the
    // session-type default — is what §8e gates on. HUMAN agent loop only; proactive/
    // background never gate. A denied (banned / out-of-budget) user is refused with
    // the optional templated reply; otherwise the resolution is frozen for
    // per-request selection + the dynamic ceiling. Identical logic runs in the resume
    // paths (`resolveUserLimitGate` is shared) — a resume is the same event.
    //
    // Bot-triggered sessions (siblings in capped mode, third-party bots in capped
    // mode) skip Gate A entirely: "Bot-to-bot spend … never toward any per-user
    // meter" (spec MULTI-AGENT-SUPPORT §9). Their spend counts toward deployment
    // [[limits]] only — no per-user attribution. Unlimited-mode third-party bots
    // preserve today's behaviour (Gate A runs, spend is attributed).
    const isBotTriggered = isBotTriggeredSender(inbound);
    let userLimitForCreate: UserLimitGate["userLimit"];
    let userCeilingOverride: number | undefined;
    let initialUserModel: string | undefined;
    if (!proactive && !isBotTriggered) {
      const gate = await resolveUserLimitGate(inbound, session.id, session.sessionType);
      if (gate.denied) {
        postUserLimitRefusal(target, session.id, session.timelineKey, gate);
        sessions.markDiscarded(session.id);
        drainNextQueuedTrigger(session.timelineKey);
        return;
      }
      userLimitForCreate = gate.userLimit;
      userCeilingOverride = gate.ceilingOverride;
      initialUserModel = gate.initialModel;
    }
    // Period cost limits — triggered/proactive admission gate (spec
    // USAGE-COST-LIMITS §6.3 / §2.1). Refuse to spawn when the session's own
    // covering rules are over budget OR a class it structurally depends on
    // (summarization) is blocked. A human trigger gets an immediate, informative
    // refusal (the optional templated reply); proactive is silent (the scheduler
    // already clamps its cadence). Not queued — an hours-late autonomous reply is
    // worse than a clear "back at X". Reuses the discard/drain plumbing above.
    if (budgetHooks.engine) {
      // Gate §8e on the per-user-SELECTED model's chain when active (spec
      // PER-USER-LIMITS §6.1) — so a §8e per-model cap on the session-type default
      // never refuses a session that will actually run on a different (upgraded)
      // model. Falls back to the session-type default when per-user is inactive.
      let admissionModelId: string | undefined;
      try {
        // Thread `session.timelineKey` for per-agent model resolution (spec §4/§8).
        admissionModelId = initialUserModel
          ? factory.resolveUpstreamModelId(initialUserModel)
          : factory.resolveModelId(session.sessionType, session.timelineKey);
      } catch {
        admissionModelId = undefined;
      }
      // Chain-aware admission (spec MODEL-FALLBACK §6.1): gate on the WHOLE fallback
      // chain (logical ids), so a model-scoped cap on the primary doesn't refuse a
      // session an in-budget fallback could serve. Resolution is isolated like the
      // model-id resolution above — a throw leaves it undefined → head-only gate.
      let admissionChain: string[] | undefined;
      try {
        // Thread `session.timelineKey` for per-agent chain resolution (spec §4/§8).
        admissionChain = initialUserModel
          ? factory.resolveModelChainLogicalIdsForModel(initialUserModel)
          : factory.resolveModelChainLogicalIds(session.sessionType, session.timelineKey);
      } catch {
        admissionChain = undefined;
      }
      // Exception-isolated, fail-open admission decision (review #7): a throw inside
      // the engine call would unwind to the dispatch `catch` (releaseClaimFor +
      // rethrow, but NOT `triggerCoordinator.complete`), leaking the per-timeline
      // slot. `safeCheckAdmission` returns undefined on a throw → we fall through to
      // a normal launch (admit), so a budget-engine bug never stops the bot replying.
      const admission = admissionModelId
        ? safeCheckAdmission(
            budgetHooks.engine,
            session.sessionType,
            admissionModelId,
            logger,
            { sessionId: session.id, timelineKey: session.timelineKey },
            admissionChain,
            session.timelineKey ?? undefined,
          )
        : undefined;
      if (admission && !admission.allowed) {
        const gate = admission.dependency ? "dependency" : "trigger_admission";
        // The refusal-emission engine calls (`logBlocked`, `accurateResetsAt`) are
        // also isolated (review #7): the deny DECISION is already valid, so a throw
        // here must NOT escape and leak the slot — we still complete the discard +
        // drain below; we just skip the (failed) log / templated reply.
        try {
          budgetHooks.engine.logBlocked(
            gate,
            admission.dependency ? admission.dependency.blocking : admission.ownBlocking,
            { class: "agent_loop", sessionType: session.sessionType, modelId: admissionModelId! },
            {
              sessionId: session.id,
              timelineKey: session.timelineKey,
              ...(admission.dependency ? { dependsOn: admission.dependency.sessionType } : {}),
            },
          );
          // Human trigger: post the templated refusal if a covering global-capable
          // rule supplies one (silent otherwise, and always silent for proactive).
          if (!proactive) {
            const message = admission.primary?.triggerRejectionMessage;
            if (message && admission.primary) {
              // Accurate reset for the templated reply: a rolling rule frees up when
              // its oldest spend ages out, not at the full-duration upper bound the
              // gate carries (§5 #5). Fall back to the gate's value if unresolved.
              const resetsAt =
                budgetHooks.engine.accurateResetsAt(admission.primary.name) ?? admission.primary.resetsAt;
              const body = message.replace(/\{resets_at\}/g, formatResetsAt(resetsAt));
              sendViaProvider(providers, target, { body, agentSessionId: session.id }, logger, "budget_refusal", (error) => {
                logger.warn("usage_limit_rejection_send_failed", {
                  sessionId: session.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }
          }
        } catch (error) {
          logger.warn("usage_admission_refusal_threw", {
            sessionId: session.id,
            timelineKey: session.timelineKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        sessions.markDiscarded(session.id);
        drainNextQueuedTrigger(session.timelineKey);
        return;
      }
    }
    // Per-session-run usage tracker (spec SESSION-COST-LIMITS §5): constructed
    // here (fresh launch → empty seed) so the SAME instance receives both the
    // tool-cost feed (wired into buildSessionTools' recordToolUsage) and the
    // factory's Layer-0 agent-loop commits — the combined basis for the ceiling.
    const usage = new SessionUsageTracker();
    let agent;
    let kickoff;
    let snapshot: ContextMessage[] | undefined;
    let tokenEstimate: number | undefined;
    try {
      // §4.3: buildSessionTools throws when agents mode + unresolvable account.
      // Placed INSIDE the try block so the existing catch handles it identically
      // to a factory failure (markDiscarded + drain), without leaving the session
      // stuck as "running". Synchronous — no async ordering concern with the
      // awaitTriggerReadiness call below.
      const tools = buildSessionTools(inbound, session.id, target, session.sessionType, usage);
      // Readiness wait (spec CLAIM-VISIBILITY-SERIALIZATION §4.1): wait for the
      // trigger group's enrichment + caption readiness HERE — the session is already
      // visible-as-running (`createPlaceholder`/`markRunning` above) and its claim
      // attributed, AND it has cleared the missing-target + budget-admission gates, so
      // a refused/aborted session never blocks on captioning. The build below still
      // renders an enriched, captioned trigger group because the wait completes first.
      // A throw here (rare — `awaitTriggerReadiness` resolves on its own timeouts) is
      // caught by this same block → `markDiscarded` → settle releases the claim +
      // drains the next trigger, exactly like a factory failure. For a proactive /
      // synthetic trigger (no persisted event, no media) this is a fast no-op.
      await awaitTriggerReadiness(inbound);
      ({ agent, finalTurn: kickoff, snapshot, tokenEstimate } = await factory.create(
        session,
        tools,
        {
          proactive: proactive ? true : undefined,
          usage,
          // Per-user selection input + dynamic ceiling (spec PER-USER-LIMITS §6).
          // Undefined for proactive / non-active resolutions → today's single-model path.
          userLimit: userLimitForCreate,
          costCeilingOverride: userCeilingOverride,
          // Drain cancellation (spec §7.2): a build waiting on a summary job
          // aborts cleanly at shutdown instead of out-living the worker pool.
          abortSignal: drainAbort.signal,
        },
      ));
      // Chat builds always emit a final trigger turn; absence indicates a build bug.
      if (!kickoff) throw new Error("context build produced no final user turn");
    } catch (error) {
      // Build-wait timeout (spec LLM-FAILURE-HANDLING §7.1): the build blocked
      // on summary coverage for the whole interactive wall-clock budget (a
      // model outage backing up the summarization queue). Discard — there is
      // no snapshot/transcript yet, so there is genuinely nothing to park; the
      // waited job is untouched and completes when its model recovers.
      const buildTimeout = error instanceof Error && error.name === "BuildWaitTimeoutError";
      sessions.markDiscarded(session.id, {
        error: error instanceof Error ? error.message : String(error),
      });
      const unresolvableAccount = error instanceof Error && error.message.startsWith("§4.3:");
      logger.error(
        buildTimeout
          ? "session_build_wait_timeout"
          : unresolvableAccount
            ? "session_skipped_unresolvable_account"
            : "session_factory_failed",
        {
        sessionId: session.id,
        timelineKey: session.timelineKey,
        proactive,
        error: error instanceof Error ? error.message : String(error),
      });
      // §8.3: a user asked and the bot is giving up — say so when configured.
      // Only for the coverage-wait timeout (a routine outage symptom), not for
      // arbitrary factory bugs; never for proactive launches (the proactive
      // scheduler simply fires again next cadence).
      if (buildTimeout && !proactive) sendFailureNotice(target, session.id);
      drainNextQueuedTrigger(session.timelineKey);
      return;
    }
    sessions.attachAgent(session.id, agent);
    // Success drain (spec DEFERRED-COALESCING): the session is now steerable, so fold
    // every co-reply parked on its trigger in as an interjection. Consumes the parked
    // entries, so the settle-fallback registered above then fires on nothing.
    if (ownerExternalId) drainPendingCoRepliesIntoSession(ownerExternalId, session.id);
    // Same for follow-ups parked while this session was building (spec FOLLOWUP-FOLDING
    // §5.2): steer them in now that it is agent-live. Consumes the parked entries, so
    // the abandonment settle-fallback above then fires on nothing.
    drainPendingFollowUpsIntoSession(session.id);

    // Attach snapshot + transcript capture (spec §5). Detached in the run
    // promise's .finally() below (the agent_end transcript flush already happens
    // during the run; detach only unsubscribes). Only reached on the success
    // path — the kickoff-missing / factory-failed early returns above never get
    // here.
    // Resolve the cost ceiling ONCE per run (spec SESSION-COST-LIMITS §3/§6) and
    // share it between the settle log (self-contained spend-vs-ceiling line) and
    // the soft-warn watcher, rather than resolving it twice. The per-user dynamic
    // ceiling (PER-USER-LIMITS §6.3) tightens it to the user's remaining headroom.
    const costCeiling = userCeilingOverride ?? factory.resolveSessionCostCeiling(session.sessionType);
    const captureHandle = attachSessionCapture(agent, {
      storage,
      sessionId: session.id,
      snapshot,
      tokenEstimate,
      usage,
      timelineKey: session.timelineKey,
      sessionType: session.sessionType,
      // Thread `session.timelineKey` for per-agent model resolution (spec §4/§8).
      model: factory.resolveModelId(session.sessionType, session.timelineKey),
      maxSessionCostUsd: costCeiling,
      logger,
    });
    // Soft cost-budget interjection (spec SESSION-COST-LIMITS §2.1); torn down in
    // the run's .finally alongside the capture handle.
    const costWarnUnsub = wireCostBudgetWarner(session.id, session.sessionType, usage, costCeiling);
    const runner = new SessionRunner({ provider: providers.get(target.provider), target, suppressTyping: proactive });

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
        // Best-effort transcript flush BEFORE any recovery decision (issue #1 +
        // spec §6.2 persist-at-failure): if the run rejected before any
        // turn_end, the only durable copy of the kickoff turn (+ any partial
        // assistant message) is the live state — and resume-in-place seeds from
        // exactly this flush. flushNow() never throws, but wrap it so it can
        // never mask the original run error.
        try {
          await captureHandle.flushNow();
        } catch (flushErr) {
          logger.error("session capture: error-path flush failed", {
            sessionId: session.id,
            error: flushErr instanceof Error ? flushErr.message : String(flushErr),
          });
        }
        // Park, never discard (spec LLM-FAILURE-HANDLING §8.2 / P5): ANY
        // LLM-layer failure — environmental (interactive wall-clock budget
        // exhausted) and content (oversized request) alike — is operator- or
        // upstream-fixable; nothing about the session itself is unresumable.
        // Layer-0 now owns ALL in-run retrying (the old Layer-2 auto-resume
        // loop is deleted): once the budget is exhausted the maintainer
        // explicitly does NOT want delayed automatic replies (P3) — the manual
        // console resume is the sole resume path. `markDiscarded` remains only
        // for untagged errors (our own code throwing) below.
        if (isLlmRunFailure(error)) {
          const message = error instanceof Error ? error.message : String(error);
          // Read the LIVE record's startedAt: `markRunning` set it on the map
          // record, but `update()` swapped in a fresh object — the `session`
          // const captured at launch is the original `createPlaceholder` object
          // whose `startedAt` is forever undefined. Reading it here (before the
          // markFailedResumable eviction below) measures elapsed run time from
          // when the run actually began, excluding trigger-queue + context-build
          // time. Fallback to `createdAt` only if the live record is somehow gone.
          const startedAt = sessions.get(session.id)?.startedAt ?? session.createdAt;
          sessions.markFailedResumable(session.id, { error: message });
          logger.error("session_parked_failed_resumable", {
            sessionId: session.id,
            timelineKey: session.timelineKey,
            class: error.llmClass,
            elapsedMs: Date.now() - startedAt,
            error: message,
          });
          // §8.3: user-triggered sessions may announce the give-up; proactive
          // sessions never do — nobody asked them anything.
          if (!proactive) sendFailureNotice(target, session.id);
          return;
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
        costWarnUnsub();
        activeRuns.delete(run);
        // Close this session's browser tab(s) when the run settles (the idle
        // sweeper is only a backstop). Fire-and-forget; never block completion.
        // Per-session browser (§10a): use the per-agent session in agents mode.
        const sessionBrowserForClose = resolveAgentBrowserSession(
          resolveWorkspaceForTimeline(session.timelineKey)?.agentName ?? null,
        );
        if (sessionBrowserForClose) {
          void sessionBrowserForClose.closeSession(session.id).catch((error) => {
            logger.warn("browser_session_close_failed", {
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        drainNextQueuedTrigger(session.timelineKey);
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
    // Claim the activating trigger so its message renders a `<handled_by_session>`
    // marker like every other accepted trigger (spec CLAIM-VISIBILITY-SERIALIZATION
    // §4.3); released on a pre-attribution launch failure, same as the active path.
    addClaim,
    releaseClaim: releaseClaimFor,
    launchSession,
    dispatch: (inbound) => {
      void handleInbound(inbound).catch((error) => {
        logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
      });
    },
    isDraining: () => draining,
    logger,
  });

  // Proactive posting scheduler (ARCHITECTURE.md §9g). Inert unless opted in
  // (config.proactive.enabled + ≥1 channel); `start()` no-ops otherwise. Produces
  // synthetic inbounds for the existing launchSession on a self-compressing
  // per-channel schedule. Started alongside the other pools below; stopped first
  // during drain so no new proactive run begins while the runtime tears down.
  const proactiveScheduler = new ProactiveScheduler({
    config,
    timeline,
    sessions,
    triggerCoordinator,
    storage,
    launchSession: (inbound, duplicate, opts) => {
      void launchSession(inbound, duplicate, opts).catch((error) => {
        logger.error("proactive_session_launch_failed", {
          timelineKey: inbound.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Release the per-timeline slot acquired via tryAcquire so future triggers
        // aren't permanently blocked (launchSession threw before its own .finally
        // could run). Forward any trigger queued during the proactive run into the
        // launcher, mirroring every other release site so a real reply still drains.
        drainNextQueuedTrigger(inbound.timelineKey);
      });
    },
    isDraining: () => draining,
    // Skip channels whose startup gap is still filling (ARCHITECTURE.md §7c §6.4).
    isFrozen: (timelineKey) => gapBackfetch.isFrozen(timelineKey),
    // Defer proactive cadence past the ACCURATE budget-window reset (oldest-spend +
    // duration, §5 #5) when proactive (or its summarization dependency) is over
    // budget (spec USAGE-COST-LIMITS §6.3). Exception-isolated + fail-open
    // (review #7): an engine throw → no defer.
    // Thread timelineKey (spec PER-AGENT-MODEL-OVERRIDES FIX 3): the callback receives
    // the channel's timeline key from the scheduler so resolveModelId and checkAdmission
    // apply the per-agent override for this channel's agent rather than the global model.
    budgetDeferUntil: (timelineKey) => {
      const engine = budgetHooks.engine;
      if (!engine) return undefined;
      return safeProactiveDeferUntil(
        engine,
        config.proactive?.session_type ?? "proactive",
        (sessionType) => factory.resolveModelId(sessionType, timelineKey),
        logger,
        timelineKey,
      );
    },
    // §6.3: wire provider self-identity so proactive synthetic inbounds carry the
    // real provider identity rather than the static config.matrix.accounts read.
    getSelf: (provider, accountId) => providers.get(provider)?.getSelf(accountId),
    // Sibling suppression (spec MULTI-AGENT-SUPPORT §5.2): exclude messages from
    // in-process sibling accounts when counting human activity in the gate.
    siblingUserIds: botSelfIdsForLimits,
    logger: logger.child("proactive"),
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
      resolveMultiAccountRetry(
        // Gate: redecryptionSweeper is Matrix-only; if no matrix provider is
        // registered (e.g. test injection without Matrix) this returns nothing and
        // the sweeper's retry callback is never actually called (sweeper disabled).
        matrixProvider ? Object.keys(config.matrix.accounts) : [],
        (accountId) => {
          // matrixProvider is guaranteed non-null here (guard above)
          const client = matrixProvider!.getClient({ provider: "matrix", timelineKey: `matrix:${accountId}`, accountId });
          return client.messageSummary({ roomId, eventId });
        },
      ),
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

  // Eager-summarization startup sweep (spec §7.3): re-evaluate every active
  // timeline's generation threshold, catching crossings that happened while the
  // process was down. Fire-and-forget — a missed enqueue here is converged by
  // the next inbound event's reconcile.
  if (summarizationIndexer) {
    void summarizationIndexer.reconcileAll().catch((error) =>
      logger.warn("summarization_index_sweep_failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

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

  // Gap-backfetch freeze (ARCHITECTURE.md §7c §8 step 2): enumerate in-scope
  // rooms, record each `floor`, and mark them frozen — strictly BEFORE
  // `provider.start` so no live event is missed and no commit races the floor
  // capture. The stale-activation/session resets and the chat-search/summarization
  // startup sweeps above all operate on committed state ≤ each room's floor (the
  // gap is above it, uncommitted), so they are unaffected. No-op when disabled.
  gapBackfetch.prepare();

  /**
   * Build the ChatProviderHost for the Matrix provider.
   *
   * Cast site — the single documented as-cast location for Matrix-specific
   * payload types, per spec §3.2. The two narrowings below are safe because
   * MatrixProvider ONLY delivers these specific payloads via these callbacks.
   * A runtime provider-id guard at the start call (below) ensures no other
   * provider is accidentally started with this Matrix-typed host.
   *
   *   Cast 1 of 2: onNativeEvent : ProviderLifecycleEvent(=unknown) → MatrixNativeEvent (minus inbound/reaction)
   *   Cast 2 of 2: onDiagnostics : unknown → ReturnType<MatrixNativeClient["start"]>
   *
   * (onReaction received an as-cast in pre-Phase-6 — removed: the provider now
   * calls adaptMatrixReactionEvent at the boundary and emits a ReactionStreamEvent.)
   */
  function buildMatrixHost(): ChatProviderHost {
    return {
      onEvent: (inbound) => {
        void handleInbound(inbound).catch((error) => {
          logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
        });
      },
      onError: (error, context) =>
        logger.error("matrix_provider_error", {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        }),
      onNativeEvent: (event, context) => {
        // Cast 1 of 2 (see §3.2 header): ProviderLifecycleEvent → Matrix-specific lifecycle shape
        const e = event as Exclude<MatrixNativeEvent, { type: "inbound" } | { type: "reaction" }>;
        logger.info("matrix_native_event", {
          ...context,
          type: e.type,
          state: "state" in e ? e.state : undefined,
          stage: "stage" in e ? e.stage : undefined,
          // Lifecycle stages (restore_recovery / enable_backup) carry their outcome
          // in `detail` — the load-bearing diagnostic for key-backup restore. Log it.
          detail: "detail" in e ? e.detail : undefined,
        });
      },
      // Passive reaction surfacing (ARCHITECTURE.md §9f): persist to the reaction
      // store only — never wake a session. Writes are fire-and-forget through the
      // single-writer queue; a failure is logged but must not stall the poll loop.
      onReaction: (event, context) => {
        // Master switch: when reactions are disabled, don't even persist (the views
        // are gated independently in the context builder).
        if (config.reactions?.enabled === false) return;
        // The provider already adapted MatrixReactionStreamEvent → ReactionStreamEvent
        // at the poll boundary; no cast needed here.
        void ingestGenericReactionEvent(storage, event, Date.now())
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
      onBulkReactionClear: (args, _ctx) => {
        if (config.reactions?.enabled === false) return;
        const now = Date.now();
        if (args.normalizedKey !== undefined) {
          void storage.tombstoneReactionsByTargetAndKey(args.targetEventId, args.normalizedKey, now).catch((error) =>
            logger.error("bulk_reaction_clear_failed", {
              targetEventId: args.targetEventId,
              normalizedKey: args.normalizedKey,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        } else {
          void storage.tombstoneReactionsByTargetEvent(args.targetEventId, now).catch((error) =>
            logger.error("bulk_reaction_clear_failed", {
              targetEventId: args.targetEventId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      },
      onDiagnostics: (diagnostics, context) => {
        // Cast 2 of 2 (see §3.2 header): unknown → MatrixNativeClient diagnostics shape
        const d = diagnostics as ReturnType<MatrixNativeClient["start"]>;
        logger.info("matrix_diagnostics", {
          ...context,
          verificationState: d.verificationState,
          keyBackupState: d.keyBackupState,
          syncState: d.syncState,
          lastSuccessfulSyncAt: d.lastSuccessfulSyncAt,
          lastSuccessfulDecryptionAt: d.lastSuccessfulDecryptionAt,
        });
      },
      // Reply-as-trigger resolver (spec RESUMABLE-SESSIONS §5). The provider asks,
      // inside its trigger hold, whether an untriggered reply targets one of the
      // bot's own messages with resume enabled for the context; if so it becomes a
      // `reply` trigger and rides the normal hold/debounce/grouping. The provider
      // stays resume-unaware — the timeline lookup and resume config live here. DMs
      // already trigger as `dm`, so in practice this only ever fires for groups
      // (the provider's `!inbound.trigger` guard). The resume-vs-fresh decision
      // stays downstream in `tryReplyResume`; this only classifies the trigger.
      resolveReplyTrigger: ({ provider: providerId, externalId, timelineKey, sender }) => {
        const ctx = resumeContextFor(timelineKey);
        if (config.agent.sessions.resume?.enabled?.[ctx] !== true) return undefined;
        const targetEvent = timeline.getByExternalId(providerId, externalId, timelineKey);
        if (!targetEvent || targetEvent.timelineKey !== timelineKey || !targetEvent.agentSessionId) {
          return undefined;
        }
        return {
          type: "reply",
          reason: "reply to bot message",
          triggeredBy: sender, // forward full SenderInfo so isBot/isWebhook reach botChainCapGate and Gate A
        };
      },
    };
  }

  // Build a minimal host for any non-Matrix provider: route all events through
  // the shared inbound pipeline and log errors. Matrix-specific callbacks
  // (onNativeEvent, onDiagnostics) are not wired — non-Matrix providers don't
  // produce them.
  const genericHost: ChatProviderHost = {
    onEvent: (inbound) => {
      void handleInbound(inbound).catch((error) => {
        logger.error("pipeline_error", { error: error instanceof Error ? error.message : String(error) });
      });
    },
    onError: (error, context) =>
      logger.error("provider_error", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      }),
    // Route non-Matrix reactions through the shared generic ingest path (§9f).
    // Provider pre-resolves all fields (PK, normalizedKey, kind, display) before
    // calling onReaction; the generic ingest writes directly to the reactions table.
    onReaction: (event, _context) => {
      void ingestGenericReactionEvent(storage, event, Date.now()).catch((error) => {
        logger.error("reaction_ingest_error", {
          reactionEventId: event.reactionEventId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onBulkReactionClear: (args, _ctx) => {
      const now = Date.now();
      if (args.normalizedKey !== undefined) {
        void storage.tombstoneReactionsByTargetAndKey(args.targetEventId, args.normalizedKey, now).catch((error) =>
          logger.error("bulk_reaction_clear_failed", {
            targetEventId: args.targetEventId,
            normalizedKey: args.normalizedKey,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        void storage.tombstoneReactionsByTargetEvent(args.targetEventId, now).catch((error) =>
          logger.error("bulk_reaction_clear_failed", {
            targetEventId: args.targetEventId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
    resolveReplyTrigger: ({ provider: providerId, externalId, timelineKey, sender }) => {
      const ctx = resumeContextFor(timelineKey);
      if (config.agent.sessions.resume?.enabled?.[ctx] !== true) return undefined;
      const targetEvent = timeline.getByExternalId(providerId, externalId, timelineKey);
      if (!targetEvent || targetEvent.timelineKey !== timelineKey || !targetEvent.agentSessionId) {
        return undefined;
      }
      return {
        type: "reply",
        reason: "reply to bot message",
        triggeredBy: sender, // forward full SenderInfo so isBot/isWebhook reach botChainCapGate and Gate A
      };
    },
  };

  // Start every registered provider with the appropriate host.
  // Runtime guard: MatrixProvider MUST receive buildMatrixHost() (not genericHost)
  // so that the Matrix-specific onNativeEvent/onReaction/onDiagnostics casts
  // documented in buildMatrixHost() are valid.
  for (const [id, p] of providers) {
    const host = id === "matrix" ? buildMatrixHost() : genericHost;
    await p.start(host);
  }

  // Discord self-id resolution is now done INSIDE DiscordProvider.start() — each
  // account's self-id is resolved via REST before attachListeners()/client.login()
  // so the sibling suppression set (siblingUserIds / botSelfIdsForLimits) is complete
  // before any gateway events arrive. start() throws if the REST call fails (fail-fast
  // policy — an incomplete suppression set is worse than a failed startup).
  // The old fire-and-forgotten resolveEagerSelfIds() call has been removed; the
  // gateway READY event continues to call onSelfResolved() as a belt-and-suspenders
  // backstop (e.g. when READY races the REST call on a very fast connection).

  // Resolve room labels for already-known (possibly idle) rooms so the console
  // shows real names without waiting for each room's next message. Throttled and
  // fire-and-forget so it never delays startup.
  void roomLabels.backfillAll().catch((error) => {
    logger.warn("room_label_backfill_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Wire per-account enrichment capabilities for every registered provider.
  // Uses IChatProvider.enrichment() (not the Matrix-specific getEnrichmentCapabilities)
  // so future providers wire automatically without changes here.
  for (const p of providers.values()) {
    for (const accountId of p.accountIds()) {
      const caps = p.enrichment(accountId);
      if (caps) {
        enrichmentPool.options.providerCapabilities.set(`${p.id}:${accountId}`, caps);
      }
    }
  }

  await enrichmentPool.start();
  await captionPool.start();
  if (summarizationPool) await summarizationPool.start();
  // Mirror worker starts after the pool so L1 hooks are wired; initial sweep
  // catches any donor summaries that landed during downtime.
  if (mirrorWorker) mirrorWorker.start();
  if (diaryPool) await diaryPool.start();
  if (retrieval) await retrieval.start();
  redecryptionSweeper.start();
  proactiveScheduler.start();

  // Gap-backfetch fill (ARCHITECTURE.md §7c §8 step 5): launch the per-room
  // fill→commit→unfreeze workers AFTER the scan-driven pools are up (so committed
  // gap rows are picked up) and after the proactive scheduler (which already skips
  // frozen rooms — §6.4). The bot stays responsive for non-frozen rooms while gaps
  // fill, and each room self-unfreezes as it completes. We HOLD the promise rather
  // than discard it (#3) so `stop()` can await an in-flight fill/commit to quiesce
  // before storage teardown — otherwise a commit could outrace `storage.close()`
  // (rejected-after-close → logged failure). The coordinator's `isDraining()` gate
  // (set at the top of `stop()`) stops launching new rooms and bails an un-started
  // commit, so this await is bounded by the single in-flight room's remaining work.
  const gapBackfetchRun = gapBackfetch.run().catch((error) => {
    logger.error("gap_backfetch_run_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Resume interrupted message-backfetch jobs only AFTER startup gap backfetch
  // settles (§10.2): a room must not be backfetched while still frozen by the gap
  // coordinator. Each job runs in the background from its persisted cursor.
  void gapBackfetchRun
    .then(() => {
      if (!draining) messageBackfetch.resumeAll();
    })
    .catch((error) => {
      logger.error("message_backfetch_resume_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

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
      // Tentative-token merge for the session SSE (spec LLM-FAILURE-HANDLING §4.2).
      liveEvents,
      // Scheduler snapshot + request ring (spec §9.1/§9.2).
      scheduler: llmScheduler,
      // Health-key → logical id(s) + has-fallback map (spec MODEL-FALLBACK §8): lets
      // the scheduler view show the config name and label a fallback-bearing model's
      // probe window as the canary. Built from config.models (multiple logical ids
      // can share one health key via inheritance/rename).
      modelHealthAnnotations: buildModelHealthAnnotations(config.models),
      llmRequestRing,
      workspaceRoot,
      // Static agents meta snapshot for GET /api/agents (spec CONSOLE-MULTI-AGENT §2).
      agentsSnapshot,
      // Per-asset workspace resolver for GET /api/media/:ref (spec
      // MULTI-AGENT-SUPPORT §7.4): in agents mode the BFF resolves the owning
      // agent's workspace from the asset's timeline_key. Absent = legacy mode.
      resolveWorkspaceRoot: agentWorkspaces.length > 0
        ? (timelineKey) => resolveWorkspaceForTimeline(timelineKey)?.workspaceRoot
        : undefined,
      // Manual resume of a parked failed-resumable session (spec §6.2) — the
      // console's second mutating action, next to abort.
      resumeSession: manualResumeSession,
      // Startup gap-backfetch status panel (ARCHITECTURE.md §7c §11).
      gapBackfetch: () => gapBackfetch.snapshot(),
      // Message-only history backfetch jobs surface (ARCHITECTURE.md §7d): list +
      // start/pause/resume/cancel + retroactive caption promote.
      backfetch: {
        enabled: messageBackfetch.enabled,
        list: (limit?: number) => messageBackfetch.snapshot(limit),
        start: (input) => messageBackfetch.startJob(input),
        pause: (id) => messageBackfetch.pauseJob(id),
        resume: (id) => messageBackfetch.resumeJob(id),
        cancel: (id) => messageBackfetch.cancelJob(id),
        promoteCaptions: (timelineKey, range) => messageBackfetch.promoteCaptions(timelineKey, range),
      },
      // Period-budget rule statuses for the Usage & Cost page (spec USAGE-COST-LIMITS §7).
      budgetEngine: budgetHooks.engine,
      // Per-user limits meters for the Usage & Cost page (spec PER-USER-LIMITS §14).
      userLimitEngine,
      logger: logger.child("console"),
    });
    await consoleServer.start();
  }

  logger.info("runtime_started", { matrixEnabled: config.matrix.enabled });
  return {
    async stop() {
      stopPromise ??= (async () => {
        draining = true;
        // Quiesce the gap-backfetch run BEFORE any pool/storage teardown (#3).
        // `draining` is now true, so the coordinator stops launching new rooms and
        // `commit()` bails before its first write; awaiting `gapBackfetchRun` lets
        // an already-in-flight fill/commit finish its oldest-first (crash-safe)
        // batch so it does not race `storage.waitForIdle()`/`close()`. Bound it so
        // a hung homeserver read cannot block shutdown forever — mirror the
        // `waitForRuns` 10s race; on timeout we proceed (an outstanding commit is
        // idempotent + oldest-first, so the gap simply re-derives next startup).
        await waitForGapBackfetch(gapBackfetchRun, logger);
        // Park in-flight message-backfetch jobs (§3 — no atomicity, so each persists
        // its cursor at the page boundary and resumes next startup). `draining` is
        // set, so each running job throws JobStopSignal('paused') at its next page
        // and quiesces before storage teardown.
        await messageBackfetch.drain();
        // Cancel context builds waiting on summarization jobs BEFORE any pool
        // teardown: once the summarization pool stops, nothing can drive a
        // waited job to terminal, so a waiting build would otherwise poll until
        // storage.close() made it throw. The abort surfaces inside
        // factory.create as a clean AbortError → launchSession discards the
        // never-started session via its factory-failure path.
        drainAbort.abort();
        // Stop the proactive scheduler first: clear its per-channel timers so no
        // new proactive run is launched while the rest of the runtime tears down.
        proactiveScheduler.stop();
        // Stop the per-user limits reconcile tick (spec PER-USER-LIMITS §8.2).
        userLimitEngine?.stop();
        // Stop the console first: it stops accepting requests and tears down any
        // open SSE streams before the live state it reads begins shutting down.
        if (consoleServer) await consoleServer.stop();
        if (retentionTimer) clearInterval(retentionTimer);
        await redecryptionSweeper.stop();
        // Stop all registered providers. MatrixProvider cleans up its sync loop;
        // other providers perform their own teardown.
        for (const p of providers.values()) await p.stop();
        triggerCoordinator.clear();
        // Drop any claims whose queued triggers were just discarded by the
        // coordinator clear (spec DUPLICATE-REPLY-MITIGATION §3.3 — queued claims
        // released on teardown); in-flight runs release their own on settle.
        sessionClaims.clear();
        coReplyInbounds.clear();
        // Drop any co-replies still parked on an un-launched owner (spec
        // DEFERRED-COALESCING): the runtime is draining, so they will not be steered
        // in or re-dispatched.
        pendingCoReplies.clear();
        // Drop every follow-up watch + its GC timer, and any parked follow-ups (spec
        // FOLLOWUP-FOLDING): the runtime is draining, so nothing more folds.
        followUpWatch.clear();
        pendingFollowUps.clear();
        // Abort each caption client's scheduler-admission seam BEFORE awaiting
        // the pool's in-flight workers (#6). `captionPool.stop()` awaits
        // in-flight caption work, and a caption call queued behind a half-open
        // probe during a caption-model outage would otherwise block until the
        // far-later `llmScheduler.stop()` rejects it (a capped-backoff probe
        // window stall). Stopping the clients first rejects those queued waiters now.
        // allCaptionClients is a Set of all DISTINCT clients (baseline + per-agent),
        // so each client is stopped exactly once even when agents share a baseline
        // instance (spec PER-AGENT-MODEL-OVERRIDES Phase 2 teardown).
        for (const client of allCaptionClients) client.stop();
        await captionPool.stop();
        if (retrieval) await retrieval.stop();
        if (diaryPool) await diaryPool.stop();
        // Stop the mirror worker before the summarization pool so the in-flight
        // sweep doesn't try to insert mirrored summaries after the pool stops.
        if (mirrorWorker) mirrorWorker.stop();
        if (summarizationPool) await summarizationPool.stop();
        await enrichmentPool.stop();
        // Drain the chat-search indexer: refuse new reconciles and await the
        // in-flight FIFO tail so the last projection commits before storage.close()
        // (§9e). Ordered after the pools whose onComplete hooks enqueue into it, so
        // no enqueue can arrive after the indexer has stopped accepting work.
        await chatSearchIndexer.stop();
        // Same drain contract for the eager-summarization indexer: ordered after
        // the summarization pool (whose onComplete enqueues into it), before
        // storage.close().
        if (summarizationIndexer) await summarizationIndexer.stop();
        await mcpPool.stop();
        fetchClient.stop();
        // Caption clients are already stopped (above, before captionPool.stop, #6).
        await waitForRuns(activeRuns);
        // Reject any LLM requests still queued for admission AFTER in-flight runs
        // drain (a queued waiter belongs to a run; stopping earlier would surface
        // synthetic errors into runs that could still finish cleanly).
        llmScheduler.stop();
        // After in-flight runs drain, disconnect the browser (closes our CDP link
        // and any lingering tabs; does NOT stop the operator-run Manager).
        // Legacy mode: one global session. Agents mode: all per-agent sessions.
        if (browserSession) await browserSession.shutdown();
        for (const bs of allBrowserSessions) await bs.shutdown();
        // After in-flight runs (and their bash execs) drain, release the sandbox.
        // Legacy mode: one global manager. Agents mode: all per-agent managers.
        if (sandbox) await sandbox.shutdown({ stop: config.sandbox?.stop_on_shutdown ?? false });
        for (const { manager, stopOnShutdown } of allSandboxManagers) {
          await manager.shutdown({ stop: stopOnShutdown });
        }
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

const GAP_BACKFETCH_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Await the held gap-backfetch `run()` promise during shutdown so an in-flight
 * fill/commit quiesces before storage teardown (#3), bounded so a hung homeserver
 * read cannot block shutdown forever. By the time this is called `draining` is
 * already true, so the coordinator launches no new rooms and `commit()` bails
 * before its first write; this just lets the single in-flight room finish (or, on
 * timeout, proceeds anyway — an outstanding oldest-first commit is idempotent and
 * the gap re-derives on the next startup). `run()` already early-returns when the
 * feature is disabled, so the held promise resolves immediately in that case.
 */
async function waitForGapBackfetch(run: Promise<void>, logger: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), GAP_BACKFETCH_DRAIN_TIMEOUT_MS);
  });
  const outcome = await Promise.race([run.then(() => "settled" as const), timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    logger.warn("gap_backfetch_drain_timeout", { timeoutMs: GAP_BACKFETCH_DRAIN_TIMEOUT_MS });
  }
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

/** The slice of {@link BudgetEngine} the budget admission/defer gates consume. */
type AdmissionEngine = Pick<BudgetEngine, "checkAdmission" | "checkAdmissionChain" | "accurateResetsAt">;

/**
 * Exception-isolated session-admission check (spec USAGE-COST-LIMITS, review #7).
 * The budget gate runs INSIDE `launchSession`, before its discard/slot-release
 * plumbing; an unguarded `checkAdmission` throw would unwind to the dispatch
 * `catch`, which does `releaseClaimFor` + rethrow but NOT
 * `triggerCoordinator.complete`, leaking the per-timeline slot. So this FAILS OPEN:
 * on a throw it returns `undefined` (= admit; the caller falls through to a normal
 * launch) and logs `usage_admission_check_threw`. Fail-open is correct — a
 * budget-engine bug must never silently stop the bot from responding (mirrors the
 * isolated pre-flight at `src/agent/request-retry.ts`).
 */
export function safeCheckAdmission(
  engine: AdmissionEngine,
  sessionType: string,
  modelId: string,
  logger: Logger,
  context: Record<string, unknown> = {},
  /**
   * Effective fallback chain as LOGICAL ids, head-first (spec MODEL-FALLBACK §6.1).
   * When supplied the gate admits if ANY chain member is in-budget; omitted ⇒ the
   * head-only `checkAdmission`. Resolution is isolated by the caller (a throw there
   * leaves it undefined → head-only, not a leak).
   */
  chainLogicalIds?: string[],
  /**
   * The session's timeline key, for agent/account-scoped rule matching
   * (spec MULTI-AGENT-SUPPORT §8). Absent ⇒ scoped rules never match (safe fail-open).
   */
  timelineKey?: string,
): AdmissionResult | undefined {
  try {
    return chainLogicalIds
      ? engine.checkAdmissionChain(sessionType, modelId, chainLogicalIds, timelineKey)
      : engine.checkAdmission(sessionType, modelId, timelineKey);
  } catch (error) {
    logger.warn("usage_admission_check_threw", {
      ...context,
      sessionType,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Exception-isolated proactive budget-defer instant (spec USAGE-COST-LIMITS,
 * review #5 + #7). Returns the instant proactive posting should be deferred to when
 * the proactive class (or its summarization dependency) is over budget, else
 * `undefined` (no defer). Uses the ACCURATE rolling reset (oldest-spend + duration,
 * §5 #5) rather than the full-duration upper bound so it doesn't over-defer. FAILS
 * OPEN (review #7): if the model can't be resolved or any engine call throws, it
 * returns `undefined` (no defer) and logs — a budget-engine bug must not silently
 * stall proactive posting.
 */
export function safeProactiveDeferUntil(
  engine: AdmissionEngine,
  proactiveType: string,
  resolveModelId: (sessionType: string) => string | undefined,
  logger: Logger,
  timelineKey?: string,
): number | undefined {
  let modelId: string | undefined;
  try {
    modelId = resolveModelId(proactiveType);
  } catch {
    return undefined;
  }
  if (modelId === undefined) return undefined;
  try {
    // Thread timelineKey so agent-scoped [[limits]] rules match the per-agent model
    // (spec PER-AGENT-MODEL-OVERRIDES FIX 3). Without a timelineKey (global callers,
    // old tests) checkAdmission falls back to process-wide scope as before.
    const admission = engine.checkAdmission(proactiveType, modelId, timelineKey);
    if (admission.allowed || !admission.primary) return undefined;
    return engine.accurateResetsAt(admission.primary.name) ?? admission.primary.resetsAt;
  } catch (error) {
    logger.warn("usage_proactive_defer_check_threw", {
      proactiveType,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Context-token ceiling cross-field validation (spec CONTEXT-LIMIT-UNIFICATION
 * §2.5, same app-wiring fail-fast convention). `context_window` is the model
 * ceiling AND the always-on enforcement base, so every model a configured
 * session type resolves to MUST declare it — unset is fail-fast, which is what
 * guarantees enforcement is always wired and lets the descriptor's `?? 128_000`
 * fallback be deleted. A session-type-level `max_context_tokens` is an
 * artificial tightening that must fit under the `context_window` of the model it
 * resolves to — an override larger than the model could ever reach is a no-op
 * typo. There is no model-level `max_context_tokens` any more (U2), so that
 * check is gone. Throws on the first offending entry. Called from
 * {@link startMikuAgent}.
 */
/**
 * Build the scheduler-snapshot annotation map (spec MODEL-FALLBACK §8): health key
 * (`endpoint::id`, as `modelHealthKey` derives it) → the LOGICAL ids ([models.*]
 * block names) resolving to it and whether ANY carries a `fallback` chain. Several
 * logical ids can share one health key (inheritance / pure-rename virtual models),
 * so ids aggregate and `hasFallback` ORs. Lets the console show the config name and
 * label a fallback-bearing model's probe window as the canary.
 */
export function buildModelHealthAnnotations(
  models: AppConfig["models"],
): Record<string, { logicalIds: string[]; hasFallback: boolean }> {
  const out: Record<string, { logicalIds: string[]; hasFallback: boolean }> = {};
  for (const [logicalId, model] of Object.entries(models)) {
    const key = `${model.endpoint ?? "unknown"}::${model.id}`;
    const entry = (out[key] ??= { logicalIds: [], hasFallback: false });
    entry.logicalIds.push(logicalId);
    if ((model.fallback?.length ?? 0) > 0) entry.hasFallback = true;
  }
  return out;
}

/**
 * Render a relative duration to a reset, compact ("3h 12m", "2d", "now") — the
 * `{resets_in}` token of a per-user refusal (spec PER-USER-LIMITS §12). A
 * non-positive duration is "now"; a positive but sub-minute duration rounds to 0
 * minutes and is ALSO "now" rather than the misleading "0m" (issue #11 — the
 * `!(ms > 0)` guard alone misses the rounds-to-zero case).
 */
export function formatRefusalDurationShort(ms: number): string {
  if (!(ms > 0)) return "now";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin === 0) return "now";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
  }
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Single source of truth mapping a capability feature flag (`[features]`) to the
 * tool names it gates. A feature that is off (the default — absent table or key)
 * makes every tool in its list unavailable to the agent across ALL session types.
 * This is a pure capability gate. The skill-file seeding half of these features
 * is driven separately by `seedFeatureSkills` (src/bootstrap/seed.ts, wired in
 * startMikuAgent via `enabledFeatureNames` below), which copies
 * templates/features/<feature>/skills/* into the workspace for each ON feature.
 */
export const FEATURE_TOOLS: Record<keyof NonNullable<AppConfig["features"]>, readonly string[]> = {
  character_card: ["character_card_create", "character_card_read", "character_card_edit"],
  danbooru: ["danbooru"],
};

/**
 * Names of the features whose gate is strictly `true` (the same on-criterion as
 * `gatedOutFeatureTools`). Drives first-run feature-skill seeding. A feature name
 * here matches its `templates/features/<name>/` directory.
 */
export function enabledFeatureNames(features: AppConfig["features"]): string[] {
  return (Object.keys(FEATURE_TOOLS) as (keyof typeof FEATURE_TOOLS)[]).filter(
    (key) => features?.[key] === true,
  );
}

/**
 * The set of tool names excluded because their owning feature is not turned on.
 * A feature counts as on only when its flag is strictly `true`; any other value
 * (absent table, absent key, or `false`) leaves the feature off and its tools out.
 */
export function gatedOutFeatureTools(features: AppConfig["features"]): Set<string> {
  const excluded = new Set<string>();
  for (const key of Object.keys(FEATURE_TOOLS) as (keyof typeof FEATURE_TOOLS)[]) {
    if (features?.[key] === true) continue;
    for (const name of FEATURE_TOOLS[key]) excluded.add(name);
  }
  return excluded;
}

export function validateContextTokenCeilings(config: AppConfig): void {
  // Require `context_window` on a model and return it. `who` names the call site
  // (a session type, or the always-resolvable default model) for the error.
  const requireWindow = (modelKey: string, who: string): number => {
    const model = config.models[modelKey];
    if (!model) {
      throw new Error(`${who}: model "${modelKey}" not found in [models]`);
    }
    if (model.context_window === undefined) {
      throw new Error(
        `models.${modelKey}: context_window is required (resolved by ${who}); ` +
          `it is the model ceiling and the always-on enforcement base`,
      );
    }
    return model.context_window;
  };

  // The `default` model is always resolvable — it backs the implicit fallback
  // for any unconfigured session type and the default session type itself — so
  // its window is required regardless of what session types are declared.
  requireWindow("default", "default model");

  for (const [typeName, sessionType] of Object.entries(config.agent.session_types ?? {})) {
    const modelKey = sessionType.model ?? "default";
    const window = requireWindow(modelKey, `agent.session_types.${typeName}`);
    if (sessionType.max_context_tokens !== undefined && sessionType.max_context_tokens > window) {
      throw new Error(
        `agent.session_types.${typeName}: max_context_tokens (${sessionType.max_context_tokens}) ` +
          `exceeds context_window (${window}) of its model "${modelKey}"`,
      );
    }
  }
}

/**
 * Fail-fast validation of every model fallback chain (spec MODEL-FALLBACK
 * §2.1 "cycles fail fast at app wiring" / §6.1). `resolveModelChain` throws on a
 * `fallback` that names a non-existent `[models.*]` block; calling it eagerly at
 * boot turns a dangling reference into a clear startup error instead of a
 * first-trigger surprise (the agent path resolves session-type chains lazily).
 *
 * Sweeping ALL `Object.keys(config.models)` (rather than only `default` +
 * `agent.session_types.*` models) is the single cleanest implementation: it
 * additionally validates the chains of models referenced only by the non-agent
 * consumers AND of entirely unreferenced models (so a typo in any block's
 * `fallback` is caught regardless of who points at it). A model with no
 * `fallback` resolves to a single-member chain and is fine; only a DANGLING
 * reference throws. Extracted (like {@link validateContextTokenCeilings}) so it
 * can be unit-tested without booting the agent.
 */
export function validateModelFallbackChains(config: AppConfig): void {
  for (const logicalId of Object.keys(config.models)) {
    // Throws "model … fallback references unknown model …" on a dangling ref.
    resolveModelChain(logicalId, config.models);
  }
}

/**
 * Cross-field validation for `[tokenizer]` (spec TOKENIZER-SWAP §5.4). TypeBox
 * keeps `glm_tokenizer_path` optional so a `gpt-tokenizer`-only config (the
 * default) needn't carry it; but selecting `glm` for either consumer makes the
 * path required AND readable — a missing/unreadable GLM asset must fail startup
 * loudly rather than silently degrade. Extracted (like
 * {@link validateContextTokenCeilings}) so it can be unit-tested without booting
 * the agent. Throws on the first problem.
 */
export function validateTokenizerConfig(config: AppConfig): void {
  const tok = config.tokenizer;
  if (!tok) return;
  const usesGlm = tok.primary === "glm" || tok.retrieval === "glm";
  if (!usesGlm) return;
  const glmPath = (tok.glm_tokenizer_path ?? "").trim();
  if (!glmPath) {
    throw new Error(
      "tokenizer: primary and/or retrieval is \"glm\" but glm_tokenizer_path is missing/empty — " +
        "set glm_tokenizer_path to the GLM tokenizer.json (e.g. \"native/assets/glm-5.1/tokenizer.json\") " +
        "or use \"gpt-tokenizer\".",
    );
  }
  try {
    accessSync(glmPath, fsConstants.R_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `tokenizer.glm_tokenizer_path "${glmPath}" is not readable: ${detail} — ` +
        "point it at the GLM tokenizer.json file.",
    );
  }
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
/**
 * Build a usage-tracker seed from a persisted session row (spec
 * TOKEN-USAGE-TRACKING §4.3). Maps the row's usage columns to cumulative
 * totals so a continue-mode resume keeps accumulating from where it left off
 * rather than resetting. Used ONLY for continue mode — see
 * {@link resumeUsageSeed} for why fresh mode must not read the row.
 */
function usageSeedFromRow(row: AgentSessionRow): SessionUsageTotals {
  return {
    llmRequests: row.llm_requests ?? 0,
    inputTokens: row.usage_input_tokens ?? 0,
    outputTokens: row.usage_output_tokens ?? 0,
    cacheReadTokens: row.usage_cache_read_tokens ?? 0,
    cacheWriteTokens: row.usage_cache_write_tokens ?? 0,
    cost: row.usage_cost ?? 0,
    contextTokens: row.context_tokens ?? null,
  };
}

/**
 * Choose the usage seed for a resumed session run by resume mode (spec
 * TOKEN-USAGE-TRACKING §4.3, §6.2/D3). Pure — the per-branch seed decision
 * that {@link MikuAgentRuntime}'s `resumeSessionRun` applies, factored out so
 * it can be unit-tested at the boundary (review issue #9).
 *
 * - `continue`: inherit the row's persisted totals (keep accumulating).
 * - `fresh`: an EMPTY seed (zeros, `contextTokens: null`). A fresh-classified
 *   row can still carry usage columns: usage persists at the Layer-0 `done`
 *   commit, enqueued BEFORE the turn's transcript flush, so a crash in that
 *   window leaves usage written but `transcript_json` null (→ `fresh`).
 *   Seeding from the row would (1) double-count those requests when the
 *   rebuilt run re-commits them and (2) seed a non-null `contextTokens` that
 *   could trip the first-request `checkContextBudget` and permanently park the
 *   session, violating D3 ("the first request is never locally blocked").
 */
export function resumeUsageSeed(
  row: AgentSessionRow,
  mode: "fresh" | "continue",
): SessionUsageTotals {
  return mode === "fresh" ? emptyUsageTotals() : usageSeedFromRow(row);
}

/** The verdict of {@link evaluateResumeGate}: continue this session, or go FRESH. */
export type ResumeGateVerdict =
  | { resume: true; row: AgentSessionRow; material: ResumeMaterial }
  | { resume: false };

/** The only resume-config fields the pre-CAS gate reads (structural subset of the
 *  `[agent.sessions.resume]` schema), so the gate is decoupled from config shape. */
export interface ResumeGateConfig {
  same_user_only?: boolean;
  window?: { dm?: number; group?: number };
  work_gate?: {
    dm?: { scope?: ResumeWorkScope; extra_exempt_tools?: readonly string[] };
    group?: { scope?: ResumeWorkScope; extra_exempt_tools?: readonly string[] };
  };
}

/**
 * The pre-CAS resume-eligibility gate (spec RESUMABLE-SESSIONS §7 steps 2–8),
 * factored out of `tryReplyResume`'s closure so it is unit-testable at the boundary
 * (review issue #2 — mirrors {@link resumeUsageSeed}). Pure over its inputs except
 * for three injected effectful callbacks; performs no DB writes and no claim
 * bookkeeping (the caller owns the `resumeClaims` slot and the `acceptResumeGeneration`
 * CAS that follows a `{resume:true}` verdict).
 *
 * CRITICAL (the issue #2 invariant): this is wrapped in a single try/catch that
 * degrades ANY unexpected throw — from `getSession`, `resolveCeiling`, `loadMaterial`,
 * or the work scan — to `{resume:false}` (FRESH), never re-throwing. A throw escaping
 * here would unwind through `tryReplyResume` → `launchSession` (no try/catch at the
 * `if (await tryReplyResume(...)) return;` site) → the dispatch rethrow, dropping the
 * user's message with no reply at all — the one outcome the spec forbids ("degrade to
 * FRESH, never to corruption/loss", §2/§7). Returning FRESH lets the caller fall
 * through to a normal new session, which still answers.
 *
 * `resolveCeiling` is additionally guarded individually (mirrors the original inline
 * gate, where only that call had a catch) so a ceiling-resolution failure leaves the
 * capability gate inert (treated as "no ceiling") rather than failing the whole gate —
 * but the outer catch is the backstop that makes the never-drop guarantee total.
 */
export async function evaluateResumeGate(args: {
  sessionId: string;
  /** Reads the durable row INSIDE the gate's try/catch, so a DB-read throw also
   *  degrades to FRESH (issue #2) rather than escaping the caller. */
  getSession: () => AgentSessionRow | undefined;
  targetEvent: Pick<CanonicalChatEvent, "agentSessionGeneration">;
  inbound: Pick<InboundChatEvent, "timelineKey"> & {
    event: { sender: { id: string }; timestamp: number };
  };
  ctx: "dm" | "group";
  resumeCfg: ResumeGateConfig;
  exemptToolNames: ReadonlySet<string>;
  /**
   * Resolve the context ceiling for a session type. Optionally receives the
   * session record's timeline key (spec PER-AGENT-MODEL-OVERRIDES FIX 7) so
   * the ceiling is resolved against the per-agent model rather than the global
   * session-type model. Callers that omit `timelineKey` fall back to the
   * global-only path (backward-compatible).
   */
  resolveCeiling: (sessionType: string, timelineKey?: string) => number | undefined;
  loadMaterial: (row: AgentSessionRow) => Promise<ResumeMaterial | null>;
  logger: Pick<Logger, "warn">;
}): Promise<ResumeGateVerdict> {
  const { sessionId, targetEvent, inbound, ctx, resumeCfg, exemptToolNames, logger } = args;
  try {
    const row = args.getSession();
    // §7.2: only `completed` is reply-resumable (failed-resumable/interrupted keep
    // the console path; discarded is dead; a pruned/missing row → FRESH).
    if (!row || row.status !== "completed") return { resume: false };
    // §7.3: synthetic worker sessions (summarize/condense/diary) aren't repliable.
    if (SYNTHETIC_SESSION_TYPES.has(row.session_type)) return { resume: false };
    // §7.4 generation gate: the target message must carry the session's CURRENT
    // generation (a reply to a superseded output → stale → FRESH).
    if ((targetEvent.agentSessionGeneration ?? 0) !== row.resume_generation) return { resume: false };
    // §7.6 intent heuristics (human reply). Explicit agent delegation would bypass
    // these — but delegation today only targets running sessions, never reaches here.
    if (
      (resumeCfg.same_user_only ?? true) &&
      row.trigger_sender_id &&
      inbound.event.sender.id !== row.trigger_sender_id
    ) {
      return { resume: false };
    }
    const windowMs = resumeCfg.window?.[ctx];
    if (
      windowMs !== undefined &&
      windowMs > 0 &&
      row.completed_at != null &&
      inbound.event.timestamp - row.completed_at > windowMs
    ) {
      return { resume: false };
    }
    // §7.7 capability gate: if the persisted context is already at/over the
    // ceiling, a resume would immediately re-park (no compaction) — FRESH instead.
    let ceiling: number | undefined;
    try {
      // Thread the row's timeline key so the ceiling uses the per-agent model (FIX 7).
      ceiling = args.resolveCeiling(row.session_type, row.timeline_key);
    } catch {
      ceiling = undefined;
    }
    if (ceiling !== undefined && row.context_tokens != null && row.context_tokens >= ceiling) {
      return { resume: false };
    }
    // §7.5/§7.8 work gate + material viability (one load of the completed material).
    const material = await args.loadMaterial(row);
    if (!material) return { resume: false };
    const scope = (resumeCfg.work_gate?.[ctx]?.scope ??
      (ctx === "dm" ? "any_in_history" : "since_last_turn")) as ResumeWorkScope;
    if (!hasResumableWork(material.transcript, { scope, exemptToolNames })) return { resume: false };
    return { resume: true, row, material };
  } catch (error) {
    // A gate threw unexpectedly → treat as ineligible (FRESH), never propagate.
    logger.warn("resume_gate_threw", {
      sessionId,
      timelineKey: inbound.timelineKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return { resume: false };
  }
}

/** The verdict of {@link evaluateFollowUpResumeGate}. */
export type FollowUpResumeGateVerdict =
  | { resume: true; row: AgentSessionRow; material: ResumeMaterial }
  | { resume: false };

/**
 * Cross-field validation for `[agent.sessions.followup]` (spec FOLLOWUP-FOLDING §9) —
 * the rules TypeBox can't express. Factored out for unit-testing; called once at app
 * wiring (fail-fast). Throws on the first offending lever; an absent block (folding
 * unconfigured) is valid.
 */
export function assertFollowupConfigValid(
  followup: AppConfig["agent"]["sessions"]["followup"],
): void {
  if (!followup) return;
  for (const form of ["media", "text", "mention"] as const) {
    const lever = followup[form];
    if (!lever) continue;
    const userGap = lever.user_gap_ms;
    const wallClock = lever.wall_clock_ms;
    // The wall-clock lifetime must CONTAIN the user-gap it guards — the follow-up's
    // wall-clock age at fold time is ≈ its user-perceived gap plus processing lag, so a
    // wall_clock_ms below user_gap_ms makes the user-gap moot (the looser clock would
    // always cut first). Refuse it.
    if (userGap !== undefined && wallClock !== undefined && wallClock < userGap) {
      throw new Error(
        `agent.sessions.followup.${form}: wall_clock_ms (${wallClock}) must be >= user_gap_ms (${userGap}) — ` +
          `the watch lifetime has to outlast the user-perceived gap it guards`,
      );
    }
    // A lever block that sets a user gap but omits its wall-clock lifetime would resolve
    // `wall_clock_ms` to 0 (`resolveFollowUpLever`'s `?? 0`), silently disabling that
    // lever (every follow-up's wall-clock age exceeds 0). Refuse the partial block
    // rather than ship a dead lever — defends against a future 00-defaults edit that
    // drops the field (shipped defaults set all three).
    if (userGap !== undefined && wallClock === undefined) {
      throw new Error(
        `agent.sessions.followup.${form}: user_gap_ms is set but wall_clock_ms is missing — ` +
          `a lever with no wall-clock lifetime is silently inert; set wall_clock_ms`,
      );
    }
  }
}

/**
 * The follow-up settled→resume gate (spec FOLLOWUP-FOLDING §5.3), factored out for
 * unit-testing like {@link evaluateResumeGate}. A deliberate SUBSET of reply-resume's
 * gate: it KEEPS the completed-status check, the synthetic-type exclusion, the
 * capability/context-ceiling gate (an image is token-heavy — a resume that would
 * instantly re-park is pointless), and material viability; it DROPS the work gate
 * (the rationale is inverted — a toolless "look at this" session is exactly what we
 * resume), the time window, the same-user check (structural via the per-sender watch),
 * and the generation-match (the watch names the session directly; single-consumption
 * is the caller's CAS). Throw-safe: ANY unexpected throw degrades to `{resume:false}`
 * (→ native fate), never propagating — a fold-resume must never drop the follow-up.
 */
export async function evaluateFollowUpResumeGate(args: {
  sessionId: string;
  getSession: () => AgentSessionRow | undefined;
  /**
   * Resolve the context ceiling for a session type. Optionally receives the
   * session record's timeline key (spec PER-AGENT-MODEL-OVERRIDES FIX 7) so
   * the ceiling is resolved against the per-agent model rather than the global
   * session-type model. Callers that omit `timelineKey` fall back to the
   * global-only path (backward-compatible).
   */
  resolveCeiling: (sessionType: string, timelineKey?: string) => number | undefined;
  loadMaterial: (row: AgentSessionRow) => Promise<ResumeMaterial | null>;
  timelineKey: string;
  logger: Pick<Logger, "warn">;
}): Promise<FollowUpResumeGateVerdict> {
  try {
    const row = args.getSession();
    // §7.2: only a `completed` row is resumable (failed-resumable/interrupted keep the
    // console path; discarded is dead; a pruned/missing row → native fate).
    if (!row || row.status !== "completed") return { resume: false };
    // §7.3: synthetic worker sessions never arm a watch, but exclude defensively.
    if (SYNTHETIC_SESSION_TYPES.has(row.session_type)) return { resume: false };
    // Capability/context-ceiling gate (§5.3 KEEP): a resume that would instantly
    // re-park is pointless → native fate instead.
    let ceiling: number | undefined;
    try {
      // Thread the row's timeline key so the ceiling uses the per-agent model (FIX 7).
      ceiling = args.resolveCeiling(row.session_type, row.timeline_key);
    } catch {
      ceiling = undefined;
    }
    if (ceiling !== undefined && row.context_tokens != null && row.context_tokens >= ceiling) {
      return { resume: false };
    }
    // Material viability (one load of the completed material).
    const material = await args.loadMaterial(row);
    if (!material) return { resume: false };
    return { resume: true, row, material };
  } catch (error) {
    args.logger.warn("follow_up_resume_gate_threw", {
      sessionId: args.sessionId,
      timelineKey: args.timelineKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return { resume: false };
  }
}

function resolveReadImageMaxBytes(config: AppConfig, perModelBytes?: number): number {
  const DEFAULT_PER_MODEL = 5_242_880; // 5 MB base64 (≈ 3.75 MB raw before encoding).
  // Keyed on the SERVING (reply) model's own `image_input_bytes`, passed by the
  // caller — never a fixed `[models.default]` read (which may be a different model).
  const perModel = perModelBytes ?? DEFAULT_PER_MODEL;
  const candidates = [
    perModel,
    config.media?.download_size_limit,
  ].filter((v): v is number => typeof v === "number");
  return Math.min(...candidates);
}

// ---------------------------------------------------------------------------
// Multi-agent config validation (spec MULTI-AGENT-SUPPORT §3 / §4.2)
// ---------------------------------------------------------------------------
//
// Pure synchronous guard — no I/O, no side effects. Throws a descriptive Error
// on any hard violation. Silently passes (without logging) the out-of-class
// account-key warning because that requires a logger; callers may independently
// check account keys if they want the advisory.
//
// Called by startMikuAgent before any I/O, and importable for unit tests.

/** Strict identifier pattern for agent names and the advisory pattern for account keys. */
const AGENT_NAME_RE_EXPORTED = /^[a-z0-9-]+$/;

/**
 * Validate multi-agent configuration cross-field invariants (spec §3 / §4.2).
 * Throws on any hard violation; returns `void` on a valid config.
 *
 * Checks:
 * - §3: colon in any account key (matrix or discord) → fatal (all modes)
 * - §3 agents mode: path-unsafe characters in any account key → fatal.
 *   Rationale: agents mode is a new opt-in with no frozen data under such keys,
 *   and §7.4 embeds the account key directly in a filesystem path
 *   (`msg-attach/<provider>.<accountKey>/`). A key containing `/`, `\`, `..`
 *   as a path segment, or whitespace/control characters can nest directories,
 *   break the one-mv relink invariant, or escape the workspace root. In legacy
 *   mode the key is never used in a path, so only the colon (which breaks
 *   parseTimelineKey) remains a hard error there — all other out-of-class chars
 *   stay warning-only (§3 back-compat unchanged).
 * - §4.2 agents mode: `[workspace].root_dir` + `[agents]` mutual exclusivity
 * - §4.2 agents mode: agent names must match `[a-z0-9-]+`
 * - §4.2 agents mode: every account's resolved agent name must match a declared entry
 * - §4.2 agents mode: workspace roots must be pairwise disjoint (no nesting)
 * - §4.2 legacy mode: `agent` field on any account without an `[agents]` table → error
 * - §10 sandbox mode: strict agents must have distinct container_name and workspace_mount;
 *   no strict agent root under the shared common parent (would void isolation)
 * - §10a browser: global profile_name with [agents] is an error; per-agent profile_names
 *   must be pairwise distinct
 */
export function validateAgentConfig(config: AppConfig): void {
  // §3: colon in an account key breaks parseTimelineKey (orphans the timeline).
  for (const accountKey of Object.keys(config.matrix?.accounts ?? {})) {
    if (accountKey.includes(":")) {
      throw new Error(
        `[matrix] account key "${accountKey}" contains a colon — this breaks ` +
          `parseTimelineKey and orphans every stored timeline. Rename the key ` +
          `(note: renaming is NOT migration-safe if rows already exist).`,
      );
    }
  }
  for (const accountKey of Object.keys(config.discord?.accounts ?? {})) {
    if (accountKey.includes(":")) {
      throw new Error(
        `[discord] account key "${accountKey}" contains a colon — this breaks ` +
          `parseTimelineKey and orphans every stored timeline. Rename the key ` +
          `(note: renaming is NOT migration-safe if rows already exist).`,
      );
    }
  }
  for (const accountKey of Object.keys(config.irc?.accounts ?? {})) {
    if (accountKey.includes(":")) {
      throw new Error(
        `[irc] account key "${accountKey}" contains a colon — this breaks ` +
          `parseTimelineKey and orphans every stored timeline. Rename the key ` +
          `(note: renaming is NOT migration-safe if rows already exist).`,
      );
    }
  }

  if (config.agents && Object.keys(config.agents).length > 0) {
    // §3 agents mode: path-unsafe characters in account keys are a hard startup
    // error. The key is baked into msg-attach/<provider>.<accountKey>/ (§7.4);
    // a key with `/`, `\`, `..` as a path segment, or whitespace/control chars
    // can nest directories or escape the workspace root.
    const pathUnsafeRe = /[/\\]|(?:^|\.)\.\.(?:\.|$)|[\s\x00-\x1f\x7f]/;
    for (const accountKey of Object.keys(config.matrix?.accounts ?? {})) {
      if (pathUnsafeRe.test(accountKey)) {
        throw new Error(
          `[matrix] account key "${accountKey}" contains a path-unsafe character ` +
            `(slash, backslash, ".." path segment, or whitespace/control char). ` +
            `In agents mode the key is embedded in filesystem paths (§7.4); ` +
            `rename the key before adding [agents] blocks (§3 back-compat: this ` +
            `is only a hard error in agents mode where no data exists under the key yet).`,
        );
      }
    }
    for (const accountKey of Object.keys(config.discord?.accounts ?? {})) {
      if (pathUnsafeRe.test(accountKey)) {
        throw new Error(
          `[discord] account key "${accountKey}" contains a path-unsafe character ` +
            `(slash, backslash, ".." path segment, or whitespace/control char). ` +
            `In agents mode the key is embedded in filesystem paths (§7.4); ` +
            `rename the key before adding [agents] blocks (§3 back-compat: this ` +
            `is only a hard error in agents mode where no data exists under the key yet).`,
        );
      }
    }
    for (const accountKey of Object.keys(config.irc?.accounts ?? {})) {
      if (pathUnsafeRe.test(accountKey)) {
        throw new Error(
          `[irc] account key "${accountKey}" contains a path-unsafe character ` +
            `(slash, backslash, ".." path segment, or whitespace/control char). ` +
            `In agents mode the key is embedded in filesystem paths (§7.4); ` +
            `rename the key before adding [agents] blocks (§3 back-compat: this ` +
            `is only a hard error in agents mode where no data exists under the key yet).`,
        );
      }
    }

    // ── Agents mode (§4.2) ────────────────────────────────────────────────────
    if (config.workspace?.root_dir !== undefined) {
      throw new Error(
        "[workspace].root_dir is mutually exclusive with [agents] — remove root_dir " +
          "from config and set workspace_root on each [agents.*] block instead.",
      );
    }
    for (const agentName of Object.keys(config.agents)) {
      if (!AGENT_NAME_RE_EXPORTED.test(agentName)) {
        throw new Error(
          `[agents] name "${agentName}" contains characters outside [a-z0-9-]. ` +
            `Agent names are path-safe identifiers: use only lowercase letters, digits, and hyphens.`,
        );
      }
    }
    for (const [accountKey, account] of Object.entries(config.matrix?.accounts ?? {})) {
      const agentName = (account as { agent?: string }).agent ?? accountKey;
      if (!config.agents[agentName]) {
        throw new Error(
          `[matrix.accounts.${accountKey}] refers to agent "${agentName}" ` +
            `which is not declared in [agents]. Add [agents.${agentName}] or set agent = "<existing-name>".`,
        );
      }
    }
    for (const [accountKey, account] of Object.entries(config.discord?.accounts ?? {})) {
      const agentName = account.agent ?? accountKey;
      if (!config.agents[agentName]) {
        throw new Error(
          `[discord.accounts.${accountKey}] refers to agent "${agentName}" ` +
            `which is not declared in [agents]. Add [agents.${agentName}] or set agent = "<existing-name>".`,
        );
      }
    }
    for (const [accountKey, account] of Object.entries(config.irc?.accounts ?? {})) {
      const agentName = account.agent ?? accountKey;
      if (!config.agents[agentName]) {
        throw new Error(
          `[irc.accounts.${accountKey}] refers to agent "${agentName}" ` +
            `which is not declared in [agents]. Add [agents.${agentName}] or set agent = "<existing-name>".`,
        );
      }
    }
    // Pairwise disjoint check
    const agentRoots = Object.entries(config.agents).map(([name, block]) => ({
      name,
      resolved: path.resolve(block.workspace_root),
    }));
    for (let i = 0; i < agentRoots.length; i++) {
      for (let j = i + 1; j < agentRoots.length; j++) {
        const a = agentRoots[i]!;
        const b = agentRoots[j]!;
        const sep = path.sep;
        if (
          a.resolved === b.resolved ||
          b.resolved.startsWith(a.resolved + sep) ||
          a.resolved.startsWith(b.resolved + sep)
        ) {
          throw new Error(
            `[agents] workspace roots must be pairwise disjoint: ` +
              `"${a.name}" (${a.resolved}) and "${b.name}" (${b.resolved}) overlap.`,
          );
        }
      }
    }

    // ── Phase 4: Browser validation (§10a) ─────────────────────────────────
    // A global [browser].profile_name alongside [agents] is a startup error.
    // Same rule as [workspace].root_dir + same schema-optional treatment.
    if (config.browser?.profile_name !== undefined) {
      throw new Error(
        "[browser].profile_name is not valid when [agents] is present — in agents mode, " +
          "each agent declares its own profile_name under [agents.<name>.browser]. " +
          "Remove profile_name from the global [browser] block.",
      );
    }
    // Per-agent browser profile_names must be pairwise distinct.
    const agentBrowserProfiles = new Map<string, string>(); // profile_name → first-seen agent name
    for (const [agentName, block] of Object.entries(config.agents)) {
      const profileName = block.browser?.profile_name;
      if (profileName !== undefined) {
        const existing = agentBrowserProfiles.get(profileName);
        if (existing !== undefined) {
          throw new Error(
            `[agents] browser profile_name "${profileName}" is shared between agents ` +
              `"${existing}" and "${agentName}" — each agent's browser profile must be ` +
              `distinct (a profile carries cookies and fingerprint state that must never cross agents).`,
          );
        }
        agentBrowserProfiles.set(profileName, agentName);
      }
    }

    // ── Phase 5c: summaries_from validation (§10b) ─────────────────────────
    for (const [agentName, block] of Object.entries(config.agents)) {
      const donorName = block.summaries_from;
      if (donorName === undefined) continue;
      if (donorName === agentName) {
        throw new Error(
          `[agents.${agentName}] summaries_from = "${donorName}" is a self-reference — ` +
            `an agent cannot mirror its own summaries.`,
        );
      }
      if (!config.agents[donorName]) {
        throw new Error(
          `[agents.${agentName}] summaries_from = "${donorName}" names an agent ` +
            `that is not declared in [agents]. Add [agents.${donorName}] or correct the name.`,
        );
      }
      if (config.agents[donorName]!.summaries_from !== undefined) {
        throw new Error(
          `[agents.${agentName}] summaries_from = "${donorName}" would create a chain — ` +
            `"${donorName}" itself has summaries_from = "${config.agents[donorName]!.summaries_from}". ` +
            `Donor agents must not themselves mirror (no chains).`,
        );
      }
    }

    // ── Per-agent MCP server allowlist validation (spec PER-AGENT-MCP-SCOPING) ─
    // Every key in mcp_servers must name a configured [mcp.servers.<key>] block.
    // An unknown key is a startup error (strict-config philosophy: catches typos
    // and stale entries when a server is removed from config).
    {
      const configuredServers = new Set(Object.keys(config.mcp?.servers ?? {}));
      for (const [agentName, block] of Object.entries(config.agents)) {
        if (block.mcp_servers === undefined) continue;
        for (const serverKey of block.mcp_servers) {
          if (!configuredServers.has(serverKey)) {
            throw new Error(
              `[agents.${agentName}].mcp_servers: "${serverKey}" does not name a configured ` +
                `[mcp.servers.*] block; add [mcp.servers.${serverKey}] or remove the entry.`,
            );
          }
        }
      }
    }

    // ── Phase 4: Sandbox validation (§10) ───────────────────────────────────
    // Strict agents (those with a per-agent sandbox block) must not share container_name
    // with each other, and must not use the shared [sandbox].container_name. Two managers
    // ensuring the same container name with different host mounts would race and produce
    // a confusing runtime mount-mismatch error that is hard to diagnose.
    const strictContainerNames = new Map<string, string>(); // container_name → first-seen agent name
    for (const [agentName, block] of Object.entries(config.agents)) {
      if (!block.sandbox) continue;
      const existing = strictContainerNames.get(block.sandbox.container_name);
      if (existing !== undefined) {
        throw new Error(
          `[agents] sandbox container_name "${block.sandbox.container_name}" is shared between ` +
            `agents "${existing}" and "${agentName}" — each strict-mode agent must use a distinct container_name.`,
        );
      }
      strictContainerNames.set(block.sandbox.container_name, agentName);
    }
    // Also reject any strict agent whose container_name collides with the global
    // [sandbox].container_name — the shared manager and the strict manager would
    // both ensure the same Docker container but with different bind-mount sources.
    if (config.sandbox) {
      const sharedContainerName = config.sandbox.container_name;
      for (const [agentName, block] of Object.entries(config.agents)) {
        if (!block.sandbox) continue;
        if (block.sandbox.container_name === sharedContainerName) {
          throw new Error(
            `[agents] strict-mode agent "${agentName}" sandbox container_name "${sharedContainerName}" ` +
              `matches the global [sandbox].container_name — use a distinct container_name so each ` +
              `manager ensures a separate Docker container with its own mount configuration.`,
          );
        }
      }
    }
    // NOTE: workspace_mount is a CONTAINER-SIDE path. Two strict-mode agents in separate
    // containers (each with a distinct container_name) can legitimately share the same
    // container-side mount path (e.g. "/workspace") — the containers are independent, so
    // there is no clash. Host-side disjointness (each agent's workspace_root pointing at a
    // different host directory) is already enforced by Phase 1's pairwise workspace-root check.
    // We do NOT require workspace_mount to be unique across strict agents.

    // Shared-mode agents share the global [sandbox] container. Validate that no
    // strict agent's workspace root lies under the shared common parent — that
    // would expose the strict agent's workspace to shared-mode agents (§10).
    const sharedAgentNames = Object.entries(config.agents).filter(([, b]) => !b.sandbox).map(([n]) => n);
    if (sharedAgentNames.length > 0 && config.sandbox?.enabled) {
      const sharedRoots = sharedAgentNames.map((n) => path.resolve(config.agents![n]!.workspace_root));
      const commonAncestor = computeCommonAncestor(sharedRoots);
      const sep = path.sep;
      for (const [agentName, block] of Object.entries(config.agents)) {
        if (!block.sandbox) continue; // skip shared-mode agents
        const strictRoot = path.resolve(block.workspace_root);
        if (strictRoot === commonAncestor || strictRoot.startsWith(commonAncestor + sep)) {
          throw new Error(
            `[agents] strict-mode agent "${agentName}" workspace root (${strictRoot}) lies under ` +
              `the shared sandbox common parent (${commonAncestor}), which would expose it to ` +
              `shared-mode agents via the shared container mount — move the strict agent's ` +
              `workspace outside the shared parent directory (§10).`,
          );
        }
      }
    }

    // ── Per-agent model overrides (spec PER-AGENT-MODEL-OVERRIDES §7) ────────
    // All checks run for every agent that carries a `models` block. Mirror the
    // fail-fast philosophy of the global role checks (app.ts ~1764/~1984):
    // unknown model names, broken chains, missing context_window on session-type
    // models, overrides for unconfigured subsystems, and summaries_from conflicts
    // all throw a path-precise error naming the agent and key.
    {
      // §7: the role-designated session type names are always valid override keys —
      // the process may launch these types regardless of explicit configuration.
      const proactiveTypeName = config.proactive?.session_type ?? "proactive";
      const roleDesignatedTypes = new Set<string>([
        "summarize",
        "condense",
        "diary",
        proactiveTypeName,
      ]);
      // Any key explicitly declared under [agent.session_types] is also valid.
      const declaredSessionTypeKeys = new Set<string>(
        Object.keys(config.agent?.session_types ?? {}),
      );
      // "default" is always a valid override key (§7 / spec §4 rung 2).
      const isValidSessionTypeKey = (key: string): boolean =>
        key === "default" || declaredSessionTypeKeys.has(key) || roleDesignatedTypes.has(key);

      // Helper: resolve model chain or throw with path-precise context.
      const requireChain = (modelRef: string, keyPath: string): void => {
        try {
          resolveModelChain(modelRef, config.models);
        } catch (err) {
          throw new Error(
            `${keyPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      // Helper: require context_window on the chain head — same check as
      // validateContextTokenCeilings for session-type models (the factory's
      // resolveSessionContextCeiling requires it for enforcement).
      const requireContextWindow = (modelRef: string, keyPath: string): void => {
        // requireChain above already rejected unknown refs
        const model = config.models[modelRef]!;
        if (model.context_window === undefined) {
          throw new Error(
            `${keyPath}: model "${modelRef}" must declare context_window — ` +
              `it is required for session-type enforcement`,
          );
        }
      };

      for (const [agentName, block] of Object.entries(config.agents)) {
        const overrides = block.models;
        if (!overrides) continue;

        // §7: session_types key existence and model chain validation.
        if (overrides.session_types) {
          for (const [typeKey, modelRef] of Object.entries(overrides.session_types)) {
            if (!isValidSessionTypeKey(typeKey)) {
              const validExtra = [...roleDesignatedTypes].filter(
                (k) => !declaredSessionTypeKeys.has(k),
              );
              throw new Error(
                `[agents.${agentName}].models.session_types: key "${typeKey}" does not name ` +
                  `a launchable session type — valid keys are declared [agent.session_types] ` +
                  `names, "default", or role-designated type names (${validExtra.join(", ")})`,
              );
            }
            const keyPath = `[agents.${agentName}].models.session_types.${typeKey}`;
            requireChain(modelRef, keyPath);
            requireContextWindow(modelRef, keyPath);
          }
        }

        // §7: summaries_from + summarize/condense override is dead config (§6).
        if (block.summaries_from !== undefined && overrides.session_types) {
          const deadKeys = (["summarize", "condense"] as const).filter(
            (k) => overrides.session_types![k] !== undefined,
          );
          if (deadKeys.length > 0) {
            throw new Error(
              `[agents.${agentName}]: summaries_from = "${block.summaries_from}" is set AND ` +
                `models.session_types has override(s) for ${deadKeys.map((k) => `"${k}"`).join(", ")} — ` +
                `agents with summaries_from never run summarization sessions, so these overrides are dead config`,
            );
          }
        }

        // §7: captioning overrides require a global [captioning] table.
        if (overrides.captioning) {
          if (!config.captioning) {
            throw new Error(
              `[agents.${agentName}].models.captioning: overrides require a global [captioning] ` +
                `table — add [captioning] to config or remove the agent captioning overrides`,
            );
          }
          for (const [modalityKey, modelRef] of Object.entries(overrides.captioning)) {
            if (modelRef === undefined) continue;
            requireChain(modelRef, `[agents.${agentName}].models.captioning.${modalityKey}`);
          }
        }

        // §7: image_gen overrides require a global [image_gen] table.
        if (overrides.image_gen) {
          if (!config.image_gen) {
            throw new Error(
              `[agents.${agentName}].models.image_gen: overrides require a global [image_gen] ` +
                `table — add [image_gen] to config or remove the agent image_gen overrides`,
            );
          }
          for (const [tierKey, modelRef] of Object.entries(overrides.image_gen)) {
            if (modelRef === undefined) continue;
            requireChain(modelRef, `[agents.${agentName}].models.image_gen.${tierKey}`);
          }
        }

        // §7: x_search overrides require a global [x_search] table.
        if (overrides.x_search) {
          if (!config.x_search) {
            throw new Error(
              `[agents.${agentName}].models.x_search: overrides require a global [x_search] ` +
                `table — add [x_search] to config or remove the agent x_search overrides`,
            );
          }
          for (const [keyName, modelRef] of Object.entries(overrides.x_search)) {
            if (modelRef === undefined) continue;
            requireChain(modelRef, `[agents.${agentName}].models.x_search.${keyName}`);
          }
        }
      }
    }
  } else {
    // ── Legacy mode (§4.2): agent field on account without [agents] is an error ─
    const matrixAgentFields = Object.entries(config.matrix?.accounts ?? {}).filter(
      ([, a]) => (a as { agent?: string }).agent !== undefined,
    );
    const discordAgentFields = Object.entries(config.discord?.accounts ?? {}).filter(
      ([, a]) => a.agent !== undefined,
    );
    const ircAgentFields = Object.entries(config.irc?.accounts ?? {}).filter(
      ([, a]) => a.agent !== undefined,
    );
    if (matrixAgentFields.length > 0 || discordAgentFields.length > 0 || ircAgentFields.length > 0) {
      const offenders = [
        ...matrixAgentFields.map(([k]) => `[matrix.accounts.${k}].agent`),
        ...discordAgentFields.map(([k]) => `[discord.accounts.${k}].agent`),
        ...ircAgentFields.map(([k]) => `[irc.accounts.${k}].agent`),
      ].join(", ");
      throw new Error(
        `account-level \`agent\` field (${offenders}) is not valid without an ` +
          `[agents] table — add [agents.*] blocks or remove the \`agent\` fields.`,
      );
    }
  }
}
