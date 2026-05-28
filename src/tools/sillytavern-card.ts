import fs from "node:fs/promises";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { parseToV2, type CharacterBookEntry, type V2 } from "character-card-utils";
import extractPngChunks from "png-chunks-extract";
import encodePngChunks from "png-chunks-encode";
import pngTextChunk from "png-chunk-text";
import sharp from "sharp";
import type { ConcurrencyLimitedFetchClient } from "../enrichment/fetch-client.js";
import { SVG_MAX_INPUT_PIXELS } from "../media/index.js";
import { assertPublicHttpUrl } from "./ssrf.js";

// Reject PNGs whose chunk table is structurally hostile before handing the
// buffer to png-chunks-extract. That library pre-allocates a Uint8Array sized
// by the declared length without bounds-checking; a malformed PNG declaring a
// 4 GiB chunk would trigger a multi-gigabyte allocation. We cap individual
// declared chunk lengths at 16 MiB and require that the running sum of declared
// chunk records (length field + name + data + CRC) stays within the buffer.
const PNG_MAX_CHUNK_DATA_LENGTH = 16 * 1024 * 1024;

// Hard ceiling for `*_from_file` text inputs. Text fields in SillyTavern cards
// are typically a few KB; 1 MiB is generous enough for unusual cases while
// still preventing a single workspace file from being slurped wholesale into
// model context.
const TEXT_INPUT_FILE_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface SillyTavernCardToolContext {
  workspaceRoot: string;
  fetchClient: ConcurrencyLimitedFetchClient;
  downloadSizeLimit: number;
  config?: {
    output_subdir?: string;
    export_subdir?: string;
    default_excerpt_chars?: number;
    max_excerpt_chars?: number;
    max_summary_entries?: number;
  };
}

type ResolvedSillyTavernConfig = {
  outputSubdir: string;
  exportSubdir: string;
  defaultExcerptChars: number;
  maxExcerptChars: number;
  maxSummaryEntries: number;
};

function resolveConfig(context: SillyTavernCardToolContext): ResolvedSillyTavernConfig {
  return {
    outputSubdir: context.config?.output_subdir ?? "cards/sillytavern",
    exportSubdir: context.config?.export_subdir ?? "exports/sillytavern",
    defaultExcerptChars: context.config?.default_excerpt_chars ?? 2000,
    maxExcerptChars: context.config?.max_excerpt_chars ?? 4000,
    maxSummaryEntries: context.config?.max_summary_entries ?? 20,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_FIELDS = [
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "creator",
  "character_version",
] as const;
const BOOK_ENTRY_TEXT_FIELDS = ["content", "comment", "name"] as const;
const BOOK_ENTRY_POSITION_VALUES = ["before_char", "after_char"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TextFieldName = (typeof TEXT_FIELDS)[number];
type BookEntryTextFieldName = (typeof BOOK_ENTRY_TEXT_FIELDS)[number];
type CardView =
  | "summary"
  | "field_excerpt"
  | "alternate_greeting_excerpt"
  | "book_index"
  | "book_entry_excerpt"
  | "export_text"
  | "export_card_json";
type CardSourceFormat = "png" | "json";

type CardInput = {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  character_book?: {
    name?: string;
    description?: string;
    scan_depth?: number;
    token_budget?: number;
    recursive_scanning?: boolean;
    entries?: Array<{
      keys: string[];
      content: string;
      extensions?: Record<string, unknown>;
      enabled?: boolean;
      insertion_order?: number;
      case_sensitive?: boolean;
      name?: string;
      priority?: number;
      id?: number;
      comment?: string;
      selective?: boolean;
      secondary_keys?: string[];
      constant?: boolean;
      position?: (typeof BOOK_ENTRY_POSITION_VALUES)[number];
    }>;
    extensions?: Record<string, unknown>;
  };
  tags?: string[];
  creator?: string;
  character_version?: string;
  extensions?: Record<string, unknown>;
};

type BookEntryInput = NonNullable<NonNullable<CardInput["character_book"]>["entries"]>[number];

type CardCreateParams = {
  imagePath?: string;
  imageUrl?: string;
  card: CardInput;
  outputPath?: string;
  draftOutputPath?: string;
  overwrite?: boolean;
};

type CardReadParams = {
  path: string;
  view?: CardView;
  field?: TextFieldName;
  greetingIndex?: number;
  entryId?: number;
  entryIndex?: number;
  entryField?: BookEntryTextFieldName;
  offset?: number;
  maxChars?: number;
  outputPath?: string;
  entryOffset?: number;
  entryLimit?: number;
};

type CardEditParams = {
  path: string;
  outputPath?: string;
  draftOutputPath?: string;
  overwrite?: boolean;
  operations: EditOperation[];
};

type EditOperation =
  | {
      op: "set_field" | "append_field";
      field: TextFieldName;
      value: string;
    }
  | {
      op: "set_field_from_file";
      field: TextFieldName;
      sourcePath: string;
    }
  | {
      op: "replace_range";
      field: TextFieldName;
      start: number;
      end: number;
      value: string;
    }
  | {
      op: "set_tags";
      tags: string[];
    }
  | {
      op: "add_alt_greeting";
      value: string;
      index?: number;
    }
  | {
      op: "update_alt_greeting";
      index: number;
      value?: string;
      sourcePath?: string;
    }
  | {
      op: "remove_alt_greeting";
      index: number;
    }
  | {
      op: "add_book_entry";
      entry: BookEntryInput;
      index?: number;
    }
  | {
      op: "update_book_entry";
      entryId?: number;
      entryIndex?: number;
      entry: Partial<BookEntryInput>;
      contentSourcePath?: string;
      commentSourcePath?: string;
      nameSourcePath?: string;
    }
  | {
      op: "remove_book_entry";
      entryId?: number;
      entryIndex?: number;
    }
  | {
      op: "replace_image";
      imagePath?: string;
      imageUrl?: string;
    };

type ParsedCardFile = {
  absolutePath: string;
  workspacePath: string;
  sourceFormat: CardSourceFormat;
  rawCard: unknown;
  normalizedCard: V2;
  imagePngBuffer?: Buffer;
};

type TextTarget =
  | { kind: "field"; field: TextFieldName }
  | { kind: "alternate_greeting"; index: number }
  | { kind: "book_entry"; entryIndex: number; entryId?: number; field: BookEntryTextFieldName };

type TextMetrics = {
  chars: number;
  lines: number;
};

type ExcerptWindow = {
  text: string;
  offset: number;
  endOffset: number;
  totalChars: number;
  totalLines: number;
  returnedChars: number;
  returnedLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
};

type ImageLoadResult = {
  pngBuffer: Buffer;
  sourceDescription: string;
  width?: number;
  height?: number;
  originalFormat?: string;
};

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const CardInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "Character name." }),
    description: Type.Optional(Type.String()),
    personality: Type.Optional(Type.String()),
    scenario: Type.Optional(Type.String()),
    first_mes: Type.Optional(Type.String({ description: "Opening message." })),
    mes_example: Type.Optional(Type.String({ description: "Example dialogue." })),
    creator_notes: Type.Optional(Type.String()),
    system_prompt: Type.Optional(Type.String()),
    post_history_instructions: Type.Optional(Type.String()),
    alternate_greetings: Type.Optional(Type.Array(Type.String())),
    character_book: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          scan_depth: Type.Optional(Type.Integer({ minimum: 0 })),
          token_budget: Type.Optional(Type.Integer({ minimum: 0 })),
          recursive_scanning: Type.Optional(Type.Boolean()),
          entries: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  keys: Type.Array(Type.String(), { minItems: 1 }),
                  content: Type.String(),
                  extensions: Type.Optional(Type.Record(Type.String(), Type.Any())),
                  enabled: Type.Optional(Type.Boolean()),
                  insertion_order: Type.Optional(Type.Integer()),
                  case_sensitive: Type.Optional(Type.Boolean()),
                  name: Type.Optional(Type.String()),
                  priority: Type.Optional(Type.Integer()),
                  id: Type.Optional(Type.Integer()),
                  comment: Type.Optional(Type.String()),
                  selective: Type.Optional(Type.Boolean()),
                  secondary_keys: Type.Optional(Type.Array(Type.String())),
                  constant: Type.Optional(Type.Boolean()),
                  position: Type.Optional(
                    Type.Unsafe<(typeof BOOK_ENTRY_POSITION_VALUES)[number]>({
                      type: "string",
                      enum: [...BOOK_ENTRY_POSITION_VALUES],
                    }),
                  ),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          extensions: Type.Optional(Type.Record(Type.String(), Type.Any())),
        },
        { additionalProperties: false },
      ),
    ),
    tags: Type.Optional(Type.Array(Type.String())),
    creator: Type.Optional(Type.String()),
    character_version: Type.Optional(Type.String()),
    extensions: Type.Optional(Type.Record(Type.String(), Type.Any())),
  },
  { additionalProperties: false },
);

