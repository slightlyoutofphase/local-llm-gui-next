"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import type { ReactElement } from "react";
import type { ChatMessageRecord, ChatSummary } from "@/lib/contracts";
import {
  Bug,
  Download,
  FolderSearch,
  LoaderCircle,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { ChatInput } from "@/components/Chat/ChatInput";
import { ChatWindow } from "@/components/Chat/ChatWindow";
import { DebugLogWindow } from "@/components/Debug/DebugLogWindow";
import { GlobalSettings } from "@/components/Settings/GlobalSettings";
import { PresetEditorDialog } from "@/components/Settings/PresetEditorDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { downloadChatsExport, getChatsWithOptions } from "@/lib/api";
import { getAttachmentCapabilities } from "@/lib/attachmentCapabilities";
import {
  CHAT_SEARCH_DEBOUNCE_MS,
  hasMeaningfulChatSearchTerms,
  normalizeChatSearchQuery,
} from "@/lib/chatSearch";
import { resolveRuntimeContextLimit } from "@/lib/runtimeDisplay";
import { useChatStore } from "@/store/chatStore";
import { useModelStore } from "@/store/modelStore";
import { useShallow } from "zustand/react/shallow";

const EMPTY_CHAT_MESSAGES: ChatMessageRecord[] = [];
const EMPTY_CHAT_PAGINATION = {
  hasOlderMessages: false,
  nextBeforeSequence: null,
} satisfies { hasOlderMessages: boolean; nextBeforeSequence: number | null };

/**
 * Renders the primary Local LLM GUI application shell.
 *
 * @returns The interactive Local LLM GUI workbench.
 */
export function ChatApp(): ReactElement {
  const [chatSearch, setChatSearch] = useState("");
  const [debouncedChatSearch, setDebouncedChatSearch] = useState("");
  const [chatSearchPending, setChatSearchPending] = useState(false);
  const [chatSearchResults, setChatSearchResults] = useState<ChatSummary[] | null>(null);
  const [dismissedRuntimeError, setDismissedRuntimeError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [presetEditorOpen, setPresetEditorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deferredModelSearch = useDeferredValue(modelSearch);

  const chatState = useChatStore(
    useShallow((state) => ({
      activeChatId: state.activeChatId,
      addPendingAttachments: state.addPendingAttachments,
      chatPaginationById: state.chatPaginationById,
      chats: state.chats,
      clearPendingAttachments: state.clearPendingAttachments,
      clearDebugEntries: state.clearDebugEntries,
      composerValue: state.composerValue,
      createChat: state.createChat,
      deleteChat: state.deleteChat,
      deleteAllChats: state.deleteAllChats,
      branchMessage: state.branchMessage,
      debugEntries: state.debugEntries,
      debugPanelOpen: state.debugPanelOpen,
      debugStreamWarning: state.debugStreamWarning,
      editMessage: state.editMessage,
      error: state.error,
      hydrated: state.hydrated,
      loadingChat: state.loadingChat,
      loadingOlderMessages: state.loadingOlderMessages,
      loadOlderMessages: state.loadOlderMessages,
      messagesByChatId: state.messagesByChatId,
      namingChatId: state.namingChatId,
      pendingAttachments: state.pendingAttachments,
      regenerateMessage: state.regenerateMessage,
      removePendingAttachment: state.removePendingAttachment,
      resolvePendingToolConfirmation: state.resolvePendingToolConfirmation,
      selectChat: state.selectChat,
      sending: state.sending,
      setComposerValue: state.setComposerValue,
      setDebugPanelOpen: state.setDebugPanelOpen,
      setError: state.setError,
      sendMessage: state.sendMessage,
      stopMessageGeneration: state.stopMessageGeneration,
    })),
  );
  const modelState = useModelStore(
    useShallow((state) => ({
      config: state.config,
      error: state.error,
      hydrated: state.hydrated,
      loadModel: state.loadModel,
      loadPresetsByModelId: state.loadInferencePresetsByModelId,
      models: state.models,
      modelsLoading: state.modelsLoading,
      modelsWarning: state.modelsWarning,
      openModelsFolder: state.openModelsFolder,
      openToolsFolder: state.openToolsFolder,
      refreshModels: state.refreshModels,
      refreshTools: state.refreshTools,
      runtime: state.runtime,
      runtimeLoadFailure: state.runtimeLoadFailure,
      runtimeStreamWarning: state.runtimeStreamWarning,
      createLoadInferencePreset: state.createLoadInferencePreset,
      createSystemPromptPreset: state.createSystemPromptPreset,
      deleteLoadInferencePreset: state.deleteLoadInferencePreset,
      deleteSystemPromptPreset: state.deleteSystemPromptPreset,
      presetsSaving: state.presetsSaving,
      saveConfig: state.saveConfig,
      savingConfig: state.savingConfig,
      selectLoadPreset: state.selectLoadPreset,
      selectedModelId: state.selectedModelId,
      selectedLoadPresetIds: state.selectedLoadPresetIds,
      selectedSystemPromptPresetIds: state.selectedSystemPromptPresetIds,
      selectModel: state.selectModel,
      selectSystemPromptPreset: state.selectSystemPromptPreset,
      setDefaultLoadInferencePreset: state.setDefaultLoadInferencePreset,
      setDefaultSystemPromptPreset: state.setDefaultSystemPromptPreset,
      systemPresetsByModelId: state.systemPromptPresetsByModelId,
      tools: state.tools,
      toolsLoading: state.toolsLoading,
      unloadModel: state.unloadModel,
      updateLoadInferencePreset: state.updateLoadInferencePreset,
      updateSystemPromptPreset: state.updateSystemPromptPreset,
    })),
  );
  const activeChatId = chatState.activeChatId;
  const chatSummaries = chatState.chats;
  const chatPaginationById = chatState.chatPaginationById;
  const debugPanelOpen = chatState.debugPanelOpen;
  const messagesByChatId = chatState.messagesByChatId;
  const setChatError = chatState.setError;
  const setDebugPanelOpen = chatState.setDebugPanelOpen;
  const chatSearchQuery = normalizeChatSearchQuery(chatSearch);
  const debouncedChatSearchQuery = normalizeChatSearchQuery(debouncedChatSearch);
  const debouncedChatSearchHasTerms = hasMeaningfulChatSearchTerms(debouncedChatSearchQuery);

  const handleChatSearchChange = (nextSearch: string): void => {
    const normalizedQuery = normalizeChatSearchQuery(nextSearch);

    setChatSearch(nextSearch);

    if (normalizedQuery.length === 0) {
      setChatSearchPending(false);
      setChatSearchResults(null);
      return;
    }

    if (!hasMeaningfulChatSearchTerms(normalizedQuery)) {
      setChatSearchPending(false);
      setChatSearchResults([]);
      return;
    }

    setChatSearchPending(true);
    setChatSearchResults(null);
  };
  const applyChatSearchResponse = useEffectEvent(
    (query: string, nextChats: ChatSummary[], errorMessage: string | null): void => {
      if (query !== chatSearchQuery) {
        return;
      }

      startTransition(() => {
        setChatSearchResults(nextChats);
        setChatSearchPending(false);

        if (errorMessage) {
          setChatError(errorMessage);
        }
      });
    },
  );

  const activeChat = chatSummaries.find((chat) => chat.id === activeChatId) ?? null;
  const activeMessages = useMemo(() => {
    if (!activeChatId) {
      return EMPTY_CHAT_MESSAGES;
    }

    return messagesByChatId[activeChatId] ?? EMPTY_CHAT_MESSAGES;
  }, [activeChatId, messagesByChatId]);
  const activeChatPagination = activeChatId
    ? (chatPaginationById[activeChatId] ?? EMPTY_CHAT_PAGINATION)
    : EMPTY_CHAT_PAGINATION;
  const pendingToolConfirmation = useMemo(
    () => findPendingToolConfirmation(activeMessages),
    [activeMessages],
  );
  const selectedModel = useMemo(
    () => modelState.models.find((model) => model.id === modelState.selectedModelId) ?? null,
    [modelState.models, modelState.selectedModelId],
  );
  const activeRuntimeModel = useMemo(
    () => modelState.models.find((model) => model.id === modelState.runtime?.activeModelId) ?? null,
    [modelState.models, modelState.runtime?.activeModelId],
  );
  const attachmentModel = activeRuntimeModel ?? selectedModel;
  const selectedSystemPresets = useMemo(
    () => (selectedModel ? (modelState.systemPresetsByModelId[selectedModel.id] ?? []) : []),
    [selectedModel, modelState.systemPresetsByModelId],
  );
  const selectedLoadPresets = useMemo(
    () => (selectedModel ? (modelState.loadPresetsByModelId[selectedModel.id] ?? []) : []),
    [selectedModel, modelState.loadPresetsByModelId],
  );
  const selectedSystemPreset = useMemo(
    () =>
      selectedModel
        ? (selectedSystemPresets.find(
            (preset) => preset.id === modelState.selectedSystemPromptPresetIds[selectedModel.id],
          ) ??
          selectedSystemPresets[0] ??
          null)
        : null,
    [selectedModel, selectedSystemPresets, modelState.selectedSystemPromptPresetIds],
  );
  const selectedLoadPreset = useMemo(
    () =>
      selectedModel
        ? (selectedLoadPresets.find(
            (preset) => preset.id === modelState.selectedLoadPresetIds[selectedModel.id],
          ) ??
          selectedLoadPresets[0] ??
          null)
        : null,
    [selectedModel, selectedLoadPresets, modelState.selectedLoadPresetIds],
  );
  const filteredModels = useMemo(() => {
    const normalizedQuery = deferredModelSearch.trim().toLowerCase();

    if (!normalizedQuery) {
      return modelState.models;
    }

    return modelState.models.filter((model) => {
      const haystack = `${model.publisher} ${model.modelName} ${model.fileName}`.toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [deferredModelSearch, modelState.models]);
  const isHydrating = !chatState.hydrated || !modelState.hydrated;
  const activeSystemPrompt = selectedSystemPreset;
  const attachmentCapabilities = getAttachmentCapabilities(attachmentModel, modelState.runtime);
  const imageAttachmentsEnabled = attachmentCapabilities.imageEnabled;
  const audioAttachmentsEnabled = attachmentCapabilities.audioEnabled;
  const textAttachmentsEnabled = attachmentCapabilities.textEnabled;
  const attachmentHint = attachmentCapabilities.hint;
  const runtimeCrashMessage = modelState.runtime?.lastError ?? null;
  const runtimeLoadFailureMessage = modelState.runtimeLoadFailure;
  const runtimeDialogMessage = runtimeLoadFailureMessage ?? runtimeCrashMessage;
  const runtimeDialogIsLoadFailure = runtimeLoadFailureMessage !== null;
  const runtimeErrorVisible =
    typeof runtimeDialogMessage === "string" && runtimeDialogMessage !== dismissedRuntimeError;
  const runtimeStreamWarning = modelState.runtimeStreamWarning;
  const debugStreamWarning = chatState.debugStreamWarning;
  const runtimeIsLoading = modelState.runtime?.status === "loading";
  const runtimeLoadProgress =
    typeof modelState.runtime?.loadProgress === "number" ? modelState.runtime.loadProgress : 0;
  const runtimeModelLabel = activeRuntimeModel
    ? `${activeRuntimeModel.publisher} / ${activeRuntimeModel.modelName}`
    : selectedModel
      ? `${selectedModel.publisher} / ${selectedModel.modelName}`
      : "the selected model";
  const runtimeContextLimit = resolveRuntimeContextLimit(
    modelState.runtime,
    activeRuntimeModel,
    selectedLoadPreset,
    selectedModel,
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "D") {
        event.preventDefault();
        void setDebugPanelOpen(!debugPanelOpen);
      }
    };

    window.addEventListener("keydown", handler);

    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [debugPanelOpen, setDebugPanelOpen]);

  useEffect(() => {
    const timeoutHandle = setTimeout(() => {
      setDebouncedChatSearch(chatSearch);
    }, CHAT_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeoutHandle);
    };
  }, [chatSearch]);

  useEffect(() => {
    if (
      !debouncedChatSearchHasTerms ||
      debouncedChatSearchQuery.length === 0 ||
      debouncedChatSearchQuery !== chatSearchQuery
    ) {
      return;
    }

    const abortController = new AbortController();

    void (async () => {
      try {
        const response = await getChatsWithOptions(debouncedChatSearchQuery, {
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) {
          return;
        }

        applyChatSearchResponse(debouncedChatSearchQuery, response.chats, null);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        const errorMessage = error instanceof Error ? error.message : "Failed to search chats.";

        applyChatSearchResponse(debouncedChatSearchQuery, [], errorMessage);
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [chatSearchQuery, debouncedChatSearchHasTerms, debouncedChatSearchQuery]);

  const showingChatSearch = chatSearchQuery.length > 0;
  const displayedChats = showingChatSearch ? (chatSearchResults ?? []) : chatSummaries;

  return (
    <>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_oklch(0.99_0.015_95),_transparent_36%),radial-gradient(circle_at_bottom_right,_oklch(0.95_0.02_85),_transparent_42%),linear-gradient(180deg,_oklch(0.995_0.004_95),_oklch(0.972_0.008_95))] px-2 py-2 text-foreground dark:bg-[radial-gradient(circle_at_top_left,_oklch(0.28_0.025_250),_transparent_32%),radial-gradient(circle_at_bottom_right,_oklch(0.22_0.02_80),_transparent_38%),linear-gradient(180deg,_oklch(0.14_0.008_260),_oklch(0.115_0.01_260))] sm:px-3 sm:py-3 lg:px-4 lg:py-4">
        <div className="mx-auto flex min-h-[calc(100dvh-0.5rem)] w-full max-w-[2200px] flex-col gap-3">
          <header className="flex flex-wrap items-center justify-between gap-3 rounded-[1.75rem] border border-border/70 bg-card/88 px-4 py-4 shadow-sm backdrop-blur sm:px-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Local LLM GUI
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">
                Local-first chat orchestration for GGUF models.
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge className="rounded-full px-3 py-1 text-xs" variant="secondary">
                {modelState.runtime?.status ?? "idle"}
              </Badge>
              <Button
                onClick={() => {
                  void modelState.refreshModels();
                }}
                variant="outline">
                <RefreshCw className="size-4" />
                Refresh models
              </Button>
              <Button
                onClick={() => {
                  void chatState.setDebugPanelOpen(true);
                }}
                variant="outline">
                <Bug className="size-4" />
                Debug
              </Button>
              <Button
                onClick={() => {
                  setSettingsOpen(true);
                }}>
                <Settings2 className="size-4" />
                Settings
              </Button>
            </div>
          </header>

          {runtimeIsLoading ? (
            <div className="rounded-[1.5rem] border border-border/70 bg-card/88 px-4 py-4 shadow-sm backdrop-blur sm:px-5">
              <div className="flex flex-wrap items-center gap-3">
                <LoaderCircle className="size-4 animate-spin text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">Loading {runtimeModelLabel}</p>
                  <p className="text-sm text-muted-foreground">
                    Starting llama-server and warming the model weights into runtime memory.
                  </p>
                </div>
                <Badge className="rounded-full px-3 py-1 text-xs tabular-nums" variant="outline">
                  {runtimeLoadProgress.toFixed(0)}%
                </Badge>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${runtimeLoadProgress}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(18rem,22vw)_minmax(0,1fr)_minmax(20rem,24vw)] 2xl:grid-cols-[minmax(20rem,21vw)_minmax(0,1.12fr)_minmax(22rem,23vw)]">
            <Card className="flex min-h-0 flex-col rounded-[1.75rem] border-border/70 bg-card/88 p-4 shadow-sm backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Chats</p>
                  <p className="text-sm text-muted-foreground">
                    {showingChatSearch
                      ? "Searching titles and persisted transcript content."
                      : "Persisted locally in SQLite."}
                  </p>
                </div>
                <Button
                  className="rounded-full"
                  onClick={() => {
                    chatState.clearPendingAttachments();
                    startTransition(() => {
                      void chatState.createChat();
                    });
                  }}
                  size="sm">
                  New chat
                </Button>
              </div>

              <div className="relative mt-3">
                <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 pl-9 text-sm"
                  onChange={(event) => {
                    handleChatSearchChange(event.target.value);
                  }}
                  placeholder="Search chats…"
                  value={chatSearch}
                />
              </div>

              {chatState.chats.length > 0 ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    onClick={() => {
                      void exportChats("json");
                    }}
                    size="sm"
                    variant="outline">
                    <Download className="mr-1.5 size-3" />
                    JSON
                  </Button>
                  <Button
                    onClick={() => {
                      void exportChats("markdown");
                    }}
                    size="sm"
                    variant="outline">
                    <Download className="mr-1.5 size-3" />
                    MD
                  </Button>
                  <Button
                    className="ml-auto"
                    onClick={() => {
                      void chatState.deleteAllChats();
                    }}
                    size="sm"
                    variant="ghost">
                    <Trash2 className="mr-1.5 size-3" />
                    Clear all
                  </Button>
                </div>
              ) : null}

              <Separator className="my-4" />
              <ScrollArea className="min-h-0 flex-1 pr-2">
                <div className="flex flex-col gap-2">
                  {isHydrating || chatSearchPending ? (
                    Array.from({ length: 5 }).map((_, index) => (
                      <Skeleton className="h-16 rounded-2xl" key={`chat-skeleton-${index}`} />
                    ))
                  ) : chatState.chats.length === 0 ? (
                    <div className="rounded-[1.25rem] border border-dashed border-border/80 bg-background/70 p-4 text-sm leading-7 text-muted-foreground">
                      No chats yet. Create one, load a model, and start sending prompts.
                    </div>
                  ) : displayedChats.length === 0 && showingChatSearch ? (
                    <div className="rounded-[1.25rem] border border-dashed border-border/80 bg-background/70 p-4 text-sm leading-7 text-muted-foreground">
                      No chats matched that search.
                    </div>
                  ) : (
                    groupChatsByDate(displayedChats).map((group) => (
                      <div key={group.label}>
                        <p className="mb-2 mt-1 text-[0.65rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground/70">
                          {group.label}
                        </p>
                        {group.chats.map((chat) => {
                          const isActive = chat.id === chatState.activeChatId;

                          return (
                            <div
                              className={`group mb-2 flex items-center gap-2 rounded-[1.25rem] border px-4 py-3 transition-colors ${
                                isActive
                                  ? "border-primary/40 bg-primary/10"
                                  : "border-border/70 bg-background/70 hover:bg-background"
                              }`}
                              key={chat.id}>
                              <button
                                aria-label={`Open chat: ${chat.title}`}
                                className="min-w-0 flex-1 text-left"
                                onClick={() => {
                                  startTransition(() => {
                                    void chatState.selectChat(chat.id);
                                  });
                                }}
                                type="button">
                                <p className="truncate text-sm font-medium">{chat.title}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {new Date(chat.updatedAt).toLocaleString()}
                                </p>
                              </button>
                              <button
                                aria-label={`Delete chat: ${chat.title}`}
                                className="shrink-0 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void chatState.deleteChat(chat.id);
                                }}
                                type="button">
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </Card>

            <Card className="flex min-h-0 flex-col rounded-[1.75rem] border-border/70 bg-card/88 p-4 shadow-sm backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold tracking-[-0.03em]">
                    {activeChat?.title ?? "Chat"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {modelState.runtime?.contextTokens != null && runtimeContextLimit != null
                      ? `${modelState.runtime.contextTokens.toLocaleString()} / ${runtimeContextLimit.toLocaleString()} tokens`
                      : "Load a model to begin a conversation."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {modelState.runtime?.tokensPerSecond != null ? (
                    <Badge className="rounded-full px-3 py-1 text-xs" variant="outline">
                      {modelState.runtime.tokensPerSecond.toFixed(1)} tok/s
                    </Badge>
                  ) : null}
                  {chatState.loadingChat ? (
                    <Badge className="rounded-full px-3 py-1 text-xs" variant="outline">
                      <LoaderCircle className="mr-2 size-3 animate-spin" />
                      Loading chat
                    </Badge>
                  ) : null}
                  {chatState.namingChatId === activeChat?.id ? (
                    <Badge className="rounded-full px-3 py-1 text-xs" variant="outline">
                      <LoaderCircle className="mr-2 size-3 animate-spin" />
                      Naming chat
                    </Badge>
                  ) : null}
                </div>
              </div>

              {modelState.runtime?.status === "loading" ? (
                <div className="mt-4 rounded-[1.25rem] border border-border/70 bg-background/80 p-4">
                  <div className="flex items-center gap-3">
                    <LoaderCircle className="size-4 animate-spin text-primary" />
                    <p className="text-sm font-medium">Loading {runtimeModelLabel}...</p>
                    {typeof modelState.runtime.loadProgress === "number" ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {modelState.runtime.loadProgress.toFixed(0)}%
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{
                        width: `${typeof modelState.runtime.loadProgress === "number" ? modelState.runtime.loadProgress : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {activeSystemPrompt?.systemPrompt ? (
                <div className="mt-4 rounded-[1.25rem] border border-border/70 bg-background/80 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    System prompt
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-7">
                    {activeSystemPrompt.systemPrompt}
                  </p>
                </div>
              ) : null}

              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
                <ChatWindow
                  hasOlderMessages={activeChatPagination.hasOlderMessages}
                  isSending={chatState.sending}
                  loadingOlderMessages={chatState.loadingOlderMessages}
                  messages={activeMessages}
                  onBranchMessage={(messageId) => {
                    void chatState.branchMessage(messageId);
                  }}
                  onEditMessage={(messageId, content) => {
                    void chatState.editMessage(messageId, content);
                  }}
                  onLoadOlderMessages={() => {
                    void chatState.loadOlderMessages();
                  }}
                  onRegenerateMessage={(messageId) => {
                    void chatState.regenerateMessage(messageId);
                  }}
                />
                <ChatInput
                  attachmentHint={attachmentHint}
                  canAttachAudio={audioAttachmentsEnabled}
                  canAttachImages={imageAttachmentsEnabled}
                  canAttachText={textAttachmentsEnabled}
                  disabled={
                    modelState.runtime?.status !== "ready" || isHydrating || chatState.loadingChat
                  }
                  isSending={chatState.sending}
                  onAddFiles={chatState.addPendingAttachments}
                  onChange={chatState.setComposerValue}
                  onError={chatState.setError}
                  onRemoveAttachment={chatState.removePendingAttachment}
                  onSend={() => {
                    void chatState.sendMessage();
                  }}
                  onStop={() => {
                    void chatState.stopMessageGeneration();
                  }}
                  pendingAttachments={chatState.pendingAttachments}
                  value={chatState.composerValue}
                />
                {chatState.error || modelState.error ? (
                  <p className="text-sm text-destructive">{chatState.error ?? modelState.error}</p>
                ) : null}
                {runtimeStreamWarning || debugStreamWarning ? (
                  <div className="space-y-2 rounded-2xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    {runtimeStreamWarning ? <p>{runtimeStreamWarning}</p> : null}
                    {debugStreamWarning ? <p>{debugStreamWarning}</p> : null}
                  </div>
                ) : null}
              </div>
            </Card>

            <Card className="flex min-h-0 flex-col rounded-[1.75rem] border-border/70 bg-card/88 p-4 shadow-sm backdrop-blur">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">Models</p>
                    <p className="text-sm text-muted-foreground">Hierarchical GGUF scan results.</p>
                  </div>
                  <FolderSearch className="size-4 text-muted-foreground" />
                </div>
                <Input
                  onChange={(event) => {
                    setModelSearch(event.target.value);
                  }}
                  placeholder="Search models"
                  value={modelSearch}
                />
              </div>

              <Separator className="my-4" />

              <ScrollArea className="min-h-0 flex-1 pr-2">
                <div className="flex flex-col gap-3">
                  {isHydrating || modelState.modelsLoading ? (
                    Array.from({ length: 4 }).map((_, index) => (
                      <Skeleton
                        className="h-28 rounded-[1.25rem]"
                        key={`model-skeleton-${index}`}
                      />
                    ))
                  ) : modelState.modelsWarning ? (
                    <div className="rounded-[1.5rem] border border-destructive/40 bg-destructive/5 p-5 text-sm leading-7 text-destructive">
                      <p className="text-base font-semibold text-foreground">Model scan failed</p>
                      <p className="mt-2 text-muted-foreground">{modelState.modelsWarning}</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          onClick={() => {
                            void modelState.openModelsFolder();
                          }}
                          type="button"
                          variant="outline">
                          Open models folder
                        </Button>
                        <Button
                          onClick={() => {
                            void modelState.refreshModels();
                          }}
                          type="button">
                          Refresh scan
                        </Button>
                      </div>
                    </div>
                  ) : modelState.models.length === 0 ? (
                    <div className="rounded-[1.5rem] border border-dashed border-border/80 bg-background/70 p-5 text-sm leading-7 text-muted-foreground">
                      <p className="text-base font-semibold text-foreground">
                        No GGUF models found
                      </p>
                      <p className="mt-2">
                        Put GGUF model files under the configured models directory using the
                        publisher / model / file hierarchy, then refresh the scan.
                      </p>
                      <p className="mt-2">
                        Compatible GGUF files are commonly distributed through Hugging Face and
                        other local-inference model hubs.
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          onClick={() => {
                            void modelState.openModelsFolder();
                          }}
                          type="button"
                          variant="outline">
                          Open models folder
                        </Button>
                        <Button
                          onClick={() => {
                            void modelState.refreshModels();
                          }}
                          type="button">
                          Refresh scan
                        </Button>
                      </div>
                    </div>
                  ) : filteredModels.length === 0 ? (
                    <div className="rounded-[1.25rem] border border-dashed border-border/80 bg-background/70 p-4 text-sm leading-7 text-muted-foreground">
                      No models matched the current search.
                    </div>
                  ) : (
                    filteredModels.map((model) => {
                      const isSelected = model.id === modelState.selectedModelId;
                      const isActive = model.id === modelState.runtime?.activeModelId;

                      return (
                        <button
                          className={`w-full rounded-[1.25rem] border px-4 py-4 text-left transition-colors ${
                            isSelected
                              ? "border-primary/40 bg-primary/10"
                              : "border-border/70 bg-background/70 hover:bg-background"
                          }`}
                          key={model.id}
                          onClick={() => {
                            startTransition(() => {
                              void modelState.selectModel(model.id);
                            });
                          }}
                          type="button">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <p className="text-sm font-semibold">{model.modelName}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {model.publisher}
                              </p>
                            </div>
                            {isActive ? <Badge>Active</Badge> : null}
                          </div>
                          <p className="mt-3 text-sm text-muted-foreground">{model.fileName}</p>
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <Badge variant="outline">{model.architecture ?? "Unknown arch"}</Badge>
                            <Badge variant="outline">{formatBytes(model.fileSizeBytes)}</Badge>
                            <Badge variant="outline">
                              {(model.contextLength ?? 0).toLocaleString()} ctx
                            </Badge>
                            {model.supportsAudio ? <Badge variant="outline">Audio</Badge> : null}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </ScrollArea>

              <Separator className="my-4" />

              <div className="space-y-3 rounded-[1.25rem] border border-border/70 bg-background/80 p-4">
                <p className="text-sm font-semibold">Selection</p>
                <p className="text-sm text-muted-foreground">
                  {selectedModel
                    ? `${selectedModel.publisher} / ${selectedModel.modelName}`
                    : "No model selected."}
                </p>
                {selectedModel ? (
                  <div className="grid gap-3">
                    <label className="grid gap-2 text-sm">
                      <span className="font-medium">System prompt preset</span>
                      <select
                        className="h-10 rounded-xl border border-border/80 bg-background px-3 text-sm"
                        onChange={(event) => {
                          modelState.selectSystemPromptPreset(selectedModel.id, event.target.value);
                        }}
                        value={selectedSystemPreset?.id ?? ""}>
                        {selectedSystemPresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                            {preset.isDefault ? " (default)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-2 text-sm">
                      <span className="font-medium">Load preset</span>
                      <select
                        className="h-10 rounded-xl border border-border/80 bg-background px-3 text-sm"
                        onChange={(event) => {
                          modelState.selectLoadPreset(selectedModel.id, event.target.value);
                        }}
                        value={selectedLoadPreset?.id ?? ""}>
                        {selectedLoadPresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                            {preset.isDefault ? " (default)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                {runtimeIsLoading ? (
                  <div className="rounded-[1rem] border border-border/70 bg-card/70 p-3">
                    <div className="flex items-center gap-2">
                      <LoaderCircle className="size-3.5 animate-spin text-primary" />
                      <p className="text-sm font-medium">Model load in progress</p>
                      <span
                        className="ml-auto text-xs tabular-nums text-muted-foreground"
                        data-testid="runtime-load-progress-label">
                        {runtimeLoadProgress.toFixed(0)}%
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        data-testid="runtime-load-progress-bar"
                        style={{ width: `${runtimeLoadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!selectedModel}
                    onClick={() => {
                      setPresetEditorOpen(true);
                    }}
                    type="button"
                    variant="outline">
                    Edit presets
                  </Button>
                  <Button
                    disabled={!selectedModel || runtimeIsLoading}
                    onClick={() => {
                      if (
                        selectedModel &&
                        modelState.runtime?.status === "ready" &&
                        modelState.runtime.activeModelId !== selectedModel.id
                      ) {
                        setModelSwitchPending(true);
                      } else if (selectedModel) {
                        void modelState.loadModel(selectedModel.id);
                      }
                    }}>
                    {runtimeIsLoading ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        Loading model
                      </>
                    ) : (
                      "Load model"
                    )}
                  </Button>
                  <Button
                    disabled={modelState.runtime?.status === "idle"}
                    onClick={() => {
                      void modelState.unloadModel();
                    }}
                    variant="outline">
                    Unload model
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>

      <GlobalSettings
        config={modelState.config}
        error={modelState.error}
        onOpenToolsFolder={modelState.openToolsFolder}
        onOpenChange={setSettingsOpen}
        onRefreshTools={modelState.refreshTools}
        onSave={modelState.saveConfig}
        open={settingsOpen}
        saving={modelState.savingConfig}
        tools={modelState.tools}
        toolsLoading={modelState.toolsLoading}
      />

      <PresetEditorDialog
        loadPresets={selectedLoadPresets}
        model={selectedModel}
        onCreateLoadPreset={(input) =>
          selectedModel
            ? modelState.createLoadInferencePreset(selectedModel.id, input)
            : Promise.resolve(null)
        }
        onCreateSystemPreset={(input) =>
          selectedModel
            ? modelState.createSystemPromptPreset(selectedModel.id, input)
            : Promise.resolve(null)
        }
        onDeleteLoadPreset={(presetId) =>
          selectedModel
            ? modelState.deleteLoadInferencePreset(selectedModel.id, presetId)
            : Promise.resolve()
        }
        onDeleteSystemPreset={(presetId) =>
          selectedModel
            ? modelState.deleteSystemPromptPreset(selectedModel.id, presetId)
            : Promise.resolve()
        }
        onOpenChange={setPresetEditorOpen}
        onSelectLoadPreset={(presetId) => {
          if (selectedModel) {
            modelState.selectLoadPreset(selectedModel.id, presetId);
          }
        }}
        onSelectSystemPreset={(presetId) => {
          if (selectedModel) {
            modelState.selectSystemPromptPreset(selectedModel.id, presetId);
          }
        }}
        onSetDefaultLoadPreset={(presetId) =>
          selectedModel
            ? modelState.setDefaultLoadInferencePreset(selectedModel.id, presetId)
            : Promise.resolve()
        }
        onSetDefaultSystemPreset={(presetId) =>
          selectedModel
            ? modelState.setDefaultSystemPromptPreset(selectedModel.id, presetId)
            : Promise.resolve()
        }
        onUpdateLoadPreset={(presetId, input) =>
          modelState.updateLoadInferencePreset(presetId, input)
        }
        onUpdateSystemPreset={(presetId, input) =>
          modelState.updateSystemPromptPreset(presetId, input)
        }
        open={presetEditorOpen}
        presetsSaving={modelState.presetsSaving}
        selectedLoadPresetId={selectedLoadPreset?.id}
        selectedSystemPresetId={selectedSystemPreset?.id}
        systemPresets={selectedSystemPresets}
        tools={modelState.tools}
      />

      <Dialog
        onOpenChange={() => {
          // Tool confirmation is action-gated and should remain open until the user approves or denies it.
        }}
        open={pendingToolConfirmation !== null}>
        <DialogContent className="max-w-2xl" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Confirm Tool Execution</DialogTitle>
            <DialogDescription>
              The model requested one or more side-effecting tools. Review the request before the
              backend proceeds.
            </DialogDescription>
          </DialogHeader>

          {pendingToolConfirmation ? (
            <div className="space-y-3">
              {pendingToolConfirmation.calls.map((toolCall) => (
                <div
                  className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3"
                  key={toolCall.callId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {toolCall.displayName ?? toolCall.toolName}
                    </p>
                    <Badge className="rounded-full px-2 py-0.5 text-[11px]" variant="outline">
                      {toolCall.category}
                    </Badge>
                    {toolCall.dangerous ? (
                      <Badge className="rounded-full px-2 py-0.5 text-[11px]" variant="secondary">
                        side effects
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Tool name: {toolCall.toolName}
                  </p>
                  <pre className="mt-3 overflow-x-auto rounded-xl border border-border/70 bg-card/80 p-3 text-xs leading-6 text-muted-foreground">
                    {toolCall.argumentsText}
                  </pre>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              disabled={chatState.sending || !pendingToolConfirmation}
              onClick={() => {
                if (pendingToolConfirmation) {
                  void chatState.resolvePendingToolConfirmation(
                    pendingToolConfirmation.assistantMessageId,
                    false,
                  );
                }
              }}
              type="button"
              variant="outline">
              Deny
            </Button>
            <Button
              disabled={chatState.sending || !pendingToolConfirmation}
              onClick={() => {
                if (pendingToolConfirmation) {
                  void chatState.resolvePendingToolConfirmation(
                    pendingToolConfirmation.assistantMessageId,
                    true,
                  );
                }
              }}
              type="button">
              {chatState.sending ? "Submitting..." : "Run tool"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open && runtimeDialogMessage) {
            setDismissedRuntimeError(runtimeDialogMessage);
          }
        }}
        open={runtimeErrorVisible}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {runtimeDialogIsLoadFailure
                ? "Model load failed"
                : "Model runtime stopped unexpectedly"}
            </DialogTitle>
            <DialogDescription>
              {runtimeDialogIsLoadFailure
                ? "llama-server could not finish loading the selected model. Review the message below, then retry the load or adjust the preset before trying again."
                : "llama-server exited or crashed while the app expected it to stay alive. Review the message below, then try a safer load preset before loading again."}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm leading-7 text-muted-foreground">
            {runtimeDialogMessage}
          </div>

          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {runtimeDialogIsLoadFailure
              ? `Suggested next step: retry the load, or reduce GPU layers from ${String(selectedLoadPreset?.settings.gpuLayers ?? 0)} or context from ${selectedLoadPreset?.settings.contextLength.toLocaleString() ?? "the current value"} before trying again.`
              : `Suggested next step: reduce GPU layers from ${String(selectedLoadPreset?.settings.gpuLayers ?? 0)} or reduce context from ${selectedLoadPreset?.settings.contextLength.toLocaleString() ?? "the current value"}, then reload the model.`}
          </div>

          <div className="flex justify-end gap-2">
            {selectedModel ? (
              <Button
                onClick={() => {
                  if (runtimeDialogMessage) {
                    setDismissedRuntimeError(runtimeDialogMessage);
                  }
                  setPresetEditorOpen(true);
                }}
                type="button"
                variant="outline">
                Open preset editor
              </Button>
            ) : null}
            {runtimeDialogIsLoadFailure && selectedModel ? (
              <Button
                onClick={() => {
                  if (runtimeDialogMessage) {
                    setDismissedRuntimeError(runtimeDialogMessage);
                  }
                  void modelState.loadModel(selectedModel.id);
                }}
                type="button"
                variant="outline">
                Retry load
              </Button>
            ) : null}
            <Button
              onClick={() => {
                if (runtimeDialogMessage) {
                  setDismissedRuntimeError(runtimeDialogMessage);
                }
              }}
              type="button">
              Dismiss
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setModelSwitchPending} open={modelSwitchPending}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch model?</DialogTitle>
            <DialogDescription>
              Loading a different model will unload the currently active model and reload
              llama-server. Any in-progress generation will be lost.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setModelSwitchPending(false);
              }}
              type="button"
              variant="outline">
              Cancel
            </Button>
            <Button
              onClick={() => {
                setModelSwitchPending(false);
                if (selectedModel) {
                  void modelState.loadModel(selectedModel.id);
                }
              }}
              type="button">
              Switch model
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <DebugLogWindow
        config={modelState.config}
        entries={chatState.debugEntries}
        onClear={() => {
          void chatState.clearDebugEntries();
        }}
        onOpenChange={(isOpen) => {
          void chatState.setDebugPanelOpen(isOpen);
        }}
        open={chatState.debugPanelOpen}
      />
    </>
  );
}

/** Formats a raw byte count into a human-readable binary-unit string. */
function formatBytes(byteCount: number): string {
  if (byteCount < 1024) {
    return `${byteCount} B`;
  }

  if (byteCount < 1024 ** 2) {
    return `${(byteCount / 1024).toFixed(1)} KiB`;
  }

  if (byteCount < 1024 ** 3) {
    return `${(byteCount / 1024 ** 2).toFixed(1)} MiB`;
  }

  return `${(byteCount / 1024 ** 3).toFixed(1)} GiB`;
}

/** View-model for a pending tool-confirmation dialog presented to the user. */
interface PendingToolConfirmationViewModel {
  readonly assistantMessageId: string;
  readonly calls: Array<{
    readonly argumentsText: string;
    readonly callId: string;
    readonly category: string;
    readonly dangerous: boolean;
    readonly displayName?: string;
    readonly toolName: string;
  }>;
}

/**
 * Scans messages for the first tool-confirmation turn still awaiting user approval.
 *
 * @param messages The active chat message list.
 * @returns The pending confirmation view-model, or `null` if none exists.
 */
function findPendingToolConfirmation(
  messages: ChatMessageRecord[],
): PendingToolConfirmationViewModel | null {
  for (const message of messages) {
    const metadataValue = message.metadata["toolConfirmation"];

    if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue)) {
      continue;
    }

    const stateValue = (metadataValue as { state?: unknown }).state;

    if (stateValue !== "pending") {
      continue;
    }

    const calls = Array.isArray((metadataValue as { calls?: unknown }).calls)
      ? (metadataValue as { calls: unknown[] }).calls
          .filter(
            (call): call is Record<string, unknown> =>
              !!call && typeof call === "object" && !Array.isArray(call),
          )
          .filter((call) => call["requiresConfirmation"] === true)
          .map((call) => ({
            argumentsText: typeof call["argumentsText"] === "string" ? call["argumentsText"] : "{}",
            callId: typeof call["callId"] === "string" ? call["callId"] : crypto.randomUUID(),
            category: typeof call["category"] === "string" ? call["category"] : "custom",
            dangerous: call["dangerous"] === true,
            ...(typeof call["displayName"] === "string"
              ? { displayName: call["displayName"] }
              : {}),
            toolName: typeof call["toolName"] === "string" ? call["toolName"] : "tool",
          }))
      : [];

    if (calls.length === 0) {
      continue;
    }

    return {
      assistantMessageId: message.id,
      calls,
    };
  }

  return null;
}

/** Groups a list of chat summaries by date category. */
function groupChatsByDate(chats: ChatSummary[]): Array<{ label: string; chats: ChatSummary[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sevenDaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;

  const today: ChatSummary[] = [];
  const previous7Days: ChatSummary[] = [];
  const older: ChatSummary[] = [];

  for (const chat of chats) {
    const updated = new Date(chat.updatedAt).getTime();

    if (updated >= startOfToday) {
      today.push(chat);
    } else if (updated >= sevenDaysAgo) {
      previous7Days.push(chat);
    } else {
      older.push(chat);
    }
  }

  const groups: Array<{ label: string; chats: ChatSummary[] }> = [];

  if (today.length > 0) {
    groups.push({ label: "Today", chats: today });
  }

  if (previous7Days.length > 0) {
    groups.push({ label: "Previous 7 Days", chats: previous7Days });
  }

  if (older.length > 0) {
    groups.push({ label: "Older", chats: older });
  }

  return groups;
}

/** Downloads chat data as JSON or Markdown via a synthetic link. */
async function exportChats(format: "json" | "markdown"): Promise<void> {
  try {
    const { blob, filename } = await downloadChatsExport(format);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    useChatStore
      .getState()
      .setError(error instanceof Error ? error.message : "Failed to export chats.");
  }
}
