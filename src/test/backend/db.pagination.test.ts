import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";

import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

interface AppDatabaseProbe {
  database: {
    query: (sql: string) => {
      get(): Record<string, number> | null;
    };
  };
}

describe.serial("AppDatabase chat pagination", () => {
  let applicationPaths: ApplicationPaths;
  let database: AppDatabase;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-db-pagination");
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

  test("returns newest transcript pages in ascending order with an older-page cursor", async () => {
    const chat = await database.createChat("Paged chat");

    for (let messageIndex = 0; messageIndex < 5; messageIndex += 1) {
      await database.appendMessage(
        chat.id,
        messageIndex % 2 === 0 ? "user" : "assistant",
        `Message ${messageIndex}`,
      );
    }

    const firstPage = database.getChatPage(chat.id, 2);
    const secondPage = database.getChatPage(chat.id, 2, firstPage?.nextBeforeSequence ?? undefined);
    const finalPage = database.getChatPage(chat.id, 2, secondPage?.nextBeforeSequence ?? undefined);

    expect(firstPage?.messages.map((message) => message.sequence)).toEqual([3, 4]);
    expect(firstPage?.hasOlderMessages).toBe(true);
    expect(firstPage?.nextBeforeSequence).toBe(3);

    expect(secondPage?.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(secondPage?.hasOlderMessages).toBe(true);
    expect(secondPage?.nextBeforeSequence).toBe(1);

    expect(finalPage?.messages.map((message) => message.sequence)).toEqual([0]);
    expect(finalPage?.hasOlderMessages).toBe(false);
    expect(finalPage?.nextBeforeSequence).toBeNull();
  }, 15_000);

  test("manual chat renames win over later auto-name compare-and-set updates", async () => {
    const chat = await database.createChat("New chat");

    const manuallyRenamedChat = await database.updateChatTitle(chat.id, "Manual title");
    const autoNamedChat = await database.updateChatTitleIfMatch(
      chat.id,
      "New chat",
      "Generated title",
    );
    const persistedChat = database.getChat(chat.id);

    expect(manuallyRenamedChat?.title).toBe("Manual title");
    expect(autoNamedChat).toBeNull();
    expect(persistedChat?.chat.title).toBe("Manual title");
  }, 15_000);

  test("rejects message writes after the parent chat has been deleted", async () => {
    const chat = await database.createChat("Deleted chat");

    expect(await database.deleteChat(chat.id)).toBe(true);
    await expect(
      database.appendMessage(chat.id, "user", "This write should fail."),
    ).rejects.toThrow(`Chat not found: ${chat.id}`);
  }, 15_000);

  test("configures a non-zero SQLite busy timeout on each database connection", async () => {
    const databaseHandle = (database as unknown as AppDatabaseProbe).database;
    const pragmaRow = databaseHandle.query("PRAGMA busy_timeout").get();
    const busyTimeout = pragmaRow ? Object.values(pragmaRow)[0] : null;

    expect(busyTimeout).toBe(250);
  }, 15_000);
});