const CardCreateSchema = Type.Object(
  {
    imagePath: Type.Optional(
      Type.String({
        description: "Path to a source image. Relative paths resolve under the agent workspace.",
      }),
    ),
    imageUrl: Type.Optional(
      Type.String({
        description: "HTTP(S) URL for the source image.",
      }),
    ),
    card: CardInputSchema,
    outputPath: Type.Optional(
      Type.String({
        description:
          "Workspace-relative output PNG path. Defaults to <outputSubdir>/<sanitized-name>.png.",
      }),
    ),
    draftOutputPath: Type.Optional(
      Type.String({
        description:
          "Optional workspace-relative JSON sidecar path. If set, the normalized full card JSON is also written there.",
      }),
    ),
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CardReadSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to a SillyTavern card PNG or JSON file. Relative paths resolve under the agent workspace.",
    }),
    view: Type.Optional(
      Type.Unsafe<CardView>({
        type: "string",
        enum: [
          "summary",
          "field_excerpt",
          "alternate_greeting_excerpt",
          "book_index",
          "book_entry_excerpt",
          "export_text",
          "export_card_json",
        ],
        description:
          "summary shows bounded stats only. Excerpt views page through one text target at a time. export_text writes one full text target to a workspace file. export_card_json writes the normalized full card JSON to a workspace file.",
      }),
    ),
    field: Type.Optional(
      Type.Unsafe<TextFieldName>({
        type: "string",
        enum: [...TEXT_FIELDS],
        description: "Used with field_excerpt or export_text when targeting a top-level text field.",
      }),
    ),
    greetingIndex: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Used with alternate_greeting_excerpt or export_text for a specific alternate greeting.",
      }),
    ),
    entryId: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Optional character book entry ID. Use entryId or entryIndex for book entry reads.",
      }),
    ),
    entryIndex: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Optional character book entry index. Use entryId or entryIndex for book entry reads.",
      }),
    ),
    entryField: Type.Optional(
      Type.Unsafe<BookEntryTextFieldName>({
        type: "string",
        enum: [...BOOK_ENTRY_TEXT_FIELDS],
        description: "Which book entry text field to inspect. Default: content.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "Character offset for excerpt views. Use the nextOffset returned by the previous call to continue reading.",
      }),
    ),
    maxChars: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Maximum characters to return for excerpt views. The tool clamps this to maxExcerptChars.",
      }),
    ),
    outputPath: Type.Optional(
      Type.String({
        description:
          "Workspace-relative output file path for export_text or export_card_json. Defaults under exportSubdir.",
      }),
    ),
    entryOffset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Starting book entry offset for view='book_index'.",
      }),
    ),
    entryLimit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Maximum book entry summaries to return for view='book_index'. Defaults to maxSummaryEntries.",
      }),
    ),
  },
  { additionalProperties: false },
);

const EditOperationSchema = Type.Object(
  {
    op: Type.String({
      description:
        "Edit operation. Supported values: set_field, append_field, set_field_from_file, replace_range, set_tags, add_alt_greeting, update_alt_greeting, remove_alt_greeting, add_book_entry, update_book_entry, remove_book_entry, replace_image.",
    }),
    field: Type.Optional(Type.Unsafe<TextFieldName>({ type: "string", enum: [...TEXT_FIELDS] })),
    value: Type.Optional(Type.String()),
    sourcePath: Type.Optional(Type.String()),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    end: Type.Optional(Type.Integer({ minimum: 0 })),
    tags: Type.Optional(Type.Array(Type.String())),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    entryId: Type.Optional(Type.Integer({ minimum: 0 })),
    entryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    entry: Type.Optional(Type.Any()),
    contentSourcePath: Type.Optional(Type.String()),
    commentSourcePath: Type.Optional(Type.String()),
    nameSourcePath: Type.Optional(Type.String()),
    imagePath: Type.Optional(Type.String()),
    imageUrl: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CardEditSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to an existing SillyTavern card PNG or JSON file. Relative paths resolve under the agent workspace.",
    }),
    outputPath: Type.Optional(
      Type.String({
        description:
          "Workspace-relative output path. Defaults to overwriting the input path when it is inside the workspace.",
      }),
    ),
    draftOutputPath: Type.Optional(
      Type.String({
        description:
          "Optional workspace-relative JSON sidecar path to write the normalized full card JSON after edits.",
      }),
    ),
    overwrite: Type.Optional(Type.Boolean()),
    operations: Type.Array(EditOperationSchema, {
      minItems: 1,
      description:
        "Patch operations. Large rewrites should prefer *_from_file variants so the model can export text to a file, edit it there, and then apply it without dumping the full field back into context.",
    }),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createSillyTavernCardCreateTool(context: SillyTavernCardToolContext): AgentTool {
  const resolvedConfig = resolveConfig(context);
  return {
    name: "sillytavern_card_create",
    label: "SillyTavern Card Create",
    description:
      "Create a SillyTavern-compatible character card PNG from a structured V2-style card definition plus an image path or image URL. " +
      "This tool is a deterministic renderer/writer: the model should think through the card definition first, then call the tool with structured fields. " +
      "It can also write a normalized JSON sidecar draft into the workspace for longer multi-step workflows.",
    parameters: CardCreateSchema,
    execute: async (_toolCallId, rawParams) =>
      executeCreate({
        workspaceRoot: context.workspaceRoot,
        config: resolvedConfig,
        fetchClient: context.fetchClient,
        downloadSizeLimit: context.downloadSizeLimit,
        params: rawParams as CardCreateParams,
      }),
  };
}

export function createSillyTavernCardReadTool(context: SillyTavernCardToolContext): AgentTool {
  const resolvedConfig = resolveConfig(context);
  return {
    name: "sillytavern_card_read",
    label: "SillyTavern Card Read",
    description:
      "Read a SillyTavern card PNG or JSON file without dumping the whole card into model context. " +
      "Default summary mode reports structure plus per-field char and line counts. Excerpt modes return one bounded slice at a time with explicit truncation markers, nextOffset, and remaining counts. " +
      "When the full text is needed, export_text writes the selected field or lorebook entry to a workspace file instead of returning it inline.",
    parameters: CardReadSchema,
    execute: async (_toolCallId, rawParams) =>
      executeRead({
        workspaceRoot: context.workspaceRoot,
        config: resolvedConfig,
        params: rawParams as CardReadParams,
      }),
  };
}

