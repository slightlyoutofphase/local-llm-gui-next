import path from "node:path";
import { gguf } from "@huggingface/gguf";
import type { ModelSamplingDefaults } from "../lib/contracts";

const GGUF_FILE_TYPE_LABELS: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  22: "IQ3_XXS",
  23: "IQ1_S",
  24: "IQ4_NL",
  25: "IQ3_S",
  26: "IQ2_S",
  27: "IQ4_XS",
};

/**
 * Represents the GGUF metadata extracted for a scanned model.
 */
export interface ParsedModelMetadata {
  /** Optional model architecture string. */
  architecture?: string;
  /** Optional context length. */
  contextLength?: number;
  /** Optional parameter count. */
  parameterCount?: number;
  /** Optional transformer block count. */
  layerCount?: number;
  /** Optional quantization label. */
  quantization?: string;
  /** Optional embedded Jinja chat template. */
  chatTemplate?: string;
  /** GGUF-derived default sampling values. */
  defaultSampling: ModelSamplingDefaults;
  /** Whether the associated multimodal stack reports audio support. */
  supportsAudio: boolean;
}

/**
 * Reads the GGUF headers required to build a model record.
 *
 * @param modelFilePath Absolute path to the base model GGUF file.
 * @param mmprojFilePath Optional absolute path to the associated MMPROJ GGUF file.
 * @returns Parsed GGUF metadata extracted from the model files.
 */
export async function readModelMetadata(
  modelFilePath: string,
  mmprojFilePath?: string,
): Promise<ParsedModelMetadata> {
  const modelHeader = (await gguf(modelFilePath, { allowLocalFile: true })) as {
    metadata?: Record<string, unknown>;
  };
  const modelMetadata = modelHeader.metadata ?? {};

  let mmprojMetadata: Record<string, unknown> = {};

  if (mmprojFilePath) {
    const mmprojHeader = (await gguf(mmprojFilePath, { allowLocalFile: true })) as {
      metadata?: Record<string, unknown>;
    };
    mmprojMetadata = mmprojHeader.metadata ?? {};
  }

  const parsedMetadata: ParsedModelMetadata = {
    defaultSampling: createSamplingDefaults(modelMetadata),
    supportsAudio: readBooleanMetadata(mmprojMetadata, "clip.has_audio_encoder") ?? false,
  };

  const architecture = readStringMetadata(modelMetadata, "general.architecture");
  const contextLength =
    (architecture
      ? readNumberMetadata(modelMetadata, `${architecture}.context_length`)
      : undefined) ??
    readNumberMetadata(modelMetadata, "llama.context_length") ??
    readNumberMetadata(modelMetadata, "context_length");
  const parameterCount =
    readNumberMetadata(modelMetadata, "general.parameter_count") ??
    readNumberMetadata(modelMetadata, "general.n_parameters");
  const layerCount =
    (architecture ? readNumberMetadata(modelMetadata, `${architecture}.block_count`) : undefined) ??
    readNumberMetadata(modelMetadata, "llama.block_count") ??
    readNumberMetadata(modelMetadata, "general.block_count") ??
    readNumberMetadata(modelMetadata, "n_layer");
  const quantization =
    inferQuantizationFromFileName(modelFilePath) ??
    readQuantizationMetadata(modelMetadata, "general.file_type");
  const chatTemplate = readStringMetadata(modelMetadata, "tokenizer.chat_template");

  if (architecture) {
    parsedMetadata.architecture = architecture;
  }

  if (typeof contextLength === "number") {
    parsedMetadata.contextLength = contextLength;
  }

  if (typeof parameterCount === "number") {
    parsedMetadata.parameterCount = parameterCount;
  }

  if (typeof layerCount === "number") {
    parsedMetadata.layerCount = layerCount;
  }

  if (quantization) {
    parsedMetadata.quantization = quantization;
  }

  if (chatTemplate) {
    parsedMetadata.chatTemplate = chatTemplate;
  }

  return parsedMetadata;
}

function createSamplingDefaults(metadata: Record<string, unknown>): ModelSamplingDefaults {
  const samplingDefaults: ModelSamplingDefaults = {};
  const topK = readNumberMetadata(metadata, "general.sampling.top_k");
  const topP = readNumberMetadata(metadata, "general.sampling.top_p");
  const temperature = readNumberMetadata(metadata, "general.sampling.temp");
  const minP = readNumberMetadata(metadata, "general.sampling.min_p");
  const repeatPenalty = readNumberMetadata(metadata, "general.sampling.penalty_repeat");

  if (typeof topK === "number") {
    samplingDefaults.topK = topK;
  }

  if (typeof topP === "number") {
    samplingDefaults.topP = topP;
  }

  if (typeof temperature === "number") {
    samplingDefaults.temperature = temperature;
  }

  if (typeof minP === "number") {
    samplingDefaults.minP = minP;
  }

  if (typeof repeatPenalty === "number") {
    samplingDefaults.repeatPenalty = repeatPenalty;
  }

  return samplingDefaults;
}

function readStringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumberMetadata(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return undefined;
    }

    return value;
  }

  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return undefined;
    }

    return Number(value);
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (/^-?\d+$/.test(trimmedValue)) {
      const parsedInteger = BigInt(trimmedValue);

      if (
        parsedInteger > BigInt(Number.MAX_SAFE_INTEGER) ||
        parsedInteger < BigInt(Number.MIN_SAFE_INTEGER)
      ) {
        return undefined;
      }

      return Number(parsedInteger);
    }

    const parsedNumber = Number(trimmedValue);

    return Number.isFinite(parsedNumber) ? parsedNumber : undefined;
  }

  return undefined;
}

function readQuantizationMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];

  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (trimmedValue.length === 0) {
      return undefined;
    }

    if (/^-?\d+$/.test(trimmedValue)) {
      return GGUF_FILE_TYPE_LABELS[Number(trimmedValue)];
    }

    return trimmedValue;
  }

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return GGUF_FILE_TYPE_LABELS[value];
  }

  if (
    typeof value === "bigint" &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return GGUF_FILE_TYPE_LABELS[Number(value)];
  }

  return undefined;
}

function readBooleanMetadata(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  return undefined;
}

function inferQuantizationFromFileName(modelFilePath: string): string | undefined {
  const fileName = path.basename(modelFilePath);
  const quantizationMatch = fileName.match(/(Q\d(?:_\d)?|IQ\d(?:_[A-Za-z0-9]+)?)/i);

  return quantizationMatch?.[1];
}

/** Test-only metadata helpers used to lock GGUF edge-case parsing behavior. */
export const ggufMetadataTestUtils = {
  readNumberMetadata,
  readQuantizationMetadata,
};
