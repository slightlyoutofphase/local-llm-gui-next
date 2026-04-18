import { create } from "zustand";
import type {
  ChatMessageRecord,
  ChatSummary,
  DebugLogEntry,
  MediaAttachmentKind,
} from "../lib/contracts";
import {
  autoNameChat,
  appendChatMessage,
  branchChatMessage,
  clearDebugLog,
  createChat,
  deleteAllChats,
  deleteChat,
  editChatMessage,
  getChat,
  getChats,
  regenerateChatMessage,
  stopGeneration,
  streamChatCompletion,
  streamToolConfirmationResolution,
  subscribeToJsonSse,
  uploadMediaAttachments,
  deletePendingMediaAttachments,
} from "../lib/api";
import {
  getAttachmentCapabilities,
  isAttachmentKindSupported,
} from "../lib/attachmentCapabilities";
import {
  buildAggregateUploadLimitError,
  sumUploadBytes,
  wouldExceedAggregateUploadLimit,
} from "../lib/attachmentUploadLimits";
import {
  resolveAttachmentKindFromFileLike,
  resolveAttachmentMimeTypeFromFileLike,
} from "../lib/attachmentTypePolicy";
import { resolveChatCreationModelId, resolvePreferredChatModelId } from "../lib/chatSelection";
import { appendDebugLogEntry } from "../lib/debugLogEntries";
import { updateBoundedTranscriptCache } from "../lib/chatTranscriptCache";
import {
  canStartGeneration,
  clearAbortControllerIfCurrent,
  stopGenerationSafely,
} from "@/lib/generationControl";
import { validateStructuredOutputResult } from "../lib/structuredOutput";
import {
  invalidateUiCacheForRevisionBestEffort,
  readUiCacheBestEffort,
  type UiCacheState,
  writeUiCacheBestEffort,
} from "../lib/ui-cache";
import {
  DEFAULT_CHAT_STORE_MODEL_CONTEXT,
  type ChatStoreModelContext,
} from "../store/chatModelBridge";

let disconnectDebugStream: (() => void) | null = null;
let requestModelSelection: ((modelId: string | null) => void) | null = null;
let shouldReconnectDebugStream = false;
const CHAT_HISTORY_PAGE_SIZE = 50;

/**
 * Module-scoped synchronous lock for generation entry points.
 *
 * The Zustand `sending` flag is set via `set()` which flushes asynchronously.
 * Two concurrent `sendMessage()` calls can both pass the `canStartGeneration`
 * guard before either `set({ sending: true })` takes effect. This synchronous
 * flag is acquired _before_ any state reads, closing the TOCTOU window.
 */
let generationLockAcquired = false;

/**
 * Attempts to acquire the module-scoped generation lock.
 * Returns `true` if the lock was acquired, `false` if it was already held.
 */
function tryAcquireGenerationLock(): boolean {
  if (generationLockAcquired) {
    return false;
  }

  generationLockAcquired = true;
  return true;
}

/** Releases the module-scoped generation lock. */
function releaseGenerationLock(): void {
  generationLockAcquired = false;
}

export function setChatStoreModelSelectionHandler(
  handler: ((modelId: string | null) => void) | null,
): void {
  requestModelSelection = handler;
}

interface ChatPaginationState {
  hasOlderMessages: boolean;
  nextBeforeSequence: number | null;
}

/**
 * Represents the frontend chat and debug-log store state.
 */
export interface ChatStoreState {
  /** The persisted chat summaries. */
  chats: ChatSummary[];
  /** The currently active chat identifier. */
  activeChatId: string | null;
  /** Cached chat messages keyed by chat identifier. */
  messagesByChatId: Record<string, ChatMessageRecord[]>;
  /** Pagination state for each cached chat transcript. */
  chatPaginationById: Record<string, ChatPaginationState>;
  /** The current composer text value. */
  composerValue: string;
  /** Per-chat unsent draft text, keyed by chat ID. */
  draftsByChatId: Record<string, string>;
  /** Files queued locally for the next user message. */
  pendingAttachments: PendingAttachment[];
  /** Pending attachment drafts keyed by persisted chat ID. */
  pendingAttachmentDraftsByChatId: Record<string, PendingAttachment[]>;
  /** Indicates whether the store completed initial hydration. */
  hydrated: boolean;
  /** Indicates whether a chat is currently being loaded. */
  loadingChat: boolean;
  /** Indicates whether an older transcript page is currently being loaded. */
  loadingOlderMessages: boolean;
  /** Indicates whether a new chat is currently being created. */
  creatingChat: boolean;
  /** Indicates whether a generation request is currently active. */
  sending: boolean;
  /** Internal abort controller for the currently active generation, if any. */
  activeGenerationAbortController: AbortController | null;
  /** Identifies the chat currently owning the active generation request. */
  activeGenerationChatId: string | null;
  /** The latest user-facing store error, if any. */
  error: string | null;
  /** The latest backend revision reflected in the chat store. */
  knownDbRevision: number;
  /** Visible warning when live debug updates have degraded after reconnect exhaustion. */
  debugStreamWarning: string | null;
  /** The retained debug-log entries for the debug panel. */
  debugEntries: DebugLogEntry[];
  /** Controls whether the debug panel is open. */
  debugPanelOpen: boolean;
  /** The synchronized model-store context consumed by chat flows. */
  modelContext: ChatStoreModelContext;
  /** Identifies the chat currently undergoing background auto-naming. */
  namingChatId: string | null;
  /** Hydrates chat summaries, the active chat, and debug panel UI state. */
  hydrate: () => Promise<void>;
  /** Creates a new chat and selects it. */
  createChat: (options?: { preferActiveRuntime?: boolean }) => Promise<string | null>;
  /** Selects a chat and loads it if necessary. */
  selectChat: (chatId: string) => Promise<void>;
  /** Loads the next older page for the active chat transcript. */
  loadOlderMessages: () => Promise<void>;
  /** Deletes a chat and its associated data. */
  deleteChat: (chatId: string) => Promise<void>;
  /** Deletes all chats and their associated data. */
  deleteAllChats: () => Promise<void>;
  /** Updates the composer text. */
  setComposerValue: (value: string) => void;
  /** Sets the latest user-facing error. */
  setError: (error: string | null) => void;
  /** Adds pending attachments to the composer. */
  addPendingAttachments: (files: File[]) => void;
  /** Removes a queued attachment. */
  removePendingAttachment: (attachmentId: string) => void;
  /** Clears all queued attachments. */
  clearPendingAttachments: () => void;
  /** Sends the current composer text through the backend proxy. */
  sendMessage: () => Promise<void>;
  /** Edits a persisted user message and regenerates the remainder of the chat. */
  editMessage: (messageId: string, content: string) => Promise<void>;
  /** Regenerates a persisted assistant message and later transcript history. */
  regenerateMessage: (messageId: string) => Promise<void>;
  /** Branches the transcript through a selected message into a new chat. */
  branchMessage: (messageId: string) => Promise<void>;
  /** Approves or rejects a paused confirmation-required tool turn. */
  resolvePendingToolConfirmation: (assistantMessageId: string, approved: boolean) => Promise<void>;
  /** Stops the active generation request. */
  stopMessageGeneration: () => Promise<void>;
  /** Opens the debug SSE connection when it is not already active. */
  connectDebugStream: () => void;
  /** Closes the debug SSE connection. */
  disconnectDebugStream: () => void;
  /** Updates the debug panel open state and persists it in IndexedDB. */
  setDebugPanelOpen: (isOpen: boolean) => Promise<void>;
  /** Clears the retained frontend and backend debug buffers. */
  clearDebugEntries: () => Promise<void>;
  /** Applies the latest model-store snapshot through the provider-owned bridge. */
  syncModelContext: (modelContext: ChatStoreModelContext) => void;
  /** Reconciles the local chat state against an externally updated UI-cache snapshot. */
  synchronizeFromUiCache: (uiCache: UiCacheState) => Promise<void>;
}

