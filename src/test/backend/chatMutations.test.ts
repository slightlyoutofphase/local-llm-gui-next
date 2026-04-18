import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildBinaryAttachmentReplayDescriptor,
  getBinaryAttachmentReplayDescriptorPath,
  persistBinaryAttachmentReplayDescriptor,
} from "../../backend/attachmentReplay";
import { branchChatAtMessage, cleanupMessageAttachments } from "../../backend/chatMutations";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import type { MediaAttachmentRecord } from "../../lib/contracts";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe("chat history mutations", () => {
  test("editing a message truncates later history and deletes removed attachments", async () => {
    const harness = await createHarness();

    try {
      const chat = await harness.database.createChat("Edit me");
      const initialUser = await harness.database.appendMessage(chat.id, "user", "Original prompt");
      await harness.database.appendMessage(chat.id, "assistant", "Original answer");
      const removedAttachment = await createAttachment(
        harness.applicationPaths,
        chat.id,
        2,
        "notes.png",
      );
      await persistBinaryAttachmentReplayDescriptor(
        removedAttachment,
        buildBinaryAttachmentReplayDescriptor(removedAttachment, Buffer.from("test-data", "utf8")),
      );

      await harness.database.appendMessage(chat.id, "user", "Later follow up", [removedAttachment]);
      await harness.database.appendMessage(chat.id, "assistant", "Later answer");

      const result = await harness.database.replaceMessageAndTruncateFollowing(
        chat.id,
        initialUser.id,
        "Edited prompt",
      );

      expect(result).not.toBeNull();
      expect(result?.messages).toHaveLength(1);
      expect(result?.messages[0]?.content).toBe("Edited prompt");
      expect(result?.removedMessages).toHaveLength(3);
      expect(existsSync(removedAttachment.filePath)).toBe(true);

      await cleanupMessageAttachments(result?.removedMessages ?? [], harness.database);

      expect(existsSync(removedAttachment.filePath)).toBe(false);
      expect(existsSync(getBinaryAttachmentReplayDescriptorPath(removedAttachment.filePath))).toBe(
        false,
      );
    } finally {
      await cleanupHarness(harness);
    }
  }, 15_000);

  test("branching a chat copies attachment files into the branched chat storage", async () => {
    const harness = await createHarness();

    try {
      const chat = await harness.database.createChat("Branch me");
      const sourceAttachment = await createAttachment(
        harness.applicationPaths,
        chat.id,
        0,
        "image.png",
      );

      await harness.database.appendMessage(chat.id, "user", "Analyze this image", [
        sourceAttachment,
      ]);
      const assistantMessage = await harness.database.appendMessage(
        chat.id,
        "assistant",
        "Looks good.",
      );
      const branch = await branchChatAtMessage(
        harness.applicationPaths,
        harness.database,
        chat.id,
        assistantMessage.id,
      );

      expect(branch).not.toBeNull();
      expect(branch?.chat.id).not.toBe(chat.id);
      expect(branch?.messages).toHaveLength(2);
      expect(branch?.messages[0]?.content).toBe("Analyze this image");
      expect(branch?.messages[1]?.content).toBe("Looks good.");
      expect(branch?.messages[0]?.mediaAttachments).toHaveLength(1);
      expect(branch?.messages[0]?.mediaAttachments[0]?.id).not.toBe(sourceAttachment.id);
      expect(branch?.messages[0]?.mediaAttachments[0]?.filePath).not.toBe(
        sourceAttachment.filePath,
      );
      expect(branch?.messages[0]?.mediaAttachments[0]?.filePath).toContain(branch?.chat.id ?? "");
      expect(existsSync(sourceAttachment.filePath)).toBe(true);
      expect(existsSync(branch?.messages[0]?.mediaAttachments[0]?.filePath ?? "")).toBe(true);
    } finally {
      await cleanupHarness(harness);
    }
  }, 15_000);

  test("branching reuses a normalized title base and deduplicates repeated branch names", async () => {
    const harness = await createHarness();

    try {
      await harness.database.createChat("Branch me (branch)");
      await harness.database.createChat("Branch me (branch 2)");

      const chat = await harness.database.createChat("Branch me (branch)");
      const userMessage = await harness.database.appendMessage(chat.id, "user", "Hello");

      const branch = await branchChatAtMessage(
        harness.applicationPaths,
        harness.database,
        chat.id,
        userMessage.id,
      );

      expect(branch).not.toBeNull();
      expect(branch?.chat.title).toBe("Branch me (branch 3)");
    } finally {
      await cleanupHarness(harness);
    }
  }, 15_000);

  test("deleting the source chat removes only the source-owned attachment file after branching", async () => {
    const harness = await createHarness();

    try {
      const chat = await harness.database.createChat("Shared media");
      const sourceAttachment = await createAttachment(
        harness.applicationPaths,
        chat.id,
        0,
        "shared.png",
      );

      const sourceUserMessage = await harness.database.appendMessage(
        chat.id,
        "user",
        "Inspect this image",
        [sourceAttachment],
      );
      await harness.database.appendMessage(chat.id, "assistant", "Looks shared.");

      const branch = await branchChatAtMessage(
        harness.applicationPaths,
        harness.database,
        chat.id,
        sourceUserMessage.id,
      );

      expect(branch).not.toBeNull();

      const sourceChatSnapshot = harness.database.getChat(chat.id);

      expect(sourceChatSnapshot).not.toBeNull();
      expect(await harness.database.deleteChat(chat.id)).toBe(true);
      await cleanupMessageAttachments(sourceChatSnapshot?.messages ?? [], harness.database);

      expect(existsSync(sourceAttachment.filePath)).toBe(false);
      expect(existsSync(branch?.messages[0]?.mediaAttachments[0]?.filePath ?? "")).toBe(true);
    } finally {
      await cleanupHarness(harness);
    }
  }, 15_000);

  test("cleanup deletes only the unreferenced files from a removed attachment batch", async () => {
    const harness = await createHarness();

    try {
      const chat = await harness.database.createChat("Batch cleanup");
      const initialUser = await harness.database.appendMessage(chat.id, "user", "Original prompt");

      await harness.database.appendMessage(chat.id, "assistant", "Original answer");

      const sharedAttachment = await createAttachment(
        harness.applicationPaths,
        chat.id,
        2,
        "shared.png",
      );
      const exclusiveAttachment = await createAttachment(
        harness.applicationPaths,
        chat.id,
        4,
        "exclusive.png",
      );

      const sharedMessage = await harness.database.appendMessage(chat.id, "user", "Shared media", [
        sharedAttachment,
      ]);

      await harness.database.appendMessage(chat.id, "assistant", "Shared answer");
      await harness.database.appendMessage(chat.id, "user", "Exclusive media", [
        exclusiveAttachment,
      ]);
      await harness.database.appendMessage(chat.id, "assistant", "Exclusive answer");

      const branch = await branchChatAtMessage(
        harness.applicationPaths,
        harness.database,
        chat.id,
        sharedMessage.id,
      );

      expect(branch).not.toBeNull();

      const truncated = await harness.database.replaceMessageAndTruncateFollowing(
        chat.id,
        initialUser.id,
        "Edited prompt",
      );

      expect(truncated).not.toBeNull();
      expect(truncated?.removedMessages).toHaveLength(5);

      await cleanupMessageAttachments(truncated?.removedMessages ?? [], harness.database);

      expect(existsSync(sharedAttachment.filePath)).toBe(false);
      expect(existsSync(branch?.messages[2]?.mediaAttachments[0]?.filePath ?? "")).toBe(true);
      expect(existsSync(exclusiveAttachment.filePath)).toBe(false);
    } finally {
      await cleanupHarness(harness);
    }
  }, 15_000);
});

