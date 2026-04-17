"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Check, Copy } from "lucide-react";
import hljs from "highlight.js";
import mermaid from "mermaid";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { Button } from "@/components/ui/button";

let mermaidInitialized = false;
const MAX_AUTO_HIGHLIGHT_CHARACTERS = 4_000;
const MAX_AUTO_HIGHLIGHT_LINES = 120;

export interface MarkdownRendererProps {
  content: string;
}

/**
 * Renders markdown message content with math, syntax highlighting, and Mermaid diagrams.
 *
 * @param props Component props.
 * @param props.content The markdown source content.
 * @returns The rendered markdown content.
 */
export function MarkdownRenderer({ content }: MarkdownRendererProps): ReactElement {
  const components = useMemo<Components>(
    () => ({
      a: ({ children, href, ...props }) => (
        <a href={href} rel="noreferrer" target="_blank" {...props}>
          {children}
        </a>
      ),
      code: ({ children, className, ...props }) => {
        const language = className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
        const rawCode = String(children);
        const code = rawCode.replace(/\n$/, "");
        const isInline = !className && !rawCode.includes("\n");

        if (isInline) {
          return (
            <code
              className="rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[0.85em]"
              {...props}>
              {children}
            </code>
          );
        }

        if (language === "mermaid") {
          return <MermaidBlock code={code} />;
        }

        return <CodeBlock code={code} language={language ?? ""} />;
      },
      table: ({ children, ...props }) => (
        <div className="my-4 overflow-x-auto">
          <table {...props}>{children}</table>
        </div>
      ),
    }),
    [],
  );

  return (
    <div className="message-markdown">
      <ReactMarkdown
        components={components}
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkMath]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Renders a syntax-highlighted code block with a copy button. */
function CodeBlock({ code, language }: { code: string; language: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const highlightedCode = useMemo(
    () => renderHighlightedCodeBlock(code, language),
    [code, language],
  );

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, 1500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copied]);

  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-border/70 bg-zinc-950/95 text-zinc-50 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/5 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
          {language || "code"}
        </p>
        <Button
          className="h-7 rounded-full px-3 text-xs text-zinc-100 hover:bg-white/10 hover:text-white"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
          }}
          size="sm"
          type="button"
          variant="ghost">
          {copied ? <Check className="mr-2 size-3.5" /> : <Copy className="mr-2 size-3.5" />}
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-7">
        <code dangerouslySetInnerHTML={{ __html: sanitizeHighlightedCode(highlightedCode) }} />
      </pre>
    </div>
  );
}

export function renderHighlightedCodeBlock(code: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language }).value;
  }

  if (shouldAutoDetectCodeLanguage(code)) {
    return hljs.highlightAuto(code).value;
  }

  return escapeHtml(code);
}

function sanitizeHighlightedCode(highlightedCode: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(highlightedCode, "text/html");
  const sanitizedFragment = document.createDocumentFragment();

  const appendSafeNode = (node: ChildNode, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();
    const allowedTags = new Set(["span", "br", "code", "div", "pre"]);

    if (!allowedTags.has(tagName)) {
      element.childNodes.forEach((child) => appendSafeNode(child, parent));
      return;
    }

    const safeElement = document.createElement(tagName);

    if (element.className) {
      safeElement.setAttribute("class", element.className);
    }

    element.childNodes.forEach((child) => appendSafeNode(child, safeElement));
    parent.appendChild(safeElement);
  };

  document.body.childNodes.forEach((node) => appendSafeNode(node, sanitizedFragment));
  const container = document.createElement("div");
  container.appendChild(sanitizedFragment);
  return container.innerHTML;
}

export function shouldAutoDetectCodeLanguage(code: string): boolean {
  if (code.length > MAX_AUTO_HIGHLIGHT_CHARACTERS) {
    return false;
  }

  let lineCount = 1;

  for (const character of code) {
    if (character === "\n") {
      lineCount += 1;

      if (lineCount > MAX_AUTO_HIGHLIGHT_LINES) {
        return false;
      }
    }
  }

  return true;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sanitizeMermaidSvg(svg: string): string {
  const parser = new DOMParser();
  const document = parser.parseFromString(svg, "image/svg+xml");
  const fragment = document.createDocumentFragment();

  const allowedTags = new Set([
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "defs",
    "linearGradient",
    "radialGradient",
    "stop",
    "mask",
    "filter",
    "use",
    "clipPath",
    "metadata",
    "title",
    "desc",
  ]);

  const allowedAttributes = new Set([
    "class",
    "cx",
    "cy",
    "d",
    "dx",
    "dy",
    "fill",
    "fill-opacity",
    "font-family",
    "font-size",
    "height",
    "id",
    "mask",
    "offset",
    "opacity",
    "pathLength",
    "points",
    "rx",
    "ry",
    "stroke",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-width",
    "style",
    "transform",
    "viewBox",
    "width",
    "x",
    "x1",
    "x2",
    "xlink:href",
    "y",
    "y1",
    "y2",
  ]);

  const sanitizeNode = (node: ChildNode, parent: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as Element;
    const tagName = element.tagName;

    if (!allowedTags.has(tagName)) {
      element.childNodes.forEach((child) => sanitizeNode(child, parent));
      return;
    }

    const safeElement = document.createElementNS("http://www.w3.org/2000/svg", tagName);

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (!allowedAttributes.has(name)) {
        continue;
      }

      if (name.startsWith("on")) {
        continue;
      }

      safeElement.setAttribute(attr.name, value);
    }

    element.childNodes.forEach((child) => sanitizeNode(child, safeElement));
    parent.appendChild(safeElement);
  };

  document.documentElement.childNodes.forEach((child) => sanitizeNode(child, fragment));

  const container = document.createElement("div");
  container.appendChild(fragment);
  return container.innerHTML;
}

/** Renders a Mermaid diagram from a fenced code block, falling back to raw source on error. */
function MermaidBlock({ code }: { code: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const renderId = useId().replace(/:/g, "-");

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram(): Promise<void> {
      try {
        if (!mermaidInitialized) {
          mermaid.initialize({
            securityLevel: "strict",
            startOnLoad: false,
            theme: "neutral",
          });
          mermaidInitialized = true;
        }

        const { svg } = await mermaid.render(`mermaid-${renderId}`, code);

        if (!cancelled) {
          setError(null);
          setRenderedSvg(svg);
        }
      } catch (renderError) {
        if (!cancelled) {
          setRenderedSvg(null);
          setError(
            renderError instanceof Error
              ? renderError.message
              : "Failed to render Mermaid diagram.",
          );
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, renderId]);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, 1500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copied]);

  return (
    <div className="my-4 overflow-hidden rounded-2xl border border-border/70 bg-background/70 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
          Mermaid
        </p>
        <Button
          className="h-7 rounded-full px-3 text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
          }}
          size="sm"
          type="button"
          variant="ghost">
          {copied ? <Check className="mr-2 size-3.5" /> : <Copy className="mr-2 size-3.5" />}
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      {renderedSvg ? (
        <div
          className="mermaid-diagram-viewer overflow-x-auto p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: sanitizeMermaidSvg(renderedSvg) }}
        />
      ) : error ? (
        <div className="space-y-3 p-4">
          <p className="text-sm text-destructive">{error}</p>
          <pre className="overflow-x-auto rounded-2xl bg-zinc-950/95 p-4 text-sm leading-7 text-zinc-50">
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">Rendering diagram...</div>
      )}
    </div>
  );
}
