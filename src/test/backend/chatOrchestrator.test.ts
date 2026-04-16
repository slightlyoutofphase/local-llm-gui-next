import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RuntimeSnapshot } from "../../lib/contracts";
import {
  createChatGenerationResponse,
  createToolConfirmationResponse,
} from "../../backend/chatOrchestrator";
import { AppDatabase } from "../../backend/db";
import { DebugLogService } from "../../backend/debug";
import type { ApplicationPaths } from "../../backend/paths";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

describe.serial("createChatGenerationResponse", () => {
  let applicationPaths: ApplicationPaths;
  let database: AppDatabase;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createBackendTestScratchDir("local-llm-gui-chat-orchestrator");
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

    database = new AppDatabase(applicationPaths);
  });

  afterEach(async () => {
    database.close();
    await removeBackendTestScratchDir(rootDir);
  });

  test("intercepts a streamed tool call, persists tool messages, and resumes generation", async () => {
    const chat = database.createChat("Tool test");
    const userMessage = database.appendMessage(chat.id, "user", "Use the echo tool.");
    const debugLogService = new DebugLogService();
    const upstreamBodies: Record<string, unknown>[] = [];

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return {
          activeModelId: "test-model",
          activeModelPath: null,
          audio: false,
          contextTokens: null,
          lastError: null,
          llamaServerBaseUrl: "http://127.0.0.1:8080",
          loadProgress: 100,
          multimodal: false,
          status: "ready",
          tokensPerSecond: null,
          updatedAt: new Date().toISOString(),
        };
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
        upstreamBodies.push(requestBody);

        if (upstreamBodies.length === 1) {
          return createSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"value":"hello"}',
                          name: "echo_tool",
                        },
                        id: "call_1",
                        index: 0,
                        type: "function",
                      },
                    ],
                  },
                },
              ],
            },
          ]);
        }

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  content: "Final answer after tool.",
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = {
      async executeTool(): Promise<{ content: string; ok: true }> {
        return {
          content: "hello",
          ok: true,
        };
      },
      async listEnabledToolManifests(): Promise<
        Array<{
          manifest: {
            description: string;
            inputSchema: {
              additionalProperties: false;
              properties: {
                value: {
                  type: "string";
                };
              };
              required: string[];
              type: "object";
            };
            name: string;
          };
          summary: {
            description: string;
            enabled: true;
            id: string;
            loadStatus: "loaded";
            name: string;
            policy: {
              allowParallel: false;
              category: "custom";
              dangerous: false;
              requiresConfirmation: false;
            };
            source: "local";
          };
        }>
      > {
        return [
          {
            manifest: {
              description: "Echo a string.",
              inputSchema: {
                additionalProperties: false,
                properties: {
                  value: {
                    type: "string",
                  },
                },
                required: ["value"],
                type: "object",
              },
              name: "echo_tool",
            },
            summary: {
              description: "Echo a string.",
              enabled: true,
              id: "echo_tool",
              loadStatus: "loaded",
              name: "echo_tool",
              policy: {
                allowParallel: false,
                category: "custom",
                dangerous: false,
                requiresConfirmation: false,
              },
              source: "local",
            },
          },
        ];
      },
    };

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();
    const persistedChat = database.getChat(chat.id);

    expect(response.ok).toBe(true);
    expect(responseText).toContain("Final answer after tool.");
    expect(responseText).toContain('"local_event":"message_persisted"');
    expect(upstreamBodies).toHaveLength(2);
    expect((upstreamBodies[0]?.["tools"] as unknown[] | undefined)?.length).toBe(1);
    expect(upstreamBodies[1]?.["messages"]).toEqual([
      {
        content: userMessage.content,
        role: "user",
      },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"value":"hello"}',
              name: "echo_tool",
            },
            id: "call_1",
            type: "function",
          },
        ],
      },
      {
        content: JSON.stringify({ content: "hello", ok: true }),
        role: "tool",
        tool_call_id: "call_1",
      },
    ]);
    expect(persistedChat?.messages).toHaveLength(3);
    expect(persistedChat?.messages[1]?.role).toBe("assistant");
    expect(persistedChat?.messages[1]?.metadata["hiddenFromTranscript"]).toBe(true);
    expect(persistedChat?.messages[2]?.role).toBe("tool");
    expect(persistedChat?.messages[2]?.metadata["toolCallId"]).toBe("call_1");
  }, 35_000);

  test("pauses a tool turn until confirmation is granted", async () => {
    const chat = database.createChat("Tool confirmation test");
    const userMessage = database.appendMessage(chat.id, "user", "Use the rename tool.");
    const debugLogService = new DebugLogService();
    const upstreamBodies: Record<string, unknown>[] = [];
    let executeCount = 0;

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
        upstreamBodies.push(requestBody);

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"target":"draft.txt"}',
                        name: "rename_tool",
                      },
                      id: "call_confirm_1",
                      index: 0,
                      type: "function",
                    },
                  ],
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = createRenameRegistry({
      executeTool: async () => {
        executeCount += 1;

        return {
          content: "renamed",
          ok: true as const,
        };
      },
      requiresConfirmation: true,
    });

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();
    const persistedChat = database.getChat(chat.id);

    expect(response.ok).toBe(true);
    expect(responseText).toContain("Awaiting confirmation: rename_tool");
    expect(executeCount).toBe(0);
    expect(upstreamBodies).toHaveLength(1);
    expect(persistedChat?.messages).toHaveLength(2);
    expect(persistedChat?.messages[1]?.metadata["toolConfirmation"]).toEqual({
      calls: [
        {
          argumentsText: '{"target":"draft.txt"}',
          callId: "call_confirm_1",
          category: "filesystem",
          dangerous: true,
          requiresConfirmation: true,
          toolName: "rename_tool",
        },
      ],
      state: "pending",
    });
  });

  test("resumes a confirmed tool turn and continues generation", async () => {
    const chat = database.createChat("Tool confirmation resume");
    const userMessage = database.appendMessage(chat.id, "user", "Use the rename tool.");
    const pendingAssistantMessage = database.appendMessage(
      chat.id,
      "assistant",
      "",
      [],
      undefined,
      false,
      {
        hiddenFromTranscript: true,
        toolCalls: [
          {
            function: {
              arguments: '{"target":"draft.txt"}',
              name: "rename_tool",
            },
            id: "call_confirm_2",
            type: "function",
          },
        ],
        toolConfirmation: {
          calls: [
            {
              argumentsText: '{"target":"draft.txt"}',
              callId: "call_confirm_2",
              category: "filesystem",
              dangerous: true,
              requiresConfirmation: true,
              toolName: "rename_tool",
            },
          ],
          state: "pending",
        },
      },
    );
    const debugLogService = new DebugLogService();
    const upstreamBodies: Record<string, unknown>[] = [];
    let executeCount = 0;

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
        upstreamBodies.push(requestBody);

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  content: "Confirmed tool finished.",
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = createRenameRegistry({
      executeTool: async () => {
        executeCount += 1;

        return {
          content: "renamed",
          ok: true as const,
        };
      },
      requiresConfirmation: true,
    });

    const response = await createToolConfirmationResponse({
      approved: true,
      assistantMessageId: pendingAssistantMessage.id,
      chatId: chat.id,
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();
    const persistedChat = database.getChat(chat.id);

    expect(response.ok).toBe(true);
    expect(responseText).toContain("Confirmed tool finished.");
    expect(executeCount).toBe(1);
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]?.["messages"]).toEqual([
      {
        content: userMessage.content,
        role: "user",
      },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"target":"draft.txt"}',
              name: "rename_tool",
            },
            id: "call_confirm_2",
            type: "function",
          },
        ],
      },
      {
        content: JSON.stringify({ content: "renamed", ok: true }),
        role: "tool",
        tool_call_id: "call_confirm_2",
      },
    ]);
    expect(
      (persistedChat?.messages[1]?.metadata["toolConfirmation"] as { state?: string }).state,
    ).toBe("approved");
    expect(persistedChat?.messages[2]?.role).toBe("tool");
    expect(persistedChat?.messages[2]?.metadata["toolCallId"]).toBe("call_confirm_2");
  }, 35_000);

  test("surfaces a clean upstream error message for failed tool turns", async () => {
    const chat = database.createChat("Tool upstream error");
    const userMessage = database.appendMessage(chat.id, "user", "Use a tool.");
    const debugLogService = new DebugLogService();

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(): Promise<Response> {
        return Response.json({ error: "Tool upstream failure." }, { status: 500 });
      },
    };

    const fakeRegistry = createRenameRegistry({
      executeTool: async () => ({
        content: "unused",
        ok: true as const,
      }),
      requiresConfirmation: false,
    });

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });

    await expect(response.text()).rejects.toThrow("Tool upstream failure.");
  });

  test("gracefully falls back when tool turns exceed the safety limit", async () => {
    const chat = database.createChat("Tool loop limit");
    const userMessage = database.appendMessage(chat.id, "user", "Keep calling the tool.");
    const debugLogService = new DebugLogService();
    let toolTurnCount = 0;

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(): Promise<Response> {
        toolTurnCount += 1;

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: `{"turn":${String(toolTurnCount)}}`,
                        name: "echo_tool",
                      },
                      id: `call_loop_${String(toolTurnCount)}`,
                      index: 0,
                      type: "function",
                    },
                  ],
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = {
      async executeTool(): Promise<{ content: string; ok: true }> {
        return {
          content: "loop",
          ok: true,
        };
      },
      async listEnabledToolManifests(): Promise<
        Array<{
          manifest: {
            description: string;
            inputSchema: {
              additionalProperties: false;
              properties: {
                turn: {
                  type: "number";
                };
              };
              required: string[];
              type: "object";
            };
            name: string;
          };
          summary: {
            description: string;
            enabled: true;
            id: string;
            loadStatus: "loaded";
            name: string;
            policy: {
              allowParallel: false;
              category: "custom";
              dangerous: false;
              requiresConfirmation: false;
            };
            source: "local";
          };
        }>
      > {
        return [
          {
            manifest: {
              description: "Echo a turn counter.",
              inputSchema: {
                additionalProperties: false,
                properties: {
                  turn: {
                    type: "number",
                  },
                },
                required: ["turn"],
                type: "object",
              },
              name: "echo_tool",
            },
            summary: {
              description: "Echo a turn counter.",
              enabled: true,
              id: "echo_tool",
              loadStatus: "loaded",
              name: "echo_tool",
              policy: {
                allowParallel: false,
                category: "custom",
                dangerous: false,
                requiresConfirmation: false,
              },
              source: "local",
            },
          },
        ];
      },
    };

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();
    const persistedChat = database.getChat(chat.id);

    expect(response.ok).toBe(true);
    expect(responseText).toContain("Tool execution reached the 8-turn safety limit");
    expect(toolTurnCount).toBe(8);
    expect(persistedChat?.messages).toHaveLength(17);
  }, 45_000);

  test("turns malformed streamed tool arguments into an invalid_arguments failure without executing the tool", async () => {
    const chat = database.createChat("Malformed tool args test");
    const userMessage = database.appendMessage(chat.id, "user", "Call the tool.");
    const debugLogService = new DebugLogService();
    const upstreamBodies: Record<string, unknown>[] = [];
    let executeCount = 0;

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
        upstreamBodies.push(requestBody);

        if (upstreamBodies.length === 1) {
          return createSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"target":',
                          name: "rename_tool",
                        },
                        id: "call_invalid_1",
                        index: 0,
                        type: "function",
                      },
                    ],
                  },
                },
              ],
            },
          ]);
        }

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  content: "The tool arguments were invalid.",
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = createRenameRegistry({
      executeTool: async () => {
        executeCount += 1;

        return {
          content: "renamed",
          ok: true as const,
        };
      },
      requiresConfirmation: false,
    });

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();
    const persistedChat = database.getChat(chat.id);
    const toolMessage = persistedChat?.messages.find((message) => message.role === "tool") ?? null;
    const replayedToolMessage = ((
      upstreamBodies[1]?.["messages"] as Array<Record<string, unknown>>
    )[2] ?? null) as Record<string, unknown> | null;
    const replayedToolResult = JSON.parse(String(replayedToolMessage?.["content"] ?? "{}")) as {
      error?: {
        code?: string;
        data?: {
          argumentsText?: string;
          parseError?: string;
        };
        message?: string;
      };
      ok?: boolean;
    };

    expect(response.ok).toBe(true);
    expect(responseText).toContain("The tool arguments were invalid.");
    expect(executeCount).toBe(0);
    expect(upstreamBodies).toHaveLength(2);
    expect((upstreamBodies[1]?.["messages"] as Array<Record<string, unknown>>).slice(0, 2)).toEqual(
      [
        {
          content: userMessage.content,
          role: "user",
        },
        {
          content: "",
          role: "assistant",
          tool_calls: [
            {
              function: {
                arguments: '{"target":',
                name: "rename_tool",
              },
              id: "call_invalid_1",
              type: "function",
            },
          ],
        },
      ],
    );
    expect(replayedToolMessage).toMatchObject({
      role: "tool",
      tool_call_id: "call_invalid_1",
    });
    expect(replayedToolResult.ok).toBe(false);
    expect(replayedToolResult.error?.code).toBe("invalid_arguments");
    expect(replayedToolResult.error?.data?.argumentsText).toBe('{"target":');
    expect(replayedToolResult.error?.data?.parseError).toBeTruthy();
    expect(replayedToolResult.error?.message).toContain(
      "Tool rename_tool was not executed because its streamed arguments were invalid JSON.",
    );
    expect(toolMessage?.metadata["toolResult"]).toMatchObject({
      error: {
        code: "invalid_arguments",
      },
      ok: false,
    });
  }, 15_000);

  test("closes the tool stream cleanly when the chat is deleted during tool-result persistence", async () => {
    const chat = database.createChat("Deleted while tooling");
    const userMessage = database.appendMessage(chat.id, "user", "Use the rename tool.");
    const debugLogService = new DebugLogService();
    const upstreamBodies: Record<string, unknown>[] = [];
    let executeCount = 0;

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
        upstreamBodies.push(requestBody);

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"target":"draft.txt"}',
                        name: "rename_tool",
                      },
                      id: "call_delete_1",
                      index: 0,
                      type: "function",
                    },
                  ],
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = createRenameRegistry({
      executeTool: async () => {
        executeCount += 1;
        database.deleteChat(chat.id);

        return {
          content: "renamed",
          ok: true as const,
        };
      },
      requiresConfirmation: false,
    });

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: new AbortController().signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();

    expect(response.ok).toBe(true);
    expect(executeCount).toBe(1);
    expect(upstreamBodies).toHaveLength(1);
    expect(responseText).toContain('"local_event":"message_persisted"');
    expect(database.getChat(chat.id)).toBeNull();
  }, 15_000);

  test("closes the tool stream cleanly when generation is aborted before tool-result persistence", async () => {
    const chat = database.createChat("Aborted while tooling");
    const userMessage = database.appendMessage(chat.id, "user", "Use the rename tool.");
    const debugLogService = new DebugLogService();
    const generationAbortController = new AbortController();
    const upstreamBodies: Record<string, unknown>[] = [];
    let executeCount = 0;

    const fakeManager = {
      getSnapshot(): RuntimeSnapshot {
        return createReadySnapshot();
      },
      getToolCallingSupport(): { supported: boolean } {
        return { supported: true };
      },
      getActiveThinkingTags(): null {
        return null;
      },
      async proxyChatCompletion(requestBody: Record<string, unknown>): Promise<Response> {
        upstreamBodies.push(requestBody);

        return createSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"target":"draft.txt"}',
                        name: "rename_tool",
                      },
                      id: "call_abort_1",
                      index: 0,
                      type: "function",
                    },
                  ],
                },
              },
            ],
          },
        ]);
      },
    };

    const fakeRegistry = createRenameRegistry({
      executeTool: async () => {
        executeCount += 1;
        generationAbortController.abort();

        return {
          content: "renamed",
          ok: true as const,
        };
      },
      requiresConfirmation: false,
    });

    const response = await createChatGenerationResponse({
      database,
      debugLogService,
      llamaServerManager: fakeManager as never,
      requestBody: {
        chatId: chat.id,
        messages: [
          {
            content: userMessage.content,
            role: userMessage.role,
          },
        ],
        stream: true,
      },
      signal: generationAbortController.signal,
      toolRegistry: fakeRegistry as never,
    });
    const responseText = await response.text();
    const persistedChat = database.getChat(chat.id);

    expect(response.ok).toBe(true);
    expect(executeCount).toBe(1);
    expect(upstreamBodies).toHaveLength(1);
    expect(responseText).toContain('"local_event":"message_persisted"');
    expect(persistedChat?.messages).toHaveLength(2);
    expect(persistedChat?.messages.some((message) => message.role === "tool")).toBe(false);
  }, 15_000);
});

