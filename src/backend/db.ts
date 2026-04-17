import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { buildChatSearchFtsQuery } from "../lib/chatSearch";
import type {
  ChatMessageRecord,
  ChatMessageRole,
  ChatSummary,
  LoadInferencePreset,
  LoadInferenceSettings,
  MediaAttachmentRecord,
  ModelRecord,
  StructuredOutputMode,
  SystemPromptPreset,
  ThinkingTagSettings,
} from "../lib/contracts";
import type { ApplicationPaths } from "./paths";
import {
  type SqliteBeginBlockedEvent,
  runSqliteTransactionWithRetry,
  type SqliteBusyRetryEvent,
  SQLITE_BUSY_TIMEOUT_MS,
} from "./sqliteBusyRetry";

interface AppDatabaseOptions {
  onSqliteBeginBlocked?: (event: SqliteBeginBlockedEvent) => void;
  onSqliteBusyRetry?: (event: SqliteBusyRetryEvent) => void;
}

/** SQLite row shape for the `chats` table. */
interface ChatRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_used_model_id: string | null;
}

/** SQLite row shape for the `messages` table. */
interface MessageRow {
  id: string;
  chat_id: string;
  sequence_number: number;
  role: ChatMessageRole;
  content: string;
  attachments_json: string;
  reasoning_content: string | null;
  reasoning_truncated: number;
  created_at: string;
  metadata_json: string;
}

/** SQLite row shape for the `system_prompt_presets` table. */
interface PresetRow {
  id: string;
  model_id: string;
  name: string;
  system_prompt: string;
  jinja_template_override: string | null;
  thinking_start_tag: string;
  thinking_end_tag: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for the `load_inference_presets` table. */
interface LoadPresetRow {
  id: string;
  model_id: string;
  name: string;
  settings_json: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/** SQLite row shape for the `pending_attachments` table. */
interface PendingAttachmentRow {
  id: string;
  chat_id: string;
  message_id: string | null;
  message_index: number;
  kind: MediaAttachmentRecord["kind"];
  file_name: string;
  mime_type: string;
  file_path: string;
  byte_size: number;
  created_at: string;
  state: PendingAttachmentState;
  persisted_file_path: string | null;
  last_error: string | null;
}

/** SQLite row shape for the derived `message_attachments` table. */
interface MessageAttachmentRow {
  attachment_id: string;
  chat_id: string;
  message_id: string;
  kind: MediaAttachmentRecord["kind"];
  file_name: string;
  mime_type: string;
  file_path: string;
  byte_size: number;
}

interface AttachmentCleanupJobRow {
  id: string;
  chat_id: string;
  operation: "append" | "edit" | "regenerate";
  file_paths_json: string;
  state: AttachmentCleanupJobState;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const ATTACHMENT_INDEX_VERSION = "1";
const SEARCH_INDEX_VERSION = "2";
const ATTACHMENT_REFERENCE_QUERY_CHUNK_SIZE = 400;

export type PendingAttachmentState = "staged" | "committed" | "cleanup_failed" | "abandoned";

export interface PendingAttachmentLifecycleRecord extends MediaAttachmentRecord {
  chatId: string;
  createdAt: string;
  messageId: string | null;
  state: PendingAttachmentState;
  persistedFilePath: string | null;
  lastError: string | null;
}

export type AttachmentCleanupJobState = "queued" | "running" | "completed" | "failed";

export interface AttachmentCleanupJobRecord {
  attemptCount: number;
  chatId: string;
  createdAt: string;
  filePaths: string[];
  id: string;
  lastError: string | null;
  operation: "append" | "edit" | "regenerate";
  state: AttachmentCleanupJobState;
  updatedAt: string;
}

interface FinalizableStatement {
  finalize(): void;
}

/** Raised when a message write targets a chat that no longer exists. */
export class ChatNotFoundError extends Error {
  public constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
  }
}

/** Result shape for preset delete operations, indicating success or reason. */
interface DeletePresetResult {
  deleted: boolean;
  modelId?: string;
  promotedDefaultId?: string;
  reason?: "last_preset" | "not_found";
}

/** Result shape for chat mutation operations (edit, regenerate, branch). */
interface ChatMutationResult {
  chat: ChatSummary;
  messages: ChatMessageRecord[];
  removedMessages: ChatMessageRecord[];
}

interface ChatPageResult {
  chat: ChatSummary;
  hasOlderMessages: boolean;
  messages: ChatMessageRecord[];
  nextBeforeSequence: number | null;
}

const MAX_CHAT_MESSAGE_PAGE_SIZE = 100;

/**
 * Provides the backend SQLite persistence layer.
 */
export class AppDatabase {
  private readonly database: Database;
  private readonly trackedStatements = new Set<FinalizableStatement>();

  /**
   * Opens the SQLite database and ensures the schema exists.
   *
   * @param applicationPaths The resolved application path bundle.
   */
  public constructor(
    applicationPaths: ApplicationPaths,
    private readonly options: AppDatabaseOptions = {},
  ) {
    if (!existsSync(path.dirname(applicationPaths.databasePath))) {
      mkdirSync(path.dirname(applicationPaths.databasePath), { recursive: true });
    }

    this.database = new Database(applicationPaths.databasePath, { create: true });
    this.database.exec(`PRAGMA busy_timeout = ${String(SQLITE_BUSY_TIMEOUT_MS)};`);
    this.installTrackedQueryHook();
    this.createSchema();
    this.ensurePendingAttachmentMessageIds();
    this.ensurePendingAttachmentLifecycleColumns();
    this.ensureMessageAttachmentIndex();
    this.ensureSearchIndexVersion();
  }

  /**
   * Returns the current monotonically increasing database revision.
   *
   * @returns The current database revision value.
   */
  public getRevision(): number {
    const revisionRow = this.database
      .query("SELECT value FROM meta WHERE key = 'db_revision'")
      .get() as { value: string } | null;

    if (!revisionRow) {
      throw new Error(
        "The application database is missing required revision metadata. The database may be corrupt or incomplete.",
      );
    }

    const revision = Number(revisionRow.value);

    if (!Number.isFinite(revision) || revision < 0) {
      throw new Error(
        "The application database contains an invalid revision metadata value. The database may be corrupt.",
      );
    }

    return revision;
  }

  /**
   * Closes the underlying SQLite connection.
   */
  public close(): void {
    this.finalizeTrackedStatements();
    this.database.close(true);
  }

