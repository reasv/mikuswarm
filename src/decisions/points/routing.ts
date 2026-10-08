/**
 * Routing (ARCHITECTURE.md §8h "Routing"): at the creation of a human-triggered
 * chat session, label the request with its tasks (one `noul` per
 * operator-defined task, multi-label: DECISION-MODEL §5.1a), optionally score
 * its difficulty (a `score`), and optionally ask which listed skills it needs
 * (one `noul` per skill). The verdict names the selected tasks, a model
 * preference cascade, a thinking level, skills to preload, and extra tail
 * files, merged over the selected tasks. The fallback is today's behaviour: no
 * routing at all (and no tasks).
 */

import type { AppConfig } from "../../config/index.js";
import { deletedPlaceholder } from "../../timeline/deletions.js";
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
/**
 * The built-in task of every proactive session (DECISION-MODEL §5.1a), assigned
 * without a decision call. Reserved like `other`: config cannot define it.
 */
export const ROUTING_PROACTIVE = "proactive";
/** Task keys config cannot define (`[decisions.routing.tasks.<key>]`). */
export const RESERVED_ROUTING_TASKS: readonly string[] = [ROUTING_OTHER, ROUTING_PROACTIVE];

/** The routing question id of a task's `noul`. */
export function taskQuestionId(key: string): string {
  return `task__${key}`;
}

/** The routing question id of a listed skill's `noul`. */
export function skillQuestionId(name: string): string {
  return `skill__${name}`;
}

const THINKING_ORDER: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** The higher of two thinking levels (unknown levels rank lowest). */
function higherThinking(a: ThinkingLevel | undefined, b: ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return THINKING_ORDER.indexOf(b) > THINKING_ORDER.indexOf(a) ? b : a;
}

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
  /** The first selected task (authored order), or "other". */
  task: string;
  /**
   * Every selected task, in authored order (DECISION-MODEL §5.1a); `["other"]`
   * when the model selected none. Empty only on the fallback verdict.
   */
  tasks: string[];
  /** Difficulty level index, when asked and confident. */
  difficulty?: number;
  /** Model preference cascade ([models.*] keys), tried before normal selection. */
  models: string[];
  thinkingLevel?: ThinkingLevel;
  /** Listed skills to preload (union of the task's skills and the `skill` answer). */
  skills: string[];
  /** Workspace-relative extra tail files. */
  tailFiles: string[];
  /**
   * Decision-group UUID for the routing evaluation (CONTRACT decision 6).
   * W4 sets this; stamped onto the harness marker of each synthetic skill-load
   * call so the injection is traceable to its decision row.
   */
  decisionGroup?: string;
}

export const NO_ROUTING: RoutingVerdict = { task: ROUTING_OTHER, tasks: [], models: [], skills: [], tailFiles: [] };