export function preserveDraftsWhenSwitchingChats(
  previousChatId: string | null,
  nextChatId: string,
  composerValue: string,
  pendingAttachments: PendingAttachment[],
  draftsByChatId: Record<string, string>,
  pendingAttachmentDraftsByChatId: Record<string, PendingAttachment[]>,
): {
  draftsByChatId: Record<string, string>;
  pendingAttachmentDraftsByChatId: Record<string, PendingAttachment[]>;
  restoredComposerValue: string;
  restoredPendingAttachments: PendingAttachment[];
} {
  const nextDraftsByChatId = { ...draftsByChatId };
  const nextPendingAttachmentDraftsByChatId = {
    ...pendingAttachmentDraftsByChatId,
  };

  if (previousChatId) {
    if (composerValue.trim().length > 0) {
      nextDraftsByChatId[previousChatId] = composerValue;
    } else {
      delete nextDraftsByChatId[previousChatId];
    }

    if (pendingAttachments.length > 0) {
      nextPendingAttachmentDraftsByChatId[previousChatId] = pendingAttachments;
    } else {
      delete nextPendingAttachmentDraftsByChatId[previousChatId];
    }
  }

  return {
    draftsByChatId: nextDraftsByChatId,
    pendingAttachmentDraftsByChatId: nextPendingAttachmentDraftsByChatId,
    restoredComposerValue: nextDraftsByChatId[nextChatId] ?? "",
    restoredPendingAttachments: nextPendingAttachmentDraftsByChatId[nextChatId] ?? [],
  };
}

/**
 * Provides the frontend chat, message, and debug-log Zustand store.
 */
