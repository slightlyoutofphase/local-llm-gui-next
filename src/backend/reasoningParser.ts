import type { ThinkingTagSettings } from "../lib/contracts";

/**
 * Incrementally separates reasoning content from final content in a
 * streaming text response, using configurable open/close tag pairs.
 *
 * Handles both generic `<think>...</think>` and Gemma 4-style
 * `<|channel>thought\n...<channel|>` tag formats. Works correctly
 * even when tags are split across multiple SSE deltas.
 */
export class ReasoningParser {
  private buffer = "";
  private insideReasoning = false;
  private readonly openTag: string;
  private readonly closeTag: string;

  /**
   * Creates a new reasoning parser.
   *
   * @param tags The open/close tag pair to match.
   */
  public constructor(tags: ThinkingTagSettings) {
    this.openTag = tags.startString;
    this.closeTag = tags.endString;
  }

  /**
   * Feeds a content delta into the parser and returns any content
   * and reasoning fragments that can be flushed.
   *
   * @param delta The incoming text delta.
   * @returns Parsed content and reasoning fragments.
   */
  public push(delta: string): { content: string; reasoning: string } {
    this.buffer += delta;
    let content = "";
    let reasoning = "";

    while (this.buffer.length > 0) {
      if (this.insideReasoning) {
        const closeIndex = this.buffer.indexOf(this.closeTag);
        const nestedOpenIndex = this.buffer.indexOf(this.openTag);

        if (nestedOpenIndex !== -1 && (closeIndex === -1 || nestedOpenIndex < closeIndex)) {
          reasoning += this.buffer.slice(0, nestedOpenIndex);
          this.buffer = this.buffer.slice(nestedOpenIndex + this.openTag.length);
          continue;
        }

        if (closeIndex === -1) {
          const tagTailLength = Math.max(this.closeTag.length, this.openTag.length);

          if (this.buffer.length > tagTailLength) {
            const safeLength = this.buffer.length - tagTailLength;
            reasoning += this.buffer.slice(0, safeLength);
            this.buffer = this.buffer.slice(safeLength);
          }

          break;
        }

        reasoning += this.buffer.slice(0, closeIndex);
        this.buffer = this.buffer.slice(closeIndex + this.closeTag.length);
        this.insideReasoning = false;
      } else {
        const openIndex = this.buffer.indexOf(this.openTag);

        if (openIndex === -1) {
          if (this.buffer.length > this.openTag.length) {
            const safeLength = this.buffer.length - this.openTag.length;
            content += this.buffer.slice(0, safeLength);
            this.buffer = this.buffer.slice(safeLength);
          }

          break;
        }

        content += this.buffer.slice(0, openIndex);
        this.buffer = this.buffer.slice(openIndex + this.openTag.length);
        this.insideReasoning = true;
      }
    }

    return { content, reasoning };
  }

  /**
   * Flushes any remaining buffered content at the end of a stream.
   *
   * @returns Final content and reasoning fragments.
   */
  public flush(): { content: string; reasoning: string } {
    const remaining = this.buffer;
    const wasInside = this.insideReasoning;
    this.buffer = "";
    this.insideReasoning = false;

    if (wasInside) {
      return { content: "", reasoning: remaining };
    }

    return { content: remaining, reasoning: "" };
  }

  /** Returns whether the parser is currently inside a reasoning block. */
  public isInsideReasoning(): boolean {
    return this.insideReasoning;
  }
}
