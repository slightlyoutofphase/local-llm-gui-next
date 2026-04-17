import type { ChatMessageRecord, ThinkingTagSettings, ToolSummary } from "../lib/contracts";
import { readErrorResponseMessage } from "../lib/httpErrors";
import { ChatNotFoundError, type AppDatabase } from "./db";
import type { DebugLogService } from "./debug";
import type { LlamaServerManager } from "./llamaServer";
import { ReasoningParser } from "./reasoningParser";
import { consumeSseEvents, flushSseEvents } from "./sseParsing";
import type { LocalToolRegistry } from "./tools/registry";
import type { ToolManifest, ToolResult } from "./tools/types";

/** Maximum number of consecutive tool-call-and-response turns before the loop is terminated. */
const MAX_TOOL_TURNS = 8;
const TOOL_STREAM_KEEPALIVE_INTERVAL_MS = 15_000;
const TOOL_LOOP_SAFETY_MESSAGE = `Tool execution reached the ${String(MAX_TOOL_TURNS)}-turn safety limit. Review the latest tool results and continue manually.`;

/** A tool manifest paired with its registry summary for injection into a generation request. */
interface ToolManifestEntry {
  readonly manifest: ToolManifest;
  readonly summary: ToolSummary;
}

/** Accumulated state for a single tool call being assembled from streamed SSE deltas. */
interface StreamedToolCall {
  /** The unique tool-call identifier assigned by the model. */
  id: string;
  /** The tool function name selected by the model. */
  name: string;
  /** JSON-encoded arguments string accumulated across streaming chunks. */
  argumentsText: string;
}

/** Result of consuming a single assistant turn stream, containing text, reasoning, and tool calls. */
interface AssistantTurnResult {
  /** Final assistant text content accumulated from content deltas. */
  assistantContent: string;
  /** Reasoning / thinking content accumulated from reasoning_content deltas. */
  reasoningContent: string;
  /** Complete tool-call invocations requested by the model in this turn. */
  toolCalls: StreamedToolCall[];
}

