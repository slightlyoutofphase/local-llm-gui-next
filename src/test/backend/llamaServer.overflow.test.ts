import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { LoadInferencePreset, RuntimeSnapshot } from "../../lib/contracts";
import { DebugLogService } from "../../backend/debug";
import { LlamaServerManager } from "../../backend/llamaServer";
import type { ApplicationPaths } from "../../backend/paths";
import { JsonSseBroadcaster } from "../../backend/sse";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe.serial("LlamaServerManager overflow handling", () => {
  let applicationPaths: ApplicationPaths;
  let manager: LlamaServerManager;
  let originalFetch: typeof fetch;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-llama-overflow");
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

    manager = new LlamaServerManager(
      applicationPaths,
      new DebugLogService(),
      new JsonSseBroadcaster<RuntimeSnapshot>({
        bufferWhenDisconnected: false,
        maxEntries: 16,
      }),
    );
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await removeBackendTestScratchDir(rootDir);
  });

  test("rejects requests that exceed the context budget in stop-at-limit mode", async () => {
    let fetchCalled = false;

    setRuntimeSnapshot(manager, createReadySnapshot());
    setActiveLoadPreset(
      manager,
      createPreset({
        contextLength: 128,
        overflowStrategy: "stop-at-limit",
        responseLengthLimit: 64,
      }),
    );

    const fetchMock = Object.assign(
      async (): Promise<Response> => {
        fetchCalled = true;
        return Response.json({ ok: true });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;
    globalThis.fetch = fetchMock;

    const response = await manager.proxyChatCompletion(
      {
        messages: [
          { content: "first", role: "user" },
          { content: "x".repeat(500), role: "assistant" },
          { content: "last", role: "user" },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toContain("context budget");
    expect(fetchCalled).toBe(false);
  });

  test("returns a clear 409 payload when a concurrent llama-server request is already active", async () => {
    setRuntimeSnapshot(manager, createReadySnapshot());
    const activeAbortController = new AbortController();

    Reflect.set(manager, "activeRequestAbortController", activeAbortController);
    Reflect.set(manager, "activeRequestPriority", "foreground");
    Reflect.set(manager, "activeRequestChatId", "chat-1");

    const response = await (manager as any).proxyJsonRequest(
      "/completion",
      { prompt: "hello" },
      new AbortController().signal,
      "background",
      null,
    );
    const payload = (await response.json()) as { activeChatId?: string; error?: string; retryable?: boolean };

    expect(response.status).toBe(409);
    expect(payload.activeChatId).toBe("chat-1");
    expect(payload.error).toContain("retry after the current request completes");
    expect(payload.retryable).toBe(true);
  });

  test("drops middle messages before proxying when truncate-middle is selected", async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    setRuntimeSnapshot(manager, createReadySnapshot());
    setActiveLoadPreset(
      manager,
      createPreset({
        contextLength: 256,
        overflowStrategy: "truncate-middle",
        responseLengthLimit: 32,
      }),
    );

    const fetchMock = Object.assign(
      async (_input: unknown, init?: RequestInit): Promise<Response> => {
        capturedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

        return Response.json({ ok: true });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;
    globalThis.fetch = fetchMock;

    const response = await manager.proxyChatCompletion(
      {
        messages: [
          { content: "keep-first", role: "user" },
          { content: "middle".repeat(120), role: "assistant" },
          { content: "keep-last", role: "user" },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;

    expect(response.ok).toBe(true);
    expect(upstreamMessages.map((message) => message["content"])).toEqual([
      "keep-first",
      "keep-last",
    ]);
  });

  test("drops multiple middle messages in center-out order when truncation must continue", async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    setRuntimeSnapshot(manager, createReadySnapshot());
    setActiveLoadPreset(
      manager,
      createPreset({
        contextLength: 214,
        overflowStrategy: "truncate-middle",
        responseLengthLimit: 32,
      }),
    );

    const fetchMock = Object.assign(
      async (_input: unknown, init?: RequestInit): Promise<Response> => {
        capturedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

        return Response.json({ ok: true });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;
    globalThis.fetch = fetchMock;

    const response = await manager.proxyChatCompletion(
      {
        messages: [
          { content: "keep-first", role: "user" },
          { content: "left".repeat(120), role: "assistant" },
          { content: "center".repeat(120), role: "assistant" },
          { content: "keep-right-middle", role: "assistant" },
          { content: "keep-last", role: "user" },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;

    expect(response.ok).toBe(true);
    expect(upstreamMessages.map((message) => message["content"])).toEqual([
      "keep-first",
      "keep-right-middle",
      "keep-last",
    ]);
  });

  test("removes assistant tool-call groups together with their tool results", async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    setRuntimeSnapshot(manager, createReadySnapshot());
    setActiveLoadPreset(
      manager,
      createPreset({
        contextLength: 188,
        overflowStrategy: "truncate-middle",
        responseLengthLimit: 32,
      }),
    );

    const fetchMock = Object.assign(
      async (_input: unknown, init?: RequestInit): Promise<Response> => {
        capturedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

        return Response.json({ ok: true });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;
    globalThis.fetch = fetchMock;

    const response = await manager.proxyChatCompletion(
      {
        messages: [
          { content: "keep-first", role: "user" },
          {
            content: "",
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: '{"path":"draft.txt"}',
                  name: "rename_file",
                },
                id: "call_1",
                type: "function",
              },
            ],
          },
          {
            content: JSON.stringify({ ok: true, result: "x".repeat(400) }),
            role: "tool",
            tool_call_id: "call_1",
          },
          { content: "keep-last", role: "user" },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;

    expect(response.ok).toBe(true);
    expect(upstreamMessages).toEqual([
      { content: "keep-first", role: "user" },
      { content: "keep-last", role: "user" },
    ]);
  });

  test("requires context shift before accepting rolling-window mode", async () => {
    let fetchCalled = false;

    setRuntimeSnapshot(manager, createReadySnapshot());
    setActiveLoadPreset(
      manager,
      createPreset({
        contextLength: 512,
        contextShift: false,
        overflowStrategy: "rolling-window",
      }),
    );

    const fetchMock = Object.assign(
      async (): Promise<Response> => {
        fetchCalled = true;
        return Response.json({ ok: true });
      },
      {
        preconnect: originalFetch.preconnect.bind(originalFetch),
      },
    ) as typeof fetch;
    globalThis.fetch = fetchMock;

    const response = await manager.proxyChatCompletion(
      {
        messages: [{ content: "hello", role: "user" }],
        stream: false,
      },
      new AbortController().signal,
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toContain("Context Shift");
    expect(fetchCalled).toBe(false);
  });
});

function createPreset(overrides: Partial<LoadInferencePreset["settings"]>): LoadInferencePreset {
  return {
    id: "overflow-preset",
    modelId: "test-model",
    name: "Overflow",
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
      repeatPenalty: 1,
      structuredOutputMode: "off",
      ...overrides,
    },
    isDefault: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createReadySnapshot(): RuntimeSnapshot {
  return {
    activeModelId: "test-model",
    activeModelPath: null,
    audio: false,
    contextLimitTokens: 512,
    contextTokens: null,
    lastError: null,
    llamaServerBaseUrl: "http://127.0.0.1:3456",
    loadProgress: 100,
    multimodal: false,
    status: "ready",
    tokensPerSecond: null,
    updatedAt: new Date().toISOString(),
  };
}

function setActiveLoadPreset(manager: LlamaServerManager, preset: LoadInferencePreset): void {
  Reflect.set(manager, "activeLoadPreset", preset);
}

function setRuntimeSnapshot(manager: LlamaServerManager, snapshot: RuntimeSnapshot): void {
  Reflect.set(manager, "runtimeSnapshot", snapshot);
}
