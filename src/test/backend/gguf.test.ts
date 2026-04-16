import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ggufMetadataTestUtils, readModelMetadata } from "../../backend/gguf";

const MODELS_ROOT = path.resolve(import.meta.dir, "../../../test/models");
const BASE_MODEL_PATH = path.join(
  MODELS_ROOT,
  "unsloth",
  "Qwen3.5-0.8B-GGUF",
  "Qwen3.5-0.8B-Q8_0.gguf",
);
const MMPROJ_PATH = path.join(
  MODELS_ROOT,
  "unsloth",
  "Qwen3.5-0.8B-GGUF",
  "Qwen3.5-0.8B-Q8_0-mmproj-F32.gguf",
);
const baseMetadataPromise = readModelMetadata(BASE_MODEL_PATH);
const multimodalMetadataPromise = readModelMetadata(BASE_MODEL_PATH, MMPROJ_PATH);

describe("readModelMetadata", () => {
  test("reads base model metadata from a real GGUF file", async () => {
    const metadata = await baseMetadataPromise;

    expect(metadata).toBeDefined();
    expect(metadata.defaultSampling).toBeDefined();
    expect(typeof metadata.supportsAudio).toBe("boolean");
  });

  test("extracts architecture when present", async () => {
    const metadata = await baseMetadataPromise;

    expect(metadata.architecture).toBeDefined();
    expect(typeof metadata.architecture).toBe("string");
  });

  test("extracts context length when present", async () => {
    const metadata = await baseMetadataPromise;

    if (metadata.contextLength !== undefined) {
      expect(typeof metadata.contextLength).toBe("number");
      expect(metadata.contextLength).toBeGreaterThan(0);
    }
  });

  test("extracts parameter count when present", async () => {
    const metadata = await baseMetadataPromise;

    if (metadata.parameterCount !== undefined) {
      expect(typeof metadata.parameterCount).toBe("number");
      expect(metadata.parameterCount).toBeGreaterThan(0);
    }
  });

  test("extracts layer count when present", async () => {
    const metadata = await baseMetadataPromise;

    if (metadata.layerCount !== undefined) {
      expect(typeof metadata.layerCount).toBe("number");
      expect(metadata.layerCount).toBeGreaterThan(0);
    }
  });

  test("reads quantization from header or file name", async () => {
    const metadata = await baseMetadataPromise;

    expect(metadata.quantization).toBeDefined();
    expect(typeof metadata.quantization).toBe("string");
  });

  test("maps numeric GGUF file_type values to human-readable quantization labels", () => {
    expect(
      ggufMetadataTestUtils.readQuantizationMetadata(
        { "general.file_type": 7 },
        "general.file_type",
      ),
    ).toBe("Q8_0");
    expect(
      ggufMetadataTestUtils.readQuantizationMetadata(
        { "general.file_type": "15" },
        "general.file_type",
      ),
    ).toBe("Q4_K_M");
  });

  test("ignores unsafe integer metadata values that exceed Number precision", () => {
    expect(
      ggufMetadataTestUtils.readNumberMetadata(
        { "general.parameter_count": BigInt(Number.MAX_SAFE_INTEGER) + 1n },
        "general.parameter_count",
      ),
    ).toBeUndefined();
  });

  test("reads chat template when embedded", async () => {
    const metadata = await baseMetadataPromise;

    if (metadata.chatTemplate !== undefined) {
      expect(typeof metadata.chatTemplate).toBe("string");
      expect(metadata.chatTemplate.length).toBeGreaterThan(0);
    }
  });

  test("populates sampling defaults from GGUF header", async () => {
    const metadata = await baseMetadataPromise;
    const sampling = metadata.defaultSampling;

    expect(sampling).toBeDefined();

    if (sampling.topK !== undefined) {
      expect(typeof sampling.topK).toBe("number");
    }

    if (sampling.topP !== undefined) {
      expect(typeof sampling.topP).toBe("number");
    }

    if (sampling.temperature !== undefined) {
      expect(typeof sampling.temperature).toBe("number");
    }
  });

  test("reads mmproj metadata when mmproj path is provided", async () => {
    const metadata = await multimodalMetadataPromise;

    expect(metadata).toBeDefined();
    expect(typeof metadata.supportsAudio).toBe("boolean");
  });

  test("throws or fails gracefully for a non-existent file", async () => {
    await expect(readModelMetadata("/nonexistent/path/model.gguf")).rejects.toThrow();
  });
});
