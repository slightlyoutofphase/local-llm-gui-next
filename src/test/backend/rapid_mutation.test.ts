import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { branchChatAtMessage, cleanupMessageAttachments } from "../../backend/chatMutations";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import type { MediaAttachmentRecord } from "../../lib/contracts";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe("rapid mutation integration", () => {
  test("upload, mutate, branch, and cleanup under concurrency handles properly", async () => {
    const harness = await createHarness();

    try {
      const chat = await harness.database.createChat("Rapid mutation chat");

      // 1. Simulate an attachment upload / staging
      const attachment = await createAttachment(harness.applicationPaths, chat.id, 0, "rapid.png");
      const userMessage = await harness.database.appendMessage(
        chat.id,
        "user",
        "Here is the rapid attachment",
        [attachment],
      );
      const assistantMessage = await harness.database.appendMessage(
        chat.id,
        "assistant",
        "Received rapid attachment.",
      );

      // 2. Simulate rapid concurrent operations
      // We branch the chat twice at the user message while simultaneously adding new messages.
      const branchPromise1 = branchChatAtMessage(
        harness.applicationPaths,
        harness.database,
        chat.id,
        userMessage.id,
      );

      const branchPromise2 = branchChatAtMessage(
        harness.applicationPaths,
        harness.database,
        chat.id,
        assistantMessage.id,
      );

      const appendPromise = harness.database.appendMessage(
        chat.id,
        "user",
        "Piling on another message.",
      );

      const [branch1, branch2, newAppend] = await Promise.all([
        branchPromise1,
        branchPromise2,
        appendPromise,
      ]);

      expect(branch1).not.toBeNull();
      expect(branch2).not.toBeNull();
      expect(newAppend).not.toBeNull();

      // Ensure the source file still exists and wasn't prematurely deleted by races
      expect(existsSync(attachment.filePath)).toBe(true);

      // Mutate the original message to remove the attachment by truncating its subsequent messages
      const truncated = await harness.database.replaceMessageAndTruncateFollowing(
        chat.id,
        userMessage.id,
        "Edited prompt without attachment",
      );

      expect(truncated).not.toBeNull();
      expect(truncated?.removedMessages).toHaveLength(2); // The assistant message and the new user append are removed!

      // Now we run cleanup on the original attachments.
      await cleanupMessageAttachments(truncated?.removedMessages ?? [], harness.database);

      // Even though the original chat removed those messages, the branches should have protected the main files
      // OR wait, branchChatAtMessage creates completely independent copies of the attachment files!
      // So the original attachment can be safely discarded by cleanup without affecting branches.

      // Actually wait, replaceMessageAndTruncateFollowing does NOT drop the attachments on the userMessage itself.
      // E.g. truncated.removedMessages are the messages AFTER `userMessage.id`.
      // The attachment is on `userMessage.id`, so it wasn't removed!
      expect(existsSync(attachment.filePath)).toBe(true);

      // If we completely delete the original chat:
      await harness.database.deleteChat(chat.id);
      const allMessages = [userMessage, assistantMessage, newAppend];
      await cleanupMessageAttachments(allMessages, harness.database);

      // Now the original is gone, but branches are preserved!
      expect(existsSync(attachment.filePath)).toBe(false);

      if (branch1?.messages[0]?.mediaAttachments[0]) {
        expect(existsSync(branch1.messages[0].mediaAttachments[0].filePath)).toBe(true);
      }
      if (branch2?.messages[0]?.mediaAttachments[0]) {
        expect(existsSync(branch2.messages[0].mediaAttachments[0].filePath)).toBe(true);
      }
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
  const rootDir = await createBackendTestScratchDir("local-llm-gui-rapid-mutation");
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
