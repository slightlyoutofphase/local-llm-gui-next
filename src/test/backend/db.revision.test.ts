import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe("AppDatabase.getRevision", () => {
  let rootDir = "";
  let database: AppDatabase | null = null;

  afterEach(async () => {
    if (database) {
      database.close();
      database = null;
    }

    if (rootDir) {
      await removeBackendTestScratchDir(rootDir);
      rootDir = "";
    }
  });

  test("throws when the db_revision metadata row is missing", async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-db-revision");
    const paths: ApplicationPaths = {
      workspaceRoot: rootDir,
      userDataDir: path.join(rootDir, "user-data"),
      configFilePath: path.join(rootDir, "user-data", "config.json"),
      databasePath: path.join(rootDir, "user-data", "local-llm-gui.sqlite"),
      mediaDir: path.join(rootDir, "user-data", "media"),
      toolsDir: path.join(rootDir, "user-data", "tools"),
      tempDir: path.join(rootDir, "user-data", "temp"),
      staticOutDir: path.join(rootDir, "out"),
    };

    database = new AppDatabase(paths);
    const internalDatabase = Reflect.get(database, "database") as {
      query(sql: string): { run(): void };
    };
    internalDatabase.query("DELETE FROM meta WHERE key = 'db_revision'").run();

    expect(() => database!.getRevision()).toThrow(
      "The application database is missing required revision metadata.",
    );
  });

  test("throws when the db_revision metadata value is invalid", async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-db-revision-invalid");
    const paths: ApplicationPaths = {
      workspaceRoot: rootDir,
      userDataDir: path.join(rootDir, "user-data"),
      configFilePath: path.join(rootDir, "user-data", "config.json"),
      databasePath: path.join(rootDir, "user-data", "local-llm-gui.sqlite"),
      mediaDir: path.join(rootDir, "user-data", "media"),
      toolsDir: path.join(rootDir, "user-data", "tools"),
      tempDir: path.join(rootDir, "user-data", "temp"),
      staticOutDir: path.join(rootDir, "out"),
    };

    database = new AppDatabase(paths);
    const internalDatabase = Reflect.get(database, "database") as {
      query(sql: string): { run(): void };
    };
    internalDatabase
      .query("UPDATE meta SET value = 'not-a-number' WHERE key = 'db_revision'")
      .run();

    expect(() => database!.getRevision()).toThrow(
      "The application database contains an invalid revision metadata value.",
    );
  });
});
