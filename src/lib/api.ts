import type {
  AppConfig,
  ChatMessageRecord,
  ChatSummary,
  HardwareOptimizerResult,
  LoadInferencePreset,
  MediaAttachmentRecord,
  ModelRecord,
  RuntimeSnapshot,
  SystemPromptPreset,
  ToolSummary,
} from "../lib/contracts";
import { readErrorResponseMessage } from "../lib/httpErrors";
import { calculateRuntimeLoadTimeoutMs } from "../lib/runtimeLoad";
import {
  streamJsonSseRequest as runJsonSseRequest,
  subscribeToJsonSse as createJsonSseSubscription,
} from "../lib/sseClient";

const JSON_REQUEST_TIMEOUT_MS = 30_000;

interface TimedRequestInit extends RequestInit {
  timeoutMs?: number;
  retryOnIdempotentRequest?: boolean;
}

/**
 * Represents the backend config response payload.
 */
export interface ConfigResponse {
  /** The persisted application configuration. */
  config: AppConfig;
  /** Optional warning about a non-destructive config recovery path. */
  warning?: string | null;
  /** The latest backend database revision. */
  dbRevision: number;
}

/**
 * Represents the backend model listing response payload.
 */
export interface ModelsResponse {
  /** The scanned model records. */
  models: ModelRecord[];
  /** Optional warning when the configured models path could not be scanned. */
  warning?: string | null;
  /** The latest backend database revision. */
  dbRevision: number;
}

/**
 * Represents the backend chat listing response payload.
 */
export interface ChatsResponse {
  /** The persisted chat summaries. */
  chats: ChatSummary[];
  /** The latest backend database revision. */
  dbRevision: number;
}

/**
 * Represents the backend single-chat response payload.
 */
export interface ChatDetailResponse {
  /** The persisted chat summary. */
  chat: ChatSummary;
  /** Indicates whether older messages remain available through pagination. */
  hasOlderMessages?: boolean;
  /** The chat's ordered messages. */
  messages: ChatMessageRecord[];
  /** Exclusive sequence cursor for loading an older page, when available. */
  nextBeforeSequence?: number | null;
  /** The latest backend database revision. */
  dbRevision: number;
}

export interface GetChatRequestOptions {
  beforeSequence?: number;
  limit?: number;
}

/**
 * Represents the backend preset listing response payload.
 *
 * @typeParam TPreset The preset payload type.
 */
export interface PresetsResponse<TPreset> {
  /** The persisted presets. */
  presets: TPreset[];
  /** The latest backend database revision. */
  dbRevision: number;
}

/**
 * Represents the backend tool listing response payload.
 */
export interface ToolsResponse {
  /** The discovered built-in and local tools. */
  tools: ToolSummary[];
}

/**
 * Represents the callbacks used during chat-completion streaming.
 */
export interface ChatCompletionStreamHandlers {
  /** Called for each assistant text delta. */
  onContentDelta?: (delta: string) => void;
  /** Called for each reasoning-content delta. */
  onReasoningDelta?: (delta: string) => void;
  /** Called when a non-streaming terminal payload includes timings or metadata. */
  onPayload?: (payload: Record<string, unknown>) => void;
}

/**
 * Represents the media-upload response payload.
 */
export interface UploadMediaAttachmentsResponse {
  /** Persisted attachment metadata for the uploaded files. */
  attachments: MediaAttachmentRecord[];
  /** The latest backend database revision. */
  dbRevision: number;
}

export interface DeletePendingMediaAttachmentsResponse {
  /** The latest backend database revision. */
  dbRevision: number;
  /** The identifiers of attachments removed from the backend staging area. */
  deletedAttachmentIds: string[];
}

/** Supported backend export formats for persisted chats. */
export type ChatExportFormat = "json" | "markdown";

/**
 * Represents the backend hardware-optimizer response payload.
 */
export interface HardwareOptimizerResponse {
  /** The latest backend database revision. */
  dbRevision: number;
  /** The optimizer hardware scan and recommendation bundle. */
  optimizer: HardwareOptimizerResult;
}

/**
 * Fetches the persisted application configuration.
 *
 * @returns The current backend config response.
 */
export async function getConfig(): Promise<ConfigResponse> {
  return await requestJson<ConfigResponse>("/api/config");
}

/**
 * Persists a partial configuration update.
 *
 * @param update Partial config update.
 * @returns The updated backend config response.
 */
