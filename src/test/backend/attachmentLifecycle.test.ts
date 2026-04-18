import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupFinalizedPendingAttachments,
  cleanupRemovedMessageAttachmentsAfterMutation,
  promotePendingAttachments,
  rollbackPromotedPendingAttachments,
} from "../../backend/attachmentLifecycle";
import type { ChatMessageRecord, MediaAttachmentRecord } from "../../lib/contracts";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

function createPendingAttachment(id: string): MediaAttachmentRecord {
  return {
    byteSize: 128,
    fileName: `${id}.png`,
    filePath: `D:/fake/${id}.png`,
    id,
    kind: "image",
    mimeType: "image/png",
  };
}

function createRemovedMessage(id: string): ChatMessageRecord {
  return {
    chatId: "chat-1",
    content: "removed",
    createdAt: "2026-04-14T00:00:00.000Z",
    id,
    mediaAttachments: [createPendingAttachment(`attachment-${id}`)],
    metadata: {},
    role: "user",
    sequence: 0,
  };
}

describe("cleanupFinalizedPendingAttachments", () => {
  test("skips cleanup work when there are no pending attachments", async () => {
    let createdCleanupJob = false;
    let deletedFiles = false;
    let markedCleanupFailed: { attachmentIds: string[]; errorMessage: string } | null = null;
    const logMessages: string[] = [];

    await cleanupFinalizedPendingAttachments({
      chatId: "chat-1",
      createCleanupJob: async () => {
        createdCleanupJob = true;
        return "job-1";
      },
      deletePendingAttachmentFiles: async () => {
        deletedFiles = true;
      },
      log: (message) => {
        logMessages.push(message);
      },
      markCleanupJobCompleted: async () => {},
      markCleanupJobFailed: async () => {},
      markCleanupJobQueued: async () => {},
      markCleanupJobRunning: async () => {},
      markPendingAttachmentsCleanupFailed: async (attachmentIds, errorMessage) => {
        markedCleanupFailed = { attachmentIds, errorMessage };
      },
      messageId: "message-1",
      pendingAttachments: [],
    });

    expect(createdCleanupJob).toBe(false);
    expect(deletedFiles).toBe(false);
    expect(markedCleanupFailed).toBeNull();
    expect(logMessages).toEqual([]);
  });

  test("marks cleanup failures without throwing and still logs the file cleanup problem", async () => {
    const pendingAttachments = [createPendingAttachment("attachment-1")];
    const deletedFileIds: string[][] = [];
    const cleanupFailedUpdates: Array<{ attachmentIds: string[]; errorMessage: string }> = [];
    const completedJobIds: string[] = [];
    const createdJobs: Array<{
      chatId: string;
      filePaths: string[];
      operation: "append" | "edit" | "regenerate";
    }> = [];
    const failedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const logMessages: string[] = [];
    const queuedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const runningJobIds: string[] = [];

    await cleanupFinalizedPendingAttachments({
      chatId: "chat-1",
      createCleanupJob: async (chatId, operation, filePaths) => {
        createdJobs.push({ chatId, filePaths, operation });
        return "job-1";
      },
      deletePendingAttachmentFiles: async (attachments) => {
        deletedFileIds.push(attachments.map((attachment) => attachment.id));
        throw new Error("disk busy");
      },
      log: (message) => {
        logMessages.push(message);
      },
      markCleanupJobCompleted: async (jobId) => {
        completedJobIds.push(jobId);
      },
      markCleanupJobFailed: async (jobId, errorMessage) => {
        failedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobQueued: async (jobId, errorMessage) => {
        queuedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobRunning: async (jobId) => {
        runningJobIds.push(jobId);
      },
      markPendingAttachmentsCleanupFailed: async (attachmentIds, errorMessage) => {
        cleanupFailedUpdates.push({ attachmentIds, errorMessage });
      },
      messageId: "message-1",
      pendingAttachments,
    });

    expect(createdJobs).toEqual([
      {
        chatId: "chat-1",
        filePaths: ["D:/fake/attachment-1.png"],
        operation: "append",
      },
    ]);
    expect(deletedFileIds).toEqual([["attachment-1"], ["attachment-1"], ["attachment-1"]]);
    expect(runningJobIds).toEqual(["job-1", "job-1", "job-1"]);
    expect(queuedJobs).toEqual([
      {
        errorMessage: "disk busy",
        jobId: "job-1",
      },
      {
        errorMessage: "disk busy",
        jobId: "job-1",
      },
    ]);
    expect(completedJobIds).toEqual([]);
    expect(failedJobs).toEqual([
      {
        errorMessage: "disk busy",
        jobId: "job-1",
      },
    ]);
    expect(cleanupFailedUpdates).toEqual([
      {
        attachmentIds: ["attachment-1"],
        errorMessage: "disk busy",
      },
    ]);
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]).toContain("pending attachment file");
    expect(logMessages[0]).toContain("disk busy");
  });

  test("logs state-update failures while still surfacing the file cleanup problem", async () => {
    const logMessages: string[] = [];
    const queuedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const runningJobIds: string[] = [];

    await cleanupFinalizedPendingAttachments({
      chatId: "chat-1",
      createCleanupJob: async () => "job-1",
      deletePendingAttachmentFiles: async () => {
        throw new Error("disk busy");
      },
      log: (message) => {
        logMessages.push(message);
      },
      markCleanupJobCompleted: async () => {},
      markCleanupJobFailed: async () => {},
      markCleanupJobQueued: async (jobId, errorMessage) => {
        queuedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobRunning: async (jobId) => {
        runningJobIds.push(jobId);
      },
      markPendingAttachmentsCleanupFailed: async () => {
        throw new Error("database locked");
      },
      messageId: "message-1",
      pendingAttachments: [createPendingAttachment("attachment-1")],
    });

    expect(runningJobIds).toEqual(["job-1", "job-1", "job-1"]);
    expect(queuedJobs).toEqual([
      {
        errorMessage: "disk busy",
        jobId: "job-1",
      },
      {
        errorMessage: "disk busy",
        jobId: "job-1",
      },
    ]);
    expect(logMessages).toHaveLength(2);
    expect(logMessages[0]).toContain("cleanup-failed state");
    expect(logMessages[0]).toContain("database locked");
    expect(logMessages[1]).toContain("pending attachment file");
    expect(logMessages[1]).toContain("disk busy");
  });

  test("logs removed-message cleanup failures without throwing", async () => {
    const removedMessages = [createRemovedMessage("message-1")];
    const cleanedMessageIds: string[][] = [];
    const completedJobIds: string[] = [];
    const createdJobs: Array<{
      chatId: string;
      filePaths: string[];
      operation: "append" | "edit" | "regenerate";
    }> = [];
    const failedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const logMessages: string[] = [];
    const queuedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const runningJobIds: string[] = [];

    await cleanupRemovedMessageAttachmentsAfterMutation({
      chatId: "chat-1",
      cleanupRemovedMessageAttachments: async (messages) => {
        cleanedMessageIds.push(messages.map((message) => message.id));
      },
      createCleanupJob: async (chatId, operation, filePaths) => {
        createdJobs.push({ chatId, filePaths, operation });
        return "job-1";
      },
      log: (message) => {
        logMessages.push(message);
      },
      markCleanupJobCompleted: async (jobId) => {
        completedJobIds.push(jobId);
      },
      markCleanupJobFailed: async (jobId, errorMessage) => {
        failedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobQueued: async (jobId, errorMessage) => {
        queuedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobRunning: async (jobId) => {
        runningJobIds.push(jobId);
      },
      operation: "edit",
      removedMessages,
    });

    expect(cleanedMessageIds).toEqual([["message-1"]]);
    expect(createdJobs).toEqual([
      {
        chatId: "chat-1",
        filePaths: ["D:/fake/attachment-message-1.png"],
        operation: "edit",
      },
    ]);
    expect(runningJobIds).toEqual(["job-1"]);
    expect(queuedJobs).toEqual([]);
    expect(completedJobIds).toEqual(["job-1"]);
    expect(failedJobs).toEqual([]);
    expect(logMessages).toEqual([]);
  });

  test("retries tracked cleanup jobs before marking terminal failure", async () => {
    const logMessages: string[] = [];
    const failedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const queuedJobs: Array<{ errorMessage: string; jobId: string }> = [];
    const runningJobIds: string[] = [];
    let cleanupAttempts = 0;

    await cleanupRemovedMessageAttachmentsAfterMutation({
      chatId: "chat-1",
      cleanupRemovedMessageAttachments: async () => {
        cleanupAttempts += 1;
        throw new Error("permission denied");
      },
      createCleanupJob: async () => "job-1",
      log: (message) => {
        logMessages.push(message);
      },
      markCleanupJobCompleted: async () => {
        throw new Error("unexpected complete");
      },
      markCleanupJobFailed: async (jobId, errorMessage) => {
        failedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobQueued: async (jobId, errorMessage) => {
        queuedJobs.push({ jobId, errorMessage });
      },
      markCleanupJobRunning: async (jobId) => {
        runningJobIds.push(jobId);
      },
      operation: "edit",
      removedMessages: [createRemovedMessage("message-1")],
    });

    expect(cleanupAttempts).toBe(3);
    expect(runningJobIds).toEqual(["job-1", "job-1", "job-1"]);
    expect(queuedJobs).toEqual([
      {
        errorMessage: "permission denied",
        jobId: "job-1",
      },
      {
        errorMessage: "permission denied",
        jobId: "job-1",
      },
    ]);
    expect(failedJobs).toEqual([
      {
        errorMessage: "permission denied",
        jobId: "job-1",
      },
    ]);
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]).toContain("after edit");
    expect(logMessages[0]).toContain("permission denied");
  });

  test("rolls back partially promoted files when a later staged attachment cannot be copied", async () => {
    const rootDir = await createBackendTestScratchDir("local-llm-gui-attachment-lifecycle");

    try {
      const mediaDir = path.join(rootDir, "media");
      const stagedDirectory = path.join(mediaDir, "chat-1", ".pending", "message-1");
      const firstAttachment = createPendingAttachment("attachment-1");
      const missingAttachment = createPendingAttachment("attachment-2");

      firstAttachment.fileName = "first.png";
      firstAttachment.filePath = path.join(stagedDirectory, "first.png");
      missingAttachment.fileName = "missing.png";
      missingAttachment.filePath = path.join(stagedDirectory, "missing.png");

      await mkdir(stagedDirectory, { recursive: true });
      await writeFile(firstAttachment.filePath, Buffer.from([0, 1, 2, 3]));

      await expect(
        promotePendingAttachments({
          chatId: "chat-1",
          mediaDir,
          messageId: "message-1",
          pendingAttachments: [firstAttachment, missingAttachment],
        }),
      ).rejects.toThrow();

      expect(existsSync(path.join(mediaDir, "chat-1", "message-1", "attachment-1-first.png"))).toBe(
        false,
      );
      expect(existsSync(firstAttachment.filePath)).toBe(true);
    } finally {
      await removeBackendTestScratchDir(rootDir);
    }
  });

  test("moves staged files into the committed directory on successful promotion", async () => {
    const rootDir = await createBackendTestScratchDir("local-llm-gui-attachment-lifecycle");

    try {
      const mediaDir = path.join(rootDir, "media");
      const stagedDirectory = path.join(mediaDir, "chat-1", ".pending", "message-1");
      const stagedAttachment = createPendingAttachment("attachment-1");

      stagedAttachment.fileName = "first.png";
      stagedAttachment.filePath = path.join(stagedDirectory, "first.png");

      await mkdir(stagedDirectory, { recursive: true });
      await writeFile(stagedAttachment.filePath, Buffer.from([0, 1, 2, 3]));

      const finalAttachments = await promotePendingAttachments({
        chatId: "chat-1",
        mediaDir,
        messageId: "message-1",
        pendingAttachments: [stagedAttachment],
      });

      expect(finalAttachments).toHaveLength(1);
      expect(existsSync(stagedAttachment.filePath)).toBe(false);
      expect(existsSync(finalAttachments[0]!.filePath)).toBe(true);
    } finally {
      await removeBackendTestScratchDir(rootDir);
    }
  });

  test("restores moved staged files when later message persistence fails", async () => {
    const rootDir = await createBackendTestScratchDir("local-llm-gui-attachment-lifecycle");

    try {
      const mediaDir = path.join(rootDir, "media");
      const stagedDirectory = path.join(mediaDir, "chat-1", ".pending", "message-1");
      const stagedAttachment = createPendingAttachment("attachment-1");

      stagedAttachment.fileName = "first.png";
      stagedAttachment.filePath = path.join(stagedDirectory, "first.png");

      await mkdir(stagedDirectory, { recursive: true });
      await writeFile(stagedAttachment.filePath, Buffer.from([0, 1, 2, 3]));

      const finalAttachments = await promotePendingAttachments({
        chatId: "chat-1",
        mediaDir,
        messageId: "message-1",
        pendingAttachments: [stagedAttachment],
      });

      await rollbackPromotedPendingAttachments({
        finalAttachments,
        pendingAttachments: [stagedAttachment],
      });

      expect(existsSync(stagedAttachment.filePath)).toBe(true);
      expect(existsSync(finalAttachments[0]!.filePath)).toBe(false);
    } finally {
      await removeBackendTestScratchDir(rootDir);
    }
  });

  test("preserves promoted final attachments when pending restoration is unsafe", async () => {
    const rootDir = await createBackendTestScratchDir(
      "local-llm-gui-attachment-lifecycle-restore-collision",
    );

    try {
      const mediaDir = path.join(rootDir, "media");
      const stagedDirectory = path.join(mediaDir, "chat-1", ".pending", "message-1");
      const stagedAttachment = createPendingAttachment("attachment-1");

      stagedAttachment.fileName = "first.png";
      stagedAttachment.filePath = path.join(stagedDirectory, "first.png");

      await mkdir(stagedDirectory, { recursive: true });
      await writeFile(stagedAttachment.filePath, Buffer.from([0, 1, 2, 3]));

      const finalAttachments = await promotePendingAttachments({
        chatId: "chat-1",
        mediaDir,
        messageId: "message-1",
        pendingAttachments: [stagedAttachment],
      });

      await writeFile(stagedAttachment.filePath, Buffer.from([9, 9, 9]));

      await rollbackPromotedPendingAttachments({
        finalAttachments,
        pendingAttachments: [stagedAttachment],
      });

      expect(existsSync(finalAttachments[0]!.filePath)).toBe(true);
      expect(existsSync(stagedAttachment.filePath)).toBe(true);
    } finally {
      await removeBackendTestScratchDir(rootDir);
    }
  });

  test("removes duplicate promoted final attachments when pending restoration already exists with identical content", async () => {
    const rootDir = await createBackendTestScratchDir(
      "local-llm-gui-attachment-lifecycle-restore-duplicate",
    );

    try {
      const mediaDir = path.join(rootDir, "media");
      const stagedDirectory = path.join(mediaDir, "chat-1", ".pending", "message-1");
      const stagedAttachment = createPendingAttachment("attachment-1");

      stagedAttachment.fileName = "first.png";
      stagedAttachment.filePath = path.join(stagedDirectory, "first.png");

      await mkdir(stagedDirectory, { recursive: true });
      await writeFile(stagedAttachment.filePath, Buffer.from([0, 1, 2, 3]));

      const finalAttachments = await promotePendingAttachments({
        chatId: "chat-1",
        mediaDir,
        messageId: "message-1",
        pendingAttachments: [stagedAttachment],
      });

      await writeFile(stagedAttachment.filePath, Buffer.from([0, 1, 2, 3]));

      await rollbackPromotedPendingAttachments({
        finalAttachments,
        pendingAttachments: [stagedAttachment],
      });

      expect(existsSync(stagedAttachment.filePath)).toBe(true);
      expect(existsSync(finalAttachments[0]!.filePath)).toBe(false);
    } finally {
      await removeBackendTestScratchDir(rootDir);
    }
  });
});
