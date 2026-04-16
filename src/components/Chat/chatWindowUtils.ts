export const CHAT_WINDOW_MESSAGE_HEIGHT_FALLBACK = 220;
export const CHAT_WINDOW_OVERSCAN_COUNT = 4;

export interface VirtualizedChatWindow {
  bottomSpacerHeight: number;
  endIndex: number;
  startIndex: number;
  topSpacerHeight: number;
  totalHeight: number;
}

export function calculateVirtualChatWindow(input: {
  messageHeights: readonly number[];
  overscanCount?: number;
  scrollTop: number;
  viewportHeight: number;
}): VirtualizedChatWindow {
  const { messageHeights, scrollTop, viewportHeight } = input;
  const overscanCount = input.overscanCount ?? CHAT_WINDOW_OVERSCAN_COUNT;
  const prefixSums = createPrefixSums(messageHeights);
  const totalHeight = prefixSums[prefixSums.length - 1] ?? 0;

  if (messageHeights.length === 0) {
    return {
      bottomSpacerHeight: 0,
      endIndex: 0,
      startIndex: 0,
      topSpacerHeight: 0,
      totalHeight: 0,
    };
  }

  if (viewportHeight <= 0) {
    const endIndex = Math.min(messageHeights.length, Math.max(1, overscanCount * 2));

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
    visibleStartIndex < messageHeights.length &&
    prefixSums[visibleStartIndex + 1]! <= safeScrollTop
  ) {
    visibleStartIndex += 1;
  }

  let visibleEndIndex = visibleStartIndex;

  while (visibleEndIndex < messageHeights.length && prefixSums[visibleEndIndex]! < visibleBottom) {
    visibleEndIndex += 1;
  }

  visibleEndIndex = Math.max(visibleEndIndex, visibleStartIndex + 1);

  const startIndex = Math.max(0, visibleStartIndex - overscanCount);
  const endIndex = Math.min(messageHeights.length, visibleEndIndex + overscanCount);

  return {
    bottomSpacerHeight: totalHeight - prefixSums[endIndex]!,
    endIndex,
    startIndex,
    topSpacerHeight: prefixSums[startIndex]!,
    totalHeight,
  };
}

function createPrefixSums(messageHeights: readonly number[]): number[] {
  const prefixSums = [0];

  for (const messageHeight of messageHeights) {
    prefixSums.push(prefixSums[prefixSums.length - 1]! + messageHeight);
  }

  return prefixSums;
}
