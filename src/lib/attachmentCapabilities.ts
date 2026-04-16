import type { MediaAttachmentKind, ModelRecord, RuntimeSnapshot } from "../lib/contracts";

export interface AttachmentCapabilities {
  audioEnabled: boolean;
  hint: string;
  imageEnabled: boolean;
  textEnabled: boolean;
}

export function getAttachmentCapabilities(
  model: ModelRecord | null,
  runtime: RuntimeSnapshot | null,
): AttachmentCapabilities {
  if (!model) {
    return {
      audioEnabled: false,
      hint: "Load a model to attach text files, images, or audio.",
      imageEnabled: false,
      textEnabled: false,
    };
  }

  const runtimeReady = runtime?.status === "ready";
  const imageEnabled = runtimeReady && runtime.multimodal && Boolean(model.mmprojPath);
  const audioEnabled = runtimeReady && runtime.audio && Boolean(model.supportsAudio);
  const textEnabled = runtimeReady;

  return {
    audioEnabled,
    hint:
      imageEnabled || audioEnabled
        ? "Drag files into the composer or use the upload buttons."
        : textEnabled
          ? "Text files are enabled. Images require a multimodal runtime, and audio requires a model with audio support."
          : "Start the runtime to attach text files, images, or audio.",
    imageEnabled,
    textEnabled,
  };
}

export function isAttachmentKindSupported(
  kind: MediaAttachmentKind,
  model: ModelRecord | null,
  runtime: RuntimeSnapshot | null,
): boolean {
  const capabilities = getAttachmentCapabilities(model, runtime);

  switch (kind) {
    case "audio":
      return capabilities.audioEnabled;
    case "image":
      return capabilities.imageEnabled;
    case "text":
      return capabilities.textEnabled;
    default:
      return false;
  }
}
