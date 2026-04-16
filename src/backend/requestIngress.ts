/** Safely decodes URL-encoded request path fragments. Returns null on malformed escapes. */
export function tryDecodeRequestPathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
