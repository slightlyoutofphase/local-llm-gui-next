import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { DebugLogEntry } from "../../lib/contracts";
import { DebugLogService } from "../../backend/debug";
import type { SseEnvelope } from "../../backend/sse";
import { createBackendTestScratchDir, removeBackendTestScratchDir } from "./testScratch";

interface DebugLogServiceProbe {
  broadcaster: {
    broadcast: (type: string, payload: DebugLogEntry) => SseEnvelope<DebugLogEntry>;
    getEntries(): unknown[];
    subscribers: Map<string, { enqueue: (chunk: Uint8Array) => void }>;
  };
}

/** Wraps a DebugLogService with a spy on its internal broadcaster. */
function createSpiedService(options: { persistenceFilePath?: string } = {}): {
  service: DebugLogService;
  emitted: SseEnvelope<DebugLogEntry>[];
} {
  const service = new DebugLogService(options);
  const emitted: SseEnvelope<DebugLogEntry>[] = [];
  const broadcaster = (service as unknown as DebugLogServiceProbe).broadcaster;
  const originalBroadcast = broadcaster.broadcast.bind(broadcaster);

  broadcaster.broadcast = (type: string, payload: DebugLogEntry): SseEnvelope<DebugLogEntry> => {
    const envelope = originalBroadcast(type, payload);
    emitted.push(envelope);
    return envelope;
  };

  return { service, emitted };
}

describe("DebugLogService", () => {
  test("log emits entries with correct source labels", () => {
    const { service, emitted } = createSpiedService();

    service.log("server:log", "first");
    service.log("process:stdout", "second");
    service.log("process:stderr", "third");

    expect(emitted).toHaveLength(3);
    expect(emitted[0]!.payload.source).toBe("server:log");
    expect(emitted[0]!.payload.message).toBe("first");
    expect(emitted[1]!.payload.source).toBe("process:stdout");
    expect(emitted[2]!.payload.source).toBe("process:stderr");
  });

  test("serverLog emits with source server:log", () => {
    const { service, emitted } = createSpiedService();

    service.serverLog("backend message");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload.source).toBe("server:log");
    expect(emitted[0]!.payload.message).toBe("backend message");
  });

  test("log ignores empty or whitespace-only messages", () => {
    const { service, emitted } = createSpiedService();

    service.log("server:log", "");
    service.log("server:log", "   ");
    service.log("server:log", "\n");

    expect(emitted).toHaveLength(0);
  });

  test("applySettings disables logging when enabled is false", () => {
    const { service, emitted } = createSpiedService();

    service.log("server:log", "before");

    expect(emitted).toHaveLength(1);

    service.applySettings({
      enabled: false,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    });
    service.log("server:log", "after");

    expect(emitted).toHaveLength(1);
  });

  test("applySettings clears the internal buffer when disabled", () => {
    const { service } = createSpiedService();

    service.log("server:log", "entry-1");
    service.log("server:log", "entry-2");
    service.applySettings({
      enabled: false,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    });

    const broadcaster = (service as unknown as DebugLogServiceProbe).broadcaster;

    expect(broadcaster.getEntries()).toHaveLength(0);
  });

  test("retains disconnected log entries for later replay", () => {
    const { service } = createSpiedService();
    const broadcaster = (service as unknown as DebugLogServiceProbe).broadcaster;

    service.log("server:log", "disconnected-entry");

    expect(broadcaster.getEntries()).toHaveLength(1);
  });

  test("re-enabling after disable allows new entries", () => {
    const { service, emitted } = createSpiedService();

    service.applySettings({
      enabled: false,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    });
    service.log("server:log", "silent");

    expect(emitted).toHaveLength(0);

    service.applySettings({
      enabled: true,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    });
    service.log("server:log", "audible");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload.message).toBe("audible");
  });

  test("verboseServerLog only emits when verbose server logging is enabled", () => {
    const { service, emitted } = createSpiedService();

    service.applySettings({
      enabled: true,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    });
    service.verboseServerLog("hidden");

    expect(emitted).toHaveLength(0);

    service.applySettings({
      enabled: true,
      maxEntries: 1000,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: true,
    });
    service.verboseServerLog("visible");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload.message).toBe("visible");
  });

  test("each entry gets a unique id and valid timestamp", () => {
    const { service, emitted } = createSpiedService();

    service.log("server:log", "one");
    service.log("server:log", "two");

    const ids = emitted.map((e) => e.payload.id);

    expect(new Set(ids).size).toBe(2);

    for (const entry of emitted) {
      expect(typeof entry.payload.timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(entry.payload.timestamp))).toBe(false);
    }
  });

  test("clear flushes the internal buffer", () => {
    const { service } = createSpiedService();

    service.log("server:log", "a");
    service.log("server:log", "b");
    service.clear();

    const broadcaster = (service as unknown as DebugLogServiceProbe).broadcaster;

    expect(broadcaster.getEntries()).toHaveLength(0);
  });

  test("applySettings enforces the configured maxEntries cap", () => {
    const { service } = createSpiedService();
    const broadcaster = (service as unknown as DebugLogServiceProbe).broadcaster;

    broadcaster.subscribers.set("test-subscriber", {
      enqueue: () => {},
    });

    service.applySettings({
      enabled: true,
      maxEntries: 2,
      showProcessStderr: true,
      showProcessStdout: true,
      showServerLogs: true,
      verboseServerLogs: false,
    });
    service.log("server:log", "first");
    service.log("server:log", "second");
    service.log("server:log", "third");

    const retainedEntries = broadcaster.getEntries() as Array<SseEnvelope<DebugLogEntry>>;

    expect(retainedEntries).toHaveLength(2);
    expect(retainedEntries.map((entry) => entry.payload.message)).toEqual(["second", "third"]);
  });

  test("restores persisted debug entries across service restarts", async () => {
    const rootDir = await createBackendTestScratchDir("local-llm-gui-debug-service");
    const persistenceFilePath = path.join(rootDir, "debug-log.json");

    try {
      const { service } = createSpiedService({ persistenceFilePath });

      service.log("server:log", "persisted-entry");

      expect(existsSync(persistenceFilePath)).toBe(true);

      const restoredService = new DebugLogService({ persistenceFilePath });
      const restoredBroadcaster = (restoredService as unknown as DebugLogServiceProbe).broadcaster;
      const restoredEntries = restoredBroadcaster.getEntries() as Array<SseEnvelope<DebugLogEntry>>;

      expect(restoredEntries).toHaveLength(1);
      expect(restoredEntries[0]?.payload.message).toBe("persisted-entry");

      restoredService.clear();

      expect(existsSync(persistenceFilePath)).toBe(false);
    } finally {
      await removeBackendTestScratchDir(rootDir);
    }
  });
});