export async function updateConfig(update: Partial<AppConfig>): Promise<ConfigResponse> {
  return await requestJson<ConfigResponse>("/api/config", {
    body: JSON.stringify(update),
    method: "PUT",
  });
}

/**
 * Fetches the current managed runtime snapshot.
 *
 * @returns The latest runtime snapshot.
 */
export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  return await requestJson<RuntimeSnapshot>("/api/runtime");
}

/**
 * Fetches the currently scanned model records.
 *
 * @returns The backend model listing response.
 */
export async function getModels(): Promise<ModelsResponse> {
  return await requestJson<ModelsResponse>("/api/models");
}

/**
 * Loads a model into the managed `llama-server` runtime.
 *
 * @param modelId The selected model identifier.
 * @param loadPresetId Optional selected load preset identifier.
 * @param systemPromptPresetId Optional selected system prompt preset identifier.
 * @returns The updated runtime snapshot.
 */
export async function loadModel(
  modelId: string,
  loadPresetId?: string,
  systemPromptPresetId?: string,
  timeoutMs: number = calculateRuntimeLoadTimeoutMs({}),
): Promise<RuntimeSnapshot> {
  const response = await requestJson<{ runtime: RuntimeSnapshot }>("/api/models/load", {
    body: JSON.stringify({
      loadPresetId,
      modelId,
      systemPromptPresetId,
    }),
    method: "POST",
    timeoutMs,
  });

  return response.runtime;
}

/**
 * Unloads the active model from the managed runtime.
 *
 * @returns The updated runtime snapshot.
 */
export async function unloadModel(): Promise<RuntimeSnapshot> {
  const response = await requestJson<{ runtime: RuntimeSnapshot }>("/api/models/unload", {
    method: "POST",
  });

  return response.runtime;
}

/**
 * Opens the configured models directory in the operating system file explorer.
 */
export async function openModelsFolder(): Promise<void> {
  await requestJson<{ ok: boolean; path: string }>("/api/models/open-folder", {
    method: "POST",
  });
}

/**
 * Requests a hardware-optimizer recommendation for a model and context length.
 */
export async function getHardwareOptimizerRecommendation(
  modelId: string,
  requestedContextLength: number,
): Promise<HardwareOptimizerResponse> {
  return await requestJson<HardwareOptimizerResponse>(
    `/api/models/${encodeURIComponent(modelId)}/optimizer`,
    {
      body: JSON.stringify({ requestedContextLength }),
      method: "POST",
    },
  );
}

/**
 * Fetches the system prompt presets associated with a model.
 *
 * @param modelId The model identifier.
 * @returns The backend preset listing response.
 */
export async function getSystemPromptPresets(
  modelId: string,
): Promise<PresetsResponse<SystemPromptPreset>> {
  return await requestJson<PresetsResponse<SystemPromptPreset>>(
    `/api/presets/system/${encodeURIComponent(modelId)}`,
  );
}

/**
 * Fetches the load and inference presets associated with a model.
 *
 * @param modelId The model identifier.
 * @returns The backend preset listing response.
 */
export async function getLoadInferencePresets(
  modelId: string,
): Promise<PresetsResponse<LoadInferencePreset>> {
  return await requestJson<PresetsResponse<LoadInferencePreset>>(
    `/api/presets/load/${encodeURIComponent(modelId)}`,
  );
}

/**
 * Creates a system-prompt preset for a model.
 */
export async function createSystemPromptPreset(
  modelId: string,
  input: {
    jinjaTemplateOverride?: string;
    name: string;
    systemPrompt: string;
    thinkingTags: SystemPromptPreset["thinkingTags"];
  },
): Promise<{ dbRevision: number; preset: SystemPromptPreset }> {
  return await requestJson<{ dbRevision: number; preset: SystemPromptPreset }>(
    `/api/presets/system/${encodeURIComponent(modelId)}`,
    {
      body: JSON.stringify(input),
      method: "POST",
    },
  );
}

/**
 * Updates a persisted system-prompt preset.
 */
export async function updateSystemPromptPreset(
  presetId: string,
  input: {
    jinjaTemplateOverride?: string;
    name: string;
    systemPrompt: string;
    thinkingTags: SystemPromptPreset["thinkingTags"];
  },
): Promise<{ dbRevision: number; preset: SystemPromptPreset }> {
  return await requestJson<{ dbRevision: number; preset: SystemPromptPreset }>(
    `/api/presets/system/item/${encodeURIComponent(presetId)}`,
    {
      body: JSON.stringify(input),
      method: "PUT",
    },
  );
}

