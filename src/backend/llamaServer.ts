import { open, unlink, writeFile } from "node:fs/promises";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  AppConfig,
  LoadInferencePreset,
  MediaAttachmentRecord,
  ModelRecord,
  RuntimeSnapshot,
  SystemPromptPreset,
  ThinkingTagSettings,
} from "../lib/contracts";
import { calculateRuntimeLoadTimeoutMs } from "../lib/runtimeLoad";
import {
  buildBinaryAttachmentReplayDescriptorFromFile,
  createContentPartFromBinaryAttachmentReplayDescriptor,
  loadBinaryAttachmentReplayDescriptor,
  persistBinaryAttachmentReplayDescriptor,
} from "./attachmentReplay";
import { DebugLogService } from "./debug";
import type { ApplicationPaths } from "./paths";
import { JsonSseBroadcaster } from "./sse";
import { consumeSseEvents, flushSseEvents } from "./sseParsing";

/** Maximum number of bytes from a text file attachment included in the prompt. */
const MAX_TEXT_ATTACHMENT_BYTES = 12_000;
/** Maximum total bytes of binary attachments (image + audio) inlined per request. */
const MAX_AGGREGATE_REPLAY_BYTES = 200 * 1024 * 1024;
const DEFAULT_RESPONSE_TOKEN_RESERVE = 256;
const MESSAGE_OVERHEAD_TOKEN_ESTIMATE = 8;
const DYNAMIC_LLAMA_SERVER_PORT = 0;
const MAX_PORT_BIND_ATTEMPTS = 3;
const TEXT_TOKEN_ESTIMATE_DIVISOR = 4;
const execFileAsync = promisify(execFile);
const llamaServerHelpTextCache = new Map<string, Promise<string | null>>();

/** Shape of the `/props` endpoint response, used to detect multimodal capabilities. */
interface LlamaServerPropsResponse {
  modalities?: unknown;
}

/** Bundled options required to load a model via {@link LlamaServerManager.loadModel}. */
interface LoadModelOptions {
  config: AppConfig;
  model: ModelRecord;
  loadPreset: LoadInferencePreset;
  systemPromptPreset: SystemPromptPreset;
}

type PrepareChatCompletionRequestBodyResult =
  | { body: Record<string, unknown> }
  | { errorResponse: Response };

const SUPPORTED_CHAT_COMPLETION_FIELDS = new Set<string>([
  "cache_prompt",
  "messages",
  "stream",
  "n_predict",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "repeat_penalty",
  "stop",
  "max_tokens",
  "logit_bias",
  "user",
]);

/** Priority level for managed requests — `"foreground"` preempts `"background"`. */
type ManagedRequestPriority = "background" | "foreground";

/**
 * Manages the lifecycle and request proxying for a single `llama-server` child process.
 */
export class LlamaServerManager {
  private childProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private activeGenerationAbortController: AbortController | null = null;
  private activeGenerationChatId: string | null = null;
  private activeGenerationSettledPromise: Promise<void> | null = null;
  private activeRequestAbortController: AbortController | null = null;
  private activeRequestPriority: ManagedRequestPriority | null = null;
  private activeRequestChatId: string | null = null;
  private activeRequestSettledPromise: Promise<void> | null = null;
  private activeServerBaseUrl: string | null = null;
  private resolveActiveGenerationSettled: (() => void) | null = null;
  private resolveActiveRequestSettled: (() => void) | null = null;
  private activeLoadPreset: LoadInferencePreset | null = null;
  private activeModel: ModelRecord | null = null;
  private activeSystemPromptPreset: SystemPromptPreset | null = null;
  private recentStderrLines: string[] = [];
  private syntheticLoadProgress = 0;
  private sawExplicitLoadProgress = false;
  private tensorLoadDots = 0;
  private tensorLoadStarted = false;
  private templateFilePath: string | null = null;
  private unloading = false;
  private runtimeSnapshot: RuntimeSnapshot = {
    status: "idle",
    activeModelId: null,
    activeModelPath: null,
    llamaServerBaseUrl: null,
    loadProgress: null,
    contextTokens: null,
    contextLimitTokens: null,
    tokensPerSecond: null,
    multimodal: false,
    audio: false,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };

  /**
   * Creates a new managed `llama-server` runtime wrapper.
   *
   * @param applicationPaths The resolved application path bundle.
   * @param debugLogService The debug log aggregator.
   * @param runtimeBroadcaster The runtime snapshot SSE broadcaster.
   */
  public constructor(
    private readonly applicationPaths: ApplicationPaths,
    private readonly debugLogService: DebugLogService,
    private readonly runtimeBroadcaster: JsonSseBroadcaster<RuntimeSnapshot>,
  ) {}

  /**
   * Returns the current runtime snapshot.
   *
   * @returns The latest runtime snapshot.
   */
  public getSnapshot(): RuntimeSnapshot {
    return this.runtimeSnapshot;
  }

  /** Returns the active temporary Jinja override file path, if one is currently in use. */
  public getActiveTemplateFilePath(): string | null {
    return this.templateFilePath;
  }

  /**
   * Starts tracking a foreground generation session that may span one or more
   * upstream requests and local tool-execution turns.
   *
   * @param chatId The persisted chat identifier when available.
   * @param downstreamSignal The client-request abort signal.
   * @returns A composed abort signal plus a completion callback, or a 409 response when busy.
   */
  public beginForegroundGeneration(
    chatId: string | null,
    downstreamSignal: AbortSignal,
  ): { complete: () => void; signal: AbortSignal } {
    if (this.activeRequestAbortController && this.activeRequestPriority === "background") {
      const backgroundAbortController = this.activeRequestAbortController;
      backgroundAbortController.abort();
      this.clearActiveController(backgroundAbortController);
    } else if (this.activeGenerationAbortController || this.activeRequestAbortController) {
      this.debugLogService.serverLog(
        "A foreground generation was already running; aborting it to prioritize the new request.",
      );
      this.abortAndClearActiveControllers();
    }

    const generationAbortController = new AbortController();
    const requestAbortController = new AbortController();
    const abortGeneration = (): void => {
      generationAbortController.abort();
      requestAbortController.abort();
    };

    downstreamSignal.addEventListener("abort", abortGeneration, { once: true });
    this.activeGenerationAbortController = generationAbortController;
    this.activeGenerationChatId = chatId;
    this.activeRequestAbortController = requestAbortController;
    this.activeRequestPriority = "foreground";
    this.activeRequestChatId = chatId;
    this.activeGenerationSettledPromise = new Promise<void>((resolve) => {
      this.resolveActiveGenerationSettled = resolve;
    });
    this.activeRequestSettledPromise = new Promise<void>((resolve) => {
      this.resolveActiveRequestSettled = resolve;
    });

    return {
      complete: () => {
        downstreamSignal.removeEventListener("abort", abortGeneration);
        this.clearActiveController(generationAbortController);
        this.clearActiveController(requestAbortController);
      },
      signal: generationAbortController.signal,
    };
  }

  /**
   * Loads a model by spawning and health-checking a new `llama-server` process.
   *
   * @param options The load request options.
   * @returns The ready runtime snapshot.
   * @throws When the configured binary path is invalid or the process fails to become healthy.
   */
  public async loadModel(options: LoadModelOptions): Promise<RuntimeSnapshot> {
    if (!options.config.llamaServerPath) {
      throw new Error("The llama-server path is not configured.");
    }

    await this.unload("model-switch");

    const loadDeadline =
      Date.now() +
      calculateRuntimeLoadTimeoutMs({
        contextLength: options.loadPreset.settings.contextLength,
        fileSizeBytes: options.model.fileSizeBytes,
      });

    for (let attemptIndex = 0; attemptIndex < MAX_PORT_BIND_ATTEMPTS; attemptIndex += 1) {
      this.activeModel = options.model;
      this.activeLoadPreset = options.loadPreset;
      this.activeSystemPromptPreset = options.systemPromptPreset;

      const spawnArguments = await this.buildSpawnArguments(options, DYNAMIC_LLAMA_SERVER_PORT);

      this.unloading = false;
      this.activeServerBaseUrl = null;
      this.resetLoadProgressTracking();
      this.updateSnapshot({
        status: "loading",
        activeModelId: options.model.id,
        activeModelPath: options.model.modelPath,
        llamaServerBaseUrl: null,
        loadProgress: 0,
        multimodal: Boolean(options.model.mmprojPath) || options.model.supportsAudio,
        audio: options.model.supportsAudio,
        lastError: null,
        contextTokens: null,
        contextLimitTokens: options.loadPreset.settings.contextLength,
        tokensPerSecond: null,
      });

      this.debugLogService.serverLog(
        `Spawning llama-server for ${options.model.id} with dynamic port allocation and ${spawnArguments.join(" ")}.`,
      );

      this.childProcess = spawn(options.config.llamaServerPath, spawnArguments, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });

      this.attachOutputListeners(this.childProcess);
      this.attachLifecycleListeners(this.childProcess, options.model.id);
      const startupFailure = this.createStartupFailurePromise(this.childProcess, options.model.id);

      try {
        const baseUrl = await this.waitForListeningBaseUrl(loadDeadline, startupFailure);

        await this.waitForHealthy(baseUrl, loadDeadline, startupFailure);

        const propsResponse = await fetchJson<LlamaServerPropsResponse>(`${baseUrl}/props`);
        const modelInfoResponse = await fetchJson<Record<string, unknown>>(`${baseUrl}/v1/models`);
        const modalities = collectModalities(propsResponse, modelInfoResponse);

        this.updateSnapshot({
          status: "ready",
          loadProgress: 100,
          contextLimitTokens: options.loadPreset.settings.contextLength,
          multimodal:
            modalities.has("image") ||
            modalities.has("vision") ||
            modalities.has("audio") ||
            options.model.supportsAudio ||
            Boolean(options.model.mmprojPath),
          audio: modalities.has("audio") || options.model.supportsAudio,
          lastError: null,
        });

        return this.getSnapshot();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const shouldRetryPortBind =
          isPortInUseError(errorMessage) && attemptIndex < MAX_PORT_BIND_ATTEMPTS - 1;

        await this.unload(shouldRetryPortBind ? "port-bind-retry" : "load-failure");

        if (!shouldRetryPortBind) {
          this.updateSnapshot({
            lastError: errorMessage,
            status: "error",
          });
          throw error;
        }

        this.debugLogService.serverLog(
          "llama-server failed to claim a usable listening port; retrying with a fresh spawn.",
        );
      }
    }

