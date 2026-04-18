import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resumeTrackedAttachmentCleanupJob } from "./attachmentLifecycle";
import { AppDatabase } from "./db";
import type { ApplicationPaths } from "./paths";

interface StartupPendingSweepOptions {
  applicationPaths: ApplicationPaths;
  database: AppDatabase;
  log: (message: string) => void;
  minimumAgeMs?: number;
  now?: number;
}

interface StartupTemplateSweepOptions {
  applicationPaths: ApplicationPaths;
  log: (message: string) => void;
  minimumAgeMs?: number;
  now?: number;
  protectedFilePaths?: string[];
}

interface StartupAttachmentCleanupJobSweepOptions {
  database: AppDatabase;
  log: (message: string) => void;
}

const MAX_STARTUP_ATTACHMENT_CLEANUP_ATTEMPTS = 3;

/**
 * Resumes attachment cleanup jobs left queued or running when the backend last stopped.
 */
export async function sweepStartupAttachmentCleanupJobs(
  options: StartupAttachmentCleanupJobSweepOptions,
): Promise<void> {
  const incompleteJobs = options.database.listIncompleteAttachmentCleanupJobs();

  for (const job of incompleteJobs) {
    const remainingAttempts = MAX_STARTUP_ATTACHMENT_CLEANUP_ATTEMPTS - job.attemptCount;

    if (remainingAttempts <= 0) {
      try {
        await options.database.markAttachmentCleanupJobFailed(
          job.id,
          job.lastError ?? "cleanup job exceeded retry budget before startup recovery",
        );
      } catch (error) {
        options.log(
          `Failed to mark interrupted attachment cleanup job ${job.id} terminally failed during startup recovery: ${formatStartupCleanupError(error)}`,
        );
      }

      continue;
    }

    await resumeTrackedAttachmentCleanupJob({
      chatId: job.chatId,
      cleanupJobId: job.id,
      filePaths: job.filePaths,
      log: options.log,
      markCleanupJobCompleted: async (jobId) => {
        await options.database.markAttachmentCleanupJobCompleted(jobId);
      },
      markCleanupJobFailed: async (jobId, errorMessage) => {
        await options.database.markAttachmentCleanupJobFailed(jobId, errorMessage);
      },
      markCleanupJobQueued: async (jobId, errorMessage) => {
        await options.database.requeueAttachmentCleanupJob(jobId, errorMessage);
      },
      markCleanupJobRunning: async (jobId) => {
        await options.database.markAttachmentCleanupJobRunning(jobId);
      },
      maxAttempts: remainingAttempts,
      operation: job.operation,
      performCleanup: async () => {
        await deleteUnreferencedAttachmentFiles(job.filePaths, options.database);
      },
    });
  }
}

/**
 * Reclaims stale staged-upload artifacts left behind by interrupted sessions.
 */
export async function sweepStartupPendingAttachments(
  options: StartupPendingSweepOptions,
): Promise<void> {
  const minimumAgeMs = options.minimumAgeMs ?? 0;
  const referenceTimeMs = options.now ?? Date.now();
  const recoverablePendingAttachments = options.database.listRecoverablePendingAttachments();
  const pendingAttachments = recoverablePendingAttachments.filter((attachment) =>
    isOlderThanMinimumAge({
      createdAt: attachment.createdAt,
      minimumAgeMs,
      now: referenceTimeMs,
    }),
  );
  const trackedPendingDirectoryPaths = new Set(
    recoverablePendingAttachments.map((attachment) => path.dirname(attachment.filePath)),
  );
  const stalePendingDirectoryPaths = new Set(
    pendingAttachments.map((attachment) => path.dirname(attachment.filePath)),
  );
  const recoveredAttachmentIds = new Set<string>();

  for (const attachment of pendingAttachments) {
    try {
      await rm(attachment.filePath, { force: true });
      recoveredAttachmentIds.add(attachment.id);
    } catch (error) {
      options.log(
        `Failed to delete stale pending attachment file ${attachment.filePath}: ${formatStartupCleanupError(error)}`,
      );
    }
  }

  const removedPendingDirectories = await removePendingUploadDirectories(
    options.applicationPaths,
    options.log,
    minimumAgeMs,
    referenceTimeMs,
    stalePendingDirectoryPaths,
    trackedPendingDirectoryPaths,
  );
  const attachmentIdsFromRemovedDirectories = pendingAttachments
    .filter((attachment) =>
      removedPendingDirectories.some((directoryPath) =>
        isPathInsideDirectory(attachment.filePath, directoryPath),
      ),
    )
    .map((attachment) => attachment.id);
  const recoveredIds = Array.from(
    new Set([...recoveredAttachmentIds, ...attachmentIdsFromRemovedDirectories]),
  );

  if (recoveredIds.length > 0) {
    try {
      await options.database.markRecoveredPendingAttachments(recoveredIds);
    } catch (error) {
      options.log(
        `Failed to update ${String(recoveredIds.length)} stale pending attachment lifecycle record(s) during startup cleanup: ${formatStartupCleanupError(error)}`,
      );
      return;
    }
  }

  if (recoveredIds.length > 0 || removedPendingDirectories.length > 0) {
    options.log(
      `Reclaimed ${String(recoveredIds.length)} stale pending attachment artifact(s) and removed ${String(removedPendingDirectories.length)} stale pending director${removedPendingDirectories.length === 1 ? "y" : "ies"} during startup cleanup.`,
    );
  }
}

/**
 * Reclaims stale temporary Jinja override files left in the backend temp directory.
 */
