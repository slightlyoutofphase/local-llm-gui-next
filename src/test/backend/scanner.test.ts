import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppDatabase } from "../../backend/db";
import type { DebugLogService } from "../../backend/debug";
import type { ApplicationPaths } from "../../backend/paths";
import { ModelScanner } from "../../backend/scanner";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

const REAL_MODELS_ROOT = path.resolve(import.meta.dir, "../../../test/models");

describe.serial("ModelScanner", () => {
  let applicationPaths: ApplicationPaths;
  let database: AppDatabase;
  let rootDir: string;
  let scanner: ModelScanner;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-scanner");
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
    scanner = new ModelScanner(database);
  });

  afterEach(async () => {
    database.close();
    await removeBackendTestScratchDir(rootDir);
  });

  test("returns an empty array when the models directory is empty", async () => {
    const emptyDir = path.join(rootDir, "empty-models");
    await mkdir(emptyDir, { recursive: true });

    const models = await scanner.scanModels(emptyDir);

    expect(models).toEqual([]);
  });

  test("returns an empty array when the root path is empty string", async () => {
    const models = await scanner.scanModels("");

    expect(models).toEqual([]);
    expect(scanner.getScanWarning()).toBeNull();
  });

  test("returns an empty array when the root path does not exist", async () => {
    const models = await scanner.scanModels("/nonexistent/path");

    expect(models).toEqual([]);
    expect(scanner.getScanWarning()).toContain("could not be scanned");
  });

  test("logs a diagnostic entry when the models root cannot be scanned", async () => {
    const debugMessages: string[] = [];
    const debugScanner = new ModelScanner(database, {
      serverLog: (message: string) => {
        debugMessages.push(message);
      },
    } as Pick<DebugLogService, "serverLog"> as DebugLogService);

    const models = await debugScanner.scanModels("/nonexistent/path");

    expect(models).toEqual([]);
    expect(debugScanner.getScanWarning()).toContain("could not be scanned");
    expect(debugMessages).toHaveLength(1);
    expect(debugMessages[0]).toContain("Model scan failed for /nonexistent/path:");
  });

  test("ignores directories without .gguf files", async () => {
    const modelsDir = path.join(rootDir, "models");
    const modelDir = path.join(modelsDir, "publisher", "model-name");
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(modelDir, "readme.txt"), "not a model");

    const models = await scanner.scanModels(modelsDir);

    expect(models).toEqual([]);
  });

  test("ignores directories containing only mmproj files", async () => {
    const modelsDir = path.join(rootDir, "models");
    const modelDir = path.join(modelsDir, "publisher", "model-name");
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(modelDir, "mmproj-something.gguf"), "fake");

    const models = await scanner.scanModels(modelsDir);

    expect(models).toEqual([]);
  });

  test("discovers and annotates models from the real test/models directory", async () => {
    const models = await scanner.scanModels(REAL_MODELS_ROOT);

    expect(models.length).toBeGreaterThan(0);

    const model = models[0]!;
    const modelWithMmproj = models.find((candidate) => candidate.mmprojPath);

    expect(model.id).toBeDefined();
    expect(model.publisher).toBe("unsloth");
    expect(model.modelName).toBe("Qwen3.5-0.8B-GGUF");
    expect(model.fileName).toContain(".gguf");
    expect(model.fileSizeBytes).toBeGreaterThan(0);
    expect(model.modelPath).toContain(".gguf");
    expect(model.defaultSampling).toBeDefined();
    expect(typeof model.supportsAudio).toBe("boolean");

    expect(modelWithMmproj).toBeDefined();
    expect(modelWithMmproj!.mmprojPath).toContain("mmproj");

    for (const discoveredModel of models) {
      const segments = discoveredModel.id.split("/");

      expect(segments.length).toBe(3);
      expect(segments[0]).toBe(discoveredModel.publisher);
      expect(segments[1]).toBe(discoveredModel.modelName);
      expect(segments[2]).toBe(discoveredModel.fileName);
    }

    if (models.length > 1) {
      for (let index = 1; index < models.length; index++) {
        expect(
          models[index - 1]!.id.localeCompare(models[index]!.id, undefined, {
            sensitivity: "base",
          }),
        ).toBeLessThanOrEqual(0);
      }
    }

    const systemPresets = database.listSystemPromptPresets(model.id);
    const loadPresets = database.listLoadInferencePresets(model.id);

    expect(systemPresets.length).toBe(0);
    expect(loadPresets.length).toBe(0);
  });
});