    throw new Error("Unable to allocate a free port for llama-server.");
  }

  /**
   * Gracefully unloads the current `llama-server` process.
   *
   * @param reason A short reason string for logging.
   */
  public async unload(reason = "requested"): Promise<void> {
    if (!this.childProcess) {
      const activeGenerationAbortController = this.activeGenerationAbortController;

      activeGenerationAbortController?.abort();

      if (activeGenerationAbortController) {
        this.clearActiveController(activeGenerationAbortController);
      }

      this.activeModel = null;
      this.activeLoadPreset = null;
      this.activeSystemPromptPreset = null;
      this.activeServerBaseUrl = null;
      this.updateSnapshot({
        status: "idle",
        activeModelId: null,
        activeModelPath: null,
        llamaServerBaseUrl: null,
        loadProgress: null,
        contextTokens: null,
        contextLimitTokens: null,
        tokensPerSecond: null,
        multimodal: false,
        audio: false,
        lastError: null,
      });
      await this.cleanupTemplateFile();
      return;
    }

    this.unloading = true;
    const activeGenerationAbortController = this.activeGenerationAbortController;
    const activeRequestAbortController = this.activeRequestAbortController;

    activeGenerationAbortController?.abort();

    if (activeGenerationAbortController) {
      this.clearActiveController(activeGenerationAbortController);
    }

    if (
      activeRequestAbortController &&
      activeRequestAbortController !== activeGenerationAbortController
    ) {
      activeRequestAbortController.abort();
      this.clearActiveController(activeRequestAbortController);
    }

    this.debugLogService.serverLog(`Unloading llama-server (${reason}).`);

    const childProcess = this.childProcess;
    this.childProcess = null;

    await terminateChildProcess(childProcess);
    await this.cleanupTemplateFile();
    this.activeModel = null;
    this.activeLoadPreset = null;
    this.activeSystemPromptPreset = null;
    this.activeServerBaseUrl = null;

    this.updateSnapshot({
      status: "idle",
      activeModelId: null,
      activeModelPath: null,
      llamaServerBaseUrl: null,
      loadProgress: null,
      contextTokens: null,
      contextLimitTokens: null,
      tokensPerSecond: null,
      multimodal: false,
      audio: false,
      lastError: null,
    });
  }

  /**
   * Aborts the currently proxied generation request when one is active.
   *
   * @returns `true` when an in-flight request was aborted.
   */
  public async stopGeneration(chatId?: string): Promise<boolean> {
    if (this.activeGenerationAbortController) {
      if (chatId && this.activeGenerationChatId !== chatId) {
        return false;
      }

      const activeGenerationAbortController = this.activeGenerationAbortController;
      const activeGenerationSettledPromise = this.activeGenerationSettledPromise;

      this.debugLogService.serverLog("Aborting the active generation.");
      activeGenerationAbortController.abort();

      if (
        this.activeRequestAbortController &&
        this.activeRequestAbortController !== activeGenerationAbortController
      ) {
        this.activeRequestAbortController.abort();
      }

      await activeGenerationSettledPromise;

      return true;
    }

    if (!this.activeRequestAbortController) {
      return false;
    }

    if (chatId && this.activeRequestChatId !== chatId) {
      return false;
    }

    const activeRequestAbortController = this.activeRequestAbortController;
    const activeRequestSettledPromise = this.activeRequestSettledPromise;

    this.debugLogService.serverLog("Aborting the active llama-server request.");
    activeRequestAbortController.abort();

    await activeRequestSettledPromise;

    return true;
  }

  /**
   * Forwards a chat-completions request to the active `llama-server` instance.
   *
   * @param requestBody The JSON body to proxy.
   * @param downstreamSignal The downstream client abort signal.
   * @returns The proxied response.
   */
  public async proxyChatCompletion(
    requestBody: Record<string, unknown>,
    downstreamSignal: AbortSignal,
  ): Promise<Response> {
    const preparedRequestBodyResult = await this.prepareChatCompletionRequestBody(requestBody);

    if ("errorResponse" in preparedRequestBodyResult) {
      return preparedRequestBodyResult.errorResponse;
    }

    return this.proxyJsonRequest(
      "/v1/chat/completions",
      preparedRequestBodyResult.body,
      downstreamSignal,
      "foreground",
      typeof requestBody["chatId"] === "string" ? requestBody["chatId"] : null,
    );
  }

  /**
   * Forwards a raw completion request to the active `llama-server` instance.
   *
   * @param requestBody The JSON body to proxy.
   * @param downstreamSignal The downstream client abort signal.
   * @returns The proxied response.
   */
  public async proxyCompletion(
    requestBody: Record<string, unknown>,
    downstreamSignal: AbortSignal,
    requestPriority: ManagedRequestPriority = "foreground",
  ): Promise<Response> {
    return this.proxyJsonRequest(
      "/completion",
      requestBody,
      downstreamSignal,
      requestPriority,
      typeof requestBody["chatId"] === "string" ? requestBody["chatId"] : null,
    );
  }

  /**
   * Synchronously marks the manager as shutting down so that a concurrent
   * child-process exit event does not broadcast a spurious runtime error.
   *
   * This MUST be called before any async shutdown work begins because on
   * Windows closing the console window can terminate the child process
   * before the parent's async handlers have a chance to run.
   */
  public prepareForShutdown(): void {
    this.unloading = true;
  }

  /**
   * Performs best-effort final cleanup during process exit.
   */
  public disposeOnExit(): void {
    this.unloading = true;
    const activeGenerationAbortController = this.activeGenerationAbortController;
    const activeRequestAbortController = this.activeRequestAbortController;

    activeGenerationAbortController?.abort();

    if (
      activeRequestAbortController &&
      activeRequestAbortController !== activeGenerationAbortController
    ) {
      activeRequestAbortController.abort();
    }

    if (activeGenerationAbortController) {
      this.clearActiveController(activeGenerationAbortController);
    }

    if (
      activeRequestAbortController &&
      activeRequestAbortController !== activeGenerationAbortController
    ) {
      this.clearActiveController(activeRequestAbortController);
    }

    this.activeServerBaseUrl = null;

    const childProcess = this.childProcess;

    this.childProcess = null;

    if (childProcess) {
      terminateChildProcessOnExit(childProcess);
    }
  }

  /**
   * Detects whether the active model's chat template appears to support
   * tool calling by checking for tool-related Jinja template tokens.
   *
   * @returns An object with `supported` flag and optional human-readable `reason`.
   */
  public getToolCallingSupport(): { reason?: string; supported: boolean } {
    const templateText =
      this.activeSystemPromptPreset?.jinjaTemplateOverride?.trim() ||
      this.activeModel?.chatTemplate?.trim() ||
      "";

    if (!templateText) {
      return {
        reason:
          "The active model does not expose a usable chat template. Add a Jinja template override before enabling tools.",
        supported: false,
      };
    }

    const normalizedTemplate = templateText.toLowerCase();

    if (
      normalizedTemplate.includes("tool_calls") ||
      normalizedTemplate.includes("tool_call_id") ||
      normalizedTemplate.includes("tools")
    ) {
      return { supported: true };
    }

    return {
      reason:
        "The active chat template does not appear tool-compatible. Add a tool-capable Jinja template override before enabling tools.",
      supported: false,
    };
  }

  /** Returns the active preset's raw reasoning tags for parser fallback. */
  public getActiveThinkingTags(): ThinkingTagSettings | null {
    return this.activeSystemPromptPreset?.thinkingTags ?? null;
  }

  /**
   * Proxies an arbitrary JSON request to the active `llama-server` instance,
   * handling both streaming and non-streaming modes.
   *
   * @param endpoint - Server-relative path (e.g. `"/v1/chat/completions"`).
   * @param requestBody - JSON body to send.
   * @param downstreamSignal - Client-originated abort signal.
   * @param requestPriority - Priority level for request scheduling.
   * @returns The proxied response.
   */
  private async proxyJsonRequest(
    endpoint: string,
    requestBody: Record<string, unknown>,
    downstreamSignal: AbortSignal,
    requestPriority: ManagedRequestPriority,
    chatId: string | null = null,
  ): Promise<Response> {
    if (this.runtimeSnapshot.status !== "ready" || !this.runtimeSnapshot.llamaServerBaseUrl) {
      return Response.json(
        { error: "No model is currently loaded." },
        {
          status: 409,
        },
      );
    }

    if (this.activeRequestAbortController) {
      const activePriority = this.activeRequestPriority;
      const activeChatId = this.activeRequestChatId;

      if (requestPriority === "foreground" && activePriority === "background") {
        this.debugLogService.serverLog(
          "Canceling the active background llama-server request to prioritize foreground work.",
        );

        const backgroundAbortController = this.activeRequestAbortController;
        backgroundAbortController.abort();
        this.clearActiveController(backgroundAbortController);
      } else {
        const activeState =
          activePriority === "foreground"
            ? "a foreground generation"
            : "a background llama-server request";
        const errorMessage =
          requestPriority === "foreground"
            ? "Another generation request is already in progress."
            : "A llama-server request is already in progress; retry after the current request completes.";

        this.debugLogService.verboseServerLog(
          `Rejecting ${endpoint} because ${activeState} is already in progress.`,
        );

        return Response.json(
          {
            activeChatId,
            error: errorMessage,
            retryable: true,
            state: activePriority === "foreground" ? "running" : "busy",
          },
          {
            status: 409,
          },
        );
      }
    }

    const payload: Record<string, unknown> = {
      ...requestBody,
    };
    const isStreamingRequest = payload["stream"] === true;
    const requestMessageCount = Array.isArray(payload["messages"]) ? payload["messages"].length : 0;
    const abortController = this.activeRequestAbortController ?? new AbortController();
    const abortActiveRequest = (): void => {
      abortController.abort();
    };
    const requestUrl = `${this.runtimeSnapshot.llamaServerBaseUrl}${endpoint}`;

    this.debugLogService.verboseServerLog(
      `Proxying ${isStreamingRequest ? "streaming" : "non-streaming"} request to ${endpoint}${chatId ? ` for chat ${chatId}` : ""} with ${String(requestMessageCount)} message(s).`,
    );

    this.beginActiveRequest(abortController, requestPriority, chatId);
    downstreamSignal.addEventListener("abort", abortActiveRequest, { once: true });

    try {
      const upstreamResponse = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      this.debugLogService.verboseServerLog(
        `Upstream ${endpoint} responded with status ${String(upstreamResponse.status)}${chatId ? ` for chat ${chatId}` : ""}.`,
      );

      if (isStreamingRequest) {
        downstreamSignal.removeEventListener("abort", abortActiveRequest);
        return this.proxyStreamResponse(
          upstreamResponse,
          abortController,
          downstreamSignal,
          endpoint,
          chatId,
        );
      }

      const responseText = await upstreamResponse.text();

      try {
        const parsedPayload = JSON.parse(responseText) as unknown;
        this.captureRuntimeMetrics(parsedPayload);
        this.clearActiveRequest(abortController);
        downstreamSignal.removeEventListener("abort", abortActiveRequest);

        return Response.json(parsedPayload, { status: upstreamResponse.status });
      } catch {
        this.clearActiveRequest(abortController);
        downstreamSignal.removeEventListener("abort", abortActiveRequest);

        return new Response(responseText, {
          headers: {
            "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "text/plain",
          },
          status: upstreamResponse.status,
        });
      }
    } catch (error) {
      this.clearActiveRequest(abortController);
      downstreamSignal.removeEventListener("abort", abortActiveRequest);

      if (abortController.signal.aborted) {
        this.debugLogService.verboseServerLog(
          `Upstream ${endpoint} request${chatId ? ` for chat ${chatId}` : ""} was aborted.`,
        );
        return Response.json({ stopped: true }, { status: 499 });
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      this.debugLogService.verboseServerLog(
        `Upstream ${endpoint} request${chatId ? ` for chat ${chatId}` : ""} failed: ${errorMessage}`,
      );

      throw error;
    }
  }

  /** Releases the tracked state for a controller when it settles. */
  private clearActiveController(abortController: AbortController): void {
    if (this.activeRequestAbortController === abortController) {
      this.activeRequestAbortController = null;
      this.activeRequestPriority = null;
      this.activeRequestChatId = null;
      this.activeRequestSettledPromise = null;

      const resolveActiveRequestSettled = this.resolveActiveRequestSettled;

      this.resolveActiveRequestSettled = null;
      resolveActiveRequestSettled?.();
    }

    if (this.activeGenerationAbortController === abortController) {
      this.activeGenerationAbortController = null;
      this.activeGenerationChatId = null;
      this.activeGenerationSettledPromise = null;

      const resolveActiveGenerationSettled = this.resolveActiveGenerationSettled;

      this.resolveActiveGenerationSettled = null;
      resolveActiveGenerationSettled?.();
    }
  }

  /** Releases the active request tracking when a controller matches the current one. */
  private clearActiveRequest(abortController: AbortController): void {
    this.clearActiveController(abortController);
  }

  /**
   * Aborts and clears all active generation and request controllers unconditionally.
   *
   * This is used when the child process crashes or exits unexpectedly to ensure
   * the generation lock is released; without this, subsequent generation requests
   * would be permanently rejected with 409 Conflict.
   */
  private abortAndClearActiveControllers(): void {
    const activeGenerationAbortController = this.activeGenerationAbortController;
    const activeRequestAbortController = this.activeRequestAbortController;

    activeGenerationAbortController?.abort();

    if (activeGenerationAbortController) {
      this.clearActiveController(activeGenerationAbortController);
    }

    if (
      activeRequestAbortController &&
      activeRequestAbortController !== activeGenerationAbortController
    ) {
      activeRequestAbortController.abort();
      this.clearActiveController(activeRequestAbortController);
    }
  }

  /** Starts tracking a newly proxied request until its fetch or stream fully unwinds. */
  private beginActiveRequest(
    abortController: AbortController,
    requestPriority: ManagedRequestPriority,
    chatId: string | null,
  ): void {
    this.activeRequestAbortController = abortController;
    this.activeRequestPriority = requestPriority;
    this.activeRequestChatId = chatId;
    this.activeRequestSettledPromise = new Promise<void>((resolve) => {
      this.resolveActiveRequestSettled = resolve;
    });
  }

  /**
   * Prepares the chat-completion request body by merging inference
   * settings, stripping internal fields, and injecting the system prompt.
   */
  private async prepareChatCompletionRequestBody(
    requestBody: Record<string, unknown>,
  ): Promise<PrepareChatCompletionRequestBodyResult> {
    const settings = this.activeLoadPreset?.settings;
    const sanitizedBody: Record<string, unknown> = { ...requestBody };
    const rawRequestMessages = Array.isArray(sanitizedBody["messages"])
      ? [...(sanitizedBody["messages"] as unknown[])]
      : [];

    const shouldCachePrompt = requestBody["cache_prompt"] === true;
    delete sanitizedBody["cache_prompt"];
    delete sanitizedBody["chatId"];
    delete sanitizedBody["chat_template_kwargs"];
    delete sanitizedBody["json_schema"];
    delete sanitizedBody["response_format"];

    const unsupportedKeys = Object.keys(sanitizedBody).filter(
      (key) => !SUPPORTED_CHAT_COMPLETION_FIELDS.has(key),
    );

    if (unsupportedKeys.length > 0) {
      return {
        errorResponse: Response.json(
          {
            error: `Unsupported chat-completion request fields: ${unsupportedKeys.join(", ")}.`,
          },
          {
            status: 400,
          },
        ),
      };
    }

    const systemPrompt = this.activeSystemPromptPreset?.systemPrompt.trim();
    const normalizedMessages = await this.normalizeChatMessages(rawRequestMessages);

    if (normalizedMessages instanceof Response) {
      return { errorResponse: normalizedMessages };
    }

    let requestMessages = [...normalizedMessages];

    if (systemPrompt) {
      requestMessages.unshift({
        content: systemPrompt,
        role: "system",
      });
    }

    if (settings) {
      const boundedMessages = this.applyOverflowStrategy(requestMessages, settings);

      if ("errorResponse" in boundedMessages) {
        return boundedMessages;
      }

      requestMessages = boundedMessages;
    }

    const nextBody: Record<string, unknown> = {
      messages: requestMessages,
      stream: sanitizedBody["stream"] === true,
      ...(shouldCachePrompt ? { cache_prompt: true } : {}),
    };

    for (const field of [
      "n_predict",
      "temperature",
      "top_p",
      "top_k",
      "min_p",
      "presence_penalty",
      "repeat_penalty",
      "stop",
      "max_tokens",
      "logit_bias",
      "user",
    ] as const) {
      if (sanitizedBody[field] !== undefined) {
        nextBody[field] = sanitizedBody[field];
      }
    }

    if (!settings) {
      return { body: nextBody };
    }

    nextBody["chat_template_kwargs"] = {
      enable_thinking: settings.thinkingEnabled,
    };
    nextBody["min_p"] = settings.minP;
    nextBody["presence_penalty"] = settings.presencePenalty;
    nextBody["repeat_penalty"] = settings.repeatPenalty;
    nextBody["stop"] = settings.stopStrings;
    nextBody["temperature"] = settings.temperature;
    nextBody["top_k"] = settings.topK;
    nextBody["top_p"] = settings.topP;

    if (settings.thinkingEnabled) {
      nextBody["reasoning_format"] = "deepseek";
    }

    if (typeof settings.responseLengthLimit === "number") {
      nextBody["n_predict"] = settings.responseLengthLimit;
    }

    if (settings.structuredOutputMode === "json_object") {
      nextBody["response_format"] = {
        type: "json_object",
      };

      return { body: nextBody };
    }

    if (settings.structuredOutputMode !== "json_schema") {
      return { body: nextBody };
    }

    const schemaText = settings.structuredOutputSchema?.trim();

    if (!schemaText) {
      return {
        errorResponse: Response.json(
          { error: "The active load preset is set to JSON Schema mode, but no schema is saved." },
          { status: 400 },
        ),
      };
    }

    let parsedSchema: Record<string, unknown>;

    try {
      parsedSchema = JSON.parse(schemaText) as Record<string, unknown>;
    } catch {
      return {
        errorResponse: Response.json(
          { error: "The active JSON schema is not valid JSON." },
          { status: 400 },
        ),
      };
    }

    if (schemaContainsUnsupportedReference(parsedSchema)) {
      return {
        errorResponse: Response.json(
          { error: "Schemas containing $ref are not supported in this application version." },
          { status: 400 },
        ),
      };
    }

    nextBody["response_format"] = {
      schema: parsedSchema,
      type: "json_schema",
    };

    return { body: nextBody };
  }

  /** Applies the active context overflow strategy to the prepared request messages. */
  private applyOverflowStrategy(
    requestMessages: Record<string, unknown>[],
    settings: LoadInferencePreset["settings"],
  ): Record<string, unknown>[] | { errorResponse: Response } {
    if (settings.overflowStrategy === "rolling-window") {
      if (settings.contextShift) {
        return requestMessages;
      }

      return {
        errorResponse: Response.json(
          {
            error:
              "Rolling Window requires Context Shift to be enabled. Reload the model with Context Shift enabled before using this overflow mode.",
          },
          { status: 409 },
        ),
      };
    }

    const promptBudget = resolvePromptTokenBudget(settings);
    const estimatedPromptTokens = estimateConversationTokens(requestMessages, settings);

    if (estimatedPromptTokens <= promptBudget) {
      return requestMessages;
    }

    if (settings.overflowStrategy === "stop-at-limit") {
      return {
        errorResponse: Response.json(
          {
            error:
              "The current conversation exceeds the active context budget. Shorten the chat, remove attachments, reduce the response length limit, or switch to Truncate Middle / Rolling Window.",
          },
          { status: 409 },
        ),
      };
    }

    const messageTokenContributions = requestMessages.map(
      (message) => MESSAGE_OVERHEAD_TOKEN_ESTIMATE + estimateMessageTokens(message, settings),
    );
    const overflowSegments = buildOverflowSegments(requestMessages);
    const removableSegmentIndices = buildMiddleRemovalOrder(overflowSegments.length);
    const removedIndices = new Set<number>();
    const segmentTokenContributions = overflowSegments.map((segment) =>
      segment.indices.reduce(
        (totalTokens, messageIndex) => totalTokens + (messageTokenContributions[messageIndex] ?? 0),
        0,
      ),
    );
    let remainingPromptTokens = messageTokenContributions.reduce(
      (totalTokens, messageTokens) => totalTokens + messageTokens,
      0,
    );

    for (const segmentIndex of removableSegmentIndices) {
      const overflowSegment = overflowSegments[segmentIndex];

      if (!overflowSegment) {
        continue;
      }

      for (const messageIndex of overflowSegment.indices) {
        removedIndices.add(messageIndex);
      }

      remainingPromptTokens -= segmentTokenContributions[segmentIndex] ?? 0;

      if (remainingPromptTokens <= promptBudget) {
        return requestMessages.filter((_message, index) => !removedIndices.has(index));
      }
    }

    return {
      errorResponse: Response.json(
        {
          error:
            "The active context limit would still be exceeded after truncating middle messages. Reduce the prompt, attachments, or response length limit.",
        },
        { status: 409 },
      ),
    };
  }

  /** Normalises a raw messages array into typed conversation message objects. */
  private async normalizeChatMessages(
    messages: unknown[],
  ): Promise<Record<string, unknown>[] | Response> {
    const normalizedMessages: Record<string, unknown>[] = [];
    let replayBudgetRemaining = MAX_AGGREGATE_REPLAY_BYTES;

    for (const messageValue of messages) {
      if (!messageValue || typeof messageValue !== "object") {
        continue;
      }

      const result = await this.normalizeChatMessage(
        messageValue as Record<string, unknown>,
        replayBudgetRemaining,
      );

      if (result instanceof Response) {
        return result;
      }

      normalizedMessages.push(result.message);
      replayBudgetRemaining = result.replayBudgetRemaining;
    }

    return normalizedMessages;
  }

  /**
   * Normalises a single chat message, inlining media attachments as
   * multipart content parts (images, audio, text files).
   */
  private async normalizeChatMessage(
    message: Record<string, unknown>,
    replayBudgetRemaining: number,
  ): Promise<{ message: Record<string, unknown>; replayBudgetRemaining: number } | Response> {
    const normalizedMessage: Record<string, unknown> = { ...message };
    const attachmentValues = Array.isArray(message["mediaAttachments"])
      ? [...(message["mediaAttachments"] as unknown[])]
      : [];

    delete normalizedMessage["mediaAttachments"];

    if (attachmentValues.length === 0 || normalizedMessage["role"] !== "user") {
      return { message: normalizedMessage, replayBudgetRemaining };
    }

    const contentParts: Array<Record<string, unknown>> = [];
    const textContent = normalizedMessage["content"];

    if (typeof textContent === "string" && textContent.length > 0) {
      contentParts.push({
        text: textContent,
        type: "text",
      });
    }

    for (const attachmentValue of attachmentValues) {
      if (!attachmentValue || typeof attachmentValue !== "object") {
        continue;
      }

      const attachment = attachmentValue as {
        byteSize?: unknown;
        fileName?: unknown;
        filePath?: unknown;
        id?: unknown;
        kind?: unknown;
        mimeType?: unknown;
      };

      if (
        typeof attachment.kind !== "string" ||
        typeof attachment.filePath !== "string" ||
        typeof attachment.mimeType !== "string"
      ) {
        continue;
      }

      if (attachment.kind === "image" && !this.runtimeSnapshot.multimodal) {
        return Response.json(
          { error: "The active llama-server runtime does not currently support multimodal input." },
          { status: 400 },
        );
      }

      if (attachment.kind === "audio" && !this.runtimeSnapshot.audio) {
        return Response.json(
          { error: "The active model does not currently support audio input." },
          { status: 400 },
        );
      }

      if (attachment.kind === "text") {
        let fileText = "";
        let wasTruncated = false;
        const fileName =
          typeof attachment.fileName === "string"
            ? attachment.fileName
            : basename(attachment.filePath as string);

        try {
          const fileHandle = await open(attachment.filePath as string, "r");
          try {
            const fileStats = await fileHandle.stat();
            const buffer = Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES);
            const { bytesRead } = await fileHandle.read(buffer, 0, MAX_TEXT_ATTACHMENT_BYTES, 0);
            fileText = decodeUtf8AttachmentPrefix(buffer, bytesRead);
            wasTruncated = fileStats.size > bytesRead;
          } finally {
            await fileHandle.close();
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown file read error";

          this.debugLogService.serverLog(
            `Text attachment read failed for ${attachment.filePath}: ${errorMessage}`,
          );
          return Response.json(
            {
              error: `The text attachment ${fileName} could not be read from disk. Ensure the file still exists and try again.`,
            },
            { status: 400 },
          );
        }

        contentParts.push({
          text: createTextAttachmentPromptPart(fileName, fileText, wasTruncated),
          type: "text",
        });
        continue;
      }

      if (attachment.kind !== "image" && attachment.kind !== "audio") {
        continue;
      }

      const fileName =
        typeof attachment.fileName === "string"
          ? attachment.fileName
          : basename(attachment.filePath as string);
      const declaredByteSize =
        typeof attachment.byteSize === "number" &&
        Number.isFinite(attachment.byteSize) &&
        attachment.byteSize > 0
          ? attachment.byteSize
          : null;

      if (declaredByteSize !== null && declaredByteSize > replayBudgetRemaining) {
        return Response.json(
          {
            error: `Replaying binary attachments for this request would exceed the media replay limit before ${fileName}. Remove some earlier media attachments or retry from a shorter branch.`,
          },
          { status: 413 },
        );
      }

      const replayAttachment: MediaAttachmentRecord = {
        byteSize: declaredByteSize ?? 0,
        fileName,
        filePath: attachment.filePath,
        id: typeof attachment.id === "string" ? attachment.id : attachment.filePath,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
      };
      const persistedReplayDescriptor =
        await loadBinaryAttachmentReplayDescriptor(replayAttachment);

      if (persistedReplayDescriptor) {
        if (persistedReplayDescriptor.byteSize > replayBudgetRemaining) {
          return Response.json(
            {
              error: `Replaying binary attachments for this request would exceed the media replay limit before ${fileName}. Remove some earlier media attachments or retry from a shorter branch.`,
            },
            { status: 413 },
          );
        }

        replayBudgetRemaining -= persistedReplayDescriptor.byteSize;
        contentParts.push(
          createContentPartFromBinaryAttachmentReplayDescriptor(persistedReplayDescriptor),
        );
        continue;
      }

      let replayDescriptor;

      try {
        replayDescriptor = await buildBinaryAttachmentReplayDescriptorFromFile(
          replayAttachment,
          attachment.filePath,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown file read error";

        this.debugLogService.serverLog(
          `${attachment.kind} attachment read failed for ${attachment.filePath}: ${errorMessage}`,
        );
        return Response.json(
          {
            error: `The ${attachment.kind} attachment ${fileName} could not be read from disk. Ensure the file still exists and try again.`,
          },
          { status: 400 },
        );
      }

      if (replayDescriptor.byteSize > replayBudgetRemaining) {
        return Response.json(
          {
            error: `Replaying binary attachments for this request would exceed the media replay limit before ${fileName}. Remove some earlier media attachments or retry from a shorter branch.`,
          },
          { status: 413 },
        );
      }

      replayBudgetRemaining -= replayDescriptor.byteSize;
      contentParts.push(createContentPartFromBinaryAttachmentReplayDescriptor(replayDescriptor));

      try {
        await persistBinaryAttachmentReplayDescriptor(replayAttachment, replayDescriptor);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown replay cache write error";

        this.debugLogService.verboseServerLog(
          `Binary attachment replay descriptor write failed for ${attachment.filePath}: ${errorMessage}`,
        );
      }
    }

    normalizedMessage["content"] = contentParts;

    return { message: normalizedMessage, replayBudgetRemaining };
  }

  /**
   * Wraps an upstream streaming response in a new `ReadableStream` that
   * captures runtime metrics from each SSE payload before forwarding.
   */
  private proxyStreamResponse(
    upstreamResponse: Response,
    abortController: AbortController,
    downstreamSignal: AbortSignal,
    endpoint: string,
    chatId: string | null,
  ): Response {
    const upstreamBody = upstreamResponse.body;

    if (!upstreamBody) {
      this.clearActiveRequest(abortController);

      this.debugLogService.verboseServerLog(
        `Streaming response from ${endpoint}${chatId ? ` for chat ${chatId}` : ""} did not include a body.`,
      );

      return Response.json({ error: "Upstream response body was empty." }, { status: 502 });
    }

    const reader = upstreamBody.getReader();
    const decoder = new TextDecoder();

    return new Response(
      new ReadableStream<Uint8Array>({
        start: async (controller) => {
          let buffer = "";
          let loggedFirstPayload = false;
          let payloadCount = 0;
          const abortListener = (): void => {
            abortController.abort();
          };

          downstreamSignal.addEventListener("abort", abortListener, { once: true });

          try {
            while (true) {
              const readResult = await reader.read();

              if (readResult.done) {
                break;
              }

              controller.enqueue(readResult.value);
              buffer += decoder.decode(readResult.value, { stream: true });
              const parsedEvents = consumeSseEvents(buffer, { strict: false });
              buffer = parsedEvents.remainder;

              for (const eventPayload of parsedEvents.payloads) {
                payloadCount += 1;

                if (!loggedFirstPayload) {
                  loggedFirstPayload = true;
                  this.debugLogService.verboseServerLog(
                    `Received the first streamed SSE payload from ${endpoint}${chatId ? ` for chat ${chatId}` : ""}.`,
                  );
                }

                this.captureRuntimeMetrics(eventPayload);
              }
            }

            buffer += decoder.decode();
            let finalEvents: unknown[] = [];

            try {
              finalEvents = flushSseEvents(buffer, { strict: false });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.debugLogService.serverLog(
                `Ignored malformed final streamed SSE payload from ${endpoint}${chatId ? ` for chat ${chatId}` : ""}: ${errorMessage}`,
              );
            }

            for (const eventPayload of finalEvents) {
              payloadCount += 1;

              if (!loggedFirstPayload) {
                loggedFirstPayload = true;
                this.debugLogService.verboseServerLog(
                  `Received the first streamed SSE payload from ${endpoint}${chatId ? ` for chat ${chatId}` : ""}.`,
                );
              }

              this.captureRuntimeMetrics(eventPayload);
            }

            this.debugLogService.verboseServerLog(
              `Completed streamed response from ${endpoint}${chatId ? ` for chat ${chatId}` : ""} after ${String(payloadCount)} SSE payload(s).`,
            );

            controller.close();
          } catch (error) {
            if (abortController.signal.aborted || downstreamSignal.aborted) {
              this.debugLogService.verboseServerLog(
                `Streaming response from ${endpoint}${chatId ? ` for chat ${chatId}` : ""} was aborted.`,
              );
              controller.close();
            } else {
              const errorMessage = error instanceof Error ? error.message : String(error);

              this.debugLogService.verboseServerLog(
                `Streaming response from ${endpoint}${chatId ? ` for chat ${chatId}` : ""} failed: ${errorMessage}`,
              );
              controller.error(error);
            }
          } finally {
            downstreamSignal.removeEventListener("abort", abortListener);
            this.clearActiveRequest(abortController);
          }
        },
      }),
      {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "text/event-stream",
        },
        status: upstreamResponse.status,
      },
    );
  }

  /**
   * Constructs the full CLI argument list for spawning `llama-server`
   * from the model record and inference preset settings.
   */
  private async buildSpawnArguments(options: LoadModelOptions, port: number): Promise<string[]> {
    const settings = options.loadPreset.settings;
    const spawnArguments = [
      "-m",
      options.model.modelPath,
      "-c",
      String(settings.contextLength),
      "-ngl",
      String(settings.gpuLayers),
      "-t",
      String(settings.cpuThreads),
      "-b",
      String(settings.batchSize),
      "-ub",
      String(settings.ubatchSize),
      "--cache-reuse",
      "256",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-np",
      "1",
      "--seed",
      String(settings.seed),
    ];

    if (await supportsLlamaServerFlag(options.config.llamaServerPath, "--log-format")) {
      spawnArguments.push("--log-format", "json");
    }

    if (options.model.mmprojPath) {
      spawnArguments.push("--mmproj", options.model.mmprojPath);
    }

    if (settings.kvCacheTypeK) {
      spawnArguments.push("--cache-type-k", settings.kvCacheTypeK);
    }

    if (settings.kvCacheTypeV) {
      spawnArguments.push("--cache-type-v", settings.kvCacheTypeV);
    }

    if (settings.unifiedKvCache) {
      spawnArguments.push("--kv-unified");
    }

    if (!settings.offloadKvCache) {
      spawnArguments.push("--no-kv-offload");
    }

    if (!settings.useMmap) {
      spawnArguments.push("--no-mmap");
    }

    if (settings.keepModelInMemory) {
      spawnArguments.push("--mlock");
    }

    if (settings.flashAttention) {
      spawnArguments.push("--flash-attn", "on");
    }

    if (settings.fullSwaCache) {
      spawnArguments.push("--swa-full");
    }

    if (typeof settings.ropeFrequencyBase === "number") {
      spawnArguments.push("--rope-freq-base", String(settings.ropeFrequencyBase));
    }

    if (typeof settings.ropeFrequencyScale === "number") {
      spawnArguments.push("--rope-freq-scale", String(settings.ropeFrequencyScale));
    }

    if (settings.contextShift || settings.overflowStrategy === "rolling-window") {
      spawnArguments.push("--context-shift");
    }

    if (typeof settings.imageMinTokens === "number") {
      spawnArguments.push("--image-min-tokens", String(settings.imageMinTokens));
    }

    if (typeof settings.imageMaxTokens === "number") {
      spawnArguments.push("--image-max-tokens", String(settings.imageMaxTokens));
    }

    const templateOverride = options.systemPromptPreset.jinjaTemplateOverride?.trim();

    if (templateOverride) {
      const templateFilePath = await this.createTemplateFile(templateOverride);
      spawnArguments.push("--jinja", "--chat-template-file", templateFilePath);
    }

    return spawnArguments;
  }

  /** Writes a temporary Jinja template override file and returns its path. */
  private async createTemplateFile(templateOverride: string): Promise<string> {
    await this.cleanupTemplateFile();

    this.templateFilePath = `${this.applicationPaths.tempDir}/${crypto.randomUUID()}.jinja`;
    await writeFile(this.templateFilePath, templateOverride, "utf8");

    return this.templateFilePath;
  }

  /** Deletes the temporary Jinja template file if one exists. */
  private async cleanupTemplateFile(): Promise<void> {
    if (!this.templateFilePath) {
      return;
    }

    try {
      await unlink(this.templateFilePath);
    } catch {
      // Best-effort cleanup only.
    }

    this.templateFilePath = null;
  }

  /** Attaches stdout/stderr line-buffered listeners for debug logging and load progress tracking. */
  private attachOutputListeners(childProcess: ChildProcessByStdio<null, Readable, Readable>): void {
    const pendingLines: Record<"stdout" | "stderr", string> = {
      stdout: "",
      stderr: "",
    };

    const handleLine = (streamName: "stdout" | "stderr", line: string): void => {
      if (streamName === "stdout") {
        this.debugLogService.log("process:stdout", line);
        return;
      }

      this.debugLogService.log("process:stderr", line);
      this.recordStderrLine(line);

      this.captureListeningBaseUrl(line);

      if (isPortInUseError(line)) {
        this.updateSnapshot({
          status: "error",
          lastError: line,
        });
      }

      this.captureLoadProgressFromLine(line);
    };

    const flushPendingLine = (streamName: "stdout" | "stderr"): void => {
      const finalLine = pendingLines[streamName].trim();

      if (finalLine.length === 0) {
        pendingLines[streamName] = "";
        return;
      }

      handleLine(streamName, finalLine);
      pendingLines[streamName] = "";
    };

    const handleChunk = (streamName: "stdout" | "stderr", chunk: Buffer): void => {
      const chunkText = chunk.toString("utf8");

      this.captureListeningBaseUrl(chunkText);

      if (streamName === "stderr") {
        this.recordStderrLine(chunkText);
        this.captureLoadProgressFromChunk(chunkText);
      }

      pendingLines[streamName] += chunkText;
      const lines = pendingLines[streamName].split(/\r?\n/);
      pendingLines[streamName] = lines.pop() ?? "";

      for (const line of lines) {
        handleLine(streamName, line);
      }
    };

    childProcess.stdout.on("data", (chunk: Buffer) => {
      handleChunk("stdout", chunk);
    });
    childProcess.stdout.on("close", () => {
      flushPendingLine("stdout");
    });
    childProcess.stderr.on("data", (chunk: Buffer) => {
      handleChunk("stderr", chunk);
    });
    childProcess.stderr.on("close", () => {
      flushPendingLine("stderr");
    });
  }

  /** Registers error and exit handlers on the child process for lifecycle monitoring. */
  private attachLifecycleListeners(
    childProcess: ChildProcessByStdio<null, Readable, Readable>,
    modelId: string,
  ): void {
    childProcess.on("error", (error) => {
      const errorMessage = this.buildLifecycleFailureMessage(
        `llama-server error for ${modelId}: ${error.message}`,
      );

      this.debugLogService.serverLog(errorMessage);

      if (this.unloading) {
        return;
      }

      this.childProcess = null;
      this.activeServerBaseUrl = null;
      this.abortAndClearActiveControllers();
      this.updateSnapshot({
        status: "error",
        lastError: errorMessage,
        llamaServerBaseUrl: null,
      });
    });

    childProcess.on("exit", (code, signal) => {
      const exitMessage = this.buildLifecycleFailureMessage(
        `llama-server exited for ${modelId} with code ${code ?? "null"} and signal ${signal ?? "null"}.`,
      );

      this.debugLogService.serverLog(exitMessage);

      if (!this.unloading) {
        this.childProcess = null;
        this.activeServerBaseUrl = null;
        this.abortAndClearActiveControllers();
        this.updateSnapshot({
          status: "error",
          lastError: exitMessage,
          llamaServerBaseUrl: null,
        });
      }
    });
  }

  /** Polls the `/health` endpoint until the server reports `"ok"` or the deadline elapses. */
  private async waitForHealthy(
    baseUrl: string,
    deadlineMs: number,
    startupFailure: Promise<never>,
  ): Promise<void> {
    while (Date.now() < deadlineMs) {
      if (!this.childProcess) {
        throw new Error("llama-server exited before health checks succeeded.");
      }

      if (this.runtimeSnapshot.status === "error" && this.runtimeSnapshot.lastError) {
        throw new Error(this.runtimeSnapshot.lastError);
      }

      if (await isLlamaServerReady(baseUrl)) {
        return;
      }

      await Promise.race([delay(250), startupFailure]);
    }

    throw new Error("Timed out while waiting for llama-server to become healthy.");
  }

  /** Waits for the spawned process to report its OS-selected listening URL before the deadline. */
  private async waitForListeningBaseUrl(
    deadlineMs: number,
    startupFailure: Promise<never>,
  ): Promise<string> {
    while (Date.now() < deadlineMs) {
      if (!this.childProcess) {
        throw new Error("llama-server exited before reporting a listening address.");
      }

      if (this.runtimeSnapshot.status === "error" && this.runtimeSnapshot.lastError) {
        throw new Error(this.runtimeSnapshot.lastError);
      }

      if (this.activeServerBaseUrl) {
        return this.activeServerBaseUrl;
      }

      await Promise.race([delay(50), startupFailure]);
    }

    throw new Error("Timed out while waiting for llama-server to report its listening address.");
  }

  /** Resets the load-progress inference state for a fresh model spawn. */
  private resetLoadProgressTracking(): void {
    this.recentStderrLines = [];
    this.syntheticLoadProgress = 0;
    this.sawExplicitLoadProgress = false;
    this.tensorLoadDots = 0;
    this.tensorLoadStarted = false;
  }

  /** Tracks a bounded stderr tail for startup and crash diagnostics. */
  private recordStderrLine(line: string): void {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      return;
    }

    this.recentStderrLines.push(trimmedLine);

    if (this.recentStderrLines.length > 12) {
      this.recentStderrLines.splice(0, this.recentStderrLines.length - 12);
    }
  }

  /** Builds a lifecycle failure message including the most recent stderr tail when available. */
  private buildLifecycleFailureMessage(baseMessage: string): string {
    const stderrTail = this.recentStderrLines.slice(-3);

    if (stderrTail.length === 0) {
      return baseMessage;
    }

    return `${baseMessage} Recent stderr: ${stderrTail.join(" | ")}`;
  }

  /** Rejects as soon as the startup child emits an `error` or `exit` event before readiness. */
  private createStartupFailurePromise(
    childProcess: ChildProcessByStdio<null, Readable, Readable>,
    modelId: string,
  ): Promise<never> {
    return new Promise<never>((_, reject) => {
      const cleanup = (): void => {
        childProcess.removeListener("error", handleError);
        childProcess.removeListener("exit", handleExit);
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(
          new Error(
            this.buildLifecycleFailureMessage(
              `llama-server error for ${modelId}: ${error.message}`,
            ),
          ),
        );
      };
      const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(
          new Error(
            this.buildLifecycleFailureMessage(
              `llama-server exited for ${modelId} with code ${code ?? "null"} and signal ${signal ?? "null"}.`,
            ),
          ),
        );
      };

      childProcess.once("error", handleError);
      childProcess.once("exit", handleExit);
    });
  }

  /** Captures explicit or inferred load progress from a single stderr line. */
  private captureLoadProgressFromLine(line: string): void {
    if (this.runtimeSnapshot.status !== "loading") {
      return;
    }

    const explicitProgress = parseLoadProgress(line);

    if (typeof explicitProgress === "number") {
      this.sawExplicitLoadProgress = true;
      this.updateSnapshot({
        loadProgress: Math.max(this.runtimeSnapshot.loadProgress ?? 0, explicitProgress),
      });
      return;
    }

    const inferredProgress = inferLoadProgressFromLine(line);

    if (line.toLowerCase().includes("load_tensors: loading model tensors")) {
      this.tensorLoadStarted = true;
    }

    if (typeof inferredProgress === "number") {
      this.updateHeuristicLoadProgress(inferredProgress);
    }
  }

  /** Captures tensor-loading dot output that is emitted before a newline is flushed. */
  private captureLoadProgressFromChunk(chunkText: string): void {
    if (
      this.runtimeSnapshot.status !== "loading" ||
      this.sawExplicitLoadProgress ||
      !this.tensorLoadStarted
    ) {
      return;
    }

    const dotRuns = chunkText.match(/\.{3,}/g);

    if (!dotRuns) {
      return;
    }

    this.tensorLoadDots += dotRuns.reduce((totalDots, dotRun) => totalDots + dotRun.length, 0);
    this.updateHeuristicLoadProgress(35 + Math.min(50, Math.floor(this.tensorLoadDots * 0.75)));
  }

  /** Captures the bound server URL from startup logs when `--port 0` is used. */
  private captureListeningBaseUrl(outputText: string): void {
    if (this.activeServerBaseUrl) {
      return;
    }

    const listeningBaseUrl = parseListeningBaseUrl(outputText);

    if (!listeningBaseUrl) {
      return;
    }

    this.activeServerBaseUrl = listeningBaseUrl;
    this.debugLogService.verboseServerLog(`llama-server bound to ${listeningBaseUrl}.`);
    this.updateSnapshot({ llamaServerBaseUrl: listeningBaseUrl });
  }

  /** Applies inferred progress without allowing it to exceed the final ready transition. */
  private updateHeuristicLoadProgress(progress: number): void {
    if (this.runtimeSnapshot.status !== "loading" || this.sawExplicitLoadProgress) {
      return;
    }

    const nextProgress = Math.min(99, clampPercentage(progress));
    const previousProgress = this.runtimeSnapshot.loadProgress ?? 0;

    if (nextProgress <= previousProgress && nextProgress <= this.syntheticLoadProgress) {
      return;
    }

    this.syntheticLoadProgress = Math.max(this.syntheticLoadProgress, nextProgress);
    this.updateSnapshot({ loadProgress: this.syntheticLoadProgress });
  }

  /** Extracts `timings` metrics from a response payload and updates the runtime snapshot. */
  private captureRuntimeMetrics(payload: unknown): void {
    const timingsValue = extractObjectRecord(payload, "timings");

    if (!timingsValue) {
      return;
    }

    const cacheCount = readNumberField(timingsValue, "cache_n") ?? 0;
    const promptCount = readNumberField(timingsValue, "prompt_n") ?? 0;
    const predictedCount = readNumberField(timingsValue, "predicted_n") ?? 0;
    const predictedPerSecond = readNumberField(timingsValue, "predicted_per_second");
    const snapshotUpdate: Partial<RuntimeSnapshot> = {
      contextTokens: cacheCount + promptCount + predictedCount,
    };

    if (typeof predictedPerSecond === "number") {
      snapshotUpdate.tokensPerSecond = predictedPerSecond;
    }

    this.updateSnapshot(snapshotUpdate);
  }

  /** Merges a partial snapshot update and broadcasts the new state via SSE. */
  private updateSnapshot(partialSnapshot: Partial<RuntimeSnapshot>): void {
    this.runtimeSnapshot = {
      ...this.runtimeSnapshot,
      ...partialSnapshot,
      updatedAt: new Date().toISOString(),
    };
    this.runtimeBroadcaster.broadcast("runtime", this.runtimeSnapshot);
  }
}

