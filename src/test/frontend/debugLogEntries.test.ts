import { describe, expect, test } from "bun:test";
import type { DebugLogEntry } from "../../lib/contracts";
import { appendDebugLogEntry } from "../../lib/debugLogEntries";

const ENTRY_ONE: DebugLogEntry = {
  id: "1",
  message: "first",
  source: "server:log",
  timestamp: "2026-04-14T19:30:26.000Z",
};

const ENTRY_TWO: DebugLogEntry = {
  id: "2",
  message: "second",
  source: "process:stderr",
  timestamp: "2026-04-14T19:30:27.000Z",
};

describe("appendDebugLogEntry", () => {
  test("ignores replayed entries that reuse an existing id", () => {
    const initialEntries = [ENTRY_ONE, ENTRY_TWO];

    const mergedEntries = appendDebugLogEntry(
      initialEntries,
      {
        ...ENTRY_ONE,
      },
      1000,
    );

    expect(mergedEntries).toEqual(initialEntries);
  });

  test("applies the configured max entry cap only for new ids", () => {
    const mergedEntries = appendDebugLogEntry(
      [ENTRY_ONE, ENTRY_TWO],
      {
        id: "3",
        message: "third",
        source: "process:stdout",
        timestamp: "2026-04-14T19:30:28.000Z",
      },
      2,
    );

    expect(mergedEntries.map((entry) => entry.id)).toEqual(["2", "3"]);
  });
});
