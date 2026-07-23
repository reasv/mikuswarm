/**
 * Context-overhead measurement harness.
 *
 * Answers: "Why is the actual first-request input_tokens ~10k higher than our
 * BuiltContext.tokenEstimate?" Our estimate (src/context/builder.ts) only sums
 * the *message* token estimates. The wire request also carries the system prompt
 * AND the full tool-definition block (name + description + JSON schema for every
 * tool) plus the provider chat-template scaffolding — none of which the estimate
 * counts.
 *
 * Two independent measurements that cross-check each other:
 *
 *   OFFLINE (no network): reconstruct the live tool set, serialize each tool to
 *   its OpenAI-completions wire form, and GLM-tokenize it → a per-tool token
 *   breakdown + total tool-block cost. This is the "way to measure" that needs no
 *   API call and can run in CI.
 *
 *   LIVE (--live): issue bare `completeSimple` requests against the real model and
 *   read back `usage.input`, isolating each contributor by differencing:
 *     - baseline  : tiny user msg, no system, no tools   → chat-template floor
 *     - +system   : + the rendered system prompt                  (system cost)
 *     - +tools    : + the full tool block                          (tool cost)
 *   The `onPayload` hook captures the EXACT wire body the provider sends, so the
 *   offline per-tool GLM counts are taken from the authoritative serialization,
 *   not a guess at the wire format.
 *
 * Run:
 *   npx tsx test/measure-context-overhead.ts            # offline only
 *   npx tsx test/measure-context-overhead.ts --live     # + real API calls
 *
 * Not a unit test (excluded from the *.test.ts runner glob).
 */
import { completeSimple, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadConfig } from "../src/config/loader.js";
import { createModelFromConfig } from "../src/agent/factory.js";
import { GlmTokenizer } from "../src/context/tokenizer/glm.js";
import * as T from "../src/tools/index.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const configDir = arg("config") ?? "./config";
const glmPath = arg("glm") ?? "native/assets/glm-5.1/tokenizer.json";
const live = hasFlag("live");

// ── Universal runtime stub ───────────────────────────────────────────────────
// Tool factories close over their runtime deps (matrix client, storage, indexer,
// sandbox, fetch client, …) and only touch them inside `execute`. Tool NAME /
// DESCRIPTION / PARAMETERS — the only things that hit the wire — are static
// literals or derived from *config*, which we pass for real. So a chainable
// callable proxy satisfies construction while leaving the wire shape identical to
// production. (A handful of factories read config at construction and throw on a
// bad shape; those get the real config section below.)
const STUB: any = new Proxy(function () {}, {
  get(_t, p) {
    if (p === "then") return undefined; // not a thenable
    if (typeof p === "symbol") return undefined;
    return STUB;
  },
  apply() {
    return STUB;
  },
  construct() {
    return STUB;
  },
});

const WS = "/tmp/miku-overhead-ws";
const ROOM = "!room:example.org";

/**
 * Reconstruct the live tool set (src/app.ts `buildSessionTools`) with real config
 * + stubbed runtime deps. Each factory is attempted independently; failures are
 * reported, never fatal, so we always get a near-complete picture.
 */
