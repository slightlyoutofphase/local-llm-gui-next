import { describe, expect, test } from "bun:test";
import type { ModelRecord, RuntimeSnapshot } from "../../lib/contracts";
import {
  getAttachmentCapabilities,
  isAttachmentKindSupported,
} from "../../lib/attachmentCapabilities";

function createRuntimeSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    activeModelId: "model-1",
    activeModelPath: "D:/models/model.gguf",
    audio: false,
    contextTokens: null,
    lastError: null,
    llamaServerBaseUrl: "http://127.0.0.1:4001",
    loadProgress: 100,
    multimodal: false,
    status: "ready",
    tokensPerSecond: null,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

function createModelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    architecture: "qwen3",
    defaultSampling: null,
    fileName: "model.gguf",
    fileSizeBytes: 1024,
    id: "publisher/model/model.gguf",
    modelName: "Model",
    modelPath: "D:/models/model.gguf",
    publisher: "publisher",
    supportsAudio: false,
    ...overrides,
  };
}

describe("getAttachmentCapabilities", () => {
  test("enables audio uploads for ready audio-capable models without requiring multimodal image support", () => {
    const capabilities = getAttachmentCapabilities(
      createModelRecord({ supportsAudio: true }),
      createRuntimeSnapshot({ audio: true, multimodal: false }),
    );

    expect(capabilities).toMatchObject({
      audioEnabled: true,
      imageEnabled: false,
      textEnabled: true,
    });
    expect(capabilities.hint).toBe("Drag files into the composer or use the upload buttons.");
    expect(
      isAttachmentKindSupported(
        "audio",
        createModelRecord({ supportsAudio: true }),
        createRuntimeSnapshot({ audio: true, multimodal: false }),
      ),
    ).toBe(true);
  });

  test("keeps image uploads disabled until multimodal runtime support and an mmproj file are both present", () => {
    const capabilities = getAttachmentCapabilities(
      createModelRecord({ mmprojPath: "D:/models/model.mmproj.gguf" }),
      createRuntimeSnapshot({ multimodal: false }),
    );

    expect(capabilities).toMatchObject({
      audioEnabled: false,
      imageEnabled: false,
      textEnabled: true,
    });
    expect(capabilities.hint).toContain("Images require a multimodal runtime");
    expect(
      isAttachmentKindSupported(
        "image",
        createModelRecord({ mmprojPath: "D:/models/model.mmproj.gguf" }),
        createRuntimeSnapshot({ multimodal: false }),
      ),
    ).toBe(false);
  });

  test("disables every attachment type until a model is selected and the runtime is ready", () => {
    expect(getAttachmentCapabilities(null, createRuntimeSnapshot())).toEqual({
      audioEnabled: false,
      hint: "Load a model to attach text files, images, or audio.",
      imageEnabled: false,
      textEnabled: false,
    });

    const capabilities = getAttachmentCapabilities(
      createModelRecord(),
      createRuntimeSnapshot({ status: "idle" }),
    );

    expect(capabilities).toEqual({
      audioEnabled: false,
      hint: "Start the runtime to attach text files, images, or audio.",
      imageEnabled: false,
      textEnabled: false,
    });
  });
});
