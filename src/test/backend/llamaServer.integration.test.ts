import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
  AppConfig,
  DebugLogSource,
  LoadInferencePreset,
  ModelRecord,
  RuntimeSnapshot,
  SystemPromptPreset,
} from "../../lib/contracts";
import { DebugLogService } from "../../backend/debug";
import { LlamaServerManager } from "../../backend/llamaServer";
import type { ApplicationPaths } from "../../backend/paths";
import { JsonSseBroadcaster } from "../../backend/sse";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

const LLAMA_SERVER_PATH = path.resolve("vendor/llama-cpp/llama-server.exe");
const MODEL_DIR = path.resolve("test/models/unsloth/Qwen3.5-0.8B-GGUF");
const MODEL_PATH = path.join(MODEL_DIR, "Qwen3.5-0.8B-Q8_0.gguf");

function createMinimalConfig(): AppConfig {
  return {
    autoNamingEnabled: true,
    llamaServerPath: LLAMA_SERVER_PATH,
    modelsPath: path.resolve("test/models"),
    customBinaries: {},
    debug: {
      enabled: true,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    },
    theme: "system",
    toolEnabledStates: {},
  };
}

function createMinimalModel(): ModelRecord {
  return {
    id: "unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf",
    publisher: "unsloth",
    modelName: "Qwen3.5-0.8B-GGUF",
    fileName: "Qwen3.5-0.8B-Q8_0.gguf",
    modelPath: MODEL_PATH,
    fileSizeBytes: 0,
    architecture: "qwen3",
    contextLength: 512,
    quantization: "Q8_0",
    supportsAudio: false,
    defaultSampling: {},
  };
}