function buildMiddleRemovalOrder(messageCount: number): number[] {
  const removableMessageCount = messageCount - 2;

  if (removableMessageCount <= 0) {
    return [];
  }

  const removableStartIndex = 1;
  const removableEndIndex = messageCount - 2;
  const removalOrder: number[] = [];

  if (removableMessageCount % 2 === 1) {
    const centerIndex = removableStartIndex + Math.floor(removableMessageCount / 2);

    removalOrder.push(centerIndex);

    for (let offset = 1; centerIndex - offset >= removableStartIndex; offset += 1) {
      removalOrder.push(centerIndex - offset);

      if (centerIndex + offset <= removableEndIndex) {
        removalOrder.push(centerIndex + offset);
      }
    }

    return removalOrder;
  }

  const leftCenterIndex = removableStartIndex + removableMessageCount / 2 - 1;
  const rightCenterIndex = leftCenterIndex + 1;

  removalOrder.push(leftCenterIndex, rightCenterIndex);

  for (let offset = 1; leftCenterIndex - offset >= removableStartIndex; offset += 1) {
    removalOrder.push(leftCenterIndex - offset);

    if (rightCenterIndex + offset <= removableEndIndex) {
      removalOrder.push(rightCenterIndex + offset);
    }
  }

  return removalOrder;
}