type ParsedToolArgumentsResult =
  | {
      args: Record<string, unknown>;
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

/** Binds a streamed tool call to its resolved registry summary for execution. */
interface ToolExecutionEntry {
  /** The raw tool call extracted from the model's streaming response. */
  readonly call: StreamedToolCall;
  /** Registry summary for the called tool, or `undefined` if the tool is unknown. */
  readonly summary?: ToolSummary;
}

/** Shape of a tool-call record persisted in assistant message metadata. */
interface PersistedToolCallRecord {
  readonly function: {
    /** JSON-encoded arguments string. */
    readonly arguments: string;
    /** Tool function name. */
    readonly name: string;
  };
  /** Unique tool-call identifier. */
  readonly id: string;
  /** Discriminator fixed to `"function"`. */
  readonly type: "function";
}

/** Individual call entry within a {@link ToolConfirmationRecord}, describing one tool call awaiting user approval. */
interface ToolConfirmationCallRecord {
  /** JSON-encoded arguments string for display in the confirmation dialog. */
  readonly argumentsText: string;
  /** Tool-call identifier for correlation with persisted records. */
  readonly callId: string;
  /** Policy category of the called tool. */
  readonly category: ToolSummary["policy"]["category"];
  /** Whether the tool is flagged as dangerous. */
  readonly dangerous: boolean;
  /** Optional human-friendly display name. */
  readonly displayName?: string;
  /** Whether this specific tool requires user confirmation. */
  readonly requiresConfirmation: boolean;
  /** Canonical tool name. */
  readonly toolName: string;
}

/** Metadata record persisted on an assistant message when one or more tool calls require user confirmation. */
interface ToolConfirmationRecord {
  /** Individual tool calls awaiting or resolved confirmation. */
  readonly calls: ToolConfirmationCallRecord[];
  /** Current confirmation state: `"pending"` until the user responds. */
  readonly state: "approved" | "pending" | "rejected";
}

/** Shared mutable context threaded through the tool-conversation streaming loop. */
interface ToolConversationStreamContext {
  /** Active chat identifier. */
  chatId: string;
  /** SSE stream controller for writing events to the client. */
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Mutable conversation history rebuilt across tool turns. */
  conversationMessages: Record<string, unknown>[];
  /** Application database for message persistence. */
  database: AppDatabase;
  /** Debug log service for lifecycle logging. */
  debugLogService: DebugLogService;
  /** llama-server manager for proxying chat completions. */
  llamaServerManager: LlamaServerManager;
  /** Original request body used as a template for each generation turn. */
  requestBody: Record<string, unknown>;
  /** Abort signal from the incoming HTTP request. */
  signal: AbortSignal;
  /** Registry for executing discovered tools. */
  toolRegistry: LocalToolRegistry;
  /** Snapshot of enabled tool manifests captured at the start of the generation. */
  tools: ToolManifestEntry[];
}

/** Raised when the downstream SSE socket is no longer writable. */
class StreamClosedError extends Error {
  public constructor() {
    super("Client stream closed.");
    this.name = "StreamClosedError";
  }
}

/**
 * Creates an SSE streaming response for a chat generation request that
 * may include tool-calling turns.
 *
 * If tools are unavailable or the request lacks the required fields, the
 * request is forwarded directly to `llamaServerManager.proxyChatCompletion`.
 * Otherwise, the tool conversation loop is initiated.
 *
 * @param options - Dependencies and request parameters.
 * @returns An HTTP {@link Response} with a streaming body.
 */
export async function createChatGenerationResponse(options: {
  database: AppDatabase;
  debugLogService: DebugLogService;
  llamaServerManager: LlamaServerManager;
  requestBody: Record<string, unknown>;
  signal: AbortSignal;
  toolRegistry: LocalToolRegistry;
}): Promise<Response> {
  const { database, debugLogService, llamaServerManager, requestBody, signal, toolRegistry } =
    options;
  const chatId = typeof requestBody["chatId"] === "string" ? requestBody["chatId"] : null;

  const conversationMessages = chatId
    ? loadConversationFromDatabase(database, chatId)
    : normalizeConversationMessages(requestBody["messages"]);

  debugLogService.verboseServerLog(
    `Preparing chat generation${chatId ? ` for chat ${chatId}` : ""} with ${String(conversationMessages.length)} conversation message(s).`,
  );

  if (conversationMessages.length === 0) {
    if (chatId) {
      debugLogService.verboseServerLog(
        `Generation aborted because chat ${chatId} could not be resolved or has no persisted messages.`,
      );
      return Response.json(
        { error: `Chat not found or has no messages: ${chatId}` },
        { status: 404 },
      );
    }

    debugLogService.verboseServerLog(
      "No normalized conversation messages were available, so the raw request will be proxied directly.",
    );

    return await llamaServerManager.proxyChatCompletion(
      stripChatGenerationFields(requestBody),
      signal,
    );
  }

  const upstreamBody: Record<string, unknown> = {
    ...stripChatGenerationFields(requestBody),
    messages: conversationMessages,
  };

  const toolManifests = await toolRegistry.listEnabledToolManifests();

  if (!chatId || toolManifests.length === 0) {
    debugLogService.verboseServerLog(
      !chatId
        ? "Proxying chat generation directly to llama-server because no persisted chatId was provided."
        : "Proxying chat generation directly to llama-server because no tools are currently enabled.",
    );
    return await llamaServerManager.proxyChatCompletion(upstreamBody, signal);
  }

  const toolSupport = llamaServerManager.getToolCallingSupport();

  if (!toolSupport.supported) {
    debugLogService.verboseServerLog(
      `Tool-enabled generation for chat ${chatId} was rejected because the active chat template is not tool-compatible.`,
    );
    return Response.json(
      {
        error:
          toolSupport.reason ??
          "Enabled tools require a tool-compatible chat template before generation can continue.",
      },
      { status: 409 },
    );
  }

  debugLogService.verboseServerLog(
    `Starting tool-enabled chat generation for chat ${chatId} with ${String(toolManifests.length)} enabled tool(s).`,
  );

  return createToolConversationStreamResponse({
    chatId,
    conversationMessages,
    database,
    debugLogService,
    llamaServerManager,
    requestBody: upstreamBody,
    signal,
    toolRegistry,
    tools: toolManifests,
  });
}

/**
 * Creates an SSE streaming response that resolves a pending tool
 * confirmation (approved or rejected) and resumes the tool conversation
 * loop from the confirmation point.
 *
 * @param options - Dependencies, confirmation state, and message identifiers.
 * @returns An HTTP {@link Response} with a streaming body.
 */
export async function createToolConfirmationResponse(options: {
  approved: boolean;
  assistantMessageId: string;
  chatId: string;
  database: AppDatabase;
  debugLogService: DebugLogService;
  llamaServerManager: LlamaServerManager;
  signal: AbortSignal;
  toolRegistry: LocalToolRegistry;
}): Promise<Response> {
  const {
    approved,
    assistantMessageId,
    chatId,
    database,
    debugLogService,
    llamaServerManager,
    signal,
    toolRegistry,
  } = options;
  const persistedChat = database.getChat(chatId);

  if (!persistedChat) {
    return Response.json({ error: `Chat not found: ${chatId}` }, { status: 404 });
  }

  const assistantMessage = persistedChat.messages.find(
    (message) => message.id === assistantMessageId,
  );

  if (!assistantMessage) {
    return Response.json({ error: `Message not found: ${assistantMessageId}` }, { status: 404 });
  }

  const pendingConfirmation = extractToolConfirmationRecord(assistantMessage);

  if (!pendingConfirmation || pendingConfirmation.state !== "pending") {
    return Response.json(
      { error: "The selected tool call is not awaiting confirmation." },
      { status: 409 },
    );
  }

  const toolCalls = extractPersistedToolCalls(assistantMessage);

  if (toolCalls.length === 0) {
    return Response.json(
      { error: "The selected assistant message does not contain any persisted tool calls." },
      { status: 409 },
    );
  }

  const toolManifests = await toolRegistry.listEnabledToolManifests();

  if (toolManifests.length > 0) {
    const toolSupport = llamaServerManager.getToolCallingSupport();

    if (!toolSupport.supported) {
      return Response.json(
        {
          error:
            toolSupport.reason ??
            "Enabled tools require a tool-compatible chat template before generation can continue.",
        },
        { status: 409 },
      );
    }
  }

  return createToolConversationStreamResponse({
    chatId,
    conversationMessages: buildConversationMessagesFromRecords(
      persistedChat.messages.filter((message) => message.sequence <= assistantMessage.sequence),
    ),
    database,
    debugLogService,
    initialConfirmation: {
      approved,
      assistantMessageId,
      entries: resolveToolExecutionEntries(toolCalls, toolManifests),
    },
    llamaServerManager,
    requestBody: {
      messages: [],
      stream: true,
    },
    signal,
    toolRegistry,
    tools: toolManifests,
  });
}

/**
 * Builds the raw SSE streaming {@link Response} that drives the multi-turn
 * tool conversation loop, optionally starting from a pending confirmation.
 *
 * @param options - Stream context with optional initial confirmation state.
 * @returns An HTTP response whose body is a `ReadableStream` of SSE events.
 */
function createToolConversationStreamResponse(
  options: Omit<ToolConversationStreamContext, "controller"> & {
    initialConfirmation?: {
      approved: boolean;
      assistantMessageId: string;
      entries: ToolExecutionEntry[];
    };
  },
): Response {
  const {
    chatId,
    conversationMessages,
    database,
    debugLogService,
    initialConfirmation,
    llamaServerManager,
    requestBody,
    signal,
    toolRegistry,
    tools,
  } = options;

  return new Response(
    new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const keepaliveEncoder = new TextEncoder();
        const closeController = (): void => {
          try {
            controller.close();
          } catch {
            // The stream is already closed or errored.
          }
        };
        const errorController = (error: unknown): void => {
          try {
            controller.error(error);
          } catch {
            // The stream is already closed or errored.
          }
        };
        const keepaliveHandle = setInterval(() => {
          if (signal.aborted || controller.desiredSize === null) {
            clearInterval(keepaliveHandle);
            return;
          }

          try {
            controller.enqueue(keepaliveEncoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepaliveHandle);
          }
        }, TOOL_STREAM_KEEPALIVE_INTERVAL_MS);

        try {
          const streamContext: ToolConversationStreamContext = {
            chatId,
            controller,
            conversationMessages,
            database,
            debugLogService,
            llamaServerManager,
            requestBody,
            signal,
            toolRegistry,
            tools,
          };

          debugLogService.verboseServerLog(`Opened tool conversation stream for chat ${chatId}.`);

          if (initialConfirmation) {
            await resolvePendingToolConfirmation(streamContext, initialConfirmation);
          }

          for (let turnIndex = 0; turnIndex < MAX_TOOL_TURNS; turnIndex += 1) {
            if (signal.aborted) {
              debugLogService.verboseServerLog(
                `Tool conversation stream aborted by the client for chat ${chatId}.`,
              );
              closeController();
              return;
            }

            const turnResult = await runAssistantTurn(streamContext);

            if (turnResult.toolCalls.length === 0) {
              debugLogService.verboseServerLog(
                `Assistant turn completed for chat ${chatId} without tool calls; closing the tool stream.`,
              );
              closeController();
              return;
            }

            const toolAction = await persistAndExecuteToolCalls(
              streamContext,
              turnResult.toolCalls,
            );

            if (toolAction === "awaiting_confirmation") {
              closeController();
              return;
            }
          }

          debugLogService.verboseServerLog(
            `Tool conversation stream exceeded the ${String(MAX_TOOL_TURNS)}-turn safety limit for chat ${chatId}.`,
          );

          enqueueSsePayload(controller, {
            choices: [
              {
                delta: {
                  content: TOOL_LOOP_SAFETY_MESSAGE,
                },
              },
            ],
          });
          closeController();
        } catch (error) {
          if (
            signal.aborted ||
            error instanceof StreamClosedError ||
            error instanceof ChatNotFoundError ||
            database.getChat(chatId) === null
          ) {
            if (!signal.aborted && !(error instanceof StreamClosedError)) {
              debugLogService.verboseServerLog(
                `Tool conversation stream stopped because chat ${chatId} was deleted during generation.`,
              );
            }

            closeController();
            return;
          }

          const errorMessage = error instanceof Error ? error.message : String(error);

          debugLogService.verboseServerLog(
            `Tool conversation stream failed for chat ${chatId}: ${errorMessage}`,
          );

          errorController(error);
        } finally {
          clearInterval(keepaliveHandle);
        }
      },
    }),
    {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
      status: 200,
    },
  );
}

