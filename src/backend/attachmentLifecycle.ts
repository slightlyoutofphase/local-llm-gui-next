import { access, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ChatMessageRecord, MediaAttachmentRecord } from "../lib/contracts";
import { deleteAttachmentArtifacts } from "./attachmentReplay";

interface PendingAttachmentPromotionRollbackOptions {
  finalAttachments: MediaAttachmentRecord[];
  pendingAttachments: MediaAttachmentRecord[];
}

interface PendingAttachmentCleanupOptions {
  chatId: string;
  createCleanupJob: (
    chatId: string,
    operation: "append" | "edit" | "regenerate",
    filePaths: string[],
  ) => Promise<string>;
  deletePendingAttachmentFiles: (attachments: MediaAttachmentRecord[]) => Promise<void>;
  log: (message: string) => void;
  markCleanupJobCompleted: (jobId: string) => Promise<void>;
  markCleanupJobFailed: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobQueued: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobRunning: (jobId: string) => Promise<void>;
  markPendingAttachmentsCleanupFailed: (
    attachmentIds: string[],
    errorMessage: string,
  ) => Promise<void>;
  messageId: string;
  pendingAttachments: MediaAttachmentRecord[];
}

interface RemovedMessageAttachmentCleanupOptions {
  chatId: string;
  cleanupRemovedMessageAttachments: (messages: ChatMessageRecord[]) => Promise<void>;
  createCleanupJob: (
    chatId: string,
    operation: "append" | "edit" | "regenerate",
    filePaths: string[],
  ) => Promise<string>;
  log: (message: string) => void;
  markCleanupJobCompleted: (jobId: string) => Promise<void>;
  markCleanupJobFailed: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobQueued: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobRunning: (jobId: string) => Promise<void>;
  operation: "edit" | "regenerate";
  removedMessages: ChatMessageRecord[];
}

interface PromotePendingAttachmentsOptions {
  chatId: string;
  mediaDir: string;
  messageId: string;
  pendingAttachments: MediaAttachmentRecord[];
}

const MAX_REMOVED_ATTACHMENT_CLEANUP_ATTEMPTS = 3;
const MAX_PENDING_ATTACHMENT_CLEANUP_ATTEMPTS = 3;

interface TrackedAttachmentCleanupOptions {
  chatId: string;
  createCleanupJob?: (
    chatId: string,
    operation: "append" | "edit" | "regenerate",
    filePaths: string[],
  ) => Promise<string>;
  existingCleanupJobId?: string;
  filePaths: string[];
  finalFailureLogMessage: (errorMessage: string) => string;
  log: (message: string) => void;
  markCleanupJobCompleted: (jobId: string) => Promise<void>;
  markCleanupJobFailed: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobQueued: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobRunning: (jobId: string) => Promise<void>;
  maxAttempts: number;
  onFinalFailure?: (errorMessage: string) => void;
  onFinalFailureDescription?: string;
  operation: "append" | "edit" | "regenerate";
  performCleanup: () => Promise<void>;
}

interface ResumeTrackedAttachmentCleanupJobOptions {
  chatId: string;
  cleanupJobId: string;
  filePaths: string[];
  log: (message: string) => void;
  markCleanupJobCompleted: (jobId: string) => Promise<void>;
  markCleanupJobFailed: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobQueued: (jobId: string, errorMessage: string) => Promise<void>;
  markCleanupJobRunning: (jobId: string) => Promise<void>;
  maxAttempts: number;
  operation: "append" | "edit" | "regenerate";
  performCleanup: () => Promise<void>;
}

/**
 * Sanitises a user-uploaded file name for safe filesystem storage by
 * stripping non-ASCII characters and collapsing runs of hyphens.
 */
export function normalizeAttachmentFileName(fileName: string): string {
  const sanitizedName = fileName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitizedName.length > 0 ? sanitizedName : "attachment";
}

/**
 * Promotes staged attachments into their committed per-message media directory.
 * If a later promotion fails, any earlier promoted files are restored.
 */
export async function promotePendingAttachments(
  options: PromotePendingAttachmentsOptions,
): Promise<MediaAttachmentRecord[]> {
  if (options.pendingAttachments.length === 0) {
    return [];
  }

  const targetDirectory = path.join(options.mediaDir, options.chatId, options.messageId);

  await mkdir(targetDirectory, { recursive: true });

  const finalAttachments: MediaAttachmentRecord[] = [];

  try {
    for (const attachment of options.pendingAttachments) {
      const finalFilePath = path.join(
        targetDirectory,
        `${attachment.id}-${normalizeAttachmentFileName(attachment.fileName)}`,
      );

      await moveAttachmentFileOrCopyForPromotion(attachment.filePath, finalFilePath);
      finalAttachments.push({
        ...attachment,
        filePath: finalFilePath,
      });
    }
  } catch (error) {
    await rollbackPromotedPendingAttachments({
      finalAttachments,
      pendingAttachments: options.pendingAttachments,
    });
    throw error;
  }

  return finalAttachments;
}

