import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { EXA_EFFORTS, type ExaEffort, type ExaResearchRequest } from "../exa/types.js";
import { ExaResearchService, type ExaResearchCaller } from "../exa/research.js";
import type { ExaResearchJob, ExaResearchOrigin } from "../storage/database.js";
import { validateExaOutputSchema } from "./exa.js";
export interface ExaResearchToolContext {
  service: ExaResearchService; caller: ExaResearchCaller;
  makeOrigin: (toolCallId: string) => ExaResearchOrigin;
  checkBudget?: () => string | undefined;
}
function render(job: ExaResearchJob, offset = 0, max = 8000) {
  const remote = job.remote;
  const body = [remote?.output?.text, remote?.output?.structured !== undefined ? `Structured output:\n${JSON.stringify(remote.output.structured)}` : undefined, remote?.output?.grounding !== undefined ? `Grounding:\n${JSON.stringify(remote.output.grounding)}` : undefined].filter(Boolean).join("\n\n");
  if (offset > body.length) throw new Error(`offset exceeds research output length ${body.length}; call exa_research_result with offset 0.`);
  const text = [`Job ${job.id}: ${job.state}${remote?.stopReason ? ` (stop reason: ${remote.stopReason})` : ""}`, job.lastError,
    job.state === "submission_unknown" ? "Remote acceptance is uncertain. Do not restart this invocation; operator investigation is required." : undefined,
    job.state === "failed" || job.state === "cancelled" ? "Research did not complete successfully; any charged cost is retained." : undefined,
    remote?.stopReason === "budget_reached" ? "Output is partial: the run stopped at its budget limit." : undefined,
    body.slice(offset, offset + max), offset + max < body.length ? `More: exa_research_result(job_id: "${job.id}", offset: ${offset + max}, wait: false).` : undefined,
  ].filter(Boolean).join("\n\n");
  return { content: [{ type: "text" as const, text }], details: { jobId: job.id, state: job.state, remoteStatus: remote?.status, stopReason: remote?.stopReason, costDollars: remote?.costDollars, accounted: job.accounted, offset, totalChars: body.length, output: remote?.output, lastError: job.lastError } };
}
export function createExaResearchTools(ctx: ExaResearchToolContext): AgentTool[] {
  const cfg = ctx.service.client.config.research;
  const result: AgentTool = {
    name: "exa_research_result", label: "Exa research result", description: "Collect a visible local research job without creating new paid work. Waits by default; wait=false checks saved status. Repeated reads do not charge again.",
    parameters: Type.Object({ job_id: Type.String({ minLength: 1 }), wait: Type.Optional(Type.Boolean()), offset: Type.Optional(Type.Integer({ minimum: 0 })), max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 200000 })) }),
    execute: async (_call, params, signal) => { const args = params as { job_id: string; wait?: boolean; offset?: number; max_chars?: number }; return render(await ctx.service.result(args.job_id, ctx.caller, args.wait ?? true, signal), args.offset, args.max_chars); },
  };
  const list: AgentTool = {
    name: "exa_research_list", label: "List Exa research", description: "Find this agent's visible saved research jobs without knowing IDs. Filter status/query and page with returned cursor; does not start research.",
    parameters: Type.Object({ status: Type.Optional(Type.Union(["submitting", "submission_unknown", "queued", "running", "completed", "failed", "cancelled"].map((status) => Type.Literal(status)))), query: Type.Optional(Type.String({ maxLength: 2000 })), cursor: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    execute: async (_call, params) => { const page = ctx.service.list(ctx.caller, params as any); const jobs = page.jobs.map((job) => ({ jobId: job.id, query: job.request.query, state: job.state, createdAt: job.createdAt, sessionId: job.origin.sessionId, timelineKey: job.origin.timelineKey, stopReason: job.remote?.stopReason, lastError: job.lastError })); return { content: [{ type: "text", text: jobs.length ? JSON.stringify({ jobs, nextCursor: page.nextCursor }) : "No visible research jobs match." }], details: { jobs, nextCursor: page.nextCursor } }; },
  };
  const cancel: AgentTool = {
    name: "exa_research_cancel", label: "Cancel Exa research", description: "Request cancellation of a visible job owned by the originating requester or trusted operator. Cancellation can race completion; it is not a refund.",
    parameters: Type.Object({ job_id: Type.String({ minLength: 1 }) }),
    execute: async (_call, params, signal) => render(await ctx.service.cancel((params as { job_id: string }).job_id, ctx.caller, signal)),
  };
  const create: AgentTool = {
    name: "exa_research", label: "Exa research", description: "Investigate a substantial question or structured list. Creates a paid durable job and waits for completion. Result/list recover existing work; do not restart merely to check progress. Local abort preserves remote work.",
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 20000 }), effort: Type.Optional(Type.Union(EXA_EFFORTS.slice(0, EXA_EFFORTS.indexOf(cfg.max_effort) + 1).map((effort) => Type.Literal(effort)))),
      output_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())), instructions: Type.Optional(Type.String({ maxLength: 10000 })),
      data_sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 })),
      input_data: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100 })), exclude_data: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100 })), previous_job_id: Type.Optional(Type.String({ minLength: 1 })),
    }),
    execute: async (call, params, signal) => {
      const args = params as { query: string; effort?: ExaEffort; output_schema?: Record<string, unknown>; instructions?: string; data_sources?: string[]; input_data?: Record<string, unknown>[]; exclude_data?: Record<string, unknown>[]; previous_job_id?: string };
      if (!args.query.trim()) throw new Error("query must not be blank; describe a bounded research task.");
      if (args.output_schema) validateExaOutputSchema(args.output_schema, false);
      if (Buffer.byteLength(JSON.stringify(args)) > 100000) throw new Error("Research inputs exceed 100KB; reduce input_data/exclude_data and schema size.");
      if (args.data_sources?.some((provider) => !cfg.allowed_data_sources.includes(provider))) throw new Error(`Research sources must be operator-allowlisted. Permitted: ${cfg.allowed_data_sources.join(", ") || "none"}.`);
      const effort = args.effort ?? cfg.default_effort;
      if (!EXA_EFFORTS.includes(effort) || EXA_EFFORTS.indexOf(effort) > EXA_EFFORTS.indexOf(cfg.max_effort)) throw new Error(`Permitted research efforts: ${EXA_EFFORTS.slice(0, EXA_EFFORTS.indexOf(cfg.max_effort) + 1).join(", ")}.`);
      const request: ExaResearchRequest = { query: args.query, effort, ...(args.output_schema ? { outputSchema: args.output_schema } : {}), ...(args.instructions ? { systemPrompt: args.instructions } : {}), ...(args.data_sources?.length ? { dataSources: args.data_sources.map((provider) => ({ provider })) } : {}), ...(args.input_data || args.exclude_data ? { input: { data: args.input_data, exclusion: args.exclude_data } } : {}) };
      return render(await ctx.service.create(ctx.makeOrigin(call), request, ctx.caller, signal, args.previous_job_id, ctx.checkBudget));
    },
  };
  return [...(cfg.enabled ? [create] : []), result, list, cancel];
}
