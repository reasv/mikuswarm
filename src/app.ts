import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config/index.js";
import { createLogger, createObservabilityServer, PipelineActivityBus, SessionLiveEventBus, type ConsoleServer, type Logger } from "./observability/index.js";
import { MatrixProvider, RoomLabelCache, ingestReactionEvent } from "./matrix/index.js";
import { Storage, MemoryFileWriter, type AgentSessionRow } from "./storage/index.js";
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
import {
  AgentSessionFactory,
  LlmScheduler,
  LlmRequestRing,
  DEFAULT_LLM_REQUEST_RING_SIZE,
  SessionManager,
  SessionClaims,
  coTargetOwnerSteerableSoon,
  SessionRunner,
  isLlmRunFailure,
  createManualResumeSession,
  isResumableRunError,
  loadResumeMaterial,
  loadCompletedSessionMaterial,
  SYNTHETIC_SESSION_TYPES,
  hasResumableWork,
  type ResumeMaterial,
  type ResumeWorkScope,
  type AgentSessionRecord,
  type ManualResumeResult,
} from "./agent/index.js";
import { attachSessionCapture, type SessionCaptureHandle } from "./agent/session-capture.js";
import { emptyUsageTotals } from "./agent/usage.js";
import { SessionUsageTracker, type CostRates, type SessionUsageTotals } from "./agent/usage.js";
import { makeCostWarnDecider, selectToolCostSeed } from "./agent/cost-budget.js";
import { ContextBuilder, renderRichMessage } from "./context/index.js";
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
  createSillyTavernCardCreateTool,
  createSillyTavernCardEditTool,
  createSillyTavernCardReadTool,
  createTextEditorTool,
  createUserProfileEditTool,
  createUserProfileReadTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteMemoryTool,
  createXFetchTool,
  createXSearchTool,
  GrokResultCache,
  createFindSourceTool,
  type ToolUsageRecord,
} from "./tools/index.js";
import { SauceNaoRateLimiter } from "./saucenao/rate-limiter.js";
import { setEgressGuardEnabled } from "./tools/ssrf.js";
import { configureHttpLimiter } from "./tools/http-limiter.js";
import type { CanonicalChatEvent, InboundChatEvent } from "./types.js";
import { EnrichmentWorkerPool, FetchClient } from "./enrichment/index.js";
import { FxTwitterClient, resolveFxTwitterConfig } from "./fxtwitter/index.js";
import { CaptionWorkerPool, InferenceClient, resolveCaptionCost, type MediaModality } from "./captioning/index.js";
import { buildInferenceImageOptions } from "./media/index.js";
import { McpClientPool, adaptMcpTools } from "./mcp/index.js";
import { SummarizationIndexer, SummarizationWorkerPool, createEscalateSummary } from "./summarization/index.js";
import { DiaryWorkerPool } from "./diary/index.js";
import { ProactiveScheduler } from "./proactive/index.js";
import { BudgetEngine, collectZeroCostModelIds, collectKnownModelIds, normalizeLimits, makeRateLimitedClaimGate, type BudgetHooks, type SpendDescriptor, type AdmissionResult } from "./budget/index.js";
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
import { SandboxManager } from "./sandbox/index.js";
import { BrowserSession } from "./browser/index.js";
import { getConfiguredTimezone } from "./time/index.js";

export interface MikuAgentRuntime {
  stop(): Promise<void>;
}