interface OverflowSegment {
  readonly indices: number[];
}

function buildOverflowSegments(requestMessages: Record<string, unknown>[]): OverflowSegment[] {
  const segments: OverflowSegment[] = [];

  for (let messageIndex = 0; messageIndex < requestMessages.length; ) {
    const message = requestMessages[messageIndex];

    if (!message) {
      messageIndex += 1;
      continue;
    }

    const toolCallIds = getAssistantToolCallIds(message);

    if (toolCallIds.length === 0) {
      segments.push({ indices: [messageIndex] });
      messageIndex += 1;
      continue;
    }

    const remainingToolCallIds = new Set(toolCallIds);
    const indices = [messageIndex];
    let nextMessageIndex = messageIndex + 1;

    while (nextMessageIndex < requestMessages.length) {
      const toolCallId = getToolResultCallId(requestMessages[nextMessageIndex]);

      if (!toolCallId || !remainingToolCallIds.has(toolCallId)) {
        break;
      }

      indices.push(nextMessageIndex);
      remainingToolCallIds.delete(toolCallId);
      nextMessageIndex += 1;
    }

    segments.push({ indices });
    messageIndex = nextMessageIndex;
  }

  return segments;
}

function getAssistantToolCallIds(message: Record<string, unknown>): string[] {
  if (message["role"] !== "assistant" || !Array.isArray(message["tool_calls"])) {
    return [];
  }

  return message["tool_calls"]
    .filter(
      (toolCallValue): toolCallValue is Record<string, unknown> =>
        typeof toolCallValue === "object" &&
        toolCallValue !== null &&
        !Array.isArray(toolCallValue),
    )
    .map((toolCallValue) => toolCallValue["id"])
    .filter((toolCallId): toolCallId is string => typeof toolCallId === "string");
}