export function createSillyTavernCardEditTool(context: SillyTavernCardToolContext): AgentTool {
  const resolvedConfig = resolveConfig(context);
  return {
    name: "sillytavern_card_edit",
    label: "SillyTavern Card Edit",
    description:
      "Edit an existing SillyTavern card with patch-style operations instead of rewriting the entire card. " +
      "Use sillytavern_card_read first to inspect bounded summaries or excerpts, then apply targeted operations such as set_field, set_field_from_file, add/update/remove lorebook entries, or replace_image. " +
      "This keeps large fields out of the model context while still allowing precise edits.",
    parameters: CardEditSchema,
    execute: async (_toolCallId, rawParams) =>
      executeEdit({
        workspaceRoot: context.workspaceRoot,
        config: resolvedConfig,
        fetchClient: context.fetchClient,
        downloadSizeLimit: context.downloadSizeLimit,
        params: rawParams as CardEditParams,
      }),
  };
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

async function executeCreate(input: {
  workspaceRoot: string;
  config: ResolvedSillyTavernConfig;
  fetchClient: ConcurrencyLimitedFetchClient;
  downloadSizeLimit: number;
  params: CardCreateParams;
}) {
  const workspaceRoot = input.workspaceRoot;
  const normalizedCard = normalizeInputCard(input.params.card);
  const image = await loadImageSource({
    workspaceRoot,
    imagePath: input.params.imagePath,
    imageUrl: input.params.imageUrl,
    fetchClient: input.fetchClient,
    downloadSizeLimit: input.downloadSizeLimit,
  });

  const cardPng = embedCardIntoPng(image.pngBuffer, normalizedCard);
  const defaultOutputPath = path.posix.join(
    input.config.outputSubdir,
    `${sanitizeFileBaseName(normalizedCard.data.name) ?? "character-card"}.png`,
  );
  const output = await resolveWorkspaceWritePath({
    workspaceRoot,
    requestedPath: input.params.outputPath,
    defaultPath: defaultOutputPath,
    overwrite: input.params.overwrite ?? false,
  });
  await fs.mkdir(path.dirname(output.absolutePath), { recursive: true });
  await fs.writeFile(output.absolutePath, cardPng);

  let draftWorkspacePath: string | undefined;
  if (input.params.draftOutputPath) {
    const draft = await resolveWorkspaceWritePath({
      workspaceRoot,
      requestedPath: input.params.draftOutputPath,
      defaultPath: path.posix.join(
        input.config.exportSubdir,
        `${sanitizeFileBaseName(normalizedCard.data.name) ?? "character-card"}.json`,
      ),
      overwrite: input.params.overwrite ?? false,
    });
    await fs.mkdir(path.dirname(draft.absolutePath), { recursive: true });
    await fs.writeFile(draft.absolutePath, JSON.stringify(normalizedCard, null, 2));
    draftWorkspacePath = draft.workspacePath;
  }

  const summary = buildCardSummary(normalizedCard, input.config);
  const lines = [
    "## SillyTavern Card Create",
    "",
    `Created a SillyTavern card PNG at \`${output.workspacePath}\`.`,
    "",
    "How this worked:",
    `- normalized the structured card input to Character Card V2`,
    `- loaded the source image from ${image.sourceDescription}`,
    `- converted the image to PNG${image.originalFormat ? ` (source format: ${image.originalFormat})` : ""}`,
    `- embedded the normalized card JSON into the PNG metadata`,
    `- wrote the card inside the agent workspace`,
    ...(draftWorkspacePath ? [`- also wrote a normalized JSON sidecar at \`${draftWorkspacePath}\``] : []),
    "",
    "Summary:",
    `- name: ${normalizedCard.data.name}`,
    `- top-level text fields: ${summary.presentTextFields}/${TEXT_FIELDS.length} present`,
    `- alternate greetings: ${summary.alternateGreetingCount}`,
    `- character book entries: ${summary.bookEntryCount}`,
    `- tags: ${summary.tagsCount}`,
    ...(image.width && image.height ? [`- image size: ${image.width}x${image.height}`] : []),
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "create",
      workspacePath: output.workspacePath,
      draftWorkspacePath,
      summary,
      image: {
        source: image.sourceDescription,
        width: image.width ?? null,
        height: image.height ?? null,
        format: image.originalFormat ?? null,
      },
    },
  };
}

async function executeRead(input: {
  workspaceRoot: string;
  config: ResolvedSillyTavernConfig;
  params: CardReadParams;
}) {
  const workspaceRoot = input.workspaceRoot;
  const parsed = await loadCardFile(workspaceRoot, input.params.path);
  const view = input.params.view ?? "summary";

  if (view === "summary") {
    return buildReadSummaryResult(parsed, input.config);
  }

  if (view === "book_index") {
    return buildBookIndexResult(parsed, input.config, input.params);
  }

  if (view === "export_card_json") {
    return exportCardJson(parsed, input.config, workspaceRoot, input.params.outputPath);
  }

  if (view === "field_excerpt") {
    const field = requireField(input.params.field, "field_excerpt");
    return buildTextExcerptResult({
      parsed,
      config: input.config,
      target: { kind: "field", field },
      offset: input.params.offset ?? 0,
      maxChars: input.params.maxChars,
    });
  }

  if (view === "alternate_greeting_excerpt") {
    if (!Number.isInteger(input.params.greetingIndex)) {
      throw new Error("greetingIndex is required for view='alternate_greeting_excerpt'.");
    }
    return buildTextExcerptResult({
      parsed,
      config: input.config,
      target: { kind: "alternate_greeting", index: input.params.greetingIndex as number },
      offset: input.params.offset ?? 0,
      maxChars: input.params.maxChars,
    });
  }

  if (view === "book_entry_excerpt") {
    const resolved = resolveBookEntryTarget(parsed.normalizedCard, input.params.entryId, input.params.entryIndex);
    return buildTextExcerptResult({
      parsed,
      config: input.config,
      target: {
        kind: "book_entry",
        entryIndex: resolved.index,
        entryId: resolved.entry.id,
        field: input.params.entryField ?? "content",
      },
      offset: input.params.offset ?? 0,
      maxChars: input.params.maxChars,
    });
  }

  return exportTextTarget({
    parsed,
    config: input.config,
    workspaceRoot,
    params: input.params,
  });
}

