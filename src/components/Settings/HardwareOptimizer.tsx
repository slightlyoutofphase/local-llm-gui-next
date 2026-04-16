"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  HardwareOptimizerRecommendation,
  HardwareOptimizerResult,
  ModelRecord,
} from "@/lib/contracts";
import { getHardwareOptimizerRecommendation } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export interface HardwareOptimizerProps {
  currentContextLength: number;
  disabled: boolean;
  model: ModelRecord;
  onApply: (recommendation: HardwareOptimizerRecommendation) => void;
}

/**
 * Scans local hardware and applies a conservative load recommendation for the selected model.
 *
 * @param props Component props.
 * @param props.currentContextLength The context length currently being edited.
 * @param props.disabled Indicates whether optimizer actions should be disabled.
 * @param props.model The active model record.
 * @param props.onApply Called when the user applies the recommended values.
 * @returns The rendered optimizer panel.
 */
export function HardwareOptimizer({
  currentContextLength,
  disabled,
  model,
  onApply,
}: HardwareOptimizerProps): ReactElement {
  const activeRequestKey = `${model.id}:${String(currentContextLength)}`;
  const [errorState, setErrorState] = useState<{ requestKey: string; value: string } | null>(null);
  const [loadingRequestKey, setLoadingRequestKey] = useState<string | null>(null);
  const [resultState, setResultState] = useState<{
    requestKey: string;
    value: HardwareOptimizerResult;
  } | null>(null);
  const activeRequestIdRef = useRef(0);
  const activeRequestKeyRef = useRef(activeRequestKey);

  useEffect(() => {
    activeRequestKeyRef.current = activeRequestKey;
  }, [activeRequestKey]);

  const error = errorState?.requestKey === activeRequestKey ? errorState.value : null;
  const loading = loadingRequestKey === activeRequestKey;
  const result = resultState?.requestKey === activeRequestKey ? resultState.value : null;

  return (
    <div className="space-y-3 rounded-[1.25rem] border border-border/70 bg-background/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Hardware optimizer</p>
          <p className="text-sm text-muted-foreground">
            Scan CPU, RAM, backend type, and VRAM to recommend threads, GPU layers, and a safe
            context size.
          </p>
        </div>
        <Button
          disabled={disabled || loading}
          onClick={() => {
            const requestKey = activeRequestKey;
            const requestId = activeRequestIdRef.current + 1;

            activeRequestIdRef.current = requestId;

            void loadOptimizerResult({
              model,
              requestedContextLength: currentContextLength,
              setError: (nextError) => {
                setErrorState(nextError ? { requestKey, value: nextError } : null);
              },
              setLoading: (nextLoading) => {
                setLoadingRequestKey(nextLoading ? requestKey : null);
              },
              setResult: (nextResult) => {
                setResultState(nextResult ? { requestKey, value: nextResult } : null);
              },
              shouldCommit: () =>
                activeRequestIdRef.current === requestId &&
                activeRequestKeyRef.current === requestKey,
            });
          }}
          type="button"
          variant="outline">
          {loading ? "Scanning..." : "Analyze hardware"}
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {result ? (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Metric label="Backend" value={result.hardware.backend.toUpperCase()} />
            <Metric label="Logical CPU threads" value={String(result.hardware.logicalCpuCount)} />
            <Metric label="System RAM" value={formatBytes(result.hardware.totalRamBytes)} />
            <Metric
              label="Free VRAM"
              value={
                result.hardware.gpus.length > 0
                  ? formatBytes(
                      result.hardware.gpus.reduce(
                        (totalBytes, gpu) => totalBytes + gpu.freeVramBytes,
                        0,
                      ),
                    )
                  : "none"
              }
            />
          </div>

          <Separator />

          <div className="grid gap-3 md:grid-cols-3">
            <Metric
              label="Recommended CPU threads"
              value={String(result.recommendation.recommendedCpuThreads)}
            />
            <Metric
              label="Recommended GPU layers"
              value={String(result.recommendation.recommendedGpuLayers)}
            />
            <Metric
              label="Recommended context"
              value={result.recommendation.recommendedContextLength.toLocaleString()}
            />
          </div>

          <div className="grid gap-2 text-sm text-muted-foreground">
            <p>Estimated CPU RAM: {formatBytes(result.recommendation.estimatedTotalRamBytes)}</p>
            <p>Estimated GPU usage: {formatBytes(result.recommendation.estimatedGpuUsageBytes)}</p>
            <p>Maximum offloadable layers: {result.recommendation.maxOffloadableLayers}</p>
          </div>

          {result.recommendation.exceedsSystemRam ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The requested context exceeds the safe RAM budget. Apply the reduced context before
              loading to avoid an OS-level OOM.
            </div>
          ) : null}

          <div className="space-y-2 rounded-xl border border-border/70 bg-card/70 p-3 text-sm text-muted-foreground">
            {result.recommendation.reasoning.map((reasoningLine) => (
              <p key={reasoningLine}>{reasoningLine}</p>
            ))}
          </div>

          <div className="flex justify-end">
            <Button
              disabled={disabled}
              onClick={() => {
                onApply(result.recommendation);
              }}
              type="button">
              Apply recommendation
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Renders a labeled metric card with a value. */
function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-xl border border-border/70 bg-card/80 px-3 py-2">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

/** Fetches the hardware optimizer recommendation and updates local state. */
export async function loadOptimizerResult({
  model,
  requestedContextLength,
  setError,
  setLoading,
  setResult,
  shouldCommit = () => true,
  getRecommendation = getHardwareOptimizerRecommendation,
}: {
  model: ModelRecord;
  requestedContextLength: number;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setResult: (result: HardwareOptimizerResult | null) => void;
  shouldCommit?: () => boolean;
  getRecommendation?: typeof getHardwareOptimizerRecommendation;
}): Promise<void> {
  setLoading(true);
  setError(null);

  try {
    const response = await getRecommendation(model.id, requestedContextLength);

    if (!shouldCommit()) {
      return;
    }

    setResult(response.optimizer);
  } catch (error) {
    if (!shouldCommit()) {
      return;
    }

    setError(error instanceof Error ? error.message : "Failed to analyze local hardware.");
  } finally {
    if (shouldCommit()) {
      setLoading(false);
    }
  }
}

/**
 * Formats a raw byte count into a GiB or MiB string.
 *
 * @param byteSize The size in bytes.
 * @returns The formatted size string.
 */
function formatBytes(byteSize: number): string {
  const gibibyte = 1024 * 1024 * 1024;

  if (byteSize >= gibibyte) {
    return `${(byteSize / gibibyte).toFixed(1)} GiB`;
  }

  return `${Math.round(byteSize / (1024 * 1024))} MiB`;
}
