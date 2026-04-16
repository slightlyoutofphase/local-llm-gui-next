import type { MediaAttachmentKind } from "./contracts";

/** Maximum accepted upload size for a single audio attachment. */
export const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Maximum accepted upload size for a single image attachment. */
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Maximum accepted upload size for a single text attachment. */
export const MAX_TEXT_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Maximum accepted aggregate upload size for a single request batch. */
export const MAX_AGGREGATE_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Returns the upload ceiling for the provided attachment kind. */
export function getAttachmentUploadLimit(kind: MediaAttachmentKind): number {
  switch (kind) {
    case "audio":
      return MAX_AUDIO_UPLOAD_BYTES;
    case "image":
      return MAX_IMAGE_UPLOAD_BYTES;
    case "text":
      return MAX_TEXT_UPLOAD_BYTES;
  }
}

/** Formats a byte limit into the MB string used in upload validation errors. */
export function formatAttachmentUploadLimit(byteCount: number): string {
  return `${Math.floor(byteCount / (1024 * 1024))} MB`;
}

/** Sums byte sizes from selected files or pending attachments. */
export function sumUploadBytes(uploadables: Iterable<{ size: number }>): number {
  let totalBytes = 0;

  for (const uploadable of uploadables) {
    totalBytes += uploadable.size;
  }

  return totalBytes;
}

/** Returns whether adding more uploads would exceed the aggregate request cap. */
export function wouldExceedAggregateUploadLimit(
  currentBytes: number,
  additionalBytes: number,
  maxBytes = MAX_AGGREGATE_UPLOAD_BYTES,
): boolean {
  return currentBytes + additionalBytes > maxBytes;
}

/** Builds the standard aggregate upload-limit validation message. */
export function buildAggregateUploadLimitError(maxBytes = MAX_AGGREGATE_UPLOAD_BYTES): string {
  return `Adding these files would exceed the ${formatAttachmentUploadLimit(maxBytes)} aggregate limit per message.`;
}