export const useChatStore = create<ChatStoreState>((set, get) => ({
  chats: [],
  activeChatId: null,
  messagesByChatId: {},
  chatPaginationById: {},
  composerValue: "",
  draftsByChatId: {},
  pendingAttachments: [],
  pendingAttachmentDraftsByChatId: {},
  hydrated: false,
  loadingChat: false,
  loadingOlderMessages: false,
  creatingChat: false,
  sending: false,
  activeGenerationAbortController: null,
  activeGenerationChatId: null,
  error: null,
  knownDbRevision: 0,
  debugStreamWarning: null,
  debugEntries: [],
  debugPanelOpen: false,
  modelContext: DEFAULT_CHAT_STORE_MODEL_CONTEXT,
  namingChatId: null,
  hydrate: async () => {
    try {
      const [uiCache, chatResponse] = await Promise.all([readUiCacheBestEffort(), getChats()]);
      const normalizedUiCache =
        uiCache.dbRevision === chatResponse.dbRevision
          ? uiCache
          : await invalidateUiCacheForRevisionBestEffort(uiCache, chatResponse.dbRevision);
      const selectedChatId =
        normalizedUiCache.lastChatId &&
        chatResponse.chats.some((chat) => chat.id === normalizedUiCache.lastChatId)
          ? normalizedUiCache.lastChatId
          : (chatResponse.chats[0]?.id ?? null);

      set({
        activeChatId: selectedChatId,
        chats: chatResponse.chats,
        debugPanelOpen: normalizedUiCache.debugPanelOpen,
        error: null,
        hydrated: true,
        knownDbRevision: chatResponse.dbRevision,
      });

      if (selectedChatId) {
        await get().selectChat(selectedChatId);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to hydrate chats.",
        hydrated: true,
      });
    }
  },
  createChat: async (options) => {
    set({ creatingChat: true, error: null });

    try {
      const lastUsedModelId = resolveChatCreationModelId({
        activeRuntimeModelId: get().modelContext.runtime?.activeModelId ?? null,
        preferActiveRuntime: options?.preferActiveRuntime === true,
        selectedModelId: get().modelContext.selectedModelId,
      });
      const response = await createChat(undefined, lastUsedModelId ?? undefined);

      set((state) => ({
        activeChatId: response.chat.id,
        chatPaginationById: {
          ...state.chatPaginationById,
          [response.chat.id]: {
            hasOlderMessages: false,
            nextBeforeSequence: null,
          },
        },
        chats: [response.chat, ...state.chats],
        creatingChat: false,
        knownDbRevision: response.dbRevision,
        messagesByChatId: updateCachedChatMessages({
          activeChatId: response.chat.id,
          activeGenerationChatId: state.activeGenerationChatId,
          chatId: response.chat.id,
          messages: [],
          messagesByChatId: state.messagesByChatId,
        }),
      }));
      await writeUiCacheBestEffort({
        dbRevision: response.dbRevision,
        lastChatId: response.chat.id,
      });

      return response.chat.id;
    } catch (error) {
      set({
        creatingChat: false,
        error: error instanceof Error ? error.message : "Failed to create a chat.",
      });

      return null;
    }
  },
  selectChat: async (chatId) => {
    const currentState = get();
    const previousChatId = currentState.activeChatId;
    const currentDraft = currentState.composerValue;

    const {
      draftsByChatId: nextDraftsByChatId,
      pendingAttachmentDraftsByChatId: nextPendingAttachmentDraftsByChatId,
      restoredComposerValue,
      restoredPendingAttachments,
    } = preserveDraftsWhenSwitchingChats(
      previousChatId,
      chatId,
      currentDraft,
      currentState.pendingAttachments,
      currentState.draftsByChatId,
      currentState.pendingAttachmentDraftsByChatId,
    );

    set({
      activeChatId: chatId,
      composerValue: restoredComposerValue,
      draftsByChatId: nextDraftsByChatId,
      error: null,
      loadingChat: true,
      loadingOlderMessages: false,
      pendingAttachmentDraftsByChatId: nextPendingAttachmentDraftsByChatId,
      pendingAttachments: restoredPendingAttachments,
    });
    await writeUiCacheBestEffort({ lastChatId: chatId });

    try {
      const chatResponse = await getChat(chatId, { limit: CHAT_HISTORY_PAGE_SIZE });
      const stateAfterResponse = get();

      if (!shouldApplyLoadedChatResponse(stateAfterResponse, chatId, chatResponse.dbRevision)) {
        if (stateAfterResponse.activeChatId === chatId) {
          set({ loadingChat: false });
        }

        return;
      }

      const modelContext = stateAfterResponse.modelContext;
      const preferredModelId = resolvePreferredChatModelId({
        availableModels: modelContext.availableModels,
        chat: chatResponse.chat,
        currentSelectedModelId: modelContext.selectedModelId,
      });

      set((state) => ({
        chatPaginationById: {
          ...state.chatPaginationById,
          [chatId]: toChatPaginationState(chatResponse),
        },
        chats: mergeUpdatedChat(state.chats, chatResponse.chat),
        knownDbRevision: chatResponse.dbRevision,
        loadingChat: false,
        messagesByChatId: updateCachedChatMessages({
          activeChatId: state.activeChatId,
          activeGenerationChatId: state.activeGenerationChatId,
          chatId,
          messages: chatResponse.messages,
          messagesByChatId: state.messagesByChatId,
        }),
      }));

      if (preferredModelId !== modelContext.selectedModelId) {
        requestModelSelection?.(preferredModelId);
      }
    } catch (error) {
      if (get().activeChatId === chatId) {
        set({
          error: error instanceof Error ? error.message : "Failed to load the selected chat.",
          loadingChat: false,
        });
      }
    }
  },
  loadOlderMessages: async () => {
    const chatId = get().activeChatId;

    if (!chatId || get().loadingOlderMessages || get().sending) {
      return;
    }

    try {
      await loadOlderMessagesPage({
        chatId,
        getState: get,
        setState: set,
      });
    } catch {
      // The helper already stored a user-facing error.
    }
  },
  deleteChat: async (chatId) => {
    try {
      if (get().activeGenerationChatId === chatId) {
        await get().stopMessageGeneration();
      }

      const response = await deleteChat(chatId);
      let deletedAttachments: PendingAttachment[] = [];

      set((state) => {
        const nextChats = state.chats.filter((chat) => chat.id !== chatId);
        const nextChatPaginationById = { ...state.chatPaginationById };
        const nextPendingAttachmentDraftsByChatId = { ...state.pendingAttachmentDraftsByChatId };

        deletedAttachments = nextPendingAttachmentDraftsByChatId[chatId] ?? [];
        delete nextChatPaginationById[chatId];
        delete nextPendingAttachmentDraftsByChatId[chatId];
        const nextActiveChatId =
          state.activeChatId === chatId ? (nextChats[0]?.id ?? null) : state.activeChatId;
        const nextMessagesByChatId = updateCachedChatMessages({
          activeChatId: nextActiveChatId,
          activeGenerationChatId:
            state.activeGenerationChatId === chatId ? null : state.activeGenerationChatId,
          chatId,
          messages: null,
          messagesByChatId: state.messagesByChatId,
        });

        return {
          activeChatId: nextActiveChatId,
          chatPaginationById: nextChatPaginationById,
          chats: nextChats,
          knownDbRevision: response.dbRevision,
          loadingOlderMessages:
            state.loadingOlderMessages && state.activeChatId === chatId
              ? false
              : state.loadingOlderMessages,
          messagesByChatId: nextMessagesByChatId,
          pendingAttachmentDraftsByChatId: nextPendingAttachmentDraftsByChatId,
          pendingAttachments:
            state.activeChatId === chatId
              ? nextActiveChatId
                ? (nextPendingAttachmentDraftsByChatId[nextActiveChatId] ?? [])
                : []
              : state.pendingAttachments,
        };
      });
      revokePendingAttachmentPreviews(deletedAttachments);

      const nextState = get();

      await writeUiCacheBestEffort({
        dbRevision: response.dbRevision,
        lastChatId: nextState.activeChatId,
      });

      if (nextState.activeChatId && !nextState.messagesByChatId[nextState.activeChatId]) {
        await get().selectChat(nextState.activeChatId);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete the chat.",
      });
    }
  },
  deleteAllChats: async () => {
    try {
      const response = await deleteAllChats();

      const currentState = get();

      revokePendingAttachmentPreviews(
        currentState.pendingAttachments,
        ...Object.values(currentState.pendingAttachmentDraftsByChatId),
      );

      set({
        activeChatId: null,
        activeGenerationChatId: null,
        chatPaginationById: {},
        chats: [],
        knownDbRevision: response.dbRevision,
        loadingOlderMessages: false,
        messagesByChatId: {},
        pendingAttachmentDraftsByChatId: {},
        pendingAttachments: [],
      });
      await writeUiCacheBestEffort({
        dbRevision: response.dbRevision,
        lastChatId: null,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete all chats.",
      });
    }
  },
  setComposerValue: (value) => {
    set({ composerValue: value });
  },
  setError: (error) => {
    set({ error });
  },
  addPendingAttachments: (files) => {
    const nextAttachments = files.flatMap((file) => {
      const attachmentKind = resolveAttachmentKindFromFileLike(file);

      if (!attachmentKind) {
        return [];
      }

      return [buildPendingAttachment(file, attachmentKind)];
    });

    if (nextAttachments.length === 0) {
      return;
    }

    if (
      wouldExceedAggregateUploadLimit(
        sumUploadBytes(get().pendingAttachments),
        sumUploadBytes(nextAttachments),
      )
    ) {
      revokePendingAttachmentPreviews(nextAttachments);
      set({ error: buildAggregateUploadLimitError() });
      return;
    }

    set((state) => ({
      error: null,
      pendingAttachmentDraftsByChatId: state.activeChatId
        ? {
            ...state.pendingAttachmentDraftsByChatId,
            [state.activeChatId]: [...state.pendingAttachments, ...nextAttachments],
          }
        : state.pendingAttachmentDraftsByChatId,
      pendingAttachments: [...state.pendingAttachments, ...nextAttachments],
    }));
  },
  removePendingAttachment: (attachmentId) => {
    const removedAttachments = get().pendingAttachments.filter(
      (candidate) => candidate.id === attachmentId,
    );

    if (removedAttachments.length === 0) {
      return;
    }

    set((state) => {
      return {
        pendingAttachmentDraftsByChatId: state.activeChatId
          ? {
              ...state.pendingAttachmentDraftsByChatId,
              [state.activeChatId]: state.pendingAttachments.filter(
                (candidate) => candidate.id !== attachmentId,
              ),
            }
          : state.pendingAttachmentDraftsByChatId,
        pendingAttachments: state.pendingAttachments.filter(
          (candidate) => candidate.id !== attachmentId,
        ),
      };
    });
    revokePendingAttachmentPreviews(removedAttachments);
  },
  clearPendingAttachments: () => {
    const clearedAttachments = get().pendingAttachments;

    if (clearedAttachments.length === 0) {
      return;
    }

    set((state) => ({
      pendingAttachmentDraftsByChatId: state.activeChatId
        ? {
            ...state.pendingAttachmentDraftsByChatId,
            [state.activeChatId]: [],
          }
        : state.pendingAttachmentDraftsByChatId,
      pendingAttachments: [],
    }));
    revokePendingAttachmentPreviews(clearedAttachments);
  },
  sendMessage: async () => {
    if (!tryAcquireGenerationLock()) {
      return;
    }

    try {
      const capturedComposerValue = get().composerValue;
      const composerValue = capturedComposerValue.trim();
      const pendingAttachments = [...get().pendingAttachments];

      if (
        !canStartGeneration({
          activeAbortController: get().activeGenerationAbortController,
          sending: get().sending,
        })
      ) {
        return;
      }

      if (!composerValue && pendingAttachments.length === 0) {
        return;
      }

      const modelContext = get().modelContext;
      const activeModel =
        modelContext.availableModels.find(
          (model) => model.id === modelContext.runtime?.activeModelId,
        ) ?? null;

      if (modelContext.runtime?.status !== "ready" || !activeModel) {
        set({ error: "Load a model before sending a message." });
        return;
      }

      const incompatiblePendingAttachments = pendingAttachments.filter(
        (attachment) =>
          !isAttachmentKindSupported(attachment.kind, activeModel, modelContext.runtime),
      );

      if (incompatiblePendingAttachments.length > 0) {
        const attachmentCapabilities = getAttachmentCapabilities(activeModel, modelContext.runtime);

        set({
          error: `Remove incompatible attachments before sending. ${attachmentCapabilities.hint}`,
        });
        return;
      }

      if (wouldExceedAggregateUploadLimit(0, sumUploadBytes(pendingAttachments))) {
        set({ error: buildAggregateUploadLimitError() });
        return;
      }

      let activeChatId = get().activeChatId;
      const messageId = crypto.randomUUID();

      set({ sending: true });

      try {
        if (!activeChatId) {
          activeChatId = await get().createChat({ preferActiveRuntime: true });

          if (!activeChatId) {
            set({ sending: false });
            return;
          }
        }

        const chatId = activeChatId;
        const sentAttachmentIds = new Set(pendingAttachments.map((attachment) => attachment.id));
        let uploadedAttachments: ChatMessageRecord["mediaAttachments"] = [];

        if (pendingAttachments.length > 0) {
          const uploadResponse = await uploadMediaAttachments(
            chatId,
            messageId,
            pendingAttachments.map((attachment) => attachment.file),
          );
          uploadedAttachments = uploadResponse.attachments;
        }

        const userMessageResponse = await appendChatMessage(
          chatId,
          "user",
          composerValue,
          uploadedAttachments,
          undefined,
          false,
          {},
          messageId,
        );
        console.log("[sendMessage] user message appended:", userMessageResponse.message.id);
        await writeUiCacheBestEffort({ dbRevision: userMessageResponse.dbRevision });
        const userMessage = userMessageResponse.message;
        const chatHistory = [...(get().messagesByChatId[chatId] ?? []), userMessage];

        set((state) => {
          const nextDrafts = { ...state.draftsByChatId };
          const nextPendingAttachmentDraftsByChatId = { ...state.pendingAttachmentDraftsByChatId };
          const currentDraftForChat = state.composerValue;

          if (currentDraftForChat === capturedComposerValue) {
            delete nextDrafts[chatId];
          } else if (currentDraftForChat.trim().length > 0) {
            nextDrafts[chatId] = currentDraftForChat;
          } else {
            delete nextDrafts[chatId];
          }

          delete nextPendingAttachmentDraftsByChatId[chatId];

          return {
            chats: updateChatTimestamp(state.chats, chatId),
            composerValue: state.composerValue === capturedComposerValue ? "" : state.composerValue,
            draftsByChatId: nextDrafts,
            error: null,
            knownDbRevision: Math.max(state.knownDbRevision, userMessageResponse.dbRevision),
            messagesByChatId: updateCachedChatMessages({
              activeChatId: state.activeChatId,
              activeGenerationChatId: state.activeGenerationChatId,
              chatId,
              messages: chatHistory,
              messagesByChatId: state.messagesByChatId,
            }),
            pendingAttachmentDraftsByChatId: nextPendingAttachmentDraftsByChatId,
            pendingAttachments: state.pendingAttachments.filter(
              (attachment) => !sentAttachmentIds.has(attachment.id),
            ),
          };
        });
        revokePendingAttachmentPreviews(pendingAttachments);

        await runGenerationFromHistory({
          chatId,
          chatMessages: chatHistory,
          getState: get,
          historyLoadedCompletely: true,
          setState: set,
        });
      } catch (error) {
        if (typeof activeChatId === "string" && pendingAttachments.length > 0) {
          try {
            await deletePendingMediaAttachments(
              activeChatId,
              messageId,
              pendingAttachments.map((attachment) => attachment.id),
            );
          } catch {
            // Best-effort cleanup; preserve the current error for user feedback.
          }
        }

        set({
          error:
            error instanceof Error
              ? error.message
              : "Failed to persist the user message or upload attachments.",
          sending: false,
        });
      }
    } finally {
      releaseGenerationLock();
    }
  },
  editMessage: async (messageId, content) => {
    if (!tryAcquireGenerationLock()) {
      return;
    }

    try {
      const chatId = get().activeChatId;
      const nextContent = content.trim();

      if (
        !chatId ||
        !nextContent ||
        !canStartGeneration({
          activeAbortController: get().activeGenerationAbortController,
          sending: get().sending,
        })
      ) {
        return;
      }

      const modelContext = get().modelContext;

      if (modelContext.runtime?.status !== "ready" || !modelContext.runtime.activeModelId) {
        set({ error: "Load a model before regenerating from an edited message." });
        return;
      }

      set({ sending: true });

      try {
        const response = await editChatMessage(chatId, messageId, nextContent);
        await writeUiCacheBestEffort({ dbRevision: response.dbRevision });

        await runGenerationFromHistory({
          chatId,
          chatMessages: response.messages,
          getState: get,
          historyLoadedCompletely: true,
          setState: set,
          updatedChat: response.chat,
        });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Failed to edit the selected message.",
          sending: false,
        });
      }
    } finally {
      releaseGenerationLock();
    }
  },
  regenerateMessage: async (messageId) => {
    if (!tryAcquireGenerationLock()) {
      return;
    }

    try {
      const chatId = get().activeChatId;

      if (
        !chatId ||
        !canStartGeneration({
          activeAbortController: get().activeGenerationAbortController,
          sending: get().sending,
        })
      ) {
        return;
      }

      const modelContext = get().modelContext;

      if (modelContext.runtime?.status !== "ready" || !modelContext.runtime.activeModelId) {
        set({ error: "Load a model before regenerating a response." });
        return;
      }

      set({ sending: true });

      try {
        const response = await regenerateChatMessage(chatId, messageId);
        await writeUiCacheBestEffort({ dbRevision: response.dbRevision });

        await runGenerationFromHistory({
          chatId,
          chatMessages: response.messages,
          getState: get,
          historyLoadedCompletely: true,
          setState: set,
          updatedChat: response.chat,
        });
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to regenerate the selected response.",
          sending: false,
        });
      }
    } finally {
      releaseGenerationLock();
    }
  },
  branchMessage: async (messageId) => {
    if (!tryAcquireGenerationLock()) {
      return;
    }

    try {
      const chatId = get().activeChatId;

      if (
        !chatId ||
        !canStartGeneration({
          activeAbortController: get().activeGenerationAbortController,
          sending: get().sending,
        })
      ) {
        return;
      }

      set({ sending: true });

      try {
        const response = await branchChatMessage(chatId, messageId);
        const modelContext = get().modelContext;
        const preferredModelId = resolvePreferredChatModelId({
          availableModels: modelContext.availableModels,
          chat: response.chat,
          currentSelectedModelId: modelContext.selectedModelId,
        });

        set((state) => ({
          activeChatId: response.chat.id,
          chatPaginationById: {
            ...state.chatPaginationById,
            [response.chat.id]: {
              hasOlderMessages: false,
              nextBeforeSequence: null,
            },
          },
          chats: mergeUpdatedChat(state.chats, response.chat),
          error: null,
          knownDbRevision: response.dbRevision,
          messagesByChatId: updateCachedChatMessages({
            activeChatId: response.chat.id,
            activeGenerationChatId: state.activeGenerationChatId,
            chatId: response.chat.id,
            messages: response.messages,
            messagesByChatId: state.messagesByChatId,
          }),
          sending: false,
        }));

        if (preferredModelId !== modelContext.selectedModelId) {
          requestModelSelection?.(preferredModelId);
        }

        await writeUiCacheBestEffort({
          dbRevision: response.dbRevision,
          lastChatId: response.chat.id,
        });
      } catch (error) {
        set({
          error:
            error instanceof Error ? error.message : "Failed to branch the selected transcript.",
          sending: false,
        });
      }
    } finally {
      releaseGenerationLock();
    }
  },
  resolvePendingToolConfirmation: async (assistantMessageId, approved) => {
    if (!tryAcquireGenerationLock()) {
      return;
    }

    try {
      const chatId = get().activeChatId;

      if (
        !chatId ||
        !canStartGeneration({
          activeAbortController: get().activeGenerationAbortController,
          sending: get().sending,
        })
      ) {
        return;
      }

      await refreshChatIfMessageMissing(chatId, assistantMessageId, get, set);

      const targetMessage = (get().messagesByChatId[chatId] ?? []).find(
        (message) => message.id === assistantMessageId,
      );
      const confirmation = targetMessage ? getToolConfirmationMetadata(targetMessage) : null;

      if (!targetMessage || !confirmation || confirmation.state !== "pending") {
        if (!targetMessage) {
          set({
            error: "The tool-confirmation message was removed before approval could be applied.",
            sending: false,
          });
        }

        return;
      }

      const previousMetadata = { ...targetMessage.metadata };

      set({ sending: true });

      updateStoredMessageMetadata(chatId, assistantMessageId, set, () => ({
        ...previousMetadata,
        toolConfirmation: {
          ...confirmation,
          state: approved ? "approved" : "rejected",
        },
      }));

      const succeeded = await runToolConfirmationResolution({
        approved,
        assistantMessageId,
        chatId,
        getState: get,
        setState: set,
      });

      const currentMessage = (get().messagesByChatId[chatId] ?? []).find(
        (message) => message.id === assistantMessageId,
      );

      if (!succeeded) {
        if (!currentMessage) {
          await refreshChatIfMessageMissing(chatId, assistantMessageId, get, set);
        } else {
          set((state) => ({
            messagesByChatId: updateCachedChatMessages({
              activeChatId: state.activeChatId,
              activeGenerationChatId: state.activeGenerationChatId,
              chatId,
              messages:
                state.messagesByChatId[chatId]?.map((message) =>
                  message.id === assistantMessageId
                    ? { ...message, metadata: previousMetadata }
                    : message,
                ) ?? [],
              messagesByChatId: state.messagesByChatId,
            }),
            sending: state.activeChatId === chatId ? state.sending : false,
          }));
        }

        return;
      }

      if (
        !currentMessage ||
        getToolConfirmationMetadata(currentMessage)?.state !== (approved ? "approved" : "rejected")
      ) {
        if (get().activeChatId === chatId) {
          await refreshChatIfMessageMissing(chatId, assistantMessageId, get, set);
        }
      }
    } finally {
      releaseGenerationLock();
    }
  },
  stopMessageGeneration: async () => {
    await stopGenerationSafely({
      abortController: get().activeGenerationAbortController,
      stopRemoteGeneration: stopGeneration,
    });

    if (get().sending) {
      set({ sending: false });
    }
  },
  connectDebugStream: () => {
    shouldReconnectDebugStream = true;
    set({ debugStreamWarning: null });
    establishDebugStreamSubscription(set);
  },
  disconnectDebugStream: () => {
    shouldReconnectDebugStream = false;

    disconnectDebugStream?.();
    disconnectDebugStream = null;
    set({ debugStreamWarning: null });
  },
  setDebugPanelOpen: async (isOpen) => {
    set({ debugPanelOpen: isOpen });
    await writeUiCacheBestEffort({ debugPanelOpen: isOpen });
  },
  clearDebugEntries: async () => {
    set({ debugEntries: [] });
    await clearDebugLog();
  },
  syncModelContext: (modelContext) => {
    set({ modelContext });
  },
  synchronizeFromUiCache: async (uiCache) => {
    try {
      await synchronizeChatStoreFromUiCache(uiCache, set, get);
    } catch {
      // Keep background sync best-effort to avoid foreground disruption.
    }
  },
}));