function reconstructTools(config: any): { tools: AgentTool[]; skipped: string[] } {
  const tools: AgentTool[] = [];
  const skipped: string[] = [];
  const multimodal = config.models.default.input_modalities?.includes("image") ?? false;

  // [label, factory-thunk] — thunk throws are caught and recorded.
  const specs: Array<[string, () => AgentTool | AgentTool[]]> = [
    ["send_message", () => T.createSendMessageTool({ provider: STUB, target: STUB, timeline: STUB, agentSessionId: "s", workspaceRoot: WS, mediaMaxBytes: 10_000_000, isClaimedByOther: () => undefined } as any)],
    ["delegate_to_session", () => T.createDelegateToSessionTool({ currentEvent: STUB, steerSession: () => true } as any)],
    ["spawn_session", () => T.createSpawnSessionTool({ spawnCoReply: () => STUB } as any)],
    // room-gated cohort
    ["emoji_list", () => T.createEmojiListTool({ client: STUB, roomId: ROOM } as any)],
    ["react", () => T.createReactTool({ client: STUB, roomId: ROOM } as any)],
    ["edit_message", () => T.createEditMessageTool({ client: STUB, roomId: ROOM } as any)],
    ["delete_message", () => T.createDeleteMessageTool({ client: STUB, roomId: ROOM } as any)],
    ["pins", () => T.createPinsTool({ client: STUB, roomId: ROOM } as any)],
    ["list_reactions", () => T.createListReactionsTool({ client: STUB, roomId: ROOM } as any)],
    ["read_messages", () => T.createReadMessagesTool({ client: STUB, roomId: ROOM } as any)],
    ["member_info", () => T.createMemberInfoTool({ client: STUB, roomId: ROOM } as any)],
    ["channel_info", () => T.createChannelInfoTool({ client: STUB, roomId: ROOM } as any)],
    ["create_poll", () => T.createCreatePollTool({ client: STUB, roomId: ROOM } as any)],
    ["poll_vote", () => T.createPollVoteTool({ client: STUB, roomId: ROOM } as any)],
    // DB-backed search/recap
    ["search_messages", () => T.createSearchMessagesTool({ storage: STUB, indexer: STUB, currentTimelineKey: "tk", absenceDefaults: { gapThresholdMs: 3_600_000, defaultLookbackMs: 86_400_000 } } as any)],
    ["expand_summary", () => T.createExpandSummaryTool({ storage: STUB, defaults: { expandTokenCap: 4000 } } as any)],
    ["recap", () => T.createRecapTool({ storage: STUB, indexer: STUB, currentTimelineKey: "tk", askerId: "@u:x", defaults: { budgetTokens: 6000, gapThresholdMs: 3_600_000, defaultLookbackMs: 86_400_000 } } as any)],
    ["user_activity", () => T.createUserActivityTool({ storage: STUB, indexer: STUB, currentTimelineKey: "tk", roomMembers: async () => [] } as any)],
    ["set_profile", () => T.createSetProfileTool({ client: STUB, workspaceRoot: WS } as any)],
    ["web_fetch", () => T.createWebFetchTool()],
    ["web_search", () => T.createWebSearchTool()],
    ["text_editor", () => T.createTextEditorTool({ workspaceRoot: WS, contextWindowTokens: config.models.default.context_window ?? 128000 } as any)],
    ["search_files", () => T.createSearchFilesTool({ workspaceRoot: WS, sandbox: STUB } as any)],
    ["bash", () => T.createBashTool({ sandbox: STUB, defaultTimeoutMs: 30000 } as any)],
    ["media", () => T.createMediaTool({ workspaceRoot: WS, clients: new Map(), defaultPrompts: {}, modelHasVision: multimodal, maxFetchBytes: 10_000_000, fetchClient: STUB } as any)],
    ["search_memory", () => T.createSearchMemoryTool({ workspaceRoot: WS } as any)],
    ["write_memory", () => T.createWriteMemoryTool({ workspaceRoot: WS, memoryWriter: STUB } as any)],
    ["user_profile_read", () => T.createUserProfileReadTool({ workspaceRoot: WS, provider: "matrix", senderId: "@u:x", senderDisplayName: "u", config: config.user_profiles } as any)],
    ["user_profile_edit", () => T.createUserProfileEditTool({ workspaceRoot: WS, provider: "matrix", senderId: "@u:x", senderDisplayName: "u", config: config.user_profiles } as any)],
  ];

  if (multimodal) {
    specs.push(["read_image", () => T.createReadImageTool({ workspaceRoot: WS, maxImageBytes: 5_000_000 } as any)]);
  }
  if (config.retrieval) {
    specs.push(["recall_memory", () => T.createRecallMemoryTool({ search: STUB, defaults: { maxResults: 8, minScore: 0.3 } } as any)]);
  }
  if (config.browser) {
    specs.push(["browser", () => T.createBrowserTool({ session: STUB, agentSessionId: "s", config: config.browser, maxImageBytes: 5_000_000, workspaceRoot: WS } as any)]);
  }
  if (config.danbooru) {
    specs.push(["danbooru", () => T.createDanbooruTool({ workspaceRoot: WS, downloadSizeLimit: 10_000_000, inlineImageMaxBytes: 5_000_000, inferenceImageOptions: {}, modelHasVision: multimodal, imageCaptionClient: STUB, fetchClient: STUB, httpProxyUrl: config.network?.http_proxy_url, config: config.danbooru } as any)]);
  }
  if (config.image_gen) {
    specs.push(["image_generate", () => T.createImageGenTool({ workspaceRoot: WS, fetchClient: STUB, downloadSizeLimit: 10_000_000, inlineImageMaxBytes: 5_000_000, inferenceImageOptions: {}, httpProxyUrl: config.network?.http_proxy_url, scheduler: STUB, maxWaitMs: 120000, agentSessionId: "s", recordToolUsage: () => {}, checkBudget: () => undefined, costRates: { pro: {}, flash: {} }, config: config.image_gen } as any)]);
  }
  if (config.x_search && (config.x_search.enabled ?? true)) {
    specs.push(["x_search", () => T.createXSearchTool({ config: config.x_search, workspaceRoot: WS, fxTwitterClient: STUB, statusHosts: [], imageCaptionClient: STUB, fetchClient: STUB, downloadSizeLimit: 10_000_000, httpProxyUrl: config.network?.http_proxy_url, cache: STUB, agentSessionId: "s", recordToolUsage: () => {}, checkBudget: () => undefined } as any)]);
  }
  if (config.saucenao?.enabled === true) {
    specs.push(["find_source", () => T.createFindSourceTool({ workspaceRoot: WS, fetchClient: STUB, inlineImageMaxBytes: 5_000_000, inferenceImageOptions: {}, modelHasVision: multimodal, rateLimiter: STUB, maxWaitMs: 30000, httpProxyUrl: config.network?.http_proxy_url, config: config.saucenao } as any)]);
  }
  if (config.character_card) {
    specs.push(["character_card_create", () => T.createCharacterCardCreateTool({ workspaceRoot: WS, fetchClient: STUB, downloadSizeLimit: 10_000_000, config: config.character_card } as any)]);
    specs.push(["character_card_read", () => T.createCharacterCardReadTool({ workspaceRoot: WS, fetchClient: STUB, downloadSizeLimit: 10_000_000, config: config.character_card } as any)]);
    specs.push(["character_card_edit", () => T.createCharacterCardEditTool({ workspaceRoot: WS, fetchClient: STUB, downloadSizeLimit: 10_000_000, config: config.character_card } as any)]);
  }
  // x_fetch (fxtwitter) — config shape is computed in app.ts; best-effort.
  if (config.fxtwitter) {
    specs.push(["x_fetch", () => T.createXFetchTool({ workspaceRoot: WS, fetchClient: STUB, client: STUB, maxImageBytes: 5_000_000, inferenceImageOptions: {}, config: config.fxtwitter, statusHosts: [] } as any)]);
  }

  for (const [label, thunk] of specs) {
    try {
      const built = thunk();
      for (const t of Array.isArray(built) ? built : [built]) tools.push(t);
    } catch (e) {
      skipped.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { tools, skipped };
}

// OpenAI-completions wire form of a tool (what pi-ai serializes into the request).
function toWireTool(t: AgentTool): unknown {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

async function main() {
  const config = (await loadConfig(configDir)) as any;
  const glm = GlmTokenizer.fromFile(glmPath);
  const count = (s: string) => glm.count(s);

  const { tools, skipped } = reconstructTools(config);

  // ── Offline per-tool breakdown ────────────────────────────────────────────
  const rows = tools
    .map((t) => {
      const wire = JSON.stringify(toWireTool(t));
      return { name: t.name, tokens: count(wire), bytes: wire.length };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const toolsTotal = rows.reduce((s, r) => s + r.tokens, 0);
  const wholeBlock = count(JSON.stringify(tools.map(toWireTool)));

  console.log(`\n=== Context overhead measurement ===`);
  console.log(`config=${configDir}  model=${config.models.default.id}  tokenizer=GLM(${glmPath})`);
  console.log(`tools reconstructed: ${tools.length}${skipped.length ? `  (skipped ${skipped.length})` : ""}\n`);
  if (skipped.length) {
    console.log("skipped (excluded from totals):");
    for (const s of skipped) console.log(`  - ${s}`);
    console.log();
  }

  console.log("Per-tool wire cost (GLM tokens), descending:");
  console.log("  tokens   name");
  console.log("  " + "-".repeat(40));
  for (const r of rows) console.log(`  ${String(r.tokens).padStart(6)}   ${r.name}`);
  console.log("  " + "-".repeat(40));
  console.log(`  ${String(toolsTotal).padStart(6)}   Σ per-tool sum`);
  console.log(`  ${String(wholeBlock).padStart(6)}   Σ whole tools[] array (single JSON, ~wire)\n`);

  if (!live) {
    console.log("(offline) Run with --live to confirm against real input_tokens.\n");
    console.log(`OFFLINE ESTIMATE OF TOOL-BLOCK OVERHEAD: ~${wholeBlock} GLM tokens`);
    return;
  }

  // ── Live differential measurement ─────────────────────────────────────────
  const mc = config.models.default;
  const baseModel = createModelFromConfig(mc) as Model<Api>;
  // Cap output so each probe is cheap; input_tokens (what we measure) is unaffected.
  const model: Model<Api> = { ...baseModel, maxTokens: 64 };
  const apiKey = mc.api_key as string;

  const captured: { tools?: unknown[] } = {};
  async function probe(label: string, ctx: { systemPrompt?: string; tools?: AgentTool[] }, capture = false): Promise<number> {
    const onPayload = capture
      ? (payload: any) => {
          captured.tools = payload?.tools;
          return undefined;
        }
      : undefined;
    const msg: AssistantMessage = await completeSimple(
      model,
      { systemPrompt: ctx.systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: ctx.tools },
      { apiKey, reasoning: "off", onPayload } as any,
    );
    const input = msg.usage.input;
    console.log(`  ${label.padEnd(28)} input_tokens=${input}`);
    return input;
  }

  // A representative small system prompt to isolate the system-prompt contribution
  // from the chat-template floor. (The live persona prompt is huge; this measures
  // the per-token system cost, which is ~1:1.)
  const sampleSystem = "You are a helpful assistant. Be concise.";
  const sysTokens = count(sampleSystem);

  console.log("Live probes (GLM via configured endpoint):");
  const base = await probe("baseline (hi, no sys/tools)", {});
  const withSys = await probe("+ system prompt", { systemPrompt: sampleSystem });
  const withTools = await probe("+ all tools (no system)", { tools }, true);
  console.log();

  const hi = count("hi");
  console.log("Decomposition (input_tokens deltas):");
  console.log(`  chat-template floor (incl. 'hi'=${hi})   = ${base}`);
  console.log(`  system-prompt cost   (sample ${sysTokens} GLM tok) = ${withSys - base}  (≈1:1 with content)`);
  console.log(`  TOOL-BLOCK cost      (the big one)        = ${withTools - base}`);
  console.log();

  if (captured.tools) {
    const wireFromProvider = count(JSON.stringify(captured.tools));
    console.log("Cross-check — GLM-count of the EXACT wire tools[] the provider sent:");
    console.log(`  provider-serialized tools[] = ${wireFromProvider} GLM tokens`);
    console.log(`  measured tool delta (live)  = ${withTools - base} input_tokens`);
    console.log(`  offline reconstructed total = ${wholeBlock} GLM tokens`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
