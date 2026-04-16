import type { MediaAttachmentKind } from "./contracts";

const AUDIO_ATTACHMENT_EXTENSIONS = [".wav", ".mp3", ".ogg", ".flac", ".m4a"];
const IMAGE_ATTACHMENT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
const TEXT_ATTACHMENT_EXTENSIONS = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
];
const TEXT_ATTACHMENT_MIME_TYPES = [
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
];
const GENERIC_ATTACHMENT_MIME_TYPES = new Set<string>(["application/octet-stream"]);

const AUDIO_ATTACHMENT_EXTENSION_SET = new Set<string>(AUDIO_ATTACHMENT_EXTENSIONS);
const IMAGE_ATTACHMENT_EXTENSION_SET = new Set<string>(IMAGE_ATTACHMENT_EXTENSIONS);
const TEXT_ATTACHMENT_EXTENSION_SET = new Set<string>(TEXT_ATTACHMENT_EXTENSIONS);
const TEXT_ATTACHMENT_MIME_TYPE_SET = new Set<string>(TEXT_ATTACHMENT_MIME_TYPES);

const AUDIO_FALLBACK_MIME_BY_EXTENSION = new Map<string, string>([
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
]);
const IMAGE_FALLBACK_MIME_BY_EXTENSION = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
]);
const TEXT_FALLBACK_MIME_BY_EXTENSION = new Map<string, string>([
  [".csv", "text/csv"],
  [".md", "text/markdown"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

export const AUDIO_ATTACHMENT_INPUT_ACCEPT = "audio/*";
export const IMAGE_ATTACHMENT_INPUT_ACCEPT = "image/*";
export const TEXT_ATTACHMENT_INPUT_ACCEPT = [
  ...TEXT_ATTACHMENT_EXTENSIONS,
  "text/*",
  ...TEXT_ATTACHMENT_MIME_TYPES,
].join(",");

export function resolveAttachmentKindFromFileLike(file: {
  name: string;
  type?: string | null;
}): MediaAttachmentKind | null {
  const mimeType = normalizeMimeType(file.type);
  const extension = getLowercaseFileExtension(file.name);

  if (mimeType.startsWith("image/") || IMAGE_ATTACHMENT_EXTENSION_SET.has(extension)) {
    return "image";
  }

  if (mimeType.startsWith("audio/") || AUDIO_ATTACHMENT_EXTENSION_SET.has(extension)) {
    return "audio";
  }

  if (
    mimeType.startsWith("text/") ||
    TEXT_ATTACHMENT_MIME_TYPE_SET.has(mimeType) ||
    TEXT_ATTACHMENT_EXTENSION_SET.has(extension)
  ) {
    return "text";
  }

  return null;
}

export function inferAttachmentMimeTypeFromName(
  fileName: string,
  kind: MediaAttachmentKind,
): string {
  const extension = getLowercaseFileExtension(fileName);

  if (kind === "image") {
    return IMAGE_FALLBACK_MIME_BY_EXTENSION.get(extension) ?? "image/png";
  }

  if (kind === "text") {
    return TEXT_FALLBACK_MIME_BY_EXTENSION.get(extension) ?? "text/plain";
  }

  return AUDIO_FALLBACK_MIME_BY_EXTENSION.get(extension) ?? "audio/wav";
}

export function resolveAttachmentMimeTypeFromFileLike(
  file: {
    name: string;
    type?: string | null;
  },
  kind: MediaAttachmentKind,
): string {
  const mimeType = normalizeMimeType(file.type);

  if (isAttachmentMimeTypeCompatible(mimeType, kind)) {
    return mimeType;
  }

  return inferAttachmentMimeTypeFromName(file.name, kind);
}

function getLowercaseFileExtension(fileName: string): string {
  const normalizedFileName = fileName.trim().toLowerCase();
  const lastDotIndex = normalizedFileName.lastIndexOf(".");

  return lastDotIndex <= 0 ? "" : normalizedFileName.slice(lastDotIndex);
}

function normalizeMimeType(mimeType: string | null | undefined): string {
  return mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isAttachmentMimeTypeCompatible(mimeType: string, kind: MediaAttachmentKind): boolean {
  if (mimeType.length === 0 || GENERIC_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return false;
  }

  if (kind === "image") {
    return mimeType.startsWith("image/");
  }

  if (kind === "audio") {
    return mimeType.startsWith("audio/");
  }

  return mimeType.startsWith("text/") || TEXT_ATTACHMENT_MIME_TYPE_SET.has(mimeType);
}