function createReadySnapshot(): RuntimeSnapshot {
  return {
    activeModelId: "test-model",
    activeModelPath: null,
    audio: false,
    contextTokens: null,
    lastError: null,
    llamaServerBaseUrl: "http://127.0.0.1:8080",
    loadProgress: 100,
    multimodal: false,
    status: "ready",
    tokensPerSecond: null,
    updatedAt: new Date().toISOString(),
  };
}

function createRenameRegistry(options: {
  executeTool: () => Promise<{ content: string; ok: true }>;
  requiresConfirmation: boolean;
}): {
  executeTool: () => Promise<{ content: string; ok: true }>;
  listEnabledToolManifests: () => Promise<
    Array<{
      manifest: {
        description: string;
        inputSchema: {
          additionalProperties: false;
          properties: {
            target: {
              type: "string";
            };
          };
          required: string[];
          type: "object";
        };
        name: string;
      };
      summary: {
        description: string;
        enabled: true;
        id: string;
        loadStatus: "loaded";
        name: string;
        policy: {
          allowParallel: false;
          category: "filesystem";
          dangerous: true;
          requiresConfirmation: boolean;
        };
        source: "local";
      };
    }>
  >;
} {
  return {
    executeTool: options.executeTool,
    async listEnabledToolManifests() {
      return [
        {
          manifest: {
            description: "Rename a file.",
            inputSchema: {
              additionalProperties: false,
              properties: {
                target: {
                  type: "string",
                },
              },
              required: ["target"],
              type: "object",
            },
            name: "rename_tool",
          },
          summary: {
            description: "Rename a file.",
            enabled: true,
            id: "rename_tool",
            loadStatus: "loaded",
            name: "rename_tool",
            policy: {
              allowParallel: false,
              category: "filesystem",
              dangerous: true,
              requiresConfirmation: options.requiresConfirmation,
            },
            source: "local",
          },
        },
      ];
    },
  };
}

function createSseResponse(payloads: Record<string, unknown>[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();

        for (const payload of payloads) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }

        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
      },
      status: 200,
    },
  );
}
