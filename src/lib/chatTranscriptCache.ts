import type { ChatMessageRecord } from "./contracts";

/** Maximum number of full chat transcripts retained in the frontend cache. */
export const MAX_CACHED_CHAT_TRANSCRIPTS = 5;

/**
 * Updates one cached transcript while preserving recency order and evicting
 * the oldest unprotected chats when the cache grows past its cap.
 *
 * @param options The current cache and the transcript update to apply.
 * @param options.cache Existing transcript cache keyed by chat ID.
 * @param options.chatId The chat whose cache entry should be updated or removed.
 * @param options.messages The cached transcript, or `null` to remove the entry.
 * @param options.protectedChatIds Chat IDs that must not be evicted.
 * @param options.maxEntries Optional cache cap override used by tests.
 * @returns The next bounded transcript cache.
 */
export function updateBoundedTranscriptCache(options: {
  cache: Record<string, ChatMessageRecord[]>;
  chatId: string;
  messages: ChatMessageRecord[] | null;
  protectedChatIds?: Iterable<string | null | undefined>;
  maxEntries?: number;
}): Record<string, ChatMessageRecord[]> {
  const {
    cache,
    chatId,
    messages,
    protectedChatIds = [],
    maxEntries = MAX_CACHED_CHAT_TRANSCRIPTS,
  } = options;
  const nextCache: Record<string, ChatMessageRecord[]> = {};

  for (const [cachedChatId, cachedMessages] of Object.entries(cache)) {
    if (cachedChatId !== chatId) {
      nextCache[cachedChatId] = cachedMessages;
    }
  }

  if (messages !== null) {
    nextCache[chatId] = messages;
  }

  const protectedChatIdSet = new Set<string>();

  for (const protectedChatId of protectedChatIds) {
    if (typeof protectedChatId === "string" && protectedChatId.length > 0) {
      protectedChatIdSet.add(protectedChatId);
    }
  }

  while (Object.keys(nextCache).length > maxEntries) {
    let evicted = false;

    for (const cachedChatId of Object.keys(nextCache)) {
      if (protectedChatIdSet.has(cachedChatId)) {
        continue;
      }

      delete nextCache[cachedChatId];
      evicted = true;
      break;
    }

    if (!evicted) {
      break;
    }
  }

  return nextCache;
}
