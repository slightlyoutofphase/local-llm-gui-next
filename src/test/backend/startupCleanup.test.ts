import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import {
  sweepStartupAttachmentCleanupJobs,
  sweepStartupPendingAttachments,
  sweepStartupTemplateOverrideFiles,
} from "../../backend/startupCleanup";
import type { MediaAttachmentRecord } from "../../lib/contracts";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe("startup cleanup", () => {
  let applicationPaths: ApplicationPaths;
  let database: AppDatabase;
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-startup-cleanup");
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

  test("removes stale temporary Jinja override files without touching unrelated temp files", async () => {
    const staleTemplatePath = path.join(applicationPaths.tempDir, "stale-template.jinja");
    const keptFilePath = path.join(applicationPaths.tempDir, "keep.txt");
    const logMessages: string[] = [];

    await writeFile(staleTemplatePath, "{{ prompt }}", "utf8");
    await writeFile(keptFilePath, "keep me", "utf8");

    await sweepStartupTemplateOverrideFiles({
      applicationPaths,
      log: (message) => {
        logMessages.push(message);
      },
    });

    expect(existsSync(staleTemplatePath)).toBe(false);
    expect(existsSync(keptFilePath)).toBe(true);
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]).toContain("stale temporary Jinja override");
  });

  test("age-gates temporary Jinja override sweeps and protects the active template file", async () => {
    const oldTemplatePath = path.join(applicationPaths.tempDir, "old-template.jinja");
    const recentTemplatePath = path.join(applicationPaths.tempDir, "recent-template.jinja");
    const protectedTemplatePath = path.join(applicationPaths.tempDir, "protected-template.jinja");
    const fixedNow = Date.parse("2026-04-14T12:00:00.000Z");
    const oneHourMs = 60 * 60 * 1000;

    await writeFile(oldTemplatePath, "{{ old }}", "utf8");
    await writeFile(recentTemplatePath, "{{ recent }}", "utf8");
    await writeFile(protectedTemplatePath, "{{ protected }}", "utf8");

    await Promise.all([
      utimes(
        oldTemplatePath,
        new Date(fixedNow - 2 * oneHourMs),
        new Date(fixedNow - 2 * oneHourMs),
      ),
      utimes(
        recentTemplatePath,
        new Date(fixedNow - 5 * 60 * 1000),
        new Date(fixedNow - 5 * 60 * 1000),
      ),
      utimes(
        protectedTemplatePath,
        new Date(fixedNow - 2 * oneHourMs),
        new Date(fixedNow - 2 * oneHourMs),
      ),
    ]);

    await sweepStartupTemplateOverrideFiles({
      applicationPaths,
      log: () => {},
      minimumAgeMs: oneHourMs,
      now: fixedNow,
      protectedFilePaths: [protectedTemplatePath],
    });

    expect(existsSync(oldTemplatePath)).toBe(false);
    expect(existsSync(recentTemplatePath)).toBe(true);
    expect(existsSync(protectedTemplatePath)).toBe(true);
  });

  test("removes stale pending attachment rows and files", async () => {
    const chat = database.createChat("Stale pending upload");
    const messageId = crypto.randomUUID();
    const staleAttachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "stale.png",
      filePath: path.join(applicationPaths.mediaDir, chat.id, ".pending", messageId, "stale.png"),
      id: crypto.randomUUID(),
      kind: "image",
      mimeType: "image/png",
    };
    const logMessages: string[] = [];

    await mkdir(path.dirname(staleAttachment.filePath), { recursive: true });
    await writeFile(staleAttachment.filePath, Buffer.from([0, 1, 2, 3]));
    database.createPendingAttachment(chat.id, messageId, staleAttachment);

    await sweepStartupPendingAttachments({
      applicationPaths,
      database,
      log: (message) => {
        logMessages.push(message);
      },
    });

    const lifecycleEntries = database.listPendingAttachmentLifecycleEntries();

    expect(existsSync(staleAttachment.filePath)).toBe(false);
    expect(database.listPendingAttachments()).toEqual([]);
    expect(lifecycleEntries).toHaveLength(1);
    expect(lifecycleEntries[0]?.state).toBe("abandoned");
    expect(lifecycleEntries[0]?.persistedFilePath).toBeNull();
    expect(lifecycleEntries[0]?.lastError).toBeNull();
    expect(logMessages).toHaveLength(1);
    expect(logMessages[0]).toContain("Reclaimed 1 stale pending attachment artifact");
  });

  test("age-gates pending attachment sweeps so recent staged uploads are left alone", async () => {
    const chat = database.createChat("Pending upload TTL");
    const oldMessageId = crypto.randomUUID();
    const recentMessageId = crypto.randomUUID();
    const minimumAgeMs = 1_000;
    const oldAttachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "old.png",
      filePath: path.join(applicationPaths.mediaDir, chat.id, ".pending", oldMessageId, "old.png"),
      id: crypto.randomUUID(),
      kind: "image",
      mimeType: "image/png",
    };
    const recentAttachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "recent.png",
      filePath: path.join(
        applicationPaths.mediaDir,
        chat.id,
        ".pending",
        recentMessageId,
        "recent.png",
      ),
      id: crypto.randomUUID(),
      kind: "image",
      mimeType: "image/png",
    };

    await mkdir(path.dirname(oldAttachment.filePath), { recursive: true });
    await writeFile(oldAttachment.filePath, Buffer.from([0, 1, 2, 3]));
    database.createPendingAttachment(chat.id, oldMessageId, oldAttachment);

    await delay(minimumAgeMs + 100);

    await mkdir(path.dirname(recentAttachment.filePath), { recursive: true });
    await writeFile(recentAttachment.filePath, Buffer.from([0, 1, 2, 3]));
    database.createPendingAttachment(chat.id, recentMessageId, recentAttachment);
    const sweepNow = Date.now();

    await sweepStartupPendingAttachments({
      applicationPaths,
      database,
      log: () => {},
      minimumAgeMs,
      now: sweepNow,
    });

    const lifecycleEntries = database.listPendingAttachmentLifecycleEntries();
    const oldLifecycleEntry = lifecycleEntries.find((entry) => entry.id === oldAttachment.id);
    const recentLifecycleEntry = lifecycleEntries.find((entry) => entry.id === recentAttachment.id);

    expect(existsSync(oldAttachment.filePath)).toBe(false);
    expect(existsSync(recentAttachment.filePath)).toBe(true);
    expect(oldLifecycleEntry?.state).toBe("abandoned");
    expect(recentLifecycleEntry?.state).toBe("staged");
  });

  test("promotes cleanup_failed lifecycle rows back to committed after recovery", async () => {
    const chat = database.createChat("Cleanup failed upload");
    const messageId = crypto.randomUUID();
    const staleAttachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "stale.png",
      filePath: path.join(applicationPaths.mediaDir, chat.id, ".pending", messageId, "stale.png"),
      id: crypto.randomUUID(),
      kind: "image",
      mimeType: "image/png",
    };

    await mkdir(path.dirname(staleAttachment.filePath), { recursive: true });
    await writeFile(staleAttachment.filePath, Buffer.from([0, 1, 2, 3]));
    database.createPendingAttachment(chat.id, messageId, staleAttachment);
    database.appendMessage(
      chat.id,
      "user",
      "Has attachment",
      [
        {
          ...staleAttachment,
          filePath: path.join(applicationPaths.mediaDir, chat.id, messageId, "stale.png"),
        },
      ],
      undefined,
      false,
      {},
      messageId,
      [
        {
          ...staleAttachment,
          filePath: path.join(applicationPaths.mediaDir, chat.id, messageId, "stale.png"),
        },
      ],
    );
    database.markPendingAttachmentsCleanupFailed([staleAttachment.id], "disk busy");

    await sweepStartupPendingAttachments({
      applicationPaths,
      database,
      log: () => {},
    });

    const lifecycleEntries = database.listPendingAttachmentLifecycleEntries();

    expect(lifecycleEntries).toHaveLength(1);
    expect(lifecycleEntries[0]?.state).toBe("committed");
    expect(lifecycleEntries[0]?.persistedFilePath).toBe(
      path.join(applicationPaths.mediaDir, chat.id, messageId, "stale.png"),
    );
    expect(lifecycleEntries[0]?.lastError).toBeNull();
  });

  test("retries queued attachment cleanup jobs on startup and marks them completed", async () => {
    const staleAttachmentPath = path.join(
      applicationPaths.mediaDir,
      "chat-1",
      "message-1",
      "stale.png",
    );

    await mkdir(path.dirname(staleAttachmentPath), { recursive: true });
    await writeFile(staleAttachmentPath, Buffer.from([0, 1, 2, 3]));

    const cleanupJob = database.createAttachmentCleanupJob("chat-1", "edit", [staleAttachmentPath]);

    await sweepStartupAttachmentCleanupJobs({
      database,
      log: () => {},
    });

    const cleanupJobs = database.listAttachmentCleanupJobs();

    expect(existsSync(staleAttachmentPath)).toBe(false);
    expect(cleanupJobs).toHaveLength(1);
    expect(cleanupJobs[0]?.id).toBe(cleanupJob.id);
    expect(cleanupJobs[0]?.state).toBe("completed");
    expect(cleanupJobs[0]?.attemptCount).toBe(1);
  });

  test("retries interrupted running append cleanup jobs on startup within the remaining retry budget", async () => {
    const chat = database.createChat("Interrupted append cleanup");
    const messageId = crypto.randomUUID();
    const staleAttachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "stale.png",
      filePath: path.join(applicationPaths.mediaDir, chat.id, ".pending", messageId, "stale.png"),
      id: crypto.randomUUID(),
      kind: "image",
      mimeType: "image/png",
    };

    await mkdir(path.dirname(staleAttachment.filePath), { recursive: true });
    await writeFile(staleAttachment.filePath, Buffer.from([0, 1, 2, 3]));
    database.createPendingAttachment(chat.id, messageId, staleAttachment);
    database.appendMessage(
      chat.id,
      "user",
      "Has attachment",
      [
        {
          ...staleAttachment,
          filePath: path.join(applicationPaths.mediaDir, chat.id, messageId, "stale.png"),
        },
      ],
      undefined,
      false,
      {},
      messageId,
      [
        {
          ...staleAttachment,
          filePath: path.join(applicationPaths.mediaDir, chat.id, messageId, "stale.png"),
        },
      ],
    );

    const cleanupJob = database.createAttachmentCleanupJob(chat.id, "append", [
      staleAttachment.filePath,
    ]);

    database.markAttachmentCleanupJobRunning(cleanupJob.id);

    await sweepStartupAttachmentCleanupJobs({
      database,
      log: () => {},
    });

    const cleanupJobs = database.listAttachmentCleanupJobs();

    expect(existsSync(staleAttachment.filePath)).toBe(false);
    expect(cleanupJobs).toHaveLength(1);
    expect(cleanupJobs[0]?.id).toBe(cleanupJob.id);
    expect(cleanupJobs[0]?.state).toBe("completed");
    expect(cleanupJobs[0]?.attemptCount).toBe(2);
  });
});
