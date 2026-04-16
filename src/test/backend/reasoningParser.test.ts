import { describe, expect, test } from "bun:test";
import { ReasoningParser } from "../../backend/reasoningParser";

describe("ReasoningParser", () => {
  describe("generic <think>...</think> tags", () => {
    const tags = { startString: "<think>", endString: "</think>" };

    test("separates a complete reasoning block from final content", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("<think>I need to think about this</think>The answer is 42.");
      const flushed = parser.flush();

      expect(result.reasoning).toBe("I need to think about this");
      expect(result.content + flushed.content).toBe("The answer is 42.");
    });

    test("handles reasoning at start with no final content", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("<think>Just thinking</think>");
      const flushed = parser.flush();

      expect(result.reasoning).toBe("Just thinking");
      expect(result.content + flushed.content).toBe("");
    });

    test("handles content with no reasoning block", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("Hello world");
      const flushed = parser.flush();

      expect(result.reasoning + flushed.reasoning).toBe("");
      expect(result.content + flushed.content).toBe("Hello world");
    });

    test("handles tags split across multiple deltas", () => {
      const parser = new ReasoningParser(tags);
      let reasoning = "";
      let content = "";

      for (const delta of ["<thi", "nk>reason", "ing text</th", "ink>final content"]) {
        const result = parser.push(delta);
        reasoning += result.reasoning;
        content += result.content;
      }

      const flushed = parser.flush();
      reasoning += flushed.reasoning;
      content += flushed.content;

      expect(reasoning).toBe("reasoning text");
      expect(content).toBe("final content");
    });

    test("handles open tag split one character at a time", () => {
      const parser = new ReasoningParser(tags);
      let reasoning = "";
      let content = "";

      for (const char of "<think>hello</think>world") {
        const result = parser.push(char);
        reasoning += result.reasoning;
        content += result.content;
      }

      const flushed = parser.flush();
      reasoning += flushed.reasoning;
      content += flushed.content;

      expect(reasoning).toBe("hello");
      expect(content).toBe("world");
    });

    test("preserves partial reasoning when flush is called mid-block", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("<think>partial reasoning with no close tag");
      const flushed = parser.flush();

      expect(parser.isInsideReasoning()).toBe(false);
      expect(result.reasoning + flushed.reasoning).toBe("partial reasoning with no close tag");
    });

    test("multiple reasoning blocks separated by content", () => {
      const parser = new ReasoningParser(tags);

      const r1 = parser.push("<think>first thought</think>middle<think>second thought</think>end");
      const flushed = parser.flush();

      expect(r1.reasoning).toBe("first thoughtsecond thought");
      expect(r1.content + flushed.content).toBe("middleend");
    });

    test("empty reasoning block", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("<think></think>content");
      const flushed = parser.flush();

      expect(result.reasoning).toBe("");
      expect(result.content + flushed.content).toBe("content");
    });

    test("ignores nested open tags while already inside reasoning", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("<think>outer<think>inner</think>final");
      const flushed = parser.flush();

      expect(result.reasoning).toBe("outerinner");
      expect(result.content + flushed.content).toBe("final");
    });

    test("isInsideReasoning tracks state correctly", () => {
      const parser = new ReasoningParser(tags);

      expect(parser.isInsideReasoning()).toBe(false);

      parser.push("<think>");

      expect(parser.isInsideReasoning()).toBe(true);

      parser.push("thinking");

      expect(parser.isInsideReasoning()).toBe(true);

      parser.push("</think>");

      expect(parser.isInsideReasoning()).toBe(false);
    });
  });

  describe("Gemma 4 <|channel>thought...<channel|> tags", () => {
    const tags = { startString: "<|channel>thought", endString: "<channel|>" };

    test("separates Gemma 4 reasoning from content", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push(
        "<|channel>thought\nLet me consider this carefully\n<channel|>Here is the answer.",
      );
      const flushed = parser.flush();

      expect(result.reasoning).toBe("\nLet me consider this carefully\n");
      expect(result.content + flushed.content).toBe("Here is the answer.");
    });

    test("handles Gemma 4 tags split across deltas", () => {
      const parser = new ReasoningParser(tags);
      let reasoning = "";
      let content = "";

      for (const delta of ["<|chan", "nel>thou", "ght\nreasoning\n<chan", "nel|>answer"]) {
        const result = parser.push(delta);
        reasoning += result.reasoning;
        content += result.content;
      }

      const flushed = parser.flush();
      reasoning += flushed.reasoning;
      content += flushed.content;

      expect(reasoning).toBe("\nreasoning\n");
      expect(content).toBe("answer");
    });

    test("handles unterminated Gemma 4 reasoning block on flush", () => {
      const parser = new ReasoningParser(tags);

      const result = parser.push("<|channel>thought\nstill thinking...");
      const flushed = parser.flush();

      expect(result.reasoning + flushed.reasoning).toBe("\nstill thinking...");
      expect(result.content + flushed.content).toBe("");
    });
  });

  describe("abort mid-reasoning", () => {
    const tags = { startString: "<think>", endString: "</think>" };

    test("partial reasoning is preserved on abort (flush with no close tag)", () => {
      const parser = new ReasoningParser(tags);
      let reasoning = "";

      const r1 = parser.push("<think>This is a very long reasoning block that was");
      reasoning += r1.reasoning;
      const r2 = parser.push(" interrupted by an abort signal before the close");
      reasoning += r2.reasoning;

      expect(parser.isInsideReasoning()).toBe(true);

      const flushed = parser.flush();
      reasoning += flushed.reasoning;

      expect(reasoning).toContain("interrupted by an abort signal");
      expect(flushed.content).toBe("");
    });

    test("content before reasoning block is preserved on abort", () => {
      const parser = new ReasoningParser(tags);
      let content = "";
      let reasoning = "";

      const r1 = parser.push("preamble<think>mid-reason");
      content += r1.content;
      reasoning += r1.reasoning;

      expect(parser.isInsideReasoning()).toBe(true);

      const flushed = parser.flush();
      content += flushed.content;
      reasoning += flushed.reasoning;

      expect(content).toBe("preamble");
      expect(reasoning).toBe("mid-reason");
    });
  });
});
