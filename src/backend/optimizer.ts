import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type {
  HardwareBackendType,
  HardwareOptimizerRecommendation,
  HardwareOptimizerResult,
  HardwareProfile,
  ModelRecord,
} from "../lib/contracts";

const ONE_GIBIBYTE = 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/**
 * Scans the current host hardware and calculates a model-load recommendation.
 *
 * @param model The selected model record.
 * @param requestedContextLength The user-requested context length to evaluate.
 * @param llamaServerPath Optional configured llama-server binary path.
 * @returns The scanned host profile and optimizer recommendation.
 */
export async function buildHardwareOptimizerResult(
  model: ModelRecord,
  requestedContextLength: number,
  llamaServerPath?: string,
): Promise<HardwareOptimizerResult> {
  const hardware = await scanHardwareProfile(llamaServerPath);

  return {
    hardware,
    recommendation: calculateHardwareOptimizerRecommendation({
      hardware,
      model,
      requestedContextLength,
    }),
  };
}

/**
 * Scans CPU, RAM, GPU memory, and llama.cpp backend capabilities.
 *
 * @param llamaServerPath Optional configured llama-server binary path.
 * @returns The detected hardware profile.
 */
export async function scanHardwareProfile(llamaServerPath?: string): Promise<HardwareProfile> {
  const [gpuSnapshots, backendInfo] = await Promise.all([
    scanGpuMemorySnapshots(),
    inspectLlamaServerBackend(llamaServerPath),
  ]);

  return {
    backend: backendInfo.backend,
    ...(backendInfo.backendDetails ? { backendDetails: backendInfo.backendDetails } : {}),
    gpus: gpuSnapshots,
    logicalCpuCount: Math.max(1, os.cpus().length),
    supportsGpuOffload: backendInfo.backend !== "cpu" && backendInfo.backend !== "unknown",
    totalRamBytes: os.totalmem(),
  };
}

/**
 * Calculates the optimizer recommendation for a static hardware profile.
 *
 * @param input The static model and hardware inputs.
 * @returns The deterministic optimizer recommendation.
 */
export function calculateHardwareOptimizerRecommendation(input: {
  hardware: HardwareProfile;
  model: Pick<
    ModelRecord,
    "contextLength" | "fileSizeBytes" | "layerCount" | "parameterCount" | "quantization"
  >;
  requestedContextLength: number;
}): HardwareOptimizerRecommendation {
  const logicalCpuCount = Math.max(1, input.hardware.logicalCpuCount);
  const recommendedCpuThreads = Math.max(1, Math.floor(logicalCpuCount / 2));
  const resolvedLayerCount = Math.max(
    1,
    input.model.layerCount ?? estimateLayerCount(input.model.parameterCount),
  );
  const requestedContextLength = Math.max(
    512,
    input.requestedContextLength || input.model.contextLength || 4096,
  );
  const aggregateFreeVramBytes = input.hardware.gpus.reduce(
    (totalBytes, gpu) => totalBytes + gpu.freeVramBytes,
    0,
  );
  const gpuBudgetBytes = input.hardware.supportsGpuOffload
    ? Math.max(0, aggregateFreeVramBytes - ONE_GIBIBYTE)
    : 0;
  const bytesPerLayer = input.model.fileSizeBytes / resolvedLayerCount;
  const maxOffloadableLayers = Math.min(
    resolvedLayerCount,
    Math.max(0, Math.floor(gpuBudgetBytes / Math.max(1, bytesPerLayer))),
  );
  const kvBytesPerToken = estimateKvBytesPerToken(resolvedLayerCount, input.model.parameterCount);
  const cpuResidentModelBytes = Math.max(
    0,
    input.model.fileSizeBytes - bytesPerLayer * maxOffloadableLayers,
  );
  const safeRamBudgetBytes = Math.max(ONE_GIBIBYTE, input.hardware.totalRamBytes - ONE_GIBIBYTE);
  const maxContextLength = Math.max(
    512,
    Math.floor((safeRamBudgetBytes - cpuResidentModelBytes) / Math.max(1, kvBytesPerToken)),
  );
  const recommendedContextLength = Math.min(requestedContextLength, maxContextLength);
  const estimatedContextRamBytes = recommendedContextLength * kvBytesPerToken;
  const estimatedGpuUsageBytes = bytesPerLayer * maxOffloadableLayers;
  const estimatedTotalRamBytes = cpuResidentModelBytes + estimatedContextRamBytes;
  const bitsPerWeight = estimateBitsPerWeight(input.model);
  const reasoning: string[] = [
    `Detected ${logicalCpuCount} logical CPU threads. Recommend ${recommendedCpuThreads} CPU threads as the editable default.`,
    input.hardware.supportsGpuOffload
      ? `GPU backend ${input.hardware.backend} detected. After a 1 GiB safety buffer, ${formatBytes(gpuBudgetBytes)} remains for layer offload.`
      : "No GPU offload backend detected. Recommend CPU-only loading.",
    `Estimated model quantization is about ${bitsPerWeight.toFixed(1)} bits/weight across ${resolvedLayerCount} layers.`,
  ];

  if (recommendedContextLength < requestedContextLength) {
    reasoning.push(
      `Requested context ${requestedContextLength.toLocaleString()} exceeds safe RAM limits. Clamp to ${recommendedContextLength.toLocaleString()} tokens to avoid system OOM.`,
    );
  } else {
    reasoning.push(
      `Estimated RAM usage at ${recommendedContextLength.toLocaleString()} context is ${formatBytes(estimatedTotalRamBytes)}.`,
    );
  }

  return {
    estimatedContextRamBytes,
    estimatedGpuUsageBytes,
    estimatedModelRamBytes: cpuResidentModelBytes,
    estimatedTotalRamBytes,
    exceedsSystemRam: requestedContextLength > maxContextLength,
    maxOffloadableLayers,
    reasoning,
    recommendedContextLength,
    recommendedCpuThreads,
    recommendedGpuLayers: maxOffloadableLayers,
  };
}

