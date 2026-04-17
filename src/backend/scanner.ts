import { readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { ModelRecord } from "../lib/contracts";
import { AppDatabase } from "./db";
import type { DebugLogService } from "./debug";
import { readModelMetadata } from "./gguf";

const DEFAULT_MODEL_SCAN_CONCURRENCY = Math.max(
  1,
  Math.min(4, Math.floor(availableParallelism() / 2)),
);

interface DiscoveredGgufFile {
  byteSize: number;
  fileName: string;
  filePath: string;
  modifiedAtMs: number;
}

interface ScanCandidate {
  baseFile: DiscoveredGgufFile;
  mmprojFile: DiscoveredGgufFile | undefined;
  modelName: string;
  publisher: string;
}

interface ScanCacheEntry {
  manifestKey: string;
  models: ModelRecord[];
  modelsRoot: string;
}

interface ModelScannerDependencies {
  maxConcurrentMetadataReads?: number;
  readMetadata?: typeof readModelMetadata;
}

/**
 * Traverses the configured models directory and produces hierarchical GGUF records.
 */
export class ModelScanner {
  private scanCache: ScanCacheEntry | null = null;
  private scanWatcher: FSWatcher | null = null;
  private scanWarning: string | null = null;
  private readonly maxConcurrentMetadataReads: number;
  private readonly readMetadata: typeof readModelMetadata;

  /**
   * Creates a new model scanner.
   *
   * @param database The application persistence layer used to seed default presets.
   * @param debugLogService Optional debug log service for reporting scan errors.
   */
  public constructor(
    _database: AppDatabase,
    private readonly debugLogService?: DebugLogService,
    dependencies: ModelScannerDependencies = {},
  ) {
    this.maxConcurrentMetadataReads = normalizeScanConcurrency(
      dependencies.maxConcurrentMetadataReads,
    );
    this.readMetadata = dependencies.readMetadata ?? readModelMetadata;
  }

  /**
   * Returns the latest top-level scan warning, if any.
   *
   * @returns The current scan warning.
   */
  public getScanWarning(): string | null {
    return this.scanWarning;
  }

  /**
   * Returns the cached model records from the last successful scan without
   * re-walking the filesystem. Falls back to a full scan when no cache
   * exists yet or when the models root has changed.
   *
   * @param modelsRoot Absolute path to the models root directory.
   * @returns The cached or freshly scanned model records.
   */
  public async getCachedOrScanModels(modelsRoot: string): Promise<ModelRecord[]> {
    if (this.scanCache && this.scanCache.modelsRoot === modelsRoot) {
      return this.scanCache.models.map((model) => cloneModelRecord(model));
    }

    return this.scanModels(modelsRoot);
  }

  /**
   * Scans the configured models root for `publisher/model/file.gguf` entries.
   *
   * @param modelsRoot Absolute path to the models root directory.
   * @returns The discovered model records.
   */
  public async scanModels(modelsRoot: string): Promise<ModelRecord[]> {
    if (!modelsRoot) {
      this.scanCache = null;
      this.scanWarning = null;
      return [];
    }

    try {
      const scanCandidates = await this.discoverScanCandidates(modelsRoot);
      const manifestKey = createScanManifestKey(modelsRoot, scanCandidates);

      if (this.scanCache?.modelsRoot === modelsRoot && this.scanCache.manifestKey === manifestKey) {
        this.scanWarning = null;
        return this.scanCache.models.map((model) => cloneModelRecord(model));
      }

      const discoveredModels = await mapWithConcurrency(
        scanCandidates,
        this.maxConcurrentMetadataReads,
        async (candidate) => await this.buildModelRecord(candidate),
      );

      const sortedModels = discoveredModels.sort((leftModel, rightModel) =>
        leftModel.id.localeCompare(rightModel.id, undefined, { sensitivity: "base" }),
      );

      this.scanCache = {
        manifestKey,
        models: sortedModels.map((model) => cloneModelRecord(model)),
        modelsRoot,
      };
      this.scanWarning = null;
      this.installModelsRootWatcher(modelsRoot);

      return sortedModels;
    } catch (error: unknown) {
      this.scanCache = null;

      const errorMessage = error instanceof Error ? error.message : "Unknown model scan error";
      this.scanWarning = createModelScanWarning(modelsRoot, errorMessage);

      this.debugLogService?.serverLog(`Model scan failed for ${modelsRoot}: ${errorMessage}`);

      return [];
    }
  }

  private installModelsRootWatcher(modelsRoot: string): void {
    if (this.scanWatcher) {
      this.scanWatcher.close();
      this.scanWatcher = null;
    }

    try {
      this.scanWatcher = watch(modelsRoot, { recursive: true }, () => {
        this.scanCache = null;
        this.scanWarning = null;
      });

      this.scanWatcher.on("error", () => {
        this.scanCache = null;
        this.scanWarning = null;
        this.scanWatcher?.close();
        this.scanWatcher = null;
      });
    } catch {
      this.scanWatcher = null;
    }
  }

  private async discoverScanCandidates(modelsRoot: string): Promise<ScanCandidate[]> {
    const publisherEntries = await readdir(modelsRoot, { withFileTypes: true });
    const scanCandidates: ScanCandidate[] = [];

    for (const publisherEntry of publisherEntries) {
      if (!publisherEntry.isDirectory()) {
        continue;
      }

      const publisherPath = path.join(modelsRoot, publisherEntry.name);
      const modelEntries = await readdir(publisherPath, { withFileTypes: true });

      for (const modelEntry of modelEntries) {
        if (!modelEntry.isDirectory()) {
          continue;
        }

        const modelDirectoryPath = path.join(publisherPath, modelEntry.name);
        const fileEntries = await readdir(modelDirectoryPath, { withFileTypes: true });
        const ggufFiles = await Promise.all(
          fileEntries
            .filter(
              (fileEntry) => fileEntry.isFile() && fileEntry.name.toLowerCase().endsWith(".gguf"),
            )
            .map(async (fileEntry) => {
              const filePath = path.join(modelDirectoryPath, fileEntry.name);
              const fileStats = await stat(filePath);

              return {
                byteSize: fileStats.size,
                fileName: fileEntry.name,
                filePath,
                modifiedAtMs: fileStats.mtimeMs,
              } satisfies DiscoveredGgufFile;
            }),
        );
        const mmprojFiles = ggufFiles
          .filter((file) => file.fileName.toLowerCase().includes("mmproj"))
          .sort((leftFile, rightFile) =>
            leftFile.fileName.localeCompare(rightFile.fileName, undefined, { sensitivity: "base" }),
          );
        const baseFiles = ggufFiles
          .filter((file) => !file.fileName.toLowerCase().includes("mmproj"))
          .sort((leftFile, rightFile) =>
            leftFile.fileName.localeCompare(rightFile.fileName, undefined, { sensitivity: "base" }),
          );

        if (baseFiles.length === 0) {
          continue;
        }

        for (const baseFile of baseFiles) {
          scanCandidates.push({
            baseFile,
            mmprojFile: mmprojFiles[0],
            modelName: modelEntry.name,
            publisher: publisherEntry.name,
          });
        }
      }
    }

    return scanCandidates;
  }

  private async buildModelRecord(candidate: ScanCandidate): Promise<ModelRecord> {
    const modelId = [candidate.publisher, candidate.modelName, candidate.baseFile.fileName].join(
      "/",
    );

    try {
      const metadata = await this.readMetadata(
        candidate.baseFile.filePath,
        candidate.mmprojFile?.filePath,
      );

      return buildScannedModelRecord(candidate, modelId, metadata);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown GGUF parse error";

      this.debugLogService?.serverLog(
        `GGUF metadata read failed for ${candidate.baseFile.filePath}: ${errorMessage}`,
      );

      return buildFallbackModelRecord(candidate, modelId);
    }
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  maxConcurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(maxConcurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;

      if (currentIndex >= items.length) {
        return;
      }

      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: boundedConcurrency }, async () => {
      await worker();
    }),
  );

  return results;
}

