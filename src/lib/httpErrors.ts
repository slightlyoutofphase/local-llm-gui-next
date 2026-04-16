export async function readErrorResponseMessage(response: Response): Promise<string> {
  const responseText = await response.text();
  const trimmedResponseText = responseText.trim();

  if (trimmedResponseText.length === 0) {
    return `Request failed with status ${response.status}.`;
  }

  try {
    const parsedPayload = JSON.parse(trimmedResponseText) as unknown;

    if (parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload)) {
      const errorValue = (parsedPayload as Record<string, unknown>)["error"];

      if (typeof errorValue === "string" && errorValue.trim().length > 0) {
        return errorValue;
      }

      const messageValue = (parsedPayload as Record<string, unknown>)["message"];

      if (typeof messageValue === "string" && messageValue.trim().length > 0) {
        return messageValue;
      }
    }
  } catch {
    // Fall back to the raw response text when the payload is not JSON.
  }

  return trimmedResponseText;
}
