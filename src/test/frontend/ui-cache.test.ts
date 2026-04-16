import { expect, test } from "bun:test";
import {
  buildRevisionInvalidatedUiCache,
  invalidateUiCacheForRevisionBestEffort,
  readUiCacheBestEffort,
  type UiCacheState,
  writeUiCacheBestEffort,
} from "../../lib/ui-cache";

test("buildRevisionInvalidatedUiCache keeps lastChatId while clearing cached models", () => {
  const currentCache: UiCacheState = {
    cachedModels: [
      {
        id: "model-1",
        path: "D:/models/model-1.gguf",
        title: "Model 1",
      },
    ],
    dbRevision: 3,
    debugPanelOpen: true,
    lastChatId: "chat-123",
  };

  expect(buildRevisionInvalidatedUiCache(currentCache, 4)).toEqual({
    cachedModels: [],
    dbRevision: 4,
    debugPanelOpen: true,
    lastChatId: "chat-123",
  });
});

test("readUiCacheBestEffort falls back to the default cache when IndexedDB is unavailable", async () => {
  const cache = await readUiCacheBestEffort(async () => {
    throw new Error("IndexedDB blocked");
  });

  expect(cache).toEqual({
    cachedModels: [],
    dbRevision: 0,
    debugPanelOpen: false,
    lastChatId: null,
  });
});

test("writeUiCacheBestEffort returns the merged cache even when persistence fails", async () => {
  const currentCache: UiCacheState = {
    cachedModels: [],
    dbRevision: 7,
    debugPanelOpen: false,
    lastChatId: "chat-123",
  };

  const nextCache = await writeUiCacheBestEffort(
    { debugPanelOpen: true },
    {
      currentCache,
      writeCache: async () => {
        throw new Error("IndexedDB blocked");
      },
    },
  );

  expect(nextCache).toEqual({
    cachedModels: [],
    dbRevision: 7,
    debugPanelOpen: true,
    lastChatId: "chat-123",
  });
});

test("invalidateUiCacheForRevisionBestEffort preserves chat selection and debug state on write failure", async () => {
  const currentCache: UiCacheState = {
    cachedModels: [
      {
        id: "model-1",
        path: "D:/models/model-1.gguf",
        title: "Model 1",
      },
    ],
    dbRevision: 3,
    debugPanelOpen: true,
    lastChatId: "chat-123",
  };

  const nextCache = await invalidateUiCacheForRevisionBestEffort(currentCache, 4, async () => {
    throw new Error("IndexedDB blocked");
  });

  expect(nextCache).toEqual({
    cachedModels: [],
    dbRevision: 4,
    debugPanelOpen: true,
    lastChatId: "chat-123",
  });
});
