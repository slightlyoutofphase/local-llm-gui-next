import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBinaryAttachmentReplayDescriptorPath } from "../../backend/attachmentReplay";
import type { MediaAttachmentRecord, RuntimeSnapshot } from "../../lib/contracts";
import { DebugLogService } from "../../backend/debug";
import { LlamaServerManager } from "../../backend/llamaServer";
import type { ApplicationPaths } from "../../backend/paths";
import { JsonSseBroadcaster } from "../../backend/sse";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe.serial("LlamaServerManager multimodal request shaping", () => {
  let applicationPaths: ApplicationPaths;
  let manager: LlamaServerManager;
  let originalFetch: typeof fetch;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-llama-mtmd");
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

  test("reconstructs persisted image attachments into OAI content parts", async () => {
    const imagePath = path.join(applicationPaths.mediaDir, "example.png");
    const attachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "example.png",
      filePath: imagePath,
      id: "attachment-image",
      kind: "image",
      mimeType: "image/png",
    };
    const capturedBodies: Record<string, unknown>[] = [];

    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: true,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Describe this image.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;
    const contentParts = (upstreamMessages[0]?.["content"] ?? []) as Array<Record<string, unknown>>;

    expect(response.ok).toBe(true);
    expect(upstreamMessages).toHaveLength(1);
    expect(contentParts).toHaveLength(2);
    expect(contentParts[0]).toEqual({
      text: "Describe this image.",
      type: "text",
    });
    expect(contentParts[1]?.["type"]).toBe("image_url");
    expect(
      ((contentParts[1]?.["image_url"] as { url?: string } | undefined)?.url ?? "").startsWith(
        "data:image/png;base64,",
      ),
    ).toBe(true);
  });

  test("reuses a persisted binary replay descriptor across repeated image turns", async () => {
    const imagePath = path.join(applicationPaths.mediaDir, "replayable.png");
    const attachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "replayable.png",
      filePath: imagePath,
      id: "attachment-image-replay",
      kind: "image",
      mimeType: "image/png",
    };
    const capturedBodies: Record<string, unknown>[] = [];
    const replayDescriptorPath = getBinaryAttachmentReplayDescriptorPath(imagePath);

    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: true,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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

    const firstResponse = await manager.proxyChatCompletion(
      {
        messages: [
          {
            content: "Describe this image twice.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );

    expect(firstResponse.ok).toBe(true);
    expect(existsSync(replayDescriptorPath)).toBe(true);

    await rm(imagePath, { force: true });

    const secondResponse = await manager.proxyChatCompletion(
      {
        messages: [
          {
            content: "Describe this image twice.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const firstMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<Record<string, unknown>>;
    const secondMessages = (capturedBodies[1]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;
    const firstUrl = (
      (firstMessages[0]?.["content"] as Array<Record<string, unknown>> | undefined)?.[1]?.[
        "image_url"
      ] as { url?: string } | undefined
    )?.url;
    const secondUrl = (
      (secondMessages[0]?.["content"] as Array<Record<string, unknown>> | undefined)?.[1]?.[
        "image_url"
      ] as { url?: string } | undefined
    )?.url;

    expect(secondResponse.ok).toBe(true);
    expect(secondUrl).toBe(firstUrl);
  });

  test("rejects persisted audio attachments when runtime audio support is unavailable", async () => {
    const audioPath = path.join(applicationPaths.mediaDir, "example.wav");
    const attachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "example.wav",
      filePath: audioPath,
      id: "attachment-audio",
      kind: "audio",
      mimeType: "audio/wav",
    };
    let fetchCalled = false;

    await writeFile(audioPath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: true,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Transcribe this clip.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toContain("audio");
    expect(fetchCalled).toBe(false);
  });

  test("reconstructs persisted audio attachments when runtime audio support is available without image capability", async () => {
    const audioPath = path.join(applicationPaths.mediaDir, "example.wav");
    const attachment: MediaAttachmentRecord = {
      byteSize: 4,
      fileName: "example.wav",
      filePath: audioPath,
      id: "attachment-audio-ok",
      kind: "audio",
      mimeType: "audio/wav",
    };
    const capturedBodies: Record<string, unknown>[] = [];

    await writeFile(audioPath, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: true,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: false,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Transcribe this clip.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;
    const contentParts = (upstreamMessages[0]?.["content"] ?? []) as Array<Record<string, unknown>>;

    expect(response.ok).toBe(true);
    expect(contentParts).toHaveLength(2);
    expect(contentParts[0]).toEqual({
      text: "Transcribe this clip.",
      type: "text",
    });
    expect(contentParts[1]?.["type"]).toBe("input_audio");
    expect((contentParts[1]?.["input_audio"] as { format?: string } | undefined)?.format).toBe(
      "wav",
    );
  });

  test("injects persisted text attachments into user prompt content", async () => {
    const textPath = path.join(applicationPaths.mediaDir, "notes.md");
    const attachment: MediaAttachmentRecord = {
      byteSize: 18,
      fileName: "notes.md",
      filePath: textPath,
      id: "attachment-text",
      kind: "text",
      mimeType: "text/markdown",
    };
    const capturedBodies: Record<string, unknown>[] = [];

    await writeFile(textPath, "# Summary\n\nAlpha beta");
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: false,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Please summarize the attached notes.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;
    const contentParts = (upstreamMessages[0]?.["content"] ?? []) as Array<Record<string, unknown>>;

    expect(response.ok).toBe(true);
    expect(contentParts).toHaveLength(2);
    expect(contentParts[0]).toEqual({
      text: "Please summarize the attached notes.",
      type: "text",
    });
    expect(contentParts[1]).toEqual({
      text: [
        "Attached text file: notes.md",
        "Use the following file content as part of the user's prompt context:",
        "# Summary\n\nAlpha beta",
      ].join("\n\n"),
      type: "text",
    });
  });

  test("truncates persisted text attachments on UTF-8 boundaries without corrupting the prompt", async () => {
    const textPath = path.join(applicationPaths.mediaDir, "notes-large.md");
    const attachment: MediaAttachmentRecord = {
      byteSize: 12_003,
      fileName: "notes-large.md",
      filePath: textPath,
      id: "attachment-text-large",
      kind: "text",
      mimeType: "text/markdown",
    };
    const capturedBodies: Record<string, unknown>[] = [];
    const oversizedText = `${"a".repeat(11_999)}🙂`;

    await writeFile(textPath, oversizedText, "utf8");
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: false,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Please summarize the attached notes.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const upstreamMessages = (capturedBodies[0]?.["messages"] ?? []) as Array<
      Record<string, unknown>
    >;
    const contentParts = (upstreamMessages[0]?.["content"] ?? []) as Array<Record<string, unknown>>;
    const attachmentPrompt = String(contentParts[1]?.["text"] ?? "");

    expect(response.ok).toBe(true);
    expect(attachmentPrompt).toContain("Attached text file: notes-large.md");
    expect(attachmentPrompt).toContain(
      "[The remainder of this attached file was truncated before sending.]",
    );
    expect(attachmentPrompt).not.toContain("�");
    expect(attachmentPrompt).not.toContain("🙂");
  });

  test("fails the request when a persisted text attachment can no longer be read", async () => {
    const missingTextPath = path.join(applicationPaths.mediaDir, "missing.md");
    const attachment: MediaAttachmentRecord = {
      byteSize: 10,
      fileName: "missing.md",
      filePath: missingTextPath,
      id: "attachment-text-missing",
      kind: "text",
      mimeType: "text/markdown",
    };
    const capturedBodies: Record<string, unknown>[] = [];

    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: false,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Please summarize the missing notes.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe(
      "The text attachment missing.md could not be read from disk. Ensure the file still exists and try again.",
    );
    expect(capturedBodies).toHaveLength(0);
  });

  test("fails the request when a persisted binary attachment can no longer be read", async () => {
    const missingImagePath = path.join(applicationPaths.mediaDir, "missing.png");
    const attachment: MediaAttachmentRecord = {
      byteSize: 10,
      fileName: "missing.png",
      filePath: missingImagePath,
      id: "attachment-image-missing",
      kind: "image",
      mimeType: "image/png",
    };
    let fetchCalled = false;

    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: true,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Please inspect the missing image.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe(
      "The image attachment missing.png could not be read from disk. Ensure the file still exists and try again.",
    );
    expect(fetchCalled).toBe(false);
  });

  test("rejects binary replay before reading when declared attachment bytes exceed the request limit", async () => {
    const imagePath = path.join(applicationPaths.mediaDir, "budget-check.png");
    const attachment: MediaAttachmentRecord = {
      byteSize: 201 * 1024 * 1024,
      fileName: "budget-check.png",
      filePath: imagePath,
      id: "attachment-image-budget",
      kind: "image",
      mimeType: "image/png",
    };
    let fetchCalled = false;

    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    setRuntimeSnapshot(manager, {
      activeModelId: "test-model",
      activeModelPath: null,
      audio: false,
      contextTokens: null,
      lastError: null,
      llamaServerBaseUrl: "http://127.0.0.1:3456",
      loadProgress: 100,
      multimodal: true,
      status: "ready",
      tokensPerSecond: null,
      updatedAt: new Date().toISOString(),
    });

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
          {
            content: "Please inspect this very large image.",
            mediaAttachments: [attachment],
            role: "user",
          },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(413);
    expect(payload.error).toContain("media replay limit");
    expect(payload.error).toContain("budget-check.png");
    expect(fetchCalled).toBe(false);
  });
});

function setRuntimeSnapshot(manager: LlamaServerManager, snapshot: RuntimeSnapshot): void {
  (manager as unknown as { runtimeSnapshot: RuntimeSnapshot }).runtimeSnapshot = snapshot;
}