/** The task keys a routing verdict gives its session (a hand-built verdict without `tasks` keeps its `task`). */
export function routingTasksOf(verdict: Pick<RoutingVerdict, "task" | "tasks">): string[] {
  return verdict.tasks && verdict.tasks.length > 0 ? [...verdict.tasks] : [verdict.task];
}

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
    // Multi-label tasks (DECISION-MODEL §5.1a): one `noul` per task, so a
    // request may select several; none selected = `other`.
    for (const [key, task] of Object.entries(input.tasks)) {
      questions[taskQuestionId(key)] = {
        type: "noul",
        instructions:
          "`request` is the latest message sent to the assistant; `recent` is the conversation before it, " +
          "for context only. The request involves this kind of task: " +
          task.description,
        criteria: {
          true: `\`request\` involves this: ${task.description}`,
          false: "`request` does not involve this kind of task (ordinary conversation, or other kinds of work).",
        },
      };
    }
    if (input.difficulty) {
      questions["difficulty"] = {
        type: "score",
        instructions: "How much work does answering `request` well take?",
        criteria: input.difficulty.levels,
      };
    }
    if (input.preloadSkills) {
      // One `noul` per listed skill, so a request can preload several.
      for (const skill of input.skills) {
        questions[skillQuestionId(skill.name)] = {
          type: "noul",
          instructions: "Does the assistant need to load this skill to handle `request`? The skill: " + skill.description,
          criteria: {
            true: `Handling \`request\` needs this skill: ${skill.description}`,
            false: "The skill is not needed: plain conversation, or the request needs other skills or none.",
          },
        };
      }
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
    // Tasks (DECISION-MODEL §5.1a): every task at or above its own threshold
    // (`tasks.<key>.threshold`, default the point's floor; calibration key
    // `"routing.task.<key>"`) is selected, in authored order.
    const taskKeys = Object.keys(input.tasks);
    let tasksAnswered = false;
    const selected: string[] = [];
    for (const key of taskKeys) {
      const answer = answers[taskQuestionId(key)];
      if (answer?.type !== "noul") continue;
      tasksAnswered = true;
      const floor = threshold(`task.${key}`, input.tasks[key]!.threshold ?? minConfidence);
      if (answer.noul >= floor) selected.push(key);
    }
    let difficulty: number | undefined;
    const difficultyAnswer = answers["difficulty"];
    if (difficultyAnswer?.type === "score" && difficultyAnswer.confidence >= minConfidence) {
      difficulty = difficultyAnswer.score;
    }
    const skillChoices: string[] = [];
    for (const skill of input.skills) {
      const answer = answers[skillQuestionId(skill.name)];
      if (answer?.type !== "noul") continue;
      if (answer.noul >= threshold(`skill.${skill.name}`, minConfidence)) skillChoices.push(skill.name);
    }
    // Nothing to apply and no task labels to give: fall back (no routing).
    if (!tasksAnswered && difficulty === undefined && skillChoices.length === 0) return null;

    const configs = selected.map((key) => input.tasks[key]!);
    const models: string[] = [];
    const skills: string[] = [];
    const tailFiles: string[] = [];
    let thinkingLevel: ThinkingLevel | undefined;
    const add = (into: string[], items: readonly string[] | undefined) => {
      for (const item of items ?? []) if (!into.includes(item)) into.push(item);
    };
    for (const config of configs) {
      // Cascades concatenated in authored order: the first selected task with
      // models heads the session, the others extend the cascade.
      add(models, cascadeOf(config));
      add(skills, config.skills);
      add(tailFiles, config.tail_files);
      thinkingLevel = higherThinking(thinkingLevel, config.thinking_level as ThinkingLevel | undefined);
    }
    // The difficulty axis applies when no selected task names models.
    if (models.length === 0 && difficulty !== undefined && input.difficulty) {
      add(models, input.difficulty.models?.[String(difficulty)]);
      thinkingLevel ??= input.difficulty.thinking_levels?.[String(difficulty)] as ThinkingLevel | undefined;
    }
    add(skills, skillChoices);
    const tasks = selected.length > 0 ? selected : [ROUTING_OTHER];
    return {
      task: tasks[0]!,
      tasks,
      ...(difficulty !== undefined ? { difficulty } : {}),
      models,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      skills,
      tailFiles,
    };
  },

  fallback: () => NO_ROUTING,

  describe: (verdict) => ({
    task: verdict.task,
    ...(verdict.tasks.length > 0 ? { tasks: verdict.tasks } : {}),
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
  if (reply && (reply.body || reply.sender || reply.deleted)) {
    // A quote of a deleted message shows the placeholder (§6 "Message edits").
    const text = reply.deleted ? deletedPlaceholder(reply.deleted, reply.sender?.id) : clipText(reply.body ?? "", 600);
    request.reply_to = { from: senderName(reply.sender), text };
  }
  const limit = args.routing.recent_messages ?? 10;
  const recent = args.recent
    .filter((event) => event.id !== args.trigger.id)
    .slice(-limit)
    .map((event) => toTranscriptMessage(event, 400, { deletedPlaceholder: true }));
  return {
    request,
    recent,
    skills: args.listedSkills.map((skill) => ({ name: skill.name, description: skill.description })),
    tasks: args.routing.tasks ?? {},
    difficulty: args.routing.difficulty,
    preloadSkills: args.routing.preload_skills ?? true,
  };
}