/**
 * Runs a single assistant generation turn by proxying the conversation
 * messages to `llama-server` with tool definitions attached.
 *
 * @param context - Shared stream context.
 * @returns The accumulated assistant content, reasoning, and tool calls.
 */
async function runAssistantTurn(
  context: ToolConversationStreamContext,
): Promise<AssistantTurnResult> {
  context.debugLogService.verboseServerLog(
    `Beginning assistant turn for chat ${context.chatId} with ${String(context.conversationMessages.length)} conversation message(s) and ${String(context.tools.length)} enabled tool(s).`,
  );

  const upstreamResponse = await context.llamaServerManager.proxyChatCompletion(
    {
      ...stripChatGenerationFields(context.requestBody),
      messages: context.conversationMessages,
      parallel_tool_calls: false,
      parse_tool_calls: true,
      tools: context.tools.map((tool) => ({
        function: {
          description: tool.manifest.description,
          name: tool.manifest.name,
          parameters: tool.manifest.inputSchema,
        },
        type: "function",
      })),
    },
    context.signal,
  );

  if (!upstreamResponse.ok) {
    context.debugLogService.verboseServerLog(
      `Assistant turn request for chat ${context.chatId} failed with upstream status ${String(upstreamResponse.status)}.`,
    );
    throw new Error(await readErrorResponseMessage(upstreamResponse));
  }

  const turnResult = await consumeAssistantTurnStream(
    upstreamResponse,
    context.controller,
    context.signal,
    context.llamaServerManager.getActiveThinkingTags(),
  );

  context.debugLogService.verboseServerLog(
    `Assistant turn stream finished for chat ${context.chatId} with ${String(turnResult.assistantContent.length)} content chars, ${String(turnResult.reasoningContent.length)} reasoning chars, and ${String(turnResult.toolCalls.length)} tool call(s).`,
  );

  return turnResult;
}