async function inspectLlamaServerBackend(
  llamaServerPath?: string,
): Promise<{ backend: HardwareBackendType; backendDetails?: string }> {
  if (!llamaServerPath) {
    return { backend: "unknown" };
  }

  try {
    const helpResult = await execFileAsync(llamaServerPath, ["--help"], {
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      windowsHide: true,
    });
    const combinedOutput = `${helpResult.stdout}\n${helpResult.stderr}`.trim();
    const normalizedOutput = combinedOutput.toLowerCase();

    if (normalizedOutput.includes("cuda") || normalizedOutput.includes("cublas")) {
      return { backend: "cuda", backendDetails: combinedOutput };
    }

    if (normalizedOutput.includes("metal")) {
      return { backend: "metal", backendDetails: combinedOutput };
    }

    if (normalizedOutput.includes("rocm") || normalizedOutput.includes("hipblas")) {
      return { backend: "rocm", backendDetails: combinedOutput };
    }

    if (normalizedOutput.includes("vulkan")) {
      return { backend: "vulkan", backendDetails: combinedOutput };
    }

    return { backend: "cpu", backendDetails: combinedOutput };
  } catch {
    return { backend: "unknown" };
  }
}

async function scanGpuMemorySnapshots(): Promise<HardwareProfile["gpus"]> {
  const nvidiaSnapshots = await scanNvidiaGpuMemorySnapshots();

  if (nvidiaSnapshots.length > 0) {
    return nvidiaSnapshots;
  }

  return await scanRocmGpuMemorySnapshots();
}

async function scanNvidiaGpuMemorySnapshots(): Promise<HardwareProfile["gpus"]> {
  try {
    const result = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      {
        maxBuffer: 256 * 1024,
        timeout: 5000,
        windowsHide: true,
      },
    );

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, totalMegabytes, freeMegabytes] = line
          .split(",")
          .map((segment) => segment.trim());

        return {
          ...(name ? { name } : {}),
          freeVramBytes: Number(freeMegabytes) * 1024 * 1024,
          totalVramBytes: Number(totalMegabytes) * 1024 * 1024,
        };
      })
      .filter(
        (snapshot) =>
          Number.isFinite(snapshot.totalVramBytes) && Number.isFinite(snapshot.freeVramBytes),
      );
  } catch {
    return [];
  }
}

async function scanRocmGpuMemorySnapshots(): Promise<HardwareProfile["gpus"]> {
  try {
    const result = await execFileAsync("rocm-smi", ["--showmeminfo", "vram", "--csv"], {
      maxBuffer: 256 * 1024,
      timeout: 5000,
      windowsHide: true,
    });

    return parseRocmGpuMemorySnapshots(result.stdout);
  } catch {
    return [];
  }
}

