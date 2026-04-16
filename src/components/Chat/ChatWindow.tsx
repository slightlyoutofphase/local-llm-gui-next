"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { ArrowDown } from "lucide-react";
import type { ChatMessageRecord } from "@/lib/contracts";
import { createMeasuredHeightsStore } from "@/lib/virtualization";
import { MessageBubble } from "@/components/Chat/MessageBubble";
import { Button } from "@/components/ui/button";
import { calculateVirtualChatWindow, CHAT_WINDOW_MESSAGE_HEIGHT_FALLBACK } from "./chatWindowUtils";

export interface ChatWindowProps {
  hasOlderMessages: boolean;
  messages: ChatMessageRecord[];
  isSending: boolean;
  loadingOlderMessages: boolean;
  onBranchMessage: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string) => void;
  onLoadOlderMessages: () => void;
  onRegenerateMessage: (messageId: string) => void;
}

/**
 * Renders the scrollable chat transcript with smart auto-scroll behavior.
 *
 * @param props Component props.
 * @param props.messages The ordered chat messages.
 * @param props.isSending Indicates whether an assistant response is streaming.
 * @returns The rendered chat transcript.
 */
export function ChatWindow({
  hasOlderMessages,
  messages,
  isSending,
  loadingOlderMessages,
  onBranchMessage,
  onEditMessage,
  onLoadOlderMessages,
  onRegenerateMessage,
}: ChatWindowProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingPrependScrollHeightRef = useRef<number | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const bottomMarkerRef = useRef<HTMLDivElement | null>(null);
  const measuredMessageHeightsStore = useMemo(() => createMeasuredHeightsStore(), []);
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.metadata["hiddenFromTranscript"] !== true),
    [messages],
  );
  const visibleMessageIds = useMemo(
    () => visibleMessages.map((message) => message.id),
    [visibleMessages],
  );
  const visibleMessageIdsRef = useRef<readonly string[]>(visibleMessageIds);

  const measuredMessageHeights = useSyncExternalStore(
    measuredMessageHeightsStore.subscribe,
    measuredMessageHeightsStore.getSnapshot,
    measuredMessageHeightsStore.getSnapshot,
  );
  const firstMessageId = useMemo(() => visibleMessages[0]?.id ?? "", [visibleMessages]);
  const lastMessageId = useMemo(() => visibleMessages.at(-1)?.id ?? "", [visibleMessages]);
  const lastStreamingRenderKey = useMemo(() => {
    if (!isSending) {
      return "";
    }

    const lastMessage = visibleMessages.at(-1);

    if (!lastMessage || lastMessage.role !== "assistant") {
      return "";
    }

    return `${lastMessage.id}:${lastMessage.content.length}:${lastMessage.reasoningContent?.length ?? 0}`;
  }, [isSending, visibleMessages]);
  const messageHeights = useMemo(
    () =>
      visibleMessages.map(
        (message) => measuredMessageHeights[message.id] ?? CHAT_WINDOW_MESSAGE_HEIGHT_FALLBACK,
      ),
    [measuredMessageHeights, visibleMessages],
  );

  useEffect(() => {
    visibleMessageIdsRef.current = visibleMessageIds;
    measuredMessageHeightsStore.prune(visibleMessageIds);
  }, [measuredMessageHeightsStore, visibleMessageIds]);

  const handleMessageHeightChange = useCallback(
    (messageId: string, nextHeight: number): void => {
      measuredMessageHeightsStore.setMeasuredHeight(
        messageId,
        nextHeight,
        visibleMessageIdsRef.current,
      );
    },
    [measuredMessageHeightsStore],
  );
  const virtualWindow = useMemo(
    () =>
      calculateVirtualChatWindow({
        messageHeights,
        scrollTop,
        viewportHeight,
      }),
    [messageHeights, scrollTop, viewportHeight],
  );
  const renderedMessages = useMemo(
    () => visibleMessages.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [virtualWindow.endIndex, virtualWindow.startIndex, visibleMessages],
  );

  const syncViewportMetrics = useCallback((): void => {
    if (!containerRef.current) {
      return;
    }

    setViewportHeight(containerRef.current.clientHeight);
    setScrollTop(containerRef.current.scrollTop);
  }, []);

  const scrollToBottom = useCallback(
    (smooth: boolean): void => {
      if (!containerRef.current) {
        return;
      }

      if (smooth) {
        bottomMarkerRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      } else {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }

      syncViewportMetrics();
    },
    [syncViewportMetrics],
  );

  const updateScrollState = (): void => {
    if (!containerRef.current) {
      return;
    }

    const { clientHeight, scrollHeight, scrollTop } = containerRef.current;
    const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
    const nextAutoScrollEnabled = distanceFromBottom < 24;

    setAutoScrollEnabled(nextAutoScrollEnabled);
    setShowScrollButton(!nextAutoScrollEnabled);
    setScrollTop(scrollTop);
  };

  useEffect(() => {
    syncViewportMetrics();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      syncViewportMetrics();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [syncViewportMetrics]);

  useEffect(() => {
    if (autoScrollEnabled) {
      scrollToBottom(true);
    }
  }, [autoScrollEnabled, lastMessageId, scrollToBottom]);

  useEffect(() => {
    if (pendingPrependScrollHeightRef.current === null || loadingOlderMessages) {
      return;
    }

    if (!containerRef.current) {
      pendingPrependScrollHeightRef.current = null;
      return;
    }

    const addedHeight = containerRef.current.scrollHeight - pendingPrependScrollHeightRef.current;

    if (addedHeight > 0) {
      containerRef.current.scrollTop += addedHeight;
    }

    syncViewportMetrics();
    pendingPrependScrollHeightRef.current = null;
  }, [firstMessageId, loadingOlderMessages, syncViewportMetrics, visibleMessages.length]);

  useEffect(() => {
    if (!autoScrollEnabled || !isSending) {
      return;
    }
    scrollToBottom(false);
  }, [autoScrollEnabled, isSending, lastStreamingRenderKey, scrollToBottom]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-[1.5rem] border border-border/70 bg-background/80">
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-6"
        onScroll={updateScrollState}
        ref={containerRef}>
        {hasOlderMessages || loadingOlderMessages ? (
          <div className="flex justify-center">
            <Button
              disabled={loadingOlderMessages}
              onClick={() => {
                pendingPrependScrollHeightRef.current = containerRef.current?.scrollHeight ?? null;
                onLoadOlderMessages();
              }}
              type="button"
              variant="outline">
              {loadingOlderMessages ? "Loading older messages..." : "Load older messages"}
            </Button>
          </div>
        ) : null}
        {visibleMessages.length === 0 ? (
          <div className="flex min-h-[20rem] items-center justify-center rounded-[1.25rem] border border-dashed border-border/80 bg-card/60 p-8 text-center text-sm leading-7 text-muted-foreground">
            Start a chat, load a model, and send the first prompt to begin streaming responses.
          </div>
        ) : (
          <div style={{ height: virtualWindow.totalHeight }}>
            <div aria-hidden style={{ height: virtualWindow.topSpacerHeight }} />
            <div>
              {renderedMessages.map((message, index) => {
                const absoluteIndex = virtualWindow.startIndex + index;

                return (
                  <MeasuredMessageRow
                    actionsDisabled={isSending}
                    isLastVisibleMessage={absoluteIndex === visibleMessages.length - 1}
                    isStreaming={
                      isSending &&
                      absoluteIndex === visibleMessages.length - 1 &&
                      message.role === "assistant"
                    }
                    key={message.id}
                    message={message}
                    onBranchMessage={onBranchMessage}
                    onEditMessage={onEditMessage}
                    onHeightChange={handleMessageHeightChange}
                    onRegenerateMessage={onRegenerateMessage}
                  />
                );
              })}
            </div>
            <div aria-hidden style={{ height: virtualWindow.bottomSpacerHeight }} />
          </div>
        )}
        <div ref={bottomMarkerRef} />
      </div>

      {showScrollButton ? (
        <Button
          className="absolute bottom-4 right-4 rounded-full shadow-lg"
          onClick={() => {
            setAutoScrollEnabled(true);
            bottomMarkerRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
          size="icon">
          <ArrowDown className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function MeasuredMessageRow(props: {
  actionsDisabled: boolean;
  isLastVisibleMessage: boolean;
  isStreaming: boolean;
  message: ChatMessageRecord;
  onBranchMessage: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string) => void;
  onHeightChange: (messageId: string, nextHeight: number) => void;
  onRegenerateMessage: (messageId: string) => void;
}): ReactElement {
  const {
    actionsDisabled,
    isLastVisibleMessage,
    isStreaming,
    message,
    onBranchMessage,
    onEditMessage,
    onHeightChange,
    onRegenerateMessage,
  } = props;
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const rowElement = rowRef.current;

    if (!rowElement) {
      return;
    }

    const reportHeight = (): void => {
      onHeightChange(message.id, Math.ceil(rowElement.getBoundingClientRect().height));
    };

    reportHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      reportHeight();
    });

    resizeObserver.observe(rowElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [message.id, onHeightChange]);

  return (
    <div className={isLastVisibleMessage ? undefined : "pb-4"} ref={rowRef}>
      <MessageBubble
        actionsDisabled={actionsDisabled}
        isStreaming={isStreaming}
        message={message}
        onBranch={onBranchMessage}
        onEdit={onEditMessage}
        onRegenerate={onRegenerateMessage}
      />
    </div>
  );
}
