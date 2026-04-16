/**
 * Represents a JSON SSE envelope emitted by the backend broadcasters.
 *
 * @typeParam T The payload type carried by the envelope.
 */
export interface SseEnvelope<T> {
  /** Logical event name associated with the payload. */
  type: string;
  /** RFC 3339 timestamp of when the envelope was created. */
  timestamp: string;
  /** JSON-serializable payload. */
  payload: T;
}

/**
 * Configures the retention behavior for a JSON SSE broadcaster.
 */
export interface JsonSseBroadcasterOptions {
  /** Maximum number of entries retained in memory while buffering is active. */
  maxEntries: number;
  /** Indicates whether payloads should be retained without any subscribers. */
  bufferWhenDisconnected: boolean;
}

/**
 * Broadcasts JSON SSE events to zero or more connected clients.
 *
 * @typeParam T The payload type carried by each event.
 */
export class JsonSseBroadcaster<T> {
  private readonly encoder = new TextEncoder();
  private readonly subscribers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  private readonly entries: Array<SseEnvelope<T>> = [];
  private maxEntries: number;

  /**
   * Creates a new JSON SSE broadcaster.
   *
   * @param options Broadcaster retention options.
   */
  public constructor(private readonly options: JsonSseBroadcasterOptions) {
    this.maxEntries = options.maxEntries;
  }

  /**
   * Creates an SSE response and subscribes the requesting client.
   *
   * @param request The inbound Bun request.
   * @param server The active Bun server instance.
   * @returns A streaming SSE response.
   */
  public subscribe(request: Request, server: Bun.Server<unknown>): Response {
    server.timeout(request, 0);

    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          const subscriptionId = crypto.randomUUID();
          const cleanup = (): void => {
            this.subscribers.delete(subscriptionId);
            controller.close();
          };

          this.subscribers.set(subscriptionId, controller);
          request.signal.addEventListener("abort", cleanup, { once: true });
          controller.enqueue(this.encoder.encode(": connected\n\n"));

          for (const entry of this.entries) {
            controller.enqueue(
              this.encoder.encode(`event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`),
            );
          }
        },
      }),
      {
        headers: {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        },
      },
    );
  }

  /**
   * Broadcasts a JSON payload to all connected subscribers.
   *
   * @param type Logical event name.
   * @param payload JSON payload to emit.
   * @returns The emitted envelope.
   */
  public broadcast(type: string, payload: T): SseEnvelope<T> {
    const envelope: SseEnvelope<T> = {
      type,
      timestamp: new Date().toISOString(),
      payload,
    };

    if (this.subscribers.size > 0 || this.options.bufferWhenDisconnected) {
      this.entries.push(envelope);

      const excessEntries = this.entries.length - this.maxEntries;

      if (excessEntries > 0) {
        this.entries.splice(0, excessEntries);
      }
    }

    const serializedEnvelope = this.encoder.encode(
      `event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`,
    );

    for (const [subscriptionId, controller] of this.subscribers.entries()) {
      try {
        controller.enqueue(serializedEnvelope);
      } catch {
        this.subscribers.delete(subscriptionId);
      }
    }

    return envelope;
  }

  /**
   * Returns the retained event envelopes.
   *
   * @returns The in-memory event buffer.
   */
  public getEntries(): readonly SseEnvelope<T>[] {
    return this.entries;
  }

  /**
   * Replaces the retained event buffer with a restored snapshot.
   *
   * @param entries The retained envelopes to seed into the broadcaster.
   */
  public replaceEntries(entries: readonly SseEnvelope<T>[]): void {
    this.entries.length = 0;
    this.entries.push(...entries.slice(-this.maxEntries));
  }

  /**
   * Clears the in-memory event buffer.
   */
  public clear(): void {
    this.entries.length = 0;
  }

  /**
   * Updates the maximum retained entry count.
   *
   * @param maxEntries The new cap for retained events.
   */
  public setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;

    const excessEntries = this.entries.length - this.maxEntries;

    if (excessEntries > 0) {
      this.entries.splice(0, excessEntries);
    }
  }
}
