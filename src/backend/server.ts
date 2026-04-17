import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AppConfig,
  ChatMessageRecord,
  ChatSummary,
  LoadInferenceSettings,
  LoadInferencePreset,
  MediaAttachmentKind,
  MediaAttachmentRecord,
  ModelRecord,
  RuntimeSnapshot,
  SystemPromptPreset,
} from "../lib/contracts";
import {
  formatAttachmentUploadLimit,
  getAttachmentUploadLimit,
  MAX_AGGREGATE_UPLOAD_BYTES,
} from "../lib/attachmentUploadLimits";
import {
  resolveAttachmentKindFromFileLike,
  resolveAttachmentMimeTypeFromFileLike,
} from "../lib/attachmentTypePolicy";
import { validateLoadInferenceSettings } from "../lib/loadInferenceValidation";
import {
  cleanupFinalizedPendingAttachments,
  cleanupRemovedMessageAttachmentsAfterMutation,
  normalizeAttachmentFileName,
  promotePendingAttachments,
  rollbackPromotedPendingAttachments,
} from "./attachmentLifecycle";
import { deleteAttachmentArtifacts } from "./attachmentReplay";
import { buildAutoNamePrompt, normalizeGeneratedChatTitle } from "./autoNaming";
import { branchChatAtMessage, cleanupMessageAttachments } from "./chatMutations";
import { ConfigStore } from "./config";
import { createChatGenerationResponse, createToolConfirmationResponse } from "./chatOrchestrator";
import { AppDatabase, ChatNotFoundError } from "./db";
import { DebugLogService } from "./debug";
import { LlamaServerManager } from "./llamaServer";
import { buildHardwareOptimizerResult } from "./optimizer";
import { ensureApplicationDirectories, getApplicationPaths } from "./paths";
import { tryDecodeRequestPathComponent } from "./requestIngress";
import { ModelScanner } from "./scanner";
import { JsonSseBroadcaster } from "./sse";
import {
  sweepStartupAttachmentCleanupJobs,
  sweepStartupPendingAttachments,
  sweepStartupTemplateOverrideFiles,
} from "./startupCleanup";
import { runLocalToolWorkerProcess } from "./tools/localToolWorkerProcess";
import { LocalToolRegistry } from "./tools/registry";

const KV_CACHE_TYPES = new Set([
  "f32",
  "f16",
  "bf16",
  "q8_0",
  "q4_0",
  "q4_1",
  "iq4_nl",
  "q5_0",
  "q5_1",
]);
const OVERFLOW_STRATEGIES = new Set(["truncate-middle", "rolling-window", "stop-at-limit"]);
const STRUCTURED_OUTPUT_MODES = new Set(["off", "json_object", "json_schema"]);

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bun route handler request type augmented with typed URL parameters. */
type RouteRequest<TParams extends Record<string, string>> = Request & { params: TParams };

const applicationPaths = getApplicationPaths();
const runtimeArguments = process.argv.slice(2);
const developmentProxyMode = runtimeArguments.includes("--dev-proxy");
const runtimeBroadcaster = new JsonSseBroadcaster<RuntimeSnapshot>({
  maxEntries: 128,
  bufferWhenDisconnected: false,
});
let configStore!: ConfigStore;
let database!: AppDatabase;
let debugLogService!: DebugLogService;
let embeddedStaticAssets: ReadonlyMap<string, ReturnType<typeof Bun.file>> = new Map();
const staticAssetDiskExistsCache = new Map<string, boolean>();
let scanner!: ModelScanner;
let toolRegistry!: LocalToolRegistry;
let llamaServerManager!: LlamaServerManager;
let server!: ReturnType<typeof Bun.serve>;
let shuttingDown = false;
let staleArtifactSweepHandle: ReturnType<typeof setInterval> | null = null;

const STALE_ARTIFACT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const STALE_ARTIFACT_MAX_AGE_MS = 15 * 60 * 1000;

if (runtimeArguments.includes("--run-local-tool-worker")) {
  runLocalToolWorkerProcess().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);

    console.error(`Failed to run Local LLM GUI tool worker: ${errorMessage}`);
    process.exit(1);
  });
} else {
  startServer().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);

    console.error(`Failed to start Local LLM GUI: ${errorMessage}`);
    process.exit(1);
  });
}

