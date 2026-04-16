import type { ToolCategory } from "../../lib/contracts";

/** Primitive JSON values that tool inputs and outputs may contain. */
export type ToolJsonPrimitive = string | number | boolean | null;

/**
 * Recursive JSON-compatible value type used for tool arguments, results,
 * and arbitrary structured data exchanged between the tool runtime and
 * the chat-completions pipeline.
 */
export type ToolJsonValue =
  | ToolJsonPrimitive
  | readonly ToolJsonValue[]
  | { readonly [key: string]: ToolJsonValue };

/**
 * Common optional metadata fields shared by every tool schema variant.
 */
interface ToolSchemaBase {
  /** Human-readable summary of the value's purpose. */
  readonly title?: string;
  /** Longer description shown to the model or displayed in the Tool Manager UI. */
  readonly description?: string;
}

/** Schema for a string-valued tool parameter. */
export interface ToolStringSchema extends ToolSchemaBase {
  readonly type: "string";
  /** Allowed enumerated string values. */
  readonly enum?: readonly string[];
  /** Minimum string length. */
  readonly minLength?: number;
  /** Maximum string length. */
  readonly maxLength?: number;
}

/** Schema for a floating-point number tool parameter. */
export interface ToolNumberSchema extends ToolSchemaBase {
  readonly type: "number";
  /** Inclusive lower bound. */
  readonly minimum?: number;
  /** Inclusive upper bound. */
  readonly maximum?: number;
}

/** Schema for an integer tool parameter. */
export interface ToolIntegerSchema extends ToolSchemaBase {
  readonly type: "integer";
  /** Inclusive lower bound. */
  readonly minimum?: number;
  /** Inclusive upper bound. */
  readonly maximum?: number;
}

/** Schema for a boolean tool parameter. */
export interface ToolBooleanSchema extends ToolSchemaBase {
  readonly type: "boolean";
}

/** Schema for an array-valued tool parameter. */
export interface ToolArraySchema extends ToolSchemaBase {
  readonly type: "array";
  /** Schema applied to every element of the array. */
  readonly items: ToolSchema;
  /** Minimum number of elements. */
  readonly minItems?: number;
  /** Maximum number of elements. */
  readonly maxItems?: number;
}

/** Schema for an object-valued tool parameter or the root input schema. */
export interface ToolObjectSchema extends ToolSchemaBase {
  readonly type: "object";
  /** Map of property names to their individual schemas. */
  readonly properties: Readonly<Record<string, ToolSchema>>;
  /** Property names that must be present in the value. */
  readonly required?: readonly string[];
  /** Whether properties not listed in {@link properties} are permitted. */
  readonly additionalProperties?: boolean;
}

/**
 * Discriminated union of all supported tool parameter schema types.
 *
 * `$ref`, `oneOf`, `anyOf`, `allOf`, `patternProperties`, and recursive
 * schemas are intentionally excluded in v1.
 */
export type ToolSchema =
  | ToolStringSchema
  | ToolNumberSchema
  | ToolIntegerSchema
  | ToolBooleanSchema
  | ToolArraySchema
  | ToolObjectSchema;

/**
 * Operational policy hints declared by a tool module.
 *
 * These flags control how the registry treats the tool at load time
 * and how the chat orchestrator guards its execution at runtime.
 */
export interface ToolPolicy {
  /** Whether the tool is enabled in a fresh installation. Defaults to `true`. */
  readonly enabledByDefault?: boolean;
  /** Marks the tool as potentially destructive in the Tool Manager UI. */
  readonly dangerous?: boolean;
  /** When `true`, the frontend must prompt for user confirmation before execution. */
  readonly requiresConfirmation?: boolean;
  /** Whether multiple invocations of this tool may run concurrently. Defaults to `false`. */
  readonly allowParallel?: boolean;
  /** Maximum execution wall-clock time in milliseconds before the tool is aborted. */
  readonly timeoutMs?: number;
  /** UI grouping category for the Tool Manager panel. */
  readonly category?: ToolCategory;
}

/**
 * Declarative manifest that every tool module must provide.
 *
 * The manifest is validated by the registry at load time and converted
 * into an OpenAI-style function definition for `POST /v1/chat/completions`.
 */
