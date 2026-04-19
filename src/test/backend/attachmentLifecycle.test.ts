import { describe, expect, test } from "bun:test";
import { normalizeAttachmentFileName } from "../../backend/attachmentLifecycle";

describe("attachmentLifecycle", () => {
  describe("normalizeAttachmentFileName", () => {
    test("removes disallowed characters", () => {
      expect(normalizeAttachmentFileName("my file (#1).txt")).toBe("my-file-1-.txt");
    });

    test("collapses multiple dashes", () => {
      expect(normalizeAttachmentFileName("a---b.txt")).toBe("a-b.txt");
    });
  });
});
