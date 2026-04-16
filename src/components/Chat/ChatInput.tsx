"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactElement } from "react";
import {
  FileText,
  ImagePlus,
  LoaderCircle,
  Music4,
  Paperclip,
  SendHorizontal,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AUDIO_ATTACHMENT_INPUT_ACCEPT,
  IMAGE_ATTACHMENT_INPUT_ACCEPT,
  resolveAttachmentKindFromFileLike,
  TEXT_ATTACHMENT_INPUT_ACCEPT,
} from "@/lib/attachmentTypePolicy";
import {
  buildAggregateUploadLimitError,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  formatAttachmentUploadLimit,
  sumUploadBytes,
  wouldExceedAggregateUploadLimit,
} from "@/lib/attachmentUploadLimits";
import type { PendingAttachment } from "@/store/chatStore";

export interface ChatInputProps {
  value: string;
  attachmentHint: string;
  canAttachAudio: boolean;
  canAttachImages: boolean;
  canAttachText: boolean;
  disabled: boolean;
  isSending: boolean;
  pendingAttachments: PendingAttachment[];
  onAddFiles: (files: File[]) => void;
  onChange: (value: string) => void;
  onError: (message: string | null) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onSend: () => void;
  onStop: () => void;
}

/**
 * Renders the chat composer and send or stop controls.
 *
 * @param props Component props.
 * @param props.value The current composer value.
 * @param props.disabled Indicates whether sending is currently disabled.
 * @param props.isSending Indicates whether a response is actively streaming.
 * @param props.onChange Called when the textarea value changes.
 * @param props.onSend Called when the user submits the composer.
 * @param props.onStop Called when the user stops the active generation.
 * @returns The rendered chat composer.
 */
