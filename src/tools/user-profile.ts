import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface UserProfileToolContext {
  workspaceRoot: string;
  provider: string;
  senderId: string;
  senderDisplayName?: string;
  config?: {
    root_dir?: string;
    default_excerpt_chars?: number;
    max_excerpt_chars?: number;
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserProfileTargetInput = {
  mode?: "requester" | "explicit";
  provider?: string;
  senderId?: string;
  username?: string;
  displayName?: string;
};

type UserProfileReadParams = {
  target?: UserProfileTargetInput;
  view?: "exists" | "summary" | "excerpt";
  section?: string;
  maxChars?: number;
  offset?: number;
};

type UserProfileEditParams = {
  target?: UserProfileTargetInput;
  createIfMissing?: boolean;
  operations?: UserProfileEditOperation[];
};

type UserProfileEditOperation =
  | {
      op: "set_identity_fields";
      displayName?: string;
      username?: string;
      aliases?: string[];
    }
  | {
      op: "replace_section";
      section: string;
      text: string;
    }
  | {
      op: "append_bullets";
      section: string;
      lines: string[];
    }
  | {
      op: "append_paragraphs";
      section: string;
      paragraphs: string[];
    }
  | {
      op: "remove_bullets_matching";
      section: string;
      lines: string[];
    };

type ResolvedUserProfileTarget = {
  provider: string;
  senderId: string;
  username?: string;
  displayName?: string;
};

type UserProfileMetadata = {
  provider: string;
  senderId: string;
  username?: string;
  displayName?: string;
  aliases: string[];
  createdAt?: string;
  updatedAt: string;
  version: number;
};

type UserProfileDocument = {
  metadata: UserProfileMetadata;
  sections: Map<string, string>;
};

type ResolvedUserProfilePath = {
  absolutePath: string;
  workspacePath: string;
  exists: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SECTIONS = [
  "Summary",
  "Likes",
  "Dislikes",
  "Interests",
  "Facts",
  "Relationship Notes",
  "Recent Notes",
  "Open Questions",
] as const;

const SECTION_SET = new Set<string>(DEFAULT_SECTIONS);

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const TargetSchema = Type.Optional(
  Type.Object(
    {
      mode: Type.Optional(Type.Union([Type.Literal("requester"), Type.Literal("explicit")])),
      provider: Type.Optional(Type.String({ description: "Provider id such as matrix, discord, or telegram." })),
      senderId: Type.Optional(Type.String({ description: "Stable provider sender id, for example a Matrix mxid." })),
      username: Type.Optional(Type.String({ description: "Optional username/localpart hint for readability metadata." })),
      displayName: Type.Optional(Type.String({ description: "Optional display-name hint for metadata." })),
    },
    { additionalProperties: false },
  ),
);

const UserProfileReadSchema = Type.Object(
  {
    target: TargetSchema,
    view: Type.Optional(
      Type.Union([Type.Literal("exists"), Type.Literal("summary"), Type.Literal("excerpt")]),
    ),
    section: Type.Optional(Type.String({ description: "Section heading to read for excerpt mode." })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const EditOperationSchema = Type.Union([
  Type.Object(
    {
      op: Type.Literal("set_identity_fields"),
      displayName: Type.Optional(Type.String()),
      username: Type.Optional(Type.String()),
      aliases: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("replace_section"),
      section: Type.String(),
      text: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("append_bullets"),
      section: Type.String(),
      lines: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("append_paragraphs"),
      section: Type.String(),
      paragraphs: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      op: Type.Literal("remove_bullets_matching"),
      section: Type.String(),
      lines: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

const UserProfileEditSchema = Type.Object(
  {
    target: TargetSchema,
    createIfMissing: Type.Optional(Type.Boolean()),
    operations: Type.Array(EditOperationSchema),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function createUserProfileReadTool(context: UserProfileToolContext): AgentTool {
  validateUserProfileExcerptBounds(context);
  return {
    name: "user_profile_read",
    label: "User Profile Read",
    description:
      "Read file-backed per-user profiles from the workspace without guessing filenames. " +
      "By default this resolves to the current requester from trusted runtime context, but it can also target another explicit provider/sender id pair.",
    parameters: UserProfileReadSchema,
    execute: async (_toolCallId, rawParams) =>
      executeUserProfileRead({
        context,
        params: rawParams as UserProfileReadParams,
      }),
  };
}

export function createUserProfileEditTool(context: UserProfileToolContext): AgentTool {
  validateUserProfileExcerptBounds(context);
  return {
    name: "user_profile_edit",
    label: "User Profile Edit",
    description:
      "Create or update file-backed per-user profiles with patch-style operations instead of manual filename guessing and freeform markdown edits. " +
      "Defaults to the current requester from trusted runtime context, but explicit cross-user targets are also supported.",
    parameters: UserProfileEditSchema,
    execute: async (_toolCallId, rawParams) =>
      executeUserProfileEdit({
        context,
        params: rawParams as UserProfileEditParams,
      }),
  };
}

function validateUserProfileExcerptBounds(context: UserProfileToolContext): void {
  const defaultExcerptChars = context.config?.default_excerpt_chars ?? 1600;
  const maxExcerptChars = context.config?.max_excerpt_chars ?? 6000;
  if (maxExcerptChars < defaultExcerptChars) {
    throw new Error(
      "user_profiles.max_excerpt_chars must be >= user_profiles.default_excerpt_chars.",
    );
  }
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

async function executeUserProfileRead(input: {
  context: UserProfileToolContext;
  params: UserProfileReadParams;
}) {
  const workspaceRoot = input.context.workspaceRoot;
  const target = resolveUserProfileTarget({
    context: input.context,
    target: input.params.target,
  });
  const resolvedPath = await resolveUserProfilePath({
    workspaceRoot,
    rootDir: input.context.config?.root_dir ?? "users",
    target,
  });
  const view = input.params.view ?? "summary";

  if (!resolvedPath.exists) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `## User Profile\n` +
            `No profile exists for ${target.provider}:${target.senderId}.\n` +
            `Canonical path: \`${resolvedPath.workspacePath}\``,
        },
      ],
      details: {
        view,
        exists: false,
        target,
        path: resolvedPath.workspacePath,
      },
    };
  }

  const document = parseUserProfileDocument(await fs.readFile(resolvedPath.absolutePath, "utf8"), target);
  if (view === "exists") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `## User Profile\n` +
            `Profile exists for ${target.provider}:${target.senderId}.\n` +
            `Path: \`${resolvedPath.workspacePath}\``,
        },
      ],
      details: {
        view,
        exists: true,
        target,
        path: resolvedPath.workspacePath,
        metadata: document.metadata,
      },
    };
  }

  if (view === "excerpt") {
    const sectionName = normalizeSectionName(input.params.section);
    if (!sectionName) {
      throw new Error("section is required when view=\"excerpt\".");
    }
    const text = document.sections.get(sectionName) ?? "";
    const maxChars = clampExcerptChars(
      input.params.maxChars,
      input.context.config?.default_excerpt_chars ?? 1600,
      input.context.config?.max_excerpt_chars ?? 6000,
    );
    const offset = normalizeOffset(input.params.offset);
    const sliced = text.slice(offset, offset + maxChars);
    const nextOffset = offset + sliced.length < text.length ? offset + sliced.length : undefined;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `## User Profile Excerpt\n` +
            `Path: \`${resolvedPath.workspacePath}\`\n` +
            `Section: ${sectionName}\n` +
            `Offset: ${offset}\n` +
            `Length: ${sliced.length}/${text.length}\n\n` +
            (sliced || "(empty section)"),
        },
      ],
      details: {
        view,
        exists: true,
        target,
        path: resolvedPath.workspacePath,
        metadata: document.metadata,
        section: sectionName,
        offset,
        maxChars,
        nextOffset,
        remainingChars: Math.max(text.length - (nextOffset ?? text.length), 0),
        text: sliced,
      },
    };
  }

  const sectionSummaries = Array.from(document.sections.entries()).map(([name, text]) => ({
    name,
    chars: text.length,
    lines: countNonEmptyLines(text),
    preview: text.replace(/\s+/g, " ").trim().slice(0, 120),
  }));
  return {
    content: [
      {
        type: "text" as const,
        text: buildUserProfileSummaryText({
          path: resolvedPath.workspacePath,
          target,
          metadata: document.metadata,
          sectionSummaries,
        }),
      },
    ],
    details: {
      view,
      exists: true,
      target,
      path: resolvedPath.workspacePath,
      metadata: document.metadata,
      sections: sectionSummaries,
    },
  };
}

async function executeUserProfileEdit(input: {
  context: UserProfileToolContext;
  params: UserProfileEditParams;
}) {
  const workspaceRoot = input.context.workspaceRoot;
  const target = resolveUserProfileTarget({
    context: input.context,
    target: input.params.target,
  });
  const resolvedPath = await resolveUserProfilePath({
    workspaceRoot,
    rootDir: input.context.config?.root_dir ?? "users",
    target,
  });
  const operations = Array.isArray(input.params.operations) ? input.params.operations : [];
  if (operations.length === 0) {
    throw new Error("operations must contain at least one edit.");
  }

  if (!resolvedPath.exists && input.params.createIfMissing === false) {
    throw new Error(`No profile exists for ${target.provider}:${target.senderId}.`);
  }

  const now = new Date().toISOString();
  const existing = resolvedPath.exists
    ? parseUserProfileDocument(await fs.readFile(resolvedPath.absolutePath, "utf8"), target)
    : createEmptyUserProfileDocument(target, now);
  const beforeSections = new Map(existing.sections);
  applyUserProfileOperations(existing, operations, now);

  await fs.mkdir(path.dirname(resolvedPath.absolutePath), { recursive: true });
  await fs.writeFile(resolvedPath.absolutePath, renderUserProfileDocument(existing), "utf8");

  const changedSections = collectChangedSections(beforeSections, existing.sections);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `## User Profile Updated\n` +
          `Target: ${target.provider}:${target.senderId}\n` +
          `Path: \`${resolvedPath.workspacePath}\`\n` +
          `Changed sections: ${changedSections.length > 0 ? changedSections.join(", ") : "(metadata only)"}`,
      },
    ],
    details: {
      action: resolvedPath.exists ? "updated" : "created",
      target,
      path: resolvedPath.workspacePath,
      metadata: existing.metadata,
      changedSections,
      operationsApplied: operations.map((operation) => operation.op),
    },
  };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function resolveUserProfileTarget(input: {
  context: UserProfileToolContext;
  target?: UserProfileTargetInput;
}): ResolvedUserProfileTarget {
  const mode = input.target?.mode ?? "requester";
  if (mode === "requester") {
    const provider = normalizeProvider(input.context.provider);
    const senderId = normalizeOptionalText(input.context.senderId);
    if (!provider || !senderId) {
      throw new Error("requester target requires trusted provider and senderId runtime context.");
    }
    return {
      provider,
      senderId,
      username: deriveProviderUsername(provider, senderId),
    };
  }

  // explicit mode — use context.provider as fallback
  const provider = normalizeProvider(input.target?.provider ?? input.context.provider);
  const senderId = normalizeOptionalText(input.target?.senderId);
  if (!provider || !senderId) {
    throw new Error("explicit targets require provider and senderId.");
  }
  return {
    provider,
    senderId,
    username: normalizeOptionalText(input.target?.username) ?? deriveProviderUsername(provider, senderId),
    displayName: normalizeOptionalText(input.target?.displayName),
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

async function resolveUserProfilePath(params: {
  workspaceRoot: string;
  rootDir: string;
  target: ResolvedUserProfileTarget;
}): Promise<ResolvedUserProfilePath> {
  const canonicalWorkspacePath = buildCanonicalUserProfileWorkspacePath({
    rootDir: params.rootDir,
    target: params.target,
  });
  const canonicalAbsolutePath = path.resolve(params.workspaceRoot, canonicalWorkspacePath);
  if (await pathExists(canonicalAbsolutePath)) {
    return {
      absolutePath: canonicalAbsolutePath,
      workspacePath: toWorkspaceRelativePath(params.workspaceRoot, canonicalAbsolutePath),
      exists: true,
    };
  }

  const discovered = await findExistingUserProfilePath(params);
  if (discovered) {
    return discovered;
  }

  return {
    absolutePath: canonicalAbsolutePath,
    workspacePath: toWorkspaceRelativePath(params.workspaceRoot, canonicalAbsolutePath),
    exists: false,
  };
}

function buildCanonicalUserProfileWorkspacePath(params: {
  rootDir: string;
  target: ResolvedUserProfileTarget;
}): string {
  const slug = buildUserProfileSlug(params.target);
  const hash = buildStableIdentityHash(params.target.provider, params.target.senderId);
  return normalizeWorkspacePortablePath(
    `${params.rootDir}/${params.target.provider}/${slug}--${hash}.md`,
  );
}

function buildUserProfileSlug(target: ResolvedUserProfileTarget): string {
  const base =
    normalizeOptionalText(target.username) ??
    deriveProviderUsername(target.provider, target.senderId) ??
    normalizeOptionalText(target.displayName) ??
    target.senderId;
  return slugifyProfileSegment(base);
}

function buildStableIdentityHash(provider: string, senderId: string): string {
  return createHash("sha256")
    .update(`${provider}\0${senderId}`)
    .digest("hex")
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

function createEmptyUserProfileDocument(
  target: ResolvedUserProfileTarget,
  now: string,
): UserProfileDocument {
  const metadata: UserProfileMetadata = {
    provider: target.provider,
    senderId: target.senderId,
    username: normalizeOptionalText(target.username) ?? deriveProviderUsername(target.provider, target.senderId),
    displayName: normalizeOptionalText(target.displayName),
    aliases: [target.senderId],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const sections = new Map<string, string>();
  for (const section of DEFAULT_SECTIONS) {
    sections.set(section, "");
  }
  return { metadata, sections };
}

function parseUserProfileDocument(
  raw: string,
  fallbackTarget: ResolvedUserProfileTarget,
): UserProfileDocument {
  const { metadata, body } = parseUserProfileFrontmatter(raw);
  const now = new Date().toISOString();
  const mergedMetadata: UserProfileMetadata = {
    provider: normalizeProvider(metadata.provider) ?? fallbackTarget.provider,
    senderId: normalizeOptionalText(metadata.sender_id) ?? fallbackTarget.senderId,
    username:
      normalizeOptionalText(metadata.username) ??
      normalizeOptionalText(fallbackTarget.username) ??
      deriveProviderUsername(fallbackTarget.provider, fallbackTarget.senderId),
    displayName: normalizeOptionalText(metadata.display_name) ?? normalizeOptionalText(fallbackTarget.displayName),
    aliases: normalizeAliases(metadata.aliases, fallbackTarget.senderId),
    createdAt: normalizeOptionalText(metadata.created_at),
    updatedAt: normalizeOptionalText(metadata.updated_at) ?? now,
    version: normalizeVersion(metadata.version),
  };

  const sections = parseUserProfileSections(body);
  for (const section of DEFAULT_SECTIONS) {
    if (!sections.has(section)) {
      sections.set(section, "");
    }
  }
  return {
    metadata: mergedMetadata,
    sections,
  };
}

function renderUserProfileDocument(document: UserProfileDocument): string {
  const metadataLines = [
    "---",
    `provider: ${quoteFrontmatterValue(document.metadata.provider)}`,
    `sender_id: ${quoteFrontmatterValue(document.metadata.senderId)}`,
  ];
  if (document.metadata.username) {
    metadataLines.push(`username: ${quoteFrontmatterValue(document.metadata.username)}`);
  }
  if (document.metadata.displayName) {
    metadataLines.push(`display_name: ${quoteFrontmatterValue(document.metadata.displayName)}`);
  }
  metadataLines.push("aliases:");
  for (const alias of uniqueStrings(document.metadata.aliases)) {
    metadataLines.push(`  - ${quoteFrontmatterValue(alias)}`);
  }
  if (document.metadata.createdAt) {
    metadataLines.push(`created_at: ${quoteFrontmatterValue(document.metadata.createdAt)}`);
  }
  metadataLines.push(`updated_at: ${quoteFrontmatterValue(document.metadata.updatedAt)}`);
  metadataLines.push(`version: ${String(document.metadata.version)}`);
  metadataLines.push("---", "");

  const sectionNames = orderedSectionNames(document.sections);
  const renderedSections = sectionNames.map((section) => {
    const text = (document.sections.get(section) ?? "").trim();
    return `# ${section}\n\n${text}`;
  });

  return `${metadataLines.join("\n")}${renderedSections.join("\n\n")}\n`;
}

function applyUserProfileOperations(
  document: UserProfileDocument,
  operations: UserProfileEditOperation[],
  now: string,
): void {
  for (const operation of operations) {
    if (operation.op === "set_identity_fields") {
      const displayName = normalizeOptionalText(operation.displayName);
      const username = normalizeOptionalText(operation.username);
      if (displayName) {
        document.metadata.displayName = displayName;
      }
      if (username) {
        document.metadata.username = username;
      }
      if (Array.isArray(operation.aliases)) {
        document.metadata.aliases = uniqueStrings([...document.metadata.aliases, ...operation.aliases]);
      }
      continue;
    }

    if (operation.op === "replace_section") {
      const section = requireSectionName(operation.section);
      document.sections.set(section, normalizeSectionBody(operation.text));
      continue;
    }

    if (operation.op === "append_bullets") {
      const section = requireSectionName(operation.section);
      const currentLines = parseBulletLines(document.sections.get(section) ?? "");
      const additions = uniqueStrings((operation.lines ?? []).map((line) => normalizeOptionalText(line) ?? "").filter(Boolean));
      const combined = uniqueStrings([...currentLines, ...additions]);
      document.sections.set(section, combined.map((line) => `- ${line}`).join("\n"));
      continue;
    }

    if (operation.op === "append_paragraphs") {
      const section = requireSectionName(operation.section);
      const existing = normalizeSectionBody(document.sections.get(section) ?? "");
      const additions = (operation.paragraphs ?? [])
        .map((paragraph) => normalizeSectionBody(paragraph))
        .filter(Boolean);
      const combined = [existing, ...additions].filter(Boolean).join("\n\n");
      document.sections.set(section, combined);
      continue;
    }

    if (operation.op === "remove_bullets_matching") {
      const section = requireSectionName(operation.section);
      const removals = new Set(
        (operation.lines ?? [])
          .map((line) => normalizeOptionalText(line)?.toLowerCase())
          .filter((line): line is string => Boolean(line)),
      );
      const remaining = parseBulletLines(document.sections.get(section) ?? "").filter(
        (line) => !removals.has(line.toLowerCase()),
      );
      document.sections.set(section, remaining.map((line) => `- ${line}`).join("\n"));
      continue;
    }
  }

  document.metadata.username =
    normalizeOptionalText(document.metadata.username) ??
    deriveProviderUsername(document.metadata.provider, document.metadata.senderId);
  document.metadata.aliases = uniqueStrings([document.metadata.senderId, ...document.metadata.aliases]);
  document.metadata.updatedAt = now;
  document.metadata.version = 1;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildUserProfileSummaryText(input: {
  path: string;
  target: ResolvedUserProfileTarget;
  metadata: UserProfileMetadata;
  sectionSummaries: Array<{ name: string; chars: number; lines: number; preview: string }>;
}): string {
  const lines = [
    "## User Profile",
    `Path: \`${input.path}\``,
    `Target: ${input.target.provider}:${input.target.senderId}`,
    `Display name: ${input.metadata.displayName ?? "(unknown)"}`,
    `Username: ${input.metadata.username ?? "(unknown)"}`,
    `Aliases: ${input.metadata.aliases.join(", ")}`,
    "",
    "### Sections",
  ];
  for (const summary of input.sectionSummaries) {
    const preview = summary.preview ? ` :: ${summary.preview}` : "";
    lines.push(`- ${summary.name} (${summary.chars} chars, ${summary.lines} lines)${preview}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Profile path discovery
// ---------------------------------------------------------------------------

async function findExistingUserProfilePath(params: {
  workspaceRoot: string;
  rootDir: string;
  target: ResolvedUserProfileTarget;
}): Promise<ResolvedUserProfilePath | undefined> {
  const rootAbsolutePath = path.resolve(params.workspaceRoot, params.rootDir);
  if (!(await pathExists(rootAbsolutePath))) {
    return undefined;
  }
  const candidates = await listMarkdownFiles(rootAbsolutePath);
  const legacyRelativePath = buildLegacyMatrixWorkspacePath(params.rootDir, params.target);
  const legacyAbsolutePath = legacyRelativePath
    ? path.resolve(params.workspaceRoot, legacyRelativePath)
    : undefined;
  for (const absolutePath of candidates) {
    const relativePath = toWorkspaceRelativePath(params.workspaceRoot, absolutePath);
    if (legacyAbsolutePath && absolutePath === legacyAbsolutePath) {
      return {
        absolutePath,
        workspacePath: relativePath,
        exists: true,
      };
    }
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = parseUserProfileFrontmatter(raw).metadata;
    if (
      normalizeProvider(parsed.provider) === params.target.provider &&
      normalizeOptionalText(parsed.sender_id) === params.target.senderId
    ) {
      return {
        absolutePath,
        workspacePath: relativePath,
        exists: true,
      };
    }
  }
  return undefined;
}

async function listMarkdownFiles(rootAbsolutePath: string): Promise<string[]> {
  const discovered: string[] = [];
  const entries = await fs.readdir(rootAbsolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(rootAbsolutePath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...(await listMarkdownFiles(absolutePath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    if (entry.name === "README.md" || entry.name === "_TEMPLATE.md") {
      continue;
    }
    discovered.push(absolutePath);
  }
  return discovered.sort();
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseUserProfileFrontmatter(raw: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith("---\n")) {
    return {
      metadata: {},
      body: raw.trim(),
    };
  }
  const endMarker = "\n---\n";
  const endIndex = raw.indexOf(endMarker, 4);
  if (endIndex === -1) {
    return {
      metadata: {},
      body: raw.trim(),
    };
  }
  const metadataBlock = raw.slice(4, endIndex);
  const body = raw.slice(endIndex + endMarker.length).trim();
  return {
    metadata: parseFrontmatterBlock(metadataBlock),
    body,
  };
}

function parseFrontmatterBlock(raw: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  let activeArrayKey: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const arrayMatch = line.match(/^\s*-\s*(.+)$/);
    if (arrayMatch && activeArrayKey) {
      const existing = Array.isArray(metadata[activeArrayKey]) ? (metadata[activeArrayKey] as string[]) : [];
      existing.push(unquoteFrontmatterValue(arrayMatch[1]));
      metadata[activeArrayKey] = existing;
      continue;
    }
    activeArrayKey = undefined;
    const pairMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!pairMatch) {
      continue;
    }
    const key = pairMatch[1];
    const value = pairMatch[2];
    if (!value) {
      metadata[key] = [];
      activeArrayKey = key;
      continue;
    }
    metadata[key] = parseFrontmatterScalar(value);
  }
  return metadata;
}

function parseFrontmatterScalar(raw: string): string | number {
  const unquoted = unquoteFrontmatterValue(raw);
  if (/^\d+$/.test(unquoted)) {
    return Number.parseInt(unquoted, 10);
  }
  return unquoted;
}

function unquoteFrontmatterValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteFrontmatterValue(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

function parseUserProfileSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let currentSection: string | undefined;
  let buffer: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^#\s+(.+?)\s*$/);
    if (headingMatch) {
      if (currentSection) {
        sections.set(currentSection, normalizeSectionBody(buffer.join("\n")));
      }
      currentSection = normalizeSectionName(headingMatch[1]);
      buffer = [];
      continue;
    }
    if (currentSection) {
      buffer.push(line);
    }
  }
  if (currentSection) {
    sections.set(currentSection, normalizeSectionBody(buffer.join("\n")));
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function deriveProviderUsername(provider: string, senderId: string): string | undefined {
  if (provider === "matrix") {
    const localpart = senderId.split(":")[0]?.replace(/^@/, "").trim();
    return localpart || undefined;
  }
  return undefined;
}

function buildLegacyMatrixWorkspacePath(rootDir: string, target: ResolvedUserProfileTarget): string | undefined {
  if (target.provider !== "matrix") {
    return undefined;
  }
  const match = target.senderId.match(/^@([^:]+):(.+)$/);
  if (!match) {
    return undefined;
  }
  return normalizeWorkspacePortablePath(`${rootDir}/${match[1]}__${match[2]}.md`);
}

function normalizeProvider(value: unknown): string | undefined {
  const raw = normalizeOptionalText(value);
  if (!raw) {
    return undefined;
  }
  const normalized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizeAliases(value: unknown, senderId: string): string[] {
  const aliases = Array.isArray(value)
    ? value.map((entry) => normalizeOptionalText(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  return uniqueStrings([senderId, ...aliases]);
}

function requireSectionName(value: string): string {
  const section = normalizeSectionName(value);
  if (!section) {
    throw new Error("section must be a non-empty heading.");
  }
  return section;
}

function normalizeSectionName(value: unknown): string | undefined {
  const trimmed = normalizeOptionalText(value);
  if (!trimmed) {
    return undefined;
  }
  if (SECTION_SET.has(trimmed)) {
    return trimmed;
  }
  return trimmed
    .split(/\s+/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSectionBody(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/g, "")
    .trim();
}

function parseBulletLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*+]\s+/, ""))
    .filter(Boolean);
}

function orderedSectionNames(sections: Map<string, string>): string[] {
  const defaults = DEFAULT_SECTIONS.filter((section) => sections.has(section));
  const extras = Array.from(sections.keys()).filter((section) => !SECTION_SET.has(section)).sort();
  return [...defaults, ...extras];
}

function collectChangedSections(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [section, nextValue] of after.entries()) {
    if ((before.get(section) ?? "") !== nextValue) {
      changed.add(section);
    }
  }
  for (const section of before.keys()) {
    if (!after.has(section)) {
      changed.add(section);
    }
  }
  return Array.from(changed).sort();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function countNonEmptyLines(value: string): number {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function clampExcerptChars(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, 1), maximum);
}

function normalizeOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

function slugifyProfileSegment(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const portable = ascii.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return portable || "user";
}

function normalizeWorkspacePortablePath(rawPath: string): string {
  const portable = rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!portable || portable === "." || portable === ".." || portable.startsWith("/") || portable.includes("../")) {
    throw new Error("User profile paths must stay inside the workspace.");
  }
  return portable;
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../")) {
    throw new Error("Resolved path escapes the workspace.");
  }
  return `./${relative}`;
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}
