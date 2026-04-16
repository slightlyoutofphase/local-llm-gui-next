import type {
  AppConfig,
  LoadInferencePreset,
  ModelRecord,
  RuntimeSnapshot,
  StructuredOutputMode,
} from "../lib/contracts";

export interface ChatStoreModelContext {
  autoNamingEnabled: boolean;
  availableModels: ModelRecord[];
  debugMaxEntries: number;
  runtime: RuntimeSnapshot | null;
  selectedModelId: string | null;
  structuredOutputMode: StructuredOutputMode;
  structuredOutputSchema: string | undefined;
}

export const DEFAULT_CHAT_STORE_MODEL_CONTEXT: ChatStoreModelContext = {
  autoNamingEnabled: true,
  availableModels: [],
  debugMaxEntries: 1000,
  runtime: null,
  selectedModelId: null,
  structuredOutputMode: "off",
  structuredOutputSchema: undefined,
};

/** Builds the subset of model-store state consumed by the chat store. */
export function buildChatStoreModelContext(input: {
  config: AppConfig | null;
  loadInferencePresetsByModelId: Record<string, LoadInferencePreset[]>;
  models: ModelRecord[];
  runtime: RuntimeSnapshot | null;
  selectedLoadPresetIds: Record<string, string>;
  selectedModelId: string | null;
}): ChatStoreModelContext {
  const activeModelId = input.runtime?.activeModelId ?? input.selectedModelId;
  const modelLoadPresets = activeModelId
    ? (input.loadInferencePresetsByModelId[activeModelId] ?? [])
    : [];
  const selectedPresetId = activeModelId ? input.selectedLoadPresetIds[activeModelId] : undefined;
  const activePreset =
    modelLoadPresets.find((preset) => preset.id === selectedPresetId) ?? modelLoadPresets[0];

  return {
    autoNamingEnabled: input.config?.autoNamingEnabled ?? true,
    availableModels: input.models,
    debugMaxEntries: input.config?.debug.maxEntries ?? 1000,
    runtime: input.runtime,
    selectedModelId: input.selectedModelId,
    structuredOutputMode: activePreset?.settings.structuredOutputMode ?? "off",
    structuredOutputSchema: activePreset?.settings.structuredOutputSchema,
  };
}
