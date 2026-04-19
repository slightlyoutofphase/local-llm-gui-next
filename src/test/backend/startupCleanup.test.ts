import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { ApplicationPaths } from "../../backend/paths";
import { sweepStartupTemplateOverrideFiles } from "../../backend/startupCleanup";
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
      log: (message: string) => {
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
});