/**
 * Persists tool-call metadata on an assistant message and either
 * executes the tool calls immediately or pauses for user confirmation.
 *
 * @param context - Shared stream context.
 * @param toolCalls - Tool calls extracted from the assistant turn.
 * @returns `"awaiting_confirmation"` if the stream paused, `"completed"` otherwise.
 */
async function persistAndExecuteToolCalls(
  context: ToolConversationStreamContext,
  toolCalls: StreamedToolCall[],
): Promise<"awaiting_confirmation" | "completed"> {
  const executionEntries = resolveToolExecutionEntries(toolCalls, context.tools);
  const toolConfirmation = buildToolConfirmationRecord(executionEntries);

  assertToolConversationPersistenceAllowed(context);

  const assistantToolCallMessage = context.database.appendMessage(
    context.chatId,
    "assistant",
    "",
    [],
    undefined,
    false,
    {
      hiddenFromTranscript: true,
      ...(toolConfirmation ? { toolConfirmation } : {}),
      toolCalls: createPersistedToolCalls(toolCalls),
    },
  );

  context.conversationMessages.push(createAssistantToolCallRequestMessage(toolCalls));
  enqueueSsePayload(context.controller, {
    local_event: "message_persisted",
    message: assistantToolCallMessage,
  });

  if (toolConfirmation) {
    const requiredToolNames = toolConfirmation.calls
      .filter((toolCall) => toolCall.requiresConfirmation)
      .map((toolCall) => toolCall.displayName ?? toolCall.toolName)
      .join(", ");

    context.debugLogService.serverLog(
      `Waiting for tool confirmation for ${requiredToolNames || "tool execution"}.`,
    );
    enqueueSsePayload(context.controller, {
      local_event: "tool_status",
      message: `Awaiting confirmation: ${requiredToolNames || "tool execution"}`,
      status: "waiting",
    });

    return "awaiting_confirmation";
  }

  await executeToolCallEntries(context, executionEntries, true);

  return "completed";
}

/**
 * Resolves a pending tool confirmation by updating the persisted state
 * and executing or denying the tool calls accordingly.
 *
 * @param context - Shared stream context.
 * @param pendingResolution - Confirmation resolution parameters.
 */
async function resolvePendingToolConfirmation(
  context: ToolConversationStreamContext,
  pendingResolution: {
    approved: boolean;
    assistantMessageId: string;
    entries: ToolExecutionEntry[];
  },
): Promise<void> {
  assertToolConversationPersistenceAllowed(context);

  const assistantMessage = context.database.getMessage(
    context.chatId,
    pendingResolution.assistantMessageId,
  );

  if (!assistantMessage) {
    throw new Error(
      `Pending tool confirmation message not found: ${pendingResolution.assistantMessageId}`,
    );
  }

  const existingConfirmation = extractToolConfirmationRecord(assistantMessage);

  if (!existingConfirmation) {
    throw new Error(
      "The selected message does not contain any pending tool confirmation metadata.",
    );
  }

  const updatedMessage = context.database.updateMessageMetadata(
    context.chatId,
    pendingResolution.assistantMessageId,
    {
      ...assistantMessage.metadata,
      toolConfirmation: {
        ...existingConfirmation,
        state: pendingResolution.approved ? "approved" : "rejected",
      },
    },
  );

  if (!updatedMessage) {
    throw new Error(
      `Failed to update pending tool confirmation: ${pendingResolution.assistantMessageId}`,
    );
  }

  await executeToolCallEntries(context, pendingResolution.entries, pendingResolution.approved);
}

/**
 * Executes a batch of tool calls sequentially, persisting each result
 * as a `tool` role message and emitting status SSE events.
 *
 * @param context - Shared stream context.
 * @param executionEntries - Tool calls paired with their registry summaries.
 * @param approved - Whether the user approved execution (`false` yields denial results).
 */
async function executeToolCallEntries(
  context: ToolConversationStreamContext,
  executionEntries: ToolExecutionEntry[],
  approved: boolean,
): Promise<void> {
  for (const executionEntry of executionEntries) {
    assertToolConversationPersistenceAllowed(context);

    const toolCall = executionEntry.call;
    const toolSummary = executionEntry.summary;
    let toolResult: ToolResult;

    if (!approved) {
      context.debugLogService.serverLog(
        `Tool call ${toolCall.name} (${toolCall.id}) was denied by the user.`,
      );
      toolResult = createDeniedToolResult(toolCall.name);
    } else {
      context.debugLogService.serverLog(`Executing tool call ${toolCall.name} (${toolCall.id}).`);
      enqueueSsePayload(context.controller, {
        callId: toolCall.id,
        local_event: "tool_status",
        message: `Running tool: ${toolCall.name}`,
        status: "running",
        toolName: toolCall.name,
      });

      const parsedToolArguments = parseToolArguments(toolCall.argumentsText);

      if (!parsedToolArguments.ok) {
        toolResult = createInvalidArgumentsToolResult(
          toolCall.name,
          toolCall.argumentsText,
          parsedToolArguments.error,
        );
      } else {
        const activeModelId = context.llamaServerManager.getSnapshot().activeModelId;
        toolResult = await context.toolRegistry.executeTool(toolCall.name, {
          args: parsedToolArguments.args,
          callId: toolCall.id,
          chatId: context.chatId,
          ...(typeof activeModelId === "string" ? { modelName: activeModelId } : {}),
          signal: context.signal,
        });
      }
    }

    context.debugLogService.verboseServerLog(
      approved
        ? toolResult.ok
          ? `Tool call ${toolCall.name} (${toolCall.id}) completed successfully.`
          : `Tool call ${toolCall.name} (${toolCall.id}) failed: ${toolResult.error.message}`
        : `Tool call ${toolCall.name} (${toolCall.id}) was canceled before execution.`,
    );

    assertToolConversationPersistenceAllowed(context);

    const persistedToolMessage = context.database.appendMessage(
      context.chatId,
      "tool",
      createToolTranscriptContent(toolCall.name, toolResult),
      [],
      undefined,
      false,
      {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolPolicy: toolSummary?.policy,
        toolResult,
      },
    );

    context.conversationMessages.push(createToolRequestMessage(toolCall.id, toolResult));
    enqueueSsePayload(context.controller, {
      local_event: "message_persisted",
      message: persistedToolMessage,
    });
    enqueueSsePayload(context.controller, {
      callId: toolCall.id,
      local_event: "tool_status",
      message: approved
        ? toolResult.ok
          ? `Tool completed: ${toolCall.name}`
          : `Tool failed: ${toolCall.name}`
        : `Tool canceled: ${toolCall.name}`,
      status: approved && toolResult.ok ? "completed" : "failed",
      toolName: toolCall.name,
    });
  }
}