async function createHarness(): Promise<{
  applicationPaths: ApplicationPaths;
  database: AppDatabase;
  rootDir: string;
}> {
  const rootDir = await createBackendTestScratchDir("local-llm-gui-chat-mutations");
  const applicationPaths: ApplicationPaths = {
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

  return {
    applicationPaths,
    database: new AppDatabase(applicationPaths),
    rootDir,
  };
}

async function cleanupHarness(harness: { database: AppDatabase; rootDir: string }): Promise<void> {
  harness.database.close();
  await removeBackendTestScratchDir(harness.rootDir);
}

async function createAttachment(
  applicationPaths: ApplicationPaths,
  chatId: string,
  messageIndex: number,
  fileName: string,
): Promise<MediaAttachmentRecord> {
  const attachmentId = crypto.randomUUID();
  const targetDirectory = path.join(applicationPaths.mediaDir, chatId, String(messageIndex));
  const targetFilePath = path.join(targetDirectory, `${attachmentId}-${fileName}`);

  await mkdir(targetDirectory, { recursive: true });
  await writeFile(targetFilePath, "test-data", "utf8");

  return {
    byteSize: 9,
    fileName,
    filePath: targetFilePath,
    id: attachmentId,
    kind: "image",
    mimeType: "image/png",
  };
}