async function executeEdit(input: {
  workspaceRoot: string;
  config: ResolvedSillyTavernConfig;
  fetchClient: ConcurrencyLimitedFetchClient;
  downloadSizeLimit: number;
  params: CardEditParams;
}) {
  const workspaceRoot = input.workspaceRoot;
  const parsed = await loadCardFile(workspaceRoot, input.params.path);
  let normalizedCard = deepCloneJson(parsed.normalizedCard) as V2;
  let imagePngBuffer = parsed.imagePngBuffer;
  const appliedOperations: string[] = [];

  for (const operation of input.params.operations) {
    switch (operation.op) {
      case "set_field":
        normalizedCard.data[operation.field] = operation.value;
        appliedOperations.push(`set ${operation.field}`);
        break;
      case "append_field":
        normalizedCard.data[operation.field] = `${normalizedCard.data[operation.field] ?? ""}${operation.value}`;
        appliedOperations.push(`append ${operation.field}`);
        break;
      case "set_field_from_file":
        normalizedCard.data[operation.field] = await readTextInputFile(workspaceRoot, operation.sourcePath);
        appliedOperations.push(`set ${operation.field} from file`);
        break;
      case "replace_range": {
        const current = normalizedCard.data[operation.field] ?? "";
        if (operation.start > operation.end || operation.end > current.length) {
          throw new Error(`Invalid replace_range bounds for field ${operation.field}.`);
        }
        normalizedCard.data[operation.field] =
          current.slice(0, operation.start) + operation.value + current.slice(operation.end);
        appliedOperations.push(`replace range in ${operation.field}`);
        break;
      }
      case "set_tags":
        normalizedCard.data.tags = normalizeStringArray(operation.tags, "tags");
        appliedOperations.push("set tags");
        break;
      case "add_alt_greeting": {
        const greetings = [...(normalizedCard.data.alternate_greetings ?? [])];
        const insertAt =
          operation.index == null ? greetings.length : clampInteger(operation.index, 0, greetings.length);
        greetings.splice(insertAt, 0, operation.value);
        normalizedCard.data.alternate_greetings = greetings;
        appliedOperations.push(`add alternate greeting at ${insertAt}`);
        break;
      }
      case "update_alt_greeting": {
        const greetings = [...(normalizedCard.data.alternate_greetings ?? [])];
        assertGreetingIndex(greetings, operation.index);
        greetings[operation.index] =
          operation.value ?? (await readTextInputFile(workspaceRoot, requireString(operation.sourcePath, "sourcePath")));
        normalizedCard.data.alternate_greetings = greetings;
        appliedOperations.push(`update alternate greeting ${operation.index}`);
        break;
      }
      case "remove_alt_greeting": {
        const greetings = [...(normalizedCard.data.alternate_greetings ?? [])];
        assertGreetingIndex(greetings, operation.index);
        greetings.splice(operation.index, 1);
        normalizedCard.data.alternate_greetings = greetings;
        appliedOperations.push(`remove alternate greeting ${operation.index}`);
        break;
      }
      case "add_book_entry": {
        const book = ensureCharacterBook(normalizedCard);
        const entry = normalizeBookEntryInput(operation.entry, book.entries.length);
        const insertAt =
          operation.index == null ? book.entries.length : clampInteger(operation.index, 0, book.entries.length);
        book.entries.splice(insertAt, 0, entry);
        normalizedCard.data.character_book = book;
        appliedOperations.push(`add book entry at ${insertAt}`);
        break;
      }
      case "update_book_entry": {
        const resolved = resolveBookEntryTarget(normalizedCard, operation.entryId, operation.entryIndex);
        const merged = {
          ...(deepCloneJson(resolved.entry) as BookEntryInput),
          ...(deepCloneJson(operation.entry ?? {}) as Partial<BookEntryInput>),
        } as Partial<BookEntryInput>;
        if (operation.contentSourcePath) {
          merged.content = await readTextInputFile(workspaceRoot, operation.contentSourcePath);
        }
        if (operation.commentSourcePath) {
          merged.comment = await readTextInputFile(workspaceRoot, operation.commentSourcePath);
        }
        if (operation.nameSourcePath) {
          merged.name = await readTextInputFile(workspaceRoot, operation.nameSourcePath);
        }
        normalizedCard.data.character_book!.entries[resolved.index] = normalizeBookEntryInput(merged, resolved.index);
        appliedOperations.push(`update book entry ${resolved.index}`);
        break;
      }
      case "remove_book_entry": {
        const resolved = resolveBookEntryTarget(normalizedCard, operation.entryId, operation.entryIndex);
        normalizedCard.data.character_book!.entries.splice(resolved.index, 1);
        appliedOperations.push(`remove book entry ${resolved.index}`);
        break;
      }
      case "replace_image": {
        const image = await loadImageSource({
          workspaceRoot,
          imagePath: operation.imagePath,
          imageUrl: operation.imageUrl,
          fetchClient: input.fetchClient,
          downloadSizeLimit: input.downloadSizeLimit,
        });
        imagePngBuffer = image.pngBuffer;
        appliedOperations.push("replace image");
        break;
      }
      default:
        throw new Error(`Unsupported edit operation: ${(operation as { op: string }).op}`);
    }
  }

  normalizedCard = parseToV2(normalizedCard);

  const outputInfo = await resolveEditOutputPath({
    workspaceRoot,
    inputPath: parsed.workspacePath,
    requestedOutputPath: input.params.outputPath,
    sourceFormat: parsed.sourceFormat,
    overwrite: input.params.overwrite ?? false,
  });

  if (outputInfo.format === "png") {
    if (!imagePngBuffer) {
      throw new Error("Cannot write a PNG card without an image. Use replace_image or start from a PNG card.");
    }
    const outputPng = embedCardIntoPng(imagePngBuffer, normalizedCard);
    await fs.mkdir(path.dirname(outputInfo.absolutePath), { recursive: true });
    await fs.writeFile(outputInfo.absolutePath, outputPng);
  } else {
    await fs.mkdir(path.dirname(outputInfo.absolutePath), { recursive: true });
    await fs.writeFile(outputInfo.absolutePath, JSON.stringify(normalizedCard, null, 2));
  }

  let draftWorkspacePath: string | undefined;
  if (input.params.draftOutputPath) {
    const draft = await resolveWorkspaceWritePath({
      workspaceRoot,
      requestedPath: input.params.draftOutputPath,
      defaultPath: path.posix.join(
        input.config.exportSubdir,
        `${sanitizeFileBaseName(normalizedCard.data.name) ?? "character-card"}.json`,
      ),
      overwrite: input.params.overwrite ?? false,
    });
    await fs.mkdir(path.dirname(draft.absolutePath), { recursive: true });
    await fs.writeFile(draft.absolutePath, JSON.stringify(normalizedCard, null, 2));
    draftWorkspacePath = draft.workspacePath;
  }

  const summary = buildCardSummary(normalizedCard, input.config);
  const lines = [
    "## SillyTavern Card Edit",
    "",
    `Wrote the edited card to \`${outputInfo.workspacePath}\`.`,
    "",
    "How this worked:",
    `- loaded the existing ${parsed.sourceFormat.toUpperCase()} card from \`${parsed.workspacePath}\``,
    `- applied ${appliedOperations.length} patch operation${appliedOperations.length === 1 ? "" : "s"}`,
    `- validated the result as Character Card V2`,
    `- wrote the updated ${outputInfo.format.toUpperCase()} artifact inside the agent workspace`,
    ...(draftWorkspacePath ? [`- also wrote a normalized JSON sidecar at \`${draftWorkspacePath}\``] : []),
    "",
    "Applied operations:",
    ...appliedOperations.map((value) => `- ${value}`),
    "",
    "Summary:",
    `- name: ${normalizedCard.data.name}`,
    `- alternate greetings: ${summary.alternateGreetingCount}`,
    `- character book entries: ${summary.bookEntryCount}`,
    `- tags: ${summary.tagsCount}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "edit",
      workspacePath: outputInfo.workspacePath,
      draftWorkspacePath,
      format: outputInfo.format,
      operations: appliedOperations,
      summary,
    },
  };
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

function buildReadSummaryResult(parsed: ParsedCardFile, config: ResolvedSillyTavernConfig) {
  const summary = buildCardSummary(parsed.normalizedCard, config);
  const lines = [
    "## SillyTavern Card Summary",
    "",
    "This view returns structure and per-field sizes only. It does not inline large text bodies.",
    "",
    `Source: \`${parsed.workspacePath}\` (${parsed.sourceFormat.toUpperCase()})`,
    `Spec: ${parsed.normalizedCard.spec} ${parsed.normalizedCard.spec_version}`,
    "",
    "Top-level text fields:",
    ...TEXT_FIELDS.map((field) => {
      const stats = summary.fieldStats[field];
      return `- ${field}: chars=${stats.chars}, lines=${stats.lines}, present=${stats.present ? "yes" : "no"}`;
    }),
    "",
    `Alternate greetings: ${summary.alternateGreetingCount}`,
    ...summary.alternateGreetingSummaries.map(
      (item) => `- [${item.index}]: chars=${item.chars}, lines=${item.lines}`,
    ),
    ...(summary.alternateGreetingRemaining > 0
      ? [`- ... ${summary.alternateGreetingRemaining} more alternate greeting entries not shown in summary`]
      : []),
    "",
    `Character book entries: ${summary.bookEntryCount}`,
    ...summary.bookEntrySummaries.map(
      (item) =>
        `- [${item.index}] id=${item.id ?? "(none)"} enabled=${item.enabled ? "yes" : "no"} keys=${item.keyCount} contentChars=${item.contentChars} contentLines=${item.contentLines}`,
    ),
    ...(summary.bookEntryRemaining > 0
      ? [`- ... ${summary.bookEntryRemaining} more character book entries not shown in summary`]
      : []),
    "",
    `Tags: ${summary.tagsCount}`,
    `Extensions namespaces: ${summary.extensionKeys.length > 0 ? summary.extensionKeys.join(", ") : "(none)"}`,
    "",
    "Next steps:",
    '- Use `view: "field_excerpt"` for one top-level text field.',
    '- Use `view: "alternate_greeting_excerpt"` for one alternate greeting.',
    '- Use `view: "book_index"` to page through lorebook entry summaries.',
    '- Use `view: "book_entry_excerpt"` for one lorebook field.',
    '- Use `view: "export_text"` or `view: "export_card_json"` when you need the full data in a workspace file instead of model context.',
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "read",
      view: "summary",
      source: parsed.workspacePath,
      format: parsed.sourceFormat,
      summary,
    },
  };
}

