import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MarkdownRenderer,
  renderHighlightedCodeBlock,
  shouldAutoDetectCodeLanguage,
} from "../../components/Chat/MarkdownRenderer";

test("shouldAutoDetectCodeLanguage skips auto-detection for large unlabeled blocks", () => {
  expect(shouldAutoDetectCodeLanguage("const value = 1;\n".repeat(20))).toBe(true);
  expect(shouldAutoDetectCodeLanguage("x".repeat(4_001))).toBe(false);
});

test("renderHighlightedCodeBlock falls back to escaped plaintext for large unlabeled blocks", () => {
  const code = "<script>alert('xss')</script>\n".repeat(200);

  expect(renderHighlightedCodeBlock(code, "")).toContain("&lt;script&gt;");
  expect(renderHighlightedCodeBlock(code, "")).not.toContain("hljs");
});

test("MarkdownRenderer renders inline code markup in the component output", () => {
  const markup = renderToStaticMarkup(
    <MarkdownRenderer content={"Use `inline-code` in this sentence."} />,
  );

  expect(markup).toContain("inline-code");
  expect(markup).toContain("<code");
  expect(markup).toContain("message-markdown");
});