function getToolResultCallId(message: Record<string, unknown> | undefined): string | null {
  if (!message || message["role"] !== "tool" || typeof message["tool_call_id"] !== "string") {
    return null;
  }

  return message["tool_call_id"];
}

/**
 * Formats a text file attachment into a structured prompt section with
 * a file-name header and optional truncation notice.
 */
function createTextAttachmentPromptPart(
  fileName: string,
  fileText: string,
  wasTruncated: boolean = false,
): string {
  const sanitizedText = fileText.replaceAll("\u0000", "");
  const normalizedText = wasTruncated
    ? `${sanitizedText}\n\n[The remainder of this attached file was truncated before sending.]`
    : sanitizedText;

  return [
    `Attached text file: ${fileName}`,
    "Use the following file content as part of the user's prompt context:",
    sanitizedText.length > 0 ? normalizedText : "[This attached text file was empty.]",
  ].join("\n\n");
}

function decodeUtf8AttachmentPrefix(buffer: Buffer, bytesRead: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (let endIndex = bytesRead; endIndex >= Math.max(0, bytesRead - 4); endIndex -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, endIndex));
    } catch {
      // Drop only the incomplete trailing UTF-8 sequence.
    }
  }

  return "";
}

function resolvePromptTokenBudget(settings: LoadInferencePreset["settings"]): number {
  const reservedResponseTokens = settings.responseLengthLimit ?? DEFAULT_RESPONSE_TOKEN_RESERVE;

  return Math.max(64, settings.contextLength - reservedResponseTokens - 32);
}

