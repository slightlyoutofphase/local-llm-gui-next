const INVALID_SSE_EVENT_PAYLOAD_MESSAGE = "The backend returned an invalid SSE event payload.";
const OVERSIZED_SSE_REMAINDER_MESSAGE =
  "The backend returned an oversized or unterminated SSE payload.";
const MAX_JSON_SSE_REMAINDER_CHARS = 256_000;

export function consumeJsonSseEvents(buffer: string): {
  payloads: Record<string, unknown>[];
  remainder: string;
} {
  const segments = buffer.split(/\r?\n\r?\n/);
  const remainder = segments.pop() ?? "";
  const payloads: Record<string, unknown>[] = [];

  if (remainder.length > MAX_JSON_SSE_REMAINDER_CHARS) {
    throw new Error(OVERSIZED_SSE_REMAINDER_MESSAGE);
  }

  for (const segment of segments) {
    const parsedPayload = parseJsonSseSegment(segment);

    if (parsedPayload) {
      payloads.push(parsedPayload);
    }
  }

  return {
    payloads,
    remainder,
  };
}

export function flushJsonSseBuffer(buffer: string): Record<string, unknown>[] {
  if (buffer.trim().length === 0) {
    return [];
  }

  const finalizedEvents = consumeJsonSseEvents(`${buffer}\n\n`);

  if (finalizedEvents.remainder.trim().length > 0) {
    throw new Error("The backend returned a truncated SSE payload.");
  }

  return finalizedEvents.payloads;
}

interface JsonSseEnvelope<TPayload> {
  payload: TPayload;
  timestamp: string;
  type: string;
}

export interface JsonSseStreamSubscriptionError {
  attempt: number;
  error?: Error;
  kind: "fatal" | "transient";
  retryDelayMs?: number;
}

interface JsonSseSubscriptionOptions<TPayload> {
  eventName: string;
  onError?: (error: JsonSseStreamSubscriptionError) => void;
  onOpen?: () => void;
  onPayload: (payload: TPayload) => void;
  path: string;
  reconnect?:
    | false
    | {
        initialDelayMs?: number;
        maxAttempts?: number;
        maxDelayMs?: number;
        multiplier?: number;
      };
}