/**
 * Deletes a persisted system-prompt preset.
 */
export async function deleteSystemPromptPreset(
  presetId: string,
): Promise<{ dbRevision: number; deleted: boolean; modelId?: string; promotedDefaultId?: string }> {
  return await requestJson<{
    dbRevision: number;
    deleted: boolean;
    modelId?: string;
    promotedDefaultId?: string;
  }>(`/api/presets/system/item/${encodeURIComponent(presetId)}`, {
    method: "DELETE",
  });
}

/**
 * Marks a system-prompt preset as the default for its model.
 */
export async function setDefaultSystemPromptPreset(
  presetId: string,
): Promise<{ dbRevision: number; preset: SystemPromptPreset }> {
  return await requestJson<{ dbRevision: number; preset: SystemPromptPreset }>(
    `/api/presets/system/item/${encodeURIComponent(presetId)}/default`,
    {
      method: "POST",
    },
  );
}

/**
 * Creates a load and inference preset for a model.
 */
export async function createLoadInferencePreset(
  modelId: string,
  input: {
    name: string;
    settings: LoadInferencePreset["settings"];
  },
): Promise<{ dbRevision: number; preset: LoadInferencePreset }> {
  return await requestJson<{ dbRevision: number; preset: LoadInferencePreset }>(
    `/api/presets/load/${encodeURIComponent(modelId)}`,
    {
      body: JSON.stringify(input),
      method: "POST",
    },
  );
}

/**
 * Updates a persisted load and inference preset.
 */
export async function updateLoadInferencePreset(
  presetId: string,
  input: {
    name: string;
    settings: LoadInferencePreset["settings"];
  },
): Promise<{ dbRevision: number; preset: LoadInferencePreset }> {
  return await requestJson<{ dbRevision: number; preset: LoadInferencePreset }>(
    `/api/presets/load/item/${encodeURIComponent(presetId)}`,
    {
      body: JSON.stringify(input),
      method: "PUT",
    },
  );
}

/**
 * Deletes a persisted load and inference preset.
 */
export async function deleteLoadInferencePreset(
  presetId: string,
): Promise<{ dbRevision: number; deleted: boolean; modelId?: string; promotedDefaultId?: string }> {
  return await requestJson<{
    dbRevision: number;
    deleted: boolean;
    modelId?: string;
    promotedDefaultId?: string;
  }>(`/api/presets/load/item/${encodeURIComponent(presetId)}`, {
    method: "DELETE",
  });
}

/**
 * Marks a load and inference preset as the default for its model.
 */
export async function setDefaultLoadInferencePreset(
  presetId: string,
): Promise<{ dbRevision: number; preset: LoadInferencePreset }> {
  return await requestJson<{ dbRevision: number; preset: LoadInferencePreset }>(
    `/api/presets/load/item/${encodeURIComponent(presetId)}/default`,
    {
      method: "POST",
    },
  );
}

/**
 * Fetches the persisted chat list, optionally using backend full-text search.
 *
 * @param searchQuery Optional transcript search query.
 * @returns The backend chat listing response.
 */
export async function getChats(searchQuery?: string): Promise<ChatsResponse> {
  return await getChatsWithOptions(searchQuery);
}

