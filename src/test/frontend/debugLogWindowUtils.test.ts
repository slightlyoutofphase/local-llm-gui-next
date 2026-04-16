import { describe, expect, test } from "bun:test";
import type { AppConfig, DebugLogEntry } from "../../lib/contracts";
import {
  calculateVirtualDebugLogWindow,
  filterVisibleDebugLogEntries,
} from "../../components/Debug/debugLogWindowUtils";

const BASE_CONFIG: AppConfig = {
  autoNamingEnabled: true,
  customBinaries: {},
  debug: {
    enabled: true,
    maxEntries: 1000,
    showProcessStderr: true,
    showProcessStdout: true,
    showServerLogs: true,
    verboseServerLogs: false,
  },
  llamaServerPath: "C:/llama-server.exe",
  modelsPath: "C:/models",
  theme: "system",
  toolEnabledStates: {},
};

const DEBUG_ENTRIES: DebugLogEntry[] = [
  {
    id: "stdout",
    message: "stdout message",
    source: "process:stdout",
    timestamp: "2026-04-12T10:00:00.000Z",
  },
  {
    id: "stderr",
    message: "stderr message",
    source: "process:stderr",
    timestamp: "2026-04-12T10:00:01.000Z",
  },
  {
    id: "server",
    message: "server message",
    source: "server",
    timestamp: "2026-04-12T10:00:02.000Z",
  },
];

describe("debugLogWindowUtils", () => {
  test("filters visible entries using the active debug settings", () => {
    const filteredEntries = filterVisibleDebugLogEntries(
      {
        ...BASE_CONFIG,
        debug: {
          ...BASE_CONFIG.debug,
          showProcessStdout: false,
          showServerLogs: false,
        },
      },
      DEBUG_ENTRIES,
    );

    expect(filteredEntries.map((entry) => entry.id)).toEqual(["stderr"]);
  });

  test("returns no visible entries when debug logging is disabled", () => {
    const filteredEntries = filterVisibleDebugLogEntries(
      {
        ...BASE_CONFIG,
        debug: {
          ...BASE_CONFIG.debug,
          enabled: false,
        },
      },
      DEBUG_ENTRIES,
    );

    expect(filteredEntries).toEqual([]);
  });

  test("computes an overscanned virtual window and spacer heights", () => {
    const windowState = calculateVirtualDebugLogWindow({
      entryHeights: [80, 100, 120, 90, 110],
      overscanCount: 1,
      scrollTop: 190,
      viewportHeight: 160,
    });

    expect(windowState).toEqual({
      bottomSpacerHeight: 0,
      endIndex: 5,
      startIndex: 1,
      topSpacerHeight: 80,
      totalHeight: 500,
    });
  });
});
