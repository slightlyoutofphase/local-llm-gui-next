import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ChatMessageRecord, ChatSummary, MediaAttachmentRecord } from "../lib/contracts";
import { buildBranchedChatTitle } from "./autoNaming";
import { deleteAttachmentArtifacts } from "./attachmentReplay";
import { normalizeAttachmentFileName } from "./attachmentLifecycle";
import { AppDatabase } from "./db";
import type { ApplicationPaths } from "./paths";

/**
 * Represents the result of branching a chat at a specific message.
 */
export interface ChatBranchResult {
  /** The newly created branched chat summary. */
  chat: ChatSummary;
  /** The cloned message slice now owned by the new chat. */
  messages: ChatMessageRecord[];
}

/**
 * Deletes attachment files associated with removed messages.
 *
 * @param messages The removed messages whose persisted attachments should be deleted.
 */
export async function cleanupMessageAttachments(
  messages: ChatMessageRecord[],
  database?: AppDatabase,
): Promise<void> {
  const candidateFilePaths = Array.from(
    new Set(
      messages.flatMap((message) =>
        message.mediaAttachments.map((attachment) => attachment.filePath),
      ),
    ),
  );
  const removableFilePaths = new Set(
    database
      ? database.listUnreferencedAttachmentFilePaths(candidateFilePaths)
      : candidateFilePaths,
  );
  const deletedFilePaths = new Set<string>();

  for (const message of messages) {
    for (const attachment of message.mediaAttachments) {
      if (deletedFilePaths.has(attachment.filePath)) {
        continue;
      }

      if (!removableFilePaths.has(attachment.filePath)) {
        continue;
      }

      await deleteAttachmentArtifacts(attachment);
      deletedFilePaths.add(attachment.filePath);
    }
  }
}

/**
 * Clones a chat history slice into a new branched chat, including attachment files.
 *
 * @param applicationPaths The resolved application path bundle.
 * @param database The application database.
 * @param sourceChatId The source chat identifier.
 * @param messageId The last message to include in the branch.
 * @returns The new branched chat and cloned messages, otherwise `null` when not found.
 */
export async function branchChatAtMessage(
  applicationPaths: ApplicationPaths,
  database: AppDatabase,
  sourceChatId: string,
  messageId: string,
): Promise<ChatBranchResult | null> {
  const sourceChat = database.getChat(sourceChatId);

  if (!sourceChat) {
    return null;
  }

  const branchMessage = sourceChat.messages.find((message) => message.id === messageId);

  if (!branchMessage) {
    return null;
  }

  const nextChat = await database.createChat(
    buildBranchedChatTitle(
      sourceChat.chat.title,
      database.listChats().map((chat) => chat.title),
    ),
    sourceChat.chat.lastUsedModelId,
  );
  const messagesToClone = sourceChat.messages.filter(
    (message) => message.sequence <= branchMessage.sequence,
  );

  for (const message of messagesToClone) {
    const clonedAttachments = await cloneAttachmentsForMessage(
      applicationPaths,
      nextChat.id,
      message.sequence,
      message.mediaAttachments,
    );

    await database.appendMessage(
      nextChat.id,
      message.role,
      message.content,
      clonedAttachments,
      message.reasoningContent,
      message.reasoningTruncated ?? false,
      message.metadata,
    );
  }

  return database.getChat(nextChat.id);
}

async function cloneAttachmentsForMessage(
  applicationPaths: ApplicationPaths,
  chatId: string,
  messageSequence: number,
  attachments: MediaAttachmentRecord[],
): Promise<MediaAttachmentRecord[]> {
  if (attachments.length === 0) {
    return [];
  }

  const targetDirectory = path.join(applicationPaths.mediaDir, chatId, String(messageSequence));

  await mkdir(targetDirectory, { recursive: true });

  const clonedAttachments: MediaAttachmentRecord[] = [];

  try {
    for (const attachment of attachments) {
      const clonedAttachmentId = crypto.randomUUID();
      const targetFilePath = path.join(
        targetDirectory,
        `${clonedAttachmentId}-${normalizeAttachmentFileName(attachment.fileName)}`,
      );

      await copyFile(attachment.filePath, targetFilePath);
      clonedAttachments.push({
        ...attachment,
        filePath: targetFilePath,
        id: clonedAttachmentId,
      });
    }
  } catch (error) {
    await Promise.all(
      clonedAttachments.map((attachment) => rm(attachment.filePath, { force: true })),
    );
    throw error;
  }

  return clonedAttachments;
}
