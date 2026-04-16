import type { UiCacheState } from "./ui-cache";

const UI_CACHE_SYNC_CHANNEL_NAME = "local-llm-gui-ui-cache-sync";
const UI_CACHE_SYNC_STORAGE_KEY = "local-llm-gui-ui-cache-sync";
const UI_CACHE_SYNC_SOURCE_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `ui-cache-sync-${String(Date.now())}`;

interface UiCacheSyncEnvelope {
  cache: UiCacheState;
  sourceId: string;
}

interface BroadcastChannelLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

interface StorageLike {
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface WindowEventLikeMap {
  focus: Event;
  storage: StorageEvent;
}

interface DocumentEventLikeMap {
  visibilitychange: Event;
}

export interface UiCacheSyncEnvironment {
  addDocumentEventListener?: <TType extends keyof DocumentEventLikeMap>(
    type: TType,
    listener: (event: DocumentEventLikeMap[TType]) => void,
  ) => void;
  addWindowEventListener?: <TType extends keyof WindowEventLikeMap>(
    type: TType,
    listener: (event: WindowEventLikeMap[TType]) => void,
  ) => void;
  createBroadcastChannel?: (channelName: string) => BroadcastChannelLike | null;
  isDocumentVisible?: () => boolean;
  localStorage?: StorageLike | null;
  removeDocumentEventListener?: <TType extends keyof DocumentEventLikeMap>(
    type: TType,
    listener: (event: DocumentEventLikeMap[TType]) => void,
  ) => void;
  removeWindowEventListener?: <TType extends keyof WindowEventLikeMap>(
    type: TType,
    listener: (event: WindowEventLikeMap[TType]) => void,
  ) => void;
}

/** Broadcasts the latest UI-cache snapshot to other client windows. */
export function broadcastUiCacheSync(
  cache: UiCacheState,
  environment: UiCacheSyncEnvironment = getDefaultUiCacheSyncEnvironment(),
): void {
  const envelope: UiCacheSyncEnvelope = {
    cache,
    sourceId: UI_CACHE_SYNC_SOURCE_ID,
  };
  const channel = environment.createBroadcastChannel?.(UI_CACHE_SYNC_CHANNEL_NAME) ?? null;

  channel?.postMessage(envelope);
  channel?.close();

  try {
    environment.localStorage?.setItem(UI_CACHE_SYNC_STORAGE_KEY, JSON.stringify(envelope));
    environment.localStorage?.removeItem(UI_CACHE_SYNC_STORAGE_KEY);
  } catch {
    // Ignore best-effort cross-window sync failures.
  }
}

/** Subscribes to external UI-cache updates from other client windows. */
export function subscribeToUiCacheSync(
  onCache: (cache: UiCacheState) => void,
  environment: UiCacheSyncEnvironment = getDefaultUiCacheSyncEnvironment(),
): () => void {
  const handleEnvelope = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    const envelope = value as Partial<UiCacheSyncEnvelope>;

    if (envelope.sourceId === UI_CACHE_SYNC_SOURCE_ID || !envelope.cache) {
      return;
    }

    onCache(envelope.cache);
  };

  const channel = environment.createBroadcastChannel?.(UI_CACHE_SYNC_CHANNEL_NAME) ?? null;
  const handleChannelMessage = (event: { data: unknown }): void => {
    handleEnvelope(event.data);
  };
  const handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== UI_CACHE_SYNC_STORAGE_KEY || !event.newValue) {
      return;
    }

    try {
      handleEnvelope(JSON.parse(event.newValue) as unknown);
    } catch {
      // Ignore malformed best-effort sync payloads.
    }
  };

  channel?.addEventListener("message", handleChannelMessage);
  environment.addWindowEventListener?.("storage", handleStorageEvent);

  return () => {
    channel?.removeEventListener("message", handleChannelMessage);
    channel?.close();
    environment.removeWindowEventListener?.("storage", handleStorageEvent);
  };
}

/** Subscribes to window-activation signals used as a fallback sync trigger. */
export function subscribeToWindowActivation(
  onActivate: () => void,
  environment: UiCacheSyncEnvironment = getDefaultUiCacheSyncEnvironment(),
): () => void {
  const handleFocus = (): void => {
    onActivate();
  };
  const handleVisibilityChange = (): void => {
    if (environment.isDocumentVisible?.() !== false) {
      onActivate();
    }
  };

  environment.addWindowEventListener?.("focus", handleFocus);
  environment.addDocumentEventListener?.("visibilitychange", handleVisibilityChange);

  return () => {
    environment.removeWindowEventListener?.("focus", handleFocus);
    environment.removeDocumentEventListener?.("visibilitychange", handleVisibilityChange);
  };
}

function getDefaultUiCacheSyncEnvironment(): UiCacheSyncEnvironment {
  if (typeof window === "undefined") {
    return {};
  }

  return {
    addDocumentEventListener: (type, listener) => {
      document.addEventListener(type, listener as EventListener);
    },
    addWindowEventListener: (type, listener) => {
      window.addEventListener(type, listener as EventListener);
    },
    createBroadcastChannel:
      typeof BroadcastChannel === "function"
        ? (channelName) => new BroadcastChannel(channelName)
        : () => null,
    isDocumentVisible: () => document.visibilityState === "visible",
    localStorage: typeof window.localStorage !== "undefined" ? window.localStorage : null,
    removeDocumentEventListener: (type, listener) => {
      document.removeEventListener(type, listener as EventListener);
    },
    removeWindowEventListener: (type, listener) => {
      window.removeEventListener(type, listener as EventListener);
    },
  };
}