function buildBookIndexResult(parsed: ParsedCardFile, config: ResolvedSillyTavernConfig, params: CardReadParams) {
  const entries = parsed.normalizedCard.data.character_book?.entries ?? [];
  const offset = clampInteger(params.entryOffset ?? 0, 0, entries.length);
  const limit = clampInteger(params.entryLimit ?? config.maxSummaryEntries, 1, config.maxSummaryEntries);
  const slice = entries.slice(offset, offset + limit);
  const remaining = Math.max(entries.length - (offset + slice.length), 0);

  const lines = [
    "## SillyTavern Card Book Index",
    "",
    `Source: \`${parsed.workspacePath}\``,
    `Entries returned: ${slice.length} of ${entries.length}`,
    `Offset: ${offset}`,
    ...(remaining > 0 ? [`Remaining after this page: ${remaining}`] : []),
    "",
    ...slice.map((entry, localIndex) => {
      const index = offset + localIndex;
      const contentStats = getTextMetrics(entry.content);
      const nameStats = getTextMetrics(entry.name ?? "");
      const commentStats = getTextMetrics(entry.comment ?? "");
      return `- [${index}] id=${entry.id ?? "(none)"} enabled=${entry.enabled ? "yes" : "no"} insertion_order=${entry.insertion_order} keys=${entry.keys.length} contentChars=${contentStats.chars} contentLines=${contentStats.lines} nameChars=${nameStats.chars} nameLines=${nameStats.lines} commentChars=${commentStats.chars} commentLines=${commentStats.lines}`;
    }),
    "",
    "Use `entryOffset` with another `book_index` call to continue, or `book_entry_excerpt` / `export_text` to inspect a specific entry field.",
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "read",
      view: "book_index",
      source: parsed.workspacePath,
      offset,
      limit,
      remaining,
      entries: slice.map((entry, localIndex) => ({
        index: offset + localIndex,
        id: entry.id ?? null,
        enabled: entry.enabled,
        insertionOrder: entry.insertion_order,
        keyCount: entry.keys.length,
        content: getTextMetrics(entry.content),
        name: getTextMetrics(entry.name ?? ""),
        comment: getTextMetrics(entry.comment ?? ""),
      })),
    },
  };
}

function buildTextExcerptResult(input: {
  parsed: ParsedCardFile;
  config: ResolvedSillyTavernConfig;
  target: TextTarget;
  offset: number;
  maxChars?: number;
}) {
  const resolved = resolveTextTarget(input.parsed.normalizedCard, input.target);
  const excerpt = buildExcerptWindow(
    resolved.text,
    input.offset,
    clampInteger(
      input.maxChars ?? input.config.defaultExcerptChars,
      1,
      input.config.maxExcerptChars,
    ),
  );
  const lines = [
    "## SillyTavern Card Excerpt",
    "",
    `Source: \`${input.parsed.workspacePath}\``,
    `Target: ${resolved.label}`,
    `Chars: ${excerpt.offset}-${excerpt.endOffset} of ${excerpt.totalChars}`,
    `Lines: ${excerpt.startLine}-${excerpt.endLine} of ${excerpt.totalLines}`,
    `Truncated: ${excerpt.truncated ? "YES" : "NO"}`,
    excerpt.truncated
      ? `[TRUNCATED: returned ${excerpt.returnedChars} of ${excerpt.totalChars} chars and ${excerpt.returnedLines} of ${excerpt.totalLines} lines from ${resolved.label}; use offset=${excerpt.endOffset} to continue, or export_text to write the full text to a workspace file.]`
      : "[COMPLETE: this call returned the full selected text target.]",
    "",
    excerpt.text,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "read",
      view: "excerpt",
      source: input.parsed.workspacePath,
      target: {
        kind: input.target.kind,
        label: resolved.label,
        field: "field" in input.target ? input.target.field : undefined,
        index: "index" in input.target ? input.target.index : undefined,
        entryIndex: "entryIndex" in input.target ? input.target.entryIndex : undefined,
        entryId: "entryId" in input.target ? input.target.entryId ?? null : null,
      },
      excerpt,
      nextOffset: excerpt.truncated ? excerpt.endOffset : null,
      remainingChars: Math.max(excerpt.totalChars - excerpt.endOffset, 0),
      remainingLines: Math.max(excerpt.totalLines - excerpt.endLine, 0),
    },
  };
}

async function exportTextTarget(input: {
  parsed: ParsedCardFile;
  config: ResolvedSillyTavernConfig;
  workspaceRoot: string;
  params: CardReadParams;
}) {
  const target = resolveExportTarget(input.parsed.normalizedCard, input.params);
  const resolved = resolveTextTarget(input.parsed.normalizedCard, target);
  const defaultPath = path.posix.join(
    input.config.exportSubdir,
    `${sanitizeFileBaseName(path.posix.basename(input.parsed.workspacePath, path.posix.extname(input.parsed.workspacePath))) ?? "card"}-${resolved.fileStem}.txt`,
  );
  const output = await resolveWorkspaceWritePath({
    workspaceRoot: input.workspaceRoot,
    requestedPath: input.params.outputPath,
    defaultPath,
    overwrite: false,
  });
  await fs.mkdir(path.dirname(output.absolutePath), { recursive: true });
  await fs.writeFile(output.absolutePath, resolved.text, "utf8");
  const metrics = getTextMetrics(resolved.text);

  const lines = [
    "## SillyTavern Card Export",
    "",
    `Exported ${resolved.label} to \`${output.workspacePath}\`.`,
    "",
    "How this worked:",
    `- loaded the card from \`${input.parsed.workspacePath}\``,
    `- resolved ${resolved.label}`,
    `- wrote the full text to a workspace file instead of returning it inline`,
    "",
    `Chars: ${metrics.chars}`,
    `Lines: ${metrics.lines}`,
  ];

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      action: "read",
      view: "export_text",
      source: input.parsed.workspacePath,
      target: resolved.label,
      workspacePath: output.workspacePath,
      chars: metrics.chars,
      lines: metrics.lines,
    },
  };
}

async function exportCardJson(
  parsed: ParsedCardFile,
  config: ResolvedSillyTavernConfig,
  workspaceRoot: string,
  outputPath: string | undefined,
) {
  const defaultPath = path.posix.join(
    config.exportSubdir,
    `${sanitizeFileBaseName(path.posix.basename(parsed.workspacePath, path.posix.extname(parsed.workspacePath))) ?? "card"}.json`,
  );
  const output = await resolveWorkspaceWritePath({
    workspaceRoot,
    requestedPath: outputPath,
    defaultPath,
    overwrite: false,
  });
  const jsonText = JSON.stringify(parsed.normalizedCard, null, 2);
  await fs.mkdir(path.dirname(output.absolutePath), { recursive: true });
  await fs.writeFile(output.absolutePath, jsonText, "utf8");
  const metrics = getTextMetrics(jsonText);

  return {
    content: [
      {
        type: "text" as const,
        text: [
          "## SillyTavern Card JSON Export",
          "",
          `Exported the normalized full card JSON to \`${output.workspacePath}\`.`,
          `Chars: ${metrics.chars}`,
          `Lines: ${metrics.lines}`,
          "",
          "Use that workspace file for large review or edit workflows instead of pulling the entire card into model context.",
        ].join("\n"),
      },
    ],
    details: {
      action: "read",
      view: "export_card_json",
      source: parsed.workspacePath,
      workspacePath: output.workspacePath,
      chars: metrics.chars,
      lines: metrics.lines,
    },
  };
}