function buildScannedModelRecord(
  candidate: ScanCandidate,
  modelId: string,
  metadata: Awaited<ReturnType<typeof readModelMetadata>>,
): ModelRecord {
  const modelRecord: ModelRecord = {
    id: modelId,
    publisher: candidate.publisher,
    modelName: candidate.modelName,
    fileName: candidate.baseFile.fileName,
    modelPath: candidate.baseFile.filePath,
    fileSizeBytes: candidate.baseFile.byteSize,
    supportsAudio: metadata.supportsAudio,
    defaultSampling: metadata.defaultSampling,
  };

  if (candidate.mmprojFile?.filePath) {
    modelRecord.mmprojPath = candidate.mmprojFile.filePath;
  }

  if (metadata.architecture) {
    modelRecord.architecture = metadata.architecture;
  }

  if (typeof metadata.contextLength === "number") {
    modelRecord.contextLength = metadata.contextLength;
  }

  if (typeof metadata.parameterCount === "number") {
    modelRecord.parameterCount = metadata.parameterCount;
  }

  if (typeof metadata.layerCount === "number") {
    modelRecord.layerCount = metadata.layerCount;
  }

  if (metadata.quantization) {
    modelRecord.quantization = metadata.quantization;
  }

  if (metadata.chatTemplate) {
    modelRecord.chatTemplate = metadata.chatTemplate;
  }

  return modelRecord;
}

