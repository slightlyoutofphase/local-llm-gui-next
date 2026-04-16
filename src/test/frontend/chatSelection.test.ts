import { describe, expect, test } from "bun:test";
import type { ChatSummary, ModelRecord } from "../../lib/contracts";
import { resolveChatCreationModelId, resolvePreferredChatModelId } from "../../lib/chatSelection";

function createModel(id: string): ModelRecord {
  return {
    architecture: "qwen3",
    defaultSampling: null,
    fileName: `${id}.gguf`,
    fileSizeBytes: 1024,
    id,
    modelName: id,
    modelPath: `D:/models/${id}.gguf`,
    publisher: "publisher",
    supportsAudio: false,
  };
}

function createChat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    createdAt: "2026-04-12T00:00:00.000Z",
    id: "chat-1",
    title: "Chat 1",
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolvePreferredChatModelId", () => {
  test("prefers the chat's last-used model when it still exists locally", () => {
    expect(
      resolvePreferredChatModelId({
        availableModels: [createModel("model-a"), createModel("model-b")],
        chat: createChat({ lastUsedModelId: "model-b" }),
        currentSelectedModelId: "model-a",
      }),
    ).toBe("model-b");
  });

  test("keeps the current selection when the chat hint is missing or unavailable", () => {
    expect(
      resolvePreferredChatModelId({
        availableModels: [createModel("model-a")],
        chat: createChat({ lastUsedModelId: "missing-model" }),
        currentSelectedModelId: "model-a",
      }),
    ).toBe("model-a");

    expect(
      resolvePreferredChatModelId({
        availableModels: [createModel("model-a")],
        chat: createChat(),
        currentSelectedModelId: "model-a",
      }),
    ).toBe("model-a");
  });
});

describe("resolveChatCreationModelId", () => {
  test("prefers the active runtime model when creation is triggered by sending", () => {
    expect(
      resolveChatCreationModelId({
        activeRuntimeModelId: "active-model",
        preferActiveRuntime: true,
        selectedModelId: "selected-model",
      }),
    ).toBe("active-model");
  });

  test("keeps the selected model hint for manual chat creation", () => {
    expect(
      resolveChatCreationModelId({
        activeRuntimeModelId: "active-model",
        preferActiveRuntime: false,
        selectedModelId: "selected-model",
      }),
    ).toBe("selected-model");
  });

  test("falls back to the selected model when no runtime model is active", () => {
    expect(
      resolveChatCreationModelId({
        activeRuntimeModelId: null,
        preferActiveRuntime: true,
        selectedModelId: "selected-model",
      }),
    ).toBe("selected-model");
  });
});
