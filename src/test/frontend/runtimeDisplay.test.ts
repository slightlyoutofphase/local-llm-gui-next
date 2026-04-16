import { describe, expect, test } from "bun:test";
import type { LoadInferencePreset, ModelRecord, RuntimeSnapshot } from "../../lib/contracts";
import { resolveRuntimeContextLimit } from "../../lib/runtimeDisplay";

function createModelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    defaultSampling: {},
    fileName: "model.gguf",
    fileSizeBytes: 1024,
    id: "publisher/model/model.gguf",
    modelName: "Model",
    modelPath: "D:/models/model.gguf",
    publisher: "publisher",
    supportsAudio: false,
    ...overrides,
  };
}

function createLoadPreset(contextLength: number): LoadInferencePreset {
  return {
    createdAt: "2026-04-12T00:00:00.000Z",
    id: "preset-1",
    isDefault: true,
    modelId: "publisher/model/model.gguf",
    name: "Preset",
    settings: {
      batchSize: 512,
      contextLength,
      contextShift: false,
      cpuThreads: 4,
      flashAttention: false,
      fullSwaCache: false,
      gpuLayers: 0,
      keepModelInMemory: false,
      minP: 0.05,
      offloadKvCache: true,
      overflowStrategy: "truncate-middle",
      presencePenalty: 0,
      repeatPenalty: 1,
      seed: -1,
      stopStrings: [],
      structuredOutputMode: "off",
      temperature: 0.7,
      thinkingEnabled: true,
      topK: 40,
      topP: 0.9,
      ubatchSize: 256,
      unifiedKvCache: false,
      useMmap: true,
    },
    updatedAt: "2026-04-12T00:00:00.000Z",
  };
}

function createRuntimeSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    activeModelId: "publisher/model/model.gguf",
    activeModelPath: "D:/models/model.gguf",
    audio: false,
    contextTokens: 128,
    lastError: null,
    llamaServerBaseUrl: "http://127.0.0.1:4001",
    loadProgress: 100,
    multimodal: false,
    status: "ready",
    tokensPerSecond: null,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveRuntimeContextLimit", () => {
  test("prefers the active runtime context ceiling over stale sidebar model metadata", () => {
    const limit = resolveRuntimeContextLimit(
      createRuntimeSnapshot({ contextLimitTokens: 8192 }),
      createModelRecord({ contextLength: 262144 }),
      createLoadPreset(4096),
      createModelRecord({ contextLength: 0, id: "other/model.gguf" }),
    );

    expect(limit).toBe(8192);
  });

  test("falls back to the selected load preset before showing zero", () => {
    const limit = resolveRuntimeContextLimit(
      createRuntimeSnapshot({ activeModelId: null, contextLimitTokens: null, status: "loading" }),
      null,
      createLoadPreset(4096),
      createModelRecord({ contextLength: undefined }),
    );

    expect(limit).toBe(4096);
  });

  test("uses the active runtime model metadata when the runtime snapshot lacks a ceiling", () => {
    const limit = resolveRuntimeContextLimit(
      createRuntimeSnapshot({ contextLimitTokens: null }),
      createModelRecord({ contextLength: 16384 }),
      null,
      createModelRecord({ contextLength: 0 }),
    );

    expect(limit).toBe(16384);
  });
});
