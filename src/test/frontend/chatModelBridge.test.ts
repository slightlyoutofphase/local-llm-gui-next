import { describe, expect, test } from "bun:test";
import type {
  AppConfig,
  LoadInferencePreset,
  ModelRecord,
  RuntimeSnapshot,
} from "../../lib/contracts";
import {
  buildChatStoreModelContext,
  DEFAULT_CHAT_STORE_MODEL_CONTEXT,
} from "../../store/chatModelBridge";

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

function createLoadPreset(
  contextLength: number,
  mode: "json_object" | "json_schema" | "off",
): LoadInferencePreset {
  return {
    createdAt: "2026-04-12T00:00:00.000Z",
    id: `preset-${mode}`,
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
      structuredOutputMode: mode,
      ...(mode === "json_schema" ? { structuredOutputSchema: '{"type":"object"}' } : {}),
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
    tokensPerSecond: 12.5,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("chatModelBridge", () => {
  test("builds the chat-store model context from the active runtime preset", () => {
    const config: AppConfig = {
      autoNamingEnabled: false,
      customBinaries: {},
      debug: {
        enabled: true,
        maxEntries: 250,
        showProcessStderr: true,
        showProcessStdout: true,
        showServerLogs: true,
        verboseServerLogs: false,
      },
      llamaServerPath: "C:/llama-server.exe",
      modelsPath: "C:/models",
      theme: "system",
      toolEnabledStates: {},
    };

    const context = buildChatStoreModelContext({
      config,
      loadInferencePresetsByModelId: {
        "publisher/model/model.gguf": [createLoadPreset(4096, "json_schema")],
      },
      models: [createModelRecord()],
      runtime: createRuntimeSnapshot(),
      selectedLoadPresetIds: {
        "publisher/model/model.gguf": "preset-json_schema",
      },
      selectedModelId: "publisher/model/model.gguf",
    });

    expect(context.autoNamingEnabled).toBe(false);
    expect(context.debugMaxEntries).toBe(250);
    expect(context.structuredOutputMode).toBe("json_schema");
    expect(context.structuredOutputSchema).toBe('{"type":"object"}');
    expect(context.runtime?.activeModelId).toBe("publisher/model/model.gguf");
  });

  test("falls back to the default off-mode context when no active preset exists", () => {
    const context = buildChatStoreModelContext({
      config: null,
      loadInferencePresetsByModelId: {},
      models: [],
      runtime: null,
      selectedLoadPresetIds: {},
      selectedModelId: null,
    });

    expect(context).toEqual(DEFAULT_CHAT_STORE_MODEL_CONTEXT);
  });
});
import { describe, expect, test } from "bun:test";
import type {
  AppConfig,
  LoadInferencePreset,
  ModelRecord,
  RuntimeSnapshot,
} from "../../lib/contracts";
import {
  buildChatStoreModelContext,
  DEFAULT_CHAT_STORE_MODEL_CONTEXT,
} from "../../store/chatModelBridge";

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

function createLoadPreset(
  contextLength: number,
  mode: "json_object" | "json_schema" | "off",
): LoadInferencePreset {
  return {
    createdAt: "2026-04-12T00:00:00.000Z",
    id: `preset-${mode}`,
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
      structuredOutputMode: mode,
      ...(mode === "json_schema" ? { structuredOutputSchema: '{"type":"object"}' } : {}),
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
    tokensPerSecond: 12.5,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("chatModelBridge", () => {
  test("builds the chat-store model context from the active runtime preset", () => {
    const config: AppConfig = {
      autoNamingEnabled: false,
      customBinaries: {},
      debug: {
        enabled: true,
        maxEntries: 250,
        showProcessStderr: true,
        showProcessStdout: true,
        showServerLogs: true,
        verboseServerLogs: false,
      },
      llamaServerPath: "C:/llama-server.exe",
      modelsPath: "C:/models",
      theme: "system",
      toolEnabledStates: {},
    };

    const context = buildChatStoreModelContext({
      config,
      loadInferencePresetsByModelId: {
        "publisher/model/model.gguf": [createLoadPreset(4096, "json_schema")],
      },
      models: [createModelRecord()],
      runtime: createRuntimeSnapshot(),
      selectedLoadPresetIds: {
        "publisher/model/model.gguf": "preset-json_schema",
      },
      selectedModelId: "publisher/model/model.gguf",
    });

    expect(context.autoNamingEnabled).toBe(false);
    expect(context.debugMaxEntries).toBe(250);
    expect(context.structuredOutputMode).toBe("json_schema");
    expect(context.structuredOutputSchema).toBe('{"type":"object"}');
    expect(context.runtime?.activeModelId).toBe("publisher/model/model.gguf");
  });

  test("falls back to the default off-mode context when no active preset exists", () => {
    const context = buildChatStoreModelContext({
      config: null,
      loadInferencePresetsByModelId: {},
      models: [],
      runtime: null,
      selectedLoadPresetIds: {},
      selectedModelId: null,
    });

    expect(context).toEqual(DEFAULT_CHAT_STORE_MODEL_CONTEXT);
  });
});
