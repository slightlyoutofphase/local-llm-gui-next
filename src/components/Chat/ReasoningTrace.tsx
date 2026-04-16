"use client";

import type { ReactElement } from "react";

export interface ReasoningTraceProps {
  reasoning: string;
  isStreaming: boolean;
}

/**
 * Renders a collapsible reasoning trace above the assistant response.
 *
 * @param props Component props.
 * @param props.reasoning The reasoning text to render.
 * @param props.isStreaming Indicates whether reasoning is still streaming.
 * @returns The rendered reasoning trace.
 */
export function ReasoningTrace({ reasoning, isStreaming }: ReasoningTraceProps): ReactElement {
  return (
    <details className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
        Reasoning trace{isStreaming ? " (streaming)" : ""}
      </summary>
      <pre className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
        {reasoning}
      </pre>
    </details>
  );
}