export function ChatInput({
  attachmentHint,
  canAttachAudio,
  canAttachImages,
  canAttachText,
  value,
  disabled,
  isSending,
  pendingAttachments,
  onAddFiles,
  onChange,
  onError,
  onRemoveAttachment,
  onSend,
  onStop,
}: ChatInputProps): ReactElement {
  const [dragActive, setDragActive] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (isSending) {
        onStop();
      } else {
        onSend();
      }
    }
  };

  const handleFileSelection = (files: FileList | File[]): void => {
    const selectedFiles = Array.from(files);
    const acceptedFiles: File[] = [];
    let skippedForCapabilities = false;
    const oversizedFiles: Array<{ kind: "audio" | "image"; name: string }> = [];

    for (const file of selectedFiles) {
      const attachmentKind = resolveAttachmentKindFromFileLike(file);

      if (attachmentKind === "image") {
        if (!canAttachImages) {
          skippedForCapabilities = true;
          continue;
        }

        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
          oversizedFiles.push({ kind: attachmentKind, name: file.name });
          continue;
        }

        acceptedFiles.push(file);
        continue;
      }

      if (attachmentKind === "audio") {
        if (!canAttachAudio) {
          skippedForCapabilities = true;
          continue;
        }

        if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
          oversizedFiles.push({ kind: attachmentKind, name: file.name });
          continue;
        }

        acceptedFiles.push(file);
        continue;
      }

      if (attachmentKind === "text") {
        if (!canAttachText) {
          skippedForCapabilities = true;
          continue;
        }

        acceptedFiles.push(file);
        continue;
      }

      skippedForCapabilities = true;
    }

    if (acceptedFiles.length === 0) {
      onError(
        buildAttachmentSelectionError(
          attachmentHint,
          oversizedFiles,
          skippedForCapabilities,
          false,
        ),
      );
      return;
    }

    const aggregateLimitExceeded = wouldExceedAggregateUploadLimit(
      sumUploadBytes(pendingAttachments),
      sumUploadBytes(acceptedFiles),
    );

    if (aggregateLimitExceeded) {
      onError(
        buildAttachmentSelectionError(attachmentHint, oversizedFiles, skippedForCapabilities, true),
      );
      return;
    }

    if (oversizedFiles.length > 0 || skippedForCapabilities) {
      onError(
        buildAttachmentSelectionError(
          attachmentHint,
          oversizedFiles,
          skippedForCapabilities,
          false,
        ),
      );
    } else {
      onError(null);
    }

    onAddFiles(acceptedFiles);
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) {
      handleFileSelection(event.target.files);
    }

    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);

    if (disabled || isSending) {
      return;
    }

    handleFileSelection(event.dataTransfer.files);
  };

  return (
    <div
      className={`rounded-[1.5rem] border bg-card/90 p-4 shadow-sm transition-colors ${
        dragActive ? "border-primary/70 ring-2 ring-primary/20" : "border-border/70"
      }`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();

        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }

        setDragActive(false);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={handleDrop}>
      <input
        accept={IMAGE_ATTACHMENT_INPUT_ACCEPT}
        className="hidden"
        multiple
        onChange={handleFileInputChange}
        ref={imageInputRef}
        type="file"
      />
      <input
        accept={AUDIO_ATTACHMENT_INPUT_ACCEPT}
        className="hidden"
        multiple
        onChange={handleFileInputChange}
        ref={audioInputRef}
        type="file"
      />
      <input
        accept={TEXT_ATTACHMENT_INPUT_ACCEPT}
        className="hidden"
        multiple
        onChange={handleFileInputChange}
        ref={textInputRef}
        type="file"
      />

      {pendingAttachments.length > 0 ? (
        <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {pendingAttachments.map((attachment) => (
            <div
              className="rounded-[1.25rem] border border-border/70 bg-background/75 p-3"
              key={attachment.id}>
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {attachment.fileName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {attachment.kind} · {formatAttachmentSize(attachment.size)}
                  </p>
                </div>
                <Button
                  onClick={() => {
                    onRemoveAttachment(attachment.id);
                  }}
                  size="icon"
                  type="button"
                  variant="ghost">
                  <X className="size-4" />
                </Button>
              </div>

              <PendingAttachmentPreview attachment={attachment} />
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || isSending || !canAttachText}
              onClick={() => {
                textInputRef.current?.click();
              }}
              type="button"
              variant="outline">
              <FileText className="size-4" />
              Add text file
            </Button>
            <Button
              disabled={disabled || isSending || !canAttachImages}
              onClick={() => {
                imageInputRef.current?.click();
              }}
              type="button"
              variant="outline">
              <ImagePlus className="size-4" />
              Add image
            </Button>
            <Button
              disabled={disabled || isSending || !canAttachAudio}
              onClick={() => {
                audioInputRef.current?.click();
              }}
              type="button"
              variant="outline">
              <Music4 className="size-4" />
              Add audio
            </Button>
            <div className="inline-flex items-center gap-2 rounded-full border border-dashed border-border/80 px-3 py-2 text-xs text-muted-foreground">
              <Paperclip className="size-3" />
              {attachmentHint}
            </div>
          </div>

          <Textarea
            className="min-h-28 resize-none rounded-[1.25rem] border-border/80 bg-background/80 text-sm leading-7"
            disabled={disabled && !isSending}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Send a prompt. Press Enter to submit and Shift+Enter for a new line."
            value={value}
          />
        </div>
        <div className="flex flex-col gap-3">
          <Button
            className="h-12 rounded-full px-5"
            disabled={
              !isSending &&
              (disabled || (value.trim().length === 0 && pendingAttachments.length === 0))
            }
            onClick={() => {
              if (isSending) {
                onStop();
              } else {
                onSend();
              }
            }}>
            {isSending ? <Square className="size-4" /> : <SendHorizontal className="size-4" />}
            {isSending ? "Stop" : "Send"}
          </Button>
          <div className="rounded-full border border-border/70 bg-background/80 px-4 py-2 text-xs text-muted-foreground">
            {isSending ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="size-3 animate-spin" />
                Streaming response
              </span>
            ) : (
              "Messages are persisted locally through the Bun backend."
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildAttachmentSelectionError(
  attachmentHint: string,
  oversizedFiles: Array<{ kind: "audio" | "image"; name: string }>,
  skippedForCapabilities: boolean,
  aggregateLimitExceeded: boolean,
): string {
  if (aggregateLimitExceeded) {
    return buildAggregateUploadLimitError();
  }

  if (oversizedFiles.length === 0) {
    return skippedForCapabilities ? attachmentHint : "No supported files were selected for upload.";
  }

  const limitDescriptions = Array.from(
    new Set(
      oversizedFiles.map((file) =>
        file.kind === "image"
          ? `images ${formatAttachmentUploadLimit(MAX_IMAGE_UPLOAD_BYTES)}`
          : `audio ${formatAttachmentUploadLimit(MAX_AUDIO_UPLOAD_BYTES)}`,
      ),
    ),
  ).join(" and ");
  const oversizedNames = oversizedFiles.map((file) => file.name).join(", ");

  return skippedForCapabilities
    ? `Some dropped files were skipped because the active model cannot accept them. Oversized files: ${oversizedNames}. Limits: ${limitDescriptions}.`
    : `Oversized files were skipped: ${oversizedNames}. Limits: ${limitDescriptions}.`;
}

function PendingAttachmentPreview(props: { attachment: PendingAttachment }): ReactElement {
  const { attachment } = props;
  const previewUrl = attachment.previewUrl ?? null;

  if (attachment.kind === "image") {
    return previewUrl ? (
      <Image
        alt={attachment.fileName}
        className="h-36 w-full rounded-xl border border-border/60 object-cover"
        src={previewUrl}
        unoptimized
        width={576}
        height={144}
      />
    ) : (
      <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
        Preparing image preview...
      </div>
    );
  }

  if (attachment.kind === "audio") {
    return previewUrl ? (
      <audio className="w-full" controls src={previewUrl} />
    ) : (
      <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
        Preparing audio preview...
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
      The backend will inject this file text directly into the next prompt.
    </div>
  );
}

/**
 * Formats a byte size into a short human-readable string (B, KB, or MB).
 *
 * @param byteSize The file size in bytes.
 * @returns The formatted size string.
 */
function formatAttachmentSize(byteSize: number): string {
  if (byteSize >= 1024 * 1024) {
    return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (byteSize >= 1024) {
    return `${Math.round(byteSize / 1024)} KB`;
  }

  return `${byteSize} B`;
}
