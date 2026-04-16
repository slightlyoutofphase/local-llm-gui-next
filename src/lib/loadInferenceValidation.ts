import type { LoadInferenceSettings } from "./contracts";

export const LOAD_INFERENCE_LIMITS = {
  batchSize: { max: 65_536, min: 1 },
  contextLength: { max: 1_048_576, min: 128 },
  cpuThreads: { max: 4_096, min: 1 },
  gpuLayers: { max: 4_096, min: 0 },
  imageTokens: { max: 16_384, min: 1 },
  minP: { max: 1, min: 0 },
  penalties: { max: 5, min: -5 },
  repeatPenalty: { max: 5, min: 0 },
  responseLengthLimit: { max: 65_536, min: 1 },
  ropeFrequency: { max: Number.MAX_SAFE_INTEGER, minExclusive: 0 },
  temperature: { max: 5, min: 0 },
  topK: { max: 100_000, min: 0 },
  topP: { max: 1, min: 0 },
  ubatchSize: { max: 65_536, min: 1 },
} as const;

/**
 * Validates load and inference preset settings for semantic correctness.
 *
 * @param settings The settings bundle to validate.
 * @returns A human-readable validation error, or `null` when the settings are valid.
 */
export function validateLoadInferenceSettings(settings: LoadInferenceSettings): string | null {
  const integerError =
    validateIntegerRange(
      "Context length",
      settings.contextLength,
      LOAD_INFERENCE_LIMITS.contextLength.min,
      LOAD_INFERENCE_LIMITS.contextLength.max,
    ) ??
    validateIntegerRange(
      "GPU layers",
      settings.gpuLayers,
      LOAD_INFERENCE_LIMITS.gpuLayers.min,
      LOAD_INFERENCE_LIMITS.gpuLayers.max,
    ) ??
    validateIntegerRange(
      "CPU threads",
      settings.cpuThreads,
      LOAD_INFERENCE_LIMITS.cpuThreads.min,
      LOAD_INFERENCE_LIMITS.cpuThreads.max,
    ) ??
    validateIntegerRange(
      "Batch size",
      settings.batchSize,
      LOAD_INFERENCE_LIMITS.batchSize.min,
      LOAD_INFERENCE_LIMITS.batchSize.max,
    ) ??
    validateIntegerRange(
      "Micro-batch size",
      settings.ubatchSize,
      LOAD_INFERENCE_LIMITS.ubatchSize.min,
      LOAD_INFERENCE_LIMITS.ubatchSize.max,
    ) ??
    validateIntegerRange("Seed", settings.seed) ??
    validateOptionalIntegerRange(
      "Response length limit",
      settings.responseLengthLimit,
      LOAD_INFERENCE_LIMITS.responseLengthLimit.min,
      LOAD_INFERENCE_LIMITS.responseLengthLimit.max,
    ) ??
    validateOptionalIntegerRange(
      "Image min tokens",
      settings.imageMinTokens,
      LOAD_INFERENCE_LIMITS.imageTokens.min,
      LOAD_INFERENCE_LIMITS.imageTokens.max,
    ) ??
    validateOptionalIntegerRange(
      "Image max tokens",
      settings.imageMaxTokens,
      LOAD_INFERENCE_LIMITS.imageTokens.min,
      LOAD_INFERENCE_LIMITS.imageTokens.max,
    );

  if (integerError) {
    return integerError;
  }

  const floatError =
    validateFiniteRange(
      "Temperature",
      settings.temperature,
      LOAD_INFERENCE_LIMITS.temperature.min,
      LOAD_INFERENCE_LIMITS.temperature.max,
    ) ??
    validateFiniteRange(
      "Top-P",
      settings.topP,
      LOAD_INFERENCE_LIMITS.topP.min,
      LOAD_INFERENCE_LIMITS.topP.max,
    ) ??
    validateFiniteRange(
      "Min-P",
      settings.minP,
      LOAD_INFERENCE_LIMITS.minP.min,
      LOAD_INFERENCE_LIMITS.minP.max,
    ) ??
    validateFiniteRange(
      "Presence penalty",
      settings.presencePenalty,
      LOAD_INFERENCE_LIMITS.penalties.min,
      LOAD_INFERENCE_LIMITS.penalties.max,
    ) ??
    validateFiniteRange(
      "Repeat penalty",
      settings.repeatPenalty,
      LOAD_INFERENCE_LIMITS.repeatPenalty.min,
      LOAD_INFERENCE_LIMITS.repeatPenalty.max,
    ) ??
    validateOptionalPositiveFiniteRange(
      "RoPE frequency base",
      settings.ropeFrequencyBase,
      LOAD_INFERENCE_LIMITS.ropeFrequency.max,
    ) ??
    validateOptionalPositiveFiniteRange(
      "RoPE frequency scale",
      settings.ropeFrequencyScale,
      LOAD_INFERENCE_LIMITS.ropeFrequency.max,
    );

  if (floatError) {
    return floatError;
  }

  if (settings.ubatchSize > settings.batchSize) {
    return "Micro-batch size cannot exceed batch size.";
  }

  if (
    typeof settings.imageMinTokens === "number" &&
    typeof settings.imageMaxTokens === "number" &&
    settings.imageMinTokens > settings.imageMaxTokens
  ) {
    return "Image min tokens cannot exceed image max tokens.";
  }

  if (settings.overflowStrategy === "rolling-window" && !settings.contextShift) {
    return "Rolling Window requires Context Shift to be enabled.";
  }

  if (settings.stopStrings.some((stopString) => stopString.trim().length === 0)) {
    return "Stop strings cannot contain blank entries.";
  }

  if (settings.structuredOutputMode !== "json_schema") {
    return null;
  }

  const schemaText = settings.structuredOutputSchema?.trim() ?? "";

  if (!schemaText) {
    return "A JSON schema is required in JSON Schema mode.";
  }

  let parsedSchema: unknown;

  try {
    parsedSchema = JSON.parse(schemaText) as unknown;
  } catch {
    return "The structured-output schema must be valid JSON.";
  }

  if (JSON.stringify(parsedSchema).includes('"$ref"')) {
    return "Schemas containing $ref are not supported in this application version.";
  }

  return null;
}

function validateIntegerRange(
  label: string,
  value: number,
  min?: number,
  max?: number,
): string | null {
  if (!Number.isInteger(value)) {
    return `${label} must be an integer.`;
  }

  if (typeof min === "number" && value < min) {
    return `${label} must be at least ${String(min)}.`;
  }

  if (typeof max === "number" && value > max) {
    return `${label} must be at most ${String(max)}.`;
  }

  return null;
}

function validateOptionalIntegerRange(
  label: string,
  value: number | undefined,
  min: number,
  max: number,
): string | null {
  if (value === undefined) {
    return null;
  }

  return validateIntegerRange(label, value, min, max);
}

function validateFiniteRange(
  label: string,
  value: number,
  min: number,
  max: number,
): string | null {
  if (!Number.isFinite(value)) {
    return `${label} must be a finite number.`;
  }

  if (value < min || value > max) {
    return `${label} must be between ${String(min)} and ${String(max)}.`;
  }

  return null;
}

function validateOptionalPositiveFiniteRange(
  label: string,
  value: number | undefined,
  max: number,
): string | null {
  if (value === undefined) {
    return null;
  }

  if (!Number.isFinite(value)) {
    return `${label} must be a finite number.`;
  }

  if (value <= 0 || value > max) {
    return `${label} must be greater than 0.`;
  }

  return null;
}