function estimateConversationTokens(
  requestMessages: Record<string, unknown>[],
  settings: LoadInferencePreset["settings"],
): number {
  return requestMessages.reduce(
    (totalTokens, message) =>
      totalTokens + MESSAGE_OVERHEAD_TOKEN_ESTIMATE + estimateMessageTokens(message, settings),
    0,
  );
}

function estimateMessageTokens(
  message: Record<string, unknown>,
  settings: LoadInferencePreset["settings"],
): number {
  const roleText = typeof message["role"] === "string" ? message["role"] : "message";

  return estimateTextTokens(roleText) + estimateContentTokens(message["content"], settings);
}

function estimateContentTokens(
  content: unknown,
  settings: LoadInferencePreset["settings"],
): number {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce((totalTokens, part) => {
    if (!part || typeof part !== "object") {
      return totalTokens;
    }

    const partRecord = part as Record<string, unknown>;

    if (partRecord["type"] === "text" && typeof partRecord["text"] === "string") {
      return totalTokens + estimateTextTokens(partRecord["text"]);
    }

    if (partRecord["type"] === "image_url") {
      return totalTokens + (settings.imageMaxTokens ?? settings.imageMinTokens ?? 256);
    }

    if (partRecord["type"] === "input_audio") {
      return totalTokens + 512;
    }

    return totalTokens;
  }, 0);
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / TEXT_TOKEN_ESTIMATE_DIVISOR));
}