async function startServer(): Promise<void> {
  await ensureApplicationDirectories(applicationPaths);

  configStore = new ConfigStore(applicationPaths);
  debugLogService = new DebugLogService({
    persistenceFilePath: path.join(applicationPaths.userDataDir, "debug-log.json"),
  });
  database = new AppDatabase(applicationPaths, {
    onSqliteBeginBlocked: (event) => {
      debugLogService.serverLog(
        `SQLite lock pressure: write-transaction begin attempt ${String(event.attempt)}/${String(event.maxRetries + 1)} waited ${String(event.elapsedMs)}ms before acquiring the lock.`,
      );
    },
    onSqliteBusyRetry: (event) => {
      debugLogService.serverLog(
        `SQLite lock pressure: busy write-transaction begin retry ${String(event.attempt)}/${String(event.maxRetries)} after ${String(event.delayMs)}ms backoff.`,
      );
    },
  });
  embeddedStaticAssets = developmentProxyMode ? new Map() : await createEmbeddedStaticAssetMap();
  scanner = new ModelScanner(database, debugLogService);
  toolRegistry = new LocalToolRegistry(applicationPaths, configStore, debugLogService);
  llamaServerManager = new LlamaServerManager(
    applicationPaths,
    debugLogService,
    runtimeBroadcaster,
  );

  const initialConfig = await configStore.getConfig();
  const initialConfigWarning = configStore.getLoadWarning();

  debugLogService.applySettings(initialConfig.debug);

  if (initialConfigWarning) {
    debugLogService.serverLog(initialConfigWarning);
  }

  await sweepStartupAttachmentCleanupJobs({
    database,
    log: (message) => {
      debugLogService.serverLog(message);
    },
  });

  await sweepStartupPendingAttachments({
    applicationPaths,
    database,
    log: (message) => {
      debugLogService.serverLog(message);
    },
  });
  await sweepStartupTemplateOverrideFiles({
    applicationPaths,
    log: (message) => {
      debugLogService.serverLog(message);
    },
  });

  staleArtifactSweepHandle = setInterval(() => {
    void runPeriodicStaleArtifactSweep();
  }, STALE_ARTIFACT_SWEEP_INTERVAL_MS);
  staleArtifactSweepHandle.unref?.();

  await toolRegistry.refreshTools();

  async function handleMediaUpload(request: Request): Promise<Response> {
    const formData = await readMultipartFormData(request);

    const chatIdValue = formData.get("chatId");
    const messageIdValue = formData.get("messageId");
    const fileEntries = formData.getAll("files");

    if (typeof chatIdValue !== "string" || chatIdValue.trim().length === 0) {
      return createErrorResponse(400, "Missing required field: chatId.");
    }

    const chat = database.getChat(chatIdValue);

    if (!chat) {
      return createErrorResponse(404, `Chat not found: ${chatIdValue}`);
    }

    if (typeof messageIdValue !== "string" || messageIdValue.trim().length === 0) {
      return createErrorResponse(400, "Missing required field: messageId.");
    }

    const messageId = messageIdValue.trim();

    if (!isUuid(messageId)) {
      return createErrorResponse(400, "messageId must be a valid UUID.");
    }

    if (fileEntries.length === 0) {
      return createErrorResponse(400, "At least one uploaded file is required.");
    }

    const stalePendingAttachments = database.listPendingAttachmentsForMessage(
      chatIdValue,
      messageId,
    );

    if (stalePendingAttachments.length > 0) {
      await deleteAttachmentFiles(stalePendingAttachments);
      database.markPendingAttachmentsAbandoned(
        stalePendingAttachments.map((attachment) => attachment.id),
        "superseded by a newer upload for the same message slot",
      );
    }

    const targetDirectory = path.join(
      applicationPaths.mediaDir,
      chatIdValue,
      ".pending",
      messageId,
    );
    const uploadFiles: File[] = [];

    for (const fileEntry of fileEntries) {
      if (typeof fileEntry === "string") {
        return createErrorResponse(
          400,
          'Uploaded form field "files" must contain file uploads, not plain text.',
        );
      }

      uploadFiles.push(fileEntry as File);
    }

    if (uploadFiles.length === 0) {
      return createErrorResponse(400, "At least one uploaded file is required.");
    }

    debugLogService.verboseServerLog(
      `Uploading ${String(uploadFiles.length)} attachment(s) for chat ${chatIdValue} message ${messageId}.`,
    );

    const validatedUploads: Array<{
      attachmentId: string;
      attachmentKind: MediaAttachmentKind;
      file: File;
      mimeType: string;
      normalizedFileName: string;
    }> = [];

    let aggregateBytes = 0;

    for (const file of uploadFiles) {
      const attachmentKind = resolveAttachmentKindFromFileLike(file);

      if (!attachmentKind) {
        return createErrorResponse(400, `Unsupported attachment type for file: ${file.name}`);
      }

      const maxUploadBytes = getMaxUploadBytes(attachmentKind);

      if (file.size > maxUploadBytes) {
        return createErrorResponse(
          413,
          `${file.name} exceeds the ${formatAttachmentUploadLimit(maxUploadBytes)} upload limit for ${attachmentKind} attachments.`,
        );
      }

      aggregateBytes += file.size;

      if (aggregateBytes > MAX_AGGREGATE_UPLOAD_BYTES) {
        return createErrorResponse(
          413,
          `Total upload size exceeds the ${formatAttachmentUploadLimit(MAX_AGGREGATE_UPLOAD_BYTES)} aggregate limit per request.`,
        );
      }

      validatedUploads.push({
        attachmentId: crypto.randomUUID(),
        attachmentKind,
        file,
        mimeType: resolveAttachmentMimeTypeFromFileLike(file, attachmentKind),
        normalizedFileName: normalizeAttachmentFileName(file.name),
      });
    }

    await mkdir(targetDirectory, { recursive: true });

    const attachments: MediaAttachmentRecord[] = [];

    try {
      for (const upload of validatedUploads) {
        const targetFilePath = path.join(
          targetDirectory,
          `${upload.attachmentId}-${upload.normalizedFileName}`,
        );
        const attachment: MediaAttachmentRecord = {
          byteSize: upload.file.size,
          fileName: upload.file.name,
          filePath: targetFilePath,
          id: upload.attachmentId,
          kind: upload.attachmentKind,
          mimeType: upload.mimeType,
        };

        attachments.push(attachment);
        await writeFileStream(targetFilePath, upload.file.stream());
      }

      for (const attachment of attachments) {
        database.createPendingAttachment(chatIdValue, messageId, attachment);
      }
    } catch (error) {
      await deleteAttachmentFiles(attachments);
      database.markPendingAttachmentsAbandoned(
        attachments.map((attachment) => attachment.id),
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    debugLogService.verboseServerLog(
      `Stored ${String(attachments.length)} pending attachment(s) for chat ${chatIdValue} message ${messageId}.`,
    );

    return Response.json(
      {
        attachments,
        dbRevision: database.getRevision(),
      },
      { status: 201 },
    );
  }

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: resolveServerPort(runtimeArguments),
    routes: {
      "/api/events/*": false,
      "/api/generate/chat": false,
      "/api/generate/completion": false,
      "/api/chats/:chatId/tool-confirmation": false,
      "/api/health": () =>
        Response.json({
          dbRevision: database.getRevision(),
          ok: true,
          runtime: llamaServerManager.getSnapshot(),
        }),
      "/api/runtime": () => Response.json(llamaServerManager.getSnapshot()),
      "/api/config": {
        GET: async () => {
          const config = await configStore.getConfig();

          return Response.json({
            config,
            dbRevision: database.getRevision(),
            warning: configStore.getLoadWarning(),
          });
        },
        PUT: async (request) => {
          const body = await readJsonObject(request);
          const updatedConfig = await configStore.updateConfig(body as Partial<AppConfig>);

          debugLogService.applySettings(updatedConfig.debug);

          return Response.json({
            config: updatedConfig,
            dbRevision: database.getRevision(),
            warning: configStore.getLoadWarning(),
          });
        },
      },
      "/api/models": {
        GET: async () => {
          const config = await configStore.getConfig();
          const models = await scanner.scanModels(config.modelsPath);

          return Response.json({
            dbRevision: database.getRevision(),
            models,
            warning: scanner.getScanWarning(),
          });
        },
      },
      "/api/models/open-folder": {
        POST: async (request) => {
          assertTrustedWriteRequest(request);
          const config = await configStore.getConfig();

          if (!config.modelsPath) {
            return createErrorResponse(400, "The models path is not configured.");
          }

          openDirectoryInExplorer(config.modelsPath);

          return Response.json({
            ok: true,
            path: config.modelsPath,
          });
        },
      },
      "/api/models/:modelId/optimizer": {
        POST: async (request: RouteRequest<{ modelId: string }>) => {
          const config = await configStore.getConfig();
          const models = await scanner.getCachedOrScanModels(config.modelsPath);
          const scanWarning = scanner.getScanWarning();

          if (scanWarning) {
            return createErrorResponse(409, scanWarning);
          }

          const selectedModel = models.find((model) => model.id === request.params.modelId);

          if (!selectedModel) {
            return createErrorResponse(404, `Model not found: ${request.params.modelId}`);
          }

          const body = (await readJsonObject(request)) as { requestedContextLength?: number };
          const requestedContextLength =
            typeof body.requestedContextLength === "number"
              ? body.requestedContextLength
              : (selectedModel.contextLength ?? 4096);
          const optimizerResult = await buildHardwareOptimizerResult(
            selectedModel,
            requestedContextLength,
            config.llamaServerPath,
          );

          return Response.json({
            dbRevision: database.getRevision(),
            optimizer: optimizerResult,
          });
        },
      },
      "/api/models/load": {
        POST: async (request) => {
          const body = (await readJsonObject(request)) as {
            loadPresetId?: string;
            modelId?: string;
            systemPromptPresetId?: string;
          };

          if (!body.modelId) {
            return createErrorResponse(400, "Missing required field: modelId.");
          }

          const config = await configStore.getConfig();
          const models = await scanner.getCachedOrScanModels(config.modelsPath);
          const scanWarning = scanner.getScanWarning();

          if (scanWarning) {
            return createErrorResponse(409, scanWarning);
          }

          const selectedModel = models.find((model) => model.id === body.modelId);

          if (!selectedModel) {
            return createErrorResponse(404, `Model not found: ${body.modelId}`);
          }

          database.ensureDefaultPresets(selectedModel);

          const loadPreset = resolveLoadPreset(selectedModel, database, body.loadPresetId);
          const systemPromptPreset = resolveSystemPromptPreset(
            selectedModel,
            database,
            body.systemPromptPresetId,
          );

          if (!loadPreset || !systemPromptPreset) {
            return createErrorResponse(404, "The requested model presets could not be resolved.");
          }

          const loadSettingsError = validateLoadInferenceSettings(loadPreset.settings);

          if (loadSettingsError) {
            return createErrorResponse(400, loadSettingsError);
          }

          const runtimeSnapshot = await llamaServerManager.loadModel({
            config,
            model: selectedModel,
            loadPreset,
            systemPromptPreset,
          });

          return Response.json({
            dbRevision: database.getRevision(),
            runtime: runtimeSnapshot,
          });
        },
      },
      "/api/models/unload": {
        POST: async (request) => {
          assertTrustedWriteRequest(request);
          await llamaServerManager.unload("user-request");

          return Response.json({
            runtime: llamaServerManager.getSnapshot(),
          });
        },
      },
      "/api/chats": {
        GET: (request) => {
          const requestUrl = new URL(request.url);
          const searchQuery = requestUrl.searchParams.get("search") ?? "";
          const page = Number(requestUrl.searchParams.get("page") ?? "1");
          const pageSize = Number(requestUrl.searchParams.get("pageSize") ?? "50");

          return Response.json({
            chats:
              searchQuery.trim().length > 0
                ? database.searchChats(searchQuery, page, pageSize)
                : database.listChats(page, pageSize),
            dbRevision: database.getRevision(),
          });
        },
        POST: async (request) => {
          const body = (await readJsonObject(request)) as {
            lastUsedModelId?: string;
            title?: string;
          };
          const createdChat = database.createChat(body.title, body.lastUsedModelId);

          debugLogService.verboseServerLog(
            `Created chat ${createdChat.id} for a new conversation${typeof body.lastUsedModelId === "string" ? ` using model ${body.lastUsedModelId}` : ""}.`,
          );

          return Response.json(
            {
              chat: createdChat,
              dbRevision: database.getRevision(),
            },
            { status: 201 },
          );
        },
        DELETE: async (request) => {
          assertTrustedWriteRequest(request);
          await llamaServerManager.stopGeneration();
          const deletedChatIds = database.deleteAllChats();

          for (const chatId of deletedChatIds) {
            await rm(path.join(applicationPaths.mediaDir, chatId), {
              force: true,
              recursive: true,
            });
          }

          return Response.json({
            dbRevision: database.getRevision(),
            deleted: deletedChatIds.length,
          });
        },
      },
      "/api/chats/export": {
        GET: (request) => createChatsExportResponse(request),
      },
      "/api/chats/:chatId": {
        GET: (request: RouteRequest<{ chatId: string }>) => {
          const requestUrl = new URL(request.url);
          const limitParam = requestUrl.searchParams.get("limit");
          const beforeSequenceParam = requestUrl.searchParams.get("beforeSequence");

          if (limitParam !== null) {
            const limit = parseNonNegativeInteger(limitParam);

            if (limit === null || limit < 1) {
              return createErrorResponse(400, "limit must be a positive integer.");
            }

            const beforeSequence =
              beforeSequenceParam === null ? null : parseNonNegativeInteger(beforeSequenceParam);

            if (beforeSequenceParam !== null && beforeSequence === null) {
              return createErrorResponse(400, "beforeSequence must be a non-negative integer.");
            }

            const chatPage = database.getChatPage(
              request.params.chatId,
              limit,
              beforeSequence ?? undefined,
            );

            if (!chatPage) {
              return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
            }

            return Response.json({
              ...chatPage,
              dbRevision: database.getRevision(),
            });
          }

          const chat = database.getChat(request.params.chatId);

          if (!chat) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          return Response.json({
            ...chat,
            dbRevision: database.getRevision(),
            hasOlderMessages: false,
            nextBeforeSequence: null,
          });
        },
        DELETE: async (request: RouteRequest<{ chatId: string }>) => {
          assertTrustedWriteRequest(request);
          await llamaServerManager.stopGeneration(request.params.chatId);
          const existingChat = database.getChat(request.params.chatId);

          if (!existingChat) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          const deleted = database.deleteChat(request.params.chatId);

          if (!deleted) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          await cleanupMessageAttachments(existingChat.messages, database);

          return Response.json({
            dbRevision: database.getRevision(),
            deleted: true,
          });
        },
      },
      "/api/chats/:chatId/media/:attachmentId": {
        GET: (request: RouteRequest<{ attachmentId: string; chatId: string }>) =>
          createMediaAttachmentResponse(request, true),
        HEAD: (request: RouteRequest<{ attachmentId: string; chatId: string }>) =>
          createMediaAttachmentResponse(request, false),
      },
      "/api/chats/:chatId/media/:attachmentId/": {
        GET: (request: RouteRequest<{ attachmentId: string; chatId: string }>) =>
          createMediaAttachmentResponse(request, true),
        HEAD: (request: RouteRequest<{ attachmentId: string; chatId: string }>) =>
          createMediaAttachmentResponse(request, false),
      },
      "/api/chats/:chatId/messages": {
        POST: async (request: RouteRequest<{ chatId: string }>, server) => {
          server.timeout(request, 0);
          const body = (await readJsonObject(request)) as {
            content?: string;
            mediaAttachments?: MediaAttachmentRecord[];
            messageId?: string;
            metadata?: Record<string, unknown>;
            reasoningContent?: string;
            reasoningTruncated?: boolean;
            role?: "assistant" | "system" | "tool" | "user";
          };
          const chat = database.getChat(request.params.chatId);

          if (!chat) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          const messageRole = body.role ?? "user";

          if (!["assistant", "system", "tool", "user"].includes(messageRole)) {
            return createErrorResponse(400, `Unsupported message role: ${String(body.role)}`);
          }

          const requestedAttachmentCount = Array.isArray(body.mediaAttachments)
            ? body.mediaAttachments.length
            : 0;
          const requestedMessageId =
            typeof body.messageId === "string" ? body.messageId.trim() : "";

          if (requestedAttachmentCount > 0 && requestedMessageId.length === 0) {
            return createErrorResponse(400, "Missing required field: messageId.");
          }

          if (requestedMessageId.length > 0 && !isUuid(requestedMessageId)) {
            return createErrorResponse(400, "messageId must be a valid UUID.");
          }

          const messageId = requestedMessageId || crypto.randomUUID();

          debugLogService.verboseServerLog(
            `Persisting ${messageRole} message ${messageId} for chat ${request.params.chatId} with ${String(requestedAttachmentCount)} attachment reference(s).`,
          );

          const preparedAttachments = await finalizePendingMessageAttachments(
            request.params.chatId,
            messageId,
            body.mediaAttachments,
          );

          let createdMessage;

          try {
            createdMessage = database.appendMessage(
              request.params.chatId,
              messageRole,
              typeof body.content === "string" ? body.content : "",
              preparedAttachments.finalAttachments,
              typeof body.reasoningContent === "string" ? body.reasoningContent : undefined,
              body.reasoningTruncated ?? false,
              body.metadata && typeof body.metadata === "object" ? body.metadata : {},
              messageId,
              preparedAttachments.finalAttachments,
            );
          } catch (error) {
            await rollbackPromotedPendingAttachments({
              finalAttachments: preparedAttachments.finalAttachments,
              pendingAttachments: preparedAttachments.pendingAttachments,
            });

            if (error instanceof ChatNotFoundError) {
              return createErrorResponse(404, error.message);
            }

            throw error;
          }

          let attachmentCleanupError: string | null = null;

          try {
            await cleanupFinalizedPendingAttachments({
              chatId: request.params.chatId,
              createCleanupJob: (chatId, operation, filePaths) =>
                database.createAttachmentCleanupJob(chatId, operation, filePaths).id,
              deletePendingAttachmentFiles: deleteAttachmentFiles,
              log: (message) => {
                debugLogService.serverLog(message);
              },
              markCleanupJobCompleted: (jobId) => {
                database.markAttachmentCleanupJobCompleted(jobId);
              },
              markCleanupJobFailed: (jobId, errorMessage) => {
                database.markAttachmentCleanupJobFailed(jobId, errorMessage);
              },
              markCleanupJobQueued: (jobId, errorMessage) => {
                database.requeueAttachmentCleanupJob(jobId, errorMessage);
              },
              markCleanupJobRunning: (jobId) => {
                database.markAttachmentCleanupJobRunning(jobId);
              },
              markPendingAttachmentsCleanupFailed: (attachmentIds, errorMessage) => {
                database.markPendingAttachmentsCleanupFailed(attachmentIds, errorMessage);
              },
              messageId: createdMessage.id,
              pendingAttachments: preparedAttachments.pendingAttachments,
            });
          } catch (error) {
            attachmentCleanupError = error instanceof Error ? error.message : String(error);
            debugLogService.serverLog(
              `Finalized pending attachment cleanup failed for chat ${request.params.chatId} message ${createdMessage.id}: ${attachmentCleanupError}`,
            );
          }

          debugLogService.verboseServerLog(
            `Persisted ${messageRole} message ${createdMessage.id} for chat ${request.params.chatId}.`,
          );

          return Response.json(
            {
              dbRevision: database.getRevision(),
              message: createdMessage,
              ...(attachmentCleanupError ? { attachmentCleanupError } : {}),
            },
            { status: 201 },
          );
        },
      },
      "/api/chats/:chatId/edit": {
        POST: async (request: RouteRequest<{ chatId: string }>) => {
          const body = (await readJsonObject(request)) as {
            content?: string;
            messageId?: string;
          };

          if (!body.messageId) {
            return createErrorResponse(400, "Missing required field: messageId.");
          }

          if (typeof body.content !== "string" || body.content.trim().length === 0) {
            return createErrorResponse(400, "Message edits must include non-empty content.");
          }

          await llamaServerManager.stopGeneration(request.params.chatId);

          const existingMessage = database.getMessage(request.params.chatId, body.messageId);

          if (!existingMessage) {
            return createErrorResponse(404, `Message not found: ${body.messageId}`);
          }

          if (existingMessage.role !== "user") {
            return createErrorResponse(400, "Only user messages can be edited.");
          }

          const result = database.replaceMessageAndTruncateFollowing(
            request.params.chatId,
            body.messageId,
            body.content.trim(),
          );

          if (!result) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          void cleanupRemovedMessageAttachmentsAfterMutation({
            chatId: request.params.chatId,
            cleanupRemovedMessageAttachments: (messages) =>
              cleanupMessageAttachments(messages, database),
            createCleanupJob: (chatId, operation, filePaths) =>
              database.createAttachmentCleanupJob(chatId, operation, filePaths).id,
            log: (message) => {
              debugLogService.serverLog(message);
            },
            markCleanupJobCompleted: (jobId) => {
              database.markAttachmentCleanupJobCompleted(jobId);
            },
            markCleanupJobFailed: (jobId, errorMessage) => {
              database.markAttachmentCleanupJobFailed(jobId, errorMessage);
            },
            markCleanupJobQueued: (jobId, errorMessage) => {
              database.requeueAttachmentCleanupJob(jobId, errorMessage);
            },
            markCleanupJobRunning: (jobId) => {
              database.markAttachmentCleanupJobRunning(jobId);
            },
            operation: "edit",
            removedMessages: result.removedMessages,
          });

          return Response.json({
            chat: result.chat,
            dbRevision: database.getRevision(),
            messages: result.messages,
          });
        },
      },
      "/api/chats/:chatId/regenerate": {
        POST: async (request: RouteRequest<{ chatId: string }>) => {
          const body = (await readJsonObject(request)) as {
            messageId?: string;
          };

          if (!body.messageId) {
            return createErrorResponse(400, "Missing required field: messageId.");
          }

          await llamaServerManager.stopGeneration(request.params.chatId);

          const existingMessage = database.getMessage(request.params.chatId, body.messageId);

          if (!existingMessage) {
            return createErrorResponse(404, `Message not found: ${body.messageId}`);
          }

          if (existingMessage.role !== "assistant") {
            return createErrorResponse(400, "Only assistant messages can be regenerated.");
          }

          const result = database.truncateChatFromMessage(request.params.chatId, body.messageId);

          if (!result) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          void cleanupRemovedMessageAttachmentsAfterMutation({
            chatId: request.params.chatId,
            cleanupRemovedMessageAttachments: (messages) =>
              cleanupMessageAttachments(messages, database),
            createCleanupJob: (chatId, operation, filePaths) =>
              database.createAttachmentCleanupJob(chatId, operation, filePaths).id,
            log: (message) => {
              debugLogService.serverLog(message);
            },
            markCleanupJobCompleted: (jobId) => {
              database.markAttachmentCleanupJobCompleted(jobId);
            },
            markCleanupJobFailed: (jobId, errorMessage) => {
              database.markAttachmentCleanupJobFailed(jobId, errorMessage);
            },
            markCleanupJobQueued: (jobId, errorMessage) => {
              database.requeueAttachmentCleanupJob(jobId, errorMessage);
            },
            markCleanupJobRunning: (jobId) => {
              database.markAttachmentCleanupJobRunning(jobId);
            },
            operation: "regenerate",
            removedMessages: result.removedMessages,
          });

          return Response.json({
            chat: result.chat,
            dbRevision: database.getRevision(),
            messages: result.messages,
          });
        },
      },
      "/api/chats/:chatId/branch": {
        POST: async (request: RouteRequest<{ chatId: string }>) => {
          const body = (await readJsonObject(request)) as {
            messageId?: string;
          };

          if (!body.messageId) {
            return createErrorResponse(400, "Missing required field: messageId.");
          }

          const result = await branchChatAtMessage(
            applicationPaths,
            database,
            request.params.chatId,
            body.messageId,
          );

          if (!result) {
            return createErrorResponse(
              404,
              `Chat or message not found for branch request: ${request.params.chatId}`,
            );
          }

          return Response.json({
            chat: result.chat,
            dbRevision: database.getRevision(),
            messages: result.messages,
          });
        },
      },
      "/api/chats/:chatId/title": {
        PUT: async (request: RouteRequest<{ chatId: string }>) => {
          const body = (await readJsonObject(request)) as { title?: string };
          const updatedChat = database.updateChatTitle(request.params.chatId, body.title ?? "");

          if (!updatedChat) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          return Response.json({
            chat: updatedChat,
            dbRevision: database.getRevision(),
          });
        },
      },
      "/api/chats/:chatId/auto-name": {
        POST: async (request: RouteRequest<{ chatId: string }>) => {
          assertTrustedWriteRequest(request);
          const config = await configStore.getConfig();
          const persistedChat = database.getChat(request.params.chatId);

          if (!persistedChat) {
            return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
          }

          if (!config.autoNamingEnabled || persistedChat.chat.title !== "New chat") {
            return Response.json({
              canceled: false,
              chat: persistedChat.chat,
              dbRevision: database.getRevision(),
              generated: false,
            });
          }

          const prompt = buildAutoNamePrompt(persistedChat.messages);

          if (!prompt) {
            return Response.json({
              canceled: false,
              chat: persistedChat.chat,
              dbRevision: database.getRevision(),
              generated: false,
            });
          }

          try {
            const completionResponse = await llamaServerManager.proxyCompletion(
              {
                cache_prompt: false,
                n_predict: 24,
                prompt,
                stop: ["\n"],
                stream: false,
                temperature: 0.2,
              },
              request.signal,
              "background",
            );

            if (completionResponse.status === 499) {
              return Response.json({
                canceled: true,
                chat: persistedChat.chat,
                dbRevision: database.getRevision(),
                generated: false,
              });
            }

            if (completionResponse.status === 409) {
              debugLogService.serverLog(
                `Auto-naming could not run for chat ${request.params.chatId}: ${await readBackendResponseErrorMessage(completionResponse.clone())}`,
              );

              return Response.json({
                canceled: true,
                chat: persistedChat.chat,
                dbRevision: database.getRevision(),
                generated: false,
              });
            }

            if (!completionResponse.ok) {
              debugLogService.serverLog(
                `Auto-naming failed for chat ${request.params.chatId}: ${await readBackendResponseErrorMessage(completionResponse.clone())}`,
              );
              return completionResponse;
            }

            const completionPayload = (await completionResponse.json()) as { content?: unknown };
            const nextTitle =
              typeof completionPayload.content === "string"
                ? normalizeGeneratedChatTitle(completionPayload.content)
                : null;

            if (!nextTitle) {
              debugLogService.serverLog(
                `Auto-naming returned no usable title for chat ${request.params.chatId}.`,
              );

              return Response.json({
                canceled: false,
                chat: persistedChat.chat,
                dbRevision: database.getRevision(),
                generated: false,
              });
            }

            const updatedChat = database.updateChatTitleIfMatch(
              request.params.chatId,
              "New chat",
              nextTitle,
            );

            if (!updatedChat) {
              const currentChat = database.getChat(request.params.chatId);

              return Response.json({
                canceled: false,
                chat: currentChat?.chat ?? persistedChat.chat,
                dbRevision: database.getRevision(),
                generated: false,
              });
            }

            return Response.json({
              canceled: false,
              chat: updatedChat,
              dbRevision: database.getRevision(),
              generated: true,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown auto-naming error.";

            debugLogService.serverLog(
              `Auto-naming failed for chat ${request.params.chatId}: ${errorMessage}`,
            );
            throw error;
          }
        },
      },
      "/api/presets/system/:modelId": {
        GET: (request: RouteRequest<{ modelId: string }>) =>
          Response.json({
            dbRevision: database.getRevision(),
            presets: database.listSystemPromptPresets(request.params.modelId),
          }),
        POST: async (request: RouteRequest<{ modelId: string }>) => {
          const body = (await readJsonObject(request)) as {
            jinjaTemplateOverride?: string;
            name?: string;
            systemPrompt?: string;
            thinkingTags?: { endString?: string; startString?: string };
          };

          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            return createErrorResponse(400, "System prompt preset name is required.");
          }

          if (!isThinkingTagPayload(body.thinkingTags)) {
            return createErrorResponse(400, "System prompt presets require valid thinking tags.");
          }

          const preset = database.createSystemPromptPreset(request.params.modelId, {
            ...(typeof body.jinjaTemplateOverride === "string"
              ? { jinjaTemplateOverride: body.jinjaTemplateOverride }
              : {}),
            name: body.name,
            systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
            thinkingTags: body.thinkingTags,
          });

          return Response.json(
            {
              dbRevision: database.getRevision(),
              preset,
            },
            { status: 201 },
          );
        },
      },
      "/api/presets/system/item/:presetId": {
        PUT: async (request: RouteRequest<{ presetId: string }>) => {
          const body = (await readJsonObject(request)) as {
            jinjaTemplateOverride?: string;
            name?: string;
            systemPrompt?: string;
            thinkingTags?: { endString?: string; startString?: string };
          };

          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            return createErrorResponse(400, "System prompt preset name is required.");
          }

          if (!isThinkingTagPayload(body.thinkingTags)) {
            return createErrorResponse(400, "System prompt presets require valid thinking tags.");
          }

          const preset = database.updateSystemPromptPreset(request.params.presetId, {
            ...(typeof body.jinjaTemplateOverride === "string"
              ? { jinjaTemplateOverride: body.jinjaTemplateOverride }
              : {}),
            name: body.name,
            systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
            thinkingTags: body.thinkingTags,
          });

          if (!preset) {
            return createErrorResponse(404, `Preset not found: ${request.params.presetId}`);
          }

          return Response.json({
            dbRevision: database.getRevision(),
            preset,
          });
        },
        DELETE: (request: RouteRequest<{ presetId: string }>) => {
          assertTrustedWriteRequest(request);
          const result = database.deleteSystemPromptPreset(request.params.presetId);

          if (!result.deleted && result.reason === "not_found") {
            return createErrorResponse(404, `Preset not found: ${request.params.presetId}`);
          }

          if (!result.deleted && result.reason === "last_preset") {
            return createErrorResponse(409, "At least one system prompt preset must remain.");
          }

          return Response.json({
            dbRevision: database.getRevision(),
            deleted: true,
            modelId: result.modelId,
            promotedDefaultId: result.promotedDefaultId,
          });
        },
      },
      "/api/presets/system/item/:presetId/default": {
        POST: (request: RouteRequest<{ presetId: string }>) => {
          assertTrustedWriteRequest(request);
          const preset = database.setDefaultSystemPromptPreset(request.params.presetId);

          if (!preset) {
            return createErrorResponse(404, `Preset not found: ${request.params.presetId}`);
          }

          return Response.json({
            dbRevision: database.getRevision(),
            preset,
          });
        },
      },
      "/api/presets/load/:modelId": {
        GET: (request: RouteRequest<{ modelId: string }>) =>
          Response.json({
            dbRevision: database.getRevision(),
            presets: database.listLoadInferencePresets(request.params.modelId),
          }),
        POST: async (request: RouteRequest<{ modelId: string }>) => {
          const body = (await readJsonObject(request)) as {
            name?: string;
            settings?: LoadInferenceSettings;
          };

          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            return createErrorResponse(400, "Load preset name is required.");
          }

          if (!isLoadSettingsPayload(body.settings)) {
            return createErrorResponse(400, "Load presets require a complete settings payload.");
          }

          const loadSettingsError = validateLoadInferenceSettings(body.settings);

          if (loadSettingsError) {
            return createErrorResponse(400, loadSettingsError);
          }

          const preset = database.createLoadInferencePreset(request.params.modelId, {
            name: body.name,
            settings: body.settings,
          });

          return Response.json(
            {
              dbRevision: database.getRevision(),
              preset,
            },
            { status: 201 },
          );
        },
      },
      "/api/presets/load/item/:presetId": {
        PUT: async (request: RouteRequest<{ presetId: string }>) => {
          const body = (await readJsonObject(request)) as {
            name?: string;
            settings?: LoadInferenceSettings;
          };

          if (typeof body.name !== "string" || body.name.trim().length === 0) {
            return createErrorResponse(400, "Load preset name is required.");
          }

          if (!isLoadSettingsPayload(body.settings)) {
            return createErrorResponse(400, "Load presets require a complete settings payload.");
          }

          const loadSettingsError = validateLoadInferenceSettings(body.settings);

          if (loadSettingsError) {
            return createErrorResponse(400, loadSettingsError);
          }

          const preset = database.updateLoadInferencePreset(request.params.presetId, {
            name: body.name,
            settings: body.settings,
          });

          if (!preset) {
            return createErrorResponse(404, `Preset not found: ${request.params.presetId}`);
          }

          return Response.json({
            dbRevision: database.getRevision(),
            preset,
          });
        },
        DELETE: (request: RouteRequest<{ presetId: string }>) => {
          assertTrustedWriteRequest(request);
          const result = database.deleteLoadInferencePreset(request.params.presetId);

          if (!result.deleted && result.reason === "not_found") {
            return createErrorResponse(404, `Preset not found: ${request.params.presetId}`);
          }

          if (!result.deleted && result.reason === "last_preset") {
            return createErrorResponse(409, "At least one load preset must remain.");
          }

          return Response.json({
            dbRevision: database.getRevision(),
            deleted: true,
            modelId: result.modelId,
            promotedDefaultId: result.promotedDefaultId,
          });
        },
      },
      "/api/presets/load/item/:presetId/default": {
        POST: (request: RouteRequest<{ presetId: string }>) => {
          assertTrustedWriteRequest(request);
          const preset = database.setDefaultLoadInferencePreset(request.params.presetId);

          if (!preset) {
            return createErrorResponse(404, `Preset not found: ${request.params.presetId}`);
          }

          return Response.json({
            dbRevision: database.getRevision(),
            preset,
          });
        },
      },
      "/api/debug/clear": {
        POST: (request) => {
          assertTrustedWriteRequest(request);
          debugLogService.clear();

          return Response.json({ ok: true });
        },
      },
      "/api/tools": {
        GET: async () =>
          Response.json({
            tools: await toolRegistry.listTools(),
          }),
      },
      "/api/tools/refresh": {
        POST: async (request) => {
          assertTrustedWriteRequest(request);
          return Response.json({
            tools: await toolRegistry.refreshTools(),
          });
        },
      },
      "/api/tools/open-folder": {
        POST: async (request) => {
          assertTrustedWriteRequest(request);
          openDirectoryInExplorer(applicationPaths.toolsDir);

          return Response.json({
            ok: true,
            path: applicationPaths.toolsDir,
          });
        },
      },
      "/api/generate/stop": {
        POST: async (request) => {
          assertTrustedWriteRequest(request);
          const stopped = await llamaServerManager.stopGeneration();

          return Response.json({ stopped });
        },
      },
      "/api/media/upload": {
        POST: async (request: RouteRequest<{}>, server) => {
          server.timeout(request, 0);

          return await handleMediaUpload(request);
        },
      },
      "/api/media/pending": {
        DELETE: async (request: RouteRequest<{}>) => {
          const body = await readJsonObject(request);
          const chatIdValue = body["chatId"];
          const messageIdValue = body["messageId"];
          const attachmentIdsValue = body["attachmentIds"];

          if (typeof chatIdValue !== "string" || chatIdValue.trim().length === 0) {
            return createErrorResponse(400, "Missing required field: chatId.");
          }

          if (typeof messageIdValue !== "string" || messageIdValue.trim().length === 0) {
            return createErrorResponse(400, "Missing required field: messageId.");
          }

          const messageId = messageIdValue.trim();

          if (!isUuid(messageId)) {
            return createErrorResponse(400, "messageId must be a valid UUID.");
          }

          const chat = database.getChat(chatIdValue);

          if (!chat) {
            return createErrorResponse(404, `Chat not found: ${chatIdValue}`);
          }

          const attachmentIds = readAttachmentIds(attachmentIdsValue);
          const pendingAttachments = database
            .listPendingAttachmentsForMessage(chatIdValue, messageId)
            .filter(
              (attachment) => attachmentIds.length === 0 || attachmentIds.includes(attachment.id),
            );

          if (pendingAttachments.length === 0) {
            return Response.json({
              dbRevision: database.getRevision(),
              deletedAttachmentIds: [],
            });
          }

          try {
            await deleteAttachmentFiles(pendingAttachments);
            const deletedAttachmentIds = pendingAttachments.map((attachment) => attachment.id);
            database.deletePendingAttachments(deletedAttachmentIds);

            return Response.json({
              dbRevision: database.getRevision(),
              deletedAttachmentIds,
            });
          } catch (error) {
            const pendingAttachmentIds = pendingAttachments.map((attachment) => attachment.id);

            database.markPendingAttachmentsAbandoned(
              pendingAttachmentIds,
              error instanceof Error ? error.message : String(error),
            );

            return createErrorResponse(
              500,
              `Failed to delete pending attachment artifact(s): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        },
      },
      "/api/*": false,
    },
    fetch: async (request, activeServer) => {
      const requestUrl = new URL(request.url);

      if (
        developmentProxyMode &&
        (request.method === "GET" || request.method === "HEAD") &&
        !requestUrl.pathname.startsWith("/api/")
      ) {
        const frontendOrigin =
          process.env["LOCAL_LLM_GUI_FRONTEND_ORIGIN"] ?? "http://127.0.0.1:3000";
        const redirectUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, frontendOrigin);

        return Response.redirect(redirectUrl.toString(), 307);
      }

      if (requestUrl.pathname === "/api/events/debug") {
        return debugLogService.subscribe(request, activeServer);
      }

      if (requestUrl.pathname === "/api/events/runtime") {
        return runtimeBroadcaster.subscribe(request, activeServer);
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate/chat") {
        activeServer.timeout(request, 0);

        const body = await readJsonObject(request);
        const chatId =
          typeof body["chatId"] === "string" && body["chatId"].trim().length > 0
            ? body["chatId"]
            : null;
        const inlineMessageCount = Array.isArray(body["messages"]) ? body["messages"].length : 0;

        return await runWithForegroundGenerationSession(chatId, request.signal, async (signal) => {
          debugLogService.verboseServerLog(
            `Accepted chat generation request${chatId ? ` for chat ${chatId}` : ""} with ${String(inlineMessageCount)} inline message(s).`,
          );

          return await createChatGenerationResponse({
            database,
            debugLogService,
            llamaServerManager,
            requestBody: body,
            signal,
            toolRegistry,
          });
        });
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/generate/completion") {
        activeServer.timeout(request, 0);

        const body = await readJsonObject(request);
        const chatId = typeof body["chatId"] === "string" ? body["chatId"] : null;

        return await runWithForegroundGenerationSession(
          chatId,
          request.signal,
          async (signal) => await llamaServerManager.proxyCompletion(body, signal, "foreground"),
        );
      }

      if (request.method === "POST") {
        const toolConfirmationMatch = requestUrl.pathname.match(
          /^\/api\/chats\/([^/]+)\/tool-confirmation$/,
        );

        if (toolConfirmationMatch) {
          activeServer.timeout(request, 0);

          const body = (await readJsonObject(request)) as {
            approved?: boolean;
            assistantMessageId?: string;
          };
          const chatId = decodeRequestPathComponent(toolConfirmationMatch[1] ?? "");

          if (
            typeof body.assistantMessageId !== "string" ||
            body.assistantMessageId.trim().length === 0
          ) {
            return createErrorResponse(400, "Missing required field: assistantMessageId.");
          }

          if (typeof body.approved !== "boolean") {
            return createErrorResponse(400, "Missing required field: approved.");
          }

          const approved = body.approved;
          const assistantMessageId = body.assistantMessageId;

          return await runWithForegroundGenerationSession(
            chatId,
            request.signal,
            async (signal) =>
              await createToolConfirmationResponse({
                approved,
                assistantMessageId,
                chatId,
                database,
                debugLogService,
                llamaServerManager,
                signal,
                toolRegistry,
              }),
          );
        }
      }

      const staticAssetResponse = await tryServeStaticAsset(requestUrl.pathname, request.method);

      if (staticAssetResponse) {
        return staticAssetResponse;
      }

      if (
        request.method === "GET" &&
        !requestUrl.pathname.startsWith("/api/") &&
        prefersHtmlResponse(request)
      ) {
        const indexResponse = createStaticAssetResponse("/index.html");

        if (indexResponse) {
          return indexResponse;
        }
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        return createErrorResponse(404, "Unknown API route.");
      }

      return new Response("Not Found", { status: 404 });
    },
    error: (error) => {
      if (error instanceof HttpError) {
        return createErrorResponse(error.status, error.message);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      debugLogService.serverLog(`Server error: ${errorMessage}`);

      return createErrorResponse(500, errorMessage);
    },
  });

  debugLogService.serverLog(`Backend listening on ${String(server.url)}.`);
  console.log(`Local LLM GUI is running at ${String(server.url)}.`);
  console.log(
    "Close this terminal window to stop the app and release model memory; any open browser tab will disconnect.",
  );

  if (developmentProxyMode) {
    console.log("Development frontend should be opened at http://127.0.0.1:3000.");
  }

  if (process.env["LOCAL_LLM_GUI_DISABLE_BROWSER"] !== "1" && !developmentProxyMode) {
    openBrowser(String(server.url));
  }

  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signalName, () => {
      llamaServerManager.prepareForShutdown();
      void handleShutdownSignal(signalName);
    });
  }

  process.on("exit", () => {
    if (staleArtifactSweepHandle) {
      clearInterval(staleArtifactSweepHandle);
      staleArtifactSweepHandle = null;
    }

    llamaServerManager.prepareForShutdown();
    llamaServerManager.disposeOnExit();
  });
}

/**
 * Handles OS shutdown signals by gracefully unloading the model,
 * stopping the server, and terminating the process.
 *
 * @param signalName - The signal that triggered the shutdown (e.g. `"SIGINT"`).
 */
const handleShutdownSignal = async (signalName: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  debugLogService.serverLog(`Received ${signalName}; shutting down.`);

  let forcedBackendExitHandle: ReturnType<typeof setTimeout> | null = null;
  let shutdownExitCode = 0;

  const forcedExitHandle = setTimeout(() => {
    debugLogService.serverLog(
      "Shutdown timed out; forcing llama-server termination before exiting the backend.",
    );
    llamaServerManager.prepareForShutdown();
    llamaServerManager.disposeOnExit();
    void server.stop(true).catch(() => undefined);

    forcedBackendExitHandle = setTimeout(() => {
      debugLogService.serverLog("Forced shutdown cleanup timed out; exiting backend process.");
      process.exit(1);
    }, 2_000);
    forcedBackendExitHandle.unref?.();
  }, 10_000);

  forcedExitHandle.unref?.();

  try {
    if (staleArtifactSweepHandle) {
      clearInterval(staleArtifactSweepHandle);
      staleArtifactSweepHandle = null;
    }

    await llamaServerManager.unload(signalName);
    await server.stop(true);
  } catch (error) {
    shutdownExitCode = 1;
    const errorMessage = error instanceof Error ? error.message : String(error);

    debugLogService.serverLog(`Shutdown failed: ${errorMessage}`);
  } finally {
    clearTimeout(forcedExitHandle);

    if (forcedBackendExitHandle) {
      clearTimeout(forcedBackendExitHandle);
      forcedBackendExitHandle = null;
    }

    process.exit(shutdownExitCode === 0 ? 0 : 1);
  }
};

async function runPeriodicStaleArtifactSweep(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  await sweepStartupPendingAttachments({
    applicationPaths,
    database,
    log: (message) => {
      debugLogService.serverLog(message);
    },
    minimumAgeMs: STALE_ARTIFACT_MAX_AGE_MS,
  });

  const activeTemplateFilePath = llamaServerManager.getActiveTemplateFilePath();

  await sweepStartupTemplateOverrideFiles({
    applicationPaths,
    log: (message) => {
      debugLogService.serverLog(message);
    },
    minimumAgeMs: STALE_ARTIFACT_MAX_AGE_MS,
    protectedFilePaths: activeTemplateFilePath ? [activeTemplateFilePath] : [],
  });
}

/**
 * Creates a JSON error response with the given HTTP status code.
 *
 * @param status - HTTP status code.
 * @param errorMessage - Human-readable error message.
 * @returns JSON response with an `error` field.
 */
function createErrorResponse(status: number, errorMessage: string): Response {
  return Response.json(
    {
      error: errorMessage,
    },
    { status },
  );
}

async function readBackendResponseErrorMessage(response: {
  status: number;
  text: () => Promise<string>;
}): Promise<string> {
  const responseText = (await response.text()).trim();

  if (responseText.length === 0) {
    return `Request failed with status ${String(response.status)}.`;
  }

  try {
    const parsedPayload = JSON.parse(responseText) as unknown;

    if (parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload)) {
      const errorValue = (parsedPayload as Record<string, unknown>)["error"];

      if (typeof errorValue === "string" && errorValue.trim().length > 0) {
        return errorValue;
      }

      const messageValue = (parsedPayload as Record<string, unknown>)["message"];

      if (typeof messageValue === "string" && messageValue.trim().length > 0) {
        return messageValue;
      }
    }
  } catch {
    // Fall back to the raw response text when the payload is not JSON.
  }

  return responseText;
}

async function runWithForegroundGenerationSession(
  chatId: string | null,
  downstreamSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const generationSession = llamaServerManager.beginForegroundGeneration(chatId, downstreamSignal);

  if (generationSession instanceof Response) {
    return generationSession;
  }

  try {
    const response = await operation(generationSession.signal);

    return wrapForegroundGenerationResponse(response, generationSession.complete);
  } catch (error) {
    generationSession.complete();
    throw error;
  }
}

function wrapForegroundGenerationResponse(response: Response, complete: () => void): Response {
  if (!isEventStreamResponse(response) || !response.body) {
    complete();
    return response;
  }

  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let completed = false;
  const finalize = (): void => {
    if (!completed) {
      completed = true;
      complete();
    }
  };

  const createReader = (): ReadableStreamDefaultReader<Uint8Array> => {
    try {
      return response.body!.getReader();
    } catch (error) {
      finalize();
      throw error;
    }
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      async cancel(reason) {
        try {
          if (upstreamReader) {
            await upstreamReader.cancel(reason);
          }
        } finally {
          finalize();
        }
      },
      async start(controller) {
        try {
          upstreamReader = createReader();

          while (true) {
            const readResult = await upstreamReader.read();

            if (readResult.done) {
              break;
            }

            controller.enqueue(readResult.value);
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          finalize();
        }
      },
    }),
    {
      headers: new Headers(response.headers),
      status: response.status,
      statusText: response.statusText,
    },
  );
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("Content-Type")?.includes("text/event-stream") ?? false;
}

function createChatsExportResponse(request: Request): Response {
  const requestUrl = new URL(request.url);
  const format = requestUrl.searchParams.get("format") ?? "json";
  const exportedAt = new Date().toISOString();

  if (format === "json") {
    return new Response(createJsonChatsExportStream(request.signal, exportedAt), {
      headers: {
        "Content-Disposition": 'attachment; filename="chats-export.json"',
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }

  if (format === "markdown") {
    return new Response(createMarkdownChatsExportStream(request.signal, exportedAt), {
      headers: {
        "Content-Disposition": 'attachment; filename="chats-export.md"',
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  }

  return createErrorResponse(400, "Unsupported export format.");
}

function createJsonChatsExportStream(
  requestSignal: AbortSignal,
  exportedAt: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chatsIterator = database.exportChatsIterator();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let first = true;
  let streamClosed = false;

  const finalize = (): void => {
    requestSignal.removeEventListener("abort", handleAbort);
    controllerRef = null;
  };
  const closeController = (): void => {
    if (streamClosed || !controllerRef) {
      finalize();
      return;
    }

    streamClosed = true;
    controllerRef.close();
    finalize();
  };
  const handleAbort = (): void => {
    closeController();
  };

  requestSignal.addEventListener("abort", handleAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode(`{"exportedAt":${JSON.stringify(exportedAt)},"chats":[`));

      if (requestSignal.aborted) {
        closeController();
      }
    },
    async pull(controller) {
      controllerRef = controller;

      if (streamClosed || requestSignal.aborted) {
        closeController();
        return;
      }

      const nextEntry = chatsIterator.next();

      if (nextEntry.done) {
        controller.enqueue(encoder.encode("]}"));
        streamClosed = true;
        controller.close();
        finalize();
        return;
      }

      const sanitized = {
        chat: nextEntry.value.chat,
        messages: nextEntry.value.messages.map((message) => sanitizeExportMessage(message)),
      };

      controller.enqueue(encoder.encode(`${first ? "" : ","}${JSON.stringify(sanitized)}`));
      first = false;
    },
    cancel() {
      streamClosed = true;
      finalize();
    },
  });
}

function createMarkdownChatsExportStream(
  requestSignal: AbortSignal,
  exportedAt: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chatsIterator = database.exportChatsIterator();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let emittedChat = false;
  let streamClosed = false;

  const finalize = (): void => {
    requestSignal.removeEventListener("abort", handleAbort);
    controllerRef = null;
  };
  const closeController = (): void => {
    if (streamClosed || !controllerRef) {
      finalize();
      return;
    }

    streamClosed = true;
    controllerRef.close();
    finalize();
  };
  const handleAbort = (): void => {
    closeController();
  };

  requestSignal.addEventListener("abort", handleAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode(`# Chats Export\n\nExported at: ${exportedAt}\n\n`));

      if (requestSignal.aborted) {
        closeController();
      }
    },
    async pull(controller) {
      controllerRef = controller;

      if (streamClosed || requestSignal.aborted) {
        closeController();
        return;
      }

      const nextEntry = chatsIterator.next();

      if (nextEntry.done) {
        if (!emittedChat) {
          controller.enqueue(encoder.encode("No chats available."));
        }

        streamClosed = true;
        controller.close();
        finalize();
        return;
      }

      const renderedChat = renderSingleChatMarkdown(
        nextEntry.value.chat,
        nextEntry.value.messages.map(sanitizeExportMessage),
      );

      controller.enqueue(encoder.encode(emittedChat ? `\n\n---\n\n${renderedChat}` : renderedChat));
      emittedChat = true;
    },
    cancel() {
      streamClosed = true;
      finalize();
    },
  });
}

function sanitizeExportMessage(message: ChatMessageRecord): Omit<
  ChatMessageRecord,
  "mediaAttachments"
> & {
  mediaAttachments: Array<
    Omit<MediaAttachmentRecord, "filePath"> & {
      filePath?: never;
    }
  >;
} {
  return {
    ...message,
    mediaAttachments: message.mediaAttachments.map((attachment) => ({
      byteSize: attachment.byteSize,
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
    })),
  };
}

function renderSingleChatMarkdown(
  chat: ChatSummary,
  messages: ReturnType<typeof sanitizeExportMessage>[],
): string {
  const transcript = messages
    .map((message) => {
      const attachmentSection =
        message.mediaAttachments.length === 0
          ? ""
          : `\n\nAttachments:\n${message.mediaAttachments
              .map(
                (attachment) =>
                  `- ${attachment.kind}: ${attachment.fileName} (${attachment.mimeType}, ${attachment.byteSize.toLocaleString()} bytes)`,
              )
              .join("\n")}`;
      const reasoningSection = message.reasoningContent
        ? `\n\nReasoning:\n\n${message.reasoningContent}`
        : "";

      return `## ${message.role}\n\n${message.content || "(empty)"}\n\nCreated: ${message.createdAt}${reasoningSection}${attachmentSection}`;
    })
    .join("\n\n---\n\n");

  return `# ${chat.title}\n\nChat ID: ${chat.id}\n\nCreated: ${chat.createdAt}\nUpdated: ${chat.updatedAt}\n${chat.lastUsedModelId ? `Last model: ${chat.lastUsedModelId}\n` : ""}\n${transcript}`;
}

const MAX_JSON_BODY_BYTES = (() => {
  const envValue = Number(process.env["LOCAL_LLM_GUI_MAX_JSON_BODY_BYTES"] ?? "");

  return Number.isFinite(envValue) && envValue > 0
    ? envValue
    : 10 * 1024 * 1024;
})();
const MAX_MULTIPART_BODY_BYTES = 50 * 1024 * 1024;

function getTrustedWriteOrigins(): Set<string> {
  const rawOrigins = process.env["LOCAL_LLM_GUI_TRUSTED_ORIGINS"]?.split(",") ?? [];
  const trustedOrigins = new Set<string>();

  for (const rawOrigin of rawOrigins) {
    const trimmedOrigin = rawOrigin.trim();

    if (!trimmedOrigin) {
      continue;
    }

    try {
      trustedOrigins.add(new URL(trimmedOrigin).origin);
    } catch {
      // Ignore invalid trusted origin configuration entries.
    }
  }

  return trustedOrigins;
}

/**
 * Parses the request body as a JSON object, rejecting malformed JSON
 * or non-object payloads with a 400 response.
 *
 * @param request - Incoming HTTP request.
 * @param maxBytes - Maximum request body size in bytes for this route.
 * @returns Parsed JSON object.
 */
async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  assertJsonContentType(request);
  assertTrustedWriteRequest(request);

  const contentLength = request.headers.get("Content-Length");

  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new HttpError(413, `Request body exceeds limit of ${maxBytes} bytes.`);
  }

  try {
    const requestBodyText = await readRequestTextWithLimit(request, maxBytes);

    if (requestBodyText.trim().length === 0) {
      throw new HttpError(400, "Request body is required.");
    }

    const parsedBody = JSON.parse(requestBodyText) as unknown;

    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new HttpError(400, "Request bodies must be JSON objects.");
    }

    return parsedBody as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let bodyText = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    byteCount += value.byteLength;

    if (byteCount > maxBytes) {
      throw new HttpError(413, `Request body exceeds limit of ${maxBytes} bytes.`);
    }

    bodyText += decoder.decode(value, { stream: true });
  }

  bodyText += decoder.decode();

  return bodyText;
}

/**
 * Rejects browser-originated write requests unless they come from the
 * application origin or the configured development frontend origin.
 *
 * @param request - Incoming HTTP request.
 * @throws {HttpError} When a browser-originated write targets the backend from an untrusted origin.
 */
function assertTrustedWriteRequest(request: Request): void {
  const trustedWriteSecret = process.env["LOCAL_LLM_GUI_WRITE_SECRET"]?.trim();
  const secretHeader = request.headers.get("x-local-llm-gui-secret");

  if (trustedWriteSecret) {
    if (secretHeader !== trustedWriteSecret) {
      throw new HttpError(403, "Write requests require a valid trusted secret.");
    }

    return;
  }

  const fetchSiteHeader = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase();

  if (fetchSiteHeader === "cross-site") {
    throw new HttpError(403, "Cross-origin write requests are not allowed.");
  }

  const originHeader = request.headers.get("Origin");
  const allowedOrigins = new Set<string>([new URL(request.url).origin]);

  if (developmentProxyMode) {
    allowedOrigins.add(process.env["LOCAL_LLM_GUI_FRONTEND_ORIGIN"] ?? "http://127.0.0.1:3000");
  }

  for (const trustedOrigin of getTrustedWriteOrigins()) {
    allowedOrigins.add(trustedOrigin);
  }

  if (!originHeader) {
    throw new HttpError(403, "Write requests require a trusted origin or secret.");
  }

  if (!allowedOrigins.has(originHeader)) {
    throw new HttpError(403, "Cross-origin write requests are not allowed.");
  }
}

/**
 * Ensures a non-empty JSON route request body declares `application/json`.
 *
 * @param request - Incoming HTTP request.
 * @throws {HttpError} When the request body does not declare `application/json`.
 */
function assertJsonContentType(request: Request): void {
  const contentTypeHeader = request.headers.get("Content-Type");
  const normalizedContentType = contentTypeHeader?.split(";")[0]?.trim().toLowerCase();

  if (normalizedContentType !== "application/json") {
    throw new HttpError(415, "JSON routes require the Content-Type header application/json.");
  }
}

/**
 * Ensures media uploads use a trusted browser origin and multipart bodies.
 *
 * @param request - Incoming HTTP request.
 * @throws {HttpError} When the upload request is cross-origin or not multipart.
 */
function assertMultipartFormRequest(request: Request): void {
  assertTrustedWriteRequest(request);

  const contentTypeHeader = request.headers.get("Content-Type") ?? "";

  if (!contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Media uploads require multipart/form-data.");
  }
}

type RequestFormData = Awaited<ReturnType<Request["formData"]>>;

async function readMultipartFormData(request: Request): Promise<RequestFormData> {
  assertMultipartFormRequest(request);

  const contentLengthHeader = request.headers.get("Content-Length");

  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);

    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new HttpError(400, "Invalid Content-Length header for multipart upload.");
    }

    if (contentLength > MAX_MULTIPART_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds limit of ${MAX_MULTIPART_BODY_BYTES} bytes.`);
    }
  }

  try {
    return await request.formData();
  } catch {
    throw new HttpError(400, "The upload body is not valid multipart/form-data.");
  }
}

async function writeFileStream(targetFilePath: string, stream: ReadableStream<Uint8Array>): Promise<void> {
  const fileHandle = await open(targetFilePath, "w");

  try {
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        await fileHandle.write(new Uint8Array(value));
      }
    }
  } finally {
    await fileHandle.close();
  }
}

/**
 * Resolves the load/inference preset for a model load request.
 *
 * @param model - The target model record.
 * @param database - Application database.
 * @param loadPresetId - Optional explicit preset ID; falls back to the default.
 * @returns The resolved preset, or `null` if not found.
 */
function resolveLoadPreset(
  model: ModelRecord,
  database: AppDatabase,
  loadPresetId?: string,
): LoadInferencePreset | null {
  const preset = loadPresetId
    ? database.getLoadInferencePreset(loadPresetId)
    : database.getDefaultLoadInferencePreset(model.id);

  return preset?.modelId === model.id ? preset : null;
}

/**
 * Resolves the system prompt preset for a model load request.
 *
 * @param model - The target model record.
 * @param database - Application database.
 * @param systemPromptPresetId - Optional explicit preset ID; falls back to the default.
 * @returns The resolved preset, or `null` if not found.
 */
function resolveSystemPromptPreset(
  model: ModelRecord,
  database: AppDatabase,
  systemPromptPresetId?: string,
): SystemPromptPreset | null {
  const preset = systemPromptPresetId
    ? database.getSystemPromptPreset(systemPromptPresetId)
    : database.getDefaultSystemPromptPreset(model.id);

  return preset?.modelId === model.id ? preset : null;
}

/**
 * Attempts to serve a static asset from disk (the `out/` directory) or
 * from the embedded static asset map for compiled builds.
 *
 * @param requestPathname - URL pathname of the request.
 * @param requestMethod - HTTP method (only `GET`/`HEAD` are served).
 * @returns A static asset response, or `null` if no asset matches.
 */
async function tryServeStaticAsset(
  requestPathname: string,
  requestMethod: string,
): Promise<Response | null> {
  if (requestMethod !== "GET" && requestMethod !== "HEAD") {
    return null;
  }

  const normalizedPath = requestPathname === "/" ? "/index.html" : requestPathname;
  const relativePath = decodeRequestPathComponent(normalizedPath).replace(/^\/+/, "");
  const candidatePath = path.join(applicationPaths.staticOutDir, relativePath);
  const relativeCandidate = path.relative(applicationPaths.staticOutDir, candidatePath);

  if (relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) {
    return null;
  }

  const staticAssetResponse = createStaticAssetResponse(normalizedPath, candidatePath);

  if (!staticAssetResponse) {
    return null;
  }

  return staticAssetResponse;
}

/**
 * Lazily imports the generated embedded static file manifest and builds
 * a `Map` keyed by normalised request path for fast asset lookup.
 *
 * @returns A read-only map from request path to `Bun.file()` handle.
 */
async function createEmbeddedStaticAssetMap(): Promise<
  ReadonlyMap<string, ReturnType<typeof Bun.file>>
> {
  const { EMBEDDED_STATIC_FILES } = await import("../generated/embeddedStatic.generated");

  return new Map(
    EMBEDDED_STATIC_FILES.map((asset) => [
      normalizeStaticAssetRequestPath(asset.requestPath),
      Bun.file(asset.filePath),
    ]),
  );
}

/**
 * Constructs a static asset response from either a disk path or the
 * embedded asset map.
 *
 * @param requestPathname - Normalised URL pathname (e.g. `"/index.html"`).
 * @param diskCandidatePath - Optional absolute filesystem path to try first.
 * @returns A {@link Response} wrapping the file, or `null` if no asset exists.
 */
function createStaticAssetResponse(
  requestPathname: string,
  diskCandidatePath?: string,
): Response | null {
  if (diskCandidatePath) {
    const diskExists =
      staticAssetDiskExistsCache.get(diskCandidatePath) ?? existsSync(diskCandidatePath);
    staticAssetDiskExistsCache.set(diskCandidatePath, diskExists);

    if (diskExists) {
      return new Response(Bun.file(diskCandidatePath));
    }
  }

  const normalizedPathname = normalizeStaticAssetRequestPath(requestPathname);
  const embeddedAsset = embeddedStaticAssets.get(normalizedPathname);

  return embeddedAsset ? new Response(embeddedAsset) : null;
}

/**
 * Normalises a request pathname for consistent static asset map lookups,
 * converting backslashes to forward slashes and mapping `"/"` to `"/index.html"`.
 *
 * @param requestPathname - Raw URL pathname.
 * @returns Normalised pathname string.
 */
function normalizeStaticAssetRequestPath(requestPathname: string): string {
  const normalizedPathname = requestPathname.replaceAll("\\", "/");

  return normalizedPathname === "/" ? "/index.html" : normalizedPathname;
}

function decodeRequestPathComponent(value: string): string {
  const decodedValue = tryDecodeRequestPathComponent(value);

  if (decodedValue === null) {
    throw new HttpError(400, "The request URL contains malformed percent-encoding.");
  }

  return decodedValue;
}

/**
 * Resolves the HTTP port for the backend server from CLI arguments,
 * environment variables, or defaults to `0` (OS-assigned).
 *
 * @param runtimeArguments - CLI arguments passed to the process.
 * @returns A valid port number (0–65535).
 */
function resolveServerPort(runtimeArguments: string[]): number {
  let configuredPort: string | undefined;

  for (let argumentIndex = 0; argumentIndex < runtimeArguments.length; argumentIndex += 1) {
    const argument = runtimeArguments[argumentIndex];

    if (!argument) {
      continue;
    }

    if (argument === "--port") {
      configuredPort = runtimeArguments[argumentIndex + 1];
      break;
    }

    if (argument.startsWith("--port=")) {
      configuredPort = argument.slice("--port=".length);
      break;
    }
  }

  const parsedPort = Number(configuredPort ?? process.env["LOCAL_LLM_GUI_BACKEND_PORT"] ?? "4000");

  return Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 4000;
}

function parseNonNegativeInteger(value: string): number | null {
  const parsedValue = Number(value);

  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : null;
}

/**
 * Type guard that checks whether a value structurally resembles a
 * {@link LoadInferenceSettings} payload.
 *
 * @param value - Raw value from the request body.
 * @returns `true` if the value is a non-null object.
 */
function isLoadSettingsPayload(value: unknown): value is LoadInferenceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    isFiniteNumber(candidate["contextLength"]) &&
    isFiniteNumber(candidate["gpuLayers"]) &&
    isFiniteNumber(candidate["cpuThreads"]) &&
    isFiniteNumber(candidate["batchSize"]) &&
    isFiniteNumber(candidate["ubatchSize"]) &&
    isOptionalEnum(candidate["kvCacheTypeK"], KV_CACHE_TYPES) &&
    isOptionalEnum(candidate["kvCacheTypeV"], KV_CACHE_TYPES) &&
    typeof candidate["unifiedKvCache"] === "boolean" &&
    typeof candidate["offloadKvCache"] === "boolean" &&
    typeof candidate["useMmap"] === "boolean" &&
    typeof candidate["keepModelInMemory"] === "boolean" &&
    typeof candidate["flashAttention"] === "boolean" &&
    typeof candidate["fullSwaCache"] === "boolean" &&
    isOptionalFiniteNumber(candidate["ropeFrequencyBase"]) &&
    isOptionalFiniteNumber(candidate["ropeFrequencyScale"]) &&
    typeof candidate["contextShift"] === "boolean" &&
    isOptionalFiniteNumber(candidate["imageMinTokens"]) &&
    isOptionalFiniteNumber(candidate["imageMaxTokens"]) &&
    isFiniteNumber(candidate["seed"]) &&
    typeof candidate["thinkingEnabled"] === "boolean" &&
    isOptionalFiniteNumber(candidate["responseLengthLimit"]) &&
    isEnumValue(candidate["overflowStrategy"], OVERFLOW_STRATEGIES) &&
    Array.isArray(candidate["stopStrings"]) &&
    candidate["stopStrings"].every((entry) => typeof entry === "string") &&
    isFiniteNumber(candidate["temperature"]) &&
    isFiniteNumber(candidate["topK"]) &&
    isFiniteNumber(candidate["topP"]) &&
    isFiniteNumber(candidate["minP"]) &&
    isFiniteNumber(candidate["presencePenalty"]) &&
    isFiniteNumber(candidate["repeatPenalty"]) &&
    isEnumValue(candidate["structuredOutputMode"], STRUCTURED_OUTPUT_MODES) &&
    (candidate["structuredOutputSchema"] === undefined ||
      typeof candidate["structuredOutputSchema"] === "string")
  );
}

/**
 * Type guard that checks whether a value contains valid `startString`
 * and `endString` fields for a thinking-tag payload.
 *
 * @param value - Raw value from the request body.
 * @returns `true` if both string fields are present.
 */
function isThinkingTagPayload(value: unknown): value is { endString: string; startString: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { startString?: unknown }).startString === "string" &&
    typeof (value as { endString?: unknown }).endString === "string"
  );
}

/** Serves a persisted media attachment for transcript image/audio playback. */
function createMediaAttachmentResponse(
  request: RouteRequest<{ attachmentId: string; chatId: string }>,
  includeBody: boolean,
): Response {
  const attachment = database.getPersistedAttachment(
    request.params.chatId,
    request.params.attachmentId,
  );

  if (!attachment) {
    if (!database.chatExists(request.params.chatId)) {
      return createErrorResponse(404, `Chat not found: ${request.params.chatId}`);
    }

    return createErrorResponse(404, `Media attachment not found: ${request.params.attachmentId}`);
  }

  if (!existsSync(attachment.filePath)) {
    return createErrorResponse(404, `Media attachment not found: ${request.params.attachmentId}`);
  }

  return new Response(includeBody ? Bun.file(attachment.filePath) : null, {
    headers: {
      "Content-Length": String(attachment.byteSize),
      "Content-Type": attachment.mimeType,
      "Cache-Control": "public, max-age=604800, immutable",
      "Accept-Ranges": "bytes",
    },
  });
}

async function finalizePendingMessageAttachments(
  chatId: string,
  messageId: string,
  mediaAttachmentsValue: unknown,
): Promise<{
  finalAttachments: MediaAttachmentRecord[];
  pendingAttachments: MediaAttachmentRecord[];
}> {
  const attachmentIds = readRequestedAttachmentIds(mediaAttachmentsValue);

  if (attachmentIds.length === 0) {
    return {
      finalAttachments: [],
      pendingAttachments: [],
    };
  }

  const pendingAttachments = database.getPendingAttachments(chatId, messageId, attachmentIds);

  if (pendingAttachments.length !== attachmentIds.length) {
    throw new HttpError(
      400,
      "One or more uploaded attachments could not be resolved for this message.",
    );
  }

  const finalAttachments = await promotePendingAttachments({
    chatId,
    mediaDir: applicationPaths.mediaDir,
    messageId,
    pendingAttachments,
  });

  return {
    finalAttachments,
    pendingAttachments,
  };
}

function readRequestedAttachmentIds(mediaAttachmentsValue: unknown): string[] {
  if (mediaAttachmentsValue === undefined) {
    return [];
  }

  if (!Array.isArray(mediaAttachmentsValue)) {
    throw new HttpError(400, "mediaAttachments must be an array of uploaded attachment IDs.");
  }

  const attachmentIds: string[] = [];
  const seenAttachmentIds = new Set<string>();

  for (const attachmentValue of mediaAttachmentsValue) {
    if (!attachmentValue || typeof attachmentValue !== "object") {
      throw new HttpError(400, "mediaAttachments must contain attachment objects with IDs.");
    }

    const attachmentId = (attachmentValue as { id?: unknown }).id;

    if (typeof attachmentId !== "string" || attachmentId.trim().length === 0) {
      throw new HttpError(400, "Each media attachment must include a valid ID.");
    }

    if (seenAttachmentIds.has(attachmentId)) {
      throw new HttpError(400, "Duplicate media attachment IDs are not allowed.");
    }

    seenAttachmentIds.add(attachmentId);
    attachmentIds.push(attachmentId);
  }

  return attachmentIds;
}

function readAttachmentIds(attachmentIdsValue: unknown): string[] {
  if (attachmentIdsValue === undefined) {
    return [];
  }

  if (!Array.isArray(attachmentIdsValue)) {
    throw new HttpError(400, "attachmentIds must be an array of attachment IDs.");
  }

  const attachmentIds: string[] = [];
  const seenAttachmentIds = new Set<string>();

  for (const rawAttachmentId of attachmentIdsValue) {
    if (typeof rawAttachmentId !== "string" || rawAttachmentId.trim().length === 0) {
      throw new HttpError(400, "attachmentIds must contain non-empty string IDs.");
    }

    const attachmentId = rawAttachmentId.trim();

    if (seenAttachmentIds.has(attachmentId)) {
      throw new HttpError(400, "Duplicate attachment IDs are not allowed.");
    }

    seenAttachmentIds.add(attachmentId);
    attachmentIds.push(attachmentId);
  }

  return attachmentIds;
}

async function deleteAttachmentFiles(attachments: MediaAttachmentRecord[]): Promise<void> {
  for (const attachment of attachments) {
    await deleteAttachmentArtifacts(attachment);
  }
}

/**
 * Checks whether the request's Accept header indicates a preference
 * for HTML content, used by the SPA fallback handler.
 *
 * @param request - Incoming HTTP request.
 * @returns True if the client accepts text/html or wildcard.
 */
function prefersHtmlResponse(request: Request): boolean {
  const acceptHeader = request.headers.get("Accept") ?? "";

  return acceptHeader.includes("text/html") || acceptHeader.includes("*/*");
}

/**
 * Opens a directory in the user's native file explorer.
 * Uses cmd on Windows, open on macOS, and xdg-open on Linux.
 *
 * @param directoryPath - Absolute path to the directory to open.
 */
function openDirectoryInExplorer(directoryPath: string): void {
  const command: [string, ...string[]] =
    process.platform === "win32"
      ? ["explorer.exe", directoryPath]
      : process.platform === "darwin"
        ? ["open", directoryPath]
        : ["xdg-open", directoryPath];

  spawn(command[0], command.slice(1), {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/**
 * Launches the user's default web browser to the given URL.
 *
 * @param targetUrl - The URL to open in the browser.
 */
function openBrowser(targetUrl: string): void {
  const command =
    process.platform === "win32"
      ? ["explorer.exe", targetUrl]
      : process.platform === "darwin"
        ? ["open", targetUrl]
        : ["xdg-open", targetUrl];

  Bun.spawn(command, {
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
}

function getMaxUploadBytes(kind: MediaAttachmentKind): number {
  return getAttachmentUploadLimit(kind);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isEnumValue(value: unknown, allowedValues: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowedValues.has(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalEnum(value: unknown, allowedValues: ReadonlySet<string>): boolean {
  return value === undefined || isEnumValue(value, allowedValues);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}