function createMinimalPreset(): LoadInferencePreset {
  return {
    id: "test-preset",
    modelId: "test-model",
    name: "Test Preset",
    settings: {
      contextLength: 512,
      gpuLayers: 0,
      cpuThreads: 2,
      batchSize: 64,
      ubatchSize: 32,
      unifiedKvCache: false,
      offloadKvCache: false,
      useMmap: true,
      keepModelInMemory: false,
      flashAttention: false,
      fullSwaCache: false,
      contextShift: false,
      seed: 42,
      thinkingEnabled: false,
      overflowStrategy: "truncate-middle",
      stopStrings: [],
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
      minP: 0.05,
      presencePenalty: 0,
      repeatPenalty: 1.0,
      structuredOutputMode: "off",
    },
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMinimalSystemPromptPreset(): SystemPromptPreset {
  return {
    id: "test-system-prompt",
    modelId: "test-model",
    name: "Default",
    systemPrompt: "You are a helpful assistant.",
    thinkingTags: { startString: "<think>", endString: "</think>" },
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe.serial("LlamaServerManager integration", () => {
  let applicationPaths: ApplicationPaths;
  let debugLogService: DebugLogService;
  let runtimeBroadcaster: JsonSseBroadcaster<RuntimeSnapshot>;
  let manager: LlamaServerManager;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-integration");
    applicationPaths = {
      configFilePath: path.join(rootDir, "config.json"),
      databasePath: path.join(rootDir, "local-llm-gui.sqlite"),
      mediaDir: path.join(rootDir, "media"),
      staticOutDir: path.join(rootDir, "out"),
      tempDir: path.join(rootDir, "temp"),
      toolsDir: path.join(rootDir, "tools"),
      userDataDir: rootDir,
      workspaceRoot: rootDir,
    };

    await Promise.all([
      mkdir(applicationPaths.mediaDir, { recursive: true }),
      mkdir(applicationPaths.tempDir, { recursive: true }),
      mkdir(applicationPaths.toolsDir, { recursive: true }),
    ]);

    debugLogService = new DebugLogService();
    runtimeBroadcaster = new JsonSseBroadcaster<RuntimeSnapshot>({
      bufferWhenDisconnected: true,
      maxEntries: 64,
    });
    manager = new LlamaServerManager(applicationPaths, debugLogService, runtimeBroadcaster);
  });

  afterEach(async () => {
    await manager.unload("test-cleanup");
    await removeBackendTestScratchDir(rootDir);
  });

  test(
    "flash attention toggle emits an explicit llama-server value",
    async () => {
      const buildSpawnArguments = Reflect.get(manager, "buildSpawnArguments") as (
        options: {
          config: AppConfig;
          loadPreset: LoadInferencePreset;
          model: ModelRecord;
          systemPromptPreset: SystemPromptPreset;
        },
        port: number,
      ) => Promise<string[]>;

      const spawnArguments = await buildSpawnArguments(
        {
          config: createMinimalConfig(),
          loadPreset: {
            ...createMinimalPreset(),
            settings: {
              ...createMinimalPreset().settings,
              flashAttention: true,
            },
          },
          model: createMinimalModel(),
          systemPromptPreset: createMinimalSystemPromptPreset(),
        },
        0,
      );

      expect(spawnArguments).toContain("--flash-attn");
      expect(spawnArguments[spawnArguments.indexOf("--flash-attn") + 1]).toBe("on");
      expect(spawnArguments[spawnArguments.indexOf("--port") + 1]).toBe("0");
    },
    { timeout: 20_000 },
  );

  test("captures the OS-selected listening URL from llama-server startup logs", () => {
    const captureListeningBaseUrl = (
      Reflect.get(manager, "captureListeningBaseUrl") as (outputText: string) => void
    ).bind(manager);

    Reflect.set(manager, "runtimeSnapshot", {
      ...manager.getSnapshot(),
      status: "loading",
    });

    captureListeningBaseUrl("main: server is listening on http://127.0.0.1:5966");

    expect(manager.getSnapshot().llamaServerBaseUrl).toBe("http://127.0.0.1:5966");
    expect(Reflect.get(manager, "activeServerBaseUrl")).toBe("http://127.0.0.1:5966");
  });

  test("stopGeneration waits for the tracked request to fully unwind", async () => {
    const activeAbortController = new AbortController();
    let resolveActiveRequest: () => void = () => undefined;

    Reflect.set(manager, "activeRequestAbortController", activeAbortController);
    Reflect.set(manager, "activeRequestChatId", "chat-1");
    Reflect.set(manager, "activeRequestPriority", "foreground");
    Reflect.set(
      manager,
      "activeRequestSettledPromise",
      new Promise<void>((resolve) => {
        resolveActiveRequest = resolve;
      }),
    );

    const stopPromise = manager.stopGeneration("chat-1");
    let resolved = false;

    void stopPromise.then(() => {
      resolved = true;
    });

    expect(activeAbortController.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveActiveRequest();
    await stopPromise;

    expect(resolved).toBe(true);
  });

  test("beginForegroundGeneration rejects overlapping generations with explicit client state", async () => {
    const firstGeneration = manager.beginForegroundGeneration(
      "chat-1",
      new AbortController().signal,
    );

    expect(firstGeneration).not.toBeInstanceOf(Response);

    if (firstGeneration instanceof Response) {
      throw new Error("Expected the first generation session to start successfully.");
    }

    try {
      const secondGeneration = manager.beginForegroundGeneration(
        "chat-2",
        new AbortController().signal,
      );

      expect(secondGeneration).toBeInstanceOf(Response);

      if (!(secondGeneration instanceof Response)) {
        throw new Error("Expected the overlapping generation to be rejected.");
      }

      const payload = (await secondGeneration.json()) as {
        activeChatId?: string | null;
        retryable?: boolean;
        state?: string;
      };

      expect(secondGeneration.status).toBe(409);
      expect(payload.activeChatId).toBe("chat-1");
      expect(payload.retryable).toBe(true);
      expect(payload.state).toBe("running");
    } finally {
      firstGeneration.complete();
    }
  });

  test("stopGeneration waits for the tracked generation session to unwind between turns", async () => {
    const generationSession = manager.beginForegroundGeneration(
      "chat-1",
      new AbortController().signal,
    );

    expect(generationSession).not.toBeInstanceOf(Response);

    if (generationSession instanceof Response) {
      throw new Error("Expected the generation session to start successfully.");
    }

    const stopPromise = manager.stopGeneration("chat-1");
    let resolved = false;

    void stopPromise.then(() => {
      resolved = true;
    });

    expect(generationSession.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(resolved).toBe(false);

    generationSession.complete();
    await stopPromise;

    expect(resolved).toBe(true);
  });

  test(
    "dead-on-arrival model startup fails quickly with stderr diagnostics",
    async () => {
      const startedAt = Date.now();

      await expect(
        manager.loadModel({
          config: createMinimalConfig(),
          model: {
            ...createMinimalModel(),
            fileName: "missing-model.gguf",
            id: "missing/Missing/missing-model.gguf",
            modelName: "Missing",
            modelPath: path.join(rootDir, "missing-model.gguf"),
          },
          loadPreset: createMinimalPreset(),
          systemPromptPreset: createMinimalSystemPromptPreset(),
        }),
      ).rejects.toThrow();

      const elapsedMs = Date.now() - startedAt;
      const snapshot = manager.getSnapshot();

      expect(elapsedMs).toBeLessThan(10_000);
      expect(snapshot.status).toBe("error");
      expect(snapshot.lastError).toContain("missing-model.gguf");
      expect(snapshot.lastError).not.toContain("Timed out while waiting");
      expect(Reflect.get(manager, "childProcess")).toBeNull();
    },
    { timeout: 20_000 },
  );

  test("unload does not wait for an exit event that already happened", async () => {
    class FakeExitedChildProcess extends EventEmitter {
      public exitCode = 0;
      public killCalls = 0;
      public pid = 123;
      public signalCode: NodeJS.Signals | null = null;
      public readonly stderr = new EventEmitter() as Readable;
      public readonly stdout = new EventEmitter() as Readable;

      public kill(): boolean {
        this.killCalls += 1;
        return true;
      }
    }

    const fakeChildProcess = new FakeExitedChildProcess();

    Reflect.set(manager, "childProcess", fakeChildProcess);
    Reflect.set(manager, "activeModel", createMinimalModel());
    Reflect.set(manager, "activeLoadPreset", createMinimalPreset());
    Reflect.set(manager, "activeSystemPromptPreset", createMinimalSystemPromptPreset());
    Reflect.set(manager, "activeServerBaseUrl", "http://127.0.0.1:9999");

    manager.prepareForShutdown();

    await Promise.race([
      manager.unload("already-exited"),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Unload hung while waiting on an already-exited child process."));
        }, 500);
      }),
    ]);

    expect(fakeChildProcess.killCalls).toBe(0);
    expect(Reflect.get(manager, "childProcess")).toBeNull();
    expect(manager.getSnapshot().status).toBe("idle");
  });

  test(
    "tears down the child process when post-spawn metadata probing fails",
    async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = Object.assign(
        async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
          const requestUrl =
            typeof input === "string" || input instanceof URL ? String(input) : input.url;

          if (requestUrl.endsWith("/health")) {
            return Response.json({ status: "ok" });
          }

          if (requestUrl.endsWith("/props")) {
            return new Response("metadata probe failed", { status: 500 });
          }

          if (requestUrl.endsWith("/v1/models")) {
            return Response.json({ data: [{ id: "test-model", meta: {} }] });
          }

          return await originalFetch(input, init);
        },
        {
          preconnect: originalFetch.preconnect.bind(originalFetch),
        },
      ) as typeof fetch;

      globalThis.fetch = fetchMock;

      try {
        await expect(
          manager.loadModel({
            config: createMinimalConfig(),
            model: createMinimalModel(),
            loadPreset: createMinimalPreset(),
            systemPromptPreset: createMinimalSystemPromptPreset(),
          }),
        ).rejects.toThrow("Upstream request failed with status 500.");
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(manager.getSnapshot().status).toBe("error");
      expect(manager.getSnapshot().lastError).toContain("500");
      expect(Reflect.get(manager, "childProcess")).toBeNull();
    },
    { timeout: 120_000 },
  );

  test("disposeOnExit does not mark an intentional process shutdown as a runtime crash", () => {
    class FakeChildProcess extends EventEmitter {
      public killCalls = 0;
      public readonly stderr = new EventEmitter() as Readable;
      public readonly stdout = new EventEmitter() as Readable;

      public kill(): boolean {
        this.killCalls += 1;
        this.emit("exit", 0, null);
        return true;
      }
    }

    const fakeChildProcess = new FakeChildProcess();
    const attachLifecycleListeners = Reflect.get(manager, "attachLifecycleListeners") as (
      childProcess: EventEmitter,
      modelId: string,
    ) => void;

    Reflect.set(manager, "childProcess", fakeChildProcess);
    attachLifecycleListeners(fakeChildProcess, "test-model");

    manager.disposeOnExit();

    expect(fakeChildProcess.killCalls).toBe(1);
    expect(Reflect.get(manager, "childProcess")).toBeNull();
    expect(manager.getSnapshot().status).not.toBe("error");
    expect(manager.getSnapshot().lastError).toBeNull();
  });

  test(
    "spawns llama-server, reaches healthy, and responds to completion",
    async () => {
      const snapshot = await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.activeModelId).toBe("unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf");
      expect(snapshot.contextLimitTokens).toBe(512);
      expect(snapshot.llamaServerBaseUrl).toBeTruthy();

      const completionResponse = await manager.proxyChatCompletion(
        {
          messages: [{ role: "user", content: "Say hello" }],
          stream: false,
        },
        new AbortController().signal,
      );

      expect(completionResponse.ok).toBe(true);

      const completionBody = (await completionResponse.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const firstChoice = completionBody.choices?.[0]?.message?.content ?? "";

      expect(firstChoice.length).toBeGreaterThan(0);

      const postRequestSnapshot = manager.getSnapshot();

      expect(postRequestSnapshot.status).toBe("ready");
    },
    { timeout: 120_000 },
  );

  test(
    "stderr progress parser emits load progress updates",
    async () => {
      const broadcastedSnapshots: RuntimeSnapshot[] = [];
      const originalBroadcast = runtimeBroadcaster.broadcast.bind(runtimeBroadcaster);

      runtimeBroadcaster.broadcast = (type: string, payload: RuntimeSnapshot) => {
        broadcastedSnapshots.push({ ...payload });
        return originalBroadcast(type, payload);
      };

      await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      const loadingSnapshots = broadcastedSnapshots.filter(
        (s) => s.status === "loading" && typeof s.loadProgress === "number" && s.loadProgress > 0,
      );
      const readySnapshot = manager.getSnapshot();

      expect(readySnapshot.status).toBe("ready");
      expect(readySnapshot.loadProgress).toBe(100);
      expect(loadingSnapshots.length).toBeGreaterThan(0);
      expect(loadingSnapshots[0]!.loadProgress).toBeGreaterThan(0);
    },
    { timeout: 120_000 },
  );

  test(
    "debug log receives process output during load",
    async () => {
      const debugEntries: Array<{ source: DebugLogSource; message: string }> = [];
      const originalLog = debugLogService.log.bind(debugLogService);

      debugLogService.log = (source: DebugLogSource, message: string) => {
        debugEntries.push({ source, message });
        originalLog(source, message);
      };

      await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      const stderrEntries = debugEntries.filter((e) => e.source === "process:stderr");
      const serverLogEntries = debugEntries.filter((e) => e.source === "server:log");

      expect(stderrEntries.length).toBeGreaterThan(0);
      expect(serverLogEntries.length).toBeGreaterThan(0);
    },
    { timeout: 120_000 },
  );

  test(
    "timings extraction populates tokensPerSecond after proxied completion",
    async () => {
      await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      const response = await manager.proxyChatCompletion(
        {
          messages: [{ role: "user", content: "Say hello" }],
          stream: false,
          n_predict: 8,
        },
        new AbortController().signal,
      );

      expect(response.ok).toBe(true);
      await response.text();

      const snapshot = manager.getSnapshot();

      expect(typeof snapshot.tokensPerSecond).toBe("number");
      expect(snapshot.tokensPerSecond!).toBeGreaterThan(0);
    },
    { timeout: 120_000 },
  );

  test(
    "abort flow closes stream without crashing the server",
    async () => {
      await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      const abortController = new AbortController();

      const responsePromise = manager.proxyChatCompletion(
        {
          messages: [{ role: "user", content: "Write a very long essay about everything." }],
          stream: true,
          n_predict: 256,
        },
        abortController.signal,
      );

      const response = await responsePromise;

      expect(response.ok).toBe(true);
      expect(response.body).toBeTruthy();

      const reader = response.body!.getReader();
      const firstChunk = await reader.read();

      expect(firstChunk.done).toBe(false);

      abortController.abort();

      let done = false;

      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
      }

      const postAbortSnapshot = manager.getSnapshot();

      expect(postAbortSnapshot.status).toBe("ready");
    },
    { timeout: 120_000 },
  );

  test(
    "process remains alive after request completes",
    async () => {
      await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      const response = await manager.proxyChatCompletion(
        {
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
          n_predict: 4,
        },
        new AbortController().signal,
      );

      expect(response.ok).toBe(true);
      await response.text();

      expect(manager.getSnapshot().status).toBe("ready");

      const healthResponse = await fetch(`${manager.getSnapshot().llamaServerBaseUrl}/health`);

      expect(healthResponse.ok).toBe(true);

      const healthBody = (await healthResponse.json()) as { status?: string };

      expect(healthBody.status).toBe("ok");
    },
    { timeout: 120_000 },
  );

  test(
    "unload gracefully terminates the child process",
    async () => {
      const snapshot = await manager.loadModel({
        config: createMinimalConfig(),
        model: createMinimalModel(),
        loadPreset: createMinimalPreset(),
        systemPromptPreset: createMinimalSystemPromptPreset(),
      });

      expect(snapshot.status).toBe("ready");

      const baseUrl = snapshot.llamaServerBaseUrl!;

      await manager.unload("test-unload");

      expect(manager.getSnapshot().status).toBe("idle");
      expect(manager.getSnapshot().activeModelId).toBeNull();
      expect(manager.getSnapshot().contextLimitTokens).toBeNull();

      let healthFailed = false;

      try {
        await fetch(`${baseUrl}/health`);
      } catch {
        healthFailed = true;
      }

      expect(healthFailed).toBe(true);
    },
    { timeout: 120_000 },
  );
});