function establishDebugStreamSubscription(setState: typeof useChatStore.setState): void {
  if (!shouldReconnectDebugStream || disconnectDebugStream) {
    return;
  }

  disconnectDebugStream = subscribeToJsonSse<DebugLogEntry>(
    "/api/events/debug",
    "log",
    (entry) => {
      const maxEntries = useChatStore.getState().modelContext.debugMaxEntries;

      setState((state) => {
        return {
          debugEntries: appendDebugLogEntry(state.debugEntries, entry, maxEntries),
          debugStreamWarning: null,
        };
      });
    },
    {
      onError: (error) => {
        if (error.kind === "fatal") {
          useChatStore.setState({
            debugStreamWarning:
              error.error?.message ??
              "Live debug updates are unavailable because the debug event stream could not recover.",
          });
          disconnectDebugStream = null;
        }
      },
      onOpen: () => {
        useChatStore.setState({ debugStreamWarning: null });
      },
      reconnect: {
        initialDelayMs: 1_500,
        maxAttempts: 5,
        maxDelayMs: 10_000,
      },
    },
  );
}

/** Runs a full assistant generation against a persisted chat history. */
async function runGenerationFromHistory(options: {
  chatId: string;
  chatMessages: ChatMessageRecord[];
  getState: typeof useChatStore.getState;
  historyLoadedCompletely?: boolean;
  setState: typeof useChatStore.setState;
  updatedChat?: ChatSummary;
}): Promise<boolean> {
  const { chatId, chatMessages, getState, historyLoadedCompletely, setState, updatedChat } =
    options;

  return await runAssistantStream({
    chatId,
    chatMessages,
    getState,
    setState,
    streamRequest: (handlers, signal) =>
      streamChatCompletion({ chatId, stream: true }, handlers, signal),
    ...(historyLoadedCompletely !== undefined ? { historyLoadedCompletely } : {}),
    ...(updatedChat !== undefined ? { updatedChat } : {}),
  });
}

