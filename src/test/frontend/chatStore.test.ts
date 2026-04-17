import { expect, test } from "bun:test";
import { refreshChatIfMessageMissing, shouldApplyLoadedChatResponse } from "../../store/chatStore";

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

test("refreshChatIfMessageMissing returns true when the target message is already present", async () => {
  const state = {
    activeChatId: "chat-1",
    activeGenerationChatId: null,
    chats: [],
    chatPaginationById: {},
    knownDbRevision: 1,
    messagesByChatId: {
      "chat-1": [
        {
          id: "msg-1",
          chatId: "chat-1",
          sequence: 1,
          role: "assistant",
          content: "ok",
          attachments: [],
          reasoningContent: null,
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          mediaAttachments: [],
        },
      ],
    },
  } as const;

  const getState = () => state as any;
  const setState = (patch: any) => {
    if (typeof patch === "function") {
      Object.assign(state, patch(state));
    } else {
      Object.assign(state, patch);
    }
  };

  expect(await refreshChatIfMessageMissing("chat-1", "msg-1", getState, setState)).toBe(true);
});

test("refreshChatIfMessageMissing fetches chat history when the target message is missing", async () => {
  const state = {
    activeChatId: "chat-1",
    activeGenerationChatId: null,
    chats: [],
    chatPaginationById: {},
    knownDbRevision: 1,
    messagesByChatId: {},
  };

  const getState = () => state as any;
  const setState = (patch: any) => {
    if (typeof patch === "function") {
      Object.assign(state, patch(state));
    } else {
      Object.assign(state, patch);
    }
  };

  const chatResponse = {
    chat: {
      id: "chat-1",
      title: "Test chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    dbRevision: 2,
    messages: [
      {
        id: "msg-2",
        chatId: "chat-1",
        sequence: 2,
        role: "assistant",
        content: "ok",
        attachments: [],
        reasoningContent: null,
        metadata: {},
        createdAt: "2026-01-01T00:01:00.000Z",
        mediaAttachments: [],
      },
    ],
  };

  const fetchChatFn = async () => chatResponse as any;

  expect(
    await refreshChatIfMessageMissing("chat-1", "msg-2", getState, setState, fetchChatFn),
  ).toBe(true);
  expect(state.messagesByChatId["chat-1"]).toEqual(chatResponse.messages);
  expect(state.knownDbRevision).toBe(2);
});