/** Maps a MIME type to a short audio format identifier for the `input_audio` content part. */
/** Extracts the bound server URL from llama-server startup logs. */
function parseListeningBaseUrl(outputText: string): string | null {
  const match = outputText.match(/server is listening on (https?:\/\/[^\s]+)/i);

  return match?.[1] ?? null;
}

/**
 * Gracefully terminates a `llama-server` child process with platform-specific
 * logic: `SIGTERM` on Unix (escalating to `SIGKILL`), or `taskkill /F` on Windows.
 */
async function terminateChildProcess(
  childProcess: ChildProcessByStdio<null, Readable, Readable>,
): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    childProcess.kill();

    try {
      await waitForExit(childProcess, 5_000);
      return;
    } catch {
      if (childProcess.pid) {
        await Bun.spawn(["taskkill", "/T", "/F", "/PID", String(childProcess.pid)], {
          stderr: "ignore",
          stdin: "ignore",
          stdout: "ignore",
        }).exited;
        await waitForExit(childProcess, 5_000).catch(() => undefined);
      }
    }

    return;
  }

  childProcess.kill("SIGTERM");

  try {
    await waitForExit(childProcess, 5_000);
  } catch {
    childProcess.kill("SIGKILL");
    await waitForExit(childProcess, 2_000).catch(() => undefined);
  }
}

