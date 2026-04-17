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

  test("ignores malformed complete JSON payloads and continues parsing the stream", () => {
    const parsedEvents = consumeJsonSseEvents(
      [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"bad"}}',
        "",
        'data: {"choices":[{"delta":{"content":"o"}}]}',
        "",
        "",
      ].join("\n"),
    );

    expect(parsedEvents.payloads).toHaveLength(2);
    expect(parsedEvents.payloads[0]).toEqual({ choices: [{ delta: { content: "Hel" } }] });
    expect(parsedEvents.payloads[1]).toEqual({ choices: [{ delta: { content: "o" } }] });
    expect(parsedEvents.remainder).toBe("");
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

  test("ignores malformed truncated payloads when the stream ends", () => {
    expect(flushJsonSseBuffer('data: {"choices":[{"delta":')).toEqual([]);
  });
});

describe("subscribeToJsonSse", () => {
  test("reports malformed event payloads as transient errors when reconnects are disabled", () => {
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
    const payloads: Array<{ ok: boolean }> = [];

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
      onPayload: (payload) => {
        payloads.push(payload);
      },
      path: "/api/events/runtime",
      reconnect: false,
    });

    fakeEventSource.emit("runtime", new MessageEvent("runtime", { data: "{not-json" }));
    fakeEventSource.emit(
      "runtime",
      new MessageEvent("runtime", {
        data: JSON.stringify({ payload: { ok: true }, timestamp: "1", type: "runtime" }),
      }),
    );
    disconnect();

    expect(errorKinds).toEqual(["transient"]);
    expect(payloads).toEqual([{ ok: true }]);
  });

  test("treats malformed event payloads as transient even when reconnect is enabled", async () => {
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
    createdSources[0]?.emit(
      "runtime",
      new MessageEvent("runtime", {
        data: JSON.stringify({ payload: { ok: true }, timestamp: "1", type: "runtime" }),
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    disconnect();

    expect(errorKinds).toEqual(["transient"]);
    expect(createdSources.length).toBe(1);
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
