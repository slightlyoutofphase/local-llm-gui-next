import { describe, expect, test } from "bun:test";
import {
  inferAttachmentMimeTypeFromName,
  resolveAttachmentKindFromFileLike,
  resolveAttachmentMimeTypeFromFileLike,
  TEXT_ATTACHMENT_INPUT_ACCEPT,
} from "../../lib/attachmentTypePolicy";

describe("attachmentTypePolicy", () => {
  test("classifies shared attachment kinds from MIME type or extension", () => {
    expect(resolveAttachmentKindFromFileLike({ name: "diagram", type: "image/png" })).toBe("image");
    expect(resolveAttachmentKindFromFileLike({ name: "VOICE.MP3", type: "" })).toBe("audio");
    expect(resolveAttachmentKindFromFileLike({ name: "settings", type: "application/json" })).toBe(
      "text",
    );
    expect(
      resolveAttachmentKindFromFileLike({ name: "payload.exe", type: "application/octet-stream" }),
    ).toBeNull();
  });

  test("builds the shared text picker accept list with structured text MIME types", () => {
    expect(TEXT_ATTACHMENT_INPUT_ACCEPT).toContain(".json");
    expect(TEXT_ATTACHMENT_INPUT_ACCEPT).toContain("text/*");
    expect(TEXT_ATTACHMENT_INPUT_ACCEPT).toContain("application/json");
    expect(TEXT_ATTACHMENT_INPUT_ACCEPT).toContain("application/xml");
  });

  test("infers fallback MIME types from the shared extension policy", () => {
    expect(inferAttachmentMimeTypeFromName("notes.md", "text")).toBe("text/markdown");
    expect(inferAttachmentMimeTypeFromName("voice.m4a", "audio")).toBe("audio/mp4");
    expect(inferAttachmentMimeTypeFromName("diagram.bmp", "image")).toBe("image/bmp");
    expect(inferAttachmentMimeTypeFromName("plainfile", "text")).toBe("text/plain");
  });

  test("normalizes generic MIME types to the shared fallback for the resolved kind", () => {
    expect(
      resolveAttachmentMimeTypeFromFileLike(
        { name: "settings.json", type: "application/octet-stream" },
        "text",
      ),
    ).toBe("application/json");
    expect(
      resolveAttachmentMimeTypeFromFileLike({ name: "voice.wav", type: "audio/wav" }, "audio"),
    ).toBe("audio/wav");
  });
});
