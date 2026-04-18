import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ModelRecord } from "../lib/contracts";
import { broadcastUiCacheSync } from "./uiCacheSync";

const CACHE_DATABASE_NAME = "local-llm-gui-ui-cache";
const CACHE_STORE_NAME = "state";

interface UiCacheSchema extends DBSchema {
  state: {
    key: string;
    value: unknown;
  };
}

/**
 * Represents the ephemeral client-side UI cache persisted in IndexedDB.
 */
export interface UiCacheState {
  /** The last backend revision reflected in the cache. */
  dbRevision: number;
  /** The last scanned model payload cached on the client. */
  cachedModels: ModelRecord[];
  /** The last open chat identifier. */
  lastChatId: string | null;
  /** Whether the debug panel was open on the last page unload. */
  debugPanelOpen: boolean;
  /** The server process build identifier from the last successful hydration. */
  lastBuildId: string | null;
}

const DEFAULT_UI_CACHE_STATE: UiCacheState = {
  dbRevision: 0,
  cachedModels: [],
  debugPanelOpen: false,
  lastBuildId: null,
  lastChatId: null,
};

type UiCacheStateReader = () => Promise<UiCacheState>;
type UiCacheStateWriter = (nextCache: UiCacheState) => Promise<UiCacheState>;
type UiCacheStateNotifier = (nextCache: UiCacheState) => void;

/**
 * Reads the persisted UI cache.
 *
 * @returns The cached UI state.
 */
export async function readUiCache(): Promise<UiCacheState> {
  const database = await openUiCacheDatabase();
  const storedValue = await database.get(CACHE_STORE_NAME, "ui");

  return normalizeUiCacheState(storedValue);
}

let sessionFallbackCache: UiCacheState | null = null;

/**
 * Reads the persisted UI cache, falling back to the discardable default snapshot when storage
 * access is blocked or unavailable.
 */
export async function readUiCacheBestEffort(
  readCache: UiCacheStateReader = readUiCache,
): Promise<UiCacheState> {
  try {
    return await readCache();
  } catch {
    return sessionFallbackCache ?? DEFAULT_UI_CACHE_STATE;
  }
}

/**
 * Writes a partial UI cache update without surfacing discardable IndexedDB failures to callers.
 */
export async function writeUiCacheBestEffort(
  update: Partial<UiCacheState>,
  options: {
    currentCache?: UiCacheState;
    notifyCache?: UiCacheStateNotifier;
    readCache?: UiCacheStateReader;
    writeCache?: UiCacheStateWriter;
  } = {},
): Promise<UiCacheState> {
  const currentCache =
    options.currentCache ??
    (options.readCache
      ? await readUiCacheBestEffort(options.readCache)
      : await readUiCacheBestEffort());
  const nextCache: UiCacheState = {
    ...currentCache,
    ...update,
  };

  try {
    const persistedCache = await (options.writeCache ?? writeUiCacheState)(nextCache);

    (options.notifyCache ?? broadcastUiCacheSync)(persistedCache);

    return persistedCache;
  } catch {
    sessionFallbackCache = nextCache;
    (options.notifyCache ?? broadcastUiCacheSync)(nextCache);
    return nextCache;
  }
}

/**
 * Recomputes the cached UI state for a backend revision change without failing callers when the
 * cache write cannot complete.
 */
export async function invalidateUiCacheForRevisionBestEffort(
  currentCache: UiCacheState,
  nextRevision: number,
  writeCache: UiCacheStateWriter = writeUiCacheState,
  notifyCache: UiCacheStateNotifier = broadcastUiCacheSync,
): Promise<UiCacheState> {
  if (currentCache.dbRevision === nextRevision) {
    return currentCache;
  }

  const nextCache = buildRevisionInvalidatedUiCache(currentCache, nextRevision);

  try {
    const persistedCache = await writeCache(nextCache);

    notifyCache(persistedCache);

    return persistedCache;
  } catch {
    notifyCache(nextCache);
    return nextCache;
  }
}

/**
 * Writes a partial UI cache update.
 *
 * @param update Partial cache update.
 * @returns The merged cache state.
 */
export async function writeUiCache(update: Partial<UiCacheState>): Promise<UiCacheState> {
  const currentCache = await readUiCache();
  const nextCache: UiCacheState = {
    ...currentCache,
    ...update,
  };
  const persistedCache = await writeUiCacheState(nextCache);

  broadcastUiCacheSync(persistedCache);

  return persistedCache;
}

/**
 * Resets the cached model payload when the backend revision changes.
 *
 * @param nextRevision The latest backend revision.
 * @returns The updated cache state.
 */
export async function invalidateUiCacheForRevision(nextRevision: number): Promise<UiCacheState> {
  const currentCache = await readUiCache();

  if (currentCache.dbRevision === nextRevision) {
    return currentCache;
  }

  return await writeUiCache(buildRevisionInvalidatedUiCache(currentCache, nextRevision));
}

/**
 * Recomputes the cached client state when the backend revision changes.
 *
 * The chat store already validates `lastChatId` against freshly fetched chats,
 * so only model-derived cache data needs to be cleared here.
 *
 * @param currentCache The previously persisted UI cache.
 * @param nextRevision The latest backend revision.
 * @returns The next cache snapshot to persist.
 */
export function buildRevisionInvalidatedUiCache(
  currentCache: UiCacheState,
  nextRevision: number,
): UiCacheState {
  return {
    ...currentCache,
    cachedModels: [],
    dbRevision: nextRevision,
  };
}

function normalizeUiCacheState(storedValue: unknown): UiCacheState {
  if (!storedValue || typeof storedValue !== "object") {
    return DEFAULT_UI_CACHE_STATE;
  }

  return {
    ...DEFAULT_UI_CACHE_STATE,
    ...(storedValue as Partial<UiCacheState>),
  };
}

async function writeUiCacheState(nextCache: UiCacheState): Promise<UiCacheState> {
  const database = await openUiCacheDatabase();

  await database.put(CACHE_STORE_NAME, nextCache, "ui");

  return nextCache;
}

/** Opens (or creates) the IndexedDB database used for ephemeral UI state. */
async function openUiCacheDatabase(): Promise<IDBPDatabase<UiCacheSchema>> {
  return await openDB<UiCacheSchema>(CACHE_DATABASE_NAME, 1, {
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
        database.createObjectStore(CACHE_STORE_NAME);
      }
    },
  });
}
