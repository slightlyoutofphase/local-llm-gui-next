import type { DebugLogEntry } from "../lib/contracts";

/**
 * Appends a new debug-log entry while ignoring SSE replays for entry IDs the
 * frontend already has buffered.
 */
export function appendDebugLogEntry(
  entries: readonly DebugLogEntry[],
  entry: DebugLogEntry,
  maxEntries: number,
): DebugLogEntry[] {
  if (entries.some((candidate) => candidate.id === entry.id)) {
    return [...entries];
  }

  if (maxEntries <= 1) {
    return [entry];
  }

  if (entries.length >= maxEntries) {
    return [...entries.slice(-(maxEntries - 1)), entry];
  }

  return [...entries, entry];
}
