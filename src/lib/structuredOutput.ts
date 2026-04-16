import Ajv from "ajv";
import type { StructuredOutputMetadata, StructuredOutputMode } from "../lib/contracts";

const ajv = new Ajv({ allErrors: true, strict: false });
const MAX_VALIDATOR_CACHE_ENTRIES = 32;
const validatorCache = new Map<string, ReturnType<Ajv["compile"]>>();

/**
 * Validates a completed assistant response against the active structured-output mode.
 *
 * @param content The raw assistant text preserved from generation.
 * @param mode The active structured-output mode.
 * @param schemaText The optional raw schema text used in `json_schema` mode.
 * @param truncated Indicates whether generation ended before completion.
 * @returns Persistable metadata describing the validation outcome, or `null` when disabled.
 */
export function validateStructuredOutputResult({
  content,
  mode,
  schemaText,
  truncated,
}: {
  content: string;
  mode: StructuredOutputMode;
  schemaText: string | undefined;
  truncated: boolean;
}): StructuredOutputMetadata | null {
  if (mode === "off") {
    return null;
  }

  if (truncated) {
    return {
      error: "Generation ended before a complete structured output was produced.",
      mode,
      status: "truncated",
    };
  }

  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(content) as unknown;
  } catch {
    return {
      error: "Assistant output was not valid JSON.",
      mode,
      status: "parse_error",
    };
  }

  if (mode === "json_object") {
    if (isJsonObject(parsedValue)) {
      return {
        mode,
        parsedValue,
        status: "valid",
      };
    }

    return {
      error: "Assistant output must be a JSON object in Any JSON Object mode.",
      mode,
      status: "schema_error",
    };
  }

  if (!schemaText?.trim()) {
    return {
      error: "JSON Schema mode requires a schema.",
      mode,
      status: "schema_error",
    };
  }

  const schema = JSON.parse(schemaText) as object;
  const validator = getSchemaValidator(schemaText, schema);

  if (validator(parsedValue)) {
    return {
      mode,
      parsedValue,
      status: "valid",
    };
  }

  return {
    error: ajv.errorsText(validator.errors, {
      separator: "; ",
    }),
    mode,
    status: "schema_error",
  };
}

/** Returns a cached or freshly compiled AJV validator for the given schema text. */
function getSchemaValidator(schemaText: string, schema: object): ReturnType<Ajv["compile"]> {
  const cachedValidator = validatorCache.get(schemaText);

  if (cachedValidator) {
    validatorCache.delete(schemaText);
    validatorCache.set(schemaText, cachedValidator);

    return cachedValidator;
  }

  const compiledValidator = ajv.compile(schema);

  if (validatorCache.size >= MAX_VALIDATOR_CACHE_ENTRIES) {
    const oldestSchemaText = validatorCache.keys().next().value;

    if (oldestSchemaText) {
      validatorCache.delete(oldestSchemaText);
    }
  }

  validatorCache.set(schemaText, compiledValidator);

  return compiledValidator;
}

/** Test-only cache inspection hook for validator eviction coverage. */
export function getStructuredOutputValidatorCacheSizeForTest(): number {
  return validatorCache.size;
}

/** Test-only cache reset hook for validator eviction coverage. */
export function resetStructuredOutputValidatorCacheForTest(): void {
  validatorCache.clear();
}

/** Type-guard that checks whether a value is a non-array plain object. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