// ---------------------------------------------------------------------------
// Card summary
// ---------------------------------------------------------------------------

function buildCardSummary(card: V2, config: ResolvedSillyTavernConfig) {
  const fieldStats = Object.fromEntries(
    TEXT_FIELDS.map((field) => {
      const value = card.data[field] ?? "";
      const metrics = getTextMetrics(value);
      return [
        field,
        {
          present: value.length > 0,
          ...metrics,
        },
      ];
    }),
  ) as Record<TextFieldName, { present: boolean; chars: number; lines: number }>;

  const alternateGreetings = card.data.alternate_greetings ?? [];
  const bookEntries = card.data.character_book?.entries ?? [];

  return {
    presentTextFields: TEXT_FIELDS.filter((field) => fieldStats[field].present).length,
    fieldStats,
    alternateGreetingCount: alternateGreetings.length,
    alternateGreetingSummaries: alternateGreetings.slice(0, config.maxSummaryEntries).map((value, index) => ({
      index,
      ...getTextMetrics(value),
    })),
    alternateGreetingRemaining: Math.max(alternateGreetings.length - config.maxSummaryEntries, 0),
    bookEntryCount: bookEntries.length,
    bookEntrySummaries: bookEntries.slice(0, config.maxSummaryEntries).map((entry, index) => ({
      index,
      id: entry.id ?? null,
      enabled: entry.enabled,
      keyCount: entry.keys.length,
      contentChars: getTextMetrics(entry.content).chars,
      contentLines: getTextMetrics(entry.content).lines,
    })),
    bookEntryRemaining: Math.max(bookEntries.length - config.maxSummaryEntries, 0),
    tagsCount: card.data.tags.length,
    extensionKeys: Object.keys(card.data.extensions ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Text excerpt helpers
// ---------------------------------------------------------------------------

function buildExcerptWindow(text: string, offset: number, maxChars: number): ExcerptWindow {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be an integer >= 0.");
  }
  const totalChars = text.length;
  if (offset > totalChars) {
    throw new Error(`offset ${offset} is beyond the end of the text (${totalChars} chars).`);
  }
  const clampedMaxChars = Math.max(1, maxChars);
  const slice = text.slice(offset, offset + clampedMaxChars);
  const endOffset = offset + slice.length;
  const totalLines = countLines(text);
  const startLine = slice.length > 0 ? lineNumberAtOffset(text, offset) : totalLines;
  const endLine = slice.length > 0 ? lineNumberAtOffset(text, Math.max(endOffset - 1, offset)) : totalLines;
  return {
    text: slice,
    offset,
    endOffset,
    totalChars,
    totalLines,
    returnedChars: slice.length,
    returnedLines: countLines(slice),
    startLine,
    endLine,
    truncated: endOffset < totalChars,
  };
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      count += 1;
    }
  }
  return count;
}

