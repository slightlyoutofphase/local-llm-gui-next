import type { AppConfig, DebugLogEntry } from "@/lib/contracts";

export const DEBUG_LOG_ENTRY_HEIGHT_FALLBACK = 112;
export const DEBUG_LOG_OVERSCAN_COUNT = 6;

export interface VirtualizedDebugLogWindow {
  bottomSpacerHeight: number;
  endIndex: number;
  startIndex: number;
  topSpacerHeight: number;
  totalHeight: number;
}

export function filterVisibleDebugLogEntries(
  config: AppConfig | null,
  entries: DebugLogEntry[],
): DebugLogEntry[] {
  const debugSettings = config?.debug;

  return entries.filter((entry) => {
    if (!debugSettings?.enabled) {
      return false;
    }

    if (entry.source === "process:stdout") {
      return debugSettings.showProcessStdout;
    }

    if (entry.source === "process:stderr") {
      return debugSettings.showProcessStderr;
    }

    return debugSettings.showServerLogs;
  });
}

export function calculateVirtualDebugLogWindow(input: {
  entryHeights: readonly number[];
  overscanCount?: number;
  scrollTop: number;
  viewportHeight: number;
}): VirtualizedDebugLogWindow {
  const { entryHeights, scrollTop, viewportHeight } = input;
  const overscanCount = input.overscanCount ?? DEBUG_LOG_OVERSCAN_COUNT;
  const prefixSums = createPrefixSums(entryHeights);
  const totalHeight = prefixSums[prefixSums.length - 1] ?? 0;

  if (entryHeights.length === 0) {
    return {
      bottomSpacerHeight: 0,
      endIndex: 0,
      startIndex: 0,
      topSpacerHeight: 0,
      totalHeight: 0,
    };
  }

  if (viewportHeight <= 0) {
    const endIndex = Math.min(entryHeights.length, Math.max(1, overscanCount * 2));

    return {
      bottomSpacerHeight: totalHeight - prefixSums[endIndex]!,
      endIndex,
      startIndex: 0,
      topSpacerHeight: 0,
      totalHeight,
    };
  }

  const safeScrollTop = Math.max(0, scrollTop);
  const visibleBottom = safeScrollTop + viewportHeight;
  let visibleStartIndex = 0;

  while (
    visibleStartIndex < entryHeights.length &&
    prefixSums[visibleStartIndex + 1]! <= safeScrollTop
  ) {
    visibleStartIndex += 1;
  }

  let visibleEndIndex = visibleStartIndex;

  while (visibleEndIndex < entryHeights.length && prefixSums[visibleEndIndex]! < visibleBottom) {
    visibleEndIndex += 1;
  }

  visibleEndIndex = Math.max(visibleEndIndex, visibleStartIndex + 1);

  const startIndex = Math.max(0, visibleStartIndex - overscanCount);
  const endIndex = Math.min(entryHeights.length, visibleEndIndex + overscanCount);

  return {
    bottomSpacerHeight: totalHeight - prefixSums[endIndex]!,
    endIndex,
    startIndex,
    topSpacerHeight: prefixSums[startIndex]!,
    totalHeight,
  };
}

function createPrefixSums(entryHeights: readonly number[]): number[] {
  const prefixSums = [0];

  for (const entryHeight of entryHeights) {
    prefixSums.push(prefixSums[prefixSums.length - 1]! + entryHeight);
  }

  return prefixSums;
}