function buildFallbackModelRecord(candidate: ScanCandidate, modelId: string): ModelRecord {
  const fallbackRecord: ModelRecord = {
    id: modelId,
    publisher: candidate.publisher,
    modelName: candidate.modelName,
    fileName: candidate.baseFile.fileName,
    modelPath: candidate.baseFile.filePath,
    fileSizeBytes: candidate.baseFile.byteSize,
    supportsAudio: false,
    defaultSampling: {},
  };

  if (candidate.mmprojFile?.filePath) {
    fallbackRecord.mmprojPath = candidate.mmprojFile.filePath;
  }

  const quantizationMatch = candidate.baseFile.fileName.match(
    /(Q\d(?:_\d)?|IQ\d(?:_[A-Za-z0-9]+)?)/i,
  );

  if (quantizationMatch?.[1]) {
    fallbackRecord.quantization = quantizationMatch[1];
  }

  return fallbackRecord;
}

function normalizeScanConcurrency(maxConcurrency?: number): number {
  if (!Number.isFinite(maxConcurrency) || maxConcurrency === undefined) {
    return DEFAULT_MODEL_SCAN_CONCURRENCY;
  }

  return Math.max(1, Math.trunc(maxConcurrency));
}

function createScanManifestKey(modelsRoot: string, scanCandidates: ScanCandidate[]): string {
  return JSON.stringify({
    modelsRoot,
    scanCandidates: scanCandidates.map((candidate) => ({
      baseFileName: candidate.baseFile.fileName,
      baseFilePath: candidate.baseFile.filePath,
      baseModifiedAtMs: Math.trunc(candidate.baseFile.modifiedAtMs),
      byteSize: candidate.baseFile.byteSize,
      mmprojFilePath: candidate.mmprojFile?.filePath ?? null,
      mmprojModifiedAtMs: candidate.mmprojFile
        ? Math.trunc(candidate.mmprojFile.modifiedAtMs)
        : null,
      modelName: candidate.modelName,
      publisher: candidate.publisher,
    })),
  });
}

function cloneModelRecord(model: ModelRecord): ModelRecord {
  return {
    ...model,
    defaultSampling: {
      ...model.defaultSampling,
    },
  };
}

function createModelScanWarning(modelsRoot: string, reason: string): string {
  return [
    `The models directory at ${modelsRoot} could not be scanned.`,
    "Verify that the configured path exists and is readable, then refresh the scan.",
    `Reason: ${reason}`,
  ].join(" ");
}
