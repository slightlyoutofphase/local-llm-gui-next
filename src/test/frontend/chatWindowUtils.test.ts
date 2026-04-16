import { describe, expect, test } from "bun:test";
import { calculateVirtualChatWindow } from "../../components/Chat/chatWindowUtils";

describe("chatWindowUtils", () => {
  test("computes an overscanned virtual message window and spacer heights", () => {
    const windowState = calculateVirtualChatWindow({
      messageHeights: [180, 220, 260, 200, 240],
      overscanCount: 1,
      scrollTop: 390,
      viewportHeight: 240,
    });

    expect(windowState).toEqual({
      bottomSpacerHeight: 240,
      endIndex: 4,
      startIndex: 0,
      topSpacerHeight: 0,
      totalHeight: 1100,
    });
  });

  test("falls back to an initial overscanned window before viewport measurements exist", () => {
    const windowState = calculateVirtualChatWindow({
      messageHeights: [200, 220, 240],
      overscanCount: 2,
      scrollTop: 0,
      viewportHeight: 0,
    });

    expect(windowState).toEqual({
      bottomSpacerHeight: 0,
      endIndex: 3,
      startIndex: 0,
      topSpacerHeight: 0,
      totalHeight: 660,
    });
  });
});