export interface ToolManifest {
  /** Canonical tool identifier. Must match `^[a-z][a-z0-9_]{0,63}$` and the containing folder name. */
  readonly name: string;
  /** Optional human-friendly label for the Tool Manager UI. */
  readonly displayName?: string;
  /** Model-facing description of the tool's purpose. */
  readonly description: string;
  /** Root object schema describing the tool's expected input arguments. */
  readonly inputSchema: ToolObjectSchema;
  /** Optional schema describing the shape of {@link ToolSuccess.data}. */
  readonly outputSchema?: ToolSchema;
  /** Operational policy hints. See {@link ToolPolicy}. */
  readonly policy?: ToolPolicy;
}

/** Structured log entry emitted by a tool during execution via {@link ToolContext.log}. */
export interface ToolLogEntry {
  /** Severity level forwarded to the debug log service. */
  readonly level: "debug" | "info" | "warn" | "error";
  /** Human-readable log message. */
  readonly message: string;
  /** Optional structured payload attached to the log entry. */
  readonly data?: ToolJsonValue;
}

/**
 * Runtime context injected into every tool's {@link LocalToolModule.run} invocation.
 *
 * Provides the abort signal, filesystem paths, and a structured logging
 * callback scoped to the current tool call.
 */
export interface ToolContext {
  /** Abort signal that fires when the tool execution is cancelled or times out. */
  readonly signal: AbortSignal;
  /** Unique identifier for this specific tool-call invocation. */
  readonly callId: string;
  /** Identifier of the chat that triggered this tool call. */
  readonly chatId: string;
  /** Absolute path to the application's user-data directory. */
  readonly appDataDir: string;
  /** Optional workspace root path, when a workspace is configured. */
  readonly workspaceDir?: string;
  /** Absolute path to a temporary directory that the tool may write scratch files to. */
  readonly tempDir: string;
  /** Display name of the model that requested the tool call, if known. */
  readonly modelName?: string;
  /**
   * Emits a structured log entry to the debug log service.
   *
   * @param entry - The log entry to emit.
   */
  log(entry: ToolLogEntry): void;
}

/**
 * Successful tool execution result.
 *
 * @typeParam TResult - Shape of the optional structured data payload.
 */
export interface ToolSuccess<TResult extends ToolJsonValue = ToolJsonValue> {
  readonly ok: true;
  /** Model-facing textual summary of what the tool accomplished. */
  readonly content: string;
  /** Optional structured data for follow-up reasoning or UI inspection. */
  readonly data?: TResult;
}

/** Failed tool execution result with a structured error descriptor. */
export interface ToolFailure {
  readonly ok: false;
  readonly error: {
    /** Machine-readable error code (e.g. `"timeout"`, `"invalid_arguments"`). */
    readonly code: string;
    /** Human-readable error message. */
    readonly message: string;
    /** Hint indicating whether the caller may retry the same invocation. */
    readonly retryable?: boolean;
    /** Optional structured payload providing additional failure context. */
    readonly data?: ToolJsonValue;
  };
}

/**
 * Discriminated union returned by every tool's `run()` method.
 *
 * @typeParam TResult - Shape of the optional structured data on success.
 */
export type ToolResult<TResult extends ToolJsonValue = ToolJsonValue> =
  | ToolSuccess<TResult>
  | ToolFailure;

/**
 * Contract that every local tool module must satisfy as its default export.
 *
 * The registry validates `apiVersion`, `kind`, and `manifest` at load time
 * and calls `run()` at execution time with validated arguments and a
 * scoped {@link ToolContext}.
 *
 * @typeParam TArgs - Shape of the validated input arguments object.
 * @typeParam TResult - Shape of the optional structured data on success.
 */
export interface LocalToolModule<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult extends ToolJsonValue = ToolJsonValue,
> {
  /** Must be `1` for the current tool contract version. */
  readonly apiVersion: 1;
  /** Must be `"local-tool"` to identify this export as a tool module. */
  readonly kind: "local-tool";
  /** Declarative manifest describing the tool's identity, schema, and policy. */
  readonly manifest: ToolManifest;
  /**
   * Executes the tool with the given validated arguments.
   *
   * @param args - Pre-validated input arguments matching {@link ToolManifest.inputSchema}.
   * @param context - Runtime context providing abort signal, paths, and logging.
   * @returns A {@link ToolResult} indicating success or structured failure.
   */
  run(args: TArgs, context: ToolContext): Promise<ToolResult<TResult>> | ToolResult<TResult>;
}