export function subscribeToJsonSse<TPayload>(
  options: JsonSseSubscriptionOptions<TPayload>,
): () => void {
  const reconnectOptions =
    options.reconnect === false
      ? false
      : {
          initialDelayMs: options.reconnect?.initialDelayMs ?? 1_500,
          maxAttempts: options.reconnect?.maxAttempts ?? 5,
          maxDelayMs: options.reconnect?.maxDelayMs ?? 15_000,
          multiplier: options.reconnect?.multiplier ?? 2,
        };
  let closed = false;
  let currentEventSource: EventSource | null = null;
  let reconnectAttempt = 0;
  let reconnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let openListener: (() => void) | null = null;
  let listener: ((event: MessageEvent<string>) => void) | null = null;
  let errorListener: (() => void) | null = null;

  const cleanupCurrentSource = (): void => {
    if (!currentEventSource) {
      return;
    }

    if (typeof currentEventSource.removeEventListener === "function") {
      if (openListener) {
        currentEventSource.removeEventListener("open", openListener as EventListener);
      }

      if (listener) {
        currentEventSource.removeEventListener(options.eventName, listener as EventListener);
      }

      if (errorListener) {
        currentEventSource.removeEventListener("error", errorListener as EventListener);
      }
    }

    currentEventSource.close();
    currentEventSource = null;
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimeoutHandle === null) {
      return;
    }

    clearTimeout(reconnectTimeoutHandle);
    reconnectTimeoutHandle = null;
  };

  const reportFatalFailure = (error: Error, attempt: number): void => {
    cleanupCurrentSource();
    clearReconnectTimer();
    closed = true;
    options.onError?.({
      attempt,
      error,
      kind: "fatal",
    });
  };

  const scheduleReconnect = (error?: Error): void => {
    if (closed || reconnectOptions === false || reconnectTimeoutHandle !== null) {
      return;
    }

    const nextAttempt = reconnectAttempt + 1;

    if (nextAttempt > reconnectOptions.maxAttempts) {
      reportFatalFailure(
        error ??
          new Error(
            `The ${options.eventName} event stream could not recover after ${String(reconnectOptions.maxAttempts)} reconnect attempts.`,
          ),
        nextAttempt,
      );
      return;
    }

    const retryDelayMs = Math.min(
      reconnectOptions.initialDelayMs * reconnectOptions.multiplier ** reconnectAttempt,
      reconnectOptions.maxDelayMs,
    );

    reconnectAttempt = nextAttempt;
    options.onError?.({
      attempt: reconnectAttempt,
      ...(error ? { error } : {}),
      kind: "transient",
      retryDelayMs,
    });
    reconnectTimeoutHandle = setTimeout(() => {
      reconnectTimeoutHandle = null;
      connect();
    }, retryDelayMs);
  };

  const connect = (): void => {
    if (closed) {
      return;
    }

    cleanupCurrentSource();
    const EventSourceConstructor = globalThis.EventSource as unknown as {
      new (url: string): EventSource;
    };
    const eventSource = new EventSourceConstructor(options.path);
    currentEventSource = eventSource;

    openListener = (): void => {
      reconnectAttempt = 0;
      options.onOpen?.();
    };

    listener = (event: MessageEvent<string>): void => {
      try {
        const parsedEvent = JSON.parse(event.data) as JsonSseEnvelope<TPayload>;

        reconnectAttempt = 0;
        options.onOpen?.();
        options.onPayload(parsedEvent.payload);
      } catch (error) {
        const parseError =
          error instanceof Error ? error : new Error(INVALID_SSE_EVENT_PAYLOAD_MESSAGE);

        options.onError?.({
          attempt: reconnectAttempt + 1,
          error: parseError,
          kind: "transient",
        });
        return;
      }
    };

    errorListener = (): void => {
      cleanupCurrentSource();

      if (closed) {
        return;
      }

      if (reconnectOptions === false) {
        options.onError?.({
          attempt: reconnectAttempt + 1,
          kind: "transient",
        });
        return;
      }

      scheduleReconnect();
    };

    eventSource.addEventListener("open", openListener as EventListener);
    eventSource.addEventListener(options.eventName, listener as EventListener);
    eventSource.addEventListener("error", errorListener as EventListener);
  };

  connect();

  return () => {
    closed = true;
    clearReconnectTimer();
    cleanupCurrentSource();
  };
}

export async function streamJsonSseRequest<TPayload>(options: {
  body: Record<string, unknown>;
  input: string;
  onPayload: (payload: TPayload) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const requestInit: RequestInit = {
    body: JSON.stringify(options.body),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const response = await fetch(options.input, requestInit);

  if (!response.ok) {
    throw new Error(await readJsonSseErrorResponseMessage(response));
  }

  if (!response.body) {
    throw new Error("The backend returned an empty stream response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;

    try {
      chunk = await reader.read();
    } catch (error) {
      if (options.signal?.aborted && error instanceof Error && error.name === "AbortError") {
        break;
      }

      if (options.signal?.aborted) {
        break;
      }

      throw error;
    }

    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const parsedEvents = consumeJsonSseEvents(buffer);
    buffer = parsedEvents.remainder;

    for (const payload of parsedEvents.payloads) {
      options.onPayload(payload as TPayload);
    }
  }

  buffer += decoder.decode();

  for (const payload of flushJsonSseBuffer(buffer)) {
    options.onPayload(payload as TPayload);
  }
}

async function readJsonSseErrorResponseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown };

    if (typeof payload.error === "string" && payload.error.length > 0) {
      return payload.error;
    }

    if (typeof payload.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
  } catch {
    // Fall through to the response text fallback.
  }

  const responseText = await response.text().catch(() => "");

  return responseText.length > 0 ? responseText : `Request failed with status ${response.status}.`;
}

function parseJsonSseSegment(segment: string): Record<string, unknown> | null {
  const dataLines = segment
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);

  if (dataLines.length === 0) {
    return null;
  }

  const joinedPayload = dataLines.join("\n");

  if (joinedPayload === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(joinedPayload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
