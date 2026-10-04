/**
 * Routing (ARCHITECTURE.md §8h "Routing"): at the creation of a human-triggered
 * chat session, classify the request by task category (an operator-defined
 * `choice`), optionally by difficulty (a `score`), and optionally ask which
 * listed skill it needs. The verdict names a model preference cascade, a
 * thinking level, skills to preload, and extra tail files. The fallback is
 * today's behaviour: no routing at all.
 */

import type { AppConfig } from "../../config/index.js";
import type { DecisionsRawConfig } from "../../config/schema.js";
import type { DecisionPoint } from "../registry.js";
import { clipText, packNewest } from "../state.js";
import { senderName, toTranscriptMessage, type TranscriptMessage } from "../transcript.js";
import type { DecisionQuestion } from "../types.js";
import type { CanonicalChatEvent } from "../../types.js";

type RoutingConfig = NonNullable<DecisionsRawConfig["routing"]>;
type TaskConfig = NonNullable<RoutingConfig["tasks"]>[string];
type ThinkingLevel = NonNullable<AppConfig["models"]["default"]["thinking_level"]>;

export const ROUTING_OTHER = "other";
export const ROUTING_NO_SKILL = "none";

export interface RoutingInput {
  request: TranscriptMessage & { reply_to?: { from: string; text: string } };
  /** Messages before the request, oldest first. */
  recent: TranscriptMessage[];
  /** The session's listed (loadable) skills. */
  skills: Array<{ name: string; description: string }>;
  tasks: Record<string, TaskConfig>;
  difficulty?: RoutingConfig["difficulty"];
  /** Ask the `skill` question. */
  preloadSkills: boolean;
}

export interface RoutingVerdict {
  /** The confident task category, or "other". */
  task: string;
  /** Difficulty level index, when asked and confident. */
  difficulty?: number;
  /** Model preference cascade ([models.*] keys), tried before normal selection. */
  models: string[];
  thinkingLevel?: ThinkingLevel;
  /** Listed skills to preload (union of the task's skills and the `skill` answer). */
  skills: string[];
  /** Workspace-relative extra tail files. */
  tailFiles: string[];
}

export const NO_ROUTING: RoutingVerdict = { task: ROUTING_OTHER, models: [], skills: [], tailFiles: [] };

/** Does routing have anything to ask for this session? */
export function routingHasQuestions(input: Pick<RoutingInput, "tasks" | "difficulty" | "preloadSkills" | "skills">): boolean {
  return (
    Object.keys(input.tasks).length > 0 ||
    input.difficulty !== undefined ||
    (input.preloadSkills && input.skills.length > 0)
  );
}

function cascadeOf(task: TaskConfig | undefined): string[] {
  if (!task) return [];
  return task.models ?? (task.model ? [task.model] : []);
}

