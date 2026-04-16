import { describe, expect, test } from "bun:test";
import {
  getStructuredOutputValidatorCacheSizeForTest,
  resetStructuredOutputValidatorCacheForTest,
  validateStructuredOutputResult,
} from "../../lib/structuredOutput";

describe("validateStructuredOutputResult", () => {
  test("bounds the compiled schema validator cache with LRU eviction", () => {
    resetStructuredOutputValidatorCacheForTest();

    for (let index = 0; index < 40; index += 1) {
      const propertyName = `field-${String(index)}`;

      validateStructuredOutputResult({
        content: JSON.stringify({ [propertyName]: `value-${String(index)}` }),
        mode: "json_schema",
        schemaText: JSON.stringify({
          additionalProperties: false,
          properties: {
            [propertyName]: {
              type: "string",
            },
          },
          required: [propertyName],
          type: "object",
        }),
        truncated: false,
      });
    }

    expect(getStructuredOutputValidatorCacheSizeForTest()).toBe(32);
    resetStructuredOutputValidatorCacheForTest();
  });

  test("marks Any JSON Object responses valid when the assistant returns an object", () => {
    const result = validateStructuredOutputResult({
      content: '{"answer":"ok"}',
      mode: "json_object",
      truncated: false,
    });

    expect(result).toEqual({
      mode: "json_object",
      parsedValue: { answer: "ok" },
      status: "valid",
    });
  });

  test("marks malformed JSON as a parse failure", () => {
    const result = validateStructuredOutputResult({
      content: '{"answer":',
      mode: "json_object",
      truncated: false,
    });

    expect(result?.status).toBe("parse_error");
  });

  test("marks schema violations as schema failures", () => {
    const result = validateStructuredOutputResult({
      content: '{"answer":42}',
      mode: "json_schema",
      schemaText: JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties: {
          answer: {
            type: "string",
          },
        },
        required: ["answer"],
      }),
      truncated: false,
    });

    expect(result?.status).toBe("schema_error");
    expect(result?.error).toContain("must be string");
  });

  test("marks truncated generations without treating them as valid", () => {
    const result = validateStructuredOutputResult({
      content: '{"answer":"partial"',
      mode: "json_schema",
      schemaText: JSON.stringify({
        type: "object",
      }),
      truncated: true,
    });

    expect(result).toEqual({
      error: "Generation ended before a complete structured output was produced.",
      mode: "json_schema",
      status: "truncated",
    });
  });
});
