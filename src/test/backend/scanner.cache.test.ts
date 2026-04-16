import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParsedModelMetadata } from "../../backend/gguf";
import { AppDatabase } from "../../backend/db";
import type { DebugLogService } from "../../backend/debug";
import type { ApplicationPaths } from "../../backend/paths";
import { ModelScanner } from "../../backend/scanner";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe("ModelScanner cache coherence", () => {
  test("caches unchanged scans and bumps db_revision only when defaults are first seeded", async () => {
    const harness = await createScannerCacheHarness();

    try {
      const initialRevision = harness.database.getRevision();

      const firstScan = await harness.scanner.scanModels(harness.modelsDir);
      const revisionAfterFirstScan = harness.database.getRevision();
      const secondScan = await harness.scanner.scanModels(harness.modelsDir);
      const revisionAfterSecondScan = harness.database.getRevision();

      expect(firstScan).toHaveLength(1);
      expect(secondScan).toEqual(firstScan);
      expect(harness.debugLogs).toHaveLength(1);
      expect(revisionAfterFirstScan).toBe(initialRevision + 1);
      expect(revisionAfterSecondScan).toBe(revisionAfterFirstScan);
    } finally {
      await cleanupScannerCacheHarness(harness);
    }
  });

  test("invalidates the cached scan when a gguf file fingerprint changes", async () => {
    const harness = await createScannerCacheHarness();

    try {
      await harness.scanner.scanModels(harness.modelsDir);

      expect(harness.debugLogs).toHaveLength(1);

      await Bun.sleep(20);
      await writeFile(harness.modelFilePath, Buffer.from("still-not-a-valid-gguf-but-different"));

      const rescannedModels = await harness.scanner.scanModels(harness.modelsDir);

      expect(harness.debugLogs).toHaveLength(2);
      expect(rescannedModels[0]?.fileSizeBytes).toBe(
        Buffer.byteLength("still-not-a-valid-gguf-but-different"),
      );
    } finally {
      await cleanupScannerCacheHarness(harness);
    }
  });

  test("bounds concurrent GGUF metadata reads while preserving candidate order", async () => {
    const harness = await createScannerCacheHarness();

    try {
      const secondModelPath = path.join(
        harness.modelsDir,
        "publisher",
        "model-name",
        "demo-Q4_K_M.gguf",
      );
      const thirdModelPath = path.join(
        harness.modelsDir,
        "publisher",
        "model-name",
        "demo-IQ4_XS.gguf",
      );

      await Promise.all([
        writeFile(secondModelPath, Buffer.from("another-invalid-gguf")),
        writeFile(thirdModelPath, Buffer.from("third-invalid-gguf")),
      ]);

      let activeReads = 0;
      let maxObservedReads = 0;
      const readOrder: string[] = [];
      const scanner = new ModelScanner(harness.database, undefined, {
        maxConcurrentMetadataReads: 2,
        readMetadata: async (modelFilePath): Promise<ParsedModelMetadata> => {
          activeReads += 1;
          maxObservedReads = Math.max(maxObservedReads, activeReads);
          readOrder.push(path.basename(modelFilePath));

          await Bun.sleep(5);
          activeReads -= 1;

          return {
            architecture: "qwen3",
            contextLength: 4096,
            defaultSampling: {},
            supportsAudio: false,
          };
        },
      });

      const models = await scanner.scanModels(harness.modelsDir);

      expect(maxObservedReads).toBe(2);
      expect(models.map((model) => model.fileName)).toEqual([
        "demo-IQ4_XS.gguf",
        "demo-Q4_K_M.gguf",
        "demo-Q8_0.gguf",
      ]);
      expect(readOrder).toEqual(["demo-IQ4_XS.gguf", "demo-Q4_K_M.gguf", "demo-Q8_0.gguf"]);
    } finally {
      await cleanupScannerCacheHarness(harness);
    }
  });
});

interface ScannerCacheHarness {
  readonly database: AppDatabase;
  readonly debugLogs: string[];
  readonly modelFilePath: string;
  readonly modelsDir: string;
  readonly rootDir: string;
  readonly scanner: ModelScanner;
}

async function createScannerCacheHarness(): Promise<ScannerCacheHarness> {
  const rootDir = await createBackendTestScratchDir("local-llm-gui-scanner-cache");
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

  const modelsDir = path.join(rootDir, "models");
  const modelFilePath = path.join(modelsDir, "publisher", "model-name", "demo-Q8_0.gguf");

  await mkdir(path.dirname(modelFilePath), { recursive: true });
  await writeFile(modelFilePath, Buffer.from("not-a-valid-gguf"));

  const database = new AppDatabase(applicationPaths);
  const debugLogs: string[] = [];
  const debugLogService = {
    serverLog: (message: string) => {
      debugLogs.push(message);
    },
  } as DebugLogService;

  return {
    database,
    debugLogs,
    modelFilePath,
    modelsDir,
    rootDir,
    scanner: new ModelScanner(database, debugLogService),
  };
}

async function cleanupScannerCacheHarness(harness: ScannerCacheHarness): Promise<void> {
  harness.database.close();
  await removeBackendTestScratchDir(harness.rootDir);
}