/** Resolves a pending tool-confirmation turn and resumes assistant streaming. */
async function runToolConfirmationResolution(options: {
  approved: boolean;
  assistantMessageId: string;
  chatId: string;
  getState: typeof useChatStore.getState;
  setState: typeof useChatStore.setState;
}): Promise<boolean> {
  const { approved, assistantMessageId, chatId, getState, setState } = options;

  return await runAssistantStream({
    chatId,
    chatMessages: getState().messagesByChatId[chatId] ?? [],
    getState,
    historyLoadedCompletely: true,
    setState,
    streamRequest: (handlers, signal) =>
      streamToolConfirmationResolution(chatId, assistantMessageId, approved, handlers, signal),
  });
}

/** Streams an assistant response, persists it, and manages abort lifecycle. */
async function runAssistantStream(options: {
  chatId: string;
  chatMessages: ChatMessageRecord[];
  getState: typeof useChatStore.getState;
  historyLoadedCompletely?: boolean;
  setState: typeof useChatStore.setState;
  streamRequest: (
    handlers: {
      onContentDelta: (delta: string) => void;
      onPayload: (payload: Record<string, unknown>) => void;
      onReasoningDelta: (delta: string) => void;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  updatedChat?: ChatSummary;
}): Promise<boolean> {
  const {
    chatId,
    chatMessages,
    getState,
    historyLoadedCompletely,
    setState,
    streamRequest,
    updatedChat,
  } = options;
  const streamingMessage = createStreamingAssistantMessage(chatId, chatMessages.length);
  const generationAbortController = new AbortController();

  setState((state) => ({
    activeGenerationAbortController: generationAbortController,
    activeGenerationChatId: chatId,
    chatPaginationById: historyLoadedCompletely
      ? {
          ...state.chatPaginationById,
          [chatId]: {
            hasOlderMessages: false,
            nextBeforeSequence: null,
          },
        }
      : state.chatPaginationById,
    chats: updatedChat
      ? mergeUpdatedChat(state.chats, updatedChat)
      : updateChatTimestamp(state.chats, chatId),
    error: null,
    messagesByChatId: updateCachedChatMessages({
      activeChatId: state.activeChatId,
      activeGenerationChatId: chatId,
      chatId,
      messages: [...chatMessages, streamingMessage],
      messagesByChatId: state.messagesByChatId,
    }),
    sending: true,
  }));

  let assistantContent = "";
  let reasoningContent = "";
  let streamingUpdateTimer: number | ReturnType<typeof setTimeout> | null = null;
  let streamingUpdateCanceled = false;
  const structuredOutputSettings = getActiveStructuredOutputSettings(getState().modelContext);

  const cancelStreamingUpdate = (): void => {
    streamingUpdateCanceled = true;

    if (streamingUpdateTimer !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(streamingUpdateTimer as number);
      } else {
        clearTimeout(streamingUpdateTimer as ReturnType<typeof setTimeout>);
      }
    }

    streamingUpdateTimer = null;
  };

  const flushStreamingUpdate = (): void => {
    streamingUpdateTimer = null;

    if (streamingUpdateCanceled) {
      return;
    }

    updateStreamingMessage(chatId, streamingMessage.id, setState, {
      content: assistantContent,
      metadata: {
        reasoningContent,
      },
    });
  };

  const scheduleStreamingUpdate = (): void => {
    if (streamingUpdateCanceled || streamingUpdateTimer !== null) {
      return;
    }

    streamingUpdateTimer =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(flushStreamingUpdate)
        : setTimeout(flushStreamingUpdate, 16);
  };

  try {
    await streamRequest(
      {
        onPayload: (payload) => {
          applyLocalGenerationEvent(chatId, streamingMessage.id, payload, setState);
        },
        onContentDelta: (delta) => {
          assistantContent += delta;
          scheduleStreamingUpdate();
        },
        onReasoningDelta: (delta) => {
          reasoningContent += delta;
          scheduleStreamingUpdate();
        },
      },
      generationAbortController.signal,
    );

    // Flush any pending coalesced update before finalizing.
    if (streamingUpdateTimer !== null) {
      flushStreamingUpdate();
    }

    if (assistantContent.length === 0 && reasoningContent.length === 0) {
      setState((state) => ({
        messagesByChatId: updateCachedChatMessages({
          activeChatId: state.activeChatId,
          activeGenerationChatId: state.activeGenerationChatId,
          chatId,
          messages: removeStreamingMessage(
            state.messagesByChatId[chatId] ?? [],
            streamingMessage.id,
          ),
          messagesByChatId: state.messagesByChatId,
        }),
        sending: false,
      }));

      return true;
    }

    const structuredOutputMetadata = validateStructuredOutputResult({
      content: assistantContent,
      mode: structuredOutputSettings.mode,
      schemaText: structuredOutputSettings.schemaText,
      truncated: false,
    });

    const runtimeTokPerSec = getState().modelContext.runtime?.tokensPerSecond ?? null;
    const assistantMetadata: Record<string, unknown> = {
      ...(structuredOutputMetadata ? { structuredOutput: structuredOutputMetadata } : {}),
      ...(typeof runtimeTokPerSec === "number" ? { tokensPerSecond: runtimeTokPerSec } : {}),
    };

    const assistantMessageResponse = await appendChatMessage(
      chatId,
      "assistant",
      assistantContent,
      [],
      reasoningContent || undefined,
      false,
      assistantMetadata,
    );
    await writeUiCacheBestEffort({ dbRevision: assistantMessageResponse.dbRevision });

    setState((state) => ({
      knownDbRevision: Math.max(state.knownDbRevision, assistantMessageResponse.dbRevision),
      messagesByChatId: updateCachedChatMessages({
        activeChatId: state.activeChatId,
        activeGenerationChatId: state.activeGenerationChatId,
        chatId,
        messages: replaceStreamingMessage(
          state.messagesByChatId[chatId] ?? [],
          streamingMessage.id,
          assistantMessageResponse.message,
        ),
        messagesByChatId: state.messagesByChatId,
      }),
      sending: false,
    }));

    const persistedMessages = replaceStreamingMessage(
      getState().messagesByChatId[chatId] ?? [],
      streamingMessage.id,
      assistantMessageResponse.message,
    );

    if (shouldTriggerAutoNaming(chatId, getState, persistedMessages)) {
      void runAutoNaming(chatId, setState);
    }

    return true;
  } catch (error) {
    const generationWasAborted = generationAbortController.signal.aborted === true;
    const hasPartialOutput = assistantContent.length > 0 || reasoningContent.length > 0;
    let persistedAssistantMessage: ChatMessageRecord | null = null;

    if (hasPartialOutput) {
      try {
        const structuredOutputMetadata =
          structuredOutputSettings.mode !== "off"
            ? validateStructuredOutputResult({
                content: assistantContent,
                mode: structuredOutputSettings.mode,
                schemaText: structuredOutputSettings.schemaText,
                truncated: true,
              })
            : null;

        const assistantMessageResponse = await appendChatMessage(
          chatId,
          "assistant",
          assistantContent,
          [],
          reasoningContent || undefined,
          true,
          {
            ...(structuredOutputMetadata ? { structuredOutput: structuredOutputMetadata } : {}),
            truncated: true,
          },
        );

        persistedAssistantMessage = assistantMessageResponse.message;

        setState((state) => ({
          knownDbRevision: Math.max(state.knownDbRevision, assistantMessageResponse.dbRevision),
          messagesByChatId: updateCachedChatMessages({
            activeChatId: state.activeChatId,
            activeGenerationChatId: state.activeGenerationChatId,
            chatId,
            messages: replaceStreamingMessage(
              state.messagesByChatId[chatId] ?? [],
              streamingMessage.id,
              assistantMessageResponse.message,
            ),
            messagesByChatId: state.messagesByChatId,
          }),
        }));
      } catch (persistError) {
        // Keep the streaming message visible so the user can copy the partial content manually.
        setState({
          error:
            persistError instanceof Error
              ? `Failed to save partial response: ${persistError.message}. Your generated content may be lost.`
              : "Failed to save partial response. Your generated content may be lost.",
        });
      }
    }

    setState((state) => ({
      error: generationWasAborted
        ? null
        : error instanceof Error
          ? error.message
          : "Failed to stream the assistant response.",
      messagesByChatId: updateCachedChatMessages({
        activeChatId: state.activeChatId,
        activeGenerationChatId: state.activeGenerationChatId,
        chatId,
        messages:
          hasPartialOutput && persistedAssistantMessage
            ? replaceStreamingMessage(
                state.messagesByChatId[chatId] ?? [],
                streamingMessage.id,
                persistedAssistantMessage,
              )
            : removeStreamingMessage(state.messagesByChatId[chatId] ?? [], streamingMessage.id),
        messagesByChatId: state.messagesByChatId,
      }),
      sending: false,
    }));

    return false;
  } finally {
    cancelStreamingUpdate();

    setState((state) => ({
      activeGenerationAbortController: clearAbortControllerIfCurrent(
        state.activeGenerationAbortController,
        generationAbortController,
      ),
      activeGenerationChatId:
        state.activeGenerationAbortController === generationAbortController
          ? null
          : state.activeGenerationChatId,
    }));
  }
}

/** Triggers background auto-naming for a newly created chat. */
async function runAutoNaming(
  chatId: string,
  setState: typeof useChatStore.setState,
): Promise<void> {
  setState({ namingChatId: chatId });

  try {
    const response = await autoNameChat(chatId);

    setState((state) => {
      const activeChat = state.chats.find((chat) => chat.id === chatId);
      const nextChats =
        response.generated && activeChat && activeChat.title === "New chat"
          ? mergeUpdatedChat(state.chats, response.chat)
          : state.chats;

      return {
        chats: nextChats,
        knownDbRevision: Math.max(state.knownDbRevision, response.dbRevision),
      };
    });
    await writeUiCacheBestEffort({ dbRevision: response.dbRevision });
  } catch {
    // Auto-naming is best-effort and should never interrupt foreground chat flow.
  } finally {
    setState((state) => ({
      namingChatId: state.namingChatId === chatId ? null : state.namingChatId,
    }));
  }
}

async function synchronizeChatStoreFromUiCache(
  uiCache: UiCacheState,
  setState: typeof useChatStore.setState,
  getState: typeof useChatStore.getState,
): Promise<void> {
  const currentState = getState();

  if (!currentState.hydrated) {
    return;
  }

  if (uiCache.dbRevision < currentState.knownDbRevision) {
    return;
  }

  if (uiCache.dbRevision === currentState.knownDbRevision) {
    const activeChatStillKnown =
      currentState.activeChatId === null ||
      currentState.chats.some((chat) => chat.id === currentState.activeChatId);

    if (!activeChatStillKnown) {
      if (uiCache.lastChatId && currentState.chats.some((chat) => chat.id === uiCache.lastChatId)) {
        await getState().selectChat(uiCache.lastChatId);
        return;
      }

      if (currentState.chats.length > 0) {
        const firstChat = currentState.chats[0];
        if (firstChat) {
          await getState().selectChat(firstChat.id);
        }
      }

      return;
    }

    if (
      uiCache.lastChatId &&
      uiCache.lastChatId !== currentState.activeChatId &&
      currentState.chats.some((chat) => chat.id === uiCache.lastChatId)
    ) {
      await getState().selectChat(uiCache.lastChatId);
    }

    if (uiCache.debugPanelOpen !== currentState.debugPanelOpen) {
      setState({ debugPanelOpen: uiCache.debugPanelOpen });
    }

    return;
  }

  const chatResponse = await getChats();
  const refreshedState = getState();
  const nextActiveChatId =
    refreshedState.activeChatId &&
    chatResponse.chats.some((chat) => chat.id === refreshedState.activeChatId)
      ? refreshedState.activeChatId
      : (chatResponse.chats[0]?.id ?? null);

  setState({
    chats: chatResponse.chats,
    error: null,
    knownDbRevision: chatResponse.dbRevision,
  });

  if (refreshedState.activeChatId && refreshedState.activeChatId !== nextActiveChatId) {
    if (nextActiveChatId) {
      await getState().selectChat(nextActiveChatId);
      return;
    }

    revokePendingAttachmentPreviews(
      refreshedState.pendingAttachments,
      ...Object.values(refreshedState.pendingAttachmentDraftsByChatId),
    );
    setState({
      activeChatId: null,
      chatPaginationById: {},
      composerValue: "",
      draftsByChatId: {},
      messagesByChatId: {},
      pendingAttachmentDraftsByChatId: {},
      pendingAttachments: [],
    });
    await writeUiCacheBestEffort({
      dbRevision: chatResponse.dbRevision,
      lastChatId: null,
    });
    return;
  }

  if (
    !nextActiveChatId ||
    refreshedState.loadingChat ||
    refreshedState.loadingOlderMessages ||
    refreshedState.sending ||
    !refreshedState.messagesByChatId[nextActiveChatId]
  ) {
    return;
  }

  const activeChatResponse = await getChat(nextActiveChatId, { limit: CHAT_HISTORY_PAGE_SIZE });
  const modelContext = getState().modelContext;
  const preferredModelId = resolvePreferredChatModelId({
    availableModels: modelContext.availableModels,
    chat: activeChatResponse.chat,
    currentSelectedModelId: modelContext.selectedModelId,
  });

  setState((state) => ({
    chatPaginationById: {
      ...state.chatPaginationById,
      [nextActiveChatId]: toChatPaginationState(activeChatResponse),
    },
    chats: mergeUpdatedChat(state.chats, activeChatResponse.chat),
    knownDbRevision: activeChatResponse.dbRevision,
    messagesByChatId: updateCachedChatMessages({
      activeChatId: state.activeChatId,
      activeGenerationChatId: state.activeGenerationChatId,
      chatId: nextActiveChatId,
      messages: activeChatResponse.messages,
      messagesByChatId: state.messagesByChatId,
    }),
  }));

  if (preferredModelId !== modelContext.selectedModelId) {
    requestModelSelection?.(preferredModelId);
  }
}

export function shouldApplyLoadedChatResponse(
  currentState: Pick<ChatStoreState, "activeChatId" | "knownDbRevision">,
  chatId: string,
  responseDbRevision: number,
): boolean {
  return currentState.activeChatId === chatId && responseDbRevision >= currentState.knownDbRevision;
}

/** Determines whether auto-naming should fire for the given chat. */
function shouldTriggerAutoNaming(
  chatId: string,
  getState: typeof useChatStore.getState,
  messages: ChatMessageRecord[],
): boolean {
  const activeChat = getState().chats.find((chat) => chat.id === chatId);

  if (!getState().modelContext.autoNamingEnabled || activeChat?.title !== "New chat") {
    return false;
  }

  let visibleUserCount = 0;
  let visibleAssistantCount = 0;

  for (const message of messages) {
    if (message.metadata["hiddenFromTranscript"] === true) {
      continue;
    }

    if (message.role === "user") {
      visibleUserCount += 1;
      continue;
    }

    if (message.role === "assistant") {
      visibleAssistantCount += 1;
    }
  }

  return visibleUserCount === 1 && visibleAssistantCount === 1;
}

/** Creates a transient streaming assistant message placeholder. */
function createStreamingAssistantMessage(chatId: string, sequence: number): ChatMessageRecord {
  return {
    id: `stream-${crypto.randomUUID()}`,
    chatId,
    sequence,
    role: "assistant",
    content: "",
    mediaAttachments: [],
    createdAt: new Date().toISOString(),
    metadata: {
      transient: true,
    },
    reasoningTruncated: false,
  };
}

/** Patches the transient streaming message in the store with partial content. */
function updateStreamingMessage(
  chatId: string,
  messageId: string,
  setState: typeof useChatStore.setState,
  update: Partial<ChatMessageRecord>,
): void {
  setState((state) => ({
    messagesByChatId: updateCachedChatMessages({
      activeChatId: state.activeChatId,
      activeGenerationChatId: state.activeGenerationChatId,
      chatId,
      messages:
        state.messagesByChatId[chatId]?.map((message) =>
          message.id === messageId
            ? {
                ...message,
                ...update,
                ...(update.metadata && message.metadata
                  ? {
                      metadata: {
                        ...message.metadata,
                        ...update.metadata,
                      },
                    }
                  : {}),
              }
            : message,
        ) ?? [],
      messagesByChatId: state.messagesByChatId,
    }),
  }));
}

/** Replaces the transient streaming message with its persisted counterpart. */
function replaceStreamingMessage(
  messages: ChatMessageRecord[],
  streamingMessageId: string,
  persistedMessage: ChatMessageRecord,
): ChatMessageRecord[] {
  return messages.map((message) =>
    message.id === streamingMessageId ? persistedMessage : message,
  );
}

/** Removes the transient streaming message from the message list. */
function removeStreamingMessage(
  messages: ChatMessageRecord[],
  streamingMessageId: string,
): ChatMessageRecord[] {
  return messages.filter((message) => message.id !== streamingMessageId);
}

/** Inserts a persisted message directly before the transient streaming message. */
function insertBeforeStreamingMessage(
  messages: ChatMessageRecord[],
  streamingMessageId: string,
  persistedMessage: ChatMessageRecord,
): ChatMessageRecord[] {
  const nextMessages: ChatMessageRecord[] = [];

  for (const message of messages) {
    if (message.id === persistedMessage.id) {
      continue;
    }

    if (message.id === streamingMessageId) {
      nextMessages.push(persistedMessage);
    }

    nextMessages.push(message);
  }

  if (!nextMessages.some((message) => message.id === persistedMessage.id)) {
    nextMessages.push(persistedMessage);
  }

  return nextMessages;
}

/** Merges an updated chat summary to the front of the list. */
function mergeUpdatedChat(chats: ChatSummary[], updatedChat: ChatSummary): ChatSummary[] {
  const remainingChats = chats.filter((chat) => chat.id !== updatedChat.id);

  return [updatedChat, ...remainingChats];
}

function toChatPaginationState(response: {
  hasOlderMessages?: boolean;
  nextBeforeSequence?: number | null;
}): ChatPaginationState {
  return {
    hasOlderMessages: response.hasOlderMessages === true,
    nextBeforeSequence:
      typeof response.nextBeforeSequence === "number" ? response.nextBeforeSequence : null,
  };
}

function updateCachedChatMessages(options: {
  activeChatId: string | null;
  activeGenerationChatId: string | null;
  chatId: string;
  messages: ChatMessageRecord[] | null;
  messagesByChatId: Record<string, ChatMessageRecord[]>;
}): Record<string, ChatMessageRecord[]> {
  const { activeChatId, activeGenerationChatId, chatId, messages, messagesByChatId } = options;

  return updateBoundedTranscriptCache({
    cache: messagesByChatId,
    chatId,
    messages,
    protectedChatIds: [activeChatId, activeGenerationChatId, messages !== null ? chatId : null],
  });
}

async function loadOlderMessagesPage(options: {
  chatId: string;
  getState: typeof useChatStore.getState;
  setState: typeof useChatStore.setState;
}): Promise<void> {
  const { chatId, getState, setState } = options;
  const currentState = getState();
  const paginationState = currentState.chatPaginationById[chatId];

  if (!paginationState?.hasOlderMessages || currentState.loadingOlderMessages) {
    return;
  }

  if (paginationState.nextBeforeSequence === null) {
    const errorMessage =
      "The selected chat has older messages available, but no pagination cursor was returned.";

    setState({ error: errorMessage, loadingOlderMessages: false });
    throw new Error(errorMessage);
  }

  setState({ error: null, loadingOlderMessages: true });

  try {
    const chatResponse = await getChat(chatId, {
      beforeSequence: paginationState.nextBeforeSequence,
      limit: CHAT_HISTORY_PAGE_SIZE,
    });

    setState((state) => ({
      chatPaginationById: {
        ...state.chatPaginationById,
        [chatId]: toChatPaginationState(chatResponse),
      },
      chats: mergeUpdatedChat(state.chats, chatResponse.chat),
      loadingOlderMessages: false,
      messagesByChatId: updateCachedChatMessages({
        activeChatId: state.activeChatId,
        activeGenerationChatId: state.activeGenerationChatId,
        chatId,
        messages: mergeLoadedChatMessages(
          chatResponse.messages,
          state.messagesByChatId[chatId] ?? [],
        ),
        messagesByChatId: state.messagesByChatId,
      }),
    }));
  } catch (error) {
    setState({
      error: error instanceof Error ? error.message : "Failed to load older chat messages.",
      loadingOlderMessages: false,
    });
    throw error;
  }
}

function mergeLoadedChatMessages(
  incomingMessages: ChatMessageRecord[],
  currentMessages: ChatMessageRecord[],
): ChatMessageRecord[] {
  const mergedMessagesById = new Map<string, ChatMessageRecord>();

  for (const message of [...incomingMessages, ...currentMessages]) {
    mergedMessagesById.set(message.id, message);
  }

  return [...mergedMessagesById.values()].sort((leftMessage, rightMessage) => {
    if (leftMessage.sequence !== rightMessage.sequence) {
      return leftMessage.sequence - rightMessage.sequence;
    }

    return leftMessage.createdAt.localeCompare(rightMessage.createdAt);
  });
}

/** Bumps a chat's timestamp to now without a backend round-trip. */
function updateChatTimestamp(chats: ChatSummary[], chatId: string): ChatSummary[] {
  const activeChat = chats.find((chat) => chat.id === chatId);

  if (!activeChat) {
    return chats;
  }

  return mergeUpdatedChat(chats, {
    ...activeChat,
    updatedAt: new Date().toISOString(),
  });
}

/** Metadata shape for a tool-confirmation turn extracted from message metadata. */
interface ToolConfirmationMetadata {
  readonly calls: Array<{
    readonly argumentsText: string;
    readonly callId: string;
    readonly category: string;
    readonly dangerous: boolean;
    readonly displayName?: string;
    readonly requiresConfirmation: boolean;
    readonly toolName: string;
  }>;
  readonly state: "approved" | "pending" | "rejected";
}

/** Extracts validated tool-confirmation metadata from a message. */
function getToolConfirmationMetadata(message: ChatMessageRecord): ToolConfirmationMetadata | null {
  const toolConfirmation = message.metadata["toolConfirmation"];

  if (
    !toolConfirmation ||
    typeof toolConfirmation !== "object" ||
    Array.isArray(toolConfirmation)
  ) {
    return null;
  }

  const calls = Array.isArray((toolConfirmation as { calls?: unknown }).calls)
    ? (toolConfirmation as { calls: unknown[] }).calls
        .filter(
          (call): call is Record<string, unknown> =>
            !!call && typeof call === "object" && !Array.isArray(call),
        )
        .map((call) => ({
          argumentsText: typeof call["argumentsText"] === "string" ? call["argumentsText"] : "{}",
          callId: typeof call["callId"] === "string" ? call["callId"] : "",
          category: typeof call["category"] === "string" ? call["category"] : "custom",
          dangerous: call["dangerous"] === true,
          ...(typeof call["displayName"] === "string" ? { displayName: call["displayName"] } : {}),
          requiresConfirmation: call["requiresConfirmation"] === true,
          toolName: typeof call["toolName"] === "string" ? call["toolName"] : "",
        }))
    : [];
  const stateValue = (toolConfirmation as { state?: unknown }).state;

  return {
    calls,
    state:
      stateValue === "approved" || stateValue === "rejected" || stateValue === "pending"
        ? stateValue
        : "pending",
  };
}

/** Atomically updates a stored message's metadata record. */
export async function refreshChatIfMessageMissing(
  chatId: string,
  assistantMessageId: string,
  getState: typeof useChatStore.getState,
  setState: typeof useChatStore.setState,
  fetchChatFn: typeof getChat = getChat,
): Promise<boolean> {
  const currentMessageExists = (getState().messagesByChatId[chatId] ?? []).some(
    (message) => message.id === assistantMessageId,
  );

  if (currentMessageExists) {
    return true;
  }

  try {
    const chatResponse = await fetchChatFn(chatId, { limit: CHAT_HISTORY_PAGE_SIZE });

    setState((state) => ({
      chats: mergeUpdatedChat(state.chats, chatResponse.chat),
      knownDbRevision: Math.max(state.knownDbRevision, chatResponse.dbRevision),
      chatPaginationById: {
        ...state.chatPaginationById,
        [chatId]: toChatPaginationState(chatResponse),
      },
      messagesByChatId: {
        ...state.messagesByChatId,
        [chatId]: chatResponse.messages,
      },
    }));

    return chatResponse.messages.some((message) => message.id === assistantMessageId);
  } catch {
    return false;
  }
}

function updateStoredMessageMetadata(
  chatId: string,
  messageId: string,
  setState: typeof useChatStore.setState,
  nextMetadata: (currentMetadata: Record<string, unknown>) => Record<string, unknown>,
): void {
  setState((state) => ({
    messagesByChatId: updateCachedChatMessages({
      activeChatId: state.activeChatId,
      activeGenerationChatId: state.activeGenerationChatId,
      chatId,
      messages:
        state.messagesByChatId[chatId]?.map((message) =>
          message.id === messageId
            ? {
                ...message,
                metadata: nextMetadata(message.metadata),
              }
            : message,
        ) ?? [],
      messagesByChatId: state.messagesByChatId,
    }),
  }));
}

/** Handles a local generation event payload emitted during streaming. */
function applyLocalGenerationEvent(
  chatId: string,
  streamingMessageId: string,
  payload: Record<string, unknown>,
  setState: typeof useChatStore.setState,
): void {
  const localEvent = payload["local_event"];

  if (localEvent === "message_persisted" && isChatMessageRecord(payload["message"])) {
    const persistedMessage = payload["message"];

    setState((state) => ({
      chats: updateChatTimestamp(state.chats, chatId),
      messagesByChatId: updateCachedChatMessages({
        activeChatId: state.activeChatId,
        activeGenerationChatId: state.activeGenerationChatId,
        chatId,
        messages: insertBeforeStreamingMessage(
          state.messagesByChatId[chatId] ?? [],
          streamingMessageId,
          persistedMessage,
        ),
        messagesByChatId: state.messagesByChatId,
      }),
    }));

    return;
  }

  if (localEvent === "tool_status") {
    const statusMessage = typeof payload["message"] === "string" ? payload["message"] : "";

    updateStreamingMessage(chatId, streamingMessageId, setState, {
      metadata: {
        toolStatus: statusMessage,
      },
    });
  }
}

/** Type-guard for a well-formed `ChatMessageRecord` object. */
function isChatMessageRecord(value: unknown): value is ChatMessageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ChatMessageRecord>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.chatId === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.sequence === "number" &&
    Array.isArray(candidate.mediaAttachments) &&
    !!candidate.metadata &&
    typeof candidate.metadata === "object"
  );
}

