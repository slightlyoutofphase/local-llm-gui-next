import { expect, test } from "bun:test";
import type { ChatStoreState } from "../../store/chatStore";
import type { ChatDetailResponse } from "../../lib/api";
import {
  preserveDraftsWhenSwitchingChats,
  refreshChatIfMessageMissing,
  shouldApplyLoadedChatResponse,
} from "../../store/chatStore";

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
  const state: ChatStoreState = {
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

  type ChatStoreStatePatch = Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState>);

  const getState = (): ChatStoreState => state as ChatStoreState;
  const setState = (patch: ChatStoreStatePatch) => {
    if (typeof patch === "function") {
      Object.assign(state, patch(state));
    } else {
      Object.assign(state, patch);
    }
  };

  expect(await refreshChatIfMessageMissing("chat-1", "msg-1", getState, setState)).toBe(true);
});

test("preserveDraftsWhenSwitchingChats saves current composer and attachments before switching chats", () => {
  const pendingAttachment = {
    file: new File(["hello"], "hello.txt", { type: "text/plain" }),
    fileName: "hello.txt",
    id: "attachment-1",
    kind: "image",
    mimeType: "image/png",
    size: 5,
  };

  const result = preserveDraftsWhenSwitchingChats(
    "chat-1",
    "chat-2",
    "Draft text",
    [pendingAttachment],
    { "chat-1": "Old draft" },
    { "chat-2": [pendingAttachment] },
  );

  expect(result.draftsByChatId).toEqual({ "chat-1": "Draft text" });
  expect(result.restoredComposerValue).toBe("");
  expect(result.restoredPendingAttachments).toEqual([pendingAttachment]);
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

  type ChatStoreStatePatch = Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState>);

  const getState = (): ChatStoreState => state as ChatStoreState;
  const setState = (patch: ChatStoreStatePatch) => {
    if (typeof patch === "function") {
      Object.assign(state, patch(state));
    } else {
      Object.assign(state, patch);
    }
  };

  const chatResponse: ChatDetailResponse = {
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

  const fetchChatFn = async (): Promise<ChatDetailResponse> => chatResponse;

  expect(
    await refreshChatIfMessageMissing("chat-1", "msg-2", getState, setState, fetchChatFn),
  ).toBe(true);
  expect(state.messagesByChatId["chat-1"]).toEqual(chatResponse.messages);
  expect(state.knownDbRevision).toBe(2);
});
