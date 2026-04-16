import { expect, test } from "bun:test";
import { shouldApplyLoadedChatResponse } from "../../store/chatStore";

test("shouldApplyLoadedChatResponse rejects stale chat loads after the store advances", () => {
  expect(
    shouldApplyLoadedChatResponse(
      {
        activeChatId: "chat-1",
        knownDbRevision: 8,
      },
      "chat-1",
      7,
    ),
  ).toBe(false);
});

test("shouldApplyLoadedChatResponse accepts the current chat when the response is not stale", () => {
  expect(
    shouldApplyLoadedChatResponse(
      {
        activeChatId: "chat-1",
        knownDbRevision: 8,
      },
      "chat-1",
      8,
    ),
  ).toBe(true);
});

test("shouldApplyLoadedChatResponse rejects responses for chats that are no longer active", () => {
  expect(
    shouldApplyLoadedChatResponse(
      {
        activeChatId: "chat-2",
        knownDbRevision: 8,
      },
      "chat-1",
      9,
    ),
  ).toBe(false);
});