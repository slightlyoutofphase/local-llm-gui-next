import { describe, expect, test } from "bun:test";
import type { ChatMessageRecord } from "../../lib/contracts";
import {
  MAX_CACHED_CHAT_TRANSCRIPTS,
  updateBoundedTranscriptCache,
} from "../../lib/chatTranscriptCache";

function createTranscript(chatId: string): ChatMessageRecord[] {
  return [
    {
      content: `Message for ${chatId}`,
      chatId,
      createdAt: "2026-04-13T00:00:00.000Z",
      id: `${chatId}-message-1`,
      mediaAttachments: [],
      metadata: {},
      role: "user",
      sequence: 0,
    },
  ];
}

describe("updateBoundedTranscriptCache", () => {
  test("evicts the least recently updated transcript once the cache exceeds the cap", () => {
    let cache: Record<string, ChatMessageRecord[]> = {};

    for (let chatIndex = 1; chatIndex <= MAX_CACHED_CHAT_TRANSCRIPTS; chatIndex += 1) {
      cache = updateBoundedTranscriptCache({
        cache,
        chatId: `chat-${chatIndex}`,
        messages: createTranscript(`chat-${chatIndex}`),
      });
    }

    cache = updateBoundedTranscriptCache({
      cache,
      chatId: "chat-2",
      messages: createTranscript("chat-2"),
    });
    cache = updateBoundedTranscriptCache({
      cache,
      chatId: `chat-${MAX_CACHED_CHAT_TRANSCRIPTS + 1}`,
      messages: createTranscript(`chat-${MAX_CACHED_CHAT_TRANSCRIPTS + 1}`),
    });

    expect(Object.keys(cache)).toEqual(["chat-3", "chat-4", "chat-5", "chat-2", "chat-6"]);
  });

  test("skips protected chats during eviction even when they are the oldest entries", () => {
    let cache: Record<string, ChatMessageRecord[]> = {};

    for (let chatIndex = 1; chatIndex <= MAX_CACHED_CHAT_TRANSCRIPTS; chatIndex += 1) {
      cache = updateBoundedTranscriptCache({
        cache,
        chatId: `chat-${chatIndex}`,
        messages: createTranscript(`chat-${chatIndex}`),
      });
    }

    cache = updateBoundedTranscriptCache({
      cache,
      chatId: `chat-${MAX_CACHED_CHAT_TRANSCRIPTS + 1}`,
      messages: createTranscript(`chat-${MAX_CACHED_CHAT_TRANSCRIPTS + 1}`),
      protectedChatIds: ["chat-1"],
    });

    expect(Object.keys(cache)).toEqual(["chat-1", "chat-3", "chat-4", "chat-5", "chat-6"]);
  });
});
