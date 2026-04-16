import { describe, expect, test } from "bun:test";
import type { HardwareOptimizerResult, ModelRecord } from "../../lib/contracts";
import { loadOptimizerResult } from "../../components/Settings/HardwareOptimizer";

const TEST_MODEL: ModelRecord = {
  capabilities: {
    completion: true,
    embedding: false,
    imageUnderstanding: false,
    reasoning: false,
    tools: false,
  },
  contextLength: 4096,
  filePath: "D:/models/test.gguf",
  fileSizeBytes: 4 * 1024 * 1024 * 1024,
  format: "gguf",
  id: "model-a",
  layerCount: 32,
  loadPresets: [],
  mtimeMs: 1,
  name: "Model A",
  parameterCount: 7_000_000_000,
  publisher: "Test",
  quantization: "Q4_0",
  reasoningFormat: "none",
  systemPromptPresets: [],
  type: "text",
};

const OPTIMIZER_RESULT: HardwareOptimizerResult = {
  hardware: {
    backend: "cuda",
    gpus: [
      {
        freeVramBytes: 8 * 1024 * 1024 * 1024,
        totalVramBytes: 8 * 1024 * 1024 * 1024,
      },
    ],
    logicalCpuCount: 16,
    supportsGpuOffload: true,
    totalRamBytes: 32 * 1024 * 1024 * 1024,
  },
  recommendation: {
    estimatedGpuUsageBytes: 2 * 1024 * 1024 * 1024,
    estimatedTotalRamBytes: 6 * 1024 * 1024 * 1024,
    exceedsSystemRam: false,
    maxOffloadableLayers: 24,
    reasoning: ["Use 24 GPU layers."],
    recommendedContextLength: 4096,
    recommendedCpuThreads: 8,
    recommendedGpuLayers: 24,
  },
};

describe("loadOptimizerResult", () => {
  test("ignores stale optimizer responses after the active request changes", async () => {
    let resolveRecommendation: ((value: { optimizer: HardwareOptimizerResult }) => void) | null =
      null;
    let activeRequest = true;
    const errorValues: Array<string | null> = [];
    const loadingValues: boolean[] = [];
    const results: HardwareOptimizerResult[] = [];

    const request = loadOptimizerResult({
      getRecommendation: async () =>
        await new Promise<{ optimizer: HardwareOptimizerResult }>((resolve) => {
          resolveRecommendation = resolve;
        }),
      model: TEST_MODEL,
      requestedContextLength: 4096,
      setError: (error) => {
        errorValues.push(error);
      },
      setLoading: (loading) => {
        loadingValues.push(loading);
      },
      setResult: (result) => {
        if (result) {
          results.push(result);
        }
      },
      shouldCommit: () => activeRequest,
    });

    expect(loadingValues).toEqual([true]);
    expect(errorValues).toEqual([null]);

    activeRequest = false;
    resolveRecommendation?.({ optimizer: OPTIMIZER_RESULT });
    await request;

    expect(results).toEqual([]);
    expect(loadingValues).toEqual([true]);
  });
});