export const routingPoint: DecisionPoint<RoutingInput, RoutingVerdict> = {
  name: "routing",

  questions(input) {
    const questions: Record<string, DecisionQuestion> = {};
    const taskKeys = Object.keys(input.tasks);
    if (taskKeys.length > 0) {
      const criteria: Record<string, string> = {};
      for (const key of taskKeys) criteria[key] = input.tasks[key]!.description;
      criteria[ROUTING_OTHER] = "None of the above; ordinary conversation or anything else.";
      questions["task"] = {
        type: "choice",
        instructions:
          "`request` is the latest message sent to the assistant; `recent` is the conversation before it, " +
          "for context only. Which kind of task does `request` ask the assistant to do?",
        criteria,
      };
    }
    if (input.difficulty) {
      questions["difficulty"] = {
        type: "score",
        instructions: "How much work does answering `request` well take?",
        criteria: input.difficulty.levels,
      };
    }
    if (input.preloadSkills && input.skills.length > 0) {
      const criteria: Record<string, string> = {};
      for (const skill of input.skills) criteria[skill.name] = skill.description;
      criteria[ROUTING_NO_SKILL] = "No skill is clearly needed: plain conversation, or the request needs none of these.";
      questions["skill"] = {
        type: "choice",
        instructions:
          "Which of these skills does the assistant need to load to handle `request`? " +
          "Pick the one it would need first.",
        criteria,
      };
    }
    return questions;
  },

  state(input, budgetTokens) {
    const build = (recent: TranscriptMessage[]) => ({
      request: input.request,
      recent: recent.map(({ from, text, attachments, self }) => ({
        from,
        text,
        ...(self ? { self } : {}),
        ...(attachments ? { attachments } : {}),
      })),
    });
    return build(packNewest(input.recent, budgetTokens, build));
  },

  resolve(answers, input, threshold, settings) {
    const minConfidence = threshold("min_confidence", settings.minConfidence);
    let confidentAnswer = false;
    let task = ROUTING_OTHER;
    const taskAnswer = answers["task"];
    if (taskAnswer?.type === "choice" && taskAnswer.confidence >= minConfidence) {
      confidentAnswer = true;
      task = taskAnswer.choice;
    }
    let difficulty: number | undefined;
    const difficultyAnswer = answers["difficulty"];
    if (difficultyAnswer?.type === "score" && difficultyAnswer.confidence >= minConfidence) {
      confidentAnswer = true;
      difficulty = difficultyAnswer.score;
    }
    let skillChoice: string | undefined;
    const skillAnswer = answers["skill"];
    if (skillAnswer?.type === "choice" && skillAnswer.confidence >= minConfidence) {
      confidentAnswer = true;
      if (skillAnswer.choice !== ROUTING_NO_SKILL) skillChoice = skillAnswer.choice;
    }
    if (!confidentAnswer) return null;

    const taskConfig = task === ROUTING_OTHER ? undefined : input.tasks[task];
    let models = cascadeOf(taskConfig);
    let thinkingLevel = taskConfig?.thinking_level as ThinkingLevel | undefined;
    // The difficulty axis only routes requests no category covers.
    if (task === ROUTING_OTHER && difficulty !== undefined && input.difficulty) {
      models = input.difficulty.models?.[String(difficulty)] ?? [];
      thinkingLevel = input.difficulty.thinking_levels?.[String(difficulty)] as ThinkingLevel | undefined;
    }
    const skills = [...(taskConfig?.skills ?? [])];
    if (skillChoice && !skills.includes(skillChoice)) skills.push(skillChoice);
    return {
      task,
      ...(difficulty !== undefined ? { difficulty } : {}),
      models,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      skills,
      tailFiles: [...(taskConfig?.tail_files ?? [])],
    };
  },

  fallback: () => NO_ROUTING,

  describe: (verdict) => ({
    task: verdict.task,
    ...(verdict.difficulty !== undefined ? { difficulty: verdict.difficulty } : {}),
    ...(verdict.models.length > 0 ? { models: verdict.models } : {}),
    ...(verdict.thinkingLevel ? { thinkingLevel: verdict.thinkingLevel } : {}),
    ...(verdict.skills.length > 0 ? { skills: verdict.skills } : {}),
    ...(verdict.tailFiles.length > 0 ? { tailFiles: verdict.tailFiles } : {}),
  }),
};

/**
 * Build the routing input from timeline events (pure; ARCHITECTURE.md §8h).
 * `recent` are the hydrated events before the trigger, oldest first.
 */
export function routingInputFrom(args: {
  trigger: CanonicalChatEvent;
  recent: CanonicalChatEvent[];
  listedSkills: ReadonlyArray<{ name: string; description: string }>;
  routing: RoutingConfig;
}): RoutingInput {
  const request: RoutingInput["request"] = toTranscriptMessage(args.trigger, 2000);
  const reply = args.trigger.replyTo;
  if (reply && (reply.body || reply.sender)) {
    request.reply_to = { from: senderName(reply.sender), text: clipText(reply.body ?? "", 600) };
  }
  const limit = args.routing.recent_messages ?? 10;
  const recent = args.recent
    .filter((event) => event.id !== args.trigger.id)
    .slice(-limit)
    .map((event) => toTranscriptMessage(event, 400));
  return {
    request,
    recent,
    skills: args.listedSkills.map((skill) => ({ name: skill.name, description: skill.description })),
    tasks: args.routing.tasks ?? {},
    difficulty: args.routing.difficulty,
    preloadSkills: args.routing.preload_skills ?? true,
  };
}
