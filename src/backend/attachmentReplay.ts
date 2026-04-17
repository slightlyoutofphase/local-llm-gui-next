import { createReadStream } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { MediaAttachmentRecord } from "../lib/contracts";

const ATTACHMENT_REPLAY_DESCRIPTOR_SUFFIX = ".replay.json";
const ATTACHMENT_REPLAY_DESCRIPTOR_VERSION = 1;

type BinaryAttachmentKind = Extract<MediaAttachmentRecord["kind"], "audio" | "image">;

interface BinaryAttachmentReplayDescriptorBase {
  readonly attachmentId: string;
  readonly byteSize: number;
  readonly kind: BinaryAttachmentKind;
  readonly mimeType: string;
  readonly version: 1;
}

export interface PersistedImageAttachmentReplayDescriptor extends BinaryAttachmentReplayDescriptorBase {
  readonly dataUrl: string;
  readonly kind: "image";
}

export interface PersistedAudioAttachmentReplayDescriptor extends BinaryAttachmentReplayDescriptorBase {
  readonly base64Data: string;
  readonly format: string;
  readonly kind: "audio";
}

export type PersistedBinaryAttachmentReplayDescriptor =
  | PersistedAudioAttachmentReplayDescriptor
  | PersistedImageAttachmentReplayDescriptor;

export function getBinaryAttachmentReplayDescriptorPath(filePath: string): string {
  return `${filePath}${ATTACHMENT_REPLAY_DESCRIPTOR_SUFFIX}`;
}

export function isBinaryReplayableAttachment(
  attachment: MediaAttachmentRecord,
): attachment is MediaAttachmentRecord & { kind: BinaryAttachmentKind } {
  return attachment.kind === "audio" || attachment.kind === "image";
}

export function buildBinaryAttachmentReplayDescriptor(
  attachment: MediaAttachmentRecord,
  fileBuffer: Buffer,
): PersistedBinaryAttachmentReplayDescriptor {
  if (!isBinaryReplayableAttachment(attachment)) {
    throw new Error(`Attachment ${attachment.id} is not replayable binary media.`);
  }

  const baseDescriptor: BinaryAttachmentReplayDescriptorBase = {
    attachmentId: attachment.id,
    byteSize: fileBuffer.byteLength,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    version: ATTACHMENT_REPLAY_DESCRIPTOR_VERSION,
  };
  const base64Data = fileBuffer.toString("base64");

  if (attachment.kind === "image") {
    return {
      ...baseDescriptor,
      dataUrl: `data:${attachment.mimeType};base64,${base64Data}`,
      kind: "image",
    };
  }

  return {
    ...baseDescriptor,
    base64Data,
    format: deriveReplayAudioFormat(attachment.mimeType),
    kind: "audio",
  };
}

export async function buildBinaryAttachmentReplayDescriptorFromFile(
  attachment: MediaAttachmentRecord,
  filePath: string,
): Promise<PersistedBinaryAttachmentReplayDescriptor> {
  if (!isBinaryReplayableAttachment(attachment)) {
    throw new Error(`Attachment ${attachment.id} is not replayable binary media.`);
  }

  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const encodedChunks: string[] = [];
  let byteSize = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += buffer.byteLength;
    encodedChunks.push(buffer.toString("base64"));
  }

  const base64Data = encodedChunks.join("");
  const baseDescriptor: BinaryAttachmentReplayDescriptorBase = {
    attachmentId: attachment.id,
    byteSize,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    version: ATTACHMENT_REPLAY_DESCRIPTOR_VERSION,
  };

  if (attachment.kind === "image") {
    return {
      ...baseDescriptor,
      dataUrl: `data:${attachment.mimeType};base64,${base64Data}`,
      kind: "image",
    };
  }

  return {
    ...baseDescriptor,
    base64Data,
    format: deriveReplayAudioFormat(attachment.mimeType),
    kind: "audio",
  };
}