function assertToolConversationPersistenceAllowed(
  context: Pick<ToolConversationStreamContext, "chatId" | "database" | "signal">,
): void {
  if (context.signal.aborted) {
    throw new Error("Generation was aborted.");
  }

  if (context.database.getChat(context.chatId) === null) {
    throw new ChatNotFoundError(context.chatId);
  }
}

/**
 * Consumes the SSE stream from a proxied assistant turn, forwarding
 * content and reasoning deltas to the client while accumulating
 * tool-call fragments.
 *
 * @param response - Upstream response from `llama-server`.
 * @param controller - Client-facing SSE stream controller.
 * @param signal - Abort signal for cancellation.
 * @returns Accumulated turn result with text, reasoning, and tool calls.
 */
async function consumeAssistantTurnStream(
  response: Response,
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal: AbortSignal,
  fallbackThinkingTags?: ThinkingTagSettings | null,
): Promise<AssistantTurnResult> {
  if (!response.body) {
    throw new Error("The backend returned an empty stream response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantContent = "";
  let reasoningContent = "";
  const toolCalls = new Map<number, StreamedToolCall>();
  const reasoningParser = createReasoningParser(fallbackThinkingTags ?? null);

  while (true) {
    if (signal.aborted) {
      throw new Error("Generation was aborted.");
    }

    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const parsedEvents = consumeSseEvents<Record<string, unknown>>(buffer, { strict: false });
    buffer = parsedEvents.remainder;

    for (const payload of parsedEvents.payloads) {
      const extractedDelta = extractAssistantDelta(payload);
      const parsedDelta = splitReasoningDelta(extractedDelta, reasoningParser);

      if (typeof parsedDelta.content === "string") {
        assistantContent += parsedDelta.content;
      }

      if (typeof parsedDelta.reasoning === "string") {
        reasoningContent += parsedDelta.reasoning;
      }

      if (parsedDelta.content || parsedDelta.reasoning) {
        enqueueSsePayload(controller, {
          choices: [
            {
              delta: {
                ...(parsedDelta.content ? { content: parsedDelta.content } : {}),
                ...(parsedDelta.reasoning ? { reasoning_content: parsedDelta.reasoning } : {}),
              },
            },
          ],
        });
      }

      for (const streamedToolCall of extractedDelta.toolCalls) {
        const existingCall = toolCalls.get(streamedToolCall.index) ?? {
          argumentsText: "",
          id: "",
          name: "",
        };

        toolCalls.set(streamedToolCall.index, {
          argumentsText: existingCall.argumentsText + (streamedToolCall.argumentsText ?? ""),
          id: streamedToolCall.id || existingCall.id,
          name: streamedToolCall.name || existingCall.name,
        });
      }
    }
  }

  buffer += decoder.decode();
  let finalEvents: Array<Record<string, unknown>> = [];

  try {
    finalEvents = flushSseEvents<Record<string, unknown>>(buffer, { strict: false });
  } catch {
    // Ignore malformed final payloads and preserve the assistant turn as much as possible.
  }

  for (const payload of finalEvents) {
    const extractedDelta = extractAssistantDelta(payload);
    const parsedDelta = splitReasoningDelta(extractedDelta, reasoningParser);

    if (typeof parsedDelta.content === "string") {
      assistantContent += parsedDelta.content;
    }

    if (typeof parsedDelta.reasoning === "string") {
      reasoningContent += parsedDelta.reasoning;
    }

    if (parsedDelta.content || parsedDelta.reasoning) {
      enqueueSsePayload(controller, {
        choices: [
          {
            delta: {
              ...(parsedDelta.content ? { content: parsedDelta.content } : {}),
              ...(parsedDelta.reasoning ? { reasoning_content: parsedDelta.reasoning } : {}),
            },
          },
        ],
      });
    }

    for (const streamedToolCall of extractedDelta.toolCalls) {
      const existingCall = toolCalls.get(streamedToolCall.index) ?? {
        argumentsText: "",
        id: "",
        name: "",
      };

      toolCalls.set(streamedToolCall.index, {
        argumentsText: existingCall.argumentsText + (streamedToolCall.argumentsText ?? ""),
        id: streamedToolCall.id || existingCall.id,
        name: streamedToolCall.name || existingCall.name,
      });
    }
  }

  if (reasoningParser) {
    const flushedDelta = reasoningParser.flush();

    if (flushedDelta.content.length > 0) {
      assistantContent += flushedDelta.content;
    }

    if (flushedDelta.reasoning.length > 0) {
      reasoningContent += flushedDelta.reasoning;
    }

    if (flushedDelta.content.length > 0 || flushedDelta.reasoning.length > 0) {
      enqueueSsePayload(controller, {
        choices: [
          {
            delta: {
              ...(flushedDelta.content.length > 0 ? { content: flushedDelta.content } : {}),
              ...(flushedDelta.reasoning.length > 0
                ? { reasoning_content: flushedDelta.reasoning }
                : {}),
            },
          },
        ],
      });
    }
  }

  return {
    assistantContent,
    reasoningContent,
    toolCalls: [...toolCalls.entries()]
      .sort((leftEntry, rightEntry) => leftEntry[0] - rightEntry[0])
      .map(([, toolCall]) => toolCall)
      .filter((toolCall) => toolCall.id.length > 0 && toolCall.name.length > 0),
  };
}

function createReasoningParser(tags: ThinkingTagSettings | null): ReasoningParser | null {
  if (!tags || tags.startString.length === 0 || tags.endString.length === 0) {
    return null;
  }

  return new ReasoningParser(tags);
}

function splitReasoningDelta(
  extractedDelta: {
    content?: string;
    reasoning?: string;
    toolCalls: Array<{ argumentsText?: string; id?: string; index: number; name?: string }>;
  },
  reasoningParser: ReasoningParser | null,
): { content?: string; reasoning?: string } {
  if (typeof extractedDelta.reasoning === "string") {
    return {
      ...(typeof extractedDelta.content === "string" ? { content: extractedDelta.content } : {}),
      reasoning: extractedDelta.reasoning,
    };
  }

  if (!reasoningParser || typeof extractedDelta.content !== "string") {
    return {
      ...(typeof extractedDelta.content === "string" ? { content: extractedDelta.content } : {}),
      ...(typeof extractedDelta.reasoning === "string"
        ? { reasoning: extractedDelta.reasoning }
        : {}),
    };
  }

  const parsedDelta = reasoningParser.push(extractedDelta.content);

  return {
    ...(parsedDelta.content.length > 0 ? { content: parsedDelta.content } : {}),
    ...(parsedDelta.reasoning.length > 0 ? { reasoning: parsedDelta.reasoning } : {}),
  };
}

/**
 * Builds an OpenAI-format assistant message containing tool-call requests
 * for injection into the conversation history.
 *
 * @param toolCalls - Completed tool calls from the assistant turn.
 * @returns A conversation message record with `role: "assistant"` and `tool_calls`.
 */
function createAssistantToolCallRequestMessage(
  toolCalls: StreamedToolCall[],
): Record<string, unknown> {
  return {
    content: "",
    role: "assistant",
    tool_calls: createPersistedToolCalls(toolCalls),
  };
}

/**
 * Builds an OpenAI-format `tool` role message containing the tool result
 * for injection into the conversation history.
 *
 * @param toolCallId - Tool-call identifier to correlate with the assistant request.
 * @param toolResult - Execution result from the tool registry.
 * @returns A conversation message record with `role: "tool"`.
 */
function createToolRequestMessage(
  toolCallId: string,
  toolResult: ToolResult,
): Record<string, unknown> {
  return {
    content: JSON.stringify(toolResult),
    role: "tool",
    tool_call_id: toolCallId,
  };
}

/**
 * Produces a human-readable transcript of a tool execution for display
 * in the chat UI.
 *
 * @param toolName - Canonical tool name.
 * @param toolResult - Execution result.
 * @returns Formatted string indicating success or failure.
 */
function createToolTranscriptContent(toolName: string, toolResult: ToolResult): string {
  return toolResult.ok
    ? `Tool ${toolName} completed.\n\n${toolResult.content}`
    : `Tool ${toolName} failed.\n\n${toolResult.error.message}`;
}

/**
 * Converts streamed tool calls into the persisted record format stored
 * in assistant message metadata.
 *
 * @param toolCalls - Completed tool calls.
 * @returns Array of {@link PersistedToolCallRecord} objects.
 */
function createPersistedToolCalls(toolCalls: StreamedToolCall[]): PersistedToolCallRecord[] {
  return toolCalls.map((toolCall) => ({
    function: {
      arguments: toolCall.argumentsText,
      name: toolCall.name,
    },
    id: toolCall.id,
    type: "function",
  }));
}

/**
 * Matches each tool call to its registry summary for execution dispatch.
 *
 * @param toolCalls - Tool calls from the assistant turn.
 * @param tools - Currently enabled tool manifests.
 * @returns Paired execution entries.
 */
function resolveToolExecutionEntries(
  toolCalls: StreamedToolCall[],
  tools: ToolManifestEntry[],
): ToolExecutionEntry[] {
  return toolCalls.map((toolCall) => {
    const summary = tools.find((tool) => tool.manifest.name === toolCall.name)?.summary;

    return summary !== undefined ? { call: toolCall, summary } : { call: toolCall };
  });
}

/**
 * Builds a confirmation record if any tool in the batch requires
 * user confirmation before execution.
 *
 * @param executionEntries - Resolved tool execution entries.
 * @returns A pending {@link ToolConfirmationRecord}, or `null` if no confirmation is needed.
 */
function buildToolConfirmationRecord(
  executionEntries: ToolExecutionEntry[],
): ToolConfirmationRecord | null {
  if (!executionEntries.some((entry) => entry.summary?.policy.requiresConfirmation)) {
    return null;
  }

  return {
    calls: executionEntries.map((entry) => ({
      argumentsText: entry.call.argumentsText,
      callId: entry.call.id,
      category: entry.summary?.policy.category ?? "custom",
      dangerous: entry.summary?.policy.dangerous ?? false,
      ...(entry.summary?.displayName ? { displayName: entry.summary.displayName } : {}),
      requiresConfirmation: entry.summary?.policy.requiresConfirmation ?? false,
      toolName: entry.call.name,
    })),
    state: "pending",
  };
}

/**
 * Extracts persisted tool-call records from an assistant message's metadata.
 *
 * @param message - The persisted chat message.
 * @returns Parsed tool calls, or an empty array if none are present.
 */
function extractPersistedToolCalls(message: ChatMessageRecord): StreamedToolCall[] {
  const toolCalls = Array.isArray(message.metadata["toolCalls"])
    ? (message.metadata["toolCalls"] as unknown[])
    : [];

  return toolCalls
    .map((toolCallValue) => {
      if (!isObjectRecord(toolCallValue)) {
        return null;
      }

      const functionValue = isObjectRecord(toolCallValue["function"])
        ? toolCallValue["function"]
        : null;
      const argumentsText =
        functionValue && typeof functionValue["arguments"] === "string"
          ? functionValue["arguments"]
          : null;
      const toolName =
        functionValue && typeof functionValue["name"] === "string" ? functionValue["name"] : null;
      const toolCallId = typeof toolCallValue["id"] === "string" ? toolCallValue["id"] : null;

      if (!argumentsText || !toolName || !toolCallId) {
        return null;
      }

      return {
        argumentsText,
        id: toolCallId,
        name: toolName,
      } satisfies StreamedToolCall;
    })
    .filter((toolCall): toolCall is StreamedToolCall => toolCall !== null);
}

/**
 * Extracts and normalises a {@link ToolConfirmationRecord} from an
 * assistant message's metadata, if one exists.
 *
 * @param message - The persisted chat message.
 * @returns The normalised confirmation record, or `null`.
 */
function extractToolConfirmationRecord(message: ChatMessageRecord): ToolConfirmationRecord | null {
  const toolConfirmation = message.metadata["toolConfirmation"];

  if (!isObjectRecord(toolConfirmation) || typeof toolConfirmation["state"] !== "string") {
    return null;
  }

  const calls = Array.isArray(toolConfirmation["calls"])
    ? toolConfirmation["calls"].filter(isObjectRecord)
    : [];

  return {
    calls: calls.map((toolCall) => ({
      argumentsText:
        typeof toolCall["argumentsText"] === "string" ? toolCall["argumentsText"] : "{}",
      callId: typeof toolCall["callId"] === "string" ? toolCall["callId"] : "",
      category:
        typeof toolCall["category"] === "string"
          ? (toolCall["category"] as ToolSummary["policy"]["category"])
          : "custom",
      dangerous: toolCall["dangerous"] === true,
      ...(typeof toolCall["displayName"] === "string"
        ? { displayName: toolCall["displayName"] }
        : {}),
      requiresConfirmation: toolCall["requiresConfirmation"] === true,
      toolName: typeof toolCall["toolName"] === "string" ? toolCall["toolName"] : "",
    })),
    state:
      toolConfirmation["state"] === "approved" || toolConfirmation["state"] === "rejected"
        ? toolConfirmation["state"]
        : "pending",
  };
}

/**
 * Loads and returns the full conversation message array for a chat from the
 * database, ready for injection into a `POST /v1/chat/completions` request.
 *
 * @param database - Application database.
 * @param chatId - Chat identifier.
 * @returns Conversation messages, or an empty array if the chat does not exist.
 */
function loadConversationFromDatabase(
  database: AppDatabase,
  chatId: string,
): Record<string, unknown>[] {
  const chat = database.getChat(chatId);

  if (!chat || chat.messages.length === 0) {
    return [];
  }

  return buildConversationMessagesFromRecords(chat.messages);
}

/**
 * Rebuilds the conversation message array from persisted chat message
 * records, reconstructing tool-call assistant messages and tool results.
 *
 * @param messages - Ordered persisted messages.
 * @returns Array of conversation messages suitable for `POST /v1/chat/completions`.
 */
function buildConversationMessagesFromRecords(
  messages: ChatMessageRecord[],
): Record<string, unknown>[] {
  const conversationMessages: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const toolCalls = extractPersistedToolCalls(message);

      if (toolCalls.length > 0) {
        conversationMessages.push(createAssistantToolCallRequestMessage(toolCalls));
        continue;
      }
    }

    const requestMessage: Record<string, unknown> = {
      content: getReplayContent(message),
      role: message.role,
    };
    const persistedToolCallId = message.metadata["toolCallId"];

    if (message.role === "user" && message.mediaAttachments.length > 0) {
      requestMessage["mediaAttachments"] = message.mediaAttachments;
    }

    if (message.role === "tool" && typeof persistedToolCallId === "string") {
      requestMessage["tool_call_id"] = persistedToolCallId;
    }

    conversationMessages.push(requestMessage);
  }

  return conversationMessages;
}

