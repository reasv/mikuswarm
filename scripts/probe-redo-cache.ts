/**
 * Probe the prompt cache of a redo from scratch (ARCHITECTURE.md §8 "Late
 * input"): does a redo request read the prefix the first request wrote, when the
 * first request completed, when it was aborted right after its first stream
 * event, and when it was aborted before any byte arrived? The answer decides the
 * cost of a redo (about one extra request when the prefix is read) and justifies
 * the abort rule (never abort before the first stream event).
 *
 * Each case sends a synthetic prefix shaped like a live session (system prompt,
 * summary layer, chat turns, final user turn) through the real transport and the
 * session's cache-breakpoint injector, then a redo with an edited final turn,
 * and prints the redo's reported cache read and write. Every case uses its own
 * random salt, so cases never share a cache entry. Costs a few requests per
 * model at the given prefix size.
 *
 * Usage:
 *   npx tsx scripts/probe-redo-cache.ts --model <models key> [--model <key> ...]
 *     [--config <dir>] [--env <file>] [--prefix-tokens <n>] [--settle-ms <n>]
 *
 * Options:
 *   --config <dir>         config directory (default ./config); its .env is loaded over the shell's
 *   --env <file>           the .env file (default ./.env)
 *   --prefix-tokens <n>    approximate prefix size (default 30000)
 *   --settle-ms <n>        pause between a first request and its redo (default 3000)
 */

import { randomBytes } from "node:crypto";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { loadConfig } from "../src/config/index.js";
import { createModelFromConfig } from "../src/agent/factory.js";
import { makeBreakpointInjector } from "../src/agent/cache-breakpoints.js";
import { estimateTokens } from "../src/context/tokens.js";

interface Args {
  models: string[];
  config: string;
  env: string;
  prefixTokens: number;
  settleMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { models: [], config: "./config", env: "./.env", prefixTokens: 30_000, settleMs: 3000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--model" && value) args.models.push(value), (i += 1);
    else if (flag === "--config" && value) (args.config = value), (i += 1);
    else if (flag === "--env" && value) (args.env = value), (i += 1);
    else if (flag === "--prefix-tokens" && value) (args.prefixTokens = Number(value)), (i += 1);
    else if (flag === "--settle-ms" && value) (args.settleMs = Number(value)), (i += 1);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.models.length === 0) throw new Error("at least one --model is required");
  return args;
}

/** Deterministic filler of about `tokens` tokens, unique per salt. */
function filler(salt: string, label: string, tokens: number): string {
  const words: string[] = [];
  let i = 0;
  while (estimateTokens(words.join(" ")) < tokens) {
    words.push(`${label}-${salt}-${i} lorem ipsum dolor sit amet consectetur`);
    i += 1;
  }
  return words.join(" ");
}

/** A live-session-shaped context: summary layer, chat turns, and the final user turn. */
function sessionContext(salt: string, prefixTokens: number, finalTurn: string): Context {
  const now = Date.now();
  const messages: Message[] = [
    { role: "user", content: `<summaries>${filler(salt, "summary", Math.floor(prefixTokens * 0.3))}</summaries>`, timestamp: now },
  ];
  for (let turn = 0; turn < 6; turn += 1) {
    messages.push({ role: "user", content: `<message>${filler(salt, `chat${turn}`, Math.floor(prefixTokens * 0.06))}</message>`, timestamp: now });
  }
  messages.push({ role: "user", content: finalTurn, timestamp: now });
  return {
    systemPrompt: `You are a test assistant. Reply with one word.\n${filler(salt, "system", Math.floor(prefixTokens * 0.3))}`,
    messages,
  };
}

type Outcome = { usage?: AssistantMessage["usage"]; stopReason?: string; error?: string };

async function send(
  model: ReturnType<typeof createModelFromConfig>,
  apiKey: string | undefined,
  reasoning: string | undefined,
  context: Context,
  abort?: { afterFirstEvent?: boolean; afterMs?: number },
): Promise<Outcome> {
  const controller = new AbortController();
  const onPayload = makeBreakpointInjector(estimateTokens);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (abort?.afterMs !== undefined) timer = setTimeout(() => controller.abort(), abort.afterMs);
  try {
    const stream = streamSimple(model, context, {
      apiKey,
      // The session's own effort: some models refuse requests without reasoning.
      ...(reasoning && reasoning !== "off" ? { reasoning } : {}),
      maxTokens: 4096,
      signal: controller.signal,
      onPayload: onPayload as never,
    } as never);
    for await (const event of stream) {
      if (abort?.afterFirstEvent) {
        controller.abort();
        break;
      }
      if (event.type === "done" || event.type === "error") break;
    }
    const message = await stream.result();
    return { usage: message.usage, stopReason: message.stopReason, ...(message.errorMessage ? { error: message.errorMessage } : {}) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describe(outcome: Outcome): string {
  const u = outcome.usage;
  const usage = u ? `input=${u.input} cache_read=${u.cacheRead} cache_write=${u.cacheWrite} output=${u.output}` : "no usage";
  return `${usage} stop=${outcome.stopReason ?? "-"}${outcome.error ? ` error=${outcome.error.slice(0, 120)}` : ""}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config, { env: { envFile: args.env, override: true } });
  const cases: Array<{ name: string; abort?: { afterFirstEvent?: boolean; afterMs?: number } }> = [
    { name: "first request completed" },
    { name: "first request aborted after its first stream event", abort: { afterFirstEvent: true } },
    { name: "first request aborted 300 ms after sending (before any byte)", abort: { afterMs: 300 } },
  ];
  for (const key of args.models) {
    const cfg = config.models[key];
    if (!cfg) throw new Error(`unknown model "${key}"`);
    const model = createModelFromConfig(cfg, cfg.context_window);
    console.log(`\n== ${key} (${cfg.api ?? "?"}, ${cfg.id})`);
    for (const c of cases) {
      const salt = randomBytes(6).toString("hex");
      const reasoning = cfg.reasoning === false ? undefined : cfg.thinking_level;
      const first = await send(model, cfg.api_key, reasoning, sessionContext(salt, args.prefixTokens, "Question: what colour is the sky?"), c.abort);
      await new Promise((r) => setTimeout(r, args.settleMs));
      const redo = await send(model, cfg.api_key, reasoning, sessionContext(salt, args.prefixTokens, "Question (edited): what colour is grass?"));
      console.log(`  ${c.name}\n    first: ${describe(first)}\n    redo:  ${describe(redo)}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
