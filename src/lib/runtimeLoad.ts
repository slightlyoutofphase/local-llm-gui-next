import type { LoadInferencePreset, ModelRecord, RuntimeSnapshot } from "../lib/contracts";

const MIN_RUNTIME_LOAD_TIMEOUT_MS = 120_000;
const MAX_RUNTIME_LOAD_TIMEOUT_MS = 420_000;
const BASE_RUNTIME_LOAD_TIMEOUT_MS = 120_000;
const RUNTIME_LOAD_TIMEOUT_PER_GIB_MS = 45_000;
const RUNTIME_LOAD_TIMEOUT_PER_4K_CONTEXT_MS = 10_000;
const BYTES_PER_GIB = 1024 * 1024 * 1024;

export interface RuntimeLoadTimeoutInput {
  contextLength?: number | null;
  fileSizeBytes?: number | null;
}

/**
 * Calculates a bounded model-load deadline from model size and requested context.
 *
 * Larger GGUF files and larger contexts are allowed more time, but the final
 * timeout remains clamped to a finite range so failures still surface.
 *
 * @param input Runtime load sizing inputs.
 * @returns Timeout budget in milliseconds.
 */
export function calculateRuntimeLoadTimeoutMs(input: RuntimeLoadTimeoutInput): number {
  const fileSizeBytes = Math.max(0, input.fileSizeBytes ?? 0);
  const contextLength = Math.max(0, input.contextLength ?? 0);
  const gibUnits = Math.ceil(fileSizeBytes / BYTES_PER_GIB);
  const extraContextUnits = Math.ceil(Math.max(0, contextLength - 4_096) / 4_096);
  const computedTimeout =
    BASE_RUNTIME_LOAD_TIMEOUT_MS +
    gibUnits * RUNTIME_LOAD_TIMEOUT_PER_GIB_MS +
    extraContextUnits * RUNTIME_LOAD_TIMEOUT_PER_4K_CONTEXT_MS;

  return clamp(computedTimeout, MIN_RUNTIME_LOAD_TIMEOUT_MS, MAX_RUNTIME_LOAD_TIMEOUT_MS);
}

/**
 * Uses runtime polling only as a fallback when the runtime SSE stream is unavailable.
 *
 * @param hasConnectedRuntimeStream Whether the runtime SSE stream is already connected.
 * @returns `true` when polling should be used.
 */
export function shouldStartRuntimeLoadPolling(hasConnectedRuntimeStream: boolean): boolean {
  return !hasConnectedRuntimeStream;
}

/**
 * Builds an explicit error snapshot when a model load fails before the frontend can observe a
 * non-loading runtime snapshot from the backend.
 */
export function buildRuntimeLoadFailureSnapshot(options: {
  errorMessage: string;
  loadPreset: Pick<LoadInferencePreset, "settings"> | null;
  model: Pick<
    ModelRecord,
    "contextLength" | "id" | "mmprojPath" | "modelPath" | "supportsAudio"
  > | null;
  previousRuntime: RuntimeSnapshot | null;
  updatedAt?: string;
}): RuntimeSnapshot {
  const { errorMessage, loadPreset, model, previousRuntime, updatedAt } = options;

  return {
    activeModelId: model?.id ?? previousRuntime?.activeModelId ?? null,
    activeModelPath: model?.modelPath ?? previousRuntime?.activeModelPath ?? null,
    audio: model?.supportsAudio ?? previousRuntime?.audio ?? false,
    contextLimitTokens:
      loadPreset?.settings.contextLength ??
      model?.contextLength ??
      previousRuntime?.contextLimitTokens ??
      null,
    contextTokens: null,
    lastError: errorMessage,
    llamaServerBaseUrl: null,
    loadProgress: null,
    multimodal:
      model !== null
        ? Boolean(model.mmprojPath) || model.supportsAudio
        : (previousRuntime?.multimodal ?? false),
    status: "error",
    tokensPerSecond: null,
    updatedAt: updatedAt ?? new Date().toISOString(),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