/**
 * Returns the content to use when replaying a persisted message in a
 * new generation request. For tool messages, this is the serialised
 * {@link ToolResult}; for other roles, it is the raw content.
 *
 * @param message - The persisted chat message.
 * @returns Content string for the conversation array.
 */
function getReplayContent(message: ChatMessageRecord): string {
  if (message.role !== "tool") {
    return message.content;
  }

  const toolResult = message.metadata["toolResult"];

  try {
    return toolResult ? JSON.stringify(toolResult) : message.content;
  } catch {
    return message.content;
  }
}

/**
 * Coerces the raw `messages` field from the request body into a typed
 * array of conversation message records.
 *
 * @param messagesValue - Raw value from the incoming request body.
 * @returns Sanitised array of message objects.
 */
function normalizeConversationMessages(messagesValue: unknown): Record<string, unknown>[] {
  if (!Array.isArray(messagesValue)) {
    return [];
  }

  return messagesValue.filter(isObjectRecord).map((message) => ({ ...message }));
}

/**
 * Returns a shallow copy of the request body with orchestrator-specific
 * fields (e.g. `chatId`) removed before forwarding to `llama-server`.
 *
 * @param requestBody - Original request body.
 * @returns Cleaned request body for upstream proxying.
 */
function stripChatGenerationFields(requestBody: Record<string, unknown>): Record<string, unknown> {
  const nextBody = { ...requestBody };

  delete nextBody["chatId"];

  return nextBody;
}

