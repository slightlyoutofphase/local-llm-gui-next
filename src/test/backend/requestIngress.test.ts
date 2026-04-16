import { describe, expect, test } from "bun:test";
import { tryDecodeRequestPathComponent } from "../../backend/requestIngress";

describe("requestIngress", () => {
  test("decodes valid request path fragments", () => {
    expect(tryDecodeRequestPathComponent("chat%2Fsegment%20name")).toBe("chat/segment name");
  });

  test("returns null for malformed percent-encoding instead of throwing", () => {
    expect(tryDecodeRequestPathComponent("%E0%A4%A")).toBeNull();
  });
});
