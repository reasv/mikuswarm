/**
 * Calibrate a judged check's threshold against model labels (spec
 * REFUSAL-HANDLING §15.1). The operator never reads a message: the tool samples
 * outputs from a database, has a labeller chat model label each one (a label and
 * a reason from fixed enums, through a forced tool call), records the decision
 * member's probability for the same item, and prints only item ids, labels,
 * reasons, probabilities and aggregates (src/audit/calibration.ts).
 *
 * Usage:
 *   npx tsx scripts/calibrate-checks.ts --db <path> --labeller <models key> --check <code> [options]
 *   npx tsx scripts/calibrate-checks.ts --db <path> --labeller <models key> --any-refusal [options]
 *   npx tsx scripts/calibrate-checks.ts --db <path> --labeller <models key> --point memory [options]
 *   npx tsx scripts/calibrate-checks.ts --db <path> --labeller <models key> --point memory --recall-ceiling [options]
 *
 * `--any-refusal` measures "is this output a refusal of any kind", the decision
 * that acts in production: the score is the highest probability among every
 * enabled refusal check's questions over the judged sources (send: message;
 * ending: analysis, text, thinking), asked in one call. Items are sampled by
 * score band from the scores already recorded in the database (live gate and
 * offline audit check rows; outputs without one are excluded and counted),
 * labelled against a generic refusal definition, and precision, recall and F1
 * are estimated for the whole population with inverse-sampling weights
 * (band population / usable items sampled from the band).
 *
 * Options:
 *   --config <dir>          config directory (default ./config); its .env is loaded over the shell's
 *   --env <file>            the .env file (default ./.env)
 *   --member <models key>   decision member to score with (default: the head of [decisions.checks].model,
 *                           else [decisions].model); only this member is called, never its fallbacks
 *   --checkpoint send|ending  (default send)
 *   --source <source>       which question of the check (default: message at send, text at ending)
 *   --question <name>       a named question of the check (e.g. the duplicate check's `repeats`);
 *                           required for a check with several questions over one source
 *   --agent <name>          use this agent's catalogue overrides of the check
 *   --sample <n>            items to label (default 200)
 *   --fired-only            only outputs the check already fired on (precision at the threshold)
 *   --seed <n>              sampling seed (default 1)
 *   --since <YYYY-MM-DD>    only sessions created since this date
 *   --thresholds a,b,...    candidate thresholds (default 0.05 … 0.95)
 *   --target-precision <p>  for the suggested threshold (default 0.9)
 *   --concurrency <n>       parallel items (default 2)
 *   --json                  print the report as JSON
 *
 * The duplicate-send check (`--check duplicate`, or any check of kind duplicate, at send): items are
 * rebuilt from history (src/audit/duplicate-calibration.ts): each posting call whose target timeline
 * holds messages of the same agent's other sessions that the session had not seen, the newest within
 * --window-ms of the draft (default 60000), judged over the live gate's `{ earlier, draft }` state.
 * The member defaults to the duplicate chain's head ([decisions.checks.duplicate].model, else
 * [decisions].model).
 *
 * --any-refusal options (instead of --check, --sample, --fired-only):
 *   --per-band <n>          items sampled per score band (default 25; all of a band if fewer)
 *   --bands a,b,...         band lower edges, starting at 0 (default 0,0.1,0.3,0.5,0.65,0.8)
 *   --source <source>       judge only this source (default: message at send; analysis, text, thinking at ending)
 *   --checkpoint, --agent, --member, --seed, --since, --thresholds, --target-precision,
 *   --concurrency, --json   as above
 *
 * `--point memory` calibrates `[decisions.memory].relevance_threshold` per member
 * (src/audit/memory-calibration.ts). Items are the memory decision rows that carry
 * a passage state (filter-only rows, whose state holds an `entry`, are skipped and
 * counted): the stored state is exactly what the member was sent. The labeller
 * labels whether the passage would help respond in that conversation (reasons
 * answers_request, same_people_history, same_topic_history, unrelated, too_vague,
 * unsure); the member scores the point's questions over the same state in one
 * request. The report has the threshold table, histograms, suggested thresholds and
 * the key to set: `[decisions.calibration.<member>] "memory.relevance_threshold"`.
 *   --member <models key>   default: [decisions.memory].model, else [decisions].model
 *   --sample <n>            rows to label (default 200)
 *   --agent <name>          only this agent's rows (and its [decisions] overrides)
 *   --since, --seed, --thresholds, --target-precision, --concurrency, --json   as above
 *
 * `--point memory --recall-ceiling` measures the recall ceiling (labels only; no
 * member is called): it samples retrieval builds (`memory_retrievals` rows) that
 * list a recall set and whose decision group holds a memory row with a state (the
 * build's conversation and request), labels every item of the recall set whatever
 * its stage (the block text from `memory_chunks` by content hash; items whose text
 * is gone are skipped and counted), and reports the share of builds with a
 * labelled-relevant item anywhere in the recall set, among the items the judge
 * scored, and among the kept items, with label counts per stage.
 *   --sample <n>            builds to label (default 20)
 *   --per-build <n>         items labelled per build (default 60; judged and kept items first)
 *   --agent, --since, --seed, --concurrency, --json   as above
 *
 * Safety:
 * - The database is opened read-only (`query_only`); run it on a copy if you prefer.
 * - The tool refuses to start when the environment sets endpoint or proxy
 *   overrides (e.g. a provider *_BASE_URL or HTTPS_PROXY), and every request is
 *   checked against the labeller's and the member's configured endpoints (the
 *   labeller's only, for the recall ceiling).
 * - The labeller must be a chat model whose data policy already covers chat
 *   content. It is instructed never to reproduce content, and its answer is
 *   reduced to enums before anything is printed.
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CHECK_SOURCES, type CheckSource } from "../src/checks/types.js";
import { loadConfig } from "../src/config/index.js";
import { ChannelVisibilityResolver, type VisibilityConfig } from "../src/visibility/index.js";
import { createModelFromConfig } from "../src/agent/factory.js";
import { DecisionClient } from "../src/decisions/client.js";
import { decisionsFor, duplicateKnobs, isDecisionModel, memoryPointKnobs } from "../src/decisions/config.js";
import { DEFAULT_DUPLICATE_WINDOW_MS, sampleDuplicateItems } from "../src/audit/duplicate-calibration.js";
import {
  assertNoEndpointOverrides,
  createDecisionScorer,
  formatReport,
  guardFetch,
  openReadOnly,
  reportJson,
  requireGuardedTransport,
  runCalibration,
  type GuardedFetch,
  type Labeller,
} from "../src/audit/calibration.js";
import {
  createMemoryScorer,
  DEFAULT_RECALL_PER_BUILD,
  formatMemoryReport,
  formatRecallCeilingReport,
  MEMORY_CALIBRATION_KEY,
  runMemoryCalibration,
  runRecallCeiling,
} from "../src/audit/memory-calibration.js";
import {
  ANY_REFUSAL_SOURCES,
  createAnyRefusalScorer,
  formatAnyRefusalReport,
  normalizeBands,
  runAnyRefusalCalibration,
} from "../src/audit/any-refusal-calibration.js";

function fail(message: string): never {
  process.stderr.write(`calibrate-checks: ${message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const switches = new Set<string>();
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
  const name = arg.slice(2);
  if (name === "json" || name === "fired-only" || name === "any-refusal" || name === "recall-ceiling") switches.add(name);
  else {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
    flags.set(name, value);
    i++;
  }
}
const required = (name: string) => flags.get(name) ?? fail(`--${name} is required`);
const num = (name: string, fallback: number) => {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
};

// 1. Endpoint overrides from the invoking shell are refused before anything loads.
try {
  assertNoEndpointOverrides(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const anyRefusal = switches.has("any-refusal");
const pointFlag = flags.get("point");
if (pointFlag !== undefined && pointFlag !== "memory") fail("--point must be memory");
const memoryMode = pointFlag === "memory";
const recallCeiling = switches.has("recall-ceiling");
if (recallCeiling && !memoryMode) fail("--recall-ceiling needs --point memory");
if (memoryMode) {
  if (anyRefusal) fail("--any-refusal does not apply to --point memory");
  if (switches.has("fired-only")) fail("--fired-only does not apply to --point memory");
  for (const name of ["check", "checkpoint", "source", "question", "per-band", "bands", "window-ms"]) {
    if (flags.has(name)) fail(`--${name} does not apply to --point memory`);
  }
  if (!recallCeiling && flags.has("per-build")) fail("--per-build applies only to --recall-ceiling");
  if (recallCeiling) {
    for (const name of ["member", "thresholds", "target-precision"]) {
      if (flags.has(name)) fail(`--${name} does not apply to --recall-ceiling (it labels only)`);
    }
  }
}
if (anyRefusal) {
  for (const name of ["check", "sample"]) if (flags.has(name)) fail(`--${name} does not apply to --any-refusal`);
  if (switches.has("fired-only")) fail("--fired-only does not apply to --any-refusal");
}
const dbPath = required("db");
const labellerKey = required("labeller");
const configDir = flags.get("config") ?? "./config";
const checkpoint = (flags.get("checkpoint") ?? "send") as "send" | "ending";
if (checkpoint !== "send" && checkpoint !== "ending") fail("--checkpoint must be send or ending");

// 2. The configuration (its .env wins over the shell for the keys it defines).
const config = await loadConfig(configDir, { env: { envFile: flags.get("env") ?? ".env", override: true } });
const labellerConfig = config.models[labellerKey] ?? fail(`--labeller ${labellerKey} is not a [models.*] key`);
if (isDecisionModel(labellerConfig)) fail(`--labeller ${labellerKey} is a decision model; it must be a chat model`);
const decisions = decisionsFor(config, flags.get("agent") ?? null);

const host = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return fail(`the configured endpoint of a model is not a URL`);
  }
};

/** The labeller over a guarded fetch (stops the run when a call bypasses the guard). */
function buildLabeller(fetchGuard: GuardedFetch): Labeller {
  const model = createModelFromConfig(labellerConfig);
  let labellerDiagnosed = false;
  return requireGuardedTransport(
    (request) =>
      completeSimple(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
          tools: [request.tool as never],
        },
        // A reasoning model gets low effort (some reject thinking disabled) and room for it.
        labellerConfig.reasoning === false
          ? { apiKey: labellerConfig.api_key, maxTokens: 300 }
          : { apiKey: labellerConfig.api_key, maxTokens: 4000, reasoning: "low" },
      ).then((response) => {
        // Diagnose a response that carries no label without printing any of its text:
        // the stop reason, the API's own error text, and the content block types.
        if (!labellerDiagnosed && !(response.content ?? []).some((b) => b.type === "toolCall")) {
          labellerDiagnosed = true;
          process.stderr.write(
            `labeller: no submit_label call (stopReason ${response.stopReason}; blocks ` +
              `${(response.content ?? []).map((b) => b.type).join(",") || "none"}` +
              `${response.errorMessage ? `; error ${response.errorMessage.slice(0, 200)}` : ""})\n`,
          );
        }
        return response;
      }),
    fetchGuard,
  );
}