/**
 * Safely parses a JSON-encoded arguments string into a plain object.
 *
 * @param argumentsText - Raw JSON string from the tool call.
 * @returns Parsed arguments object, or a parse error description.
 */
function parseToolArguments(argumentsText: string): ParsedToolArgumentsResult {
  try {
    const parsedValue = JSON.parse(argumentsText) as unknown;

    if (!isObjectRecord(parsedValue)) {
      return {
        error: "Tool arguments must decode to a JSON object.",
        ok: false,
      };
    }

    return {
      args: parsedValue,
      ok: true,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Tool arguments were not valid JSON.",
      ok: false,
    };
  }
}

/**
 * Creates a structured failure {@link ToolResult} for a tool call
 * that was denied by the user during the confirmation flow.
 *
 * @param toolName - Name of the denied tool.
 * @returns A denial failure result.
 */
function createDeniedToolResult(toolName: string): ToolResult {
  return {
    error: {
      code: "user_confirmation_denied",
      message: `Tool ${toolName} was not executed because the user denied confirmation.`,
    },
    ok: false,
  };
}

function createInvalidArgumentsToolResult(
  toolName: string,
  argumentsText: string,
  parseError: string,
): ToolResult {
  return {
    error: {
      code: "invalid_arguments",
      data: {
        argumentsText,
        parseError,
      },
      message: `Tool ${toolName} was not executed because its streamed arguments were invalid JSON. ${parseError}`,
    },
    ok: false,
  };
}