export async function sweepStartupTemplateOverrideFiles(
  options: StartupTemplateSweepOptions,
): Promise<void> {
  if (!existsSync(options.applicationPaths.tempDir)) {
    return;
  }

  const minimumAgeMs = options.minimumAgeMs ?? 0;
  const protectedFilePaths = new Set(
    (options.protectedFilePaths ?? []).map((filePath) => path.resolve(filePath)),
  );
  const removedTemplateFiles: string[] = [];
  const tempEntries = await readdir(options.applicationPaths.tempDir, { withFileTypes: true });

  for (const tempEntry of tempEntries) {
    if (!tempEntry.isFile() || !tempEntry.name.endsWith(".jinja")) {
      continue;
    }

    const templateFilePath = path.join(options.applicationPaths.tempDir, tempEntry.name);

    if (protectedFilePaths.has(path.resolve(templateFilePath))) {
      continue;
    }

    if (
      !(await isPathOlderThanMinimumAge({
        minimumAgeMs,
        now: options.now ?? Date.now(),
        targetPath: templateFilePath,
      }))
    ) {
      continue;
    }

    try {
      await rm(templateFilePath, { force: true });
      removedTemplateFiles.push(templateFilePath);
    } catch (error) {
      options.log(
        `Failed to delete stale temporary Jinja override file ${templateFilePath}: ${formatStartupCleanupError(error)}`,
      );
    }
  }

  if (removedTemplateFiles.length > 0) {
    options.log(
      `Removed ${String(removedTemplateFiles.length)} stale temporary Jinja override file${removedTemplateFiles.length === 1 ? "" : "s"} during startup cleanup.`,
    );
  }
}

async function removePendingUploadDirectories(
  applicationPaths: ApplicationPaths,
  log: (message: string) => void,
  minimumAgeMs: number,
  now: number,
  staleTrackedDirectoryPaths: ReadonlySet<string>,
  allTrackedDirectoryPaths: ReadonlySet<string>,
): Promise<string[]> {
  if (!existsSync(applicationPaths.mediaDir)) {
    return [];
  }

  const removedDirectoryPaths: string[] = [];
  const chatEntries = await readdir(applicationPaths.mediaDir, { withFileTypes: true });

  for (const chatEntry of chatEntries) {
    if (!chatEntry.isDirectory()) {
      continue;
    }

    const pendingDirectoryPath = path.join(applicationPaths.mediaDir, chatEntry.name, ".pending");

    if (!existsSync(pendingDirectoryPath)) {
      continue;
    }

    const messageEntries = await readdir(pendingDirectoryPath, { withFileTypes: true });

    for (const messageEntry of messageEntries) {
      if (!messageEntry.isDirectory()) {
        continue;
      }

      const stagedMessageDirectoryPath = path.join(pendingDirectoryPath, messageEntry.name);

      if (staleTrackedDirectoryPaths.has(stagedMessageDirectoryPath)) {
        try {
          await rm(stagedMessageDirectoryPath, { force: true, recursive: true });
          removedDirectoryPaths.push(stagedMessageDirectoryPath);
        } catch (error) {
          log(
            `Failed to delete stale pending upload directory ${stagedMessageDirectoryPath}: ${formatStartupCleanupError(error)}`,
          );
        }

        continue;
      }

      if (allTrackedDirectoryPaths.has(stagedMessageDirectoryPath)) {
        continue;
      }

      if (
        !(await isPathOlderThanMinimumAge({
          minimumAgeMs,
          now,
          targetPath: stagedMessageDirectoryPath,
        }))
      ) {
        continue;
      }

      try {
        await rm(stagedMessageDirectoryPath, { force: true, recursive: true });
        removedDirectoryPaths.push(stagedMessageDirectoryPath);
      } catch (error) {
        log(
          `Failed to delete stale pending upload directory ${stagedMessageDirectoryPath}: ${formatStartupCleanupError(error)}`,
        );
      }
    }

    try {
      const remainingEntries = await readdir(pendingDirectoryPath);

      if (remainingEntries.length === 0) {
        await rm(pendingDirectoryPath, { force: true, recursive: true });
      }
    } catch (error) {
      log(
        `Failed to tidy empty pending upload directory ${pendingDirectoryPath}: ${formatStartupCleanupError(error)}`,
      );
    }
  }

  return removedDirectoryPaths;
}

function isOlderThanMinimumAge(options: {
  createdAt: string;
  minimumAgeMs: number;
  now: number;
}): boolean {
  if (options.minimumAgeMs <= 0) {
    return true;
  }

  const createdAtMs = Date.parse(options.createdAt);

  if (Number.isNaN(createdAtMs)) {
    return true;
  }

  return options.now - createdAtMs >= options.minimumAgeMs;
}

async function isPathOlderThanMinimumAge(options: {
  minimumAgeMs: number;
  now: number;
  targetPath: string;
}): Promise<boolean> {
  if (options.minimumAgeMs <= 0) {
    return true;
  }

  try {
    const targetStats = await stat(options.targetPath);
    return options.now - targetStats.mtimeMs >= options.minimumAgeMs;
  } catch {
    return false;
  }
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, filePath);

  return (
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  );
}

async function deleteUnreferencedAttachmentFiles(
  filePaths: string[],
  database: AppDatabase,
): Promise<void> {
  const removableFilePaths = database.listUnreferencedAttachmentFilePaths(filePaths);

  for (const filePath of removableFilePaths) {
    await rm(filePath, { force: true });
  }
}

function formatStartupCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