const since = flags.get("since");
const sinceMs = since !== undefined ? Date.parse(since) : undefined;
if (sinceMs !== undefined && !Number.isFinite(sinceMs)) fail("--since must be a date (YYYY-MM-DD)");
const thresholds = flags.has("thresholds")
  ? flags.get("thresholds")!.split(",").map((t) => Number(t)).filter((t) => t >= 0 && t <= 1)
  : undefined;
const labellerInfo = { model: labellerKey, host: host(labellerConfig.endpoint) };

if (memoryMode) {
  const agentName = flags.get("agent") ?? null;
  if (recallCeiling) {
    // Labels only: the labeller's endpoint is the only one reachable.
    const fetchGuard = guardFetch([labellerConfig.endpoint]);
    globalThis.fetch = fetchGuard;
    const labeller = buildLabeller(fetchGuard);
    const db = openReadOnly(dbPath);
    try {
      const report = await runRecallCeiling({
        db,
        sample: num("sample", 20),
        seed: num("seed", 1),
        ...(sinceMs !== undefined ? { since: sinceMs } : {}),
        agent: agentName,
        perBuild: num("per-build", DEFAULT_RECALL_PER_BUILD),
        concurrency: num("concurrency", 2),
        labeller,
        labellerInfo,
      });
      process.stdout.write(switches.has("json") ? reportJson(report) : formatRecallCeilingReport(report));
    } catch (error) {
      // Error texts here are the tool's own (guards, configuration, HTTP status): never content.
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      db.close();
    }
    process.exit(0);
  }
  // The memory point's chain head: [decisions.memory].model, else [decisions].model.
  const memberKey = flags.get("member") ?? decisions.memory?.model ?? decisions.model ?? fail("--member is required (no [decisions] model)");
  const memberConfig = config.models[memberKey] ?? fail(`--member ${memberKey} is not a [models.*] key`);
  if (!isDecisionModel(memberConfig)) fail(`--member ${memberKey} must be a system-one decision model`);
  if (memberConfig.decision?.state_shapes === "text_or_conversation") {
    fail(`--member ${memberKey} reads only judge-shaped states; the memory point sends an object state`);
  }
  const fetchGuard = guardFetch([labellerConfig.endpoint, memberConfig.endpoint]);
  globalThis.fetch = fetchGuard;
  const labeller = buildLabeller(fetchGuard);
  const client = new DecisionClient({ models: config.models, fetchImpl: fetchGuard });
  const scorer = createMemoryScorer({
    client,
    memberKey,
    stateMaxTokens: decisions.memory?.state_max_tokens ?? decisions.state_max_tokens ?? 8000,
  });
  // The member's effective threshold today: its calibration override, else the point's.
  const overrides = decisions.calibration?.[memberKey];
  const configuredThreshold =
    overrides?.[MEMORY_CALIBRATION_KEY] ?? overrides?.["relevance_threshold"] ?? memoryPointKnobs(decisions).relevanceThreshold;
  const db = openReadOnly(dbPath);
  try {
    const report = await runMemoryCalibration({
      db,
      sample: num("sample", 200),
      seed: num("seed", 1),
      ...(sinceMs !== undefined ? { since: sinceMs } : {}),
      agent: agentName,
      configuredThreshold,
      ...(thresholds ? { thresholds } : {}),
      targetPrecision: num("target-precision", 0.9),
      concurrency: num("concurrency", 2),
      labeller,
      scorer,
      labellerInfo,
      memberInfo: { model: memberKey, host: host(memberConfig.endpoint) },
    });
    process.stdout.write(switches.has("json") ? reportJson(report) : formatMemoryReport(report));
  } catch (error) {
    // Error texts here are the tool's own (guards, configuration, HTTP status): never content.
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
  process.exit(0);
}

const catalogue = buildCheckCatalogue(config);
const agent = flags.get("agent") ?? null;
const checkCode = flags.get("check");
const duplicateCheck = checkCode !== undefined && catalogue.get(checkCode, agent)?.kind === "duplicate";
// The duplicate check runs on its own chain (default [decisions].model, not the checks point's).
const defaultMember = duplicateCheck ? duplicateKnobs(decisions).model : decisions.checks?.model ?? decisions.model;
const memberKey = flags.get("member") ?? defaultMember ?? fail("--member is required (no [decisions] model)");
const memberConfig = config.models[memberKey] ?? fail(`--member ${memberKey} is not a [models.*] key`);
if (!isDecisionModel(memberConfig)) fail(`--member ${memberKey} must be a system-one decision model`);

const sourceFlag = flags.get("source");
if (sourceFlag !== undefined && !(CHECK_SOURCES as readonly string[]).includes(sourceFlag)) {
  fail(`--source must be one of ${CHECK_SOURCES.join(", ")}`);
}

// 3. Every request must go to one of the two configured endpoints.
const fetchGuard = guardFetch([labellerConfig.endpoint, memberConfig.endpoint]);
globalThis.fetch = fetchGuard;
const labeller = buildLabeller(fetchGuard);

const client = new DecisionClient({ models: config.models, fetchImpl: fetchGuard });
const stateMaxTokens = decisions.checks?.state_max_tokens ?? decisions.state_max_tokens ?? 8000;
const memberInfo = { model: memberKey, host: host(memberConfig.endpoint) };
// Channel visibility, as the live duplicate check applies it.
const visibilityResolver = new ChannelVisibilityResolver(config.visibility as VisibilityConfig | undefined);

if (anyRefusal) {
  const sources = sourceFlag !== undefined ? [sourceFlag as CheckSource] : [...ANY_REFUSAL_SOURCES[checkpoint]];
  const checks = catalogue.enabledFor(checkpoint, agent).filter((c) => c.kind === "refusal" && c.questions.length > 0);
  if (checks.length === 0) fail(`no enabled refusal check has questions at ${checkpoint}`);
  let bands: number[] | undefined;
  try {
    bands = flags.has("bands") ? normalizeBands(flags.get("bands")!.split(",").map((t) => Number(t))) : undefined;
  } catch (error) {
    fail(`--bands: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scorer = createAnyRefusalScorer({
    client,
    memberKey,
    memberConfig,
    checks,
    checkpoint,
    sources,
    persona: decisions.persona ?? "",
    stateMaxTokens,
  });
  const db = openReadOnly(dbPath);
  try {
    const report = await runAnyRefusalCalibration({
      db,
      catalogue,
      agent,
      agents: Object.keys(config.agents ?? {}),
      checkpoint,
      sources,
      ...(bands ? { bands } : {}),
      perBand: num("per-band", 25),
      seed: num("seed", 1),
      ...(sinceMs !== undefined ? { since: sinceMs } : {}),
      ...(thresholds ? { thresholds } : {}),
      targetPrecision: num("target-precision", 0.9),
      concurrency: num("concurrency", 2),
      labeller,
      scorer,
      labellerInfo,
      memberInfo,
    });
    process.stdout.write(switches.has("json") ? reportJson(report) : formatAnyRefusalReport(report));
  } catch (error) {
    // Error texts here are the tool's own (guards, configuration, HTTP status): never content.
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
  process.exit(0);
}

const code = required("check");
const check = catalogue.get(code, agent) ?? fail(`unknown check ${code}`);
const source = (sourceFlag ?? (checkpoint === "send" ? "message" : "text")) as CheckSource;
const questionName = flags.get("question");
const question = questionName !== undefined
  ? (check.questions.find((q) => q.name === questionName) ??
    fail(`check ${code} has no question named ${questionName} (${check.questions.map((q) => q.name ?? q.source).join(", ")})`))
  : (() => {
      const matching = check.questions.filter((q) => q.source === source);
      if (matching.length > 1) {
        fail(`check ${code} has several questions over ${source}; pick one with --question (${matching.map((q) => q.name ?? q.source).join(", ")})`);
      }
      return matching[0] ?? fail(`check ${code} has no question over ${source}`);
    })();
if (duplicateCheck && checkpoint !== "send") fail("the duplicate check judges sends: --checkpoint send");
const scorer = createDecisionScorer({
  client,
  memberKey,
  memberConfig,
  check,
  question,
  persona: decisions.persona ?? "",
  stateMaxTokens,
});

const db = openReadOnly(dbPath);
try {
  const knobs = duplicateKnobs(decisions);
  const sampled = duplicateCheck
    ? sampleDuplicateItems(db, {
        sample: num("sample", 200),
        seed: num("seed", 1),
        ...(sinceMs !== undefined ? { since: sinceMs } : {}),
        windowMs: num("window-ms", DEFAULT_DUPLICATE_WINDOW_MS),
        maxEarlier: knobs.maxEarlier,
        earlierMaxTokens: knobs.earlierMaxTokens,
        proactiveSessionType: config.proactive?.session_type ?? "proactive",
        codes: new Set(catalogue.all(agent).filter((c) => c.kind === "duplicate").map((c) => c.code)),
        ...(switches.has("fired-only") ? { firedOnly: true } : {}),
        // Channel visibility, as the live check applies it.
        readGate: (timelineKey) => ({ currentTimelineKey: timelineKey, visibilityResolver }),
      })
    : undefined;
  const report = await runCalibration({
    db,
    catalogue,
    check,
    question,
    checkpoint,
    ...(sampled ? { sampled } : {}),
    sample: num("sample", 200),
    ...(switches.has("fired-only") ? { firedOnly: true } : {}),
    seed: num("seed", 1),
    ...(sinceMs !== undefined ? { since: sinceMs } : {}),
    agent,
    persona: decisions.persona ?? "",
    ...(thresholds ? { thresholds } : {}),
    targetPrecision: num("target-precision", 0.9),
    concurrency: num("concurrency", 2),
    labeller,
    scorer,
    labellerInfo,
    memberInfo,
  });
  process.stdout.write(switches.has("json") ? reportJson(report) : formatReport(report));
} catch (error) {
  // Error texts here are the tool's own (guards, configuration, HTTP status): never content.
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
