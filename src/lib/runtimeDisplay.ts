import type { LoadInferencePreset, ModelRecord, RuntimeSnapshot } from "./contracts";

/** Resolves the best available context ceiling for the currently displayed runtime header. */
export function resolveRuntimeContextLimit(
  runtime: RuntimeSnapshot | null,
  activeRuntimeModel: ModelRecord | null,
  selectedLoadPreset: LoadInferencePreset | null,
  selectedModel: ModelRecord | null,
): number | null {
  if (typeof runtime?.contextLimitTokens === "number" && runtime.contextLimitTokens > 0) {
    return runtime.contextLimitTokens;
  }

  if (runtime?.activeModelId && typeof activeRuntimeModel?.contextLength === "number") {
    return activeRuntimeModel.contextLength;
  }

  if (
    selectedModel &&
    (!runtime?.activeModelId || runtime.activeModelId === selectedModel.id) &&
    typeof selectedLoadPreset?.settings.contextLength === "number"
  ) {
    return selectedLoadPreset.settings.contextLength;
  }

  return typeof selectedModel?.contextLength === "number" ? selectedModel.contextLength : null;
}