/**
 * Performs synchronous best-effort termination during process exit, using
 * `taskkill /T /F` on Windows so child processes do not keep ports bound.
 */
function terminateChildProcessOnExit(
  childProcess: ChildProcessByStdio<null, Readable, Readable>,
): void {
  if (process.platform === "win32" && childProcess.pid) {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(childProcess.pid)], {
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      });
      return;
    } catch {
      // Fall through to the direct child-process kill path below.
    }
  }

  try {
    childProcess.kill();
  } catch {
    // Best-effort cleanup only.
  }
}

/** Waits for a child process to emit `"exit"`, racing against a timeout. */
async function waitForExit(
  childProcess: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      const cleanup = (): void => {
        childProcess.removeListener("close", handleCloseOrExit);
        childProcess.removeListener("error", handleCloseOrExit);
        childProcess.removeListener("exit", handleCloseOrExit);
      };
      const handleCloseOrExit = (): void => {
        cleanup();
        resolve();
      };

      childProcess.once("close", handleCloseOrExit);
      childProcess.once("error", handleCloseOrExit);
      childProcess.once("exit", handleCloseOrExit);
    }),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out while waiting for the child process to exit.");
    }),
  ]);
}

/** Fetches and parses a JSON response from the given URL. */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Upstream request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

/** Verifies that the upstream runtime is both healthy and exposing loaded model metadata. */
async function isLlamaServerReady(baseUrl: string): Promise<boolean> {
  try {
    const healthResponse = await fetch(`${baseUrl}/health`);

    if (!healthResponse.ok) {
      return false;
    }

    const healthPayload = (await healthResponse.json()) as { status?: string };

    if (healthPayload.status !== "ok") {
      return false;
    }

    const modelInfoResponse = await fetch(`${baseUrl}/v1/models`);

    if (!modelInfoResponse.ok) {
      return false;
    }

    const modelInfoPayload = (await modelInfoResponse.json()) as { data?: unknown };
    const firstModel = Array.isArray(modelInfoPayload.data) ? modelInfoPayload.data[0] : null;

    if (!firstModel || typeof firstModel !== "object") {
      return false;
    }

    const meta = (firstModel as Record<string, unknown>)["meta"];

    return Boolean(meta && typeof meta === "object");
  } catch {
    return false;
  }
}

/** Parses a model-loading progress percentage from a `llama-server` log line. */
function parseLoadProgress(line: string): number | undefined {
  const percentMatch = line.match(/llama_model_load.*?(\d{1,3}(?:\.\d+)?)%/i);

  if (percentMatch) {
    return clampPercentage(Number(percentMatch[1]));
  }

  const jsonProgressMatch = line.match(/"progress"\s*:\s*(\d{1,3}(?:\.\d+)?)/i);

  if (jsonProgressMatch) {
    return clampPercentage(Number(jsonProgressMatch[1]));
  }

  return undefined;
}

/** Infers approximate model-load progress from well-known `llama-server` startup stages. */
function inferLoadProgressFromLine(line: string): number | undefined {
  const normalizedLine = line.trim().toLowerCase();

  if (normalizedLine.length === 0) {
    return undefined;
  }

  if (normalizedLine.includes("main: loading model")) {
    return 2;
  }

  if (normalizedLine.includes("load_model: loading model")) {
    return 6;
  }

  if (normalizedLine.includes("fitting params to free memory took")) {
    return 12;
  }

  if (normalizedLine.includes("loaded meta data")) {
    return 18;
  }

  if (normalizedLine.includes("load_tensors: loading model tensors")) {
    return 32;
  }

  if (normalizedLine.includes("offloaded") && normalizedLine.includes("layers to gpu")) {
    return 40;
  }

  if (normalizedLine.includes("constructing llama_context")) {
    return 84;
  }

  if (normalizedLine.includes("warming up the model")) {
    return 92;
  }

  if (normalizedLine.includes("initializing slots")) {
    return 96;
  }

  if (
    normalizedLine.includes("main: model loaded") ||
    normalizedLine.includes("server is listening")
  ) {
    return 99;
  }

  return undefined;
}

/** Clamps a numeric value to the 0–100 percentage range. */
function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Collects modality strings from the `/props` and `/v1/models` endpoint
 * responses into a normalised lowercase `Set`.
 */
function collectModalities(
  propsResponse: LlamaServerPropsResponse,
  modelsResponse: Record<string, unknown>,
): Set<string> {
  const modalities = new Set<string>();
  const directPropsModalities = asStringArray(propsResponse.modalities);

  for (const modality of directPropsModalities) {
    modalities.add(modality.toLowerCase());
  }

  const modelData = modelsResponse["data"];
  const dataArray = Array.isArray(modelData) ? modelData : [];

  for (const item of dataArray) {
    const metaObject = extractObjectRecord(item, "meta");
    const metaModalities = metaObject ? asStringArray(metaObject["modalities"]) : [];

    for (const modality of metaModalities) {
      modalities.add(modality.toLowerCase());
    }
  }

  return modalities;
}

/** Coerces an unknown value to a `string[]`, filtering out non-string entries. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function schemaContainsUnsupportedReference(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => schemaContainsUnsupportedReference(entry));
  }

  const record = value as Record<string, unknown>;

  if ("$ref" in record) {
    return true;
  }

  return Object.values(record).some((entry) => schemaContainsUnsupportedReference(entry));
}

function isPortInUseError(errorMessage: string): boolean {
  return /address already in use|eaddrinuse/i.test(errorMessage);
}

async function supportsLlamaServerFlag(
  llamaServerPath: string,
  flagName: string,
): Promise<boolean> {
  const normalizedFlagName = flagName.trim().toLowerCase();

  if (normalizedFlagName.length === 0) {
    return false;
  }

  const helpText = await getLlamaServerHelpText(llamaServerPath);

  return helpText?.toLowerCase().includes(normalizedFlagName) === true;
}

async function getLlamaServerHelpText(llamaServerPath: string): Promise<string | null> {
  const cachedHelpText = llamaServerHelpTextCache.get(llamaServerPath);

  if (cachedHelpText) {
    return await cachedHelpText;
  }

  const helpTextPromise = (async (): Promise<string | null> => {
    try {
      const helpResult = await execFileAsync(llamaServerPath, ["--help"], {
        maxBuffer: 1024 * 1024,
        timeout: 5000,
        windowsHide: true,
      });
      const combinedOutput = `${helpResult.stdout}\n${helpResult.stderr}`.trim();

      return combinedOutput.length > 0 ? combinedOutput : null;
    } catch (error) {
      if (error && typeof error === "object") {
        const stdoutText =
          "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
        const stderrText =
          "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
        const combinedOutput = `${stdoutText}\n${stderrText}`.trim();

        if (combinedOutput.length > 0) {
          return combinedOutput;
        }
      }

      return null;
    }
  })();

  llamaServerHelpTextCache.set(llamaServerPath, helpTextPromise);

  return await helpTextPromise;
}

/** Safely extracts a nested object property from an unknown value. */
function extractObjectRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || !(key in value)) {
    return null;
  }

  const recordValue = (value as Record<string, unknown>)[key];

  return recordValue && typeof recordValue === "object"
    ? (recordValue as Record<string, unknown>)
    : null;
}

/** Reads a numeric field from a record, coercing string values to numbers. */
function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsedValue = Number(value);

    return Number.isFinite(parsedValue) ? parsedValue : undefined;
  }

  return undefined;
}
