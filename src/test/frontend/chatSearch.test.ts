import { describe, expect, test } from "bun:test";
import {
  buildChatSearchFtsQuery,
  extractChatSearchTerms,
  hasMeaningfulChatSearchTerms,
  normalizeChatSearchQuery,
} from "../../lib/chatSearch";

describe("chatSearch helpers", () => {
  test("normalizes and extracts safe terms from mixed operator input", () => {
    expect(normalizeChatSearchQuery("  nebula OR [  ")).toBe("nebula OR [");
    expect(extractChatSearchTerms("nebula OR [")).toEqual(["nebula"]);
    expect(buildChatSearchFtsQuery("nebula OR [")).toBe('"nebula"*');
  });

  test("drops punctuation-only and single-letter punctuation artifacts", () => {
    expect(extractChatSearchTerms("++[[--")).toEqual([]);
    expect(extractChatSearchTerms("C++")).toEqual([]);
    expect(hasMeaningfulChatSearchTerms("++[[--")).toBe(false);
    expect(buildChatSearchFtsQuery("C++")).toBeNull();
  });

  test("deduplicates repeated terms while preserving punctuation-split numeric fragments", () => {
    expect(extractChatSearchTerms("Qwen3.5-0.8B qwen3.5-0.8B")).toEqual(["Qwen3", "5", "0", "8B"]);
    expect(buildChatSearchFtsQuery("Qwen3.5-0.8B qwen3.5-0.8B")).toBe('"Qwen3"* "5"* "0"* "8B"*');
  });
});