export async function getChatsWithOptions(
  searchQuery?: string,
  options?: {
    signal?: AbortSignal;
  },
): Promise<ChatsResponse> {
  const normalizedQuery = searchQuery?.trim() ?? "";
  const requestPath =
    normalizedQuery.length > 0
      ? `/api/chats?search=${encodeURIComponent(normalizedQuery)}`
      : "/api/chats";

  return await requestJson<ChatsResponse>(requestPath, {
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Downloads a server-generated export of all persisted chats.
 *
 * @param format Requested export format.
 * @returns Blob payload and filename advertised by the backend.
 */
export async function downloadChatsExport(
  format: ChatExportFormat,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/chats/export?format=${encodeURIComponent(format)}`, {
    headers: {
      Accept: format === "json" ? "application/json" : "text/markdown",
    },
  });

  if (!response.ok) {
    throw new Error(await readErrorResponseMessage(response));
  }

  const dispositionHeader = response.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(dispositionHeader);

  return {
    blob: await response.blob(),
    filename: filename ?? (format === "json" ? "chats-export.json" : "chats-export.md"),
  };
}

function parseContentDispositionFilename(disposition: string): string | null {
  const filenameStarMatch = disposition.match(/filename\*\s*=\s*([^;]+)/i);

  if (filenameStarMatch?.[1]) {
    let rawValue = filenameStarMatch[1].trim();

    if (rawValue.startsWith("UTF-8''") || rawValue.startsWith("utf-8''")) {
      rawValue = rawValue.slice(rawValue.indexOf("''") + 2);
    }

    rawValue = rawValue.replace(/^"|"$/g, "");

    try {
      return sanitizeExportFilename(decodeURIComponent(rawValue));
    } catch {
      return sanitizeExportFilename(rawValue);
    }
  }

  const filenameMatch = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const rawFilename = filenameMatch ? (filenameMatch[1] ?? filenameMatch[2]) : null;

  return rawFilename ? sanitizeExportFilename(rawFilename) : null;
}

function sanitizeExportFilename(filename: string): string | null {
  const normalized = filename.replace(/["'\\/\r\n]/g, "_").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Creates a new chat.
 *
 * @param title Optional initial title.
 * @returns The created chat summary and revision.
 */
export async function createChat(
  title?: string,
  lastUsedModelId?: string,
): Promise<{ chat: ChatSummary; dbRevision: number }> {
  return await requestJson<{ chat: ChatSummary; dbRevision: number }>("/api/chats", {
    body: JSON.stringify({ lastUsedModelId, title }),
    method: "POST",
  });
}

/**
 * Fetches a single persisted chat and its messages.
 *
 * @param chatId The chat identifier.
 * @param options Optional transcript paging options.
 * @returns The backend chat detail response.
 */
export async function getChat(
  chatId: string,
  options?: GetChatRequestOptions,
): Promise<ChatDetailResponse> {
  const searchParams = new URLSearchParams();

  if (typeof options?.limit === "number") {
    searchParams.set("limit", String(options.limit));
  }

  if (typeof options?.beforeSequence === "number") {
    searchParams.set("beforeSequence", String(options.beforeSequence));
  }

  const requestPath = `/api/chats/${encodeURIComponent(chatId)}${
    searchParams.size > 0 ? `?${searchParams.toString()}` : ""
  }`;

  return await requestJson<ChatDetailResponse>(requestPath);
}

/**
 * Deletes a chat and all associated messages and media from the backend.
 *
 * @param chatId The chat identifier.
 * @returns The updated database revision.
 */
export async function deleteChat(
  chatId: string,
): Promise<{ dbRevision: number; deleted: boolean }> {
  return await requestJson<{ dbRevision: number; deleted: boolean }>(
    `/api/chats/${encodeURIComponent(chatId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * Deletes all chats and their associated media from the backend.
 *
 * @returns The revision and count of deleted chats.
 */
export async function deleteAllChats(): Promise<{ dbRevision: number; deleted: number }> {
  return await requestJson<{ dbRevision: number; deleted: number }>("/api/chats", {
    method: "DELETE",
  });
}

/**
 * Persists a chat title change.
 *
 * @param chatId The chat identifier.
 * @param title The next chat title.
 * @returns The updated chat summary and revision.
 */
export async function updateChatTitle(
  chatId: string,
  title: string,
): Promise<{ chat: ChatSummary; dbRevision: number }> {
  return await requestJson<{ chat: ChatSummary; dbRevision: number }>(
    `/api/chats/${encodeURIComponent(chatId)}/title`,
    {
      body: JSON.stringify({ title }),
      method: "PUT",
    },
  );
}

/**
 * Requests low-priority automatic title generation for a persisted chat.
 *
 * @param chatId The chat identifier.
 * @returns The updated chat summary and generation status.
 */
export async function autoNameChat(
  chatId: string,
): Promise<{ canceled: boolean; chat: ChatSummary; dbRevision: number; generated: boolean }> {
  return await requestJson<{
    canceled: boolean;
    chat: ChatSummary;
    dbRevision: number;
    generated: boolean;
  }>(`/api/chats/${encodeURIComponent(chatId)}/auto-name`, {
    method: "POST",
  });
}

/**
 * Appends a persisted chat message.
 *
 * @param chatId The parent chat identifier.
 * @param role The message role.
 * @param content The message content.
 * @param mediaAttachments Persisted attachment metadata.
 * @param reasoningContent Optional reasoning content.
 * @param reasoningTruncated Whether the reasoning trace was truncated.
 * @param metadata Optional backend metadata.
 * @returns The created chat message and revision.
 */
export async function appendChatMessage(
  chatId: string,
  role: "assistant" | "system" | "tool" | "user",
  content: string,
  mediaAttachments: MediaAttachmentRecord[] = [],
  reasoningContent?: string,
  reasoningTruncated = false,
  metadata: Record<string, unknown> = {},
  messageId?: string,
): Promise<{ dbRevision: number; message: ChatMessageRecord }> {
  return await requestJson<{ dbRevision: number; message: ChatMessageRecord }>(
    `/api/chats/${encodeURIComponent(chatId)}/messages`,
    {
      body: JSON.stringify({
        content,
        mediaAttachments,
        messageId,
        metadata,
        reasoningContent,
        reasoningTruncated,
        role,
      }),
      method: "POST",
    },
  );
}

/**
 * Replaces a persisted user message and truncates the later transcript history.
 *
 * @param chatId The parent chat identifier.
 * @param messageId The message identifier being edited.
 * @param content The edited message content.
 * @returns The updated chat detail response.
 */
export async function editChatMessage(
  chatId: string,
  messageId: string,
  content: string,
): Promise<ChatDetailResponse> {
  return await requestJson<ChatDetailResponse>(`/api/chats/${encodeURIComponent(chatId)}/edit`, {
    body: JSON.stringify({
      content,
      messageId,
    }),
    method: "POST",
  });
}

/**
 * Removes a persisted assistant message and later history so the client can regenerate it.
 *
 * @param chatId The parent chat identifier.
 * @param messageId The assistant message identifier to regenerate.
 * @returns The updated chat detail response.
 */
export async function regenerateChatMessage(
  chatId: string,
  messageId: string,
): Promise<ChatDetailResponse> {
  return await requestJson<ChatDetailResponse>(
    `/api/chats/${encodeURIComponent(chatId)}/regenerate`,
    {
      body: JSON.stringify({ messageId }),
      method: "POST",
    },
  );
}

/**
 * Clones a transcript slice into a new branched chat.
 *
 * @param chatId The source chat identifier.
 * @param messageId The last message to include in the new branch.
 * @returns The created branched chat detail response.
 */
export async function branchChatMessage(
  chatId: string,
  messageId: string,
): Promise<ChatDetailResponse> {
  return await requestJson<ChatDetailResponse>(`/api/chats/${encodeURIComponent(chatId)}/branch`, {
    body: JSON.stringify({ messageId }),
    method: "POST",
  });
}

/**
 * Uploads pending media files for a chat before the related message is persisted.
 */
export async function uploadMediaAttachments(
  chatId: string,
  messageId: string,
  files: File[],
): Promise<UploadMediaAttachmentsResponse> {
  const formData = new FormData();
  formData.set("chatId", chatId);
  formData.set("messageId", messageId);

  for (const file of files) {
    formData.append("files", file);
  }

  return await requestJson<UploadMediaAttachmentsResponse>("/api/media/upload", {
    body: formData,
    method: "POST",
  });
}

export async function deletePendingMediaAttachments(
  chatId: string,
  messageId: string,
  attachmentIds: string[],
): Promise<DeletePendingMediaAttachmentsResponse> {
  return await requestJson<DeletePendingMediaAttachmentsResponse>("/api/media/pending", {
    body: JSON.stringify({ chatId, messageId, attachmentIds }),
    method: "DELETE",
  });
}

/**
 * Returns the backend URL that serves a persisted media attachment.
 */
export function getMediaAttachmentUrl(chatId: string, attachmentId: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(attachmentId)}/`;
}

/**
 * Stops the active generation request, when present.
 *
 * @returns A boolean describing whether a request was stopped.
 */
export async function stopGeneration(): Promise<boolean> {
  const response = await requestJson<{ stopped: boolean }>("/api/generate/stop", {
    method: "POST",
  });

  return response.stopped;
}

/**
 * Clears the backend debug-log buffer.
 */
export async function clearDebugLog(): Promise<void> {
  await requestJson<{ ok: boolean }>("/api/debug/clear", {
    method: "POST",
  });
}

/**
 * Fetches the discovered tool list.
 *
 * @returns The backend tool listing response.
 */
export async function getTools(): Promise<ToolsResponse> {
  return await requestJson<ToolsResponse>("/api/tools");
}

/**
 * Forces the backend to rescan the tools directory.
 *
 * @returns The refreshed backend tool listing response.
 */
export async function refreshTools(): Promise<ToolsResponse> {
  return await requestJson<ToolsResponse>("/api/tools/refresh", {
    method: "POST",
  });
}

/**
 * Opens the local tools folder in the operating system file explorer.
 */
export async function openToolsFolder(): Promise<void> {
  await requestJson<{ ok: boolean; path: string }>("/api/tools/open-folder", {
    method: "POST",
  });
}

/**
 * Streams a chat-completions request through the backend proxy.
 *
 * @param requestBody The OpenAI-compatible chat-completions body.
 * @param handlers Stream lifecycle callbacks.
 * @param signal Optional external abort signal.
 */
export async function streamChatCompletion(
  requestBody: Record<string, unknown>,
  handlers: ChatCompletionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await streamJsonSseRequest("/api/generate/chat", requestBody, handlers, signal);
}

/**
 * Resolves a paused tool-confirmation turn and resumes assistant streaming.
 *
 * @param chatId The chat identifier.
 * @param assistantMessageId The hidden assistant tool-call message awaiting confirmation.
 * @param approved Whether the user approved execution.
 * @param handlers Stream lifecycle callbacks.
 * @param signal Optional external abort signal.
 */
export async function streamToolConfirmationResolution(
  chatId: string,
  assistantMessageId: string,
  approved: boolean,
  handlers: ChatCompletionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await streamJsonSseRequest(
    `/api/chats/${encodeURIComponent(chatId)}/tool-confirmation`,
    {
      approved,
      assistantMessageId,
    },
    handlers,
    signal,
  );
}

/**
 * Subscribes to a backend JSON SSE stream.
 *
 * @typeParam TPayload The event payload type.
 * @param path The SSE endpoint path.
 * @param eventName The SSE event name.
 * @param onPayload Callback invoked for each event payload.
 * @returns A cleanup function that closes the `EventSource`.
 */
export function subscribeToJsonSse<TPayload>(
  path: string,
  eventName: string,
  onPayload: (payload: TPayload) => void,
  options?: {
    onError?: (error: {
      attempt: number;
      error?: Error;
      kind: "fatal" | "transient";
      retryDelayMs?: number;
    }) => void;
    onOpen?: () => void;
    reconnect?:
      | false
      | {
          initialDelayMs?: number;
          maxAttempts?: number;
          maxDelayMs?: number;
          multiplier?: number;
        };
  },
): () => void {
  return createJsonSseSubscription<TPayload>({
    eventName,
    onPayload,
    path,
    ...(options?.onError ? { onError: options.onError } : {}),
    ...(options?.onOpen ? { onOpen: options.onOpen } : {}),
    ...(typeof options?.reconnect === "undefined" ? {} : { reconnect: options.reconnect }),
  });
}

/** Issues a JSON request and returns the parsed response, throwing on non-OK status. */
export async function requestJson<TPayload>(
  input: string,
  init?: TimedRequestInit,
): Promise<TPayload> {
  const {
    timeoutMs = JSON_REQUEST_TIMEOUT_MS,
    retryOnIdempotentRequest,
    ...fetchInit
  } = init ?? {};
  const headers = new Headers(fetchInit.headers);
  const isIdempotent = !fetchInit.method || fetchInit.method.toUpperCase() === "GET";
  const hasExplicitIdempotencyHeader =
    headers.has("Idempotency-Key") || headers.has("X-Idempotency-Key");
  const isSafeForRetry =
    isIdempotent || retryOnIdempotentRequest === true || hasExplicitIdempotencyHeader;
  const maxAttempts = isSafeForRetry ? 3 : 1;
  const baseDelayMs = 150;

  if (typeof fetchInit.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { signal, cleanup } = buildTimedRequestSignal(fetchInit.signal, timeoutMs);

    try {
      const response = await fetch(input, {
        ...fetchInit,
        headers,
        signal,
      });

      if (response.ok) {
        return (await response.json()) as TPayload;
      }

      const responseError = new Error(await readErrorResponseMessage(response));
      const retryableStatus = [502, 503, 504];

      if (isSafeForRetry && attempt < maxAttempts && retryableStatus.includes(response.status)) {
        await delay(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      throw responseError;
    } catch (error) {
      if (attempt < maxAttempts && isSafeForRetry && isRetryableRequestError(error)) {
        await delay(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }

      throw error;
    } finally {
      cleanup();
    }
  }

  throw new Error("Failed to complete the request after retrying.");
}

export function buildTimedRequestSignal(
  existingSignal?: AbortSignal | null,
  timeoutMs = JSON_REQUEST_TIMEOUT_MS,
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutResult =
    typeof AbortSignal.timeout === "function"
      ? { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} }
      : createTimeoutAbortSignal(timeoutMs);

  if (!existingSignal) {
    return {
      signal: timeoutResult.signal,
      cleanup: timeoutResult.cleanup,
    };
  }

  if (typeof AbortSignal.any === "function") {
    return {
      signal: AbortSignal.any([existingSignal, timeoutResult.signal]),
      cleanup: timeoutResult.cleanup,
    };
  }

  const combinedController = new AbortController();
  const propagateAbort = (): void => {
    combinedController.abort();
  };

  existingSignal.addEventListener("abort", propagateAbort, { once: true });
  timeoutResult.signal.addEventListener("abort", propagateAbort, { once: true });
  combinedController.signal.addEventListener(
    "abort",
    () => {
      existingSignal.removeEventListener("abort", propagateAbort);
      timeoutResult.signal.removeEventListener("abort", propagateAbort);
      timeoutResult.cleanup();
    },
    { once: true },
  );

  return {
    signal: combinedController.signal,
    cleanup: (): void => {
      existingSignal.removeEventListener("abort", propagateAbort);
      timeoutResult.signal.removeEventListener("abort", propagateAbort);
      timeoutResult.cleanup();
    },
  };
}

function createTimeoutAbortSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutHandle = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: (): void => {
      clearTimeout(timeoutHandle);
    },
  };
}

export function isRetryableRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();
  const normalizedCode = (() => {
    const rawCode = (error as { code?: unknown }).code;

    return typeof rawCode === "string" ? rawCode.toLowerCase() : "";
  })();
  const retryableErrorCodes = new Set([
    "econnreset",
    "econnrefused",
    "enotfound",
    "enetunreach",
    "eai_again",
    "eai",
    "etimedout",
    "ecancelled",
    "econnaborted",
  ]);

  return (
    retryableErrorCodes.has(normalizedCode) ||
    normalizedMessage.includes("network") ||
    normalizedMessage.includes("failed to fetch") ||
    normalizedMessage.includes("network request failed") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("connection") ||
    normalizedMessage.includes("connection reset") ||
    normalizedMessage.includes("connection aborted") ||
    normalizedMessage.includes("socket hang up") ||
    normalizedMessage.includes("econnreset") ||
    normalizedMessage.includes("econnrefused") ||
    normalizedMessage.includes("enotfound") ||
    normalizedMessage.includes("enetunreach") ||
    normalizedMessage.includes("eai") ||
    normalizedMessage.includes("etimed out")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Streams a JSON SSE request and dispatches chat-completion deltas to handlers. */
async function streamJsonSseRequest(
  input: string,
  body: Record<string, unknown>,
  handlers: ChatCompletionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await runJsonSseRequest<Record<string, unknown>>({
    body,
    input,
    onPayload: (payload) => {
      handleChatPayload(payload, handlers);
    },
    ...(signal ? { signal } : {}),
  });
}

/** Dispatches a parsed SSE chat payload to the appropriate handler callbacks. */
function handleChatPayload(
  payload: Record<string, unknown>,
  handlers: ChatCompletionStreamHandlers,
): void {
  handlers.onPayload?.(payload);

  const choicesValue = payload["choices"];

  if (!Array.isArray(choicesValue) || choicesValue.length === 0) {
    return;
  }

  const firstChoice = choicesValue[0];

  if (!firstChoice || typeof firstChoice !== "object") {
    return;
  }

  const deltaValue = (firstChoice as Record<string, unknown>)["delta"];

  if (!deltaValue || typeof deltaValue !== "object") {
    return;
  }

  const deltaRecord = deltaValue as Record<string, unknown>;
  const contentDelta = deltaRecord["content"];
  const reasoningDelta = deltaRecord["reasoning_content"];

  if (typeof contentDelta === "string") {
    handlers.onContentDelta?.(contentDelta);
  }

  if (typeof reasoningDelta === "string") {
    handlers.onReasoningDelta?.(reasoningDelta);
  }
}