export async function loadBinaryAttachmentReplayDescriptor(
  attachment: MediaAttachmentRecord,
): Promise<PersistedBinaryAttachmentReplayDescriptor | null> {
  if (!isBinaryReplayableAttachment(attachment)) {
    return null;
  }

  let descriptorText: string;

  try {
    descriptorText = await readFile(
      getBinaryAttachmentReplayDescriptorPath(attachment.filePath),
      "utf8",
    );
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }

    return null;
  }

  let parsedDescriptor: unknown;

  try {
    parsedDescriptor = JSON.parse(descriptorText) as unknown;
  } catch {
    return null;
  }

  if (!isObjectRecord(parsedDescriptor)) {
    return null;
  }

  if (
    parsedDescriptor["version"] !== ATTACHMENT_REPLAY_DESCRIPTOR_VERSION ||
    parsedDescriptor["attachmentId"] !== attachment.id ||
    parsedDescriptor["kind"] !== attachment.kind ||
    parsedDescriptor["mimeType"] !== attachment.mimeType ||
    typeof parsedDescriptor["byteSize"] !== "number" ||
    !Number.isFinite(parsedDescriptor["byteSize"]) ||
    parsedDescriptor["byteSize"] <= 0 ||
    parsedDescriptor["byteSize"] !== attachment.byteSize
  ) {
    return null;
  }

  if (
    parsedDescriptor["kind"] === "image" &&
    typeof parsedDescriptor["dataUrl"] === "string" &&
    parsedDescriptor["dataUrl"].startsWith(`data:${attachment.mimeType};base64,`)
  ) {
    return {
      attachmentId: parsedDescriptor["attachmentId"],
      byteSize: parsedDescriptor["byteSize"],
      dataUrl: parsedDescriptor["dataUrl"],
      kind: "image",
      mimeType: parsedDescriptor["mimeType"],
      version: ATTACHMENT_REPLAY_DESCRIPTOR_VERSION,
    };
  }

  if (
    parsedDescriptor["kind"] === "audio" &&
    typeof parsedDescriptor["base64Data"] === "string" &&
    typeof parsedDescriptor["format"] === "string"
  ) {
    return {
      attachmentId: parsedDescriptor["attachmentId"],
      base64Data: parsedDescriptor["base64Data"],
      byteSize: parsedDescriptor["byteSize"],
      format: parsedDescriptor["format"],
      kind: "audio",
      mimeType: parsedDescriptor["mimeType"],
      version: ATTACHMENT_REPLAY_DESCRIPTOR_VERSION,
    };
  }

  return null;
}

export async function persistBinaryAttachmentReplayDescriptor(
  attachment: MediaAttachmentRecord,
  descriptor: PersistedBinaryAttachmentReplayDescriptor,
): Promise<void> {
  if (!isBinaryReplayableAttachment(attachment)) {
    return;
  }

  await writeFile(
    getBinaryAttachmentReplayDescriptorPath(attachment.filePath),
    JSON.stringify(descriptor),
    "utf8",
  );
}

export function createContentPartFromBinaryAttachmentReplayDescriptor(
  descriptor: PersistedBinaryAttachmentReplayDescriptor,
): Record<string, unknown> {
  if (descriptor.kind === "image") {
    return {
      image_url: {
        url: descriptor.dataUrl,
      },
      type: "image_url",
    };
  }

  return {
    input_audio: {
      data: descriptor.base64Data,
      format: descriptor.format,
    },
    type: "input_audio",
  };
}

export async function deleteAttachmentArtifacts(attachment: MediaAttachmentRecord): Promise<void> {
  await rm(attachment.filePath, { force: true });

  if (isBinaryReplayableAttachment(attachment)) {
    await rm(getBinaryAttachmentReplayDescriptorPath(attachment.filePath), { force: true });
  }
}

function deriveReplayAudioFormat(mimeType: string): string {
  const normalizedMimeType = mimeType.toLowerCase();

  if (normalizedMimeType.includes("wav")) {
    return "wav";
  }

  if (normalizedMimeType.includes("mpeg") || normalizedMimeType.includes("mp3")) {
    return "mp3";
  }

  if (normalizedMimeType.includes("ogg")) {
    return "ogg";
  }

  if (normalizedMimeType.includes("flac")) {
    return "flac";
  }

  return "wav";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileMissingError(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error["code"] === "ENOENT"
  );
}
