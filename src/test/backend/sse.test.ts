import { describe, expect, test } from "bun:test";
import { JsonSseBroadcaster } from "../../backend/sse";
import { consumeSseEvents, flushSseEvents } from "../../backend/sseParsing";

describe("JsonSseBroadcaster", () => {
  test("buffers events when disconnected and replays them to new subscribers", async () => {
    const broadcaster = new JsonSseBroadcaster<{ foo: string }>({
      maxEntries: 10,
      bufferWhenDisconnected: true,
    });

    broadcaster.broadcast("log", { foo: "one" });
    broadcaster.broadcast("log", { foo: "two" });

    const request = new Request("http://localhost/api/events/debug");
    const server = {
      timeout: () => {},
    } as unknown as Bun.Server<unknown>;
    const response = broadcaster.subscribe(request, server);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (!text.includes("event: log") || !text.includes('"foo":"two"')) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      text += decoder.decode(result.value, { stream: true });
    }

    await reader.cancel();

    expect(text).toContain("event: log");
    expect(text).toContain('"foo":"one"');
    expect(text).toContain('"foo":"two"');
  });
});

describe("consumeSseEvents", () => {
  test("parses well-formed SSE frames into JSON payloads", () => {
    const buffer = 'data: {"id":"1","content":"hello"}\n\ndata: {"id":"2","content":"world"}\n\n';
    const result = consumeSseEvents<{ id: string; content: string }>(buffer);

    expect(result.payloads).toHaveLength(2);
    expect(result.payloads[0]!.content).toBe("hello");
    expect(result.payloads[1]!.content).toBe("world");
    expect(result.remainder).toBe("");
  });

  test("retains an incomplete trailing frame as remainder", () => {
    const buffer = 'data: {"id":"1"}\n\ndata: {"id":"2"';
    const result = consumeSseEvents(buffer);

    expect(result.payloads).toHaveLength(1);
    expect(result.remainder).toBe('data: {"id":"2"');
  });

  test("silently drops malformed JSON in tolerant mode", () => {
    const buffer = 'data: {broken json}\n\ndata: {"ok":true}\n\n';
    const result = consumeSseEvents<{ ok: boolean }>(buffer);

    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]!.ok).toBe(true);
  });

  test("throws on malformed JSON in strict mode", () => {
    const buffer = "data: {broken json}\n\n";

    expect(() => consumeSseEvents(buffer, { strict: true })).toThrow(/Malformed SSE JSON payload/);
  });

  test("throws when strict finalization ends with a truncated frame", () => {
    expect(() => flushSseEvents('data: {"id":"1"', { strict: true })).toThrow(
      /Malformed SSE JSON payload/,
    );
  });

  test("skips [DONE] sentinel lines", () => {
    const buffer = 'data: {"id":"1"}\n\ndata: [DONE]\n\n';
    const result = consumeSseEvents(buffer);

    expect(result.payloads).toHaveLength(1);
  });

  test("finalizes a complete trailing SSE frame without requiring a separator", () => {
    const payloads = flushSseEvents<{ id: string }>('data: {"id":"1"}');

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.id).toBe("1");
  });
});
