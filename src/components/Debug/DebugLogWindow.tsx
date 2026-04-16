"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import type { AppConfig, DebugLogEntry } from "@/lib/contracts";
import { createMeasuredHeightsStore } from "@/lib/virtualization";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  calculateVirtualDebugLogWindow,
  DEBUG_LOG_ENTRY_HEIGHT_FALLBACK,
  filterVisibleDebugLogEntries,
} from "./debugLogWindowUtils";

export interface DebugLogWindowProps {
  config: AppConfig | null;
  entries: DebugLogEntry[];
  open: boolean;
  onClear: () => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Renders the toggleable debug log overlay panel.
 *
 * @param props Component props.
 * @param props.config The current persisted application config.
 * @param props.entries The buffered debug log entries.
 * @param props.open Controls whether the panel is visible.
 * @param props.onClear Clears the retained debug log entries.
 * @param props.onOpenChange Updates the visibility state.
 * @returns The rendered debug log window.
 */
export function DebugLogWindow({
  config,
  entries,
  open,
  onClear,
  onOpenChange,
}: DebugLogWindowProps): ReactElement {
  const visibleEntries = useMemo(
    () => filterVisibleDebugLogEntries(config, entries),
    [config, entries],
  );
  const visibleEntryIds = useMemo(() => visibleEntries.map((entry) => entry.id), [visibleEntries]);
  const visibleEntryIdsRef = useRef<readonly string[]>(visibleEntryIds);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const entryHeightsStore = useMemo(() => createMeasuredHeightsStore(), []);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const entryHeightsById = useSyncExternalStore(
    entryHeightsStore.subscribe,
    entryHeightsStore.getSnapshot,
    entryHeightsStore.getSnapshot,
  );

  useEffect(() => {
    visibleEntryIdsRef.current = visibleEntryIds;
    entryHeightsStore.prune(visibleEntryIds);
  }, [entryHeightsStore, visibleEntryIds]);

  useEffect(() => {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    const updateViewport = (): void => {
      setViewportHeight(container.clientHeight);
      setScrollTop(container.scrollTop);
    };

    updateViewport();

    const resizeObserver = new ResizeObserver(() => {
      updateViewport();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [open]);

  const measuredEntryHeights = useMemo(
    () =>
      visibleEntries.map((entry) => entryHeightsById[entry.id] ?? DEBUG_LOG_ENTRY_HEIGHT_FALLBACK),
    [entryHeightsById, visibleEntries],
  );
  const virtualWindow = useMemo(
    () =>
      calculateVirtualDebugLogWindow({
        entryHeights: measuredEntryHeights,
        scrollTop,
        viewportHeight,
      }),
    [measuredEntryHeights, scrollTop, viewportHeight],
  );
  const renderedEntries = visibleEntries.slice(virtualWindow.startIndex, virtualWindow.endIndex);

  useEffect(() => {
    if (!open || isUserScrolledUp.current) {
      return;
    }

    const container = scrollContainerRef.current;

    if (container) {
      container.scrollTop = container.scrollHeight;
      setScrollTop(container.scrollTop);
    }
  }, [open, visibleEntries]);

  const handleScroll = (): void => {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    isUserScrolledUp.current = distanceFromBottom > 40;
    setScrollTop(container.scrollTop);
  };

  const measureEntry = (entryId: string, element: HTMLDivElement | null): void => {
    if (!element) {
      return;
    }

    const nextHeight = element.offsetHeight;

    entryHeightsStore.setMeasuredHeight(entryId, nextHeight, visibleEntryIdsRef.current);
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-[min(100vw,78rem)] border-l border-border/70 bg-background/96 backdrop-blur sm:max-w-[78rem]">
        <SheetHeader className="border-b border-border/70">
          <SheetTitle>Debug log</SheetTitle>
          <SheetDescription>
            Real-time `llama-server` and backend log output filtered by the current debug settings.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 flex items-center justify-between gap-3 px-6">
          <p className="text-sm text-muted-foreground">{visibleEntries.length} visible entries</p>
          <Button onClick={onClear} variant="outline">
            Clear log
          </Button>
        </div>

        <div
          className="mx-6 mt-4 mb-6 flex min-h-0 flex-1 overflow-y-auto rounded-[1.25rem] border border-border/70 bg-card/80"
          onScroll={handleScroll}
          ref={scrollContainerRef}>
          <div className="min-w-0 flex-1 font-mono text-[0.78rem] leading-6">
            {visibleEntries.length === 0 ? (
              <div className="flex min-h-full items-center justify-center px-6 py-12 text-sm text-muted-foreground">
                No log entries match the active filters.
              </div>
            ) : (
              <div style={{ height: virtualWindow.totalHeight }}>
                <div aria-hidden style={{ height: virtualWindow.topSpacerHeight }} />
                <div className="divide-y divide-border/60">
                  {renderedEntries.map((entry) => (
                    <div
                      className="px-4 py-3"
                      key={entry.id}
                      ref={(element) => {
                        measureEntry(entry.id, element);
                      }}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <span>{entry.source}</span>
                        <span className="text-[0.72rem] tabular-nums tracking-[0.12em]">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[0.8rem] leading-6 text-foreground/95">
                        {entry.message}
                      </pre>
                    </div>
                  ))}
                </div>
                <div aria-hidden style={{ height: virtualWindow.bottomSpacerHeight }} />
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
