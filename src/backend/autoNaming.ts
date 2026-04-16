import type { ChatMessageRecord } from "../lib/contracts";

const AUTO_NAME_MAX_INPUT_LENGTH = 800;
const CHAT_TITLE_MAX_LENGTH = 80;
const BRANCH_TITLE_PATTERN = /\s*\(branch(?:\s+(\d+))?\)\s*$/i;

/**
 * Builds the raw `/completion` prompt used for background chat auto-naming.
 *
 * @param messages Persisted chat messages ordered by sequence.
 * @returns The title-generation prompt, or `null` when insufficient chat content exists.
 */
export function buildAutoNamePrompt(messages: ChatMessageRecord[]): string | null {
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.metadata["hiddenFromTranscript"] !== true,
  );
  const firstAssistantMessage = messages.find(
    (message) => message.role === "assistant" && message.metadata["hiddenFromTranscript"] !== true,
  );

  if (!firstUserMessage) {
    return null;
  }

  const normalizedUserContent = normalizePromptExcerpt(firstUserMessage.content);

  if (!normalizedUserContent) {
    return null;
  }

  const normalizedAssistantContent = normalizePromptExcerpt(firstAssistantMessage?.content ?? "");

  return [
    "Write a concise title for this local AI chat.",
    "Rules:",
    "- Return only the title text.",
    "- Use 3 to 7 words when possible.",
    "- No quotation marks.",
    "- No markdown, labels, or trailing punctuation.",
    "",
    `First user message: ${normalizedUserContent}`,
    normalizedAssistantContent ? `First assistant reply: ${normalizedAssistantContent}` : "",
    "",
    "Title:",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Normalizes raw `/completion` output into a persisted chat title.
 *
 * @param rawTitle The raw title candidate returned by the model.
 * @returns The cleaned title, or `null` when no usable title remains.
 */
export function normalizeGeneratedChatTitle(rawTitle: string): string | null {
  const firstLine = rawTitle.split(/\r?\n/, 1)[0] ?? "";
  let normalizedTitle = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^title\s*[:\-]\s*/i, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.?!,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedTitle) {
    return null;
  }

  if (normalizedTitle.length > CHAT_TITLE_MAX_LENGTH) {
    normalizedTitle = normalizedTitle.slice(0, CHAT_TITLE_MAX_LENGTH).trimEnd();
  }

  return normalizedTitle.length > 0 ? normalizedTitle : null;
}

/**
 * Builds a normalized, deduplicated title for a new branched chat.
 *
 * @param sourceTitle The current source chat title.
 * @param existingTitles Titles already present in the database.
 * @returns A polished branch title that avoids suffix accumulation and collisions.
 */
export function buildBranchedChatTitle(
  sourceTitle: string,
  existingTitles: readonly string[],
): string {
  const normalizedSourceTitle = collapseTitleWhitespace(sourceTitle);
  const existingTitleSet = new Set(existingTitles.map((title) => title.trim().toLowerCase()));

  for (let branchNumber = 1; ; branchNumber += 1) {
    const candidate = buildBranchedTitleCandidate(normalizedSourceTitle, branchNumber);

    if (!existingTitleSet.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/**
 * Determines whether the current persisted chat transcript qualifies for first-turn auto-naming.
 *
 * @param messages Persisted chat messages ordered by sequence.
 * @returns `true` when exactly one visible user message and one visible assistant message exist.
 */
export function shouldAutoNameFromMessages(messages: ChatMessageRecord[]): boolean {
  let visibleUserCount = 0;
  let visibleAssistantCount = 0;

  for (const message of messages) {
    if (message.metadata["hiddenFromTranscript"] === true) {
      continue;
    }

    if (message.role === "user") {
      visibleUserCount += 1;
      continue;
    }

    if (message.role === "assistant") {
      visibleAssistantCount += 1;
    }
  }

  return visibleUserCount === 1 && visibleAssistantCount === 1;
}

function normalizePromptExcerpt(content: string): string {
  const collapsedContent = content.replace(/\s+/g, " ").trim();

  if (collapsedContent.length <= AUTO_NAME_MAX_INPUT_LENGTH) {
    return collapsedContent;
  }

  return `${collapsedContent.slice(0, AUTO_NAME_MAX_INPUT_LENGTH).trimEnd()}...`;
}

function buildBranchedTitleCandidate(sourceTitle: string, branchNumber: number): string {
  if (sourceTitle === "New chat") {
    const suffix = branchNumber === 1 ? " branch" : ` branch ${String(branchNumber)}`;

    return trimTitleWithSuffix("New chat", suffix);
  }

  const baseTitle = sourceTitle.replace(BRANCH_TITLE_PATTERN, "").trim() || "Chat";
  const suffix = branchNumber === 1 ? " (branch)" : ` (branch ${String(branchNumber)})`;

  return trimTitleWithSuffix(baseTitle, suffix);
}

function trimTitleWithSuffix(baseTitle: string, suffix: string): string {
  const normalizedBaseTitle = collapseTitleWhitespace(baseTitle);
  const maxBaseLength = Math.max(1, CHAT_TITLE_MAX_LENGTH - suffix.length);
  const trimmedBaseTitle = normalizedBaseTitle.slice(0, maxBaseLength).trimEnd();

  return `${trimmedBaseTitle || "Chat"}${suffix}`;
}

function collapseTitleWhitespace(title: string): string {
  const normalizedTitle = title.replace(/\s+/g, " ").trim();

  return normalizedTitle.length > 0 ? normalizedTitle : "New chat";
}