/** Reads the active structured-output mode and schema from the model store. */
function getActiveStructuredOutputSettings(modelContext: ChatStoreModelContext): {
  mode: "json_object" | "json_schema" | "off";
  schemaText: string | undefined;
} {
  return {
    mode: modelContext.structuredOutputMode,
    schemaText: modelContext.structuredOutputSchema,
  };
}

/** Represents a locally queued file attachment awaiting upload. */
export interface PendingAttachment {
  file: File;
  fileName: string;
  id: string;
  kind: MediaAttachmentKind;
  mimeType: string;
  previewUrl?: string;
  size: number;
}

function buildPendingAttachment(file: File, kind: MediaAttachmentKind): PendingAttachment {
  const previewUrl =
    kind !== "text" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : undefined;

  return {
    file,
    fileName: file.name,
    id: crypto.randomUUID(),
    kind,
    mimeType: resolveAttachmentMimeTypeFromFileLike(file, kind),
    ...(previewUrl ? { previewUrl } : {}),
    size: file.size,
  };
}

function revokePendingAttachmentPreviews(
  ...attachmentGroups: Array<PendingAttachment[] | undefined>
): void {
  if (typeof URL.revokeObjectURL !== "function") {
    return;
  }

  const previewUrls = new Set<string>();

  for (const attachmentGroup of attachmentGroups) {
    for (const attachment of attachmentGroup ?? []) {
      if (attachment.previewUrl) {
        previewUrls.add(attachment.previewUrl);
      }
    }
  }

  for (const previewUrl of previewUrls) {
    URL.revokeObjectURL(previewUrl);
  }
}