export function parseRocmGpuMemorySnapshots(stdout: string): HardwareProfile["gpus"] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const headerLineIndex = lines.findIndex(
    (line) => line.toLowerCase().includes("total") && line.toLowerCase().includes("used"),
  );

  if (headerLineIndex < 0) {
    return [];
  }

  const headerSegments = lines[headerLineIndex]!.split(",").map((segment) => segment.trim());
  const normalizedHeaders = headerSegments.map((segment) => segment.toLowerCase());
  const totalIndex = normalizedHeaders.findIndex(
    (segment) => segment.includes("total") && segment.includes("vram"),
  );
  const usedIndex = normalizedHeaders.findIndex(
    (segment) => segment.includes("used") && segment.includes("vram"),
  );
  const nameIndex = normalizedHeaders.findIndex(
    (segment) => segment === "device" || segment.includes("card") || segment.includes("gpu"),
  );

  if (totalIndex < 0 || usedIndex < 0) {
    return [];
  }

  const totalMultiplier = resolveRocmMemoryUnitMultiplier(headerSegments[totalIndex]!);
  const usedMultiplier = resolveRocmMemoryUnitMultiplier(headerSegments[usedIndex]!);
  const snapshots: HardwareProfile["gpus"] = [];

  for (const line of lines.slice(headerLineIndex + 1)) {
    const segments = line.split(",").map((segment) => segment.trim());

    if (segments.length <= Math.max(totalIndex, usedIndex)) {
      continue;
    }

    const totalBytes = parseRocmMemoryValue(segments[totalIndex]!, totalMultiplier);
    const usedBytes = parseRocmMemoryValue(segments[usedIndex]!, usedMultiplier);

    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || totalBytes <= 0) {
      continue;
    }

    const freeVramBytes = Math.max(0, totalBytes - usedBytes);
    const snapshot: HardwareProfile["gpus"][number] = {
      freeVramBytes,
      totalVramBytes: totalBytes,
    };

    if (nameIndex >= 0 && nameIndex < segments.length && segments[nameIndex]!.length > 0) {
      snapshot.name = segments[nameIndex]!;
    }

    snapshots.push(snapshot);
  }

  return snapshots;
}

function parseRocmMemoryValue(value: string, multiplier: number): number {
  const numericMatch = value.match(/-?\d+(?:\.\d+)?/);

  if (!numericMatch) {
    return Number.NaN;
  }

  return Number(numericMatch[0]) * multiplier;
}

function resolveRocmMemoryUnitMultiplier(headerLabel: string): number {
  const normalizedHeader = headerLabel.toLowerCase();

  if (normalizedHeader.includes("gib") || normalizedHeader.includes("gb")) {
    return 1024 * 1024 * 1024;
  }

  if (normalizedHeader.includes("mib") || normalizedHeader.includes("mb")) {
    return 1024 * 1024;
  }

  if (normalizedHeader.includes("kib") || normalizedHeader.includes("kb")) {
    return 1024;
  }

  return 1;
}

function estimateLayerCount(parameterCount?: number): number {
  if (!parameterCount || parameterCount <= 0) {
    return 32;
  }

  if (parameterCount < 2_000_000_000) {
    return 24;
  }

  if (parameterCount < 8_000_000_000) {
    return 32;
  }

  if (parameterCount < 20_000_000_000) {
    return 40;
  }

  if (parameterCount < 50_000_000_000) {
    return 60;
  }

  return 80;
}

function estimateKvBytesPerToken(layerCount: number, parameterCount?: number): number {
  const sizeMultiplier =
    parameterCount && parameterCount >= 60_000_000_000
      ? 4
      : parameterCount && parameterCount >= 30_000_000_000
        ? 2
        : 1;

  return layerCount * 8192 * sizeMultiplier;
}

function estimateBitsPerWeight(
  model: Pick<ModelRecord, "fileSizeBytes" | "parameterCount" | "quantization">,
): number {
  if (model.parameterCount && model.parameterCount > 0) {
    return (model.fileSizeBytes * 8) / model.parameterCount;
  }

  const quantizationLabel = model.quantization?.toUpperCase() ?? "";
  const quantizationMatch = quantizationLabel.match(/(Q|IQ)(\d+)/);

  if (quantizationMatch?.[2]) {
    return Number(quantizationMatch[2]);
  }

  if (quantizationLabel.includes("F16") || quantizationLabel.includes("BF16")) {
    return 16;
  }

  if (quantizationLabel.includes("F32")) {
    return 32;
  }

  return 8;
}

function formatBytes(byteSize: number): string {
  if (byteSize >= ONE_GIBIBYTE) {
    return `${(byteSize / ONE_GIBIBYTE).toFixed(1)} GiB`;
  }

  return `${Math.round(byteSize / (1024 * 1024))} MiB`;
}
