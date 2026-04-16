import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigStore } from "../../backend/config";
import type { ApplicationPaths } from "../../backend/paths";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe.serial("ConfigStore", () => {
  let applicationPaths: ApplicationPaths;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-config");
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
  });

  afterEach(async () => {
    await removeBackendTestScratchDir(rootDir);
  });

  test("creates and persists defaults when the config file is missing", async () => {
    const store = new ConfigStore(applicationPaths);

    const config = await store.getConfig();
    const persisted = JSON.parse(
      await readFile(applicationPaths.configFilePath, "utf8"),
    ) as typeof config;

    expect(store.getLoadWarning()).toBeNull();
    expect(config.debug.verboseServerLogs).toBe(false);
    expect(persisted.debug.verboseServerLogs).toBe(false);
    expect(persisted).toEqual(config);
  });

  test("persists the verbose server logging preference", async () => {
    const store = new ConfigStore(applicationPaths);

    const updatedConfig = await store.updateConfig({
      debug: {
        verboseServerLogs: true,
      },
    });
    const persisted = JSON.parse(
      await readFile(applicationPaths.configFilePath, "utf8"),
    ) as typeof updatedConfig;

    expect(updatedConfig.debug.verboseServerLogs).toBe(true);
    expect(persisted.debug.verboseServerLogs).toBe(true);
  });

  test("preserves malformed config files until the user explicitly saves settings", async () => {
    const invalidConfig = '{\n  "theme": "dark",\n';

    await Bun.write(applicationPaths.configFilePath, invalidConfig);

    const store = new ConfigStore(applicationPaths);

    const config = await store.getConfig();
    const afterRead = await readFile(applicationPaths.configFilePath, "utf8");

    expect(afterRead).toBe(invalidConfig);
    expect(config.theme).toBe("system");
    expect(store.getLoadWarning()).toContain("could not be loaded");

    const updatedConfig = await store.updateConfig({ theme: "dark" });
    const afterSave = JSON.parse(
      await readFile(applicationPaths.configFilePath, "utf8"),
    ) as typeof updatedConfig;

    expect(updatedConfig.theme).toBe("dark");
    expect(afterSave.theme).toBe("dark");
    expect(store.getLoadWarning()).toBeNull();
  });
});
