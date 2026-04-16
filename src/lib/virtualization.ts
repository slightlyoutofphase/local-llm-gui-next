/**
 * Drops measured-height entries that no longer belong to the active virtualized collection.
 *
 * Returning the original object when nothing changes keeps React state updates cheap for steady
 * scrolling while still letting long-lived sessions release stale measurements as items disappear.
 */
export function pruneMeasuredHeights(
  measuredHeights: Readonly<Record<string, number>>,
  activeIds: readonly string[],
): Record<string, number> {
  const activeIdSet = new Set(activeIds);

  if (activeIdSet.size === 0) {
    return Object.keys(measuredHeights).length === 0 ? measuredHeights : {};
  }

  let removedAny = false;
  const nextHeights: Record<string, number> = {};

  for (const [itemId, height] of Object.entries(measuredHeights)) {
    if (!activeIdSet.has(itemId)) {
      removedAny = true;
      continue;
    }

    nextHeights[itemId] = height;
  }

  return removedAny ? nextHeights : measuredHeights;
}

export interface MeasuredHeightsStore {
  getSnapshot: () => Record<string, number>;
  prune: (activeIds: readonly string[]) => void;
  setMeasuredHeight: (itemId: string, nextHeight: number, activeIds?: readonly string[]) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createMeasuredHeightsStore(
  initialSnapshot: Record<string, number> = {},
): MeasuredHeightsStore {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();

  const updateSnapshot = (nextSnapshot: Record<string, number>): void => {
    if (nextSnapshot === snapshot) {
      return;
    }

    snapshot = nextSnapshot;

    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => snapshot,
    prune: (activeIds) => {
      updateSnapshot(pruneMeasuredHeights(snapshot, activeIds));
    },
    setMeasuredHeight: (itemId, nextHeight, activeIds) => {
      const currentSnapshot = activeIds ? pruneMeasuredHeights(snapshot, activeIds) : snapshot;
      const nextSnapshot =
        currentSnapshot[itemId] === nextHeight
          ? currentSnapshot
          : {
              ...currentSnapshot,
              [itemId]: nextHeight,
            };

      updateSnapshot(nextSnapshot);
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
