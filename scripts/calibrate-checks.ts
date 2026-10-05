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
 *
 * Options:
 *   --config <dir>          config directory (default ./config); its .env is loaded over the shell's
 *   --env <file>            the .env file (default ./.env)
 *   --member <models key>   decision member to score with (default: the head of [decisions.checks].model,
 *                           else [decisions].model); only this member is called, never its fallbacks
 *   --checkpoint send|ending  (default send)
 *   --source <source>       which question of the check (default: message at send, text at ending)
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
 * Safety:
 * - The database is opened read-only (`query_only`); run it on a copy if you prefer.
 * - The tool refuses to start when the environment sets endpoint or proxy
 *   overrides (e.g. a provider *_BASE_URL or HTTPS_PROXY), and every request is
 *   checked against the labeller's and the member's configured endpoints.
 * - The labeller must be a chat model whose data policy already covers chat
 *   content. It is instructed never to reproduce content, and its answer is
 *   reduced to enums before anything is printed.
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import type { CheckSource } from "../src/checks/types.js";
import { loadConfig } from "../src/config/index.js";
import { createModelFromConfig } from "../src/agent/factory.js";
import { DecisionClient } from "../src/decisions/client.js";
import { decisionsFor, isDecisionModel } from "../src/decisions/config.js";
import {
  assertNoEndpointOverrides,
  createDecisionScorer,
  formatReport,
  guardFetch,
  openReadOnly,
  reportJson,
  requireGuardedTransport,
  runCalibration,
  type Labeller,
} from "../src/audit/calibration.js";

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
  if (name === "json" || name === "fired-only") switches.add(name);
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

const dbPath = required("db");
const labellerKey = required("labeller");
const code = required("check");
const configDir = flags.get("config") ?? "./config";
const checkpoint = (flags.get("checkpoint") ?? "send") as "send" | "ending";
if (checkpoint !== "send" && checkpoint !== "ending") fail("--checkpoint must be send or ending");

// 2. The configuration (its .env wins over the shell for the keys it defines).
const config = await loadConfig(configDir, { env: { envFile: flags.get("env") ?? ".env", override: true } });
const labellerConfig = config.models[labellerKey] ?? fail(`--labeller ${labellerKey} is not a [models.*] key`);
if (isDecisionModel(labellerConfig)) fail(`--labeller ${labellerKey} is a decision model; it must be a chat model`);
const decisions = decisionsFor(config, flags.get("agent") ?? null);
const memberKey = flags.get("member") ?? decisions.checks?.model ?? decisions.model ?? fail("--member is required (no [decisions] model)");
const memberConfig = config.models[memberKey] ?? fail(`--member ${memberKey} is not a [models.*] key`);
if (!isDecisionModel(memberConfig)) fail(`--member ${memberKey} must be a system-one decision model`);

const catalogue = buildCheckCatalogue(config);
const agent = flags.get("agent") ?? null;
const check = catalogue.get(code, agent) ?? fail(`unknown check ${code}`);
const source = (flags.get("source") ?? (checkpoint === "send" ? "message" : "text")) as CheckSource;
const question = check.questions.find((q) => q.source === source) ?? fail(`check ${code} has no question over ${source}`);

const host = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return fail(`the configured endpoint of a model is not a URL`);
  }
};

// 3. Every request must go to one of the two configured endpoints.
const fetchGuard = guardFetch([labellerConfig.endpoint, memberConfig.endpoint]);
globalThis.fetch = fetchGuard;

const model = createModelFromConfig(labellerConfig);
let labellerDiagnosed = false;
const labeller: Labeller = requireGuardedTransport(
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

const scorer = createDecisionScorer({
  client: new DecisionClient({ models: config.models, fetchImpl: fetchGuard }),
  memberKey,
  memberConfig,
  check,
  question,
  persona: decisions.persona ?? "",
  stateMaxTokens: decisions.checks?.state_max_tokens ?? decisions.state_max_tokens ?? 8000,
});

const since = flags.get("since");
const sinceMs = since !== undefined ? Date.parse(since) : undefined;
if (sinceMs !== undefined && !Number.isFinite(sinceMs)) fail("--since must be a date (YYYY-MM-DD)");

const db = openReadOnly(dbPath);
try {
  const report = await runCalibration({
    db,
    catalogue,
    check,
    question,
    checkpoint,
    sample: num("sample", 200),
    ...(switches.has("fired-only") ? { firedOnly: true } : {}),
    seed: num("seed", 1),
    ...(sinceMs !== undefined ? { since: sinceMs } : {}),
    agent,
    persona: decisions.persona ?? "",
    ...(flags.has("thresholds")
      ? { thresholds: flags.get("thresholds")!.split(",").map((t) => Number(t)).filter((t) => t >= 0 && t <= 1) }
      : {}),
    targetPrecision: num("target-precision", 0.9),
    concurrency: num("concurrency", 2),
    labeller,
    scorer,
    labellerInfo: { model: labellerKey, host: host(labellerConfig.endpoint) },
    memberInfo: { model: memberKey, host: host(memberConfig.endpoint) },
  });
  process.stdout.write(switches.has("json") ? reportJson(report) : formatReport(report));
} catch (error) {
  // Error texts here are the tool's own (guards, configuration, HTTP status): never content.
  fail(error instanceof Error ? error.message : String(error));
} finally {
  db.close();
}
