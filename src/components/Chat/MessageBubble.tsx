"use client";

import Image from "next/image";
import { memo, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Check, Copy, GitBranch, Pencil, RefreshCcw, X } from "lucide-react";
import type { ChatMessageRecord, StructuredOutputMetadata } from "@/lib/contracts";
import { getMediaAttachmentUrl } from "@/lib/api";
import { MarkdownRenderer } from "@/components/Chat/MarkdownRenderer";
import { ReasoningTrace } from "@/components/Chat/ReasoningTrace";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export interface MessageBubbleProps {
  actionsDisabled?: boolean;
  message: ChatMessageRecord;
  isStreaming: boolean;
  onBranch?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onRegenerate?: (messageId: string) => void;
}

/**
 * Renders a single chat message bubble.
 *
 * Settled messages (not streaming) are memoized by message identity to
 * avoid expensive markdown / syntax-highlight / Mermaid re-renders
 * while other parts of the transcript update.
 *
 * @param props Component props.
 * @param props.message The message record to render.
 * @param props.isStreaming Indicates whether the message is currently streaming.
 * @returns The rendered message bubble.
 */
export const MessageBubble = memo(function MessageBubble({
  actionsDisabled = false,
  message,
  isStreaming,
  onBranch,
  onEdit,
  onRegenerate,
}: MessageBubbleProps): ReactElement {
  const reasoning = useMemo(() => {
    if (message.reasoningContent) {
      return message.reasoningContent;
    }

    const metadataReasoning = message.metadata["reasoningContent"];

    return typeof metadataReasoning === "string" ? metadataReasoning : "";
  }, [message.metadata, message.reasoningContent]);

  const isUserMessage = message.role === "user";
  const [draftContent, setDraftContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const structuredOutput = getStructuredOutputMetadata(message);
  const toolStatus =
    typeof message.metadata["toolStatus"] === "string" ? message.metadata["toolStatus"] : "";
  const bubbleClassName = isUserMessage
    ? "ml-auto bg-primary text-primary-foreground"
    : "mr-auto bg-card text-card-foreground";

  const canBranch = !isStreaming && typeof onBranch === "function";
  const canEdit = isUserMessage && !isStreaming && typeof onEdit === "function";
  const canRegenerate =
    message.role === "assistant" && !isStreaming && typeof onRegenerate === "function";

  return (
    <div className={`flex w-full ${isUserMessage ? "justify-end" : "justify-start"}`}>
      <Card
        className={`w-full max-w-3xl rounded-[1.5rem] border-border/70 p-4 shadow-sm ${bubbleClassName}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] opacity-70">
              {message.role}
            </p>
            <p className="mt-1 text-xs opacity-70">
              {new Date(message.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canEdit && !isEditing ? (
              <Button
                disabled={actionsDisabled}
                onClick={() => {
                  setDraftContent(message.content);
                  setIsEditing(true);
                }}
                size="sm"
                variant={isUserMessage ? "secondary" : "ghost"}>
                <Pencil className="mr-2 size-4" />
                Edit
              </Button>
            ) : null}
            {canRegenerate ? (
              <Button
                disabled={actionsDisabled}
                onClick={() => {
                  onRegenerate?.(message.id);
                }}
                size="sm"
                variant={isUserMessage ? "secondary" : "ghost"}>
                <RefreshCcw className="mr-2 size-4" />
                Regenerate
              </Button>
            ) : null}
            {canBranch ? (
              <Button
                disabled={actionsDisabled}
                onClick={() => {
                  onBranch?.(message.id);
                }}
                size="sm"
                variant={isUserMessage ? "secondary" : "ghost"}>
                <GitBranch className="mr-2 size-4" />
                Branch
              </Button>
            ) : null}
            <Button
              className="rounded-full"
              disabled={actionsDisabled}
              onClick={() => {
                void navigator.clipboard.writeText(message.content);
              }}
              size="icon"
              variant={isUserMessage ? "secondary" : "ghost"}>
              <Copy className="size-4" />
            </Button>
          </div>
        </div>

        {reasoning ? <ReasoningTrace isStreaming={isStreaming} reasoning={reasoning} /> : null}

        {!reasoning && isStreaming && toolStatus ? (
          <div className="mt-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
            {toolStatus}
          </div>
        ) : null}

        {structuredOutput ? (
          <div className="mt-3 rounded-2xl border border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground/80">
              Structured output: {formatStructuredOutputStatus(structuredOutput.status)}
            </p>
            <p className="mt-1">
              mode: {structuredOutput.mode}
              {structuredOutput.error ? ` · ${structuredOutput.error}` : ""}
            </p>
          </div>
        ) : null}

        {message.mediaAttachments.length > 0 ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {message.mediaAttachments.map((attachment) => (
              <div
                className="rounded-2xl border border-border/70 bg-background/70 p-3"
                key={attachment.id}>
                <p className="mb-2 truncate text-xs font-medium text-muted-foreground">
                  {attachment.fileName}
                </p>
                {attachment.kind === "image" ? (
                  <Image
                    alt={attachment.fileName}
                    className="max-h-80 w-full rounded-xl border border-border/60 object-cover"
                    src={getMediaAttachmentUrl(message.chatId, attachment.id)}
                    unoptimized
                    width={960}
                    height={640}
                  />
                ) : attachment.kind === "audio" ? (
                  <audio
                    className="w-full"
                    controls
                    src={getMediaAttachmentUrl(message.chatId, attachment.id)}
                  />
                ) : attachment.kind === "text" ? (
                  <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
                    This text file is read from disk and injected into the prompt when the request
                    is sent or replayed.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {isEditing ? (
          <div className="mt-3 space-y-3">
            <Textarea
              className="min-h-32 bg-background/80 text-foreground"
              onChange={(event) => {
                setDraftContent(event.target.value);
              }}
              value={draftContent}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                disabled={actionsDisabled}
                onClick={() => {
                  setIsEditing(false);
                }}
                size="sm"
                variant="outline">
                <X className="mr-2 size-4" />
                Cancel
              </Button>
              <Button
                disabled={actionsDisabled || draftContent.trim().length === 0}
                onClick={() => {
                  const nextContent = draftContent.trim();

                  if (nextContent === message.content.trim()) {
                    setIsEditing(false);
                    return;
                  }

                  onEdit?.(message.id, nextContent);
                  setIsEditing(false);
                }}
                size="sm"
                variant="default">
                <Check className="mr-2 size-4" />
                Save and Regenerate
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            {isStreaming ? (
              <div className="message-markdown whitespace-pre-wrap">{message.content || "..."}</div>
            ) : (
              <MarkdownRenderer content={message.content || ""} />
            )}
          </div>
        )}

        {!isUserMessage &&
        !isStreaming &&
        typeof message.metadata["tokensPerSecond"] === "number" ? (
          <p className="mt-2 text-right text-[0.65rem] tracking-wide text-muted-foreground/70">
            {(message.metadata["tokensPerSecond"] as number).toFixed(1)} tok/s
          </p>
        ) : null}
      </Card>
    </div>
  );
});

/**
 * Extracts validated structured-output metadata from a message's metadata map.
 *
 * @param message The chat message record to inspect.
 * @returns The structured-output metadata, or `null` if absent or invalid.
 */
function getStructuredOutputMetadata(message: ChatMessageRecord): StructuredOutputMetadata | null {
  const structuredOutputValue = message.metadata["structuredOutput"];

  if (!structuredOutputValue || typeof structuredOutputValue !== "object") {
    return null;
  }

  const candidate = structuredOutputValue as Partial<StructuredOutputMetadata>;

  if (
    (candidate.mode === "json_object" || candidate.mode === "json_schema") &&
    (candidate.status === "valid" ||
      candidate.status === "parse_error" ||
      candidate.status === "schema_error" ||
      candidate.status === "truncated")
  ) {
    return candidate as StructuredOutputMetadata;
  }

  return null;
}

/**
 * Converts a structured-output validation status enum into a display label.
 *
 * @param status The validation status.
 * @returns A human-readable status label.
 */
function formatStructuredOutputStatus(status: StructuredOutputMetadata["status"]): string {
  switch (status) {
    case "valid":
      return "valid";
    case "parse_error":
      return "invalid JSON";
    case "schema_error":
      return "schema mismatch";
    case "truncated":
      return "truncated";
  }
}
