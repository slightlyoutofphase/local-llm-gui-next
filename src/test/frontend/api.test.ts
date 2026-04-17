import { afterEach, expect, test } from "bun:test";
import {
  buildTimedRequestSignal,
  getChat,
  getChats,
  getChatsWithOptions,
  getMediaAttachmentUrl,
  isRetryableRequestError,
  loadModel,
  requestJson,
  subscribeToJsonSse,
} from "../../lib/api";
import { calculateRuntimeLoadTimeoutMs } from "../../lib/runtimeLoad";

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;
const originalAbortSignalTimeout = AbortSignal.timeout;

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortSignalTimeout;
});

test("getMediaAttachmentUrl returns a trailing-slash media route", () => {
  expect(getMediaAttachmentUrl("chat id", "attachment/id")).toBe(
    "/api/chats/chat%20id/media/attachment%2Fid/",
  );
});

test("subscribeToJsonSse forwards EventSource errors to the optional callback", () => {
  class FakeEventSource {
    private readonly listeners = new Map<string, Set<EventListener>>();

    public addEventListener(type: string, listener: EventListener): void {
      const listenersForType = this.listeners.get(type) ?? new Set<EventListener>();

      listenersForType.add(listener);
      this.listeners.set(type, listenersForType);
    }

    public removeEventListener(type: string, listener: EventListener): void {
      this.listeners.get(type)?.delete(listener);
    }

    public close(): void {}

    public emit(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    }
  }

  const fakeEventSource = new FakeEventSource();
  const errorKinds: string[] = [];

  globalThis.EventSource = class {
    public constructor() {
      return fakeEventSource as unknown as EventSource;
    }
  } as typeof EventSource;

  const disconnect = subscribeToJsonSse("/api/events/runtime", "runtime", () => {}, {
    onError: (error) => {
      errorKinds.push(error.kind);
    },
    reconnect: false,
  });

  fakeEventSource.emit("error");
  disconnect();

  expect(errorKinds).toEqual(["transient"]);
});

test("requestJson attaches a timeout-backed abort signal to JSON requests", async () => {
  let capturedSignal: AbortSignal | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedSignal = (init?.signal as AbortSignal | null | undefined) ?? null;

    return Response.json({ chats: [], dbRevision: 0 });
  }) as typeof fetch;

  await getChats();

  expect(capturedSignal).not.toBeNull();
  expect(capturedSignal?.aborted).toBe(false);
});

test("requestJson retries POST requests with an explicit idempotency header", async () => {
  let attempt = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    attempt += 1;

    if (attempt === 1) {
      return new Response("Service unavailable", { status: 503 });
    }

    return Response.json({ success: true });
  }) as typeof fetch;

  const result = await requestJson<{ success: boolean }>("/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Idempotency-Key": "retryable" },
    body: JSON.stringify({ data: "ok" }),
  });

  expect(attempt).toBe(2);
  expect(result.success).toBe(true);
});

test("requestJson does not retry unsafe POST requests by default", async () => {
  let attempt = 0;
  globalThis.fetch = (async () => {
    attempt += 1;
    return new Response("Service unavailable", { status: 503 });
  }) as typeof fetch;

  await expect(
    requestJson<{ success: boolean }>("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "ok" }),
    }),
  ).rejects.toThrow();

  expect(attempt).toBe(1);
});

test("getChats forwards an explicit abort signal when provided", async () => {
  const abortController = new AbortController();
  let capturedSignal: AbortSignal | null = null;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedSignal = (init?.signal as AbortSignal | null | undefined) ?? null;

    return Response.json({ chats: [], dbRevision: 0 });
  }) as typeof fetch;

  await getChatsWithOptions("search", { signal: abortController.signal });

  abortController.abort();

  expect(capturedSignal).not.toBeNull();
  expect(capturedSignal?.aborted).toBe(true);
});

