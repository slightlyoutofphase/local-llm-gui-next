import { afterEach, describe, expect, test } from "bun:test";
import { consumeJsonSseEvents, flushJsonSseBuffer, subscribeToJsonSse } from "../../lib/sseClient";

const originalEventSource = globalThis.EventSource;

afterEach(() => {
  globalThis.EventSource = originalEventSource;
});

describe("consumeJsonSseEvents", () => {
  test("parses complete JSON SSE payloads and preserves the trailing remainder", () => {
    const parsedEvents = consumeJsonSseEvents(
      [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"!"}}]}',
      ].join("\n"),
    );

    expect(parsedEvents.payloads).toHaveLength(2);
    expect(parsedEvents.remainder).toBe('data: {"choices":[{"delta":{"content":"!"}}]}');
  });

  test("ignores DONE sentinels and comment-only segments", () => {
    const parsedEvents = consumeJsonSseEvents(
      [": keep-alive", "", "data: [DONE]", "", ""].join("\n"),
    );

    expect(parsedEvents.payloads).toEqual([]);
    expect(parsedEvents.remainder).toBe("");
  });

  test("throws for malformed complete JSON payloads instead of ignoring them", () => {
    expect(() => consumeJsonSseEvents(['data: {"choices":', "", ""].join("\n"))).toThrow(
      "The backend returned an invalid SSE JSON payload.",
    );
  });

  test("throws when the trailing remainder grows beyond the safety cap", () => {
    expect(() => consumeJsonSseEvents(`data: ${"x".repeat(256_001)}`)).toThrow(
      "The backend returned an oversized or unterminated SSE payload.",
    );
  });
});

describe("flushJsonSseBuffer", () => {
  test("accepts a final complete SSE payload even without a trailing separator", () => {
    const payloads = flushJsonSseBuffer('data: {"choices":[{"delta":{"content":"done"}}]}');

    expect(payloads).toHaveLength(1);
  });

  test("throws when the stream ends with a truncated JSON payload", () => {
    expect(() => flushJsonSseBuffer('data: {"choices":[{"delta":')).toThrow(
      "The backend returned an invalid SSE JSON payload.",
    );
  });
});

describe("subscribeToJsonSse", () => {
  test("reports malformed event payloads as fatal errors when reconnects are disabled", () => {
    class FakeEventSource {
      private readonly listeners = new Map<string, Set<EventListener>>();

      public addEventListener(type: string, listener: EventListener): void {
        const listenersForType = this.listeners.get(type) ?? new Set<EventListener>();

        listenersForType.add(listener);
        this.listeners.set(type, listenersForType);
      }

      public close(): void {}

      public emit(type: string, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
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

    const disconnect = subscribeToJsonSse<{ ok: boolean }>({
      eventName: "runtime",
      onError: (error) => {
        errorKinds.push(error.kind);
      },
      onPayload: () => {},
      path: "/api/events/runtime",
      reconnect: false,
    });

    fakeEventSource.emit("runtime", new MessageEvent("runtime", { data: "{not-json" }));
    disconnect();

    expect(errorKinds).toEqual(["fatal"]);
  });

  test("reconnects after malformed event payloads when retries are enabled", async () => {
    class FakeEventSource {
      private readonly listeners = new Map<string, Set<EventListener>>();

      public addEventListener(type: string, listener: EventListener): void {
        const listenersForType = this.listeners.get(type) ?? new Set<EventListener>();

        listenersForType.add(listener);
        this.listeners.set(type, listenersForType);
      }

      public close(): void {}

      public emit(type: string, event?: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event ?? new Event(type));
        }
      }
    }

    const createdSources: FakeEventSource[] = [];
    const errorKinds: string[] = [];
    const payloads: Array<{ ok: boolean }> = [];

    globalThis.EventSource = class {
      public constructor() {
        const nextSource = new FakeEventSource();

        createdSources.push(nextSource);
        return nextSource as unknown as EventSource;
      }
    } as typeof EventSource;

    const disconnect = subscribeToJsonSse<{ ok: boolean }>({
      eventName: "runtime",
      onError: (error) => {
        errorKinds.push(error.kind);
      },
      onPayload: (payload) => {
        payloads.push(payload);
      },
      path: "/api/events/runtime",
      reconnect: {
        initialDelayMs: 1,
        maxAttempts: 2,
        maxDelayMs: 2,
      },
    });

    createdSources[0]?.emit("runtime", new MessageEvent("runtime", { data: "{not-json" }));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    createdSources[1]?.emit(
      "runtime",
      new MessageEvent("runtime", {
        data: '{"payload":{"ok":true},"timestamp":"2026-04-15T00:00:00.000Z","type":"runtime"}',
      }),
    );
    disconnect();

    expect(errorKinds).toEqual(["transient"]);
    expect(createdSources.length).toBe(2);
    expect(payloads).toEqual([{ ok: true }]);
  });

  test("reconnects with backoff after transient EventSource failures", async () => {
    class FakeEventSource {
      private readonly listeners = new Map<string, Set<EventListener>>();

      public addEventListener(type: string, listener: EventListener): void {
        const listenersForType = this.listeners.get(type) ?? new Set<EventListener>();

        listenersForType.add(listener);
        this.listeners.set(type, listenersForType);
      }

      public close(): void {}

      public emit(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(new Event(type));
        }
      }
    }

    const createdSources: FakeEventSource[] = [];
    const errorKinds: string[] = [];

    globalThis.EventSource = class {
      public constructor() {
        const nextSource = new FakeEventSource();

        createdSources.push(nextSource);
        return nextSource as unknown as EventSource;
      }
    } as typeof EventSource;

    const disconnect = subscribeToJsonSse<{ ok: boolean }>({
      eventName: "runtime",
      onError: (error) => {
        errorKinds.push(error.kind);
      },
      onPayload: () => {},
      path: "/api/events/runtime",
      reconnect: {
        initialDelayMs: 1,
        maxDelayMs: 2,
      },
    });

    createdSources[0]?.emit("error");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    disconnect();

    expect(errorKinds).toEqual(["transient"]);
    expect(createdSources.length).toBe(2);
  });

  test("reports a fatal stream warning after retry exhaustion", async () => {
    class FakeEventSource {
      private readonly listeners = new Map<string, Set<EventListener>>();

      public addEventListener(type: string, listener: EventListener): void {
        const listenersForType = this.listeners.get(type) ?? new Set<EventListener>();

        listenersForType.add(listener);
        this.listeners.set(type, listenersForType);
      }

      public close(): void {}

      public emit(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(new Event(type));
        }
      }
    }

    const createdSources: FakeEventSource[] = [];
    const errors: Array<{ kind: string; message: string | null }> = [];

    globalThis.EventSource = class {
      public constructor() {
        const nextSource = new FakeEventSource();

        createdSources.push(nextSource);
        return nextSource as unknown as EventSource;
      }
    } as typeof EventSource;

    const disconnect = subscribeToJsonSse<{ ok: boolean }>({
      eventName: "runtime",
      onError: (error) => {
        errors.push({
          kind: error.kind,
          message: error.error?.message ?? null,
        });
      },
      onPayload: () => {},
      path: "/api/events/runtime",
      reconnect: {
        initialDelayMs: 1,
        maxAttempts: 1,
        maxDelayMs: 2,
      },
    });

    createdSources[0]?.emit("error");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    createdSources[1]?.emit("error");
    disconnect();

    expect(errors).toEqual([
      { kind: "transient", message: null },
      {
        kind: "fatal",
        message: "The runtime event stream could not recover after 1 reconnect attempts.",
      },
    ]);
  });
});