/** Restores staged uploads after promotion succeeded but message persistence failed later. */
export async function rollbackPromotedPendingAttachments(
  options: PendingAttachmentPromotionRollbackOptions,
): Promise<void> {
  const pendingAttachmentsById = new Map(
    options.pendingAttachments.map((attachment) => [attachment.id, attachment]),
  );

  for (const finalAttachment of options.finalAttachments) {
    const pendingAttachment = pendingAttachmentsById.get(finalAttachment.id);

    if (!pendingAttachment) {
      await deleteAttachmentArtifacts(finalAttachment);
      continue;
    }

    if (!(await pathExists(finalAttachment.filePath))) {
      continue;
    }

    if (finalAttachment.filePath === pendingAttachment.filePath) {
      continue;
    }

    if (await pathExists(pendingAttachment.filePath)) {
      if (
        finalAttachment.filePath !== pendingAttachment.filePath &&
        (await filesHaveIdenticalContents(finalAttachment.filePath, pendingAttachment.filePath))
      ) {
        await deleteAttachmentArtifacts(finalAttachment);
      }

      continue;
    }

    await mkdir(path.dirname(pendingAttachment.filePath), { recursive: true });
    await moveAttachmentFileOrCopyForPromotion(
      finalAttachment.filePath,
      pendingAttachment.filePath,
    );
  }
}

async function filesHaveIdenticalContents(firstPath: string, secondPath: string): Promise<boolean> {
  try {
    const [firstData, secondData] = await Promise.all([readFile(firstPath), readFile(secondPath)]);

    return firstData.length === secondData.length && firstData.equals(secondData);
  } catch {
    return false;
  }
}

/**
 * Deletes staged attachment artifacts after a message has already been persisted.
 * Cleanup failures are logged so they remain observable without turning a durable
 * message append into a false request failure.
 */
export async function cleanupFinalizedPendingAttachments(
  options: PendingAttachmentCleanupOptions,
): Promise<void> {
  if (options.pendingAttachments.length === 0) {
    return;
  }

  const attachmentIds = options.pendingAttachments.map((attachment) => attachment.id);
  const filePaths = options.pendingAttachments.map((attachment) => attachment.filePath);

  await runTrackedAttachmentCleanup({
    chatId: options.chatId,
    createCleanupJob: options.createCleanupJob,
    filePaths,
    finalFailureLogMessage: (errorMessage) =>
      `Failed to delete ${String(options.pendingAttachments.length)} pending attachment file(s) for chat ${options.chatId} message ${options.messageId} after message persistence: ${errorMessage}`,
    log: options.log,
    markCleanupJobCompleted: options.markCleanupJobCompleted,
    markCleanupJobFailed: options.markCleanupJobFailed,
    markCleanupJobQueued: options.markCleanupJobQueued,
    markCleanupJobRunning: options.markCleanupJobRunning,
    maxAttempts: MAX_PENDING_ATTACHMENT_CLEANUP_ATTEMPTS,
    onFinalFailure: async (errorMessage) => {
      await options.markPendingAttachmentsCleanupFailed(attachmentIds, errorMessage);
    },
    onFinalFailureDescription: `cleanup-failed state for ${String(attachmentIds.length)} pending attachment record(s) for chat ${options.chatId} message ${options.messageId}`,
    operation: "append",
    performCleanup: async () => {
      await options.deletePendingAttachmentFiles(options.pendingAttachments);
    },
  });
}

/**
 * Tracks detached cleanup for removed-message attachments so failures remain
 * visible instead of disappearing from edit or regenerate flows.
 */
