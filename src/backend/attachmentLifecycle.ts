import { copyFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { MediaAttachmentRecord } from "../lib/contracts";

/**
 * Sanitises a user-uploaded file name for safe filesystem storage by
 * stripping non-ASCII characters and collapsing runs of hyphens.
 */
export function normalizeAttachmentFileName(fileName: string): string {
  const sanitizedName = fileName
    .trim()
    .replace(/[^\w.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (sanitizedName.length === 0) {
    return "attachment";
  }

  return sanitizedName;
}

export async function simplePromoteAttachments(
  chatId: string,
  messageId: string,
  mediaDir: string,
  pendingAttachments: MediaAttachmentRecord[],
): Promise<MediaAttachmentRecord[]> {
  if (pendingAttachments.length === 0) return [];

  const targetDir = path.join(mediaDir, chatId, messageId);
  await mkdir(targetDir, { recursive: true });

  const finalAttachments: MediaAttachmentRecord[] = [];

  for (const att of pendingAttachments) {
    const finalPath = path.join(
      targetDir,
      `${att.id}-${normalizeAttachmentFileName(att.fileName)}`,
    );
    await rename(att.filePath, finalPath).catch(() => copyFile(att.filePath, finalPath));
    finalAttachments.push({ ...att, filePath: finalPath });
  }
  return finalAttachments;
}
