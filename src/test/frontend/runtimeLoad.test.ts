import { expect, test } from "bun:test";
import {
  buildRuntimeLoadFailureSnapshot,
  calculateRuntimeLoadTimeoutMs,
  shouldStartRuntimeLoadPolling,
} from "../../lib/runtimeLoad";

test("calculateRuntimeLoadTimeoutMs grows with model size and context within bounds", () => {
  const baselineTimeout = calculateRuntimeLoadTimeoutMs({
    contextLength: 4_096,
    fileSizeBytes: 0,
  });
  const largerTimeout = calculateRuntimeLoadTimeoutMs({
    contextLength: 16_384,
    fileSizeBytes: 3 * 1024 * 1024 * 1024,
  });
  const clampedTimeout = calculateRuntimeLoadTimeoutMs({
    contextLength: 65_536,
    fileSizeBytes: 20 * 1024 * 1024 * 1024,
  });

  expect(baselineTimeout).toBe(120_000);
  expect(largerTimeout).toBeGreaterThan(baselineTimeout);
  expect(clampedTimeout).toBe(420_000);
});

test("shouldStartRuntimeLoadPolling uses polling only when the runtime stream is unavailable", () => {
  expect(shouldStartRuntimeLoadPolling(false)).toBe(true);
  expect(shouldStartRuntimeLoadPolling(true)).toBe(false);
});

test("buildRuntimeLoadFailureSnapshot creates an explicit recoverable error state", () => {
  const snapshot = buildRuntimeLoadFailureSnapshot({
    errorMessage: "llama-server exited before the model became ready.",
    loadPreset: {
      settings: {
        cachePrompt: true,
        contextLength: 8192,
        cpuThreads: 8,
        flashAttention: true,
        gpuLayers: 24,
        mlock: false,
        temperature: 0.7,
        topK: 40,
        topP: 0.9,
      },
    },
    model: {
      contextLength: 4096,
      id: "model-1",
      mmprojPath: null,
      modelPath: "D:/models/model-1.gguf",
      supportsAudio: false,
    },
    previousRuntime: null,
    updatedAt: "2026-04-15T00:00:00.000Z",
  });

  expect(snapshot).toEqual({
    activeModelId: "model-1",
    activeModelPath: "D:/models/model-1.gguf",
    audio: false,
    contextLimitTokens: 8192,
    contextTokens: null,
    lastError: "llama-server exited before the model became ready.",
    llamaServerBaseUrl: null,
    loadProgress: null,
    multimodal: false,
    status: "error",
    tokensPerSecond: null,
    updatedAt: "2026-04-15T00:00:00.000Z",
  });
});
