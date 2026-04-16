import type { ChatSummary, ModelRecord } from "../lib/contracts";

export function resolveChatCreationModelId(options: {
  activeRuntimeModelId: string | null;
  preferActiveRuntime: boolean;
  selectedModelId: string | null;
}): string | null {
  const { activeRuntimeModelId, preferActiveRuntime, selectedModelId } = options;

  if (preferActiveRuntime) {
    return activeRuntimeModelId ?? selectedModelId;
  }

  return selectedModelId;
}

export function resolvePreferredChatModelId(options: {
  availableModels: ModelRecord[];
  chat: ChatSummary;
  currentSelectedModelId: string | null;
}): string | null {
  const { availableModels, chat, currentSelectedModelId } = options;

  if (chat.lastUsedModelId && availableModels.some((model) => model.id === chat.lastUsedModelId)) {
    return chat.lastUsedModelId;
  }

  return currentSelectedModelId;
}