/**
 * Extracts the content delta, reasoning delta, and tool-call fragments
 * from a single parsed SSE payload in OpenAI streaming format.
 *
 * @param payload - Parsed JSON payload from a `data:` SSE line.
 * @returns Extracted content, reasoning, and tool-call fragments.
 */
function extractAssistantDelta(payload: Record<string, unknown>): {
  content?: string;
  reasoning?: string;
  toolCalls: Array<{ argumentsText?: string; id?: string; index: number; name?: string }>;
} {
  const choicesValue = payload["choices"];

  if (
    !Array.isArray(choicesValue) ||
    choicesValue.length === 0 ||
    !isObjectRecord(choicesValue[0])
  ) {
    return { toolCalls: [] };
  }

  const deltaValue = choicesValue[0]["delta"];

  if (!isObjectRecord(deltaValue)) {
    return { toolCalls: [] };
  }

  const extractedToolCalls = Array.isArray(deltaValue["tool_calls"])
    ? deltaValue["tool_calls"].filter(isObjectRecord).map((toolCallValue, toolIndex) => {
        const functionValue = isObjectRecord(toolCallValue["function"])
          ? toolCallValue["function"]
          : null;
        const argumentsText =
          functionValue && typeof functionValue["arguments"] === "string"
            ? functionValue["arguments"]
            : null;
        const toolCallId = typeof toolCallValue["id"] === "string" ? toolCallValue["id"] : null;
        const toolName =
          functionValue && typeof functionValue["name"] === "string" ? functionValue["name"] : null;

        return {
          index: typeof toolCallValue["index"] === "number" ? toolCallValue["index"] : toolIndex,
          ...(argumentsText ? { argumentsText } : {}),
          ...(toolCallId ? { id: toolCallId } : {}),
          ...(toolName ? { name: toolName } : {}),
        };
      })
    : [];

  const content = typeof deltaValue["content"] === "string" ? deltaValue["content"] : null;
  const reasoning =
    typeof deltaValue["reasoning_content"] === "string" ? deltaValue["reasoning_content"] : null;

  return {
    ...(content ? { content } : {}),
    ...(reasoning ? { reasoning } : {}),
    toolCalls: extractedToolCalls,
  };
}

/**
 * Enqueues a single SSE event containing a JSON-serialised payload into
 * the client-facing response stream.
 *
 * @param controller - `ReadableStream` controller for the SSE response.
 * @param payload - JSON-serialisable payload to send.
 */
function enqueueSsePayload(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: Record<string, unknown>,
): void {
  if (controller.desiredSize === null) {
    throw new StreamClosedError();
  }

  try {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
  } catch {
    throw new StreamClosedError();
  }
}

/** Shallow type guard for plain objects (non-null, non-array, typeof `"object"`). */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
