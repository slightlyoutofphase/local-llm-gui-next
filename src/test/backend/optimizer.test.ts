import { describe, expect, test } from "bun:test";
import type { HardwareProfile, ModelRecord } from "../../lib/contracts";
import {
  calculateHardwareOptimizerRecommendation,
  parseRocmGpuMemorySnapshots,
} from "../../backend/optimizer";

describe("calculateHardwareOptimizerRecommendation", () => {
  test("recommends all layers when the VRAM budget can hold the full model", () => {
    const hardware: HardwareProfile = {
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
    };
    const model = {
      contextLength: 8192,
      fileSizeBytes: 4 * 1024 * 1024 * 1024,
      layerCount: 40,
      parameterCount: 8_000_000_000,
      quantization: "Q4_0",
    } satisfies Pick<
      ModelRecord,
      "contextLength" | "fileSizeBytes" | "layerCount" | "parameterCount" | "quantization"
    >;

    const recommendation = calculateHardwareOptimizerRecommendation({
      hardware,
      model,
      requestedContextLength: 8192,
    });

    expect(recommendation.recommendedCpuThreads).toBe(8);
    expect(recommendation.recommendedGpuLayers).toBe(40);
    expect(recommendation.maxOffloadableLayers).toBe(40);
    expect(recommendation.exceedsSystemRam).toBe(false);
  });

  test("falls back to CPU-only loading when no GPU backend is available", () => {
    const hardware: HardwareProfile = {
      backend: "cpu",
      gpus: [],
      logicalCpuCount: 12,
      supportsGpuOffload: false,
      totalRamBytes: 24 * 1024 * 1024 * 1024,
    };
    const model = {
      contextLength: 4096,
      fileSizeBytes: 6 * 1024 * 1024 * 1024,
      layerCount: 32,
      parameterCount: 7_000_000_000,
      quantization: "Q8_0",
    } satisfies Pick<
      ModelRecord,
      "contextLength" | "fileSizeBytes" | "layerCount" | "parameterCount" | "quantization"
    >;

    const recommendation = calculateHardwareOptimizerRecommendation({
      hardware,
      model,
      requestedContextLength: 4096,
    });

    expect(recommendation.recommendedCpuThreads).toBe(6);
    expect(recommendation.recommendedGpuLayers).toBe(0);
    expect(recommendation.maxOffloadableLayers).toBe(0);
  });

  test("parses ROCm CSV memory snapshots using total minus used VRAM", () => {
    const snapshots = parseRocmGpuMemorySnapshots(
      [
        "device,VRAM Total Memory (B),VRAM Total Used Memory (B)",
        "card0,17179869184,4294967296",
        "card1,8589934592,2147483648",
      ].join("\n"),
    );

    expect(snapshots).toEqual([
      {
        freeVramBytes: 12 * 1024 * 1024 * 1024,
        name: "card0",
        totalVramBytes: 16 * 1024 * 1024 * 1024,
      },
      {
        freeVramBytes: 6 * 1024 * 1024 * 1024,
        name: "card1",
        totalVramBytes: 8 * 1024 * 1024 * 1024,
      },
    ]);
  });
});
