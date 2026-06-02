import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ExecBackend, ExecResult } from "../sandbox/index.js";

export interface BashToolContext {
  sandbox: ExecBackend;
  /** Fallback timeout (ms) when a call omits timeout_ms. */
  defaultTimeoutMs?: number;
}

interface BashArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

/**
 * Run a shell command inside the sandbox container. This is the isolation
 * boundary that makes arbitrary shell execution safe: the command runs as the
 * sandbox user inside the container, not in the harness process. The workspace
 * is mounted at the container root, so files created here are visible to the
 * in-process file/image tools (hybrid FS model — ARCHITECTURE.md §11a).
 */
export function createBashTool(context: BashToolContext): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command inside the sandbox container via /bin/sh -lc. The workspace is the " +
      "working directory; `cwd` is interpreted relative to the workspace root. Use this for builds, " +
      "package installs, running scripts, and any CLI tooling. Network access reaches the public " +
      "internet but not local services.",
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run." }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory relative to the workspace root. Defaults to the workspace root." }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ minimum: 1, maximum: 600_000, description: "Kill the command after this many milliseconds." }),
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      const args = params as BashArgs;
      const result = await context.sandbox.exec(args.command, {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms ?? context.defaultTimeoutMs,
        signal,
      });
      return {
        content: [{ type: "text", text: formatBashResult(result) }],
        details: {
          exitCode: result.exitCode,
          truncated: result.truncated,
          timedOut: result.timedOut,
          cwd: args.cwd ?? ".",
        },
      };
    },
  };
}

function formatBashResult(result: ExecResult): string {
  const parts: string[] = [`exit: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`];
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no output)");
  if (result.truncated) parts.push("[output truncated]");
  return parts.join("\n\n");
}