  /**
   * Returns a lightweight list of chats ordered by last activity.
   *
   * @returns Persisted chat summaries.
   */
  public listChats(page = 1, pageSize = 50): ChatSummary[] {
    const boundedPage = Math.max(1, page);
    const boundedPageSize = Math.min(100, Math.max(1, pageSize));
    const offset = (boundedPage - 1) * boundedPageSize;

    const rows = this.database
      .query(
        "SELECT id, title, created_at, updated_at, last_used_model_id FROM chats ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(boundedPageSize, offset) as ChatRow[];

    return rows.map((row) => mapChatRow(row));
  }

  /**
   * Searches persisted chats by title and message content.
   *
   * @param query The user-entered search query.
   * @param page The 1-based page to return.
   * @param pageSize The maximum number of results per page.
   * @returns Matching chats ordered by last activity.
   */
  public searchChats(query: string, page = 1, pageSize = 50): ChatSummary[] {
    const normalizedQuery = query.trim();

    if (normalizedQuery.length === 0) {
      return [];
    }

    const ftsQuery = buildChatSearchFtsQuery(normalizedQuery);

    if (!ftsQuery) {
      return [];
    }

    const boundedPage = Math.max(1, page);
    const boundedPageSize = Math.min(100, Math.max(1, pageSize));
    const offset = (boundedPage - 1) * boundedPageSize;
    const scopedFtsQuery = `{title message_content reasoning_content} : ${ftsQuery}`;

    const rows = this.database
      .query(
        "SELECT DISTINCT c.id, c.title, c.created_at, c.updated_at, c.last_used_model_id FROM chats c WHERE c.id IN (SELECT chat_id FROM chat_search_fts WHERE chat_search_fts MATCH ?) ORDER BY c.updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(scopedFtsQuery, boundedPageSize, offset) as ChatRow[];

    return rows.map((row) => mapChatRow(row));
  }

  /**
   * Returns every persisted chat together with its full transcript.
   *
   * @returns Chats with their ordered messages.
   */
  public exportChats(): Array<{ chat: ChatSummary; messages: ChatMessageRecord[] }> {
    const chatRows = this.database
      .query(
        "SELECT id, title, created_at, updated_at, last_used_model_id FROM chats ORDER BY updated_at DESC",
      )
      .all() as ChatRow[];

    if (chatRows.length === 0) {
      return [];
    }

    const messageRows = this.database
      .query(
        "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages ORDER BY chat_id ASC, sequence_number ASC",
      )
      .all() as MessageRow[];
    const messagesByChatId = new Map<string, ChatMessageRecord[]>();

    for (const messageRow of messageRows) {
      const existingMessages = messagesByChatId.get(messageRow.chat_id);
      const mappedMessage = mapMessageRow(messageRow);

      if (existingMessages) {
        existingMessages.push(mappedMessage);
      } else {
        messagesByChatId.set(messageRow.chat_id, [mappedMessage]);
      }
    }

    return chatRows.map((chatRow) => ({
      chat: mapChatRow(chatRow),
      messages: messagesByChatId.get(chatRow.id) ?? [],
    }));
  }

  public *exportChatsIterator(): Generator<{ chat: ChatSummary; messages: ChatMessageRecord[] }> {
    const chatRows = this.database
      .query(
        "SELECT id, title, created_at, updated_at, last_used_model_id FROM chats ORDER BY updated_at DESC",
      )
      .all() as ChatRow[];
    const messagesQuery = this.database.query(
      "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? ORDER BY sequence_number ASC",
    );

    for (const chatRow of chatRows) {
      const messageRows = messagesQuery.all(chatRow.id) as MessageRow[];

      yield {
        chat: mapChatRow(chatRow),
        messages: messageRows.map(mapMessageRow),
      };
    }
  }

  /**
   * Creates a new empty chat row.
   *
   * @param title Optional chat title.
   * @param lastUsedModelId Optional last-used model hint.
   * @returns The created chat summary.
   */
  public createChat(title?: string, lastUsedModelId?: string): ChatSummary {
    const chatId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const nextTitle = title?.trim() || "New chat";

    this.runInTransaction(() => {
      this.database
        .query(
          "INSERT INTO chats (id, title, created_at, updated_at, last_used_model_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(chatId, nextTitle, timestamp, timestamp, lastUsedModelId ?? null);
      this.rebuildSearchIndexForChat(chatId);
      this.bumpRevision();
    });

    const createdChat: ChatSummary = {
      id: chatId,
      title: nextTitle,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (lastUsedModelId) {
      createdChat.lastUsedModelId = lastUsedModelId;
    }

    return createdChat;
  }

  /**
   * Returns a chat and its ordered messages.
   *
   * @param chatId The chat identifier.
   * @returns The chat with messages when it exists, otherwise `null`.
   */
  public getChat(chatId: string): { chat: ChatSummary; messages: ChatMessageRecord[] } | null {
    const chatRow = this.database
      .query("SELECT id, title, created_at, updated_at, last_used_model_id FROM chats WHERE id = ?")
      .get(chatId) as ChatRow | null;

    if (!chatRow) {
      return null;
    }

    const messageRows = this.database
      .query(
        "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? ORDER BY sequence_number ASC",
      )
      .all(chatId) as MessageRow[];

    return {
      chat: mapChatRow(chatRow),
      messages: messageRows.map((row) => mapMessageRow(row)),
    };
  }

  /** Returns whether the given chat row currently exists. */
  public chatExists(chatId: string): boolean {
    return this.database.query("SELECT 1 FROM chats WHERE id = ? LIMIT 1").get(chatId) !== null;
  }

  /** Returns one persisted attachment without reconstructing the full transcript. */
  public getPersistedAttachment(
    chatId: string,
    attachmentId: string,
  ): MediaAttachmentRecord | null {
    const row = this.database
      .query(
        "SELECT attachment_id, chat_id, message_id, kind, file_name, mime_type, file_path, byte_size FROM message_attachments WHERE chat_id = ? AND attachment_id = ? LIMIT 1",
      )
      .get(chatId, attachmentId) as MessageAttachmentRow | null;

    return row ? mapMessageAttachmentRow(row) : null;
  }

  /**
   * Returns whether any persisted message still references the provided
   * attachment file path.
   *
   * @param filePath The absolute attachment file path.
   * @returns `true` when at least one remaining message references the file.
   */
  public hasAttachmentReference(filePath: string): boolean {
    return (
      this.database
        .query("SELECT 1 FROM message_attachments WHERE file_path = ? LIMIT 1")
        .get(filePath) !== null
    );
  }

  /**
   * Returns which candidate file paths are no longer referenced by any message.
   *
   * @param filePaths Candidate absolute attachment file paths.
   * @returns The subset safe to delete.
   */
  public listUnreferencedAttachmentFilePaths(filePaths: string[]): string[] {
    const uniqueFilePaths = Array.from(
      new Set(
        filePaths.map((filePath) => filePath.trim()).filter((filePath) => filePath.length > 0),
      ),
    );

    if (uniqueFilePaths.length === 0) {
      return [];
    }

    const referencedFilePaths = new Set<string>();

    for (
      let startIndex = 0;
      startIndex < uniqueFilePaths.length;
      startIndex += ATTACHMENT_REFERENCE_QUERY_CHUNK_SIZE
    ) {
      const chunk = uniqueFilePaths.slice(
        startIndex,
        startIndex + ATTACHMENT_REFERENCE_QUERY_CHUNK_SIZE,
      );
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database
        .query(
          `SELECT DISTINCT file_path FROM message_attachments WHERE file_path IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ file_path: string }>;

      for (const row of rows) {
        referencedFilePaths.add(row.file_path);
      }
    }

    return uniqueFilePaths.filter((filePath) => !referencedFilePaths.has(filePath));
  }

  /**
   * Returns a newest-first page of persisted chat messages, reversed back into
   * ascending sequence order for transcript rendering.
   *
   * @param chatId The chat identifier.
   * @param limit Maximum number of messages to return.
   * @param beforeSequence Optional exclusive upper sequence bound for older pages.
   * @returns The paged chat detail when it exists, otherwise `null`.
   */
  public getChatPage(
    chatId: string,
    limit: number,
    beforeSequence?: number,
  ): ChatPageResult | null {
    const chatRow = this.database
      .query("SELECT id, title, created_at, updated_at, last_used_model_id FROM chats WHERE id = ?")
      .get(chatId) as ChatRow | null;

    if (!chatRow) {
      return null;
    }

    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_CHAT_MESSAGE_PAGE_SIZE));
    const pagedRows = (
      typeof beforeSequence === "number"
        ? this.database
            .query(
              "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? AND sequence_number < ? ORDER BY sequence_number DESC LIMIT ?",
            )
            .all(chatId, beforeSequence, normalizedLimit + 1)
        : this.database
            .query(
              "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? ORDER BY sequence_number DESC LIMIT ?",
            )
            .all(chatId, normalizedLimit + 1)
    ) as MessageRow[];
    const hasOlderMessages = pagedRows.length > normalizedLimit;
    const pageRows = (hasOlderMessages ? pagedRows.slice(0, normalizedLimit) : pagedRows).reverse();

    return {
      chat: mapChatRow(chatRow),
      hasOlderMessages,
      messages: pageRows.map((row) => mapMessageRow(row)),
      nextBeforeSequence: hasOlderMessages ? (pageRows[0]?.sequence_number ?? null) : null,
    };
  }

  /**
   * Returns a single persisted message row scoped to a chat.
   *
   * @param chatId The parent chat identifier.
   * @param messageId The message identifier.
   * @returns The persisted message when found, otherwise `null`.
   */
  public getMessage(chatId: string, messageId: string): ChatMessageRecord | null {
    const row = this.database
      .query(
        "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? AND id = ? LIMIT 1",
      )
      .get(chatId, messageId) as MessageRow | null;

    return row ? mapMessageRow(row) : null;
  }

  /**
   * Appends a new message to a chat.
   *
   * @param chatId The parent chat identifier.
   * @param role The message role.
   * @param content The user-visible message content.
   * @param mediaAttachments Any persisted attachments referenced by the message.
   * @param reasoningContent Optional separate reasoning content.
   * @param reasoningTruncated Indicates whether the reasoning trace was truncated.
   * @param metadata Optional backend-only metadata.
   * @returns The persisted message record.
   * @throws {ChatNotFoundError} When the parent chat no longer exists.
   */
  public appendMessage(
    chatId: string,
    role: ChatMessageRole,
    content: string,
    mediaAttachments: MediaAttachmentRecord[] = [],
    reasoningContent?: string,
    reasoningTruncated = false,
    metadata: Record<string, unknown> = {},
    messageId: string = crypto.randomUUID(),
    committedPendingAttachments: MediaAttachmentRecord[] = [],
  ): ChatMessageRecord {
    if (!this.chatExists(chatId)) {
      throw new ChatNotFoundError(chatId);
    }

    let nextSequence = -1;
    const timestamp = new Date().toISOString();

    this.runInTransaction(() => {
      nextSequence = this.getNextSequenceNumber(chatId);

      this.database
        .query(
          "INSERT INTO messages (id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          messageId,
          chatId,
          nextSequence,
          role,
          content,
          JSON.stringify(mediaAttachments),
          reasoningContent ?? null,
          reasoningTruncated ? 1 : 0,
          timestamp,
          JSON.stringify(metadata),
        );

      this.indexAttachmentsForMessage(chatId, messageId, mediaAttachments);
      this.markPendingAttachmentsCommittedInTransaction(committedPendingAttachments);
      this.indexMessageForSearch(chatId, content, reasoningContent ?? "");
      this.touchChat(chatId, timestamp);
      this.bumpRevision();
    });

    const createdMessage: ChatMessageRecord = {
      id: messageId,
      chatId,
      sequence: nextSequence,
      role,
      content,
      mediaAttachments,
      reasoningTruncated,
      createdAt: timestamp,
      metadata,
    };

    if (reasoningContent) {
      createdMessage.reasoningContent = reasoningContent;
    }

    return createdMessage;
  }

  /**
   * Replaces the backend-only metadata for a persisted message.
   *
   * @param chatId The parent chat identifier.
   * @param messageId The message identifier.
   * @param metadata The next metadata payload.
   * @returns The updated message when found, otherwise `null`.
   */
  public updateMessageMetadata(
    chatId: string,
    messageId: string,
    metadata: Record<string, unknown>,
  ): ChatMessageRecord | null {
    const existingMessage = this.getMessage(chatId, messageId);

    if (!existingMessage) {
      return null;
    }

    const timestamp = new Date().toISOString();

    this.database
      .query("UPDATE messages SET metadata_json = ? WHERE id = ? AND chat_id = ?")
      .run(JSON.stringify(metadata), messageId, chatId);

    this.touchChat(chatId, timestamp);
    this.bumpRevision();

    return this.getMessage(chatId, messageId);
  }

  /**
   * Persists a staged attachment uploaded ahead of message creation.
   *
   * @param chatId The owning chat identifier.
   * @param messageId The reserved message identifier.
   * @param attachment The staged attachment metadata.
   */
  public createPendingAttachment(
    chatId: string,
    messageId: string,
    attachment: MediaAttachmentRecord,
  ): void {
    this.database
      .query(
        "INSERT INTO pending_attachments (id, chat_id, message_id, message_index, kind, file_name, mime_type, file_path, byte_size, created_at, state, persisted_file_path, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        attachment.id,
        chatId,
        messageId,
        -1,
        attachment.kind,
        attachment.fileName,
        attachment.mimeType,
        attachment.filePath,
        attachment.byteSize,
        new Date().toISOString(),
        "staged",
        null,
        null,
      );
  }

  /**
   * Resolves staged attachments for the given chat/message pair in the
   * same order they were requested by the caller.
   *
   * @param chatId The owning chat identifier.
   * @param messageId The reserved message identifier.
   * @param attachmentIds The staged attachment identifiers.
   * @returns The resolved staged attachments in request order.
   */
  public getPendingAttachments(
    chatId: string,
    messageId: string,
    attachmentIds: string[],
  ): MediaAttachmentRecord[] {
    if (attachmentIds.length === 0) {
      return [];
    }

    const rows = this.database
      .query(
        "SELECT id, chat_id, message_id, message_index, kind, file_name, mime_type, file_path, byte_size, created_at, state, persisted_file_path, last_error FROM pending_attachments WHERE chat_id = ? AND message_id = ? AND state = 'staged'",
      )
      .all(chatId, messageId) as PendingAttachmentRow[];
    const rowsById = new Map(rows.map((row) => [row.id, mapPendingAttachmentRow(row)]));

    return attachmentIds.flatMap((attachmentId) => {
      const attachment = rowsById.get(attachmentId);

      return attachment ? [attachment] : [];
    });
  }

  /**
   * Lists every staged attachment currently associated with a chat/message pair.
   *
   * @param chatId The owning chat identifier.
   * @param messageId The reserved message identifier.
   * @returns All staged attachments for that pending message slot.
   */
  public listPendingAttachmentsForMessage(
    chatId: string,
    messageId: string,
  ): MediaAttachmentRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, message_id, message_index, kind, file_name, mime_type, file_path, byte_size, created_at, state, persisted_file_path, last_error FROM pending_attachments WHERE chat_id = ? AND message_id = ? AND state = 'staged'",
      )
      .all(chatId, messageId) as PendingAttachmentRow[];

    return rows.map((row) => mapPendingAttachmentRow(row));
  }

  /**
   * Lists every staged attachment currently recorded in the pending-attachment table.
   *
   * @returns All staged attachments across chats and reserved message slots.
   */
  public listPendingAttachments(): MediaAttachmentRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, message_id, message_index, kind, file_name, mime_type, file_path, byte_size, created_at, state, persisted_file_path, last_error FROM pending_attachments WHERE state = 'staged'",
      )
      .all() as PendingAttachmentRow[];

    return rows.map((row) => mapPendingAttachmentRow(row));
  }

  /**
   * Lists every pending-attachment lifecycle record for debugging and recovery.
   *
   * @returns All lifecycle rows, including committed and recovered attachments.
   */
  public listPendingAttachmentLifecycleEntries(): PendingAttachmentLifecycleRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, message_id, message_index, kind, file_name, mime_type, file_path, byte_size, created_at, state, persisted_file_path, last_error FROM pending_attachments ORDER BY created_at ASC, id ASC",
      )
      .all() as PendingAttachmentRow[];

    return rows.map((row) => mapPendingAttachmentLifecycleRow(row));
  }

  /**
   * Lists lifecycle rows that still own staged artifacts requiring recovery work.
   *
   * @returns Rows whose staged files may still exist on disk.
   */
  public listRecoverablePendingAttachments(): PendingAttachmentLifecycleRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, message_id, message_index, kind, file_name, mime_type, file_path, byte_size, created_at, state, persisted_file_path, last_error FROM pending_attachments WHERE state IN ('staged', 'cleanup_failed') ORDER BY created_at ASC, id ASC",
      )
      .all() as PendingAttachmentRow[];

    return rows.map((row) => mapPendingAttachmentLifecycleRow(row));
  }

  /**
   * Deletes staged attachment records after finalisation or rollback.
   *
   * @param attachmentIds The staged attachment identifiers.
   */
  public deletePendingAttachments(attachmentIds: string[]): void {
    if (attachmentIds.length === 0) {
      return;
    }

    const placeholders = attachmentIds.map(() => "?").join(",");

    this.database
      .query(`DELETE FROM pending_attachments WHERE id IN (${placeholders})`)
      .run(...attachmentIds);
  }

  /**
   * Marks persisted-message pending attachments as committed with their final file paths.
   *
   * @param attachments The committed attachment records as stored on the message.
   */
  public markPendingAttachmentsCleanupFailed(attachmentIds: string[], errorMessage: string): void {
    if (attachmentIds.length === 0) {
      return;
    }

    this.runInTransaction(() => {
      for (const attachmentId of attachmentIds) {
        this.database
          .query(
            "UPDATE pending_attachments SET state = 'cleanup_failed', last_error = ? WHERE id = ?",
          )
          .run(errorMessage, attachmentId);
      }
    });
  }

  /**
   * Marks staged lifecycle rows as abandoned after a local rollback or replacement.
   *
   * @param attachmentIds The lifecycle rows to mark abandoned.
   * @param errorMessage Optional descriptive reason for the transition.
   */
  public markPendingAttachmentsAbandoned(
    attachmentIds: string[],
    errorMessage: string | null = null,
  ): void {
    if (attachmentIds.length === 0) {
      return;
    }

    this.runInTransaction(() => {
      for (const attachmentId of attachmentIds) {
        this.database
          .query("UPDATE pending_attachments SET state = 'abandoned', last_error = ? WHERE id = ?")
          .run(errorMessage, attachmentId);
      }
    });
  }

  /**
   * Marks recovered lifecycle rows after startup cleanup reclaims stale staged files.
   *
   * @param attachmentIds The lifecycle rows that were successfully repaired.
   */
  public markRecoveredPendingAttachments(attachmentIds: string[]): void {
    if (attachmentIds.length === 0) {
      return;
    }

    this.runInTransaction(() => {
      for (const attachmentId of attachmentIds) {
        this.database
          .query(
            "UPDATE pending_attachments SET state = CASE WHEN state = 'cleanup_failed' THEN 'committed' ELSE 'abandoned' END, last_error = NULL WHERE id = ?",
          )
          .run(attachmentId);
      }
    });
  }

  /**
   * Records a tracked background cleanup job for attachment-file cleanup.
   *
   * @param chatId The owning chat identifier.
   * @param operation The originating mutation type.
   * @param filePaths The candidate attachment file paths to clean up.
   * @returns The persisted cleanup job record.
   */
  public createAttachmentCleanupJob(
    chatId: string,
    operation: "append" | "edit" | "regenerate",
    filePaths: string[],
  ): AttachmentCleanupJobRecord {
    const jobId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    this.database
      .query(
        "INSERT INTO attachment_cleanup_jobs (id, chat_id, operation, file_paths_json, state, attempt_count, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, ?)",
      )
      .run(jobId, chatId, operation, JSON.stringify(filePaths), timestamp, timestamp);

    return {
      attemptCount: 0,
      chatId,
      createdAt: timestamp,
      filePaths,
      id: jobId,
      lastError: null,
      operation,
      state: "queued",
      updatedAt: timestamp,
    };
  }

  /** Marks an attachment cleanup job as actively running and increments its attempt count. */
  public markAttachmentCleanupJobRunning(jobId: string): void {
    const timestamp = new Date().toISOString();

    this.database
      .query(
        "UPDATE attachment_cleanup_jobs SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, jobId);
  }

  /** Marks an attachment cleanup job as successfully completed. */
  public markAttachmentCleanupJobCompleted(jobId: string): void {
    const timestamp = new Date().toISOString();

    this.database
      .query(
        "UPDATE attachment_cleanup_jobs SET state = 'completed', last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, jobId);
  }

  /** Returns an attachment cleanup job to the queued state after a retryable failure. */
  public requeueAttachmentCleanupJob(jobId: string, errorMessage: string): void {
    const timestamp = new Date().toISOString();

    this.database
      .query(
        "UPDATE attachment_cleanup_jobs SET state = 'queued', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(errorMessage, timestamp, jobId);
  }

  /** Marks an attachment cleanup job as terminally failed. */
  public markAttachmentCleanupJobFailed(jobId: string, errorMessage: string): void {
    const timestamp = new Date().toISOString();

    this.database
      .query(
        "UPDATE attachment_cleanup_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(errorMessage, timestamp, jobId);
  }

  /** Lists all tracked attachment cleanup jobs for diagnostics and tests. */
  public listAttachmentCleanupJobs(): AttachmentCleanupJobRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, operation, file_paths_json, state, attempt_count, last_error, created_at, updated_at FROM attachment_cleanup_jobs ORDER BY created_at ASC, id ASC",
      )
      .all() as AttachmentCleanupJobRow[];

    return rows.map((row) => mapAttachmentCleanupJobRow(row));
  }

  /** Returns attachment cleanup jobs left queued or running across process boundaries. */
  public listIncompleteAttachmentCleanupJobs(): AttachmentCleanupJobRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, operation, file_paths_json, state, attempt_count, last_error, created_at, updated_at FROM attachment_cleanup_jobs WHERE state IN ('queued', 'running') ORDER BY updated_at ASC, id ASC",
      )
      .all() as AttachmentCleanupJobRow[];

    return rows.map((row) => mapAttachmentCleanupJobRow(row));
  }

  /**
   * Replaces a message's content and removes all later messages from the same chat.
   *
   * @param chatId The parent chat identifier.
   * @param messageId The message identifier to replace.
   * @param nextContent The new textual content.
   * @returns The updated chat state and removed messages, otherwise `null` when not found.
   */
  public replaceMessageAndTruncateFollowing(
    chatId: string,
    messageId: string,
    nextContent: string,
  ): ChatMutationResult | null {
    const existingMessage = this.getMessage(chatId, messageId);

    if (!existingMessage) {
      return null;
    }

    const removedMessages = this.listMessagesAfterSequence(chatId, existingMessage.sequence);
    const timestamp = new Date().toISOString();

    this.runInTransaction(() => {
      this.database
        .query(
          "UPDATE messages SET content = ?, reasoning_content = NULL, reasoning_truncated = 0, created_at = ? WHERE id = ? AND chat_id = ?",
        )
        .run(nextContent, timestamp, messageId, chatId);
      this.database
        .query("DELETE FROM messages WHERE chat_id = ? AND sequence_number > ?")
        .run(chatId, existingMessage.sequence);

      this.rebuildSearchIndexForChat(chatId);
      this.touchChat(chatId, timestamp);
      this.bumpRevision();
    });

    const updatedChat = this.getChat(chatId);

    return updatedChat
      ? {
          ...updatedChat,
          removedMessages,
        }
      : null;
  }

  /**
   * Removes a message and all later messages from the same chat.
   *
   * @param chatId The parent chat identifier.
   * @param messageId The first message to remove.
   * @returns The updated chat state and removed messages, otherwise `null` when not found.
   */
  public truncateChatFromMessage(chatId: string, messageId: string): ChatMutationResult | null {
    const existingMessage = this.getMessage(chatId, messageId);

    if (!existingMessage) {
      return null;
    }

    const removedMessages = this.listMessagesFromSequence(chatId, existingMessage.sequence);
    const timestamp = new Date().toISOString();

    this.runInTransaction(() => {
      this.database
        .query("DELETE FROM messages WHERE chat_id = ? AND sequence_number >= ?")
        .run(chatId, existingMessage.sequence);

      this.rebuildSearchIndexForChat(chatId);
      this.touchChat(chatId, timestamp);
      this.bumpRevision();
    });

    const updatedChat = this.getChat(chatId);

    return updatedChat
      ? {
          ...updatedChat,
          removedMessages,
        }
      : null;
  }

  /**
   * Updates the persisted title for a chat.
   *
   * @param chatId The chat identifier.
   * @param title The next title value.
   * @returns The updated chat summary when found, otherwise `null`.
   */
  public updateChatTitle(chatId: string, title: string): ChatSummary | null {
    const nextTitle = title.trim();

    if (!nextTitle) {
      return this.getChat(chatId)?.chat ?? null;
    }

    const timestamp = new Date().toISOString();
    let updated = false;

    this.runInTransaction(() => {
      const result = this.database
        .query("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
        .run(nextTitle, timestamp, chatId);

      if (result.changes === 0) {
        return;
      }

      updated = true;
      this.rebuildSearchIndexForChat(chatId);
      this.bumpRevision();
    });

    if (!updated) {
      return null;
    }

    return this.getChat(chatId)?.chat ?? null;
  }

  /**
   * Conditionally updates a chat title only when the current persisted title
   * matches the expected value. Used by auto-naming to avoid overwriting a
   * manual rename that occurred while the background completion was in flight.
   *
   * @param chatId The chat identifier.
   * @param expectedCurrentTitle The title that must still be current for the update to apply.
   * @param nextTitle The new title to set.
   * @returns The updated chat summary when the conditional update succeeded, otherwise `null`.
   */
  public updateChatTitleIfMatch(
    chatId: string,
    expectedCurrentTitle: string,
    nextTitle: string,
  ): ChatSummary | null {
    const sanitizedTitle = nextTitle.trim();

    if (!sanitizedTitle) {
      return null;
    }

    const timestamp = new Date().toISOString();
    let updated = false;

    this.runInTransaction(() => {
      const result = this.database
        .query("UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
        .run(sanitizedTitle, timestamp, chatId, expectedCurrentTitle);

      if (result.changes === 0) {
        return;
      }

      updated = true;
      this.rebuildSearchIndexForChat(chatId);
      this.bumpRevision();
    });

    if (!updated) {
      return null;
    }

    return this.getChat(chatId)?.chat ?? null;
  }

  /**
   * Deletes a persisted chat and its messages.
   *
   * @param chatId The chat identifier.
   * @returns `true` when a chat row was deleted.
   */
  public deleteChat(chatId: string): boolean {
    let deleted = false;

    this.runInTransaction(() => {
      const result = this.database.query("DELETE FROM chats WHERE id = ?").run(chatId);

      if (result.changes === 0) {
        return;
      }

      deleted = true;
      this.deleteSearchIndexForChat(chatId);
      this.bumpRevision();
    });

    return deleted;
  }

  /**
   * Deletes all chats and their messages.
   *
   * @returns The list of deleted chat IDs so the caller can clean up media files.
   */
  public deleteAllChats(): string[] {
    const rows = this.database.query("SELECT id FROM chats").all() as Array<{ id: string }>;
    const chatIds = rows.map((row) => row.id);

    if (chatIds.length > 0) {
      this.runInTransaction(() => {
        this.database.query("DELETE FROM chats").run();
        this.database.query("DELETE FROM chat_search_fts").run();
        this.bumpRevision();
      });
    }

    return chatIds;
  }

  /**
   * Returns the system prompt presets associated with a model.
   *
   * @param modelId The model identifier.
   * @returns The model's system prompt presets.
   */
  public listSystemPromptPresets(modelId: string): SystemPromptPreset[] {
    const rows = this.database
      .query(
        "SELECT id, model_id, name, system_prompt, jinja_template_override, thinking_start_tag, thinking_end_tag, is_default, created_at, updated_at FROM system_prompt_presets WHERE model_id = ? ORDER BY is_default DESC, name ASC",
      )
      .all(modelId) as PresetRow[];

    return rows.map((row) => mapSystemPresetRow(row));
  }

  /**
   * Returns the load and inference presets associated with a model.
   *
   * @param modelId The model identifier.
   * @returns The model's load and inference presets.
   */
  public listLoadInferencePresets(modelId: string): LoadInferencePreset[] {
    const rows = this.database
      .query(
        "SELECT id, model_id, name, settings_json, is_default, created_at, updated_at FROM load_inference_presets WHERE model_id = ? ORDER BY is_default DESC, name ASC",
      )
      .all(modelId) as LoadPresetRow[];

    return rows.map((row) => mapLoadPresetRow(row));
  }

  /**
   * Returns the requested system prompt preset.
   *
   * @param presetId The preset identifier.
   * @returns The preset when found, otherwise `null`.
   */
  public getSystemPromptPreset(presetId: string): SystemPromptPreset | null {
    const row = this.database
      .query(
        "SELECT id, model_id, name, system_prompt, jinja_template_override, thinking_start_tag, thinking_end_tag, is_default, created_at, updated_at FROM system_prompt_presets WHERE id = ?",
      )
      .get(presetId) as PresetRow | null;

    return row ? mapSystemPresetRow(row) : null;
  }

  /**
   * Returns the requested load and inference preset.
   *
   * @param presetId The preset identifier.
   * @returns The preset when found, otherwise `null`.
   */
  public getLoadInferencePreset(presetId: string): LoadInferencePreset | null {
    const row = this.database
      .query(
        "SELECT id, model_id, name, settings_json, is_default, created_at, updated_at FROM load_inference_presets WHERE id = ?",
      )
      .get(presetId) as LoadPresetRow | null;

    return row ? mapLoadPresetRow(row) : null;
  }

  /**
   * Returns the generated default system prompt preset for a model.
   *
   * @param modelId The model identifier.
   * @returns The default preset when found, otherwise `null`.
   */
  public getDefaultSystemPromptPreset(modelId: string): SystemPromptPreset | null {
    const row = this.database
      .query(
        "SELECT id, model_id, name, system_prompt, jinja_template_override, thinking_start_tag, thinking_end_tag, is_default, created_at, updated_at FROM system_prompt_presets WHERE model_id = ? AND is_default = 1 LIMIT 1",
      )
      .get(modelId) as PresetRow | null;

    return row ? mapSystemPresetRow(row) : null;
  }

  /**
   * Returns the generated default load and inference preset for a model.
   *
   * @param modelId The model identifier.
   * @returns The default preset when found, otherwise `null`.
   */
  public getDefaultLoadInferencePreset(modelId: string): LoadInferencePreset | null {
    const row = this.database
      .query(
        "SELECT id, model_id, name, settings_json, is_default, created_at, updated_at FROM load_inference_presets WHERE model_id = ? AND is_default = 1 LIMIT 1",
      )
      .get(modelId) as LoadPresetRow | null;

    return row ? mapLoadPresetRow(row) : null;
  }

  /**
   * Creates a new system-prompt preset for a model.
   */
  public createSystemPromptPreset(
    modelId: string,
    input: {
      jinjaTemplateOverride?: string;
      name: string;
      systemPrompt: string;
      thinkingTags: ThinkingTagSettings;
    },
  ): SystemPromptPreset {
    const presetId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const nextIsDefault = this.listSystemPromptPresets(modelId).length === 0;

    this.runInTransaction(() => {
      this.database
        .query(
          "INSERT INTO system_prompt_presets (id, model_id, name, system_prompt, jinja_template_override, thinking_start_tag, thinking_end_tag, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          presetId,
          modelId,
          input.name.trim(),
          input.systemPrompt,
          input.jinjaTemplateOverride?.trim() ? input.jinjaTemplateOverride.trim() : null,
          input.thinkingTags.startString,
          input.thinkingTags.endString,
          nextIsDefault ? 1 : 0,
          timestamp,
          timestamp,
        );

      this.bumpRevision();
    });

    return this.getSystemPromptPreset(presetId)!;
  }

  /**
   * Updates an existing system-prompt preset.
   */
  public updateSystemPromptPreset(
    presetId: string,
    input: {
      jinjaTemplateOverride?: string;
      name: string;
      systemPrompt: string;
      thinkingTags: ThinkingTagSettings;
    },
  ): SystemPromptPreset | null {
    const existingPreset = this.getSystemPromptPreset(presetId);

    if (!existingPreset) {
      return null;
    }

    const timestamp = new Date().toISOString();

    this.database
      .query(
        "UPDATE system_prompt_presets SET name = ?, system_prompt = ?, jinja_template_override = ?, thinking_start_tag = ?, thinking_end_tag = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        input.name.trim(),
        input.systemPrompt,
        input.jinjaTemplateOverride?.trim() ? input.jinjaTemplateOverride.trim() : null,
        input.thinkingTags.startString,
        input.thinkingTags.endString,
        timestamp,
        presetId,
      );

    this.bumpRevision();

    return this.getSystemPromptPreset(presetId);
  }

  /**
   * Deletes a system-prompt preset while preserving at least one preset per model.
   */
  public deleteSystemPromptPreset(presetId: string): DeletePresetResult {
    const existingPreset = this.getSystemPromptPreset(presetId);

    if (!existingPreset) {
      return {
        deleted: false,
        reason: "not_found",
      };
    }

    const presetsForModel = this.listSystemPromptPresets(existingPreset.modelId);

    if (presetsForModel.length <= 1) {
      return {
        deleted: false,
        modelId: existingPreset.modelId,
        reason: "last_preset",
      };
    }

    let promotedDefaultId: string | undefined;

    this.runInTransaction(() => {
      this.database.query("DELETE FROM system_prompt_presets WHERE id = ?").run(presetId);

      if (existingPreset.isDefault) {
        const nextDefaultPreset = presetsForModel.find((preset) => preset.id !== presetId);

        if (nextDefaultPreset) {
          this.database
            .query("UPDATE system_prompt_presets SET is_default = 1 WHERE id = ?")
            .run(nextDefaultPreset.id);
          promotedDefaultId = nextDefaultPreset.id;
        }
      }

      this.bumpRevision();
    });

    return {
      deleted: true,
      ...(existingPreset.modelId ? { modelId: existingPreset.modelId } : {}),
      ...(promotedDefaultId ? { promotedDefaultId } : {}),
    };
  }

  /**
   * Marks a system-prompt preset as the default for its model.
   */
  public setDefaultSystemPromptPreset(presetId: string): SystemPromptPreset | null {
    const existingPreset = this.getSystemPromptPreset(presetId);

    if (!existingPreset) {
      return null;
    }

    this.runInTransaction(() => {
      this.database
        .query("UPDATE system_prompt_presets SET is_default = 0 WHERE model_id = ?")
        .run(existingPreset.modelId);
      this.database
        .query("UPDATE system_prompt_presets SET is_default = 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), presetId);
      this.bumpRevision();
    });

    return this.getSystemPromptPreset(presetId);
  }

  /**
   * Creates a new load and inference preset for a model.
   */
  public createLoadInferencePreset(
    modelId: string,
    input: {
      name: string;
      settings: LoadInferenceSettings;
    },
  ): LoadInferencePreset {
    const presetId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const nextIsDefault = this.listLoadInferencePresets(modelId).length === 0;

    this.runInTransaction(() => {
      this.database
        .query(
          "INSERT INTO load_inference_presets (id, model_id, name, settings_json, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          presetId,
          modelId,
          input.name.trim(),
          JSON.stringify(input.settings),
          nextIsDefault ? 1 : 0,
          timestamp,
          timestamp,
        );

      this.bumpRevision();
    });

    return this.getLoadInferencePreset(presetId)!;
  }

  /**
   * Updates an existing load and inference preset.
   */
  public updateLoadInferencePreset(
    presetId: string,
    input: {
      name: string;
      settings: LoadInferenceSettings;
    },
  ): LoadInferencePreset | null {
    const existingPreset = this.getLoadInferencePreset(presetId);

    if (!existingPreset) {
      return null;
    }

    this.database
      .query(
        "UPDATE load_inference_presets SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(input.name.trim(), JSON.stringify(input.settings), new Date().toISOString(), presetId);

    this.bumpRevision();

    return this.getLoadInferencePreset(presetId);
  }

  /**
   * Deletes a load and inference preset while preserving at least one preset per model.
   */
  public deleteLoadInferencePreset(presetId: string): DeletePresetResult {
    const existingPreset = this.getLoadInferencePreset(presetId);

    if (!existingPreset) {
      return {
        deleted: false,
        reason: "not_found",
      };
    }

    const presetsForModel = this.listLoadInferencePresets(existingPreset.modelId);

    if (presetsForModel.length <= 1) {
      return {
        deleted: false,
        modelId: existingPreset.modelId,
        reason: "last_preset",
      };
    }

    let promotedDefaultId: string | undefined;

    this.runInTransaction(() => {
      this.database.query("DELETE FROM load_inference_presets WHERE id = ?").run(presetId);

      if (existingPreset.isDefault) {
        const nextDefaultPreset = presetsForModel.find((preset) => preset.id !== presetId);

        if (nextDefaultPreset) {
          this.database
            .query("UPDATE load_inference_presets SET is_default = 1 WHERE id = ?")
            .run(nextDefaultPreset.id);
          promotedDefaultId = nextDefaultPreset.id;
        }
      }

      this.bumpRevision();
    });

    return {
      deleted: true,
      ...(existingPreset.modelId ? { modelId: existingPreset.modelId } : {}),
      ...(promotedDefaultId ? { promotedDefaultId } : {}),
    };
  }

  /**
   * Marks a load and inference preset as the default for its model.
   */
  public setDefaultLoadInferencePreset(presetId: string): LoadInferencePreset | null {
    const existingPreset = this.getLoadInferencePreset(presetId);

    if (!existingPreset) {
      return null;
    }

    this.runInTransaction(() => {
      this.database
        .query("UPDATE load_inference_presets SET is_default = 0 WHERE model_id = ?")
        .run(existingPreset.modelId);
      this.database
        .query("UPDATE load_inference_presets SET is_default = 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), presetId);
      this.bumpRevision();
    });

    return this.getLoadInferencePreset(presetId);
  }

  /**
   * Ensures the generated default presets exist for a scanned model.
   *
   * @param model The scanned model record.
   */
  public ensureDefaultPresets(model: ModelRecord): boolean {
    let createdDefaultPreset = false;

    if (!this.getDefaultSystemPromptPreset(model.id)) {
      const timestamp = new Date().toISOString();
      const thinkingTags = deriveThinkingTags(model);

      this.database
        .query(
          "INSERT INTO system_prompt_presets (id, model_id, name, system_prompt, jinja_template_override, thinking_start_tag, thinking_end_tag, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .run(
          crypto.randomUUID(),
          model.id,
          "Default system prompt",
          "",
          null,
          thinkingTags.startString,
          thinkingTags.endString,
          timestamp,
          timestamp,
        );
      createdDefaultPreset = true;
    }

    if (!this.getDefaultLoadInferencePreset(model.id)) {
      const timestamp = new Date().toISOString();
      const defaultSettings = createDefaultLoadInferenceSettings(model);

      this.database
        .query(
          "INSERT INTO load_inference_presets (id, model_id, name, settings_json, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .run(
          crypto.randomUUID(),
          model.id,
          "Default load & inference",
          JSON.stringify(defaultSettings),
          timestamp,
          timestamp,
        );
      createdDefaultPreset = true;
    }

    if (createdDefaultPreset) {
      this.bumpRevision();
    }

    return createdDefaultPreset;
  }

  /** Initialises all tables, indexes, and seed rows using `CREATE IF NOT EXISTS`. */
  private createSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta (key, value) VALUES ('db_revision', '0');

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_model_id TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sequence_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        reasoning_content TEXT,
        reasoning_truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(chat_id, sequence_number)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_sequence ON messages(chat_id, sequence_number);

      CREATE TABLE IF NOT EXISTS pending_attachments (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id TEXT,
        message_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'staged',
        persisted_file_path TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_attachments_chat_message
      ON pending_attachments(chat_id, message_index);

  CREATE INDEX IF NOT EXISTS idx_pending_attachments_chat_message_id
  ON pending_attachments(chat_id, message_id);

      CREATE TABLE IF NOT EXISTS message_attachments (
        attachment_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        PRIMARY KEY(chat_id, attachment_id)
      );

      CREATE INDEX IF NOT EXISTS idx_message_attachments_message
      ON message_attachments(message_id);

      CREATE INDEX IF NOT EXISTS idx_message_attachments_file_path
      ON message_attachments(file_path);

      CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        file_paths_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_jobs_state
      ON attachment_cleanup_jobs(state, updated_at);

      CREATE TABLE IF NOT EXISTS system_prompt_presets (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        jinja_template_override TEXT,
        thinking_start_tag TEXT NOT NULL,
        thinking_end_tag TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS load_inference_presets (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chat_search_fts USING fts5(
        chat_id UNINDEXED,
        title,
        message_content,
        reasoning_content
      );
    `);
  }

  /** Tracks cached Bun statements so SQLite can be hard-closed on Windows. */
  private installTrackedQueryHook(): void {
    const databaseWithMutableQuery = this.database as Database & {
      query: (sql: string) => FinalizableStatement;
    };
    const originalQuery = databaseWithMutableQuery.query.bind(this.database);

    databaseWithMutableQuery.query = ((sql: string) => {
      const statement = originalQuery(sql);

      this.trackedStatements.add(statement);

      return statement;
    }) as typeof databaseWithMutableQuery.query;
  }

  /** Finalizes cached statements before closing the SQLite handle. */
  private finalizeTrackedStatements(): void {
    for (const statement of this.trackedStatements) {
      statement.finalize();
    }

    this.trackedStatements.clear();
  }

  /** Ensures upgraded databases can resolve pending attachments by message UUID. */
  private ensurePendingAttachmentMessageIds(): void {
    const columns = this.database.query("PRAGMA table_info(pending_attachments)").all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === "message_id")) {
      this.database.exec("ALTER TABLE pending_attachments ADD COLUMN message_id TEXT;");
    }

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_attachments_chat_message_id
      ON pending_attachments(chat_id, message_id);
    `);
  }

  /** Ensures upgraded databases have lifecycle-state columns for staged attachments. */
  private ensurePendingAttachmentLifecycleColumns(): void {
    const columns = this.database.query("PRAGMA table_info(pending_attachments)").all() as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === "state")) {
      this.database.exec(
        "ALTER TABLE pending_attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'staged';",
      );
    }

    if (!columns.some((column) => column.name === "persisted_file_path")) {
      this.database.exec("ALTER TABLE pending_attachments ADD COLUMN persisted_file_path TEXT;");
    }

    if (!columns.some((column) => column.name === "last_error")) {
      this.database.exec("ALTER TABLE pending_attachments ADD COLUMN last_error TEXT;");
    }
  }

  /** Repairs the derived attachment lookup table for upgraded databases. */
  private ensureMessageAttachmentIndex(): void {
    const versionRow = this.database
      .query("SELECT value FROM meta WHERE key = 'attachment_index_version'")
      .get() as { value: string } | null;

    if (versionRow?.value === ATTACHMENT_INDEX_VERSION) {
      return;
    }

    this.runInTransaction(() => {
      this.rebuildEntireAttachmentIndex();
      this.database
        .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('attachment_index_version', ?)")
        .run(ATTACHMENT_INDEX_VERSION);
    });
  }

  /** Repairs legacy search-index contents when the derived schema changes. */
  private ensureSearchIndexVersion(): void {
    const versionRow = this.database
      .query("SELECT value FROM meta WHERE key = 'search_index_version'")
      .get() as { value: string } | null;

    if (versionRow?.value === SEARCH_INDEX_VERSION) {
      return;
    }

    this.runInTransaction(() => {
      this.rebuildEntireSearchIndex();
      this.database
        .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('search_index_version', ?)")
        .run(SEARCH_INDEX_VERSION);
    });
  }

  /** Increments the monotonic `db_revision` counter in the `meta` table. */
  private bumpRevision(): void {
    const nextRevision = this.getRevision() + 1;

    this.database
      .query("UPDATE meta SET value = ? WHERE key = 'db_revision'")
      .run(String(nextRevision));
  }

  /** Rebuilds the derived attachment lookup table from canonical messages. */
  private rebuildEntireAttachmentIndex(): void {
    this.database.query("DELETE FROM message_attachments").run();

    const rows = this.database
      .query(
        "SELECT id, chat_id, attachments_json FROM messages WHERE attachments_json != '[]' ORDER BY chat_id ASC, sequence_number ASC",
      )
      .all() as Array<{ attachments_json: string; chat_id: string; id: string }>;

    for (const row of rows) {
      this.indexAttachmentsForMessage(
        row.chat_id,
        row.id,
        parseMessageAttachments(row.attachments_json),
      );
    }
  }

  /** Rebuilds the search index for every persisted chat and message. */
  private rebuildEntireSearchIndex(): void {
    this.database.query("DELETE FROM chat_search_fts").run();

    this.database
      .query(
        "INSERT INTO chat_search_fts (chat_id, title, message_content, reasoning_content) SELECT id, title, '', '' FROM chats ORDER BY created_at ASC",
      )
      .run();

    this.database
      .query(
        "INSERT INTO chat_search_fts (chat_id, title, message_content, reasoning_content) SELECT chat_id, '', content, COALESCE(reasoning_content, '') FROM messages ORDER BY chat_id ASC, sequence_number ASC",
      )
      .run();
  }

  /** Rebuilds the search index rows for one chat from canonical chat/message tables. */
  private rebuildSearchIndexForChat(chatId: string): void {
    this.deleteSearchIndexForChat(chatId);

    const chatRow = this.database.query("SELECT id, title FROM chats WHERE id = ?").get(chatId) as {
      id: string;
      title: string;
    } | null;

    if (!chatRow) {
      return;
    }

    this.database
      .query(
        "INSERT INTO chat_search_fts (chat_id, title, message_content, reasoning_content) VALUES (?, ?, '', '')",
      )
      .run(chatId, chatRow.title);

    const messageRows = this.database
      .query(
        "SELECT content, reasoning_content FROM messages WHERE chat_id = ? ORDER BY sequence_number ASC",
      )
      .all(chatId) as Array<{ content: string; reasoning_content: string | null }>;

    for (const messageRow of messageRows) {
      this.indexMessageForSearch(chatId, messageRow.content, messageRow.reasoning_content ?? "");
    }
  }

  /** Removes all derived search rows associated with a chat. */
  private deleteSearchIndexForChat(chatId: string): void {
    this.database.query("DELETE FROM chat_search_fts WHERE chat_id = ?").run(chatId);
  }

  /** Inserts one message's attachment rows into the derived lookup table. */
  private indexAttachmentsForMessage(
    chatId: string,
    messageId: string,
    attachments: MediaAttachmentRecord[],
  ): void {
    if (attachments.length === 0) {
      return;
    }

    const query = this.database.query(
      "INSERT INTO message_attachments (attachment_id, chat_id, message_id, kind, file_name, mime_type, file_path, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    for (const attachment of attachments) {
      query.run(
        attachment.id,
        chatId,
        messageId,
        attachment.kind,
        attachment.fileName,
        attachment.mimeType,
        attachment.filePath,
        attachment.byteSize,
      );
    }
  }

  /** Inserts a message content row into the FTS5 search index. */
  private indexMessageForSearch(chatId: string, content: string, reasoningContent: string): void {
    this.database
      .query(
        "INSERT INTO chat_search_fts (chat_id, title, message_content, reasoning_content) VALUES (?, '', ?, ?)",
      )
      .run(chatId, content, reasoningContent);
  }

  /** Runs a callback inside a write transaction and rolls back on failure. */
  private runInTransaction<T>(callback: () => T): T {
    const retryOptions = {
      begin: () => {
        this.database.exec("BEGIN IMMEDIATE");
      },
      commit: () => {
        this.database.exec("COMMIT");
      },
      execute: callback,
      rollback: () => {
        this.database.exec("ROLLBACK");
      },
      ...(this.options.onSqliteBeginBlocked
        ? { onBeginBlocked: this.options.onSqliteBeginBlocked }
        : {}),
      ...(this.options.onSqliteBusyRetry ? { onBusyRetry: this.options.onSqliteBusyRetry } : {}),
    };

    return runSqliteTransactionWithRetry(retryOptions);
  }

  /** Records committed attachment lifecycle state inside the surrounding write transaction. */
  private markPendingAttachmentsCommittedInTransaction(attachments: MediaAttachmentRecord[]): void {
    for (const attachment of attachments) {
      this.database
        .query(
          "UPDATE pending_attachments SET state = 'committed', persisted_file_path = ?, last_error = NULL WHERE id = ?",
        )
        .run(attachment.filePath, attachment.id);
    }
  }

  /** Returns the next available sequence number for messages in a chat. */
  private getNextSequenceNumber(chatId: string): number {
    const row = this.database
      .query(
        "SELECT COALESCE(MAX(sequence_number), -1) AS max_sequence FROM messages WHERE chat_id = ?",
      )
      .get(chatId) as { max_sequence: number };

    return row.max_sequence + 1;
  }

  /** Lists all messages strictly after The given sequence number. */
  private listMessagesAfterSequence(chatId: string, sequence: number): ChatMessageRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? AND sequence_number > ? ORDER BY sequence_number ASC",
      )
      .all(chatId, sequence) as MessageRow[];

    return rows.map((row) => mapMessageRow(row));
  }

  /** Lists all messages at or after the given sequence number. */
  private listMessagesFromSequence(chatId: string, sequence: number): ChatMessageRecord[] {
    const rows = this.database
      .query(
        "SELECT id, chat_id, sequence_number, role, content, attachments_json, reasoning_content, reasoning_truncated, created_at, metadata_json FROM messages WHERE chat_id = ? AND sequence_number >= ? ORDER BY sequence_number ASC",
      )
      .all(chatId, sequence) as MessageRow[];

    return rows.map((row) => mapMessageRow(row));
  }

  /** Updates a chat's `updated_at` timestamp. */
  private touchChat(chatId: string, timestamp: string): void {
    this.database.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(timestamp, chatId);
  }
}

/** Maps a raw `chats` table row to a {@link ChatSummary} contract object. */
function mapChatRow(row: ChatRow): ChatSummary {
  const chatSummary: ChatSummary = {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.last_used_model_id) {
    chatSummary.lastUsedModelId = row.last_used_model_id;
  }

  return chatSummary;
}

/** Maps a raw `messages` table row to a {@link ChatMessageRecord} contract object. */
function mapMessageRow(row: MessageRow): ChatMessageRecord {
  const messageRecord: ChatMessageRecord = {
    id: row.id,
    chatId: row.chat_id,
    sequence: row.sequence_number,
    role: row.role,
    content: row.content,
    mediaAttachments: parseMessageAttachments(row.attachments_json),
    reasoningTruncated: row.reasoning_truncated === 1,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };

  if (row.reasoning_content) {
    messageRecord.reasoningContent = row.reasoning_content;
  }

  return messageRecord;
}

function parseMessageAttachments(attachmentsJson: string): MediaAttachmentRecord[] {
  return JSON.parse(attachmentsJson) as MediaAttachmentRecord[];
}

/** Maps a raw `message_attachments` row to a persisted attachment record. */
function mapMessageAttachmentRow(row: MessageAttachmentRow): MediaAttachmentRecord {
  return {
    id: row.attachment_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    filePath: row.file_path,
    byteSize: row.byte_size,
  };
}

/** Maps a raw `pending_attachments` row to a staged attachment record. */
function mapPendingAttachmentRow(row: PendingAttachmentRow): MediaAttachmentRecord {
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    filePath: row.file_path,
    byteSize: row.byte_size,
  };
}

/** Maps a raw `pending_attachments` row to a lifecycle record. */
function mapPendingAttachmentLifecycleRow(
  row: PendingAttachmentRow,
): PendingAttachmentLifecycleRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    createdAt: row.created_at,
    messageId: row.message_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    filePath: row.file_path,
    byteSize: row.byte_size,
    state: row.state,
    persistedFilePath: row.persisted_file_path,
    lastError: row.last_error,
  };
}

function mapAttachmentCleanupJobRow(row: AttachmentCleanupJobRow): AttachmentCleanupJobRecord {
  return {
    attemptCount: row.attempt_count,
    chatId: row.chat_id,
    createdAt: row.created_at,
    filePaths: JSON.parse(row.file_paths_json) as string[],
    id: row.id,
    lastError: row.last_error,
    operation: row.operation,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

/** Maps a raw `system_prompt_presets` row to a {@link SystemPromptPreset} contract object. */
function mapSystemPresetRow(row: PresetRow): SystemPromptPreset {
  const systemPromptPreset: SystemPromptPreset = {
    id: row.id,
    modelId: row.model_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    thinkingTags: {
      startString: row.thinking_start_tag,
      endString: row.thinking_end_tag,
    },
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.jinja_template_override) {
    systemPromptPreset.jinjaTemplateOverride = row.jinja_template_override;
  }

  return systemPromptPreset;
}

/** Maps a raw `load_inference_presets` row to a {@link LoadInferencePreset} contract object. */
function mapLoadPresetRow(row: LoadPresetRow): LoadInferencePreset {
  const parsedSettings = JSON.parse(row.settings_json) as LoadInferenceSettings & {
    structuredOutputMode?: StructuredOutputMode;
  };

  return {
    id: row.id,
    modelId: row.model_id,
    name: row.name,
    settings: {
      ...parsedSettings,
      structuredOutputMode:
        parsedSettings.structuredOutputMode ??
        (parsedSettings.structuredOutputSchema ? "json_schema" : "off"),
    },
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Infers default thinking tag delimiters from a model's architecture and name. */
function deriveThinkingTags(model: ModelRecord): ThinkingTagSettings {
  const architectureName = (model.architecture ?? "").toLowerCase();
  const modelName = model.modelName.toLowerCase();

  if (architectureName.includes("gemma") && modelName.includes("4")) {
    return {
      startString: "<|channel>thought",
      endString: "<channel|>",
    };
  }

  return {
    startString: "<think>",
    endString: "</think>",
  };
}

/** Builds the default load/inference settings for a model based on its metadata and hardware. */
function createDefaultLoadInferenceSettings(model: ModelRecord): LoadInferenceSettings {
  return {
    contextLength: model.contextLength ?? 4096,
    gpuLayers: 0,
    cpuThreads: Math.max(1, Math.floor(os.cpus().length / 2)),
    batchSize: 2048,
    ubatchSize: 512,
    kvCacheTypeK: "f16",
    kvCacheTypeV: "f16",
    unifiedKvCache: false,
    offloadKvCache: true,
    useMmap: true,
    keepModelInMemory: false,
    flashAttention: false,
    fullSwaCache: false,
    contextShift: false,
    seed: -1,
    thinkingEnabled: true,
    overflowStrategy: "truncate-middle",
    stopStrings: [],
    temperature: model.defaultSampling.temperature ?? 0.8,
    topK: model.defaultSampling.topK ?? 40,
    topP: model.defaultSampling.topP ?? 0.95,
    minP: model.defaultSampling.minP ?? 0.05,
    presencePenalty: 0,
    repeatPenalty: model.defaultSampling.repeatPenalty ?? 1.1,
    structuredOutputMode: "off",
  };
}
