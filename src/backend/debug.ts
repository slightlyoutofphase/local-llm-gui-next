import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DebugLogEntry, DebugLogSettings, DebugLogSource } from "../lib/contracts";
import { JsonSseBroadcaster, type SseEnvelope } from "./sse";

const DEBUG_LOG_DEFAULT_MAX_ENTRIES = 1000;

interface DebugLogServiceOptions {
  persistenceFilePath?: string;
}

interface PersistedDebugLogPayload {
  entries?: unknown;
  nextEntryId?: unknown;
}

/**
 * Aggregates backend and process debug output for SSE delivery to the frontend.
 */
export class DebugLogService {
  private readonly broadcaster: JsonSseBroadcaster<DebugLogEntry>;
  private readonly persistenceFilePath: string | null;

  private enabled = true;
  private nextEntryId = 0;
  private verboseServerLogs = false;

  public constructor(options: DebugLogServiceOptions = {}) {
    this.persistenceFilePath = options.persistenceFilePath ?? null;
    this.broadcaster = new JsonSseBroadcaster<DebugLogEntry>({
      maxEntries: DEBUG_LOG_DEFAULT_MAX_ENTRIES,
      bufferWhenDisconnected: true,
    });

    this.restorePersistedEntries();
  }

  /**
   * Applies the persisted debug-log configuration.
   *
   * @param settings The latest debug settings.
   */
  public applySettings(settings: DebugLogSettings): void {
    this.enabled = settings.enabled;
    this.verboseServerLogs = settings.verboseServerLogs;
    this.broadcaster.setMaxEntries(settings.maxEntries);

    if (!settings.enabled) {
      this.clear();
      return;
    }

    this.persistBufferedEntries();
  }

  /**
   * Creates an SSE response for the debug log stream.
   *
   * @param request The inbound Bun request.
   * @param server The active Bun server instance.
   * @returns A streaming SSE response.
   */
  public subscribe(request: Request, server: Bun.Server<unknown>): Response {
    return this.broadcaster.subscribe(request, server);
  }

  /**
   * Emits a debug entry when collection is enabled.
   *
   * @param source The logical log source.
   * @param message The raw log line.
   */
  public log(source: DebugLogSource, message: string): void {
    if (!this.enabled || message.trim().length === 0) {
      return;
    }

    this.broadcaster.broadcast("log", {
      id: String((this.nextEntryId += 1)),
      timestamp: new Date().toISOString(),
      source,
      message,
    });
    this.persistBufferedEntries();
  }

  /**
   * Emits a backend-owned log entry.
   *
   * @param message The raw log line.
   */
  public serverLog(message: string): void {
    this.log("server:log", message);
  }

  /**
   * Emits a backend-owned log entry only when verbose server logging is enabled.
   *
   * @param message The raw log line.
   */
  public verboseServerLog(message: string): void {
    if (!this.verboseServerLogs) {
      return;
    }

    this.serverLog(message);
  }

  /**
   * Clears the retained in-memory log buffer.
   */
  public clear(): void {
    this.broadcaster.clear();
    this.persistBufferedEntries();
  }

  private persistBufferedEntries(): void {
    if (!this.persistenceFilePath) {
      return;
    }

    const entries = this.broadcaster.getEntries();

    if (entries.length === 0) {
      rmSync(this.persistenceFilePath, { force: true });
      return;
    }

    writeFileSync(
      this.persistenceFilePath,
      JSON.stringify({
        entries,
        nextEntryId: this.nextEntryId,
      }),
      "utf8",
    );
  }

  private restorePersistedEntries(): void {
    if (!this.persistenceFilePath || !existsSync(this.persistenceFilePath)) {
      return;
    }

    try {
      const persistedPayload = JSON.parse(
        readFileSync(this.persistenceFilePath, "utf8"),
      ) as PersistedDebugLogPayload;
      const entries = readPersistedDebugLogEntries(persistedPayload.entries);
      const highestEntryId = entries.reduce((highestId, entry) => {
        const parsedId = Number(entry.payload.id);

        return Number.isInteger(parsedId) ? Math.max(highestId, parsedId) : highestId;
      }, 0);

      this.broadcaster.replaceEntries(entries);
      this.nextEntryId = Math.max(
        readPersistedNextEntryId(persistedPayload.nextEntryId),
        highestEntryId,
      );
    } catch {
      rmSync(this.persistenceFilePath, { force: true });
    }
  }
}

function readPersistedDebugLogEntries(value: unknown): SseEnvelope<DebugLogEntry>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isPersistedDebugLogEnvelope);
}

function readPersistedNextEntryId(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isPersistedDebugLogEnvelope(value: unknown): value is SseEnvelope<DebugLogEntry> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const envelope = value as {
    payload?: unknown;
    timestamp?: unknown;
    type?: unknown;
  };

  if (envelope.type !== "log" || typeof envelope.timestamp !== "string") {
    return false;
  }

  return isPersistedDebugLogEntry(envelope.payload);
}

function isPersistedDebugLogEntry(value: unknown): value is DebugLogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as {
    id?: unknown;
    message?: unknown;
    source?: unknown;
    timestamp?: unknown;
  };

  return (
    typeof entry.id === "string" &&
    typeof entry.message === "string" &&
    typeof entry.timestamp === "string" &&
    (entry.source === "server:log" ||
      entry.source === "process:stdout" ||
      entry.source === "process:stderr")
  );
}
