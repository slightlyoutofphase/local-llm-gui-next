import { describe, expect, test } from "bun:test";
import {
  buildAggregateUploadLimitError,
  MAX_AGGREGATE_UPLOAD_BYTES,
  sumUploadBytes,
  wouldExceedAggregateUploadLimit,
} from "../../lib/attachmentUploadLimits";

describe("attachmentUploadLimits", () => {
  test("sums byte sizes from file-like upload entries", () => {
    expect(sumUploadBytes([{ size: 12 }, { size: 30 }, { size: 58 }])).toBe(100);
  });

  test("treats the aggregate upload cap as inclusive and flags only true overages", () => {
    expect(wouldExceedAggregateUploadLimit(MAX_AGGREGATE_UPLOAD_BYTES - 10, 10)).toBe(false);
    expect(wouldExceedAggregateUploadLimit(MAX_AGGREGATE_UPLOAD_BYTES - 10, 11)).toBe(true);
  });

  test("builds the standard aggregate upload limit message", () => {
    expect(buildAggregateUploadLimitError()).toBe(
      "Adding these files would exceed the 200 MB aggregate limit per message.",
    );
  });
});