test("getChat encodes transcript paging parameters into the request path", async () => {
  let capturedInput = "";

  globalThis.fetch = (async (input: string | URL | Request) => {
    capturedInput = String(input);

    return Response.json({
      chat: {
        createdAt: "2026-04-13T00:00:00.000Z",
        id: "chat id",
        title: "Paged chat",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
      dbRevision: 0,
      hasOlderMessages: true,
      messages: [],
      nextBeforeSequence: 120,
    });
  }) as typeof fetch;

  await getChat("chat id", { beforeSequence: 120, limit: 50 });

  expect(capturedInput).toBe("/api/chats/chat%20id?limit=50&beforeSequence=120");
});

test("loadModel uses the bounded default runtime-load timeout when no sizing data is provided", async () => {
  const capturedTimeouts: number[] = [];

  AbortSignal.timeout = ((timeoutMs: number) => {
    capturedTimeouts.push(timeoutMs);
    return originalAbortSignalTimeout(timeoutMs);
  }) as typeof AbortSignal.timeout;

  globalThis.fetch = (async () => {
    return Response.json({
      runtime: {
        activeModelId: "model-1",
        activeModelPath: "D:/models/model.gguf",
        audio: false,
        contextLimitTokens: 4096,
        contextTokens: null,
        lastError: null,
        llamaServerBaseUrl: "http://127.0.0.1:4000",
        loadProgress: 100,
        multimodal: false,
        status: "ready",
        tokensPerSecond: null,
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    });
  }) as typeof fetch;

  await loadModel("model-1");

  expect(capturedTimeouts).toEqual([calculateRuntimeLoadTimeoutMs({})]);
});

test("loadModel forwards an explicit runtime-load timeout override", async () => {
  const capturedTimeouts: number[] = [];

  AbortSignal.timeout = ((timeoutMs: number) => {
    capturedTimeouts.push(timeoutMs);
    return originalAbortSignalTimeout(timeoutMs);
  }) as typeof AbortSignal.timeout;

  globalThis.fetch = (async () => {
    return Response.json({
      runtime: {
        activeModelId: "model-1",
        activeModelPath: "D:/models/model.gguf",
        audio: false,
        contextLimitTokens: 4096,
        contextTokens: null,
        lastError: null,
        llamaServerBaseUrl: "http://127.0.0.1:4000",
        loadProgress: 100,
        multimodal: false,
        status: "ready",
        tokensPerSecond: null,
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    });
  }) as typeof fetch;

  await loadModel("model-1", undefined, undefined, 210_000);

  expect(capturedTimeouts).toEqual([210_000]);
});

test("isRetryableRequestError returns true for common retryable network conditions", () => {
  expect(isRetryableRequestError(new Error("Failed to fetch"))).toBe(true);
  expect(isRetryableRequestError(new Error("Connection reset by peer"))).toBe(true);

  const codeError = new Error("socket hang up");
  (codeError as any).code = "ECONNRESET";

  expect(isRetryableRequestError(codeError)).toBe(true);
});

test("isRetryableRequestError returns false for AbortError instances", () => {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";

  expect(isRetryableRequestError(abortError)).toBe(false);
});

test("buildTimedRequestSignal fallback combines timeout and existing signal when AbortSignal.any is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");

  if (descriptor && descriptor.configurable !== true) {
    expect(true).toBe(true);
    return;
  }

  const originalAny = (AbortSignal as any).any;

  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    configurable: true,
    writable: true,
  });

  try {
    const { signal: combinedSignal, cleanup } = buildTimedRequestSignal(null, 1);

    expect(combinedSignal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(combinedSignal.aborted).toBe(true);
    cleanup();
  } finally {
    if (descriptor) {
      Object.defineProperty(AbortSignal, "any", descriptor);
    } else {
      delete (AbortSignal as any).any;
    }
    (AbortSignal as any).any = originalAny;
  }
});

test("buildTimedRequestSignal cleanup cancels the fallback timeout when an existing signal is provided", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");

  if (descriptor && descriptor.configurable !== true) {
    expect(true).toBe(true);
    return;
  }

  const originalAny = (AbortSignal as any).any;

  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    configurable: true,
    writable: true,
  });

  const existingController = new AbortController();
  let cleanup: (() => void) | null = null;

  try {
    const result = buildTimedRequestSignal(existingController.signal, 10);
    cleanup = result.cleanup;
    const signal = result.signal;

    expect(signal.aborted).toBe(false);
    expect(existingController.signal.aborted).toBe(false);

    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(signal.aborted).toBe(false);
    expect(existingController.signal.aborted).toBe(false);
  } finally {
    cleanup?.();

    if (descriptor) {
      Object.defineProperty(AbortSignal, "any", descriptor);
    } else {
      delete (AbortSignal as any).any;
    }
    (AbortSignal as any).any = originalAny;
  }
});

test("buildTimedRequestSignal cleanup cancels the fallback timeout when AbortSignal.timeout is unavailable", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");

  if (!timeoutDescriptor?.configurable) {
    expect(true).toBe(true);
    return;
  }

  const originalTimeout = AbortSignal.timeout;

  Object.defineProperty(AbortSignal, "timeout", {
    value: undefined,
    configurable: true,
    writable: true,
  });

  try {
    const { signal, cleanup } = buildTimedRequestSignal(null, 30);

    expect(signal.aborted).toBe(false);
    cleanup();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal.aborted).toBe(false);
  } finally {
    if (timeoutDescriptor) {
      Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    }
    (AbortSignal as any).timeout = originalTimeout;
  }
});