export async function cleanupRemovedMessageAttachmentsAfterMutation(
  options: RemovedMessageAttachmentCleanupOptions,
): Promise<void> {
  const filePaths = Array.from(
    new Set(
      options.removedMessages.flatMap((message) =>
        message.mediaAttachments.map((attachment) => attachment.filePath),
      ),
    ),
  );

  if (filePaths.length === 0) {
    return;
  }

  await runTrackedAttachmentCleanup({
    chatId: options.chatId,
    createCleanupJob: options.createCleanupJob,
    filePaths,
    finalFailureLogMessage: (errorMessage) =>
      `Failed to clean up removed-message attachment file(s) after ${options.operation} for chat ${options.chatId}: ${errorMessage}`,
    log: options.log,
    markCleanupJobCompleted: options.markCleanupJobCompleted,
    markCleanupJobFailed: options.markCleanupJobFailed,
    markCleanupJobQueued: options.markCleanupJobQueued,
    markCleanupJobRunning: options.markCleanupJobRunning,
    maxAttempts: MAX_REMOVED_ATTACHMENT_CLEANUP_ATTEMPTS,
    operation: options.operation,
    performCleanup: async () => {
      await options.cleanupRemovedMessageAttachments(options.removedMessages);
    },
  });
}

/** Resumes a tracked attachment cleanup job that was interrupted before completion. */
export async function resumeTrackedAttachmentCleanupJob(
  options: ResumeTrackedAttachmentCleanupJobOptions,
): Promise<void> {
  await runTrackedAttachmentCleanup({
    chatId: options.chatId,
    existingCleanupJobId: options.cleanupJobId,
    filePaths: options.filePaths,
    finalFailureLogMessage: (errorMessage) =>
      `Failed to complete attachment cleanup job ${options.cleanupJobId} (${options.operation}) for chat ${options.chatId} during startup recovery: ${errorMessage}`,
    log: options.log,
    markCleanupJobCompleted: options.markCleanupJobCompleted,
    markCleanupJobFailed: options.markCleanupJobFailed,
    markCleanupJobQueued: options.markCleanupJobQueued,
    markCleanupJobRunning: options.markCleanupJobRunning,
    maxAttempts: options.maxAttempts,
    operation: options.operation,
    performCleanup: options.performCleanup,
  });
}

async function runTrackedAttachmentCleanup(
  options: TrackedAttachmentCleanupOptions,
): Promise<void> {
  if (options.filePaths.length === 0 || options.maxAttempts <= 0) {
    return;
  }

  let cleanupJobId = options.existingCleanupJobId ?? null;

  if (!cleanupJobId && options.createCleanupJob) {
    try {
      cleanupJobId = await options.createCleanupJob(
        options.chatId,
        options.operation,
        options.filePaths,
      );
    } catch (error) {
      options.log(
        `Failed to create attachment cleanup job after ${options.operation} for chat ${options.chatId}: ${formatAttachmentCleanupError(error)}`,
      );
    }
  }

  for (let attemptIndex = 0; attemptIndex < options.maxAttempts; attemptIndex += 1) {
    if (cleanupJobId) {
      try {
        await options.markCleanupJobRunning(cleanupJobId);
      } catch (error) {
        options.log(
          `Failed to mark attachment cleanup job ${cleanupJobId} running after ${options.operation} for chat ${options.chatId}: ${formatAttachmentCleanupError(error)}`,
        );
      }
    }

    try {
      await options.performCleanup();

      if (cleanupJobId) {
        try {
          await options.markCleanupJobCompleted(cleanupJobId);
        } catch (error) {
          options.log(
            `Failed to complete attachment cleanup job ${cleanupJobId} after ${options.operation} for chat ${options.chatId}: ${formatAttachmentCleanupError(error)}`,
          );
        }
      }

      return;
    } catch (error) {
      const errorMessage = formatAttachmentCleanupError(error);
      const isFinalAttempt = attemptIndex === options.maxAttempts - 1;

      if (cleanupJobId) {
        try {
          if (isFinalAttempt) {
            await options.markCleanupJobFailed(cleanupJobId, errorMessage);
          } else {
            await options.markCleanupJobQueued(cleanupJobId, errorMessage);
          }
        } catch (stateError) {
          options.log(
            `Failed to update attachment cleanup job ${cleanupJobId} after ${options.operation} for chat ${options.chatId}: ${formatAttachmentCleanupError(stateError)}`,
          );
        }
      }

      if (isFinalAttempt) {
        if (options.onFinalFailure) {
          try {
            options.onFinalFailure(errorMessage);
          } catch (stateError) {
            options.log(
              `Failed to update ${options.onFinalFailureDescription ?? "attachment cleanup state"}: ${formatAttachmentCleanupError(stateError)}`,
            );
          }
        }

        options.log(options.finalFailureLogMessage(errorMessage));
      }
    }
  }
}

function formatAttachmentCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function moveAttachmentFileOrCopyForPromotion(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error;
    }
  }

  await copyFile(sourcePath, targetPath);
  await rm(sourcePath, { force: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isCrossDeviceRenameError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EXDEV";
}
