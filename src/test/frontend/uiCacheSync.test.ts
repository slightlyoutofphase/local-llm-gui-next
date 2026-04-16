import { describe, expect, test } from "bun:test";
import type { UiCacheState } from "../../lib/ui-cache";
import {
  broadcastUiCacheSync,
  subscribeToUiCacheSync,
  subscribeToWindowActivation,
  type UiCacheSyncEnvironment,
} from "../../lib/uiCacheSync";

const UI_CACHE: UiCacheState = {
  cachedModels: [],
  dbRevision: 7,
  debugPanelOpen: true,
  lastChatId: "chat-123",
};

describe("uiCacheSync", () => {
  test("broadcastUiCacheSync publishes through both broadcast and storage transports", () => {
    const messages: unknown[] = [];
    const storageWrites: Array<{ key: string; value: string | null }> = [];

    broadcastUiCacheSync(UI_CACHE, {
      createBroadcastChannel: () => ({
        addEventListener: () => {},
        close: () => {},
        postMessage: (message) => {
          messages.push(message);
        },
        removeEventListener: () => {},
      }),
      localStorage: {
        removeItem: (key) => {
          storageWrites.push({ key, value: null });
        },
        setItem: (key, value) => {
          storageWrites.push({ key, value });
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ cache: UI_CACHE });
    expect(storageWrites[0]).toMatchObject({ key: "local-llm-gui-ui-cache-sync" });
    expect(storageWrites[1]).toEqual({ key: "local-llm-gui-ui-cache-sync", value: null });
  });

  test("subscribeToUiCacheSync forwards external cache updates from storage and broadcast events", () => {
    const receivedCaches: UiCacheState[] = [];
    const storageListeners: Array<(event: StorageEvent) => void> = [];
    const broadcastListeners: Array<(event: { data: unknown }) => void> = [];
    const environment: UiCacheSyncEnvironment = {
      addWindowEventListener: (type, listener) => {
        if (type === "storage") {
          storageListeners.push(listener as (event: StorageEvent) => void);
        }
      },
      createBroadcastChannel: () => ({
        addEventListener: (_type, listener) => {
          broadcastListeners.push(listener);
        },
        close: () => {},
        postMessage: () => {},
        removeEventListener: () => {},
      }),
      removeWindowEventListener: () => {},
    };

    const unsubscribe = subscribeToUiCacheSync((cache) => {
      receivedCaches.push(cache);
    }, environment);

    broadcastListeners[0]?.({
      data: {
        cache: UI_CACHE,
        sourceId: "other-window",
      },
    });
    storageListeners[0]?.({
      key: "local-llm-gui-ui-cache-sync",
      newValue: JSON.stringify({
        cache: {
          ...UI_CACHE,
          dbRevision: 8,
        },
        sourceId: "other-window-2",
      }),
    } as StorageEvent);

    unsubscribe();

    expect(receivedCaches).toEqual([
      UI_CACHE,
      {
        ...UI_CACHE,
        dbRevision: 8,
      },
    ]);
  });

  test("subscribeToWindowActivation reacts to focus and visible document changes", () => {
    const activations: string[] = [];
    const focusListeners: Array<() => void> = [];
    const visibilityListeners: Array<() => void> = [];
    let visible = false;

    const unsubscribe = subscribeToWindowActivation(
      () => {
        activations.push("activate");
      },
      {
        addDocumentEventListener: (_type, listener) => {
          visibilityListeners.push(listener as () => void);
        },
        addWindowEventListener: (_type, listener) => {
          focusListeners.push(listener as () => void);
        },
        isDocumentVisible: () => visible,
        removeDocumentEventListener: () => {},
        removeWindowEventListener: () => {},
      },
    );

    focusListeners[0]?.();
    visibilityListeners[0]?.();
    visible = true;
    visibilityListeners[0]?.();
    unsubscribe();

    expect(activations).toEqual(["activate", "activate"]);
  });
});
