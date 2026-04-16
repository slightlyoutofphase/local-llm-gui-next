import { describe, expect, test } from "bun:test";
import type { ChatMessageRecord } from "../../lib/contracts";
import {
  buildBranchedChatTitle,
  buildAutoNamePrompt,
  normalizeGeneratedChatTitle,
  shouldAutoNameFromMessages,
} from "../../backend/autoNaming";

describe("auto naming helpers", () => {
  test("builds a completion prompt from the first user and assistant messages", () => {
    const messages = createMessages([
      { content: "Summarize the attached GPU tuning advice.", role: "user" },
      { content: "Use fewer GPU layers and a lower context.", role: "assistant" },
    ]);

    const prompt = buildAutoNamePrompt(messages);

    expect(prompt).toContain("First user message: Summarize the attached GPU tuning advice.");
    expect(prompt).toContain("First assistant reply: Use fewer GPU layers and a lower context.");
    expect(prompt?.endsWith("Title:")).toBe(true);
  });

  test("normalizes raw completion output into a clean title", () => {
    expect(normalizeGeneratedChatTitle('Title: "GPU Layer Tuning."\nMore text')).toBe(
      "GPU Layer Tuning",
    );
  });

  test("only auto-names after the first visible user and assistant turn pair", () => {
    const firstTurnMessages = createMessages([
      { content: "Hello", role: "user" },
      { content: "Hi there", role: "assistant" },
    ]);
    const laterTurnMessages = createMessages([
      { content: "Hello", role: "user" },
      { content: "Hi there", role: "assistant" },
      { content: "Tell me more", role: "user" },
    ]);

    expect(shouldAutoNameFromMessages(firstTurnMessages)).toBe(true);
    expect(shouldAutoNameFromMessages(laterTurnMessages)).toBe(false);
  });

  test("builds deduplicated branch titles without suffix accumulation", () => {
    expect(
      buildBranchedChatTitle("GPU tuning (branch)", [
        "GPU tuning (branch)",
        "GPU tuning (branch 2)",
      ]),
    ).toBe("GPU tuning (branch 3)");

    const longTitle = buildBranchedChatTitle(
      "A very long title that should keep the source meaning while trimming repeated suffix noise from branch creation",
      [],
    );

    expect(longTitle.endsWith("(branch)")).toBe(true);
    expect(longTitle.length).toBeLessThanOrEqual(80);
  });
});

function createMessages(
  inputs: Array<{ content: string; role: ChatMessageRecord["role"] }>,
): ChatMessageRecord[] {
  return inputs.map((input, index) => ({
    chatId: "chat-1",
    content: input.content,
    createdAt: new Date(2026, 3, 12, 10, index).toISOString(),
    id: `message-${index}`,
    mediaAttachments: [],
    metadata: {},
    role: input.role,
    sequence: index,
  }));
}
