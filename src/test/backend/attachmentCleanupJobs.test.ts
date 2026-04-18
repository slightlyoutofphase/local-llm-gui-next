import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe("attachment cleanup jobs", () => {
  let applicationPaths: ApplicationPaths;
  let database: AppDatabase;
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-attachment-cleanup-jobs");
    applicationPaths = {
      configFilePath: path.join(rootDir, "config.json"),
      databasePath: path.join(rootDir, "local-llm-gui.sqlite"),
      mediaDir: path.join(rootDir, "media"),
      staticOutDir: path.join(rootDir, "out"),
      tempDir: path.join(rootDir, "temp"),
      toolsDir: path.join(rootDir, "tools"),
      userDataDir: rootDir,
      workspaceRoot: rootDir,
    };

    await Promise.all([
      mkdir(applicationPaths.mediaDir, { recursive: true }),
      mkdir(applicationPaths.tempDir, { recursive: true }),
      mkdir(applicationPaths.toolsDir, { recursive: true }),
    ]);

    database = new AppDatabase(applicationPaths);
  });

  afterEach(async () => {
    database.close();
    await removeBackendTestScratchDir(rootDir);
  });

  test("tracks attachment cleanup jobs through queued, running, and completed states", async () => {
    const createdJob = await database.createAttachmentCleanupJob("chat-1", "append", [
      "D:/fake/a.png",
      "D:/fake/b.png",
    ]);

    await database.markAttachmentCleanupJobRunning(createdJob.id);
    await database.markAttachmentCleanupJobCompleted(createdJob.id);

    const jobs = database.listAttachmentCleanupJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.chatId).toBe("chat-1");
    expect(jobs[0]?.operation).toBe("append");
    expect(jobs[0]?.filePaths).toEqual(["D:/fake/a.png", "D:/fake/b.png"]);
    expect(jobs[0]?.attemptCount).toBe(1);
    expect(jobs[0]?.state).toBe("completed");
    expect(jobs[0]?.lastError).toBeNull();
  });

  test("lists only incomplete attachment cleanup jobs", async () => {
    const queuedJob = await database.createAttachmentCleanupJob("chat-1", "edit", [
      "D:/fake/a.png",
    ]);
    const runningJob = await database.createAttachmentCleanupJob("chat-1", "regenerate", [
      "D:/fake/b.png",
    ]);
    const completedJob = await database.createAttachmentCleanupJob("chat-1", "append", [
      "D:/fake/c.png",
    ]);

    await database.markAttachmentCleanupJobRunning(runningJob.id);
    await database.markAttachmentCleanupJobRunning(completedJob.id);
    await database.markAttachmentCleanupJobCompleted(completedJob.id);

    const jobs = database.listIncompleteAttachmentCleanupJobs();

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.id)).toEqual([queuedJob.id, runningJob.id]);
  });

  test("records terminal failure details for attachment cleanup jobs", async () => {
    const createdJob = await database.createAttachmentCleanupJob("chat-1", "regenerate", [
      "D:/fake/a.png",
    ]);

    await database.markAttachmentCleanupJobRunning(createdJob.id);
    await database.requeueAttachmentCleanupJob(createdJob.id, "retry later");
    await database.markAttachmentCleanupJobRunning(createdJob.id);
    await database.markAttachmentCleanupJobFailed(createdJob.id, "permission denied");

    const jobs = database.listAttachmentCleanupJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.attemptCount).toBe(2);
    expect(jobs[0]?.state).toBe("failed");
    expect(jobs[0]?.lastError).toBe("permission denied");
  });
});