export async function startMikuAgent(config: AppConfig): Promise<MikuAgentRuntime> {
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
      { group: config.captioning?.model?.rate_limit_group, source: "captioning.model" },
      ...(["image", "video", "audio"] as const).map((modality) => ({
        group: config.captioning?.[modality]?.model?.rate_limit_group,
        source: `captioning.${modality}.model`,
      })),
      { group: config.retrieval?.embedding?.remote?.rate_limit_group, source: "retrieval.embedding.remote" },
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
  // [saucenao] cross-field sanity (spec SAUCENAO-SOURCE-LOOKUP §3.2/§5; app-wiring
  // per the proactive-posting precedent): the schema keeps `api_key` optional so a
  // disabled block needn't carry a `${SAUCENAO_API_KEY}` template that would fail
  // startup when the env var is unset — but an *enabled* block with no key is a
  // misconfiguration the `find_source` tool would only catch at construction time.
  if (config.saucenao?.enabled === true && !(config.saucenao.api_key ?? "").trim()) {
    throw new Error(
      "saucenao.enabled is true but saucenao.api_key is missing/empty — set a SauceNAO API key (e.g. api_key = \"${SAUCENAO_API_KEY}\") or set enabled = false.",
    );
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
      probeIntervalMs: config.recovery?.llm_probe_interval_ms,
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
  // Canonicalize once at the source. `config.workspace.root_dir` is commonly
  // configured as a relative path (e.g. "./workspaces/miku"); resolving it here
  // means every tool downstream receives an absolute, normalized root. That
  // keeps path-containment guards correct regardless of how they compare paths,
  // so a tool can't reintroduce the "absolute path never string-prefixes a
  // relative root" class of false-rejection bug. Idempotent for the sandbox,
  // which already calls path.resolve(workspaceRoot) for its bind mount below.
  const workspaceRoot = path.resolve(config.workspace.root_dir);
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
  let browserSession: BrowserSession | undefined;
  if (config.browser?.enabled) {
    // Downloads cross-field validation (same fail-fast convention as the
    // proactive/rate-limit checks above; ARCHITECTURE.md §11b "Downloads"): the
    // two keys describe ONE shared staging volume from two containers'
    // viewpoints, so setting exactly one is a broken topology, not a partial
    // opt-in. Both unset ⇒ downloads disabled (explicit opt-in).
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
    browserSession = new BrowserSession({
      config: config.browser,
      agentTimezone: getConfiguredTimezone(),
      workspaceRoot,
      // Browser downloads share the global media size cap; on breach the
      // in-flight download is canceled (§11b).
      downloadSizeLimit,
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
    // Claim registry for `<handled_by_session>` markers (DUPLICATE-REPLY-MITIGATION §4).
    sessionClaims,
  );

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

  // Shared, cross-session Grok-result cache for x_search (spec X-SEARCH §9): one
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
    config.saucenao?.enabled === true
      ? new SauceNaoRateLimiter({
          shortWindowMax: config.saucenao.rate_limit?.short_window_max ?? 6,
          shortWindowMs: config.saucenao.rate_limit?.short_window_ms ?? 30_000,
        })
      : undefined;

  const captioningConfig = config.captioning ?? {};
  const sharedModel = {
    id: captioningConfig.model?.id ?? "google/gemini-3.5-flash",
    endpoint: captioningConfig.model?.endpoint ?? config.models.default.endpoint,
    api_key: captioningConfig.model?.api_key ?? config.models.default.api_key,
    // Accounting provenance recorded on caption usage_events rows; never inherited
    // across a different modality model (parity with cost), only carried verbatim.
    provider: captioningConfig.model?.provider ?? null,
  };

  function resolveModalityModel(modalityConfig?: {
    model?: { id?: string; endpoint?: string; api_key?: string; provider?: string };
  }) {
    return {
      id: modalityConfig?.model?.id ?? sharedModel.id,
      endpoint: modalityConfig?.model?.endpoint ?? sharedModel.endpoint,
      api_key: modalityConfig?.model?.api_key ?? sharedModel.api_key,
      provider: modalityConfig?.model?.provider ?? sharedModel.provider,
    };
  }

  // Rate-limit group for a captioning modality (spec §9.4): the group attaches to
  // the model BLOCK actually in use — a modality override's own group field wins;
  // else the shared captioning model's; only when no captioning model block exists
  // at all (full fallback onto models.default) does the default model's group
  // apply. Unset resolves to `default` inside the scheduler.
  function resolveModalityRateLimitGroup(modalityConfig?: { model?: { rate_limit_group?: string } }): string | undefined {
    if (modalityConfig?.model) return modalityConfig.model.rate_limit_group;
    if (captioningConfig.model) return captioningConfig.model.rate_limit_group;
    return config.models.default.rate_limit_group;
  }

  // Auxiliary caption cost rates (spec AUXILIARY-USAGE-TRACKING §5/§7.1): the
  // config cost block is snake_case USD/1M tokens; map to the CostRates shape.
  // Cost is a property of a SPECIFIC model and is never inherited across models —
  // resolveCaptionCost applies the top-level [captioning.model].cost only when the
  // modality actually runs the shared model. A modality that overrides the model to
  // a different id without its own cost block has UNKNOWN cost (untracked, not the
  // shared model's rates); we warn so that silent gap is visible. Never falls back
  // to models.default.
  function resolveModalityCost(modality: MediaModality, modalityConfig?: {
    model?: { id?: string; cost?: { input: number; output: number; cache_read: number; cache_write: number } };
  }): CostRates | undefined {
    const { rates, unpricedOverride } = resolveCaptionCost({
      modalityModelId: modalityConfig?.model?.id,
      modalityCost: modalityConfig?.model?.cost,
      sharedModelId: sharedModel.id,
      topLevelCost: captioningConfig.model?.cost,
    });
    if (unpricedOverride) {
      logger.warn("caption_cost_untracked_model_override", {
        modality,
        modality_model: modalityConfig?.model?.id,
        shared_model: sharedModel.id,
        detail:
          "captioning modality overrides the model but sets no [captioning." +
          modality +
          ".model.cost]; its usage will be tracked with unknown cost ([captioning.model].cost is not inherited across different models)",
      });
    }
    return rates;
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

  const captionClients = new Map<MediaModality, InferenceClient>([
    ["image", new InferenceClient({
      modality: "image",
      model: resolveModalityModel(imageConfig),
      prompt: imageConfig.prompt ?? "Describe the image.",
      maxChars: imageConfig.max_chars ?? 500,
      maxTokens: imageConfig.max_tokens ?? 2048,
      scheduler: llmScheduler,
      rateLimitGroup: resolveModalityRateLimitGroup(imageConfig),
      costRates: resolveModalityCost("image", imageConfig),
      imageProcessing: inferenceImageOptions,
    })],
    ["video", new InferenceClient({
      modality: "video",
      model: resolveModalityModel(videoConfig),
      prompt: videoConfig.prompt ?? "Describe the video.",
      maxChars: videoConfig.max_chars ?? 500,
      maxTokens: videoConfig.max_tokens ?? 2048,
      scheduler: llmScheduler,
      rateLimitGroup: resolveModalityRateLimitGroup(videoConfig),
      costRates: resolveModalityCost("video", videoConfig),
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
    ["audio", new InferenceClient({
      modality: "audio",
      model: resolveModalityModel(audioConfig),
      prompt: audioConfig.prompt ?? "Transcribe and describe the audio.",
      maxChars: audioConfig.max_chars ?? 2000,
      maxTokens: audioConfig.max_tokens ?? 4096,
      scheduler: llmScheduler,
      rateLimitGroup: resolveModalityRateLimitGroup(audioConfig),
      costRates: resolveModalityCost("audio", audioConfig),
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
    fxtwitter: { client: fxTwitterClient, config: fxTwitterConfig },
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
    budget: budgetHooks,
    captionModelId:
      config.captioning?.model?.id ??
      config.captioning?.image?.model?.id ??
      config.captioning?.video?.model?.id ??
      config.captioning?.audio?.model?.id,
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
    // Reply-as-trigger resolver (spec RESUMABLE-SESSIONS §5). The provider asks,
    // inside its trigger hold, whether an untriggered reply targets one of the
    // bot's own messages with resume enabled for the context; if so it becomes a
    // `reply` trigger and rides the normal hold/debounce/grouping. The provider
    // stays resume-unaware — the timeline lookup and resume config live here. DMs
    // already trigger as `dm`, so in practice this only ever fires for groups
    // (the provider's `!inbound.trigger` guard). The resume-vs-fresh decision
    // stays downstream in `tryReplyResume`; this only classifies the trigger.
    resolveReplyTrigger: ({ provider, externalId, timelineKey, sender }) => {
      const ctx = resumeContextFor(timelineKey);
      if (config.agent.sessions.resume?.enabled?.[ctx] !== true) return undefined;
      const targetEvent = timeline.getByExternalId(provider, externalId, timelineKey);
      if (!targetEvent || targetEvent.timelineKey !== timelineKey || !targetEvent.agentSessionId) {
        return undefined;
      }
      return {
        type: "reply",
        reason: "reply to bot message",
        triggeredBy: { id: sender.id, displayName: sender.displayName },
      };
    },
  });
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
  // llm-gateway keeps the durable wire log upstream.
  const llmRequestRing = new LlmRequestRing(
    config.observability?.llm_request_ring_size ?? DEFAULT_LLM_REQUEST_RING_SIZE,
  );

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
    const normalized = normalizeLimits(config.limits as never, {
      defaultTz: config.agent.timezone ?? "UTC",
      knownTools,
      knownSessionTypes,
      knownModelIds,
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
    const zeroCostModelIds = collectZeroCostModelIds(config);

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
      resolveModelId: (sessionType) => {
        try {
          return factory.resolveModelId(sessionType);
        } catch {
          return undefined;
        }
      },
      logger: logger.child("budget"),
    });

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
  // USAGE-COST-LIMITS §6.3/§6.4, review #2). Returns a `shouldPause` closure that
  // parks the pool while ANY of its `agent_loop` session types is over budget AND
  // — mirroring the caption pool — emits one rate-limited (≤1/min) `usage_limit_blocked`
  // log naming the hit rules. Model-id resolution matches the engine's
  // `isClassAvailable` (resolve via `factory.resolveModelId`; an unresolvable type
  // contributes no descriptor and never blocks). The rate-limited log + first-blocked
  // selection live in the shared `makeRateLimitedClaimGate`; each pool gets its own
  // gate (independent rate-limit clocks). `budgetHooks.engine` is set before pool
  // construction, so it is always present here; absent = no gate (no budgeting).
  const makeAgentLoopClaimGate = (sessionTypes: readonly string[]): (() => boolean) => {
    const engine = budgetHooks.engine;
    if (!engine) return () => false;
    return makeRateLimitedClaimGate({
      engine,
      descriptors: () => {
        const out: SpendDescriptor[] = [];
        for (const sessionType of sessionTypes) {
          let modelId: string | undefined;
          try {
            modelId = factory.resolveModelId(sessionType);
          } catch {
            modelId = undefined;
          }
          if (modelId === undefined) continue; // unresolvable → don't block on it
          out.push({ class: "agent_loop", sessionType, modelId });
        }
        return out;
      },
    });
  };

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
        logger: logger.child("summarization-indexer"),
      })
    : null;

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

    // Wait-or-omit's coverage re-check (spec §7.2/§7.3): when an over-budget
    // build finds no job covering its oldest events, it runs ONE awaited
    // indexer reconcile before concluding nothing covers them — closing the
    // race against the pool-onComplete fire-and-forget reconcile on deep
    // multi-chunk backlogs. Job creation stays with the indexer; errors are
    // logged here and never reach the build (the builder then proceeds as if
    // the reconcile found nothing).
    contextBuilder.reconcileSummaries = (timelineKey) =>
      summarizationIndexer!.reconcileTimeline(timelineKey).catch((error) => {
        logger.error("summary_reconcile_for_build_failed", {
          timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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

  // Feed the context builder's <runtime_state> channel descriptor (label + DM
  // flag). Mirrors resolveChannelLabel but returns both fields from one
  // channelInfo call, and — per the hook contract — never rejects: a malformed
  // key or lookup failure resolves to null and the Channel/Type lines are simply
  // omitted (the raw timeline key still identifies the room).
  contextBuilder.resolveChannelContext = async (timelineKey) => {
    try {
      const accountId = timelineKey.split(":")[1];
      const roomId = roomIdFromTimelineKey(timelineKey);
      if (!roomId) return null;
      const client = provider.getClient({ provider: "matrix", timelineKey, accountId });
      return await client.channelContext({ roomId });
    } catch (error) {
      logger.debug("resolve_channel_context_failed", {
        timelineKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
        // Budget claim gate (spec USAGE-COST-LIMITS §6.3): park while the diary
        // class is over budget. Diary depends on nothing, so this gates only diary.
        // Emits a rate-limited `usage_limit_blocked` log on pause (§6.4, review #2).
        shouldPause: makeAgentLoopClaimGate(["diary"]),
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
  const gapBackfetchSelfIds = new Map<string, string>();
  for (const [accountId, account] of Object.entries(config.matrix.accounts)) {
    if (account.user_id) gapBackfetchSelfIds.set(accountId, account.user_id);
  }
  const gapBackfetch = new GapBackfetchCoordinator({
    storage,
    timeline,
    config: gapBackfetchConfig,
    getClient: (accountId) =>
      provider.getClient({ provider: "matrix", timelineKey: `matrix:${accountId}:`, accountId }),
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
    defaultSafetyCap: config.backfetch?.default_safety_cap ?? 50000,
    defaultTimeoutMs: config.backfetch?.default_timeout_ms ?? 0,
    utdHaltThreshold: config.backfetch?.utd_halt_threshold ?? 50,
    captionBackfetched: config.backfetch?.caption_backfetched ?? false,
  };
  const messageBackfetch = new MessageBackfetchCoordinator({
    storage,
    timeline,
    config: messageBackfetchConfig,
    getClient: (accountId) =>
      provider.getClient({ provider: "matrix", timelineKey: `matrix:${accountId}:`, accountId }),
    selfUserIds: gapBackfetchSelfIds,
    notifyEnrichment: (eventId) => enrichmentPool.notifyNewEvent(eventId),
    notifyCaptions: () => captionPool.notifyNewWork(),
    enqueueChatSearch: (eventId) => chatSearchIndexer.enqueueReconcileEvent(eventId),
    isDraining: () => draining,
    logger: logger.child("message-backfetch"),
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

    // Reply-to-bot as a trigger (spec RESUMABLE-SESSIONS §5) is resolved upstream in
    // the provider's trigger hold (`resolveReplyTrigger`), so a bare reply to one of
    // the bot's own completed messages already carries `inbound.trigger` here (with
    // the hold's debounce + same-sender grouping applied). The §7 fork in
    // launchSession then continues that session or gives a fresh response. Nothing
    // to synthesize at this point.
    if (!inbound.trigger) return;

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
   */
  function buildReplyHydratedEvent(
    inbound: InboundChatEvent,
    target: CanonicalChatEvent,
  ): CanonicalChatEvent {
    const [hydratedTarget] = hydrateEvents(storage, [target]);
    return {
      ...inbound.event,
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
    if (!replyTarget) return false;
    const windowMs = config.agent.sessions.coalesce_window_ms;
    if (windowMs === undefined) return false;

    // The match is the FIRST claim (any attribution) whose own trigger replied to the
    // same beat — including an un-attributed (queued / pre-launch) one (spec
    // DEFERRED-COALESCING).
    const match = sessionClaims.coTargetClaim(inbound.timelineKey, replyTarget);
    if (!match) return false;
    // Only near-simultaneous reactions to the SAME beat merge — bare proximity
    // would wrongly fold the independent questions of Case A.
    if (Math.abs(inbound.event.timestamp - match.triggerTimestamp) > windowMs) return false;

    // Trigger-hold re-delivery dedup (shared with reply-steer): inject at most once.
    if (steeredEventIds.has(inbound.event.id)) return true;

    // Owner already live → steer the co-reply in now (Case B, immediate).
    if (match.sessionId) {
      const outcome = trySteerCoReply(match.sessionId, inbound);
      if (outcome === "steered") return true;
      // Cannot hydrate the quote → spawn rather than inject a broken interjection.
      if (outcome === "no-target") return false;
      // outcome === "not-live": owner attributed but not steerable. Defer only if it
      // is still in its build window (will go live); a terminal/settling owner →
      // spawn (§5.2 — a fresh session built after it settles sees its replies).
      if (!coTargetOwnerSteerableSoon(true, sessions.get(match.sessionId)?.status)) return false;
    } else {
      // Un-attributed owner (queued / accept→launch window): it WILL launch. Only
      // defer if the shared target exists so the interjection can hydrate at drain.
      const target = timeline.getByExternalId(inbound.provider, replyTarget, inbound.timelineKey);
      if (!target || target.timelineKey !== inbound.timelineKey) return false;
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
  ): string {
    const eventForRender = buildReplyHydratedEvent(inbound, target);
    const senderName = inbound.event.sender.displayName ?? inbound.event.sender.id;
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
    // Retain the inbound so the session can spin it off via spawn_session (§5.4),
    // and clean it up when that session settles.
    const externalId = inbound.event.externalId;
    if (externalId) {
      coReplyInbounds.set(externalId, { inbound, intoSessionId: coReplySessionId });
      sessions.onSettle(coReplySessionId, () => coReplyInbounds.delete(externalId));
      // Race guard (review #3): `onSettle` fires nothing if the session ALREADY
      // settled (evicted) between the steer above and this registration — clean up
      // the just-stored entry so it can't linger until shutdown. The check is
      // "record gone" (`!sessions.get`), NOT `isAgentLive`: the success drain
      // (DEFERRED-COALESCING) calls this right after `attachAgent` but BEFORE
      // `runner.run()`, where the steer succeeds yet `agent.signal` is still
      // undefined — `isAgentLive` would be false there and wrongly drop the entry,
      // silently breaking the `spawn_session` affordance the interjection advertises.
      // A still-present record (running, or interrupted-pending-evict) will fire
      // `onSettle` later, so the entry is correctly retained.
      if (!sessions.get(coReplySessionId)) coReplyInbounds.delete(externalId);
    }
    logger.info("co_reply_coalesced", {
      sessionId: coReplySessionId,
      timelineKey: inbound.timelineKey,
      eventId: inbound.event.id,
      replyTarget,
    });
    return "steered";
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
    const roomId = target.roomId;
    // Operative per-session context ceiling (spec CONTEXT-LIMIT-UNIFICATION §2.4
    // consumer 3 / §2.5 ordering shape (a)): the text-editor read budget derives
    // from the SAME resolver call that feeds enforcement and the model descriptor,
    // never an independent `config.models.*.context_window` read — so a session
    // type's override (or a non-default model) shapes the tool budget too.
    const contextCeiling = factory.resolveSessionContextCeiling(sessionType);

    // Shared auxiliary usage-ledger sink for the LLM-calling tools (image_generate,
    // x_search). Feeds the per-session cost ceiling's combined-spend lane in-memory
    // (spec SESSION-COST-LIMITS §4) and appends one durable `tool_invocations` row
    // (spec AUXILIARY-USAGE-TRACKING §8.2 / X-SEARCH §7). Both lanes are separate
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

    return [
      createSendMessageTool({
        provider,
        target,
        timeline,
        agentSessionId: sessionId,
        agentSessionGeneration: resumeGeneration,
        workspaceRoot,
        mediaMaxBytes: downloadSizeLimit,
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
        currentTimelineKey: inbound.timelineKey,
        absenceDefaults: chatSearchDefaults.absence,
      }),
      // Summary drill-down (§9e). DB-backed (lineage tables + shared renderer), so like
      // search/recap it's available regardless of roomId and is single-id (room implicit).
      createExpandSummaryTool({ storage, defaults: chatSearchDefaults.expand }),
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
      }),
      createUserActivityTool({
        storage,
        indexer: chatSearchIndexer,
        currentTimelineKey: inbound.timelineKey,
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
            agentSessionId: sessionId,
            config: config.browser,
            // Same shared per-model base64 cap read_image uses, so inline
            // screenshots respect the model's per-image budget (issue #2).
            maxImageBytes: resolveReadImageMaxBytes(config),
            // Upload paths resolve within (and are confined to) the workspace (§6).
            workspaceRoot,
          })]
        : []),
      // Adaptive paging uses the session's operative context ceiling
      // (`min(context_window, session_type.max_context_tokens)`), resolved once
      // above — so a single read is sized against the budget it will actually
      // consume, not the raw physical window. Clamps in resolveMaxCharacters
      // (50KB–512KB) bound the impact, so a mismatch only shifts the cap within
      // those limits.
      createTextEditorTool({ workspaceRoot, contextWindowTokens: contextCeiling }),
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
        // When the default model lacks vision, `preview` describes the asset via
        // the captioning model instead of emitting an unusable image block.
        modelHasVision: config.models.default.multimodal,
        imageCaptionClient: captionClients.get("image"),
        fetchClient,
        httpProxyUrl: config.network?.http_proxy_url,
        config: config.danbooru,
      }),
      ...(fxTwitterConfig.tool.enabled
        ? [createXFetchTool({
            workspaceRoot,
            fetchClient,
            client: fxTwitterClient,
            // Same shared per-model base64 cap + conditioning pipeline as
            // read_image / the danbooru preview path, so view_media blocks
            // respect the model's per-image budget.
            maxImageBytes: resolveReadImageMaxBytes(config),
            inferenceImageOptions,
            config: fxTwitterConfig.tool,
            statusHosts: fxTwitterConfig.statusHosts,
          })]
        : []),
      ...(config.image_gen
        ? [createImageGenTool({
            workspaceRoot,
            fetchClient,
            downloadSizeLimit,
            inlineImageMaxBytes: resolveReadImageMaxBytes(config),
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
            // Per-tier cost rates (spec §7.2): snake_case config block → CostRates.
            costRates: {
              pro: toImageCostRates(config.image_gen.costs?.pro),
              flash: toImageCostRates(config.image_gen.costs?.flash),
            },
            config: config.image_gen,
          })]
        : []),
      // find_source (spec SAUCENAO-SOURCE-LOOKUP): reverse-image search via
      // SauceNAO — image → source URL + artist (inverse of `danbooru`). Gated on
      // saucenao.enabled; shares the process-wide per-account quota limiter.
      ...(config.saucenao?.enabled === true && sauceNaoRateLimiter
        ? [createFindSourceTool({
            workspaceRoot,
            fetchClient,
            // Same shared per-model base64 cap + conditioning pipeline as
            // read_image / danbooru preview, for the view-thumbnail path.
            inlineImageMaxBytes: resolveReadImageMaxBytes(config),
            inferenceImageOptions,
            modelHasVision: config.models.default.multimodal,
            rateLimiter: sauceNaoRateLimiter,
            maxWaitMs: config.saucenao.rate_limit?.max_wait_ms,
            httpProxyUrl: config.network?.http_proxy_url,
            config: config.saucenao,
          })]
        : []),
      // x_search (spec/X-SEARCH.md): Grok-as-subagent X.com search, grounded by
      // miku's own FxTwitter hydration + inline captioning. The Grok call goes to
      // OpenRouter — a different provider lane than the agent loop — so it is NOT
      // admitted through llmScheduler (§8); only the inline captions ride the
      // caption client's own scheduler. Gated on x_search.enabled (default true).
      ...(config.x_search && (config.x_search.enabled ?? true)
        ? [createXSearchTool({
            config: config.x_search,
            workspaceRoot,
            fxTwitterClient,
            statusHosts: fxTwitterConfig.statusHosts,
            // Reuse the image caption model — the exact `media`-tool path (§5).
            imageCaptionClient: captionClients.get("image"),
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
    const material = await loadResumeMaterial(row, { media: storage, workspaceRoot, logger });
    if (!material) return { outcome: "unresumable", error: "no resumable snapshot/transcript" };
    const target = inbound.outboundTarget;
    if (!target) return { outcome: "unresumable", error: "no outbound target" };

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
    const tools = buildSessionTools(inbound, record.id, target, record.sessionType, usage, row.resume_generation);
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
          proactive:
            record.sessionType === (config.proactive?.session_type ?? "proactive") ? true : undefined,
          abortSignal: drainAbort.signal,
          usage,
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
    // the soft-warn watcher, rather than resolving it twice.
    const costCeiling = factory.resolveSessionCostCeiling(record.sessionType);
    const captureHandle = attachSessionCapture(agent, {
      storage,
      sessionId: record.id,
      snapshot,
      tokenEstimate,
      usage,
      timelineKey: record.timelineKey,
      sessionType: record.sessionType,
      model: factory.resolveModelId(record.sessionType),
      maxSessionCostUsd: costCeiling,
      logger,
    });
    // Soft cost-budget interjection (spec SESSION-COST-LIMITS §2.1); the combined
    // spend is seeded from the row above, so a resumed session warns/blocks from
    // where it left off. Torn down with the capture handle in the finally.
    const costWarnUnsub = wireCostBudgetWarner(record.id, record.sessionType, usage, costCeiling);
    const runner = new SessionRunner({
      provider,
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
    loadMaterial: (row) => loadResumeMaterial(row, { media: storage, workspaceRoot, logger }),
    hasLiveSession: (id) => sessions.get(id) !== undefined,
    adopt: (record) => sessions.adopt(record),
    tryAcquireTimelineSlot: (timelineKey) => triggerCoordinator.tryAcquire(timelineKey),
    // Mirror launchSession's `.finally`: release the slot AND drain the next
    // queued trigger (issue #17), via the shared helper so the drained trigger's
    // claim is released on a pre-attribution launch failure too (review #1). During
    // drain the coordinator is cleared by stop(), so the helper skips — same as
    // launchSession does.
    releaseTimelineSlot: (timelineKey) => drainNextQueuedTrigger(timelineKey),
    selfUserIdForAccount: (accountId) => config.matrix.accounts[accountId]?.user_id,
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
    void provider.send(target, { body: phrase, agentSessionId: sessionId }).catch((error) => {
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
   * DM vs group from the timeline key (`matrix:<acct>:dm:<room>` → dm). Reused by
   * the provider's `resolveReplyTrigger` callback (reply-as-trigger, §5) and the
   * resume fork; reply triggers themselves are now classified upstream in the
   * provider's trigger hold, not synthesized here.
   */
  function resumeContextFor(timelineKey: string): "dm" | "group" {
    return timelineKey.split(":")[2] === "dm" ? "dm" : "group";
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
    const ctx = resumeContextFor(inbound.timelineKey);
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
        resolveCeiling: (sessionType) => factory.resolveSessionContextCeiling(sessionType),
        loadMaterial: (row) => loadCompletedSessionMaterial(row, { media: storage, workspaceRoot, logger }),
        logger,
      });
      if (!verdict.resume) return false;
      const { row, material } = verdict;

      // All gates pass → ACCEPT. Single-consumption CAS (§6): completed → resuming,
      // bump generation. A racing reply that already consumed this state gets
      // `undefined` here → FRESH.
      const generation = await storage.acceptResumeGeneration(sessionId);
      if (generation === undefined) return false;
      // Past the CAS we own the trigger's timeline slot (return true → no FRESH
      // launch). `runReplyResumeSession` wires the run's `.finally` slot-drain, but
      // a throw in its pre-run setup (adopt/markRunning/tool build) would settle
      // before that — so guard it: evict any adopted record and drain the slot so
      // the timeline can't deadlock. The orphaned generation bump is harmless
      // (the row is no longer `completed` → future replies fork FRESH, §6).
      try {
        await runReplyResumeSession({ inbound, duplicate, target, targetEvent, row, material, generation, ctx, resumeCfg });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (sessions.get(sessionId)) sessions.markDiscarded(sessionId, { error: message });
        logger.error("session_resume_setup_threw", { sessionId, timelineKey: inbound.timelineKey, error: message });
        drainNextQueuedTrigger(inbound.timelineKey);
      }
      return true;
    } finally {
      resumeClaims.delete(sessionId);
    }
  }

  /**
   * Adopt the accepted session and run the resumed rollout (spec §7/§9/§11). Mirrors
   * the fresh run's lifecycle tail (claim attribution, capture, run/settle, slot
   * drain, browser close) — the only differences are: the row is ADOPTED (not
   * created), the usage seed and generation come from the bumped row, the snapshot
   * is reused (capture re-persists only the growing transcript), and the kickoff is
   * the freshly-built appended turn (gap + fresh satellite + trigger group).
   */
  async function runReplyResumeSession(args: {
    inbound: InboundChatEvent;
    duplicate: boolean;
    target: NonNullable<InboundChatEvent["outboundTarget"]>;
    targetEvent: CanonicalChatEvent;
    row: ReturnType<typeof storage.getAgentSession> & object;
    material: NonNullable<Awaited<ReturnType<typeof loadCompletedSessionMaterial>>>;
    generation: number;
    ctx: "dm" | "group";
    resumeCfg: NonNullable<NonNullable<typeof config.agent.sessions.resume>>;
  }): Promise<void> {
    const { inbound, duplicate, target, targetEvent, row, material, generation, ctx, resumeCfg } = args;
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
    sessions.onSettle(record.id, () => sessionClaims.releaseSession(record.timelineKey, record.id));
    const ownerExternalId = inbound.event.externalId;
    if (ownerExternalId) {
      sessions.onSettle(record.id, () => redispatchPendingCoReplies(ownerExternalId));
    }
    logger.info("session_resume_started", {
      sessionId: record.id,
      timelineKey: record.timelineKey,
      generation,
      context: ctx,
    });

    // Usage continues accumulating from the row (continue-mode seed).
    const usage = new SessionUsageTracker(
      resumeUsageSeed(row, "continue"),
      selectToolCostSeed("continue", () => storage.getSessionToolUsage(record.id).cost),
    );
    const tools = buildSessionTools(inbound, record.id, target, record.sessionType, usage, generation);

    // Gap backfill (§9): active only when BOTH limits are non-zero (0 = include none).
    const gapCfg = resumeCfg.gap?.[ctx];
    const gapActive =
      !!gapCfg && (gapCfg.max_messages ?? 0) !== 0 && (gapCfg.max_tokens ?? 0) !== 0;
    const gap = gapActive
      ? {
          maxMessages: gapCfg!.max_messages ?? 0,
          maxTokens: gapCfg!.max_tokens ?? 0,
          // Lower bound = the trigger group's latest member the session ALREADY
          // covers (spec §9.2): its persisted `chat_upper_bound_ts` — its original
          // trigger on creation, advanced to each accepted resume's trigger below.
          // NULL only on a legacy (pre-v27) row's first resume → a one-time bounded
          // fallback to the replied-to message's timestamp (the old behaviour for
          // that single edge). Read from the in-memory `row` (read-old), before the
          // write-new below — no race despite the queued write.
          lowerBoundTimestamp: row.chat_upper_bound_ts ?? targetEvent.timestamp,
        }
      : undefined;

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
      // Readiness wait (spec CLAIM-VISIBILITY-SERIALIZATION §4.1/§4.2): the resumed
      // session is already visible-as-running (`adopt`/`markRunning` above) and its
      // claim attributed, so wait for the reply trigger's enrichment + caption
      // readiness HERE — a reply that itself carries fresh media gets its appended
      // turn built with the caption ready, instead of skipping the wait as before.
      await awaitTriggerReadiness(inbound);
      ({ agent, finalTurn: kickoff } = await factory.create(record, tools, {
        resume: material,
        resumeContinuation: {
          tail: resumeCfg.satellite?.tail ?? true,
          browserNote: browserSession ? RESUME_BROWSER_NOTE : undefined,
          gap,
        },
        usage,
        abortSignal: drainAbort.signal,
      }));
      if (!kickoff) throw new Error("resume continuation produced no appended turn");
    } catch (error) {
      const buildTimeout = error instanceof Error && error.name === "BuildWaitTimeoutError";
      sessions.markDiscarded(record.id, {
        error: error instanceof Error ? error.message : String(error),
      });
      logger.error(buildTimeout ? "session_resume_build_wait_timeout" : "session_resume_factory_failed", {
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

    const costCeiling = factory.resolveSessionCostCeiling(record.sessionType);
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
      model: factory.resolveModelId(record.sessionType),
      maxSessionCostUsd: costCeiling,
      logger,
    });
    const costWarnUnsub = wireCostBudgetWarner(record.id, record.sessionType, usage, costCeiling);
    const runner = new SessionRunner({ provider, target, suppressTyping: false });
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
        if (browserSession) {
          void browserSession.closeSession(record.id).catch((error) => {
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
    const session = sessions.createPlaceholder(inbound, sessionType, factory.resolveModelId(sessionType));
    sessions.markRunning(session.id);
    // Attribute the claim added at accept time to this session and release it when
    // the run settles (spec DUPLICATE-REPLY-MITIGATION §3.3). Registered before the
    // outbound-target check below so even the immediate-discard paths fire the
    // release on evict. Proactive/synthetic triggers have no external id → no claim,
    // and `releaseSession` is a no-op for a session that never claimed.
    if (inbound.event.externalId) {
      sessionClaims.attachSession(session.timelineKey, inbound.event.externalId, session.id);
    }
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
    // Period cost limits — triggered/proactive admission gate (spec
    // USAGE-COST-LIMITS §6.3 / §2.1). Refuse to spawn when the session's own
    // covering rules are over budget OR a class it structurally depends on
    // (summarization) is blocked. A human trigger gets an immediate, informative
    // refusal (the optional templated reply); proactive is silent (the scheduler
    // already clamps its cadence). Not queued — an hours-late autonomous reply is
    // worse than a clear "back at X". Reuses the discard/drain plumbing above.
    if (budgetHooks.engine) {
      let admissionModelId: string | undefined;
      try {
        admissionModelId = factory.resolveModelId(session.sessionType);
      } catch {
        admissionModelId = undefined;
      }
      // Exception-isolated, fail-open admission decision (review #7): a throw inside
      // the engine call would unwind to the dispatch `catch` (releaseClaimFor +
      // rethrow, but NOT `triggerCoordinator.complete`), leaking the per-timeline
      // slot. `safeCheckAdmission` returns undefined on a throw → we fall through to
      // a normal launch (admit), so a budget-engine bug never stops the bot replying.
      const admission = admissionModelId
        ? safeCheckAdmission(budgetHooks.engine, session.sessionType, admissionModelId, logger, {
            sessionId: session.id,
            timelineKey: session.timelineKey,
          })
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
              void provider.send(target, { body, agentSessionId: session.id }).catch((error) => {
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
    const tools = buildSessionTools(inbound, session.id, target, session.sessionType, usage);
    let agent;
    let kickoff;
    let snapshot: ContextMessage[] | undefined;
    let tokenEstimate: number | undefined;
    try {
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
      logger.error(buildTimeout ? "session_build_wait_timeout" : "session_factory_failed", {
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

    // Attach snapshot + transcript capture (spec §5). Detached in the run
    // promise's .finally() below (the agent_end transcript flush already happens
    // during the run; detach only unsubscribes). Only reached on the success
    // path — the kickoff-missing / factory-failed early returns above never get
    // here.
    // Resolve the cost ceiling ONCE per run (spec SESSION-COST-LIMITS §3/§6) and
    // share it between the settle log (self-contained spend-vs-ceiling line) and
    // the soft-warn watcher, rather than resolving it twice.
    const costCeiling = factory.resolveSessionCostCeiling(session.sessionType);
    const captureHandle = attachSessionCapture(agent, {
      storage,
      sessionId: session.id,
      snapshot,
      tokenEstimate,
      usage,
      timelineKey: session.timelineKey,
      sessionType: session.sessionType,
      model: factory.resolveModelId(session.sessionType),
      maxSessionCostUsd: costCeiling,
      logger,
    });
    // Soft cost-budget interjection (spec SESSION-COST-LIMITS §2.1); torn down in
    // the run's .finally alongside the capture handle.
    const costWarnUnsub = wireCostBudgetWarner(session.id, session.sessionType, usage, costCeiling);
    const runner = new SessionRunner({ provider, target, suppressTyping: proactive });

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
        if (browserSession) {
          void browserSession.closeSession(session.id).catch((error) => {
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
    budgetDeferUntil: () => {
      const engine = budgetHooks.engine;
      if (!engine) return undefined;
      return safeProactiveDeferUntil(
        engine,
        config.proactive?.session_type ?? "proactive",
        (sessionType) => factory.resolveModelId(sessionType),
        logger,
      );
    },
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
  void gapBackfetchRun.then(() => {
    if (!draining) messageBackfetch.resumeAll();
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
      llmRequestRing,
      workspaceRoot,
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
        // Stop the console first: it stops accepting requests and tears down any
        // open SSE streams before the live state it reads begins shutting down.
        if (consoleServer) await consoleServer.stop();
        if (retentionTimer) clearInterval(retentionTimer);
        await redecryptionSweeper.stop();
        await provider.stop();
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
        // Abort each caption client's scheduler-admission seam BEFORE awaiting
        // the pool's in-flight workers (#6). `captionPool.stop()` awaits
        // in-flight caption work, and a caption call queued behind a half-open
        // probe during a caption-model outage would otherwise block until the
        // far-later `llmScheduler.stop()` rejects it (~N×llm_probe_interval_ms
        // stall). Stopping the clients first rejects those queued waiters now.
        for (const client of captionClients.values()) client.stop();
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
type AdmissionEngine = Pick<BudgetEngine, "checkAdmission" | "accurateResetsAt">;

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
): AdmissionResult | undefined {
  try {
    return engine.checkAdmission(sessionType, modelId);
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
): number | undefined {
  let modelId: string | undefined;
  try {
    modelId = resolveModelId(proactiveType);
  } catch {
    return undefined;
  }
  if (modelId === undefined) return undefined;
  try {
    const admission = engine.checkAdmission(proactiveType, modelId);
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
  resolveCeiling: (sessionType: string) => number | undefined;
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
      ceiling = args.resolveCeiling(row.session_type);
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

function resolveReadImageMaxBytes(config: AppConfig): number {
  const DEFAULT_PER_MODEL = 5_242_880; // 5 MB base64 (≈ 3.75 MB raw before encoding).
  const perModel = config.models.default.image_input_bytes ?? DEFAULT_PER_MODEL;
  const candidates = [
    perModel,
    config.media?.download_size_limit,
  ].filter((v): v is number => typeof v === "number");
  return Math.min(...candidates);
}
