import { describe, expect, test } from "bun:test";
import { readErrorResponseMessage } from "../../lib/httpErrors";

describe("readErrorResponseMessage", () => {
  test("extracts the error field from a JSON error response", async () => {
    const response = Response.json(
      {
        error: "Chat not found.",
      },
      { status: 404 },
    );

    await expect(readErrorResponseMessage(response)).resolves.toBe("Chat not found.");
  });

  test("falls back to the message field when error is absent", async () => {
    const response = Response.json(
      {
        message: "Backend unavailable.",
      },
      { status: 503 },
    );

    await expect(readErrorResponseMessage(response)).resolves.toBe("Backend unavailable.");
  });

  test("returns plain text responses unchanged", async () => {
    const response = new Response("Plain text failure", { status: 500 });

    await expect(readErrorResponseMessage(response)).resolves.toBe("Plain text failure");
  });

  test("uses a status fallback when the response body is empty", async () => {
    const response = new Response(null, { status: 409 });

    await expect(readErrorResponseMessage(response)).resolves.toBe(
      "Request failed with status 409.",
    );
  });
});