function lineNumberAtOffset(text: string, offset: number): number {
  if (!text) {
    return 0;
  }
  const clamped = clampInteger(offset, 0, Math.max(text.length - 1, 0));
  let line = 1;
  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function getTextMetrics(text: string): TextMetrics {
  return {
    chars: text.length,
    lines: countLines(text),
  };
}

// ---------------------------------------------------------------------------
// Card normalization
// ---------------------------------------------------------------------------

function normalizeInputCard(input: CardInput): V2 {
  const normalized = {
    spec: "chara_card_v2" as const,
    spec_version: "2.0",
    data: {
      name: requireNonEmptyString(input.name, "card.name"),
      description: input.description ?? "",
      personality: input.personality ?? "",
      scenario: input.scenario ?? "",
      first_mes: input.first_mes ?? "",
      mes_example: input.mes_example ?? "",
      creator_notes: input.creator_notes ?? "",
      system_prompt: input.system_prompt ?? "",
      post_history_instructions: input.post_history_instructions ?? "",
      alternate_greetings: normalizeStringArray(input.alternate_greetings ?? [], "card.alternate_greetings"),
      character_book: input.character_book
        ? {
            name: normalizeOptionalString(input.character_book.name),
            description: normalizeOptionalString(input.character_book.description),
            scan_depth: normalizeOptionalInteger(input.character_book.scan_depth, "card.character_book.scan_depth"),
            token_budget: normalizeOptionalInteger(input.character_book.token_budget, "card.character_book.token_budget"),
            recursive_scanning:
              typeof input.character_book.recursive_scanning === "boolean"
                ? input.character_book.recursive_scanning
                : false,
            entries: (input.character_book.entries ?? []).map((entry, index) => normalizeBookEntryInput(entry, index)),
            extensions: normalizeJsonObject(input.character_book.extensions),
          }
        : undefined,
      tags: normalizeStringArray(input.tags ?? [], "card.tags"),
      creator: input.creator ?? "",
      character_version: input.character_version ?? "",
      extensions: normalizeJsonObject(input.extensions),
    },
  };
  return parseToV2(normalized);
}

function normalizeBookEntryInput(input: Partial<BookEntryInput>, index: number): CharacterBookEntry {
  return {
    keys: normalizeStringArray(input.keys ?? [], "character_book.entries.keys", true),
    content: requireString(input.content ?? "", "character_book.entries.content"),
    extensions: normalizeJsonObject(input.extensions),
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    insertion_order:
      typeof input.insertion_order === "number" && Number.isInteger(input.insertion_order)
        ? input.insertion_order
        : index,
    case_sensitive: typeof input.case_sensitive === "boolean" ? input.case_sensitive : undefined,
    name: normalizeOptionalString(input.name),
    priority:
      typeof input.priority === "number" && Number.isInteger(input.priority) ? input.priority : undefined,
    id: typeof input.id === "number" && Number.isInteger(input.id) ? input.id : undefined,
    comment: normalizeOptionalString(input.comment),
    selective: typeof input.selective === "boolean" ? input.selective : undefined,
    secondary_keys: input.secondary_keys ? normalizeStringArray(input.secondary_keys, "secondary_keys") : undefined,
    constant: typeof input.constant === "boolean" ? input.constant : undefined,
    position:
      input.position && BOOK_ENTRY_POSITION_VALUES.includes(input.position)
        ? input.position
        : undefined,
  };
}

function normalizeLoadedCard(rawCard: unknown): V2 {
  try {
    return parseToV2(rawCard);
  } catch (error) {
    const backfilled = backfillLooseV2Card(rawCard);
    if (backfilled === rawCard) {
      throw error;
    }
    return parseToV2(backfilled);
  }
}

function backfillLooseV2Card(rawCard: unknown): unknown {
  if (!isRecord(rawCard) || rawCard.spec !== "chara_card_v2" || !isRecord(rawCard.data)) {
    return rawCard;
  }

  const rawData = rawCard.data;
  const characterBook = isRecord(rawData.character_book) ? rawData.character_book : undefined;
  const rawEntries = Array.isArray(characterBook?.entries) ? characterBook.entries : undefined;

  return {
    ...rawCard,
    spec_version: typeof rawCard.spec_version === "string" ? rawCard.spec_version : "2.0",
    data: {
      ...rawData,
      description: typeof rawData.description === "string" ? rawData.description : "",
      personality: typeof rawData.personality === "string" ? rawData.personality : "",
      scenario: typeof rawData.scenario === "string" ? rawData.scenario : "",
      first_mes: typeof rawData.first_mes === "string" ? rawData.first_mes : "",
      mes_example: typeof rawData.mes_example === "string" ? rawData.mes_example : "",
      creator_notes: typeof rawData.creator_notes === "string" ? rawData.creator_notes : "",
      system_prompt: typeof rawData.system_prompt === "string" ? rawData.system_prompt : "",
      post_history_instructions:
        typeof rawData.post_history_instructions === "string" ? rawData.post_history_instructions : "",
      alternate_greetings: Array.isArray(rawData.alternate_greetings) ? rawData.alternate_greetings : [],
      tags: Array.isArray(rawData.tags) ? rawData.tags : [],
      creator: typeof rawData.creator === "string" ? rawData.creator : "",
      character_version: typeof rawData.character_version === "string" ? rawData.character_version : "",
      extensions: isRecord(rawData.extensions) ? rawData.extensions : {},
      character_book: characterBook
        ? {
            ...characterBook,
            extensions: isRecord(characterBook.extensions) ? characterBook.extensions : {},
            entries: rawEntries?.map((entry, index) => {
              if (!isRecord(entry)) {
                return entry;
              }
              return {
                ...entry,
                extensions: isRecord(entry.extensions) ? entry.extensions : {},
                enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
                insertion_order:
                  typeof entry.insertion_order === "number" && Number.isInteger(entry.insertion_order)
                    ? entry.insertion_order
                    : index,
              };
            }) ?? [],
          }
        : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// PNG encode/decode
// ---------------------------------------------------------------------------

function decodeCardFromPng(buffer: Buffer): unknown {
  validatePngChunkSizes(buffer);
  const chunks = extractPngChunks(new Uint8Array(buffer));
  for (const chunk of chunks) {
    if (chunk.name !== "tEXt") {
      continue;
    }
    let decoded: { keyword: string; text: string };
    try {
      decoded = pngTextChunk.decode(Buffer.from(chunk.data));
    } catch {
      // A malformed tEXt chunk elsewhere in the file must not prevent us from
      // finding the chara chunk we actually care about. Skip undecodable
      // chunks and keep searching.
      continue;
    }
    if (decoded.keyword !== "chara") {
      continue;
    }
    try {
      const jsonText = Buffer.from(decoded.text, "base64").toString("utf8");
      return JSON.parse(jsonText);
    } catch (error) {
      throw new Error(`Failed to decode embedded SillyTavern card metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("PNG does not contain a `chara` tEXt chunk with embedded card JSON.");
}

function embedCardIntoPng(pngBuffer: Buffer, card: V2): Buffer {
  validatePngChunkSizes(pngBuffer);
  const chunks = extractPngChunks(new Uint8Array(pngBuffer)).filter((chunk) => {
    if (chunk.name !== "tEXt") {
      return true;
    }
    // A tEXt chunk that fails to decode is, by definition, not the `chara`
    // chunk we want to strip. Preserve it rather than throwing — otherwise
    // a single malformed sibling chunk would block every edit.
    try {
      const decoded = pngTextChunk.decode(Buffer.from(chunk.data));
      return decoded.keyword !== "chara";
    } catch {
      return true;
    }
  });
  const payload = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  chunks.splice(chunks.length - 1, 0, pngTextChunk.encode("chara", payload));
  return Buffer.from(encodePngChunks(chunks));
}

// Pre-validate a PNG's chunk table before handing it to png-chunks-extract.
// That library reads each chunk's declared length and immediately allocates a
// Uint8Array of that size with no bounds check, so a 100-byte hostile PNG
// declaring `length = 0xFFFFFFFF` would request a 4 GiB allocation. We walk
// the table the same way the library does (read 4-byte big-endian length,
// then skip 4-byte name + data + 4-byte CRC) and reject:
//   - any single declared chunk-data length above 16 MiB
//   - any chunk whose record would extend past the buffer end
function validatePngChunkSizes(buffer: Buffer): void {
  if (buffer.length < PNG_SIGNATURE.length + 12) {
    // Not enough bytes for even a single chunk header + CRC; let
    // png-chunks-extract surface the underlying decode error.
    return;
  }
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > PNG_MAX_CHUNK_DATA_LENGTH) {
      throw new Error(
        `Refusing to parse PNG with oversized chunk declaration (${length} bytes > ${PNG_MAX_CHUNK_DATA_LENGTH} cap).`,
      );
    }
    // record = 4-byte length + 4-byte name + N-byte data + 4-byte CRC
    const recordEnd = offset + 4 + 4 + length + 4;
    if (recordEnd > buffer.length) {
      throw new Error(
        "Refusing to parse PNG with oversized chunk declaration (chunk extends past end of buffer).",
      );
    }
    const name =
      String.fromCharCode(buffer[offset + 4]!) +
      String.fromCharCode(buffer[offset + 5]!) +
      String.fromCharCode(buffer[offset + 6]!) +
      String.fromCharCode(buffer[offset + 7]!);
    offset = recordEnd;
    if (name === "IEND") {
      break;
    }
  }
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

async function loadCardFile(workspaceRoot: string, rawPath: string): Promise<ParsedCardFile> {
  const absolutePath = resolveReadablePath(workspaceRoot, rawPath);
  const buffer = await fs.readFile(absolutePath);
  if (isPngBuffer(buffer)) {
    const rawCard = decodeCardFromPng(buffer);
    const normalizedCard = normalizeLoadedCard(rawCard);
    return {
      absolutePath,
      workspacePath: toWorkspaceRelativePath(workspaceRoot, absolutePath),
      sourceFormat: "png",
      rawCard,
      normalizedCard,
      imagePngBuffer: buffer,
    };
  }

  const jsonText = buffer.toString("utf8");
  let rawCard: unknown;
  try {
    rawCard = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Card file ${rawPath} is neither a PNG with an embedded card nor valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    absolutePath,
    workspacePath: toWorkspaceRelativePath(workspaceRoot, absolutePath),
    sourceFormat: "json",
    rawCard,
    normalizedCard: normalizeLoadedCard(rawCard),
  };
}

// ---------------------------------------------------------------------------
// Image loading (adapted for ConcurrencyLimitedFetchClient)
// ---------------------------------------------------------------------------

async function loadImageSource(input: {
  workspaceRoot: string;
  imagePath?: string;
  imageUrl?: string;
  fetchClient: ConcurrencyLimitedFetchClient;
  downloadSizeLimit: number;
}): Promise<ImageLoadResult> {
  const hasPath = Boolean(input.imagePath);
  const hasUrl = Boolean(input.imageUrl);
  if (hasPath === hasUrl) {
    throw new Error("Provide exactly one of imagePath or imageUrl.");
  }

  let buffer: Buffer;
  let sourceDescription: string;

  if (input.imagePath) {
    const absolutePath = resolveReadablePath(input.workspaceRoot, input.imagePath);
    buffer = await fs.readFile(absolutePath);
    sourceDescription = `workspace/local path \`${toWorkspaceRelativePath(input.workspaceRoot, absolutePath)}\``;
  } else {
    const url = requireString(input.imageUrl ?? "", "imageUrl");
    // Block SSRF before any network call: same pattern as web_fetch /
    // set-profile / send-message. Prevents AWS metadata, RFC1918, and
    // localhost:<port> from being reachable via imageUrl.
    await assertPublicHttpUrl(url);
    const fetched = await input.fetchClient.fetch(url, { maxBytes: input.downloadSizeLimit });
    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      await unlink(fetched.path).catch(() => {});
      throw new Error(`Image fetch failed with HTTP ${fetched.statusCode}`);
    }
    try {
      buffer = await fs.readFile(fetched.path);
    } finally {
      await unlink(fetched.path).catch(() => {});
    }
    sourceDescription = `URL \`${input.imageUrl}\`${fetched.contentType ? ` (${fetched.contentType})` : ""}`;
  }

  // limitInputPixels caps librsvg/libvips rasterization. Without it, a
  // crafted SVG can demand multi-gigabyte rasters even though the source
  // buffer is tiny. Reuse the same constant the read_image and captioning
  // pipelines already enforce.
  const pipeline = sharp(buffer, { animated: false, limitInputPixels: SVG_MAX_INPUT_PIXELS });
  const metadata = await pipeline.metadata();
  if (!metadata.format) {
    throw new Error("The provided image could not be decoded.");
  }
  const pngBuffer = await pipeline.png().toBuffer();
  return {
    pngBuffer,
    sourceDescription,
    width: metadata.width,
    height: metadata.height,
    originalFormat: metadata.format,
  };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function resolveTextTarget(card: V2, target: TextTarget): { text: string; label: string; fileStem: string } {
  switch (target.kind) {
    case "field":
      return {
        text: card.data[target.field] ?? "",
        label: `field \`${target.field}\``,
        fileStem: target.field,
      };
    case "alternate_greeting": {
      const greetings = card.data.alternate_greetings ?? [];
      assertGreetingIndex(greetings, target.index);
      return {
        text: greetings[target.index],
        label: `alternate_greetings[${target.index}]`,
        fileStem: `alternate-greeting-${target.index}`,
      };
    }
    case "book_entry": {
      const entry = card.data.character_book?.entries[target.entryIndex];
      if (!entry) {
        throw new Error(`No character book entry exists at index ${target.entryIndex}.`);
      }
      return {
        text: (entry[target.field] ?? "") as string,
        label: `character_book.entries[${target.entryIndex}].${target.field}`,
        fileStem: `book-entry-${target.entryId ?? target.entryIndex}-${target.field}`,
      };
    }
  }
}

function resolveExportTarget(card: V2, params: CardReadParams): TextTarget {
  if (params.field) {
    return { kind: "field", field: params.field };
  }
  if (Number.isInteger(params.greetingIndex)) {
    return { kind: "alternate_greeting", index: params.greetingIndex as number };
  }
  const bookEntry = resolveBookEntryTarget(card, params.entryId, params.entryIndex);
  return {
    kind: "book_entry",
    entryIndex: bookEntry.index,
    entryId: bookEntry.entry.id,
    field: params.entryField ?? "content",
  };
}

function resolveBookEntryTarget(card: V2, entryId?: number, entryIndex?: number) {
  const entries = card.data.character_book?.entries ?? [];
  if (Number.isInteger(entryIndex)) {
    const entry = entries[entryIndex as number];
    if (!entry) {
      throw new Error(`No character book entry exists at index ${entryIndex}.`);
    }
    return { entry, index: entryIndex as number };
  }
  if (Number.isInteger(entryId)) {
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index === -1) {
      throw new Error(`No character book entry exists with id ${entryId}.`);
    }
    return { entry: entries[index], index };
  }
  throw new Error("entryId or entryIndex is required for book entry operations.");
}

// ---------------------------------------------------------------------------
// Edit helpers
// ---------------------------------------------------------------------------

function ensureCharacterBook(card: V2) {
  if (!card.data.character_book) {
    card.data.character_book = {
      entries: [],
      extensions: {},
    };
  }
  if (!card.data.character_book.entries) {
    card.data.character_book.entries = [];
  }
  if (!card.data.character_book.extensions) {
    card.data.character_book.extensions = {};
  }
  return card.data.character_book;
}

function assertGreetingIndex(greetings: string[], index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= greetings.length) {
    throw new Error(`alternate_greetings index ${index} is out of range.`);
  }
}

function requireField(field: TextFieldName | undefined, view: string): TextFieldName {
  if (!field) {
    throw new Error(`field is required for view='${view}'.`);
  }
  return field;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

function normalizeStringArray(values: string[], field: string, requireNonEmpty = false): string[] {
  return values.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${field}[${index}] must be a string.`);
    }
    if (requireNonEmpty && value.trim().length === 0) {
      throw new Error(`${field}[${index}] must not be empty.`);
    }
    return value;
  });
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extensions must be a JSON object.");
  }
  return deepCloneJson(value) as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string value.");
  }
  return value;
}

function normalizeOptionalInteger(value: unknown, field: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function requireNonEmptyString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

function resolveReadablePath(workspaceRoot: string, rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("A non-empty file path is required.");
  }
  // Mirror the write-side guard: reject absolute paths and `..` traversal,
  // then resolve under workspaceRoot and re-check containment. Before this,
  // any caller of `resolveReadablePath` (loadCardFile, loadImageSource,
  // readTextInputFile, and every *_from_file edit op) could read arbitrary
  // files via `/etc/passwd` or `../../something`.
  const portable = normalizeWorkspaceOutputPath(rawPath);
  const absolutePath = path.resolve(workspaceRoot, portable);
  assertPathInsideWorkspace(workspaceRoot, absolutePath);
  return absolutePath;
}

async function readTextInputFile(workspaceRoot: string, rawPath: string): Promise<string> {
  const absolutePath = resolveReadablePath(workspaceRoot, rawPath);
  // Stat first so we refuse oversized text fields without ever buffering them.
  // Card text fields are typically a few KB; 1 MiB is a generous ceiling.
  const stats = await fs.stat(absolutePath);
  if (stats.size > TEXT_INPUT_FILE_MAX_BYTES) {
    throw new Error(
      `Text input file ${rawPath} is ${stats.size} bytes, exceeding the ${TEXT_INPUT_FILE_MAX_BYTES}-byte limit.`,
    );
  }
  return fs.readFile(absolutePath, "utf8");
}

async function resolveEditOutputPath(input: {
  workspaceRoot: string;
  inputPath: string;
  requestedOutputPath?: string;
  sourceFormat: CardSourceFormat;
  overwrite: boolean;
}) {
  const defaultPath = input.requestedOutputPath ?? input.inputPath;
  const resolved = await resolveWorkspaceWritePath({
    workspaceRoot: input.workspaceRoot,
    requestedPath: defaultPath,
    defaultPath,
    overwrite: input.overwrite,
  });
  const format: CardSourceFormat = resolved.absolutePath.toLowerCase().endsWith(".json") ? "json" : "png";
  return {
    ...resolved,
    format,
  };
}

async function resolveWorkspaceWritePath(input: {
  workspaceRoot: string;
  requestedPath?: string;
  defaultPath: string;
  overwrite: boolean;
}) {
  const portable = normalizeWorkspaceOutputPath(input.requestedPath ?? input.defaultPath);
  let absolutePath = path.resolve(input.workspaceRoot, portable);
  assertPathInsideWorkspace(input.workspaceRoot, absolutePath);
  if (!input.overwrite) {
    absolutePath = await uniquifyPath(absolutePath);
  }
  return {
    absolutePath,
    workspacePath: toWorkspaceRelativePath(input.workspaceRoot, absolutePath),
  };
}

function normalizeWorkspaceOutputPath(rawPath: string): string {
  const portable = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!portable || portable === "." || portable === ".." || portable.startsWith("/") || portable.includes("../")) {
    throw new Error("Output paths must be safe workspace-relative paths.");
  }
  return portable;
}

function assertPathInsideWorkspace(workspaceRoot: string, absolutePath: string) {
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(rootWithSep)) {
    throw new Error("Refusing to write outside the workspace.");
  }
}

async function uniquifyPath(absolutePath: string): Promise<string> {
  const parsed = path.parse(absolutePath);
  let candidate = absolutePath;
  let counter = 1;
  while (await fileExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.startsWith("..") ? absolutePath : `./${relative.replace(/\\/g, "/")}`;
}

function sanitizeFileBaseName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || undefined;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
