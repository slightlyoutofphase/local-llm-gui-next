/** Options controlling SSE parse behaviour. */
export interface ConsumeSseOptions {
  /**
   * When `true`, malformed JSON data frames throw instead of being
   * silently dropped.  Use strict mode on assistant-generation streams
   * where a corrupt frame means lost content; leave tolerant for
   * metrics-only paths that can afford to drop occasional events.
   */
  strict?: boolean;
}

/**
 * Splits an SSE text buffer into parsed JSON payloads plus any trailing
 * incomplete frame text that should be retained for the next chunk.
 *
 * @param buffer - Accumulated SSE text that may contain zero or more complete frames.
 * @param options - Optional parsing behaviour overrides.
 */
export function consumeSseEvents<T = unknown>(
  buffer: string,
  options?: ConsumeSseOptions,
): {
  payloads: T[];
  remainder: string;
} {
  const strict = options?.strict === true;
  const segments = buffer.split(/\r?\n\r?\n/);
  const remainder = segments.pop() ?? "";
  const payloads: T[] = [];

  for (const segment of segments) {
    const dataLines = segment
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0 && line !== "[DONE]");

    if (dataLines.length === 0) {
      continue;
    }

    try {
      payloads.push(JSON.parse(dataLines.join("\n")) as T);
    } catch {
      if (strict) {
        const snippet = dataLines.join("\n").slice(0, 200);
        throw new Error(`Malformed SSE JSON payload from llama-server: ${snippet}`);
      }
      // Tolerant mode: silently drop malformed frames.
    }
  }

  return { payloads, remainder };
}

/**
 * Finalises an SSE buffer at end-of-stream, throwing when the trailing
 * data contains an incomplete frame.
 *
 * @param buffer - Remaining SSE text at stream completion.
 * @param options - Optional parsing behaviour overrides.
 * @returns All completed JSON payloads.
 */
export function flushSseEvents<T = unknown>(buffer: string, options?: ConsumeSseOptions): T[] {
  if (buffer.trim().length === 0) {
    return [];
  }

  const finalizedEvents = consumeSseEvents<T>(`${buffer}\n\n`, options);

  if (finalizedEvents.remainder.trim().length > 0) {
    throw new Error("The llama-server stream ended with a truncated SSE payload.");
  }

  return finalizedEvents.payloads;
}
